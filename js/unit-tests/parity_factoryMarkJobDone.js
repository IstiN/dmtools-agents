#!/usr/bin/env node
/**
 * sh-parity harness for js/factory/mark_job_done.js — the flipTaskListItems
 * awk port vs the LITERAL awk program from the awf spec:
 * dmtools-agentic-workflows scripts/mark-job-done.sh (byte-extracted from
 * factory-teammate.yml «Mark machine job done», PR #34). The sh + its A/B
 * harness stay intact over there until the final rewire; this harness pins
 * the JS to the same behavior on randomized inputs.
 *
 * Node-only (needs child_process + awk on PATH); NOT part of the testRunner
 * suite. Run:  node js/unit-tests/parity_factoryMarkJobDone.js [N]
 */

'use strict';
var fs = require('fs');   // pipeline scenario only (temp dirs, stub scripts)
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var mjd = require(path.join(__dirname, '..', 'factory', 'mark_job_done.js'));

// The spec's awk program, byte-for-byte (argv: -v url="(RUN_URL)" -v mark -v end).
var AWK_PROGRAM = [
    'index($0, url) > 0 && $0 ~ /^- \\[ \\]/ {',
    '  line = $0',
    '  sub(/^- \\[ \\] /, "- [x] ", line)',
    '  if (match(line, /started [0-9][0-9]:[0-9][0-9]/)) {',
    '    st = substr(line, RSTART, RLENGTH)',
    '    sub(/started [0-9][0-9]:[0-9][0-9] .*$/, st " · done " end " " mark, line)',
    '  }',
    '  $0 = line',
    '}',
    '{ print }'
].join('\n');

var RUN_URL = 'https://github.com/IstiN/target-repo/actions/runs/1777';
var NEEDLE = '(' + RUN_URL + ')';
var OTHER_URL = 'https://github.com/IstiN/target-repo/actions/runs/1778';
var MARKS = ['✅', '❌', '🚫', '⚠️ superseded', '⚠️ '];
var SUFFIXES = ['', ' [1777](' + RUN_URL + ')', ' — leg details', '  ', ' / retry'];

// Deterministic LCG so a failure is reproducible from the seed.
var SEED = 20261013;
function rnd() {
    SEED = (SEED * 1103515245 + 12345) % 2147483648;
    return SEED / 2147483648;
}
function pick(arr) { return arr[Math.floor(rnd() * arr.length) % arr.length]; }
function hhmm() {
    return pick(['0', '']) + Math.floor(rnd() * 10) + ':' +
        (Math.floor(rnd() * 10) + '' + Math.floor(rnd() * 10));
}

function randomLine() {
    var roll = rnd();
    var t = hhmm();
    var s = pick(SUFFIXES);
    if (roll < 0.30) return '- [ ] Run factory agent started ' + t + s + ' ' + NEEDLE;
    if (roll < 0.40) return '- [x] Run factory agent started ' + t + s + ' ' + NEEDLE;
    if (roll < 0.50) return '- [ ] Retry leg started ' + t + ' ' + NEEDLE;
    if (roll < 0.58) return '- [ ] no-time task ' + NEEDLE;
    if (roll < 0.66) return '- [ ]Run no-space started ' + t + ' ' + NEEDLE;
    if (roll < 0.74) return '- [ ] started ' + t + 'ends-with-time ' + NEEDLE;
    if (roll < 0.80) return '- [ ] other task (different run: ' + OTHER_URL + ')';
    if (roll < 0.86) return '- [ ] bare mention ' + RUN_URL + ' no parens';
    if (roll < 0.92) return 'plain noise line ' + t;
    if (roll < 0.96) return '- [x] already done task';
    return '';
}

function randomBody() {
    var n = 1 + Math.floor(rnd() * 8);
    var lines = [];
    for (var i = 0; i < n; i++) lines.push(randomLine());
    return lines.join(rnd() < 0.8 ? '\n' : '\r\n') + (rnd() < 0.85 ? '\n' : '');
}

function runAwk(body, mark, end) {
    var r = spawnSync('awk', ['-v', 'url=' + NEEDLE, '-v', 'mark=' + mark, '-v', 'end=' + end, AWK_PROGRAM],
        { input: body, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('awk failed: ' + r.stderr);
    return r.stdout;
}

var N = parseInt(process.argv[2], 10) || 300;
var failures = 0;
for (var i = 0; i < N; i++) {
    var body = randomBody();
    var mark = pick(MARKS);
    var end = hhmm();
    var expected = runAwk(body, mark, end);
    var actual = mjd.flipTaskListItems(body, RUN_URL, mark, end).body;
    if (actual !== expected) {
        failures++;
        console.log('── MISMATCH #' + (i + 1) + ' (mark=' + mark + ', end=' + end + ')');
        console.log('  body:     ' + JSON.stringify(body));
        console.log('  expected: ' + JSON.stringify(expected));
        console.log('  actual:   ' + JSON.stringify(actual));
        if (failures >= 5) break;
    }
}
console.log(failures === 0
    ? 'sh-parity: ' + N + '/' + N + ' randomized bodies byte-identical to the awk spec'
    : 'sh-parity: ' + failures + ' MISMATCHES');

// ── pipeline scenario: the REAL sh path vs the JS module, byte for byte ─────
// Reviewer Next-Step-4: transport parity must not rest on unit-test
// assumptions. Runs the spec's FULL mark-job-done.sh (embedded byte-for-byte
// below from dmtools-agentic-workflows scripts/mark-job-done.sh @ PR #34 —
// the sh + its A/B harness stay intact there until the final rewire) with a
// PATH-stubbed gh/date in a temp dir, then drives the JS module with the
// same gh view output and compares the POSTED body file and the stdout
// marker line byte-for-byte — including the trailing-newline behavior.

var os = require('os');
var cp = require('child_process');

// The spec script, verbatim (provenance header replaced by this note).
var SH_SPEC = [
    '#!/usr/bin/env bash',
    '  repo="${GITHUB_REPOSITORY}"',
    '  case "${JOB_RESULT}" in',
    '    success) mark="✅" ;;',
    '    failure) mark="❌" ;;',
    '    cancelled) mark="🚫" ;;',
    '    *) mark="⚠️ ${JOB_RESULT}" ;;',
    '  esac',
    '  end_ts="$(date -u \'+%H:%M\')"',
    '  gh issue view "$NUMBER" --repo "$repo" --json body -q .body > /tmp/issue_body.md',
    '  awk -v url="(${RUN_URL})" -v mark="$mark" -v end="$end_ts" \'',
    '    index($0, url) > 0 && $0 ~ /^- \\[ \\]/ {',
    '      line = $0',
    '      sub(/^- \\[ \\] /, "- [x] ", line)',
    '      if (match(line, /started [0-9][0-9]:[0-9][0-9]/)) {',
    '        st = substr(line, RSTART, RLENGTH)',
    '        sub(/started [0-9][0-9]:[0-9][0-9] .*$/, st " · done " end " " mark, line)',
    '      }',
    '      $0 = line',
    '    }',
    '    { print }',
    '  \' /tmp/issue_body.md > /tmp/issue_body_new.md',
    '  if ! cmp -s /tmp/issue_body.md /tmp/issue_body_new.md; then',
    '    gh issue edit "$NUMBER" --repo "$repo" --body-file /tmp/issue_body_new.md',
    '    echo "job marker flipped to [x] ${mark}"',
    '  else',
    '    echo "::warning::start marker not found for ${RUN_URL} — nothing to flip"',
    '  fi'
].join('\n') + '\n';

var GH_STUB = [
    '#!/usr/bin/env bash',
    '{ printf \'gh\'; for a in "$@"; do printf \' [%s]\' "$a"; done; printf \'\\n\'; } >> "$SCENARIO_DIR/gh_calls.log"',
    'if [ "$1" = issue ] && [ "$2" = view ]; then',
    '  cat "$SCENARIO_DIR/issue_body.txt"',
    '  exit 0',
    'fi',
    'if [ "$1" = issue ] && [ "$2" = edit ]; then',
    '  prev=""',
    '  for a in "$@"; do [ "$prev" = --body-file ] && cp "$a" "$SCENARIO_DIR/posted_body.md"; prev="$a"; done',
    '  exit 0',
    'fi',
    'echo "gh-stub: unhandled call: $*" >&2; exit 64'
].join('\n') + '\n';

var DATE_STUB = [
    '#!/usr/bin/env bash',
    'if [ "$1" = -u ] && [ "$2" = "+%H:%M" ]; then echo "$FIXED_HHMM"; exit 0; fi',
    'exec /bin/date "$@"'
].join('\n') + '\n';

function runPipelineScenario(name, issueBody, jobResult, fixedHHMM, expectedStatus) {
    var tmp = cp.execSync('mktemp -d').toString().trim();
    fs.writeFileSync(tmp + '/mark-job-done.sh', SH_SPEC, { mode: 493 });
    fs.writeFileSync(tmp + '/gh', GH_STUB, { mode: 493 });
    fs.writeFileSync(tmp + '/date', DATE_STUB, { mode: 493 });
    fs.writeFileSync(tmp + '/issue_body.txt', issueBody);
    var env = Object.assign({}, process.env, {
        SCENARIO_DIR: tmp,
        NUMBER: '42',
        REPO: undefined,
        GITHUB_REPOSITORY: 'IstN/target-repo',
        RUN_URL: RUN_URL,
        JOB_RESULT: jobResult,
        FIXED_HHMM: fixedHHMM,
        PATH: tmp + require('path').delimiter + process.env.PATH
    });
    delete env.REPO;
    var sh = cp.spawnSync('bash', [tmp + '/mark-job-done.sh'], { env, encoding: 'utf8' });
    if (sh.status !== 0) throw new Error('sh scenario failed: ' + sh.stderr);
    // the no-marker path never posts — absent file == no post
    var shPosted = null;
    try { shPosted = fs.readFileSync(tmp + '/posted_body.md', 'utf8'); } catch (e) {}
    var shStdout = sh.stdout;

    // JS side: same gh view output (real gh prints the body + trailing \n),
    // same fixed clock, capturers instead of the CLI.
    var jsPosted = null;
    var jsLogs = [];
    var r = mjd.markJobDone({
        repo: 'IstN/target-repo', number: '42', runUrl: RUN_URL,
        jobResult: jobResult, endTs: fixedHHMM
    }, {
        exec: function (cmd) {
            if (cmd.indexOf('issue view') !== -1) return issueBody;
            if (cmd.indexOf('issue edit') !== -1) return '';
            throw new Error('unexpected: ' + cmd);
        },
        writeFile: function (p, content) { jsPosted = content; },
        clock: function () {
            var parts = fixedHHMM.split(':');
            return new Date(Date.UTC(2026, 9, 13, +parts[0], +parts[1]));
        },
        log: function (line) { jsLogs.push(line); }
    });

    var okBody = (shPosted === null) ? (jsPosted === null) : (shPosted === jsPosted);
    var okLog = shStdout === jsLogs.join('\n') + '\n';
    var okStatus = r.status === expectedStatus;
    console.log('  scenario ' + name + ': posted-body ' +
        (shPosted === null ? ('none on both sides' + (okBody ? '' : ' (JS POSTED!)')) : (okBody ? 'BYTE-IDENTICAL' : 'DIFF')) +
        ', stdout ' + (okLog ? 'identical' : 'DIFF') +
        (okBody && okLog && okStatus ? '' : '  ← FAILURE'));
    if (!okBody || !okLog || !okStatus) {
        console.log('    sh posted: ' + JSON.stringify(shPosted));
        console.log('    js posted: ' + JSON.stringify(jsPosted));
        console.log('    sh stdout: ' + JSON.stringify(shStdout));
        console.log('    js stdout: ' + JSON.stringify(jsLogs));
        return false;
    }
    return true;
}

// Scenario 1: the canonical flip (trailing newline flows through both paths).
// Scenario 2: gh transport stripping the trailing newline (execOut-style $()
// semantics) — the JS ORS rule must land the same posted bytes as the sh
// pipeline, whose file always carries the final newline.
// Scenario 3: no-marker warning path (stdout line compare only).
var pipelineOk =
    runPipelineScenario('flip (body + trailing \\n)',
        '- [ ] Run factory agent started 09:15 [1777](' + RUN_URL + ')\n- [ ] other\n', 'success', '12:34', 'flipped') &
    runPipelineScenario('flip (newline-stripped transport)',
        '- [ ] Run factory agent started 09:15 [1777](' + RUN_URL + ')', 'failure', '23:59', 'flipped') &
    runPipelineScenario('no-marker warning',
        '- [ ] unrelated task\n- [x] done\n', 'cancelled', '00:01', 'no-marker');
var pipelineFailed = (pipelineOk !== 1 && pipelineOk !== true);

if (failures === 0 && !pipelineFailed) {
    console.log('sh-pipeline scenarios: 3/3 byte-identical (posted body + stdout marker)');
    process.exit(0);
}
if (pipelineFailed) {
    console.log('sh-pipeline scenarios: FAILURE');
    process.exit(1);
}
process.exit(1);
