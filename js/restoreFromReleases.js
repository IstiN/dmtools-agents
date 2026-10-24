/**
 * Restore From Releases — preJSAction
 *
 * Downloads named assets from a single shared Release per ticket (GitHub or
 * GitLab, resolved from config.scm.provider / customParams.scmProvider)
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
var configLoader = require('./configLoader.js');

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) ||
           params.customParams ||
           {};
}

/**
 * The params bag that carries the ticket: the Teammate call path has it at
 * params.ticket, the JSRunner path nests everything under params.jobParams.
 */
function resolveActualParams(params) {
    return params.ticket ? params : (params.jobParams || params);
}

/** The configured assets to restore, or null when the list is absent/empty/malformed. */
function configuredAssets(config) {
    var assets = config && config.assets;
    if (!assets || !Array.isArray(assets) || assets.length === 0) return null;
    return assets;
}

/** The SCM provider for the artefact download: projectConfig.scm.provider, github default. */
function scmProviderOf(projectConfig) {
    return (projectConfig.scm && projectConfig.scm.provider) || 'github';
}

/**
 * Restore one asset. An asset without a name or a target folder is skipped
 * with a warning; a failed download is non-fatal (the next asset is tried).
 */
function restoreOneAsset(artefactRepo, ticketKey, releaseConfig, asset, scmProvider) {
    if (!asset.name || !asset.toFolder) {
        console.warn('⚠️  Asset missing name or toFolder, skipping:', JSON.stringify(asset));
        return;
    }

    var result = releaseArtefacts.downloadArtefact(
        artefactRepo.owner, artefactRepo.repo, ticketKey, releaseConfig, asset, scmProvider
    );

    if (result.restored) {
        console.log('✅ Restored "' + asset.name + '" →',
                    releaseArtefacts.resolveTemplate(asset.toFolder, ticketKey));
    } else if (!result.success) {
        console.warn('⚠️  Could not restore "' + asset.name + '":', result.error);
        // Non-fatal — continue to next asset
    }
}

/**
 * The restore flow for one ticket: config → assets → artefact repo →
 * per-asset downloads. Every skip is a logged no-op — the action is
 * non-fatal by contract.
 */
function restoreTicketAssets(params, actualParams, ticketKey) {
    var customParams = resolveCustomParams(params);
    var config = customParams.restoreFromReleases;

    if (!config) {
        console.log('ℹ️  restoreFromReleases: not configured, skipping');
        return;
    }

    var assets = configuredAssets(config);
    if (!assets) {
        console.log('ℹ️  restoreFromReleases: no assets configured, skipping');
        return;
    }

    var artefactRepo = releaseArtefacts.resolveArtefactRepository(customParams);
    if (!artefactRepo) {
        console.warn('⚠️  restoreFromReleases: artefactRepository not configured, skipping');
        return;
    }

    var projectConfig = configLoader.loadProjectConfig(actualParams);
    var scmProvider = scmProviderOf(projectConfig);

    var releaseConfig = {
        tagTemplate:  config.releaseTagTemplate,
        nameTemplate: config.releaseNameTemplate
    };

    console.log('=== restoreFromReleases for', ticketKey, '(' + scmProvider + ') ===');
    console.log('Release tag:', releaseArtefacts.buildTag(ticketKey, releaseConfig.tagTemplate));

    for (var i = 0; i < assets.length; i++) {
        restoreOneAsset(artefactRepo, ticketKey, releaseConfig, assets[i], scmProvider);
    }

    console.log('=== restoreFromReleases done ===');
}

/**
 * @param {Object} params - Teammate/JSRunner params
 * @returns {boolean} Always true — non-fatal, never blocks processing
 */
function action(params) {
    try {
        var actualParams = resolveActualParams(params);
        var ticketKey = actualParams.ticket && actualParams.ticket.key;
        if (!ticketKey) {
            console.warn('⚠️  restoreFromReleases: no ticketKey found, skipping');
            return true;
        }

        restoreTicketAssets(params, actualParams, ticketKey);

    } catch (e) {
        console.warn('⚠️  restoreFromReleases error (non-fatal):', e);
    }

    return true;
}

module.exports = {
    action: action,
    resolveActualParams: resolveActualParams,
    configuredAssets: configuredAssets,
    scmProviderOf: scmProviderOf
};
