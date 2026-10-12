/**
 * Unit tests: machine-merge-driven agent-pack releases (gh-867, live
 * incidents 2026-10-11/12).
 *
 * Incident: PRs #863 (22:01Z) and #866 (00:11Z) merged by the Machine
 * Merge Bot produced NO 'Agent Pack Release' run. The release workflow
 * reacts to new main commits ONLY via its push trigger, and GitHub
 * suppresses workflow triggers on GITHUB_TOKEN-authored pushes — the
 * merge bot's merge push never fires an event. Both merges stalled in
 * main until an operator dispatched the release manually (runs
 * 38179243031 / 38188359001), twice blocking the SM fleet from picking
 * up machine-landed fixes (it resolves packs via the 'latest' release).
 *
 * The gh-844 kicker is a 10-minute polling belt — it cannot meet the
 * ~2-minute acceptance and demonstrably did not rescue either incident.
 * The fix is ticket option 3: a workflow_run trigger on 'Machine Merge
 * Bot' completions (workflow_run chains up to 3 levels are allowed —
 * 'Agent Docs → Machine Merge Bot → Agent Pack Release' is 2).
 *
 * Invariants:
 *   M1 trigger — the release workflow fires on 'Machine Merge Bot'
 *      completions (types: [completed]).
 *   M2 no branch filter — the bot's workflow_run head_branch is the PR
 *      branch, never main; a branches: [main] filter would silence the
 *      trigger entirely. "Main filtering" is the tag...main diff +
 *      dist/.no-release no-op (gh-690 dedup), not a trigger filter.
 *   M3 success gate — only conclusion == 'success' bot runs may cut a
 *      release (the bot completes on every label latch tick, merging
 *      nothing; failed runs must not publish).
 *   M4 current main — workflow_run-triggered runs sync to origin/main
 *      before the affected-set computation (the merge may land after the
 *      event fired; queued runs must release current main). Manual
 *      dispatch stays ref-targeted (no sync).
 *   M5 no recursion — the release must never listen to itself or to the
 *      kicker (a workflow_run loop would chain-cut releases).
 *   M6 planes intact — push trigger, workflow_dispatch inputs and the
 *      gh-844 kicker stay untouched (belt AND suspenders).
 *
 * Uses: loadModule(), file_read(), suite(), test(), assert
 */

'use strict';

/* global loadModule, assert, test, suite, file_read */

var RELEASE_WF_PATH = '.github/workflows/agent-pack-release.yml';
var MERGE_BOT_WF_PATH = '.github/workflows/machine-merge.yml';
var KICKER_WF_PATH = '.github/workflows/agent-pack-release-kicker.yml';

// The workflow_run trigger block of the release workflow (from the
// 'workflow_run:' key to the next top-level 'on.' key or workflow key),
// with YAML comment lines stripped — the M2 assertion targets trigger
// KEYS, not prose (the block documents why branches: is absent).
function workflowRunBlock(wf) {
    var start = wf.indexOf('workflow_run:');
    if (start === -1) return '';
    var rest = wf.slice(start + 'workflow_run:'.length);
    var end = rest.search(/\n  (push|workflow_dispatch|schedule):/);
    var block = end === -1 ? rest : rest.slice(0, end);
    return block.split('\n').filter(function (line) {
        return line.trim().charAt(0) !== '#';
    }).join('\n');
}

suite('machine merge → release trigger (gh-867)', function () {

    var wf = file_read({ path: RELEASE_WF_PATH });

    test('M1: the release fires on Machine Merge Bot completions', function () {
        var bot = file_read({ path: MERGE_BOT_WF_PATH });
        var botName = /name:\s*'([^']+)'/.exec(bot);
        assert.ok(botName && botName[1] === 'Machine Merge Bot',
            'the merge bot workflow must be named Machine Merge Bot — the ' +
            'trigger matches the workflow NAME, not the file name');
        var block = workflowRunBlock(wf);
        assert.ok(block !== '',
            'the release workflow needs a workflow_run trigger (gh-867) — ' +
            'the push trigger alone never sees GITHUB_TOKEN merge pushes');
        assert.ok(block.indexOf("'Machine Merge Bot'") !== -1,
            "workflow_run.workflows must list 'Machine Merge Bot'");
        assert.ok(/types:\s*\[?\s*completed\s*\]?/.test(block),
            'only completions may trigger (requested/in_progress would cut ' +
            'a release before the merge exists)');
    });

    test('M2: NO branches filter on the workflow_run trigger', function () {
        var block = workflowRunBlock(wf);
        assert.ok(block.indexOf('branches') === -1 && block.indexOf('branches-ignore') === -1,
            'the bot runs on PR-branch events — its workflow_run head_branch ' +
            'is the PR branch, never main. A branches: [main] filter would ' +
            'silence this trigger forever; "main filtering" is the ' +
            'tag...main diff + dist/.no-release no-op (gh-690 dedup)');
    });

    test('M3: only successful bot runs may cut a release', function () {
        assert.ok(wf.indexOf("github.event.workflow_run.conclusion == 'success'") !== -1,
            "the release job must gate workflow_run events on conclusion " +
            "== 'success' — the bot completes on every label latch tick " +
            "(merging nothing) and on failures; those must never publish");
    });

    test('M4: workflow_run-triggered runs sync to current main before the build', function () {
        var reset = wf.indexOf('git reset --hard origin/main');
        var build = wf.indexOf('node ci/release_packs.mjs');
        assert.ok(reset !== -1 && build !== -1 && reset < build,
            'the origin/main sync must precede the affected-set computation');
        assert.ok(wf.indexOf("github.event_name == 'push' || github.event_name == 'workflow_run'") !== -1,
            'the sync gate must cover push AND workflow_run events (the ' +
            'merge may land after the workflow_run event fired, and queued ' +
            'runs must release current main — gh-690)');
        assert.ok(wf.indexOf("github.event_name == 'push' || github.event_name == 'workflow_run' || github.event_name == 'workflow_dispatch'") === -1,
            'a manual dispatch may deliberately target a non-main ref — ' +
            'the sync must stay gated OFF workflow_dispatch');
    });

    test('M5: no recursion — the release never listens to itself or the kicker', function () {
        var block = workflowRunBlock(wf);
        assert.ok(block.indexOf('Agent Pack Release') === -1,
            'a workflow_run loop would chain-cut releases (max 3 chain ' +
            "levels: 'Agent Docs → Machine Merge Bot → Agent Pack Release' " +
            'is 2 — the release must not re-trigger itself)');
        assert.ok(block.indexOf('Kicker') === -1,
            'the kicker already re-dispatches the release — listening to it ' +
            'too would double-dispatch every 10-minute tick');
    });

    test('M6: push, dispatch and kicker planes stay intact (belt AND suspenders)', function () {
        assert.ok(wf.indexOf('push:') !== -1 && wf.indexOf('branches: [main]') !== -1,
            'the push trigger stays — PAT/app-token merges must still fire directly');
        assert.ok(wf.indexOf('workflow_dispatch:') !== -1 &&
            wf.indexOf('agents:') !== -1 && wf.indexOf('bump:') !== -1,
            'the manual dispatch inputs stay (operator escape hatch)');
        var kicker = file_read({ path: KICKER_WF_PATH });
        assert.ok(kicker.indexOf('schedule:') !== -1 &&
            kicker.indexOf('node ci/release_kicker.mjs') !== -1,
            'the gh-844 kicker belt stays — it still rescues any OTHER ' +
            'dropped-push path (e.g. the Merge Trigger bot)');
    });
});
