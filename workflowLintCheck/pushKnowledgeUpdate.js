/**
 * Push Knowledge Update Post-Action (postJSAction for pr_knowledge_update agent)
 *
 * Commits and pushes whatever the CLI agent changed under customParams.knowledgeDir
 * — the ONLY repo-specific piece of config this action reads, same as its
 * preCliJSAction counterpart (preCliKnowledgeUpdateSetup.js). Fully generic
 * otherwise: no knowledge of any particular repo's directory layout or content,
 * and no dependency on a ticket/tracker — this job is driven purely by
 * customParams (see preCliKnowledgeUpdateSetup.js), so the branch name is
 * derived from customParams.prNumber (or a timestamp when no PR number is
 * available, e.g. a direct-content-only run) instead of a ticket key.
 *
 * Behavior:
 * - If knowledgeDir isn't configured, or the CLI agent made no changes under it
 *   (e.g. it correctly no-op'd per knowledge_task.md), this is a silent no-op.
 * - Otherwise: commits the changes under knowledgeDir only (nothing else in the
 *   working tree is touched/staged) on a new branch, pushes it, and logs the
 *   compare URL so a human can open a merge/pull request from it. Opening the
 *   MR/PR itself is intentionally left to a human for now — see the write
 *   protocol docs (agents/instructions/knowledge_update/) for why review stays
 *   human-in-the-loop at this stage.
 */

var configLoader = require('./configLoader.js');
const { GIT_CONFIG } = require('./config.js');

function cleanOutput(output) {
    return (output || '').toString().trim();
}

function branchSlugFor(customParams) {
    if (customParams.prNumber) {
        return 'pr-' + String(customParams.prNumber).toLowerCase();
    }
    // No PR reference available (e.g. a direct-content-only run) — fall back to
    // a timestamp so concurrent/repeated runs don't collide on the same branch name.
    var ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    return 'update-' + ts;
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams || {};

        var knowledgeDir = customParams.knowledgeDir;
        if (!knowledgeDir) {
            console.log('pushKnowledgeUpdate: no customParams.knowledgeDir configured — nothing to push.');
            return { success: true, skipped: true };
        }

        var status = cleanOutput(cli_execute_command({ command: 'git status --porcelain -- "' + knowledgeDir + '"' }));
        if (!status) {
            console.log('pushKnowledgeUpdate: no changes under', knowledgeDir, '— nothing to push.');
            return { success: true, skipped: true };
        }

        console.log('pushKnowledgeUpdate: detected changes under', knowledgeDir, ':\n' + status);

        cli_execute_command({ command: 'git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"' });
        cli_execute_command({ command: 'git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"' });

        var slug = branchSlugFor(customParams);
        var branchName = 'knowledge/' + slug + '-review-lessons';
        var commitSubject = customParams.prNumber
            ? 'knowledge(pr-' + customParams.prNumber + '): distill review lessons from merged PR'
            : 'knowledge: distill review lessons';

        cli_execute_command({ command: 'git checkout -b "' + branchName + '"' });
        cli_execute_command({ command: 'git add -- "' + knowledgeDir + '"' });
        cli_execute_command({ command: 'git commit -m "' + commitSubject + '"' });

        var pushOutput = cleanOutput(cli_execute_command({ command: 'git push -u origin "' + branchName + '"' }));
        console.log('pushKnowledgeUpdate: pushed branch', branchName);
        console.log(pushOutput);

        return { success: true, branchName: branchName, knowledgeDir: knowledgeDir };

    } catch (error) {
        console.error('❌ Error in pushKnowledgeUpdate:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
