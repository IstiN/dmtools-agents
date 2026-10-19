/**
 * Factory review verdict — the zero-maintainer keystone glue (owner
 * directive 2026-10-13: factory glue moves into dmtools-agents as JS agent
 * code; awf workflows become thin callers).
 *
 * JS port of the awf factory-teammate.yml step «Apply the review verdict
 * (review runs only)» — byte-extracted into scripts/apply-review-verdict.sh
 * by IstiN/dmtools-agentic-workflows#34. Behavior contract is identical:
 *
 *   1. GH_TOKEN missing → warn + skip (labels would not trigger workflows).
 *   2. Fallback sources: the issue's labels, the linked open PR (closes/
 *      fixes/resolves #N in the body, or headRefName ^N[-_.] / gh-0*N$),
 *      the PR's comments+reviews and the issue's comments (a failed fetch
 *      leaves the source file absent — the parser reports `missing`).
 *   3. machineAuthor: workflow input first, then the per-repo
 *      .dmtools/config.js knob (js/common/machineAuthor.js order #2).
 *   4. Parser selection: the unpacked pack's loop/verdict.sh WINS
 *      (versions with the reviewed pack); the legacy
 *      ${FACTORY_ROOT}/setup/review-verdict.sh is the old-pin fallback.
 *   5. The parser emits an eval-safe key=value contract (decision, source,
 *      override, blocking_markers, rounds_done, next_round, escalate,
 *      round_labels, diagnosis). JS parses it line-wise instead of eval'ing
 *      — conformant contracts parse identically; non-conformant output is
 *      IGNORED rather than executed (deliberate hardening, documented).
 *   6. rework + escalate → strip round labels, needs-human (B60205), the
 *      GraphQL review-threads summary comment, done. rework → remove
 *      needs-human, agent:rework + rework-round-N (BFD4F2). approve → the
 *      CI-green gate (≤10 min of 30s polls; red checks refuse the verdict;
 *      all-green → strip labels, pr_approved). No verdict at all → LOUD
 *      failure (gh-305): ::error:: annotation, needs-human, per-source
 *      diagnosis comment, THROW (the sh exits 1 — the step must redden).
 *
 * Error contract mirrors the sh under `bash -e`: gh failures on the
 * load-bearing calls (pr list) propagate; tolerant calls keep the sh's
 * `|| true` / `|| echo ''` semantics (labels, comment sources, rollup,
 * label create, threads fetch).
 *
 * Env/file contract (the sh step's env block; the JSRunner entry reads
 * jobParams.customParams first, these env names as fallback):
 *   GH_TOKEN            presence gates the skip (gh reads it itself)
 *   NUMBER              the review issue
 *   RUN_OUTPUT          the leg's captured run output (default
 *                       .dmtools/run-output.txt)
 *   MACHINE_AUTHOR      workflow input; .dmtools/config.js knob fallback
 *   MAX_ROUNDS          the auto-rework cap (display + parser env)
 *   GITHUB_REPOSITORY   owner/repo
 *   CONFIG              runner config path (basename → pack agent)
 *   FACTORY_ROOT        legacy verdict parser root
 *   HOME                pack cache root (~/.dmtools/packs/…)
 *
 * Pure functions carry no IO: applyReviewVerdict takes { exec, writeFile,
 * readFile, tempFile, clock, sleepMs, log } capturers (factoryState.js
 * convention). exec results are unwrapped ((res.output || res.stdout) ||
 * res — the #893 review lesson); every interpolation goes through
 * shellQuote (token_usage.js); no global gh is touched (tests stub the
 * transport).
 */

var shellQuote = require('./token_usage.js').shellQuote;

var DEFAULT_RUN_OUTPUT = '.dmtools/run-output.txt';
var CI_POLL_MS = 30000;
var CI_DEADLINE_MS = 600000; // ≤10 min, the sh's SECONDS+600

var RED_CHECKS = 'FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE';
var GREEN_CHECKS = 'SUCCESS|SKIPPED|NEUTRAL';
// gh-1079: the per-poll rollup matchers, compiled once (the pre-refactor
// loop built these on every poll — same patterns, same anchors).
var RED_CHECK_RE = new RegExp('^(' + RED_CHECKS + ')$');
var GREEN_CHECK_RE = new RegExp('^(' + GREEN_CHECKS + ')$');

var THREADS_QUERY =
    'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name)' +
    '{pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved path line ' +
    'comments(first:1){nodes{body author{login}}}}}}}}';

var LABELS_JQ = '[.labels[].name] | join(" ")';
var PR_COMMENTS_JQ = '[(.comments // [])[] | {author: (.author.login // ""), body}] + [(.reviews // [])[] | {author: (.author.login // ""), body}]';
var ISSUE_COMMENTS_JQ = '[(.comments // [])[] | {author: (.author.login // ""), body}]';
var ROLLUP_JQ = '.statusCheckRollup[] | if .status and .status != "COMPLETED" then "PENDING" else (.conclusion // .state // "PENDING") end';

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Parses the parser's eval-safe key=value contract. Line-wise; quoted
 * values keep inner spaces; non-conforming lines are IGNORED (never
 * evaluated — safer than the sh's eval, identical for conformant output).
 */
function parseVerdictContract(text) {
    var out = { decision: '', source: '', override: '', blocking_markers: '',
                rounds_done: 0, next_round: 0, escalate: false,
                round_labels: '', diagnosis: '' };
    var lines = String(text == null ? '' : text).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!m) continue;
        var v = m[2];
        if (v.length >= 2) {
            var q = v.charAt(0);
            if ((q === '"' || q === "'") && v.charAt(v.length - 1) === q) v = v.substring(1, v.length - 1);
        }
        out[m[1]] = v;
    }
    out.escalate = (out.escalate === true || out.escalate === 'true');
    out.rounds_done = parseInt(out.rounds_done, 10) || 0;
    out.next_round = parseInt(out.next_round, 10) || 0;
    return out;
}

/**
 * machineAuthor resolution order #2 (js/common/machineAuthor.js). NOTE
 * (gh-728): the knob became a comma-separated login list there
 * (`machineAuthor: "ai-teammate,github-actions[bot]"`), but this matcher —
 * deliberately mirroring the spec's `sed -nE` capture ([A-Za-z0-9._-]+,
 * closing quote right after) — resolves SINGLE-login values only; a
 * comma-list matches nothing and MACHINE_AUTHOR stays empty (only *[bot]
 * comment authors trusted). Parity holds by construction; route through
 * machineAuthorLogins-style parsing only if the spec itself is updated.
 */
function resolveMachineAuthor(machineAuthor, io) {
    if (machineAuthor) return machineAuthor;
    try {
        var cfg = io.readFile('.dmtools/config.js');
        if (cfg) {
            var lines = String(cfg).split('\n');
            for (var i = 0; i < lines.length; i++) {
                var m = lines[i].match(/machineAuthor["']?\s*:\s*["']([A-Za-z0-9._-]+)["']/);
                if (m) return m[1];
            }
        }
    } catch (e) { /* unreadable/absent — empty, only *[bot] authors trusted */ }
    return '';
}

/**
 * Parser selection: the unpacked pack's loop/verdict.sh wins (sort -V |
 * tail -1 over the pack cache glob); the legacy FACTORY_ROOT tree is the
 * old-pin fallback. Returns the path; logs the sh's verdict-logic line.
 */
function pickVerdictSh(opts, io) {
    var agent = basenameNoJson(opts.config);
    var glob = 'ls -1 ' + shellQuote(opts.home + '/.dmtools/packs/') + agent +
        '-*/loop/verdict.sh 2>/dev/null | sort -V | tail -1';
    var pack = '';
    try { pack = unwrap(io.exec('bash -c ' + shellQuote(glob))).trim(); } catch (e) { pack = ''; }
    if (pack) {
        io.log('→ verdict logic: pack ' + pack);
        return pack;
    }
    var legacy = (opts.factoryRoot || '') + '/setup/review-verdict.sh';
    io.log('→ verdict logic: legacy tree ' + legacy +
        ' (no ' + agent + ' pack loop/verdict.sh unpacked)');
    return legacy;
}

function basenameNoJson(p) {
    var b = String(p || '').split('/').pop();
    return b.replace(/\.json$/, '');
}

// ── orchestration (capturer-injected) ────────────────────────────────────────

/** The entry's exec unwrap (no trim: body/file paths ride verbatim).
 * An exec result object with EMPTY output is an empty output — not the
 * object itself (the pilot's `(res.output || res.stdout) || res` stringified
 * the object to '[object Object]', which the parity harness caught as the
 * verdict-logic path). */
function unwrap(res) {
    var out = res && (res.output || res.stdout);
    if (out === undefined || out === null) out = (typeof res === 'string') ? res : '';
    return String(out || '');
}

/**
 * Apply the review verdict. See the header for opts/io and the statuses:
 * no-token | rework | escalated | approved | approve-no-pr | ci-red |
 * ci-timeout; throws on the loud no-verdict path (exit-1 parity).
 */
// ── gh-1079: applyReviewVerdict decomposed into single-purpose helpers ───────
// Behavior contract is unchanged (the characterization suite in
// test_factoryReviewVerdict.js + the sh-parity harness pin every branch);
// this only splits the former 39-complexity monolith along its existing
// seams: entry guards, the fallback-source fetch prologue, the parser probe,
// and one handler per verdict outcome (rework / escalated / missing /
// approve). Every exec, writeFile and log call keeps its original position
// in the sequence — the parity harness byte-compares the transport.

function tryExec(io, cmd, fallback) {
    try { return unwrap(io.exec(cmd)); } catch (e) { return fallback; }
}

// The sh's load-bearing-call contract: the token gate precedes everything,
// the numeric-NUMBER guard precedes any gh call (the raw jq-splice guard).
function entryGuard(opts, io) {
    var log = io.log || function () {};
    if (!opts.ghToken) {
        log('::warning::SOURCE_GITHUB_TOKEN not set — verdict labels would not trigger workflows; skipping (a maintainer must label manually)');
        return { status: 'no-token' };
    }
    // `number` is spliced INSIDE the single-quoted pr-list jq program (the
    // sh's '"$NUMBER"' splice) — the one interpolation that cannot go
    // through shellQuote. A non-numeric value would break out of the shell
    // string at the argv level; fail loud instead of exec-weird (the sh
    // dies under bash -e on the same condition — the loud-fail contract).
    if (!/^\d+$/.test(String(opts.number))) {
        throw new Error('review verdict: NUMBER must be numeric, got: ' + opts.number);
    }
    return null;
}

// Verdict fallback sources beyond the run output (gh-305): a failed
// fetch leaves the file absent — the parser reports `missing`.
// Call order is load-bearing: labels → pr list → pr comments → issue
// comments → machineAuthor (.dmtools/config.js read) → parser selection.
function buildReviewContext(opts, io) {
    var q = shellQuote;
    var log = io.log || function () {};
    var repo = opts.repo;
    var number = opts.number;

    var labels = tryExec(io, 'gh issue view ' + q(number) + ' --repo ' + q(repo) +
        " --json labels --jq '" + LABELS_JQ + "'", '');
    var pr = unwrap(io.exec(
        'gh pr list --repo ' + q(repo) + ' --state open ' +
        "--json number,body,headRefName --jq '\n" +
        "      [.[] | select(\n" +
        // argv must carry DOUBLE backslashes exactly like the sh's
        // double-quoted jq program — real gh's jq treats a lone \s as an
        // invalid string escape and the compile error silently empties
        // find_linked_pr (caught by the sh-parity harness).
        '          ((.body // "") | test("(?i)\\\\b(closes|fixes|resolves)\\\\s+#' + number + '\\\\b"))\n' +
        '          or (.headRefName | test("^' + number + '[-_.]"))\n' +
        '          or (.headRefName | test("(^|[-_./])gh-0*' + number + '$")))\n' +
        "        | .number] | first // empty'")).trim();

    var prCommentsPath = io.tempFile('pr_comments.json');
    var issueCommentsPath = io.tempFile('issue_comments.json');
    if (pr) {
        var pc = tryExec(io, 'gh pr view ' + q(pr) + ' --repo ' + q(repo) +
            " --json comments,reviews --jq '" + PR_COMMENTS_JQ + "'", null);
        if (pc !== null) io.writeFile(prCommentsPath, pc);
    }
    var ic = tryExec(io, 'gh issue view ' + q(number) + ' --repo ' + q(repo) +
        " --json comments --jq '" + ISSUE_COMMENTS_JQ + "'", null);
    if (ic !== null) io.writeFile(issueCommentsPath, ic);

    var machineAuthor = resolveMachineAuthor(opts.machineAuthor, io);
    var verdictSh = pickVerdictSh(opts, io);

    return {
        log: log,
        repo: repo,
        number: number,
        labels: labels,
        pr: pr,
        prCommentsPath: prCommentsPath,
        issueCommentsPath: issueCommentsPath,
        machineAuthor: machineAuthor,
        verdictSh: verdictSh
    };
}

// The sh runs the probe as `eval "$(VERDICT_SH decide)"` — a failing
// substitution yields NO output (its rc is swallowed), the contract
// vars stay unset → decision=unknown → the loud diagnosis path. Keep
// that: probe failure is 'unknown', not a transport abort.
function verdictParserCommand(opts, ctx) {
    var q = shellQuote;
    return 'MAX_ROUNDS=' + q(String(opts.maxRounds === undefined ? '' : opts.maxRounds)) +
        ' PR_REVIEW_JSON=' + q('outputs/pr_review.json') +
        ' PR_REVIEW_JSON_ALT=' + q('outputs/gh-' + ctx.number + '/pr_review.json') +
        ' RUN_OUTPUT=' + q(opts.runOutput || DEFAULT_RUN_OUTPUT) +
        ' PR_COMMENTS_JSON=' + q(ctx.prCommentsPath) +
        ' ISSUE_COMMENTS_JSON=' + q(ctx.issueCommentsPath) +
        ' MACHINE_AUTHOR=' + q(ctx.machineAuthor) +
        ' ISSUE_LABELS=' + q(ctx.labels) +
        ' bash ' + q(ctx.verdictSh) + ' decide';
}

function probeVerdictContract(opts, io, ctx) {
    var probeOut = '';
    try {
        probeOut = unwrap(io.exec(verdictParserCommand(opts, ctx)));
    } catch (e) {
        probeOut = '';
    }
    var contract = parseVerdictContract(probeOut);
    return {
        contract: contract,
        decision: contract.decision || 'unknown'
    };
}

function logDecisionLine(log, probed) {
    var contract = probed.contract;
    log('→ review decision: ' + probed.decision + ' (source=' + (contract.source || 'none') +
        ', override=' + (contract.override || 'false') + ', rounds_done=' + contract.rounds_done + ')');
}

// ── label/comment primitives (were applyReviewVerdict closures) ─────────────

function stripRoundLabels(io, ctx) {
    var lbls = String(ctx.contract.round_labels || '').split(/\s+/);
    for (var i = 0; i < lbls.length; i++) {
        if (!lbls[i]) continue;
        tryExec(io, 'gh issue edit ' + shellQuote(ctx.number) + ' --repo ' + shellQuote(ctx.repo) +
            ' --remove-label ' + shellQuote(lbls[i]), '');
    }
}

function ensureLabel(io, ctx, name, color) {
    try { io.exec('gh label create ' + shellQuote(name) + ' --repo ' + shellQuote(ctx.repo) +
        ' --color ' + shellQuote(color) + ' --force'); } catch (e) { /* idempotent */ }
}

function addLabel(io, ctx, name) {
    io.exec('gh issue edit ' + shellQuote(ctx.number) + ' --repo ' + shellQuote(ctx.repo) +
        ' --add-label ' + shellQuote(name));
}

function removeNeedsHumanQuietly(io, ctx) {
    tryExec(io, 'gh issue edit ' + shellQuote(ctx.number) + ' --repo ' + shellQuote(ctx.repo) +
        " --remove-label 'needs-human'", '');
}

function postIssueComment(io, ctx, body) {
    var p = io.tempFile('comment.md');
    io.writeFile(p, body);
    io.exec('gh issue comment ' + shellQuote(ctx.number) + ' --repo ' + shellQuote(ctx.repo) +
        ' --body-file ' + shellQuote(p));
}

// ── pure comment bodies (byte-exact, pinned by the unit + parity suites) ────

function buildEscalationCommentBody(roundsDone, maxRounds, pr, threadSummary) {
    var lines = [
        '🛑 **Auto-rework loop capped** — ' + roundsDone + ' automatic rework rounds without an APPROVE verdict (cap: ' + (maxRounds === undefined ? '' : maxRounds) + '). The machine stopped labeling `agent:rework`.',
        ''
    ];
    if (pr) {
        lines.push('### Unresolved review threads on PR #' + pr, '');
        if (threadSummary) lines.push(threadSummary);
        lines.push('');
        lines.push('_If no threads are listed, the findings live in the PR general comments._');
    } else {
        lines.push('_No linked open PR found for this issue._');
    }
    lines.push('');
    lines.push('**Next step (human):** fix the remaining findings directly and re-label `agent:review` for a fresh review — or re-label `agent:rework` to re-arm the agent loop with a fresh round cap.');
    return lines.join('\n') + '\n';
}

function buildNoVerdictComment(diagnosis) {
    return [
        '🛑 **Review verdict missing** — the review leg finished, but no verdict (APPROVE / REQUEST_CHANGES / BLOCK) was found in any source, so the cycle cannot be labeled.',
        '',
        'Per-source diagnosis: `' + (diagnosis || 'n/a') + '`',
        '',
        "_Next step (human):_ read the review leg's run output, then label `pr_approved` (approve) or `agent:rework` (changes requested) — or re-run the review leg."
    ].join('\n') + '\n';
}

// ── one handler per verdict outcome ─────────────────────────────────────────

function applyEscalatedVerdict(opts, io, ctx) {
    var contract = ctx.contract;
    stripRoundLabels(io, ctx);
    ensureLabel(io, ctx, 'needs-human', 'B60205');
    addLabel(io, ctx, 'needs-human');
    var threadSummary = '';
    if (ctx.pr) {
        var owner = ctx.repo.split('/')[0];
        var name = ctx.repo.split('/')[1];
        var threadsPath = io.tempFile('threads.json');
        // the sh: `if gh api graphql …; then summary=$(render); else
        // warn; fi` — the renderer runs ONLY on fetch success and its
        // own failure aborts (unguarded under bash -e). Keep both.
        var gqlOk = true;
        try {
            io.writeFile(threadsPath, unwrap(io.exec(
                'gh api graphql -f query=' + shellQuote(THREADS_QUERY) +
                ' -f owner=' + shellQuote(owner) + ' -f name=' + shellQuote(name) +
                ' -F number=' + shellQuote(ctx.pr))));
        } catch (e) {
            gqlOk = false;
            ctx.log('::warning::reviewThreads fetch failed — the findings live in the PR review comments');
        }
        if (gqlOk) {
            // sh: summary="$(bash …)" — command substitution strips
            // ALL trailing newlines; the raw exec keeps them.
            threadSummary = unwrap(io.exec(
                'bash ' + shellQuote(ctx.verdictSh) + ' threads ' + shellQuote(threadsPath)))
                .replace(/\n+$/, '');
        }
    }
    postIssueComment(io, ctx, buildEscalationCommentBody(contract.rounds_done, opts.maxRounds, ctx.pr, threadSummary));
    ctx.log('→ labeled needs-human — auto-rework capped after ' + contract.rounds_done + ' round(s)');
    return { status: 'escalated', decision: ctx.decision, pr: ctx.pr, roundsDone: contract.rounds_done };
}

function applyPlainReworkVerdict(opts, io, ctx) {
    var nextRound = ctx.contract.next_round;
    // agent:rework FIRST (ordering is load-bearing: the round-label
    // event must not outrank the rework queue label), then the counter.
    removeNeedsHumanQuietly(io, ctx);
    stripRoundLabels(io, ctx);
    addLabel(io, ctx, 'agent:rework');
    ensureLabel(io, ctx, 'rework-round-' + nextRound, 'BFD4F2');
    addLabel(io, ctx, 'rework-round-' + nextRound);
    ctx.log('→ labeled agent:rework (round ' + nextRound + '/' + (opts.maxRounds === undefined ? '' : opts.maxRounds) + ') — rework run queued (re-review follows automatically)');
    return { status: 'rework', decision: ctx.decision, pr: ctx.pr, nextRound: nextRound };
}

function applyReworkVerdict(opts, io, ctx) {
    if (!ctx.contract.escalate) return applyPlainReworkVerdict(opts, io, ctx);
    return applyEscalatedVerdict(opts, io, ctx);
}

// gh-305: fail LOUDLY and leave a diagnosable marker (the sh exits 1).
function applyMissingVerdict(io, ctx) {
    ctx.log('::error::no verdict found in any source (pr_review.json / run output / PR comments / issue comments) — the review cycle cannot be labeled (gh-305)');
    ctx.log('→ diagnosis: ' + (ctx.contract.diagnosis || 'none'));
    ensureLabel(io, ctx, 'needs-human', 'B60205');
    addLabel(io, ctx, 'needs-human');
    postIssueComment(io, ctx, buildNoVerdictComment(ctx.contract.diagnosis));
    throw new Error('review verdict missing — needs-human left behind, the cycle is stranded (gh-305; the sh exits 1)');
}

// One rollup snapshot → 'green' | 'red' | 'pending' (empty lines skipped;
// any red conclusion refuses the whole verdict).
function assessRollup(states, pr, log) {
    if (!states) return 'pending';
    var arr = states.split('\n');
    var allGreen = true;
    for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (!s) continue;
        if (RED_CHECK_RE.test(s)) {
            log('::warning::PR #' + pr + ' checks FAILED — verdict not trusted, no label (a fresh dev/rework round must fix CI first)');
            return 'red';
        }
        if (!GREEN_CHECK_RE.test(s)) allGreen = false;
    }
    if (allGreen) {
        log('→ PR #' + pr + ' checks green');
        return 'green';
    }
    return 'pending';
}

function nowMs(io) {
    return (io.clock ? io.clock() : new Date()).getTime();
}

// Polls the rollup until green / red / the 10-min deadline. Returns the
// terminal result object, or null when the checks went green (the caller
// then labels pr_approved).
function waitForGreenChecks(io, ctx) {
    var deadline = nowMs(io) + CI_DEADLINE_MS;
    for (;;) {
        var states = tryExec(io, 'gh pr view ' + shellQuote(ctx.pr) + ' --repo ' + shellQuote(ctx.repo) +
            " --json statusCheckRollup --jq '" + ROLLUP_JQ + "'", '');
        var assessment = assessRollup(states, ctx.pr, ctx.log);
        if (assessment === 'red') return { status: 'ci-red', decision: ctx.decision, pr: ctx.pr };
        if (assessment === 'green') break;
        if (nowMs(io) >= deadline) {
            ctx.log('::warning::PR #' + ctx.pr + ' checks still pending after 10 min — skipping pr_approved (re-label or re-run to retry)');
            return { status: 'ci-timeout', decision: ctx.decision, pr: ctx.pr };
        }
        if (io.sleepMs) io.sleepMs(CI_POLL_MS);
    }
    return null;
}

function applyApproveVerdict(opts, io, ctx) {
    ctx.log('→ review verdict: approve');
    if (!ctx.pr) {
        ctx.log('::warning::APPROVE verdict but no linked open PR for #' + ctx.number + ' — skipping pr_approved');
        return { status: 'approve-no-pr', decision: ctx.decision };
    }
    ctx.log('→ linked PR #' + ctx.pr + ' — waiting for green checks (≤10 min)');
    var wait = waitForGreenChecks(io, ctx);
    if (wait) return wait;
    stripRoundLabels(io, ctx);
    removeNeedsHumanQuietly(io, ctx);
    addLabel(io, ctx, 'pr_approved');
    ctx.log('→ labeled pr_approved — merge-trigger will squash-merge PR #' + ctx.pr + ' once CLEAN');
    var kicked = kickSmOnGreenHead(opts, io, ctx.pr);
    return { status: 'approved', decision: ctx.decision, pr: ctx.pr, smKicked: kicked };
}

/**
 * Apply the review verdict. See the header for opts/io and the statuses:
 * no-token | rework | escalated | approved | approve-no-pr | ci-red |
 * ci-timeout; throws on the loud no-verdict path (exit-1 parity).
 */
function applyReviewVerdict(opts, io) {
    opts = opts || {};
    io = io || {};
    var blocked = entryGuard(opts, io);
    if (blocked) return blocked;
    var ctx = buildReviewContext(opts, io);
    var probed = probeVerdictContract(opts, io, ctx);
    ctx.contract = probed.contract;
    ctx.decision = probed.decision;
    logDecisionLine(ctx.log, probed);
    if (ctx.decision === 'rework') return applyReworkVerdict(opts, io, ctx);
    if (ctx.decision !== 'approve') return applyMissingVerdict(io, ctx);
    return applyApproveVerdict(opts, io, ctx);
}

// ── gh-1101: kick one SM tick on approval when the head is already green ──
// Live dart #435: approved at 14:04 on a head whose dispatched CI run had
// concluded green at 13:57 — the merge waited on cron. When the current
// head carries a completed-green dispatched CI run, order ONE SM tick now,
// deduped against an SM run already queued/in_progress (factory-sm-kicker
// sm-liveness parity). Best-effort: every probe failure means no kick.

var SM_LIVE_JQ = '[.[] | select(.status == "queued" or .status == "in_progress")] | length';
var GREEN_RUNS_JQ = '[.workflow_runs[] | select(.status == "completed" and .conclusion == "success")] | length';

function smKickEnabled(opts) {
    return String(opts.smKick === undefined ? 'true' : opts.smKick) !== 'false';
}

function execCount(io, cmd) {
    try { return parseInt(String(unwrap(io.exec(cmd))).trim(), 10) || 0; } catch (e) { return -1; }
}

function headShaOf(io, repo, pr) {
    try {
        return String(unwrap(io.exec('gh pr view ' + shellQuote(pr) + ' --repo ' + shellQuote(repo) +
            " --json headRefOid --jq '.headRefOid'"))).trim();
    } catch (e) { return ''; }
}

function headHasGreenRun(io, repo, ciWorkflow, sha) {
    return execCount(io, 'gh api ' + shellQuote('repos/' + repo + '/actions/workflows/' + ciWorkflow +
        '/runs?head_sha=' + sha + '&event=workflow_dispatch&per_page=5') +
        ' --jq ' + shellQuote(GREEN_RUNS_JQ)) > 0;
}

function smRunLive(io, repo, smWorkflow) {
    // -1 (probe failure) counts as live: never risk a duplicate tick.
    return execCount(io, 'gh run list --repo ' + shellQuote(repo) + ' --workflow ' +
        shellQuote(smWorkflow) + ' --limit 20 --json status --jq ' + shellQuote(SM_LIVE_JQ)) !== 0;
}

function greenHeadSha(opts, io, pr) {
    var sha = headShaOf(io, opts.repo, pr);
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return '';
    return headHasGreenRun(io, opts.repo, opts.ciWorkflow || 'quality.yml', sha) ? sha : '';
}

function dispatchSmTick(io, repo, smWorkflow, log) {
    try {
        io.exec('gh workflow run ' + shellQuote(smWorkflow) + ' --repo ' + shellQuote(repo));
        return true;
    } catch (e) {
        log('::warning::SM tick dispatch failed: ' + (e && e.message || e));
        return false;
    }
}

function kickSmOnGreenHead(opts, io, pr) {
    if (!smKickEnabled(opts)) return false;
    var log = io.log || function () {};
    var sha = greenHeadSha(opts, io, pr);
    if (!sha) return false;
    var smWorkflow = opts.smWorkflow || 'machine-sm.yml';
    if (smRunLive(io, opts.repo, smWorkflow)) {
        log('→ head ' + sha.slice(0, 8) + ' already green; SM tick already queued/running — no kick');
        return false;
    }
    if (!dispatchSmTick(io, opts.repo, smWorkflow, log)) return false;
    log('→ head ' + sha.slice(0, 8) + ' already green — dispatched one SM tick (' + smWorkflow + ') to merge now');
    return true;
}

module.exports = {
    applyReviewVerdict: applyReviewVerdict,
    kickSmOnGreenHead: kickSmOnGreenHead,
    DEFAULT_RUN_OUTPUT: DEFAULT_RUN_OUTPUT,
    parseVerdictContract: parseVerdictContract,
    resolveMachineAuthor: resolveMachineAuthor,
    pickVerdictSh: pickVerdictSh,
    unwrap: unwrap,
    entryGuard: entryGuard,
    tryExec: tryExec,
    buildReviewContext: buildReviewContext,
    verdictParserCommand: verdictParserCommand,
    probeVerdictContract: probeVerdictContract,
    logDecisionLine: logDecisionLine,
    stripRoundLabels: stripRoundLabels,
    ensureLabel: ensureLabel,
    addLabel: addLabel,
    removeNeedsHumanQuietly: removeNeedsHumanQuietly,
    postIssueComment: postIssueComment,
    buildEscalationCommentBody: buildEscalationCommentBody,
    buildNoVerdictComment: buildNoVerdictComment,
    applyReworkVerdict: applyReworkVerdict,
    applyEscalatedVerdict: applyEscalatedVerdict,
    applyPlainReworkVerdict: applyPlainReworkVerdict,
    applyMissingVerdict: applyMissingVerdict,
    applyApproveVerdict: applyApproveVerdict,
    assessRollup: assessRollup,
    waitForGreenChecks: waitForGreenChecks,
    nowMs: nowMs
};
