#!/usr/bin/env node
/**
 * Agent pack release builder (dmtools-agents#441).
 *
 * Computes the affected agent set from the git diff since the last release,
 * bumps each affected agent's version in versions.json, builds every affected
 * pack with `dmtools compile` (the single implementation of the pack format —
 * dm.ai#595), validates each zip against its manifest, and writes catalog.json.
 *
 * Usage:
 *   node ci/release_packs.mjs [--agents=all|name1,name2] [--bump=patch|minor|major]
 *       [--base-ref <git-ref>] [--out dist] [--dry-run]
 *
 * Exit 0 with an empty affected set means "nothing to release" (not an error).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const VERSIONS_FILE = join(ROOT, 'versions.json');
const OUT_DIR = arg('--out') || 'dist';
const BUMP = arg('--bump') || 'patch';
const AGENTS_INPUT = arg('--agents') || '';
const BASE_REF = arg('--base-ref') || '';
const DRY_RUN = hasFlag('--dry-run');

/** Directory prefixes whose change affects every agent (shared runtime code). */
const SHARED_PREFIXES = ['js/', 'instructions/', 'prompts/', 'scripts/'];

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

/** All root-level *.json entry points (agent names), excluding package*.json. */
function allAgents() {
  return readdirSync(ROOT)
    .filter((f) => f.endsWith('.json') && !f.startsWith('package'))
    .map((f) => basename(f, '.json'))
    .sort();
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
    if (file.endsWith('.json') && !file.includes('/') && !file.startsWith('package')) {
      affected.add(basename(file, '.json')); // a root entry config changed
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

/** Builds one pack via the dmtools CLI. Returns the produced zip path. */
function buildPack(agent, version) {
  execFileSync(
    'dmtools',
    ['compile', `${agent}.json`, '--agent-root', ROOT, '--version', version, '--out', OUT_DIR],
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
  if (affected.length === 0) {
    console.log('No affected agents — nothing to release.');
    writeFileSync(join(OUT_DIR, '.no-release'), 'no affected agents\n');
    return;
  }
  console.log(`Affected agents (${affected.length}): ${affected.join(', ')}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const catalog = {};
  for (const agent of affected) {
    const current = versions[agent] || '0.1.0';
    const next = bump(current, BUMP);
    console.log(`\n=== ${agent}: ${current} -> ${next} ===`);
    if (!DRY_RUN) {
      const zip = buildPack(agent, next);
      const count = validatePack(zip);
      console.log(`validated ${basename(zip)} (${count} files)`);
      versions[agent] = next;
      catalog[agent] = next;
    } else {
      console.log('[dry-run] would build and validate the pack');
      catalog[agent] = next;
    }
  }

  if (!DRY_RUN) {
    writeFileSync(VERSIONS_FILE, JSON.stringify(versions, null, 2) + '\n');
    writeFileSync(join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    console.log(`\nWrote versions.json and ${OUT_DIR}/catalog.json (${affected.length} agents)`);
  }
}

main();
