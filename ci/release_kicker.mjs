#!/usr/bin/env node
/**
 * Agent pack release kicker (dmtools-agents#844).
 *
 * The belt for a silently-dropped push trigger (live 2026-10-10: #841 merged
 * 14:24Z, no release until an operator dispatch 17:05Z — #826 hung in the
 * gap). Each tick:
 *
 *   1. resolve origin/main HEAD and the commit behind the newest agents-rel-* tag
 *   2. diff the tag...main names
 *   3. count queued/in_progress runs of agent-pack-release.yml
 *   4. decide through ci/release_kicker_guard.cjs (all logic is unit-tested there)
 *   5. on 'dispatch' — `gh workflow run agent-pack-release.yml --ref main`
 *
 * Idempotent (gh-844 AC2): an in-flight release run suppresses the dispatch,
 * and the release workflow's own ledger guard + dist/.no-release no-op
 * dedupe the rest. The paths-ignore set is parsed from the release workflow
 * itself — single source of truth (AC3). Every decision is logged as a
 * notice so the AC1 metric (no fix waits >15 min in main) is auditable.
 *
 * Usage: node ci/release_kicker.mjs   (env: GH_TOKEN with actions:write)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  pathsIgnoreFromWorkflow,
  decideKick,
} from './release_kicker_guard.cjs';

const RELEASE_WF_PATH = '.github/workflows/agent-pack-release.yml';
const RELEASE_WF_NAME = 'agent-pack-release.yml';
const RELEASE_TAG_PREFIX = 'agents-rel-';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gh(args) {
  return sh('gh', args);
}

// 1. main HEAD.
const mainHead = sh('git', ['rev-parse', 'refs/remotes/origin/main']);

// 2. latest release tag -> its commit ('' when no release exists yet).
let tag = '';
let releaseCommit = '';
const tagsOut = sh('git', ['tag', '--list', `${RELEASE_TAG_PREFIX}*`, '--sort=-creatordate']);
if (tagsOut) {
  tag = tagsOut.split('\n')[0].trim();
  if (tag) releaseCommit = sh('git', ['rev-list', '-n', '1', tag]);
}

// 3. changed files since the tag (null only when the tag is missing AND the
//    tree is empty of history — the guard treats null as 'never skip').
let changedFiles = null;
if (releaseCommit) {
  const diffOut = sh('git', ['diff', '--name-only', `${releaseCommit}...${mainHead}`]);
  changedFiles = diffOut ? diffOut.split('\n').map((f) => f.trim()).filter(Boolean) : [];
}

// 4. queued / in_progress release runs (the workflow name, not the kicker's).
const runs = JSON.parse(gh(['run', 'list', '--workflow', RELEASE_WF_NAME, '--json', 'status']));
const activeReleaseRuns = runs.filter(
  (r) => r.status === 'queued' || r.status === 'in_progress',
).length;

// 5. decide — the ignore set comes from the release workflow, not a copy.
const ignored = pathsIgnoreFromWorkflow(readFileSync(RELEASE_WF_PATH, 'utf8'));
const decision = decideKick({ mainHead, releaseCommit, changedFiles, activeReleaseRuns, ignored });

// 6. act + the AC1 tick log line.
if (decision.action === 'dispatch') {
  console.log(`::notice::release-kicker: ${decision.reason} ` +
    `(tag=${tag || '<none>'}, relevant=${decision.relevantCount}) — dispatching ${RELEASE_WF_NAME}`);
  gh(['workflow', 'run', RELEASE_WF_NAME, '--ref', 'main']);
  console.log(`::notice::release-kicker: dispatched ${RELEASE_WF_NAME} on main`);
} else {
  console.log(`::notice::release-kicker: noop — ${decision.reason} (tag=${tag || '<none>'})`);
}
