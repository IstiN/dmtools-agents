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
var forkCheckout = require('./common/forkCheckout.js');
// gh-1404 (hoisted, never lazy — the gh-823 pack-require rule): the
// diff-of-diff input — the re-review round's frozen already-reviewed code.
var prNewHunks = require('./common/prNewHunks.js');
// gh-1332 (hoisted, never lazy — the gh-823 pack-require rule): the
// finding-identity registry — the review-round dedup. The registry's
// previously-raised-findings injection tells a review round what earlier
// rounds already raised, so a re-raise re-introduces the identity instead of
// minting a duplicate thread.
var machineAuthorModule = require('./common/machineAuthor.js');
var findingRegistry = require('./common/findingRegistry.js');
// gh-1351 (hoisted, never lazy — the gh-823 pack-require rule): the review
// policy config — resolved once here so a malformed config fails the leg at
// start, and the resolved table is stamped into the review run context.
var reviewPolicyModule = require('./common/reviewPolicy.js');

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
    // gh-1351: hard validation at leg start — a malformed reviewPolicy throws
    // a ReviewPolicyValidationError HERE, before any side effect. The tracker
    // is created FIRST so the failure is posted on the ticket, not just logged.
    ctx.reviewPolicy = reviewPolicyModule.resolveReviewPolicy(
        ctx.config, ctx.params.jobParams || ctx.params);
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
function checkoutPrBranch(ctx, branchName, prDetails) {
    try {
        if (branchName) {
            var pullRef = forkCheckout.resolvePullRef(
                forkCheckout.prPullRef(prDetails), forkCheckout.envCheckoutRef());
            console.log('Checking out PR branch:', branchName, 'workingDir:', ctx.config.workingDir || '(default)');
            gitOps.checkoutPRBranch(branchName, ctx.config.workingDir, ctx.config.git.baseBranch, pullRef);
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

// ── gh-1351: the review-policy run-context stamp ─────────────────────────────

/**
 * Stamps the resolved reviewPolicy into the review run context
 * (`review_policy.md`) so the reviewer ranks and posts under the SAME policy
 * the machine enforces. Non-fatal end to end: a lost file degrades to the
 * pre-gh-1351 behavior (the policy still governs the machine verdict).
 */
function writeReviewPolicyContext(ctx) {
    try {
        gitOps.writeInputFile(
            ctx.inputFolder + '/review_policy.md',
            reviewPolicyModule.policyInputContextMarkdown(ctx.reviewPolicy),
            'review_policy.md (resolved review policy — gh-1351)'
        );
        console.log('✅ Review policy stamped into the run context (review_policy.md, preset ' +
            ctx.reviewPolicy.preset + ')');
        return true;
    } catch (e) {
        console.warn('review_policy.md stamp failed (non-fatal):', e.message || e);
        return false;
    }
}

// ── gh-1332: the finding-identity registry injection ─────────────────────────

function machineAuthorLoginsOf(ctx) {
    return machineAuthorModule.machineAuthorLogins(
        machineAuthorModule.resolveMachineAuthor(ctx.jp, ctx.config));
}

// The normalized PR comment list shape, or null when the provider cannot
// list comments (no getPrComments) — the injections then skip quietly.
// The shape ladder is the shared normalizePrCommentList; unlike the stamping
// site there is no catch here — a broken payload throws into the caller's
// own non-fatal catch (prCommentsForContextSteps below). Serves BOTH context
// injections now (gh-1404 rework), hence the provider-neutral name.
function normalizedPrComments(scm, prNumber) {
    if (!scm || typeof scm.getPrComments !== 'function') return null;
    return findingRegistry.normalizePrCommentList(scm.getPrComments(prNumber));
}

// gh-1404 rework (review thread ⚠️): steps 6.5 and 6.6 parse the SAME PR
// comment payload — registry records and verdict records ride the identical
// list — so action() fetches it ONCE through this wrapper and threads the
// result through both steps. The read stays non-fatal: a transport failure
// yields null and both steps skip quietly, exactly as when the provider has
// no getPrComments at all.
function prCommentsForContextSteps(scm, prNumber) {
    try {
        return normalizedPrComments(scm, prNumber);
    } catch (e) {
        console.warn('PR comment list read failed (non-fatal):', e.message || e);
        return null;
    }
}

/**
 * The comment list the registry step parses: the shared, already-fetched
 * list (gh-1404 rework); omitted → the step fetches its own (direct-call
 * shape, exercised by the unit tests). Null (or a null prNumber) → the step
 * skips quietly.
 */
function resolveRegistryComments(ctx, prNumber, comments) {
    if (!prNumber) return null;
    return comments === undefined ? normalizedPrComments(ctx.scm, prNumber) : comments;
}

/**
 * Step 6.5: inject the previously raised findings (claim, file, status) into
 * the review input, so a review round inherits the earlier rounds' registry —
 * a re-raise re-introduces the identity instead of minting a duplicate
 * thread. Non-fatal end to end: without a registry (or when the provider
 * cannot list comments) the input prep looks exactly as before.
 */
function writeFindingRegistryContext(ctx, prNumber, comments) {
    try {
        var list = resolveRegistryComments(ctx, prNumber, comments);
        if (list === null) return false;
        var record = findingRegistry.latestRegistry(list,
            { authorLogins: machineAuthorLoginsOf(ctx) });
        var markdown = record ? findingRegistry.buildFindingsInjection(record.registry) : null;
        if (!markdown) return false;
        gitOps.writeInputFile(ctx.inputFolder + '/pr_findings.md', markdown, 'pr_findings.md');
        console.log('✅ Finding-registry context written (previously raised findings injected)');
        return true;
    } catch (e) {
        console.warn('Finding-registry context injection failed (non-fatal):', e.message || e);
        return false;
    }
}

// ── gh-1404: the diff-of-diff injection (pr_new_hunks.txt) ───────────────────

// The prDetails head pair the diff-of-diff runs on, or null when the PR
// details carry no usable anchor (extracted for the CRAP ratchet, gh-1404
// rework review thread 🚨: writeNewHunksContext accumulated every guard of
// the step and crossed the threshold).
function newHunksHeadPair(prDetails) {
    var currentHead = prDetails && prDetails.head && prDetails.head.sha;
    if (!prDetails || !prDetails.number || !currentHead) return null;
    return { number: prDetails.number, currentHead: currentHead };
}

/**
 * Resolved diff-of-diff inputs, or null when this round is NOT a re-review:
 * a first round (no verdict record), an unchanged head, or no comment list.
 * `comments` is the shared, already-fetched list (gh-1404 rework — no second
 * provider round-trip); omitted → the step fetches its own (direct-call
 * shape, exercised by the unit tests).
 */
function resolveNewHunksContext(ctx, prDetails, comments) {
    var pair = newHunksHeadPair(prDetails);
    if (!pair) return null;
    var list = comments === undefined ? normalizedPrComments(ctx.scm, pair.number) : comments;
    if (list === null) return null;
    var lastHead = prNewHunks.lastReviewedHead(list,
        { authorLogins: machineAuthorLoginsOf(ctx) });
    if (!prNewHunks.headsDiffer(lastHead, pair.currentHead)) return null;
    return { lastHead: lastHead, currentHead: pair.currentHead };
}

/**
 * Step 6.6: inject the new hunks since the last reviewed head into the review
 * input. A re-review round reviews the diff-of-diff plus the interaction
 * neighborhood instead of whole files, and unchanged lines are frozen
 * (gh-1404) — this is what stops findings landing on already-reviewed code.
 * The last reviewed head is the head of the newest machine verdict record on
 * the PR (reviewVerdicts). Non-fatal end to end: a first round (no verdict
 * record), an unchanged head, a failed diff command or a provider without
 * getPrComments leaves the input exactly as before — the reviewer then
 * reviews the full PR diff.
 */
function writeNewHunksContext(ctx, prDetails, comments) {
    try {
        var heads = resolveNewHunksContext(ctx, prDetails, comments);
        if (!heads) return false;
        var hunks = gitOps.getDiffBetweenCommits(heads.lastHead, heads.currentHead, ctx.config.workingDir);
        if (!hunks) return false;
        gitOps.writeInputFile(ctx.inputFolder + '/pr_new_hunks.txt',
            prNewHunks.buildNewHunksFile(heads.lastHead, heads.currentHead,
                gitOps.trimLargeTextForInput(hunks, 'pr_new_hunks.txt')),
            'pr_new_hunks.txt');
        console.log('✅ Diff-of-diff context written (new hunks since last reviewed head)');
        return true;
    } catch (e) {
        console.warn('Diff-of-diff context injection failed (non-fatal):', e.message || e);
        return false;
    }
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
        // loadContext MUTATES ctx in place and returns it — the in-place
        // mutation is load-bearing (gh-1351): a reviewPolicy validation error
        // thrown mid-load still leaves the resolved tracker on the ctx the
        // catch uses, so the failure is posted on the ticket, not just logged.
        ctx = parseContext(params);
        loadContext(ctx);

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
        checkoutPrBranch(ctx, branchName, prDetails);

        var diff = generateDiff(ctx, prDetails, branchName);
        var discussionData = fetchDiscussionData(ctx, prOutcome.pr.number);
        writePrContext(ctx, prDetails, diff, discussionData);

        // gh-1351: stamp the resolved reviewPolicy into the run context so
        // the reviewer ranks/posts under the policy the machine enforces.
        writeReviewPolicyContext(ctx);

        // Steps 6.5 + 6.6: one PR comment read serves both context injections
        // (gh-1404 rework) — the finding registry and the diff-of-diff step
        // parse the identical payload; a read failure is non-fatal (null →
        // both steps skip quietly).
        var prComments = prCommentsForContextSteps(ctx.scm, prOutcome.pr.number);

        // Step 6.5: inject the finding-identity registry (gh-1332) — the
        // previously raised findings this round must answer, not re-raise.
        writeFindingRegistryContext(ctx, prOutcome.pr.number, prComments);

        // Step 6.6: inject the diff-of-diff (gh-1404) — the hunks added since
        // the last reviewed head, so already-reviewed code stays frozen.
        writeNewHunksContext(ctx, prDetails, prComments);

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
        writeFindingRegistryContext: writeFindingRegistryContext,
        writeNewHunksContext: writeNewHunksContext,
        newHunksHeadPair: newHunksHeadPair,
        resolveNewHunksContext: resolveNewHunksContext,
        resolveRegistryComments: resolveRegistryComments,
        prCommentsForContextSteps: prCommentsForContextSteps,
        detectCheckFailures: detectCheckFailures,
        buildFailedChecksPanel: buildFailedChecksPanel,
        buildReviewStartedComment: buildReviewStartedComment,
        postReviewStartedComment: postReviewStartedComment,
        enrichWithParentContext: enrichWithParentContext,
        finishReviewStart: finishReviewStart,
        buildSuccessResult: buildSuccessResult
    };
}
