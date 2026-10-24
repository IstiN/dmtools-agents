/**
 * Issue #889 scenario capture — «[BUG] copilot usage is not posted to ADO».
 *
 * The owner merge gate for the factory JS migration: a real factory leg must
 * process #889 on the ported code, so the token-usage contract must already
 * cover it. #889 has TWO transports for copilot usage, both captured here:
 *
 *   1. Board rows (producer side, dmtools-agents#781): the copilot leg's
 *      `fa-tokens:` ledger lines land on the factory-data branch
 *      (data/fa-tokens.json) with the copilot model preserved — the SM tick
 *      renders them on the ADO board. The publisher performs ZERO tracker
 *      calls: the exec capturer here rejects anything that does not start
 *      with `gh`, so a jira_post_comment/tracker_post_comment path would
 *      fail the test.
 *   2. Ticket comments (js/common/tokenUsageComment.js): a leg whose agent
 *      wrote outputs/copilot_usage.json must post through the
 *      vendor-agnostic tracker (tracker.postComment; providers from
 *      config.tracker.provider — agents#854), formatted for ADO markdown
 *      (agents#877/#878) — never through the Jira-only jira_post_comment
 *      global the #889 log shows failing.
 *
 * These are regression guards on ALREADY-ported modules (token_usage.js from
 * the pilot PR #892, tokenUsageComment.js from agents#854/#877); they go
 * green with the modules as merged — red here means a #889-class break.
 */

var assert = globalThis.assert;

var tokenUsage = loadModule('js/factory/token_usage.js', makeRequire({}, {}), {});

var NOW = '2026-10-13T12:34:56Z';

// gh-1230 CRAP: the per-command decision lives in the pure boardExecResponse
// helper below; exec only guards the gh-only transport contract. Both are
// file-level (named) so each stays a small, separately-measured function.
function boardExecStub(map) {
  var state = { puts: 0, trackerCalls: [], commands: [] };
  function exec(args) {
    var cmd = String((args && args.command) || args || '');
    state.commands.push(cmd);
    // #889 guard: the producer is gh-only. Any tracker tool call here
    // (jira_post_comment / tracker_post_comment / ADO REST) is a break.
    if (cmd.indexOf('gh') !== 0) {
      state.trackerCalls.push(cmd);
      throw new Error('#889: non-gh transport reached the publisher: ' + cmd);
    }
    return boardExecResponse(cmd, map, state);
  }
  return { state: state, exec: exec };
}

// gh-1230 CRAP: pure gh-command decision table (PUT puts-counter with a
// 409 fail budget, sha probe, base64 body probe, empty fallback).
function boardExecResponse(cmd, map, state) {
  if (cmd.indexOf('-X PUT') !== -1) {
    state.puts++;
    if (state.puts <= (map.failPuts || 0)) throw new Error('gh: 409 sha was not supplied');
    return { output: '' };
  }
  if (cmd.indexOf('--jq .sha') !== -1) {
    if (map.sha == null) throw new Error('gh: Not Found (404)');
    return { output: map.sha };
  }
  if (cmd.indexOf('base64 -d') !== -1) {
    if (map.body == null) throw new Error('gh: Not Found (404)');
    return { output: map.body };
  }
  return { output: '' };
}

// ── 1. producer side: copilot ledger rows reach the factory-data board ──────

suite('issue889 — copilot usage rows reach the ADO board (factory-data producer)', function () {

  // Copilot leg run output: two fa-tokens segments (resume-aware), wrapped
  // in log noise, copilot model on the last segment (last-seen wins).
  var COPILOT_RUN_OUTPUT = [
    '::log:: copilot session s1 start',
    'fa-tokens: {"sessionId":"s1","segment":1,"input":4200,"output":910,"cacheRead":15300}',
    'some log line with braces {"not":"a ledger"}',
    'fa-tokens:\t{"sessionId":"s1","segment":2,"input":1200,"output":640,"cacheRead":2100,"model":"copilot/claude-sonnet-4.5"}',
    '::log:: done'
  ].join('\n');

  test('copilot ledger segments sum onto one board row with the copilot model preserved', function () {
    var sums = tokenUsage.parseFaTokensLedger(COPILOT_RUN_OUTPUT);
    assert.equal(sums.input, 5400);
    assert.equal(sums.output, 1550);
    assert.equal(sums.cacheRead, 17400);
    assert.equal(sums.model, 'copilot/claude-sonnet-4.5');
  });

  test('issue-anchored copilot leg publishes its row to data/fa-tokens.json', function () {
    var stub = boardExecStub({ sha: 'shabbsha', body: '{}' });
    var r = tokenUsage.publishTokenUsage({
      runOutput: '/tmp/run.txt', configPath: 'factory-agents/pr_review.json',
      kind: 'review', anchor: 'gh-889', repo: 'IstN/target-repo',
      dataBranch: 'factory-data', dataPath: 'data/fa-tokens.json', now: NOW
    }, { exec: stub.exec, read: function () { return COPILOT_RUN_OUTPUT; }, log: function () {} });
    assert.equal(r.status, 'published');
    assert.equal(r.key, 'issue-889');
    assert.equal(r.row.model, 'copilot/claude-sonnet-4.5');
    assert.equal(r.row.total, 6950);
    assert.deepEqual(stub.state.trackerCalls, [], 'no tracker transport may be used');
  });

  test('pr-anchored copilot leg (rework slot collapses to dev; basename recovers rework)', function () {
    var stub = boardExecStub({ sha: 'shabbsha', body: '{}' });
    var r = tokenUsage.publishTokenUsage({
      runOutput: '/tmp/run.txt', configPath: 'factory-agents/pr_rework.json',
      kind: 'dev', anchor: 'pr-889', repo: 'IstN/target-repo',
      dataBranch: 'factory-data', dataPath: 'data/fa-tokens.json', now: NOW
    }, { exec: stub.exec, read: function () { return COPILOT_RUN_OUTPUT; }, log: function () {} });
    assert.equal(r.status, 'published');
    assert.equal(r.key, 'pr-889');
    assert.equal(r.leg, 'rework');
  });

  test('a leg whose copilot ledger never printed still warns and never gates', function () {
    var stub = boardExecStub({});
    var r = tokenUsage.publishTokenUsage({
      runOutput: '/tmp/run.txt', configPath: 'factory-agents/pr_review.json',
      kind: 'review', anchor: 'gh-889', repo: 'IstN/target-repo', now: NOW
    }, { exec: stub.exec, read: function () { return 'no ledger here\n'; }, log: function () {} });
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'no-ledger');
  });
});

// ── 2. ticket side: outputs/copilot_usage.json posts through the ADO tracker ─

suite('issue889 — copilot usage comment posts through the vendor-agnostic tracker', function () {

  function loadWith(mocks) {
    return loadModule('js/common/tokenUsageComment.js', makeRequire({
      './trackers.js': {
        createTracker: function () {
          throw new Error('#889: createTracker must not run when options.tracker is given');
        }
      }
    }), mocks);
  }

  function adoTrackerStub() {
    var t = {
      comments: [],
      provider: function () { return 'ado'; },
      postComment: function (key, comment) { t.comments.push({ key: key, comment: comment }); }
    };
    return t;
  }

  var COPILOT_USAGE = { provider: 'copilot', model: 'copilot/claude-sonnet-4.5', total_tokens: 6950 };

  test('outputs/copilot_usage.json posts to the ADO ticket in ADO markdown shape', function () {
    var mod = loadWith({
      file_read: function (opts) {
        if (opts.path === 'outputs/token_usage_files.json') {
          return JSON.stringify(['outputs/copilot_usage.json']);
        }
        if (opts.path === 'outputs/copilot_usage.json') {
          return JSON.stringify(COPILOT_USAGE);
        }
        return null;
      }
    });
    var tracker = adoTrackerStub();
    var r = mod.postTokenUsageComments('889', { tracker: tracker });
    assert.equal(r.posted, 1);
    assert.equal(tracker.comments.length, 1);
    assert.equal(tracker.comments[0].key, '889');
    var comment = tracker.comments[0].comment;
    // agents#877/#878 ADO markdown: bold label + fenced json, no [label]:
    // link-reference definition, no [~accountid:] jira mention markup.
    assert.contains(comment, '**copilot**');
    assert.contains(comment, '"total_tokens":6950');
    assert.ok(comment.indexOf('[copilot]:') === -1, 'ADO must not get the jira [label]: shape');
    assert.ok(comment.indexOf('[~accountid:') === -1, 'ADO must not get jira mention markup');
  });

  test('an ADO leg never touches the jira_post_comment global (#889 regression guard)', function () {
    var mod = loadWith({
      file_read: function (opts) {
        if (opts.path === 'outputs/token_usage_files.json') {
          return JSON.stringify(['outputs/copilot_usage.json']);
        }
        if (opts.path === 'outputs/copilot_usage.json') {
          return JSON.stringify(COPILOT_USAGE);
        }
        return null;
      },
      // If any code path in the loaded module reached for the Jira-only
      // global the #889 log shows failing, this throws and fails the test.
      jira_post_comment: function () {
        throw new Error('#889 regression: jira_post_comment called on an ADO leg');
      }
    });
    var tracker = adoTrackerStub();
    var r = mod.postTokenUsageComments('889', { tracker: tracker });
    assert.equal(r.posted, 1);
    assert.deepEqual(r.errors, []);
  });
});

// ── 3. gh-1230 CRAP characterization: board exec stub contract ───────────────

suite('issue889 — boardExecStub contract (gh-1230 characterization)', function () {

  test('non-gh transport throws the #889 break and lands on trackerCalls (all shapes)', function () {
    var stub = boardExecStub({});
    var offenders = ['jira_post_comment x', 'tracker_post_comment y', 'curl -X PUT https://ado'];
    for (var i = 0; i < offenders.length; i++) {
      var threw = null;
      try { stub.exec(offenders[i]); } catch (e) { threw = e; }
      assert.ok(threw, offenders[i] + ' must be rejected');
      assert.contains(threw.message, '#889: non-gh transport reached the publisher');
      assert.equal(stub.state.trackerCalls[i], offenders[i], 'offender recorded in order');
    }
    assert.equal(stub.state.trackerCalls.length, 3);
  });

  test('gh commands are recorded and unknown gh commands get an empty output', function () {
    var stub = boardExecStub({});
    assert.equal(stub.exec({ command: 'gh api repos/x/y' }).output, '');
    assert.equal(stub.exec('gh pr view 5').output, '');
    assert.deepEqual(stub.state.commands, ['gh api repos/x/y', 'gh pr view 5']);
    assert.deepEqual(stub.state.trackerCalls, []);
  });

  test('boardExecResponse: PUT succeeds, counts puts, honours failPuts 409 budget', function () {
    var state = { puts: 0 };
    assert.deepEqual(boardExecResponse('gh api -X PUT d', {}, state), { output: '' });
    assert.equal(state.puts, 1);
    var st2 = { puts: 0 };
    var threw = null;
    try { boardExecResponse('gh api -X PUT d', { failPuts: 2 }, st2); } catch (e) { threw = e; }
    assert.ok(threw, 'first PUT within the fail budget must 409');
    assert.contains(threw.message, 'gh: 409 sha was not supplied');
    assert.equal(st2.puts, 1);
    assert.deepEqual(boardExecResponse('gh api -X PUT d', { failPuts: 1 }, st2), { output: '' },
      'PUT after the fail budget is exhausted succeeds');
    assert.equal(st2.puts, 2);
  });

  test('boardExecResponse: sha probe returns map.sha, 404 when unset', function () {
    var state = { puts: 0 };
    assert.deepEqual(boardExecResponse('gh api --jq .sha x', { sha: 'abc' }, state), { output: 'abc' });
    var threw = null;
    try { boardExecResponse('gh api --jq .sha x', {}, state); } catch (e) { threw = e; }
    assert.ok(threw, 'unset sha must 404');
    assert.contains(threw.message, 'gh: Not Found (404)');
  });

  test('boardExecResponse: base64 body probe returns map.body, 404 when unset', function () {
    var state = { puts: 0 };
    assert.deepEqual(boardExecResponse('gh api x | base64 -d', { body: '{"a":1}' }, state), { output: '{"a":1}' });
    var threw = null;
    try { boardExecResponse('gh api x | base64 -d', {}, state); } catch (e) { threw = e; }
    assert.ok(threw, 'unset body must 404');
    assert.contains(threw.message, 'gh: Not Found (404)');
  });

  test('boardExecResponse: command with no special marker gets the empty fallback', function () {
    assert.deepEqual(boardExecResponse('gh api repos/o/r', {}, { puts: 0 }), { output: '' });
  });
});
