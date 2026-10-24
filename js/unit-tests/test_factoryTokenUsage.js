/**
 * Unit tests for js/factory/token_usage.js — the per-leg token-usage
 * publisher (port of awf scripts/publish-token-usage.sh, extracted byte-exact
 * in IstiN/dmtools-agentic-workflows#34 from the factory-teammate.yml
 * «Publish leg token usage (fa-tokens ledger -> factory-data)» step).
 *
 * Owner directive 2026-10-13: factory glue moves into dmtools-agents as JS
 * agent code; awf workflows become thin callers (stage 3 rewire).
 *
 * Pure functions only at module top; the publisher takes `exec`/`read`
 * capturers (factoryState.js convention) — no global tool calls.
 * assert = the harness global (equal/deepEqual/ok/contains).
 */

var assert = globalThis.assert;

var tuModule = loadModule('js/factory/token_usage.js', makeRequire({}), {});

// Fixed clock for every timestamp-sensitive assertion: 2026-10-13T12:34:56Z.
var NOW = '2026-10-13T12:34:56Z';

function execStub(map) {
    // map: { sha: '…', body: '…', failPuts: N } — failPuts PUTs throw before
    // succeeding, mirroring the Contents API 409 dance between concurrent legs.
    var state = { puts: 0, failed: 0, commands: [] };
    return {
        state: state,
        exec: function (args) {
            var cmd = String((args && args.command) || args || '');
            state.commands.push(cmd);
            if (cmd.indexOf('-X PUT') !== -1) {
                state.puts++;
                if (state.puts <= (map.failPuts || 0)) {
                    state.failed++;
                    throw new Error('gh: 409 sha was not supplied');
                }
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
            return { output: '' }; // bootstrap ref POST (its own `|| true`)
        }
    };
}

// ── parseFaTokensLedger ──────────────────────────────────────────────────────

suite('factoryTokenUsage — parseFaTokensLedger', function () {

  test('single ledger line: input/output sums, cacheRead passthrough, model kept', function () {
    var sums = tuModule.parseFaTokensLedger(
      'step log noise\nfa-tokens: {"sessionId":"s1","segment":1,"input":1200,"output":340,"cacheRead":9900,"source":"reported"}\nmore noise\n');
    assert.equal(sums.input, 1200);
    assert.equal(sums.output, 340);
    assert.equal(sums.cacheRead, 9900);
    assert.equal(sums.model, '');
  });

  test('multiple segments are summed (resume-aware: one line per session segment)', function () {
    var sums = tuModule.parseFaTokensLedger(
      'fa-tokens: {"input":100,"output":10,"cacheRead":5}\n' +
      'mid-log fa-tokens:{"input":200,"output":20,"cacheRead":7}\n' +
      'fa-tokens:\t{"input":1000,"output":70,"cacheRead":88}');
    assert.equal(sums.input, 1300);
    assert.equal(sums.output, 100);
    assert.equal(sums.cacheRead, 100);
  });

  test('last-seen model wins; records without a model keep the previous one', function () {
    var sums = tuModule.parseFaTokensLedger(
      'fa-tokens: {"input":1,"output":1,"model":"claude-x"}\n' +
      'fa-tokens: {"input":2,"output":2}\n' +
      'fa-tokens: {"input":3,"output":3,"model":"gpt-y"}');
    assert.equal(sums.model, 'gpt-y');
  });

  test('invalid JSON after the marker is skipped, valid neighbours still summed', function () {
    var sums = tuModule.parseFaTokensLedger(
      'fa-tokens: {not json}\n' +
      'fa-tokens: {"input":5,"output":6,"cacheRead":7}');
    assert.equal(sums.input, 5);
    assert.equal(sums.output, 6);
    assert.equal(sums.cacheRead, 7);
  });

  test('unterminated brace (truncated log) is ignored', function () {
    var sums = tuModule.parseFaTokensLedger(
      'fa-tokens: {"input":4,"output":4}\nfa-tokens: {"input":99');
    assert.equal(sums.input, 4);
    assert.equal(sums.output, 4);
  });

  test('missing fields coerce to 0; numeric strings accepted', function () {
    var sums = tuModule.parseFaTokensLedger('fa-tokens: {"input":"512","output":null}');
    assert.equal(sums.input, 512);
    assert.equal(sums.output, 0);
    assert.equal(sums.cacheRead, 0);
  });

  test('no marker at all → zero sums, empty model', function () {
    var sums = tuModule.parseFaTokensLedger('a perfectly ordinary run log');
    assert.deepEqual(sums, { input: 0, output: 0, cacheRead: 0, model: '' });
  });

  test('empty text → zero sums', function () {
    assert.deepEqual(tuModule.parseFaTokensLedger(''),
        { input: 0, output: 0, cacheRead: 0, model: '' });
  });
});

// ── leg + anchor resolution ──────────────────────────────────────────────────

suite('factoryTokenUsage — resolveLeg / resolveAnchorKey', function () {

  test('config basename containing rework → leg "rework" (guard collapses the slot into dev)', function () {
    assert.equal(tuModule.resolveLeg('/w/.dmtools/config-rework.json', 'dev'), 'rework');
  });

  test('basename strips .json only (rework detected inside the stem)', function () {
    assert.equal(tuModule.resolveLeg('rework', 'dev'), 'rework');
  });

  test('no rework in basename → KIND verbatim', function () {
    assert.equal(tuModule.resolveLeg('/w/config-dev.json', 'test_automation'), 'test_automation');
  });

  test('no rework, KIND missing/empty → "dev"', function () {
    assert.equal(tuModule.resolveLeg('/w/config.json', ''), 'dev');
    assert.equal(tuModule.resolveLeg('', ''), 'dev');
    assert.equal(tuModule.resolveLeg(undefined, undefined), 'dev');
  });

  test('anchor pr-* passes through as the key', function () {
    assert.equal(tuModule.resolveAnchorKey('pr-783'), 'pr-783');
  });

  test('anchor gh-* maps to issue-<n>', function () {
    assert.equal(tuModule.resolveAnchorKey('gh-1241'), 'issue-1241');
  });

  test('any other anchor (or missing) → null = skip signal', function () {
    assert.equal(tuModule.resolveAnchorKey('main'), null);
    assert.equal(tuModule.resolveAnchorKey(''), null);
    assert.equal(tuModule.resolveAnchorKey(undefined), null);
  });
});

// ── buildRow + timestamps ────────────────────────────────────────────────────

suite('factoryTokenUsage — buildRow / utcStampZ / cutoffIso', function () {

  test('row shape is the printf contract, field order exact', function () {
    var row = tuModule.buildRow({
      leg: 'dev', at: NOW, prompt: 1200, completion: 340, cacheRead: 9900, model: 'gpt-y'
    });
    assert.equal(JSON.stringify(row),
      '{"leg":"dev","at":"' + NOW + '","prompt":1200,"completion":340,' +
      '"total":1540,"cacheRead":9900,"model":"gpt-y"}');
  });

  test('total = prompt + completion; cacheRead rides along unpriced', function () {
    var row = tuModule.buildRow({ leg: 'rework', at: NOW, prompt: 10, completion: 5, cacheRead: 7 });
    assert.equal(row.total, 15);
    assert.equal(row.cacheRead, 7);
  });

  test('utcStampZ renders UTC ISO-8601 seconds precision (date -u shape)', function () {
    assert.equal(tuModule.utcStampZ(new Date(Date.UTC(2026, 9, 13, 12, 34, 56, 789))),
        '2026-10-13T12:34:56Z');
  });

  test('cutoffIso = now − 14 days (retention window)', function () {
    assert.equal(tuModule.cutoffIso(NOW, 14), '2026-09-29T12:34:56Z');
    assert.equal(tuModule.cutoffIso(NOW), '2026-09-29T12:34:56Z', 'default window is 14 days');
  });
});

// ── mergeTokenRows ───────────────────────────────────────────────────────────

suite('factoryTokenUsage — mergeTokenRows', function () {

  var CUTOFF = '2026-09-29T12:34:56Z';
  var ROW = { leg: 'dev', at: NOW, prompt: 1, completion: 2, total: 3, cacheRead: 4, model: 'm' };
  var OLD = { leg: 'dev', at: '2026-09-01T00:00:00Z', prompt: 9, completion: 9, total: 18, cacheRead: 0, model: '' };
  var KEPT = { leg: 'dev', at: '2026-10-01T00:00:00Z', prompt: 5, completion: 5, total: 10, cacheRead: 1, model: '' };

  test('appends under the key; other legs and their rows untouched', function () {
    var next = tuModule.mergeTokenRows({ 'pr-1': [KEPT] }, 'pr-783', ROW, CUTOFF);
    assert.deepEqual(next['pr-783'], [ROW]);
    assert.deepEqual(next['pr-1'], [KEPT]);
  });

  test('append to an existing key keeps prior rows and adds the new one last', function () {
    var next = tuModule.mergeTokenRows({ 'issue-1': [KEPT] }, 'issue-1', ROW, CUTOFF);
    assert.deepEqual(next['issue-1'], [KEPT, ROW]);
  });

  test('retention: rows older than the cutoff are dropped, then the tail is capped at 40', function () {
    var cur = { 'pr-1': [OLD, KEPT] };
    var many = [];
    for (var i = 0; i < 45; i++) {
      many.push({ leg: 'dev', at: '2026-10-02T00:00:' + (i < 10 ? '0' + i : i) + 'Z',
        prompt: i, completion: 0, total: i, cacheRead: 0, model: '' });
    }
    cur['pr-1'] = cur['pr-1'].concat(many);
    var next = tuModule.mergeTokenRows(cur, 'pr-1', ROW, CUTOFF);
    assert.equal(next['pr-1'].length, 40, 'cap: last 40 survive');
    assert.deepEqual(next['pr-1'][39], ROW, 'new row is the newest tail element');
    assert.deepEqual(next['pr-1'][0],
        { leg: 'dev', at: '2026-10-02T00:00:06Z', prompt: 6, completion: 0, total: 6, cacheRead: 0, model: '' });
    assert.equal(JSON.stringify(next['pr-1']).indexOf('2026-09-01'), -1, 'pre-cutoff row gone');
  });

  test('entries reduced to zero rows disappear; absent keys never appear', function () {
    var next = tuModule.mergeTokenRows({ 'pr-1': [OLD] }, 'pr-2', ROW, CUTOFF);
    assert.equal(JSON.stringify(next).indexOf('pr-1'), -1);
    assert.deepEqual(Object.keys(next), ['pr-2']);
  });

  test('corrupt/absent cur shapes (null, string, array) are treated as {}', function () {
    assert.deepEqual(tuModule.mergeTokenRows(null, 'pr-1', ROW, CUTOFF), { 'pr-1': [ROW] });
    assert.deepEqual(tuModule.mergeTokenRows('garbage', 'pr-1', ROW, CUTOFF), { 'pr-1': [ROW] });
    assert.deepEqual(tuModule.mergeTokenRows([1, 2], 'pr-1', ROW, CUTOFF), { 'pr-1': [ROW] });
  });
});

// ── gh command builders (gh-first, executor whitelist) ───────────────────────

suite('factoryTokenUsage — gh command builders', function () {

  test('bootstrap creates the data branch from the default branch head, tolerating 422', function () {
    var cmd = tuModule.bootstrapBranchCommand('O/R', 'factory-data');
    assert.equal(cmd.indexOf('gh api'), 0, 'executor whitelist: first token is gh');
    assert.contains(cmd, '-X POST repos/O/R/git/refs');
    assert.contains(cmd, '-f ref=refs/heads/factory-data');
    assert.contains(cmd, '$(gh api repos/O/R/git/ref/heads/$(gh api repos/O/R --jq .default_branch) --jq .object.sha)');
    assert.ok(/\|\| true$/.test(cmd), '422 already-exists must not abort');
  });

  test('probes: .sha via --jq; body via .content | base64 -d; both ref-locked', function () {
    assert.equal(tuModule.contentsShaCommand('O/R', 'data/fa-tokens.json', 'factory-data'),
        'gh api repos/O/R/contents/data/fa-tokens.json?ref=factory-data --jq .sha');
    assert.equal(tuModule.contentsBodyCommand('O/R', 'data/fa-tokens.json', 'factory-data'),
        'gh api repos/O/R/contents/data/fa-tokens.json?ref=factory-data --jq .content | base64 -d');
  });

  test('PUT assembles branch, message, base64 content and existing sha', function () {
    var cmd = tuModule.contentsPutCommand('O/R', 'data/fa-tokens.json', {
      branch: 'factory-data',
      message: 'leg tokens — pr-783 dev [skip ci]',
      json: '{"pr-783":[]}',
      sha: 'abc123'
    });
    assert.contains(cmd, 'gh api -X PUT repos/O/R/contents/data/fa-tokens.json');
    assert.contains(cmd, "-f branch=factory-data");
    assert.contains(cmd, "-f message='leg tokens — pr-783 dev [skip ci]'");
    assert.contains(cmd, '-f content="$(printf %s \'{"pr-783":[]}\' | base64)"');
    assert.contains(cmd, "-f sha='abc123'");
  });

  test('first publish (no sha) omits -f sha entirely', function () {
    var cmd = tuModule.contentsPutCommand('O/R', 'data/fa-tokens.json', {
      branch: 'factory-data', message: 'm', json: '{}', sha: ''
    });
    assert.equal(cmd.indexOf('-f sha'), -1);
  });

  test('shellQuote survives single quotes in interpolated leg/model text', function () {
    assert.equal(tuModule.shellQuote("leg tokens — gh-1 de've [skip ci]"),
        "'leg tokens — gh-1 de'\\''ve [skip ci]'");
  });
});

// ── gh-1152: base64EncodeUtf8 + --input temp-file transport (MAX_ARG_STRLEN) ─

suite('factoryTokenUsage — gh-1152 base64EncodeUtf8 & --input PUT transport', function () {

  function buildLargeTokensJson() {
    var bigCur = {};
    for (var k = 1500; k < 1700; k++) {
      var list = [];
      for (var r = 0; r < 6; r++) {
        list.push({
          leg: 'dev', at: '2026-10-10T10:00:0' + r + 'Z',
          prompt: 123456, completion: 7890, total: 131346,
          cacheRead: 987654, model: 'claude-opus-4-7'
        });
      }
      bigCur['pr-' + k] = list;
    }
    return JSON.stringify(bigCur);
  }

  function noop() {}

  test('base64EncodeUtf8 encodes empty, ASCII, padding (1/2/3 mod 3), and multi-byte UTF-8', function () {
    assert.equal(tuModule.base64EncodeUtf8(''), '');
    assert.equal(tuModule.base64EncodeUtf8(null), '');
    assert.equal(tuModule.base64EncodeUtf8('f'), 'Zg==');
    assert.equal(tuModule.base64EncodeUtf8('fo'), 'Zm8=');
    assert.equal(tuModule.base64EncodeUtf8('foo'), 'Zm9v');
    var utf8Sample = '{"msg":"leg tokens — pr-1665 ✅ кириллица"}';
    var expected = 'eyJtc2ciOiJsZWcgdG9rZW5zIOKAlC' + 'Bwci0xNjY1IOKchSDQutC40YDQuNC70LvQuNGG0LAifQ==';
    assert.equal(tuModule.base64EncodeUtf8(utf8Sample), expected);
  });

  test('buildContentsPutBody produces branch, message, base64 content, and optional sha', function () {
    var withoutSha = tuModule.buildContentsPutBody({
      branch: 'factory-data',
      message: 'leg tokens — pr-1665 rework [skip ci]',
      json: '{"pr-1665":[]}',
      sha: ''
    });
    assert.deepEqual(Object.keys(withoutSha).sort(), ['branch', 'content', 'message']);
    assert.equal(withoutSha.branch, 'factory-data');
    assert.equal(withoutSha.message, 'leg tokens — pr-1665 rework [skip ci]');
    assert.equal(withoutSha.content, tuModule.base64EncodeUtf8('{"pr-1665":[]}'));

    var withSha = tuModule.buildContentsPutBody({
      branch: 'factory-data',
      message: 'm',
      json: '{}',
      sha: 'deadbeef'
    });
    assert.equal(withSha.sha, 'deadbeef');

    var defaults = tuModule.buildContentsPutBody();
    assert.equal(defaults.branch, 'factory-data');
    assert.equal(defaults.message, '');
    assert.equal(defaults.content, tuModule.base64EncodeUtf8('{}'));
  });

  test('tempPutBodyPath and contentsPutInputCommand keep argv tiny and metachar-free', function () {
    var p = tuModule.tempPutBodyPath(NOW, 2);
    assert.ok(/^\/tmp\/fa-tokens-put-\d+-2\.json$/.test(p), 'got: ' + p);
    assert.equal(tuModule.tempPutBodyPath('not-a-date', 0), '/tmp/fa-tokens-put-0-0.json');
    var cmd = tuModule.contentsPutInputCommand('IstiN/flutter_agent_harness', 'data/fa-tokens.json', p);
    assert.equal(cmd, 'gh api -X PUT repos/IstiN/flutter_agent_harness/contents/data/fa-tokens.json --input ' + p);
  });

  test('publishTokenUsage with write/del uses --input temp file and cleans up on success & conflict', function () {
    var writes = [];
    var deleted = [];
    var stub = execStub({ failPuts: 1, sha: 'sha1152', body: '{}' });
    var res = tuModule.publishTokenUsage({
      runOutput: 'out.txt', configPath: 'config-rework.json', kind: 'dev',
      anchor: 'pr-1665', repo: 'IstiN/flutter_agent_harness',
      dataBranch: 'factory-data', dataPath: 'data/fa-tokens.json', now: NOW
    }, {
      exec: stub.exec,
      read: function () { return 'fa-tokens: {"input":500,"output":100,"cacheRead":2000,"model":"claude-opus-4-7"}'; },
      write: function (o) { writes.push(o); },
      del: function (o) { deleted.push(o.path); },
      sleepMs: function () {},
      log: function () {}
    });
    assert.equal(res.status, 'published');
    assert.equal(res.attempts, 2);
    assert.equal(writes.length, 2, 'written once per attempt');
    assert.equal(deleted.length, 2, 'cleaned up in finally on both failed and succeeded attempts');
    assert.equal(writes[0].path, deleted[0]);
    assert.equal(writes[1].path, deleted[1]);
    var parsedBody = JSON.parse(writes[1].content);
    assert.equal(parsedBody.branch, 'factory-data');
    assert.equal(parsedBody.message, 'leg tokens — pr-1665 rework [skip ci]');
    assert.equal(parsedBody.sha, 'sha1152');
    var expectedRowJson = JSON.stringify({
      "pr-1665": [{
        leg: "rework", at: NOW, prompt: 500, completion: 100,
        total: 600, cacheRead: 2000, model: "claude-opus-4-7"
      }]
    });
    assert.equal(parsedBody.content, tuModule.base64EncodeUtf8(expectedRowJson));
  });

  test('putTokenContents logs a one-time warning when file_write is unavailable and falls back to inline PUT', function () {
    var logs = [];
    var cmds = [];
    var io = {
      exec: function (o) { cmds.push(o.command); return {}; },
      log: function (m) { logs.push(m); }
    };
    var bigJson = buildLargeTokensJson();
    assert.equal(tuModule.putTokenContents(io, 'O/R', 'data/fa-tokens.json', NOW, 1, {
      branch: 'factory-data', message: 'm', json: bigJson, sha: 's1'
    }), true);
    assert.equal(tuModule.putTokenContents(io, 'O/R', 'data/fa-tokens.json', NOW, 2, {
      branch: 'factory-data', message: 'm', json: bigJson, sha: 's1'
    }), true);
    assert.equal(logs.length, 1, 'warning logged once on attempt 1');
    assert.contains(logs[0], 'file_write unavailable');
    assert.equal(cmds.length, 2);
  });

  test('120 KB payload (>96 KB JSON / >131,072 MAX_ARG_STRLEN base64) keeps shell command <200 bytes', function () {
    var bigBodyStr = buildLargeTokensJson();
    assert.ok(bigBodyStr.length > 100000, 'fixture exceeds 100 KB raw JSON, got ' + bigBodyStr.length);
    var writes = [];
    var stub = execStub({ sha: '21a0fb08', body: bigBodyStr });
    var res = tuModule.publishTokenUsage({
      runOutput: 'out.txt', configPath: 'config-dev.json', kind: 'dev',
      anchor: 'pr-1715', repo: 'IstiN/flutter_agent_harness',
      dataBranch: 'factory-data', dataPath: 'data/fa-tokens.json', now: NOW
    }, {
      exec: stub.exec,
      read: function () { return 'fa-tokens: {"input":1000,"output":250,"cacheRead":500,"model":"claude-opus-4-7"}'; },
      write: function (o) { writes.push(o); },
      del: noop,
      sleepMs: noop,
      log: noop
    });
    assert.equal(res.status, 'published');
    assert.equal(writes.length, 1);
    var putBody = JSON.parse(writes[0].content);
    assert.ok(putBody.content.length > 131072,
        'base64 content exceeds Linux 131,072-byte MAX_ARG_STRLEN, got ' + putBody.content.length);
    var putCmd = stub.state.commands[3];
    assert.ok(putCmd.length < 200, 'shell command stays tiny (<200 bytes), got ' + putCmd.length);
    assert.contains(putCmd, '--input /tmp/fa-tokens-put-');
    assert.equal(putCmd.indexOf('base64'), -1, 'no inline base64 expansion in argv');
    assert.equal(putCmd.indexOf('pr-1715'), -1, 'no JSON payload in argv');
  });
});

// ── publishTokenUsage (orchestrator, exec/read capturers) ────────────────────

suite('factoryTokenUsage — publishTokenUsage', function () {

  var LEDGER = 'fa-tokens: {"input":1200,"output":340,"cacheRead":9900,"model":"gpt-y"}';

  function run(opts, map, ioExtra) {
    var stub = execStub(map || {});
    var io = Object.assign({
      exec: stub.exec,
      read: function () { return LEDGER; },
      sleepMs: function () {},
      log: function () {}
    }, ioExtra || {});
    var result = tuModule.publishTokenUsage(Object.assign({
      runOutput: '.dmtools/run-output.txt',
      configPath: '/w/.dmtools/config-dev.json',
      kind: 'dev',
      anchor: 'pr-783',
      repo: 'O/R',
      dataBranch: 'factory-data',
      dataPath: 'data/fa-tokens.json',
      now: NOW
    }, opts || {}), io);
    return { result: result, stub: stub, io: io };
  }

  test('missing run output → skipped (no-run-output), no gh traffic', function () {
    var r = run({ runOutput: '' }, {}, { read: function () { return ''; } });
    assert.equal(r.result.status, 'skipped');
    assert.equal(r.result.reason, 'no-run-output');
    assert.equal(r.stub.state.commands.length, 0);
  });

  test('unreadable run output (read throws) → same skip', function () {
    var r = run({}, {}, { read: function () { throw new Error('file_read: not found'); } });
    assert.equal(r.result.status, 'skipped');
    assert.equal(r.result.reason, 'no-run-output');
  });

  test('no fa-tokens ledger line (zero sums) → skipped (no-ledger), no gh traffic', function () {
    var r = run({}, {}, { read: function () { return 'log without markers'; } });
    assert.equal(r.result.status, 'skipped');
    assert.equal(r.result.reason, 'no-ledger');
    assert.equal(r.stub.state.commands.length, 0);
  });

  test('unrecognized anchor → skipped (bad-anchor), gh bootstrap never runs', function () {
    var r = run({ anchor: 'main' });
    assert.equal(r.result.status, 'skipped');
    assert.equal(r.result.reason, 'bad-anchor');
    assert.equal(r.stub.state.commands.length, 0);
  });

  test('first publish: probes 404 → sha-less PUT carries the fresh row', function () {
    var r = run({});
    assert.equal(r.result.status, 'published');
    assert.equal(r.result.key, 'pr-783');
    assert.equal(r.result.leg, 'dev');
    assert.equal(r.result.attempts, 1);
    assert.deepEqual(r.result.row, {
      leg: 'dev', at: NOW, prompt: 1200, completion: 340, total: 1540,
      cacheRead: 9900, model: 'gpt-y'
    });
    var cmds = r.stub.state.commands;
    assert.equal(cmds.length, 4, 'bootstrap, sha probe, body probe, PUT');
    assert.contains(cmds[0], '-X POST repos/O/R/git/refs');
    assert.contains(cmds[1], '--jq .sha');
    assert.contains(cmds[2], 'base64 -d');
    var put = cmds[3];
    assert.contains(put, '-X PUT repos/O/R/contents/data/fa-tokens.json');
    assert.contains(put, '-f branch=factory-data');
    assert.contains(put, "-f message='leg tokens — pr-783 dev [skip ci]'");
    assert.contains(put, '"prompt":1200');
    assert.contains(put, '"cacheRead":9900');
    assert.equal(put.indexOf('-f sha'), -1, 'first publish creates without sha');
  });

  test('update: existing sha + body → PUT with sha and prior rows preserved (append, not clobber)', function () {
    var prior = '{"pr-783":[{"leg":"dev","at":"2026-10-01T00:00:00Z","prompt":5,"completion":5,' +
      '"total":10,"cacheRead":1,"model":""}],"issue-2":[{"leg":"dev","at":"2026-10-02T00:00:00Z",' +
      '"prompt":1,"completion":1,"total":2,"cacheRead":0,"model":""}]}';
    var r = run({}, { sha: 'abc123', body: prior });
    assert.equal(r.result.status, 'published');
    var put = r.stub.state.commands[3];
    assert.contains(put, "-f sha='abc123'");
    assert.contains(put, '"prompt":5', 'prior pr-783 row kept');
    assert.contains(put, '"issue-2"', 'other key kept');
    assert.contains(put, '"prompt":1200', 'new row appended');
    assert.ok(put.indexOf('"prompt":1200') > put.indexOf('"prompt":5'), 'append lands after prior rows');
  });

  test('corrupt body on the branch → merged from {} (jq empty guard)', function () {
    var r = run({}, { sha: 'abc123', body: '{oops' });
    assert.equal(r.result.status, 'published');
    var put = r.stub.state.commands[3];
    assert.contains(put, '"pr-783":[{"leg"');
  });

  test('rework leg + gh anchor: leg=rework, key=issue-<n> end to end', function () {
    var r = run({ configPath: '/w/config-rework.json', kind: 'dev', anchor: 'gh-1241' });
    assert.equal(r.result.leg, 'rework');
    assert.equal(r.result.key, 'issue-1241');
    assert.contains(r.stub.state.commands[3], "-f message='leg tokens — issue-1241 rework [skip ci]'");
  });

  test('conflicting PUTs are retried with refetch (up to 3 attempts), then published', function () {
    var r = run({}, { failPuts: 2 });
    assert.equal(r.result.status, 'published');
    assert.equal(r.result.attempts, 3);
    assert.equal(r.stub.state.puts, 3);
    var probes = r.stub.state.commands.filter(function (c) {
      return c.indexOf('--jq .sha') !== -1;
    });
    assert.equal(probes.length, 3, 'each attempt refetches the sha');
  });

  test('three conflicting PUTs → gave-up warning, never a throw', function () {
    var lines = [];
    var r = run({}, { failPuts: 99 }, { log: function (l) { lines.push(l); } });
    assert.equal(r.result.status, 'gave-up');
    assert.equal(r.result.attempts, 3);
    var warned = lines.filter(function (l) { return l.indexOf('::warning::') === 0; });
    assert.equal(warned.length, 1);
    assert.contains(warned[0], 'gave up after 3 attempts');
  });

  test('retry backoff sleeps attempt*2s between attempts (2s, 4s), never after the last', function () {
    var slept = [];
    var r = run({}, { failPuts: 1 }, { sleepMs: function (ms) { slept.push(ms); } });
    assert.equal(r.result.status, 'published');
    assert.deepEqual(slept, [2000]);
    var r2 = run({}, { failPuts: 99 }, { sleepMs: function (ms) { slept.push(ms); } });
    assert.equal(r2.result.status, 'gave-up');
    assert.deepEqual(slept, [2000, 2000, 4000]);
  });

  test('emits the grep-able "leg tokens:" line like the sh step', function () {
    var lines = [];
    run({}, {}, { log: function (l) { lines.push(l); } });
    var leg = lines.filter(function (l) { return l.indexOf('leg tokens:') === 0; })[0];
    assert.ok(leg, 'leg tokens line present');
    assert.contains(leg, 'pr-783 dev prompt=1200 completion=340 cached=9900 model=gpt-y');
  });

  test('empty model renders as "none" in the log line, empty string in the row', function () {
    var lines = [];
    var r = run({}, {}, {
      read: function () { return 'fa-tokens: {"input":1,"output":1}'; },
      log: function (l) { lines.push(l); }
    });
    assert.equal(r.result.row.model, '');
    assert.contains(lines.filter(function (l) { return l.indexOf('leg tokens:') === 0; })[0],
        'model=none');
  });
});

// ── entry glue (js/factory/token_usage_publish.js) ───────────────────────────

suite('factoryTokenUsage — entry action (token_usage_publish.js)', function () {

  var entry = loadModule('js/factory/token_usage_publish.js', makeRequire({
    './token_usage.js': tuModule
  }), {});

  test('resolveParams: customParams win, env is the fallback, defaults for branch/path', function () {
    var p = entry.resolveParams({ jobParams: { customParams: {
      runOutput: 'a.txt', anchor: 'pr-1', repo: 'O/R'
    }}}, {
      RUN_OUTPUT: 'env.txt', CONFIG: 'env.json', KIND: 'dev',
      ANCHOR: 'gh-1', REPO: 'E/R', DATA_BRANCH: 'ignored-branch', DATA_PATH: 'x.json'
    });
    assert.equal(p.runOutput, 'a.txt', 'customParams beat env');
    assert.equal(p.anchor, 'pr-1');
    assert.equal(p.configPath, 'env.json', 'env fills the gaps');
    assert.equal(p.dataBranch, 'ignored-branch', 'explicit env branch honored');
    assert.equal(p.dataPath, 'x.json');

    var d = entry.resolveParams({}, {});
    assert.equal(d.runOutput, '');
    assert.equal(d.kind, '');
    assert.equal(d.dataBranch, 'factory-data', 'default branch');
    assert.equal(d.dataPath, 'data/fa-tokens.json', 'default path');
  });

  function recordPath(arr) {
    return function (args) { arr.push(args && args.path); };
  }

  function recordLedgerRead(arr) {
    return function (args) {
      arr.push(args && args.path);
      return 'fa-tokens: {"input":3,"output":4}';
    };
  }

  test('action wires exec→cli_execute_command, read→file_read, write→file_write, del→file_delete', function () {
    var readPaths = [];
    var writes = [];
    var deleted = [];
    var stub = execStub({});
    var result = entry.action(
      { jobParams: { customParams: {
        runOutput: '.dmtools/run-output.txt', configPath: 'config-dev.json',
        kind: 'dev', anchor: 'pr-783', repo: 'O/R', now: NOW
      } } },
      {
        cli_execute_command: stub.exec,
        file_read: recordLedgerRead(readPaths),
        file_write: function (args) { writes.push(args); },
        file_delete: recordPath(deleted)
      });
    assert.equal(result.status, 'published');
    assert.deepEqual(readPaths, ['.dmtools/run-output.txt'], 'ledger read via file_read');
    assert.equal(writes.length, 1, 'PUT body written via file_write');
    assert.equal(deleted.length, 1, 'temp file deleted via file_delete');
    assert.contains(stub.state.commands[3], '--input /tmp/fa-tokens-put-');
  });
  test('action without any input degrades to the no-run-output skip (never throws)', function () {
    var result = entry.action({}, { cli_execute_command: execStub({}).exec,
      file_read: function () { throw new Error('missing'); } });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-run-output');
  });
});

// ── gh-1193: characterization tests for the CRAP-target helpers ──────────────
// Every branch of mergeTokenRows and publishTokenUsage is pinned here before
// the helper extraction so the refactor can be proven behaviour-identical.

suite('factoryTokenUsage — mergeTokenRows helpers (gh-1193)', function () {

    test('objectOrEmpty degrades corrupt shapes to {} and keeps objects', function () {
        assert.deepEqual(tuModule.objectOrEmpty(null), {});
        assert.deepEqual(tuModule.objectOrEmpty('junk'), {});
        assert.deepEqual(tuModule.objectOrEmpty([1, 2]), {});
        var src = { 'issue-1': [] };
        assert.equal(tuModule.objectOrEmpty(src), src);
    });

    test('orderedKeysOf keeps insertion order and appends a new key once', function () {
        var src = { b: [], a: [] };
        assert.deepEqual(tuModule.orderedKeysOf(src, 'c'), ['b', 'a', 'c']);
        assert.deepEqual(tuModule.orderedKeysOf(src, 'a'), ['b', 'a']);
        assert.deepEqual(tuModule.orderedKeysOf({}, 'k'), ['k']);
    });

    test('retainedRowsOf keeps at/after-cutoff rows and caps the tail at 40', function () {
        var rows = [];
        for (var i = 0; i < 45; i++) {
            rows.push({ at: '2026-10-0' + (1 + Math.floor(i / 5)) + 'T00:00:0' + (i % 10) + 'Z', i: i });
        }
        var kept = tuModule.retainedRowsOf(rows, '2026-10-01T00:00:00Z');
        assert.equal(kept.length, 40);
        assert.equal(kept[kept.length - 1].i, 44, 'the newest row survives the tail cap');

        var dropped = tuModule.retainedRowsOf([
            { at: '2026-09-01T00:00:00Z' },
            { at: '2026-10-13T00:00:00Z' }
        ], '2026-10-01T00:00:00Z');
        assert.equal(dropped.length, 1);
        assert.equal(dropped[0].at, '2026-10-13T00:00:00Z');

        assert.deepEqual(tuModule.retainedRowsOf([{ nope: 1 }, null], '2026-10-01T00:00:00Z'), [],
            'non-row shapes drop');
        assert.deepEqual(tuModule.retainedRowsOf([], '2026-10-01T00:00:00Z'), []);
    });
});

suite('factoryTokenUsage — publishTokenUsage branches (gh-1193)', function () {

    test('a sha probe answering literal "Not Found" PUTs without a sha', function () {
        var commands = [];
        var puts = [];
        var exec = function (args) {
            var cmd = String((args && args.command) || args || '');
            commands.push(cmd);
            if (cmd.indexOf('-X PUT') !== -1) { puts.push(cmd); return { output: '' }; }
            if (cmd.indexOf('--jq .sha') !== -1) return { output: 'Not Found' };
            if (cmd.indexOf('base64 -d') !== -1) throw new Error('gh: Not Found (404)');
            return { output: '' };
        };
        var ledger = 'fa-tokens: {"input":10,"output":5,"cacheRead":1}';
        var result = tuModule.publishTokenUsage({
            runOutput: 'out.txt',
            anchor: 'pr-12',
            repo: 'O/R',
            now: NOW
        }, { exec: exec, read: function () { return ledger; } });

        assert.equal(result.status, 'published');
        assert.equal(puts.length, 1);
        assert.notContains(puts[0], '-f sha=', 'first publish omits -f sha entirely');
    });

    test('a corrupt branch body merges from {} (jq empty guard)', function () {
        var commands = [];
        var exec = function (args) {
            var cmd = String((args && args.command) || args || '');
            commands.push(cmd);
            if (cmd.indexOf('-X PUT') !== -1) return { output: '' };
            if (cmd.indexOf('--jq .sha') !== -1) return { output: 'abc123' };
            if (cmd.indexOf('base64 -d') !== -1) return { output: '{not json' };
            return { output: '' };
        };
        var ledger = 'fa-tokens: {"input":10,"output":5,"cacheRead":1}';
        var result = tuModule.publishTokenUsage({
            runOutput: 'out.txt',
            anchor: 'gh-9',
            repo: 'O/R',
            now: NOW
        }, { exec: exec, read: function () { return ledger; } });

        assert.equal(result.status, 'published');
        assert.equal(result.key, 'issue-9');
    });

    test('without opts.now the publisher rides the live clock', function () {
        var exec = function (args) {
            var cmd = String((args && args.command) || args || '');
            if (cmd.indexOf('-X PUT') !== -1) return { output: '' };
            if (cmd.indexOf('--jq .sha') !== -1) throw new Error('gh: Not Found (404)');
            if (cmd.indexOf('base64 -d') !== -1) throw new Error('gh: Not Found (404)');
            return { output: '' };
        };
        var ledger = 'fa-tokens: {"input":10,"output":5,"cacheRead":1}';
        var result = tuModule.publishTokenUsage({
            runOutput: 'out.txt',
            anchor: 'pr-3',
            repo: 'O/R'
        }, { exec: exec, read: function () { return ledger; } });

        assert.equal(result.status, 'published');
        assert.equal(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result.row.at), true,
            'row.at is a live UTC stamp: ' + result.row.at);
    });
});

// ── gh-1225 — CRAP gaps: extractFaPayload branches + ledger skips + helpers ──

suite('factoryTokenUsage — extractFaPayload marker-scan branches (gh-1225)', function () {

  test('a non-space, non-brace char right after the marker → null (sh regex anchored)', function () {
    assert.equal(tuModule.extractFaPayload('fa-tokens:x{"input":1}', 'fa-tokens:'.length), null);
    assert.equal(tuModule.extractFaPayload('fa-tokens:fa-tokens: {"input":1}', 'fa-tokens:'.length), null);
  });

  test('only spaces/tabs after the marker → null (EOF without a brace)', function () {
    assert.equal(tuModule.extractFaPayload('fa-tokens:  \t ', 'fa-tokens:'.length), null);
    assert.equal(tuModule.extractFaPayload('fa-tokens:', 'fa-tokens:'.length), null);
  });

  test('escaped backslash and escaped quote inside a string value survive the balanced scan', function () {
    var text = 'fa-tokens: {"say":"a\\\\b \\"c}done","input":1,"output":2}';
    var payload = tuModule.extractFaPayload(text, 'fa-tokens:'.length);
    assert.equal(payload, '{"say":"a\\\\b \\"c}done","input":1,"output":2}');
    var sums = tuModule.parseFaTokensLedger(text);
    assert.equal(sums.input, 1);
    assert.equal(sums.output, 2);
  });

  test('braces and quotes inside string values do not open/close the payload', function () {
    var payload = tuModule.extractFaPayload('fa-tokens: {"m":"}{ \\" {","output":5}', 'fa-tokens:'.length);
    assert.equal(payload, '{"m":"}{ \\" {","output":5}');
  });
});

suite('factoryTokenUsage — parseFaTokensLedger skip branches (gh-1225)', function () {

  test('a non-object payload (array) is skipped', function () {
    assert.deepEqual(tuModule.parseFaTokensLedger('fa-tokens: [1,2,3]'),
        { input: 0, output: 0, cacheRead: 0, model: '' });
  });

  test('a non-numeric string field invalidates the whole record (the sh int() raise)', function () {
    assert.deepEqual(tuModule.parseFaTokensLedger('fa-tokens: {"input":"12x","output":3}'),
        { input: 0, output: 0, cacheRead: 0, model: '' });
  });

  test('valid records still sum after skipped ones (marker-paced, non-overlapping)', function () {
    var sums = tuModule.parseFaTokensLedger(
        'fa-tokens:x\n' +
        'fa-tokens: {"input":"1e3","output":2}\n' +
        'fa-tokens: {"input":10,"output":20,"cacheRead":5,"model":"kimi"}');
    assert.deepEqual(sums, { input: 10, output: 20, cacheRead: 5, model: 'kimi' });
  });
});

suite('factoryTokenUsage — balanced-payload scan helpers (gh-1225)', function () {

  test('jsonPayloadEndFrom returns the index of the closing brace', function () {
    var text = 'x {"a":"} still string"} tail';
    var open = text.indexOf('{');
    // the object's closing brace, not the '}' inside the string value
    assert.equal(tuModule.jsonPayloadEndFrom(text, open), text.lastIndexOf('}'));
    assert.equal(text.lastIndexOf('}'), 23);
  });

  test('jsonPayloadEndFrom: escaped backslash does not close the string; escaped quote neither', function () {
    var text = '{"p":"a\\\\b \\" q"}';
    assert.equal(tuModule.jsonPayloadEndFrom(text, 0), text.lastIndexOf('}'));
  });

  test('jsonPayloadEndFrom: unterminated payload → -1', function () {
    assert.equal(tuModule.jsonPayloadEndFrom('{"a":1', 0), -1);
  });

  test('jsonPayloadEndFrom: nested objects close at the outermost brace', function () {
    var text = '{"a":{"b":2},"c":3}';
    assert.equal(tuModule.jsonPayloadEndFrom(text, 0), text.length - 1);
  });

  test('stepInStringState: the escape lifecycle inside a string', function () {
    assert.deepEqual(tuModule.stepInStringState('\\', false), { escaped: true, inString: true });
    assert.deepEqual(tuModule.stepInStringState('n', true), { escaped: false, inString: true });
    assert.deepEqual(tuModule.stepInStringState('"', true), { escaped: false, inString: true });
    assert.deepEqual(tuModule.stepInStringState('"', false), { escaped: false, inString: false });
    assert.deepEqual(tuModule.stepInStringState('a', false), { escaped: false, inString: true });
  });

  test('applyLedgerRecord sums fields and rides the last-seen model', function () {
    var sums = { input: 0, output: 0, cacheRead: 0, model: '' };
    tuModule.applyLedgerRecord(sums, { input: 10, output: '20', cacheRead: 5, model: 'kimi' });
    tuModule.applyLedgerRecord(sums, { input: 1, output: 2, cacheRead: 3, model: '' });
    tuModule.applyLedgerRecord(sums, { input: 7, output: 8, cacheRead: 9, model: 'copilot' });
    assert.deepEqual(sums, { input: 18, output: 30, cacheRead: 17, model: 'copilot' });
  });

  test('applyLedgerRecord: a non-numeric field skips the record silently (int() raise)', function () {
    var sums = { input: 4, output: 4, cacheRead: 0, model: '' };
    tuModule.applyLedgerRecord(sums, { input: '1e3', output: 2 });
    assert.deepEqual(sums, { input: 4, output: 4, cacheRead: 0, model: '' });
  });
});
