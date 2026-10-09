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
 *       [--base-ref <git-ref>] [--prev-release-tag <tag>] [--allow-unverified-base]
 *       [--out dist] [--dry-run]
 *
 * Exit 0 with an empty affected set means "nothing to release" (not an error).
 *
 * gh-812 release integrity (live incident 2026-10-09): the builder derives
 * every version from the PREVIOUS RELEASE's shipped catalog (append-only,
 * cannot be rewritten by a failed ledger push) rather than versions.json on
 * main (--prev-release-tag; a failed shipped-state read FAILS the release
 * unless --allow-unverified-base opts into the ledger fallback), re-version
 * an unbumped agent whose
 * rebuilt payload differs from what its unchanged version already shipped
 * (never republish changed content under a shipped version), and gate every
 * built zip through the require sanity check (assertZipRequires) BEFORE the
 * ledger commit and the publish — a pack whose code requires a file the zip
 * does not carry must fail the release, not the fa runners.
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

// gh-812: version uniqueness (shipped-version-first resolution, payload
// fingerprints) + the require sanity gate — both pure CommonJS twins kept
// unit-testable in the dmtools runner (same split as pack_release_guard.cjs).
import {
  bump, resolveBaseVersion, resolveCandidateVersion, resolveShipVersion,
  fingerprintsDiffer,
} from './pack_version_guard.cjs';
import { unresolvedRequires } from './pack_require_gate.cjs';

const ROOT = process.cwd();
const VERSIONS_FILE = join(ROOT, 'versions.json');
const OUT_DIR = arg('--out') || 'dist';
const BUMP = arg('--bump') || 'patch';
const AGENTS_INPUT = arg('--agents') || '';
const BASE_REF = arg('--base-ref') || '';
const PREV_TAG = arg('--prev-release-tag') || '';
const DRY_RUN = hasFlag('--dry-run');
// gh-812 rework (review thread 2): a failed shipped-state read defaults to
// FAILING the release — silently degrading to the stale versions.json
// ledger (the incident's root cause) or skipping the payload-drift check
// re-opens the exact two-packs-one-version collision this pipeline exists
// to prevent. --allow-unverified-base opts into the degraded mode as a
// deliberate human decision instead of a log line.
const ALLOW_UNVERIFIED_BASE = hasFlag('--allow-unverified-base');

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

/**
 * Shipped state of the PREVIOUS release (gh-812 V1): catalog.json gives the
 * version each agent actually shipped (append-only release history — cannot
 * be rewritten by a failed ledger push, unlike versions.json on main), and
 * same-version pack zips give the payload to compare rebuilt unbumped agents
 * against (V3). Strict by default (gh-812 rework, review thread 2): a failed
 * read FAILS the release — the fallback paths silently reverted to the
 * stale-ledger base / skipped the drift check, which re-opens AC2 with only
 * a warning. --allow-unverified-base opts into the degraded mode; the
 * degraded read stays visible at ::warning:: level.
 */
let SHIPPED_DIR = null;
let SHIPPED_CATALOG = null;
const SHIPPED_ZIP_MANIFESTS = {};

/** gh invocation suffix: the repo slug when Actions provides it, else gh
 *  falls back to the local git remote (a release checkout has one). */
function ghRepoArg() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  return repo ? ` --repo ${JSON.stringify(repo)}` : '';
}

function shippedCatalog() {
  if (SHIPPED_CATALOG === null) {
    if (!PREV_TAG || DRY_RUN) return {}; // no previous release to read — ledger fallback
    SHIPPED_DIR = mkdtempSync(join(tmpdir(), 'prev-release-'));
    try {
      execSync(
        `gh release download ${JSON.stringify(PREV_TAG)} --pattern 'catalog.json' --dir ${JSON.stringify(SHIPPED_DIR)} --clobber${ghRepoArg()}`,
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
      SHIPPED_CATALOG = JSON.parse(readFileSync(join(SHIPPED_DIR, 'catalog.json'), 'utf8'));
      // gh-812 rework (review thread 6): ONE batched download of every zip
      // on the previous release replaces ~68 serial per-agent `gh release
      // download` round-trips inside the build loop — minutes of gh time
      // per release, and each call was another chance for the transient
      // failure the drift check depends on. shippedZipManifest() below
      // just reads the local copy. Release assets for one tag are bounded,
      // and stale-version zips are simply ignored (each agent has exactly
      // one version per release snapshot).
      execSync(
        `gh release download ${JSON.stringify(PREV_TAG)} --pattern '*.zip' --dir ${JSON.stringify(SHIPPED_DIR)} --clobber${ghRepoArg()}`,
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
    } catch (e) {
      const reason = String(e.message).split('\n')[0];
      rmSync(SHIPPED_DIR, { recursive: true, force: true });
      SHIPPED_DIR = null;
      SHIPPED_CATALOG = {};
      if (!ALLOW_UNVERIFIED_BASE) {
        console.error(`::error::previous release ${PREV_TAG} unavailable (${reason}) — failing the release: without the shipped catalog the version-uniqueness base degrades to the versions.json ledger that caused gh-812 (pass --allow-unverified-base to accept the degraded base)`);
        throw new Error(
          `shipped catalog of ${PREV_TAG} could not be read (${reason}); ` +
          'refusing to release on an unverifiable base (gh-812: never re-ship changed content under a shipped version) — ' +
          'pass --allow-unverified-base to release with ledger-based versions',
        );
      }
      console.warn(`::warning::previous release ${PREV_TAG} unavailable (${reason}) — --allow-unverified-base set: base versions fall back to the versions.json ledger`);
    }
  }
  return SHIPPED_CATALOG;
}

/** manifest.json text of the zip the previous release shipped for
 *  <agent>-<version>, read from the batched download at shippedCatalog()
 *  time (no per-agent gh round-trip — gh-812 rework, review thread 6);
 *  null ONLY in the explicit --allow-unverified-base degraded mode or when
 *  there is no previous release to compare against. */
function shippedZipManifest(agent, version) {
  const key = `${agent}@${version}`;
  if (Object.prototype.hasOwnProperty.call(SHIPPED_ZIP_MANIFESTS, key)) {
    return SHIPPED_ZIP_MANIFESTS[key];
  }
  if (!PREV_TAG || DRY_RUN || !SHIPPED_DIR) return null;
  try {
    SHIPPED_ZIP_MANIFESTS[key] = execSync(
      `unzip -p ${JSON.stringify(join(SHIPPED_DIR, `${agent}-${version}.zip`))} manifest.json`,
      { encoding: 'utf8' },
    );
  } catch (e) {
    const reason = String(e.message).split('\n')[0];
    if (!ALLOW_UNVERIFIED_BASE) {
      // gh-812 rework (review thread 2): a failed read used to return null,
      // and fingerprintsDiffer(null, …) === false shipped the rebuilt pack
      // at the version that already shipped — the drift check silently
      // disabled, per agent and quiet. Fail the release instead.
      console.error(`::error::shipped ${key}.zip missing/unreadable from ${PREV_TAG} (${reason}) — failing the release: the payload-drift check cannot run, so changed content could ship under the already-shipped version (pass --allow-unverified-base to skip the comparison)`);
      throw new Error(
        `shipped ${key}.zip could not be read from ${PREV_TAG} (${reason}); ` +
        'the payload-drift check cannot run — refusing to republish under a shipped version (gh-812) — ' +
        'pass --allow-unverified-base to skip the comparison',
      );
    }
    console.warn(`::warning::could not read shipped ${key}.zip for the payload comparison (${reason}) — --allow-unverified-base set: shipping at the candidate version`);
    SHIPPED_ZIP_MANIFESTS[key] = null;
  }
  return SHIPPED_ZIP_MANIFESTS[key];
}

/** manifest.json text from a freshly built zip (validatePack already does
 *  this read — kept separate so the gate ordering stays explicit). */
function zipManifestText(zipPath) {
  return execSync(`unzip -p ${JSON.stringify(zipPath)} manifest.json`, { encoding: 'utf8' });
}

/**
 * gh-812 AC1/AC3 release self-test: every literal relative require in every
 * .js inside [zipPath] must resolve to a file IN the zip — else throw, so
 * the build step exits non-zero before the ledger commit and the publish.
 * validatePack() cannot catch this class: it re-hashes manifest entries
 * against themselves, never checks payload self-consistency.
 */
function assertZipRequires(zipPath) {
  const tmp = mkdtempSync(join(tmpdir(), 'pack-require-gate-'));
  try {
    execSync(`unzip -q -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(tmp)}`);
    const paths = new Set();
    const sources = [];
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), relPath);
        else {
          paths.add(relPath);
          if (relPath.endsWith('.js')) {
            sources.push({ path: relPath, source: readFileSync(join(dir, e.name), 'utf8') });
          }
        }
      }
    };
    walk(tmp, '');
    const unresolved = unresolvedRequires(sources, paths);
    if (unresolved.length > 0) {
      const lines = unresolved
        .map((u) => `  ${u.from}: require('${u.spec}') -> none of [${u.bases.join(', ')}] is in the zip`)
        .join('\n');
      throw new Error(
        `require sanity gate FAILED for ${basename(zipPath)}: ` +
        `${unresolved.length} packed require(s) resolve to files absent from the zip (gh-812):\n${lines}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

/**
 * Builds ONE agent pack release-ready: compile → launch-surface augment →
 * gh-812 payload-drift re-version (an unchanged version must never re-ship
 * changed content) → require sanity gate → manifest validation. The guarded
 * chain stays literal and in order (build → augment → validate — see
 * test_packLaunchContract); [next] is the version to build at and is
 * advanced when the drift check forces a re-version. Returns the shipped
 * { zipPath, version }.
 */
function buildPackRelease(agent, next, isAffected, shippedVersion) {
  // ALWAYS build every agent zip — a factory-setup-only release is a
  // RELEASE too and must stay a self-contained snapshot. Skipping the
  // build on an empty affected set shipped a catalog that advertised
  // packs the release never carried, and the registry resolver 404'd
  // on `@latest` (live: fa SM tick 2026-10-03T08:49, sm_github-0.1.18
  // in catalog, zip absent from agents-rel-20261003-084425).
  const zip = buildPack(agent, next);
  augmentLaunchSurface(agent, zip);
  // gh-812 V3: a rebuilt-but-unbumped agent whose payload differs from the
  // zip its version already shipped is the exact collision class that put
  // two different sm_github-0.1.36.zip files into 075526 and 091304 —
  // re-version one patch up instead of republishing under the same name.
  if (!isAffected && shippedVersion === next &&
      fingerprintsDiffer(shippedZipManifest(agent, shippedVersion), zipManifestText(zip))) {
    next = resolveShipVersion(next, true);
    console.log(`  payload differs from shipped ${shippedVersion} — re-versioning to ${next} (gh-812: never republish changed content under a shipped version)`);
    // gh-812 rework (review thread 1, BLOCKING): the first build materialized
    // the drifted payload AS <agent>-<shippedVersion>.zip (+ .sha256) in
    // dist/ — the version this check just proved already shipped DIFFERENT
    // content. The publish step uploads dist/*.zip wholesale, so both stale
    // artifacts must be gone BEFORE the rebuild at the final version, or the
    // release republishes the exact two-packs-one-version collision gh-812
    // forbids (version-keyed consumer caches would refresh from its assets).
    rmSync(zip, { force: true });
    rmSync(`${zip}.sha256`, { force: true });
    const rezipped = buildPack(agent, next);
    augmentLaunchSurface(agent, rezipped);
    assertZipRequires(rezipped); // gh-812 AC1/AC3 — throws before ledger commit + publish
    const recount = validatePack(rezipped);
    console.log(`validated ${basename(rezipped)} (${recount} files)`);
    return { zipPath: rezipped, version: next };
  }
  assertZipRequires(zip); // gh-812 AC1/AC3 — throws before ledger commit + publish
  const count = validatePack(zip);
  console.log(`validated ${basename(zip)} (${count} files)`);
  return { zipPath: zip, version: next };
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
  const ledgerBefore = { ...versions };
  for (const agent of agents) {
    const ledgerVersion = versions[agent] || '0.1.0';
    const shippedVersion = shippedCatalog()[agent] || null;
    const isAffected = affected.includes(agent);
    // gh-812 V1/V2: the base is what the previous release SHIPPED for this
    // agent (append-only, cannot be rewritten by a failed ledger push); the
    // versions.json ledger is only the fallback. Bumping from a stale ledger
    // re-shipped a live version with new content — the gh-812 collision.
    let next = resolveCandidateVersion(resolveBaseVersion(ledgerVersion, shippedVersion), BUMP, isAffected);
    console.log(`\n=== ${agent}: ledger ${ledgerVersion}, shipped ${shippedVersion || '<none>'}${next !== ledgerVersion ? ` -> ${next}` : ' (unchanged)'} ===`);
    if (!DRY_RUN) {
      const built = buildPackRelease(agent, next, isAffected, shippedVersion);
      next = built.version;
      versions[agent] = next;
    }
    catalog[agent] = next;
  }

  if (!DRY_RUN) {
    // Write the ledger whenever any final version diverges from what it
    // said — affected bumps, gh-812 forced re-versionings, and the
    // reconciliation of a ledger that lagged the shipped catalog.
    const ledgerChanged = agents.some((a) => versions[a] !== (ledgerBefore[a] || '0.1.0'));
    if (ledgerChanged) {
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
