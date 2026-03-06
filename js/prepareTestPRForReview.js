/**
 * Prepare Test PR For Review Action (preCliJSAction for pr_test_automation_review)
 * Same as preparePRForReview.js but specifically targets test/{TICKET-KEY} branches,
 * not feature ai/{TICKET-KEY} branches.
 */

const gh = require('./common/githubHelpers.js');

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
            return { pr: openMatch[0], merged: false };
        }

        // No open PR — check if it was already merged
        const closedPRs = github_list_prs({ workspace: workspace, repository: repository, state: 'closed' });
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

function action(params) {
    try {
        const inputFolder = params.inputFolderPath;
        const ticketKey = inputFolder.split('/').pop();

        console.log('=== Preparing test PR for review:', ticketKey, '===');

        // Step 1: GitHub repo info
        const repoInfo = gh.getGitHubRepoInfo();
        if (!repoInfo) {
            const err = 'Could not determine GitHub repository from git remote';
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Test PR Review Setup Failed\n\n' + err + '\n\n_Review cancelled._' }); } catch (e) {}
            return false;
        }

        // Step 2: Find PR on test/{KEY} branch specifically
        var found = findTestPRForTicket(repoInfo.owner, repoInfo.repo, ticketKey);
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

            // Branch exists — create a new PR so review can proceed
            console.log('Branch exists but no PR — creating PR for review...');
            try {
                const ticket = jira_get_ticket({ key: ticketKey });
                const summary = ticket && ticket.fields ? (ticket.fields.summary || ticketKey) : ticketKey;
                const prTitle = ticketKey + ' ' + summary;
                const prBody = 'Auto-created PR for test automation review.\n\nTicket: ' + ticketKey;

                file_write({ path: '/tmp/review_pr_body_' + ticketKey + '.md', content: prBody });

                const createOutput = cli_execute_command({
                    command: 'gh pr create --title "' + prTitle.replace(/"/g, '\\"') + '" --body-file "/tmp/review_pr_body_' + ticketKey + '.md" --base main --head ' + branchName + ' --repo ' + repoInfo.owner + '/' + repoInfo.repo
                }) || '';

                console.log('gh pr create output:', createOutput);

                const urlMatch = createOutput.match(/https:\/\/github\.com\/[^\s]+/);
                const prUrl = urlMatch ? urlMatch[0] : null;
                const prNumMatch = (prUrl || '').match(/\/pull\/(\d+)/);
                const prNum = prNumMatch ? parseInt(prNumMatch[1], 10) : null;

                if (!prNum) {
                    throw new Error('Could not determine PR number from: ' + createOutput.substring(0, 200));
                }

                console.log('✅ Created new PR #' + prNum + ' for review');
                found = { merged: false, pr: { number: prNum, html_url: prUrl } };
            } catch (createErr) {
                const err = 'Branch test/' + ticketKey + ' exists but could not create PR: ' + createErr.toString();
                try { jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Test PR Review Setup Failed\n\n' + err + '\n\n_Review cancelled._' }); } catch (e) {}
                return false;
            }
        }

        // If PR is already merged — move ticket to final status without re-reviewing
        if (found.merged) {
            const pr = found.pr;
            try {
                const ticket = jira_get_ticket({ key: ticketKey });
                const currentStatus = ticket && ticket.fields && ticket.fields.status
                    ? ticket.fields.status.name : '';
                const finalStatus = currentStatus === 'In Review - Failed' ? 'Failed' : 'Passed';
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

        // Step 3: PR details
        const prDetails = gh.getPRDetails(repoInfo.owner, repoInfo.repo, pr.number);
        if (!prDetails) {
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Test PR Review Setup Failed\n\nCould not fetch details for PR #' + pr.number + '.\n\n_Review cancelled._' }); } catch (e) {}
            return false;
        }

        // Step 4: Checkout test branch
        const branchName = prDetails.head ? prDetails.head.ref : null;
        try {
            if (branchName) {
                gh.checkoutPRBranch(branchName);
            }
        } catch (e) {
            console.warn('Could not checkout test branch:', e);
        }

        // Step 5: Diff + discussions
        const baseBranch = prDetails.base ? prDetails.base.ref : 'main';
        const diff = gh.getPRDiff(baseBranch, branchName || (prDetails.head && prDetails.head.ref));

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(repoInfo.owner, repoInfo.repo, pr.number);

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
            const ticketKey = params.inputFolderPath.split('/').pop();
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
