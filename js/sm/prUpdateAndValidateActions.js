/**
 * PR branch refresh (`update_branch`) and validation dispatch (`validate_pr`)
 * localAction handlers — js/sm/prUpdateAndValidateActions.js (#1459).
 */
'use strict';

var checkRunZombiesModule = require('../common/checkRunZombies.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var parkAndActorProbesModule = require('./parkAndActorProbes.js');
var smRuleLayersModule = require('../common/smRuleLayers.js');
var triggerFailuresModule = require('../common/triggerFailures.js');
var validationLivenessModule = require('../common/validationLiveness.js');
var PLACEHOLDER_PARK_MARKER = '\uD83C\uDFF7\uFE0F Placeholder resets capped';
var TERMINAL_PR_SKIP_MSG = 'terminal PR — dispatch skipped';
var unparkWithComment = parkAndActorProbesModule.unparkWithComment;
var cancelStaleAfterRefreshUb = parkAndActorProbesModule.cancelStaleAfterRefreshUb;
var handleUpdateBranchAction = parkAndActorProbesModule.handleUpdateBranchAction;
function isNewerHumanActorCommit(vprActor, vprParkedAt, deps, vprMachineLogin) {
  if (!vprActor || !vprParkedAt || !vprActor.date || !(Date.parse(vprActor.date) > Date.parse(vprParkedAt))) {
    return false;
  }
  var vprActorLogin = String(vprActor.login || '').toLowerCase();
  return !deps.isMachineParkPush(vprActor.committer, vprActorLogin, vprMachineLogin);
}
function checkValidatePrParkedBackstop(deps, effectiveConfig, repoInfo, ticket, key) {
  if ((ticket.labels || []).indexOf('validation_failed') === -1) {
    return true;
  }
  var vprMachineLogin = machineAuthorModule.resolveMachineAuthor(deps.jobParams, effectiveConfig);
  var vprHead = deps.resolveHeadSha(repoInfo, ticket);
  var vprActor = deps.parkResetCommit(repoInfo, vprHead, vprMachineLogin);
  var vprParkedAt = deps.parkedSince(repoInfo, ticket.prNumber);
  if (!isNewerHumanActorCommit(vprActor, vprParkedAt, deps, vprMachineLogin)) {
    deps.log('  ⏭️  ' + key + ' validation_failed — parked; NO validation CI until a HUMAN push newer than the park clears it');
    return false;
  }
  var vprActorLogin = String(vprActor.login || '').toLowerCase();
  unparkWithComment(deps, repoInfo, ticket.prNumber, 'validation_failed', '🅿️→▶ validation_failed cleared — human push by `' + (vprActorLogin || 'unknown') + '` at ' + vprActor.date + ' (last substantive commit `' + (vprActor.sha || vprHead) + '` of head `' + vprHead + '`, machine merges of main walked past — #681) is newer than the park (' + vprParkedAt + '). Re-entering validation (update_branch RESET never ran: the head is not BEHIND — live fa 2026-10-03).');
  deps.log('  ▶ ' + key + ' park cleared (fresh human push) — validation proceeds');
  return true;
}
function greenCoverVoidByZombiesOrPlaceholders(deps, repoInfo, key, vHead0) {
  if (!vHead0) {
    return false;
  }
  var gGreenZombies = deps.headCheckRunZombies(repoInfo, vHead0);
  if (!gGreenZombies) {
    return false;
  }
  if (gGreenZombies.zombies.length) {
    var zList = gGreenZombies.zombies.map(function (z) { return z.name + ' (' + z.reason + ')'; }).join(', ');
    deps.log('  🧟 ' + key + ' green cover VOID — ' + gGreenZombies.zombies.length + ' zombie check-run(s) hold the gate (gh-842: ' + zList + ') — re-dispatching to override the ghosts');
    return true;
  }
  var gGreenPh = deps.headPlaceholders(repoInfo, vHead0);
  if (gGreenPh && gGreenPh.length) {
    var phList = gGreenPh.map(function (p) { return p.name; }).join(', ');
    deps.log('  🧟 ' + key + ' green cover VOID — ' + gGreenPh.length + ' placeholder check-run(s) pin the gate (gh-852: ' + phList + ') — the dispatch gate will mint a fresh sha (a same-sha re-dispatch re-mints placeholders)');
    return true;
  }
  return false;
}
function checkGreenCoverSkip(deps, rule, repoInfo, key, vProbe, vHead0) {
  if (!rule.skipIfGreenCi || !vProbe || !vProbe.green) {
    return false;
  }
  if (greenCoverVoidByZombiesOrPlaceholders(deps, repoInfo, key, vHead0)) {
    return false;
  }
  deps.log('  ⏭️  ' + key + ' head already carries a green dispatched CI run — blocker is not this CI; skip re-dispatch');
  return true;
}
function checkLatchSkipGhostsVoid(deps, repoInfo, key, vHead0) {
  if (!vHead0) {
    return false;
  }
  var latchZombies = deps.headCheckRunZombies(repoInfo, vHead0);
  if (!latchZombies) {
    return false;
  }
  if (latchZombies.zombies.length) {
    deps.log('  🧟 ' + key + ' latch-skip VOID — ' + latchZombies.zombies.length + ' zombie check-run(s) hold the gate (gh-842) — dispatching instead of arm-only');
    return true;
  }
  var latchPh = deps.headPlaceholders(repoInfo, vHead0);
  if (latchPh && latchPh.length) {
    deps.log('  🧟 ' + key + ' latch-skip VOID — ' + latchPh.length + ' placeholder check-run(s) pin the gate (gh-852) — the dispatch gate will mint a fresh sha instead of arm-only');
    return true;
  }
  return false;
}
function isLatchSkipEligible(deps, rule, repoInfo, ticket, vProbe, vHead0, key) {
  if (!rule.skipIfValidatedHead || !vProbe || (ticket.labels || []).indexOf('ai_validated') === -1 || !vProbe.green) {
    return false;
  }
  return deps.validationRollupGreen(repoInfo, ticket.prNumber) && !checkLatchSkipGhostsVoid(deps, repoInfo, key, vHead0);
}
function executeLatchSkipArmAndMerge(deps, repoInfo, ticket, key, processedKeys) {
  deps.githubTracker(repoInfo).addLabel(ticket.prNumber, 'ai_validating');
  deps.log('  ⏭️  ' + key + ' latch-skip: head unchanged since the green validation — arm only');
  try {
    deps.attemptMergeProbe(repoInfo, ticket, key);
  } catch (eMergeProbe) {
    deps.warn('  ⚠️  ' + key + ' latch-skip merge probe: ' + eMergeProbe + ' — arm stays, merge-validated retries next tick');
  }
  processedKeys.push(key);
  return true;
}
function checkLatchSkipArmOnly(deps, rule, repoInfo, ticket, key, vProbe, vHead0, processedKeys) {
  if (!isLatchSkipEligible(deps, rule, repoInfo, ticket, vProbe, vHead0, key)) {
    return false;
  }
  var latchMutexHolder = deps.validationMutexHeldByAnother(repoInfo, rule, ticket);
  if (latchMutexHolder) {
    deps.log('  🔒 ' + key + ' arm refused — pr-' + latchMutexHolder + ' already holds ai_validating (action-time re-check; the query-time mutex scanned a stale list)');
    return true;
  }
  return executeLatchSkipArmAndMerge(deps, repoInfo, ticket, key, processedKeys);
}
function stripStaleValidatedLatch(deps, repoInfo, prNumber, key) {
  try {
    deps.githubTracker(repoInfo).removeLabel(prNumber, 'ai_validated');
    deps.log('  🏷️  ' + key + ' latch VOID — no completed-green dispatched CI run covers the current head (gh-850) — ai_validated stripped, re-validating');
  } catch (eLatchVoid) {
    deps.warn('  ⚠️  ' + key + ' stale latch strip failed: ' + (eLatchVoid.message || eLatchVoid));
  }
}
function handleLatchEconomyAndVoid(deps, rule, repoInfo, ticket, key, vProbe) {
  if ((ticket.labels || []).indexOf('ai_validated') === -1 || !vProbe) {
    return false;
  }
  if (!vProbe.green) {
    stripStaleValidatedLatch(deps, repoInfo, ticket.prNumber, key);
    return false;
  }
  if (!rule.skipIfValidatedHead) {
    deps.log('  ⏭️  ' + key + ' latch covers the current head (completed-green dispatched run on this sha) — no re-validation');
    return true;
  }
  return false;
}
function isGuestDeferRedAlreadyMarked(deps, repoInfo, prNumber, parkMarker, vHead0) {
  try {
    var list = deps.fetchPrCommentList(repoInfo, prNumber);
    return list.some(function (c) {
      var b = String(c && c.body || '');
      return b.indexOf(parkMarker) !== -1 && b.indexOf(String(vHead0)) !== -1;
    });
  } catch (eParkRead) {
    return false;
  }
}
function postGuestDeferRedCommentIfNeeded(deps, repoInfo, prNumber, vHead0) {
  var parkMarker = '🅿️ Validation red — PR parked';
  if (deps.dry || isGuestDeferRedAlreadyMarked(deps, repoInfo, prNumber, parkMarker, vHead0)) {
    return;
  }
  try {
    deps.githubTracker(repoInfo).postComment(prNumber, parkMarker + ' — the current head `' + vHead0 + '` failed validation and the head has not moved. ' + 'Re-running CI on the same SHA cannot pass, so the merge ' + 'window skips this PR until the head moves (push a fix or ' + 'rebase). The failure itself is reported separately above.');
  } catch (eParkComment) {
    deps.warn('  ⚠️  park comment failed: ' + (eParkComment.message || eParkComment));
  }
}
function checkDeferRedHead(deps, rule, effectiveConfig, repoInfo, ticket, key, vProbe, vHead0) {
  if (!rule.deferRedHead || !vProbe || vProbe.verdict !== 'failure') {
    return false;
  }
  var prMachineAuthor = machineAuthorModule.resolveMachineAuthor(deps.jobParams, effectiveConfig);
  var isMachinePrForPark = machineAuthorModule.isMachineAuthored(ticket, prMachineAuthor, repoInfo.owner);
  if (!isMachinePrForPark) {
    postGuestDeferRedCommentIfNeeded(deps, repoInfo, ticket.prNumber, vHead0);
  }
  deps.log('  🅿️  ' + key + ' red verdict still current on this head — parked, merge window advances');
  return true;
}
function postPlaceholderRejectionNotice(deps, repoInfo, prNumber, key, rejected) {
  deps.warn('  ⚠️  ' + key + ' placeholder conclusion rejected (' + rejected + ') — falling back to the gh-852 fresh-sha reset');
  if (deps.dry) {
    return;
  }
  try {
    deps.githubTracker(repoInfo).postComment(prNumber, '🔒 Placeholder conclusion rejected by GitHub (`' + rejected + '`) — the Actions app\'s check-runs refuse PATCH by the workflow token (ownership rules, gh-857). Falling back to the gh-852 fresh-sha reset. Evidence for the gh-848 placeholder law.');
  } catch (ePh403) {
    deps.warn('  ⚠️  gh-857 403-evidence comment failed: ' + (ePh403.message || ePh403));
  }
}
function finalizePlaceholderInPlaceConclude(deps, repoInfo, ticket, key, count, processedKeys) {
  deps.log('  ✅ ' + key + ' concluded ' + count + ' placeholder/orphan check-run(s) in place (gh-857/gh-865) — the green head unblocks without a fresh-sha reset or a CI re-dispatch');
  try {
    deps.attemptMergeProbe(repoInfo, ticket, key);
  } catch (eMergeProbe) {
    deps.warn('  ⚠️  ' + key + ' post-conclude merge probe: ' + (eMergeProbe.message || eMergeProbe) + ' — retry next tick (the mergeability read may lag the PATCH)');
  }
  processedKeys.push(key);
  return true;
}
function dispatchConcludePlaceholdersResult(deps, repoInfo, ticket, key, phConc, totalTargets, processedKeys) {
  if (!phConc.rejected && phConc.concluded === totalTargets) {
    return finalizePlaceholderInPlaceConclude(deps, repoInfo, ticket, key, phConc.concluded, processedKeys);
  }
  if (phConc.rejected) {
    postPlaceholderRejectionNotice(deps, repoInfo, ticket.prNumber, key, phConc.rejected);
  }
  return false;
}
function tryConcludePlaceholdersInPlace(deps, repoInfo, ticket, key, vCiWf, vHead0, vProbe, vPh, vOrphans, processedKeys) {
  if (!vProbe || !vProbe.green) {
    return false;
  }
  var phCover = deps.greenCoverRun(repoInfo, vCiWf, vHead0);
  if (!phCover) {
    return false;
  }
  var phTargets = (vPh || []).concat(vOrphans || []);
  var phConc = deps.concludePlaceholderCheckRuns(repoInfo, phTargets, phCover);
  return dispatchConcludePlaceholdersResult(deps, repoInfo, ticket, key, phConc, phTargets.length, processedKeys);
}
function logSweepNeutralOrphansResult(deps, key, swConc) {
  if (swConc.concluded > 0) {
    deps.log('  🧹 ' + key + ' zombie-swept ' + swConc.concluded + ' terminal-owner check-run(s) as neutral (gh-998)' + (swConc.rejected ? ' — ' + swConc.rejected + ' rejected, retry next tick' : ''));
    deps.onZombiesSwept(swConc.concluded);
    return;
  }
  if (swConc.rejected) {
    deps.warn('  ⚠️  ' + key + ' zombie sweep rejected (' + swConc.rejected + ') — retry next tick (gh-998)');
  }
}
function trySweepNeutralOrphans(deps, repoInfo, key, vHead0, vProbe, vOrphans) {
  if (!vOrphans || !vOrphans.length || vProbe && vProbe.green) {
    return;
  }
  logSweepNeutralOrphansResult(deps, key, deps.sweepZombieCheckRunsNeutral(repoInfo, vOrphans, vHead0));
}
function runInPlacePlaceholderCure(deps, repoInfo, ticket, key, vCiWf, vHead0, vProbe, vPh, vOrphans, processedKeys) {
  if (!deps.checksAppToken()) {
    return false;
  }
  var phHeadRuns = deps.headWorkflowRunsSafe(repoInfo, vHead0);
  if (phHeadRuns === null) {
    return false;
  }
  if (deps.hasActiveHeadRun(phHeadRuns)) {
    deps.log('  ⏭️  ' + key + ' placeholders carry a LIVE run on the head (gh-857 AC2) — no in-place conclusion, the run owns the contexts');
    return false;
  }
  if (tryConcludePlaceholdersInPlace(deps, repoInfo, ticket, key, vCiWf, vHead0, vProbe, vPh, vOrphans, processedKeys)) {
    return true;
  }
  trySweepNeutralOrphans(deps, repoInfo, key, vHead0, vProbe, vOrphans);
  return false;
}
function postPlaceholderCapParkNotice(deps, repoInfo, prNumber, phState, phMarks, phCap) {
  if (phState.placeholderParked || deps.dry) {
    return;
  }
  try {
    deps.githubTracker(repoInfo).postComment(prNumber, PLACEHOLDER_PARK_MARKER + ' (' + phMarks.count + '/' + phCap + ' fresh-sha resets in the current window) — automatic placeholder gate resets paused (gh-852 AC2). A human push (fresh head) or the next window resumes them.');
  } catch (ePhPark) {
    deps.warn('  ⚠️  placeholder park comment failed: ' + (ePhPark.message || ePhPark));
  }
}
function checkPlaceholderResetPreconditions(deps, repoInfo, ticket, key, phCap, phState, phMarks) {
  if (!checkRunZombiesModule.placeholderRetryAllowed(phMarks, phCap)) {
    postPlaceholderCapParkNotice(deps, repoInfo, ticket.prNumber, phState, phMarks, phCap);
    deps.log('  🅿️  ' + key + ' placeholder resets capped (' + phMarks.count + '/' + phCap + ' in window) — reset paused (gh-852 AC2)');
    return false;
  }
  var phPoolFree = deps.repoPoolFree(repoInfo);
  if (phPoolFree === null) {
    deps.warn('  ⚠️  ' + key + ' pool-free probe failed — placeholder reset deferred (fail closed, retry next tick)');
    return false;
  }
  if (!phPoolFree) {
    deps.log('  ⏳ ' + key + ' placeholder-pinned but the repo pool is BUSY (active runs) — fresh-sha reset deferred (gh-852 AC2 pool probe)');
    return false;
  }
  if (deps.dry) {
    deps.log('  🧪 [dry] placeholder reset skipped (gh-852: silent-update fresh sha + validation dispatch on ' + ticket.branch + ')');
    return false;
  }
  return true;
}
function extractPrHeadShaFromObj(phPrObj) {
  var head = phPrObj && phPrObj.head;
  return head && (head.sha || head) || null;
}
function readNewHeadAfterPlaceholderReset(deps, repoInfo, prNumber, key) {
  try {
    return extractPrHeadShaFromObj(deps.getPr(repoInfo, prNumber));
  } catch (ePhHead) {
    deps.warn('  ⚠️  ' + key + ' new-head read failed after the placeholder reset: ' + (ePhHead.message || ePhHead) + ' — stamp skipped, the dispatch still lands on the fresh head');
    return null;
  }
}
function postPlaceholderResetMarkerBestEffort(deps, tr, prNumber, phMarks, phCap) {
  if (deps.dry) {
    return;
  }
  try {
    tr.postComment(prNumber, checkRunZombiesModule.placeholderMarkerLine(phMarks.count + 1, phCap, new Date().toISOString()) + '\n\nPlaceholder check-runs pinned the merge gate on the old head (pending stamps with no backing run — gh-852). The head was refreshed to a fresh sha via a silent update and validation dispatched on it, pool-free probed. Bounded: ' + phCap + ' fresh-sha resets per PR per window.');
  } catch (ePhMark) {
    deps.warn('  ⚠️  placeholder marker comment failed: ' + (ePhMark.message || ePhMark));
  }
}
function armAndMarkPlaceholderReset(deps, repoInfo, prNumber, key, phMarks, phCap) {
  var phNewHead = readNewHeadAfterPlaceholderReset(deps, repoInfo, prNumber, key);
  if (phNewHead) {
    deps.stampValidationChecks(repoInfo, phNewHead, 'in_progress', null, null);
  }
  var tr = deps.githubTracker(repoInfo);
  try {
    tr.addLabel(prNumber, 'ai_validating');
  } catch (ePhArm) {
    deps.warn('  ⚠️  placeholder arm failed: ' + (ePhArm.message || ePhArm));
  }
  postPlaceholderResetMarkerBestEffort(deps, tr, prNumber, phMarks, phCap);
}
function executePlaceholderFreshShaReset(deps, repoInfo, ticket, key, vHead0, processedKeys) {
  var phCap = checkRunZombiesModule.placeholderCapOf(deps.jobParams);
  var phState = deps.failMarkerState(repoInfo, ticket.prNumber);
  var phMarks = phState.placeholders || { count: 0, lastAtMs: null };
  if (!checkPlaceholderResetPreconditions(deps, repoInfo, ticket, key, phCap, phState, phMarks)) {
    return;
  }
  if (!deps.freshShaReset(ticket.branch, vHead0)) {
    return;
  }
  try {
    deps.dispatchCiWorkflow(ticket.branch);
  } catch (ePhCi) {
    deps.warn('  ⚠️  ' + key + ' placeholder validation dispatch failed: ' + (ePhCi.message || ePhCi) + ' — fresh sha stands, next tick validates it');
    return;
  }
  armAndMarkPlaceholderReset(deps, repoInfo, ticket.prNumber, key, phMarks, phCap);
  deps.log('  ♻️  ' + key + ' placeholder reset ' + (phMarks.count + 1) + '/' + phCap + ' — fresh sha via silent update, validation dispatched on' + ' the new head (gh-852)');
  processedKeys.push(key);
}
function hasItems(arr) {
  return !!(arr && arr.length);
}
function handlePlaceholdersAndOrphansGate(deps, repoInfo, ticket, key, vCiWf, vHead0, vProbe, processedKeys) {
  if (!vHead0) {
    return false;
  }
  var vPh = deps.headPlaceholders(repoInfo, vHead0);
  var vOrphans = deps.headOrphanedRunChecks(repoInfo, vHead0);
  if (!hasItems(vPh) && !hasItems(vOrphans)) {
    return false;
  }
  if (runInPlacePlaceholderCure(deps, repoInfo, ticket, key, vCiWf, vHead0, vProbe, vPh, vOrphans, processedKeys)) {
    return true;
  }
  if (hasItems(vPh)) {
    executePlaceholderFreshShaReset(deps, repoInfo, ticket, key, vHead0, processedKeys);
    return true;
  }
  return false;
}
function checkHeadInvisibleOrHoldGate(deps, repoInfo, ticket, key, vHead0, processedKeys) {
  if (!vHead0) {
    return false;
  }
  if (deps.invisibleRequiredReset(repoInfo, ticket, key, vHead0, deps.freshShaReset)) {
    processedKeys.push(key);
    return true;
  }
  return deps.holdDispatchForPushSuite(repoInfo, ticket, key, vHead0);
}
function checkActiveOrFastPathGuards(deps, repoInfo, ticket, key, vProbe, vHead0, processedKeys) {
  if (vProbe && vProbe.active) {
    deps.log('  ⏭️  ' + key + ' validation already dispatching on this head — skip');
    return true;
  }
  if (checkHeadInvisibleOrHoldGate(deps, repoInfo, ticket, key, vHead0, processedKeys) || deps.approvedGreenHeadFastPath(repoInfo, ticket, key, vProbe, vHead0) && (processedKeys.push(key), true)) {
    return true;
  }
  if (deps.recentlyConcludedNonGreen(vProbe, repoInfo, vHead0)) {
    deps.log('  ⏭️  ' + key + ' a dispatched run on this head concluded <' + validationLivenessModule.CONCLUDED_REDISPATCH_GRACE_MS / 60000 + ' min ago — no re-dispatch (check visibility grace / fresh green, fa #2148)');
    return true;
  }
  return false;
}
function checkValidatePrProbeGuards(deps, rule, effectiveConfig, repoInfo, ticket, key, vProbe, vHead0, processedKeys) {
  if (checkActiveOrFastPathGuards(deps, repoInfo, ticket, key, vProbe, vHead0, processedKeys) || checkGreenCoverSkip(deps, rule, repoInfo, key, vProbe, vHead0)) {
    return true;
  }
  if (checkLatchSkipArmOnly(deps, rule, repoInfo, ticket, key, vProbe, vHead0, processedKeys) || handleLatchEconomyAndVoid(deps, rule, repoInfo, ticket, key, vProbe)) {
    return true;
  }
  return checkDeferRedHead(deps, rule, effectiveConfig, repoInfo, ticket, key, vProbe, vHead0);
}
function checkValidatePrPreDispatchGates(deps, rule, repoInfo, ticket, key, vHead0) {
  if (deps.redHeadSkipEnabled(rule, deps.jobParams) && vHead0) {
    var rhCap = deps.redHeadCapOf(deps.jobParams);
    if (deps.redHeadBlocked(repoInfo, ticket.prNumber, vHead0, rhCap)) {
      deps.log('  🚫 ' + key + ' head ' + vHead0 + ' already went red ' + rhCap + '× — re-arm blocked until a NEW head lands (red yields the slot)');
      return true;
    }
  }
  var mutexHolder = deps.validationMutexHeldByAnother(repoInfo, rule, ticket);
  if (mutexHolder) {
    deps.log('  🔒 ' + key + ' arm refused — pr-' + mutexHolder + ' already holds ai_validating (action-time re-check; the query-time mutex scanned a stale list)');
    return true;
  }
  if (vHead0) {
    var vRaceGrace = deps.dispatchRaceGraceMs(deps.jobParams);
    if (vRaceGrace > 0 && deps.hasRecentHeadRun(deps.headWorkflowRunsSafe(repoInfo, vHead0), vRaceGrace)) {
      deps.log('  ⏭️  ' + key + ' a run just landed on this head (kicker/CI dispatch race, gh-748) — it owns the CI order, no second dispatch');
      return true;
    }
  }
  return false;
}
function finalizeValidatePrDispatch(deps, repoInfo, ticket, key, vHead0, processedKeys) {
  try {
    deps.dispatchCiWorkflow(ticket.branch);
  } catch (eCi922) {
    deps.warn('  ⚠️  validation dispatch failed for ' + key + ': ' + (eCi922.message || eCi922));
    deps.recordDispatchFailure(repoInfo, key, ticket, eCi922, ticket.branch, triggerFailuresModule.classifyTriggerError(eCi922 && eCi922.message));
    return;
  }
  if (vHead0) {
    deps.stampValidationChecks(repoInfo, vHead0, 'in_progress', null, null);
  }
  if (!deps.dry) {
    deps.githubTracker(repoInfo).addLabel(ticket.prNumber, 'ai_validating');
  }
  deps.log('  🧪 ' + key + ' validation dispatched (CI runs on the head via workflow_dispatch)');
  processedKeys.push(key);
}
function cancelStaleAndCurePlaceholders(deps, repoInfo, ticket, key, vCiWf, vHead0, vProbe, processedKeys) {
  if (vHead0) {
    var vCancelResult = deps.cancelStaleDispatchedRuns(repoInfo, vCiWf, ticket.branch, vHead0);
    deps.postGhostGuardAudit(repoInfo, ticket.prNumber, vCancelResult);
  }
  return handlePlaceholdersAndOrphansGate(deps, repoInfo, ticket, key, vCiWf, vHead0, vProbe, processedKeys);
}
function resolveTicketCiWorkflow(rule, jobParams) {
  return rule.ciWorkflow || (jobParams || {}).ciWorkflow || 'quality.yml';
}
function dispatchAndArmValidatePr(deps, rule, effectiveConfig, repoInfo, ticket, key, processedKeys) {
  var vHead0 = ticket.pr && ticket.pr.headSha || ticket.headSha;
  var vCiWf = resolveTicketCiWorkflow(rule, deps.jobParams);
  var vProbe = vHead0 ? deps.probeDispatchedState(repoInfo, vCiWf, vHead0) : null;
  if (checkValidatePrProbeGuards(deps, rule, effectiveConfig, repoInfo, ticket, key, vProbe, vHead0, processedKeys)) {
    return;
  }
  if (checkValidatePrPreDispatchGates(deps, rule, repoInfo, ticket, key, vHead0)) {
    return;
  }
  if (cancelStaleAndCurePlaceholders(deps, repoInfo, ticket, key, vCiWf, vHead0, vProbe, processedKeys)) {
    return;
  }
  finalizeValidatePrDispatch(deps, repoInfo, ticket, key, vHead0, processedKeys);
}
function checkValidatePrEntryGates(deps, rule, effectiveConfig, repoInfo, ticket, key, skippedKeys) {
  if (ticket.prNumber && deps.prTerminalStateOf(repoInfo, ticket.prNumber)) {
    deps.log('  ⏭️  ' + key + ' PR #' + ticket.prNumber + ' (merged/closed) — ' + TERMINAL_PR_SKIP_MSG + ' (gh-1402: no CI trigger, no arm, no comment, no attempt counting)');
    return false;
  }
  if (smRuleLayersModule.isMergePathRule(rule) && ticket.prNumber && deps.tickMovedPrs[ticket.prNumber]) {
    deps.log('  ⏭ pr-' + ticket.prNumber + ' head moved this tick — merge-candidate validation deferred to the next tick');
    skippedKeys.push(key);
    return false;
  }
  if (!checkValidatePrParkedBackstop(deps, effectiveConfig, repoInfo, ticket, key)) {
    return false;
  }
  if (!ticket.branch) {
    deps.error('  ❌ validate_pr: no head branch on ' + key + ' — skipped');
    return false;
  }
  return true;
}
function handleValidatePrAction(deps, rule, effectiveConfig, repoInfo, ticket, key, processedKeys, skippedKeys) {
  if (!checkValidatePrEntryGates(deps, rule, effectiveConfig, repoInfo, ticket, key, skippedKeys)) {
    return;
  }
  try {
    dispatchAndArmValidatePr(deps, rule, effectiveConfig, repoInfo, ticket, key, processedKeys);
  } catch (e) {
    deps.error('  ❌ validate_pr failed for ' + key + ': ' + (e.message || e));
  }
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PLACEHOLDER_PARK_MARKER: PLACEHOLDER_PARK_MARKER,
      TERMINAL_PR_SKIP_MSG: TERMINAL_PR_SKIP_MSG,
      cancelStaleAfterRefreshUb: cancelStaleAfterRefreshUb,
      handleUpdateBranchAction: handleUpdateBranchAction,
      handleValidatePrAction: handleValidatePrAction
    };
}
