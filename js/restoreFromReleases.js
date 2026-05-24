/**
 * Restore From Releases — preJSAction
 *
 * Downloads named assets from a single shared GitHub Release per ticket
 * and unpacks them to configured local folders.
 * Always returns true (non-fatal) — if no release or asset exists yet, silently skips.
 *
 * customParams.restoreFromReleases schema:
 * {
 *   "releaseTagTemplate": "ai-{ticketKey}",   // optional, matches cacheToReleases default
 *   "assets": [
 *     {
 *       "name": "copilot-session",
 *       "toFolder": ".copilot/session-state/{ticketKey}"
 *     }
 *   ]
 * }
 *
 * Also requires customParams.artefactRepository: { owner, repo }
 * (falls back to aiRepository or targetRepository)
 *
 * Usage in agent config:
 *   "preJSAction": "agents/js/restoreFromReleases.js"
 */

var releaseArtefacts = require('./common/releaseArtefacts.js');

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) ||
           params.customParams ||
           {};
}

/**
 * @param {Object} params - Teammate/JSRunner params
 * @returns {boolean} Always true — non-fatal, never blocks processing
 */
function action(params) {
    try {
        var actualParams = params.ticket ? params : (params.jobParams || params);
        var ticketKey = actualParams.ticket && actualParams.ticket.key;
        if (!ticketKey) {
            console.warn('⚠️  restoreFromReleases: no ticketKey found, skipping');
            return true;
        }

        var customParams = resolveCustomParams(params);
        var config = customParams.restoreFromReleases;

        if (!config) {
            console.log('ℹ️  restoreFromReleases: not configured, skipping');
            return true;
        }

        var assets = config.assets;
        if (!assets || !Array.isArray(assets) || assets.length === 0) {
            console.log('ℹ️  restoreFromReleases: no assets configured, skipping');
            return true;
        }

        var artefactRepo = releaseArtefacts.resolveArtefactRepository(customParams);
        if (!artefactRepo) {
            console.warn('⚠️  restoreFromReleases: artefactRepository not configured, skipping');
            return true;
        }

        var releaseConfig = {
            tagTemplate:  config.releaseTagTemplate,
            nameTemplate: config.releaseNameTemplate
        };

        console.log('=== restoreFromReleases for', ticketKey, '===');
        console.log('Release tag:', releaseArtefacts.buildTag(ticketKey, releaseConfig.tagTemplate));

        for (var i = 0; i < assets.length; i++) {
            var asset = assets[i];
            if (!asset.name || !asset.toFolder) {
                console.warn('⚠️  Asset missing name or toFolder, skipping:', JSON.stringify(asset));
                continue;
            }

            var result = releaseArtefacts.downloadArtefact(
                artefactRepo.owner, artefactRepo.repo, ticketKey, releaseConfig, asset
            );

            if (result.restored) {
                console.log('✅ Restored "' + asset.name + '" →',
                            releaseArtefacts.resolveTemplate(asset.toFolder, ticketKey));
            } else if (!result.success) {
                console.warn('⚠️  Could not restore "' + asset.name + '":', result.error);
                // Non-fatal — continue to next asset
            }
        }

        console.log('=== restoreFromReleases done ===');

    } catch (e) {
        console.warn('⚠️  restoreFromReleases error (non-fatal):', e);
    }

    return true;
}

module.exports = { action: action };
