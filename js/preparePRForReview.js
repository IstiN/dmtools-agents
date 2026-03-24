/**
 * Prepare PR for Review Action (preCliJSAction for pr_review agent)
 * 1. Finds PR associated with the ticket
 * 2. Checks out the PR branch
 * 3. Writes input folder: pr_info.md, pr_diff.txt, pr_discussions.md, pr_discussions_raw.json
 * 4. Posts "Review Started" comment to Jira
 */

var configLoader = require('./configLoader.js');
const gh = require('./common/githubHelpers.js');

function action(params) {
    try {
        const inputFolder = params.inputFolderPath;
        const ticketKey = inputFolder.split('/').pop();
        var config = configLoader.loadProjectConfig(params.jobParams || params);

        console.log('=== Preparing PR for review:', ticketKey, '===');

        // Step 1: GitHub repo info — prefer targetRepository from config over git remote
        var repoInfo = null;
        if (config.repository && config.repository.owner && config.repository.repo) {
            repoInfo = { owner: config.repository.owner, repo: config.repository.repo };
            console.log('Using targetRepository from config:', repoInfo.owner + '/' + repoInfo.repo);
        } else {
            repoInfo = gh.getGitHubRepoInfo();
        }
        if (!repoInfo) {
            const err = 'Could not determine GitHub repository from git remote';
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ PR Review Setup Failed\n\n' + err + '\n\n_Review cancelled — no PR to review._' }); } catch (e) {}
            return false;
        }

        // Step 2: Find PR
        const pr = gh.findPRForTicket(repoInfo.owner, repoInfo.repo, ticketKey);
        if (!pr) {
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ⚠️ PR Review Setup Failed\n\n' +
                        'Could not find an open Pull Request associated with *' + ticketKey + '*.\n\n' +
                        'Please ensure:\n' +
                        '* A PR has been created with the ticket key in the title or branch name\n' +
                        '* The PR is open and accessible\n\n' +
                        '_Review cancelled — no PR to review._'
                });
            } catch (e) {}
            return false;
        }

        // Step 3: PR details
        const prDetails = gh.getPRDetails(repoInfo.owner, repoInfo.repo, pr.number);
        if (!prDetails) {
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ⚠️ PR Review Setup Failed\n\nCould not fetch details for PR #' + pr.number + '.\n\n_Review cancelled._'
                });
            } catch (e) {}
            return false;
        }

        // Step 4: Checkout PR branch
        const branchName = prDetails.head ? prDetails.head.ref : null;
        try {
            if (branchName) {
                gh.checkoutPRBranch(branchName, config.workingDir);
            }
        } catch (e) {
            console.warn('Could not checkout PR branch:', e);
        }

        // Step 5: Diff + discussions (human-readable + raw with IDs)
        const baseBranch = prDetails.base ? prDetails.base.ref : config.git.baseBranch;
        const diff = gh.getPRDiff(baseBranch, branchName || (prDetails.head && prDetails.head.ref), config.workingDir);

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(repoInfo.owner, repoInfo.repo, pr.number);

        // Step 6: Write all context files
        gh.writePRContext(inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);

        // Step 6.5: Detect failed CI checks
        var headSha = prDetails.head ? prDetails.head.sha : null;
        var failedChecks = gh.detectFailedChecks(repoInfo.owner, repoInfo.repo, headSha, inputFolder);

        // Step 7: Jira comment
        try {
            var jiraComment = 'h3. 🔍 Automated PR Review Started\n\n' +
                '*Pull Request*: [PR #' + prDetails.number + '|' + prDetails.html_url + ']\n' +
                '*Branch*: {code}' + (branchName || 'unknown') + '{code}\n' +
                '*Files Changed*: ' + (prDetails.changed_files || 0) + '\n\n';

            if (failedChecks.length > 0) {
                jiraComment += '{panel:bgColor=#FFEBE6|borderColor=#DE350B}' +
                    '⚠️ *CI checks failing* — ' + failedChecks.length + ' check(s) did not pass:\n' +
                    failedChecks.map(function(c) { return '* {code}' + c.name + '{code}'; }).join('\n') +
                    '\nError logs are in {code}ci_failures.md{code} — reviewer will flag these as blocking issues.' +
                    '{panel}\n\n';
            }

            jiraComment += 'AI Code Reviewer is analyzing the pull request for:\n' +
                '* 🔒 Security vulnerabilities\n' +
                '* 🏗️ Code quality & OOP principles\n' +
                '* ✅ Task alignment with requirements\n' +
                '* 🧪 Testing adequacy\n\n' +
                '_Review results will be posted shortly..._';

            jira_post_comment({ key: ticketKey, comment: jiraComment });
        } catch (e) {
            console.warn('Failed to post review started comment:', e);
        }

        console.log('✅ PR review setup completed — PR #' + prDetails.number);

        return {
            success: true,
            prNumber: prDetails.number,
            prUrl: prDetails.html_url,
            branchName: branchName,
            owner: repoInfo.owner,
            repo: repoInfo.repo
        };

    } catch (error) {
        console.error('❌ Error in preparePRForReview:', error);
        try {
            const ticketKey = params.inputFolderPath.split('/').pop();
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ❌ PR Review Setup Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
