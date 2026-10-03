/**
 * Release Artefacts Helper
 *
 * Core utilities for caching and restoring folders as Release assets, on
 * either GitHub or GitLab (pass providerName: 'github' | 'gitlab' to
 * uploadArtefact/downloadArtefact/uploadRawFile; defaults to 'github').
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
 * On GitHub, assets are uploaded natively via the Releases API. On GitLab
 * (which has no direct binary-upload-to-release API), assets are published
 * to the project's Generic Package Registry and attached to the release as
 * an asset link (see dm.ai's gitlab_upload_release_asset /
 * gitlab_get_or_create_release / gitlab_download_release_asset MCP tools).
 *
 * Used by:
 *   - agents/js/cacheToReleases.js      (postJSAction)
 *   - agents/js/restoreFromReleases.js  (preJSAction)
 *   - agents/js/timerAutoCommitAndSave.js (timerJSAction, via uploadRawFile)
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
 * SCM-agnostic release provider abstraction.
 *
 * GitHub has a native "upload binary as release asset" API keyed by numeric
 * releaseId. GitLab has no equivalent — the closest analog is publishing the
 * file to the project's Generic Package Registry and attaching it to the
 * release as an asset link (dm.ai's gitlab_upload_release_asset /
 * gitlab_get_or_create_release / gitlab_download_release_asset MCP tools,
 * added specifically to support this use case). Both providers are
 * normalized here to a common shape so uploadArtefact/downloadArtefact/
 * uploadRawFile don't need to branch on provider themselves.
 */
function _githubReleaseProvider() {
    return {
        name: 'github',
        getOrCreateRelease: function(owner, repo, tag, name, body) {
            var releaseJson = github_get_or_create_draft_release({
                workspace: owner, repository: repo, tagName: tag, releaseName: name, body: body
            });
            var release = typeof releaseJson === 'string' ? JSON.parse(releaseJson) : releaseJson;
            var assets = (release.assets && Array.isArray(release.assets)) ? release.assets : [];
            return {
                tagName: tag,
                releaseId: String(release.id),
                htmlUrl: release.html_url || null,
                assetNames: assets.map(function(a) { return a.name; })
            };
        },
        uploadAsset: function(owner, repo, release, filePath, assetName, contentType) {
            var assetJson = github_upload_release_asset({
                workspace: owner, repository: repo, releaseId: release.releaseId,
                filePath: filePath, assetName: assetName, contentType: contentType, overwrite: 'true'
            });
            var result = typeof assetJson === 'string' ? JSON.parse(assetJson) : assetJson;
            return { url: (result && result.browser_download_url) || null };
        },
        downloadAsset: function(owner, repo, release, assetName, destPath) {
            cli_execute_command({
                command: 'gh release download ' + release.tagName +
                         ' --repo ' + owner + '/' + repo +
                         ' --pattern "' + assetName + '"' +
                         ' --output ' + destPath +
                         ' --clobber'
            });
        }
    };
}

function _gitlabReleaseProvider() {
    return {
        name: 'gitlab',
        getOrCreateRelease: function(owner, repo, tag, name, body) {
            var releaseJson = gitlab_get_or_create_release({
                workspace: owner, repository: repo, tagName: tag, releaseName: name, body: body
            });
            var release = typeof releaseJson === 'string' ? JSON.parse(releaseJson) : releaseJson;
            var links = (release.assets && Array.isArray(release.assets.links)) ? release.assets.links : [];
            return {
                tagName: release.tag_name || tag,
                releaseId: null,
                htmlUrl: (release._links && release._links.self) || null,
                assetNames: links.map(function(l) { return l.name; })
            };
        },
        uploadAsset: function(owner, repo, release, filePath, assetName, contentType) {
            var linkJson = gitlab_upload_release_asset({
                workspace: owner, repository: repo, tagName: release.tagName,
                filePath: filePath, assetName: assetName, contentType: contentType, overwrite: 'true'
            });
            var result = typeof linkJson === 'string' ? JSON.parse(linkJson) : linkJson;
            return { url: (result && result.direct_asset_url) || null };
        },
        downloadAsset: function(owner, repo, release, assetName, destPath) {
            gitlab_download_release_asset({
                workspace: owner, repository: repo, tagName: release.tagName,
                assetName: assetName, targetFilePath: destPath
            });
        }
    };
}

/**
 * @param {string} [providerName]  'github' (default) or 'gitlab'
 */
function _getReleaseProvider(providerName) {
    if (providerName === 'gitlab') return _gitlabReleaseProvider();
    return _githubReleaseProvider();
}

/**
 * Upload a folder as a named asset inside a shared Release for the ticket.
 *
 * Steps:
 *   1. Zip the folder → /tmp/{assetName}.zip
 *   2. Find or create the shared release (tag/name from releaseConfig)
 *   3. Upload zip as asset named "{asset.name}.zip"
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ticketKey
 * @param {Object} releaseConfig  { tagTemplate?: string, nameTemplate?: string }
 * @param {Object} asset          { fromFolder: string, name: string }
 * @param {string} [providerName] 'github' (default) or 'gitlab'
 * @returns {{ success: boolean, releaseUrl: string|null, assetUrl: string|null, error: string|null }}
 */
function uploadArtefact(owner, repo, ticketKey, releaseConfig, asset, providerName) {
    var provider   = _getReleaseProvider(providerName);
    var folderPath = resolveTemplate(asset.fromFolder, ticketKey);
    var assetName  = asset.name;
    var assetFile  = assetName + '.zip';
    var tag        = buildTag(ticketKey, releaseConfig.tagTemplate);
    var relName    = buildReleaseName(ticketKey, releaseConfig.nameTemplate);

    console.log('📦 Caching "' + assetName + '" from', folderPath, '→', provider.name, 'release', tag, '/', assetFile);

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
        var release = provider.getOrCreateRelease(owner, repo, tag, relName, 'AI Artefact storage for ticket ' + ticketKey);
        console.log('📌 Release:', release.tagName, 'url:', release.htmlUrl);

        // overwrite: "true" replaces any existing asset with the same name
        var uploadResult = provider.uploadAsset(owner, repo, release, zipPath, assetFile, 'application/zip');

        console.log('✅ Uploaded "' + assetFile + '" to release', tag, '(overwrite: replaced if existed)');
        return { success: true, releaseUrl: release.htmlUrl, assetUrl: uploadResult.url, error: null };

    } catch (e) {
        console.error('Failed to upload "' + assetFile + '":', e);
        return { success: false, releaseUrl: null, assetUrl: null, error: String(e) };
    } finally {
        try { file_delete({ path: zipPath }); } catch (e2) { /* ignore */ }
    }
}

/**
 * Upload a single local file (no zipping) as a named asset inside a shared
 * Release for the ticket. Used for lightweight artefacts like the timer's
 * periodic session-output snapshot, where zipping would need `zip` in the
 * CLI whitelist unnecessarily.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ticketKey
 * @param {Object} releaseConfig  { tagTemplate?: string, nameTemplate?: string }
 * @param {string} filePath       Local file path to upload as-is
 * @param {string} assetName      Asset filename to use in the release
 * @param {string} [providerName] 'github' (default) or 'gitlab'
 * @returns {{ success: boolean, releaseUrl: string|null, assetUrl: string|null, error: string|null }}
 */
function uploadRawFile(owner, repo, ticketKey, releaseConfig, filePath, assetName, providerName) {
    var provider = _getReleaseProvider(providerName);
    var tag      = buildTag(ticketKey, releaseConfig.tagTemplate);
    var relName  = buildReleaseName(ticketKey, releaseConfig.nameTemplate);

    try {
        var release = provider.getOrCreateRelease(owner, repo, tag, relName, 'AI Artefact storage for ticket ' + ticketKey);
        var uploadResult = provider.uploadAsset(owner, repo, release, filePath, assetName, 'text/plain');
        return { success: true, releaseUrl: release.htmlUrl, assetUrl: uploadResult.url, error: null };
    } catch (e) {
        return { success: false, releaseUrl: null, assetUrl: null, error: String(e) };
    }
}

/**
 * Download a named asset from the shared ticket Release and restore it.
 *
 * Steps:
 *   1. Find or create the shared release (if none → skip silently, first run)
 *   2. Download specific asset "{asset.name}.zip"
 *   3. Unzip to toFolder
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ticketKey
 * @param {Object} releaseConfig  { tagTemplate?: string, nameTemplate?: string }
 * @param {Object} asset          { name: string, toFolder: string }
 * @param {string} [providerName] 'github' (default) or 'gitlab'
 * @returns {{ success: boolean, restored: boolean, error: string|null }}
 */
function downloadArtefact(owner, repo, ticketKey, releaseConfig, asset, providerName) {
    var provider  = _getReleaseProvider(providerName);
    var toFolder  = resolveTemplate(asset.toFolder, ticketKey);
    var assetName = asset.name;
    var assetFile = assetName + '.zip';
    var tag       = buildTag(ticketKey, releaseConfig.tagTemplate);
    var zipPath   = '/tmp/' + assetName.toLowerCase().replace(/[^a-z0-9._-]/g, '-') + '-restore.zip';

    console.log('🔄 Restoring "' + assetName + '" from', provider.name, 'release', tag, '→', toFolder);

    try {
        // Find existing release — if it has no assets, this is the first run
        var release = provider.getOrCreateRelease(
            owner, repo, tag, buildReleaseName(ticketKey, releaseConfig.nameTemplate),
            'AI Artefact storage for ticket ' + ticketKey);

        // Check if the specific asset we need actually exists
        var assetExists = release.assetNames.indexOf(assetFile) !== -1;
        if (!assetExists) {
            console.log('ℹ️  Asset "' + assetFile + '" not in release "' + tag + '" — skipping restore (first run or not cached)');
            return { success: true, restored: false, error: null };
        }

        // Download the specific asset by name
        try { file_delete({ path: zipPath }); } catch (e) { /* ignore */ }

        provider.downloadAsset(owner, repo, release, assetFile, zipPath);

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
    uploadRawFile: uploadRawFile,
    downloadArtefact: downloadArtefact,
    resolveArtefactRepository: resolveArtefactRepository
};

