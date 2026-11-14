/**
 * Validation check-run and workflow-run rollup probes —
 * js/sm/validationProbes.js (#1459).
 */
'use strict';

var checkRunZombiesModule = require('../common/checkRunZombies.js');
var redVerdictModule = require('./redVerdict.js');
var smProviderModule = require('../common/smProvider.js');
var validationLivenessModule = require('../common/validationLiveness.js');
var workflowRunsModule = require('../common/workflowRuns.js');
var ACTIVE_DISPATCH_STATUSES = ['queued', 'in_progress', 'waiting', 'pending'];
var RULESET_CONTEXTS_JQ = '[.[] | select(.type == "required_status_checks")' + ' | .parameters.required_status_checks[].context]';
var PR_ROLLUP_JQ = '[.data.repository.pullRequest.statusCheckRollup.contexts.nodes[]' + ' | select(.isRequired == true) | (.name // .context)]';
var PROBE_WORKER_SOURCE = ['function(args) {', '    function mcpParse(result) {', '        if (!result) return null;', "        if (typeof result === 'string') {", '            try { return JSON.parse(result); } catch (e) { return null; }', '        }', '        return result;', '    }', "    var out = { active: false, verdict: null, green: false, newest: null };", '    try {', '        var res = cli_execute_command({', "            command: 'gh api \"repos/' + args.repo.owner + '/' + args.repo.repo +", "                '/actions/workflows/' + args.ciWorkflow +", "                '/runs?head_sha=' + args.headSha +", "                '&event=workflow_dispatch&per_page=5\"'", '        });', '        var parsed = mcpParse((res || {}).output || (res || {}).stdout || res);', '        var list = (parsed && parsed.workflow_runs) || [];', '        out.active = list.some(function (r) {', "            return r.status === 'queued' || r.status === 'in_progress' ||", "                r.status === 'waiting' || r.status === 'pending';", '        });', '        out.green = list.some(function (r) {', "            return r.status === 'completed' && r.conclusion === 'success';", '        });', '        var concluded = list.filter(function (r) {', "            return r.status === 'completed' && r.conclusion &&", "                r.conclusion !== 'cancelled';", '        });', '        if (concluded.length) {', '            concluded.sort(function (a, b) {', '                return new Date(b.updated_at || b.created_at).getTime() -', '                       new Date(a.updated_at || a.created_at).getTime();', '            });', '            out.verdict = concluded[0].conclusion;', '        }', '        if (list.length) {', '            var sorted = list.slice();', '            sorted.sort(function (a, b) {', '                return Date.parse(b.updated_at || b.created_at || 0) -', '                       Date.parse(a.updated_at || a.created_at || 0);', '            });', '            out.newest = sorted[0];', '        }', '    } catch (e) {', "        console.warn('  ⚠️  dispatched-state probe failed: ' + (e.message || e));", '    }', '    return out;', '}'].join('\n');
function mcpParse(payload) {
  if (typeof payload !== 'string') {
    return payload || null;
  }
  try {
    return JSON.parse(payload);
  } catch (err) {
    return null;
  }
}
function headCheckRunsSafe(deps, repoInfo, headSha) {
  try {
    var cr = mcpParse(deps.getCommitCheckRuns(repoInfo, headSha)) || {};
    return cr.check_runs || cr.checkRuns || [];
  } catch (e) {
    deps.warn('  ⚠️  check-run scan failed: ' + (e.message || e));
    return null;
  }
}
function isNewerCheckEntry(prev, t, id, pos) {
  if (!prev || t > prev.t) {
    return true;
  }
  if (t !== prev.t) {
    return false;
  }
  return id > prev.id || id === prev.id && pos > prev.pos;
}
function parseCheckEntryTime(r) {
  return Date.parse(r.completed_at || r.started_at || '') || 0;
}
function latestCheckRunConclusions(rollup) {
  var latest = {};
  (rollup || []).forEach(function (r, pos) {
    var name = r && (r.name || r.context);
    if (!name) {
      return;
    }
    var concl = r.conclusion ? String(r.conclusion).toUpperCase() : null;
    var t = parseCheckEntryTime(r);
    var id = Number(r.id) || 0;
    if (isNewerCheckEntry(latest[name], t, id, pos)) {
      latest[name] = {
        t: t,
        id: id,
        pos: pos,
        concl: concl
      };
    }
  });
  return latest;
}
function isBookkeepingCheckName(name) {
  var prefixes = smProviderModule && smProviderModule.BOOKKEEPING_CHECK_PREFIXES || ['kicker /', 'Wake-up probe', 'merge /'];
  var n = String(name || '');
  for (var i = 0; i < prefixes.length; i++) {
    if (n.indexOf(prefixes[i]) === 0) {
      return true;
    }
  }
  return false;
}
function eachNonBookkeepingConclusion(rollup, visit) {
  var latest = latestCheckRunConclusions(rollup);
  var names = Object.keys(latest);
  for (var i = 0; i < names.length; i++) {
    if (isBookkeepingCheckName(names[i])) {
      continue;
    }
    if (visit(latest[names[i]].concl, names[i])) {
      return true;
    }
  }
  return false;
}
function headHasRealFailure(deps, repoInfo, headSha) {
  try {
    var rollup = headCheckRunsSafe(deps, repoInfo, headSha);
    if (!rollup || !rollup.length) {
      return true;
    }
    return eachNonBookkeepingConclusion(rollup, function (concl) {
      return concl === 'FAILURE' || concl === 'TIMED_OUT';
    });
  } catch (e) {
    deps.warn('  ⚠️  red-verdict probe failed: ' + (e.message || e));
    return true;
  }
}
function isFailingNonBookkeeping(latest, name) {
  if (isBookkeepingCheckName(name)) {
    return false;
  }
  var concl = latest[name].concl;
  return concl === 'FAILURE' || concl === 'TIMED_OUT';
}
function failingCheckNames(deps, repoInfo, headSha) {
  if (!repoInfo || !headSha) {
    return [];
  }
  try {
    var rollup = headCheckRunsSafe(deps, repoInfo, headSha);
    if (!rollup || !rollup.length) {
      return [];
    }
    var latest = latestCheckRunConclusions(rollup);
    return Object.keys(latest).filter(function (name) {
      return isFailingNonBookkeeping(latest, name);
    }).sort();
  } catch (e) {
    deps.warn('  ⚠️  failing-check scan failed: ' + e);
    return [];
  }
}
function extractWorkflowRunsArray(parsed) {
  var runs = parsed || {};
  return runs.workflow_runs || runs.workflowRuns || [];
}
function dispatchedValidationRuns(deps, repoInfo, ciWorkflow) {
  if (!repoInfo || !ciWorkflow) {
    return null;
  }
  try {
    return extractWorkflowRunsArray(mcpParse(deps.listWorkflowRuns(repoInfo, ciWorkflow)));
  } catch (e) {
    deps.warn('  ⚠️  dispatched-run list fetch failed: ' + e);
    return null;
  }
}
function failedRunLinksLine(deps, repoInfo, ciWorkflow, headSha) {
  return redVerdictModule.failedRunLinksFromList(dispatchedValidationRuns(deps, repoInfo, ciWorkflow), headSha);
}
function parseExecRuns(res) {
  var raw = (res || {}).output || (res || {}).stdout || res;
  return extractWorkflowRunsArray(mcpParse(raw));
}
function headWorkflowRunsSafe(deps, repoInfo, headSha) {
  try {
    var res = deps.exec({
      command: 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo + '/actions/runs?head_sha=' + headSha + '&per_page=50"'
    });
    return parseExecRuns(res);
  } catch (e) {
    deps.warn('  ⚠️  head-run probe failed: ' + (e.message || e));
    return null;
  }
}
function headCheckRunZombies(deps, repoInfo, headSha) {
  var checkRuns = headCheckRunsSafe(deps, repoInfo, headSha);
  if (checkRuns === null) {
    return null;
  }
  if (!checkRuns.length) {
    return {
      zombies: [],
      live: 0,
      settled: 0,
      unresolvable: 0
    };
  }
  var runs = headWorkflowRunsSafe(deps, repoInfo, headSha);
  if (runs === null) {
    return null;
  }
  var byId = workflowRunsModule.indexRunsById(runs);
  return checkRunZombiesModule.classify(checkRuns, function (runId) {
    var hit = byId[String(runId)];
    return hit === undefined ? null : hit;
  }, Date.now(), {
    staleNoRunnerMinutes: (deps.jobParams || {}).checkRunZombieStaleMinutes,
    runConcludedGraceMinutes: (deps.jobParams || {}).checkRunZombieGraceMinutes
  });
}
function headPlaceholders(deps, repoInfo, headSha) {
  var checkRuns = headCheckRunsSafe(deps, repoInfo, headSha);
  if (checkRuns === null) {
    return null;
  }
  return checkRunZombiesModule.placeholders(checkRuns, Date.now(), {
    placeholderMinutes: (deps.jobParams || {}).checkRunPlaceholderMinutes
  });
}
function headOrphanedRunChecks(deps, repoInfo, headSha) {
  var checkRuns = headCheckRunsSafe(deps, repoInfo, headSha);
  if (checkRuns === null) {
    return null;
  }
  if (!checkRuns.length) {
    return [];
  }
  var runs = headWorkflowRunsSafe(deps, repoInfo, headSha);
  if (runs === null) {
    return null;
  }
  var byId = workflowRunsModule.indexRunsById(runs);
  return checkRunZombiesModule.orphanedRunChecks(checkRuns, function (runId) {
    var hit = byId[String(runId)];
    return hit === undefined ? null : hit;
  }, Date.now(), {
    runConcludedGraceMinutes: (deps.jobParams || {}).checkRunZombieGraceMinutes
  });
}
function repoPoolFree(deps, repoInfo) {
  try {
    var runs = mcpParse(deps.listWorkflowRuns(repoInfo)) || {};
    var list = runs.workflow_runs || runs.workflowRuns || [];
    return !validationLivenessModule.poolBusy(list, Date.now());
  } catch (ePool) {
    deps.warn('  ⚠️  pool-free probe failed: ' + (ePool.message || ePool));
    return null;
  }
}
function hasActiveHeadRun(runs) {
  return (runs || []).some(function (r) {
    return validationLivenessModule.ACTIVE_RUN_STATES.indexOf(r.status) !== -1;
  });
}
function isAmbientNonDispatchRun(r) {
  if (!r || !r.event) {
    return false;
  }
  return r.event === 'dynamic' || r.event === 'pull_request' || r.event === 'pull_request_target';
}
function isCompletedWithinGrace(r, now, graceMs) {
  if (r.status !== 'completed') {
    return false;
  }
  var endTs = Date.parse(r.updated_at || r.created_at || '');
  return !isNaN(endTs) && now - endTs >= 0 && now - endTs < graceMs;
}
function isRecentSingleHeadRun(r, now, graceMs) {
  if (!r || isAmbientNonDispatchRun(r)) {
    return false;
  }
  if (ACTIVE_DISPATCH_STATUSES.indexOf(r.status) !== -1 || r.status === 'requested') {
    return true;
  }
  return isCompletedWithinGrace(r, now, graceMs);
}
function hasRecentHeadRun(runs, graceMs) {
  var now = Date.now();
  return (runs || []).some(function (r) {
    return isRecentSingleHeadRun(r, now, graceMs);
  });
}
module.exports = {
  PROBE_WORKER_SOURCE: PROBE_WORKER_SOURCE,
  RULESET_CONTEXTS_JQ: RULESET_CONTEXTS_JQ,
  PR_ROLLUP_JQ: PR_ROLLUP_JQ,
  mcpParse: mcpParse,
  headCheckRunsSafe: headCheckRunsSafe,
  latestCheckRunConclusions: latestCheckRunConclusions,
  isBookkeepingCheckName: isBookkeepingCheckName,
  eachNonBookkeepingConclusion: eachNonBookkeepingConclusion,
  headHasRealFailure: headHasRealFailure,
  failingCheckNames: failingCheckNames,
  dispatchedValidationRuns: dispatchedValidationRuns,
  failedRunLinksLine: failedRunLinksLine,
  headWorkflowRunsSafe: headWorkflowRunsSafe,
  headCheckRunZombies: headCheckRunZombies,
  headPlaceholders: headPlaceholders,
  headOrphanedRunChecks: headOrphanedRunChecks,
  repoPoolFree: repoPoolFree,
  hasActiveHeadRun: hasActiveHeadRun,
  isAmbientNonDispatchRun: isAmbientNonDispatchRun,
  hasRecentHeadRun: hasRecentHeadRun
};
