/**
 * Ticket/issue/review/merge localAction handlers — js/sm/prLifecycleActions.js (#1459).
 *
 * Implements close_issue, advance_plan, mark_developed, arm_review,
 * reconcile_verdicts, arm_rework, restore_rework_arm, merge_pr,
 * complete_validation, and transplant_guest_pr.
 */
'use strict';

var guestTransplantModule = require('../common/guestTransplant.js');
var issuePlanModule = require('../common/issuePlan.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var machineNoticeModule = require('../common/machineNotice.js');
var planAdvanceModule = require('../common/planAdvance.js');
var prTerminalStateModule = require('../common/prTerminalState.js');
var reworkLoopGuardModule = require('../common/reworkLoopGuard.js');
function handleCloseIssueAction(deps, repoInfo, ticket, key, processedKeys) {
  try {
    deps.closeIssue(repoInfo, ticket.issueNumber);
    deps.log('  ✅ ' + key + ' issue #' + ticket.issueNumber + ' closed (linked PR #' + ticket.prNumber + ' merged)');
    processedKeys.push(key);
  } catch (e) {
    deps.error('  ❌ close_issue failed for ' + key + ': ' + (e.message || e));
  }
}
function recordAdvancePlanOutcome(planStep, key, processedKeys, skippedKeys) {
  if (planStep.type === 'start' || planStep.type === 'complete') {
    processedKeys.push(key);
  } else {
    skippedKeys.push(key);
  }
}
function handleAdvancePlanAction(deps, rule, effectiveConfig, repoInfo, ticket, key, processedKeys, skippedKeys) {
  try {
    var planCfg = issuePlanModule.resolvePlanningConfig(effectiveConfig, (deps.jobParams || {}).customParams || {});
    var planTracker = rule.source === 'github' ? deps.githubTracker(repoInfo) : deps.smTracker(effectiveConfig);
    var planStep = planAdvanceModule.advancePlan(planTracker, ticket.issueNumber || key, planCfg, {
      dryRun: deps.dry,
      closeIssue: function () {
        deps.closeIssue(repoInfo, ticket.issueNumber);
      }
    });
    deps.log('  ' + (deps.dry ? '🧪 [dry] ' : '') + key + ' plan: ' + planAdvanceModule.describe(planStep, planCfg));
    recordAdvancePlanOutcome(planStep, key, processedKeys, skippedKeys);
  } catch (e) {
    deps.error('  ❌ advance_plan failed for ' + key + ': ' + (e.message || e));
  }
}
function handleMarkDevelopedAction(deps, repoInfo, ticket, key, processedKeys) {
  try {
    deps.githubTracker(repoInfo).addLabel(ticket.issueNumber, 'ai_developed');
    deps.log('  ✅ ' + key + ' issue #' + ticket.issueNumber + ' labeled ai_developed (green PR #' + ticket.prNumber + ')');
    processedKeys.push(key);
  } catch (e) {
    deps.error('  ❌ mark_developed failed for ' + key + ': ' + (e.message || e));
  }
}
function handleArmReviewAction(deps, effectiveConfig, repoInfo, ticket, key, processedKeys) {
  var ma = machineAuthorModule.resolveMachineAuthor(deps.jobParams, effectiveConfig);
  if (deps.armReviewOnlyMachineMerges(repoInfo, ticket, key, ma)) {
    return;
  }
  try {
    deps.githubTracker(repoInfo).addLabel(ticket.prNumber, 'agent:review');
    deps.log('  ✅ ' + key + ' agent:review re-armed (stale CHANGES_REQUESTED on PR #' + ticket.prNumber + ')');
    processedKeys.push(key);
  } catch (e) {
    deps.error('  ❌ arm_review failed for ' + key + ': ' + (e.message || e));
  }
}
function handleReconcileVerdictsAction(deps, effectiveConfig, repoInfo, ticket, key, processedKeys) {
  try {
    if (deps.dry) {
      deps.log('  🧪 [dry] ' + key + ' would reconcile review verdicts on PR #' + ticket.prNumber);
      processedKeys.push(key);
      return;
    }
    if (deps.reconcileReviewVerdicts(repoInfo, ticket, deps.verdictMachineLogins(effectiveConfig))) {
      processedKeys.push(key);
    } else {
      deps.log('  ⏭️  ' + key + ' verdict records and labels already agree — nothing to reconcile');
    }
  } catch (e) {
    deps.error('  ❌ reconcile_verdicts failed for ' + key + ': ' + (e.message || e));
  }
}
function handleRestoreReworkArmAction(deps, rule, effectiveConfig, repoInfo, ticket, key, processedKeys) {
  if (deps.dry) {
    deps.log('  🧪 [dry] ' + key + ' would restore agent:rework (consumed-without-work sweep, gh-840)');
    processedKeys.push(key);
    return;
  }
  if (deps.restoreReworkArm(key, ticket, rule, repoInfo, effectiveConfig)) {
    processedKeys.push(key);
  }
}
function handleRedGateCapWithhold(deps, repoInfo, ticket, key, redGateMarks, redGateHead, redGatePrior, redGateCap, processedKeys) {
  if (redGateMarks.reworkWithheld[redGateHead]) {
    deps.log('  ⏭️  ' + key + ' rework arm stays withheld at cap (' + redGatePrior + '/' + redGateCap + ' reds on head ' + String(redGateHead).substring(0, 7) + ') — escalation already posted (gh-917)');
    return;
  }
  deps.githubTracker(repoInfo).postComment(ticket.prNumber, '\uD83D\uDED1 rework arm withheld on head ' + redGateHead + ' — ' + redGatePrior + '/' + redGateCap + ' red arming attempts left the head unchanged' + ' (gh-917). The rework leg keeps closing without a fix (a violation class the agent' + ' cannot repair without the local toolchain) — the machine stops retrying here.' + ' A human owns this PR: push a fix (a NEW head restarts the budget and validation)' + ' or resolve the violation at its source.');
  deps.log('  🛑 ' + key + ' rework arm WITHHELD at cap (' + redGatePrior + '/' + redGateCap + ' reds on head ' + String(redGateHead).substring(0, 7) + ') — owner escalated (gh-917: no infinite retry)');
  processedKeys.push(key);
}
function checkNoopLoopFalsePositive(deps, repoInfo, ticket, key, noopHead) {
  try {
    var fpHeadRed = (ticket.labels || []).indexOf('validation_failed') !== -1 || deps.noopGuardHeadIsRed(repoInfo, noopHead);
    return reworkLoopGuardModule.escalationIsFalsePositive({
      unresolvedThreads: deps.unresolvedThreadCount(repoInfo, ticket.prNumber),
      headRed: fpHeadRed
    });
  } catch (eFp) {
    deps.warn('  ⚠️ ' + key + ' gh-990 false-positive probe failed — legacy' + ' escalation stands: ' + (eFp.message || eFp));
    return false;
  }
}
function postNoopLoopEscalation(deps, repoInfo, ticket, key, noopHead, noopDecision, noopComments, noopAllow) {
  var tr = deps.githubTracker(repoInfo);
  try {
    tr.addLabel(ticket.prNumber, reworkLoopGuardModule.ESCALATION_LABEL);
  } catch (eLabel) {
    deps.warn('  ⚠️ ' + key + ' loop-guard escalation label failed: ' + (eLabel.message || eLabel));
  }
  try {
    tr.postComment(ticket.prNumber, deps.findingEscalationComment(reworkLoopGuardModule.buildEscalationComment(noopHead, noopDecision.laps, noopDecision.maxLaps), noopComments, noopAllow));
  } catch (eComment) {
    deps.warn('  ⚠️ ' + key + ' loop-guard escalation comment failed: ' + (eComment.message || eComment));
  }
  deps.log('  🛑 ' + key + ' agent:rework WITHHELD — rework no-op loop guard (' + noopDecision.laps + '/' + noopDecision.maxLaps + ' empty laps on head ' + String(noopHead).substring(0, 7) + ', gh-957) — owner escalated (label +' + ' comment); a new head or a resolving leg resets the budget');
}
function handleArmReworkNoopGuard(deps, repoInfo, ticket, key, noopHead, noopLogins, processedKeys) {
  if (!noopHead || !noopLogins.length) {
    return false;
  }
  var noopComments = deps.prCommentList(repoInfo, ticket.prNumber);
  var noopAllow = {
    authorLogins: noopLogins
  };
  var noopDecision = reworkLoopGuardModule.shouldWithholdArm({
    markers: reworkLoopGuardModule.parseLapMarkers(noopComments, noopAllow),
    escalationMarkers: reworkLoopGuardModule.parseEscalationMarkers(noopComments, noopAllow),
    headSha: noopHead,
    maxNoopLaps: deps.noopLapMaxOf(deps.jobParams)
  });
  if (!noopDecision.withhold) {
    return false;
  }
  if (!noopDecision.escalate) {
    deps.log('  ⏭️  ' + key + ' agent:rework stays withheld — no-op loop guard' + ' escalation already posted for head ' + String(noopHead).substring(0, 7) + ' (gh-957)');
    return true;
  }
  if (checkNoopLoopFalsePositive(deps, repoInfo, ticket, key, noopHead)) {
    deps.log('  ⏭️  ' + key + ' agent:rework stays withheld (gh-957 budget ' + noopDecision.laps + '/' + noopDecision.maxLaps + ' on head ' + String(noopHead).substring(0, 7) + ') — escalation SUPPRESSED (gh-990):' + ' 0 unresolved threads and no red validation — validation re-flow owns' + ' this PR, not a human park');
    processedKeys.push(key);
    return true;
  }
  postNoopLoopEscalation(deps, repoInfo, ticket, key, noopHead, noopDecision, noopComments, noopAllow);
  processedKeys.push(key);
  return true;
}
function postArmReworkNotice(deps, repoInfo, ticket, key, redGated, redGateLine, redGateCap, armNoticeHead) {
  var tr = deps.githubTracker(repoInfo);
  var armRecentComments = deps.prCommentList(repoInfo, ticket.prNumber);
  if (redGated) {
    var redGateBody = machineNoticeModule.noticeWithHead((redGateLine ? redGateLine + '\n' : '') + '\uD83D\uDD34 Red pre-merge gate on the head with no armed validation — rework armed' + ' (gh-917: first validation included, review or no review). The rework runner pushes a' + ' fix and validation re-runs on the new head (validate-fresh). After ' + redGateCap + ' red arming attempts on the SAME head the arm is withheld and a human is escalated' + ' (no infinite retry).', armNoticeHead);
    if (machineNoticeModule.shouldPostNotice(armRecentComments, redGateBody, armNoticeHead)) {
      tr.postComment(ticket.prNumber, redGateBody);
    } else {
      deps.log('  ⏭️  ' + key + ' red-gate arm notice suppressed — identical notice already' + ' posted on head ' + String(armNoticeHead).substring(0, 7) + ' (gh-1387 reduction)');
    }
    deps.log('  ✅ ' + key + ' agent:rework armed (red pre-merge gate on PR #' + ticket.prNumber + ', first validation included — gh-917)');
    return;
  }
  var armNoticeBody = machineNoticeModule.noticeWithHead('🧵 Unresolved review threads — rework armed. This machine-authored PR is reviewed ' + '(ai_pr_reviewed) but still has open review threads. The rework leg owns open threads: ' + 'agent:rework is armed on this PR and the rework runner will work through the threads and push. ' + 'Validation re-runs automatically afterwards, and once the threads are resolved a fresh ' + 're-review is armed (review-threads-resolved).', armNoticeHead);
  if (machineNoticeModule.shouldPostNotice(armRecentComments, armNoticeBody, armNoticeHead)) {
    tr.postComment(ticket.prNumber, armNoticeBody);
  } else {
    deps.log('  ⏭️  ' + key + ' arm notice suppressed — identical notice already posted' + ' on arm head ' + String(armNoticeHead).substring(0, 7) + ' (gh-1387 reduction)');
  }
  deps.log('  ✅ ' + key + ' agent:rework armed (unresolved review threads on PR #' + ticket.prNumber + ')');
}
function ticketHeadSha(ticket) {
  return ticket && ticket.pr && ticket.pr.headSha || ticket && ticket.headSha || null;
}
function checkRedGateWithheld(deps, rule, repoInfo, ticket, key, processedKeys) {
  var cap = deps.redHeadCapOf(deps.jobParams);
  if (rule.redHeadGated !== true) {
    return { withheld: false, redGated: false, head: null, cap: cap, line: null };
  }
  var head = ticketHeadSha(ticket);
  var marks = deps.failMarkerState(repoInfo, ticket.prNumber);
  var prior = head ? marks.redHeads[head] || 0 : 0;
  if (prior >= cap) {
    handleRedGateCapWithhold(deps, repoInfo, ticket, key, marks, head, prior, cap, processedKeys);
    return { withheld: true };
  }
  return {
    withheld: false,
    redGated: true,
    head: head,
    cap: cap,
    line: head ? deps.redHeadMarkerLine(prior, head, cap) : null
  };
}
function executeArmReworkMain(deps, rule, effectiveConfig, repoInfo, ticket, key, terminalProbe, processedKeys) {
  var rg = checkRedGateWithheld(deps, rule, repoInfo, ticket, key, processedKeys);
  if (rg.withheld) {
    return;
  }
  var logins = deps.verdictMachineLogins(effectiveConfig);
  var armGate = deps.reworkArmGate(repoInfo, ticket, logins, terminalProbe);
  if (!armGate.arm) {
    deps.log('  ⏭️  ' + key + ' rework arm withheld — APPROVE verdict on head ' + armGate.headShort + ' is authoritative (gh-807: suggestions do not trigger rework)');
    processedKeys.push(key);
    return;
  }
  if (armGate.effective && armGate.effective.record) {
    deps.log('  ℹ️  ' + key + ' rework arm allowed — ' + armGate.reason + ' on head ' + armGate.headShort);
  }
  var noopHead = rg.head || ticketHeadSha(ticket);
  if (handleArmReworkNoopGuard(deps, repoInfo, ticket, key, noopHead, logins, processedKeys)) {
    return;
  }
  deps.githubTracker(repoInfo).addLabel(ticket.prNumber, 'agent:rework');
  postArmReworkNotice(deps, repoInfo, ticket, key, rg.redGated, rg.line, rg.cap, noopHead);
  deps.armReworkLatch(ticket);
  processedKeys.push(key);
}
function isTerminalProbeState(deps, prNumber, key, terminalProbe) {
  if (!terminalProbe || !prTerminalStateModule.isTerminalPrState(terminalProbe.state, terminalProbe.merged)) {
    return false;
  }
  deps.log('  ⏭️  ' + key + ' PR #' + prNumber + ' is ' + (terminalProbe.state || 'TERMINAL') + ' — terminal: rework never arms' + ' on a merged/closed PR (gh-1369)');
  return true;
}
function handleArmReworkAction(deps, rule, effectiveConfig, repoInfo, ticket, key, processedKeys) {
  if (deps.consultReworkLatch(key, ticket, repoInfo).latched) {
    return;
  }
  var terminalProbe = deps.prHeadAndLabels(repoInfo, ticket.prNumber);
  if (isTerminalProbeState(deps, ticket.prNumber, key, terminalProbe)) {
    return;
  }
  if (deps.dry) {
    deps.log('  🧪 [dry] ' + key + ' would arm agent:rework (' + (rule.redHeadGated === true ? 'red pre-merge gate, first validation included — gh-917' : 'unresolved review threads') + ' on PR #' + ticket.prNumber + ')');
    processedKeys.push(key);
    return;
  }
  executeArmReworkMain(deps, rule, effectiveConfig, repoInfo, ticket, key, terminalProbe, processedKeys);
}
function handleMergePrAction(deps, rule, effectiveConfig, repoInfo, ticket, key, processedKeys) {
  if (rule.guestZeroFailing && !deps.guestZeroFailingMergeGate(repoInfo, rule, ticket, key, effectiveConfig)) {
    return;
  }
  try {
    deps.attemptMergeProbe(repoInfo, ticket, key);
    processedKeys.push(key);
  } catch (e) {
    deps.error('  ❌ merge_pr failed for ' + key + ': ' + (e.message || e));
  }
}
function handleCompleteValidationAction(deps, repoInfo, ticket, key, processedKeys) {
  try {
    var tr = deps.githubTracker(repoInfo);
    tr.removeLabel(ticket.prNumber, 'ai_validating');
    tr.addLabel(ticket.prNumber, 'ai_validated');
    deps.log('  ✅ ' + key + ' validation green — ai_validated latched, review follows');
    processedKeys.push(key);
  } catch (e) {
    deps.error('  ❌ complete_validation failed for ' + key + ': ' + (e.message || e));
  }
}
function handleTransplantGuestPrAction(deps, guestCfg, effectiveConfig, repoInfo, ticket, key, processedKeys) {
  try {
    if (!guestCfg) {
      deps.log('  ⏸️  ' + key + ' guest-transplant inert (no smGuestTransplant) — skipped');
      return;
    }
    if (deps.transplantGuestPrAction(repoInfo, ticket, guestCfg, deps.verdictMachineLogins(effectiveConfig))) {
      processedKeys.push(key);
    }
  } catch (e) {
    deps.error('  ❌ transplant_guest_pr failed for ' + key + ': ' + (e.message || e));
  }
}
function runRedVerdictForTicket(ctx, rule, ticket, key, repoInfo, effectiveConfig) {
  var ciWf = rule.ciWorkflow || (ctx.jobParams || {}).ciWorkflow || 'quality.yml';
  var tr = ctx.githubTracker(repoInfo.owner, repoInfo.repo);
  var rvDeps = ctx.rvDeps;
  var pDeps = ctx.pDeps;
  return ctx.redVerdictModule.handle({
    key: key, owner: repoInfo.owner, prNumber: ticket.prNumber,
    head: ctx.resolveHeadSha(repoInfo, ticket), branch: ticket.branch
  }, {
    dry: ctx.dry, jobParams: ctx.jobParams,
    log: rvDeps.log, warn: rvDeps.warn,
    postComment: function (n, body) { tr.postComment(n, body); },
    addLabel: function (n, l) { tr.addLabel(n, l); },
    removeLabel: function (n, l) { tr.removeLabel(n, l); },
    getPr: function (n) { return ctx.validationProbesModule.mcpParse(ctx.getPrRaw(repoInfo, n)); },
    commentBodies: function () {
      return ctx.reworkAndVerdictsModule.prCommentList(rvDeps, repoInfo, ticket.prNumber).map(function (c) { return String(c && c.body || ''); });
    },
    readFailMarks: function () { return ctx.failMarkerState(repoInfo, ticket.prNumber); },
    reworkLatched: function () { return ctx.reworkAndVerdictsModule.consultReworkLatch(rvDeps, key, ticket, repoInfo).latched; },
    latchRework: function () { ctx.reworkAndVerdictsModule.armReworkLatch(rvDeps, ticket); },
    realRed: function (h) { return ctx.validationProbesModule.headHasRealFailure(pDeps, repoInfo, h); },
    isMachinePr: function () {
      var ma = ctx.machineAuthorModule.resolveMachineAuthor(ctx.jobParams, effectiveConfig);
      return ctx.machineAuthorModule.isMachineAuthored(ticket, ma, repoInfo.owner);
    },
    dispatchedRuns: function () { return ctx.validationProbesModule.dispatchedValidationRuns(pDeps, repoInfo, ciWf); },
    failingJobs: function (h) { return ctx.validationProbesModule.failingCheckNames(pDeps, repoInfo, h); },
    redLine: function (prior, h) {
      return ctx.verdictAndFailStateModule.redHeadMarkerLine(prior, h, ctx.verdictAndFailStateModule.redHeadCapOf(ctx.jobParams));
    },
    rerunFailed: function (id) {
      ctx.exec({ command: 'gh run rerun ' + id + ' --failed --repo ' + repoInfo.owner + '/' + repoInfo.repo });
    },
    stampInProgress: function (h) { ctx.stampValidationChecks(repoInfo, h, 'in_progress', null, null); }
  });
}
function bindActionHandlerDeps(d, m, ticketHelpers) {
  d.closeIssue = m.closeIssue;
  d.armReviewOnlyMachineMerges = function (r, t, k, ma) { return m.parkAndActorProbesModule.armReviewOnlyMachineMerges(m.pDeps, r, t, k, ma); };
  d.reconcileReviewVerdicts = function (r, t, logins) { return m.verdictAndFailStateModule.reconcileReviewVerdicts(m.rvDeps, r, t, logins); };
  d.verdictMachineLogins = function (cfg) { return m.verdictAndFailStateModule.verdictMachineLogins(m.rvDeps, cfg); };
  d.restoreReworkArm = function (k, t, r, ri, cfg) { return m.reworkAndVerdictsModule.restoreReworkArm(m.rvDeps, k, t, r, ri, cfg); };
  d.failMarkerState = m.failMarkerState;
  d.redHeadCapOf = m.verdictAndFailStateModule.redHeadCapOf;
  d.redHeadSkipEnabled = m.verdictAndFailStateModule.redHeadSkipEnabled;
  d.redHeadBlocked = function (r, n, sha, cap) { return m.verdictAndFailStateModule.redHeadBlocked(m.rvDeps, r, n, sha, cap); };
  d.redHeadMarkerLine = m.verdictAndFailStateModule.redHeadMarkerLine;
  d.noopGuardHeadIsRed = function (r, sha) { return m.reworkAndVerdictsModule.noopGuardHeadIsRed(m.rvDeps, r, sha); };
  d.unresolvedThreadCount = function (r, n) { return m.reworkAndVerdictsModule.unresolvedThreadCount(m.rvDeps, r, n); };
  d.findingEscalationComment = m.reworkAndVerdictsModule.findingEscalationComment;
  d.prCommentList = function (r, n) { return m.reworkAndVerdictsModule.prCommentList(m.rvDeps, r, n); };
  d.noopLapMaxOf = m.verdictAndFailStateModule.noopLapMaxOf;
  d.reworkArmGate = function (r, t, logins, probe) { return m.verdictAndFailStateModule.reworkArmGate(m.rvDeps, r, t, logins, probe); };
  d.armReworkLatch = function (t, headOverride) { m.reworkAndVerdictsModule.armReworkLatch(m.rvDeps, t, headOverride); };
  d.consultReworkLatch = function (k, t, r, headOverride) { return m.reworkAndVerdictsModule.consultReworkLatch(m.rvDeps, k, t, r, headOverride); };
  d.prHeadAndLabels = function (r, n) { return m.verdictAndFailStateModule.prHeadAndLabels(m.rvDeps, r, n); };
  d.prTerminalStateOf = function (r, n, opts) { return m.workflowDispatchModule.prTerminalStateOf(m.wdDeps, r, n, opts); };
  d.guestZeroFailingMergeGate = function (r, rule, t, k, cfg) { return m.mergeAndParkProbesModule.guestZeroFailingMergeGate(m.pDeps, r, rule, t, k, cfg); };
  d.attemptMergeProbe = function (r, t, k) { return m.mergeAndParkProbesModule.attemptMergeProbe(m.pDeps, r, t, k); };
  d.transplantGuestPrAction = function (r, t, gCfg, logins) { return m.guestTransplantRunnerModule.transplantGuestPrAction(m.gtDeps, r, t, gCfg, logins); };
  d.resolveHeadSha = m.resolveHeadSha;
  d.freshHeadSha = m.freshHeadSha;
  d.headCommitActor = function (r, sha) { return m.parkAndActorProbesModule.headCommitActor(m.pDeps, r, sha); };
  d.parkResetCommit = function (r, sha, ma) { return m.parkAndActorProbesModule.parkResetCommit(m.pDeps, r, sha, ma); };
  d.parkedSince = function (r, n) { return m.parkAndActorProbesModule.parkedSince(m.pDeps, r, n); };
  d.parkedHeadSha = function (r, n) { return m.parkAndActorProbesModule.parkedHeadSha(m.pDeps, r, n); };
  d.isMachineParkPush = m.parkAndActorProbesModule.isMachineParkPush;
  d.latestDispatchedVerdict = function (r, wf, sha) { return m.mergeAndParkProbesModule.latestDispatchedVerdict(m.pDeps, r, wf, sha); };
  d.probeDispatchedState = function (r, wf, sha) { return m.mergeAndParkProbesModule.probeDispatchedState(m.pDeps, r, wf, sha); };
  d.headHasRealFailure = function (r, sha) { return m.validationProbesModule.headHasRealFailure(m.pDeps, r, sha); };
  d.headChecksRed = function (r, n) { return m.parkAndActorProbesModule.headChecksRed(m.pDeps, r, n); };
  d.headCheckRunsSafe = function (r, sha) { return m.validationProbesModule.headCheckRunsSafe(m.pDeps, r, sha); };
  d.latestCheckRunConclusions = m.validationProbesModule.latestCheckRunConclusions;
  d.failingCheckNames = function (r, sha) { return m.validationProbesModule.failingCheckNames(m.pDeps, r, sha); };
  d.failedRunLinksLine = function (r, wf, sha) { return m.validationProbesModule.failedRunLinksLine(m.pDeps, r, wf, sha); };
  d.cancelStaleDispatchedRuns = function (r, wf, b, sha) { return m.checkRunCuresModule.cancelStaleDispatchedRuns(m.pDeps, r, wf, b, sha); };
  d.postGhostGuardAudit = function (r, n, res) { m.checkRunCuresModule.postGhostGuardAudit(m.pDeps, r, n, res); };
  d.headMoved = m.mergeAndParkProbesModule.headMoved;
  d.hasActiveLegRun = m.workflowRunTrackingModule.hasActiveLegRun;
  d.dropOpenPrsCache = m.tickOrchestratorModule.dropOpenPrsCache;
  d.validationMutexHeldByAnother = function (r, rule, t) { return m.mergeAndParkProbesModule.validationMutexHeldByAnother(m.pDeps, r, rule, t); };
  d.invisibleRequiredReset = function (r, t, k, sha, freshReset) { return m.mergeAndParkProbesModule.invisibleRequiredReset(m.pDeps, r, t, k, sha, freshReset); };
  d.headCheckRunZombies = function (r, sha) { return m.validationProbesModule.headCheckRunZombies(m.pDeps, r, sha); };
  d.headPlaceholders = function (r, sha) { return m.validationProbesModule.headPlaceholders(m.pDeps, r, sha); };
  d.headOrphanedRunChecks = function (r, sha) { return m.validationProbesModule.headOrphanedRunChecks(m.pDeps, r, sha); };
  d.validationRollupGreen = function (r, n) { return m.parkAndActorProbesModule.validationRollupGreen(m.pDeps, r, n); };
  d.greenCoverRun = function (r, wf, sha) { return m.checkRunCuresModule.greenCoverRun(m.pDeps, r, wf, sha); };
  d.concludePlaceholderCheckRuns = function (r, ph, cr) { return m.checkRunCuresModule.concludePlaceholderCheckRuns(m.pDeps, r, ph, cr); };
  d.sweepZombieCheckRunsNeutral = function (r, z, sha) { return m.checkRunCuresModule.sweepZombieCheckRunsNeutral(m.pDeps, r, z, sha); };
  d.onZombiesSwept = m.onZombiesSwept;
  d.repoPoolFree = function (r) { return m.validationProbesModule.repoPoolFree(m.pDeps, r); };
  d.approvedGreenHeadFastPath = function (r, t, k, probe, sha) { return m.mergeAndParkProbesModule.approvedGreenHeadFastPath(m.pDeps, r, t, k, probe, sha); };
  d.recentlyConcludedNonGreen = function (prb, r, sha) { return m.mergeAndParkProbesModule.recentlyConcludedNonGreen(m.pDeps, prb, r, sha); };
  d.dispatchRaceGraceMs = m.tickOrchestratorModule.dispatchRaceGraceMs;
  d.headWorkflowRunsSafe = function (r, sha) { return m.validationProbesModule.headWorkflowRunsSafe(m.pDeps, r, sha); };
  d.hasRecentHeadRun = m.validationProbesModule.hasRecentHeadRun;
  d.holdDispatchForPushSuite = function (r, t, k, sha) { return m.mergeAndParkProbesModule.holdDispatchForPushSuite(m.pDeps, r, t, k, sha); };
  d.stampValidationChecks = m.stampValidationChecks;
  d.cancelledRequiredContexts = function (r, sha, ctxs) { return m.checkRunCuresModule.cancelledRequiredContexts(m.pDeps, r, sha, ctxs); };
  d.requiredContextsSafe = function (r, n) { return m.mergeAndParkProbesModule.requiredContextsSafe(m.pDeps, r, n); };
  d.hasActiveHeadRun = m.validationProbesModule.hasActiveHeadRun;
  d.ghostFlapEscalate = function (r, t, sha, c, k, mAx) { return m.checkRunCuresModule.ghostFlapEscalate(m.pDeps, r, t, sha, c, k, mAx); };
  d.rerunTargetsForCancelledContexts = function (r, sha, ctxs, runs) { return m.checkRunCuresModule.rerunTargetsForCancelledContexts(m.pDeps, r, sha, ctxs, runs); };
  d.runRedVerdict = m.runRedVerdict;
  d.recordDispatchFailure = function (r, k, t, err, br, cls) { m.workflowDispatchModule.recordDispatchFailure(m.wdDeps, r, k, t, err, br, cls); };
  d.removeRuleLabel = function (k, l, r, ri) { m.workflowDispatchModule.removeRuleLabel(m.wdDeps, k, l, r, ri); };
  d.addRuleLabels = function (k, rule, r) { m.workflowDispatchModule.addRuleLabels(m.wdDeps, k, rule, r); };
  d.triggerWorkflow = function (r, k, rule, cfg, wb, it, skip) { return m.workflowDispatchModule.triggerWorkflow(m.wdDeps, r, k, rule, cfg, wb, it, skip); };
  if (ticketHelpers) {
    Object.assign(d, ticketHelpers);
  }
  return d;
}
function bindRuleProcessorDeps(d, m) {
  d.recordRepoSeen = m.recordRepoSeen;
  d.syncValidationChecks = m.syncValidationChecks;
  d.stampValidationChecks = m.stampValidationChecks;
  d.sweepClosedGuestBranches = function (r, gCfg, logins) { m.guestTransplantRunnerModule.sweepClosedGuestBranches(m.gtDeps, r, gCfg, logins); };
  d.verdictMachineLogins = function (cfg) { return m.verdictAndFailStateModule.verdictMachineLogins(m.rvDeps, cfg); };
  d.ruleBudgetRemaining = m.ruleBudgetRemaining;
  d.getTickMergeReservedSlots = m.getTickMergeReservedSlots;
  d.setTickMergeSlotSpent = m.setTickMergeSlotSpent;
  d.logBlockingWorkflowRuns = function (wb, wf) { m.workflowRunTrackingModule.logBlockingWorkflowRuns(m.wdDeps, wb, wf); };
  d.logRuleQuery = m.logRuleQuery;
  d.queryRuleTickets = m.queryRuleTickets;
  d.ruleTargetSelfManagesLabel = function (r) { return m.workflowDispatchModule.ruleTargetSelfManagesLabel(m.wdDeps, r); };
  d.firstMatchingLabel = m.workflowDispatchModule.firstMatchingLabel;
  d.shouldRecoverStaleTriggerLabel = m.workflowDispatchModule.shouldRecoverStaleTriggerLabel;
  d.createTargetScm = m.workflowDispatchModule.createTargetScm;
  d.hasActiveTargetWorkflowRun = function (scm, wf, cf, k) { return m.workflowRunTrackingModule.hasActiveTargetWorkflowRun(m.wdDeps, scm, wf, cf, k); };
  d.removeRuleLabel = function (k, l, r, ri) { m.workflowDispatchModule.removeRuleLabel(m.wdDeps, k, l, r, ri); };
  d.isWorkflowBudgetExhausted = function (r, cfg, wb, ri) { return m.workflowDispatchModule.isWorkflowBudgetExhausted(m.wdDeps, r, cfg, wb, ri); };
  d.moveStatus = function (k, s) { m.workflowDispatchModule.moveStatus(d, k, s); };
  d.buildBranchRefreshDeps = m.buildBranchRefreshDeps;
  d.buildActionDeps = m.buildActionDeps;
  d.buildStatePublishDeps = m.buildStatePublishDeps;
  d.runTeammateLocally = function (k, r, cfg) { return m.workflowDispatchModule.runTeammateLocally(m.wdDeps, k, r, cfg); };
  d.addRuleLabels = function (k, r, ri) { m.workflowDispatchModule.addRuleLabels(m.wdDeps, k, r, ri); };
  d.triggerWorkflow = function (r, k, rule, cfg, wb, it, skip) { return m.workflowDispatchModule.triggerWorkflow(m.wdDeps, r, k, rule, cfg, wb, it, skip); };
  d.auditReworkConsumption = m.wdDeps.auditReworkConsumption;
  return d;
}
module.exports = {
  runRedVerdictForTicket: runRedVerdictForTicket,
  bindActionHandlerDeps: bindActionHandlerDeps,
  bindRuleProcessorDeps: bindRuleProcessorDeps,
  handleCloseIssueAction: handleCloseIssueAction,
  handleAdvancePlanAction: handleAdvancePlanAction,
  handleMarkDevelopedAction: handleMarkDevelopedAction,
  handleArmReviewAction: handleArmReviewAction,
  handleReconcileVerdictsAction: handleReconcileVerdictsAction,
  handleRestoreReworkArmAction: handleRestoreReworkArmAction,
  handleArmReworkAction: handleArmReworkAction,
  handleMergePrAction: handleMergePrAction,
  handleCompleteValidationAction: handleCompleteValidationAction,
  handleTransplantGuestPrAction: handleTransplantGuestPrAction
};
