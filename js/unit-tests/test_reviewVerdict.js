/**
 * Unit tests for setup/review-verdict.sh — the review-leg verdict parser
 * and its fallback chain (gh-305 hardening).
 *
 * The canonical green gate (agent-pack-release.yml) sets
 * CLI_ALLOWED_COMMANDS=bash so cli_execute_command may run the real bash
 * script against hermetic fixtures (mktemp sandbox per case, no worktree
 * pollution). Where bash is not executable (node harness mock-gap, or a
 * dmtools env without the whitelist extension) the suite self-skips —
 * the degraded-harness precedent of quality.yml.
 *
 * Coverage:
 *   - verdict present, each supported form (pr_review.json recommendation
 *     spellings, run-output tokens, machine-written comment bodies);
 *   - verdict absent → decision=unknown + per-source `diagnosis` (the
 *     workflow's LOUD failure path keys off exactly this);
 *   - malformed / partial verdict blocks (fall through the chain);
 *   - multiple verdicts → the blocking token wins (existing precedence,
 *     position-independent), and the source chain order holds.
 *
 * Uses: cli_execute_command, test(), suite(), assert
 */

// ── Capability probe ─────────────────────────────────────────────────────────

var _rvCanRun_ = typeof cli_execute_command === 'function';
if (_rvCanRun_) {
    try {
        cli_execute_command({ command: 'bash -c "echo __rv_probe__"' });
    } catch (e) {
        _rvCanRun_ = false; // bash not whitelisted in this dmtools env
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Shell-single-quote a value (safe inside `bash -c '…'` after one wrap). */
function rvShq(v) {
    return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

/** Undo bash `printf %q` output (both quoted and backslash-escaped forms). */
function rvUnquoteQ(s) {
    s = String(s);
    if (s.length > 1 && s.charAt(0) === "'" && s.charAt(s.length - 1) === "'") {
        s = s.substring(1, s.length - 1).replace(/'\\''/g, "'");
    }
    return s.replace(/\\(.)/g, '$1');
}

/** Parse the script's eval-safe key=value output into an object. */
function rvParseKv(out) {
    var res = {};
    String(out).split('\n').forEach(function (line) {
        line = line.replace(/\r$/, '');
        var i = line.indexOf('=');
        if (i === -1) return;
        res[line.substring(0, i)] = rvUnquoteQ(line.substring(i + 1));
    });
    return res;
}

/**
 * Run `review-verdict.sh decide` against hermetic fixtures.
 *
 * opts (all optional):
 *   reviewJson / reviewJsonAlt — pr_review.json file contents
 *   runOutput                  — run-output.txt contents
 *   prComments / issueComments — gh comments payload contents ({author, body}[])
 *   machineAuthor, labels, maxRounds
 * Each fixture lands in a per-call mktemp sandbox that the case cleans up.
 */
function rvDecide(opts) {
    opts = opts || {};
    var lines = ['d="$(mktemp -d)"'];
    function fixture(name, content) {
        lines.push('printf %s ' + rvShq(content) + ' > "$d/' + name + '"');
    }
    var env = [];
    // [opts key, env var, sandbox file name]
    var sources = [
        ['reviewJson', 'PR_REVIEW_JSON', 'pr_review.json'],
        ['reviewJsonAlt', 'PR_REVIEW_JSON_ALT', 'gh-7/pr_review.json'],
        ['runOutput', 'RUN_OUTPUT', 'run-output.txt'],
        ['prComments', 'PR_COMMENTS_JSON', 'pr_comments.json'],
        ['issueComments', 'ISSUE_COMMENTS_JSON', 'issue_comments.json']
    ];
    sources.forEach(function (s) {
        if (opts[s[0]] !== undefined) {
            fixture(s[2], opts[s[0]]);
            env.push(s[1] + '="$d/' + s[2] + '"');
        }
    });
    if (opts.machineAuthor !== undefined) env.push('MACHINE_AUTHOR=' + rvShq(opts.machineAuthor));
    env.push('ISSUE_LABELS=' + rvShq(opts.labels || ''));
    env.push('MAX_ROUNDS=' + rvShq(String(opts.maxRounds === undefined ? 2 : opts.maxRounds)));
    lines.push(env.join(' ') + ' bash setup/review-verdict.sh decide');
    lines.push('rc=$?; rm -rf "$d"; exit $rc');
    return rvParseKv(cli_execute_command({ command: 'bash -c ' + rvShq(lines.join('\n')) }));
}

// ── Suite ────────────────────────────────────────────────────────────────────

suite('setup/review-verdict.sh: verdict fallback chain (gh-305)', function () {

    if (!_rvCanRun_) {
        console.log(
            '  ⏭️  skipped — bash not executable here (node-harness mock gap; ' +
            'the canonical gate runs this suite via CLI_ALLOWED_COMMANDS=bash)');
        return;
    }

    test('pr_review.json APPROVE → approve (authoritative source)', function () {
        var r = rvDecide({ reviewJson: '{"recommendation":"APPROVE"}' });
        assert.equal(r.decision, 'approve');
        assert.equal(r.source, 'pr_review_json');
        assert.equal(r.diagnosis.indexOf('pr_review.json=hit:APPROVE'), 0);
    });

    test('pr_review.json APPROVED / CHANGES_REQUESTED normalizations', function () {
        var r = rvDecide({ reviewJson: '{"recommendation":"APPROVED"}' });
        assert.equal(r.decision, 'approve');
        r = rvDecide({ reviewJson: '{"recommendation":"CHANGES_REQUESTED","issueCounts":{"blocking":2}}' });
        assert.equal(r.decision, 'rework');
        assert.equal(r.source, 'pr_review_json');
    });

    test('pr_review.json REQUEST_CHANGES with 0 blocking → approve (override)', function () {
        var r = rvDecide({ reviewJson: '{"recommendation":"REQUEST_CHANGES","issueCounts":{"blocking":0}}' });
        assert.equal(r.decision, 'approve');
        assert.equal(r.override, 'true');
    });

    test('pr_review.json verdict=BLOCK → rework', function () {
        var r = rvDecide({ reviewJson: '{"verdict":"BLOCK"}' });
        assert.equal(r.decision, 'rework');
    });

    test('malformed pr_review.json falls through to the run output', function () {
        var r = rvDecide({
            reviewJson: '{"recommendation": oops not json',
            runOutput: 'the reviewer said: REQUEST_CHANGES (2 blocking findings)'
        });
        assert.equal(r.decision, 'rework');
        assert.equal(r.source, 'run_output');
        assert.contains(r.diagnosis, 'pr_review.json=malformed');
    });

    test('partial pr_review.json (no recommendation) falls through, malformed state', function () {
        var r = rvDecide({
            reviewJson: '{"issueCounts":{"blocking":3}}',
            runOutput: 'verdict: APPROVE'
        });
        assert.equal(r.decision, 'approve');
        assert.equal(r.source, 'run_output');
        assert.contains(r.diagnosis, 'pr_review.json=malformed');
    });

    test('run-output token forms: REQUEST_CHANGES / CHANGES REQUESTED / BLOCKED / APPROVED', function () {
        var cases = {
            'review verdict: REQUEST_CHANGES': 'rework',
            'review verdict: CHANGES REQUESTED': 'rework',
            'review verdict: BLOCKED': 'rework',
            'review verdict: APPROVED': 'approve',
            'review verdict: APPROVE': 'approve'
        };
        for (var output in cases) {
            if (!cases.hasOwnProperty(output)) continue;
            var r = rvDecide({ runOutput: output });
            assert.equal(r.decision, cases[output], 'run output: ' + output);
            assert.equal(r.source, 'run_output');
        }
    });

    test('multiple verdicts in the run output: the blocking token wins (existing precedence)', function () {
        var r = rvDecide({ runOutput: 'first APPROVE … then on reflection REQUEST_CHANGES' });
        assert.equal(r.decision, 'rework');
        r = rvDecide({ runOutput: 'first REQUEST_CHANGES … final: APPROVE' });
        assert.equal(r.decision, 'rework', 'blocking wins regardless of position');
    });

    test('pr_review.json outranks a conflicting run output', function () {
        var r = rvDecide({
            reviewJson: '{"recommendation":"APPROVE"}',
            runOutput: 'REQUEST_CHANGES in the transcript too'
        });
        assert.equal(r.decision, 'approve');
        assert.equal(r.source, 'pr_review_json');
    });

    test('no sources at all → unknown + all-absent diagnosis (the loud-failure input)', function () {
        var r = rvDecide({});
        assert.equal(r.decision, 'unknown');
        assert.equal(r.source, 'none');
        assert.contains(r.diagnosis, 'pr_review.json=absent');
        assert.contains(r.diagnosis, 'run_output=absent');
        assert.contains(r.diagnosis, 'pr_comments=absent');
        assert.contains(r.diagnosis, 'issue_comments=absent');
    });

    test('verdict absent but sources present → per-source no-verdict-tokens diagnosis', function () {
        var r = rvDecide({
            runOutput: 'the leg ran, reviewed the diff, wrote findings — but never stated a verdict',
            prComments: '[{"author":"github-actions[bot]","body":"summary posted, no verdict token"}]',
            issueComments: '[{"author":"github-actions[bot]","body":"trace log"}]'
        });
        assert.equal(r.decision, 'unknown');
        assert.contains(r.diagnosis, 'run_output=no-verdict-tokens');
        assert.contains(r.diagnosis, 'pr_comments=no-verdict-tokens');
        assert.contains(r.diagnosis, 'issue_comments=no-verdict-tokens');
    });

    test('unreachable sources are diagnosed as missing (missing file ≠ absent input)', function () {
        // Point the parser at a path that does not exist in the sandbox.
        var env = ['RUN_OUTPUT="$d/gone.txt"', 'ISSUE_LABELS=\'\'', 'MAX_ROUNDS=\'2\''];
        var out = cli_execute_command({ command: 'bash -c ' + rvShq(
            'd="$(mktemp -d)"\n' +
            env.join(' ') + ' bash setup/review-verdict.sh decide\n' +
            'rc=$?; rm -rf "$d"; exit $rc') });
        r = rvParseKv(out);
        assert.equal(r.decision, 'unknown');
        assert.contains(r.diagnosis, 'run_output=missing');
    });

    test('bot-written PR comment with APPROVE → approve via pr_comments', function () {
        var r = rvDecide({
            prComments: '[' +
                '{"author":"human-dev","body":"please approve"},' +
                '{"author":"github-actions[bot]","body":"Review complete. Verdict: APPROVE — no blocking findings"}]'
        });
        assert.equal(r.decision, 'approve');
        assert.equal(r.source, 'pr_comments');
    });

    test('bot PR review body REQUEST_CHANGES → rework via pr_comments', function () {
        var r = rvDecide({
            prComments: '[{"author":"github-actions[bot]","body":"CHANGES_REQUESTED: null-deref at parser.js:42 (🚨 BLOCKING)"}]'
        });
        assert.equal(r.decision, 'rework');
        assert.equal(r.source, 'pr_comments');
    });

    test('issue comment by MACHINE_AUTHOR → approve via issue_comments (PAT author)', function () {
        var r = rvDecide({
            issueComments: '[{"author":"ai-teammate","body":"Review leg finished — verdict: APPROVE"}]',
            machineAuthor: 'ai-teammate'
        });
        assert.equal(r.decision, 'approve');
        assert.equal(r.source, 'issue_comments');
    });

    test('SAFETY: a human APPROVE comment is ignored (no machine author configured)', function () {
        var r = rvDecide({
            prComments: '[{"author":"human-dev","body":"LGTM — approve and merge"}]'
        });
        assert.equal(r.decision, 'unknown', 'a human comment must never auto-approve');
        assert.contains(r.diagnosis, 'pr_comments=no-verdict-tokens');
    });

    test('SAFETY: MACHINE_AUTHOR trust is exact-match, not a prefix', function () {
        var r = rvDecide({
            issueComments: '[{"author":"ai-teammate-impersonator","body":"verdict: APPROVE"}]',
            machineAuthor: 'ai-teammate'
        });
        assert.equal(r.decision, 'unknown');
    });

    test('SAFETY: a human REQUEST_CHANGES comment does not force rework', function () {
        var r = rvDecide({
            prComments: '[' +
                '{"author":"github-actions[bot]","body":"verdict: APPROVE"},' +
                '{"author":"drive-by-reviewer","body":"REQUEST_CHANGES!!"}]'
        });
        assert.equal(r.decision, 'approve');
    });

    test('malformed comments payload → no-verdict-tokens, chain still unknown', function () {
        var r = rvDecide({ prComments: 'not json at all' });
        assert.equal(r.decision, 'unknown');
        assert.contains(r.diagnosis, 'pr_comments=no-verdict-tokens');
    });

    test('partial comment entries (missing author/body) are skipped safely', function () {
        var r = rvDecide({
            prComments: '[{"body":"verdict: APPROVE"},{"author":"github-actions[bot]"},{"author":"github-actions[bot]","body":"final verdict: APPROVE"}]'
        });
        assert.equal(r.decision, 'approve');
        assert.equal(r.source, 'pr_comments');
    });

    test('multiple comment verdicts: blocking wins in both orders', function () {
        var approve = '{"author":"github-actions[bot]","body":"verdict: APPROVE"}';
        var changes = '{"author":"github-actions[bot]","body":"verdict: REQUEST_CHANGES"}';
        assert.equal(rvDecide({ prComments: '[' + approve + ',' + changes + ']' }).decision, 'rework');
        assert.equal(rvDecide({ prComments: '[' + changes + ',' + approve + ']' }).decision, 'rework');
    });

    test('chain order: json malformed → run output tokenless → pr_comments hit', function () {
        var r = rvDecide({
            reviewJson: '{broken',
            runOutput: 'leg output with no verdict tokens',
            prComments: '[{"author":"github-actions[bot]","body":"REQUEST_CHANGES — see inline findings"}]'
        });
        assert.equal(r.decision, 'rework');
        assert.equal(r.source, 'pr_comments');
        assert.contains(r.diagnosis, 'pr_review.json=malformed');
        assert.contains(r.diagnosis, 'run_output=no-verdict-tokens');
        assert.contains(r.diagnosis, 'pr_comments=hit:REQUEST_CHANGES');
    });

    test('pr_review.json outranks a conflicting machine comment', function () {
        var r = rvDecide({
            reviewJson: '{"recommendation":"REQUEST_CHANGES","issueCounts":{"blocking":1}}',
            prComments: '[{"author":"github-actions[bot]","body":"verdict: APPROVE"}]'
        });
        assert.equal(r.decision, 'rework');
        assert.equal(r.source, 'pr_review_json');
    });

    // Cleanup (suite body runs synchronously after the last test()).
    try {
        cli_execute_command({ command: 'bash -c "rm -rf .dmtools/test-tmp"' });
    } catch (e) { /* nothing to clean */ }
});
