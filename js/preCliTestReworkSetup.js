/**
 * Pre-CLI Test Rework Setup Action (preCliJSAction for pr_test_automation_rework)
 * Same as preCliReworkSetup.js but specifically targets test/{TICKET-KEY} branches,
 * not feature ai/{TICKET-KEY} branches.
 */

var configLoader = require('./configLoader.js');
const gh = require('./common/githubHelpers.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
const fetchLinkedBugsToInput = require('./fetchLinkedBugsToInput.js');

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
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var inputFolder = actualParams.inputFolderPath;
        var ticketKey = inputFolder.split('/').pop();
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var scm = configLoader.createScm(config);

        console.log('=== Test rework setup for:', ticketKey, '===');

        // Step 1: GitHub repo info
        var repoInfo = scm.getRemoteRepoInfo();
        if (!repoInfo) {
            const err = 'Could not determine GitHub repository from git remote';
            try { jira_post_comment({ key: ticketKey, comment: 'h3. ❌ Test Rework Setup Failed\n\n' + err }); } catch (e) {}
            return { success: false, error: err };
        }

        // Step 2: Find PR on test/{KEY} branch specifically
        var pr = findTestPRForTicket(scm, ticketKey);
        const testBranchName = 'test/' + ticketKey;

        if (!pr) {
            // No open PR — check if the test branch exists on remote
            console.log('No open PR found. Checking if branch exists on remote:', testBranchName);
            var branchExists = false;
            try {
                const lsOutput = cli_execute_command({ command: 'git ls-remote --heads origin ' + testBranchName }) || '';
                branchExists = lsOutput.indexOf('refs/heads/' + testBranchName) !== -1;
            } catch (e) {
                console.warn('Could not check remote branch:', e);
            }

            if (!branchExists) {
                const err = 'No test PR and no remote branch found for ' + testBranchName + '. Moving to Backlog for re-automation.';
                try {
                    jira_post_comment({ key: ticketKey, comment: 'h3. ❌ Test Rework Setup Failed\n\n' + err });
                    jira_move_to_status({ key: ticketKey, statusName: 'Backlog' });
                } catch (e) {}
                return { success: false, error: err };
            }

            // Branch exists — ALWAYS checkout first so CLI runs on correct branch
            // (critical: CLI always runs regardless of preCliJSAction return value)
            try {
                gh.checkoutPRBranch(testBranchName);
                console.log('✅ Checked out branch:', testBranchName);
            } catch (e) {
                console.warn('Could not checkout branch (will try fetch+checkout):', e);
                try {
                    cli_execute_command({ command: 'git fetch origin ' + testBranchName + ':' + testBranchName });
                    cli_execute_command({ command: 'git checkout ' + testBranchName });
                    console.log('✅ Checked out branch via fetch:', testBranchName);
                } catch (e2) {
                    console.warn('Branch checkout failed:', e2);
                }
            }

            // Use gh api --input JSON to avoid shell quoting issues with title special chars
            console.log('Creating PR for rework from existing branch...');
            try {
                const ticket = jira_get_ticket({ key: ticketKey });
                const summary = ticket && ticket.fields ? (ticket.fields.summary || ticketKey) : ticketKey;
                const prTitle = configLoader.formatTemplate(config.formats.prTitle.rework, {ticketKey: ticketKey, ticketSummary: summary});

                const prData = JSON.stringify({
                    title: prTitle,
                    body: 'Auto-created PR for rework of test automation.\n\nTicket: ' + ticketKey,
                    head: testBranchName,
                    base: config.git.baseBranch
                });
                file_write({ path: 'pr_create_' + ticketKey + '.json', content: prData });

                const createOutput = cli_execute_command({
                    command: 'gh api repos/' + repoInfo.owner + '/' + repoInfo.repo + '/pulls --input pr_create_' + ticketKey + '.json'
                }) || '';

                console.log('gh api pr create output length:', createOutput.length);

                var prJson;
                try { prJson = JSON.parse(createOutput); } catch (e) { prJson = null; }
                const prNum = prJson && prJson.number;
                const prUrl = prJson && prJson.html_url;

                if (!prNum) {
                    throw new Error('Could not parse PR from API response: ' + createOutput.substring(0, 300));
                }

                console.log('✅ Created new PR #' + prNum + ' for rework');
                pr = { number: prNum, html_url: prUrl, head: { ref: testBranchName } };
            } catch (createErr) {
                // PR creation failed — CLI is already on correct branch, postTestReworkResults will create PR
                console.warn('PR auto-creation failed (CLI will run on correct branch, PR will be created post-rework):', createErr.toString());
                try {
                    jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ PR Auto-Creation Warning\n\nBranch {code}' + testBranchName + '{code} is checked out and rework will proceed.\nA PR will be created automatically after rework completes.\n\nError: ' + createErr.toString() });
                } catch (e) {}

                // Write minimal context so CLI knows what to do
                try {
                    const ticket2 = jira_get_ticket({ key: ticketKey });
                    const summary2 = ticket2 && ticket2.fields ? (ticket2.fields.summary || '') : '';
                    gh.writePRContext(inputFolder, { number: 0, title: ticketKey + ' ' + summary2, html_url: '' }, '', 'No PR exists yet — re-run tests from scratch on this branch.', []);
                } catch (e) { console.warn('Could not write fallback context:', e); }

                return { success: true, branchName: testBranchName, prNumber: null, noPR: true };
            }
        }

        // Step 3: PR details
        const prDetails = gh.getPRDetails(scm, pr.number);
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
        const baseBranch = prDetails.base ? prDetails.base.ref : config.git.baseBranch;

        // Step 4.5: Merge base branch and detect conflicts
        const conflictFiles = gh.detectMergeConflicts(baseBranch, inputFolder);

        const diff = gh.getPRDiff(baseBranch, branchName);

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(scm, pr.number);

        // Step 6: Write context files
        gh.writePRContext(inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);

        // Step 7: Fetch question subtasks with answers (extra context)
        try {
            fetchQuestionsToInput.action(actualParams);
        } catch (e) {
            console.warn('Failed to fetch questions (non-fatal):', e);
        }

        // Step 7b: Fetch linked bugs (with fix comments) — rework agent needs to know
        // HOW the bug was fixed (timing, delays) so the test properly accounts for it
        try {
            fetchLinkedBugsToInput.action(actualParams);
        } catch (e) {
            console.warn('Failed to fetch linked bugs (non-fatal):', e);
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
