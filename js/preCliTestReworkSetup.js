/**
 * Pre-CLI Test Rework Setup Action (preCliJSAction for pr_test_automation_rework)
 * Same as preCliReworkSetup.js but specifically targets test/{TICKET-KEY} branches,
 * not feature ai/{TICKET-KEY} branches.
 */

const gh = require('./common/githubHelpers.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');

function findTestPRForTicket(workspace, repository, ticketKey) {
    try {
        const branchName = 'test/' + ticketKey;
        console.log('Searching for PR on branch:', branchName);

        const openPRs = github_list_prs({ workspace: workspace, repository: repository, state: 'open' });
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
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var inputFolder = actualParams.inputFolderPath;
        var ticketKey = inputFolder.split('/').pop();

        console.log('=== Test rework setup for:', ticketKey, '===');

        // Step 1: GitHub repo info
        const repoInfo = gh.getGitHubRepoInfo();
        if (!repoInfo) {
            const err = 'Could not determine GitHub repository from git remote';
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ❌ Test Rework Setup Failed\n\n' + err }); } catch (e) {}
            return { success: false, error: err };
        }

        // Step 2: Find PR on test/{KEY} branch specifically
        const pr = findTestPRForTicket(repoInfo.owner, repoInfo.repo, ticketKey);
        if (!pr) {
            const err = 'No test PR found for branch test/' + ticketKey + '. Cannot start rework without an existing PR.';
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ❌ Test Rework Setup Failed\n\n' + err }); } catch (e) {}
            return { success: false, error: err };
        }

        // Step 3: PR details
        const prDetails = gh.getPRDetails(repoInfo.owner, repoInfo.repo, pr.number);
        if (!prDetails) {
            return { success: false, error: 'Failed to fetch PR details for PR #' + pr.number };
        }

        // Step 4: Checkout test branch
        const branchName = prDetails.head ? prDetails.head.ref : null;
        if (!branchName) {
            return { success: false, error: 'Could not determine branch from PR details' };
        }
        try {
            gh.checkoutPRBranch(branchName);
        } catch (e) {
            return { success: false, error: 'Failed to checkout branch: ' + e.toString() };
        }

        // Step 5: Diff + discussions
        const baseBranch = prDetails.base ? prDetails.base.ref : 'main';
        const diff = gh.getPRDiff(baseBranch, branchName);

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(repoInfo.owner, repoInfo.repo, pr.number);

        // Step 6: Write context files
        gh.writePRContext(inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);

        // Step 7: Fetch question subtasks with answers (extra context)
        try {
            fetchQuestionsToInput.action(actualParams);
        } catch (e) {
            console.warn('Failed to fetch questions (non-fatal):', e);
        }

        // Step 8: Jira comment
        try {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. 🔧 Automated Test Rework Started\n\n' +
                    '*Pull Request*: [PR #' + prDetails.number + '|' + prDetails.html_url + ']\n' +
                    '*Branch*: {code}' + branchName + '{code}\n\n' +
                    'AI Teammate is fixing test code issues raised in the review.\n\n' +
                    '_Results will be posted shortly..._'
            });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        console.log('✅ Test rework setup complete — branch:', branchName, '| PR #' + prDetails.number);

        return {
            success: true,
            prNumber: prDetails.number,
            prUrl: prDetails.html_url,
            branchName: branchName,
            owner: repoInfo.owner,
            repo: repoInfo.repo
        };

    } catch (error) {
        console.error('❌ Error in preCliTestReworkSetup:', error);
        try {
            const ticketKey = (params.inputFolderPath ||
                (params.jobParams && params.jobParams.inputFolderPath) || '').split('/').pop();
            if (ticketKey) {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ❌ Test Rework Setup Error\n\n{code}' + error.toString() + '{code}'
                });
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
