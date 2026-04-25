/**
 * Trigger Bitrise build_ios_simulator (manual JSRunner trigger)
 *
 * Finds the open feature PR for the trigger ticket, then triggers
 * build_ios_simulator on the PR's head branch.
 *
 * Required jobParams:
 *   inputJql           — JQL to find the ticket (e.g. "key = MAPC-6815")
 *   bitriseBuild.appSlug       — Bitrise app slug
 *   bitriseBuild.workflowId   — Bitrise workflow ID (default: build_ios_simulator)
 *   featurePR.owner    — GitHub owner of the mobile app repo
 *   featurePR.repo     — GitHub repo name of the mobile app repo
 */

function action(params) {
    try {
        var jobParams = params.jobParams || {};
        // params.inputJql (from Jira encoded_config) takes priority over jobParams default
        var inputJql = params.inputJql || jobParams.inputJql || '';
        var bb = jobParams.bitriseBuild || {};
        var appSlug = bb.appSlug;
        var workflowId = bb.workflowId || 'build_ios_simulator';
        var featurePRConfig = jobParams.featurePR || {};
        var featureOwner = featurePRConfig.owner || '';
        var featureRepo = featurePRConfig.repo || '';

        if (!appSlug) {
            console.error('❌ jobParams.bitriseBuild.appSlug is required');
            return { success: false, error: 'Missing bitriseBuild.appSlug' };
        }

        // ── 1. Fetch ticket by JQL ────────────────────────────────────────────
        var ticketKey = '';
        var ticketSummary = '';
        if (inputJql) {
            // Extract ticket key directly from JQL (e.g. "key = MAPC-6815")
            var keyMatch = inputJql.match(/key\s*=\s*([A-Z]+-\d+)/i);
            if (keyMatch) {
                ticketKey = keyMatch[1].toUpperCase();
                try {
                    var ticket = jira_get_ticket({ key: ticketKey });
                    ticketSummary = (ticket && ticket.fields && ticket.fields.summary) || ticketKey;
                    console.log('✅ Ticket fetched:', ticketKey, '—', ticketSummary);
                } catch (e) {
                    console.warn('⚠️ Could not fetch ticket details:', e.message || e);
                }
            } else {
                // Fallback: jira_search_by_jql
                console.log('Fetching ticket by JQL:', inputJql);
                try {
                    var results = jira_search_by_jql({ jql: inputJql, maxResults: 1 });
                    var parsed = (typeof results === 'string') ? JSON.parse(results) : results;
                    var issues = (parsed && parsed.issues) ? parsed.issues : (Array.isArray(parsed) ? parsed : []);
                    if (issues.length > 0) {
                        ticketKey = issues[0].key;
                        ticketSummary = (issues[0].fields && issues[0].fields.summary) || ticketKey;
                    }
                } catch (e) {
                    console.warn('⚠️ jira_search_by_jql failed:', e.message || e);
                }
            }
        }
        if (!ticketKey) {
            console.error('❌ No ticket found for JQL:', inputJql);
            return { success: false, error: 'No ticket found for: ' + inputJql };
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🏗️  Bitrise iOS Build Trigger');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Ticket:', ticketKey, '—', ticketSummary);

        // ── 2. Find open feature PR → get head branch ─────────────────────────
        var branch = 'develop';
        var featurePrUrl = '';
        if (featureOwner && featureRepo) {
            try {
                var prs = github_list_prs({ workspace: featureOwner, repository: featureRepo, state: 'open' });
                if (prs && prs.length > 0) {
                    for (var i = 0; i < prs.length; i++) {
                        var pr = prs[i];
                        var prTitle = pr.title || '';
                        var prBranch = (pr.head && pr.head.ref) || '';
                        if (prTitle.indexOf(ticketKey) !== -1 || prBranch.indexOf(ticketKey) !== -1) {
                            branch = prBranch || branch;
                            featurePrUrl = pr.html_url || pr.url || '';
                            console.log('✅ Found feature PR #' + pr.number + ' → branch: ' + branch);
                            break;
                        }
                    }
                }
                if (!featurePrUrl) {
                    console.log('ℹ️ No open feature PR found — triggering on develop');
                }
            } catch (e) {
                console.warn('⚠️ Could not search PRs:', e.message || e);
            }
        }

        // ── 3. Trigger Bitrise build ─────────────────────────────────────────
        // Always use the feature branch as the Bitrise trigger branch so
        // the Bitrise API records the correct branch. This allows the test
        // automation to find the build by branch name later.
        var envVars = [
            { mapped_to: 'TICKET_KEY', value: ticketKey, is_expand: false }
        ];
        if (featurePrUrl) {
            envVars.push({ mapped_to: 'FEATURE_PR_URL', value: featurePrUrl, is_expand: false });
        }

        var buildResult = bitrise_trigger_build({
            appSlug:       appSlug,
            workflowId:    workflowId,
            branch:        branch,
            commitMessage: ticketKey + ' — iOS build for ' + branch,
            envVars:       JSON.stringify(envVars)
        });

        // bitrise_trigger_build may return a JSON string — parse it
        var buildData = (typeof buildResult === 'string') ? JSON.parse(buildResult) : buildResult;
        console.log('✅ Bitrise build triggered: build #' + (buildData.build_number || '?'));

        var buildUrl = buildData.build_url ||
            (buildData.build_slug ? 'https://app.bitrise.io/build/' + buildData.build_slug : '') ||
            (buildData.results && buildData.results[0] && buildData.results[0].build_url) || '';

        // ── 4. Post Jira comment ─────────────────────────────────────────────
        var comment = 'h3. 🏗️ iOS Build Triggered\n\n' +
            'Bitrise *' + workflowId + '* triggered manually for *' + ticketKey + '*.\n\n' +
            '| Field | Value |\n|-------|-------|\n' +
            '| Workflow | ' + workflowId + ' |\n' +
            '| Branch | ' + branch + ' |';
        if (buildUrl) comment += '\n| Build | [View on Bitrise|' + buildUrl + '] |';
        if (featurePrUrl) comment += '\n| Feature PR | ' + featurePrUrl + ' |';

        try {
            jira_post_comment({ key: ticketKey, comment: comment });
            console.log('✅ Posted Jira comment');
        } catch (e) {
            console.warn('⚠️ Could not post Jira comment:', e.message || e);
        }

        return { success: true, buildUrl: buildUrl, branch: branch, workflowId: workflowId };

    } catch (error) {
        console.error('❌ Error in triggerBitriseIosBuild:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
