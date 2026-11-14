/**
 * Merge-window probes, invisible-required resets, and dispatched-state probes —
 * js/sm/mergeAndParkProbes.js (#1459).
 */
'use strict';

var checkRunZombiesModule = require('../common/checkRunZombies.js');
var guestValidationPathModule = require('../common/guestValidationPath.js');
var invisibleRequiredModule = require('../common/invisibleRequiredChecks.js');
var labelListModule = require('../common/labelList.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var smProviderModule = require('../common/smProvider.js');
var validationLivenessModule = require('../common/validationLiveness.js');
var workflowRunsModule = require('../common/workflowRuns.js');
var validationProbesModule = require('./validationProbes.js');
var RULESET_CONTEXTS_JQ = validationProbesModule.RULESET_CONTEXTS_JQ;
var PR_ROLLUP_JQ = validationProbesModule.PR_ROLLUP_JQ;
function cliJson(deps, command) {
  var res = deps.exec({
    command: command
  });
  var out = res && (res.output || res.stdout) || res;
  return typeof out === 'string' ? JSON.parse(out || 'null') : out;
}
function armEventActor(deps, repoInfo, prNumber) {
  try {
    var events = cliJson(deps, 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo + '/issues/' + prNumber + '/events?per_page=100"');
    return guestValidationPathModule.newestArmEvent(events);
  } catch (eArmProbe) {
    deps.warn('  ⚠️  arm-event probe failed for pr-' + prNumber + ': ' + (eArmProbe.message || eArmProbe) + ' — no external-arm proof (fail closed)');
    return null;
  }
}
function verifyGuestCheckTally(deps, repoInfo, gHead, key) {
  var gRuns = gHead ? deps.headCheckRunsSafe(repoInfo, gHead) : null;
  if (gRuns === null) {
    deps.log('  ⏭️  ' + key + ' guest zero-failing gate: head check-run probe failed' + ' — refusing the merge (fail closed)');
    return null;
  }
  var gTally = guestValidationPathModule.realCheckTally(gRuns, smProviderModule.BOOKKEEPING_CHECK_PREFIXES);
  if (gTally.red > 0) {
    deps.log('  ⏭️  ' + key + ' guest zero-failing gate: ' + gTally.red + ' real red check(s) on the head — fail-validation owns the verdict');
    return null;
  }
  if (gTally.pending > 0) {
    deps.log('  ⏭️  ' + key + ' guest zero-failing gate: ' + gTally.pending + ' real check(s) in flight — the verdict rules own the head');
    return null;
  }
  return gTally;
}
function verifyGuestNoActiveHeadRuns(deps, repoInfo, gHead, key) {
  var gHeadRuns = gHead ? deps.headWorkflowRunsSafe(repoInfo, gHead) : null;
  if (gHeadRuns === null || validationProbesModule.hasActiveHeadRun(gHeadRuns)) {
    deps.log('  ⏭️  ' + key + ' guest zero-failing gate: ' + (gHeadRuns === null ? 'head-run probe failed (fail closed)' : 'a run is active on the head (gh-748 stamp-lag belt)') + ' — refusing the merge');
    return false;
  }
  return true;
}
function guestZeroFailingMergeGate(deps, repoInfo, rule, ticket, key, effectiveConfig) {
  var gHead = ticket.pr && ticket.pr.headSha || ticket.headSha;
  var gTally = verifyGuestCheckTally(deps, repoInfo, gHead, key);
  if (!gTally) {
    return false;
  }
  if (!verifyGuestNoActiveHeadRuns(deps, repoInfo, gHead, key)) {
    return false;
  }
  var gArm = armEventActor(deps, repoInfo, ticket.prNumber);
  if (!gArm) {
    deps.log('  ⏭️  ' + key + ' guest zero-failing gate: no readable ai_validating' + ' label event — no external-arm proof (fail closed)');
    return false;
  }
  var gMachineAuthor = machineAuthorModule.resolveMachineAuthor(deps.jobParams, effectiveConfig);
  if (!guestValidationPathModule.isManualArm(gArm, gMachineAuthor)) {
    deps.log('  ⏭️  ' + key + ' guest zero-failing gate: ai_validating was added by `' + gArm.login + '` (a machine identity) — the machine arms ride the normal CI path');
    return false;
  }
  deps.log('  🤝 ' + key + ' external validation arm — ai_validating added by `' + gArm.login + '` at ' + (gArm.createdAt || 'unknown time') + ', head carries ' + gTally.real + ' real check(s), none red, none in flight' + ' (gh-113: the stub-only rollup never reads green — the manual arm is the verdict)');
  return true;
}
function clearPostMergeLabels(tr, prNumber) {
  try {
    tr.removeLabel(prNumber, 'ai_validating');
    tr.removeLabel(prNumber, 'pr_approved');
    tr.removeLabel(prNumber, 'ai_validated');
  } catch (e2) {/* absent labels are fine post-merge */}
}
function parseJsonObjectSafe(raw) {
  if (!raw) {
    return {};
  }
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw || {};
  } catch (e) {
    return {};
  }
}
function attemptMergeProbe(deps, repoInfo, ticket, key) {
  var tr = deps.githubTracker(repoInfo);
  var gatePr = parseJsonObjectSafe(deps.getPr(repoInfo, ticket.prNumber));
  var gateLabels = (gatePr.labels || []).map(function (l) {
    return l && l.name || l;
  });
  if (gateLabels.indexOf('pr_approved') === -1) {
    tr.removeLabel(ticket.prNumber, 'ai_validating');
    tr.addLabel(ticket.prNumber, 'ai_validated');
    deps.log('  ✅ ' + key + ' validated (no approval yet) — ai_validated latched, review follows');
    return 'latched';
  }
  var mergeRaw = deps.mergePr(repoInfo, ticket.prNumber);
  var mergeResp = parseJsonObjectSafe(mergeRaw);
  if (mergeResp.merged !== true) {
    throw new Error('merge refused: ' + (typeof mergeRaw === 'string' ? mergeRaw : JSON.stringify(mergeRaw)));
  }
  deps.onMergedSlotSpent();
  clearPostMergeLabels(tr, ticket.prNumber);
  deps.log('  🎉 ' + key + ' squash-merged');
  return 'merged';
}
function matchesMutexScope(labels, q) {
  if (labels.indexOf(q.mutex) === -1 || labels.indexOf('blocked') !== -1) {
    return false;
  }
  if (q.mutexAmong && !q.mutexAmong.some(function (l) {
    return labels.indexOf(l) !== -1;
  })) {
    return false;
  }
  return true;
}
function parseMutexMax(mutexMax) {
  return typeof mutexMax === 'number' && isFinite(mutexMax) ? Math.max(1, Math.floor(mutexMax)) : 1;
}
function labelsOfPr(p) {
  return (p && p.labels || []).map(function (l) {
    return l && l.name || l;
  });
}
function scanMutexHolders(arr, q, selfPrNumber) {
  var selfHolds = false;
  var otherHolders = [];
  arr.forEach(function (p) {
    if (!matchesMutexScope(labelsOfPr(p), q)) {
      return;
    }
    var num = p.number || p.prNumber;
    if (num === selfPrNumber) {
      selfHolds = true;
      return;
    }
    otherHolders.push(num);
  });
  if (q.mutexExcludeSelf && selfHolds) {
    return 0;
  }
  return otherHolders.length >= parseMutexMax(q.mutexMax) ? otherHolders[0] : 0;
}
function normalizePrArray(list) {
  if (Array.isArray(list)) {
    return list;
  }
  return list && (list.pullRequests || list.items) || [];
}
function validationMutexHeldByAnother(deps, repoInfo, rule, ticket) {
  var q = rule.query || {};
  if (!q.mutex) {
    return 0;
  }
  try {
    var list = validationProbesModule.mcpParse(deps.listOpenPrs(repoInfo));
    return scanMutexHolders(normalizePrArray(list), q, ticket.prNumber);
  } catch (eMutex) {
    deps.warn('  ⚠️  action-time mutex probe failed: ' + (eMutex.message || eMutex));
    return 0;
  }
}
function nonEmptyArrayOrNull(arr) {
  return Array.isArray(arr) && arr.length ? arr : null;
}
function queryRequiredContextsForBase(deps, repoInfo, base) {
  if (!base || typeof base !== 'string') {
    return null;
  }
  try {
    var ctx = nonEmptyArrayOrNull(cliJson(deps, 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo + '/branches/' + base + '" --jq ".protection.required_status_checks.contexts"'));
    if (ctx) {
      return ctx;
    }
  } catch (eClassic) {}
  return nonEmptyArrayOrNull(cliJson(deps, 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo + '/rules/branches/' + base + '" --jq \'' + RULESET_CONTEXTS_JQ + '\''));
}
function requiredContextsSafe(deps, repoInfo, prNumber) {
  try {
    var pr = validationProbesModule.mcpParse(deps.getPr(repoInfo, prNumber)) || {};
    var base = pr.base && (pr.base.ref || pr.base);
    return queryRequiredContextsForBase(deps, repoInfo, base);
  } catch (e) {
    deps.warn('  ⚠️  required-contexts probe failed: ' + (e.message || e));
    return null;
  }
}
function prRequiredRollupSafe(deps, repoInfo, prNumber) {
  try {
    var q = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){' + 'pullRequest(number:$n){statusCheckRollup{contexts(first:100){nodes{' + '... on CheckRun{name isRequired(pullRequestNumber:$n)}' + '... on StatusContext{context isRequired(pullRequestNumber:$n)}}}}}}}';
    var names = cliJson(deps, 'gh api graphql -f query=\'' + q + '\' -F o=' + repoInfo.owner + ' -F r=' + repoInfo.repo + ' -F n=' + prNumber + ' --jq \'' + PR_ROLLUP_JQ + '\'');
    return Array.isArray(names) ? names : null;
  } catch (e) {
    deps.warn('  ⚠️  PR rollup probe failed: ' + (e.message || e));
    return null;
  }
}
function detectInvisibleRequired(deps, repoInfo, ticket, headSha) {
  if (!invisibleRequiredModule.blockedApprovedShape(ticket)) {
    return false;
  }
  var required = requiredContextsSafe(deps, repoInfo, ticket.prNumber);
  if (!required || !required.length) {
    return false;
  }
  var checkRuns = deps.headCheckRunsSafe(repoInfo, headSha);
  if (!checkRuns) {
    return false;
  }
  var visible = prRequiredRollupSafe(deps, repoInfo, ticket.prNumber);
  return invisibleRequiredModule.isInvisible(required, checkRuns, visible);
}
function postInvisibleRequiredResetNote(deps, repoInfo, prNumber, headSha, count, cap) {
  var now = new Date().toISOString();
  try {
    deps.githubTracker(repoInfo).postComment(prNumber, invisibleRequiredModule.markerLine(headSha, now) + '\n' + checkRunZombiesModule.placeholderMarkerLine(count + 1, cap, now) + '\n\nRequired checks were green on `' + headSha.slice(0, 8) + '` but invisible to the PR' + ' (they ran in a workflow_dispatch check suite GitHub does not associate with PRs —' + ' mergeState stuck BLOCKED). Head refreshed to a fresh sha; CI is dispatched once the' + ' push suite exists on it (gh-1101).');
  } catch (eNote) {
    deps.warn('  ⚠️  invisible-required notice failed: ' + (eNote.message || eNote));
  }
}
function invisibleRequiredReset(deps, repoInfo, ticket, key, headSha, freshReset) {
  if (!detectInvisibleRequired(deps, repoInfo, ticket, headSha)) {
    return false;
  }
  deps.log('  👻 ' + key + ' required checks invisible to PR — green on ' + headSha.slice(0, 8) + ' (workflow_dispatch suite) but absent from the PR rollup');
  var cap = checkRunZombiesModule.placeholderCapOf(deps.jobParams);
  var marks = deps.failMarkerState(repoInfo, ticket.prNumber).placeholders || {
    count: 0
  };
  if (!checkRunZombiesModule.placeholderRetryAllowed(marks, cap)) {
    deps.log('  🅿️  ' + key + ' invisible-required reset capped (' + marks.count + '/' + cap + ')');
    return true;
  }
  if (deps.dry) {
    deps.log('  🧪 [dry] invisible-required fresh-sha reset skipped');
    return true;
  }
  if (freshReset(ticket.branch, headSha)) {
    postInvisibleRequiredResetNote(deps, repoInfo, ticket.prNumber, headSha, marks.count, cap);
  }
  return true;
}
function prHeadShaSafe(deps, repoInfo, prNumber) {
  try {
    var pr = validationProbesModule.mcpParse(deps.getPr(repoInfo, prNumber)) || {};
    return pr.head && (pr.head.sha || pr.head) || null;
  } catch (e) {
    return null;
  }
}
function headMoved(oldHead, newHead) {
  return typeof newHead === 'string' && !!newHead && newHead !== oldHead;
}
function freshShaResetOnce(deps, repoInfo, ticket, key, oldHead, refresh) {
  if (deps.tickFreshResets[ticket.prNumber]) {
    deps.log('  ⏭️  ' + key + ' fresh-sha reset already done this tick — skip');
    return false;
  }
  deps.tickFreshResets[ticket.prNumber] = true;
  try {
    refresh();
  } catch (eUp) {
    deps.warn('  ⚠️  ' + key + ' fresh-sha refresh failed: ' + (eUp.message || eUp) + ' — head unchanged, retry next tick');
    return false;
  }
  var newHead = prHeadShaSafe(deps, repoInfo, ticket.prNumber);
  if (!headMoved(oldHead, newHead)) {
    deps.warn('  ⚠️  ' + key + ' fresh-sha reset did not move the head (' + String(oldHead || '?').slice(0, 8) + ' → ' + String(newHead || '?').slice(0, 8) + ') — not counted, retry next tick');
    return false;
  }
  return true;
}
function holdDispatchForPushSuite(deps, repoInfo, ticket, key, headSha) {
  var bodies = [];
  try {
    var list = deps.fetchPrCommentList(repoInfo, ticket.prNumber);
    bodies = list.map(function (c) {
      return String(c && c.body || '');
    });
  } catch (e) {}
  var last = invisibleRequiredModule.lastResetAtMs(bodies);
  if (last === null) {
    return false;
  }
  var hold = invisibleRequiredModule.shouldHoldDispatch(last, deps.headWorkflowRunsSafe(repoInfo, headSha), Date.now(), (deps.jobParams || {}).pushSuiteWaitMs);
  if (hold) {
    deps.log('  ⏳ ' + key + ' fresh head ' + headSha.slice(0, 8) + ' has no push suite yet — CI dispatch held (gh-1101 ordering)');
  }
  return hold;
}
function headGateClean(deps, repoInfo, headSha) {
  var z = validationProbesModule.headCheckRunZombies(deps, repoInfo, headSha);
  if (z && z.zombies.length) {
    return false;
  }
  var ph = validationProbesModule.headPlaceholders(deps, repoInfo, headSha);
  return !(ph && ph.length);
}
function greenRunUrlOf(probe) {
  var r = probe && probe.newest;
  return r && r.status === 'completed' && r.conclusion === 'success' ? r.html_url || null : null;
}
function latchValidatedAfterFastMergeFail(deps, repoInfo, prNumber, key, labels, err) {
  var tracker = deps.githubTracker(repoInfo);
  if (labels.indexOf('ai_validating') !== -1) {
    tracker.removeLabel(prNumber, 'ai_validating');
  }
  if (labels.indexOf('ai_validated') === -1) {
    tracker.addLabel(prNumber, 'ai_validated');
  }
  deps.warn('  ⚠️  ' + key + ' fast-path merge: ' + (err.message || err) + ' — ai_validated latched, merge retries next tick (no re-dispatch)');
}
function executeFastPathMerge(deps, repoInfo, ticket, key, probe, headSha, labels) {
  deps.log('  ✅ ' + key + ' approved + green dispatched run on the current head' + ' — merging without CI (gh-1101)');
  deps.stampValidationChecks(repoInfo, headSha, 'completed', 'success', greenRunUrlOf(probe));
  try {
    attemptMergeProbe(deps, repoInfo, ticket, key);
  } catch (eFast) {
    latchValidatedAfterFastMergeFail(deps, repoInfo, ticket.prNumber, key, labels, eFast);
  }
  return true;
}
function isEligibleForGreenFastPath(ticket, probe, headSha) {
  if (!headSha || !probe || !probe.green) {
    return false;
  }
  if ((ticket.labels || []).indexOf('pr_approved') === -1) {
    return false;
  }
  return !ticket.pr || ticket.pr.mergeState !== 'BEHIND';
}
function approvedGreenHeadFastPath(deps, repoInfo, ticket, key, probe, headSha) {
  if (!isEligibleForGreenFastPath(ticket, probe, headSha)) {
    return false;
  }
  if (!headGateClean(deps, repoInfo, headSha)) {
    return false;
  }
  return executeFastPathMerge(deps, repoInfo, ticket, key, probe, headSha, ticket.labels || []);
}
function recentlyConcludedNonGreen(deps, probe, repoInfo, headSha) {
  var n = probe && probe.newest;
  if (n && n.conclusion === 'success') {
    return !!repoInfo && validationLivenessModule.freshGreen(probe, Date.now()) && headGateClean(deps, repoInfo, headSha);
  }
  if (!n) {
    return false;
  }
  return validationLivenessModule.concludedWithin(n, Date.now(), validationLivenessModule.CONCLUDED_REDISPATCH_GRACE_MS);
}
function queryDispatchedRunsSafe(deps, repoInfo, ciWorkflow, headSha, warnLabel) {
  try {
    return workflowRunsModule.dispatchedRuns(repoInfo, ciWorkflow, headSha, deps.exec);
  } catch (e) {
    deps.warn('  ⚠️  ' + warnLabel + ' probe failed: ' + (e.message || e));
    return null;
  }
}
function latestDispatchedVerdict(deps, repoInfo, ciWorkflow, headSha) {
  var raw = queryDispatchedRunsSafe(deps, repoInfo, ciWorkflow, headSha, 'verdict');
  if (!raw) {
    return null;
  }
  var list = raw.filter(function (r) {
    return r.status === 'completed' && r.conclusion && r.conclusion !== 'cancelled';
  });
  if (!list.length) {
    return null;
  }
  workflowRunsModule.sortRunsNewestFirst(list);
  return list[0].conclusion;
}
function hasActiveRunInList(list) {
  return !!list && list.some(function (r) {
    return validationLivenessModule.ACTIVE_RUN_STATES.indexOf(r.status) !== -1;
  });
}
function hasGreenRunInList(list) {
  return !!list && list.some(function (r) {
    return r.status === 'completed' && r.conclusion === 'success';
  });
}
function newestRunInList(list) {
  if (!list || !list.length) {
    return null;
  }
  workflowRunsModule.sortRunsNewestFirst(list);
  return list[0];
}
function probeDispatchedState(deps, repoInfo, ciWorkflow, headSha) {
  if (typeof deps.runAsync === 'function') {
    return deps.runAsync(deps.evalWorker(validationProbesModule.PROBE_WORKER_SOURCE), {
      repo: repoInfo,
      ciWorkflow: ciWorkflow,
      headSha: headSha
    }).wait();
  }
  var activeList = queryDispatchedRunsSafe(deps, repoInfo, ciWorkflow, headSha, 'dispatch-guard');
  var greenList = queryDispatchedRunsSafe(deps, repoInfo, ciWorkflow, headSha, 'green-cover');
  var staleList = queryDispatchedRunsSafe(deps, repoInfo, ciWorkflow, headSha, 'stale-arm');
  return {
    active: hasActiveRunInList(activeList),
    verdict: latestDispatchedVerdict(deps, repoInfo, ciWorkflow, headSha),
    green: hasGreenRunInList(greenList),
    newest: newestRunInList(staleList)
  };
}
module.exports = {
  cliJson: cliJson,
  armEventActor: armEventActor,
  guestZeroFailingMergeGate: guestZeroFailingMergeGate,
  attemptMergeProbe: attemptMergeProbe,
  validationMutexHeldByAnother: validationMutexHeldByAnother,
  requiredContextsSafe: requiredContextsSafe,
  prRequiredRollupSafe: prRequiredRollupSafe,
  detectInvisibleRequired: detectInvisibleRequired,
  invisibleRequiredReset: invisibleRequiredReset,
  prHeadShaSafe: prHeadShaSafe,
  headMoved: headMoved,
  freshShaResetOnce: freshShaResetOnce,
  holdDispatchForPushSuite: holdDispatchForPushSuite,
  headGateClean: headGateClean,
  approvedGreenHeadFastPath: approvedGreenHeadFastPath,
  recentlyConcludedNonGreen: recentlyConcludedNonGreen,
  latestDispatchedVerdict: latestDispatchedVerdict,
  probeDispatchedState: probeDispatchedState
};
