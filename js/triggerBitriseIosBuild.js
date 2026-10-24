/**
 * Trigger Bitrise build_ios_simulator (manual JSRunner trigger)
 *
 * Finds the open feature PR for the trigger ticket, then triggers
 * build_ios_simulator on the PR's head branch.
 *
 * Required jobParams:
 *   inputJql           — JQL to find the ticket (e.g. "key = PROJ-6815")
 *   bitriseBuild.appSlug       — Bitrise app slug
 *   bitriseBuild.workflowId   — Bitrise workflow ID (default: build_ios_simulator)
 *   bitriseBuild.triggerBranch — branch for Bitrise trigger (use "main" when YAML
 *                                lives in a different repo than the build target)
 *   featurePR.owner    — GitHub owner of the mobile app repo
 *   featurePR.repo     — GitHub repo name of the mobile app repo
 */


// Load-time requires (gh-823): a deferred require would resolve against the
// pack js/ root only — hoist every require to the top of the module.
var configLoader = require('./configLoader.js');
var trackerSlot = require('./common/trackerSlot.js');
var bitriseTrigger = require('./common/bitriseTrigger.js');

// Tracker-agnostic ticket operations (jira / ado / github) — lazily created
// per action() run via the shared tracker slot (gh-1250). Local wrappers keep
// every call site and export unchanged.
function initTracker(config, customParams) { trackerSlot.initTracker(config, customParams); }
function getTracker() { return trackerSlot.getTracker(); }

// ── Pure param/matrix builders (extracted from action, gh-929) ───────────────

function resolveJql(params, jobParams) {
    return params.inputJql || jobParams.inputJql || '';
}

function ticketSummaryOf(ticket, fallbackKey) {
    return (ticket && ticket.fields && ticket.fields.summary) || fallbackKey;
}

function fetchByKeySummary(key) {
    try {
        var ticket = getTracker().getIssue(key);
        var summary = ticketSummaryOf(ticket, key);
        console.log('✅ Ticket fetched:', key, '—', summary);
        return { key: key, summary: summary };
    } catch (e) {
        console.warn('⚠️ Could not fetch ticket details:', e.message || e);
        return { key: key, summary: '' };
    }
}

function searchForTicket(jql) {
    console.log('Fetching ticket by JQL:', jql);
    try {
        var issues = bitriseTrigger.parseIssueList(getTracker().searchIssues(jql, { maxResults: 1 }));
        if (issues.length > 0) {
            return { key: issues[0].key, summary: ticketSummaryOf(issues[0], issues[0].key) };
        }
        return { key: '', summary: '' };
    } catch (e) {
        console.warn('⚠️ jira_search_by_jql failed:', e.message || e);
        return { key: '', summary: '' };
    }
}

function resolveIosTicket(inputJql) {
    if (!inputJql) return { key: '', summary: '' };
    // Extract ticket key directly from JQL (e.g. "key = PROJ-6815")
    var key = bitriseTrigger.parseJqlTicketKey(inputJql);
    if (key) return fetchByKeySummary(key);
    // Fallback: jira_search_by_jql
    return searchForTicket(inputJql);
}

function resolveIosBitriseConfig(jobParams) {
    var bb = jobParams.bitriseBuild || {};
    return {
        appSlug: bb.appSlug,
        workflowId: bb.workflowId || 'build_ios_simulator',
        triggerBranch: bb.triggerBranch || ''
    };
}

function resolveFeaturePrConfig(jobParams) {
    var featurePRConfig = jobParams.featurePR || {};
    return {
        owner: featurePRConfig.owner || '',
        repo: featurePRConfig.repo || ''
    };
}

function findFeaturePrWithBranch(prs, ticketKey, defaultBranch) {
    var pr = bitriseTrigger.findMatchingPr(prs, ticketKey);
    if (pr) {
        var branch = bitriseTrigger.prHeadRef(pr) || defaultBranch;
        console.log('✅ Found feature PR #' + pr.number + ' → branch: ' + branch);
        return { branch: branch, url: bitriseTrigger.prViewUrl(pr) };
    }
    return null;
}

function applyIosFeaturePr(result, pr) {
    if (!pr || !pr.url) {
        console.log('ℹ️ No open feature PR found — triggering on develop');
    }
    if (pr) {
        result.branch = pr.branch || result.branch;
        result.url = pr.url;
    }
}

function resolveIosFeatureBranch(projectConfig, jobParams, ticketKey) {
    var featureConfig = resolveFeaturePrConfig(jobParams);
    var result = { branch: 'develop', url: '' };
    if (!(featureConfig.owner && featureConfig.repo)) return result;
    try {
        var featureScm = configLoader.createScm({
            scm: projectConfig.scm,
            repository: { owner: featureConfig.owner, repo: featureConfig.repo }
        });
        applyIosFeaturePr(result, findFeaturePrWithBranch(featureScm.listPrs('open'), ticketKey, result.branch));
    } catch (e) {
        console.warn('⚠️ Could not search PRs:', e.message || e);
    }
    return result;
}

function buildIosEnvVars(ticketKey, branch, featurePrUrl) {
    var envVars = [
        { mapped_to: 'TICKET_KEY', value: ticketKey, is_expand: false },
        { mapped_to: 'MOBILE_BRANCH', value: branch, is_expand: false }
    ];
    if (featurePrUrl) {
        envVars.push({ mapped_to: 'FEATURE_PR_URL', value: featurePrUrl, is_expand: false });
    }
    return envVars;
}

function resolveIosBuildUrl(data) {
    var fromResults = data.results && data.results[0] && data.results[0].build_url;
    return data.build_url ||
        (data.build_slug ? 'https://app.bitrise.io/build/' + data.build_slug : '') ||
        fromResults || '';
}

function parseTriggerResult(buildResult) {
    // bitrise_trigger_build may return a JSON string — parse it
    var buildData = (typeof buildResult === 'string') ? JSON.parse(buildResult) : buildResult;
    console.log('✅ Bitrise build triggered: build #' + (buildData.build_number || '?'));
    return { buildUrl: resolveIosBuildUrl(buildData) };
}

function buildIosComment(ticketKey, workflowId, branch, buildUrl, featurePrUrl) {
    var comment = 'h3. 🏗️ iOS Build Triggered\n\n' +
        'Bitrise *' + workflowId + '* triggered manually for *' + ticketKey + '*.\n\n' +
        '| Field | Value |\n|-------|-------|\n' +
        '| Workflow | ' + workflowId + ' |\n' +
        '| Branch | ' + branch + ' |';
    if (buildUrl) comment += '\n| Build | [View on Bitrise|' + buildUrl + '] |';
    if (featurePrUrl) comment += '\n| Feature PR | ' + featurePrUrl + ' |';
    return comment;
}

function safeIosPostComment(ticketKey, comment) {
    try {
        getTracker().postComment(ticketKey, comment);
        console.log('✅ Posted Jira comment');
    } catch (e) {
        console.warn('⚠️ Could not post Jira comment:', e.message || e);
    }
}

function action(params) {
    try {
        var jobParams = params.jobParams || {};
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        initTracker(projectConfig, jobParams.customParams || {});
        var cfg = resolveIosBitriseConfig(jobParams);

        if (!cfg.appSlug) {
            console.error('❌ jobParams.bitriseBuild.appSlug is required');
            return { success: false, error: 'Missing bitriseBuild.appSlug' };
        }

        // ── 1. Fetch ticket by JQL ────────────────────────────────────────────
        var inputJql = resolveJql(params, jobParams);
        var ticket = resolveIosTicket(inputJql);
        if (!ticket.key) {
            console.error('❌ No ticket found for JQL:', inputJql);
            return { success: false, error: 'No ticket found for: ' + inputJql };
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🏗️  Bitrise iOS Build Trigger');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Ticket:', ticket.key, '—', ticket.summary);

        // ── 2. Find open feature PR → get head branch ─────────────────────────
        var pr = resolveIosFeatureBranch(projectConfig, jobParams, ticket.key);

        // ── 3. Trigger Bitrise build ─────────────────────────────────────────
        // triggerBranch (e.g. "main") = branch for Bitrise to fetch the YAML from.
        // MOBILE_BRANCH env var = the actual mobileApp branch to clone/build.
        var effectiveBranch = cfg.triggerBranch || pr.branch;
        var buildResult = bitrise_trigger_build({
            appSlug:       cfg.appSlug,
            workflowId:    cfg.workflowId,
            branch:        effectiveBranch,
            commitMessage: ticket.key + ' — iOS build for ' + pr.branch,
            envVars:       JSON.stringify(buildIosEnvVars(ticket.key, pr.branch, pr.url))
        });

        var build = parseTriggerResult(buildResult);

        // ── 4. Post Jira comment ─────────────────────────────────────────────
        safeIosPostComment(ticket.key, buildIosComment(ticket.key, cfg.workflowId, pr.branch, build.buildUrl, pr.url));

        return { success: true, buildUrl: build.buildUrl, branch: pr.branch, workflowId: cfg.workflowId };

    } catch (error) {
        console.error('❌ Error in triggerBitriseIosBuild:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveJql: resolveJql,
        parseJqlTicketKey: bitriseTrigger.parseJqlTicketKey,
        parseIssueList: bitriseTrigger.parseIssueList,
        ticketSummaryOf: ticketSummaryOf,
        fetchByKeySummary: fetchByKeySummary,
        searchForTicket: searchForTicket,
        resolveIosTicket: resolveIosTicket,
        resolveIosBitriseConfig: resolveIosBitriseConfig,
        resolveFeaturePrConfig: resolveFeaturePrConfig,
        prHeadRef: bitriseTrigger.prHeadRef,
        prViewUrl: bitriseTrigger.prViewUrl,
        prMatchesTicket: bitriseTrigger.prMatchesTicket,
        findFeaturePrWithBranch: findFeaturePrWithBranch,
        applyIosFeaturePr: applyIosFeaturePr,
        resolveIosFeatureBranch: resolveIosFeatureBranch,
        buildIosEnvVars: buildIosEnvVars,
        resolveIosBuildUrl: resolveIosBuildUrl,
        parseTriggerResult: parseTriggerResult,
        buildIosComment: buildIosComment,
        safeIosPostComment: safeIosPostComment
    };
}
