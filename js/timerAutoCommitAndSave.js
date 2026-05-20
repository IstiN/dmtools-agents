/**
 * Timer JS Action — Auto-commit, push, and save session artefacts
 *
 * Executed periodically (every timerIntervalSeconds) while CLI commands run.
 * Ensures code changes are never lost even if the runner crashes.
 *
 * Actions performed on each tick:
 * 1. If there are uncommitted changes in targetRepository workingDir → commit + push
 * 2. If copilot session folder exists → zip and upload to releases
 *
 * params available:
 *   params.currentCliOutput — accumulated CLI stdout so far
 *   params.jobParams.customParams — agent config customParams
 *   params.ticket — current ticket object (key, fields, etc.)
 *   params.jobParams.metadata.contextId — agent name (e.g. "sf_story_development")
 */

var releaseArtefacts = require('./common/releaseArtefacts.js');

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
            command: 'git add -A',
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
            command: 'git push',
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
 * Uses working-dir-relative paths (FileTools blocks /tmp/ as path traversal)
 * and git-based zip (always whitelisted) to avoid CLI_ALLOWED_COMMANDS issues.
 */
function saveSessionArtefact(customParams, ticketKey, contextId, currentCliOutput) {
    var artefactRepo = releaseArtefacts.resolveArtefactRepository(customParams);
    if (!artefactRepo) {
        return;
    }

    if (!currentCliOutput || !currentCliOutput.trim()) {
        return;
    }

    var assetName = contextId + '-session';
    var tagTemplate = customParams.cacheToReleases && customParams.cacheToReleases.releaseTagTemplate;
    var nameTemplate = customParams.cacheToReleases && customParams.cacheToReleases.releaseNameTemplate;

    var tag = releaseArtefacts.buildTag(ticketKey, tagTemplate);
    var releaseName = releaseArtefacts.buildReleaseName(ticketKey, nameTemplate);

    // Write to working dir (FileTools blocks /tmp/ paths)
    var outputFile = '.dmtools-session-output.log';
    var zipFile = '.dmtools-session.zip';

    try {
        file_write({ path: outputFile, content: currentCliOutput });
    } catch (e) {
        console.error('⏱️ timer: failed to write CLI output file:', e.toString().substring(0, 100));
        return;
    }

    // Use git archive trick or gh to zip — but simplest: upload the .log directly
    // Actually use cli_execute_command with 'zip' which should be available
    try {
        cli_execute_command({ command: 'zip -j ' + zipFile + ' ' + outputFile });
    } catch (e) {
        // zip might not be in whitelist — try uploading the raw .log file instead
        try {
            releaseArtefacts.uploadArtefact(artefactRepo, tag, releaseName, outputFile, assetName + '.log');
            console.log('⏱️ timer: ✅ session saved (raw): ' + assetName + '.log → ' + tag);
        } catch (e2) {
            console.error('⏱️ timer: session upload failed:', e2.toString().substring(0, 150));
        }
        try { file_delete({ path: outputFile }); } catch (e3) { /* ignore */ }
        return;
    }

    // Upload zip to release
    try {
        releaseArtefacts.uploadArtefact(artefactRepo, tag, releaseName, zipFile, assetName + '.zip');
        console.log('⏱️ timer: ✅ session saved: ' + assetName + '.zip → ' + tag);
    } catch (e) {
        console.error('⏱️ timer: session upload failed:', e.toString().substring(0, 150));
    }

    // Cleanup
    try { file_delete({ path: zipFile }); } catch (e) { /* ignore */ }
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
    saveSessionArtefact(customParams, ticketKey, contextId, currentCliOutput);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
