/**
 * Validation check stamping & sync — js/sm/validationCheckSync.js (#1459).
 *
 * Bridge-free tick-stamped check runs (owner 2026-09-23 / gh-1107 / gh-1118):
 * builds the deep-linked summary block, stamps the configured validationChecks
 * via Checks API temp-file POST (with one retry), and refreshes armed PR
 * check stamps from the newest dispatched workflow runs once per repo per tick.
 */
'use strict';

var checkRunStampModule = require('../common/checkRunStamp.js');
var probeCacheModule = require('../common/probeCache.js');
var FAILING_JOB_CONCLUSIONS = ['failure', 'timed_out', 'action_required', 'startup_failure', 'stale'];
var ACTIVE_SYNC_STATES = ['queued', 'in_progress', 'waiting', 'pending'];
var stampTempSeq = 0;
function mcpParse(result) {
  if (!result) {
    return null;
  }
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch (e) {
      return null;
    }
  }
  return result;
}
function nonEmptyArray(arr) {
  return Array.isArray(arr) && arr.length ? arr : null;
}
function validationCheckNames(jobParams) {
  var raw = (jobParams || {}).validationChecks;
  if (!raw) {
    return null;
  }
  return nonEmptyArray(typeof raw === 'string' ? mcpParse(raw) : raw);
}
function formatJobVerdict(j) {
  if (!j.conclusion) {
    return j.status;
  }
  return j.status === 'completed' ? j.conclusion : j.status;
}
function buildJobsTableSummary(runUrl, jobs) {
  var lines = ['| Job | Result |', '| --- | --- |'];
  jobs.forEach(function (j) {
    var link = j.html_url || runUrl;
    lines.push('| [' + String(j.name) + '](' + link + ') | ' + formatJobVerdict(j) + ' |');
  });
  return 'Dispatched run: ' + runUrl + '\n' + lines.join('\n') + '\n_Stamped by the SM tick (bridge-free mode)._';
}
function findFirstFailingJobUrl(jobs) {
  for (var i = 0; i < jobs.length; i++) {
    var j = jobs[i];
    if (j && FAILING_JOB_CONCLUSIONS.indexOf(j.conclusion) !== -1 && j.html_url) {
      return j.html_url;
    }
  }
  return null;
}
function parseJobsResponse(res) {
  var parsed = mcpParse(res && (res.output || res.stdout) || res);
  return parsed && parsed.jobs || [];
}
function fetchRunJobsSafe(deps, repoInfo, runId) {
  // fa #224: the poll rode the 30s probe layer — 84 identical
  // actions/runs/<id>/jobs calls for 3 run ids measured in ONE dry tick.
  // The jobs table is informational (stamp summary body); the stamp POST
  // itself is not affected. liveProbeTtlMs jobParam, 0 = live polls.
  return probeCacheModule.cachedRunJobs(deps, repoInfo, runId, parseJobsResponse);
}
function stampLinkBlock(deps, repoInfo, runUrl, conclusion) {
  var block = {
    detailsUrl: runUrl || null,
    summary: runUrl ? 'Dispatched run: ' + runUrl : 'Stamped by the SM tick (bridge-free mode).'
  };
  var m = runUrl ? /\/runs\/(\d+)/.exec(String(runUrl)) : null;
  if (!m) {
    return block;
  }
  var jobs = fetchRunJobsSafe(deps, repoInfo, m[1]);
  if (!jobs.length) {
    return block;
  }
  block.summary = buildJobsTableSummary(runUrl, jobs);
  var failUrl = conclusion === 'failure' ? findFirstFailingJobUrl(jobs) : null;
  if (failUrl) {
    block.detailsUrl = failUrl;
  }
  return block;
}
function postStampBodyForCheck(deps, repoInfo, headSha, status, conclusion, linkBlock, checkName) {
  var body = checkRunStampModule.buildCheckRunBody({
    name: checkName,
    headSha: headSha,
    status: status,
    conclusion: conclusion,
    detailsUrl: linkBlock.detailsUrl,
    title: 'SM validation' + (conclusion ? ': ' + conclusion : ' (tick-dispatched)'),
    summary: linkBlock.summary
  });
  var tempPath = checkRunStampModule.tempBodyPath(Date.now(), ++stampTempSeq);
  return checkRunStampModule.postCheckRunStampRetryOnce(repoInfo, body, tempPath, {
    write: deps.fileWrite,
    exec: deps.exec,
    del: deps.fileDelete
  }, function (eStamp) {
    deps.warn('  ⚠️  stamp "' + checkName + '" on ' + String(headSha).slice(0, 7) + ' failed (' + (eStamp.message || eStamp) + ') — retrying once');
  });
}
function stampSingleCheckName(deps, repoInfo, headSha, status, conclusion, linkBlock, checkName) {
  if (deps.dry) {
    deps.log('  🧪 [dry] stamp "' + checkName + '" ' + status + (conclusion ? '/' + conclusion : ''));
    return;
  }
  try {
    if (!postStampBodyForCheck(deps, repoInfo, headSha, status, conclusion, linkBlock, checkName)) {
      deps.onStampFailed();
    }
  } catch (e) {
    deps.warn('  ⚠️  stamp "' + checkName + '" on ' + String(headSha).slice(0, 7) + ': ' + (e.message || e));
    deps.onStampFailed();
  }
}
function swapStampToken(deps) {
  var jp = deps.jobParams || {};
  var appToken = jp.checksToken || jp.silentToken;
  var swapped = false;
  if (appToken) {
    try {
      deps.setEnv('GH_TOKEN', appToken);
      swapped = true;
    } catch (e) {
      deps.warn('  ⚠️  token swap failed, stamps use the PAT: ' + (e.message || e));
    }
  }
  return {
    swapped: swapped,
    sourceTok: jp.sourceToken
  };
}
function stampValidationChecksForModule(deps, repoInfo, headSha, status, conclusion, runUrl) {
  var names = validationCheckNames(deps.jobParams);
  if (!names || !headSha) {
    return;
  }
  var tok = swapStampToken(deps);
  try {
    var linkBlock = stampLinkBlock(deps, repoInfo, runUrl, conclusion);
    names.forEach(function (checkName) {
      stampSingleCheckName(deps, repoInfo, headSha, status, conclusion, linkBlock, checkName);
    });
  } finally {
    if (tok.swapped && tok.sourceTok) {
      try {
        deps.setEnv('GH_TOKEN', tok.sourceTok);
      } catch (e2) {}
    }
  }
}
function hasSyncTargetLabel(l) {
  var name = l && l.name;
  return name === 'ai_validating' || name === 'validation_failed';
}
function hasAnyDispatchedRunOnHead(pr, runList) {
  var headSha = pr && pr.head && pr.head.sha;
  if (!headSha || !Array.isArray(runList)) {
    return false;
  }
  return runList.some(function (r) {
    return r.event === 'workflow_dispatch' && r.head_sha === headSha;
  });
}
function isArmedValidatingPr(pr, runList) {
  var head = pr && pr.head;
  if (!head || !head.sha || !head.ref) {
    return false;
  }
  return (pr.labels || []).some(hasSyncTargetLabel) || hasAnyDispatchedRunOnHead(pr, runList);
}
function extractOpenPrList(prsRaw) {
  var prs = mcpParse(prsRaw);
  if (Array.isArray(prs)) {
    return prs;
  }
  return prs && (prs.pullRequests || prs.data || prs.items) || [];
}
function fetchAllRunsFallback(deps, repoInfo, ciWorkflow, runsErr) {
  var all = mcpParse(deps.listWorkflowRuns(repoInfo, null));
  var allList = all ? all.workflow_runs : [];
  var want = '.github/workflows/' + ciWorkflow;
  var runList = allList.filter(function (r) {
    return r.path === want;
  });
  deps.log('  ℹ️  validation-sync: workflow-id form failed (' + String(runsErr).slice(0, 60) + ') — all-runs fallback: ' + runList.length + ' runs');
  return runList;
}
function queryWorkflowRunsById(deps, repoInfo, ciWorkflow) {
  try {
    var runs = mcpParse(deps.listWorkflowRuns(repoInfo, ciWorkflow)) || {};
    var runList = runs.workflow_runs || [];
    var err = !runList.length && runs.message ? runs.message : null;
    return { runs: runs, runList: runList, err: err };
  } catch (eRuns) {
    return { runs: {}, runList: [], err: eRuns.message || String(eRuns) };
  }
}
function fetchSyncWorkflowRuns(deps, repoInfo, ciWorkflow) {
  var q = queryWorkflowRunsById(deps, repoInfo, ciWorkflow);
  var runList = q.err ? fetchAllRunsFallback(deps, repoInfo, ciWorkflow, q.err) : q.runList;
  if (!runList.length) {
    deps.log('  ℹ️  validation-sync: 0 runs from ' + ciWorkflow + ' — raw: ' + JSON.stringify(q.runs).slice(0, 200));
  }
  return runList;
}
function isTerminalNonCancelledRun(r) {
  return r.status === 'completed' && !!r.conclusion && r.conclusion !== 'cancelled';
}
function isActiveSyncRun(r) {
  return ACTIVE_SYNC_STATES.indexOf(r.status) !== -1;
}
function stampTerminalSyncVerdict(deps, prNumber, headSha, t, stampFn) {
  deps.log('  📍 stamp verdict pr#' + prNumber + ' ' + t.conclusion + ' run ' + t.id + ' (stampFn: ' + typeof stampFn + ')');
  try {
    stampFn(headSha, 'completed', t.conclusion === 'success' ? 'success' : 'failure', t.html_url);
  } catch (e) {
    deps.warn('  ⚠️  verdict stamp threw: ' + (e.message || e) + ' / stack: ' + String(e.stack || '').split('\n').slice(0, 3).join(' | '));
  }
}
function stampActiveSyncProgress(deps, prNumber, headSha, activeRun, stampFn) {
  deps.log('  📍 stamp in-progress pr#' + prNumber + ' (stampFn: ' + typeof stampFn + ')');
  try {
    stampFn(headSha, 'in_progress', null, activeRun.html_url);
  } catch (e) {
    deps.warn('  ⚠️  in-progress stamp threw: ' + e);
  }
}
function syncSingleArmedPr(deps, pr, runList, stampFn) {
  var headSha = pr.head.sha;
  var mine = runList.filter(function (r) {
    return r.event === 'workflow_dispatch' && r.head_sha === headSha;
  });
  if (!mine.length) {
    return;
  }
  var terminal = mine.filter(isTerminalNonCancelledRun);
  if (terminal.length) {
    stampTerminalSyncVerdict(deps, pr.number, headSha, terminal[0], stampFn);
    return;
  }
  var active = mine.filter(isActiveSyncRun);
  if (active.length) {
    stampActiveSyncProgress(deps, pr.number, headSha, active[0], stampFn);
  }
}
function isSyncEligible(deps, repoInfo) {
  if (!validationCheckNames(deps.jobParams) || !repoInfo || !repoInfo.owner || !repoInfo.repo) {
    return false;
  }
  var syncMemo = deps.syncMemo;
  var repoKey = repoInfo.owner + '/' + repoInfo.repo;
  var now = Date.now();
  if (syncMemo.repo === repoKey && now - syncMemo.at < 5000) {
    return false;
  }
  syncMemo.repo = repoKey;
  syncMemo.at = now;
  return true;
}
function syncValidationChecks(deps, repoInfo, stampFn) {
  if (!isSyncEligible(deps, repoInfo)) {
    return;
  }
  var ciWorkflow = (deps.jobParams || {}).ciWorkflow || 'quality.yml';
  var openPrs = extractOpenPrList(deps.listOpenPrs(repoInfo));
  if (!openPrs.length) {
    return;
  }
  var runList = fetchSyncWorkflowRuns(deps, repoInfo, ciWorkflow);
  var armed = openPrs.filter(function (pr) {
    return isArmedValidatingPr(pr, runList);
  });
  if (!armed.length) {
    return;
  }
  armed.forEach(function (pr) {
    syncSingleArmedPr(deps, pr, runList, stampFn);
  });
  deps.log('  ℹ️  validation-sync: ' + JSON.stringify({
    armed: armed.length,
    runs: runList.length
  }));
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      validationCheckNames: validationCheckNames,
      stampLinkBlock: stampLinkBlock,
      stampValidationChecksForModule: stampValidationChecksForModule,
      syncValidationChecks: syncValidationChecks
    };
}
