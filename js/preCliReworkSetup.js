/**
 * Pre-CLI Rework Setup Action (preCliJSAction for pr_rework agent)
 * 1. Finds the existing PR for the ticket
 * 2. Checks out the PR branch
 * 3. Writes input folder: pr_info.md, pr_diff.txt, pr_discussions.md, pr_discussions_raw.json
 * 4. Fetches question subtasks with answers (extra context)
 * 5. Posts "Rework Started" comment to Jira
 */

var configLoader = require('./configLoader.js');
const gh = require('./common/githubHelpers.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
const fetchParentContextToInput = require('./fetchParentContextToInput.js');

function failSetup(ticketKey, inputFolder, message) {
    try {
        file_write({
            path: inputFolder + '/rework_setup_failed.md',
            content: '# Rework Setup Failed\n\n' + message + '\n'
        });
    } catch (e) {
        console.warn('Failed to write rework setup failure marker:', e);
    }
    try {
        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ❌ Rework Setup Failed\n\n' + message
        });
    } catch (e) {}
    throw new Error(message);
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var inputFolder = actualParams.inputFolderPath;
        var ticketKey = inputFolder.split('/').pop();
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var scm = configLoader.createScm(config);

        console.log('=== Rework setup for:', ticketKey, '===');

        // Step 1: GitHub repo info — prefer targetRepository from config over git remote
        var repoInfo = null;
        if (config.repository && config.repository.owner && config.repository.repo) {
            repoInfo = { owner: config.repository.owner, repo: config.repository.repo };
            console.log('Using targetRepository from config:', repoInfo.owner + '/' + repoInfo.repo);
        } else {
            repoInfo = scm.getRemoteRepoInfo();
        }
        if (!repoInfo) {
            const err = 'Could not determine GitHub repository from git remote';
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ❌ Rework Setup Failed\n\n' + err }); } catch (e) {}
            return { success: false, error: err };
        }

        // Step 2: Find existing PR
        const pr = gh.findPRForTicket(scm, ticketKey);
        if (!pr) {
            failSetup(
                ticketKey,
                inputFolder,
                'No Pull Request found for ticket ' + ticketKey + '. Cannot start rework without an existing PR.'
            );
        }

        // Step 3: PR details
        const prDetails = gh.getPRDetails(scm, pr.number);
        if (!prDetails) {
            failSetup(ticketKey, inputFolder, 'Failed to fetch PR details for PR #' + pr.number);
        }

        // Step 4: Checkout PR branch
        const branchName = prDetails.head ? prDetails.head.ref : null;
        if (!branchName) {
            failSetup(ticketKey, inputFolder, 'Could not determine branch from PR details');
        }
        try {
            gh.checkoutPRBranch(branchName, config.workingDir);
        } catch (e) {
            failSetup(ticketKey, inputFolder, 'Failed to checkout branch: ' + e.toString());
        }

        // Step 5: Diff + discussions (human-readable + raw with IDs)
        const baseBranch = prDetails.base ? prDetails.base.ref : config.git.baseBranch;

        // Step 4.5: Merge base branch and detect conflicts
        // Always merges origin/{baseBranch} so the branch stays up to date.
        // If conflicts exist, writes merge_conflicts.md to the input folder.
        const conflictFiles = gh.detectMergeConflicts(baseBranch, inputFolder, config.workingDir);

        // Step 4.6: Detect failed CI checks — writes ci_failures.md if any failed
        const headSha = prDetails.head ? prDetails.head.sha : null;
        const failedChecks = gh.detectFailedChecks(scm, headSha, inputFolder);

        const diff = gh.getPRDiff(baseBranch, branchName, config.workingDir);

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(scm, pr.number);

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

        // Enrich input with [BA]/[SA]/[VD] context from parent siblings
        try {
            fetchParentContextToInput.action(params);
        } catch (e) {
            console.warn('fetchParentContextToInput failed (non-fatal):', e);
        }

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
