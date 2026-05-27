/**
 * Release Artefacts Helper
 *
 * Core utilities for caching and restoring folders as GitHub Release assets.
 *
 * One release per ticket, multiple named assets inside:
 *   release tag:   ai-{ticketKey}              e.g. ai-proj-123
 *   release name:  [AI] [PROJ-123] Artefacts
 *   asset names:   copilot-session.zip, agent-outputs.zip, ...
 *
 * Both the tag and release name are fully customizable via templates in customParams:
 *   releaseTagTemplate:  "ai-{ticketKey}"               (default)
 *   releaseNameTemplate: "[AI] [{ticketKey}] Artefacts"  (default)
 *
 * Used by:
 *   - agents/js/cacheToReleases.js  (postJSAction)
 *   - agents/js/restoreFromReleases.js (preJSAction)
 */

var DEFAULT_TAG_TEMPLATE  = 'ai-{ticketKey}';
var DEFAULT_NAME_TEMPLATE = '[AI] [{ticketKey}] Artefacts';

/**
 * Resolve a template string, replacing {ticketKey} with the actual key.
 * @param {string} template
 * @param {string} ticketKey
 * @returns {string}
 */
function resolveTemplate(template, ticketKey) {
    if (!template) return template;
    return template.replace(/\{ticketKey\}/g, ticketKey);
}

/**
 * Build the GitHub release tag from an optional template.
 * @param {string} ticketKey
 * @param {string} [tagTemplate]  defaults to "ai-{ticketKey}"
 * @returns {string}
 */
function buildTag(ticketKey, tagTemplate) {
    var tag = resolveTemplate(tagTemplate || DEFAULT_TAG_TEMPLATE, ticketKey);
    return tag.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
}

/**
 * Build the human-readable GitHub release name from an optional template.
 * @param {string} ticketKey
 * @param {string} [nameTemplate]  defaults to "[AI] [{ticketKey}] Artefacts"
 * @returns {string}
 */
function buildReleaseName(ticketKey, nameTemplate) {
    return resolveTemplate(nameTemplate || DEFAULT_NAME_TEMPLATE, ticketKey);
}

/**
 * Resolve {ticketKey} template token in a folder path.
 * @param {string} template   e.g. ".copilot/session-state/{ticketKey}"
 * @param {string} ticketKey  e.g. "PROJ-123"
 * @returns {string}
 */
function resolveTemplate(template, ticketKey) {
    if (!template) return template;
    return template.replace(/\{ticketKey\}/g, ticketKey);
}

/**
 * Zip a folder to a temp file.
 * @param {string} folderPath   Source folder (may contain template tokens already resolved)
 * @param {string} assetName    Used as the zip filename (e.g. "copilot-session")
 * @returns {string|null}       Absolute path to the created zip, or null on failure
 */
function zipFolder(folderPath, assetName) {
    var safeName = assetName.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    var zipPath = '/tmp/' + safeName + '.zip';

    try {
        // Remove stale zip if present
        try { file_delete({ path: zipPath }); } catch (e) { /* ignore */ }

        var output = cli_execute_command({
            command: 'bash -c "zip -r ' + zipPath + ' ' + folderPath + '"'
        }) || '';

        // Verify the zip was actually created (ls is whitelisted, throws if not found)
        try {
            cli_execute_command({ command: 'ls ' + zipPath });
        } catch (verifyErr) {
            console.error('zip command ran but file not found at:', zipPath, 'output:', output.substring(0, 200));
            return null;
        }
        console.log('✅ Zipped', folderPath, '→', zipPath);
        return zipPath;
    } catch (e) {
        console.error('Failed to zip folder', folderPath, ':', e);
        return null;
    }
}

/**
 * Unzip a file into a destination folder (creates folder if needed).
 * @param {string} zipPath
 * @param {string} destFolder
 * @returns {boolean}
 */
function unzipTo(zipPath, destFolder) {
    try {
        cli_execute_command({ command: 'bash -c "mkdir -p ' + destFolder + '"' });
        cli_execute_command({ command: 'bash -c "unzip -o ' + zipPath + ' -d ' + destFolder + '"' });
        console.log('✅ Unzipped', zipPath, '→', destFolder);
        return true;
    } catch (e) {
        console.error('Failed to unzip', zipPath, 'into', destFolder, ':', e);
        return false;
    }
}

/**
 * Upload a folder as a named asset inside a shared GitHub Release for the ticket.
 *
 * Steps:
 *   1. Zip the folder → /tmp/{assetName}.zip
 *   2. Find or create the shared draft release (tag/name from releaseConfig)
 *   3. Upload zip as asset named "{asset.name}.zip"
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ticketKey
 * @param {Object} releaseConfig  { tagTemplate?: string, nameTemplate?: string }
 * @param {Object} asset          { fromFolder: string, name: string }
 * @returns {{ success: boolean, releaseUrl: string|null, assetUrl: string|null, error: string|null }}
 */
function uploadArtefact(owner, repo, ticketKey, releaseConfig, asset) {
    var folderPath = resolveTemplate(asset.fromFolder, ticketKey);
    var assetName  = asset.name;
    var assetFile  = assetName + '.zip';
    var tag        = buildTag(ticketKey, releaseConfig.tagTemplate);
    var relName    = buildReleaseName(ticketKey, releaseConfig.nameTemplate);

    console.log('📦 Caching "' + assetName + '" from', folderPath, '→ release', tag, '/', assetFile);

    // Check folder exists (ls is whitelisted, throws if path not found)
    try {
        cli_execute_command({ command: 'ls ' + folderPath });
    } catch (e) {
        console.warn('⚠️  Folder does not exist, skipping cache:', folderPath);
        return { success: false, error: 'Folder not found: ' + folderPath };
    }

    var zipPath = zipFolder(folderPath, assetName);
    if (!zipPath) {
        return { success: false, error: 'Failed to zip folder: ' + folderPath };
    }

    try {
        var releaseJson = github_get_or_create_draft_release({
            workspace:   owner,
            repository:  repo,
            tagName:     tag,
            releaseName: relName,
            body:        'AI Artefact storage for ticket ' + ticketKey
        });
        var release    = typeof releaseJson === 'string' ? JSON.parse(releaseJson) : releaseJson;
        var releaseId  = String(release.id);
        var releaseUrl = release.html_url || null;

        console.log('📌 Release id:', releaseId, 'url:', releaseUrl);

        // overwrite: "true" replaces any existing asset with the same name (added in dmtools PR #221)
        var assetJson = github_upload_release_asset({
            workspace:   owner,
            repository:  repo,
            releaseId:   releaseId,
            filePath:    zipPath,
            assetName:   assetFile,
            contentType: 'application/zip',
            overwrite:   'true'
        });
        var assetResult = typeof assetJson === 'string' ? JSON.parse(assetJson) : assetJson;
        var assetUrl    = (assetResult && assetResult.browser_download_url) || null;

        console.log('✅ Uploaded "' + assetFile + '" to release', tag, '(overwrite: replaced if existed)');
        return { success: true, releaseUrl: releaseUrl, assetUrl: assetUrl, error: null };

    } catch (e) {
        console.error('Failed to upload "' + assetFile + '":', e);
        return { success: false, releaseUrl: null, assetUrl: null, error: String(e) };
    } finally {
        try { file_delete({ path: zipPath }); } catch (e2) { /* ignore */ }
    }
}

/**
 * Download a named asset from the shared ticket GitHub Release and restore it.
 *
 * Steps:
 *   1. Find or create the shared draft release (if none → skip silently, first run)
 *   2. Download specific asset "{asset.name}.zip" via gh CLI
 *   3. Unzip to toFolder
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ticketKey
 * @param {Object} releaseConfig  { tagTemplate?: string, nameTemplate?: string }
 * @param {Object} asset          { name: string, toFolder: string }
 * @returns {{ success: boolean, restored: boolean, error: string|null }}
 */
function downloadArtefact(owner, repo, ticketKey, releaseConfig, asset) {
    var toFolder  = resolveTemplate(asset.toFolder, ticketKey);
    var assetName = asset.name;
    var assetFile = assetName + '.zip';
    var tag       = buildTag(ticketKey, releaseConfig.tagTemplate);
    var zipPath   = '/tmp/' + assetName.toLowerCase().replace(/[^a-z0-9._-]/g, '-') + '-restore.zip';

    console.log('🔄 Restoring "' + assetName + '" from release', tag, '→', toFolder);

    try {
        // Find existing release — if it has no assets, this is the first run
        var releaseJson = github_get_or_create_draft_release({
            workspace:   owner,
            repository:  repo,
            tagName:     tag,
            releaseName: buildReleaseName(ticketKey, releaseConfig.nameTemplate),
            body:        'AI Artefact storage for ticket ' + ticketKey
        });
        var release    = typeof releaseJson === 'string' ? JSON.parse(releaseJson) : releaseJson;
        var assets     = (release.assets && Array.isArray(release.assets)) ? release.assets : [];

        // Check if the specific asset we need actually exists
        var assetExists = assets.some(function(a) { return a.name === assetFile; });
        if (!assetExists) {
            console.log('ℹ️  Asset "' + assetFile + '" not in release "' + tag + '" — skipping restore (first run or not cached)');
            return { success: true, restored: false, error: null };
        }

        // Download the specific asset by name
        try { file_delete({ path: zipPath }); } catch (e) { /* ignore */ }

        cli_execute_command({
            command: 'gh release download ' + tag +
                     ' --repo ' + owner + '/' + repo +
                     ' --pattern "' + assetFile + '"' +
                     ' --output ' + zipPath +
                     ' --clobber'
        });

        // Verify download produced a file (ls throws if not found)
        try {
            cli_execute_command({ command: 'ls ' + zipPath });
        } catch (lsErr) {
            return { success: false, restored: false, error: 'Download produced no file at ' + zipPath };
        }

        var unzipOk = unzipTo(zipPath, toFolder);
        return { success: unzipOk, restored: unzipOk, error: unzipOk ? null : 'Unzip failed' };

    } catch (e) {
        var errStr = String(e);
        if (errStr.indexOf('404') !== -1 || errStr.indexOf('Not Found') !== -1 ||
            errStr.indexOf('release not found') !== -1) {
            console.log('ℹ️  No existing release "' + tag + '" — skipping restore (first run)');
            return { success: true, restored: false, error: null };
        }
        console.error('Failed to restore "' + assetName + '":', e);
        return { success: false, restored: false, error: errStr };
    } finally {
        try { file_delete({ path: zipPath }); } catch (e2) { /* ignore */ }
    }
}

/**
 * Extract artefactRepository config from customParams.
 * Falls back to aiRepository if artefactRepository is not set.
 * @param {Object} customParams
 * @returns {{ owner: string, repo: string }|null}
 */
function resolveArtefactRepository(customParams) {
    if (!customParams) return null;
    var repo = customParams.artefactRepository || customParams.aiRepository || customParams.targetRepository;
    if (!repo || !repo.owner || !repo.repo) return null;
    return { owner: repo.owner, repo: repo.repo };
}

module.exports = {
    buildTag: buildTag,
    buildReleaseName: buildReleaseName,
    resolveTemplate: resolveTemplate,
    zipFolder: zipFolder,
    unzipTo: unzipTo,
    uploadArtefact: uploadArtefact,
    downloadArtefact: downloadArtefact,
    resolveArtefactRepository: resolveArtefactRepository
};
