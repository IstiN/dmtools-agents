/**
 * E2E Post-Action: Write Solution + Add Affected Repository Labels
 *
 * Extends writeSolutionAndDiagrams by reading outputs/affected_repos.json
 * and labelling the Jira ticket with each affected repository name.
 *
 * Use this as postJSAction in story_solution_e2e.json (or any config that
 * needs repo-level traceability on the ticket). The file is optional — if
 * absent or empty the action still succeeds.
 */

const base = require('./writeSolutionAndDiagrams.js');
const outputFiles = require('./common/outputFiles.js');

function action(params) {
    // Run the full base write-solution flow first
    var result = base.action(params);
    if (!result.success) {
        return result;
    }

    var ticketKey = params.ticket && params.ticket.key;

    // Read outputs/affected_repos.json and apply repo labels
    try {
        var reposJson = outputFiles.readOutputFile('affected_repos.json');
        if (reposJson) {
            var affectedRepos = JSON.parse(reposJson);
            if (Array.isArray(affectedRepos) && affectedRepos.length > 0) {
                for (var i = 0; i < affectedRepos.length; i++) {
                    var repoLabel = (affectedRepos[i] || '').toString().trim();
                    if (repoLabel) {
                        try {
                            jira_add_label({ key: ticketKey, label: repoLabel });
                            console.log('Added repo label "' + repoLabel + '" to ' + ticketKey);
                        } catch (le) {
                            console.warn('Failed to add repo label "' + repoLabel + '":', le);
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn('Failed to apply affected_repos.json labels:', e);
    }

    return result;
}

module.exports = { action: action };
