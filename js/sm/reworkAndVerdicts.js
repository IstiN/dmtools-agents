/**
 * Rework consumption audit, latch, thread census, and restore-rework-arm —
 * js/sm/reworkAndVerdicts.js (#1459).
 */
'use strict';

var factoryStateModule = require('../factoryState.js');
var findingRegistryModule = require('../common/findingRegistry.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var prTerminalStateModule = require('../common/prTerminalState.js');
var reworkConsumptionModule = require('../common/reworkConsumption.js');
var reworkLatchModule = require('../common/reworkLatch.js');
var reworkLoopGuardModule = require('../common/reworkLoopGuard.js');
var reviewVerdictsModule = require('../common/reviewVerdicts.js');
var validationProbesModule = require('./validationProbes.js');
var verdictAndFailStateModule = require('./verdictAndFailState.js');
function prCommentList(deps, repoInfo, prNumber) {
  try {
    return deps.fetchPrCommentList(repoInfo, prNumber);
  } catch (e) {
    deps.warn('  ⚠️ gh-840: comment read failed (fail-closed): ' + (e.message || e));
    return [];
  }
}
function findingEscalationComment(escalationBody, prComments, allow) {
  var record = findingRegistryModule.latestRegistry(prComments || [], allow);
  var packet = record ? findingRegistryModule.buildEscalationPacketComment(record.registry) : null;
  return packet ? escalationBody + '\n' + packet : escalationBody;
}
function postConsumptionAuditMarker(deps, repoInfo, prNumber, path, body) {
  if (deps.dry) {
    deps.log('  [dry] 🏷️ gh-840 consumption audit (' + path + ') on PR #' + prNumber);
    return;
  }
  try {
    deps.githubTracker(repoInfo).postComment(prNumber, body);
    deps.log('  🏷️  gh-840: agent:rework consumption audited (path: ' + path + ') on PR #' + prNumber);
  } catch (eAudit) {
    deps.warn('  ⚠️ gh-840: consumption audit comment failed (non-fatal): ' + (eAudit.message || eAudit));
  }
}
function resolveConsumptionHead(deps, repoInfo, ticket) {
  var head = ticket.pr && ticket.pr.headSha || ticket.headSha || null;
  if (head) {
    return head;
  }
  var probe = verdictAndFailStateModule.prHeadAndLabels(deps, repoInfo, ticket.prNumber);
  return probe ? probe.headSha : null;
}
function auditReworkConsumption(deps, repoInfo, ticket, label, path) {
  if (label !== reviewVerdictsModule.LABEL_REWORK) {
    return;
  }
  if (!ticket || !ticket.prNumber) {
    deps.warn('  ⚠️ gh-840: agent:rework consumed on ' + (ticket && ticket.key) + ' with no PR anchor — audit marker skipped');
    return;
  }
  var head = resolveConsumptionHead(deps, repoInfo, ticket);
  var body = reworkConsumptionModule.buildConsumeAuditComment(path, head);
  if (!body) {
    deps.warn('  ⚠️ gh-840: agent:rework consumed on PR #' + ticket.prNumber + ' (path: ' + path + ') but the head could not be attributed ' + '(item.pr null, fresh probe failed) — no audit marker posted; the sweep has no evidence');
    return;
  }
  postConsumptionAuditMarker(deps, repoInfo, ticket.prNumber, path, body);
}
function unresolvedThreadCount(deps, repoInfo, prNumber) {
  if (!deps.hasGetThreads) {
    return -1;
  }
  try {
    var nodes = deps.fetchPrReviewThreadNodes(repoInfo, prNumber);
    var n = 0;
    nodes.forEach(function (t) {
      if (t && t.isResolved !== true) {
        n++;
      }
    });
    return n;
  } catch (eCensus) {
    deps.warn('  ⚠️ gh-990: unresolved-thread census failed (fail closed): ' + (eCensus.message || eCensus));
    return -1;
  }
}
function noopGuardHeadIsRed(deps, repoInfo, headSha) {
  if (!headSha) {
    return true;
  }
  var rollup = deps.headCheckRunsSafe(repoInfo, headSha);
  if (!rollup) {
    return true;
  }
  return validationProbesModule.eachNonBookkeepingConclusion(rollup, function (concl) {
    return concl === 'FAILURE' || concl === 'TIMED_OUT';
  });
}
function firstCommentAuthor(t) {
  var first = t.comments && t.comments.nodes && t.comments.nodes[0] || {};
  return first.author && (first.author.login || first.author.name);
}
function isUnresolvedMachineThread(t, lower) {
  if (!t || t.isResolved === true) {
    return false;
  }
  return machineAuthorModule.loginMatchesList(firstCommentAuthor(t), lower);
}
function normalizeLowerLogins(machineLogins) {
  return (machineLogins || []).map(function (l) {
    return String(l || '').toLowerCase();
  });
}
function unresolvedMachineThreadCount(deps, repoInfo, prNumber, machineLogins) {
  if (!deps.hasGetThreads) {
    return -1;
  }
  var lower = normalizeLowerLogins(machineLogins);
  if (!lower.length) {
    return 0;
  }
  try {
    var nodes = deps.fetchPrReviewThreadNodes(repoInfo, prNumber);
    return nodes.filter(function (t) {
      return isUnresolvedMachineThread(t, lower);
    }).length;
  } catch (eCensus) {
    deps.warn('  ⚠️ gh-840: machine-thread census failed (fail-closed): ' + (eCensus.message || eCensus));
    return -1;
  }
}
function parseJsonOrSelf(raw) {
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
function parseStatePublishReleaseCfg(jobParams) {
  var raw = parseJsonOrSelf(jobParams && jobParams.statePublish);
  return raw && raw.channel === 'release' ? raw : null;
}
function tickReworkLatchState(deps, effectiveRepoInfo) {
  var current = deps.getTickReworkLatch();
  if (current) {
    return current;
  }
  var state = {
    map: {}
  };
  var spCfg = parseStatePublishReleaseCfg(deps.jobParams);
  if (spCfg && effectiveRepoInfo && effectiveRepoInfo.owner && effectiveRepoInfo.repo) {
    var prev = factoryStateModule.fetchPreviousState(effectiveRepoInfo.owner + '/' + effectiveRepoInfo.repo, spCfg, deps.exec);
    state.map = reworkLatchModule.normalizeMap(prev && prev.reworkInFlight);
  }
  deps.setTickReworkLatch(state);
  return state;
}
function reworkLatchHeadOf(ticket) {
  return ticket && ticket.pr && ticket.pr.headSha || ticket && ticket.headSha || null;
}
function evaluateLatchVerdict(deps, latchState, prNumber, head, effectiveRepoInfo) {
  var verdict = reworkLatchModule.isActive(latchState.map, prNumber, head, {});
  if (!verdict.entry) {
    return verdict;
  }
  var runs = deps.headWorkflowRunsSafe(effectiveRepoInfo, head);
  return reworkLatchModule.isActive(latchState.map, prNumber, head, {
    runs: runs,
    workflowFile: reworkLatchModule.DEFAULT_LEG_WORKFLOW
  });
}
function clearExpiredLatchIfPresent(deps, latchState, verdict, key, prNumber, head) {
  if (verdict.entry) {
    reworkLatchModule.clear(latchState.map, prNumber, head);
    deps.log('  🔓 ' + key + ' rework latch cleared (' + verdict.cause + ') for (pr-' + prNumber + ', ' + head.substring(0, 7) + ')');
  }
  return {
    latched: false,
    head: head
  };
}
function consultReworkLatch(deps, key, ticket, effectiveRepoInfo, headOverride) {
  var prNumber = ticket && ticket.prNumber;
  var head = headOverride || reworkLatchHeadOf(ticket);
  if (!prNumber || !head) {
    return {
      latched: false,
      head: head
    };
  }
  var latchState = tickReworkLatchState(deps, effectiveRepoInfo);
  var verdict = evaluateLatchVerdict(deps, latchState, prNumber, head, effectiveRepoInfo);
  if (!verdict.active) {
    return clearExpiredLatchIfPresent(deps, latchState, verdict, key, prNumber, head);
  }
  deps.log('  ⏭️  ' + key + ' rework already in flight for (pr-' + prNumber + ', ' + head.substring(0, 7) + ')');
  return {
    latched: true,
    head: head
  };
}
function armReworkLatch(deps, ticket, headOverride) {
  if (deps.dry) {
    return;
  }
  var prNumber = ticket && ticket.prNumber;
  var head = headOverride || reworkLatchHeadOf(ticket);
  if (!prNumber || !head) {
    return;
  }
  var latchState = tickReworkLatchState(deps, null);
  reworkLatchModule.arm(latchState.map, prNumber, head, null, 'sm');
}
function postRestoreNoopEscalation(deps, repoInfo, prNumber, key, head, noopDecision) {
  if (!noopDecision.escalate) {
    deps.log('  ⏭️  ' + key + ' sweep: restore stays withheld — no-op loop guard escalation already posted for head ' + String(head).substring(0, 7) + ' (gh-957)');
    return;
  }
  var tr = deps.githubTracker(repoInfo);
  tr.addLabel(prNumber, reworkLoopGuardModule.ESCALATION_LABEL);
  tr.postComment(prNumber, reworkLoopGuardModule.buildEscalationComment(head, noopDecision.laps, noopDecision.maxLaps));
  deps.log('  🛑 ' + key + ' sweep: agent:rework restore WITHHELD — no-op loop guard (' + noopDecision.laps + '/' + noopDecision.maxLaps + ' empty laps on head ' + String(head).substring(0, 7) + ', gh-957) — owner escalated');
}
function handleRestoreNoopGuard(deps, repoInfo, prNumber, key, head, comments, machineLogins) {
  if (!head || !machineLogins.length) {
    return false;
  }
  var allow = {
    authorLogins: machineLogins
  };
  var noopDecision = reworkLoopGuardModule.shouldWithholdArm({
    markers: reworkLoopGuardModule.parseLapMarkers(comments, allow),
    escalationMarkers: reworkLoopGuardModule.parseEscalationMarkers(comments, allow),
    headSha: head,
    maxNoopLaps: verdictAndFailStateModule.noopLapMaxOf(deps.jobParams)
  });
  if (!noopDecision.withhold) {
    return false;
  }
  postRestoreNoopEscalation(deps, repoInfo, prNumber, key, head, noopDecision);
  return true;
}
function evaluateRestoreArmDecision(comments, machineLogins, machineThreads, staleMin) {
  var allow = {
    authorLogins: machineLogins
  };
  var consumed = reworkConsumptionModule.parseConsumeMarkers(comments, allow);
  var restored = reworkConsumptionModule.parseRestoreMarkers(comments, allow);
  var newestConsume = consumed.length ? consumed[consumed.length - 1] : null;
  var decision = reworkConsumptionModule.shouldRestoreArm({
    unresolvedMachineThreads: machineThreads,
    hasReworkLabel: false,
    reworkInFlight: false,
    consumedAtMs: newestConsume ? newestConsume.atMs : null,
    restoredAtMs: restored.length ? restored[restored.length - 1].atMs : null,
    nowMs: Date.now(),
    staleMs: staleMin * 60 * 1000
  });
  return {
    decision: decision,
    newestConsume: newestConsume
  };
}
function applyRestoredReworkArm(deps, repoInfo, ticket, key, head, newestConsume, decision, machineThreads, staleMin) {
  var prNumber = ticket.prNumber;
  var tr = deps.githubTracker(repoInfo);
  tr.addLabel(prNumber, 'agent:rework');
  var markerBody = reworkConsumptionModule.buildRestoreMarkerComment(head || newestConsume && newestConsume.head || 'unknown', decision.reason);
  if (markerBody) {
    try {
      tr.postComment(prNumber, markerBody);
    } catch (eMarker) {
      deps.warn('  ⚠️ gh-840: restore marker comment failed (non-fatal): ' + (eMarker.message || eMarker));
    }
  }
  armReworkLatch(deps, ticket, head);
  deps.log('  🔄 ' + key + ' agent:rework RESTORED (gh-840: previous consumption left ' + machineThreads + ' machine thread(s) unresolved, quiet > ' + staleMin + 'm) — rework-on-label re-dispatches the leg');
  return true;
}
function isRestoreBlockedByLatchOrLeg(deps, key, ticket, repoInfo, head) {
  if (consultReworkLatch(deps, key, ticket, repoInfo, head).latched) {
    return true;
  }
  if (head && deps.hasActiveLegRun(deps.headWorkflowRunsSafe(repoInfo, head), reworkLatchModule.DEFAULT_LEG_WORKFLOW)) {
    deps.log('  ⏭️  ' + key + ' sweep: a leg run is active on head ' + String(head).substring(0, 7) + ' — the leg owns the threads');
    return true;
  }
  return false;
}
function isProbedPrTerminal(deps, prNumber, probedHead) {
  if (!probedHead || !prTerminalStateModule.isTerminalPrState(probedHead.state, probedHead.merged)) {
    return false;
  }
  deps.log('  ⏭️  pr-' + prNumber + ' sweep: PR #' + prNumber + ' is ' + (probedHead.state || 'TERMINAL') + ' — terminal: nothing to restore (gh-1369)');
  return true;
}
function resolveRestoreHead(ticket, probedHead) {
  return reworkLatchHeadOf(ticket) || (probedHead ? probedHead.headSha : null);
}
function checkRestorePreGates(deps, key, ticket, repoInfo, effectiveConfig) {
  var prNumber = ticket && ticket.prNumber;
  if (!prNumber) {
    deps.log('  ⏭️  ' + key + ' sweep: no PR anchor — nothing to restore');
    return null;
  }
  var probedHead = verdictAndFailStateModule.prHeadAndLabels(deps, repoInfo, prNumber);
  var head = resolveRestoreHead(ticket, probedHead);
  if (isProbedPrTerminal(deps, prNumber, probedHead) || isRestoreBlockedByLatchOrLeg(deps, key, ticket, repoInfo, head)) {
    return null;
  }
  var machineLogins = verdictAndFailStateModule.verdictMachineLogins(deps, effectiveConfig);
  var armGate = verdictAndFailStateModule.reworkArmGate(deps, repoInfo, ticket, machineLogins, probedHead);
  if (armGate.arm) {
    return { prNumber: prNumber, head: head, machineLogins: machineLogins };
  }
  deps.log('  ⏭️  ' + key + ' sweep: arm withheld — ' + armGate.reason + ' on head ' + armGate.headShort + ' (gh-807 verdict semantics preserved)');
  return null;
}
function restoreReworkArm(deps, key, ticket, rule, repoInfo, effectiveConfig) {
  var pre = checkRestorePreGates(deps, key, ticket, repoInfo, effectiveConfig);
  if (!pre) {
    return false;
  }
  var comments = prCommentList(deps, repoInfo, pre.prNumber);
  var machineThreads = unresolvedMachineThreadCount(deps, repoInfo, pre.prNumber, pre.machineLogins);
  if (machineThreads === -1) {
    deps.log('  ⏭️  ' + key + ' sweep: machine-thread census unavailable — fail closed, retry next tick');
    return false;
  }
  var staleMin = typeof rule.staleMinutes === 'number' && rule.staleMinutes > 0 ? rule.staleMinutes : Math.round(reworkConsumptionModule.DEFAULT_RESTORE_STALE_MS / 60000);
  var evalRes = evaluateRestoreArmDecision(comments, pre.machineLogins, machineThreads, staleMin);
  if (!evalRes.decision.restore) {
    deps.log('  ⏭️  ' + key + ' sweep: no restore (' + evalRes.decision.reason + ')');
    return false;
  }
  if (handleRestoreNoopGuard(deps, repoInfo, pre.prNumber, key, pre.head, comments, pre.machineLogins)) {
    return false;
  }
  return applyRestoredReworkArm(deps, repoInfo, ticket, key, pre.head, evalRes.newestConsume, evalRes.decision, machineThreads, staleMin);
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      prCommentList: prCommentList,
      findingEscalationComment: findingEscalationComment,
      auditReworkConsumption: auditReworkConsumption,
      unresolvedThreadCount: unresolvedThreadCount,
      noopGuardHeadIsRed: noopGuardHeadIsRed,
      unresolvedMachineThreadCount: unresolvedMachineThreadCount,
      reworkLatchHeadOf: reworkLatchHeadOf,
      consultReworkLatch: consultReworkLatch,
      armReworkLatch: armReworkLatch,
      restoreReworkArm: restoreReworkArm
    };
}
