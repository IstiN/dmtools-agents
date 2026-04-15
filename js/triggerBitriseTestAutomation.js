/**
 * Trigger Bitrise Test Automation (GitHub-side proxy postJSAction)
 *
 * This script is the GitHub-side proxy for test automation.
 * It does NO actual test work — instead it:
 *
 * 1. Finds the open feature PR for the trigger ticket
 * 2. Triggers the Bitrise ai_teammate_test_automation workflow
 *    passing TICKET_KEY, INPUT_JQL, FEATURE_PR_URL, and FEATURE_PR_NUMBER
 * 3. Posts a Jira comment with the Bitrise build URL
 * 4. Moves the ticket to In Testing
 * 5. Removes the SM trigger label
 *
 * All actual Maestro automation work happens on Bitrise.
 *
 * Required customParams:
 *   bitriseBuild.appSlug   — Bitrise app slug
 *   bitriseBuild.workflow  — Bitrise workflow ID
 *   featurePR.owner        — GitHub owner for feature repo (mobileApp)
 *   featurePR.repo         — GitHub repo name for feature repo
 *
 * Optional customParams:
 *   bitriseBuild.branch    — branch to build (default: main)
 */

var configLoader = require('./configLoader.js');
const { STATUSES, LABELS, resolveStatuses } = require('./config.js');

function action(params) {
    try {
        var actualParams = params.ticket ? params : (params.jobParams || params);
        var ticketKey = actualParams.ticket.key;
        var ticketSummary = (actualParams.ticket.fields && actualParams.ticket.fields.summary) || ticketKey;
        var customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams || {};
        var statuses = resolveStatuses(customParams);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 Bitrise Test Automation Proxy');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Ticket:', ticketKey, '—', ticketSummary);

        // ── 1. Resolve Bitrise build config ─────────────────────────────────
        var bb = customParams.bitriseBuild || {};
        var appSlug = bb.appSlug;
        var workflowId = bb.workflowId || 'ai_teammate_test_automation';
        var branch = bb.branch || 'main';

        if (!appSlug) {
            console.error('❌ customParams.bitriseBuild.appSlug is required');
            return { success: false, error: 'Missing bitriseBuild.appSlug' };
        }

        // ── 2. Find the open feature PR ──────────────────────────────────────
        var featurePRConfig = customParams.featurePR || {};
        var featureOwner = featurePRConfig.owner || '';
        var featureRepo = featurePRConfig.repo || '';
        var featurePrUrl = '';
        var featurePrNumber = '';

        if (featureOwner && featureRepo) {
            try {
                var prs = github_list_prs({ workspace: featureOwner, repository: featureRepo, state: 'open' });
                if (prs && prs.length > 0) {
                    for (var i = 0; i < prs.length; i++) {
                        var pr = prs[i];
                        var prTitle = pr.title || '';
                        var prBranch = (pr.head && pr.head.ref) || '';
                        if (prTitle.indexOf(ticketKey) !== -1 || prBranch.indexOf(ticketKey) !== -1) {
                            featurePrUrl = pr.html_url || pr.url || '';
                            featurePrNumber = String(pr.number || '');
                            console.log('✅ Found feature PR #' + pr.number + ': ' + prTitle);
                            break;
                        }
                    }
                }
                if (!featurePrUrl) {
                    console.log('ℹ️ No open feature PR found for', ticketKey, '— will run automation anyway');
                }
            } catch (prErr) {
                console.warn('⚠️ Could not search feature PRs:', prErr.message || prErr);
            }
        }

        // ── 3. Trigger Bitrise build ─────────────────────────────────────────
        var envVars = [
            { mapped_to: 'TICKET_KEY',       value: ticketKey,       is_expand: false },
            { mapped_to: 'INPUT_JQL',         value: 'key = ' + ticketKey, is_expand: false },
            { mapped_to: 'FEATURE_PR_URL',    value: featurePrUrl,    is_expand: false },
            { mapped_to: 'FEATURE_PR_NUMBER', value: featurePrNumber, is_expand: false },
            { mapped_to: 'FEATURE_REPO',      value: featureOwner + '/' + featureRepo, is_expand: false }
        ];

        var buildResult = null;
        try {
            buildResult = bitrise_trigger_build({
                appSlug:       appSlug,
                workflowId:    workflowId,
                branch:        branch,
                commitMessage: ticketKey + ' — AI test automation triggered by GitHub',
                envVars:       JSON.stringify(envVars)
            });
            console.log('✅ Bitrise build triggered:', JSON.stringify(buildResult));
        } catch (bitriseErr) {
            console.error('❌ Failed to trigger Bitrise build:', bitriseErr.message || bitriseErr);
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ❌ Test Automation Trigger Failed\n\n' +
                        'Could not trigger Bitrise workflow *' + workflowId + '*.\n\n' +
                        '{code}' + (bitriseErr.message || bitriseErr) + '{code}'
                });
            } catch (_) {}
            return { success: false, error: 'Failed to trigger Bitrise: ' + bitriseErr };
        }

        // ── 4. Build Bitrise build URL from response ─────────────────────────
        var buildUrl = '';
        try {
            if (buildResult && buildResult.build_slug) {
                buildUrl = 'https://app.bitrise.io/build/' + buildResult.build_slug;
            } else if (buildResult && buildResult.build_url) {
                buildUrl = buildResult.build_url;
            }
        } catch (_) {}

        // ── 5. Post Jira comment ─────────────────────────────────────────────
        var jiraComment = 'h3. 🤖 iOS Test Automation Started\n\n' +
            'Maestro test automation for *' + ticketKey + '* has been triggered on Bitrise.\n\n' +
            '| Field | Value |\n' +
            '|-------|-------|\n' +
            '| Workflow | ' + workflowId + ' |\n' +
            '| Branch | ' + branch + ' |';

        if (buildUrl) {
            jiraComment += '\n| Build | [View on Bitrise|' + buildUrl + '] |';
        }
        if (featurePrUrl) {
            jiraComment += '\n| Feature PR | ' + featurePrUrl + ' |';
        }

        jiraComment += '\n\nTest results will be posted here and on the feature PR once the build completes.';

        try {
            jira_post_comment({ key: ticketKey, comment: jiraComment });
            console.log('✅ Posted Jira comment with Bitrise build info');
        } catch (e) {
            console.warn('⚠️ Failed to post Jira comment:', e.message || e);
        }

        // ── 6. Move ticket to In Testing ─────────────────────────────────────
        try {
            jira_move_to_status({ key: ticketKey, statusName: statuses.IN_TESTING });
            console.log('✅ Moved', ticketKey, 'to In Testing');
        } catch (e) {
            console.warn('⚠️ Could not move ticket to In Testing:', e.message || e);
        }

        // ── 7. Remove SM trigger label ────────────────────────────────────────
        var removeLabel = customParams.removeLabel;
        if (removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('✅ Removed SM label:', removeLabel);
            } catch (e) {}
        }

        // ── 8. Remove WIP label ───────────────────────────────────────────────
        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip' : 'test_automation_wip';
        try {
            jira_remove_label({ key: ticketKey, label: wipLabel });
        } catch (e) {}

        console.log('✅ Bitrise test automation proxy completed for', ticketKey);

        return {
            success:    true,
            message:    'Bitrise test automation triggered for ' + ticketKey,
            buildUrl:   buildUrl,
            workflowId: workflowId
        };

    } catch (error) {
        console.error('❌ Error in triggerBitriseTestAutomation:', error);
        try {
            if (params && params.ticket && params.ticket.key) {
                jira_post_comment({
                    key: params.ticket.key,
                    comment: 'h3. ❌ Test Automation Proxy Error\n\n' +
                        '{code}' + error.toString() + '{code}'
                });
            }
        } catch (_) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
