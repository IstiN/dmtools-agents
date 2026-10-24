/**
 * Prepare Test PR For Review Action (preJSAction for test-automation review agents)
 * Same as preparePRForReview.js but specifically targets test/{TICKET-KEY} branches,
 * not feature ai/{TICKET-KEY} branches.
 *
 * Runs as preJSAction so that returning `false` skips the whole agent when the PR is
 * already merged or has no changes.
 */

var configLoader = require('./configLoader.js');
const gh = require('./common/githubHelpers.js');
const gitOps = require('./common/gitOps.js');
var prHelper = require('./common/pullRequest.js');
const { LABELS } = require('./config.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}



function getInputFolder(params, ticketKey) {
    if (params.inputFolderPath) {
        return params.inputFolderPath;
    }
    return 'input/' + ticketKey;
}

function ensureInputFolder(inputFolder) {
    try {
        cli_execute_command({ command: 'bash -c "mkdir -p ' + inputFolder + '"' });
    } catch (e) {
        console.warn('Could not create input folder:', e);
    }
}

function findTestPRForTicket(scm, ticketKey) {
    try {
        const branchName = 'test/' + ticketKey;
        console.log('Searching for PR on branch:', branchName);

        const openPRs = scm.listPrs('open');
        const openMatch = openPRs.filter(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName;
        });
        if (openMatch.length > 0) {
            console.log('Found open test PR #' + openMatch[0].number);
            return { pr: openMatch[0], merged: false };
        }

        const closedPRs = scm.listPrs('closed');
        const mergedMatch = closedPRs.filter(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName && pr.merged_at;
        });
        if (mergedMatch.length > 0) {
            console.log('Found already-merged test PR #' + mergedMatch[0].number);
            return { pr: mergedMatch[0], merged: true };
        }

        console.warn('No PR found for test branch:', branchName);
        return null;
    } catch (e) {
        console.error('Failed to find test PR:', e);
        return null;
    }
}

function clearStaleReviewOutputs() {
    try {
        cli_execute_command({
            command: 'rm -f outputs/pr_review.json outputs/response.md outputs/pr_review_general.md && rm -rf outputs/pr_review_comments'
        });
        console.log('✅ Cleared stale review outputs');
    } catch (e) {
        console.warn('Could not clear stale review outputs:', e);
    }
}

// gh-965: ticket summary for the PR title — falls back to the ticket key when
// the tracker issue or its summary is unavailable.
function prTitleSummary(ticket, ticketKey) {
    return ticket && ticket.fields ? (ticket.fields.summary || ticketKey) : ticketKey;
}

// gh-965: creates the review PR for an existing test branch and re-fetches it
// so downstream code gets a consistent PR shape from the SCM. Throws on failure.
function createReviewPrForBranch(scm, ticketKey, branchName, config) {
    const ticket = getTracker().getIssue(ticketKey);
    const prTitle = configLoader.formatTemplate(config.formats.prTitle.testAutomation,
        {ticketKey: ticketKey, ticketSummary: prTitleSummary(ticket, ticketKey)});

    const prResult = prHelper.createPullRequest({
        scm: scm,
        title: prTitle,
        branchName: branchName,
        baseBranch: config.git.baseBranch,
        // gh-737: merge bot links approved issues via 'Closes #N' —
        // emit it by construction on this auto-created review PR.
        ticketKey: ticketKey,
        bodyContent: 'Auto-created PR for test automation review.\n\nTicket: ' + ticketKey
    });
    if (!prResult || !prResult.success) {
        throw new Error((prResult && prResult.error) || 'Failed to create PR/MR');
    }

    console.log('✅ Created new PR/MR for review:', prResult.prUrl || '(URL unknown)');
    const found = findTestPRForTicket(scm, ticketKey);
    if (!found) {
        throw new Error('PR was created but could not be found immediately after creation');
    }
    return found;
}

// gh-965: the "no open/merged PR" decision. Re-automation when the remote
// branch is gone; otherwise create the review PR. Returns { found } to proceed
// with review, or { result: false } when action() must abort.
function ensureReviewPrExists(scm, ticketKey, config, jiraConfig, issueType) {
    const branchName = 'test/' + ticketKey;
    console.log('No PR found. Checking if branch exists on remote:', branchName);

    if (!remoteBranchExistsOnOrigin(branchName)) {
        // No branch at all — needs re-automation from scratch
        const err = 'No test PR and no remote branch found for test/' + ticketKey + '. Ticket needs re-automation.';
        try {
            getTracker().postComment(ticketKey, 'h3. ⚠️ Test PR Review Setup Failed\n\n' + err + '\n\n_Moving to In Rework so it can be re-automated._');
            getTracker().moveToStatus(ticketKey, jiraConfig.statuses.IN_REWORK);
        } catch (e) {}
        return { result: false };
    }

    // Branch exists — create a new PR/MR so review can proceed
    console.log('Branch exists but no PR — creating PR for review...');
    try {
        return { found: createReviewPrForBranch(scm, ticketKey, branchName, config) };
    } catch (createErr) {
        if (isNoCommitsError(createErr)) {
            console.log('Branch test/' + ticketKey + ' has no commits ahead of main — test code is already merged.');
            finalizeAlreadyMergedTestCase(ticketKey, branchName, issueType, jiraConfig);
            return { result: false };
        }
        postReviewSetupFailed(ticketKey,
            'Branch test/' + ticketKey + ' exists but could not create PR: ' + createErr.toString(),
            '_Review cancelled._');
        return { result: false };
    }
}

// gh-965: PR already merged — move ticket to final status without re-reviewing.
function handleAlreadyMergedPr(ticketKey, pr, issueType, jiraConfig) {
    markTestPrMerged(ticketKey);
    try {
        const ticket = getTracker().getIssue(ticketKey);
        const finalStatus = resolveFinalStatus(ticket, issueType, jiraConfig, getTracker());
        // gh-916: the final status (Passed/Failed/In Testing) can be tag-only — stage-label fallback.
        const moved = getTracker().moveToStatusOrMark(ticketKey, finalStatus,
            issueType === jiraConfig.issueTypes.TEST_CASE
                ? (finalStatus === jiraConfig.statuses.FAILED ? 'FAILED' : 'PASSED')
                : 'IN_TESTING');
        if (moved.moved || moved.marked) {
            getTracker().postComment(ticketKey, 'h3. ✅ Test PR Already Merged\n\n' +
                    'PR [#' + pr.number + '|' + pr.html_url + '] for branch {code}test/' + ticketKey + '{code} was already merged.\n\n' +
                    'Skipping re-review — moved ticket to *' + finalStatus + '*.');
            console.log('✅ PR already merged — moved', ticketKey, 'to', finalStatus);
        }
    } catch (e) {
        console.warn('Failed to handle already-merged PR:', e);
    }
}

// gh-965: a PR whose diff is empty carries no test code to review.
function hasNoChanges(prDetails) {
    var changedFiles = prDetails.changed_files;
    return typeof changedFiles === 'number' && changedFiles === 0;
}

function isNoCommitsError(error) {
    const msg = error && error.toString ? error.toString() : String(error);
    return msg.indexOf('No commits between') !== -1 ||
           msg.indexOf('no commits between') !== -1;
}

// gh-965: setup-failure comment shared by every abort-before-review path.
function postReviewSetupFailed(ticketKey, err, note) {
    try {
        getTracker().postComment(ticketKey, 'h3. ⚠️ Test PR Review Setup Failed\n\n' + err + '\n\n' + note);
    } catch (e) {}
}

// gh-965: probes origin for the test branch via ls-remote (stderr-noise tolerant:
// the check is on a real refs/heads/<name> line, not capture non-emptiness).
function remoteBranchExistsOnOrigin(branchName) {
    try {
        const lsOutput = cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || '';
        return lsOutput.indexOf('refs/heads/' + branchName) !== -1;
    } catch (e) {
        console.warn('Could not check remote branch:', e);
        return false;
    }
}

function getIssueType(params) {
    try {
        return params.ticket.fields.issuetype.name;
    } catch (e) {
        return null;
    }
}

// ── gh-1077 extracted pure helpers (parse/build/decide) ─────────────────────

function isWipPrTitle(title) {
    return /^\s*(WIP|DRAFT)\b/i.test(title);
}

// The PR itself is WIP/draft: an explicit draft flag or a WIP/DRAFT title prefix.
function isWipPr(pr) {
    return !!pr && (!!pr.draft || (!!pr.title && isWipPrTitle(pr.title)));
}

// ADO labels arrive as {value: [...]}; jira/github as a plain array.
// Returns null when the ticket carries no labels at all.
function ticketLabels(ticket) {
    if (!ticket || !ticket.labels) {
        return null;
    }
    return Array.isArray(ticket.labels) ? ticket.labels : (ticket.labels.value || []);
}

function isWipLabel(label) {
    return /_(wip|draft)$/i.test(label) || /^(wip|draft)$/i.test(label);
}

function hasWipTicketLabel(ticket) {
    const labels = ticketLabels(ticket);
    if (!labels) {
        return false;
    }
    for (var i = 0; i < labels.length; i++) {
        if (isWipLabel(labels[i])) {
            return true;
        }
    }
    return false;
}

function isWip(pr, ticket) {
    if (isWipPr(pr)) {
        return true;
    }
    if (hasWipTicketLabel(ticket)) {
        return true;
    }
    return false;
}

function resolveFinalStatus(ticket, issueType, jiraConfig, tracker) {
    // Test Cases finish in Passed/Failed; Stories and Bugs stay in In Testing
    // so the done-check agents (checkStoryTestsPassed / checkBugTestsPassed)
    // can evaluate all linked Test Cases and move to Done / Bug To Fix / Ready For Testing.
    // gh-916: hasStage also accepts the stage_<key> marker a rejected In Review - Failed
    // transition left (jira.stageFallback 'label'); 'none' mode compares the status only.
    if (issueType === jiraConfig.issueTypes.TEST_CASE) {
        return tracker.hasStage(ticket, 'IN_REVIEW_FAILED', jiraConfig.statuses.IN_REVIEW_FAILED)
            ? jiraConfig.statuses.FAILED
            : jiraConfig.statuses.PASSED;
    }
    return jiraConfig.statuses.IN_TESTING;
}

function markTestPrMerged(ticketKey) {
    try {
        getTracker().addLabel(ticketKey, LABELS.TEST_PR_MERGED);
        console.log('Added label', LABELS.TEST_PR_MERGED, 'to', ticketKey);
    } catch (e) {
        console.warn('Could not add test_pr_merged label:', e);
    }
}

function finalizeAlreadyMergedTestCase(ticketKey, branchName, issueType, jiraConfig) {
    try {
        markTestPrMerged(ticketKey);
        const ticket = getTracker().getIssue(ticketKey);
        const finalStatus = resolveFinalStatus(ticket, issueType, jiraConfig, getTracker());
        // gh-916: the final status (Passed/Failed/In Testing) can be tag-only — stage-label fallback.
        const moved = getTracker().moveToStatusOrMark(ticketKey, finalStatus,
            issueType === jiraConfig.issueTypes.TEST_CASE
                ? (finalStatus === jiraConfig.statuses.FAILED ? 'FAILED' : 'PASSED')
                : 'IN_TESTING');
        if (moved.moved || moved.marked) {
            getTracker().postComment(ticketKey, 'h3. ✅ Test Code Already Merged\n\n' +
                    'Branch {code}' + branchName + '{code} has no commits ahead of main, so the test code is already in main.\n\n' +
                    'Moved ticket to *' + finalStatus + '* and removed the stale branch.');
            console.log('✅ Branch has no commits ahead of main — moved', ticketKey, 'to', finalStatus);
        }
        try {
            cli_execute_command({ command: 'git push origin --delete ' + branchName });
            console.log('✅ Deleted stale branch:', branchName);
        } catch (delErr) {
            console.warn('Could not delete stale branch', branchName + ':', delErr);
        }
    } catch (e) {
        console.warn('Failed to finalize already-merged test case:', e);
    }
}

// ── gh-1186: review-setup helpers (extracted from action) ───────────────────

/**
 * Pure ticket-key resolution: params.ticket.key first, then the input folder
 * (params or jobParams) leaf name. Throws when nothing identifies the ticket.
 */
function getTicketKey(params) {
    if (params.ticket && params.ticket.key) {
        return params.ticket.key;
    }
    if (params.inputFolderPath) {
        return params.inputFolderPath.split('/').pop();
    }
    if (params.jobParams && params.jobParams.inputFolderPath) {
        return params.jobParams.inputFolderPath.split('/').pop();
    }
    throw new Error('Cannot determine ticket key from params.ticket.key or params.inputFolderPath');
}

/**
 * Everything action() needs before touching git: ticket key, input folder,
 * issue type, project config, tracker init and the SCM — resolved in the
 * original order.
 */
function resolveReviewSetup(params) {
    const ticketKey = getTicketKey(params);
    const inputFolder = getInputFolder(params, ticketKey);
    const issueType = getIssueType(params);
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    initTracker(config, (params.jobParams && params.jobParams.customParams) || params.customParams || {});
    return {
        ticketKey: ticketKey,
        inputFolder: inputFolder,
        ticket: params.ticket,
        issueType: issueType,
        config: config,
        jiraConfig: config.jira,
        scm: configLoader.createScm(config)
    };
}

/**
 * The "which PR is under review" resolution: find the open/merged test PR,
 * create one when only the branch exists, and short-circuit the two states
 * that must not be reviewed (already merged, WIP/draft). Returns
 * { found } to proceed or { abort: true, result } to return from action().
 */
function resolveTestPr(setup) {
    var found = findTestPRForTicket(setup.scm, setup.ticketKey);
    if (!found) {
        // No open/merged PR — re-automate, or create a review PR for the existing branch
        var ensured = ensureReviewPrExists(setup.scm, setup.ticketKey, setup.config, setup.jiraConfig, setup.issueType);
        if (ensured.result !== undefined) return { abort: true, result: ensured.result };
        found = ensured.found;
    }

    // If PR is already merged — move ticket to final status without re-reviewing
    if (found.merged) {
        handleAlreadyMergedPr(setup.ticketKey, found.pr, setup.issueType, setup.jiraConfig);
        return { abort: true, result: false };
    }

    const pr = found.pr;

    // Skip WIP / draft PRs
    if (isWip(pr, setup.ticket)) {
        console.log('PR #' + pr.number + ' is WIP/draft — skipping review for', setup.ticketKey);
        try {
            getTracker().postComment(setup.ticketKey, 'h3. ⏸️ Test PR Review Skipped\n\nPR [#' + pr.number + '|' + (pr.html_url || '') + '] is WIP/draft. Review will run once it is ready.');
        } catch (e) {}
        return { abort: true, result: false };
    }

    return { found: found };
}

/** Head branch of the PR details, or null when the shape is unexpected. */
function branchRefOf(prDetails) {
    return prDetails.head ? prDetails.head.ref : null;
}

// The stale test branch name, derived from the ticket when the PR has no head.
function staleBranchRef(branchName, ticketKey) {
    return branchName || ('test/' + ticketKey);
}

// Diff target: the PR's branch when known, else whatever the PR details offer.
function diffHeadRef(branchName, prDetails) {
    return branchName || (prDetails.head && prDetails.head.ref);
}

/**
 * Step 4 of the original flow: checkout the test branch; a missing branch or
 * a failed checkout is logged and never aborts the review setup.
 */
function checkoutTestBranch(gitOps, branchName, config) {
    try {
        if (branchName) {
            gitOps.checkoutPRBranch(branchName, config.workingDir, config.git.baseBranch);
        }
    } catch (e) {
        console.warn('Could not checkout test branch:', e);
    }
}

/**
 * Steps 5-6 of the original flow: diff against the PR base, fetch the PR
 * discussions and write the review context files into the input folder.
 */
function writeReviewContext(gh, gitOps, scm, config, inputFolder, prDetails, branchName) {
    const baseBranch = prDetails.base ? prDetails.base.ref : config.git.baseBranch;
    const diff = gitOps.getPRDiff(baseBranch, diffHeadRef(branchName, prDetails));

    console.log('Fetching PR discussions...');
    const discussionData = gh.fetchDiscussionsAndRawData(scm, prDetails.number);

    gitOps.writePRContext(inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);
}

// The "review started" ticket comment body.
function reviewStartedComment(prDetails, branchName) {
    return 'h3. 🧪 Automated Test PR Review Started\n\n' +
        '*Pull Request*: [PR #' + prDetails.number + '|' + prDetails.html_url + ']\n' +
        '*Branch*: {code}' + (branchName || 'unknown') + '{code}\n' +
        '*Files Changed*: ' + (prDetails.changed_files || 0) + '\n\n' +
        '_Test code review results will be posted shortly..._';
}

/** Step 7: announce the started review on the ticket; provider errors logged. */
function postReviewStartedComment(ticketKey, prDetails, branchName) {
    try {
        getTracker().postComment(ticketKey, reviewStartedComment(prDetails, branchName));
    } catch (e) {
        console.warn('Failed to post Jira comment:', e);
    }
}

/** The success payload returned to the CLI-agent runner. */
function reviewOutcome(repoInfo, prDetails, branchName) {
    return {
        success: true,
        prNumber: prDetails.number,
        prUrl: prDetails.html_url,
        branchName: branchName,
        owner: repoInfo.owner,
        repo: repoInfo.repo
    };
}

/** Best-effort setup-error report on the ticket; failures are swallowed. */
function postReviewSetupError(params, error) {
    try {
        const ticketKey = getTicketKey(params);
        getTracker().postComment(ticketKey, 'h3. ❌ Test PR Review Setup Error\n\n{code}' + error.toString() + '{code}');
    } catch (e) {}
}

function action(params) {
    try {
        const setup = resolveReviewSetup(params);

        console.log('=== Preparing test PR for review:', setup.ticketKey, '===');

        ensureInputFolder(setup.inputFolder);
        clearStaleReviewOutputs();

        // Step 1: GitHub repo info
        var repoInfo = setup.scm.getRemoteRepoInfo();
        if (!repoInfo) {
            postReviewSetupFailed(setup.ticketKey, 'Could not determine repository from git remote', '_Review cancelled._');
            return false;
        }

        // Step 2: Find PR on test/{KEY} branch specifically (create one when only
        // the branch exists; abort on already-merged / WIP states)
        var resolved = resolveTestPr(setup);
        if (resolved.abort) return resolved.result;
        const pr = resolved.found.pr;

        // Step 3: PR details
        const prDetails = gh.getPRDetails(setup.scm, pr.number);
        if (!prDetails) {
            postReviewSetupFailed(setup.ticketKey, 'Could not fetch details for PR #' + pr.number + '.', '_Review cancelled._');
            return false;
        }

        const branchName = branchRefOf(prDetails);

        // If the PR has no actual changes, the test code is already in main. Finalize and skip review.
        if (hasNoChanges(prDetails)) {
            console.log('PR #' + pr.number + ' has 0 changed files — test code is already in main');
            finalizeAlreadyMergedTestCase(setup.ticketKey, staleBranchRef(branchName, setup.ticketKey), setup.issueType, setup.jiraConfig);
            return false;
        }

        // Step 4: Checkout test branch
        checkoutTestBranch(gitOps, branchName, setup.config);

        // Step 5 + 6: Diff + discussions, then write context files
        writeReviewContext(gh, gitOps, setup.scm, setup.config, setup.inputFolder, prDetails, branchName);

        // Step 7: Jira comment
        postReviewStartedComment(setup.ticketKey, prDetails, branchName);

        console.log('✅ Test PR review setup complete — PR #' + prDetails.number);

        return reviewOutcome(repoInfo, prDetails, branchName);

    } catch (error) {
        console.error('❌ Error in prepareTestPRForReview:', error);
        postReviewSetupError(params, error);
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        isWip: isWip,
        isWipPr: isWipPr,
        isWipPrTitle: isWipPrTitle,
        ticketLabels: ticketLabels,
        isWipLabel: isWipLabel,
        hasWipTicketLabel: hasWipTicketLabel,
        // gh-1186: ticket-key resolution and review-step helpers — additive surface.
        getTicketKey: getTicketKey,
        branchRefOf: branchRefOf,
        staleBranchRef: staleBranchRef,
        diffHeadRef: diffHeadRef,
        reviewStartedComment: reviewStartedComment,
        reviewOutcome: reviewOutcome
    };
}
