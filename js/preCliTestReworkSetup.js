/**
 * Pre-CLI Test Rework Setup Action (preCliJSAction for pr_test_automation_rework)
 * Same as preCliReworkSetup.js but specifically targets test/{TICKET-KEY} branches,
 * not feature ai/{TICKET-KEY} branches.
 *
 * gh-1042: the CRAP refactor extracts parse/build helpers (pure) plus one
 * function per setup step from action() — same tracker/SCM/git calls in the
 * same order, exported for direct unit testing.
 */

var configLoader = require('./configLoader.js');
const gh = require('./common/githubHelpers.js');
const gitOps = require('./common/gitOps.js');
const prHelper = require('./common/pullRequest.js');
const trackersModule = require('./common/trackers.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
const fetchLinkedBugsToInput = require('./fetchLinkedBugsToInput.js');

// ── Pure parse/build helpers (gh-1042) ──────────────────────────────────────

/** params resolution: Teammate workflow (inputFolderPath on params) vs JSRunner. */
function parseActualParams(params) {
    return params.inputFolderPath ? params : (params.jobParams || params);
}

/** customParams live on actualParams or on jobParams — first hit wins. */
function parseCustomParams(params, actualParams) {
    return actualParams.customParams || (params.jobParams && params.jobParams.customParams) || {};
}

/** 'input/PROJ-12' → 'PROJ-12' (the ticket key is the input folder's basename). */
function parseTicketKey(inputFolder) {
    return inputFolder.split('/').pop();
}

function buildTestBranchName(ticketKey) {
    return 'test/' + ticketKey;
}

/** Decide "branch exists on remote" from a raw ls-remote capture. */
function parseBranchExists(lsOutput, branchName) {
    return (lsOutput || '').indexOf('refs/heads/' + branchName) !== -1;
}

function buildFailureResult(error) {
    return { success: false, error: error };
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

/** Error message for a failed createPr — the provider's reason or a generic one. */
function decidePrCreateError(prResult) {
    return (prResult && prResult.error) || 'SCM provider failed to create PR/MR';
}

/**
 * Build the "Automated Test Rework Started" tracker comment (pure).
 * @param {Object} prDetails     - PR details (number/html_url)
 * @param {string} branchName    - head branch
 * @param {string[]} conflictFiles - files with merge conflicts (may be empty)
 * @returns {string} Jira-wiki comment body
 */
function buildReworkStartedComment(prDetails, branchName, conflictFiles) {
    var jiraComment = 'h3. 🔧 Automated Test Rework Started\n\n' +
        '*Pull Request*: [PR #' + prDetails.number + '|' + prDetails.html_url + ']\n' +
        '*Branch*: {code}' + branchName + '{code}\n\n';

    if (conflictFiles.length > 0) {
        jiraComment += '{panel:bgColor=#FFEBE6|borderColor=#DE350B}' +
            '⚠️ *Merge conflicts detected* — ' + conflictFiles.length + ' file(s) must be resolved:\n' +
            conflictFiles.map(function(f) { return '* {code}' + f + '{code}'; }).join('\n') +
            '{panel}\n\n';
    }

    jiraComment += 'AI Teammate is fixing test code issues raised in the review.\n\n' +
        '_Results will be posted shortly..._';
    return jiraComment;
}

// ── Setup steps (gh-1042) ────────────────────────────────────────────────────

/** Clear stale output files from any previous run (best-effort). */
function clearStaleOutputFiles() {
    try {
        cli_execute_command({
            command: 'bash -c "rm -f outputs/test_automation_result.json outputs/story_test_automation_result.json outputs/tracker_comment.md outputs/comment.md outputs/jira_comment.md outputs/response.md outputs/pr_body.md outputs/bug_description.md outputs/failed_description_*.md"'
        });
        console.log('Cleared stale output files before rework');
    } catch (e) {
        console.warn('Could not clear output files:', e);
    }
}

/** Probe the remote for the test branch; a probe failure means "absent". */
function probeRemoteBranch(testBranchName) {
    try {
        const lsOutput = cli_execute_command({ command: 'git ls-remote --heads origin ' + testBranchName }) || '';
        return parseBranchExists(lsOutput, testBranchName);
    } catch (e) {
        console.warn('Could not check remote branch:', e);
        return false;
    }
}

/** PR title for an auto-created rework PR, from the tracker ticket summary. */
function buildPrTitle(config, tracker, ticketKey) {
    const ticket = tracker.getIssue(ticketKey);
    const summary = ticket && ticket.fields ? (ticket.fields.summary || ticketKey) : ticketKey;
    return configLoader.formatTemplate(config.formats.prTitle.rework, {ticketKey: ticketKey, ticketSummary: summary});
}

/** Auto-create the rework PR on the checked-out test branch. Throws on failure. */
function createReworkPr(scm, config, tracker, ticketKey, testBranchName) {
    const prTitle = buildPrTitle(config, tracker, ticketKey);

    if (!scm.createPr) {
        throw new Error('Configured SCM provider does not support createPr');
    }
    const prResult = scm.createPr({
        title: prTitle,
        // gh-737: merge bot links approved issues via 'Closes #N' —
        // emit it by construction on this auto-created rework PR.
        body: prHelper.ensureClosesLine('Auto-created PR for rework of test automation.\n\nTicket: ' + ticketKey, ticketKey),
        branchName: testBranchName,
        baseBranch: config.git.baseBranch
    });
    if (!prResult || !prResult.success) {
        throw new Error(decidePrCreateError(prResult));
    }

    console.log('✅ Created new PR/MR #' + (prResult.number || '?') + ' for rework');
    return { number: prResult.number, html_url: prResult.prUrl, head: { ref: testBranchName } };
}

/**
 * PR auto-creation failed — CLI is already on correct branch, postTestReworkResults
 * will create the PR. Posts a warning, writes minimal context so the CLI knows
 * what to do, and returns the noPR success shape.
 */
function reportAutoCreateFailure(tracker, ticketKey, testBranchName, createErr, inputFolder) {
    console.warn('PR auto-creation failed (CLI will run on correct branch, PR will be created post-rework):', createErr.toString());
    try {
        tracker.postComment(ticketKey, 'h3. ⚠️ PR Auto-Creation Warning\n\nBranch {code}' + testBranchName + '{code} is checked out and rework will proceed.\nA PR will be created automatically after rework completes.\n\nError: ' + createErr.toString());
    } catch (e) {}

    // Write minimal context so CLI knows what to do
    try {
        const ticket2 = tracker.getIssue(ticketKey);
        const summary2 = ticket2 && ticket2.fields ? (ticket2.fields.summary || '') : '';
        gitOps.writePRContext(inputFolder, { number: 0, title: ticketKey + ' ' + summary2, html_url: '' }, '', 'No PR exists yet — re-run tests from scratch on this branch.', []);
    } catch (e) { console.warn('Could not write fallback context:', e); }

    return { success: true, branchName: testBranchName, prNumber: null, noPR: true };
}

/**
 * No-PR flow (gh-1042 step): the test branch exists on the remote but has no
 * open PR. Returns { result } when the flow is finished (failure or noPR
 * success), { pr } when a PR was auto-created and the main flow continues.
 */
function prepareBranchWithoutOpenPr(scm, config, tracker, ticketKey, testBranchName, inputFolder) {
    console.log('No open PR found. Checking if branch exists on remote:', testBranchName);
    if (!probeRemoteBranch(testBranchName)) {
        const err = 'No test PR and no remote branch found for ' + testBranchName + '. Moving to Backlog for re-automation.';
        try {
            tracker.postComment(ticketKey, 'h3. ❌ Test Rework Setup Failed\n\n' + err);
            tracker.moveToStatus(ticketKey, config.jira.statuses.BACKLOG);
        } catch (e) {}
        return { result: buildFailureResult(err) };
    }

    // Branch exists — ALWAYS checkout first so CLI runs on correct branch
    // (critical: CLI always runs regardless of preCliJSAction return value)
    try {
        gitOps.checkoutPRBranch(testBranchName, config.workingDir, config.git.baseBranch);
        console.log('✅ Checked out branch:', testBranchName);
    } catch (e) {
        console.warn('Could not checkout branch (will try fetch+checkout):', e);
        try {
            cli_execute_command({ command: gh.buildOriginFetchCommand(testBranchName + ':' + testBranchName) });
            cli_execute_command({ command: 'git checkout ' + testBranchName });
            console.log('✅ Checked out branch via fetch:', testBranchName);
        } catch (e2) {
            console.warn('Branch checkout failed:', e2);
        }
    }

    console.log('Creating PR for rework from existing branch...');
    try {
        return { pr: createReworkPr(scm, config, tracker, ticketKey, testBranchName) };
    } catch (createErr) {
        return { result: reportAutoCreateFailure(tracker, ticketKey, testBranchName, createErr, inputFolder) };
    }
}

/** Step-4 checkout; returns an error string instead of throwing. */
function checkoutPrBranchOrFail(branchName, config) {
    try {
        gitOps.checkoutPRBranch(branchName, config.workingDir, config.git.baseBranch);
        return null;
    } catch (e) {
        return 'Failed to checkout branch: ' + e.toString();
    }
}

/** Fetch question subtasks and linked bugs (both non-fatal, fixed order). */
function fetchExtras(actualParams) {
    try {
        fetchQuestionsToInput.action(actualParams);
    } catch (e) {
        console.warn('Failed to fetch questions (non-fatal):', e);
    }
    try {
        fetchLinkedBugsToInput.action(actualParams);
    } catch (e) {
        console.warn('Failed to fetch linked bugs (non-fatal):', e);
    }
}

/** Post the started-comment; a posting failure is a warning only. */
function postReworkStartedComment(tracker, ticketKey, prDetails, branchName, conflictFiles) {
    try {
        tracker.postComment(ticketKey, buildReworkStartedComment(prDetails, branchName, conflictFiles));
    } catch (e) {
        console.warn('Failed to post Jira comment:', e);
    }
}

/** Ticket key for the outer-catch error comment — '' when no folder is known. */
function parseErrorTicketKey(params) {
    return (params.inputFolderPath ||
        (params.jobParams && params.jobParams.inputFolderPath) || '').split('/').pop();
}

/** The tracker for the error comment: the action's own, or a fallback factory. */
function createErrorTracker(params, tracker) {
    if (tracker) return tracker;
    return trackersModule.createTracker(null, (params.jobParams && params.jobParams.customParams) || params.customParams || {});
}

/** Outer-catch reporter: best-effort error comment via a fallback tracker. */
function reportActionError(params, tracker, error) {
    console.error('❌ Error in preCliTestReworkSetup:', error);
    try {
        tracker = createErrorTracker(params, tracker);
        const ticketKey = parseErrorTicketKey(params);
        if (ticketKey) {
            tracker.postComment(ticketKey, 'h3. ❌ Test Rework Setup Error\n\n{code}' + error.toString() + '{code}');
        }
    } catch (e) {}
    return buildFailureResult(error.toString());
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
            return openMatch[0];
        }

        console.warn('No open PR found for test branch:', branchName);
        return null;
    } catch (e) {
        console.error('Failed to find test PR:', e);
        return null;
    }
}

function action(params) {
    var tracker = null;
    try {
        var actualParams = parseActualParams(params);
        var inputFolder = actualParams.inputFolderPath;
        var ticketKey = parseTicketKey(inputFolder);
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var scm = configLoader.createScm(config);
        tracker = trackersModule.createTracker(config, parseCustomParams(params, actualParams));

        console.log('=== Test rework setup for:', ticketKey, '===');

        // Clear stale output files from any previous run so the post-action
        // never reads a result JSON that belongs to a different ticket.
        clearStaleOutputFiles();

        // Step 1: GitHub repo info
        var repoInfo = scm.getRemoteRepoInfo();
        if (!repoInfo) {
            const err = 'Could not determine GitHub repository from git remote';
            try { tracker.postComment(ticketKey, 'h3. ❌ Test Rework Setup Failed\n\n' + err); } catch (e) {}
            return buildFailureResult(err);
        }

        // Step 2: Find PR on test/{KEY} branch specifically
        var pr = findTestPRForTicket(scm, ticketKey);
        const testBranchName = buildTestBranchName(ticketKey);

        if (!pr) {
            var noPrOutcome = prepareBranchWithoutOpenPr(scm, config, tracker, ticketKey, testBranchName, inputFolder);
            if (noPrOutcome.result) return noPrOutcome.result;
            pr = noPrOutcome.pr;
        }

        // Step 3: PR details
        const prDetails = gh.getPRDetails(scm, pr.number);
        if (!prDetails) {
            return buildFailureResult('Failed to fetch PR details for PR #' + pr.number);
        }

        // Step 4: Checkout test branch
        const branchName = prDetails.head ? prDetails.head.ref : null;
        if (!branchName) {
            return buildFailureResult('Could not determine branch from PR details');
        }
        const checkoutError = checkoutPrBranchOrFail(branchName, config);
        if (checkoutError) {
            return buildFailureResult(checkoutError);
        }

        // Step 5: Diff + discussions
        const baseBranch = prDetails.base ? prDetails.base.ref : config.git.baseBranch;

        // Step 4.5: Merge base branch and detect conflicts
        const conflictFiles = gitOps.detectMergeConflicts(baseBranch, inputFolder);

        const diff = gitOps.getPRDiff(baseBranch, branchName);

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(scm, pr.number);

        // Step 6: Write context files
        gitOps.writePRContext(inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);

        // Step 7 (+7b): question subtasks and linked bugs (extra context)
        fetchExtras(actualParams);

        // Step 8: Jira comment
        postReworkStartedComment(tracker, ticketKey, prDetails, branchName, conflictFiles);

        console.log('✅ Test rework setup complete — branch:', branchName, '| PR #' + prDetails.number);

        return buildSuccessResult(prDetails, branchName, repoInfo);

    } catch (error) {
        return reportActionError(params, tracker, error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        // gh-1042: helpers extracted from action() to bring its CRAP under the
        // quality-gate threshold — exported for direct unit testing.
        parseActualParams,
        parseCustomParams,
        parseTicketKey,
        buildTestBranchName,
        parseBranchExists,
        buildFailureResult,
        buildSuccessResult,
        decidePrCreateError,
        buildReworkStartedComment,
        clearStaleOutputFiles,
        probeRemoteBranch,
        buildPrTitle,
        createReworkPr,
        reportAutoCreateFailure,
        prepareBranchWithoutOpenPr,
        checkoutPrBranchOrFail,
        fetchExtras,
        postReworkStartedComment,
        parseErrorTicketKey,
        createErrorTracker,
        reportActionError
    };
}
