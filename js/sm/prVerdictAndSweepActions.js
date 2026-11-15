/**
 * Cancelled-checks rerun, conflict rework, and stale-validation sweep
 * localAction handlers — js/sm/prVerdictAndSweepActions.js (#1459).
 */
'use strict';

var checkRunStampModule = require('../common/checkRunStamp.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var mutexRegistryModule = require('../common/mutexRegistry.js');
var prTerminalStateModule = require('../common/prTerminalState.js');
var validationLivenessModule = require('../common/validationLiveness.js');
var validationProbesModule = require('./validationProbes.js');
var mcpParse = validationProbesModule.mcpParse;
function isUnarmHeadGreen(deps, rule, repoInfo, ticket) {
  var uHead = ticket.pr && ticket.pr.headSha || ticket.headSha;
  if (!uHead) {
    return false;
  }
  var uCiWf = rule.ciWorkflow || (deps.jobParams || {}).ciWorkflow || 'quality.yml';
  var uProbe = deps.probeDispatchedState(repoInfo, uCiWf, uHead);
  return !!(uProbe && uProbe.green);
}
function handleUnarmValidationAction(deps, rule, repoInfo, ticket, key, processedKeys) {
  try {
    var uGreen = isUnarmHeadGreen(deps, rule, repoInfo, ticket);
    var tr = deps.githubTracker(repoInfo);
    tr.removeLabel(ticket.prNumber, 'ai_validating');
    if (uGreen) {
      tr.addLabel(ticket.prNumber, 'ai_validated');
    }
    deps.dropOpenPrsCache(repoInfo);
    deps.log(uGreen ? '  🔓 ' + key + ' BEHIND strip — head validation green, ai_validated latched (verdict consumed, no re-dispatch — gh-751)' : '  🔓 ' + key + ' unarmed (validated head went stale) — refresh + re-validate follows');
    processedKeys.push(key);
  } catch (e) {
    deps.error('  ❌ unarm_validation failed for ' + key + ': ' + (e.message || e));
  }
}
function parseRuleRequiredContexts(rule) {
  if (Array.isArray(rule.requiredContexts)) {
    return rule.requiredContexts;
  }
  var raw = typeof rule.requiredContexts === 'string' ? rule.requiredContexts : '';
  return raw.split(',').map(function (s) {
    return s.trim();
  }).filter(Boolean);
}
function readCommentListWithMarker(deps, repoInfo, prNumber, marker, headSha) {
  try {
    var list = deps.fetchPrCommentList(repoInfo, prNumber);
    var reported = list.some(function (c) {
      var b = String(c && c.body || '');
      return b.indexOf(marker) !== -1 && (!headSha || b.indexOf(String(headSha)) !== -1);
    });
    return {
      list: list,
      reported: reported
    };
  } catch (e) {
    return {
      list: [],
      reported: false
    };
  }
}
function resolveGhostCiWorkflow(rule, jobParams) {
  return rule.ciWorkflow || (jobParams || {}).ciWorkflow || 'quality.yml';
}
function executeGhostCancelRedispatch(deps, rule, repoInfo, ticket, key, rcHead, ghostProbe, ghostMarker, processedKeys) {
  var ghostCi = resolveGhostCiWorkflow(rule, deps.jobParams);
  if (deps.dry) {
    deps.log('  🧪 [dry] ghost-cancel re-dispatch skipped (gh workflow run ' + ghostCi + ' @ ' + ticket.branch + ')');
    return;
  }
  var ghostRef = checkRunStampModule.shellQuote(String(ticket.branch || ''));
  try {
    deps.exec({
      command: 'gh workflow run ' + ghostCi + ' --repo ' + repoInfo.owner + '/' + repoInfo.repo + ' --ref ' + ghostRef
    });
  } catch (eGhostDispatch) {
    deps.warn('  ⚠️  ' + key + ' ghost-cancel re-dispatch failed: ' + (eGhostDispatch.message || eGhostDispatch) + ' — no marker posted, retried next tick');
    return;
  }
  deps.githubTracker(repoInfo).postComment(ticket.prNumber, ghostMarker + ': the newest dispatched validation run (' + ghostProbe.runId + ') concluded CANCELLED before its check runs ' + 'materialized — no required check will ever re-report on its own ' + '(gh-1000 ghost-cancel class, live gh-757). CANCELLED is never a ' + 'verdict: fresh CI re-dispatched on the same head, merging resumes ' + 'automatically. (head `' + rcHead + '`)');
  deps.log('  🔁 ' + key + ' ghost-cancelled validation re-dispatched (run ' + ghostProbe.runId + ' concluded ' + ghostProbe.conclusion + ')');
  processedKeys.push(key);
}
function isGhostCancelGateHeld(deps, repoInfo, rcHead, rcHeadRuns, rcAny, rcContexts) {
  var ghostProbe = mutexRegistryModule.isGhostCancelProbe(rcHeadRuns, null);
  var ghostRollup = ghostProbe.isGhostCancel ? deps.headCheckRunsSafe(repoInfo, rcHead) : null;
  if (!ghostRollup) {
    return null;
  }
  var ghostLatest = deps.latestCheckRunConclusions(ghostRollup);
  var ghostNames = rcAny ? Object.keys(ghostLatest) : rcContexts;
  var held = ghostNames.some(function (c) {
    return !ghostLatest[c] || ghostLatest[c].concl === null;
  });
  return held ? ghostProbe : null;
}
function handleNoCancelledContextsPath(deps, rule, repoInfo, ticket, key, rcHead, rcHeadRuns, rcAny, rcContexts, processedKeys) {
  var ghostProbe = isGhostCancelGateHeld(deps, repoInfo, rcHead, rcHeadRuns, rcAny, rcContexts);
  if (!ghostProbe) {
    deps.log('  ⏭️  ' + key + ' no context reads CANCELLED on ' + rcHead.substring(0, 7) + ' — nothing to rerun');
    return;
  }
  var ghostMarker = '🔁 Ghost-cancelled validation re-dispatched';
  var scan = readCommentListWithMarker(deps, repoInfo, ticket.prNumber, ghostMarker, rcHead);
  if (scan.reported) {
    var ghostFlapPosted = deps.ghostFlapEscalate(repoInfo, ticket, rcHead, scan.list, key, ghostMarker);
    deps.log('  ⏭️  ' + key + ' ghost-cancelled validation already ' + 're-dispatched for head — waiting on the run' + (ghostFlapPosted ? ' (flap alarm posted)' : ''));
    return;
  }
  executeGhostCancelRedispatch(deps, rule, repoInfo, ticket, key, rcHead, ghostProbe, ghostMarker, processedKeys);
}
function dispatchCancelledRunReruns(deps, repoInfo, rcTargets) {
  var rcSeen = {};
  rcTargets.forEach(function (t) {
    if (rcSeen[t.runId]) {
      return;
    }
    rcSeen[t.runId] = true;
    if (deps.dry) {
      deps.log('  [dry] ▶️ gh run rerun ' + t.runId + ' (' + t.context + ')');
      return;
    }
    deps.exec({
      command: 'gh run rerun ' + t.runId + ' --repo ' + repoInfo.owner + '/' + repoInfo.repo
    });
  });
}
function postCancelledRerunSummary(deps, repoInfo, ticket, key, rcMarker, rcHead, rcAny, rcTargets, rcCancelled) {
  var rcCovered = {};
  rcTargets.forEach(function (t) {
    rcCovered[t.context] = true;
  });
  var rcUncovered = rcCancelled.filter(function (c) {
    return !rcCovered[c];
  });
  var rcEvidence = rcAny ? 'the push runs died after the 15m verdict window (gh-755 — live dmtools-agents PRs ' + '#752/#753: kicker sm-liveness + docs-freshness cancelled with no rerun and no verdict; ' + 'owner directive 2026-10-05: a CANCELLED run is not a verdict, re-run it)' : 'a pending run superseded by the silent-refresh push wave ' + '(live fa#1202/#1203 2026-10-03, still reproducing 2026-10-04 06:21 — dmtools-agents#682)';
  if (!deps.dry && !rcUncovered.length) {
    deps.githubTracker(repoInfo).postComment(ticket.prNumber, rcMarker + ': ' + rcTargets.map(function (t) {
      return '`' + t.context + '`';
    }).join(', ') + ' ended CANCELLED on this head — ' + rcEvidence + '. ' + 'CANCELLED is never a verdict: nothing failed, the re-run re-stamps the contexts and merging resumes automatically.' + ' (head `' + rcHead + '`)');
  } else {
    if (rcUncovered.length && !deps.dry) {
      deps.warn('  ⚠️  ' + key + ' rerun set covers ' + (rcCancelled.length - rcUncovered.length) + '/' + rcCancelled.length + ' cancelled contexts — marker deferred, uncovered: ' + rcUncovered.join(', ') + ' (retried next tick)');
    }
  }
  deps.log('  🔁 ' + key + ' cancelled required checks re-run dispatched: ' + rcTargets.map(function (t) {
    return t.context + ' (run ' + t.runId + ')';
  }).join(', '));
}
function executeRerunCancelledTargets(deps, repoInfo, ticket, key, rcHead, rcHeadRuns, rcAny, rcCancelled, processedKeys) {
  var rcMarker = '🔁 Cancelled required checks re-run';
  if (readCommentListWithMarker(deps, repoInfo, ticket.prNumber, rcMarker, rcHead).reported) {
    deps.log('  ⏭️  ' + key + ' cancelled checks already re-run for head — waiting on the rerun');
    return;
  }
  if (deps.hasActiveHeadRun(rcHeadRuns)) {
    deps.log('  ⏭️  ' + key + ' head carries an in-flight run — it re-stamps the contexts, no rerun');
    return;
  }
  var rcTargets = deps.rerunTargetsForCancelledContexts(repoInfo, rcHead, rcCancelled, rcHeadRuns);
  if (!rcTargets.length) {
    deps.warn('  ⚠️  ' + key + ' cancelled contexts ' + rcCancelled.join(', ') + ' have no rerunnable (attempt-1) cancelled run — skip, retry next tick');
    return;
  }
  dispatchCancelledRunReruns(deps, repoInfo, rcTargets);
  postCancelledRerunSummary(deps, repoInfo, ticket, key, rcMarker, rcHead, rcAny, rcTargets, rcCancelled);
  processedKeys.push(key);
}
function executeRerunCancelledChecks(deps, rule, repoInfo, ticket, key, rcHead, processedKeys) {
  var rcAny = rule.anyCancelled === true;
  var rcContexts = parseRuleRequiredContexts(rule);
  if (!rcContexts.length && !rcAny) {
    deps.warn('  ⚠️  ' + key + ' rerun_cancelled_checks: rule carries no requiredContexts and no anyCancelled — skip');
    return;
  }
  var rcHeadRuns = deps.headWorkflowRunsSafe(repoInfo, rcHead);
  var rcCancelled = deps.cancelledRequiredContexts(repoInfo, rcHead, rcAny ? null : rcContexts);
  if (!rcCancelled.length) {
    handleNoCancelledContextsPath(deps, rule, repoInfo, ticket, key, rcHead, rcHeadRuns, rcAny, rcContexts, processedKeys);
    return;
  }
  executeRerunCancelledTargets(deps, repoInfo, ticket, key, rcHead, rcHeadRuns, rcAny, rcCancelled, processedKeys);
}
function handleRerunCancelledChecksAction(deps, rule, repoInfo, ticket, key, processedKeys) {
  try {
    var rcHead = ticket.pr && ticket.pr.headSha || ticket.headSha;
    if (!rcHead) {
      deps.log('  ⏭️  ' + key + ' rerun_cancelled_checks: no head sha — skip');
      return;
    }
    executeRerunCancelledChecks(deps, rule, repoInfo, ticket, key, rcHead, processedKeys);
  } catch (e) {
    deps.error('  ❌ rerun_cancelled_checks failed for ' + key + ': ' + (e.message || e));
  }
}
function parsePrHeadFromObj(cprObj) {
  var head = cprObj && cprObj.head;
  return head && (head.sha || head) || null;
}
function resolveConflictHeadSha(deps, repoInfo, ticket) {
  var headSha = ticket.pr && ticket.pr.headSha || null;
  if (headSha) return headSha;
  try {
    return parsePrHeadFromObj(mcpParse(deps.getPr(repoInfo, ticket.prNumber)));
  } catch (e5) {
    return null;
  }
}
function extractIssueNumberFromBranch(branch) {
  if (!branch) return null;
  var cbm = /(?:^|\/)(?:gh-(\d+)|(\d+)-[a-z0-9._-]+)$/i.exec(String(branch));
  return cbm ? parseInt(cbm[1] || cbm[2], 10) : null;
}
function resolveConflictLinkedIssue(deps, repoInfo, ticket, cIsMachinePr) {
  if (!cIsMachinePr) return { cLinked: null, bodyObj: null };
  var cLinked = null;
  var bodyObj = null;
  try {
    bodyObj = mcpParse(deps.getPr(repoInfo, ticket.prNumber)) || {};
    var cm = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(String(bodyObj.body || ''));
    if (cm) cLinked = parseInt(cm[1], 10);
  } catch (e8) {
    deps.warn('  ⚠️ linked-issue lookup failed: ' + (e8.message || e8));
  }
  return { cLinked: cLinked || extractIssueNumberFromBranch(ticket.branch), bodyObj: bodyObj };
}
function isOpenValidLinkedIssue(liObj) {
  return !!(liObj && typeof liObj.number === 'number' && !liObj.message && String(liObj.state || 'open').toLowerCase() === 'open');
}
function probeLinkedIssueOpenState(deps, repoInfo, cLinked) {
  if (!cLinked) return { open: false, hasRework: false };
  if (!deps.hasGetIssue) return { open: true, hasRework: false };
  try {
    var liObj = mcpParse(deps.getIssue(repoInfo, cLinked));
    var open = isOpenValidLinkedIssue(liObj);
    var hasRework = open && (liObj.labels || []).some(function (l) {
      return l && l.name === 'agent:rework';
    });
    return { open: open, hasRework: hasRework };
  } catch (e9) {
    return { open: false, hasRework: false };
  }
}
function buildConflictReportBody(marker, headSha, cIsMachinePr, cLinked, cLinkedOpen) {
  var headPart = headSha ? ' (head `' + headSha + '`)' : '';
  if (!cIsMachinePr) {
    return marker + ' — the silent branch update could not merge main (conflict).' + headPart + ' Guest PR: rebase onto main and push — validation re-runs automatically;' + ' auto-rework is reserved for the machine account.';
  }
  var cReworkNote = cLinked && cLinkedOpen ? ' Rework re-queued (linked issue #' + cLinked + ' re-armed): resolve the conflicts and push — validation re-runs automatically.' : cLinked ? ' Rework dispatched as a PR-anchored conflict rework leg (linked issue #' + cLinked + ' is not OPEN): resolve the conflicts and push — validation re-runs automatically.' : ' Rework dispatched as a PR-anchored conflict rework leg (no linked issue): resolve the conflicts and push — validation re-runs automatically.';
  return marker + ' — the silent branch update could not merge main (conflict).' + headPart + cReworkNote + ' (approval latch kept — no re-review after the fix)';
}
function armConflictReworkTarget(deps, effectiveConfig, repoInfo, workflowBudget, ticket, key, cIsMachinePr, cLinked, cLinkedOpen) {
  if (!cIsMachinePr) return true;
  if (cLinked && cLinkedOpen) {
    if (!deps.dry) deps.githubTracker(repoInfo).addLabel(cLinked, 'agent:rework');
    return true;
  }
  return deps.dry || !!deps.triggerWorkflow(repoInfo, key, {
    id: 'conflict-rework', workflowFile: 'ai-teammate.yml', workflowRef: '{branch}',
    inputs: {
      issue: '', leg: 'rework',
      reason: 'sm: merge conflict with main, no OPEN linked issue - PR-anchored conflict rework',
      pr: '{prNumber}'
    }
  }, effectiveConfig, workflowBudget, { prNumber: ticket.prNumber, branch: ticket.branch });
}
function handleAlreadyReportedConflict(deps, repoInfo, ticket, key, cIsMachinePr, cLinked, issueState, processedKeys) {
  if (!deps.dry && cIsMachinePr && cLinked && issueState.open && !issueState.hasRework) {
    deps.githubTracker(repoInfo).addLabel(cLinked, 'agent:rework');
    deps.armReworkLatch(ticket);
    deps.log('  🔁 ' + key + ' conflict marker present but issue #' + cLinked + ' has no agent:rework — re-armed (gh-683 self-heal)');
  }
  deps.log('  ⏭️  ' + key + ' conflict already reported for head — waiting on rework');
  processedKeys.push(key);
}
function stripValidatingLabelBestEffort(deps, tr, prNumber) {
  if (!deps.dry) {
    try { tr.removeLabel(prNumber, 'ai_validating'); } catch (e7) {}
  }
}
function executeConflictReworkReportAndArm(deps, effectiveConfig, repoInfo, workflowBudget, ticket, key, marker, headSha, cIsMachinePr, cLinked, cLinkedOpen, processedKeys) {
  var tr = deps.githubTracker(repoInfo);
  stripValidatingLabelBestEffort(deps, tr, ticket.prNumber);
  var cReport = buildConflictReportBody(marker, headSha, cIsMachinePr, cLinked, cLinkedOpen);
  if (!armConflictReworkTarget(deps, effectiveConfig, repoInfo, workflowBudget, ticket, key, cIsMachinePr, cLinked, cLinkedOpen)) {
    deps.log('  ⏳ ' + key + ' conflict rework arming deferred (workflow cap / active run) — marker NOT posted, retrying next tick (gh-683)');
    return;
  }
  if (cIsMachinePr) deps.armReworkLatch(ticket, headSha);
  if (!deps.dry) tr.postComment(ticket.prNumber, cReport);
  var suffix = !cIsMachinePr ? 'guest PR, report only' : cLinked && cLinkedOpen ? 'rework re-queued (issue #' + cLinked + ')' : 'PR-anchored rework dispatched';
  deps.log('  🔁 ' + key + ' merge conflict with main — ' + suffix);
  processedKeys.push(key);
}
function isConflictPrTerminal(cIsMachinePr, linkedRes) {
  return !!(cIsMachinePr && linkedRes.bodyObj && prTerminalStateModule.isTerminalPrState(linkedRes.bodyObj.state, linkedRes.bodyObj.merged));
}
function executeConflictReworkMain(deps, effectiveConfig, repoInfo, workflowBudget, ticket, key, processedKeys) {
  var headSha = resolveConflictHeadSha(deps, repoInfo, ticket);
  var marker = '⚠️ Merge conflict with main';
  var alreadyReported = readCommentListWithMarker(deps, repoInfo, ticket.prNumber, marker, headSha).reported;
  var cMachineAuthor = machineAuthorModule.resolveMachineAuthor(deps.jobParams, effectiveConfig);
  var cIsMachinePr = machineAuthorModule.isMachineAuthored(ticket, cMachineAuthor, repoInfo.owner);
  if (cIsMachinePr && deps.consultReworkLatch(key, ticket, repoInfo).latched) {
    processedKeys.push(key);
    return;
  }
  var linkedRes = resolveConflictLinkedIssue(deps, repoInfo, ticket, cIsMachinePr);
  var issueState = cIsMachinePr ? probeLinkedIssueOpenState(deps, repoInfo, linkedRes.cLinked) : { open: false, hasRework: false };
  if (isConflictPrTerminal(cIsMachinePr, linkedRes)) {
    deps.log('  ⏭️  ' + key + ' PR #' + ticket.prNumber + ' is terminal (merged/closed) — conflict rework never arms on shipped code (gh-1369)');
    processedKeys.push(key);
    return;
  }
  if (alreadyReported) {
    handleAlreadyReportedConflict(deps, repoInfo, ticket, key, cIsMachinePr, linkedRes.cLinked, issueState, processedKeys);
    return;
  }
  executeConflictReworkReportAndArm(deps, effectiveConfig, repoInfo, workflowBudget, ticket, key, marker, headSha, cIsMachinePr, linkedRes.cLinked, issueState.open, processedKeys);
}
function handleConflictReworkAction(deps, effectiveConfig, repoInfo, workflowBudget, ticket, key, processedKeys) {
  try {
    executeConflictReworkMain(deps, effectiveConfig, repoInfo, workflowBudget, ticket, key, processedKeys);
  } catch (e) {
    deps.error('  ❌ conflict_rework failed for ' + key + ': ' + (e.message || e));
  }
}
function postZombieCrashLoopComment(deps, tr, ticket, sHead, sProbe, zMarks, zCap) {
  try {
    var greenNote = sProbe && sProbe.green ? ' An older GREEN dispatched run exists on this head (gh-751/latch-skip semantics) — worth a manual look before re-dispatching or pushing.' : '';
    tr.postComment(ticket.prNumber, '🅿️ Validation parked — zombie crash-loop (' + zMarks.count + '/' + zCap + ' automatic re-dispatches on head `' + sHead + '` died cancelled or never started; the ai_validating arm kept holding' + ' the merge window with no live run behind it — gh-821). No further' + ' automatic re-dispatches: a new push (new head SHA) restarts validation.' + (sHead ? '\nparked-head: ' + sHead : '') + greenNote);
  } catch (eZsay) {
    deps.warn('  ⚠️  zombie park comment failed: ' + (eZsay.message || eZsay));
  }
}
function parkZombieCrashLoop(deps, repoInfo, ticket, key, sHead, sProbe, zMarks, zCap, processedKeys) {
  var tr = deps.githubTracker(repoInfo);
  if (!deps.dry) {
    try {
      tr.removeLabel(ticket.prNumber, 'ai_validating');
    } catch (eZarm) {}
    try {
      tr.addLabel(ticket.prNumber, 'validation_failed');
    } catch (eZpark) {
      deps.warn('  ⚠️  zombie park label failed: ' + (eZpark.message || eZpark));
    }
    postZombieCrashLoopComment(deps, tr, ticket, sHead, sProbe, zMarks, zCap);
  }
  deps.dropOpenPrsCache(repoInfo);
  deps.log('  🅿️  ' + key + ' zombie crash-loop (' + zMarks.count + '/' + zCap + ' re-dispatches dead on head ' + String(sHead).slice(0, 7) + ') — validation_failed park, merge-window slot released');
  processedKeys.push(key);
}
function postZombieRedispatchLabelAndComment(deps, tr, ticket, sHead, sState, zMarks, zCap) {
  if (deps.dry) {
    return;
  }
  try {
    tr.addLabel(ticket.prNumber, 'ai_validating');
  } catch (eZre) {
    deps.warn('  ⚠️  zombie re-arm failed: ' + (eZre.message || eZre));
  }
  try {
    var whyText = sState === 'zombie-cancelled' ? 'The dispatched validation run on this head concluded `cancelled` — no live run existed behind the ai_validating arm (gh-821).' : 'This head carried no dispatched validation run at all — the dispatch was lost (gh-821).';
    tr.postComment(ticket.prNumber, validationLivenessModule.zombieMarkerLine(zMarks.count + 1, sHead, zCap, new Date().toISOString()) + '\n\n' + whyText + ' CI was re-dispatched automatically (bounded: 1 per head per hour; ' + zCap + ' in a row on the same head park the PR validation_failed).');
  } catch (eZmark) {
    deps.warn('  ⚠️  zombie marker comment failed: ' + (eZmark.message || eZmark));
  }
}
function redispatchZombieValidation(deps, repoInfo, ticket, key, sHead, sState, zMarks, zCap, processedKeys) {
  var tr = deps.githubTracker(repoInfo);
  stripValidatingLabelBestEffort(deps, tr, ticket.prNumber);
  deps.dropOpenPrsCache(repoInfo);
  try {
    deps.dispatchCiWorkflow(ticket.branch);
  } catch (eZci) {
    deps.warn('  ⚠️  zombie re-dispatch failed for ' + key + ': ' + (eZci.message || eZci) + ' — re-arming, retry next tick');
    if (!deps.dry) {
      try {
        tr.addLabel(ticket.prNumber, 'ai_validating');
      } catch (eZre2) {}
    }
    return;
  }
  if (sHead) {
    deps.stampValidationChecks(repoInfo, sHead, 'in_progress', null, null);
  }
  postZombieRedispatchLabelAndComment(deps, tr, ticket, sHead, sState, zMarks, zCap);
  deps.dropOpenPrsCache(repoInfo);
  deps.log('  🔄 re-dispatching zombie validation for ' + key + ' (head ' + String(sHead).slice(0, 7) + ', ' + (sState === 'zombie-cancelled' ? 'cancelled dispatch' : 'no run') + ', zombie ' + (zMarks.count + 1) + '/' + zCap + ')');
  processedKeys.push(key);
}
function isZombieWindowCoolingDown(deps, key, zMarks, zWindowMs) {
  if (zWindowMs <= 0 || zMarks.lastAtMs === null || Date.now() - zMarks.lastAtMs >= zWindowMs) {
    return false;
  }
  var zWaitMin = Math.ceil((zWindowMs - (Date.now() - zMarks.lastAtMs)) / 60000);
  deps.log('  ⏭️  ' + key + ' zombie re-dispatch bounded (1/head/hour) — last went out ' + Math.round((Date.now() - zMarks.lastAtMs) / 60000) + ' min ago, next window in ~' + zWaitMin + ' min');
  return true;
}
function handleZombieValidationBranch(deps, repoInfo, ticket, key, sHead, sProbe, sState, processedKeys) {
  var zGraceMs = deps.dispatchRaceGraceMs(deps.jobParams);
  if (zGraceMs > 0 && deps.hasRecentHeadRun(deps.headWorkflowRunsSafe(repoInfo, sHead), zGraceMs)) {
    deps.log('  ⏭️  ' + key + ' sweep: zombie read raced a fresh CI order on the head (gh-748) — arm stays');
    return;
  }
  var zMarks = deps.failMarkerState(repoInfo, ticket.prNumber).zombies[sHead] || {
    count: 0,
    lastAtMs: null
  };
  var zCap = validationLivenessModule.zombieCapOf(deps.jobParams);
  if (zMarks.count >= zCap) {
    parkZombieCrashLoop(deps, repoInfo, ticket, key, sHead, sProbe, zMarks, zCap, processedKeys);
    return;
  }
  if (isZombieWindowCoolingDown(deps, key, zMarks, validationLivenessModule.zombieWindowMsOf(deps.jobParams))) {
    return;
  }
  if (!ticket.branch) {
    deps.warn('  ⚠️  ' + key + ' zombie validation needs a re-dispatch but the ticket carries no head branch — arm stays, retry next tick');
    return;
  }
  redispatchZombieValidation(deps, repoInfo, ticket, key, sHead, sState, zMarks, zCap, processedKeys);
}
function isRunConcludedAndStale(sRun, sStaleMin) {
  if (!sRun || sRun.status !== 'completed' || !sRun.conclusion || sRun.conclusion === 'cancelled') {
    return false;
  }
  var sDone = Date.parse(sRun.updated_at || sRun.created_at || '');
  return !isNaN(sDone) && Date.now() - sDone > sStaleMin * 60 * 1000;
}
function sweepGreenStaleValidation(deps, repoInfo, ticket, key, processedKeys) {
  try {
    var tr = deps.githubTracker(repoInfo);
    tr.removeLabel(ticket.prNumber, 'ai_validating');
    tr.addLabel(ticket.prNumber, 'ai_validated');
    deps.dropOpenPrsCache(repoInfo);
    deps.log('  🧹 ' + key + ' stale arm swept (validation green, verdict never' + ' consumed) — unarmed + ai_validated re-latched');
    processedKeys.push(key);
  } catch (e) {
    deps.error('  ❌ sweep_stale_validation failed for ' + key + ': ' + (e.message || e));
  }
}
function resolveStaleMinutesForRule(rule) {
  return typeof rule.staleMinutes === 'number' && rule.staleMinutes > 0 ? rule.staleMinutes : 15;
}
function probeSweepDispatchedState(deps, rule, repoInfo, sHead) {
  if (!sHead) {
    return null;
  }
  var sCiWf = rule.ciWorkflow || (deps.jobParams || {}).ciWorkflow || 'quality.yml';
  return deps.probeDispatchedState(repoInfo, sCiWf, sHead);
}
function handleSweepStaleValidationAction(deps, rule, repoInfo, ticket, key, processedKeys) {
  var sHead = ticket.pr && ticket.pr.headSha || ticket.headSha;
  var sProbe = probeSweepDispatchedState(deps, rule, repoInfo, sHead);
  var sState = validationLivenessModule.classify(sProbe);
  if (sState === 'zombie-cancelled' || sState === 'zombie-no-run') {
    handleZombieValidationBranch(deps, repoInfo, ticket, key, sHead, sProbe, sState, processedKeys);
    return false;
  }
  var sRun = sProbe ? sProbe.newest : null;
  if (!isRunConcludedAndStale(sRun, resolveStaleMinutesForRule(rule))) {
    deps.log('  ⏭️  ' + key + ' sweep: no concluded-and-stale validation run' + ' on the head — arm stays');
    return false;
  }
  if (sRun.conclusion === 'success') {
    sweepGreenStaleValidation(deps, repoInfo, ticket, key, processedKeys);
    return false;
  }
  deps.log('  🧹 ' + key + ' stale arm swept (validation red, never consumed)' + ' — unarming + standard fail handling');
  return true;
}
function handleFailValidationAction(deps, rule, effectiveConfig, repoInfo, ticket, key, processedKeys) {
  try {
    var fvOutcome = deps.runRedVerdict(rule, ticket, key, repoInfo, effectiveConfig);
    if (fvOutcome === 'skip') {
      return;
    }
    deps.dropOpenPrsCache(repoInfo);
    processedKeys.push(key);
  } catch (e) {
    deps.error('  ❌ fail_validation failed for ' + key + ': ' + (e.message || e));
  }
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      resolveConflictHeadSha: resolveConflictHeadSha,
      resolveConflictLinkedIssue: resolveConflictLinkedIssue,
      probeLinkedIssueOpenState: probeLinkedIssueOpenState,
      handleUnarmValidationAction: handleUnarmValidationAction,
      handleRerunCancelledChecksAction: handleRerunCancelledChecksAction,
      handleConflictReworkAction: handleConflictReworkAction,
      handleSweepStaleValidationAction: handleSweepStaleValidationAction,
      handleFailValidationAction: handleFailValidationAction
    };
}
