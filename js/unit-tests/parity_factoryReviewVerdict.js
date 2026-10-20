// Parity harness: JS review-verdict port vs the REAL awf sh pipeline.
//
// Like parity_factoryMarkJobDone.js, this does not rest on unit-test
// assumptions: it runs the spec's FULL apply-review-verdict.sh
// (js/unit-tests/fixtures/apply-review-verdict.spec.sh — a byte-verbatim
// snapshot of dmtools-agentic-workflows scripts/apply-review-verdict.sh @
// PR #34; the sh + its A/B harness stay intact there until the final
// rewire) under bash with PATH-stubbed gh/date/sleep in a temp dir, then
// drives the JS module with the same stub world and compares every
// transport artifact byte-for-byte:
//   - the gh_calls.log (argv of every gh invocation, same stub on both
//     sides → identical expected output),
//   - the posted comment body file bytes,
//   - the graphql -f query payload,
//   - the exit code,
//   - the diagnostic log stream (the sh's stdout echo lines vs the JS
//     io.log lines — the → progress lines plus the ::warning::/::error::
//     annotations, i.e. the warn lines for the non-fatal failure mode;
//     the sh prints them on stdout, the JS side logs them).
//
// Run: node js/unit-tests/parity_factoryReviewVerdict.js

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var REPO = 'tests/fixtures';
var SPECS = {
    sh: path.join(__dirname, 'fixtures', 'apply-review-verdict.spec.sh')
};

var GH_STUB = [
    '#!/usr/bin/env bash',
    'JQ=""',
    'prev=""',
    'for a in "$@"; do',
    '  [ "$prev" = --jq ] && JQ="$a"',
    '  prev="$a"',
    'done',
    '{ printf \'gh\'; for a in "$@"; do printf \' [%s]\' "$a"; done; printf \'\\n\'; } >> "$SCENARIO_DIR/gh_calls.log"',
    'apply_jq() { if [ -n "$JQ" ]; then jq -r "$JQ"; else cat; fi; }',
'if [ "$1" = issue ] && [ "$2" = view ]; then',
    '  apply_jq < "$SCENARIO_DIR/issue_view.json"',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    '  { printf \'graphql\'; for a in "$@"; do printf \' [%s]\' "$a"; done; printf \'\\n\'; } >> "$SCENARIO_DIR/graphql.log"',
    '  [ -f "$SCENARIO_DIR/graphql_fails" ] && exit 1',
    '  apply_jq < "$SCENARIO_DIR/threads.json"',
    '  exit 0',
    'fi',
    'if [ "$1" = pr ] && [ "$2" = view ]; then',
    '  case "$*" in *statusCheckRollup*)',
    '    POLLS=$(cat "$SCENARIO_DIR/polls" 2>/dev/null || echo 0)',
    '    POLLS=$((POLLS + 1))',
    '    printf \'%s\\n\' "$POLLS" > "$SCENARIO_DIR/polls"',
    '    if [ "$POLLS" -ge "$CHECKS_AFTER_POLLS" ]; then',
    '      case "$CHECKS_STATE" in',
    '        FAILURE) printf \'{"statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}]}\\n\' ;;',
    '        *) printf \'{"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}\\n\' ;;',
    '      esac',
    '    else',
    '      printf \'{"statusCheckRollup":[{"status":"IN_PROGRESS","conclusion":null}]}\\n\'',
    '    fi | apply_jq',
    '    exit 0',
    '    ;;',
    '  esac',
    '  apply_jq < "$SCENARIO_DIR/pr_view.json"',
    '  exit 0',
    'fi',
    'if [ "$1" = pr ] && [ "$2" = list ]; then',
    '  apply_jq < "$SCENARIO_DIR/pr_list.json"',
    '  exit 0',
    'fi',
    'if [ "$1" = pr ] && [ "$2" = edit ]; then',
    '  { printf \'pr-edit\'; for a in "$@"; do printf \' [%s]\' "$a"; done; printf \'\\n\'; } >> "$SCENARIO_DIR/gh_calls.log"',
    '  exit 0',
    'fi',
    'if [ "$1" = issue ] && [ "$2" = comment ]; then',
    '  prev=""',
    '  for a in "$@"; do [ "$prev" = --body-file ] && cp "$a" "$SCENARIO_DIR/posted_comment.md"; prev="$a"; done',
    '  exit 0',
    'fi',
    'exit 0'
].join('\n') + '\n';

var DATE_STUB = '#!/usr/bin/env bash\necho 1791885600\n';
var SLEEP_STUB = '#!/usr/bin/env bash\nexit 0\n';

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function makeScenario(dir, fx) {
    fs.mkdirSync(dir, { recursive: true });
    var bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
    fs.writeFileSync(path.join(bin, 'date'), DATE_STUB);
    fs.writeFileSync(path.join(bin, 'sleep'), SLEEP_STUB);
    ['gh', 'date', 'sleep'].forEach(function (n) {
        fs.chmodSync(path.join(bin, n), 0o755);
    });
    fs.writeFileSync(path.join(dir, 'issue_result.txt'), fx.jobResult);
    fs.writeFileSync(path.join(dir, 'pr_view.json'), JSON.stringify(fx.prView || {
        headRefName: 'agents/issue-42', state: 'OPEN'
    }) + '\n');
    fs.writeFileSync(path.join(dir, 'pr_list.json'), JSON.stringify(fx.prList === undefined
        ? [{ number: fx.number, body: 'closes #' + fx.number,
             headRefName: 'agents/issue-' + fx.number }]
        : fx.prList) + '\n');
    fs.writeFileSync(path.join(dir, 'issue_view.json'),
        JSON.stringify({
            labels: String(fx.labels || '').split(/\s+/).filter(Boolean)
                .map(function (n) { return { name: n }; }),
            comments: [], body: 'issue body #' + fx.number
        }) + '\n');
    fs.writeFileSync(path.join(dir, 'issue_labels.json'),
        JSON.stringify({ labels: fx.labels || [] }) + '\n');
    fs.writeFileSync(path.join(dir, 'run_output.txt'), (fx.runOutput ||
        'APPROVE — looks good\n'));
    if (fx.graphqlFails) fs.writeFileSync(path.join(dir, 'graphql_fails'), 'x\n');
    fs.writeFileSync(path.join(dir, 'threads.json'), JSON.stringify(fx.threads || {
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } }
    }) + '\n');
    // The spec resolves the verdict logic itself: pack glob wins, else
    // $FACTORY_ROOT/setup/review-verdict.sh. Stub the legacy path with the
    // real contract: eval-safe key=value lines (NOT json).
    fs.mkdirSync(path.join(dir, 'setup'), { recursive: true });
    // The real verdict.sh emits EVAL-SAFE key=value lines (the spec evals
    // them under bash -e): multi-word values must be shell-quoted or the
    // eval explodes with rc 127 ('agent:rework-2: command not found').
    var evalSafe = function (v) {
        v = String(v);
        return /^[A-Za-z0-9._@/-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'";
    };
    fs.writeFileSync(path.join(dir, 'setup', 'review-verdict.sh'), fx.verdictFails
        ? '#!/usr/bin/env bash\nexit 1\n'
        : '#!/usr/bin/env bash\n' +
          'echo "decision=' + evalSafe(fx.verdict.decision) + '"\n' +
          'echo "source=' + evalSafe('stub-source') + '"\n' +
          'echo "override=' + evalSafe('false') + '"\n' +
          'echo "rounds_done=' + evalSafe(fx.verdict.roundsDone) + '"\n' +
          'echo "next_round=' + evalSafe(fx.verdict.nextRound) + '"\n' +
          'echo "escalate=' + evalSafe(fx.verdict.escalate) + '"\n' +
          'echo "round_labels=' + evalSafe(fx.verdict.roundLabels || '') + '"\n');
    fs.chmodSync(path.join(dir, 'setup', 'review-verdict.sh'), 0o755);
    return {
        dir: dir,
        env: {
            SCENARIO_DIR: dir, PATH: bin + ':/usr/bin:/bin',
            CHECKS_AFTER_POLLS: String(fx.checksAfterPolls === undefined ? 2 : fx.checksAfterPolls),
            CHECKS_STATE: fx.checksState || 'CLEAN',
            GITHUB_REPOSITORY: REPO, NUMBER: String(fx.number), RUN_URL: fx.runUrl,
            JOB_RESULT: fx.jobResult, RUN_OUTPUT: path.join(dir, 'run_output.txt'),
            MACHINE_AUTHOR: 'stub-bot', MAX_ROUNDS: '2',
            CONFIG: 'pr_review.json', HOME: dir, FACTORY_ROOT: dir,
            SOURCE_GITHUB_TOKEN: 'stub-token', GH_TOKEN: 'stub-token'
        }
    };
}

// Hard wall for every child: the harness must never hang. The one
// legitimately slow path — the spec's 600 s pending-checks deadline driven
// by bash's real-time $SECONDS — is compressed by the CHECKS_AFTER_POLLS
// stub above; scenarios that intentionally exhaust it (fx.checksAfterPolls
// = Infinity) KILL the sh mid-loop and compare the loop invariants
// instead of the post-deadline artifacts.
var CHILD_TIMEOUT_MS = 20000;

// Run the sh spec. `exec` replaces the /bin/sh wrapper with bash itself so
// the 20 s SIGKILL wall kills the poll-loop process — without it the
// deadline scenario orphans a bash that busy-polls for 600 real seconds.
function runSh(fx) {
    var sc = makeScenario(path.join(fx.tmp, 'sh'), fx);
    // stdout is captured (not /dev/null): the sh's echo lines ARE the
    // diagnostic log stream compared against the JS io.log lines below.
    var cmd = 'exec bash -e ' + q(SPECS.sh) + ' >' +
        q(path.join(sc.dir, 'stdout.txt')) + ' 2>' +
        q(path.join(sc.dir, 'stderr.txt'));
    var rc;
    try {
        cp.execSync(cmd, { env: sc.env, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' });
        rc = 0;
    } catch (e) {
        if (e.killed || e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT') return { killed: true, sc: sc };
        rc = e.status;
        if (typeof rc !== 'number') throw e;
    }
    var a = artifacts(sc.dir, rc);
    a.logs = a.stdout; // the sh's log stream rides stdout
    return a;
}

// Run the JS module through the JSRunner entry with the same stub world:
// exec goes through the PATH-stubbed gh (so gh_calls.log is comparable),
// env carries the sh step's variable names.
function runJs(fx) {
    var sc = makeScenario(path.join(fx.tmp, 'js'), fx);
    var entry = require(path.join(__dirname, '..', 'factory', 'review_verdict_publish.js'));
    var rc = 0;
    var logs = [];
    try {
        entry.action({
            jobParams: { customParams: {} }
        }, {
            cli_execute_command: function (r) {
                var out = cp.execSync(r.command, {
                    env: sc.env, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL'
                });
                return { output: out.toString() };
            },
            env: {
                NUMBER: String(fx.number), RUN_URL: fx.runUrl,
                JOB_RESULT: fx.jobResult, GITHUB_REPOSITORY: REPO,
                GH_TOKEN: 'stub-token', SOURCE_GITHUB_TOKEN: 'stub-token',
                RUN_OUTPUT: sc.env.RUN_OUTPUT, MACHINE_AUTHOR: 'stub-bot',
                MAX_ROUNDS: '2', HOME: sc.dir, CONFIG: 'pr_review.json',
                FACTORY_ROOT: sc.dir,
                SM_KICK: 'false' // gh-1101 JS-only extension, not in the sh
            },
            file_write: function (p, c) { fs.writeFileSync(p, c); },
            file_read: function (r) {
                try { return fs.readFileSync(r.path).toString(); }
                catch (e) { return null; }
            },
            console_log: function (m) { logs.push(String(m)); },
            // The sh's poll deadline runs on real $SECONDS with an instant
            // sleep stub; mirror that compression on the JS side: the fake
            // clock advances one CI_POLL_MS (30 s) per call, so the 600 s
            // deadline is reached after ~20 fast stub polls instead of 10
            // real minutes of busy-looping.
            clock: (function () {
                var t = 1791885600000;
                return function () { t += 30000; return new Date(t); };
            })(),
            sleepMs: function () {}
        });
    } catch (e) { rc = 1; if (process.env.RV_DEBUG) console.log('  JS-ERR:', String(e && e.message || e).slice(0, 300)); }
    var a = artifacts(sc.dir, rc);
    // the JS log stream: the io.log lines, newline-terminated like the
    // sh's echo lines (the entry's own ⚖️ console.log is NOT io.log).
    a.logs = logs.join('\n') + (logs.length ? '\n' : '');
    return a;
}

function artifacts(dir, rc) {
    var read = function (n) {
        try { return fs.readFileSync(path.join(dir, n)).toString(); }
        catch (e) { return null; }
    };
    return {
        rc: rc,
        ghCalls: read('gh_calls.log'),
        graphql: read('graphql.log'),
        comment: read('posted_comment.md'),
        stdout: read('stdout.txt'),
        stderr: read('stderr.txt')
    };
}

function readOrNull(p) {
    try { return fs.readFileSync(p).toString(); } catch (e) { return null; }
}

function canon(a) {
    // The sh's --jq literal for the rollup query is a line-continued
    // single-quoted string (newline + indent INSIDE the argv); the JS port
    // carries the same expression on one line. Normalize both sides to the
    // one-line form — the jq OUTPUT is compared through the same stub.
    var norm = function (s) {
        if (s === null || s === undefined) return s;
        s = String(s);
        // The sh's --jq literal for the rollup query is a line-continued
        // single-quoted string (newline + indent INSIDE the argv); the JS
        // port carries the same expression on one line. Normalize both
        // sides to the one-line form — the jq OUTPUT is compared through
        // the same stub.
        s = s.replace(/\n\s+then "PENDING" else/g, ' then "PENDING" else');
        // The two sides run in sibling scenario dirs (<tmp>/sh vs
        // <tmp>/js); the verdict-logic log line carries the dir. Normalize
        // the side segment — the path SHAPE is compared, the side is not
        // an artifact of the port.
        s = s.replace(/\/(sh|js)\//g, '/<SIDE>/');
        // The comment body rides a temp file whose NAME is an artifact of
        // the side (mktemp vs the entry's rv-N-comment.md); the bytes are
        // compared separately in `comment`. Normalize the argv token.
        s = s.replace(/\[--body-file\] \[[^\]]+\]/g, '[--body-file] [BODY_FILE]');
        return s;
    };
    return {
        rc: a.rc,
        ghCalls: norm(a.ghCalls),
        graphql: norm(a.graphql),
        comment: a.comment,
        logs: norm(a.logs)
    };
}

var outcomes = { total: 0, pass: 0, fails: [] };

function compare(name, fx) {
    outcomes.total++;
    if (process.env.RV_PROG) console.error('→ scenario ' + name);
    if (process.env.RV_ONLY && name !== process.env.RV_ONLY) return;
    fx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-parity-'));
    try {
        var a = runSh(fx);
        var b = canon(runJs(fx));
        if (a.killed) {
            // deadline-exhaustion scenario: the sh was SIGKILLed mid
            // poll-loop (600 s of real $SECONDS compressed away). Parity
            // invariants: the sh was polling and had NOT yet posted the
            // warning/labels; the JS module converged to the terminal
            // artifacts (warn comment, no pr_approved label).
            var gh = a.sc ? readOrNull(path.join(a.sc.dir, 'gh_calls.log')) : '';
            var polls = (gh.match(/\[--json\] \[statusCheckRollup\]/g) || []).length;
            var posted = readOrNull(path.join(a.sc.dir, 'posted_comment.md'));
            var diffs = [];
            if (polls < 5) diffs.push('sh not in poll loop (polls=' + polls + ')');
            if (posted !== null) diffs.push('sh posted before deadline');
            if (gh && /pr_approved/.test(gh)) diffs.push('sh labeled pr_approved before deadline');
            var jsLog = b.logs || '';
            if (jsLog.indexOf('checks still pending') === -1) diffs.push('js missing pending warning');
            if (b.comment) diffs.push('js posted unexpected comment');
            if (b.ghCalls && /add-label.*pr_approved/.test(b.ghCalls)) diffs.push('js labeled pr_approved');
            if (diffs.length) {
                outcomes.fails.push(name + ' (deadline): ' + diffs.join(', '));
                console.log('  MISMATCH ' + name + ' (deadline) — ' + diffs.join(', '));
            } else {
                outcomes.pass++;
            }
            return;
        }
        a = canon(a);
        var diffs = [];
        if (a.rc !== b.rc) diffs.push('rc ' + a.rc + ' vs ' + b.rc);
        ['ghCalls', 'graphql', 'comment', 'logs'].forEach(function (k) {
            if (a[k] !== b[k]) diffs.push(k);
        });
        if (diffs.length) {
            outcomes.fails.push(name + ': ' + diffs.join(', '));
            console.log('  MISMATCH ' + name + ' — ' + diffs.join(', '));
            if (process.env.RV_KEEP) console.log('    KEPT ' + fx.tmp);
            ['ghCalls', 'graphql', 'comment', 'logs'].forEach(function (k) {
                if (a[k] !== b[k]) {
                    console.log('    sh: ' + JSON.stringify(String(a[k]).slice(0, 200)));
                    console.log('    js: ' + JSON.stringify(String(b[k]).slice(0, 200)));
                }
            });
        } else {
            outcomes.pass++;
        }
    } finally {
        if (!process.env.RV_KEEP) cp.execSync('rm -rf ' + q(fx.tmp));
    }
}

// ── deterministic scenarios ────────────────────────────────────────────
var BASE = { number: 42, runUrl: 'https://github.com/IstiN/target-repo/actions/runs/1777' };

compare('approve green', Object.assign({}, BASE, {
    jobResult: 'all checks green',
    verdict: { decision: 'approve', roundsDone: 1, nextRound: 1, escalate: 'false' },
    prView: { headRefName: 'agents/issue-42', state: 'OPEN' }
}));
compare('rework under cap', Object.assign({}, BASE, {
    jobResult: 'issues remain',
    verdict: { decision: 'rework', roundsDone: 1, nextRound: 2, escalate: 'false',
               roundLabels: 'agent:rework' },
    labels: 'agent:rework'
}));
compare('rework escalated (cap)', Object.assign({}, BASE, {
    jobResult: 'issues remain',
    verdict: { decision: 'rework', roundsDone: 2, nextRound: 2, escalate: 'true',
               roundLabels: 'agent:rework agent:rework-2' },
    labels: 'agent:rework agent:rework-2'
}));
compare('cancelled verdict', Object.assign({}, BASE, {
    jobResult: 'cancelled by user',
    verdict: { decision: 'cancelled', roundsDone: 0, nextRound: 0, escalate: 'false' }
}));
compare('approve + pending forever (deadline)', Object.assign({}, BASE, {
    jobResult: 'all checks green',
    verdict: { decision: 'approve', roundsDone: 1, nextRound: 1, escalate: 'false' },
    checksAfterPolls: 1000000
}));
compare('graphql fetch fails', Object.assign({}, BASE, {
    jobResult: 'issues remain', graphqlFails: true,
    verdict: { decision: 'rework', roundsDone: 1, nextRound: 2, escalate: 'false',
               roundLabels: 'agent:rework' },
    labels: 'agent:rework'
}));
compare('verdict probe fails (abort)', Object.assign({}, BASE, {
    jobResult: 'issues remain', verdictFails: true,
    verdict: { decision: 'approve', roundsDone: 1, nextRound: 1, escalate: 'false' }
}));

// ── randomized matrix ──────────────────────────────────────────────────
var decisions = ['approve', 'rework', 'cancelled'];
var seed = 1791885600;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
for (var i = 0; i < 100; i++) {
    compare('rand#' + i, Object.assign({}, BASE, {
        number: 1 + Math.floor(rnd() * 500),
        jobResult: 'outcome ' + i,
        verdict: {
            decision: decisions[Math.floor(rnd() * 3)],
            roundsDone: Math.floor(rnd() * 3),
            nextRound: Math.floor(rnd() * 3),
            escalate: rnd() < 0.3 ? 'true' : 'false',
            roundLabels: rnd() < 0.5 ? 'agent:rework' : ''
        },
        graphqlFails: rnd() < 0.2,
        checksAfterPolls: 1 + Math.floor(rnd() * 3),
        checksState: rnd() < 0.7 ? 'CLEAN' : 'FAILURE',
        prView: { headRefName: 'agents/issue-' + i, state: rnd() < 0.9 ? 'OPEN' : 'MERGED' }
    }));
}

console.log('sh-parity: ' + outcomes.pass + '/' + outcomes.total +
    ' scenarios byte-identical to the awf sh pipeline');
if (outcomes.fails.length) {
    console.log('FAILURES:\n' + outcomes.fails.join('\n'));
    process.exit(1);
}
