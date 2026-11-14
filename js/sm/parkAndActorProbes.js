/**
 * Sticky-park actor/head probes and PR rollup helpers —
 * js/sm/parkAndActorProbes.js (#1459).
 */
'use strict';

var guestValidationPathModule = require('../common/guestValidationPath.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var smProviderModule = require('../common/smProvider.js');
var validationLivenessModule = require('../common/validationLiveness.js');
var validationProbesModule = require('./validationProbes.js');
function buildCommitActorRecord(parsed, headSha) {
  return {
    login: String(parsed.login || ''),
    date: String(parsed.date || ''),
    committer: String(parsed.committer || ''),
    sha: String(parsed.sha || headSha),
    parents: Array.isArray(parsed.parents) ? parsed.parents : []
  };
}
function extractResText(res) {
  if (!res) {
    return '';
  }
  return String(res.output || res.stdout || res).trim();
}
function headCommitActor(deps, repoInfo, headSha) {
  try {
    var res = deps.exec({
      command: 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo + '/commits/' + headSha + '" --jq \'{login: (.author.login // .committer.login // ""), date: (.commit.committer.date // .committer.date // ""), committer: .commit.committer.name, sha: .sha, parents: [.parents[].sha]}\''
    });
    var parsed = validationProbesModule.mcpParse(extractResText(res));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return buildCommitActorRecord(parsed, headSha);
  } catch (e) {
    deps.warn('  ⚠️  head-commit actor probe failed: ' + (e.message || e));
    return null;
  }
}
function isMergeCommitShape(commit) {
  return Array.isArray(commit.parents) && commit.parents.length >= 2;
}
function isMachineMergeCommit(commit, machineAuthor) {
  if (!isMergeCommitShape(commit)) {
    return false;
  }
  if (String(commit.committer || '') === 'sm-silent-update') {
    return true;
  }
  var login = String(commit.login || '').toLowerCase();
  return !!login && machineAuthorModule.isMachineLogin(commit.login, machineAuthor);
}
function parkResetCommit(deps, repoInfo, headSha, machineAuthor) {
  var sha = headSha;
  for (var step = 0; sha && step < 10; step++) {
    var commit = headCommitActor(deps, repoInfo, sha);
    if (!commit) {
      return null;
    }
    if (!isMachineMergeCommit(commit, machineAuthor)) {
      return commit;
    }
    sha = commit.parents[0];
  }
  deps.warn('  ⚠️  park-reset walk: 10 machine merges deep without a ' + 'substantive commit — keeping the park (fail closed)');
  return null;
}
function headShaOfTicket(ticket) {
  return ticket && (ticket.pr && ticket.pr.headSha || ticket.headSha) || null;
}
function armReviewOnlyMachineMerges(deps, repoInfo, ticket, key, machineAuthor) {
  var reviewCid = ticket.lastReviewCommitId || null;
  var armHeadSha = headShaOfTicket(ticket);
  if (!reviewCid || !armHeadSha || reviewCid === armHeadSha) {
    return false;
  }
  var subst = parkResetCommit(deps, repoInfo, armHeadSha, machineAuthor);
  if (!subst || subst.sha !== reviewCid) {
    return false;
  }
  deps.log('  ⏭️  ' + key + ' arm_review skipped (head ' + armHeadSha.slice(0, 8) + ' only adds machine merge(s) over reviewed commit ' + reviewCid.slice(0, 8) + ')');
  return true;
}
function resolveHeadShaViaApi(deps, repoInfo, prNumber, keyLabel) {
  try {
    var pr = validationProbesModule.mcpParse(deps.getPr(repoInfo, prNumber));
    var resolved = pr && pr.head && pr.head.sha || null;
    if (resolved) {
      deps.log('  ℹ️  ' + keyLabel + ': head sha resolved via github_get_pr (' + resolved.slice(0, 8) + ')');
    }
    return resolved;
  } catch (eRhs) {
    deps.warn('  ⚠️  head sha resolve failed for ' + keyLabel + ': ' + eRhs);
    return null;
  }
}
function resolveHeadSha(deps, repoInfo, ticket) {
  var head = headShaOfTicket(ticket);
  if (head || !ticket || !ticket.prNumber) {
    return head;
  }
  return resolveHeadShaViaApi(deps, repoInfo, ticket.prNumber, 'pr-' + ticket.prNumber);
}
function freshHeadSha(deps, repoInfo, prNumber) {
  try {
    var pr = validationProbesModule.mcpParse(deps.getPr(repoInfo, prNumber));
    var sha = pr && pr.head && pr.head.sha || null;
    if (!sha) {
      deps.warn('  ⚠️  post-refresh head read for pr-' + prNumber + ' returned no head sha — stale-cancel skipped this tick');
    }
    return sha;
  } catch (eFresh) {
    deps.warn('  ⚠️  post-refresh head read failed for pr-' + prNumber + ': ' + eFresh + ' — stale-cancel skipped this tick');
    return null;
  }
}
function parkedSince(deps, repoInfo, prNumber) {
  try {
    var res = deps.exec({
      command: 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo + '/issues/' + prNumber + '/events?per_page=100" --jq \'[.[] | select(.event == "labeled" and .label.name == "validation_failed") | .created_at] | max // ""\''
    });
    var out = extractResText(res).replace(/^"|"$/g, '');
    return out || null;
  } catch (e) {
    deps.warn('  ⚠️  park-time probe failed: ' + (e.message || e));
    return null;
  }
}
function extractParkedShaFromBody(body) {
  if (body.indexOf('parked-head: ') === -1) {
    return null;
  }
  var tail = body.slice(body.lastIndexOf('parked-head: ') + 13);
  var m = /^([0-9a-f]{7,40})/i.exec(tail.trim());
  return m ? m[1] : null;
}
function parkedHeadSha(deps, repoInfo, prNumber) {
  try {
    var list = deps.fetchPrCommentList(repoInfo, prNumber);
    var sha = '';
    list.forEach(function (c) {
      var found = extractParkedShaFromBody(String(c && c.body || ''));
      if (found) {
        sha = found;
      }
    });
    return sha;
  } catch (e) {
    deps.warn('  ⚠️  park-head probe failed: ' + (e.message || e));
    return null;
  }
}
function isMachineParkPush(lastCommitter, actorLogin, machineAuthorLogin) {
  return lastCommitter === 'sm-silent-update' || machineAuthorModule.isMachineLogin(actorLogin, machineAuthorLogin);
}
function checkRollupConclusionEquals(deps, repoInfo, prNumber, wanted, warnPrefix) {
  try {
    var provider = smProviderModule.createSmProvider({
      scm: {
        provider: deps.smForge || 'github'
      },
      repository: repoInfo
    });
    var st = provider.prStatus(prNumber);
    return !!st && st.checkConclusion === wanted;
  } catch (e) {
    deps.warn(warnPrefix + (e.message || e));
    return false;
  }
}
function validationRollupGreen(deps, repoInfo, prNumber) {
  return checkRollupConclusionEquals(deps, repoInfo, prNumber, 'green', '  ⚠️  latch-skip rollup probe failed: ');
}
function headChecksRed(deps, repoInfo, prNumber) {
  return checkRollupConclusionEquals(deps, repoInfo, prNumber, 'red', '  ⚠️  red-rollup probe failed: ');
}
function unparkHeadChange994(deps, repoInfo, ticket, key, parkLabelVf, parkedHeadVf, uHead) {
  if (!deps.dry) {
    try {
      deps.githubTracker(repoInfo).removeLabel(ticket.prNumber, parkLabelVf);
    } catch (eUnpark994) {
      deps.warn('  ⚠️  un-park label failed: ' + (eUnpark994.message || eUnpark994));
    }
  }
  deps.dropOpenPrsCache(repoInfo);
  deps.log('  ▶ park-reset: ' + key + ' head ' + parkedHeadVf + '→' + uHead + ' — validation_failed tracked the old head only; the park resets on ANY head change (gh-994)');
  return true;
}
function unparkWithComment(deps, repoInfo, prNumber, parkLabelVf, commentBody) {
  if (deps.dry) return;
  var tr = deps.githubTracker(repoInfo);
  try {
    tr.removeLabel(prNumber, parkLabelVf);
  } catch (eUnpark) {
    deps.warn('  ⚠️  un-park label failed: ' + (eUnpark.message || eUnpark));
  }
  try {
    tr.postComment(prNumber, commentBody);
  } catch (eComment) {
    deps.warn('  ⚠️  un-park comment failed: ' + (eComment.message || eComment));
  }
}
function evaluateMachineUnpark(deps, repoInfo, ticket, uHead, parkedAtVf, probeHeadVerdictVf) {
  if ( deps.validationRollupGreen(repoInfo, ticket.prNumber) ) {
    return { unpark: true, why: 'the current head checks are GREEN' };
  }
  var headActorVf = deps.headCommitActor(repoInfo, uHead);
  var headDate = headActorVf && headActorVf.date ? headActorVf.date : '';
  var headMovedCleanVf = !!(headDate && Date.parse(headDate) > Date.parse(parkedAtVf) && probeHeadVerdictVf() !== 'failure');
  return {
    unpark: headMovedCleanVf,
    why: 'the head moved past the park carrying no red verdict of its own (head `' + uHead.slice(0, 8) + '` @ ' + (headDate || 'unknown') + ' > park ' + parkedAtVf + ')'
  };
}
function evaluateGuestZeroRedSelfClear(deps, repoInfo, isMachinePrU, uHead, probeHeadVerdictVf) {
  if (isMachinePrU || !uHead) return { clear: false, why: '' };
  var gRunsVf = deps.headCheckRunsSafe(repoInfo, uHead);
  if (gRunsVf === null) return { clear: false, why: '' };
  var gTallyVf = guestValidationPathModule.realCheckTally(gRunsVf, smProviderModule.BOOKKEEPING_CHECK_PREFIXES);
  if (!guestValidationPathModule.recoverableZeroRed(gTallyVf) || probeHeadVerdictVf() === 'failure') {
    return { clear: false, why: '' };
  }
  return {
    clear: true,
    why: 'the punished head now carries no red of its own (' + gTallyVf.real + ' real check(s), none red, none cancelled;' + ' bookkeeping stubs ignored — gh-113)'
  };
}
function applyGuestZeroRedClear(deps, repoInfo, ticket, key, parkLabelVf, uHead, isMachinePrU, probeHeadVerdictVf) {
  var guestClear = evaluateGuestZeroRedSelfClear(deps, repoInfo, isMachinePrU, uHead, probeHeadVerdictVf);
  if (!guestClear.clear) {
    deps.log('  🅿️  ' + key + ' ' + parkLabelVf + ' holds — the head predates the park event (no new push since)');
    return false;
  }
  unparkWithComment(deps, repoInfo, ticket.prNumber, parkLabelVf, '🅿️→▶ validation_failed cleared — this GUEST PR\'s park went stale: ' + guestClear.why + '. The red the park punished no longer exists on head `' + uHead + '`. Re-entering the normal lanes — validation re-arms on the current head; a genuinely re-broken head is re-parked one validation cycle later (gh-113: no human label edit needed).');
  deps.dropOpenPrsCache(repoInfo);
  deps.log('  ▶ ' + key + ' ' + parkLabelVf + ' cleared: guest zero-red self-clear — ' + guestClear.why);
  return true;
}
function makeMemoizedVerdictProbe(deps, rule, repoInfo, uHead) {
  var headVerdictVf = null;
  var probed = false;
  return function () {
    if (!probed) {
      probed = true;
      var ciWf = rule.ciWorkflow || (deps.jobParams || {}).ciWorkflow || 'quality.yml';
      headVerdictVf = deps.latestDispatchedVerdict(repoInfo, ciWf, uHead);
    }
    return headVerdictVf;
  };
}
function applyMachineSelfUnparkIfEligible(deps, repoInfo, ticket, key, parkLabelVf, uHead, parkedAtVf, isMachinePrU, probeHeadVerdictVf) {
  if (!isMachinePrU || !uHead) return false;
  var machineRes = evaluateMachineUnpark(deps, repoInfo, ticket, uHead, parkedAtVf, probeHeadVerdictVf);
  if (!machineRes.unpark) return false;
  unparkWithComment(deps, repoInfo, ticket.prNumber, parkLabelVf, '🅿️→▶ validation_failed cleared — this MACHINE-authored PR was parked with no self-clear path (the machine pushes its own heads, so the human-push reset can never fire): ' + machineRes.why + '. The parked red verdict is void for the current head — re-entering validation (owner directive 2026-10-05).');
  deps.log('  ▶ ' + key + ' ' + parkLabelVf + ' cleared: machine-authored PR, ' + machineRes.why + ' — re-validating (the park had no self-clear path, gh-750)');
  return true;
}
function applyHumanOrGuestUnpark(deps, repoInfo, ticket, key, parkLabelVf, uHead, actorVf, parkedAtVf, isMachinePrU, probeHeadVerdictVf) {
  var actorLoginVf = String(actorVf.login || '').toLowerCase();
  var lastCommitter = String(actorVf.committer || '');
  var freshPushVf = !!(actorVf.date && Date.parse(actorVf.date) > Date.parse(parkedAtVf));
  if (!freshPushVf) {
    return applyGuestZeroRedClear(deps, repoInfo, ticket, key, parkLabelVf, uHead, isMachinePrU, probeHeadVerdictVf);
  }
  unparkWithComment(deps, repoInfo, ticket.prNumber, parkLabelVf, '🅿️→▶ validation_failed cleared — the last substantive commit `' + (actorVf.sha || uHead) + '` (head `' + uHead + '`) was pushed by `' + (actorLoginVf || lastCommitter || 'unknown') + '` (human, newer than the park event; machine merges of main walked past) — re-entering validation.');
  deps.log('  ▶ ' + key + ' ' + parkLabelVf + ' cleared: HUMAN push newer than the park — re-entering validation');
  return true;
}
function isMachineHoldOnLegacyPark(deps, key, parkLabelVf, actorVf, prMachineAuthorU) {
  var actorLoginVf = String(actorVf.login || '').toLowerCase();
  var lastCommitter = String(actorVf.committer || '');
  if (!deps.isMachineParkPush(lastCommitter, actorLoginVf, prMachineAuthorU)) {
    return false;
  }
  deps.log('  🅿️  ' + key + ' ' + parkLabelVf + ' holds — the last substantive commit is machine work (' + (lastCommitter === 'sm-silent-update' ? 'sm-silent-update' : actorLoginVf) + '); silent-updates, bot merges of main and agent auto-saves are not new work');
  return true;
}
function handleLegacyParkResetLadder(deps, rule, repoInfo, ticket, key, parkLabelVf, uHead, prMachineAuthorU, isMachinePrU) {
  var actorVf = uHead ? deps.parkResetCommit(repoInfo, uHead, prMachineAuthorU) : null;
  var parkedAtVf = deps.parkedSince(repoInfo, ticket.prNumber);
  if (actorVf === null || parkedAtVf === null) {
    deps.warn('  ⚠️  ' + key + ' ' + parkLabelVf + ': park probe failed (substantive commit / park time) — keeping the park (fail closed)');
    return false;
  }
  var probeHeadVerdictVf = makeMemoizedVerdictProbe(deps, rule, repoInfo, uHead);
  if (applyMachineSelfUnparkIfEligible(deps, repoInfo, ticket, key, parkLabelVf, uHead, parkedAtVf, isMachinePrU, probeHeadVerdictVf)) {
    return true;
  }
  if (isMachineHoldOnLegacyPark(deps, key, parkLabelVf, actorVf, prMachineAuthorU)) {
    return false;
  }
  return applyHumanOrGuestUnpark(deps, repoInfo, ticket, key, parkLabelVf, uHead, actorVf, parkedAtVf, isMachinePrU, probeHeadVerdictVf);
}
function applyGuestParkSideEffects(deps, repoInfo, prNumber, parkLabelVf, uHead) {
  if (deps.dry) return;
  var tr = deps.githubTracker(repoInfo);
  try { tr.addLabel(prNumber, parkLabelVf); } catch (eParkVf) { deps.warn('  ⚠️  park label failed: ' + (eParkVf.message || eParkVf)); }
  try {
    tr.postComment(prNumber, '🛑 validation_failed — the current head `' + uHead + '` has failing checks. This GUEST PR is parked: no validation ' + 'CI is dispatched for it and the merge window skips it until the ' + 'head changes — ANY push that moves the head (yours, the kicker, a ' + 'silent main-merge) clears the park via the head-change reset; a ' + 'genuinely red new head is re-parked one validation cycle later. ' + 'The failure itself is reported separately. parked-head: ' + uHead);
  } catch (eParkVfC) { deps.warn('  ⚠️  park comment failed: ' + (eParkVfC.message || eParkVfC)); }
}
function maybeParkGuestOnRedHead(deps, repoInfo, ticket, key, parkLabelVf, labelsVf, uHead, isMachinePrU, unparkedThisPass) {
  if (unparkedThisPass || isMachinePrU || labelsVf.indexOf(parkLabelVf) !== -1) return false;
  if (!deps.headChecksRed(repoInfo, ticket.prNumber)) return false;
  applyGuestParkSideEffects(deps, repoInfo, ticket.prNumber, parkLabelVf, uHead);
  deps.log('  🅿️  ' + key + ' head checks red on a guest PR — ' + parkLabelVf + ' set, merge window advances');
  return !deps.dry;
}
function extractUniqueStaleShas(staleCancelledUb, nowIso) {
  var seenUb = {};
  var linesUb = [];
  staleCancelledUb.forEach(function (r) {
    var sha = String(r && r.head_sha || '');
    if (sha && !seenUb[sha]) {
      seenUb[sha] = true;
      linesUb.push(validationLivenessModule.staleCancelMarkerLine(sha, nowIso));
    }
  });
  return linesUb;
}
function postStaleCancelSummary(deps, repoInfo, prNumber, staleCancelledUb) {
  if (!staleCancelledUb.length || deps.dry) return;
  try {
    var linesUb = extractUniqueStaleShas(staleCancelledUb, new Date().toISOString());
    deps.githubTracker(repoInfo).postComment(prNumber, linesUb.join('\n') + '\n\n' + 'Cancelled ' + staleCancelledUb.length + ' validation run(s) ' + 'dispatched on a superseded head of this PR — the silent refresh ' + 'moved the base and their results would be discarded anyway ' + '(gh-846). `cancelled` is not a verdict (gh-755): no ' + 'fail-validation, no zombie re-dispatch, no red-head count is ' + 'recorded for these heads — validation re-dispatches only on the ' + 'current head.');
  } catch (eStaleMark) {
    deps.warn('  ⚠️  stale-cancel marker comment failed: ' + (eStaleMark.message || eStaleMark));
  }
}
function cancelStaleAfterRefreshUb(deps, rule, repoInfo, ticket, knownNewHead) {
  var newHeadUb = knownNewHead || deps.freshHeadSha(repoInfo, ticket.prNumber);
  if (!newHeadUb) return;
  var ciWf = rule.ciWorkflow || (deps.jobParams || {}).ciWorkflow || 'quality.yml';
  var ubCancelResult = deps.cancelStaleDispatchedRuns(repoInfo, ciWf, ticket.branch, newHeadUb);
  deps.postGhostGuardAudit(repoInfo, ticket.prNumber, ubCancelResult);
  postStaleCancelSummary(deps, repoInfo, ticket.prNumber, ubCancelResult.cancelled);
}
function executeRefreshHeadSilent(deps, repoInfo, ticket, key, uHead, forkFull) {
  var pushedShaMtt = forkFull ? deps.forkSilentUpdateBranchTracked(ticket.branch, forkFull) : deps.silentUpdateBranchTracked(ticket.branch, false);
  if (deps.dry) return null;
  var newHeadMtt = typeof pushedShaMtt === 'string' && pushedShaMtt ? pushedShaMtt : deps.freshHeadSha(repoInfo, ticket.prNumber);
  if (uHead && deps.headMoved(uHead, newHeadMtt)) {
    deps.tickMovedPrs[ticket.prNumber] = true;
    deps.log('  🔖 ' + key + ' head moved this tick (' + String(uHead || '?').slice(0, 8) + ' → ' + String(newHeadMtt).slice(0, 8) + ') — verdicts deferred (gh-1114)');
  }
  return newHeadMtt;
}
function runGuardedSilentRefresh(deps, rule, repoInfo, ticket, key, uHead, forkFull) {
  var legWorkflowUb = rule.workflowFile || 'ai-teammate.yml';
  if (uHead) {
    var headRunsUb = deps.headWorkflowRunsSafe(repoInfo, uHead);
    if (headRunsUb !== null && deps.hasActiveLegRun(headRunsUb, legWorkflowUb)) {
      deps.log('  ⏭️  ' + key + ' branch refresh deferred — an ai-teammate leg is in flight on the head' + ' (refreshes on the first tick after it finishes)');
      return;
    }
    if (headRunsUb === null) {
      deps.warn('  ⚠️  ' + key + ' head-run probe failed — branch refresh deferred (fail closed, gh-798)');
      return;
    }
  }
  var newHead = executeRefreshHeadSilent(deps, repoInfo, ticket, key, uHead, forkFull);
  deps.log('  ✅ ' + key + ' branch silently updated (no CI)');
  cancelStaleAfterRefreshUb(deps, rule, repoInfo, ticket, newHead);
}
function tryUnparkParkedTicket(deps, rule, repoInfo, ticket, key, parkLabelVf, labelsVf, uHead, prMachineAuthorU, isMachinePrU) {
  if (labelsVf.indexOf(parkLabelVf) === -1) return false;
  var parkedHeadVf = deps.parkedHeadSha(repoInfo, ticket.prNumber);
  if (uHead && parkedHeadVf && uHead !== parkedHeadVf) {
    return unparkHeadChange994(deps, repoInfo, ticket, key, parkLabelVf, parkedHeadVf, uHead);
  }
  return handleLegacyParkResetLadder(deps, rule, repoInfo, ticket, key, parkLabelVf, uHead, prMachineAuthorU, isMachinePrU);
}
function handleUpdateBranchAction(deps, rule, effectiveConfig, repoInfo, ticket, key, processedKeys) {
  if (!ticket.branch) {
    deps.error('  ❌ update_branch: no head branch on ' + key + ' — skipped');
    return;
  }
  try {
    var parkLabelVf = 'validation_failed';
    var labelsVf = ticket.labels || [];
    var uHead = deps.resolveHeadSha(repoInfo, ticket);
    var prMachineAuthorU = machineAuthorModule.resolveMachineAuthor(deps.jobParams, effectiveConfig);
    var isMachinePrU = machineAuthorModule.isMachineAuthored(ticket, prMachineAuthorU, repoInfo.owner);
    var unparkedThisPass = tryUnparkParkedTicket(deps, rule, repoInfo, ticket, key, parkLabelVf, labelsVf, uHead, prMachineAuthorU, isMachinePrU);
    var parkedRedHeadThisPass = maybeParkGuestOnRedHead(deps, repoInfo, ticket, key, parkLabelVf, labelsVf, uHead, isMachinePrU, unparkedThisPass);
    deps.setUpdateBranchPassFlags(unparkedThisPass, parkedRedHeadThisPass);
    var forkGateU = deps.forkSilentUpdateGate();
    if (forkGateU.refresh) {
      runGuardedSilentRefresh(deps, rule, repoInfo, ticket, key, uHead, forkGateU.forkFull);
    }
    processedKeys.push(key);
  } catch (e) {
    deps.error('  ❌ update_branch failed for ' + key + ': ' + (e.message || e));
  }
}
module.exports = {
  headCommitActor: headCommitActor,
  parkResetCommit: parkResetCommit,
  armReviewOnlyMachineMerges: armReviewOnlyMachineMerges,
  resolveHeadSha: resolveHeadSha,
  freshHeadSha: freshHeadSha,
  parkedSince: parkedSince,
  parkedHeadSha: parkedHeadSha,
  isMachineParkPush: isMachineParkPush,
  validationRollupGreen: validationRollupGreen,
  headChecksRed: headChecksRed,
  unparkWithComment: unparkWithComment,
  cancelStaleAfterRefreshUb: cancelStaleAfterRefreshUb,
  handleUpdateBranchAction: handleUpdateBranchAction
};
