/**
 * SM Agent — Scrum Master automation (JSRunner)
 *
 * Reads an array of rules from params.rules (defined in agents/sm.json)
 * and for each rule:
 *   1. Queries Jira by rule.jql (with {jiraProject}/{parentTicket} interpolation)
 *   2. Optionally transitions each ticket to rule.targetStatus
 *   3. Runs the agent for each matching ticket, via one of three modes:
 *      - dispatch (default) — triggers an ai-teammate GitHub Actions workflow (async)
 *      - localExecution: true — runs the agent config's postJSAction directly in the
 *        SM process (pure JS, no AI CLI, no checkout — for fast/safe operations)
 *      - localTeammate: true — runs the FULL teammate pipeline (checkout/branch switch,
 *        AI CLI, PR/Jira actions) synchronously on the local machine via
 *        scripts/run-teammate-local.sh, one ticket at a time (no GitHub Actions runner)
 *
 * Decomposed into focused js/sm/* modules (#1459).
 */

'use strict';

// Dry-run mode: log every side effect instead of performing it.
var DRY = false;

var configLoader = require('./configLoader.js');
var smSource = require('./sm/sourceResolver.js');
var scmModule = require('./common/scm.js');
var reworkLatchModule = require('./common/reworkLatch.js');
var validationLivenessModule = require('./common/validationLiveness.js');
var checkRunZombiesModule = require('./common/checkRunZombies.js');
var labelListModule = require('./common/labelList.js');
var checkRunStampModule = require('./common/checkRunStamp.js');
var workflowRunsModule = require('./common/workflowRuns.js');
var invisibleRequiredModule = require('./common/invisibleRequiredChecks.js');
var buildEncodedConfigModule = require('./common/buildEncodedConfig.js');
var machineAuthorModule = require('./common/machineAuthor.js');
var smProviderModule = require('./common/smProvider.js');
var guestTransplantModule = require('./common/guestTransplant.js');
var trackersModule = require('./common/trackers.js');
var configModule = require('./config.js');
var reviewVerdictsModule = require('./common/reviewVerdicts.js');
var redVerdictModule = require('./sm/redVerdict.js');
var issuePlanModule = require('./common/issuePlan.js');
var planAdvanceModule = require('./common/planAdvance.js');
var reworkConsumptionModule = require('./common/reworkConsumption.js');
var reworkLoopGuardModule = require('./common/reworkLoopGuard.js');
var findingRegistryModule = require('./common/findingRegistry.js');
var prTerminalStateModule = require('./common/prTerminalState.js');
var smRuleLayersModule = require('./common/smRuleLayers.js');
var triggerFailuresModule = require('./common/triggerFailures.js');
var quotaBreakerModule = require('./common/quotaCircuitBreaker.js');
var forkDispatchModule = require('./common/forkDispatch.js');
var mutexRegistryModule = require('./common/mutexRegistry.js');
var guestValidationPathModule = require('./common/guestValidationPath.js');
var githubSourceModule = require('./sm/sources/githubSource.js');
var branchLegGuardModule = require('./common/branchLegGuard.js');
var nakedPrReconcileModule = require('./common/nakedPrReconcile.js');
var machineNoticeModule = require('./common/machineNotice.js');
var gitlabTrackerModule = require('./common/gitlabTracker.js');
var ticketKeyShapesModule = require('./common/ticketKeyShapes.js');
var linkedIssuesReportModule = require('./common/linkedIssuesReport.js');
var tokenUsageCommentModule = require('./common/tokenUsageComment.js');
var smDoneCheckModule = require('./common/smDoneCheck.js');
var aiChatModule = require('./common/aiChat.js');
var validateInputJqlModule = require('./common/validateInputJql.js');
var autoStartModule = require('./common/autoStart.js');
var commentMarkupModule = require('./common/commentMarkup.js');
var tcRunRegistryModule = require('./common/tcRunRegistry.js');
var ledgerCoreModule = require('./common/ledgerCore.js');
var tcMaintenanceLedgerModule = require('./common/tcMaintenanceLedger.js');
var tcAlternationModule = require('./common/tcAlternation.js');
var tcTriageModule = require('./common/tcTriage.js');
var bugBookkeepingModule = require('./common/bugBookkeeping.js');
var jobTicketInputsModule = require('./common/jobTicketInputs.js');
var branchRefreshModule = require('./sm/branchRefresh.js');
var checkRunCuresModule = require('./sm/checkRunCures.js');
var guestTransplantRunnerModule = require('./sm/guestTransplantRunner.js');
var localAndStateRunnerModule = require('./sm/localAndStateRunner.js');
var mergeAndParkProbesModule = require('./sm/mergeAndParkProbes.js');
var parkAndActorProbesModule = require('./sm/parkAndActorProbes.js');
var prLifecycleActionsModule = require('./sm/prLifecycleActions.js');
var prUpdateAndValidateActionsModule = require('./sm/prUpdateAndValidateActions.js');
var prVerdictAndSweepActionsModule = require('./sm/prVerdictAndSweepActions.js');
var reworkAndVerdictsModule = require('./sm/reworkAndVerdicts.js');
var ruleProcessorModule = require('./sm/ruleProcessor.js');
var tickOrchestratorModule = require('./sm/tickOrchestrator.js');
var validationCheckSyncModule = require('./sm/validationCheckSync.js');
var probeCacheModule = require('./common/probeCache.js');
var validationProbesModule = require('./sm/validationProbes.js');
var verdictAndFailStateModule = require('./sm/verdictAndFailState.js');
var workflowDispatchModule = require('./sm/workflowDispatch.js');
var workflowRunTrackingModule = require('./sm/workflowRunTracking.js');

var RUN_JOB_PARAMS = {}, projectConfig = {}, smForge = 'github', _githubTrackers = {};
var PRIORITY_LABELS = { blocker: 'priority_blocker', medium: 'priority_medium', low: 'priority_low' };
var tickStampsFailed = 0, tickZombiesSwept = 0, tickMergeReservedSlots = 0;
var tickMergeReservationReleased = false, tickMergeSlotSpent = null, tickMergeSlotAccounted = false, tickL1CacheDropped = false;
var tickReposSeen = {}, tickMovedPrs = {}, tickFreshResets = {}, tickParkedRecorded = {}, tickWorkflowEscalations = {}, terminalPrMemo = {};
var tickReworkLatch = null, tickDeadZone = null, syncMemo = { repo: null, at: 0 };

function smTracker(config) {
    return trackersModule.createTracker(config || projectConfig || {}, (RUN_JOB_PARAMS && RUN_JOB_PARAMS.customParams) || {});
}

function githubTracker(owner, repo) {
    var k = String(owner || '') + '/' + String(repo || '');
    if (!_githubTrackers[k]) {
        _githubTrackers[k] = typeof trackersModule.createGithubTracker === 'function'
            ? trackersModule.createGithubTracker(owner, repo)
            : trackersModule.createTracker({ tracker: { provider: 'github' }, repository: { owner: owner, repo: repo } });
    }
    return _githubTrackers[k];
}

function ruleBudgetRemaining(rule, workflowBudget) {
    if (!workflowBudget) return 0;
    if (smRuleLayersModule.isMergePathRule(rule) || tickMergeReservationReleased) return workflowBudget.remaining;
    return Math.max(0, workflowBudget.remaining - tickMergeReservedSlots);
}

function loadRuleConfig(rule, fallbackConfig) {
    if (!rule.configPath) return fallbackConfig;
    console.log('  Loading per-rule config from: ' + rule.configPath);
    var cfg = configLoader.loadProjectConfig({ configPath: rule.configPath });
    if (cfg) return workflowDispatchModule.applyRuleForge(workflowDispatchModule.applyJobParamsScm(cfg, RUN_JOB_PARAMS), rule);
    console.warn('  ⚠️  Failed to load rule config from ' + rule.configPath + ' — falling back to global config');
    return fallbackConfig;
}

function checksAppToken() {
    var jp = RUN_JOB_PARAMS || {};
    return jp.checksToken || jp.silentToken;
}

function swapToChecksToken(warnPrefix) {
    var appToken = checksAppToken(), sourceTok = (RUN_JOB_PARAMS || {}).sourceToken, swapped = false;
    if (appToken) {
        try { set_env_variable('GH_TOKEN', appToken); swapped = true; } catch (eSwap) { console.warn(warnPrefix + (eSwap.message || eSwap)); }
    }
    return { sourceTok: sourceTok, swapped: swapped };
}

function restoreChecksToken(swapped, sourceTok) {
    if (swapped && sourceTok) {
        try { set_env_variable('GH_TOKEN', sourceTok); } catch (eRestore) {}
    }
}

function sleepMs(ms) {
    var end = Date.now() + (ms > 0 ? ms : 0);
    while (Date.now() < end) { /* spin */ }
}

function fetchPrCommentList(repoInfo, prNumber) {
    var raw = github_get_pr_comments({ workspace: repoInfo.owner, repository: repoInfo.repo, pullRequestId: String(prNumber) });
    var obj = validationProbesModule.mcpParse(raw) || [];
    return Array.isArray(obj) ? obj : (obj.comments || obj.items || []);
}

function fetchPrReviewThreadNodes(repoInfo, prNumber) {
    var raw = github_get_pr_review_threads({ workspace: repoInfo.owner, repository: repoInfo.repo, pullRequestId: Number(prNumber) });
    return smProviderModule.reviewThreadNodesOf(validationProbesModule.mcpParse(raw));
}

function logRuleQuery(rule, interpolatedJql) {
    if (rule.source && rule.source !== 'jira') {
        console.log('   Query[' + rule.source + ']: ' + JSON.stringify(rule.query || {}) + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
        return;
    }
    console.log('   JQL: ' + interpolatedJql + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
}

function queryRuleTickets(rule, effectiveConfig, effectiveRepoInfo, interpolatedJql) {
    var ctx = {
        config: effectiveConfig, repoInfo: effectiveRepoInfo, jql: interpolatedJql,
        machineAuthor: machineAuthorModule.resolveMachineAuthor(RUN_JOB_PARAMS, effectiveConfig),
        priorityLabels: PRIORITY_LABELS
    };
    if (workflowDispatchModule.isForgeSource(rule)) ctx.scmProvider = rule.source;
    return smSource.resolve(rule).query(rule, ctx) || [];
}

function buildIoDeps() {
    var readFilePath = function (p) { return file_read({ path: p }); };
    var writeFileSmart = function (pathOrOpts, content) {
        return (pathOrOpts && typeof pathOrOpts === 'object') ? file_write(pathOrOpts) : file_write({ path: pathOrOpts, content: content });
    };
    var deleteFileSmart = function (pathOrOpts) {
        return (pathOrOpts && typeof pathOrOpts === 'object') ? file_delete(pathOrOpts) : file_delete({ path: pathOrOpts });
    };
    return {
        get dry() { return DRY; }, get jobParams() { return RUN_JOB_PARAMS; }, get projectConfig() { return projectConfig; }, get smForge() { return smForge; },
        get hasGetIssue() { return typeof github_get_issue === 'function'; }, get hasGetPr() { return typeof github_get_pr === 'function'; },
        get hasGetThreads() { return typeof github_get_pr_review_threads === 'function'; },
        exec: function (opts) { return cli_execute_command(opts); }, fileRead: readFilePath,
        writeFile: writeFileSmart, fileWrite: writeFileSmart, deleteFile: deleteFileSmart, fileDelete: deleteFileSmart,
        setEnv: function (k, v) { if (typeof set_env_variable === 'function') set_env_variable(k, v); }, sleep: sleepMs,
        log: function () { console.log.apply(console, arguments); }, warn: function () { console.warn.apply(console, arguments); }, error: function () { console.error.apply(console, arguments); },
        githubTracker: function (r) { return githubTracker(r.owner, r.repo); }, smTracker: smTracker,
        swapToChecksToken: swapToChecksToken, restoreChecksToken: restoreChecksToken, checksAppToken: checksAppToken,
        fetchPrCommentList: fetchPrCommentList, fetchPrReviewThreadNodes: fetchPrReviewThreadNodes,
        getPr: function (r, n) { return github_get_pr({ workspace: r.owner, repository: r.repo, pullRequestId: n }); },
        mergePr: function (r, n) { return github_merge_pr({ workspace: r.owner, repository: r.repo, pullRequestId: Number(n), mergeMethod: 'squash' }); },
        getIssue: function (r, n) { return github_get_issue({ workspace: r.owner, repository: r.repo, issueNumber: n }); },
        getCommitCheckRuns: function (r, sha) { return github_get_commit_check_runs({ workspace: r.owner, repository: r.repo, commitSha: sha }); },
        listOpenPrs: function (r) { return github_list_prs({ workspace: r.owner, repository: r.repo, state: 'open' }); },
        listPrs: function (r, state) { return github_list_prs({ workspace: r.owner, repository: r.repo, state: state || 'open' }); },
        listWorkflowRuns: function (r, wf) {
            var args = { workspace: r.owner, repository: r.repo };
            if (wf) args.workflowId = wf;
            return github_list_workflow_runs(args);
        },
        get terminalPrMemo() { return terminalPrMemo; }, get tickFreshResets() { return tickFreshResets; }, get tickMovedPrs() { return tickMovedPrs; },
        get tickParkedRecorded() { return tickParkedRecorded; }, get tickWorkflowEscalations() { return tickWorkflowEscalations; }, get tickReposSeen() { return tickReposSeen; }
    };
}

function resolveHeadShaForRepo(r, it) { return parkAndActorProbesModule.resolveHeadSha(buildProbesDeps(), r, it); }
function failMarkerStateForRepo(r, n) { return verdictAndFailStateModule.failMarkerState(buildReworkVerdictsDeps(), r, n); }

function buildGuestTransplantDeps() {
    var base = buildIoDeps();
    base.getPrComments = function (r, n) { return github_get_pr_comments({ workspace: r.owner, repository: r.repo, pullRequestId: String(n) }); };
    base.getPrDiffText = typeof github_get_pr_diff_text === 'function' ? function (r, n) { return github_get_pr_diff_text({ workspace: r.owner, repository: r.repo, pullRequestId: String(n) }); } : null;
    base.getPrDiff = typeof github_get_pr_diff === 'function' ? function (r, n) { return github_get_pr_diff({ workspace: r.owner, repository: r.repo, pullRequestId: String(n) }); } : null;
    base.resolveHeadSha = resolveHeadShaForRepo;
    return base;
}

function buildSyncValidationDeps() {
    var base = buildIoDeps();
    base.syncMemo = syncMemo;
    base.onStampFailed = function () { tickStampsFailed++; };
    return base;
}

function stampValidationChecksForModule(repoInfo, headSha, status, conclusion, runUrl) {
    return validationCheckSyncModule.stampValidationChecksForModule(buildSyncValidationDeps(), repoInfo, headSha, status, conclusion, runUrl);
}

function syncValidationChecks(repoInfo, stampFn) {
    var sfn = stampFn || function (sha, st, co, url) { stampValidationChecksForModule(repoInfo, sha, st, co, url); };
    return validationCheckSyncModule.syncValidationChecks(buildSyncValidationDeps(), repoInfo, sfn);
}

function buildProbesDeps() {
    var d = buildIoDeps();
    d.runAsync = typeof runAsync === 'function' ? runAsync : null;
    d.evalWorker = function (src) { return eval('(' + src + ')'); };
    d.onMergedSlotSpent = function () { if (!tickMergeSlotSpent) tickMergeSlotSpent = 'merged'; };
    d.failMarkerState = failMarkerStateForRepo;
    d.headCheckRunsSafe = function (r, sha) { return validationProbesModule.headCheckRunsSafe(d, r, sha); };
    d.headWorkflowRunsSafe = function (r, sha) { return validationProbesModule.headWorkflowRunsSafe(d, r, sha); };
    d.stampValidationChecks = stampValidationChecksForModule;
    return d;
}

function buildReworkVerdictsDeps() {
    var pDeps = buildProbesDeps(), d = buildIoDeps();
    d.getTickReworkLatch = function () { return tickReworkLatch; };
    d.setTickReworkLatch = function (v) { tickReworkLatch = v; };
    d.resolveHeadSha = resolveHeadShaForRepo;
    d.headCheckRunsSafe = pDeps.headCheckRunsSafe;
    d.headWorkflowRunsSafe = pDeps.headWorkflowRunsSafe;
    d.headHasRealFailure = function (r, sha) { return validationProbesModule.headHasRealFailure(pDeps, r, sha); };
    d.hasActiveLegRun = workflowRunTrackingModule.hasActiveLegRun;
    d.bodyLinker = githubSourceModule && typeof githubSourceModule.linkedIssueNumber === 'function' ? githubSourceModule.linkedIssueNumber : function () { return null; };
    return d;
}

function buildWorkflowDispatchDeps() {
    var rvDeps = buildReworkVerdictsDeps(), pDeps = buildProbesDeps(), d = buildIoDeps();
    d.ruleBudgetRemaining = ruleBudgetRemaining;
    d.resolveHeadSha = resolveHeadShaForRepo;
    d.dropOpenPrsCache = tickOrchestratorModule.dropOpenPrsCache;
    d.auditReworkConsumption = function (r, t, l, p) { reworkAndVerdictsModule.auditReworkConsumption(rvDeps, r, t, l, p); };
    d.stampValidationChecks = stampValidationChecksForModule;
    d.freshShaResetOnce = function (r, it, k, oldHead, refresh) { return mergeAndParkProbesModule.freshShaResetOnce(pDeps, r, it, k, oldHead, refresh); };
    return d;
}

function buildBranchRefreshDeps(repoInfo, ticket, key, passState) {
    var pDeps = buildProbesDeps(), d = buildIoDeps();
    d.repoInfo = repoInfo; d.ticket = ticket; d.key = key; d.passState = passState || {};
    d.getPrComments = function (r, n) { return github_get_pr_comments({ workspace: r.owner, repository: r.repo, pullRequestId: String(n) }); };
    d.failMarkerState = failMarkerStateForRepo;
    d.resolveHeadSha = resolveHeadShaForRepo;
    d.freshHeadSha = function (r, n) { return parkAndActorProbesModule.freshHeadSha(buildProbesDeps(), r, n); };
    d.freshShaResetOnce = function (r, it, k, oldHead, refresh) { return mergeAndParkProbesModule.freshShaResetOnce(pDeps, r, it, k, oldHead, refresh); };
    return d;
}

function buildLocalAndStateDeps(effectiveConfig) {
    var wdDeps = buildWorkflowDispatchDeps(), d = buildIoDeps();
    if (effectiveConfig) Object.defineProperty(d, 'projectConfig', { get: function () { return effectiveConfig; } });
    d.runtimeModules = {
        ticketKeyShapesModule: ticketKeyShapesModule, gitlabTrackerModule: gitlabTrackerModule, trackersModule: trackersModule,
        linkedIssuesReportModule: linkedIssuesReportModule, tokenUsageCommentModule: tokenUsageCommentModule, smDoneCheckModule: smDoneCheckModule,
        aiChatModule: aiChatModule, validateInputJqlModule: validateInputJqlModule, buildEncodedConfigModule: buildEncodedConfigModule,
        autoStartModule: autoStartModule, commentMarkupModule: commentMarkupModule, quotaBreakerModule: quotaBreakerModule,
        machineAuthorModule: machineAuthorModule, reviewVerdictsModule: reviewVerdictsModule, tcRunRegistryModule: tcRunRegistryModule,
        ledgerCoreModule: ledgerCoreModule, tcMaintenanceLedgerModule: tcMaintenanceLedgerModule, tcAlternationModule: tcAlternationModule,
        tcTriageModule: tcTriageModule, bugBookkeepingModule: bugBookkeepingModule, jobTicketInputsModule: jobTicketInputsModule,
        configModule: configModule, configLoader: configLoader, scmModule: scmModule
    };
    d.evalLocalScript = function (script) { return eval(script); };
    d.loadRuleConfig = loadRuleConfig; d.logRuleQuery = logRuleQuery; d.queryRuleTickets = queryRuleTickets;
    d.firstMatchingLabel = workflowDispatchModule.firstMatchingLabel;
    d.shouldRecoverStaleTriggerLabel = workflowDispatchModule.shouldRecoverStaleTriggerLabel;
    d.removeRuleLabel = function (k, l, r, ri) { workflowDispatchModule.removeRuleLabel(wdDeps, k, l, r, ri); };
    d.moveStatus = function (k, s) { workflowDispatchModule.moveStatus(d, k, s); };
    d.addRuleLabels = function (k, r, ri) { workflowDispatchModule.addRuleLabels(wdDeps, k, r, ri); };
    d.getTickDeadZone = function () { return tickDeadZone; }; d.setTickDeadZone = function (dz) { tickDeadZone = dz; };
    d.getTickReworkLatch = function () { return tickReworkLatch; }; d.getTickZombiesSwept = function () { return tickZombiesSwept; };
    d.setSpMutex = function () {};
    d.validationCheckNames = function () { return validationCheckSyncModule.validationCheckNames(RUN_JOB_PARAMS); };
    d.takeMutexTickSnapshot = function () {
        return (githubSourceModule && typeof githubSourceModule.takeMutexTickSnapshot === 'function') ? githubSourceModule.takeMutexTickSnapshot() : null;
    };
    d.searchIssues = function (q) { return typeof github_search_issues === 'function' ? github_search_issues({ query: q }) : []; };
    return d;
}

function runRedVerdictForTicket(rule, ticket, key, repoInfo, effectiveConfig) {
    return prLifecycleActionsModule.runRedVerdictForTicket({
        rvDeps: buildReworkVerdictsDeps(), pDeps: buildProbesDeps(), redVerdictModule: redVerdictModule,
        machineAuthorModule: machineAuthorModule, validationProbesModule: validationProbesModule,
        reworkAndVerdictsModule: reworkAndVerdictsModule, verdictAndFailStateModule: verdictAndFailStateModule,
        dry: DRY, jobParams: RUN_JOB_PARAMS, githubTracker: githubTracker,
        resolveHeadSha: resolveHeadShaForRepo, failMarkerState: failMarkerStateForRepo, stampValidationChecks: stampValidationChecksForModule,
        getPrRaw: function (r, n) { return github_get_pr({ workspace: r.owner, repository: r.repo, pullRequestId: n }); },
        exec: function (opts) { cli_execute_command(opts); }
    }, rule, ticket, key, repoInfo, effectiveConfig);
}

function buildActionHandlerDeps(ticketHelpers) {
    return prLifecycleActionsModule.bindActionHandlerDeps(buildIoDeps(), {
        rvDeps: buildReworkVerdictsDeps(), pDeps: buildProbesDeps(), wdDeps: buildWorkflowDispatchDeps(), gtDeps: buildGuestTransplantDeps(),
        parkAndActorProbesModule: parkAndActorProbesModule, verdictAndFailStateModule: verdictAndFailStateModule,
        reworkAndVerdictsModule: reworkAndVerdictsModule, workflowDispatchModule: workflowDispatchModule,
        mergeAndParkProbesModule: mergeAndParkProbesModule, guestTransplantRunnerModule: guestTransplantRunnerModule,
        validationProbesModule: validationProbesModule, checkRunCuresModule: checkRunCuresModule,
        workflowRunTrackingModule: workflowRunTrackingModule, tickOrchestratorModule: tickOrchestratorModule,
        closeIssue: function (r, n) { github_close_issue({ workspace: r.owner, repository: r.repo, number: n }); },
        failMarkerState: failMarkerStateForRepo, resolveHeadSha: resolveHeadShaForRepo,
        freshHeadSha: function (r, n) { return parkAndActorProbesModule.freshHeadSha(buildProbesDeps(), r, n); },
        onZombiesSwept: function (c) { tickZombiesSwept += c; },
        stampValidationChecks: stampValidationChecksForModule, runRedVerdict: runRedVerdictForTicket
    }, ticketHelpers);
}

function buildRuleProcessorDeps(effectiveConfig) {
    var d = buildIoDeps();
    if (effectiveConfig) Object.defineProperty(d, 'projectConfig', { get: function () { return effectiveConfig; } });
    return prLifecycleActionsModule.bindRuleProcessorDeps(d, {
        wdDeps: buildWorkflowDispatchDeps(), gtDeps: buildGuestTransplantDeps(), rvDeps: buildReworkVerdictsDeps(),
        guestTransplantRunnerModule: guestTransplantRunnerModule, verdictAndFailStateModule: verdictAndFailStateModule,
        workflowRunTrackingModule: workflowRunTrackingModule, workflowDispatchModule: workflowDispatchModule,
        recordRepoSeen: function (r) { if (r && r.owner && r.repo) tickReposSeen[r.owner + '/' + r.repo] = r; },
        syncValidationChecks: syncValidationChecks, stampValidationChecks: stampValidationChecksForModule,
        ruleBudgetRemaining: ruleBudgetRemaining, getTickMergeReservedSlots: function () { return tickMergeReservedSlots; },
        setTickMergeSlotSpent: function (v) { if (!tickMergeSlotSpent) tickMergeSlotSpent = v; },
        logRuleQuery: logRuleQuery, queryRuleTickets: queryRuleTickets,
        buildBranchRefreshDeps: buildBranchRefreshDeps, buildActionDeps: buildActionHandlerDeps, buildStatePublishDeps: buildLocalAndStateDeps
    });
}

function processRule(rule, globalRepoInfo, ruleIndex, workflowBudget) {
    var effectiveConfig = loadRuleConfig(rule, projectConfig);
    var ruleTrackerProvider = smTracker(effectiveConfig).provider();
    if (rule.localExecution) {
        var localJql = configLoader.interpolateJql(configLoader.selectRuleQuery(rule, ruleTrackerProvider), effectiveConfig, ruleTrackerProvider);
        return localAndStateRunnerModule.processRuleLocally(buildLocalAndStateDeps(effectiveConfig), rule, globalRepoInfo, ruleIndex, effectiveConfig, localJql);
    }
    var interpolatedJql = configLoader.interpolateJql(configLoader.selectRuleQuery(rule, ruleTrackerProvider), effectiveConfig, ruleTrackerProvider);
    var rpDeps = buildRuleProcessorDeps(effectiveConfig);
    var early = ruleProcessorModule.checkProcessRuleEarlyExit(rpDeps, rule, ruleIndex, workflowBudget, !rule.localTeammate && !rule.localAction);
    if (early) return early;
    return ruleProcessorModule.processRule(rpDeps, rule, globalRepoInfo, ruleIndex, workflowBudget, effectiveConfig, interpolatedJql);
}

// Per-tick tunings (pr #1514, registry F5): ioCacheTtlMs rides jobParams
// into the smProvider io-cache holder, liveProbeTtlMs into the probe layer.
// Lives HERE because smProvider sits exactly at its module-size pin
// (1636/106) and cannot grow by a line — _cache is its exported
// machine-loop wiring surface (makeSmAgent's stub carries one too).
function applyTickTunings(p) {
    p = p || {};
    if (smProviderModule && smProviderModule._cache && typeof p.ioCacheTtlMs === 'number' && p.ioCacheTtlMs >= 0) {
        smProviderModule._cache.ttlMs = p.ioCacheTtlMs;
    }
    if (probeCacheModule && typeof probeCacheModule.applyProbeTuning === 'function') probeCacheModule.applyProbeTuning(p);
}

function buildTickOrchestratorDeps() {
    var rvDeps = buildReworkVerdictsDeps(), lsDeps = buildLocalAndStateDeps(), d = buildIoDeps();
    d.initTickState = function (p) {
        DRY = Boolean(p.dryRun); RUN_JOB_PARAMS = p;
        tickStampsFailed = 0; tickZombiesSwept = 0; tickMergeReservedSlots = 0;
        tickMergeReservationReleased = false; tickMergeSlotSpent = null; tickMergeSlotAccounted = false; tickL1CacheDropped = false;
        tickReposSeen = {}; tickMovedPrs = {}; tickFreshResets = {}; tickParkedRecorded = {}; tickWorkflowEscalations = {}; terminalPrMemo = {};
        tickReworkLatch = null; tickDeadZone = null; syncMemo = { repo: null, at: 0 };
        if (DRY) console.log('🧪 DRY-RUN mode — no workflows will be triggered, no transitions or labels applied');
        projectConfig = workflowDispatchModule.applyJobParamsScm(configLoader.loadProjectConfig(p), p);
        smForge = workflowDispatchModule.resolveSmForge(projectConfig);
        PRIORITY_LABELS = tickOrchestratorModule.resolvePriorityLabels(buildIoDeps(), projectConfig);
        if (smProviderModule && typeof smProviderModule.ioCacheReset === 'function') smProviderModule.ioCacheReset();
        applyTickTunings(RUN_JOB_PARAMS);
        var jsonCap = typeof p.maxTriggeredWorkflows === 'number' ? p.maxTriggeredWorkflows : p.maxWorkflowsPerRun;
        var cap = tickOrchestratorModule.resolveWorkflowCap(buildIoDeps(), jsonCap, projectConfig);
        var workflowBudget = cap ? { initial: cap, remaining: cap, activeCount: 0, activeCountsByWorkflow: {}, activeRunSummariesByWorkflow: {} } : null;
        return { projectConfig: projectConfig, workflowBudget: workflowBudget };
    };
    d.recordRepoSeen = function (r) { if (r && r.owner && r.repo) tickReposSeen[r.owner + '/' + r.repo] = r; };
    d.applyRuleOverrides = function (rules, overrides) { return tickOrchestratorModule.applyRuleOverrides(d, rules, overrides); };
    d.resolveValidationConcurrency = function (p, cfg) { return tickOrchestratorModule.resolveValidationConcurrency(d, p, cfg); };
    d.effectiveValidationConcurrency = tickOrchestratorModule.effectiveValidationConcurrency;
    d.approvedQueueDepth = function (ri) { return tickOrchestratorModule.approvedQueueDepth(d, ri); };
    d.reportValidationCost = function (ri, cfg, max) { return tickOrchestratorModule.reportValidationCost(d, ri, cfg, max); };
    d.processRule = processRule;
    d.setTickMergeReservedSlots = function (n) { tickMergeReservedSlots = n; };
    d.getTickMergeReservedSlots = function () { return tickMergeReservedSlots; };
    d.setTickMergeReservationReleased = function (v) { tickMergeReservationReleased = v; };
    d.getTickMergeReservationReleased = function () { return tickMergeReservationReleased; };
    d.getTickMergeSlotSpent = function () { return tickMergeSlotSpent; };
    d.getTickMergeSlotAccounted = function () { return tickMergeSlotAccounted; };
    d.setTickMergeSlotAccounted = function (v) { tickMergeSlotAccounted = v; };
    d.getTickL1CacheDropped = function () { return tickL1CacheDropped; };
    d.setTickL1CacheDropped = function (v) { tickL1CacheDropped = v; };
    d.dropAllSeenReposCache = function () { Object.keys(tickReposSeen).forEach(function (rk) { tickOrchestratorModule.dropOpenPrsCache(tickReposSeen[rk]); }); };
    d.getSmForge = function () { return smForge; };
    d.runNakedPrSweep = function (ri) { return verdictAndFailStateModule.runNakedPrSweep(rvDeps, ri); };
    d.getTickStampsFailed = function () { return tickStampsFailed; };
    d.ensureDeadZoneScan = function (ma) { return localAndStateRunnerModule.ensureDeadZoneScan(lsDeps, ma); };
    d.publishFactoryStateOnce = function (rule, cfg, ri, keys) { localAndStateRunnerModule.maybePublishFactoryState(buildLocalAndStateDeps(cfg), rule, cfg, ri, keys); };
    return d;
}

function action(params) { return tickOrchestratorModule.runAction(buildTickOrchestratorDeps(), params); }

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action, processRule: processRule, loadRuleConfig: loadRuleConfig,
        // pr #1514 F5: per-tick TTL tunings (io-cache holder + probe layer)
        applyTickTunings: applyTickTunings,
        readLocalActionSource: function (jsPath, readFile) { return localAndStateRunnerModule.readLocalActionSource(readFile || function (p) { return file_read({ path: p }); }, jsPath); },
        runLocalAction: function (jsPath, ticket, agentParams) { return localAndStateRunnerModule.runLocalAction(buildLocalAndStateDeps(), jsPath, ticket, agentParams); },
        probeDispatchedState: function (repoInfo, ciWorkflow, headSha) { return mergeAndParkProbesModule.probeDispatchedState(buildProbesDeps(), repoInfo, ciWorkflow, headSha); },
        hasRecentHeadRun: validationProbesModule.hasRecentHeadRun,
        recentlyConcludedNonGreen: function (probe, repoInfo, headSha) { return mergeAndParkProbesModule.recentlyConcludedNonGreen(buildProbesDeps(), probe, repoInfo, headSha); },
        dispatchRaceGraceMs: tickOrchestratorModule.dispatchRaceGraceMs,
        resolveValidationConcurrency: function (jobParams, projectCfg) { return tickOrchestratorModule.resolveValidationConcurrency(buildIoDeps(), jobParams, projectCfg); },
        effectiveValidationConcurrency: tickOrchestratorModule.effectiveValidationConcurrency,
        reportValidationCost: function (repoInfo, cfg, mutexMax) { return tickOrchestratorModule.reportValidationCost(buildTickOrchestratorDeps(), repoInfo, cfg, mutexMax); },
        resolvePriorityLabels: function (projectCfg) { return tickOrchestratorModule.resolvePriorityLabels(buildIoDeps(), projectCfg); },
        applyRuleOverridesForTest: function (rules, overrides) { return tickOrchestratorModule.applyRuleOverrides(buildIoDeps(), rules, overrides); },
        recordDispatchFailure: function (repoInfo, ticketKey, item, err, expandedRef, failClass) { return workflowDispatchModule.recordDispatchFailure(buildWorkflowDispatchDeps(), repoInfo, ticketKey, item, err, expandedRef, failClass); },
        ruleBudgetRemaining: ruleBudgetRemaining, syncValidationChecks: syncValidationChecks, stampValidationChecksForModule: stampValidationChecksForModule,
        stampLinkBlock: function (repoInfo, runUrl, conclusion) { return validationCheckSyncModule.stampLinkBlock(buildSyncValidationDeps(), repoInfo, runUrl, conclusion); },
        dispatchedValidationRuns: function (r, wf) { return validationProbesModule.dispatchedValidationRuns(buildProbesDeps(), r, wf); },
        failingCheckNames: function (r, sha) { return validationProbesModule.failingCheckNames(buildProbesDeps(), r, sha); },
        headCheckRunsSafe: function (r, sha) { return validationProbesModule.headCheckRunsSafe(buildProbesDeps(), r, sha); },
        latestCheckRunConclusions: validationProbesModule.latestCheckRunConclusions,
        headHasRealFailure: function (r, sha) { return validationProbesModule.headHasRealFailure(buildProbesDeps(), r, sha); },
        headWorkflowRunsSafe: function (r, sha) { return validationProbesModule.headWorkflowRunsSafe(buildProbesDeps(), r, sha); },
        headCheckRunZombies: function (r, sha) { return validationProbesModule.headCheckRunZombies(buildProbesDeps(), r, sha); },
        headPlaceholders: function (r, sha) { return validationProbesModule.headPlaceholders(buildProbesDeps(), r, sha); },
        headOrphanedRunChecks: function (r, sha) { return validationProbesModule.headOrphanedRunChecks(buildProbesDeps(), r, sha); },
        fetchPrCommentList: fetchPrCommentList, fetchPrReviewThreadNodes: fetchPrReviewThreadNodes,
        checksAppToken: checksAppToken, swapToChecksToken: swapToChecksToken, restoreChecksToken: restoreChecksToken
    };
}
