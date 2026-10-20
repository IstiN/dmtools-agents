/**
 * Prepare PR for Review Action (preCliJSAction for pr_review agent)
 * 1. Finds PR associated with the ticket
 * 2. Checks out the PR branch
 * 3. Writes input folder: pr_info.md, pr_diff.txt, pr_discussions.md, pr_discussions_raw.json
 * 4. Posts "Review Started" comment to Jira
 *
 * gh-927: `action` is a short orchestrator; the steps live in small exported
 * helpers (parse, resolve, build and fetch functions below) so each is
 * directly testable and the file stays under the CRAP ratchet.
 */

var configLoader = require('./configLoader.js');
const gh = require('./common/githubHelpers.js');
const gitOps = require('./common/gitOps.js');
const commentMarkup = require('./common/commentMarkup.js');
const fetchParentContextToInput = require('./fetchParentContextToInput.js');
var trackersModule = require('./common/trackers.js');

// ── Parsing / context ────────────────────────────────────────────────────────

function parsePrAnchor(ticketKey, fallbackParams) {
    var anchorMatch = /^pr-(\d+)$/.exec(String(ticketKey || ''));
    return (anchorMatch ? parseInt(anchorMatch[1], 10) : null) ||
        (parseInt(fallbackParams.prNumber || fallbackParams.pr || '', 10) || null);
}

function parseContext(params) {
    var inputFolder = params.inputFolderPath;
    var ticketKey = inputFolder.split('/').pop();
    // PR-anchored review (issue #687): a `pr-N` contextId makes the PR
    // itself the anchor — no ticket lookup, no ticket comments. Covers
    // PRs born without an issue and on-demand PR reviews (agent:review).
    var jp = params.jobParams || params;
    var prAnchor = parsePrAnchor(ticketKey, jp);
    return {
        params: params,
        inputFolder: inputFolder,
        ticketKey: ticketKey,
        jp: jp,
        prAnchor: prAnchor,
        noTicket: !!prAnchor
    };
}

function loadContext(ctx) {
    ctx.config = configLoader.loadProjectConfig(ctx.params.jobParams || ctx.params);
    ctx.scm = configLoader.createScm(ctx.config);
    ctx.tracker = trackersModule.createTracker(ctx.config,
        (ctx.params.jobParams && ctx.params.jobParams.customParams) || ctx.params.customParams || {});
    return ctx;
}

// ── Log lines ────────────────────────────────────────────────────────────────

function describeConfiguredRepository(config) {
    return config.repository && config.repository.owner && config.repository.repo
        ? config.repository.owner + '/' + config.repository.repo
        : '(fallback to git remote)';
}

function configuredBaseBranch(config) {
    return config.git && config.git.baseBranch ? config.git.baseBranch : '(not set)';
}

function logPreparationStart(ctx) {
    console.log('=== Preparing PR for review:', ctx.ticketKey, '===');
    console.log('Input folder:', ctx.inputFolder);
    console.log('Configured repository:', describeConfiguredRepository(ctx.config));
    console.log('Configured working directory:', ctx.config.workingDir || '(not set)');
    console.log('Configured base branch:', configuredBaseBranch(ctx.config));
}

// ── Failure comments ─────────────────────────────────────────────────────────

function buildSetupFailedComment(ticketKey, err) {
    return commentMarkup.forTicket(ticketKey).h(3, '⚠️ PR Review Setup Failed') + '\n\n' + err + '\n\n_Review cancelled — no PR to review._';
}

function buildNoPrComment(ticketKey) {
    return commentMarkup.forTicket(ticketKey).h(3, '⚠️ PR Review Setup Failed') + '\n\n' +
        'Could not find an open Pull Request associated with ' + commentMarkup.forTicket(ticketKey).bold(ticketKey) + '.\n\n' +
        'Please ensure:\n' +
        '* A PR has been created with the ticket key in the title or branch name\n' +
        '* The PR is open and accessible\n\n' +
        '_Review cancelled — no PR to review._';
}

function buildDetailsFailureComment(ticketKey, prNumber) {
    return commentMarkup.forTicket(ticketKey).h(3, '⚠️ PR Review Setup Failed') +
        '\n\nCould not fetch details for PR #' + prNumber + '.\n\n_Review cancelled._';
}

/**
 * Posts a failure comment unless it is null (PR-anchored runs have no ticket
 * to notify). Tracker errors are swallowed — failure reporting must never
 * mask the original failure.
 */
function postFailureComment(ctx, comment) {
    if (!comment) return;
    try {
        ctx.tracker.postComment(ctx.ticketKey, comment);
    } catch (e) {}
}

function postSetupErrorComment(ctx, params, error) {
    if (ctx.noTicket) return;
    try {
        var ticketKey = params.inputFolderPath.split('/').pop();
        ctx.tracker.postComment(ticketKey,
            commentMarkup.forTicket(ticketKey).h(3, '❌ PR Review Setup Error') + '\n\n' + commentMarkup.forTicket(ticketKey).code(error.toString())
        );
    } catch (e) {}
}

// ── Steps ────────────────────────────────────────────────────────────────────

// Step 1: repository info — prefer targetRepository from config over git remote
function resolveRepoInfo(ctx) {
    var config = ctx.config;
    var repoInfo = null;
    if (config.repository && config.repository.owner && config.repository.repo) {
        repoInfo = { owner: config.repository.owner, repo: config.repository.repo };
        console.log('Using targetRepository from config:', repoInfo.owner + '/' + repoInfo.repo);
    } else {
        console.log('Target repository not configured, resolving from git remote...');
        repoInfo = ctx.scm.getRemoteRepoInfo();
    }
    if (!repoInfo) {
        var err = 'Could not determine GitHub repository from git remote';
        console.error('PR review setup failed at repository resolution:', err);
        return { failed: true, comment: buildSetupFailedComment(ctx.ticketKey, err) };
    }
    console.log('Resolved repository:', repoInfo.owner + '/' + repoInfo.repo);
    return { repoInfo: repoInfo };
}

function logFoundPr(pr) {
    console.log('Found PR candidate #' + pr.number + ' with title: ' + (pr.title || '(no title)'));
    console.log('PR head branch:', pr.head && pr.head.ref ? pr.head.ref : '(missing)');
}

// Step 2: find the PR — direct anchor or ticket-key search
function findPullRequest(ctx) {
    var pr;
    if (ctx.prAnchor) {
        console.log('PR-anchored review: PR #' + ctx.prAnchor + ' (no ticket lookup)');
        pr = { number: ctx.prAnchor };
    } else {
        console.log('Searching for open PR associated with ticket:', ctx.ticketKey);
        var prSearchOptions = ctx.config.prSearchFn ? { prSearchFn: ctx.config.prSearchFn } : {};
        pr = gh.findPRForTicket(ctx.scm, ctx.ticketKey, prSearchOptions);
    }
    if (pr) {
        logFoundPr(pr);
        return { pr: pr };
    }
    console.warn('No open PR found for ticket:', ctx.ticketKey);
    return { failed: true, comment: ctx.noTicket ? null : buildNoPrComment(ctx.ticketKey) };
}

function refLabel(refContainer) {
    return refContainer && refContainer.ref ? refContainer.ref : '(missing)';
}

// Step 3: PR details
function fetchPrDetails(ctx, pr) {
    console.log('Fetching details for PR #' + pr.number + '...');
    var prDetails = gh.getPRDetails(ctx.scm, pr.number);
    if (prDetails) {
        console.log('Loaded PR details for #' + prDetails.number +
            ' | head=' + refLabel(prDetails.head) +
            ' | base=' + refLabel(prDetails.base) +
            ' | changed_files=' + (prDetails.changed_files || 0));
        return { prDetails: prDetails };
    }
    console.error('Failed to fetch PR details for PR #' + pr.number);
    return { failed: true, comment: ctx.noTicket ? null : buildDetailsFailureComment(ctx.ticketKey, pr.number) };
}

// Step 4: checkout the PR branch (non-fatal on failure)
function checkoutPrBranch(ctx, branchName) {
    try {
        if (branchName) {
            console.log('Checking out PR branch:', branchName, 'workingDir:', ctx.config.workingDir || '(default)');
            gitOps.checkoutPRBranch(branchName, ctx.config.workingDir, ctx.config.git.baseBranch);
            console.log('Checkout completed for branch:', branchName);
        } else {
            console.warn('PR details did not include a head branch; checkout skipped');
        }
    } catch (e) {
        console.warn('Could not checkout PR branch:', e);
    }
}

// Step 5: PR diff (base branch from PR, falling back to config)
function extractBaseBranch(prDetails, config) {
    return prDetails.base ? prDetails.base.ref : config.git.baseBranch;
}

function generateDiff(ctx, prDetails, branchName) {
    var baseBranch = extractBaseBranch(prDetails, ctx.config);
    console.log('Generating PR diff with base branch:', baseBranch, 'and head branch:', branchName || '(missing)');
    var diff = gitOps.getPRDiff(baseBranch, branchName || (prDetails.head && prDetails.head.ref), ctx.config.workingDir);
    console.log('Loaded PR diff characters:', diff ? diff.length : 0);
    return diff;
}

function fetchDiscussionData(ctx, prNumber) {
    console.log('Fetching PR discussions...');
    var discussionData = gh.fetchDiscussionsAndRawData(ctx.scm, prNumber);
    console.log('Fetched PR discussions markdown characters:', discussionData && discussionData.markdown ? discussionData.markdown.length : 0);
    console.log('Fetched PR discussion threads:', discussionData && discussionData.rawThreads ? discussionData.rawThreads.length : 0);
    return discussionData;
}

// Step 6: write all context files
function writePrContext(ctx, prDetails, diff, discussionData) {
    console.log('Writing PR context files to:', ctx.inputFolder);
    gitOps.writePRContext(ctx.inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);
    console.log('PR context files written successfully');
}

// Step 6.5: detect failed checks on the head commit.
// gh-1119: the PR diff rides along so detectFailedChecks can tag extracted
// gate violations owned/foreign in ci_failures.md (same tables the rework
// leg sees); without it everything degrades to the unattributed note.
function detectCheckFailures(ctx, prDetails, diff) {
    var headSha = prDetails.head ? prDetails.head.sha : null;
    console.log('Detecting failed checks for head SHA:', headSha || '(missing)');
    var failedChecks = gh.detectFailedChecks(ctx.scm, headSha, ctx.inputFolder, ctx.config.scm && ctx.config.scm.jenkinsBasePath, diff);
    console.log('Detected failed checks:', failedChecks.length);
    return failedChecks;
}

// ── Review-started comment (Step 7) ─────────────────────────────────────────

function buildFailedChecksPanel(m, failedChecks) {
    return '⚠️ ' + m.bold('CI checks failing') + ' — ' + failedChecks.length + ' check(s) did not pass:\n' +
        failedChecks.map(function(c) { return '* ' + m.inline(c.name); }).join('\n') +
        '\nError logs: ' + m.inline('ci_failures.md') + ' (summary) and ' + m.inline('ci_failures_full.log') + ' (full logs).';
}

function buildReviewStartedComment(ticketKey, prDetails, branchName, failedChecks) {
    var m = commentMarkup.forTicket(ticketKey);
    var jiraComment = m.h(3, '🔍 Automated PR Review Started') + '\n\n' +
        m.bold('Pull Request') + ': ' + m.link('PR #' + prDetails.number, prDetails.html_url) + '\n' +
        m.bold('Branch') + ': ' + m.inline(branchName || 'unknown') + '\n' +
        m.bold('Files Changed') + ': ' + (prDetails.changed_files || 0) + '\n\n';

    if (failedChecks.length > 0) {
        jiraComment += m.panel(null, buildFailedChecksPanel(m, failedChecks),
            'bgColor=#FFEBE6|borderColor=#DE350B') + '\n\n';
    }

    jiraComment += 'AI Code Reviewer is analyzing the pull request for:\n' +
        '* 🔒 Security vulnerabilities\n' +
        '* 🏗️ Code quality & OOP principles\n' +
        '* ✅ Task alignment with requirements\n' +
        '* 🧪 Testing adequacy\n\n' +
        '_Review results will be posted shortly..._';
    return jiraComment;
}

function postReviewStartedComment(ctx, prDetails, branchName, failedChecks) {
    try {
        ctx.tracker.postComment(ctx.ticketKey, buildReviewStartedComment(ctx.ticketKey, prDetails, branchName, failedChecks));
        console.log('Posted "review started" comment to Jira ticket:', ctx.ticketKey);
    } catch (e) {
        console.warn('Failed to post review started comment:', e);
    }
}

// Enrich input with [BA]/[SA]/[VD] context from parent siblings (non-fatal).
function enrichWithParentContext(ctx) {
    try {
        fetchParentContextToInput.action(ctx.params);
    } catch (e) {
        console.warn('fetchParentContextToInput failed (non-fatal):', e);
    }
}

/**
 * Step 7 + completion: the ticket comment and parent enrichment run for
 * issue-anchored reviews only — a PR-anchored review has no ticket to notify
 * (the PR comment comes from the post action).
 */
function finishReviewStart(ctx, prDetails, branchName, failedChecks) {
    if (!ctx.noTicket) {
        postReviewStartedComment(ctx, prDetails, branchName, failedChecks);
    }

    console.log('✅ PR review setup completed — PR #' + prDetails.number);

    if (!ctx.noTicket) {
        enrichWithParentContext(ctx);
    }
}

function buildSuccessResult(prDetails, branchName, repoInfo) {
    return {
        success: true,
        prNumber: prDetails.number,
        prUrl: prDetails.html_url,
        branchName: branchName,
        owner: repoInfo.owner,
        repo: repoInfo.repo
    };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

function extractHeadBranch(prDetails) {
    return prDetails.head ? prDetails.head.ref : null;
}

function action(params) {
    // Seed noTicket/tracker so the catch block can safely decide whether an
    // error comment applies even when the failure happens before context
    // parsing completed (gh-927: the catch previously crashed on a
    // block-scoped `noTicket` when the try threw early).
    var ctx = { noTicket: false, tracker: null };
    try {
        ctx = loadContext(parseContext(params));

        logPreparationStart(ctx);

        var repoOutcome = resolveRepoInfo(ctx);
        if (repoOutcome.failed) {
            postFailureComment(ctx, repoOutcome.comment);
            return false;
        }

        var prOutcome = findPullRequest(ctx);
        if (prOutcome.failed) {
            postFailureComment(ctx, prOutcome.comment);
            return false;
        }

        var detailsOutcome = fetchPrDetails(ctx, prOutcome.pr);
        if (detailsOutcome.failed) {
            postFailureComment(ctx, detailsOutcome.comment);
            return false;
        }
        var prDetails = detailsOutcome.prDetails;

        var branchName = extractHeadBranch(prDetails);
        checkoutPrBranch(ctx, branchName);

        var diff = generateDiff(ctx, prDetails, branchName);
        var discussionData = fetchDiscussionData(ctx, prOutcome.pr.number);
        writePrContext(ctx, prDetails, diff, discussionData);

        var failedChecks = detectCheckFailures(ctx, prDetails, diff);

        finishReviewStart(ctx, prDetails, branchName, failedChecks);

        return buildSuccessResult(prDetails, branchName, repoOutcome.repoInfo);

    } catch (error) {
        console.error('❌ Error in preparePRForReview:', error);
        postSetupErrorComment(ctx, params, error);
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        parsePrAnchor: parsePrAnchor,
        parseContext: parseContext,
        loadContext: loadContext,
        describeConfiguredRepository: describeConfiguredRepository,
        configuredBaseBranch: configuredBaseBranch,
        logPreparationStart: logPreparationStart,
        buildSetupFailedComment: buildSetupFailedComment,
        buildNoPrComment: buildNoPrComment,
        buildDetailsFailureComment: buildDetailsFailureComment,
        postFailureComment: postFailureComment,
        postSetupErrorComment: postSetupErrorComment,
        resolveRepoInfo: resolveRepoInfo,
        findPullRequest: findPullRequest,
        logFoundPr: logFoundPr,
        refLabel: refLabel,
        fetchPrDetails: fetchPrDetails,
        extractHeadBranch: extractHeadBranch,
        checkoutPrBranch: checkoutPrBranch,
        extractBaseBranch: extractBaseBranch,
        generateDiff: generateDiff,
        fetchDiscussionData: fetchDiscussionData,
        writePrContext: writePrContext,
        detectCheckFailures: detectCheckFailures,
        buildFailedChecksPanel: buildFailedChecksPanel,
        buildReviewStartedComment: buildReviewStartedComment,
        postReviewStartedComment: postReviewStartedComment,
        enrichWithParentContext: enrichWithParentContext,
        finishReviewStart: finishReviewStart,
        buildSuccessResult: buildSuccessResult
    };
}
