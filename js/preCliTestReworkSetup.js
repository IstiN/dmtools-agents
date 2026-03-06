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
        var pr = findTestPRForTicket(repoInfo.owner, repoInfo.repo, ticketKey);
        if (!pr) {
            // No open PR — check if the test branch exists on remote (branch may exist without a PR)
            const branchName = 'test/' + ticketKey;
            console.log('No open PR found. Checking if branch exists on remote:', branchName);
            var branchExists = false;
            try {
                const lsOutput = cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || '';
                branchExists = lsOutput.indexOf('refs/heads/' + branchName) !== -1;
            } catch (e) {
                console.warn('Could not check remote branch:', e);
            }

            if (!branchExists) {
                const err = 'No test PR and no remote branch found for test/' + ticketKey + '. Cannot start rework — test may need to be re-automated from Backlog.';
                try {
                    jira_post_comment({ key: ticketKey, comment: 'h3. ❌ Test Rework Setup Failed\n\n' + err });
                    jira_move_to_status({ key: ticketKey, statusName: 'Backlog' });
                } catch (e) {}
                return { success: false, error: err };
            }

            // Branch exists — create a new PR so rework can proceed
            console.log('Branch exists but no open PR — creating PR for rework...');
            try {
                const ticket = jira_get_ticket({ key: ticketKey });
                const summary = ticket && ticket.fields ? (ticket.fields.summary || ticketKey) : ticketKey;
                const prTitle = ticketKey + ' ' + summary + ' (rework)';
                const prBody = 'Auto-created PR for rework of test automation.\n\nTicket: ' + ticketKey;

                // Write temp body file
                file_write({ path: '/tmp/rework_pr_body_' + ticketKey + '.md', content: prBody });

                const createOutput = cli_execute_command({
                    command: 'gh pr create --title "' + prTitle.replace(/"/g, '\\"') + '" --body-file "/tmp/rework_pr_body_' + ticketKey + '.md" --base main --head ' + branchName + ' --repo ' + repoInfo.owner + '/' + repoInfo.repo
                }) || '';

                console.log('gh pr create output:', createOutput);

                // Extract PR number
                const urlMatch = createOutput.match(/https:\/\/github\.com\/[^\s]+/);
                const prUrl = urlMatch ? urlMatch[0] : null;
                const prNumMatch = (prUrl || '').match(/\/pull\/(\d+)/);
                const prNum = prNumMatch ? parseInt(prNumMatch[1], 10) : null;

                if (!prNum) {
                    throw new Error('Could not determine PR number from: ' + createOutput.substring(0, 200));
                }

                console.log('✅ Created new PR #' + prNum + ' for rework');

                // Re-fetch the PR object
                const openPRs2 = github_list_prs({ workspace: repoInfo.owner, repository: repoInfo.repo, state: 'open' });
                const matched2 = openPRs2.filter(function(p) { return p.number === prNum; });
                if (matched2.length > 0) {
                    pr = matched2[0];
                } else {
                    pr = { number: prNum, html_url: prUrl };
                }
            } catch (createErr) {
                const err = 'Branch test/' + ticketKey + ' exists but could not create PR: ' + createErr.toString();
                try { jira_post_comment({ key: ticketKey, comment: 'h3. ❌ Test Rework Setup Failed\n\n' + err }); } catch (e) {}
                return { success: false, error: err };
            }
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

        // Step 4.5: Merge base branch and detect conflicts
        const conflictFiles = gh.detectMergeConflicts(baseBranch, inputFolder);

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

            jira_post_comment({ key: ticketKey, comment: jiraComment });
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
