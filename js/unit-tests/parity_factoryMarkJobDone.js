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
var fs = require('fs');
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
process.exit(failures === 0 ? 0 : 1);
