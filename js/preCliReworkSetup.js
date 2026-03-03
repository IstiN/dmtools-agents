/**
 * Pre-CLI Rework Setup Action (preCliJSAction for pr_rework agent)
 * 1. Finds the existing PR for the ticket
 * 2. Checks out the PR branch
 * 3. Writes input folder: pr_info.md, pr_diff.txt, pr_discussions.md, pr_discussions_raw.json
 * 4. Fetches question subtasks with answers (extra context)
 * 5. Posts "Rework Started" comment to Jira
 */

const gh = require('./common/githubHelpers.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var inputFolder = actualParams.inputFolderPath;
        var ticketKey = inputFolder.split('/').pop();

        console.log('=== Rework setup for:', ticketKey, '===');

        // Step 1: GitHub repo info
        const repoInfo = gh.getGitHubRepoInfo();
        if (!repoInfo) {
            const err = 'Could not determine GitHub repository from git remote';
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ❌ Rework Setup Failed\n\n' + err }); } catch (e) {}
            return { success: false, error: err };
        }

        // Step 2: Find existing PR
        const pr = gh.findPRForTicket(repoInfo.owner, repoInfo.repo, ticketKey);
        if (!pr) {
            const err = 'No Pull Request found for ticket ' + ticketKey + '. Cannot start rework without an existing PR.';
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ❌ Rework Setup Failed\n\n' + err }); } catch (e) {}
            return { success: false, error: err };
        }

        // Step 3: PR details
        const prDetails = gh.getPRDetails(repoInfo.owner, repoInfo.repo, pr.number);
        if (!prDetails) {
            return { success: false, error: 'Failed to fetch PR details for PR #' + pr.number };
        }

        // Step 4: Checkout PR branch
        const branchName = prDetails.head ? prDetails.head.ref : null;
        if (!branchName) {
            return { success: false, error: 'Could not determine branch from PR details' };
        }
        try {
            gh.checkoutPRBranch(branchName);
        } catch (e) {
            return { success: false, error: 'Failed to checkout branch: ' + e.toString() };
        }

        // Step 5: Diff + discussions (human-readable + raw with IDs)
        const baseBranch = prDetails.base ? prDetails.base.ref : 'main';

        // Step 4.5: Merge base branch and detect conflicts
        // Always merges origin/{baseBranch} so the branch stays up to date.
        // If conflicts exist, writes merge_conflicts.md to the input folder.
        const conflictFiles = gh.detectMergeConflicts(baseBranch, inputFolder);

        // Step 4.6: Detect failed CI checks — writes ci_failures.md if any failed
        const headSha = prDetails.head ? prDetails.head.sha : null;
        const failedChecks = gh.detectFailedChecks(repoInfo.owner, repoInfo.repo, headSha, inputFolder);

        const diff = gh.getPRDiff(baseBranch, branchName);

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(repoInfo.owner, repoInfo.repo, pr.number);

        // Step 6: Write all context files
        gh.writePRContext(inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);

        // Step 7: Fetch question subtasks with answers
        try {
            fetchQuestionsToInput.action(actualParams);
        } catch (e) {
            console.warn('Failed to fetch questions (non-fatal):', e);
        }

        // Step 8: Jira comment
        try {
            var jiraComment = 'h3. 🔧 Automated Rework Started\n\n' +
                '*Pull Request*: [PR #' + prDetails.number + '|' + prDetails.html_url + ']\n' +
                '*Branch*: {code}' + branchName + '{code}\n\n';

            if (conflictFiles.length > 0) {
                jiraComment += '{panel:bgColor=#FFEBE6|borderColor=#DE350B}' +
                    '⚠️ *Merge conflicts detected* — ' + conflictFiles.length + ' file(s) must be resolved before rework can be applied:\n' +
                    conflictFiles.map(function(f) { return '* {code}' + f + '{code}'; }).join('\n') +
                    '{panel}\n\n';
            }

            if (failedChecks.length > 0) {
                jiraComment += '{panel:bgColor=#FFEBE6|borderColor=#DE350B}' +
                    '⚠️ *CI checks failing* — ' + failedChecks.length + ' check(s) must pass before merge:\n' +
                    failedChecks.map(function(c) { return '* {code}' + c.name + '{code}'; }).join('\n') +
                    '\nError logs written to {code}ci_failures.md{code} — AI will fix the root cause.' +
                    '{panel}\n\n';
            }

            jiraComment += 'AI Teammate is fixing issues raised in the code review.\n\n' +
                '_Fix results will be posted shortly..._';

            jira_post_comment({ key: ticketKey, comment: jiraComment });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        console.log('✅ Rework setup complete — branch:', branchName, '| PR #' + prDetails.number);

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
        try {
            const ticketKey = (params.inputFolderPath ||
                (params.jobParams && params.jobParams.inputFolderPath) || '').split('/').pop();
            if (ticketKey) {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ❌ Rework Setup Error\n\n{code}' + error.toString() + '{code}'
                });
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
