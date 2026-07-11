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
var prHelper = require('./common/pullRequest.js');
const { STATUSES, LABELS } = require('./config.js');

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

function getInputFolder(params, ticketKey) {
    if (params.inputFolderPath) {
        return params.inputFolderPath;
    }
    return 'input/' + ticketKey;
}

function ensureInputFolder(inputFolder) {
    try {
        cli_execute_command({ command: 'mkdir -p ' + inputFolder });
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

function isNoCommitsError(error) {
    const msg = error && error.toString ? error.toString() : String(error);
    return msg.indexOf('No commits between') !== -1 ||
           msg.indexOf('no commits between') !== -1;
}

function getIssueType(params) {
    try {
        return params.ticket.fields.issuetype.name;
    } catch (e) {
        return null;
    }
}

function isWip(pr, ticket) {
    if (pr && (pr.draft || (pr.title && /^\s*(WIP|DRAFT)\b/i.test(pr.title)))) {
        return true;
    }
    if (ticket && ticket.labels) {
        const labels = Array.isArray(ticket.labels) ? ticket.labels : (ticket.labels.value || []);
        for (var i = 0; i < labels.length; i++) {
            if (/_(wip|draft)$/i.test(labels[i]) || /^(wip|draft)$/i.test(labels[i])) {
                return true;
            }
        }
    }
    return false;
}

function resolveFinalStatus(currentStatus, issueType) {
    // Test Cases finish in Passed/Failed; Stories and Bugs stay in In Testing
    // so the done-check agents (checkStoryTestsPassed / checkBugTestsPassed)
    // can evaluate all linked Test Cases and move to Done / Bug To Fix / Ready For Testing.
    if (issueType === 'Test Case') {
        return currentStatus === 'In Review - Failed' ? 'Failed' : 'Passed';
    }
    return STATUSES.IN_TESTING;
}

function markTestPrMerged(ticketKey) {
    try {
        jira_add_label({ key: ticketKey, label: LABELS.TEST_PR_MERGED });
        console.log('Added label', LABELS.TEST_PR_MERGED, 'to', ticketKey);
    } catch (e) {
        console.warn('Could not add test_pr_merged label:', e);
    }
}

function finalizeAlreadyMergedTestCase(ticketKey, branchName, issueType) {
    try {
        markTestPrMerged(ticketKey);
        const ticket = jira_get_ticket({ key: ticketKey });
        const currentStatus = ticket && ticket.fields && ticket.fields.status
            ? ticket.fields.status.name
            : '';
        const finalStatus = resolveFinalStatus(currentStatus, issueType);
        jira_move_to_status({ key: ticketKey, statusName: finalStatus });
        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ Test Code Already Merged\n\n' +
                'Branch {code}' + branchName + '{code} has no commits ahead of main, so the test code is already in main.\n\n' +
                'Moved ticket to *' + finalStatus + '* and removed the stale branch.'
        });
        console.log('✅ Branch has no commits ahead of main — moved', ticketKey, 'to', finalStatus);
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

function action(params) {
    try {
        const ticketKey = getTicketKey(params);
        const inputFolder = getInputFolder(params, ticketKey);
        const issueType = getIssueType(params);
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var scm = configLoader.createScm(config);

        console.log('=== Preparing test PR for review:', ticketKey, '===');

        ensureInputFolder(inputFolder);
        clearStaleReviewOutputs();

        // Step 1: GitHub repo info
        var repoInfo = scm.getRemoteRepoInfo();
        if (!repoInfo) {
            const err = 'Could not determine repository from git remote';
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Test PR Review Setup Failed\n\n' + err + '\n\n_Review cancelled._' }); } catch (e) {}
            return false;
        }

        // Step 2: Find PR on test/{KEY} branch specifically
        var found = findTestPRForTicket(scm, ticketKey);
        if (!found) {
            // No open/merged PR — check if the test branch exists on remote
            const branchName = 'test/' + ticketKey;
            console.log('No PR found. Checking if branch exists on remote:', branchName);
            var branchExists = false;
            try {
                const lsOutput = cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || '';
                branchExists = lsOutput.indexOf('refs/heads/' + branchName) !== -1;
            } catch (e) {
                console.warn('Could not check remote branch:', e);
            }

            if (!branchExists) {
                // No branch at all — needs re-automation from scratch
                const err = 'No test PR and no remote branch found for test/' + ticketKey + '. Ticket needs re-automation.';
                try {
                    jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Test PR Review Setup Failed\n\n' + err + '\n\n_Moving to In Rework so it can be re-automated._' });
                    jira_move_to_status({ key: ticketKey, statusName: 'In Rework' });
                } catch (e) {}
                return false;
            }

            // Branch exists — create a new PR/MR so review can proceed
            console.log('Branch exists but no PR — creating PR for review...');
            try {
                const ticket = jira_get_ticket({ key: ticketKey });
                const summary = ticket && ticket.fields ? (ticket.fields.summary || ticketKey) : ticketKey;
                const prTitle = configLoader.formatTemplate(config.formats.prTitle.testAutomation, {ticketKey: ticketKey, ticketSummary: summary});

                const prResult = prHelper.createPullRequest({
                    scm: scm,
                    title: prTitle,
                    branchName: branchName,
                    baseBranch: config.git.baseBranch,
                    bodyContent: 'Auto-created PR for test automation review.\n\nTicket: ' + ticketKey
                });
                if (!prResult || !prResult.success) {
                    throw new Error((prResult && prResult.error) || 'Failed to create PR/MR');
                }

                console.log('✅ Created new PR/MR for review:', prResult.prUrl || '(URL unknown)');
                // Re-fetch so downstream code gets a consistent PR shape from the SCM.
                found = findTestPRForTicket(scm, ticketKey);
                if (!found) {
                    throw new Error('PR was created but could not be found immediately after creation');
                }
            } catch (createErr) {
                if (isNoCommitsError(createErr)) {
                    console.log('Branch test/' + ticketKey + ' has no commits ahead of main — test code is already merged.');
                    finalizeAlreadyMergedTestCase(ticketKey, branchName, issueType);
                    return false;
                }
                const err = 'Branch test/' + ticketKey + ' exists but could not create PR: ' + createErr.toString();
                try { jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Test PR Review Setup Failed\n\n' + err + '\n\n_Review cancelled._' }); } catch (e) {}
                return false;
            }
        }

        // If PR is already merged — move ticket to final status without re-reviewing
        if (found.merged) {
            const pr = found.pr;
            markTestPrMerged(ticketKey);
            try {
                const ticket = jira_get_ticket({ key: ticketKey });
                const currentStatus = ticket && ticket.fields && ticket.fields.status
                    ? ticket.fields.status.name : '';
                const finalStatus = resolveFinalStatus(currentStatus, issueType);
                jira_move_to_status({ key: ticketKey, statusName: finalStatus });
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ✅ Test PR Already Merged\n\n' +
                        'PR [#' + pr.number + '|' + pr.html_url + '] for branch {code}test/' + ticketKey + '{code} was already merged.\n\n' +
                        'Skipping re-review — moved ticket to *' + finalStatus + '*.'
                });
                console.log('✅ PR already merged — moved', ticketKey, 'to', finalStatus);
            } catch (e) {
                console.warn('Failed to handle already-merged PR:', e);
            }
            return false;
        }

        const pr = found.pr;

        // Skip WIP / draft PRs
        if (isWip(pr, params.ticket)) {
            console.log('PR #' + pr.number + ' is WIP/draft — skipping review for', ticketKey);
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ⏸️ Test PR Review Skipped\n\nPR [#' + pr.number + '|' + (pr.html_url || '') + '] is WIP/draft. Review will run once it is ready.'
                });
            } catch (e) {}
            return false;
        }

        // Step 3: PR details
        const prDetails = gh.getPRDetails(scm, pr.number);
        if (!prDetails) {
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Test PR Review Setup Failed\n\nCould not fetch details for PR #' + pr.number + '.\n\n_Review cancelled._' }); } catch (e) {}
            return false;
        }

        const branchName = prDetails.head ? prDetails.head.ref : null;

        // If the PR has no actual changes, the test code is already in main. Finalize and skip review.
        var changedFiles = prDetails.changed_files;
        if (typeof changedFiles === 'number' && changedFiles === 0) {
            console.log('PR #' + pr.number + ' has 0 changed files — test code is already in main');
            finalizeAlreadyMergedTestCase(ticketKey, branchName || ('test/' + ticketKey), issueType);
            return false;
        }

        // Step 4: Checkout test branch
        try {
            if (branchName) {
                gh.checkoutPRBranch(branchName, config.workingDir, config.git.baseBranch);
            }
        } catch (e) {
            console.warn('Could not checkout test branch:', e);
        }

        // Step 5: Diff + discussions
        const baseBranch = prDetails.base ? prDetails.base.ref : config.git.baseBranch;
        const diff = gh.getPRDiff(baseBranch, branchName || (prDetails.head && prDetails.head.ref));

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(scm, pr.number);

        // Step 6: Write context files
        gh.writePRContext(inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);

        // Step 7: Jira comment
        try {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. 🧪 Automated Test PR Review Started\n\n' +
                    '*Pull Request*: [PR #' + prDetails.number + '|' + prDetails.html_url + ']\n' +
                    '*Branch*: {code}' + (branchName || 'unknown') + '{code}\n' +
                    '*Files Changed*: ' + (prDetails.changed_files || 0) + '\n\n' +
                    '_Test code review results will be posted shortly..._'
            });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        console.log('✅ Test PR review setup complete — PR #' + prDetails.number);

        return {
            success: true,
            prNumber: prDetails.number,
            prUrl: prDetails.html_url,
            branchName: branchName,
            owner: repoInfo.owner,
            repo: repoInfo.repo
        };

    } catch (error) {
        console.error('❌ Error in prepareTestPRForReview:', error);
        try {
            const ticketKey = getTicketKey(params);
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ❌ Test PR Review Setup Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
