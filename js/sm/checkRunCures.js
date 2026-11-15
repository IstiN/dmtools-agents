/**
 * Ghost-guard cancellation, check-run cures, and cancelled-check rerun mapping —
 * js/sm/checkRunCures.js (#1459).
 */
'use strict';

var checkRunStampModule = require('../common/checkRunStamp.js');
var checkRunZombiesModule = require('../common/checkRunZombies.js');
var validationLivenessModule = require('../common/validationLiveness.js');
var workflowRunsModule = require('../common/workflowRuns.js');
var validationProbesModule = require('./validationProbes.js');
var ACTIVE_DISPATCH_STATUSES = ['queued', 'in_progress', 'waiting', 'pending'];
var GHOST_FLAP_MARKER = '🚨 Ghost-cancel flap';
function parseMsParam(val, fallbackMs) {
  var n = typeof val === 'string' ? parseInt(val, 10) : val;
  return typeof n === 'number' && !isNaN(n) && n >= 0 ? Math.floor(n) : fallbackMs;
}
function cancelMaterializeTimeoutMs(jobParams) {
  return parseMsParam((jobParams || {}).cancelMaterializeTimeoutMs, 45 * 1000);
}
function cancelMaterializePollMs(jobParams) {
  return parseMsParam((jobParams || {}).cancelMaterializePollMs, 3 * 1000);
}
function execTextOf(res) {
  return (res || {}).output || (res || {}).stdout || res;
}
function fetchRunMaterializeStatus(deps, repoInfo, runId) {
  try {
    var res = deps.exec({
      command: 'gh api repos/' + repoInfo.owner + '/' + repoInfo.repo + '/actions/runs/' + runId
    });
    var run = validationProbesModule.mcpParse(execTextOf(res));
    return {
      ok: true,
      status: run && run.status ? String(run.status).toLowerCase() : null
    };
  } catch (e) {
    deps.warn('  ⚠️  gh-848 materialization probe failed for run ' + runId + ': ' + e + ' — cancel deferred');
    return {
      ok: false,
      status: null
    };
  }
}
function waitForRunMaterialized(deps, repoInfo, runId, timeoutMs, pollMs) {
  var deadline = Date.now() + timeoutMs;
  while (true) {
    var probe = fetchRunMaterializeStatus(deps, repoInfo, runId);
    if (!probe.ok) {
      return false;
    }
    if (probe.status === null) {
      deps.warn('  ⚠️  gh-848 materialization probe for run ' + runId + ' returned no status — cancel deferred');
      return false;
    }
    if (probe.status !== 'queued') {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    deps.sleep(pollMs);
  }
}
function collectOrphanedCheckRuns(checkRuns, runId) {
  var orphans = [];
  (checkRuns || []).forEach(function (cr) {
    if (!cr || !checkRunZombiesModule.isPendingCheckRun(cr)) {
      return;
    }
    if (checkRunZombiesModule.runIdOf(cr) !== String(runId)) {
      return;
    }
    orphans.push(cr);
  });
  return orphans;
}
function patchOrphanCheckRuns(deps, repoInfo, orphans) {
  var concluded = 0;
  orphans.forEach(function (cr) {
    try {
      deps.exec({
        command: 'gh api -X PATCH repos/' + repoInfo.owner + '/' + repoInfo.repo + '/check-runs/' + cr.id + ' -f status=completed -f conclusion=cancelled'
      });
      concluded++;
    } catch (e2) {
      deps.warn('  ⚠️  gh-848 belt: concluding check-run ' + cr.id + ' failed: ' + (e2.message || e2));
    }
  });
  return concluded;
}
function concludeOrphanedCheckRuns(deps, repoInfo, cancelledRun) {
  if (!cancelledRun || !cancelledRun.head_sha) {
    return 0;
  }
  var checkRuns = validationProbesModule.headCheckRunsSafe(deps, repoInfo, cancelledRun.head_sha);
  var orphans = collectOrphanedCheckRuns(checkRuns, cancelledRun.id);
  if (!orphans.length) {
    return 0;
  }
  deps.log('  🧹 gh-848 belt: ' + orphans.length + ' orphaned check-run(s) of run ' + cancelledRun.id + ' still pending on head ' + String(cancelledRun.head_sha).slice(0, 7) + ' — concluding them cancelled');
  var tok = deps.swapToChecksToken('  ⚠️  gh-848 token swap failed, belt uses the PAT (will 403): ');
  try {
    return patchOrphanCheckRuns(deps, repoInfo, orphans);
  } finally {
    deps.restoreChecksToken(tok.swapped, tok.sourceTok);
  }
}
function isStaleCandidateRun(r, branch, currentSha) {
  return !!(r && r.head_branch === branch && r.head_sha !== currentSha && ACTIVE_DISPATCH_STATUSES.indexOf(r.status) !== -1);
}
function fetchStaleCandidateRuns(deps, repoInfo, ciWorkflow, branch, currentSha) {
  var list = [];
  ['workflow_dispatch', 'push'].forEach(function (ev) {
    var res = deps.exec({
      command: 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo + '/actions/workflows/' + ciWorkflow + '/runs?event=' + ev + '&per_page=50"'
    });
    var runs = validationProbesModule.mcpParse(execTextOf(res));
    list = list.concat(runs && runs.workflow_runs || []);
  });
  return list.filter(function (r) {
    return isStaleCandidateRun(r, branch, currentSha);
  });
}
function cancelSingleStaleRun(deps, repoInfo, branch, matTimeoutMs, matPollMs, result, r) {
  if (matTimeoutMs > 0 && !waitForRunMaterialized(deps, repoInfo, r.id, matTimeoutMs, matPollMs)) {
    result.deferred.push(r);
    deps.log('  ⏸️  gh-848: deferred cancel of stale run ' + r.id + ' on superseded head ' + String(r.head_sha).slice(0, 7) + ' — jobs not materialized yet (retried next tick)');
    return;
  }
  deps.exec({
    command: 'gh api -X POST repos/' + repoInfo.owner + '/' + repoInfo.repo + '/actions/runs/' + r.id + '/cancel || true'
  });
  result.cancelled.push(r);
  deps.log('  🛑 cancelled stale validation run ' + r.id + ' on superseded head ' + String(r.head_sha).slice(0, 7) + ' (' + branch + ')');
  var concluded = concludeOrphanedCheckRuns(deps, repoInfo, r);
  if (concluded > 0 && r.head_sha) {
    result.cleaned.push({
      head_sha: r.head_sha,
      run_id: r.id,
      count: concluded
    });
  }
}
function executeStaleDispatchedCancel(deps, repoInfo, ciWorkflow, branch, currentSha, empty) {
  try {
    var stale = fetchStaleCandidateRuns(deps, repoInfo, ciWorkflow, branch, currentSha);
    var result = {
      cancelled: [],
      deferred: [],
      cleaned: []
    };
    var matTimeoutMs = cancelMaterializeTimeoutMs(deps.jobParams);
    var matPollMs = cancelMaterializePollMs(deps.jobParams);
    stale.forEach(function (r) {
      try {
        cancelSingleStaleRun(deps, repoInfo, branch, matTimeoutMs, matPollMs, result, r);
      } catch (e2) {
        deps.warn('  ⚠️  cancel of stale run ' + r.id + ' failed: ' + (e2.message || e2));
      }
    });
    return result;
  } catch (e) {
    deps.warn('  ⚠️  stale-cancel probe failed: ' + (e.message || e));
    return empty;
  }
}
function cancelStaleDispatchedRuns(deps, repoInfo, ciWorkflow, branch, currentSha) {
  var empty = {
    cancelled: [],
    deferred: [],
    cleaned: []
  };
  if (!branch || !currentSha) {
    return empty;
  }
  if (deps.dry) {
    deps.log('  🧪 [dry] stale-cancel skipped (' + ciWorkflow + ' @ ' + branch + ', head ' + String(currentSha).slice(0, 7) + ')');
    return empty;
  }
  return executeStaleDispatchedCancel(deps, repoInfo, ciWorkflow, branch, currentSha, empty);
}
function addGhostAuditLine(wanted, seen, prefix, sha, kind, line) {
  if (!sha || seen[prefix + sha]) {
    return;
  }
  seen[prefix + sha] = true;
  wanted.push({
    kind: kind,
    sha: sha,
    line: line
  });
}
function collectWantedGhostAuditLines(cancelResult) {
  var wanted = [];
  var seen = {};
  var nowIso = new Date().toISOString();
  (cancelResult.deferred || []).forEach(function (r) {
    var sha = String(r && r.head_sha || '');
    addGhostAuditLine(wanted, seen, 'd:', sha, 'deferred', validationLivenessModule.ghostGuardDeferMarkerLine(sha, r.id, nowIso));
  });
  (cancelResult.cleaned || []).forEach(function (c) {
    var sha = String(c && c.head_sha || '');
    addGhostAuditLine(wanted, seen, 'c:', sha, 'cleaned', validationLivenessModule.ghostGuardCleanMarkerLine(sha, c.count, nowIso));
  });
  return wanted;
}
function readExistingGhostGuardMarks(deps, repoInfo, prNumber) {
  try {
    var list = deps.fetchPrCommentList(repoInfo, prNumber);
    var bodies = list.map(function (c) {
      return String(c && c.body || '');
    });
    return validationLivenessModule.ghostGuardMarks(bodies);
  } catch (e) {
    deps.warn('  ⚠️  ghost-guard marker read failed — posting without dedupe: ' + e);
    return {
      deferred: {},
      cleaned: {}
    };
  }
}
function postGhostGuardAudit(deps, repoInfo, prNumber, cancelResult) {
  if (deps.dry || !prNumber || !cancelResult) {
    return;
  }
  var wanted = collectWantedGhostAuditLines(cancelResult);
  if (!wanted.length) {
    return;
  }
  var marks = readExistingGhostGuardMarks(deps, repoInfo, prNumber);
  var fresh = wanted.filter(function (w) {
    return !marks[w.kind][w.sha];
  });
  if (!fresh.length) {
    return;
  }
  try {
    deps.githubTracker(repoInfo).postComment(prNumber, fresh.map(function (w) {
      return w.line;
    }).join('\n') + '\n\nGhost-guard bookkeeping (gh-848): a stale validation run was left running because its jobs had not materialized yet — a queued cancel orphans its check-runs as `in_progress` ghosts and the merge gate holds on them forever — and/or its orphaned check-runs were concluded `cancelled` via the Checks API. `cancelled` is not a verdict (gh-755): no fail-validation, no zombie re-dispatch is recorded for these heads.');
  } catch (e2) {
    deps.warn('  ⚠️  ghost-guard marker comment failed: ' + e2);
  }
}
function recordFirstRejection(out, err) {
  if (!out.rejected) {
    out.rejected = err && err.message || String(err);
  }
}
function patchCheckRunCompleted(deps, repoInfo, id, conclusion, detailsUrl, title, summary) {
  deps.exec({
    command: 'gh api -X PATCH repos/' + repoInfo.owner + '/' + repoInfo.repo + '/check-runs/' + id + ' -f status=completed -f conclusion=' + conclusion + (detailsUrl ? ' -f details_url=' + checkRunStampModule.shellQuote(detailsUrl) : '') + ' -f ' + checkRunStampModule.shellQuote('output[title]=' + title) + ' -f ' + checkRunStampModule.shellQuote('output[summary]=' + summary)
  });
}
function hasCheckRunId(item) {
  return !!(item && item.id !== null && item.id !== undefined);
}
function sweepSingleZombieCheckRun(deps, repoInfo, headSha, summary, out, z) {
  if (!hasCheckRunId(z)) {
    recordFirstRejection(out, 'check-run id missing (cannot PATCH)');
    return;
  }
  if (deps.dry) {
    deps.log('  🧪 [dry] zombie-swept check-run ' + z.id + ' ("' + z.name + '") completed/neutral on ' + String(headSha).slice(0, 7) + ' (gh-998)');
    out.concluded++;
    return;
  }
  try {
    patchCheckRunCompleted(deps, repoInfo, z.id, 'neutral', null, 'SM swept a zombie check-run (gh-998)', summary);
    out.concluded++;
    deps.log('  ' + checkRunZombiesModule.zombieSweptLine(z.id, headSha));
  } catch (ePatch) {
    recordFirstRejection(out, ePatch);
  }
}
function sweepZombieCheckRunsNeutral(deps, repoInfo, zombies, headSha) {
  var out = {
    concluded: 0,
    rejected: null
  };
  if (!zombies || !zombies.length) {
    return out;
  }
  var summary = 'Zombie-swept by the SM tick (gh-998): the check-run outlived its' + ' validation cycle — the owning workflow run terminated without' + ' concluding it. Closed as neutral: a dead cycle carries no verdict' + ' about its head. The PR re-validates through the normal dispatch path.';
  var tok = deps.swapToChecksToken('  ⚠️  gh-998 token swap failed, sweep uses the PAT (may 403): ');
  try {
    zombies.forEach(function (z) {
      sweepSingleZombieCheckRun(deps, repoInfo, headSha, summary, out, z);
    });
  } finally {
    deps.restoreChecksToken(tok.swapped, tok.sourceTok);
  }
  return out;
}
function greenCoverRun(deps, repoInfo, ciWorkflow, headSha) {
  try {
    var list = workflowRunsModule.dispatchedRuns(repoInfo, ciWorkflow, headSha, deps.exec).filter(function (r) {
      return r.status === 'completed' && r.conclusion === 'success';
    });
    if (!list.length) {
      return null;
    }
    workflowRunsModule.sortRunsNewestFirst(list);
    return list[0];
  } catch (e) {
    deps.warn('  ⚠️  green-cover probe failed: ' + (e.message || e));
    return null;
  }
}
function concludeSinglePlaceholder(deps, repoInfo, coverUrl, coverLine, out, ph) {
  if (!hasCheckRunId(ph)) {
    recordFirstRejection(out, 'check-run id missing (cannot PATCH)');
    return;
  }
  if (deps.dry) {
    deps.log('  🧪 [dry] conclude placeholder check-run ' + ph.id + ' ("' + (ph.name || '?') + '") completed/success (gh-857)');
    return;
  }
  try {
    patchCheckRunCompleted(deps, repoInfo, ph.id, 'success', coverUrl, 'SM concluded a placeholder check-run (gh-857)', coverLine);
    out.concluded++;
  } catch (ePatch) {
    recordFirstRejection(out, ePatch);
  }
}
function concludePlaceholderCheckRuns(deps, repoInfo, placeholders, coverRun) {
  var out = {
    concluded: 0,
    rejected: null
  };
  if (!placeholders || !placeholders.length) {
    return out;
  }
  var coverUrl = coverRun && (coverRun.html_url || coverRun.url) ? String(coverRun.html_url || coverRun.url) : null;
  var coverLine = 'Concluded in place by the SM tick (gh-857) — the head\'s' + ' dispatched validation run concluded success' + (coverUrl ? ': ' + coverUrl : '') + '. The gh-852 fresh-sha reset is the fallback cure.';
  var tok = deps.swapToChecksToken('  ⚠️  gh-857 token swap failed, conclusion uses the PAT (may 403): ');
  try {
    placeholders.forEach(function (ph) {
      concludeSinglePlaceholder(deps, repoInfo, coverUrl, coverLine, out, ph);
    });
  } finally {
    deps.restoreChecksToken(tok.swapped, tok.sourceTok);
  }
  return out;
}
function headKeyedComments(comments, head) {
  var out = [];
  (comments || []).forEach(function (c) {
    var b = String(c && c.body || '');
    if (b.indexOf(String(head)) !== -1) {
      out.push(b);
    }
  });
  return out;
}
function ghostFlapState(comments, head, dispatchMarker) {
  var keyed = headKeyedComments(comments, head);
  var dispatches = keyed.filter(function (b) {
    return b.indexOf(dispatchMarker) !== -1;
  }).length;
  var alarms = keyed.filter(function (b) {
    return b.indexOf(GHOST_FLAP_MARKER) !== -1;
  }).length;
  return {
    dispatches: dispatches,
    alarms: alarms
  };
}
function ghostFlapEscalate(deps, repoInfo, ticket, head, comments, key, dispatchMarker) {
  var st = ghostFlapState(comments, head, dispatchMarker);
  if (st.dispatches < 1) {
    return false;
  }
  var flaps = st.dispatches;
  deps.warn('  ⚠️  ' + key + ' ghost-cancel flap: machine re-dispatch ' + flaps + '× and the head still reads ghost-cancel (merge gate still waiting) — ' + 'a guest PR cannot self-escape (gh-1000 E3)');
  if (st.alarms >= flaps) {
    return false;
  }
  deps.githubTracker(repoInfo).postComment(ticket.prNumber, GHOST_FLAP_MARKER + ' (head `' + head + '`): the machine re-dispatched validation ' + st.dispatches + '× after ghost-cancel and every fresh run was cancelled again — ' + 'the arm is wedged and a guest PR cannot self-escape (gh-1000 E3). Manual action ' + 'required: re-run the workflow or inspect the cancel source (gh-748 kicker race).');
  return true;
}
function cancelledRequiredContexts(deps, repoInfo, headSha, contexts) {
  try {
    var rollup = validationProbesModule.headCheckRunsSafe(deps, repoInfo, headSha);
    if (rollup === null) {
      return [];
    }
    var latest = validationProbesModule.latestCheckRunConclusions(rollup);
    var names = contexts || Object.keys(latest);
    return names.filter(function (c) {
      return !!(latest[c] && latest[c].concl === 'CANCELLED');
    });
  } catch (e) {
    deps.warn('  ⚠️  check-run scan failed: ' + (e.message || e));
    return [];
  }
}
function fetchCancelledRunJobNames(deps, repoInfo, runId) {
  var jobsRaw = deps.exec({
    command: 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo + '/actions/runs/' + runId + '/jobs?per_page=50"'
  });
  var jobs = validationProbesModule.mcpParse(execTextOf(jobsRaw)) || {};
  return (jobs.jobs || []).map(function (j) {
    return j ? j.name || j.step : undefined;
  });
}
function sortedCancelledRuns(allRuns) {
  var runs = (allRuns || []).filter(function (r) {
    return r.status === 'completed' && r.conclusion === 'cancelled';
  });
  runs.sort(function (a, b) {
    return Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0);
  });
  return runs;
}
function fetchAllRunsForCancelledRerun(deps, repoInfo, headSha, runsPrefetched) {
  if (runsPrefetched) {
    return runsPrefetched;
  }
  var res = deps.exec({
    command: 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo + '/actions/runs?head_sha=' + headSha + '&per_page=50"'
  });
  var runs = validationProbesModule.mcpParse(execTextOf(res));
  return runs && runs.workflow_runs || [];
}
function matchRunJobsToPendingContexts(names, runId, pending, targets) {
  return pending.filter(function (ctx) {
    if (names.indexOf(ctx) === -1) {
      return true;
    }
    targets.push({
      context: ctx,
      runId: runId
    });
    return false;
  });
}
function rerunTargetsForCancelledContexts(deps, repoInfo, headSha, contexts, runsPrefetched) {
  try {
    var allRuns = fetchAllRunsForCancelledRerun(deps, repoInfo, headSha, runsPrefetched);
    var runs = sortedCancelledRuns(allRuns);
    var targets = [];
    var pending = contexts.slice();
    for (var i = 0; i < runs.length && pending.length; i++) {
      var run = runs[i];
      if ((run.run_attempt || 1) > 1) {
        continue;
      }
      var names = fetchCancelledRunJobNames(deps, repoInfo, run.id);
      pending = matchRunJobsToPendingContexts(names, run.id, pending, targets);
    }
    return targets;
  } catch (e) {
    deps.warn('  ⚠️  cancelled-run mapping failed: ' + (e.message || e));
    return [];
  }
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      GHOST_FLAP_MARKER: GHOST_FLAP_MARKER,
      cancelMaterializeTimeoutMs: cancelMaterializeTimeoutMs,
      cancelMaterializePollMs: cancelMaterializePollMs,
      waitForRunMaterialized: waitForRunMaterialized,
      concludeOrphanedCheckRuns: concludeOrphanedCheckRuns,
      cancelStaleDispatchedRuns: cancelStaleDispatchedRuns,
      postGhostGuardAudit: postGhostGuardAudit,
      recordFirstRejection: recordFirstRejection,
      sweepZombieCheckRunsNeutral: sweepZombieCheckRunsNeutral,
      greenCoverRun: greenCoverRun,
      concludePlaceholderCheckRuns: concludePlaceholderCheckRuns,
      headKeyedComments: headKeyedComments,
      ghostFlapState: ghostFlapState,
      ghostFlapEscalate: ghostFlapEscalate,
      cancelledRequiredContexts: cancelledRequiredContexts,
      rerunTargetsForCancelledContexts: rerunTargetsForCancelledContexts
    };
}
