/**
 * Workflow dispatch, rule labels/statuses, and local teammate runner —
 * js/sm/workflowDispatch.js (#1459).
 */
'use strict';

var buildEncodedConfigModule = require('../common/buildEncodedConfig.js');
var configLoader = require('../configLoader.js');
var configModule = require('../config.js');
var forkDispatchModule = require('../common/forkDispatch.js');
var labelListModule = require('../common/labelList.js');
var prTerminalStateModule = require('../common/prTerminalState.js');
var dispatchInputsModule = require('./dispatchInputs.js');
var scmModule = require('../common/scm.js');
var triggerFailuresModule = require('../common/triggerFailures.js');
var validationLivenessModule = require('../common/validationLiveness.js');
var workflowRunTrackingModule = require('./workflowRunTracking.js');
var TERMINAL_PR_SKIP_MSG = 'terminal PR — dispatch skipped';
// gh-1540 — the in-tick dispatch latch: one SM tick can evaluate several
// dispatch lanes against the SAME world (the live PR #1536 incident: two
// review arming rules matched the same rework-close state 4 seconds apart
// and both legs ran in parallel). The run-list probes (gh-715 / gh-806 /
// gh-1028) are list-based — a run created seconds ago is not yet visible —
// and labels alone cannot close the window because leg A has not started
// (and has not set ai_reviewing) when the second lane evaluates in the same
// tick. This set is the arbiter: keyed branch::leg, consulted before the
// trigger, recorded after a successful one. Module-level state is tick-state
// by construction (one fresh GraalJS engine per tick); the explicit reset in
// smAgent's initTickState keeps that true even for multi-action callers.
var inTickDispatchLatch = {};
function inTickDispatchKey(item, rule) {
  var it = item || {};
  if (!it.branch) return null;
  var leg = (rule && rule.inputs && rule.inputs.leg) || '';
  return String(it.branch) + '::' + String(leg);
}
function inTickDispatchSeen(item, rule) {
  var key = inTickDispatchKey(item, rule);
  return !!key && !!inTickDispatchLatch[key];
}
function recordInTickDispatch(item, rule) {
  var key = inTickDispatchKey(item, rule);
  if (key) inTickDispatchLatch[key] = true;
}
function resetInTickDispatchLatch() { inTickDispatchLatch = {}; }
var TAG_ONLY_STAGE_KEYS = {
  PASSED: true, FAILED: true, IN_REVIEW_PASSED: true, IN_REVIEW_FAILED: true,
  SKIPPED: true, IRRELEVANT: true, BUG_TO_FIX: true, IN_TESTING: true,
  READY_FOR_TESTING: true, MERGED: true
};
var withScmProvider = workflowRunTrackingModule.withScmProvider;
var applyJobParamsScm = workflowRunTrackingModule.applyJobParamsScm;
var applyRuleForge = workflowRunTrackingModule.applyRuleForge;
var resolveSmForge = workflowRunTrackingModule.resolveSmForge;
var isForgeSource = workflowRunTrackingModule.isForgeSource;
var firstMatchingLabel = workflowRunTrackingModule.firstMatchingLabel;
var shouldRecoverStaleTriggerLabel = workflowRunTrackingModule.shouldRecoverStaleTriggerLabel;
var createTargetScm = workflowRunTrackingModule.createTargetScm;
var isWorkflowBudgetExhausted = workflowRunTrackingModule.isWorkflowBudgetExhausted;
var prRawRead = workflowRunTrackingModule.prRawRead;
var prTerminalStateOf = workflowRunTrackingModule.prTerminalStateOf;
var ruleTargetSelfManagesLabel = workflowRunTrackingModule.ruleTargetSelfManagesLabel;
function gitlabRuleLabel(deps, ticketKey, label, repoInfo, add) {
  var sign = add ? ' +' : ' -';
  var m = /^pr-(\d+)$/.exec(String(ticketKey));
  if (!m) {
    deps.warn('  ⚠️  gitlab: no issue-label tool — ' + ticketKey + sign + label + ' skipped');
    return;
  }
  if (deps.dry) {
    deps.log('  [dry] 🏷️ ' + ticketKey + sign + label);
    return;
  }
  var scm = createTargetScm(withScmProvider(deps.projectConfig, 'gitlab'), repoInfo);
  if (add) scm.addLabel(m[1], label);
  else scm.removeLabel(m[1], label);
}
function githubRuleLabel(deps, ticketKey, label, repoInfo, add) {
  var n = /(\d+)$/.exec(String(ticketKey));
  if (!n) return !add;
  if (!add && deps.dry) {
    deps.log('  [dry] 🏷️ ' + ticketKey + ' -' + label);
    return false;
  }
  var tr = deps.githubTracker(repoInfo);
  if (add) tr.addLabel(parseInt(n[1], 10), label);
  else tr.removeLabel(parseInt(n[1], 10), label);
  return true;
}
function dispatchRuleLabelOp(deps, ticketKey, label, rule, repoInfo, add) {
  var source = rule && rule.source;
  if (source === 'gitlab') {
    gitlabRuleLabel(deps, ticketKey, label, repoInfo, add);
    return true;
  }
  if (source === 'github') return githubRuleLabel(deps, ticketKey, label, repoInfo, add);
  if (deps.dry) {
    deps.log('  [dry] 🏷️ ' + ticketKey + (add ? ' +' : ' -') + label);
    return true;
  }
  if (add) deps.smTracker().addLabel(ticketKey, label);
  else deps.smTracker().removeLabel(ticketKey, label);
  return true;
}
function addRuleLabels(deps, ticketKey, rule, repoInfo) {
  labelListModule.normalizeLabels(rule.addLabel, rule.addLabels).forEach(function (label) {
    try { dispatchRuleLabelOp(deps, ticketKey, label, rule, repoInfo, true); } catch (e) {}
  });
}
function removeRuleLabel(deps, ticketKey, label, rule, repoInfo) {
  if (!ticketKey || !label) return;
  try {
    if (dispatchRuleLabelOp(deps, ticketKey, label, rule, repoInfo, false)) {
      deps.log('  🏷️  Removed stale trigger label "' + label + '" from ' + ticketKey);
    }
  } catch (e) {
    deps.warn('  ⚠️  Could not remove stale trigger label "' + label + '" from ' + ticketKey + ': ' + (e.message || e));
  }
}
function findDefaultStageKey(defaultStatuses, statusName) {
  var wanted = String(statusName || '').toLowerCase();
  if (!wanted) return null;
  var def = defaultStatuses || {};
  return Object.keys(TAG_ONLY_STAGE_KEYS).find(function (k) {
    return String(def[k] || '').toLowerCase() === wanted;
  }) || null;
}
function stageKeyForStatusName(projectConfig, defaultStatuses, statusName) {
  var statuses = projectConfig && projectConfig.jira && projectConfig.jira.statuses || {};
  var exact = Object.keys(TAG_ONLY_STAGE_KEYS).find(function (k) {
    return statuses[k] === statusName;
  });
  return exact || findDefaultStageKey(defaultStatuses, statusName);
}
function moveStatus(deps, ticketKey, targetStatus) {
  try {
    if (deps.dry) {
      deps.log('  [dry] 🔀 ' + ticketKey + ' → ' + targetStatus);
    } else {
      var stageKey = stageKeyForStatusName(deps.projectConfig, configModule.STATUSES, targetStatus);
      if (stageKey) {
        deps.smTracker().moveToStatusOrMark(ticketKey, targetStatus, stageKey);
      } else {
        deps.smTracker().moveToStatusStrict(ticketKey, targetStatus);
      }
    }
    deps.log('  ✅ ' + ticketKey + ' → ' + targetStatus);
  } catch (e) {
    deps.warn('  ⚠️  Status transition failed for ' + ticketKey + ': ' + (e.message || e));
  }
}
function forkPullRefLive(deps, repoInfo, prNumber) {
  var ref = forkDispatchModule.pullHeadRef(prNumber);
  var full = repoInfo.owner + '/' + repoInfo.repo;
  var targetUrl = validationLivenessModule.forkPushTokenUrl(full);
  try {
    var res = deps.exec({
      command: 'git ls-remote ' + targetUrl + ' ' + ref
    });
    var out = String((res || {}).output || (res || {}).stdout || res || '');
    return out.indexOf(ref) !== -1;
  } catch (eProbe) {
    deps.warn('  ⚠️  fork pull-ref probe DEGRADED for ' + ref + ' (pr-' + prNumber + ', ' + full + ' probe failed: ' + (eProbe.message || eProbe) + ') — treating the head as LIVE (fail-open, gh-1075)');
    return true;
  }
}
function buildDeadHeadParkBody(markKey, msg, count, cap, headSha) {
  var forkPark = String(markKey).indexOf('refs/pull/') === 0;
  var goneLine = forkPark ? ' The PR head (fork) is gone — `' + markKey + '` no longer resolves' : ' The head branch `' + markKey + '` no longer exists';
  var restoreLine = forkPark ? ' Restore the fork and re-push the head' : ' Restore or re-push the branch';
  var parkBody = '🅿️ validation_failed — dispatch dead-head park (gh-922).' + goneLine + ' — every dispatch fails (' + msg + ').' + ' The PR is parked: it cannot preempt the queue and no legs are dispatched against it.' + restoreLine + ' — a fresh push clears the park automatically' + ' (the head-change reset fires on the new sha; a human re-push also clears a legacy park).' + '\n' + triggerFailuresModule.triggerFailMarkerLine(count, markKey, cap, new Date().toISOString());
  return headSha ? parkBody + '\nparked-head: ' + headSha : parkBody;
}
function writeNoRefVerdict(deps, repoInfo, ticketKey, item, err, markKey, count, cap) {
  var headSha = null;
  try {
    headSha = deps.resolveHeadSha(repoInfo, item);
  } catch (eSha) {
    headSha = null;
  }
  var tr = deps.githubTracker(repoInfo);
  var msg = String(err && err.message || err).replace(/\s+/g, ' ').trim();
  if (count >= cap) {
    tr.addLabel(item.prNumber, 'validation_failed');
    tr.postComment(item.prNumber, buildDeadHeadParkBody(markKey, msg, count, cap, headSha));
    deps.dropOpenPrsCache(repoInfo);
    deps.log('  🅿️  ' + ticketKey + ' dispatch dead-head (' + count + '/' + cap + ' no-ref failures on ' + markKey + ') — validation_failed park, slot stays open');
    return;
  }
  tr.postComment(item.prNumber, triggerFailuresModule.triggerFailMarkerLine(count, markKey, cap, new Date().toISOString()) + '\nThe workflow dispatch failed with a non-retryable no-ref error (' + msg + ').' + ' The dispatch slot was yielded to the next candidate in the queue (fail-open, gh-922).' + ' ' + (cap - count) + ' more failure(s) on this head park the PR validation_failed.');
  deps.log('  ⏭️  ' + ticketKey + ' trigger failed (no-ref) — attempt ' + count + '/' + cap + ' recorded on ' + markKey + '; the slot yields to the next candidate (fail-open, gh-922)');
}
function isNoRefBookkeepingSkipped(deps, item) {
  if (deps.smForge !== 'github' || (item.labels || []).indexOf('validation_failed') !== -1) {
    return true;
  }
  return !!(deps.tickParkedRecorded && deps.tickParkedRecorded[item.prNumber]);
}
function nextTriggerFailCount(deps, repoInfo, prNumber, markKey) {
  try {
    var bodies = deps.fetchPrCommentList(repoInfo, prNumber).map(function (c) {
      return String(c && c.body || '');
    });
    return (triggerFailuresModule.triggerFailMarks(bodies)[markKey] || 0) + 1;
  } catch (eRead) {
    return 1;
  }
}
function recordNoRefBookkeeping(deps, repoInfo, ticketKey, item, err, markKey) {
  var cap = triggerFailuresModule.capOf(deps.jobParams);
  if (cap <= 0 || isNoRefBookkeepingSkipped(deps, item)) {
    return;
  }
  if (deps.tickParkedRecorded) {
    deps.tickParkedRecorded[item.prNumber] = true;
  }
  var count = nextTriggerFailCount(deps, repoInfo, item.prNumber, markKey);
  writeNoRefVerdict(deps, repoInfo, ticketKey, item, err, markKey, count, cap);
}
function recordForkNoRefFailure(deps, repoInfo, ticketKey, item, err) {
  if (forkDispatchModule.classifyForkNoRef(forkPullRefLive(deps, repoInfo, item.prNumber)) === 'live') {
    deps.log('  ⏭️  ' + ticketKey + ' trigger failed (no-ref) on a fork head ignored — ' + forkDispatchModule.pullHeadRef(item.prNumber) + ' is fetchable (gh-1075 AC2: never head-dead evidence for a cross-repo PR).' + ' NOTE: the branch-targeted validate_pr lane stays fork-blind for pr-' + item.prNumber + ' (gh-1075 fork-blind — the CI reroute is tracked in the' + ' #1074 observability lane); a live fork head can arm validation only' + ' after that lands.');
    return;
  }
  recordNoRefBookkeeping(deps, repoInfo, ticketKey, item, err, forkDispatchModule.pullHeadRef(item.prNumber));
}
function isNoRefFailureEligible(deps, failClass, item) {
  return !deps.dry && failClass === 'no-ref' && !!(item && item.prNumber && item.branch);
}
function recordDispatchFailure(deps, repoInfo, ticketKey, item, err, expandedRef, failClass) {
  if (!isNoRefFailureEligible(deps, failClass, item)) {
    return;
  }
  if (prTerminalStateOf(deps, repoInfo, item.prNumber, { fresh: true })) {
    deps.log('  ⏭️  ' + ticketKey + ' PR #' + item.prNumber + ' turned terminal while the dispatch was in flight — trigger-failure' + ' recorded LOG-ONLY (gh-1402: no issue comment, no park-cap counting)');
    return;
  }
  if (forkDispatchModule.forkFullOf(item, repoInfo.owner, repoInfo.repo)) {
    recordForkNoRefFailure(deps, repoInfo, ticketKey, item, err);
    return;
  }
  if (String(expandedRef || '') === String(item.branch)) {
    recordNoRefBookkeeping(deps, repoInfo, ticketKey, item, err, item.branch);
  }
}
function isValidLocalIssueObj(raw) {
  var obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return !!(obj && typeof obj.number === 'number' && !obj.message);
}
function shouldSanitizeScrapedIssue(deps, needsIssue, issueNumber, prNumber) {
  return !!(needsIssue && issueNumber !== null && prNumber && deps.smForge === 'github' && deps.hasGetIssue);
}
function sanitizeScrapedIssueAnchor(deps, repoInfo, needsIssue, issueNumber, prNumber) {
  if (!shouldSanitizeScrapedIssue(deps, needsIssue, issueNumber, prNumber)) {
    return issueNumber;
  }
  try {
    if (isValidLocalIssueObj(deps.getIssue(repoInfo, issueNumber))) return issueNumber;
  } catch (e) {}
  deps.log('  ⚠️  #' + issueNumber + ' scraped from PR #' + prNumber + ' does not exist in ' + repoInfo.owner + '/' + repoInfo.repo + ' (cross-repo or dangling ref) — not a local anchor (#544)');
  return null;
}
function resolveRuleInputsAnchor(deps, repoInfo, ticketKey, rule, it) {
  var needsIssue = Object.keys(rule.inputs).some(function (k) {
    return String(rule.inputs[k]).indexOf('{issueNumber}') !== -1;
  });
  var rawIssue = it.issueNumber === undefined || it.issueNumber === null ? null : it.issueNumber;
  var issueNumber = sanitizeScrapedIssueAnchor(deps, repoInfo, needsIssue, rawIssue, it.prNumber);
  if (!needsIssue || issueNumber !== null) {
    return { ok: true, issueNumber: issueNumber, prAnchoredFallback: false };
  }
  if (it.prNumber) {
    deps.log('  🔀 ' + ticketKey + ' links no local issue — dispatching PR-anchored instead (#544)');
    return { ok: true, issueNumber: null, prAnchoredFallback: true };
  }
  deps.log('  ⏭️  ' + ticketKey + ' skipped (rule "' + (rule.id || '') + '" needs {issueNumber} but the item links no issue and has no PR anchor)');
  return { ok: false };
}
function buildWorkflowDispatchInputs(deps, repoInfo, ticketKey, rule, effectiveConfig, resolvedCf, concurrencyKey, projectKey, item) {
  if (!rule.inputs) {
    return dispatchInputsModule.bareDispatchInputs(ticketKey, rule, effectiveConfig, resolvedCf, concurrencyKey, projectKey);
  }
  var it = item || {};
  var anchor = resolveRuleInputsAnchor(deps, repoInfo, ticketKey, rule, it);
  if (!anchor.ok) return null;
  var inputs = {};
  Object.keys(rule.inputs).forEach(function (k) {
    inputs[k] = dispatchInputsModule.expandDispatchInputValue(rule.inputs[k], ticketKey, dispatchInputsModule.dispatchAnchorIssueVal(anchor, ticketKey), it);
  });
  return dispatchInputsModule.applyPrAnchoredFallbackInputs(inputs, anchor, it);
}
function checkCrossAnchorActive(deps, scm, workflowFile, resolvedCf, item, skipInfo) {
  var altKeys = workflowRunTrackingModule.crossAnchorKeys(item);
  for (var altIx = 0; altIx < altKeys.length; altIx++) {
    if (workflowRunTrackingModule.hasActiveTargetWorkflowRun(deps, scm, workflowFile, resolvedCf, altKeys[altIx])) {
      if (skipInfo) skipInfo.crossAnchorActive = altKeys[altIx];
      return true;
    }
  }
  return false;
}
function checkHeadRefLegInFlight(deps, scm, workflowFile, ticketKey, headRefDispatch, forkPlan, it0) {
  if (!headRefDispatch) return false;
  var legInFlight = forkPlan.checkoutRef ? workflowRunTrackingModule.hasActiveLegRunForPull(scm, workflowFile, it0.prNumber) : workflowRunTrackingModule.hasActiveLegRunOnBranch(scm, workflowFile, it0.branch);
  if (!legInFlight) return false;
  var legGuardKey = forkPlan.checkoutRef ? 'pr-' + it0.prNumber + ' (fork head)' : 'branch ' + it0.branch;
  deps.log('  ⏭️  ' + ticketKey + ' skipped (leg already in flight on ' + legGuardKey + ' — gh-1028: the head is the leg\'s single writer, ' + 'a second leg would race its push)');
  return true;
}
function checkItemLegOrTerminalSuppression(deps, repoInfo, scm, workflowFile, ticketKey, headRefDispatch, forkPlan, item) {
  var it0 = item || {};
  if (checkHeadRefLegInFlight(deps, scm, workflowFile, ticketKey, headRefDispatch, forkPlan, it0)) return true;
  if (it0.prNumber && prTerminalStateOf(deps, repoInfo, it0.prNumber)) {
    deps.log('  ⏭️  ' + ticketKey + ' PR #' + it0.prNumber + ' (merged/closed) — ' + TERMINAL_PR_SKIP_MSG + ' (gh-1402: state guard — no comment, no attempt counting)');
    return true;
  }
  return false;
}
function checkTriggerSuppressionGates(deps, repoInfo, scm, workflowFile, resolvedCf, concurrencyKey, ticketKey, workflowBudget, headRefDispatch, forkPlan, item, skipInfo) {
  workflowRunTrackingModule.ensureWorkflowBudgetActiveCount(deps, workflowBudget, scm, workflowFile);
  if (workflowBudget && workflowBudget.remaining <= 0) {
    deps.log('  ⏭️  ' + ticketKey + ' skipped (global workflow cap reached: ' + workflowBudget.initial + ')');
    workflowRunTrackingModule.logBlockingWorkflowRuns(deps, workflowBudget, workflowFile);
    return true;
  }
  if (workflowRunTrackingModule.hasActiveTargetWorkflowRun(deps, scm, workflowFile, resolvedCf, concurrencyKey)) return true;
  if (checkCrossAnchorActive(deps, scm, workflowFile, resolvedCf, item, skipInfo)) return true;
  return checkItemLegOrTerminalSuppression(deps, repoInfo, scm, workflowFile, ticketKey, headRefDispatch, forkPlan, item);
}
function resolveDispatchPlanForRule(deps, rule, repoInfo, effectiveConfig, item) {
  var defaultWorkflowRef = configLoader.resolveDefaultWorkflowRef(rule, effectiveConfig, deps.projectConfig);
  var it0 = item || {};
  var expanded = String(rule.workflowRef || defaultWorkflowRef).replace(/\{branch\}/g, String(it0.branch || '')).replace(/\{prNumber\}/g, String(it0.prNumber || '')) || defaultWorkflowRef;
  var headRefDispatch = !!(it0.branch && expanded === String(it0.branch));
  var forkPlan = forkDispatchModule.dispatchPlan(expanded, it0, repoInfo.owner, repoInfo.repo, defaultWorkflowRef);
  return {
    workflowFile: rule.workflowFile || 'ai-teammate.yml',
    workflowRef: forkPlan.ref, headRefDispatch: headRefDispatch, forkPlan: forkPlan
  };
}
function applyForkCheckoutInputs(plan, inputs, item) {
  if (plan.forkPlan.checkoutRef) {
    inputs.checkout_ref = plan.forkPlan.checkoutRef;
    inputs.pr = inputs.pr || String(item.prNumber);
  }
}
function dispatchPreparedWorkflow(deps, repoInfo, scm, plan, inputs, ticketKey, projectKey, item, rule) {
  applyForkCheckoutInputs(plan, inputs, item);
  if (deps.dry) {
    deps.log('  [dry] ▶️ ' + ticketKey + ' dispatch:' + plan.workflowFile + ' inputs=' + JSON.stringify(inputs));
    return;
  }
  dispatchInputsModule.triggerWorkflowCompatible(scm, repoInfo, plan, inputs);
  if (rule) recordInTickDispatch(item, rule);
  deps.log('  ✅ Triggered ' + plan.workflowFile + '@' + plan.workflowRef + ' for ' + ticketKey + (projectKey ? ' [project_key=' + projectKey + ']' : ''));
  return true;
}
function triggerWorkflow(deps, repoInfo, ticketKey, rule, effectiveConfig, workflowBudget, item, skipInfo) {
  var plan = resolveDispatchPlanForRule(deps, rule, repoInfo, effectiveConfig, item);
  var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
  var concurrencyKey = rule.concurrencyKey || ticketKey;
  var projectKey = buildEncodedConfigModule.resolveProjectKey(rule, effectiveConfig);
  try {
    var scm = createTargetScm(effectiveConfig, repoInfo);
    if (checkTriggerSuppressionGates(deps, repoInfo, scm, plan.workflowFile, resolvedCf, concurrencyKey, ticketKey, workflowBudget, plan.headRefDispatch, plan.forkPlan, item, skipInfo)) return false;
    var inputs = buildWorkflowDispatchInputs(deps, repoInfo, ticketKey, rule, effectiveConfig, resolvedCf, concurrencyKey, projectKey, item);
    if (!inputs) return false;
    // gh-1540: the in-tick latch is consulted AFTER the probes and BEFORE
    // the trigger — every suppression probe above is list-based and cannot
    // see a leg dispatched seconds ago, so this set is the only same-tick
    // arbiter. A latch skip is transient (no labels consumed): the next
    // tick re-evaluates the lane under the leg's own ai_reviewing carrier.
    if (inTickDispatchSeen(item, rule)) {
      deps.log('  ⏭️  ' + ticketKey + ' skipped (in-tick dispatch latch: ' +
        inTickDispatchKey(item, rule) + ' already dispatched this tick — gh-1540: one leg per branch per tick)');
      return false;
    }
    return dispatchPreparedWorkflow(deps, repoInfo, scm, plan, inputs, ticketKey, projectKey, item, rule);
  } catch (e) {
    var failClass = triggerFailuresModule.classifyTriggerError(e && e.message);
    deps.warn('  ⚠️  Workflow trigger failed for ' + ticketKey + ' (' + failClass + ', ref=' + plan.workflowRef + '): ' + (e.message || e));
    recordDispatchFailure(deps, repoInfo, ticketKey, item, e, plan.workflowRef, failClass);
    return false;
  }
}
function writeLocalEncodedConfigFile(deps, ticketKey, encodedConfig) {
  if (!encodedConfig) return '';
  var safeTicket = ticketKey.replace(/[^A-Za-z0-9_-]/g, '_');
  var encodedConfigFile = '.dmtools/local-run-encoded-config-' + safeTicket + '.json';
  try {
    deps.fileWrite(encodedConfigFile, encodedConfig);
    return encodedConfigFile;
  } catch (e) {
    deps.warn('  ⚠️  Could not write encoded config file: ' + (e.message || e));
    return '';
  }
}
function executeTeammateCommand(deps, ticketKey, cmd, encodedConfigFile) {
  deps.log('  🖥️  [local] ' + cmd);
  var ok = true;
  try {
    deps.exec({ command: cmd });
    deps.log('  ✅ Local run complete for ' + ticketKey);
  } catch (e) {
    ok = false;
    deps.error('  ❌ Local teammate run failed for ' + ticketKey + ': ' + (e.message || e));
  }
  if (encodedConfigFile) {
    try { deps.exec({ command: 'bash -c "rm -f ' + encodedConfigFile + '"' }); } catch (e2) {}
  }
  return ok;
}
function buildLocalTeammateCmd(rule, resolvedCf, ticketKey, encodedConfigFile, projectKey, effectiveConfig) {
  var scriptPath = rule.localTeammateScript || 'agents/scripts/run-teammate-local.sh';
  var baseBranch = effectiveConfig && effectiveConfig.git && effectiveConfig.git.baseBranch || '';
  return 'bash ' + scriptPath + ' --config-file ' + resolvedCf + ' --ticket ' + ticketKey + (encodedConfigFile ? ' --encoded-config-file ' + encodedConfigFile : '') + (projectKey ? ' --project-key ' + projectKey : '') + (baseBranch ? ' --base-branch ' + baseBranch : '');
}
function runTeammateLocally(deps, ticketKey, rule, effectiveConfig) {
  var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
  if (deps.dry) {
    deps.log('  [dry] 🖥️ local teammate ' + ticketKey + ' → ' + resolvedCf);
    return true;
  }
  var encodedConfig = buildEncodedConfigModule.buildEncodedConfig(ticketKey, rule, effectiveConfig, true);
  var projectKey = buildEncodedConfigModule.resolveProjectKey(rule, effectiveConfig);
  var encodedConfigFile = writeLocalEncodedConfigFile(deps, ticketKey, encodedConfig);
  var cmd = buildLocalTeammateCmd(rule, resolvedCf, ticketKey, encodedConfigFile, projectKey, effectiveConfig);
  return executeTeammateCommand(deps, ticketKey, cmd, encodedConfigFile);
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      TERMINAL_PR_SKIP_MSG: TERMINAL_PR_SKIP_MSG, TAG_ONLY_STAGE_KEYS: TAG_ONLY_STAGE_KEYS,
      withScmProvider: withScmProvider, applyJobParamsScm: applyJobParamsScm,
      applyRuleForge: applyRuleForge, resolveSmForge: resolveSmForge,
      isForgeSource: isForgeSource, firstMatchingLabel: firstMatchingLabel,
      shouldRecoverStaleTriggerLabel: shouldRecoverStaleTriggerLabel,
      createTargetScm: createTargetScm, isWorkflowBudgetExhausted: isWorkflowBudgetExhausted,
      prRawRead: prRawRead, prTerminalStateOf: prTerminalStateOf,
      ruleTargetSelfManagesLabel: ruleTargetSelfManagesLabel,
      gitlabRuleLabel: gitlabRuleLabel, addRuleLabels: addRuleLabels,
      removeRuleLabel: removeRuleLabel, moveStatus: moveStatus,
      forkPullRefLive: forkPullRefLive, recordNoRefBookkeeping: recordNoRefBookkeeping,
      recordDispatchFailure: recordDispatchFailure, triggerWorkflow: triggerWorkflow,
      inTickDispatchKey: inTickDispatchKey, inTickDispatchSeen: inTickDispatchSeen,
      recordInTickDispatch: recordInTickDispatch, resetInTickDispatchLatch: resetInTickDispatchLatch,
      runTeammateLocally: runTeammateLocally, stageKeyForStatusName: stageKeyForStatusName
    };
}
