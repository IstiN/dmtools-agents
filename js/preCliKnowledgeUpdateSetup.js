/**
 * Pre-CLI Knowledge Update Setup Action (preCliJSAction for pr_knowledge_update agent)
 *
 * Runs after a ticket reaches a "merged" status. Prepares input context so a
 * CLI agent can distill review-thread pain points from the just-merged PR/MR
 * into a self-curated, repo-specific knowledge base — without any repo-specific
 * logic living here. See agents/instructions/knowledge_update/ for the
 * generic read/write protocol the CLI agent follows.
 *
 * customParams.knowledgeDir is the ONLY repo-specific piece of configuration
 * this action reads, and it is entirely optional: when it is not set (the
 * default in this generic config), this action is a no-op — it writes a
 * knowledge_task.md explaining there is nothing to do, and the CLI agent's
 * instructions tell it to stop immediately on seeing that. This mirrors the
 * existing no-op convention for other optional resolver hooks in this repo
 * (e.g. baseBranchResolverFnPath, snapshotBranchResolverFnPath) — a project
 * that hasn't opted in must never fail or produce noise.
 *
 * When knowledgeDir IS configured:
 * 1. Finds the most recently MERGED PR/MR for the ticket (not open — the
 *    ticket already transitioned to "Merged").
 * 2. Fetches its diff text and review discussions via the PR API (works even
 *    after the head branch was deleted post-merge — no local git checkout of
 *    the target repo is required for this flow).
 * 3. Writes the standard pr_info.md / pr_diff.txt / pr_discussions.md /
 *    pr_discussions_raw.json context files.
 * 4. Writes knowledge_task.md naming the resolved knowledge directory, which
 *    the generic write-protocol prompt reads to know where to read/write
 *    MOC.md + heuristics/*.md.
 */

var configLoader = require('./configLoader.js');
const gh = require('./common/githubHelpers.js');

function writeNoOpMarker(inputFolder, reason) {
    file_write({
        path: inputFolder + '/knowledge_task.md',
        content: '# Knowledge Update — nothing to do\n\n' + reason +
            '\n\nDo NOT read or modify any knowledge/ directory this run. Stop after ' +
            'confirming this file says so; do not attempt to find one yourself.\n'
    });
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var inputFolder = actualParams.inputFolderPath;
        var ticketKey = inputFolder.split('/').pop();
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams || {};

        console.log('=== Knowledge update setup for:', ticketKey, '===');

        var knowledgeDir = customParams.knowledgeDir;
        if (!knowledgeDir) {
            console.log('No customParams.knowledgeDir configured for this repo — skipping (no-op).');
            writeNoOpMarker(inputFolder,
                'This repo has not configured `customParams.knowledgeDir`, so there is no ' +
                'review-knowledge base to update yet.');
            return { success: true, skipped: true, reason: 'knowledgeDir not configured' };
        }

        var scm = configLoader.createScm(config);

        var pr = gh.findMergedPRForTicket(scm, ticketKey);
        if (!pr) {
            console.warn('No merged PR found for ticket', ticketKey, '— skipping.');
            writeNoOpMarker(inputFolder,
                'No merged Pull Request / Merge Request could be found for ' + ticketKey + '.');
            return { success: true, skipped: true, reason: 'no merged PR found' };
        }

        var prDetails = gh.getPRDetails(scm, pr.number) || pr;

        var diffText = null;
        if (typeof scm.getDiffText === 'function') {
            diffText = scm.getDiffText(pr.number);
        }
        if (!diffText) {
            console.warn('Diff text unavailable for PR #' + pr.number + ' — proceeding with discussions only.');
        }

        console.log('Fetching PR discussions for merged PR #' + pr.number + '...');
        var discussionData = gh.fetchDiscussionsAndRawData(scm, pr.number) || {};

        gh.writePRContext(inputFolder, prDetails, diffText, discussionData.markdown, discussionData.rawThreads);

        file_write({
            path: inputFolder + '/knowledge_task.md',
            content: '# Knowledge Update Task\n\n' +
                'Ticket: ' + ticketKey + '\n' +
                'Merged PR: [#' + prDetails.number + '](' + prDetails.html_url + ')\n\n' +
                'Target knowledge directory (relative to your current working directory): `' +
                knowledgeDir + '`\n\n' +
                'Follow the read/write protocol described in your instructions to distill ' +
                'generalized heuristics from pr_discussions.md and pr_diff.txt into that ' +
                'directory. Do not invent a different location.\n'
        });

        console.log('✅ Knowledge update setup complete — PR #' + prDetails.number, '| target:', knowledgeDir);

        return {
            success: true,
            prNumber: prDetails.number,
            prUrl: prDetails.html_url,
            knowledgeDir: knowledgeDir
        };

    } catch (error) {
        console.error('❌ Error in preCliKnowledgeUpdateSetup:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, writeNoOpMarker };
}
