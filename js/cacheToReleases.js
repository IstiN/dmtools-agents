/**
 * Cache To Releases — postJSAction
 *
 * Zips configured folders and uploads them as named assets into a single
 * GitHub Release per ticket. The release tag and name are customizable.
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

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) ||
           params.customParams ||
           {};
}

/**
 * @param {Object} params - Teammate/JSRunner params
 * @returns {Object}
 */
function action(params) {
    try {
        var actualParams = params.ticket ? params : (params.jobParams || params);
        var ticketKey = actualParams.ticket && actualParams.ticket.key;
        if (!ticketKey) {
            console.warn('⚠️  cacheToReleases: no ticketKey found, skipping');
            return { success: true, skipped: true };
        }

        var customParams = resolveCustomParams(params);
        var config = customParams.cacheToReleases;

        if (!config) {
            console.log('ℹ️  cacheToReleases: not configured, skipping');
            return { success: true, skipped: true };
        }

        var assets = config.assets;
        if (!assets || !Array.isArray(assets) || assets.length === 0) {
            console.log('ℹ️  cacheToReleases: no assets configured, skipping');
            return { success: true, skipped: true };
        }

        var artefactRepo = releaseArtefacts.resolveArtefactRepository(customParams);
        if (!artefactRepo) {
            console.warn('⚠️  cacheToReleases: artefactRepository not configured, skipping');
            return { success: true, skipped: true };
        }

        var releaseConfig = {
            tagTemplate:  config.releaseTagTemplate,
            nameTemplate: config.releaseNameTemplate
        };

        console.log('=== cacheToReleases for', ticketKey, '===');
        console.log('Release tag :', releaseArtefacts.buildTag(ticketKey, releaseConfig.tagTemplate));
        console.log('Release name:', releaseArtefacts.buildReleaseName(ticketKey, releaseConfig.nameTemplate));

        var results = [];
        var releaseUrl = null;

        for (var i = 0; i < assets.length; i++) {
            var asset = assets[i];
            if (!asset.fromFolder || !asset.name) {
                console.warn('⚠️  Asset missing fromFolder or name, skipping:', JSON.stringify(asset));
                continue;
            }

            var result = releaseArtefacts.uploadArtefact(
                artefactRepo.owner, artefactRepo.repo, ticketKey, releaseConfig, asset
            );
            results.push({ name: asset.name, result: result });

            if (result.releaseUrl) releaseUrl = result.releaseUrl;

            if (asset.postToPRComment === true && result.success && result.releaseUrl) {
                try {
                    var targetRepo = customParams.targetRepository;
                    if (targetRepo && targetRepo.owner && targetRepo.repo) {
                        // Find open PR for this ticket
                        var prsJson = github_list_prs({
                            workspace: targetRepo.owner,
                            repository: targetRepo.repo,
                            state: 'open'
                        });
                        var prs = typeof prsJson === 'string' ? JSON.parse(prsJson) : prsJson;
                        var matchingPr = (prs || []).filter(function(pr) {
                            return (pr.title && pr.title.indexOf(ticketKey) !== -1) ||
                                   (pr.head && pr.head.ref && pr.head.ref.toLowerCase().indexOf(ticketKey.toLowerCase()) !== -1);
                        })[0];

                        if (matchingPr) {
                            github_add_pr_comment({
                                workspace: targetRepo.owner,
                                repository: targetRepo.repo,
                                pullRequestId: String(matchingPr.number),
                                text: '## 📦 Artefact: ' + asset.name + '\n\n' +
                                      'Folder `' + releaseArtefacts.resolveTemplate(asset.fromFolder, ticketKey) +
                                      '` has been archived to GitHub Release.\n\n' +
                                      '**Release:** ' + result.releaseUrl
                            });
                            console.log('✅ Posted release link to PR #' + matchingPr.number + ' for "' + asset.name + '"');
                        } else {
                            console.warn('⚠️  No open PR found for', ticketKey, '— skipping PR comment');
                        }
                    } else {
                        console.warn('⚠️  targetRepository not configured — skipping PR comment');
                    }
                } catch (commentErr) {
                    console.warn('⚠️  Could not post PR comment for "' + asset.name + '":', commentErr);
                }
            }
        }

        var successCount = results.filter(function(r) { return r.result.success; }).length;
        console.log('✅ cacheToReleases complete:', successCount + '/' + assets.length, 'assets cached',
                    releaseUrl ? '→ ' + releaseUrl : '');

        return { success: true, results: results, releaseUrl: releaseUrl };

    } catch (e) {
        console.error('cacheToReleases failed:', e);
        return { success: false, error: String(e) };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
