/**
 * Active workflow run inspection, budget accounting, and leg-in-flight guards —
 * js/sm/workflowRunTracking.js (#1459).
 */
'use strict';

var branchLegGuardModule = require('../common/branchLegGuard.js');
var labelListModule = require('../common/labelList.js');
var prTerminalStateModule = require('../common/prTerminalState.js');
var scmModule = require('../common/scm.js');
var workflowRunsModule = require('../common/workflowRuns.js');
var STALE_NON_RUNNING_WORKFLOW_MS = 6 * 60 * 60 * 1000;
function withScmProvider(config, provider) {
  var cfg = Object.assign({}, config || {});
  var scm = Object.assign({}, cfg.scm || {});
  scm.provider = provider;
  cfg.scm = scm;
  return cfg;
}
function applyJobParamsScm(config, jobParams) {
  var want = jobParams && jobParams.scm && jobParams.scm.provider;
  if (!want || !config) return config;
  return config.scm && config.scm.provider === want ? config : withScmProvider(config, want);
}
function applyRuleForge(config, rule) {
  if (!config || !rule || rule.source !== 'gitlab') return config;
  return withScmProvider(config, 'gitlab');
}
function resolveSmForge(config) {
  return config && config.scm && config.scm.provider === 'gitlab' ? 'gitlab' : 'github';
}
function isForgeSource(rule) {
  return !!rule && (rule.source === 'github' || rule.source === 'gitlab');
}
function firstMatchingLabel(ticket, labels) {
  var itemLabels = ticket && (ticket.labels || ticket.fields && ticket.fields.labels) || [];
  var list = labels || [];
  for (var i = 0; i < list.length; i++) {
    if (itemLabels.indexOf(list[i]) !== -1) return list[i];
  }
  return null;
}
function shouldRecoverStaleTriggerLabel(rule, label) {
  if (rule.recoverStaleTriggerLabel === true) return true;
  if (rule.recoverStaleTriggerLabel === false) return false;
  var labels = labelListModule.normalizeLabels(rule.addLabel, rule.addLabels);
  return labels.indexOf(label) !== -1;
}
function createTargetScm(effectiveConfig, repoInfo) {
  if (!repoInfo || !repoInfo.owner || !repoInfo.repo) return scmModule.createScm(effectiveConfig);
  var cfg = Object.assign({}, effectiveConfig || {});
  cfg.repository = { owner: repoInfo.owner, repo: repoInfo.repo };
  return scmModule.createScm(cfg);
}
function isWorkflowBudgetExhausted(deps, rule, effectiveConfig, workflowBudget, repoInfo) {
  if (!workflowBudget) return false;
  var workflowFile = rule.workflowFile || 'ai-teammate.yml';
  var scm = createTargetScm(effectiveConfig, repoInfo);
  ensureWorkflowBudgetActiveCount(deps, workflowBudget, scm, workflowFile);
  return deps.ruleBudgetRemaining(rule, workflowBudget) <= 0;
}
function parseRawPrObj(raw) {
  var obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return obj && typeof obj === 'object' && !obj.message ? obj : null;
}
function prRawRead(deps, repoInfo, prNumber, warnPrefix) {
  if (!deps.hasGetPr) return null;
  try {
    return parseRawPrObj(deps.getPr(repoInfo, String(prNumber)));
  } catch (e) {
    if (warnPrefix) deps.warn(warnPrefix + (e.message || e));
    return null;
  }
}
function terminalPrMemoKey(repoInfo, prNumber) {
  var r = repoInfo || {};
  return (r.owner || '?') + '/' + (r.repo || '?') + '#' + String(prNumber);
}
function prTerminalStateOf(deps, repoInfo, prNumber, opts) {
  var memo = deps.terminalPrMemo || {};
  var memoKey = terminalPrMemoKey(repoInfo, prNumber);
  if (!(opts && opts.fresh) && typeof memo[memoKey] !== 'undefined') return memo[memoKey];
  var pr = prRawRead(deps, repoInfo, prNumber);
  var terminal = !!pr && prTerminalStateModule.isTerminalPrState(pr.state, pr.merged === true);
  memo[memoKey] = terminal;
  return terminal;
}
function ruleTargetSelfManagesLabel(deps, rule) {
  var addLabels = labelListModule.normalizeLabels(rule.addLabel, rule.addLabels);
  if (!addLabels.length || !rule.configFile) {
    return false;
  }
  try {
    var raw = deps.fileRead(rule.configFile);
    var targetConfig = JSON.parse(raw);
    var customParams = targetConfig.params && targetConfig.params.customParams || {};
    var removeLabels = labelListModule.normalizeLabels(customParams.removeLabel, customParams.removeLabels);
    return addLabels.some(function (label) {
      return removeLabels.indexOf(label) !== -1;
    });
  } catch (e) {
    return false;
  }
}
function hasValidNumber(val) {
  return val !== undefined && val !== null;
}
function crossAnchorKeys(item) {
  var it = item || {};
  var key = String(it.key || '');
  if (key.indexOf('pr-') === 0 && hasValidNumber(it.issueNumber)) {
    return ['gh-' + it.issueNumber];
  }
  if (key.indexOf('gh-') === 0 && hasValidNumber(it.prNumber)) {
    return ['pr-' + it.prNumber];
  }
  return [];
}
function isAnchorKeyChar(ch) {
  return ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch === '-';
}
function anchorTokens(ticketKey) {
  var tokens = ['· ' + ticketKey];
  var m = /^gh-(\d+)$/.exec(String(ticketKey));
  if (m) {
    tokens.push('#' + m[1]);
  }
  return tokens;
}
function tokenMatchesWholeInTitle(runName, token) {
  var from = 0;
  while (from <= runName.length - token.length) {
    var idx = runName.indexOf(token, from);
    if (idx === -1) {
      return false;
    }
    if (!isAnchorKeyChar(runName.charAt(idx + token.length))) {
      return true;
    }
    from = idx + 1;
  }
  return false;
}
function stubAnchorMatches(runName, ticketKey) {
  var tokens = anchorTokens(ticketKey);
  for (var t = 0; t < tokens.length; t++) {
    if (tokenMatchesWholeInTitle(runName, tokens[t])) {
      return true;
    }
  }
  return false;
}
function isStaleNonRunningWorkflowRun(run, status) {
  if (status === 'in_progress') {
    return false;
  }
  var timestamp = workflowRunsModule.workflowRunTimestamp(run);
  if (!timestamp) {
    return false;
  }
  return Date.now() - timestamp > STALE_NON_RUNNING_WORKFLOW_MS;
}
function runTitleOf(run) {
  return run && (run.display_title || run.displayTitle || run.name) || '';
}
function matchesTargetWorkflowRun(runName, configFile, ticketKey) {
  var expectedRunName = configFile + ' : ' + ticketKey;
  if (runName === expectedRunName) {
    return true;
  }
  var expectedSuffix = ' : ' + ticketKey;
  var matchesDisplay = runName.indexOf(configFile + ' : ') === 0 && runName.substring(runName.length - expectedSuffix.length) === expectedSuffix;
  return matchesDisplay || stubAnchorMatches(runName, ticketKey);
}
function findMatchingActiveRunInList(runs, status, configFile, ticketKey) {
  for (var j = 0; j < runs.length; j++) {
    var run = runs[j] || {};
    if (!isStaleNonRunningWorkflowRun(run, status) && matchesTargetWorkflowRun(runTitleOf(run), configFile, ticketKey)) {
      return true;
    }
  }
  return false;
}
function scanActiveStatusRuns(scm, workflowFile, matchRuns) {
  if (!scm || typeof scm.listWorkflowRuns !== 'function') {
    return false;
  }
  return workflowRunsModule.eachActiveStatusRun(scm, workflowFile, '  ⚠️  Could not inspect active workflow runs', [], function (status, runsRaw) {
    return matchRuns(status, workflowRunsModule.parseWorkflowRuns(runsRaw));
  });
}
function hasActiveTargetWorkflowRun(deps, scm, workflowFile, configFile, ticketKey) {
  var expectedRunName = configFile + ' : ' + ticketKey;
  return scanActiveStatusRuns(scm, workflowFile, function (status, runs) {
    if (!findMatchingActiveRunInList(runs, status, configFile, ticketKey)) {
      return false;
    }
    deps.log('  ⏭️  ' + ticketKey + ' skipped (active workflow already exists: ' + expectedRunName + ')');
    return true;
  });
}
function legGuardOpts(workflowFile) {
  return {
    workflowFile: workflowFile,
    staleNonRunningMs: STALE_NON_RUNNING_WORKFLOW_MS,
    nowMs: Date.now()
  };
}
function hasActiveLegRunOnBranch(scm, workflowFile, branch) {
  if (!branch) {
    return false;
  }
  return scanActiveStatusRuns(scm, workflowFile, function (_status, runs) {
    return branchLegGuardModule.hasActiveLegRunOnBranch(runs, branch, legGuardOpts(workflowFile));
  });
}
function hasActiveLegRunForPull(scm, workflowFile, prNumber) {
  if (!prNumber) {
    return false;
  }
  return scanActiveStatusRuns(scm, workflowFile, function (_status, runs) {
    return branchLegGuardModule.hasActiveLegRunForPull(runs, prNumber, legGuardOpts(workflowFile));
  });
}
function isActiveWorkflowStatus(status) {
  return status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'pending';
}
function isActiveNonStaleRun(r) {
  if (!r || !isActiveWorkflowStatus(r.status)) {
    return false;
  }
  return !(r.status !== 'in_progress' && isStaleNonRunningWorkflowRun(r, r.status));
}
function hasActiveLegRun(runs, workflowFile) {
  var suffix = '/' + String(workflowFile || 'ai-teammate.yml');
  return (runs || []).some(function (r) {
    if (!isActiveNonStaleRun(r)) {
      return false;
    }
    var p = String(r.path || '');
    return p.length >= suffix.length && p.slice(p.length - suffix.length) === suffix;
  });
}
function runSummaryId(r) {
  return r.id || r.databaseId || r.run_number || r.runNumber;
}
function runSummaryUrl(r) {
  return r.html_url || r.htmlUrl || r.url || '';
}
function formatWorkflowRunSummary(run, fallbackStatus) {
  var r = run || {};
  var title = runTitleOf(r) || 'workflow run';
  var status = r.status || fallbackStatus;
  var age = workflowRunsModule.workflowRunAge(r) || '?';
  var idDisp = runSummaryId(r) || '?';
  var base = title + ' [' + status + ', age ' + age + ', id ' + idDisp + ']';
  var url = runSummaryUrl(r);
  return url ? base + ' ' + url : base;
}
function recordActiveStatusRun(run, idx, status, seen, summaries) {
  if (!run || isStaleNonRunningWorkflowRun(run, status)) {
    return 0;
  }
  var id = runSummaryId(run) || runTitleOf(run) + ':' + idx + ':' + status;
  if (seen[id]) {
    return 0;
  }
  seen[id] = true;
  summaries.push(formatWorkflowRunSummary(run, status));
  return 1;
}
function collectActiveWorkflowRuns(scm, workflowFile) {
  if (!scm || typeof scm.listWorkflowRuns !== 'function') {
    return {
      count: 0,
      summaries: []
    };
  }
  var seen = {};
  var count = 0;
  var summaries = [];
  workflowRunsModule.eachActiveStatusRun(scm, workflowFile, '  ⚠️  Could not count active workflow runs', [], function (status, runsRaw) {
    var list = workflowRunsModule.parseWorkflowRuns(runsRaw);
    list.forEach(function (item, idx) {
      count += recordActiveStatusRun(item, idx, status, seen, summaries);
    });
    return false;
  });
  return {
    count: count,
    summaries: summaries
  };
}
function logBlockingWorkflowRuns(deps, workflowBudget, workflowFile) {
  if (!workflowBudget || !workflowBudget.activeRunSummariesByWorkflow) {
    return;
  }
  var summaries = workflowBudget.activeRunSummariesByWorkflow[workflowFile] || [];
  if (!summaries.length) {
    return;
  }
  deps.log('  Blocking active workflow run(s):');
  summaries.slice(0, 5).forEach(function (summary) {
    deps.log('   - ' + summary);
  });
  if (summaries.length > 5) {
    deps.log('   - ... +' + (summaries.length - 5) + ' more');
  }
}
function initBudgetMaps(workflowBudget, workflowFile) {
  if (!workflowBudget) {
    return false;
  }
  if (!workflowBudget.activeCountsByWorkflow) {
    workflowBudget.activeCountsByWorkflow = {};
  }
  if (workflowBudget.activeCountsByWorkflow[workflowFile]) {
    return false;
  }
  if (!workflowBudget.activeRunSummariesByWorkflow) {
    workflowBudget.activeRunSummariesByWorkflow = {};
  }
  return true;
}
function ensureWorkflowBudgetActiveCount(deps, workflowBudget, scm, workflowFile) {
  if (!initBudgetMaps(workflowBudget, workflowFile)) {
    return;
  }
  var active = collectActiveWorkflowRuns(scm, workflowFile);
  workflowBudget.activeCount = (workflowBudget.activeCount || 0) + active.count;
  workflowBudget.remaining = Math.max(0, workflowBudget.remaining - active.count);
  workflowBudget.activeCountsByWorkflow[workflowFile] = true;
  workflowBudget.activeRunSummariesByWorkflow[workflowFile] = active.summaries;
  if (active.count > 0) {
    deps.log('  Active workflow cap accounting: ' + active.count + ' active, ' + workflowBudget.remaining + ' dispatch slot(s) left');
    logBlockingWorkflowRuns(deps, workflowBudget, workflowFile);
  }
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      STALE_NON_RUNNING_WORKFLOW_MS: STALE_NON_RUNNING_WORKFLOW_MS,
      withScmProvider: withScmProvider,
      applyJobParamsScm: applyJobParamsScm,
      applyRuleForge: applyRuleForge,
      resolveSmForge: resolveSmForge,
      isForgeSource: isForgeSource,
      firstMatchingLabel: firstMatchingLabel,
      shouldRecoverStaleTriggerLabel: shouldRecoverStaleTriggerLabel,
      createTargetScm: createTargetScm,
      isWorkflowBudgetExhausted: isWorkflowBudgetExhausted,
      prRawRead: prRawRead,
      prTerminalStateOf: prTerminalStateOf,
      ruleTargetSelfManagesLabel: ruleTargetSelfManagesLabel,
      crossAnchorKeys: crossAnchorKeys,
      isAnchorKeyChar: isAnchorKeyChar,
      anchorTokens: anchorTokens,
      stubAnchorMatches: stubAnchorMatches,
      isStaleNonRunningWorkflowRun: isStaleNonRunningWorkflowRun,
      hasActiveTargetWorkflowRun: hasActiveTargetWorkflowRun,
      hasActiveLegRunOnBranch: hasActiveLegRunOnBranch,
      hasActiveLegRunForPull: hasActiveLegRunForPull,
      hasActiveLegRun: hasActiveLegRun,
      formatWorkflowRunSummary: formatWorkflowRunSummary,
      collectActiveWorkflowRuns: collectActiveWorkflowRuns,
      logBlockingWorkflowRuns: logBlockingWorkflowRuns,
      ensureWorkflowBudgetActiveCount: ensureWorkflowBudgetActiveCount
    };
}
