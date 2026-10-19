/**
 * Unit tests for js/factory/review_verdict.js — the review verdict glue
 * (port of awf scripts/apply-review-verdict.sh, extracted byte-exact in
 * IstiN/dmtools-agentic-workflows#34 from the factory-teammate.yml
 * «Apply the review verdict (review runs only)» step).
 *
 * Owner directive 2026-10-13/14: factory glue moves into dmtools-agents as
 * JS agent code; awf workflows become thin callers. The sh + its A/B
 * harness (9 scenarios there) stay intact as the executable spec until the
 * final rewire; the parity harness (parity_factoryReviewVerdict.js) runs
 * the REAL sh and byte-compares.
 *
 * The verdict PARSER itself is external on both sides (the pack's
 * loop/verdict.sh wins, legacy setup/review-verdict.sh is the fallback) —
 * this module ports the GLUE: fallback-source fetches, machineAuthor
 * resolution, parser selection + invocation, the eval-safe key=value
 * contract parse, label transitions, the escalation comment with the
 * GraphQL review-threads query, the CI-green gate, and the loud
 * no-verdict path (gh-305).
 *
 * Lessons from #893's review applied up front: exec results are unwrapped
 * ((res.output || res.stdout) || res), no test touches a real gh global
 * (all transports are stubs), interpolations go through shellQuote.
 *
 * assert = the harness global (equal/deepEqual/ok/contains/throws).
 */

var assert = globalThis.assert;

var tokenUsageModule = loadModule('js/factory/token_usage.js', makeRequire({}, {}), {});
var rvModule = loadModule('js/factory/review_verdict.js', makeRequire({
    './token_usage.js': tokenUsageModule
}), {});

var RUN_URL_NA = null; // (verdict step has no run url — keep the linter calm)
var NUMBER = '42';
var REPO = 'IstN/target-repo';
var PR = '7';

var BODY_FLIP = '- [ ] Run factory agent started 09:15 [1777](https://x)\n';

// ── exec/io stubs ────────────────────────────────────────────────────────────

/**
 * gh stub driven by a rules table (mirrors the awf A/B gh-stub contract):
 * rules = [[regex, kind, payload]] — kind 'out' prints payload, 'throw'
 * fails the call. Records every command + captured body files.
 */
function execStub(rules) {
    var st = { commands: [], bodies: [], thrown: 0 };
    st.exec = function (cmd) {
        cmd = String(cmd);
        st.commands.push(cmd);
        for (var i = 0; i < rules.length; i++) {
            if (new RegExp(rules[i][0]).test(cmd)) {
                if (rules[i][1] === 'throw') { st.thrown++; throw new Error('gh: ' + rules[i][2]); }
                return rules[i][2];
            }
        }
        throw new Error('gh-stub: NO RULE matched: ' + cmd);
    };
    return st;
}

function ioStub(execSt, over) {
    over = over || {};
    var io = {
        commands: execSt ? execSt.commands : [],
        written: {},
        logs: [],
        sleeps: [],
        exec: execSt ? function (cmd) { return unwrap(execSt.exec(cmd)); } : (over.exec || null),
        writeFile: function (p, c) { io.written[p] = c; },
        readFile: over.readFile || function () { throw new Error('no file'); },
        tempFile: function (hint) { return '/tmp/rv-' + hint; },
        clock: over.clock || function () { return new Date(NOW_MS); },
        sleepMs: over.sleepMs || function (ms) { io.sleeps.push(ms); },
        log: function (line) { io.logs.push(line); }
    };
    return io;
}

// the entry's unwrap (execOut pattern, no trim — body fidelity)
function unwrap(res) {
    return String((res && (res.output || res.stdout)) || res || '');
}

var NOW_MS = Date.UTC(2026, 10, 13, 12, 34, 56);
var STUB_DIR = '/tmp/awf-stub';
var VERDICT_SH = STUB_DIR + '/review-verdict.sh';

function baseOpts(over) {
    over = over || {};
    return {
        repo: REPO, number: NUMBER,
        runOutput: '.dmtools/run-output.txt',
        machineAuthor: over.machineAuthor !== undefined ? over.machineAuthor : 'machine-reviewer[bot]',
        maxRounds: over.maxRounds !== undefined ? over.maxRounds : '2',
        config: over.config !== undefined ? over.config : 'factory-agents/pr_review.json',
        factoryRoot: over.factoryRoot !== undefined ? over.factoryRoot : STUB_DIR,
        home: over.home !== undefined ? over.home : STUB_DIR + '/home',
        ghToken: over.ghToken !== undefined ? over.ghToken : 'stub-token'
    };
}

// gh rules common to most scenarios: pr list → PR 7 linked; rollup green.
function baseRules(over) {
    over = over || {};
    return [
        ["bash -c 'ls -1", 'out', STUB_DIR + '/home/.dmtools/packs/pr_review-2.0.0/loop/verdict.sh\n'],
        ['issue view.*--json labels', 'out', over.labels || 'needs-human rework-round-2'],
        ['pr list', 'out', over.prList !== undefined ? over.prList : PR],
        ['pr view.*--json comments,reviews', 'out', '[{"author":"machine-reviewer[bot]","body":"REQUEST_CHANGES"}]'],
        ['issue view.*--json comments', 'out', '[{"author":"ai-teammate","body":"verdict note"}]'],
        ['api graphql', 'out', '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'],
        ['label create', 'out', 'ok'],
        ['issue edit', 'out', 'ok'],
        ['issue comment', 'out', 'comment posted'],
        ['pr view.*statusCheckRollup', 'out', over.rollup !== undefined ? over.rollup : 'SUCCESS\n']
    ];
}

// the contract the stubbed parser emits (eval-safe key=value, like the
// awf A/B scenario's setup/review-verdict.sh stub)
function contractLines(over) {
    over = over || {};
    return [
        'decision=' + (over.decision || 'unknown'),
        'source=' + (over.source !== undefined ? over.source : 'stub-source'),
        'override=false',
        'rounds_done=' + (over.roundsDone !== undefined ? over.roundsDone : '2'),
        'next_round=' + (over.nextRound !== undefined ? over.nextRound : '3'),
        'escalate=' + (over.escalate || 'false'),
        'round_labels=' + (over.roundLabels !== undefined ? over.roundLabels : 'rework-round-2'),
        'diagnosis="' + (over.diagnosis || 'pr_review.json=present run-output=missing') + '"'
    ].join('\n');
}

// the exec stub needs a rule for the parser invocation itself; rules are
// consulted in order, so push it LAST (matches `bash ... decide`).
function withParser(st, contractOut, threadsOut) {
    st.exec = (function (orig) {
        return function (cmd) {
            if (/bash .*decide/.test(cmd)) {
                st.commands.push(cmd);
                st.lastParserCmd = cmd;
                return contractOut;
            }
            if (/bash .*threads /.test(cmd)) {
                st.commands.push(cmd);
                st.lastThreadsCmd = cmd;
                return threadsOut !== undefined ? threadsOut : 'thread summary line\n';
            }
            return orig(cmd);
        };
    })(st.exec);
    return st;
}

// ── parseVerdictContract (the eval-key=value replacement) ───────────────────

suite('factoryReviewVerdict — parseVerdictContract', function () {

  test('parses the eval-safe key=value contract with defaults for absent keys', function () {
    var c = rvModule.parseVerdictContract('decision=rework\nescalate=true\nrounds_done=1\n');
    assert.equal(c.decision, 'rework');
    assert.equal(c.escalate, true);
    assert.equal(c.rounds_done, 1);
    assert.equal(c.decision === 'rework', true);
    assert.equal(c.next_round, 0);
    assert.equal(c.source, '');
    assert.equal(c.round_labels, '');
  });

  test('quoted values keep inner spaces (the sh stub emits diagnosis="a b c")', function () {
    var c = rvModule.parseVerdictContract('decision=approve\ndiagnosis="pr_review.json=present run-output=missing"');
    assert.equal(c.diagnosis, 'pr_review.json=present run-output=missing');
  });

  test('single-quoted and empty values', function () {
    var c = rvModule.parseVerdictContract("source='run-output'\nblocking_markers=\n");
    assert.equal(c.source, 'run-output');
    assert.equal(c.blocking_markers, '');
  });

  test("non key=value lines are ignored (never eval'd — safer than the sh)", function () {
    var c = rvModule.parseVerdictContract('some parser chatter\ndecision=approve\nrm -rf /\n');
    assert.equal(c.decision, 'approve');
    assert.equal(c['rm -rf /'], undefined);
  });

  test('escalate only the literal true is true (sh string compare parity)', function () {
    assert.equal(rvModule.parseVerdictContract('escalate=true').escalate, true);
    assert.equal(rvModule.parseVerdictContract('escalate=TRUE').escalate, false);
    assert.equal(rvModule.parseVerdictContract('escalate=1').escalate, false);
  });
});

// ── machineAuthor resolution (#2 order) ──────────────────────────────────────

suite('factoryReviewVerdict — resolveMachineAuthor', function () {

  test('workflow input wins over the config knob', function () {
    var io = ioStub(null, { readFile: function () { return 'module.exports={machineAuthor:"cfg-bot"};'; } });
    assert.equal(rvModule.resolveMachineAuthor('input-bot', io), 'input-bot');
  });

  test('empty input falls back to .dmtools/config.js machineAuthor', function () {
    var io = ioStub(null, { readFile: function (p) {
        assert.equal(p, '.dmtools/config.js');
        return 'module.exports = { machineAuthor: "cfg-bot" };';
    } });
    assert.equal(rvModule.resolveMachineAuthor('', io), 'cfg-bot');
  });

  test('single-quoted machineAuthor variant', function () {
    var io = ioStub(null, { readFile: function () { return "machineAuthor: 'sq-bot'"; } });
    assert.equal(rvModule.resolveMachineAuthor('', io), 'sq-bot');
  });

  test('unreadable config → empty (only *[bot] authors trusted then)', function () {
    var io = ioStub(null, { readFile: function () { throw new Error('absent'); } });
    assert.equal(rvModule.resolveMachineAuthor('', io), '');
  });
});

// ── parser selection (pack wins, legacy fallback) ────────────────────────────

suite('factoryReviewVerdict — pickVerdictSh', function () {

  test('pack cache path wins (sort -V tail) and is logged', function () {
    var st = execStub([
        ["bash -c 'ls -1", 'out', STUB_DIR + '/home/.dmtools/packs/pr_review-2.0.0/loop/verdict.sh\n']
    ]);
    var io = ioStub(st);
    var r = rvModule.pickVerdictSh(baseOpts(), io);
    assert.equal(r, STUB_DIR + '/home/.dmtools/packs/pr_review-2.0.0/loop/verdict.sh');
    assert.contains(io.logs.join('\n'), '→ verdict logic: pack ' + r);
  });

  test('no pack → legacy FACTORY_ROOT tree, with the unpacked note', function () {
    var st = execStub([["bash -c 'ls -1", 'out', '\n']]);
    var io = ioStub(st);
    var r = rvModule.pickVerdictSh(baseOpts(), io);
    assert.equal(r, STUB_DIR + '/setup/review-verdict.sh');
    assert.contains(io.logs.join('\n'),
      '→ verdict logic: legacy tree ' + r + ' (no pr_review pack loop/verdict.sh unpacked)');
  });
});

// ── orchestration: the nine awf A/B scenarios as contract tests ─────────────

suite('factoryReviewVerdict — applyReviewVerdict (orchestration)', function () {

  test('no GH_TOKEN → warning + skip, zero gh calls', function () {
    var st = execStub([]);
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts({ ghToken: '' }), io);
    assert.equal(r.status, 'no-token');
    assert.equal(st.commands.length, 0);
    assert.equal(io.logs.join('\n'),
      '::warning::SOURCE_GITHUB_TOKEN not set — verdict labels would not trigger workflows; skipping (a maintainer must label manually)');
  });

  test('rework: exact label sequence + queue line', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'rework' }));
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'rework');
    var adds = st.commands.filter(function (c) { return c.indexOf('--add-label') !== -1; });
    assert.contains(adds.join('\n'), "--add-label 'agent:rework'");
    assert.contains(adds.join('\n'), "--add-label 'rework-round-3'");
    var creates = st.commands.filter(function (c) { return c.indexOf('label create') !== -1; });
    assert.equal(creates.length, 1);
    assert.contains(creates[0], "label create 'rework-round-3' --repo '" + REPO + "' --color 'BFD4F2' --force");
    var removes = st.commands.filter(function (c) { return c.indexOf('--remove-label') !== -1; });
    assert.contains(removes.join('\n'), "--remove-label 'needs-human'");
    assert.contains(removes.join('\n'), "--remove-label 'rework-round-2'");
    assert.contains(io.logs.join('\n'),
      '→ labeled agent:rework (round 3/2) — rework run queued (re-review follows automatically)');
    assert.equal(io.sleeps.length, 0, 'rework never polls CI');
  });

  test('rework-escalate: needs-human + threads summary comment (byte-exact body)', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'rework', escalate: 'true' }),
      'thread summary line 1\nthread summary line 2\n');
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'escalated');
    var expected =
      '🛑 **Auto-rework loop capped** — 2 automatic rework rounds without an APPROVE verdict (cap: 2). The machine stopped labeling `agent:rework`.\n' +
      '\n' +
      '### Unresolved review threads on PR #' + PR + '\n' +
      '\n' +
      'thread summary line 1\n' +
      'thread summary line 2\n' +
      '\n' +
      '_If no threads are listed, the findings live in the PR general comments._\n' +
      '\n' +
      '**Next step (human):** fix the remaining findings directly and re-label `agent:review` for a fresh review — or re-label `agent:rework` to re-arm the agent loop with a fresh round cap.\n';
    var commentCmds = st.commands.filter(function (c) { return c.indexOf('issue comment') !== -1; });
    assert.equal(commentCmds.length, 1);
    var bodyPath = commentCmds[0].replace(/^.*--body-file '/, '').replace(/'$/, '');
    assert.equal(io.written[bodyPath], expected);
    assert.contains(io.logs.join('\n'),
      '→ labeled needs-human — auto-rework capped after 2 round(s)');
    // graphql reviewThreads rode the pr number through the query vars
    var gql = st.commands.filter(function (c) { return c.indexOf('api graphql') !== -1; })[0];
    assert.contains(gql, "-F number='" + PR + "'");
    assert.contains(gql, "reviewThreads(first:100)");
  });

  test('escalate without a linked PR: the no-PR body variant, no graphql', function () {
    var st = withParser(execStub(baseRules({ prList: '' })),
      contractLines({ decision: 'rework', escalate: 'true' }));
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'escalated');
    var gql = st.commands.filter(function (c) { return c.indexOf('api graphql') !== -1; });
    assert.equal(gql.length, 0, 'no PR → no threads query');
    var commentCmds = st.commands.filter(function (c) { return c.indexOf('issue comment') !== -1; });
    var bodyPath = commentCmds[0].replace(/^.*--body-file '/, '').replace(/'$/, '');
    assert.equal(io.written[bodyPath],
      '🛑 **Auto-rework loop capped** — 2 automatic rework rounds without an APPROVE verdict (cap: 2). The machine stopped labeling `agent:rework`.\n' +
      '\n' +
      '_No linked open PR found for this issue._\n' +
      '\n' +
      '**Next step (human):** fix the remaining findings directly and re-label `agent:review` for a fresh review — or re-label `agent:rework` to re-arm the agent loop with a fresh round cap.\n');
  });

  test('escalate with a failing threads fetch: warn line, comment without summary', function () {
    var rules = [['api graphql', 'throw', 'server error']];
    Array.prototype.push.apply(rules, baseRules());
    var st = withParser(execStub(rules), contractLines({ decision: 'rework', escalate: 'true' }));
    var io = ioStub(st);
    rvModule.applyReviewVerdict(baseOpts(), io);
    assert.contains(io.logs.join('\n'),
      '::warning::reviewThreads fetch failed — the findings live in the PR review comments');
    var commentCmds = st.commands.filter(function (c) { return c.indexOf('issue comment') !== -1; });
    var bodyPath = commentCmds[0].replace(/^.*--body-file '/, '').replace(/'$/, '');
    assert.ok(io.written[bodyPath].indexOf('thread summary') === -1);
  });

  test('approve + green checks: needs-human removed, pr_approved added', function () {
    var st = withParser(execStub(baseRules({ rollup: 'SUCCESS\nSKIPPED\n' })),
      contractLines({ decision: 'approve' }));
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'approved');
    var adds = st.commands.filter(function (c) { return c.indexOf('--add-label') !== -1; });
    assert.contains(adds.join('\n'), "--add-label 'pr_approved'");
    assert.contains(io.logs.join('\n'), '→ review verdict: approve');
    assert.contains(io.logs.join('\n'), '→ linked PR #' + PR + ' — waiting for green checks (≤10 min)');
    assert.contains(io.logs.join('\n'), '→ PR #' + PR + ' checks green');
    assert.contains(io.logs.join('\n'),
      '→ labeled pr_approved — merge-trigger will squash-merge PR #' + PR + ' once CLEAN');
  });

  test('approve + red checks: warn, no label, no sleep', function () {
    var st = withParser(execStub(baseRules({ rollup: 'FAILURE\n' })),
      contractLines({ decision: 'approve' }));
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'ci-red');
    assert.equal(st.commands.filter(function (c) { return c.indexOf('pr_approved') !== -1; }).length, 0);
    assert.contains(io.logs.join('\n'),
      '::warning::PR #' + PR + ' checks FAILED — verdict not trusted, no label (a fresh dev/rework round must fix CI first)');
  });

  test('approve + pending forever: 10 min deadline → warn (bounded sleeps)', function () {
    var t = NOW_MS;
    var st = withParser(execStub(baseRules({ rollup: 'PENDING\n' })),
      contractLines({ decision: 'approve' }));
    var io = ioStub(st, {
      clock: function () { return new Date(t += 30000); }
    });
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'ci-timeout');
    assert.ok(io.sleeps.length >= 1);
    assert.deepEqual(io.sleeps, io.sleeps.map(function () { return 30000; }));
    assert.contains(io.logs.join('\n'),
      '::warning::PR #' + PR + ' checks still pending after 10 min — skipping pr_approved (re-label or re-run to retry)');
  });

  test('approve + pending-then-green: the loop polls until green', function () {
    var st = withParser(execStub(baseRules({ rollup: 'PENDING\n' })),
      contractLines({ decision: 'approve' }));
    var io = ioStub(st);
    // first rollup call returns PENDING, then SUCCESS (rule list is
    // consulted in order; push a one-shot pending rule FIRST)
    var calls = 0;
    st.exec = (function (orig) {
      return function (cmd) {
        if (cmd.indexOf('statusCheckRollup') !== -1) {
          calls++;
          return calls === 1 ? 'PENDING\n' : 'SUCCESS\n';
        }
        return orig(cmd);
      };
    })(st.exec);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'approved');
    assert.equal(io.sleeps.length, 1);
    assert.equal(io.sleeps[0], 30000);
  });

  test('rollup fetch failure is tolerated (sh: `|| true` → empty states → keep polling)', function () {
    var rules = [['statusCheckRollup', 'throw', 'boom']];
    Array.prototype.push.apply(rules, baseRules());
    var t = NOW_MS;
    var st = withParser(execStub(rules), contractLines({ decision: 'approve' }));
    var io = ioStub(st, { clock: function () { return new Date(t += 300000); } });
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'ci-timeout');
  });

  test('no verdict: LOUD failure — ::error::, needs-human, diagnosis comment, THROWS (exit-1 parity)', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'unknown' }));
    var io = ioStub(st);
    var threw = null;
    try { rvModule.applyReviewVerdict(baseOpts(), io); } catch (e) { threw = e; }
    assert.ok(threw, 'must throw (the sh exits 1)');
    assert.contains(io.logs.join('\n'),
      '::error::no verdict found in any source (pr_review.json / run output / PR comments / issue comments) — the review cycle cannot be labeled (gh-305)');
    assert.contains(io.logs.join('\n'), '→ diagnosis: pr_review.json=present run-output=missing');
    var creates = st.commands.filter(function (c) { return c.indexOf('label create') !== -1; });
    assert.contains(creates.join('\n'), "'needs-human'");
    assert.contains(creates.join('\n'), "'B60205'");
    var adds = st.commands.filter(function (c) { return c.indexOf('--add-label') !== -1; });
    assert.contains(adds.join('\n'), "--add-label 'needs-human'");
    var commentCmds = st.commands.filter(function (c) { return c.indexOf('issue comment') !== -1; });
    var bodyPath = commentCmds[0].replace(/^.*--body-file '/, '').replace(/'$/, '');
    assert.equal(io.written[bodyPath],
      '🛑 **Review verdict missing** — the review leg finished, but no verdict (APPROVE / REQUEST_CHANGES / BLOCK) was found in any source, so the cycle cannot be labeled.\n' +
      '\n' +
      'Per-source diagnosis: `pr_review.json=present run-output=missing`\n' +
      '\n' +
      "_Next step (human):_ read the review leg's run output, then label `pr_approved` (approve) or `agent:rework` (changes requested) — or re-run the review leg.\n");
  });

  test('approve with no linked PR: warn + skip (no pr_approved)', function () {
    var st = withParser(execStub(baseRules({ prList: '' })),
      contractLines({ decision: 'approve' }));
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'approve-no-pr');
    assert.contains(io.logs.join('\n'),
      '::warning::APPROVE verdict but no linked open PR for #' + NUMBER + ' — skipping pr_approved');
    assert.equal(st.commands.filter(function (c) { return c.indexOf('pr_approved') !== -1; }).length, 0);
  });

  test('labels fetch failure degrades to empty (sh: `|| echo \'\'`)', function () {
    var rules = [['issue view.*--json labels', 'throw', 'boom']];
    Array.prototype.push.apply(rules, baseRules());
    var st = withParser(execStub(rules), contractLines({ decision: 'rework' }));
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'rework');
    var parserEnv = st.lastParserCmd;
    assert.contains(parserEnv, "ISSUE_LABELS=''");
  });

  test('the parser invocation carries the full env contract', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'rework' }));
    var io = ioStub(st);
    rvModule.applyReviewVerdict(baseOpts(), io);
    var c = st.lastParserCmd;
    assert.contains(c, "MAX_ROUNDS='2'");
    assert.contains(c, "PR_REVIEW_JSON='outputs/pr_review.json'");
    assert.contains(c, "PR_REVIEW_JSON_ALT='outputs/gh-42/pr_review.json'");
    assert.contains(c, "RUN_OUTPUT='.dmtools/run-output.txt'");
    assert.contains(c, "MACHINE_AUTHOR='machine-reviewer[bot]'");
    assert.contains(c, "ISSUE_LABELS='needs-human rework-round-2'");
    assert.contains(c, "bash '" + STUB_DIR + "/home/.dmtools/packs/pr_review-2.0.0/loop/verdict.sh' decide");
  });

  test('decision line logs source/override with sh defaults', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'approve', source: '' }));
    var io = ioStub(st);
    rvModule.applyReviewVerdict(baseOpts(), io);
    assert.contains(io.logs.join('\n'),
      '→ review decision: approve (source=none, override=false, rounds_done=2)');
  });
});

// ── JSRunner entry ───────────────────────────────────────────────────────────

suite('factoryReviewVerdict — entry action (review_verdict_publish.js)', function () {

  var entryModule = loadModule('js/factory/review_verdict_publish.js', makeRequire({
    './review_verdict.js': rvModule,
    './token_usage.js': tokenUsageModule
  }), {});

  test('resolveParams: customParams > env > defaults', function () {
    var p = entryModule.resolveParams(
      { jobParams: { customParams: { number: '1', repo: 'C/R' } } },
      { NUMBER: '42', GITHUB_REPOSITORY: 'E/R', MAX_ROUNDS: '3' });
    assert.equal(p.number, '1');
    assert.equal(p.repo, 'C/R');
    assert.equal(p.maxRounds, '3');
  });

  test('resolveParams: runOutput default matches the sh step env', function () {
    var p = entryModule.resolveParams({}, {});
    assert.equal(p.runOutput, '.dmtools/run-output.txt');
  });

  test('action unwraps a result-object transport ({output}) and still flips', function () {
    var r = entryModule.action(
      { jobParams: { customParams: {
        repo: REPO, number: NUMBER, maxRounds: '2', ghToken: 't',
        config: 'factory-agents/pr_review.json', factoryRoot: STUB_DIR, home: STUB_DIR + '/home'
      } } },
      {
        cli_execute_command: (function () {
          var inner = execStub(baseRules());
          inner = withParser(inner, contractLines({ decision: 'rework' }));
          return function (args) {
            var out = inner.exec(String((args && args.command) || args || ''));
            return { output: out };   // result-object transport
          };
        })(),
        file_write: function (p, c) {},
        env: {}
      });
    assert.equal(r.status, 'rework');
  });

  test('action with a throwing transport surfaces the error (stubbed, no network)', function () {
    assert.throws(function () {
      entryModule.action(
        { jobParams: { customParams: { repo: 'O/R', number: '1', ghToken: 't' } } },
        { cli_execute_command: function () { throw new Error('gh: boom'); }, env: {} });
    });
  });
});

// ── round-3 rework: production seams (sleep, temp workspace, guards) ─────────

suite('factoryReviewVerdict — entry production seams (round-3 rework)', function () {

  var entryModule = loadModule('js/factory/review_verdict_publish.js', makeRequire({
    './review_verdict.js': rvModule,
    './token_usage.js': tokenUsageModule
  }), {});

  function runAction(st, customParams, depsOver) {
    depsOver = depsOver || {};
    var deps = {
      cli_execute_command: function (args) {
        return { output: st.exec(String((args && args.command) || args || '')) };
      },
      file_write: function (p, c) { st.written = st.written || {}; st.written[p] = c; },
      file_read: function () { return null; },
      env: {}
    };
    Object.keys(depsOver).forEach(function (k) { deps[k] = depsOver[k]; });
    return entryModule.action(
      { jobParams: { customParams: Object.assign({
        repo: REPO, number: NUMBER, maxRounds: '2', ghToken: 't',
        config: 'factory-agents/pr_review.json', factoryRoot: STUB_DIR,
        home: STUB_DIR + '/home'
      }, customParams || {}) } }, deps);
  }

  test('production sleepMs is a REAL sleep (the no-op busy-loop blocker)', function () {
    assert.equal(typeof entryModule.productionSleepMs, 'function');
    var t0 = Date.now();
    entryModule.productionSleepMs(25);
    var took = Date.now() - t0;
    assert.ok(took >= 20, 'productionSleepMs(25) must block ~25ms, took ' + took + 'ms');
    var t1 = Date.now();
    entryModule.productionSleepMs(0);
    entryModule.productionSleepMs(-5);
    entryModule.productionSleepMs('garbage');
    assert.ok(Date.now() - t1 < 100, 'non-positive/garbage ms must return immediately');
  });

  test('production sleepMs rides the Java bridge when present (the JSRunner runtime)', function () {
    var sleeps = [];
    var withJava = loadModule('js/factory/review_verdict_publish.js', makeRequire({
      './review_verdict.js': rvModule,
      './token_usage.js': tokenUsageModule
    }), { Java: { type: function (name) {
      assert.equal(name, 'java.lang.Thread');
      return { sleep: function (ms) { sleeps.push(ms); } };
    } } });
    withJava.productionSleepMs(123);
    assert.deepEqual(sleeps, [123]);
  });

  test('action wires the production sleep by default (the poll loop beats 30s)', function () {
    var real = entryModule.productionSleepMs;
    var spied = [];
    entryModule.productionSleepMs = function (ms) { spied.push(ms); };
    try {
      var t = NOW_MS;
      var st = withParser(execStub(baseRules({ rollup: 'PENDING\n' })),
        contractLines({ decision: 'approve' }));
      var r = runAction(st, {}, { clock: function () { return new Date(t += 30000); } });
      assert.equal(r.status, 'ci-timeout');
      assert.ok(spied.length >= 1, 'the default sleep must sit inside the poll loop');
      assert.deepEqual(spied, spied.map(function () { return 30000; }));
    } finally {
      entryModule.productionSleepMs = real;
    }
  });

  test('staged bodies ride a mktemp -d workspace, cleaned up like the sh trap', function () {
    var st = withParser(execStub([['^mktemp -d$', 'out', '/tmp/rvw-mk-4242']]
      .concat(baseRules())), contractLines({ decision: 'rework', escalate: 'true' }),
      'thread summary line\n');
    var r = runAction(st);
    assert.equal(r.status, 'escalated');
    var commentCmds = st.commands.filter(function (c) { return c.indexOf('issue comment') !== -1; });
    assert.equal(commentCmds.length, 1);
    assert.contains(commentCmds[0], '--body-file \'/tmp/rvw-mk-4242/comment.md\'');
    var cleans = st.commands.filter(function (c) { return c.indexOf('rm -rf') === 0; });
    assert.equal(cleans.length, 1);
    assert.contains(cleans[0], 'rm -rf \'/tmp/rvw-mk-4242\'');
    assert.ok(st.commands.indexOf(cleans[0]) > st.commands.indexOf(commentCmds[0]),
      'cleanup runs after the comment is posted (the sh trap ordering)');
  });

  test('the loud no-verdict path still cleans the workspace (finally ≈ the sh trap)', function () {
    var st = withParser(execStub([['^mktemp -d$', 'out', '/tmp/rvw-mk-77']]
      .concat(baseRules())), contractLines({ decision: 'unknown' }));
    var threw = null;
    try { runAction(st); } catch (e) { threw = e; }
    assert.ok(threw, 'the loud path must throw (exit-1 parity)');
    var cleans = st.commands.filter(function (c) { return c.indexOf('rm -rf') === 0; });
    assert.equal(cleans.length, 1);
    assert.contains(cleans[0], 'rm -rf \'/tmp/rvw-mk-77\'');
  });

  test('no mktemp on the transport → unpredictable per-run names, staged files rm -f\'ed', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'rework', escalate: 'true' }),
      'thread summary line\n');
    var r = runAction(st);
    assert.equal(r.status, 'escalated');
    var commentCmds = st.commands.filter(function (c) { return c.indexOf('issue comment') !== -1; });
    var m = commentCmds[0].match(/--body-file '([^']+)'/);
    assert.ok(m, 'body file staged');
    assert.equal(/^\/tmp\/rv-\d+-\d+-comment\.md$/.test(m[1]), true,
      'unpredictable per-run fallback name, got: ' + m[1]);
    assert.notEqual(m[1], '/tmp/rv-1-comment.md');
    var cleans = st.commands.filter(function (c) { return c.indexOf('rm -f ') === 0; });
    assert.equal(cleans.length, 1);
    assert.contains(cleans[0], m[1]);
  });
});

// ── round-3 rework: module guards ────────────────────────────────────────────

suite('factoryReviewVerdict — applyReviewVerdict guards (round-3 rework)', function () {

  test('non-numeric NUMBER fails loud BEFORE any gh call (the raw jq-splice guard)', function () {
    ['42abc', 'abc', '4 2', "42'; echo pwned", ''].forEach(function (bad) {
      var st = withParser(execStub(baseRules()), contractLines({ decision: 'approve' }));
      var io = ioStub(st);
      var threw = null;
      try { rvModule.applyReviewVerdict(Object.assign(baseOpts(), { number: bad }), io); } catch (e) { threw = e; }
      assert.ok(threw, 'must throw for NUMBER=' + JSON.stringify(bad));
      assert.contains(String(threw && threw.message || threw), 'NUMBER must be numeric');
      assert.equal(st.commands.length, 0, 'zero gh calls for NUMBER=' + JSON.stringify(bad));
    });
  });

  test('token gate precedes the NUMBER guard (the sh checks the token first)', function () {
    var st = execStub([]);
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts({ ghToken: '', number: 'abc' }), io);
    assert.equal(r.status, 'no-token');
    assert.equal(st.commands.length, 0);
  });

  test('pr-list jq program carries DOUBLE backslashes (pin the README parity claim)', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'rework' }));
    var io = ioStub(st);
    rvModule.applyReviewVerdict(baseOpts(), io);
    var prList = st.commands.filter(function (c) { return c.indexOf('pr list') !== -1; })[0];
    assert.ok(prList, 'pr list was called');
    assert.contains(prList, '\\\\b(closes|fixes|resolves)\\\\s+#' + NUMBER + '\\\\b');
  });
});

// ── gh-1101: approval on an already-green head kicks ONE SM tick ────────────
suite('review verdict — gh-1101 SM tick on approval', function () {
  var SHA = '1fbfd41a1fbfd41a1fbfd41a1fbfd41a1fbfd41a';
  function kickRules(green, smLive) {
    return [
      ['headRefOid', 'out', SHA + '\n'],
      ['actions/workflows/quality.yml/runs', 'out', green + '\n'],
      ['run list', 'out', smLive + '\n'],
      ['workflow run', 'out', 'ok']
    ].concat(baseRules({ rollup: 'SUCCESS\n' }));
  }
  function smKicks(st) {
    return st.commands.filter(function (c) { return c.indexOf('gh workflow run') === 0; });
  }
  function approve(rules, optsOver) {
    var st = withParser(execStub(rules), contractLines({ decision: 'approve' }));
    var r = rvModule.applyReviewVerdict(Object.assign(baseOpts(), optsOver || {}), ioStub(st));
    return { st: st, r: r };
  }

  test('(d) approval with a green dispatched run on the head ⇒ exactly one SM tick', function () {
    var x = approve(kickRules(1, 0));
    assert.equal(x.r.status, 'approved');
    assert.equal(x.r.smKicked, true);
    assert.equal(smKicks(x.st).length, 1);
    assert.contains(smKicks(x.st)[0], "'machine-sm.yml'");
  });

  test('SM tick already queued/running ⇒ no duplicate', function () {
    var x = approve(kickRules(1, 1));
    assert.equal(x.r.smKicked, false);
    assert.equal(smKicks(x.st).length, 0);
  });

  test('no green run on the current head ⇒ no SM tick', function () {
    var x = approve(kickRules(0, 0));
    assert.equal(smKicks(x.st).length, 0);
  });

  test('configured smWorkflow / ciWorkflow are honored; smKick=false disables', function () {
    var rules = [['actions/workflows/ci.yml/runs', 'out', '1\n']].concat(kickRules(0, 0));
    var x = approve(rules, { smWorkflow: 'sm.yml', ciWorkflow: 'ci.yml' });
    assert.equal(smKicks(x.st).length, 1);
    assert.contains(smKicks(x.st)[0], "'sm.yml'");
    var y = approve(kickRules(1, 0), { smKick: 'false' });
    assert.equal(smKicks(y.st).length, 0);
  });

  test('SM liveness probe failure counts as live (never risk a duplicate)', function () {
    var rules = [['run list', 'throw', 'boom']].concat(kickRules(1, 0));
    var x = approve(rules);
    assert.equal(smKicks(x.st).length, 0);
  });

  test('SM dispatch failure is tolerated', function () {
    var rules = [['workflow run', 'throw', 'boom']].concat(kickRules(1, 0));
    var x = approve(rules);
    assert.equal(x.r.status, 'approved');
    assert.equal(x.r.smKicked, false);
  });
});

// ── gh-1079: applyReviewVerdict characterization ─────────────────────────────
// Pins the currently-uncovered branches (entry defaults, unwrap/parse edge
// contracts, legacy parser fallback, parser-env defaults, probe failure,
// missing round_labels/diagnosis/maxRounds rendering, clock-less io, SM-kick
// warn paths) BEFORE the handler extraction — green now, must stay green.

suite('factoryReviewVerdict — applyReviewVerdict characterization (gh-1079)', function () {

  // gh-1101 kick-world rules (suite-local copy — the original lives inside
  // the gh-1101 suite): green dispatched run on the head, SM idle.
  var KICK_SHA = '1fbfd41a1fbfd41a1fbfd41a1fbfd41a1fbfd41a';
  function kickRules(green, smLive) {
    return [
      ['headRefOid', 'out', KICK_SHA + '\n'],
      ['actions/workflows/quality.yml/runs', 'out', green + '\n'],
      ['run list', 'out', smLive + '\n'],
      ['workflow run', 'out', 'ok']
    ].concat(baseRules({ rollup: 'SUCCESS\n' }));
  }

  test('applyReviewVerdict() with no arguments short-circuits to no-token, zero calls', function () {
    var r = rvModule.applyReviewVerdict();
    assert.deepEqual(r, { status: 'no-token' });

    var st = execStub([]);
    var r2 = rvModule.applyReviewVerdict(baseOpts({ ghToken: '' }), ioStub(st));
    assert.deepEqual(r2, { status: 'no-token' });
    assert.equal(st.commands.length, 0);
  });

  test('unwrap contract: absent/empty object output is empty, plain strings ride verbatim', function () {
    assert.equal(rvModule.unwrap({}), '');
    assert.equal(rvModule.unwrap(null), '');
    assert.equal(rvModule.unwrap(undefined), '');
    assert.equal(rvModule.unwrap({ output: '' }), '');
    assert.equal(rvModule.unwrap({ stdout: 's' }), 's');
    assert.equal(rvModule.unwrap('raw-string'), 'raw-string');
    assert.equal(rvModule.unwrap(0), '');
  });

  test('parseVerdictContract(null/undefined) yields the all-default contract', function () {
    var c = rvModule.parseVerdictContract(null);
    assert.equal(c.decision, '');
    assert.equal(c.source, '');
    assert.equal(c.override, '');
    assert.equal(c.blocking_markers, '');
    assert.equal(c.rounds_done, 0);
    assert.equal(c.next_round, 0);
    assert.equal(c.escalate, false);
    assert.equal(c.round_labels, '');
    assert.equal(c.diagnosis, '');
    assert.equal(rvModule.parseVerdictContract(undefined).decision, '');
  });

  test('pickVerdictSh: probe exec failure still falls back to the legacy tree', function () {
    var st = execStub([["bash -c 'ls -1", 'throw', 'exploded']]);
    var io = ioStub(st);
    var r = rvModule.pickVerdictSh(baseOpts(), io);
    assert.equal(r, STUB_DIR + '/setup/review-verdict.sh');
    assert.contains(io.logs.join('\n'),
      '→ verdict logic: legacy tree ' + r + ' (no pr_review pack loop/verdict.sh unpacked)');
  });

  test('pickVerdictSh: absent config/factoryRoot still resolve a (rootless) legacy path', function () {
    var st = execStub([['bash -c', 'out', '\n']]);
    var io = ioStub(st);
    var r = rvModule.pickVerdictSh({}, io);
    assert.equal(r, '/setup/review-verdict.sh');
  });

  test('parser env: MAX_ROUNDS empty when undefined; RUN_OUTPUT falls back to the sh default', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'rework' }));
    var io = ioStub(st);
    rvModule.applyReviewVerdict(baseOpts({ maxRounds: undefined, runOutput: undefined }), io);
    var c = st.lastParserCmd;
    assert.contains(c, "MAX_ROUNDS=''");
    assert.contains(c, "RUN_OUTPUT='.dmtools/run-output.txt'");
  });

  test('probe failure (parser exec throws) → empty contract → unknown decision → LOUD path with no diagnosis', function () {
    var rules = [['decide', 'throw', 'parser exploded']];
    Array.prototype.push.apply(rules, baseRules());
    var st = execStub(rules);
    var io = ioStub(st);
    var threw = null;
    try { rvModule.applyReviewVerdict(baseOpts(), io); } catch (e) { threw = e; }
    assert.ok(threw, 'probe failure degrades to unknown → the loud exit-1 path');
    assert.contains(String(threw && threw.message || threw), 'review verdict missing');
    assert.contains(io.logs.join('\n'), '→ diagnosis: none');
    var commentCmds = st.commands.filter(function (c) { return c.indexOf('issue comment') !== -1; });
    var bodyPath = commentCmds[0].replace(/^.*--body-file '/, '').replace(/'$/, '');
    assert.contains(io.written[bodyPath], 'Per-source diagnosis: `n/a`');
  });

  test('parser chatter with NO decision line → unknown decision → the loud path too', function () {
    var st = withParser(execStub(baseRules()), 'just chatter\nno keys here\n');
    var io = ioStub(st);
    var threw = null;
    try { rvModule.applyReviewVerdict(baseOpts(), io); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.contains(io.logs.join('\n'), '→ review decision: unknown (source=none, override=false, rounds_done=0)');
  });

  test('rework with an empty round_labels contract: only needs-human is removed', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'rework', roundLabels: '' }));
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'rework');
    var removes = st.commands.filter(function (c) { return c.indexOf('--remove-label') !== -1; });
    assert.equal(removes.length, 1, 'no round labels in the contract → nothing else to strip');
    assert.contains(removes[0], "--remove-label 'needs-human'");
    assert.notContains(removes.join('\n'), 'rework-round');
  });

  test('rework with maxRounds undefined: the queue log renders an empty cap', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'rework' }));
    var io = ioStub(st);
    rvModule.applyReviewVerdict(baseOpts({ maxRounds: undefined }), io);
    assert.contains(io.logs.join('\n'),
      '→ labeled agent:rework (round 3/) — rework run queued (re-review follows automatically)');
  });

  test('escalate with maxRounds undefined: the comment renders an empty cap', function () {
    var st = withParser(execStub(baseRules()), contractLines({ decision: 'rework', escalate: 'true' }),
      'thread summary line\n');
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts({ maxRounds: undefined }), io);
    assert.equal(r.status, 'escalated');
    var commentCmds = st.commands.filter(function (c) { return c.indexOf('issue comment') !== -1; });
    var bodyPath = commentCmds[0].replace(/^.*--body-file '/, '').replace(/'$/, '');
    assert.contains(io.written[bodyPath],
      '🛑 **Auto-rework loop capped** — 2 automatic rework rounds without an APPROVE verdict (cap: ). The machine stopped labeling `agent:rework`.');
  });

  test('approve path tolerates a log-less, clock-less io (new Date() clock, no crash)', function () {
    var st = withParser(execStub(baseRules({ rollup: 'SUCCESS\n' })),
      contractLines({ decision: 'approve' }));
    var io = ioStub(st);
    delete io.log;
    delete io.clock;
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'approved');
    var adds = st.commands.filter(function (c) { return c.indexOf('--add-label') !== -1; });
    assert.contains(adds.join('\n'), "--add-label 'pr_approved'");
  });

  test('SM dispatch failure with a non-Error throw warns via String(e)', function () {
    var rules = [['workflow run', 'throw', 'gh: plain string']];
    Array.prototype.push.apply(rules, kickRules(1, 0));
    var st = withParser(execStub(rules), contractLines({ decision: 'approve' }));
    var io = ioStub(st);
    var r = rvModule.applyReviewVerdict(baseOpts(), io);
    assert.equal(r.status, 'approved');
    assert.equal(r.smKicked, false);
    assert.contains(io.logs.join('\n'), '::warning::SM tick dispatch failed: gh: plain string');
  });

  test('kickSmOnGreenHead works with a log-less io (default no-op logger)', function () {
    var st = execStub(kickRules(1, 0));
    var io = ioStub(st);
    delete io.log;
    var kicked = rvModule.kickSmOnGreenHead(baseOpts(), io, PR);
    assert.equal(kicked, true);
    assert.equal(st.commands.filter(function (c) { return c.indexOf('gh workflow run') === 0; }).length, 1);
  });

});
