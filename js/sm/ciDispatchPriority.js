/**
 * CI dispatch priority for the validate_pr lane — js/sm/ciDispatchPriority.js.
 *
 * Live incident (IstiN/flutter_agent_harness #2435): 3 runners, 17 queued
 * workflow_dispatch CI runs; the approved PR's pre-merge validation was
 * dispatched 5x and starved behind pre-approval runs and duplicates.
 *
 *  1. one run per (branch, head sha) before approval: never re-dispatch
 *     while a run on the sha is in flight, nor on a sha that already
 *     concluded (cancelled runs are NOT verdicts — they re-dispatch);
 *     duplicate in-flight runs on one branch+sha keep only the newest.
 *  2. approved-first: while an approved PR's validation is queued (not yet
 *     started) or armed this tick, QUEUED pre-approval runs are cancelled
 *     (their ai_validating stripped so validate-fresh re-dispatches the
 *     same sha later) and rules with deferWhileApprovedPending defer.
 *     After a merge, other approved PRs' in-flight validations are stale:
 *     cancelled + unarmed so they re-arm one at a time.
 *  3. dead branches: in-flight workflow_dispatch CI runs whose branch has
 *     no open PR are cancelled. push runs (v* tags) are never touched.
 *
 * One CI-run listing per repo per tick (memo reset by resetTick and on
 * every dispatch). Every probe fails open (⚠️ + legacy behavior).
 */
'use strict';

var triggerFailuresModule = require('../common/triggerFailures.js');

var ACTIVE = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
var QUEUED = ['queued', 'waiting', 'pending', 'requested'];
var PROTECTED_BRANCHES = ['main', 'master', 'develop'];
var _runsMemo = {};
var _sweepMemo = {};
var _armedApproved = {};

function resetTick() {
  _runsMemo = {};
  _sweepMemo = {};
  _armedApproved = {};
}
function repoKey(repoInfo) {
  return repoInfo.owner + '/' + repoInfo.repo;
}
function ciWorkflowOf(rule, jobParams) {
  return rule && rule.ciWorkflow || (jobParams || {}).ciWorkflow || 'quality.yml';
}
function textOf(res) {
  return res && typeof res === 'object' ? res.output || res.stdout || res : res;
}
function parseJson(res) {
  var text = textOf(res);
  if (typeof text !== 'string') {
    return text || null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}
function labelNames(pr) {
  return (pr && pr.labels || []).map(function (l) {
    return l && l.name || l;
  });
}
function hasLabel(pr, name) {
  return labelNames(pr).indexOf(name) !== -1;
}
function branchOfPr(pr) {
  return pr && pr.head && pr.head.ref || pr && pr.branch || '';
}
function isDispatch(r) {
  return !!r && r.event === 'workflow_dispatch';
}
function isActive(r) {
  return !!r && ACTIVE.indexOf(r.status) !== -1;
}
function isQueued(r) {
  return !!r && QUEUED.indexOf(r.status) !== -1;
}
function runAge(r) {
  return Date.parse(r.created_at || r.run_started_at || 0) || Number(r.id) || 0;
}

// IO: the ONE in-flight listing per repo+workflow per tick.
function inFlightCiRuns(deps, repoInfo, ciWorkflow) {
  var k = repoKey(repoInfo) + ':' + ciWorkflow;
  if (_runsMemo[k]) {
    return _runsMemo[k];
  }
  var parsed = parseJson(deps.listWorkflowRuns(repoInfo, ciWorkflow));
  if (!parsed || !Array.isArray(parsed.workflow_runs)) {
    throw new Error('unreadable workflow runs listing for ' + ciWorkflow);
  }
  _runsMemo[k] = parsed.workflow_runs.filter(isActive);
  return _runsMemo[k];
}
function dropRunsMemo(repoInfo) {
  var prefix = repoKey(repoInfo) + ':';
  Object.keys(_runsMemo).forEach(function (k) {
    if (k.indexOf(prefix) === 0) {
      delete _runsMemo[k];
    }
  });
  delete _sweepMemo[repoKey(repoInfo)];
}

function openPrs(deps, repoInfo) {
  var parsed = parseJson(deps.listOpenPrs(repoInfo));
  var list = Array.isArray(parsed) ? parsed : parsed && parsed.data;
  if (!Array.isArray(list)) {
    throw new Error('unreadable open-PR list');
  }
  return list;
}
// Pure: in-flight dispatch runs on one branch+sha.
function runsOnHead(runs, branch, sha) {
  return (runs || []).filter(function (r) {
    return isDispatch(r) && r.head_branch === branch && r.head_sha === sha;
  });
}
// Pure: every in-flight dispatch run except the newest per branch+sha.
function dedupeSameHead(runs) {
  var groups = {};
  (runs || []).filter(isDispatch).forEach(function (r) {
    var g = r.head_branch + '@' + r.head_sha;
    (groups[g] = groups[g] || []).push(r);
  });
  var out = [];
  Object.keys(groups).forEach(function (g) {
    var sorted = groups[g].slice().sort(function (a, b) {
      return runAge(b) - runAge(a);
    });
    out = out.concat(sorted.slice(1));
  });
  return out;
}
function indexPrsByBranch(prs) {
  var idx = {};
  (prs || []).forEach(function (p) {
    var b = branchOfPr(p);
    if (b) {
      idx[b] = p;
    }
  });
  return idx;
}
// Pure: dispatch runs whose branch has no open PR (never protected branches).
function deadBranchRuns(runs, prIdx) {
  return (runs || []).filter(function (r) {
    return isDispatch(r) && !prIdx[r.head_branch] && PROTECTED_BRANCHES.indexOf(r.head_branch) === -1;
  });
}
// Pure: an approved PR whose validation run is queued but not started.
function approvedPendingExists(runs, prIdx) {
  return (runs || []).some(function (r) {
    return isDispatch(r) && isQueued(r) && hasLabel(prIdx[r.head_branch], 'pr_approved');
  });
}
// Pure: queued (not started) dispatch runs of open PRs WITHOUT pr_approved.
function queuedUnapprovedRuns(runs, prIdx) {
  return (runs || []).filter(function (r) {
    var pr = prIdx[r.head_branch];
    return isDispatch(r) && isQueued(r) && !!pr && !hasLabel(pr, 'pr_approved');
  });
}
// Pure: in-flight dispatch runs of OTHER approved PRs (stale after a merge).
function otherApprovedRuns(runs, prIdx, mergedBranch) {
  return (runs || []).filter(function (r) {
    return isDispatch(r) && r.head_branch !== mergedBranch && hasLabel(prIdx[r.head_branch], 'pr_approved');
  });
}
function shouldDeferFresh(rule, state) {
  return !!(rule && rule.deferWhileApprovedPending && state && state.approvedPending);
}

function cancelRun(deps, repoInfo, r, why) {
  var line = 'CI run ' + r.id + ' (' + r.head_branch + ' @ ' + String(r.head_sha || '').slice(0, 7) + ', ' + r.status + ') — ' + why;
  if (deps.dry) {
    deps.log('  🧪 [dry] would cancel ' + line);
    return;
  }
  try {
    deps.exec({
      command: 'gh api -X POST repos/' + repoKey(repoInfo) + '/actions/runs/' + r.id + '/cancel || true'
    });
    deps.log('  🛑 cancelled ' + line);
  } catch (e) {
    deps.warn('  ⚠️  cancel of CI run ' + r.id + ' failed: ' + (e.message || e));
  }
}
function unarm(deps, repoInfo, pr) {
  if (deps.dry || !pr || !hasLabel(pr, 'ai_validating')) {
    return;
  }
  try {
    deps.githubTracker(repoInfo).removeLabel(pr.number, 'ai_validating');
  } catch (e) {
    deps.warn('  ⚠️  ai_validating strip on pr-' + pr.number + ' failed: ' + (e.message || e));
  }
}
function cancelBatch(deps, repoInfo, runs, why, seen, prIdx) {
  runs.forEach(function (r) {
    if (seen[r.id]) {
      return;
    }
    seen[r.id] = true;
    cancelRun(deps, repoInfo, r, why);
    if (prIdx) {
      unarm(deps, repoInfo, prIdx[r.head_branch]);
    }
  });
}
function cancelQueuedUnapproved(deps, repoInfo, runs, prIdx, seen) {
  cancelBatch(deps, repoInfo, queuedUnapprovedRuns(runs, prIdx), 'approved-first: frees the runner for pending pre-merge validation (re-dispatched later on the same sha)', seen, prIdx);
}
function cancelDeadBranchRuns(deps, repoInfo, runs, prIdx, seen) {
  cancelBatch(deps, repoInfo, deadBranchRuns(runs, prIdx), 'branch has no open PR', seen, null);
}
function runSweep(deps, repoInfo, ciWorkflow) {
  var runs = inFlightCiRuns(deps, repoInfo, ciWorkflow);
  var prIdx = indexPrsByBranch(openPrs(deps, repoInfo));
  var seen = {};
  cancelBatch(deps, repoInfo, dedupeSameHead(runs), 'duplicate of a newer run on the same head', seen, null);
  cancelDeadBranchRuns(deps, repoInfo, runs, prIdx, seen);
  var pending = approvedPendingExists(runs, prIdx) || !!_armedApproved[repoKey(repoInfo)];
  if (pending) {
    cancelQueuedUnapproved(deps, repoInfo, runs, prIdx, seen);
  }
  return { approvedPending: pending };
}
// Once per repo per tick (memoized); fail-open on any probe error.
function sweep(deps, repoInfo, ciWorkflow) {
  var k = repoKey(repoInfo);
  if (_sweepMemo[k]) {
    return _sweepMemo[k];
  }
  try {
    _sweepMemo[k] = runSweep(deps, repoInfo, ciWorkflow);
  } catch (e) {
    deps.warn('  ⚠️  CI priority probe failed (fail-open, dispatch as before): ' + (e.message || e));
    _sweepMemo[k] = { approvedPending: !!_armedApproved[k], failed: true };
  }
  return _sweepMemo[k];
}
// ruleProcessor hook: true = the rule defers this tick.
function gateRule(deps, rule, repoInfo) {
  if (!rule || rule.localAction !== 'validate_pr' || rule.source !== 'github' || !repoInfo) {
    return false;
  }
  var state = sweep(deps, repoInfo, ciWorkflowOf(rule, deps.jobParams));
  if (!shouldDeferFresh(rule, state)) {
    return false;
  }
  deps.log('  ⏸️  approved PR validation pending — pre-approval validation deferred (approved-first)');
  return true;
}
// validate_pr hook before dispatch: true = skip (handled for this tick).
function preDispatchSkip(deps, rule, repoInfo, ticket, key, vProbe, sha, processedKeys) {
  if (rule.oneRunPerHead && vProbe && vProbe.verdict) {
    deps.log('  ⏭️  ' + key + ' head ' + String(sha).slice(0, 7) + ' already has a concluded CI run (' + vProbe.verdict + ') — one run per head');
    processedKeys.push(key);
    return true;
  }
  try {
    if (!sha || !runsOnHead(inFlightCiRuns(deps, repoInfo, ciWorkflowOf(rule, deps.jobParams)), ticket.branch, sha).length) {
      return false;
    }
  } catch (e) {
    deps.warn('  ⚠️  in-flight CI probe failed (fail-open): ' + (e.message || e));
    return false;
  }
  deps.log('  ⏭️  in-flight CI already covers ' + String(sha).slice(0, 7) + ' (' + key + ')');
  processedKeys.push(key);
  return true;
}
function noteDispatched(repoInfo, ticket) {
  dropRunsMemo(repoInfo);
  if ((ticket.labels || []).indexOf('pr_approved') !== -1) {
    _armedApproved[repoKey(repoInfo)] = true;
  }
}
// validate_pr dispatch tail (moved from prUpdateAndValidateActions.js).
function finalizeValidatePrDispatch(deps, repoInfo, ticket, key, vHead0, processedKeys) {
  try {
    deps.dispatchCiWorkflow(ticket.branch);
  } catch (eCi922) {
    deps.warn('  ⚠️  validation dispatch failed for ' + key + ': ' + (eCi922.message || eCi922));
    deps.recordDispatchFailure(repoInfo, key, ticket, eCi922, ticket.branch, triggerFailuresModule.classifyTriggerError(eCi922 && eCi922.message));
    return;
  }
  noteDispatched(repoInfo, ticket);
  if (vHead0) {
    deps.stampValidationChecks(repoInfo, vHead0, 'in_progress', null, null);
  }
  if (!deps.dry) {
    deps.githubTracker(repoInfo).addLabel(ticket.prNumber, 'ai_validating');
  }
  deps.log('  🧪 ' + key + ' validation dispatched (CI runs on the head via workflow_dispatch)');
  processedKeys.push(key);
}
// merge_pr hook: other approved validations are stale once main moved.
function afterMergeOutcome(deps, repoInfo, ticket, outcome) {
  if (outcome !== 'merged') {
    return outcome;
  }
  try {
    var runs = inFlightCiRuns(deps, repoInfo, ciWorkflowOf(null, deps.jobParams));
    var prIdx = indexPrsByBranch(openPrs(deps, repoInfo));
    cancelBatch(deps, repoInfo, otherApprovedRuns(runs, prIdx, ticket.branch), 'stale pre-merge validation (main moved by the merge) — re-arms serially', {}, prIdx);
  } catch (e) {
    deps.warn('  ⚠️  post-merge stale-validation cancel failed (fail-open): ' + (e.message || e));
  }
  dropRunsMemo(repoInfo);
  return outcome;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    resetTick: resetTick,
    inFlightCiRuns: inFlightCiRuns,
    dropRunsMemo: dropRunsMemo,
    dedupeSameHead: dedupeSameHead,
    deadBranchRuns: deadBranchRuns,
    approvedPendingExists: approvedPendingExists,
    queuedUnapprovedRuns: queuedUnapprovedRuns,
    otherApprovedRuns: otherApprovedRuns,
    cancelQueuedUnapproved: cancelQueuedUnapproved,
    cancelDeadBranchRuns: cancelDeadBranchRuns,
    shouldDeferFresh: shouldDeferFresh,
    sweep: sweep,
    gateRule: gateRule,
    preDispatchSkip: preDispatchSkip,
    noteDispatched: noteDispatched,
    finalizeValidatePrDispatch: finalizeValidatePrDispatch,
    afterMergeOutcome: afterMergeOutcome
  };
}
