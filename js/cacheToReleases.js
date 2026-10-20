/**
 * Cache To Releases — postJSAction
 *
 * Zips configured folders and uploads them as named assets into a single
 * Release per ticket (GitHub or GitLab, resolved from config.scm.provider /
 * customParams.scmProvider). The release tag and name are customizable.
 *
 * customParams.cacheToReleases schema:
 * {
 *   "releaseTagTemplate":  "ai-{ticketKey}",             // optional, this is the default
 *   "releaseNameTemplate": "[AI] [{ticketKey}] Artefacts", // optional, this is the default
 *   "assets": [
 *     {
 *       "fromFolder": ".copilot/session-state/{ticketKey}",
 *       "name": "copilot-session"
 *     },
 *     {
 *       "fromFolder": "outputs/{ticketKey}",
 *       "name": "agent-outputs",
 *       "postToPRComment": true   // optional: post Jira comment with release link
 *     }
 *   ]
 * }
 *
 * Also requires customParams.artefactRepository: { owner, repo }
 * (falls back to aiRepository or targetRepository)
 *
 * Result in GitHub:
 *   Release:  [AI] [PROJ-123] Artefacts   (tag: ai-proj-123)
 *   Assets:   copilot-session.zip, agent-outputs.zip
 *
 * Usage in agent config:
 *   "postJSAction": "agents/js/cacheToReleases.js"
 */

var releaseArtefacts = require('./common/releaseArtefacts.js');
var configLoader = require('./configLoader.js');

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) ||
           params.customParams ||
           {};
}

// Skip log lines, one per precondition failure — keyed by the reason
// resolveActionInputs reports. Console output (level + text) matches the
// pre-extraction messages verbatim.
var ACTION_SKIP_LOGS = {
    noTicketKey: function () {
        console.warn('⚠️  cacheToReleases: no ticketKey found, skipping');
    },
    notConfigured: function () {
        console.log('ℹ️  cacheToReleases: not configured, skipping');
    },
    noAssets: function () {
        console.log('ℹ️  cacheToReleases: no assets configured, skipping');
    },
    noArtefactRepository: function () {
        console.warn('⚠️  cacheToReleases: artefactRepository not configured, skipping');
    }
};

// The params shape actually carrying the ticket: callers pass either the
// raw action params or a params envelope.
function resolveActionContext(params) {
    var actualParams = params.ticket ? params : (params.jobParams || params);
    return {
        actualParams: actualParams,
        ticketKey: actualParams.ticket && actualParams.ticket.key
    };
}

// Pure precondition ladder — every gate the action must pass before any
// upload happens, evaluated in the original order (ticket → config →
// assets → artefact repo → project config).
function resolveActionInputs(params) {
    var ctx = resolveActionContext(params);
    if (!ctx.ticketKey) {
        return { ok: false, reason: 'noTicketKey' };
    }

    var customParams = resolveCustomParams(params);
    var config = customParams.cacheToReleases;
    if (!config) {
        return { ok: false, reason: 'notConfigured' };
    }

    if (!hasConfiguredAssets(config)) {
        return { ok: false, reason: 'noAssets' };
    }

    var artefactRepo = releaseArtefacts.resolveArtefactRepository(customParams);
    if (!artefactRepo) {
        return { ok: false, reason: 'noArtefactRepository' };
    }

    var projectConfig = configLoader.loadProjectConfig(ctx.actualParams);
    return {
        ok: true,
        ticketKey: ctx.ticketKey,
        customParams: customParams,
        assets: config.assets,
        artefactRepo: artefactRepo,
        projectConfig: projectConfig,
        scmProvider: resolveScmProvider(projectConfig),
        releaseConfig: buildReleaseConfig(config)
    };
}

function hasConfiguredAssets(config) {
    return !!config.assets && Array.isArray(config.assets) && config.assets.length > 0;
}

function resolveScmProvider(projectConfig) {
    return (projectConfig.scm && projectConfig.scm.provider) || 'github';
}

function buildReleaseConfig(config) {
    return {
        tagTemplate:  config.releaseTagTemplate,
        nameTemplate: config.releaseNameTemplate
    };
}

function countSuccessful(results) {
    return results.filter(function(r) { return r.result.success; }).length;
}

// Pure: should this asset's release link be posted to the ticket's PR?
function shouldPostPrComment(asset, result) {
    return asset.postToPRComment === true && result.success && result.releaseUrl;
}

// Pure: the PR comment body announcing the cached artefact.
function assetPrCommentBody(asset, ticketKey, scmProvider, releaseUrl) {
    return '## 📦 Artefact: ' + asset.name + '\n\n' +
        'Folder `' + releaseArtefacts.resolveTemplate(asset.fromFolder, ticketKey) +
        '` has been archived to a ' + scmProvider + ' Release.\n\n' +
        '**Release:** ' + releaseUrl;
}

// Pure: first PR whose title or head branch mentions the ticket key.
function findMatchingPr(prs, ticketKey) {
    return prs.filter(function(pr) {
        return (pr.title && pr.title.indexOf(ticketKey) !== -1) ||
               (pr.head && pr.head.ref && pr.head.ref.toLowerCase().indexOf(ticketKey.toLowerCase()) !== -1);
    })[0];
}

// Post the artefact's release link to the ticket's open PR. Best-effort:
// a missing targetRepository or a transport error never fails the release.
function postAssetPrComment(asset, result, inputs) {
    try {
        var targetRepo = inputs.customParams.targetRepository;
        if (targetRepo && targetRepo.owner && targetRepo.repo) {
            // Find open PR for this ticket (scm abstraction normalizes GitHub/GitLab shapes)
            var scm = configLoader.createScm(inputs.projectConfig);
            var prs = scm.listPrs('open') || [];
            var matchingPr = findMatchingPr(prs, inputs.ticketKey);

            if (matchingPr) {
                scm.addComment(matchingPr.number,
                    assetPrCommentBody(asset, inputs.ticketKey, inputs.scmProvider, result.releaseUrl)
                );
                console.log('✅ Posted release link to PR #' + matchingPr.number + ' for "' + asset.name + '"');
            } else {
                console.warn('⚠️  No open PR found for', inputs.ticketKey, '— skipping PR comment');
            }
        } else {
            console.warn('⚠️  targetRepository not configured — skipping PR comment');
        }
    } catch (commentErr) {
        console.warn('⚠️  Could not post PR comment for "' + asset.name + '":', commentErr);
    }
}

// Upload every configured asset in order; aggregates results and the newest
// release URL. Incomplete assets are skipped with a warning, never fatal.
function uploadAssets(inputs) {
    var results = [];
    var releaseUrl = null;

    for (var i = 0; i < inputs.assets.length; i++) {
        var asset = inputs.assets[i];
        if (!asset.fromFolder || !asset.name) {
            console.warn('⚠️  Asset missing fromFolder or name, skipping:', JSON.stringify(asset));
            continue;
        }

        var result = releaseArtefacts.uploadArtefact(
            inputs.artefactRepo.owner, inputs.artefactRepo.repo, inputs.ticketKey, inputs.releaseConfig, asset, inputs.scmProvider
        );
        results.push({ name: asset.name, result: result });

        if (result.releaseUrl) releaseUrl = result.releaseUrl;

        if (shouldPostPrComment(asset, result)) {
            postAssetPrComment(asset, result, inputs);
        }
    }

    return { results: results, releaseUrl: releaseUrl };
}

/**
 * @param {Object} params - Teammate/JSRunner params
 * @returns {Object}
 */
function action(params) {
    try {
        var inputs = resolveActionInputs(params);
        if (!inputs.ok) {
            ACTION_SKIP_LOGS[inputs.reason]();
            return { success: true, skipped: true };
        }

        console.log('=== cacheToReleases for', inputs.ticketKey, '(' + inputs.scmProvider + ') ===');
        console.log('Release tag :', releaseArtefacts.buildTag(inputs.ticketKey, inputs.releaseConfig.tagTemplate));
        console.log('Release name:', releaseArtefacts.buildReleaseName(inputs.ticketKey, inputs.releaseConfig.nameTemplate));

        var out = uploadAssets(inputs);

        console.log('✅ cacheToReleases complete:', countSuccessful(out.results) + '/' + inputs.assets.length, 'assets cached',
                    out.releaseUrl ? '→ ' + out.releaseUrl : '');

        return { success: true, results: out.results, releaseUrl: out.releaseUrl };

    } catch (e) {
        console.error('cacheToReleases failed:', e);
        return { success: false, error: String(e) };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
