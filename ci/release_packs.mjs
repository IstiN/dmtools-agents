#!/usr/bin/env node
/**
 * Agent pack release builder (dmtools-agents#441).
 *
 * Computes the affected agent set from the git diff since the last release,
 * bumps each affected agent's version in versions.json, builds EVERY agent
 * pack with `dmtools compile` (the single implementation of the pack format —
 * dm.ai#595), validates each zip against its manifest, and writes a FULL
 * catalog.json (every agent -> its current version): each release is a
 * self-contained snapshot because the registry resolver resolves
 * `<agent>@latest` against the newest release's catalog only.
 *
 * Usage:
 *   node ci/release_packs.mjs [--agents=all|name1,name2] [--bump=patch|minor|major]
 *       [--base-ref <git-ref>] [--out dist] [--dry-run]
 *
 * Exit 0 with an empty affected set means "nothing to release" (not an error).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync,
  copyFileSync, cpSync, chmodSync, mkdtempSync, rmSync, statSync, utimesSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// Pack launch-surface contract (Wave 2, owner 2026-10-01): teammate packs
// carry launch.json (+ loop/verdict.sh for review packs) inside the zip.
import { launchExtras, mergeManifest } from './pack_launch_contract.cjs';

// Release-guard classification (gh-690): versions.json is the version
// LEDGER — data, not an agent. The old inline filter in allAgents() swept it
// in as a phantom "versions" agent (a bogus ledger key plus a phantom
// versions-<v>.zip in every release). pack_release_guard.cjs is the single
// definition of "what is an agent" — the affected-set path uses it too.
import {
  agentNamesFromFiles, isAgentConfigFile, toAgentName,
} from './pack_release_guard.cjs';

const ROOT = process.cwd();
const VERSIONS_FILE = join(ROOT, 'versions.json');
const OUT_DIR = arg('--out') || 'dist';
const BUMP = arg('--bump') || 'patch';
const AGENTS_INPUT = arg('--agents') || '';
const BASE_REF = arg('--base-ref') || '';
const DRY_RUN = hasFlag('--dry-run');

/** Directory prefixes whose change affects every agent (shared runtime code). */
const SHARED_PREFIXES = ['js/', 'instructions/', 'prompts/', 'scripts/'];

/**
 * The factory-setup asset (owner mandate 2026-10-03: "no factory-agents tree
 * checkout in the factory") — the workflow glue the factory needs at run
 * time, shipped as a release zip so awf's factory-teammate.yml never clones
 * the dmtools-agents tree:
 *   setup/    — the whole toolbelt (install.sh, cache.sh, review-verdict.sh,
 *               fa-session.sh, per-tool installers, _common.sh)
 *   scripts/git-push-guard.sh — the guard fallback (kit stays primary)
 *   configs/  — the four leg entry configs the guard job names as its
 *               parent-config fallback (pack launch.json stays primary)
 */
const FACTORY_SETUP_LEGS = ['bug_development', 'story_development', 'pr_review', 'pr_rework'];

/** True when any changed file lives under setup/ or the builder itself. */
function setupTouched() {
  if (AGENTS_INPUT) return true; // explicit dispatch: always ship a fresh asset
  const changed = changedFiles();
  if (changed === null) return true;
  // setup/ content or THIS builder — either way the factory-setup asset
  // must re-ship (live: the builder-only diff cut no release and the
  // factory-setup asset never landed, 2026-10-03).
  return changed.some((f) => f.startsWith('setup/') || f === 'ci/release_packs.mjs');
}

/** Builds dist/factory-setup-<datestamp>.zip + .sha256 sidecar. */
function buildFactorySetup() {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = resolve(OUT_DIR, `factory-setup-${stamp}.zip`);
  const staging = mkdtempSync(join(tmpdir(), 'factory-setup-'));
  try {
    mkdirSync(join(staging, 'configs'), { recursive: true });
    cpSync(join(ROOT, 'setup'), join(staging, 'setup'), { recursive: true });
    mkdirSync(join(staging, 'scripts'), { recursive: true });
    copyFileSync(join(ROOT, 'scripts', 'git-push-guard.sh'), join(staging, 'scripts', 'git-push-guard.sh'));
    for (const leg of FACTORY_SETUP_LEGS) {
      copyFileSync(join(ROOT, `${leg}.json`), join(staging, 'configs', `${leg}.json`));
    }
    // Plain integrity inventory (not a dmtools agent-pack manifest — this is
    // workflow glue, never resolved by the agent pack registry).
    const sums = [];
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), relPath);
        else sums.push(`${createHash('sha256').update(readFileSync(join(dir, e.name))).digest('hex')}  ${relPath}`);
      }
    };
    walk(staging, '');
    writeFileSync(join(staging, 'SHA256SUMS'), `${sums.sort().join('\n')}\n`);
    execSync(`cd ${JSON.stringify(staging)} && zip -q -r ${JSON.stringify(zipPath)} .`);
    const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
    writeFileSync(`${zipPath}.sha256`, `${digest}  ${basename(zipPath)}\n`);
    console.log(`built ${basename(zipPath)} (${sums.length} files)`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return zipPath;
}

function arg(name) {
  // Support both "--flag value" and "--flag=value".
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readVersions() {
  return JSON.parse(readFileSync(VERSIONS_FILE, 'utf8'));
}

/** All root-level *.json entry points (agent names), excluding package*.json
 *  and the versions.json ledger (gh-690 — see ci/pack_release_guard.cjs). */
function allAgents() {
  return agentNamesFromFiles(readdirSync(ROOT));
}

/** Files changed since the base ref (last release tag), or all when none. */
function changedFiles() {
  if (!BASE_REF) return null; // caller treats null as "unknown -> all agents"
  try {
    const out = execSync(`git diff --name-only ${BASE_REF}...HEAD`, { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.warn(`git diff against ${BASE_REF} failed (${e.message}); releasing all agents`);
    return null;
  }
}

/**
 * Affected set: changed root entry configs, plus every agent when any shared
 * runtime file changed (conservative superset of the closure intersection —
 * never misses an affected agent).
 */
function computeAffectedSet() {
  if (AGENTS_INPUT === 'all') return allAgents();
  if (AGENTS_INPUT) return AGENTS_INPUT.split(',').map((s) => s.trim()).filter(Boolean);

  const changed = changedFiles();
  if (changed === null) return allAgents();

  const affected = new Set();
  for (const file of changed) {
    // Single classification path (gh-690 review): the guard module owns
    // "what is an agent" — it already excludes the ledger, npm metadata and
    // nested files, so a root entry config change is the only per-agent case.
    if (isAgentConfigFile(file)) {
      affected.add(toAgentName(file)); // a root entry config changed
    }
    if (SHARED_PREFIXES.some((p) => file.startsWith(p))) {
      console.log(`Shared file changed: ${file} — bumping all agents`);
      return allAgents();
    }
  }
  return [...affected].sort();
}

/** Semver bump. */
function bump(version, kind) {
  const [maj, min, pat] = version.split('.').map((n) => parseInt(n, 10) || 0);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/**
 * Adds the launch surface (see ci/pack_launch_contract.cjs) to a compiled
 * pack zip: unpack → copy the contract files in (verbatim) → fold them
 * into manifest.json (sorted, sha256, mode) → rebuild the zip
 * deterministically (manifest first, sorted entries, fixed 1980-01-01
 * mtime — compiler parity) → refresh the .sha256 sidecar. Non-teammate
 * packs pass through untouched.
 */
function augmentLaunchSurface(agent, zipPath) {
  const extras = launchExtras(agent);
  if (extras.length === 0) return;
  const tmp = mkdtempSync(join(tmpdir(), 'pack-launch-'));
  try {
    execSync(`unzip -q -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(tmp)}`);
    const added = [];
    for (const { entry, source } of extras) {
      const dest = join(tmp, ...entry.split('/'));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(ROOT, source), dest);
      const executable = entry.endsWith('.sh');
      chmodSync(dest, executable ? 0o755 : 0o644);
      added.push({
        path: entry,
        sha256: createHash('sha256').update(readFileSync(dest)).digest('hex'),
        mode: executable ? '0755' : '0644',
      });
      console.log(`  + ${entry} (verbatim from ${source})`);
    }
    const manifestPath = join(tmp, 'manifest.json');
    const manifest = mergeManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
      added,
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Deterministic rebuild: every entry stamped to the compiler's fixed
    // zip epoch, manifest.json first, then the closure sorted by path
    // (`zip -X` drops uid/gid/extra fields but keeps the unix mode).
    const fixedTime = new Date('1980-01-01T00:00:00Z');
    const entries = readdirSync(tmp, { recursive: true })
      .filter((f) => statSync(join(tmp, f)).isFile())
      .map((f) => f.split(sep).join('/'))
      .sort();
    const ordered = ['manifest.json', ...entries.filter((f) => f !== 'manifest.json')];
    for (const f of ordered) utimesSync(join(tmp, f), fixedTime, fixedTime);
    const rebuilt = join(tmp, 'rebuilt.zip');
    execFileSync('zip', ['-q', '-X', rebuilt, ...ordered], { cwd: tmp });
    copyFileSync(rebuilt, zipPath);
    writeFileSync(
      `${zipPath}.sha256`,
      `${createHash('sha256').update(readFileSync(zipPath)).digest('hex')}  ${basename(zipPath)}\n`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Builds one pack via the dmtools CLI. Returns the produced zip path. */
function buildPack(agent, version) {
  execFileSync(
    'dmtools',
    ['compile', `${agent}.json`, '--agent-root', ROOT, '--version', version, '--out', OUT_DIR, '--include', 'instructions', '--include', 'prompts'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  return join(OUT_DIR, `${agent}-${version}.zip`);
}

/** Validates a zip against its embedded manifest (per-file sha256 inventory). */
function validatePack(zipPath) {
  // Read manifest.json from the zip without external tools (unzip -p).
  const manifestJson = execSync(`unzip -p ${JSON.stringify(zipPath)} manifest.json`, { encoding: 'utf8' });
  const manifest = JSON.parse(manifestJson);
  const files = manifest.files || [];
  if (files.length === 0) throw new Error(`manifest.json in ${zipPath} has no files`);
  for (const f of files) {
    const bytes = execSync(`unzip -p ${JSON.stringify(zipPath)} ${JSON.stringify(f.path)}`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== f.sha256) {
      throw new Error(`sha256 mismatch in ${zipPath}: ${f.path}`);
    }
  }
  return files.length;
}

function main() {
  const versions = readVersions();
  const affected = computeAffectedSet();
  const setupOnly = setupTouched();
  if (affected.length === 0 && !setupOnly) {
    console.log('No affected agents and no setup change — nothing to release.');
    // dist/ may not exist yet (the build below is skipped) — create it or
    // the marker write throws ENOENT and the job fails (live: release run
    // 2026-09-30T09:11 on a push whose BASE diff was empty).
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, '.no-release'), 'no affected agents\n');
    return;
  }
  console.log(`Affected agents (${affected.length}): ${affected.join(', ') || '<none — factory-setup-only>'}`);
  mkdirSync(OUT_DIR, { recursive: true });

  // Bump ONLY the affected agents (incremental versioning), but BUILD and
  // catalog EVERY agent: each release must be a self-contained snapshot.
  // The registry resolver resolves `<agent>@latest` against the NEWEST
  // release's catalog.json — an affected-only catalog hides every agent
  // that was not touched by this release, and their packs are absent from
  // the release assets too, so `@latest` AND `@<version>` both fail
  // (live: epam/dmtools-dart machine-merge, 2026-09-29 —
  // "Agent 'machine_merge' not found in registry catalog .../catalog.json"
  // because the 19:07 release bumped only sm_github).
  const agents = allAgents();
  const catalog = {};
  for (const agent of agents) {
    const current = versions[agent] || '0.1.0';
    const next = affected.includes(agent) ? bump(current, BUMP) : current;
    console.log(`\n=== ${agent}: ${current}${next !== current ? ` -> ${next}` : ' (unchanged)'} ===`);
    if (!DRY_RUN) {
      // ALWAYS build every agent zip — a factory-setup-only release is a
      // RELEASE too and must stay a self-contained snapshot. Skipping the
      // build on an empty affected set shipped a catalog that advertised
      // packs the release never carried, and the registry resolver 404'd
      // on `@latest` (live: fa SM tick 2026-10-03T08:49, sm_github-0.1.18
      // in catalog, zip absent from agents-rel-20261003-084425).
      const zip = buildPack(agent, next);
      augmentLaunchSurface(agent, zip);
      const count = validatePack(zip);
      console.log(`validated ${basename(zip)} (${count} files)`);
      versions[agent] = next;
    }
    catalog[agent] = versions[agent];
  }

  if (!DRY_RUN) {
    if (affected.length > 0) {
      writeFileSync(VERSIONS_FILE, JSON.stringify(versions, null, 2) + '\n');
    }
    // The factory-setup asset rides EVERY release (self-contained snapshot,
    // same rule as the agent packs) — the factory downloads it by tag, so a
    // stale asset on a fresh tag would silently pin old workflow glue.
    buildFactorySetup();
    writeFileSync(join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    console.log(`\nWrote ${OUT_DIR}/catalog.json (${agents.length} agents, ${affected.length} bumped, factory-setup shipped)`);
  }
}

main();
