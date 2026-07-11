/**
 * Timer JS Action — Auto-commit, push, and save session artefacts
 *
 * Executed periodically (every timerIntervalSeconds) while CLI commands run.
 * Ensures code changes are never lost even if the runner crashes.
 *
 * Actions performed on each tick:
 * 1. If there are uncommitted changes in targetRepository workingDir → commit + push
 * 2. If there is accumulated CLI output → save a snapshot as a release asset
 *    (GitHub or GitLab, resolved from config.scm.provider / customParams.scmProvider)
 *
 * params available:
 *   params.currentCliOutput — accumulated CLI stdout so far
 *   params.jobParams.customParams — agent config customParams
 *   params.ticket — current ticket object (key, fields, etc.)
 *   params.jobParams.metadata.contextId — agent name (e.g. "sf_story_development")
 */

var releaseArtefacts = require('./common/releaseArtefacts.js');
var configLoader = require('./configLoader.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) ||
           params.customParams ||
           {};
}

function getTicketKey(params) {
    if (params.ticket && params.ticket.key) return params.ticket.key;
    if (params.ticketKey) return params.ticketKey;
    return null;
}

function getContextId(params) {
    var metadata = (params.jobParams && params.jobParams.metadata) || {};
    return metadata.contextId || 'unknown_agent';
}

/**
 * Auto-commit and push any uncommitted changes in the target repo working dir.
 * Returns true if a commit was made.
 */
function autoCommitAndPush(customParams, ticketKey) {
    var targetRepo = customParams.targetRepository;
    if (!targetRepo || !targetRepo.workingDir) {
        return false;
    }

    var workingDir = targetRepo.workingDir;

    // Safety net: never auto-commit/push while sitting on the base branch
    // (develop/main/...). If setup failed to switch onto the ticket branch
    // (e.g. checkout error, missing PR), HEAD stays on baseBranch — pushing
    // WIP snapshots there would land straight in the mainline history instead
    // of the intended ticket branch.
    if (targetRepo.baseBranch) {
        var currentBranch;
        try {
            currentBranch = cli_execute_command({
                command: 'git rev-parse --abbrev-ref HEAD',
                workingDirectory: workingDir
            });
        } catch (e) {
            console.log('⏱️ timer: could not determine current branch, skipping:', e.toString().substring(0, 100));
            return false;
        }
        if (currentBranch && cleanCommandOutput(currentBranch) === targetRepo.baseBranch) {
            console.warn('⏱️ timer: HEAD is on base branch "' + targetRepo.baseBranch +
                '" — refusing to auto-commit/push (branch setup likely failed)');
            return false;
        }
    }

    // Check for changes using git status
    var statusOutput;
    try {
        statusOutput = cli_execute_command({
            command: 'git status --porcelain',
            workingDirectory: workingDir
        });
    } catch (e) {
        console.log('⏱️ timer: git status failed:', e.toString().substring(0, 100));
        return false;
    }

    if (!statusOutput || !statusOutput.trim()) {
        return false;
    }

    // There are changes — commit and push
    var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    var commitMsg = ticketKey + ' WIP auto-save ' + timestamp;

    try {
        cli_execute_command({
            command: 'git rm -r --ignore-unmatch .dmtools/copilot-sessions',
            workingDirectory: workingDir
        });
    } catch (cleanupErr) {
        console.log('⏱️ timer: session cache cleanup skipped:', cleanupErr.toString().substring(0, 100));
    }

    try {
        cli_execute_command({
            command: 'git add -A -- ":!.dmtools/copilot-sessions" ":!.dmtools/copilot-sessions/**"',
            workingDirectory: workingDir
        });
    } catch (e) {
        console.error('⏱️ timer: git add failed:', e.toString().substring(0, 100));
        return false;
    }

    try {
        cli_execute_command({
            command: 'git commit -m "' + commitMsg + '"',
            workingDirectory: workingDir
        });
    } catch (e) {
        // Could be "nothing to commit" after add
        console.log('⏱️ timer: git commit:', e.toString().substring(0, 100));
        return false;
    }

    try {
        cli_execute_command({
            command: 'git push origin HEAD',
            workingDirectory: workingDir
        });
        console.log('⏱️ timer: ✅ auto-committed and pushed: ' + commitMsg);
        return true;
    } catch (e) {
        console.error('⏱️ timer: git push failed:', e.toString().substring(0, 100));
        return false;
    }
}

/**
 * Save CLI output snapshot to releases as an artefact.
 * The asset name includes the agent contextId to distinguish between agents.
 *
 * Uses working-dir-relative paths (FileTools blocks /tmp/ as path traversal).
 * Uploads .log directly — no zip needed (timer doesn't inherit CLI_ALLOWED_COMMANDS,
 * so `zip` is not in whitelist; raw .log upload is simpler and sufficient).
 */
function saveSessionArtefact(params, customParams, ticketKey, contextId, currentCliOutput) {
    var artefactRepo = releaseArtefacts.resolveArtefactRepository(customParams);
    if (!artefactRepo) {
        return;
    }

    if (!currentCliOutput || !currentCliOutput.trim()) {
        return;
    }

    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var scmProvider = (projectConfig.scm && projectConfig.scm.provider) || 'github';

    var assetName = contextId + '-session.log';
    var tagTemplate = customParams.cacheToReleases && customParams.cacheToReleases.releaseTagTemplate;
    var nameTemplate = customParams.cacheToReleases && customParams.cacheToReleases.releaseNameTemplate;

    var tag = releaseArtefacts.buildTag(ticketKey, tagTemplate);
    var releaseConfig = { tagTemplate: tagTemplate, nameTemplate: nameTemplate };

    // Write to working dir (FileTools blocks /tmp/ paths)
    var outputFile = '.dmtools-session-output.log';

    var snapshotTimestamp = new Date().toISOString();
    var snapshotHeader = '=== ⏱️ TIMER SESSION SNAPSHOT START (saved at ' + snapshotTimestamp + ') ===\n' +
                         '=== This is a periodic snapshot of the running agent output, NOT a new agent run ===\n\n';
    var snapshotFooter = '\n\n=== ⏱️ TIMER SESSION SNAPSHOT END ===\n';

    try {
        file_write({ path: outputFile, content: snapshotHeader + currentCliOutput + snapshotFooter });
    } catch (e) {
        console.error('⏱️ timer: failed to write CLI output file:', e.toString().substring(0, 100));
        return;
    }

    // Upload .log directly to release (no zip, no CLI commands needed)
    var result = releaseArtefacts.uploadRawFile(
        artefactRepo.owner, artefactRepo.repo, ticketKey, releaseConfig, outputFile, assetName, scmProvider
    );
    if (result.success) {
        console.log('⏱️ timer: ✅ session saved: ' + assetName + ' → ' + tag + ' (' + scmProvider + ')');
    } else {
        console.error('⏱️ timer: session upload failed:', String(result.error).substring(0, 150));
    }

    // Cleanup
    try { file_delete({ path: outputFile }); } catch (e) { /* ignore */ }
}

/**
 * Main timer action entry point.
 */
function action(params) {
    var customParams = resolveCustomParams(params);
    var ticketKey = getTicketKey(params);
    var contextId = getContextId(params);
    var currentCliOutput = params.currentCliOutput || '';

    if (!ticketKey) {
        console.log('⏱️ timer: no ticketKey available, skipping');
        return;
    }

    // 1. Auto-commit and push changes
    autoCommitAndPush(customParams, ticketKey);

    // 2. Save currentCliOutput to releases as session artefact
    saveSessionArtefact(params, customParams, ticketKey, contextId, currentCliOutput);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
