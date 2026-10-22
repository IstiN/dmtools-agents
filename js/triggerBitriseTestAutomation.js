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
var trackersModule = require('./common/trackers.js');

// ── Pure param/matrix builders (extracted from action, gh-929) ───────────────

function resolveInitialTrackerCustomParams(params) {
    return (params.jobParams && (params.jobParams.customParams || params.jobParams)) ||
        params.customParams || {};
}

function resolveJql(params) {
    return params.inputJql || (params.jobParams && params.jobParams.inputJql) || '';
}

function parseJqlTicketKey(jql) {
    var keyMatch = jql.match(/key\s*=\s*([A-Z]+-\d+)/i);
    return keyMatch ? keyMatch[1].toUpperCase() : '';
}

function parseIssueList(results) {
    var parsed = (typeof results === 'string') ? JSON.parse(results) : results;
    return (parsed && parsed.issues) ? parsed.issues : (Array.isArray(parsed) ? parsed : []);
}

function fetchTicketByKey(tracker, key) {
    console.log('JSRunner mode — fetching ticket by key:', key);
    try {
        var t = tracker.getIssue(key);
        return (t && t.key) ? { ticket: t } : { error: 'Could not fetch ticket: ' + key };
    } catch (e) {
        return { error: 'Failed to fetch ticket ' + key + ': ' + e };
    }
}

function searchFirstTicket(tracker, jql) {
    try {
        var issues = parseIssueList(tracker.searchIssues(jql, { maxResults: 1 }));
        if (!issues.length) return { error: 'No tickets found for JQL: ' + jql };
        return { ticket: issues[0] };
    } catch (e) {
        return { error: 'jira_search_by_jql failed: ' + e };
    }
}

/**
 * JSRunner mode has no ticket context — resolve one from inputJql and
 * rebuild params as { ticket, jobParams }. Returns { params } or { error }.
 */
function resolveTicketParams(params, tracker) {
    if (params.ticket) return { params: params };
    var jql = resolveJql(params);
    var key = parseJqlTicketKey(jql);
    if (key) {
        var byKey = fetchTicketByKey(tracker, key);
        return byKey.error ? byKey : { params: { ticket: byKey.ticket, jobParams: params.jobParams } };
    }
    console.log('JSRunner mode — fetching ticket by JQL:', jql);
    var found = searchFirstTicket(tracker, jql);
    return found.error ? found : { params: { ticket: found.ticket, jobParams: params.jobParams } };
}

function pickActualParams(params) {
    return params.ticket ? params : (params.jobParams || params);
}

function resolveCustomParams(params, actualParams) {
    return (params.jobParams && params.jobParams.customParams) ||
        (params.jobParams && params.jobParams) || actualParams.customParams || {};
}

function resolveTicketSummary(actualParams) {
    return (actualParams.ticket.fields && actualParams.ticket.fields.summary) || actualParams.ticket.key;
}

function resolveBitriseConfig(customParams) {
    var bb = customParams.bitriseBuild || {};
    return {
        appSlug: bb.appSlug,
        workflowId: bb.workflowId || 'ai_teammate_test_automation',
        branch: bb.branch || 'main'
    };
}

function resolveFeaturePrConfig(customParams) {
    var featurePRConfig = customParams.featurePR || {};
    return {
        owner: featurePRConfig.owner || '',
        repo: featurePRConfig.repo || ''
    };
}

function prHeadRef(pr) {
    return (pr.head && pr.head.ref) || '';
}

function prViewUrl(pr) {
    return pr.html_url || pr.url || '';
}

function prMatchesTicket(pr, ticketKey) {
    var prBranch = prHeadRef(pr);
    return (pr.title || '').indexOf(ticketKey) !== -1 || prBranch.indexOf(ticketKey) !== -1;
}

function findFeaturePr(prs, ticketKey) {
    for (var i = 0; i < (prs || []).length; i++) {
        var pr = prs[i];
        if (prMatchesTicket(pr, ticketKey)) {
            console.log('✅ Found feature PR #' + pr.number + ': ' + (pr.title || ''));
            return { url: prViewUrl(pr), number: String(pr.number || '') };
        }
    }
    return { url: '', number: '' };
}

function searchFeaturePr(projectConfig, customParams, ticketKey) {
    var featureConfig = resolveFeaturePrConfig(customParams);
    if (!(featureConfig.owner && featureConfig.repo)) {
        return { url: '', number: '', owner: featureConfig.owner, repo: featureConfig.repo };
    }
    try {
        var featureScm = configLoader.createScm({
            scm: projectConfig.scm,
            repository: { owner: featureConfig.owner, repo: featureConfig.repo }
        });
        var pr = findFeaturePr(featureScm.listPrs('open'), ticketKey);
        if (!pr.url) {
            console.log('ℹ️ No open feature PR found for', ticketKey, '— will run automation anyway');
        }
        return { url: pr.url, number: pr.number, owner: featureConfig.owner, repo: featureConfig.repo };
    } catch (prErr) {
        console.warn('⚠️ Could not search feature PRs:', prErr.message || prErr);
        return { url: '', number: '', owner: featureConfig.owner, repo: featureConfig.repo };
    }
}

function parseBuildList(listResultRaw) {
    var listParsed = (typeof listResultRaw === 'string') ? JSON.parse(listResultRaw) : listResultRaw;
    return (listParsed && listParsed.data) ? listParsed.data : (Array.isArray(listParsed) ? listParsed : []);
}

function matchesTicketBuild(b, ticketKey) {
    return (b.commit_message || '').indexOf(ticketKey) !== -1 && !!b.slug;
}

function abortOneBuild(appSlug, b, ticketKey) {
    try {
        bitrise_abort_build({
            appSlug: appSlug,
            buildSlug: b.slug,
            reason: 'Superseded by newer trigger for ' + ticketKey
        });
        console.log('🛑 Aborted in-flight build #' + (b.build_number || '?') + ' (' + b.slug + ') for ' + ticketKey);
        return true;
    } catch (abortErr) {
        console.warn('⚠️ Could not abort build ' + b.slug + ':', abortErr.message || abortErr);
        return false;
    }
}

function abortBuildsForTicket(appSlug, builds, ticketKey) {
    var abortedCount = 0;
    for (var bi = 0; bi < builds.length; bi++) {
        var b = builds[bi] || {};
        if (matchesTicketBuild(b, ticketKey) && abortOneBuild(appSlug, b, ticketKey)) abortedCount++;
    }
    return abortedCount;
}

/**
 * Abort any in-flight builds for the same ticket (3a) — prevents duplicate
 * concurrent runs when the GitHub Action is triggered multiple times.
 */
function abortInFlightBuilds(cfg, ticketKey) {
    var statusesToCheck = ['not_started', 'in_progress'];
    var abortedCount = 0;
    try {
        for (var si = 0; si < statusesToCheck.length; si++) {
            var listResultRaw = null;
            try {
                listResultRaw = bitrise_list_builds({
                    appSlug: cfg.appSlug,
                    workflowId: cfg.workflowId,
                    branch: cfg.branch,
                    status: statusesToCheck[si],
                    limit: 50
                });
            } catch (listErr) {
                console.warn('⚠️ bitrise_list_builds failed for status ' + statusesToCheck[si] + ':', listErr.message || listErr);
                continue;
            }
            abortedCount += abortBuildsForTicket(cfg.appSlug, parseBuildList(listResultRaw), ticketKey);
        }
        if (abortedCount > 0) {
            console.log('ℹ️ Aborted ' + abortedCount + ' older build(s) before triggering new one.');
        }
    } catch (dedupErr) {
        console.warn('⚠️ Build dedup check failed (continuing anyway):', dedupErr.message || dedupErr);
    }
    return abortedCount;
}

function buildTriggerEnvVars(ticketKey, pr) {
    return [
        { mapped_to: 'TICKET_KEY',       value: ticketKey,       is_expand: false },
        { mapped_to: 'INPUT_JQL',         value: 'key = ' + ticketKey, is_expand: false },
        { mapped_to: 'FEATURE_PR_URL',    value: pr.url,    is_expand: false },
        { mapped_to: 'FEATURE_PR_NUMBER', value: pr.number, is_expand: false },
        { mapped_to: 'FEATURE_REPO',      value: pr.owner + '/' + pr.repo, is_expand: false }
    ];
}

function triggerBitriseBuild(cfg, ticketKey, pr, tracker) {
    try {
        var buildResult = bitrise_trigger_build({
            appSlug:       cfg.appSlug,
            workflowId:    cfg.workflowId,
            branch:        cfg.branch,
            commitMessage: ticketKey + ' — AI test automation triggered by GitHub',
            envVars:       JSON.stringify(buildTriggerEnvVars(ticketKey, pr))
        });
        console.log('✅ Bitrise build triggered:', JSON.stringify(buildResult));
        return { ok: true, result: buildResult };
    } catch (bitriseErr) {
        console.error('❌ Failed to trigger Bitrise build:', bitriseErr.message || bitriseErr);
        try {
            tracker.postComment(ticketKey, 'h3. ❌ Test Automation Trigger Failed\n\n' +
                    'Could not trigger Bitrise workflow *' + cfg.workflowId + '*.\n\n' +
                    '{code}' + (bitriseErr.message || bitriseErr) + '{code}');
        } catch (_) {}
        return { ok: false, error: 'Failed to trigger Bitrise: ' + bitriseErr };
    }
}

function resolveBuildUrl(data, firstResult) {
    return data.build_url ||
        (firstResult && firstResult.build_url) ||
        (data.build_slug ? 'https://app.bitrise.io/build/' + data.build_slug : '') || '';
}

function resolveBuildNumber(data, firstResult) {
    return String(data.build_number || (firstResult && firstResult.build_number) || '');
}

function extractBuildInfo(buildResult) {
    try {
        // bitrise_trigger_build may return a JSON string — parse it
        var buildData = (typeof buildResult === 'string') ? JSON.parse(buildResult) : buildResult;
        var firstResult = buildData.results && buildData.results[0];
        var info = {
            buildUrl: resolveBuildUrl(buildData, firstResult),
            buildNumber: resolveBuildNumber(buildData, firstResult)
        };
        console.log('✅ Build #' + info.buildNumber + (info.buildUrl ? ' → ' + info.buildUrl : ''));
        return info;
    } catch (_) {}
    return { buildUrl: '', buildNumber: '' };
}

function buildTriggerComment(ticketKey, cfg, pr, info) {
    var jiraComment = 'h3. 🤖 iOS Test Automation Started\n\n' +
        'Maestro test automation for *' + ticketKey + '* has been triggered on Bitrise.\n\n' +
        '| Field | Value |\n' +
        '|-------|-------|\n' +
        '| Workflow | ' + cfg.workflowId + ' |\n' +
        '| Branch | ' + cfg.branch + ' |';

    if (info.buildUrl) {
        var buildLabel = info.buildNumber ? 'Build #' + info.buildNumber : 'View on Bitrise';
        jiraComment += '\n| Build | [' + buildLabel + '|' + info.buildUrl + '] |';
    }
    if (pr.url) {
        jiraComment += '\n| Feature PR | ' + pr.url + ' |';
    }

    return jiraComment +
        '\n\nTest results will be posted here and on the feature PR once the build completes.';
}

function safePostComment(tracker, ticketKey, comment) {
    try {
        tracker.postComment(ticketKey, comment);
        console.log('✅ Posted Jira comment with Bitrise build info');
    } catch (e) {
        console.warn('⚠️ Failed to post Jira comment:', e.message || e);
    }
}

function moveToInTesting(tracker, ticketKey, statuses) {
    try {
        // gh-916: IN_TESTING can be tag-only (restricted ADO workflows) — stage-label fallback.
        var moveResult = tracker.moveToStatusOrMark(ticketKey, statuses.IN_TESTING, 'IN_TESTING');
        if (moveResult.moved || moveResult.marked) {
            console.log('✅ Moved', ticketKey, 'to In Testing');
        }
    } catch (e) {
        console.warn('⚠️ Could not move ticket to In Testing:', e.message || e);
    }
}

function safeRemoveLabel(tracker, ticketKey, label, announce) {
    if (!label) return;
    try {
        tracker.removeLabel(ticketKey, label);
        if (announce) console.log('✅ Removed SM label:', label);
    } catch (e) {}
}

function resolveWipLabel(params) {
    return params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip' : 'test_automation_wip';
}

function reportFatalError(tracker, params, error) {
    try {
        if (params && params.ticket && params.ticket.key) {
            tracker.postComment(params.ticket.key, 'h3. ❌ Test Automation Proxy Error\n\n' +
                    '{code}' + error.toString() + '{code}');
        }
    } catch (_) {}
}

function action(params) {
    var tracker;
    try {
        var initialConfig = null;
        tracker = trackersModule.createTracker(initialConfig, resolveInitialTrackerCustomParams(params));
        // JSRunner mode: no ticket context — fetch it from inputJql in jobParams
        var resolved = resolveTicketParams(params, tracker);
        if (resolved.error) return { success: false, error: resolved.error };
        params = resolved.params;

        var actualParams = pickActualParams(params);
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var ticketKey = actualParams.ticket.key;
        var customParams = resolveCustomParams(params, actualParams);
        tracker = trackersModule.createTracker(projectConfig, customParams);
        var statuses = resolveStatuses(customParams);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 Bitrise Test Automation Proxy');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Ticket:', ticketKey, '—', resolveTicketSummary(actualParams));

        // ── 1. Resolve Bitrise build config ─────────────────────────────────
        var cfg = resolveBitriseConfig(customParams);

        if (!cfg.appSlug) {
            console.error('❌ customParams.bitriseBuild.appSlug is required');
            return { success: false, error: 'Missing bitriseBuild.appSlug' };
        }

        // ── 2. Find the open feature PR ──────────────────────────────────────
        var pr = searchFeaturePr(projectConfig, customParams, ticketKey);

        // ── 3a. Abort any in-flight builds for the same ticket ───────────────
        abortInFlightBuilds(cfg, ticketKey);

        // ── 3b. Trigger Bitrise build ────────────────────────────────────────
        var trigger = triggerBitriseBuild(cfg, ticketKey, pr, tracker);
        if (!trigger.ok) return { success: false, error: trigger.error };

        // ── 4. Build Bitrise build URL from response ─────────────────────────
        var info = extractBuildInfo(trigger.result);

        // ── 5. Post Jira comment ─────────────────────────────────────────────
        safePostComment(tracker, ticketKey, buildTriggerComment(ticketKey, cfg, pr, info));

        // ── 6. Move ticket to In Testing ─────────────────────────────────────
        moveToInTesting(tracker, ticketKey, statuses);

        // ── 7. Remove SM trigger label ────────────────────────────────────────
        safeRemoveLabel(tracker, ticketKey, customParams.removeLabel, true);

        // ── 8. Remove WIP label ───────────────────────────────────────────────
        safeRemoveLabel(tracker, ticketKey, resolveWipLabel(params), false);

        console.log('✅ Bitrise test automation proxy completed for', ticketKey);

        return {
            success:    true,
            message:    'Bitrise test automation triggered for ' + ticketKey,
            buildUrl:   info.buildUrl,
            workflowId: cfg.workflowId
        };

    } catch (error) {
        console.error('❌ Error in triggerBitriseTestAutomation:', error);
        reportFatalError(tracker, params, error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveInitialTrackerCustomParams: resolveInitialTrackerCustomParams,
        resolveJql: resolveJql,
        parseJqlTicketKey: parseJqlTicketKey,
        parseIssueList: parseIssueList,
        fetchTicketByKey: fetchTicketByKey,
        searchFirstTicket: searchFirstTicket,
        resolveTicketParams: resolveTicketParams,
        pickActualParams: pickActualParams,
        resolveCustomParams: resolveCustomParams,
        resolveTicketSummary: resolveTicketSummary,
        resolveBitriseConfig: resolveBitriseConfig,
        resolveFeaturePrConfig: resolveFeaturePrConfig,
        prHeadRef: prHeadRef,
        prViewUrl: prViewUrl,
        prMatchesTicket: prMatchesTicket,
        findFeaturePr: findFeaturePr,
        searchFeaturePr: searchFeaturePr,
        parseBuildList: parseBuildList,
        matchesTicketBuild: matchesTicketBuild,
        abortOneBuild: abortOneBuild,
        abortBuildsForTicket: abortBuildsForTicket,
        abortInFlightBuilds: abortInFlightBuilds,
        buildTriggerEnvVars: buildTriggerEnvVars,
        triggerBitriseBuild: triggerBitriseBuild,
        resolveBuildUrl: resolveBuildUrl,
        resolveBuildNumber: resolveBuildNumber,
        extractBuildInfo: extractBuildInfo,
        buildTriggerComment: buildTriggerComment,
        safePostComment: safePostComment,
        moveToInTesting: moveToInTesting,
        safeRemoveLabel: safeRemoveLabel,
        resolveWipLabel: resolveWipLabel,
        reportFatalError: reportFatalError
    };
}
