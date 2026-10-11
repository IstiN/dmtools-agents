/**
 * Pre-CLI Knowledge Update Setup Action (preCliJSAction for pr_knowledge_update agent)
 *
 * Prepares input context so a CLI agent can distill review-thread pain points
 * from a merged PR/MR into a self-curated, repo-specific knowledge base —
 * without any repo-specific or tracker-specific logic living here. See
 * agents/instructions/knowledge_update/ for the generic read/write protocol
 * the CLI agent follows.
 *
 * This job is intentionally NOT bound to a ticket/tracker. It is driven purely
 * by customParams, so it can be:
 *   - run standalone against any already-merged PR/MR to backfill a knowledge
 *     base in bulk (e.g. looping over a list of historical PR numbers), or
 *   - wired to whatever "PR merged" trigger a project chooses (a webhook, a
 *     scheduled scan of recently-merged PRs, a manual one-off invocation,
 *     etc.) — that trigger mechanism is deliberately out of scope here.
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
 * customParams.knowledgeRepoDir (also optional) names a SEPARATE
 * knowledge-hosting repository checked out inside the workspace (e.g. a shared
 * memory repo cloned under dependencies/ via .dmtools/repositories.json). When
 * set, the agent-facing target path becomes <knowledgeRepoDir>/<knowledgeDir>
 * and the pushKnowledgeUpdate post-action scopes all git commands to that
 * repository via `git -C`, so knowledge branches are pushed to the memory
 * repo's origin — never to the outer working repo.
 *
 * When knowledgeDir IS configured, one of three input modes is used (checked
 * in this order):
 *
 *   1. Direct content (customParams.diffText and/or customParams.discussionsMarkdown
 *      already provided) — no SCM calls at all. Use this to feed the agent
 *      diff-only or conversations-only material gathered by some external
 *      process (e.g. a bulk-export script, or a PR whose head branch/API
 *      access is no longer available).
 *
 *   2. Direct PR/MR reference (customParams.prNumber) — fetches PR details,
 *      diff text, and discussions straight from the SCM API for that single
 *      PR/MR number. This is the primary way to run this job standalone,
 *      e.g. `dmtools run pr_knowledge_update.json --customParams
 *      '{"knowledgeDir":"...","prNumber":"123"}'`, including in a loop over
 *      many historical PR numbers to backfill a knowledge base quickly.
 *
 *   3. Ticket-based (only if this action is invoked with a ticket in context,
 *      e.g. params.ticket) — finds the most recently MERGED PR/MR for that
 *      ticket via findMergedPRForTicket(). Kept for projects that prefer to
 *      drive this from their own ticket-status automation.
 *
 * In every mode, diff text and discussions are each optional on their own —
 * a PR with no review comments (diff-only) or a PR whose diff could not be
 * fetched (discussions-only) both still produce useful, if narrower, context.
 * Only the total absence of both is treated as "nothing to learn from".
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

/**
 * Path the CLI agent should read/write, relative to its working directory.
 * When customParams.knowledgeRepoDir names a separate knowledge-hosting repo
 * checked out inside the workspace (e.g. a shared memory repo under
 * dependencies/ from .dmtools/repositories.json), the agent-facing path is
 * <knowledgeRepoDir>/<knowledgeDir>; the post-action scopes git to that repo.
 */
function agentKnowledgePath(customParams) {
    var repoDir = customParams.knowledgeRepoDir;
    return repoDir ? repoDir + '/' + customParams.knowledgeDir : customParams.knowledgeDir;
}

function writeTaskMarker(inputFolder, knowledgeDir, prDetails) {
    var prLine = prDetails && prDetails.number
        ? 'Source PR/MR: [#' + prDetails.number + '](' + (prDetails.html_url || 'unknown') + ')\n\n'
        : 'Source PR/MR: unknown (content supplied directly, no PR reference available)\n\n';

    file_write({
        path: inputFolder + '/knowledge_task.md',
        content: '# Knowledge Update Task\n\n' + prLine +
            'Target knowledge directory (relative to your current working directory): `' +
            knowledgeDir + '`\n\n' +
            'Follow the read/write protocol described in your instructions to distill ' +
            'generalized heuristics from pr_discussions.md and/or pr_diff.txt (either may be ' +
            'absent — work with whichever is available) into that directory. Do not invent a ' +
            'different location.\n'
    });
}

/**
 * Resolves how to source PR context, in priority order:
 * direct content > direct PR reference > ticket-based lookup.
 *
 * Returns { prDetails, diffText, discussionsMarkdown, discussionsRaw } or null
 * if nothing usable could be resolved (caller writes the no-op marker).
 */
function resolvePrContext(scm, customParams, ticketKey) {
    // Mode 1: direct content — fully offline, no SCM calls.
    if (customParams.diffText || customParams.discussionsMarkdown) {
        console.log('Knowledge update: using directly supplied diff/discussions content (no SCM calls).');
        var directPr = {
            number: customParams.prNumber || null,
            html_url: customParams.prUrl || null,
            title: customParams.prTitle || null,
            state: 'merged'
        };
        return {
            prDetails: directPr,
            diffText: customParams.diffText || null,
            discussionsMarkdown: customParams.discussionsMarkdown || null,
            discussionsRaw: null
        };
    }

    // Mode 2: direct PR/MR reference — the primary standalone/backfill entry point.
    if (customParams.prNumber) {
        console.log('Knowledge update: resolving PR/MR #' + customParams.prNumber + ' directly.');
        var prByNumber = gh.getPRDetails(scm, customParams.prNumber);
        if (!prByNumber) {
            console.warn('Could not fetch PR/MR #' + customParams.prNumber + ' — skipping.');
            return null;
        }
        return fetchDiffAndDiscussions(scm, prByNumber);
    }

    // Mode 3: ticket-based — only when this action happens to be invoked with a ticket.
    if (ticketKey) {
        console.log('Knowledge update: resolving merged PR/MR for ticket', ticketKey, '.');
        var prByTicket = gh.findMergedPRForTicket(scm, ticketKey);
        if (!prByTicket) {
            console.warn('No merged PR found for ticket', ticketKey, '— skipping.');
            return null;
        }
        var prDetails = gh.getPRDetails(scm, prByTicket.number) || prByTicket;
        return fetchDiffAndDiscussions(scm, prDetails);
    }

    return null;
}

function fetchDiffAndDiscussions(scm, prDetails) {
    var diffText = null;
    if (typeof scm.getDiffText === 'function') {
        diffText = scm.getDiffText(prDetails.number);
    }
    if (!diffText) {
        console.warn('Diff text unavailable for PR #' + prDetails.number + ' — proceeding with discussions only (if any).');
    }

    console.log('Fetching discussions for PR/MR #' + prDetails.number + '...');
    var discussionData = gh.fetchDiscussionsAndRawData(scm, prDetails.number) || {};

    return {
        prDetails: prDetails,
        diffText: diffText,
        discussionsMarkdown: discussionData.markdown || null,
        discussionsRaw: discussionData.rawThreads || null
    };
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var inputFolder = actualParams.inputFolderPath;
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams || {};
        var ticketKey = actualParams.ticket ? (actualParams.ticket.key || actualParams.ticket) : (customParams.ticket || null);

        console.log('=== Knowledge update setup ===');

        var knowledgeDir = customParams.knowledgeDir;
        if (!knowledgeDir) {
            console.log('No customParams.knowledgeDir configured for this repo — skipping (no-op).');
            writeNoOpMarker(inputFolder,
                'This repo has not configured `customParams.knowledgeDir`, so there is no ' +
                'review-knowledge base to update yet.');
            return { success: true, skipped: true, reason: 'knowledgeDir not configured' };
        }

        var hasDirectContent = !!(customParams.diffText || customParams.discussionsMarkdown);
        var scm = hasDirectContent ? null : configLoader.createScm(config);

        var resolved = resolvePrContext(scm, customParams, ticketKey);
        if (!resolved) {
            writeNoOpMarker(inputFolder,
                'No PR/MR context could be resolved. Provide `customParams.prNumber` (direct ' +
                'backfill run), `customParams.diffText`/`discussionsMarkdown` (direct content), ' +
                'or invoke this action with a ticket in context.');
            return { success: true, skipped: true, reason: 'no PR context resolved' };
        }

        if (!resolved.diffText && !resolved.discussionsMarkdown) {
            console.warn('Neither diff nor discussions could be obtained — nothing to learn from.');
            writeNoOpMarker(inputFolder,
                'Both the diff and the discussions were unavailable for this PR/MR — there is ' +
                'nothing to distill.');
            return { success: true, skipped: true, reason: 'no diff or discussions available' };
        }

        var prDetailsForContext = resolved.prDetails || {};
        var agentPath = agentKnowledgePath(customParams);
        gh.writePRContext(inputFolder, prDetailsForContext, resolved.diffText, resolved.discussionsMarkdown, resolved.discussionsRaw);
        writeTaskMarker(inputFolder, agentPath, resolved.prDetails);

        console.log('✅ Knowledge update setup complete — target:', agentPath);

        return {
            success: true,
            prNumber: prDetailsForContext.number || null,
            prUrl: prDetailsForContext.html_url || null,
            knowledgeDir: knowledgeDir,
            knowledgeRepoDir: customParams.knowledgeRepoDir || null,
            agentKnowledgePath: agentPath
        };

    } catch (error) {
        console.error('❌ Error in preCliKnowledgeUpdateSetup:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, writeNoOpMarker, resolvePrContext, agentKnowledgePath };
}
