/**
 * Guest transplant executor — js/sm/guestTransplantRunner.js (gh-1140 / #1459).
 */
'use strict';

var guestTransplantModule = require('../common/guestTransplant.js');
function cliText(res) {
  return String(res && (res.output || res.stdout) || res || '');
}
function guestExec(deps, repoInfo, command) {
  return {
    out: cliText(deps.exec({
      command: command
    })).trim()
  };
}
function guestBranchExists(deps, repoInfo, branch) {
  try {
    deps.exec({
      command: 'gh api repos/' + repoInfo.owner + '/' + repoInfo.repo + '/branches/' + branch + ' --jq .name'
    });
    return true;
  } catch (e) {
    return false;
  }
}
function parseCommentsArray(raw) {
  if (!raw) {
    return [];
  }
  var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return parsed.comments || parsed.items || [];
}
function guestMarker(deps, repoInfo, prNumber, machineLogins) {
  try {
    var list = parseCommentsArray(deps.getPrComments(repoInfo, prNumber));
    return guestTransplantModule.parseTransplantMarker(list, machineLogins);
  } catch (e) {
    deps.warn('  ⚠️  transplant marker probe failed (fail closed): ' + (e.message || e));
    return null;
  }
}
function guestArmEvent(deps, repoInfo, prNumber, label) {
  try {
    var res = deps.exec({
      command: guestTransplantModule.buildListLabelEventsCommand(repoInfo.owner, repoInfo.repo, prNumber)
    });
    return guestTransplantModule.parseLabelEvents(cliText(res), label);
  } catch (e) {
    deps.warn('  ⚠️  arm-event probe failed (fail closed): ' + (e.message || e));
    return null;
  }
}
function guestOpenPrOnBranch(deps, repoInfo, branch) {
  try {
    var list = parseCommentsArray(deps.listOpenPrs(repoInfo));
    var hit = list.filter(function (p) {
      return p.head && p.head.ref === branch;
    })[0];
    return hit ? { number: hit.number } : null;
  } catch (e) {
    return null;
  }
}
function tryDiffTool(fn, repoInfo, prNumber) {
  if (typeof fn !== 'function') {
    return null;
  }
  try {
    return guestTransplantModule.extractPrDiffText(fn(repoInfo, prNumber)) || null;
  } catch (e) {
    return null;
  }
}
function guestPrDiffText(deps, repoInfo, prNumber) {
  return tryDiffTool(deps.getPrDiffText, repoInfo, prNumber) || tryDiffTool(deps.getPrDiff, repoInfo, prNumber);
}
function applyCreateRefStep(deps, repoInfo, s, dry) {
  if (dry) {
    deps.log('  🧪 [dry] would create branch ' + s.branch + ' at ' + s.atBranch);
    return {};
  }
  var main = guestExec(deps, repoInfo, guestTransplantModule.buildMainHeadCommand(repoInfo.owner, repoInfo.repo, s.atBranch)).out;
  if (!/^[0-9a-f]{40}$/.test(main)) {
    throw new Error('base head probe failed for ' + s.atBranch + ' — no branch cut');
  }
  guestExec(deps, repoInfo, guestTransplantModule.buildCreateRefCommand(repoInfo.owner, repoInfo.repo, s.branch, main));
  deps.log('  🌿 branch ' + s.branch + ' cut at ' + s.atBranch + ' (' + main.substring(0, 8) + ')');
  return {};
}
function parseJsonOutSafe(out) {
  try {
    return JSON.parse(out) || {};
  } catch (e) {
    return {};
  }
}
function runApiMergeCommand(deps, repoInfo, branch, headSha) {
  try {
    return guestExec(deps, repoInfo, guestTransplantModule.buildApiMergeCommand(repoInfo.owner, repoInfo.repo, branch, headSha));
  } catch (eMerge) {
    if (guestTransplantModule.isMergeConflictError(eMerge)) {
      eMerge.isMergeConflict = true;
    }
    throw eMerge;
  }
}
function applyMergeStep(deps, repoInfo, s, dry) {
  if (dry) {
    deps.log('  🧪 [dry] would API-merge ' + s.headSha + ' → ' + s.branch);
    return {
      mergedSha: s.headSha
    };
  }
  var res = runApiMergeCommand(deps, repoInfo, s.branch, s.headSha);
  var mergedSha = parseJsonOutSafe(res.out).sha || '';
  deps.log('  🧬 merged ' + String(s.headSha).substring(0, 8) + ' into ' + s.branch + (mergedSha ? ' at ' + String(mergedSha).substring(0, 8) : ''));
  return {
    mergedSha: mergedSha || s.headSha
  };
}
function applyOpenPrStep(deps, repoInfo, s, dry) {
  if (dry) {
    deps.log('  🧪 [dry] would open PR "' + s.title + '" (' + s.branch + ' → ' + s.baseBranch + ')');
    return {
      newPrNumber: null
    };
  }
  var payloadPath = 'gt_pr_payload_tmp_' + Number(Date.now()) + '-' + String(s.branch).replace(/[^0-9a-zA-Z-]/g, '') + '.json';
  try {
    deps.fileWrite({
      path: payloadPath,
      content: guestTransplantModule.buildGuestPrPayload({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        branch: s.branch,
        baseBranch: s.baseBranch,
        title: s.title,
        body: s.body
      })
    });
    var res2 = guestExec(deps, repoInfo, guestTransplantModule.buildCreateGuestPrCommand(repoInfo.owner, repoInfo.repo, payloadPath));
    var pj = parseJsonOutSafe(res2.out);
    var prNum = pj.number || pj.data && pj.data.number || null;
    deps.log('  📬 machine PR opened: #' + (prNum || '?') + ' "' + s.title + '"');
    return {
      newPrNumber: prNum
    };
  } finally {
    try {
      deps.fileDelete({
        path: payloadPath
      });
    } catch (eDel) {/* best-effort cleanup */}
  }
}
function applyCarryDecisionStep(deps, repoInfo, cfg, ctx, dry, tr) {
  var sourceDiff = guestPrDiffText(deps, repoInfo, ctx.sourcePrNumber);
  var newDiff = ctx.newPrNumber ? guestPrDiffText(deps, repoInfo, ctx.newPrNumber) : null;
  var decision = guestTransplantModule.carryDecision(sourceDiff, newDiff, cfg, ctx.sourceLabels);
  if (decision.carry && !dry) {
    for (var li = 0; li < decision.labels.length; li++) {
      tr.addLabel(ctx.newPrNumber, decision.labels[li]);
    }
  }
  deps.log('  ⚖️ verdict carry: ' + decision.reason + (decision.carry ? ' → [' + decision.labels.join(', ') + ']' : ' → fresh pipeline'));
  return {
    carriedLabels: decision.carry ? decision.labels : []
  };
}
function applyTransplantCommentStep(deps, s, ctx, dry, tr) {
  if (dry) {
    deps.log('  🧪 [dry] would post the transplant comment on #' + s.prNumber);
    return {};
  }
  tr.postComment(s.prNumber, guestTransplantModule.buildTransplantComment({
    sourcePrNumber: s.prNumber,
    sourceSha: ctx.usedSha,
    mergedSha: ctx.mergedSha || ctx.usedSha,
    transplantPrNumber: ctx.newPrNumber || 0,
    carriedLabels: ctx.carriedLabels || []
  }));
  return {};
}
function buildTransplantedMarkerPayload(s, ctx) {
  return {
    state: 'transplanted',
    source: s.prNumber,
    head: ctx.usedSha || s.head || null,
    branch: s.branch,
    transplant: ctx.newPrNumber || null,
    merged: ctx.mergedSha || ctx.usedSha || null,
    actor: ctx.actorLogin || null
  };
}
function applyTransplantedMarkerStep(deps, s, ctx, dry, tr) {
  if (dry) {
    deps.log('  🧪 [dry] would post the transplanted marker on #' + s.prNumber);
    return {};
  }
  tr.postComment(s.prNumber, guestTransplantModule.transplantMarkerComment(buildTransplantedMarkerPayload(s, ctx)));
  deps.log('  🧬 transplanted marker posted on #' + s.prNumber);
  return {};
}
function applyCommentOrLabelStep(deps, s, dry, tr) {
  if (s.op === 'comment') {
    if (dry) deps.log('  🧪 [dry] would comment on #' + s.prNumber);
    else tr.postComment(s.prNumber, s.text);
    return {};
  }
  if (s.op === 'add_label') {
    if (dry) deps.log('  🧪 [dry] would label #' + s.prNumber + ' +' + s.label);
    else tr.addLabel(s.prNumber, s.label);
    return {};
  }
  return null;
}
function applySimpleTrackerStep(deps, repoInfo, s, dry, tr) {
  var res = applyCommentOrLabelStep(deps, s, dry, tr);
  if (res !== null) return res;
  if (s.op === 'remove_label') {
    if (dry) deps.log('  🧪 [dry] would unlabel #' + s.prNumber + ' -' + s.label);
    else tr.removeLabel(s.prNumber, s.label);
    return {};
  }
  return null;
}
function applyRefOrCloseStep(deps, repoInfo, s, dry) {
  if (s.op === 'close_pr') {
    if (dry) deps.log('  🧪 [dry] would close source PR #' + s.prNumber);
    else {
      guestExec(deps, repoInfo, guestTransplantModule.buildClosePrCommand(repoInfo.owner, repoInfo.repo, s.prNumber));
      deps.log('  🔒 source PR #' + s.prNumber + ' closed (transplanted)');
    }
    return {};
  }
  if (s.op === 'delete_ref') {
    if (dry) deps.log('  🧪 [dry] would delete branch ' + s.branch);
    else {
      guestExec(deps, repoInfo, guestTransplantModule.buildDeleteRefCommand(repoInfo.owner, repoInfo.repo, s.branch));
      deps.log('  🪦 branch ' + s.branch + ' deleted (GC)');
    }
    return {};
  }
  return null;
}
function applyCreateOrMergeStep(deps, repoInfo, s, dry) {
  if (s.op === 'create_ref') {
    return applyCreateRefStep(deps, repoInfo, s, dry);
  }
  if (s.op === 'merge') {
    return applyMergeStep(deps, repoInfo, s, dry);
  }
  if (s.op === 'open_pr') {
    return applyOpenPrStep(deps, repoInfo, s, dry);
  }
  return null;
}
function applyCarryOrMarkerStep(deps, repoInfo, cfg, s, ctx, dry, tr) {
  if (s.op === 'carry_decision') {
    return applyCarryDecisionStep(deps, repoInfo, cfg, ctx, dry, tr);
  }
  if (s.op === 'transplant_comment') {
    return applyTransplantCommentStep(deps, s, ctx, dry, tr);
  }
  if (s.op === 'transplanted_marker') {
    return applyTransplantedMarkerStep(deps, s, ctx, dry, tr);
  }
  return null;
}
function guestApplyStep(deps, repoInfo, cfg, s, ctx, dry) {
  var tr = deps.githubTracker(repoInfo);
  var res = applySimpleTrackerStep(deps, repoInfo, s, dry, tr) || applyRefOrCloseStep(deps, repoInfo, s, dry) || applyCreateOrMergeStep(deps, repoInfo, s, dry) || applyCarryOrMarkerStep(deps, repoInfo, cfg, s, ctx, dry, tr);
  if (res !== null) {
    return res;
  }
  deps.warn('  ⚠️  unknown transplant step: ' + s.op);
  return {};
}
function guestRunSteps(deps, repoInfo, cfg, steps, startCtx, dry) {
  var ctx = startCtx;
  for (var i = 0; i < steps.length; i++) {
    var out = guestApplyStep(deps, repoInfo, cfg, steps[i], ctx, dry);
    if (out) {
      if (out.newPrNumber !== undefined) {
        ctx.newPrNumber = out.newPrNumber;
      }
      if (out.mergedSha !== undefined) {
        ctx.mergedSha = out.mergedSha;
      }
      if (out.carriedLabels !== undefined) {
        ctx.carriedLabels = out.carriedLabels;
      }
    }
  }
  return ctx;
}
function resolveUsedShaForTransplant(seq, marker, headSha) {
  var seqSha = guestTransplantModule.sequenceHeadSha(seq);
  if (seqSha) {
    return seqSha;
  }
  var shaInfo = guestTransplantModule.resolveTransplantSha(marker, headSha);
  return shaInfo ? shaInfo.sha : null;
}
function executeLiveTransplantSteps(deps, repoInfo, cfg, seq, marker, headSha, ctx) {
  try {
    ctx.usedSha = resolveUsedShaForTransplant(seq, marker, headSha);
    guestRunSteps(deps, repoInfo, cfg, seq.steps, ctx, false);
    return true;
  } catch (eRun) {
    if (!eRun || eRun.isMergeConflict !== true) {
      throw eRun;
    }
    deps.log('  ⚠️  transplant merge conflict — parking the source (AC4)');
    guestRunSteps(deps, repoInfo, cfg, guestTransplantModule.parkSteps('conflict', {
      cfg: cfg,
      source: {
        prNumber: ctx.sourcePrNumber
      },
      headSha: ctx.usedSha,
      actorLogin: ctx.actorLogin
    }), ctx, false);
    return false;
  }
}
function buildTransplantSourceInput(prNumber, ticket) {
  return {
    prNumber: prNumber,
    title: ticket.title || '',
    author: ticket.author || '',
    labels: ticket.labels || [],
    headRepo: ticket.headRepo || null,
    draft: !!ticket.draft,
    state: ticket.pr && ticket.pr.state || 'OPEN'
  };
}
function firstMachineLogin(machineLogins) {
  return Array.isArray(machineLogins) && machineLogins.length ? machineLogins[0] : null;
}
function transplantGuestPrAction(deps, repoInfo, ticket, cfg, machineLogins) {
  var prNumber = ticket.prNumber;
  var branch = guestTransplantModule.transplantBranchName(cfg.branchPrefix, prNumber);
  var marker = guestMarker(deps, repoInfo, prNumber, machineLogins);
  var headSha = deps.resolveHeadSha(repoInfo, ticket);
  var actorLogin = firstMachineLogin(machineLogins);
  var seq = guestTransplantModule.transplantSequence({
    cfg: cfg,
    base: {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      baseBranch: cfg.baseBranch
    },
    source: buildTransplantSourceInput(prNumber, ticket),
    headSha: headSha,
    armEvent: guestArmEvent(deps, repoInfo, prNumber, cfg.label),
    machineLogins: machineLogins,
    actorLogin: actorLogin,
    marker: marker,
    branchExists: guestBranchExists(deps, repoInfo, branch),
    openTransplantPr: guestOpenPrOnBranch(deps, repoInfo, branch),
    completionRentry: ticket.completionRentry === true
  });
  deps.log('  🧬 ' + seq.audit);
  if (!seq.steps || !seq.steps.length) {
    return false;
  }
  var ctx = {
    sourcePrNumber: prNumber,
    sourceLabels: ticket.labels || [],
    usedSha: null,
    newPrNumber: seq.resumePrNumber || null,
    actorLogin: actorLogin
  };
  if (deps.dry === true) {
    guestRunSteps(deps, repoInfo, cfg, seq.steps, ctx, true);
    return true;
  }
  return executeLiveTransplantSteps(deps, repoInfo, cfg, seq, marker, headSha, ctx);
}
function probeBranchPrState(deps, repoInfo, branch) {
  try {
    var raw = deps.exec({
      command: guestTransplantModule.buildFindPrByHeadCommand(repoInfo.owner, repoInfo.repo, branch)
    });
    var list = JSON.parse(cliText(raw));
    return guestTransplantModule.prStateFromFindList(list);
  } catch (ePr) {
    return null;
  }
}
function guestSweepEntry(deps, repoInfo, cfg, branch, machineLogins) {
  var prState = probeBranchPrState(deps, repoInfo, branch);
  var marker = prState ? null : guestMarker(deps, repoInfo, guestTransplantModule.parseGuestBranch(branch, cfg.branchPrefix), machineLogins);
  return {
    branch: branch,
    prState: prState,
    marker: marker
  };
}
function guestPrLabels(deps, repoInfo, prNumber) {
  try {
    var out = guestExec(deps, repoInfo, guestTransplantModule.buildPrLabelsCommand(repoInfo.owner, repoInfo.repo, prNumber)).out;
    return String(out).split(',').map(function (s) {
      return s.trim();
    }).filter(Boolean);
  } catch (eL) {
    return null;
  }
}
function executeGcDeleteStep(deps, repoInfo, s) {
  if (deps.dry) {
    deps.log('  🧪 [dry] GC would delete ' + s.branch);
    return;
  }
  guestExec(deps, repoInfo, guestTransplantModule.buildDeleteRefCommand(repoInfo.owner, repoInfo.repo, s.branch));
  deps.log('  🪦 guest branch GC: ' + s.branch);
}
function findSweepEntryMarker(sweep, branch) {
  var entry = sweep.filter(function (e) {
    return e.branch === branch;
  })[0];
  return entry ? entry.marker : null;
}
function executeGcOrphanStep(deps, repoInfo, cfg, machineLogins, sweep, s) {
  var holdLabels = guestPrLabels(deps, repoInfo, s.sourcePrNumber);
  var entryMarker = findSweepEntryMarker(sweep, s.branch);
  if (guestTransplantModule.completionHold(holdLabels, cfg.parkedLabel, entryMarker)) {
    deps.log('  ⏸️ orphan completion held on ' + s.branch + ' — the source carries a human hold (fa#939)');
    return;
  }
  deps.log('  🧩 completing orphan transplant on ' + s.branch + ' (E5)');
  transplantGuestPrAction(deps, repoInfo, {
    prNumber: s.sourcePrNumber,
    title: '',
    author: '',
    labels: [cfg.label],
    headRepo: null,
    draft: false,
    state: 'OPEN',
    completionRentry: true
  }, cfg, machineLogins);
}
function collectActionableSweepEntries(deps, repoInfo, cfg, machineLogins, names) {
  var cap = guestTransplantModule.gcActionableCap(cfg.maxGcBranches);
  var bounded = names.slice(0, guestTransplantModule.gcScanBudget(cfg.maxGcBranches));
  var sweep = [];
  bounded.forEach(function (name) {
    if (sweep.length < cap) {
      var entry = guestSweepEntry(deps, repoInfo, cfg, name, machineLogins);
      if (guestTransplantModule.gcSteps([entry]).length) sweep.push(entry);
    }
  });
  return sweep;
}
function sweepClosedGuestBranches(deps, repoInfo, cfg, machineLogins) {
  var res = deps.exec({
    command: guestTransplantModule.buildListBranchesCommand(repoInfo.owner, repoInfo.repo)
  });
  var names = cliText(res).split('\n').map(function (n) {
    return n.trim();
  }).filter(function (n) {
    return n.indexOf(cfg.branchPrefix) === 0;
  });
  var sweep = collectActionableSweepEntries(deps, repoInfo, cfg, machineLogins, names);
  var steps = guestTransplantModule.gcSteps(sweep);
  steps.forEach(function (s) {
    if (s.op === 'delete_ref') {
      executeGcDeleteStep(deps, repoInfo, s);
      return;
    }
    executeGcOrphanStep(deps, repoInfo, cfg, machineLogins, sweep, s);
  });
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      guestExec: guestExec,
      guestBranchExists: guestBranchExists,
      guestMarker: guestMarker,
      guestArmEvent: guestArmEvent,
      guestOpenPrOnBranch: guestOpenPrOnBranch,
      guestPrDiffText: guestPrDiffText,
      guestApplyStep: guestApplyStep,
      guestRunSteps: guestRunSteps,
      transplantGuestPrAction: transplantGuestPrAction,
      guestSweepEntry: guestSweepEntry,
      guestPrLabels: guestPrLabels,
      sweepClosedGuestBranches: sweepClosedGuestBranches
    };
}
