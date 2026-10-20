/**
 * Pre-CLI Rework Setup Action (preCliJSAction for pr_rework agent)
 * 1. Finds the existing PR for the ticket
 * 2. Checks out the PR branch
 * 3. Merges origin/{baseBranch} into the PR branch (auto-update, before setup commands run —
 *    see the comment above the detectMergeConflicts() call for why the order matters)
 * 4. Runs project-specific setup commands (build/verify) against the now-updated branch
 * 5. Writes input folder: pr_info.md, pr_diff.txt, pr_discussions.md, pr_discussions_raw.json
 *    plus the pinned gh-799 input contract: pr_discussions_raw.json (even with 0 threads),
 *    ci_failures.md (even with 0 failed checks) and review_state.md (review verdicts +
 *    decision state) — the complete open-item picture regardless of which armer fired.
 * 6. Fetches question subtasks with answers (extra context)
 * 7. Posts "Rework Started" comment to the ticket (Jira/ADO/GitHub via common/trackers.js),
 *    rendered in the ticket's markup flavor (Markdown on GitHub, wiki on Jira — gh-770)
 */

var configLoader = require('./configLoader.js');
var trackersModule = require('./common/trackers.js');
var commentMarkup = require('./common/commentMarkup.js');
const gh = require('./common/githubHelpers.js');
const gitOps = require('./common/gitOps.js');
var forkCheckout = require('./common/forkCheckout.js');
const { resolveStatuses } = require('./config.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
const fetchParentContextToInput = require('./fetchParentContextToInput.js');
var restoreFromReleases = require('./restoreFromReleases.js');
var setupCommands = require('./common/setupCommands.js');
var baseBranchMarker = require('./common/baseBranchMarker.js');

/**
 * Optionally syncs the PR's base branch with its own upstream (config.git.baseBranch)
 * before merge-conflict detection runs. Relevant in two-branch mode, where the PR's base is
 * a long-lived branch (e.g. "release/rc_*") that can drift stale relative to
 * config.git.baseBranch over time. Delegates to a project-specific hook
 * (customParams.branchSyncFnPath) because syncing may require bypassing branch-protection
 * rules that block direct pushes to that branch — same rationale as
 * customParams.branchCreateFnPath in checkoutBranch.js.
 *
 * No-op when branchSyncFnPath isn't configured, or when the PR's base already IS
 * config.git.baseBranch (nothing to sync). Failures are logged and swallowed — the sync is
 * a best-effort freshness step, not a hard prerequisite for the rest of the rework flow.
 *
 * @param {string} baseBranch    - the PR's base branch (prDetails.base.ref)
 * @param {Object} customParams  - agent customParams (may contain branchSyncFnPath)
 * @param {Object} config        - resolved project config (config.git.baseBranch, workingDir)
 */
function syncBaseBranchIfConfigured(baseBranch, customParams, config) {
    if (!customParams || !customParams.branchSyncFnPath || !baseBranch || baseBranch === config.git.baseBranch) {
        return;
    }
    var branchSyncFn = configLoader.loadHookFn(customParams.branchSyncFnPath, 'branchSyncFnPath');
    if (!branchSyncFn) {
        return;
    }
    try {
        console.log('Syncing base branch', baseBranch, 'via', customParams.branchSyncFnPath);
        branchSyncFn({
            branchName: baseBranch,
            targetBranch: config.git.baseBranch,
            workingDir: config.workingDir,
            config: config
        });
        cli_execute_command({ command: gh.buildOriginFetchCommand() });
    } catch (e) {
        console.warn('branchSyncFnPath failed (non-fatal):', e && e.toString ? e.toString() : String(e));
    }
}

// Defensive cap on Jira/tracker comment length for any failSetup() caller. The
// setupCommands module already truncates its own embedded command output at the
// source (see truncateSetupError), but other failure messages here (e.g. branch
// checkout errors) could still, in principle, be arbitrarily long — Jira rejects
// comments over ~350000 characters, and previously that rejection was silently
// swallowed, leaving the ticket with no visible failure reason at all.
var truncateForComment = setupCommands.truncateSetupError;

/**
 * Build the "Automated Rework Started" comment in the flavor of the ticket's
 * tracker (gh-770). The template historically hard-coded Jira wiki markup
 * (h3., {panel:bgColor=...}, {code}), which renders as raw text garbage on
 * GitHub issues; the flavor comes from common/commentMarkup.js so the same
 * script renders Markdown on GitHub and wiki on Jira.
 *
 * @param {Object} flavor - a commentMarkup flavor bag (forTicket/forFlavor)
 * @param {Object} ctx    - { prNumber, prUrl, branchName, conflictFiles, failedChecks }
 * @returns {string} the rendered comment
 */
function buildReworkStartedComment(flavor, ctx) {
    var m = flavor;
    var comment = m.h(3, '🔧 Automated Rework Started') + '\n\n' +
        m.bold('Pull Request') + ': ' + m.link('PR #' + ctx.prNumber, ctx.prUrl) + '\n' +
        m.bold('Branch') + ': ' + m.inline(ctx.branchName) + '\n\n';

    var conflicts = ctx.conflictFiles || [];
    if (conflicts.length > 0) {
        comment += m.panel(null,
            '⚠️ ' + m.bold('Merge conflicts detected') + ' — ' + conflicts.length +
                ' file(s) must be resolved before rework can be applied:\n' +
            conflicts.map(function (f) { return '* ' + m.inline(f); }).join('\n'),
            'bgColor=#FFEBE6|borderColor=#DE350B') + '\n\n';
    }

    var checks = ctx.failedChecks || [];
    if (checks.length > 0) {
        comment += m.panel(null,
            '⚠️ ' + m.bold('CI checks failing') + ' — ' + checks.length + ' check(s) must pass before merge:\n' +
            checks.map(function (c) { return '* ' + m.inline(c.name); }).join('\n') +
            '\nError logs: ' + m.inline('ci_failures.md') + ' (summary) and ' + m.inline('ci_failures_full.log') + ' (full logs).',
            'bgColor=#FFEBE6|borderColor=#DE350B') + '\n\n';
    }

    comment += 'AI Teammate is fixing issues raised in the code review.\n\n' +
        m.italic('Fix results will be posted shortly...');
    return comment;
}

// ── gh-799: pinned input contract — armer-independent rework picture ─────────
// Whatever arms the leg (fail-validation CI-red, review-threads-resolved
// armer, conflict-rework, manual dispatch), the input folder must ALWAYS carry
// the complete open-item picture:
//   1. pr_discussions_raw.json — unresolved threads WITH ids (a {"threads": []}
//      placeholder when the PR currently has zero threads — the shared
//      fetchDiscussions only produces data when threads exist);
//   2. ci_failures.md — failed checks, or an explicit "nothing failed" contract
//      file when every check is green or the probe failed;
//   3. review_state.md — the review verdict(s) + decision state
//      (CHANGES_REQUESTED / APPROVED / NONE), so the agent sees WHAT the
//      reviewer decided, not just raw threads.
// ensureInputContextContract() pins the trio; an armer path that skips one is
// a regression (fixture-tested per armer shape).

var CI_NO_FAILURES_MD = [
    '# CI Checks — No Failed Checks',
    '',
    'All CI checks passed on the rework head (or no check reported a failure).',
    '',
    '- `ci_failures_full.log` will not exist when nothing failed.',
    '- If CI was expected to be red, re-check the PR checks page — this file was',
    '  written once by rework setup at leg start.'
].join('\n');

var NO_THREADS_RAW_JSON = JSON.stringify({ threads: [] }, null, 2);

/**
 * True when the input file exists with non-blank content. Used to avoid
 * clobbering real data (written by detectFailedChecks / writePRContext) with
 * contract placeholders.
 */
function inputContextFileExists(path) {
    try {
        var content = file_read({ path: path });
        return !!(content && String(content).trim());
    } catch (e) {
        return false;
    }
}

/**
 * First line of a text as a bounded excerpt — review bodies and thread bodies
 * can be arbitrarily long; review_state.md is a summary, not a dump.
 */
function firstLineExcerpt(text, maxLen) {
    var line = String(text || '').split('\n')[0].trim();
    var limit = maxLen || 200;
    if (line.length > limit) line = line.substring(0, limit - 3) + '...';
    return line;
}

/**
 * Latest CONCLUDED review (CHANGES_REQUESTED / APPROVED), oldest first sort,
 * last one wins — same verdict semantics as pushReworkChanges.
 * Returns null when there is no concluded review.
 */
function latestConcludedReview(reviews) {
    var concluded = (reviews || []).filter(function(r) {
        return r && (r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED');
    });
    concluded.sort(function(a, b) {
        return String(a.submitted_at || '') < String(b.submitted_at || '') ? -1 : 1;
    });
    return concluded.length > 0 ? concluded[concluded.length - 1] : null;
}

/**
 * gh-957 context parity: state the SAME GraphQL reviewThreads census the
 * SM arm rule counts (the inventory is GraphQL-sourced now, so the two can
 * never silently disagree again). When the census differs from the
 * actionable list, the delta is exclusion accounting — say so. Returns null
 * when no census is available.
 */
function buildCensusNote(census, openCount) {
    if (!census || typeof census.graphqlUnresolved !== 'number') return null;
    if (census.graphqlUnresolved === openCount) {
        return '> ℹ️ Arm-rule census: the SM armer counts the SAME ' + census.graphqlUnresolved +
            ' unresolved review thread(s) via GraphQL reviewThreads (gh-957 — one source of truth).';
    }
    return '> ℹ️ Arm-rule census (gh-957): the SM armer counts ' + census.graphqlUnresolved +
        ' unresolved review thread(s) via GraphQL reviewThreads; the actionable list below is ' +
        openCount + ' — the delta is machine-notice/bot threads (excluded above, never reply targets).';
}

/**
 * The reviewer login of a concluded review: user.login (GitHub export) or
 * author.login/name (other exports) — 'unknown' when unnamed.
 */
function reviewAuthorOf(latest) {
    if (latest.user && latest.user.login) return latest.user.login;
    if (latest.author && (latest.author.login || latest.author.name)) {
        return latest.author.login || latest.author.name;
    }
    return 'unknown';
}

/**
 * The reviewer-verdict lines: the latest concluded decision (state, reviewer,
 * submission date, first-line summary) or the honest 'no concluded review'
 * note. Returns [] when the provider exposes no review support at all.
 */
function renderVerdictLines(reviews) {
    if (reviews === null) {
        return ['> Review verdicts are not available from this SCM provider — rely on the open threads below.', ''];
    }
    var latest = latestConcludedReview(reviews);
    var lines = ['**Review decision: `' + (latest ? latest.state : 'NONE') + '`**', ''];
    if (!latest) {
        lines.push('No concluded review (CHANGES_REQUESTED/APPROVED) exists yet.');
        lines.push('');
        return lines;
    }
    lines.push('Latest concluded review:');
    lines.push('');
    lines.push('- **State**: ' + latest.state);
    lines.push('- **Reviewer**: ' + reviewAuthorOf(latest));
    lines.push('- **Submitted**: ' + (latest.submitted_at || 'unknown'));
    var summary = firstLineExcerpt(latest.body);
    if (summary) lines.push('- **Summary**: ' + summary);
    lines.push('');
    return lines;
}

/**
 * One actionable open-thread bullet: id (threadId, else comment#rootId,
 * else no-id), the path:line location, and a bounded first-line excerpt.
 */
function renderOpenThreadLine(t) {
    var id = t.threadId ||
        (t.rootCommentId !== null && t.rootCommentId !== undefined ? 'comment#' + t.rootCommentId : 'no-id');
    var loc = t.path ? (t.path + (t.line ? ':' + t.line : '')) : '';
    var excerpt = firstLineExcerpt(t.body, 160);
    return '- `' + id + '`' + (loc ? ' — `' + loc + '`' : '') + (excerpt ? ' — "' + excerpt + '"' : '');
}

/**
 * The actionable open-thread bullet list — one line per thread.
 */
function renderOpenThreadLines(openThreads) {
    var lines = ['Each open thread below is blocking reviewer feedback — fix it and reply via `outputs/review_replies.json`:', ''];
    (openThreads || []).forEach(function(t) {
        lines.push(renderOpenThreadLine(t));
    });
    lines.push('');
    return lines;
}

/**
 * Builds review_state.md — the reviewer-verdict context for the rework agent:
 * the latest concluded review decision, who asked for what, and the open
 * thread inventory with ids. Providers without review support (no
 * listReviews) and probe failures degrade to an honest "not available" note —
 * the file is still written (the contract is non-optional), never fatal.
 */
function buildReviewStateMd(scm, prNumber, discussionData) {
    var lines = [];
    lines.push('# Review State — Reviewer Verdict Context');
    lines.push('');
    lines.push('What the reviewer decided on this PR and which threads are still open.');
    lines.push('Decision values: `CHANGES_REQUESTED` (blocking — reviewer asked for changes), `APPROVED`, or `NONE` (no concluded review yet).');
    lines.push('');

    var reviews = null;
    if (scm && typeof scm.listReviews === 'function') {
        try {
            reviews = scm.listReviews(String(prNumber)) || [];
        } catch (e) {
            console.warn('review_state: listReviews probe failed (non-fatal):', e.message || e);
            reviews = null;
        }
    }

    renderVerdictLines(reviews).forEach(function(l) { lines.push(l); });

    var rawThreads = (discussionData && discussionData.rawThreads && discussionData.rawThreads.threads) || [];
    var census = (discussionData && discussionData.rawThreads && discussionData.rawThreads.census) || null;
    var openThreads = rawThreads.filter(function(t) {
        return !!t && t.resolved !== true && t.bot !== true;
    });
    lines.push('**Open review threads at rework start: ' + openThreads.length + '**');
    var censusNote = buildCensusNote(census, openThreads.length);
    if (censusNote) {
        lines.push('');
        lines.push(censusNote);
        lines.push('');
    }
    lines.push('');
    if (openThreads.length > 0) {
        renderOpenThreadLines(openThreads).forEach(function(l) { lines.push(l); });
    }
    if (reviews !== null && latestConcludedReview(reviews) &&
        latestConcludedReview(reviews).state === 'CHANGES_REQUESTED') {
        lines.push('⚠️ The reviewer **requires changes** before this PR can merge — treat every open thread as blocking.');
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * gh-799 AC1: enforces the pinned input trio. Writes ONLY what is missing —
 * real thread data and real failure logs (written by writePRContext /
 * detectFailedChecks) are never clobbered; review_state.md is refreshed every
 * leg because the verdict can move between legs. Non-fatal by contract: the
 * caller wraps it in try/catch so a placeholder write failure never kills the
 * leg (the leg can still run on whatever picture it has).
 *
 * @returns {string[]} the files this call wrote
 */
function ensureInputContextContract(inputFolder, scm, prNumber, discussionData, failedChecks) {
    var written = [];
    var rawThreads = discussionData && discussionData.rawThreads;
    var hasThreadData = !!(rawThreads && rawThreads.threads && rawThreads.threads.length > 0);
    if (!hasThreadData && !inputContextFileExists(inputFolder + '/pr_discussions_raw.json')) {
        gitOps.writeInputFile(
            inputFolder + '/pr_discussions_raw.json',
            NO_THREADS_RAW_JSON,
            'pr_discussions_raw.json (contract placeholder — 0 threads at leg start)'
        );
        written.push('pr_discussions_raw.json');
    }

    var hasFailures = !!(failedChecks && failedChecks.length > 0);
    if (!hasFailures && !inputContextFileExists(inputFolder + '/ci_failures.md')) {
        gitOps.writeInputFile(
            inputFolder + '/ci_failures.md',
            CI_NO_FAILURES_MD,
            'ci_failures.md (contract placeholder — 0 failed checks at leg start)'
        );
        written.push('ci_failures.md');
    }

    gitOps.writeInputFile(
        inputFolder + '/review_state.md',
        buildReviewStateMd(scm, prNumber, discussionData),
        'review_state.md (review verdict + open threads)'
    );
    written.push('review_state.md');

    if (written.length > 0) {
        console.log('✅ Input contract (gh-799): ensured ' + written.join(', '));
    }
    return written;
}

function failSetup(tracker, ticketKey, inputFolder, message, customParams) {
    try {
        file_write({
            path: inputFolder + '/rework_setup_failed.md',
            content: '# Rework Setup Failed\n\n' + message + '\n'
        });
    } catch (e) {
        console.warn('Failed to write rework setup failure marker:', e);
    }
    try {
        var m = commentMarkup.forTicket(ticketKey, customParams);
        tracker.postComment(
            ticketKey,
            m.h(3, '❌ Rework Setup Failed') + '\n\n' + truncateForComment(message)
        );
    } catch (e) {
        // PR-anchored reworks (#544): a 'pr-N' key parses to no tracker
        // ticket — the comment is best-effort, the failure marker file is
        // the source of truth.
        console.error('Failed to post rework setup failure comment to ' + ticketKey + ':', e && e.toString ? e.toString() : String(e));
    }
    throw new Error(message);
}

/**
 * Which params bag carries the input folder: the flat params when they have
 * one, otherwise jobParams (the real Teammate execution path), otherwise the
 * params as-is.
 * (gh-1002) Pure parse* helper extracted from action().
 */
function resolveActualParams(params) {
    return params.inputFolderPath ? params : (params.jobParams || params);
}

/**
 * The PR anchor for this rework run: a `pr-N` input folder IS the anchor
 * (#544), otherwise jobParams.prNumber / jobParams.pr when parseable.
 * (gh-1002) Pure parse* helper extracted from action().
 *
 * @param {string} ticketKey - input folder basename (the context id)
 * @param {Object} params    - workflow params
 * @returns {(number|null)}
 */
function parsePrAnchor(ticketKey, params) {
    var anchorMatch = /^pr-(\d+)$/.exec(String(ticketKey || ''));
    var jp0 = params.jobParams || params;
    return (anchorMatch ? parseInt(anchorMatch[1], 10) : null) ||
        (parseInt(jp0.prNumber || jp0.pr || '', 10) || null);
}

/**
 * Parse the incoming params into the rework anchor context: which params bag
 * carries the input folder, the derived ticket key, and the PR anchor.
 * PR-anchored rework (#544): a `pr-N` contextId makes the PR itself the
 * anchor — the labeled PR has no local issue (guest/issue-less PR the owner
 * labeled agent:rework). The PR number is taken directly, no
 * findPRForTicket body/branch scrape; tracker status moves and ticket
 * comments are skipped (a 'pr-N' key parses to no GitHub issue — comments
 * would throw).
 * (gh-1002) Pure parse* helper extracted from action().
 *
 * @param {Object} params - workflow params (jobParams shape or flat)
 * @returns {{actualParams: Object, inputFolder: string, ticketKey: string, prAnchor: (number|null)}}
 */
function parseReworkParams(params) {
    var actualParams = resolveActualParams(params);
    var inputFolder = actualParams.inputFolderPath;
    var ticketKey = inputFolder.split('/').pop();
    return {
        actualParams: actualParams,
        inputFolder: inputFolder,
        ticketKey: ticketKey,
        prAnchor: parsePrAnchor(ticketKey, params)
    };
}

/**
 * Resolve the repository (owner/repo) for the rework — prefer targetRepository
 * from config over the git remote.
 * (gh-1002) decide* helper extracted from action() Step 1.
 *
 * @param {Object} config - resolved project config
 * @param {Object} scm    - SCM client (configLoader.createScm result)
 * @returns {{owner: string, repo: string}|null}
 */
function resolveRepoInfo(config, scm) {
    if (config.repository && config.repository.owner && config.repository.repo) {
        var pinned = { owner: config.repository.owner, repo: config.repository.repo };
        console.log('Using targetRepository from config:', pinned.owner + '/' + pinned.repo);
        return pinned;
    }
    return scm.getRemoteRepoInfo();
}

/**
 * Best-effort tracker comment for the repo-resolution failure. Optional
 * helper — comment failures are swallowed (the {success:false} result is the
 * real signal).
 * (gh-1002) Extracted from action() Step 1.
 */
function postRepoResolutionFailure(tracker, ticketKey, customParams, err) {
    try {
        var mRepoFail = commentMarkup.forTicket(ticketKey, customParams);
        tracker.postComment(ticketKey, mRepoFail.h(3, '❌ Rework Setup Failed') + '\n\n' + err);
    } catch (e) {}
}

/**
 * Decide which PR anchors this rework run: an explicit pr-N anchor wins (the
 * anchor IS the PR, #544), otherwise the PR is looked up from the ticket key.
 * (gh-1002) decide* helper extracted from action() Step 2.
 *
 * @param {(number|null)} prAnchor - PR number parsed from the input folder name, or null
 * @param {Object} scm        - SCM client
 * @param {Object} config     - resolved project config (may pin config.prSearchFn)
 * @param {string} ticketKey  - ticket key (used only when there is no anchor)
 * @returns {Object|null} PR (or PR-like) object with a number
 */
function findPrForRework(prAnchor, scm, config, ticketKey) {
    if (prAnchor) {
        console.log('PR-anchored rework: PR #' + prAnchor + ' (no ticket lookup, #544)');
        return { number: prAnchor };
    }
    var prSearchOptions = config.prSearchFn ? { prSearchFn: config.prSearchFn } : {};
    return gh.findPRForTicket(scm, ticketKey, prSearchOptions);
}

/**
 * Mark the ticket actively-worked with the ACTUAL rework-phase status
 * (gh-802 AC3b): a rework leg used to write statuses.IN_DEVELOPMENT — the
 * stale dev-phase status — so the board showed the card back in Development
 * while rework (post-review fixes) was actually running. Opt-in
 * (config.jira.markReworkInDevelopment); skipped for PR-anchored runs, which
 * have no ticket. A failed transition is logged with its content, not thrown.
 * (gh-1002) Side-effecting step helper extracted from action().
 */
function moveTicketToReworkStatus(config, tracker, ticketKey, statuses, prAnchor) {
    if (config.jira && config.jira.markReworkInDevelopment && !prAnchor) {
        try {
            tracker.moveToStatus(ticketKey, statuses.IN_REWORK);
            console.log('Moved ' + ticketKey + ' to ' + statuses.IN_REWORK);
        } catch (e) {
            // Log the error CONTENT — the host console renders a raw Error
            // object as "{}" (same log-hygiene rule as AC3c; matches the
            // e.message || String(e) pattern used elsewhere in this file).
            console.warn('Failed to move ticket to ' + statuses.IN_REWORK + ':', e && e.message ? e.message : String(e));
        }
    }
}

/**
 * Check out the rework branch; a checkout error fails the setup (failSetup
 * writes the marker + posts the comment, then throws).
 * (gh-1002) Side-effecting step helper extracted from action() Step 4.
 */
function checkoutReworkBranch(branchName, config, inputFolder, tracker, ticketKey, customParams, pullRef) {
    try {
        gitOps.checkoutPRBranch(branchName, config.workingDir, config.git.baseBranch, pullRef);
    } catch (e) {
        failSetup(tracker, ticketKey, inputFolder, 'Failed to checkout branch: ' + e.toString(), customParams);
    }
}

/**
 * Run project-specific prerequisite/setup commands (e.g. install JDK/Maven,
 * verify build credentials) before the CLI agent starts fixing code.
 * Non-fatal setup command failures land in setup_warnings.md; a hard setup
 * error fails the setup (failSetup throws).
 * (gh-1002) Side-effecting step helper extracted from action() Step 4.6.
 */
function runSetupCommandsStep(customParams, config, inputFolder, tracker, ticketKey) {
    try {
        var setupResult = setupCommands.runSetupCommands(customParams, config.workingDir);
        var setupWarnings = setupCommands.buildSetupWarningsMarkdown(setupResult);
        if (setupWarnings) {
            try {
                file_write({ path: inputFolder + '/setup_warnings.md', content: setupWarnings });
                console.log('⚠️ Wrote setup_warnings.md (non-fatal setup command failure(s))');
            } catch (writeErr) {
                console.warn('Failed to write setup_warnings.md:', writeErr);
            }
        }
    } catch (e) {
        failSetup(tracker, ticketKey, inputFolder, 'Environment setup failed: ' + (e && e.toString ? e.toString() : String(e)), customParams);
    }
}

/**
 * Remember the head this pass starts from, so pushReworkChanges can tell a
 * real fix from a pass that only left housekeeping (outputs/, WIP auto-saves)
 * behind. Optional helper — a write failure leaves the no-fix guard off.
 * (gh-1002) Side-effecting step helper extracted from action().
 */
function writeReworkBaseHead(inputFolder, headSha) {
    try {
        if (headSha) file_write({ path: inputFolder + '/rework_base_head.txt', content: String(headSha) });
    } catch (e) {
        console.warn('Could not write rework_base_head.txt (no-fix guard stays off):', e.message || e);
    }
}

/**
 * Post the "Automated Rework Started" tracker comment, rendered in the flavor
 * of the ticket's tracker (gh-770): Markdown on GitHub issues, wiki markup on
 * Jira. Optional helper — comment failures are logged and swallowed.
 * (gh-1002) Extracted from action() Step 8.
 */
function postReworkStartedCommentStep(tracker, ticketKey, customParams, ctx) {
    try {
        tracker.postComment(ticketKey, buildReworkStartedComment(
            commentMarkup.forTicket(ticketKey, customParams),
            ctx
        ));
    } catch (e) {
        console.warn('Failed to post tracker comment:', e);
    }
}

/**
 * The ticket key an action()-level error should be reported to: derived from
 * inputFolderPath (flat params or jobParams), '' when none is derivable.
 * (gh-1002) Extracted from reportActionError().
 */
function errorTicketKeyOf(params) {
    return (params.inputFolderPath ||
        (params.jobParams && params.jobParams.inputFolderPath) || '').split('/').pop();
}

/**
 * Tracker for the error comment: reuse the probed tracker when there is one,
 * otherwise build one from the params. Returns null when creation fails.
 * (gh-1002) Extracted from reportActionError().
 */
function createErrorTracker(params, tracker) {
    var errorTracker = (typeof tracker !== 'undefined' && tracker) ? tracker : null;
    if (!errorTracker) {
        try {
            errorTracker = trackersModule.createTracker(
                configLoader.loadProjectConfig(configLoader.paramsForConfigLoad(params)),
                (params.jobParams && params.jobParams.customParams) || params.customParams);
        } catch (trackerError) {
            console.error('Failed to create tracker for error comment:', trackerError);
        }
    }
    return errorTracker;
}

/**
 * Post the "❌ Rework Setup Error" comment, in the flavor of the ticket's
 * tracker (gh-770): Markdown on GitHub issues, wiki markup on Jira.
 * (gh-1002) Extracted from reportActionError().
 */
function postErrorComment(errorTracker, ticketKey, error, params) {
    var errorCustomParams = (params.jobParams && params.jobParams.customParams) || params.customParams;
    var em = commentMarkup.forTicket(ticketKey, errorCustomParams);
    errorTracker.postComment(
        ticketKey,
        em.h(3, '❌ Rework Setup Error') + '\n\n' + em.code(truncateForComment(error.toString()))
    );
}

/**
 * Report an action()-level failure to the tracker as a "❌ Rework Setup
 * Error" comment. Optional helper — every failure mode (no ticket key,
 * tracker creation, the comment itself) is logged and swallowed.
 * (gh-1002) Extracted from the action() catch block.
 */
function reportActionError(params, tracker, error) {
    try {
        const ticketKey = errorTicketKeyOf(params);
        if (ticketKey) {
            // Post the error to the ticket via the probed tracker provider
            var errorTracker = createErrorTracker(params, tracker);
            if (errorTracker) {
                postErrorComment(errorTracker, ticketKey, error, params);
            }
        }
    } catch (e) {
        console.error('Failed to post rework setup error comment:', e && e.toString ? e.toString() : String(e));
    }
}

function action(params) {
    try {
        var parsed = parseReworkParams(params);
        var actualParams = parsed.actualParams;
        var inputFolder = parsed.inputFolder;
        var ticketKey = parsed.ticketKey;
        var prAnchor = parsed.prAnchor;
        // paramsForConfigLoad re-attaches params.ticket (sibling of jobParams in the
        // real Teammate execution path) so baseBranchResolverFnPath can key off the
        // ticket's fixVersion — see configLoader.js for details.
        var config = configLoader.loadProjectConfig(configLoader.paramsForConfigLoad(params));
        var customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
        var scm = configLoader.createScm(config);
        var statuses = resolveStatuses(customParams, config.jira && config.jira.statuses);
        // Probe the tracker provider once — the same script then runs unchanged
        // on Jira / ADO / GitHub deployments.
        var tracker = trackersModule.createTracker(config, customParams);

        // Restore configured artefacts (e.g. cosmo test reports) from GitHub Release — non-fatal
        try { restoreFromReleases.action(params); } catch (e) { console.warn('⚠️ restoreFromReleases failed (non-fatal):', e); }

        console.log('=== Rework setup for:', ticketKey, '===');

        // Mark the ticket actively-worked with the ACTUAL rework-phase status
        // (gh-802 AC3b) — see moveTicketToReworkStatus() for the full rationale.
        moveTicketToReworkStatus(config, tracker, ticketKey, statuses, prAnchor);

        // Step 1: GitHub repo info — prefer targetRepository from config over git remote
        var repoInfo = resolveRepoInfo(config, scm);
        if (!repoInfo) {
            const err = 'Could not determine GitHub repository from git remote';
            postRepoResolutionFailure(tracker, ticketKey, customParams, err);
            return { success: false, error: err };
        }

        // Step 2: Find existing PR — PR-anchored (#544): the anchor IS the PR.
        var pr = findPrForRework(prAnchor, scm, config, ticketKey);
        if (!pr) {
            failSetup(
                tracker,
                ticketKey,
                inputFolder,
                'No Pull Request found for ticket ' + ticketKey + '. Cannot start rework without an existing PR.',
                customParams
            );
        }

        // Step 3: PR details
        const prDetails = gh.getPRDetails(scm, pr.number);
        if (!prDetails) {
            failSetup(tracker, ticketKey, inputFolder, 'Failed to fetch PR details for PR #' + pr.number, customParams);
        }

        // Step 4: Checkout PR branch
        const branchName = prDetails.head ? prDetails.head.ref : null;
        if (!branchName) {
            failSetup(tracker, ticketKey, inputFolder, 'Could not determine branch from PR details', customParams);
        }
        checkoutReworkBranch(branchName, config, inputFolder, tracker, ticketKey, customParams,
            forkCheckout.resolvePullRef(forkCheckout.prPullRef(prDetails), forkCheckout.envCheckoutRef()));

        const baseBranch = prDetails.base ? prDetails.base.ref : config.git.baseBranch;

        // Persist the PR's real base branch to outputs/pr_base_branch.txt so that
        // quality-gate shell commands (static strings in the job's JSON config, unable
        // to reference config.git.baseBranch at runtime) can read the actual target
        // branch instead of relying on a hardcoded literal like "origin/master" — see
        // js/common/baseBranchMarker.js docblock for the full rationale.
        baseBranchMarker.writeBaseBranchMarker(baseBranch);

        // Step 4.4: Optionally sync the PR's base branch with its own upstream — see
        // syncBaseBranchIfConfigured() docblock for the rationale.
        syncBaseBranchIfConfigured(baseBranch, customParams, config);

        // Step 4.5: Merge base branch and detect conflicts.
        // Always merges origin/{baseBranch} so the branch stays up to date.
        // If conflicts exist, writes merge_conflicts.md to the input folder.
        //
        // This MUST run before Step 4.6 (setup commands): setupCommands typically builds
        // and tests the repo (e.g. `mvn clean verify`), and the PR branch itself can be
        // arbitrarily stale relative to baseBranch — including fixes to the very tests
        // setupCommands runs (a flaky/broken test fixed on baseBranch stays broken on any
        // PR branch forked before that fix, until the PR branch is brought up to date).
        // Running the merge first means setup commands validate the code the CLI agent is
        // about to work on top of (merged, even if only staged/uncommitted), not a stale
        // pre-merge snapshot — this is the "auto-update the branch on every rework run"
        // behavior that should hold out of the box, not depend on someone remembering to
        // rebase the PR branch manually.
        const conflictFiles = gitOps.detectMergeConflicts(baseBranch, inputFolder, config.workingDir);

        // Step 4.6: Run project-specific prerequisite/setup commands (e.g. install
        // JDK/Maven, verify build credentials) before the CLI agent starts fixing code.
        runSetupCommandsStep(customParams, config, inputFolder, tracker, ticketKey);

        // Step 4.7: Detect failed CI checks — writes ci_failures.md if any failed.
        // gh-1119: the PR diff is fetched FIRST and handed to detectFailedChecks,
        // which tags every extracted gate violation owned/foreign against the
        // diff file list (the #433 rework leg missed an owned violation because
        // it was buried in the raw tails — now it opens ci_failures.md).
        const headSha = prDetails.head ? prDetails.head.sha : null;

        // Step 5: Diff + discussions (human-readable + raw with IDs)
        const diff = gitOps.getPRDiff(baseBranch, branchName, config.workingDir);

        const failedChecks = gh.detectFailedChecks(
            scm, headSha, inputFolder, config.scm && config.scm.jenkinsBasePath, diff);

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(scm, pr.number);

        // Step 6: Write all context files
        gitOps.writePRContext(inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);

        // agents#827: remember the head this pass starts from, so pushReworkChanges can tell a real fix
        // from a pass that only left housekeeping (outputs/, WIP auto-saves) behind.
        writeReworkBaseHead(inputFolder, headSha);

        // gh-799: pinned input contract — whatever armed this leg, the input
        // folder now ALWAYS carries the complete open-item picture (threads
        // with ids, CI failures, review verdict). Non-fatal: a placeholder
        // write failure must not kill the leg.
        try {
            ensureInputContextContract(inputFolder, scm, prDetails.number, discussionData, failedChecks);
        } catch (e) {
            console.warn('Input contract enforcement failed (non-fatal):', e);
        }

        // Step 7: Fetch question subtasks with answers
        try {
            fetchQuestionsToInput.action(actualParams);
        } catch (e) {
            console.warn('Failed to fetch questions (non-fatal):', e);
        }

        // Step 8: tracker comment — skipped for PR-anchored reworks (#544):
        // a 'pr-N' key parses to no tracker ticket (the PR comment comes
        // from the post action instead).
        if (prAnchor) {
            console.log('PR-anchored rework: skipping tracker comment (no ticket, #544)');
        } else {
            postReworkStartedCommentStep(tracker, ticketKey, customParams, {
                prNumber: prDetails.number,
                prUrl: prDetails.html_url,
                branchName: branchName,
                conflictFiles: conflictFiles,
                failedChecks: failedChecks
            });
        }

        console.log('✅ Rework setup complete — branch:', branchName, '| PR #' + prDetails.number);

        // Enrich input with [BA]/[SA]/[VD] context from parent siblings
        try {
            fetchParentContextToInput.action(params);
        } catch (e) {
            console.warn('fetchParentContextToInput failed (non-fatal):', e);
        }

        return {
            success: true,
            prNumber: prDetails.number,
            prUrl: prDetails.html_url,
            branchName: branchName,
            owner: repoInfo.owner,
            repo: repoInfo.repo
        };

    } catch (error) {
        console.error('❌ Error in preCliReworkSetup:', error);
        reportActionError(params, tracker, error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        syncBaseBranchIfConfigured,
        truncateForComment,
        buildReworkStartedComment,
        buildReviewStateMd,
        ensureInputContextContract,
        // gh-1002: helpers extracted from action() to bring its CRAP under the
        // quality-gate threshold — exported for direct unit testing.
        parseReworkParams,
        resolveActualParams,
        parsePrAnchor,
        resolveRepoInfo,
        postRepoResolutionFailure,
        findPrForRework,
        moveTicketToReworkStatus,
        checkoutReworkBranch,
        runSetupCommandsStep,
        writeReworkBaseHead,
        postReworkStartedCommentStep,
        reportActionError,
        createErrorTracker,
        postErrorComment,
        errorTicketKeyOf
    };
}
