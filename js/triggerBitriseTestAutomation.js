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
        // JSRunner mode: no ticket context — fetch it from inputJql in jobParams
        if (!params.ticket) {
            // params.inputJql (from Jira encoded_config) takes priority over jobParams default
            var jql = params.inputJql || (params.jobParams && params.jobParams.inputJql) || '';
            var keyMatch = jql.match(/key\s*=\s*([A-Z]+-\d+)/i);
            if (keyMatch) {
                var ticketKeyFromJql = keyMatch[1].toUpperCase();
                console.log('JSRunner mode — fetching ticket by key:', ticketKeyFromJql);
                try {
                    var t = jira_get_ticket({ key: ticketKeyFromJql });
                    if (t && t.key) {
                        params = { ticket: t, jobParams: params.jobParams };
                    } else {
                        return { success: false, error: 'Could not fetch ticket: ' + ticketKeyFromJql };
                    }
                } catch (fetchErr) {
                    return { success: false, error: 'Failed to fetch ticket ' + ticketKeyFromJql + ': ' + fetchErr };
                }
            } else {
                // Fallback to jira_search_by_jql
                console.log('JSRunner mode — fetching ticket by JQL:', jql);
                try {
                    var results = jira_search_by_jql({ jql: jql, maxResults: 1 });
                    var parsed = (typeof results === 'string') ? JSON.parse(results) : results;
                    var issues = (parsed && parsed.issues) ? parsed.issues : (Array.isArray(parsed) ? parsed : []);
                    if (!issues.length) {
                        return { success: false, error: 'No tickets found for JQL: ' + jql };
                    }
                    params = { ticket: issues[0], jobParams: params.jobParams };
                } catch (searchErr) {
                    return { success: false, error: 'jira_search_by_jql failed: ' + searchErr };
                }
            }
        }

        var actualParams = params.ticket ? params : (params.jobParams || params);
        var ticketKey = actualParams.ticket.key;
        var ticketSummary = (actualParams.ticket.fields && actualParams.ticket.fields.summary) || ticketKey;
        var customParams = (params.jobParams && params.jobParams.customParams) || (params.jobParams && params.jobParams) || actualParams.customParams || {};
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

        // ── 3a. Abort any in-flight builds for the same ticket ───────────────
        // Prevents duplicate concurrent runs when the GitHub Action is triggered
        // multiple times (e.g. by re-applied Jira label, manual dispatch, etc.).
        try {
            var statusesToCheck = ['not_started', 'in_progress'];
            var abortedCount = 0;
            for (var si = 0; si < statusesToCheck.length; si++) {
                var listResultRaw = null;
                try {
                    listResultRaw = bitrise_list_builds({
                        appSlug: appSlug,
                        workflowId: workflowId,
                        branch: branch,
                        status: statusesToCheck[si],
                        limit: 50
                    });
                } catch (listErr) {
                    console.warn('⚠️ bitrise_list_builds failed for status ' + statusesToCheck[si] + ':', listErr.message || listErr);
                    continue;
                }
                var listParsed = (typeof listResultRaw === 'string') ? JSON.parse(listResultRaw) : listResultRaw;
                var builds = (listParsed && listParsed.data) ? listParsed.data : (Array.isArray(listParsed) ? listParsed : []);
                for (var bi = 0; bi < builds.length; bi++) {
                    var b = builds[bi] || {};
                    var msg = b.commit_message || '';
                    if (msg.indexOf(ticketKey) !== -1 && b.slug) {
                        try {
                            bitrise_abort_build({
                                appSlug: appSlug,
                                buildSlug: b.slug,
                                reason: 'Superseded by newer trigger for ' + ticketKey
                            });
                            abortedCount++;
                            console.log('🛑 Aborted in-flight build #' + (b.build_number || '?') + ' (' + b.slug + ') for ' + ticketKey);
                        } catch (abortErr) {
                            console.warn('⚠️ Could not abort build ' + b.slug + ':', abortErr.message || abortErr);
                        }
                    }
                }
            }
            if (abortedCount > 0) {
                console.log('ℹ️ Aborted ' + abortedCount + ' older build(s) before triggering new one.');
            }
        } catch (dedupErr) {
            console.warn('⚠️ Build dedup check failed (continuing anyway):', dedupErr.message || dedupErr);
        }

        // ── 3b. Trigger Bitrise build ────────────────────────────────────────
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
        var buildNumber = '';
        try {
            // bitrise_trigger_build may return a JSON string — parse it
            var buildData = (typeof buildResult === 'string') ? JSON.parse(buildResult) : buildResult;
            var firstResult = buildData.results && buildData.results[0];
            buildUrl = buildData.build_url ||
                (firstResult && firstResult.build_url) ||
                (buildData.build_slug ? 'https://app.bitrise.io/build/' + buildData.build_slug : '') || '';
            buildNumber = String(buildData.build_number || (firstResult && firstResult.build_number) || '');
            console.log('✅ Build #' + buildNumber + (buildUrl ? ' → ' + buildUrl : ''));
        } catch (_) {}

        // ── 5. Post Jira comment ─────────────────────────────────────────────
        var jiraComment = 'h3. 🤖 iOS Test Automation Started\n\n' +
            'Maestro test automation for *' + ticketKey + '* has been triggered on Bitrise.\n\n' +
            '| Field | Value |\n' +
            '|-------|-------|\n' +
            '| Workflow | ' + workflowId + ' |\n' +
            '| Branch | ' + branch + ' |';

        if (buildUrl) {
            var buildLabel = buildNumber ? 'Build #' + buildNumber : 'View on Bitrise';
            jiraComment += '\n| Build | [' + buildLabel + '|' + buildUrl + '] |';
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
