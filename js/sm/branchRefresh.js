/**
 * Silent branch update & fork refresh helpers — js/sm/branchRefresh.js (#1459).
 *
 * Encapsulates the silent-update git command builder (gh-1070 / gh-1074 / gh-1101),
 * stderr capture & secret redaction, I5 / AC3 failure trails, gh-1106 workflow-write
 * escalation, and the fork maintainer-edits gate.
 */
'use strict';

var checkRunStampModule = require('../common/checkRunStamp.js');
var smProviderModule = require('../common/smProvider.js');
var validationLivenessModule = require('../common/validationLiveness.js');
var validationProbesModule = require('./validationProbes.js');
var mcpParse = validationProbesModule.mcpParse;
function upToDateClause(forceFresh, pushTarget) {
  var onUpToDate = forceFresh ? ' echo "silent-update: up to date — fresh-sha empty commit"' + ' && git -c user.name=sm-silent-update' + ' -c user.email=sm-silent-update@users.noreply.github.com' + ' commit --allow-empty -m "chore: fresh-sha reset (gh-1101) [sm]"' + ' && git push ' + pushTarget + ' && exit 0; fi' : ' echo "silent-update: already up to date"' + ' && exit 0; fi';
  return ' && if git merge-base --is-ancestor FETCH_HEAD HEAD; then' + onUpToDate;
}
function silentUpdateCommand(repoInfo, opts) {
  return 'gh repo clone ' + repoInfo.owner + '/' + repoInfo.repo + ' ' + opts.dir + ' -- ' + opts.headFlags + ' 2>' + opts.stderrFile + ' && { chmod 600 ' + opts.stderrFile + ' && cd ' + opts.dir + opts.headSetup + ' && git fetch --no-tags --depth 200 origin main' + upToDateClause(opts.forceFresh, opts.pushTarget) + ' && git -c user.name=sm-silent-update' + ' -c user.email=sm-silent-update@users.noreply.github.com' + ' merge --no-edit FETCH_HEAD' + ' && git push ' + opts.pushTarget + '; } 2>>' + opts.stderrFile + ' && rm -f ' + opts.stderrFile;
}
function pushedHeadShaOf(deps, dir) {
  try {
    var out = deps.exec({
      command: 'git -C ' + dir + ' rev-parse HEAD'
    });
    var text = String(out && (out.output || out.stdout) || out || '').trim();
    return /^[0-9a-f]{40}$/i.test(text) ? text : null;
  } catch (eRev) {
    return null;
  }
}
var silentUpdateSeq = 0;
function silentUpdateDirFor(branchName) {
  silentUpdateSeq += 1;
  return '/tmp/sm-silent-update-' + Date.now() + '-' + silentUpdateSeq + '-' + String(branchName).replace(/[^a-zA-Z0-9._-]/g, '_');
}
function silentUpdateStderrFile(branchName) {
  return silentUpdateDirFor(branchName) + '.stderr';
}
function silentUpdateBranch(deps, repoInfo, branchName, stderrFile, forceFresh) {
  var dir = stderrFile ? String(stderrFile).replace(/\.stderr$/, '') : silentUpdateDirFor(branchName);
  deps.exec({
    command: silentUpdateCommand(repoInfo, {
      dir: dir,
      headFlags: '--no-tags --single-branch --branch ' + checkRunStampModule.shellQuote(branchName) + ' --depth 200',
      headSetup: '',
      stderrFile: stderrFile || dir + '.stderr',
      forceFresh: forceFresh === true,
      pushTarget: 'https://x-access-' + 'token:${GH_TOKEN}@github.com/' + repoInfo.owner + '/' + repoInfo.repo + '.git ' + checkRunStampModule.shellQuote(branchName)
    })
  });
  return pushedHeadShaOf(deps, dir);
}
function readSilentUpdateStderrTail(deps, stderrFile) {
  try {
    var raw = deps.fileRead(stderrFile);
    try {
      deps.exec({
        command: 'bash -c "rm -f ' + stderrFile + '"'
      });
    } catch (eRm) {}
    var text = raw == null ? '' : String(raw);
    if (!text) {
      return null;
    }
    var tail = validationLivenessModule.silentUpdateStderrTail(text);
    tail = validationLivenessModule.redactSilentUpdateSecrets(tail);
    return tail || null;
  } catch (eTail) {
    return null;
  }
}
function silentUpdateErrorWithTail(e, tail) {
  var base = e && e.message ? e.message : String(e);
  if (!tail) {
    return e;
  }
  var wrapped = new Error(base + '\n[silent-update stderr tail — last ' + validationLivenessModule.SILENT_UPDATE_STDERR_TAIL_LINES + ' lines, secrets redacted]\n' + tail);
  if (e && e.stack) {
    wrapped.stack = e.stack + '\nCaused by: wrapped with stderr tail (gh-1074)';
  }
  return wrapped;
}
function silentUpdateFailureTrail(deps, repoInfo, prNumber, reason) {
  var tracker = deps.githubTracker(repoInfo);
  var comments = tracker.getComments(prNumber) || [];
  var count = validationLivenessModule.silentUpdateFailureCount(comments);
  var attempt = count.count + 1;
  var iso = new Date().toISOString();
  if (attempt <= validationLivenessModule.SILENT_UPDATE_MAX_FAILURES) {
    tracker.postComment(prNumber, validationLivenessModule.silentUpdateFailureLine(attempt, iso, reason));
  }
  return {
    attempt: attempt,
    left: validationLivenessModule.silentUpdateAttemptsLeft(attempt)
  };
}
function recordSilentUpdateFailure(deps, repoInfo, ticket, key, reason) {
  try {
    var trail = silentUpdateFailureTrail(deps, repoInfo, ticket.prNumber, reason);
    if (trail.left > 0) {
      deps.warn('  ⚠️  ' + key + ' silent-update clone failure #' + trail.attempt + ' recorded on the PR — ' + trail.left + ' attempt(s) left before the degraded flag (I5)' + (reason ? ' — ' + reason : ''));
      return;
    }
    if ((ticket.labels || []).indexOf(validationLivenessModule.SILENT_UPDATE_DEGRADED_LABEL) === -1) {
      deps.githubTracker(repoInfo).addLabel(ticket.prNumber, validationLivenessModule.SILENT_UPDATE_DEGRADED_LABEL);
    }
    deps.error('  ❌ ' + key + ' silent-update DEGRADED after ' + validationLivenessModule.SILENT_UPDATE_MAX_FAILURES + ' consecutive clone failures — PR flagged silent-update-degraded (I5)');
  } catch (eI5) {
    deps.warn('  ⚠️  ' + key + ' I5 failure bookkeeping failed: ' + (eI5.message || eI5));
  }
}
function silentUpdateBranchTracked(deps, repoInfo, ticket, key, branchName, forceFresh) {
  var stderrFile = silentUpdateStderrFile(branchName);
  try {
    return silentUpdateBranch(deps, repoInfo, branchName, stderrFile, forceFresh);
  } catch (eClone) {
    var tail = readSilentUpdateStderrTail(deps, stderrFile);
    recordSilentUpdateFailure(deps, repoInfo, ticket, key, validationLivenessModule.silentUpdateRejectionReason(tail));
    throw silentUpdateErrorWithTail(eClone, tail);
  }
}
function freshShaReset(deps, repoInfo, ticket, key, branchName, oldHead) {
  return deps.freshShaResetOnce(repoInfo, ticket, key, oldHead, function () {
    silentUpdateBranchTracked(deps, repoInfo, ticket, key, branchName, true);
  });
}
function probeForkMaintainerCanModify(deps, repoInfo, ticket, key) {
  var t = ticket.maintainerCanModify;
  if (t === true || t === false) {
    return t;
  }
  try {
    var pr = mcpParse(deps.getPr(repoInfo, ticket.prNumber));
    return smProviderModule.ghPrMaintainerCanModify(pr);
  } catch (eProbe) {
    deps.warn('  ⚠️  ' + key + ' maintainer-edits probe failed: ' + (eProbe.message || eProbe));
    return null;
  }
}
function isParkedRedHeadThisPass(deps) {
  return !!(deps.passState && deps.passState.parkedRedHeadThisPass);
}
function isUnparkedThisPass(deps) {
  return !!(deps.passState && deps.passState.unparkedThisPass);
}
function parkForkGuest(deps, repoInfo, ticket, reason) {
  if (isParkedRedHeadThisPass(deps)) {
    return;
  }
  if ((ticket.labels || []).indexOf('validation_failed') === -1) {
    deps.githubTracker(repoInfo).addLabel(ticket.prNumber, 'validation_failed');
  }
  var head = deps.resolveHeadSha(repoInfo, ticket) || 'unknown';
  deps.githubTracker(repoInfo).postComment(ticket.prNumber, '🛑 validation_failed — fork park (gh-1070): ' + reason + ' Update the branch from main (merge main in, or re-enable ' + '"Allow edits from maintainers") — ANY push that moves the ' + 'head clears this park automatically. parked-head: ' + head);
}
function forkSilentUpdateBranch(deps, repoInfo, prNumber, branchName, forkFull, stderrFile) {
  var dir = stderrFile ? String(stderrFile).replace(/\.stderr$/, '') : silentUpdateDirFor(branchName);
  deps.exec({
    command: silentUpdateCommand(repoInfo, {
      dir: dir,
      headFlags: '--no-tags --depth 200',
      headSetup: ' && git fetch --no-tags --depth 200 origin refs/pull/' + prNumber + '/head' + ' && git checkout -B ' + checkRunStampModule.shellQuote(branchName) + ' FETCH_HEAD',
      stderrFile: stderrFile || dir + '.stderr',
      pushTarget: validationLivenessModule.forkPushTokenUrl(forkFull) + ' HEAD:' + checkRunStampModule.shellQuote(branchName)
    })
  });
  return pushedHeadShaOf(deps, dir);
}
function recordForkSilentUpdateFailure(deps, repoInfo, ticket, key, reason) {
  try {
    var trail = silentUpdateFailureTrail(deps, repoInfo, ticket.prNumber, reason);
    if (trail.left > 0) {
      deps.warn('  ⚠️  ' + key + ' fork silent-update push failure #' + trail.attempt + ' recorded on the PR — ' + trail.left + ' attempt(s) left before the guest park (gh-1070 AC3)' + (reason ? ' — ' + reason : ''));
      return;
    }
    if ((ticket.labels || []).indexOf('validation_failed') === -1) {
      parkForkGuest(deps, repoInfo, ticket, 'the maintainer-edit push kept failing (' + validationLivenessModule.SILENT_UPDATE_MAX_FAILURES + ' consecutive attempts — maintainer edits were likely ' + 'revoked mid-flight, gh-1070 AC3).');
    }
    deps.error('  ❌ ' + key + ' fork silent-update parked guest-style ' + 'after ' + validationLivenessModule.SILENT_UPDATE_MAX_FAILURES + ' consecutive push failures (gh-1070 AC3)');
  } catch (e1070) {
    deps.warn('  ⚠️  ' + key + ' gh-1070 failure bookkeeping failed: ' + (e1070.message || e1070));
  }
}
function parseCommentArray(raw) {
  var obj = typeof raw === 'string' ? JSON.parse(raw) : raw || [];
  return Array.isArray(obj) ? obj : obj.comments || obj.items || [];
}
function isWorkflowWriteParkAlreadyMarked(deps, repoInfo, prNumber, head) {
  try {
    var list = parseCommentArray(deps.getPrComments(repoInfo, prNumber));
    return validationLivenessModule.workflowWriteParkMarked(list.map(function (c) {
      return String(c && c.body || '');
    }), head);
  } catch (eRead) {
    return false;
  }
}
function postWorkflowWriteParkComment(deps, repoInfo, ticket, key, marker) {
  try {
    deps.githubTracker(repoInfo).postComment(ticket.prNumber, '🛑 validation_failed — fork park (gh-1106): the silent-update of main into ' + 'this branch was refused because the token pushing it cannot create or update ' + 'workflow files — a platform capability, not a maintainer decision. The escalated ' + 'push with the workflow-write token (sourceToken) was refused too, so no token ' + 'available to this tick can finish the update. Grant the App "Workflows: write" ' + '(or set sourceToken to a PAT with the `workflow` scope) — the machine lifts this ' + 'park itself on the first successful escalation; ANY head-moving push clears it.\n' + marker);
  } catch (ePost) {
    deps.warn('  ⚠️  ' + key + ' workflow-write park comment failed: ' + (ePost.message || ePost));
  }
}
function addWorkflowWriteParkLabel(deps, repoInfo, ticket, key) {
  if ((ticket.labels || []).indexOf('validation_failed') !== -1) {
    return;
  }
  try {
    deps.githubTracker(repoInfo).addLabel(ticket.prNumber, 'validation_failed');
  } catch (eLabel) {
    deps.warn('  ⚠️  ' + key + ' park label failed: ' + (eLabel.message || eLabel));
  }
}
function parkForkWorkflowWrite(deps, repoInfo, ticket, key) {
  if (isParkedRedHeadThisPass(deps)) {
    return;
  }
  var head = deps.resolveHeadSha(repoInfo, ticket) || 'unknown';
  var marker = validationLivenessModule.workflowWriteParkLine(head, new Date().toISOString());
  if (!isWorkflowWriteParkAlreadyMarked(deps, repoInfo, ticket.prNumber, head)) {
    postWorkflowWriteParkComment(deps, repoInfo, ticket, key, marker);
  }
  addWorkflowWriteParkLabel(deps, repoInfo, ticket, key);
  deps.error('  ❌ ' + key + ' fork silent-update needs a workflow-write token — ' + 'parked with a distinct reason, NOT counted on the gh-1070 trail (gh-1106 AC3)');
}
function runEscalatedForkPush(deps, repoInfo, ticket, key, branchName, forkFull, sourceTok, silentTok) {
  var escStderrFile = silentUpdateStderrFile(branchName);
  var swapped = false;
  try {
    deps.setEnv('GH_TOKEN', sourceTok);
    swapped = true;
  } catch (eSwap) {
    deps.warn('  ⚠️  ' + key + ' escalation token swap failed — ' + 'the push retries with the silent token (will be refused): ' + (eSwap.message || eSwap));
  }
  try {
    try {
      var escSha = forkSilentUpdateBranch(deps, repoInfo, ticket.prNumber, branchName, forkFull, escStderrFile);
      deps.log('  🔐 ' + key + ' workflow-write escalation succeeded — ' + 'fork head moved (gh-1106 AC1); the park reset and validation ' + 're-dispatch ride the standard lanes (AC4)');
      return {
        ok: true,
        sha: escSha || true
      };
    } finally {
      if (swapped) {
        try {
          deps.setEnv('GH_TOKEN', silentTok || sourceTok);
        } catch (eRes) {}
      }
    }
  } catch (eEsc) {
    return {
      ok: false,
      tail: readSilentUpdateStderrTail(deps, escStderrFile)
    };
  }
}
function checkEscalationPreconditions(deps, repoInfo, ticket, key, forkFull) {
  if (deps.dry) {
    deps.log('  🧪 [dry] ' + key + ' workflow-write escalation planned ' + '(push ' + forkFull + ' with sourceToken) — skipped');
    return {
      proceed: false
    };
  }
  var escalations = deps.tickWorkflowEscalations || {};
  if (escalations[ticket.prNumber]) {
    deps.warn('  ⏭️  ' + key + ' workflow-write escalation already ' + 'attempted this tick — deferred to the next tick');
    return {
      proceed: false
    };
  }
  escalations[ticket.prNumber] = true;
  var sourceTok = (deps.jobParams || {}).sourceToken;
  if (!sourceTok) {
    deps.warn('  ⚠️  ' + key + ' no sourceToken on the tick — ' + 'cannot escalate the workflows-permission rejection');
    parkForkWorkflowWrite(deps, repoInfo, ticket, key);
    return {
      proceed: false
    };
  }
  return {
    proceed: true,
    sourceTok: sourceTok
  };
}
function escalateForkSilentUpdate(deps, repoInfo, ticket, key, branchName, forkFull) {
  var pre = checkEscalationPreconditions(deps, repoInfo, ticket, key, forkFull);
  if (!pre.proceed) {
    return false;
  }
  var silentTok = (deps.jobParams || {}).silentToken;
  var res = runEscalatedForkPush(deps, repoInfo, ticket, key, branchName, forkFull, pre.sourceTok, silentTok);
  if (res.ok) {
    return res.sha;
  }
  if (validationLivenessModule.isWorkflowsPermissionRejection(res.tail)) {
    parkForkWorkflowWrite(deps, repoInfo, ticket, key);
    return false;
  }
  recordForkSilentUpdateFailure(deps, repoInfo, ticket, key, validationLivenessModule.silentUpdateRejectionReason(res.tail));
  return false;
}
function forkSilentUpdateBranchTracked(deps, repoInfo, ticket, key, branchName, forkFull) {
  var stderrFile = silentUpdateStderrFile(branchName);
  try {
    return forkSilentUpdateBranch(deps, repoInfo, ticket.prNumber, branchName, forkFull, stderrFile);
  } catch (eFork) {
    var tail = readSilentUpdateStderrTail(deps, stderrFile);
    if (validationLivenessModule.isWorkflowsPermissionRejection(tail)) {
      var escSha = escalateForkSilentUpdate(deps, repoInfo, ticket, key, branchName, forkFull);
      if (escSha) {
        return escSha;
      }
      throw silentUpdateErrorWithTail(eFork, tail);
    }
    recordForkSilentUpdateFailure(deps, repoInfo, ticket, key, validationLivenessModule.silentUpdateRejectionReason(tail));
    throw silentUpdateErrorWithTail(eFork, tail);
  }
}
function parkNonEditableFork(deps, repoInfo, ticket, key) {
  if (isUnparkedThisPass(deps) || deps.dry || (ticket.labels || []).indexOf('validation_failed') !== -1) {
    return;
  }
  try {
    parkForkGuest(deps, repoInfo, ticket, 'this head lives on a fork where maintainer ' + 'edits are NOT available (the author disabled "Allow ' + 'edits from maintainers", or an organization fork) — ' + 'the machine cannot refresh the branch itself, so no ' + 'silent-update is attempted (gh-1070 AC2).');
  } catch (ePark) {
    deps.warn('  ⚠️  ' + key + ' fork park failed: ' + (ePark.message || ePark));
  }
}
function forkSilentUpdateGate(deps, repoInfo, ticket, key) {
  var forkFull = validationLivenessModule.forkHeadFull(ticket.headRepo, repoInfo.owner, repoInfo.repo);
  if (!forkFull) {
    return {
      refresh: true,
      forkFull: null
    };
  }
  var canModify = probeForkMaintainerCanModify(deps, repoInfo, ticket, key);
  if (canModify === null) {
    deps.warn('  ⚠️  ' + key + ' maintainer-edits probe failed — ' + 'fork refresh deferred (fail closed, re-probe next tick; gh-1070)');
    return {
      refresh: false,
      forkFull: forkFull
    };
  }
  if (canModify === true) {
    return {
      refresh: true,
      forkFull: forkFull
    };
  }
  parkNonEditableFork(deps, repoInfo, ticket, key);
  deps.log('  🅿️  ' + key + ' fork head is not maintainer-editable — ' + 'guest park, zero silent-update attempts (gh-1070 AC2)');
  return {
    refresh: false,
    forkFull: forkFull
  };
}
module.exports = {
  upToDateClause: upToDateClause,
  silentUpdateCommand: silentUpdateCommand,
  pushedHeadShaOf: pushedHeadShaOf,
  silentUpdateDirFor: silentUpdateDirFor,
  silentUpdateStderrFile: silentUpdateStderrFile,
  silentUpdateBranch: silentUpdateBranch,
  readSilentUpdateStderrTail: readSilentUpdateStderrTail,
  silentUpdateErrorWithTail: silentUpdateErrorWithTail,
  silentUpdateFailureTrail: silentUpdateFailureTrail,
  recordSilentUpdateFailure: recordSilentUpdateFailure,
  silentUpdateBranchTracked: silentUpdateBranchTracked,
  freshShaReset: freshShaReset,
  probeForkMaintainerCanModify: probeForkMaintainerCanModify,
  parkForkGuest: parkForkGuest,
  forkSilentUpdateBranch: forkSilentUpdateBranch,
  recordForkSilentUpdateFailure: recordForkSilentUpdateFailure,
  parkForkWorkflowWrite: parkForkWorkflowWrite,
  escalateForkSilentUpdate: escalateForkSilentUpdate,
  forkSilentUpdateBranchTracked: forkSilentUpdateBranchTracked,
  parkNonEditableFork: parkNonEditableFork,
  forkSilentUpdateGate: forkSilentUpdateGate
};
