/**
 * Review verdict reconciliation, fail-marker parsing, and naked-PR sweep —
 * js/sm/verdictAndFailState.js (#1459).
 */
'use strict';

var checkRunZombiesModule = require('../common/checkRunZombies.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var nakedPrReconcileModule = require('../common/nakedPrReconcile.js');
var prTerminalStateModule = require('../common/prTerminalState.js');
var reworkLoopGuardModule = require('../common/reworkLoopGuard.js');
var reviewVerdictsModule = require('../common/reviewVerdicts.js');
var validationLivenessModule = require('../common/validationLiveness.js');
var validationProbesModule = require('./validationProbes.js');
var workflowDispatchModule = require('./workflowDispatch.js');
var RED_HEAD_MARKER_RE = /\uD83D\uDD34 red head ([0-9a-f]{7,40}) \u2014 red (\d+)\/(\d+)/g;
var EMPTY_LAP_MARKER_RE = /\uD83C\uDF00 empty rework lap (\d+)\/(\d+) \u2014 head ([0-9a-f]{7,40}) unchanged/g;
var PLACEHOLDER_PARK_MARKER = '\uD83C\uDFF7\uFE0F Placeholder resets capped';
var REWORK_WITHHELD_MARKER_RE = /\uD83D\uDED1 rework arm withheld on head ([0-9a-f]{7,40})/g;
function parsePositiveIntParam(val, fallback) {
  var n = typeof val === 'string' ? parseInt(val, 10) : val;
  return typeof n === 'number' && n > 0 ? Math.floor(n) : fallback;
}
function redHeadCapOf(jobParams) {
  return parsePositiveIntParam((jobParams || {}).redHeadCap, 3);
}
function redHeadSkipEnabled(rule, jobParams) {
  return rule.redHeadSkip !== false && String((jobParams || {}).redHeadSkip) !== 'false';
}
function redHeadMarkerLine(priorReds, headSha, cap) {
  if (!headSha) {
    return null;
  }
  return '\uD83D\uDD34 red head ' + headSha + ' \u2014 red ' + (priorReds + 1) + '/' + cap + ' (owner directive 2026-10-04: red yields the slot \u2014 after ' + cap + ' reds on the same head, validation waits for a NEW head)';
}
function noopLapMaxOf(jobParams) {
  return parsePositiveIntParam((jobParams || {}).noopLapMax, reworkLoopGuardModule.DEFAULT_NOOP_LAP_MAX);
}
function scanMaxMarkerMatches(re, body, keyIdx, numIdx, map) {
  var m;
  re.lastIndex = 0;
  while ((m = re.exec(body)) !== null) {
    var n = parseInt(m[numIdx], 10) || 0;
    var k = m[keyIdx];
    if (!map[k] || n > map[k]) {
      map[k] = n;
    }
  }
}
function scanCommentBodyMarkers(body, out) {
  scanMaxMarkerMatches(RED_HEAD_MARKER_RE, body, 1, 2, out.redHeads);
  scanMaxMarkerMatches(EMPTY_LAP_MARKER_RE, body, 3, 1, out.emptyLaps);
}
function parseRedAndEmptyLapBodies(deps, repoInfo, prNumber, out) {
  var bodies = [];
  try {
    var list = deps.fetchPrCommentList(repoInfo, prNumber);
    list.forEach(function (c) {
      var body = String(c && c.body || '');
      bodies.push(body);
      scanCommentBodyMarkers(body, out);
    });
  } catch (eMarks) {
    deps.warn('  ⚠️  fail-marker state read failed: ' + (eMarks.message || eMarks));
  }
  return bodies;
}
function parseZombieAndPlaceholderMarks(deps, bodies, out) {
  try {
    out.zombies = validationLivenessModule.zombieMarks(bodies);
  } catch (eZomb) {
    deps.warn('  ⚠️  zombie-marker parse failed: ' + (eZomb.message || eZomb));
  }
  try {
    out.placeholders = checkRunZombiesModule.placeholderMarks(bodies, Date.now(), checkRunZombiesModule.placeholderWindowMsOf(deps.jobParams));
    out.placeholderParked = bodies.some(function (b) {
      return String(b == null ? '' : b).indexOf(PLACEHOLDER_PARK_MARKER) !== -1;
    });
  } catch (ePh) {
    deps.warn('  ⚠️  placeholder-marker parse failed: ' + (ePh.message || ePh));
    out.placeholders = {
      count: 0,
      lastAtMs: null
    };
  }
}
function parseWithheldReworkMarks(deps, bodies, out) {
  try {
    out.reworkWithheld = {};
    bodies.forEach(function (b) {
      var wmr;
      REWORK_WITHHELD_MARKER_RE.lastIndex = 0;
      while ((wmr = REWORK_WITHHELD_MARKER_RE.exec(String(b == null ? '' : b))) !== null) {
        out.reworkWithheld[wmr[1]] = true;
      }
    });
  } catch (eWmr) {
    deps.warn('  ⚠️  withheld-arm marker parse failed: ' + (eWmr.message || eWmr));
    out.reworkWithheld = {};
  }
}
function failMarkerState(deps, repoInfo, prNumber) {
  var out = {
    redHeads: {},
    emptyLaps: {},
    zombies: {},
    placeholders: null,
    placeholderParked: false,
    reworkWithheld: {}
  };
  var bodies = parseRedAndEmptyLapBodies(deps, repoInfo, prNumber, out);
  parseZombieAndPlaceholderMarks(deps, bodies, out);
  parseWithheldReworkMarks(deps, bodies, out);
  return out;
}
function redHeadBlocked(deps, repoInfo, prNumber, headSha, cap) {
  if (!headSha) {
    return false;
  }
  var hist = failMarkerState(deps, repoInfo, prNumber).redHeads;
  return (hist[headSha] || 0) >= cap;
}
function prHeadAndLabels(deps, repoInfo, prNumber) {
  var pr = workflowDispatchModule.prRawRead(deps, repoInfo, prNumber, '  ⚠️ verdict probe: PR read failed (fail-open): ');
  if (!pr || !pr.head || !pr.head.sha) {
    return null;
  }
  return {
    headSha: pr.head.sha,
    labels: (pr.labels || []).map(function (l) {
      return l && l.name || l;
    }),
    state: prTerminalStateModule.normalizePrState(pr.state),
    merged: pr.merged === true
  };
}
function verdictMachineLogins(deps, effectiveConfig) {
  return machineAuthorModule.machineAuthorLogins(machineAuthorModule.resolveMachineAuthor(deps.jobParams, effectiveConfig));
}
function readVerdictRecords(deps, repoInfo, prNumber, machineLogins) {
  try {
    var list = deps.fetchPrCommentList(repoInfo, prNumber);
    return reviewVerdictsModule.parseVerdictRecords(list, {
      authorLogins: Array.isArray(machineLogins) ? machineLogins : []
    });
  } catch (e) {
    deps.warn('  ⚠️ verdict probe: comment read failed (fail-open): ' + (e.message || e));
    return [];
  }
}
function extractLabelNames(labels) {
  return (labels || []).map(function (l) {
    return l && (l.name || l) || l;
  });
}
function linkedIssueLabels(deps, repoInfo, issueNumber) {
  if (!issueNumber || !deps.hasGetIssue) {
    return null;
  }
  try {
    var obj = validationProbesModule.mcpParse(deps.getIssue(repoInfo, issueNumber));
    if (!obj || typeof obj !== 'object' || obj.message) {
      return null;
    }
    return extractLabelNames(obj.labels);
  } catch (e) {
    return null;
  }
}
function reworkArmGate(deps, repoInfo, ticket, machineLogins, probeOverride) {
  var out = {
    arm: true,
    reason: 'no-verdict-records',
    headShort: null,
    effective: null
  };
  var probe = probeOverride || prHeadAndLabels(deps, repoInfo, ticket.prNumber);
  if (!probe) {
    return out;
  }
  out.headShort = String(probe.headSha).substring(0, 7);
  var decision = reviewVerdictsModule.armReworkDecision(readVerdictRecords(deps, repoInfo, ticket.prNumber, machineLogins), probe.headSha);
  decision.headShort = out.headShort;
  return decision;
}
function removeReconciledLoserLabels(deps, repoInfo, ticket, probe, decision) {
  var tr = deps.githubTracker(repoInfo);
  var removed = false;
  if (decision.removeFromPr) {
    try {
      tr.removeLabel(ticket.prNumber, decision.loserLabel);
      removed = true;
      deps.log('  ⚖️  removed ' + decision.loserLabel + ' from PR #' + ticket.prNumber + ' (head ' + String(probe.headSha).substring(0, 7) + ')');
    } catch (ePr) {
      deps.warn('  ⚠️ failed to remove ' + decision.loserLabel + ' from PR #' + ticket.prNumber + ': ' + (ePr.message || ePr));
    }
  }
  if (decision.removeFromIssue) {
    try {
      tr.removeLabel(ticket.issueNumber, decision.loserLabel);
      removed = true;
      deps.log('  ⚖️  removed ' + decision.loserLabel + ' from linked issue #' + ticket.issueNumber);
    } catch (eIss) {
      deps.warn('  ⚠️ failed to remove ' + decision.loserLabel + ' from issue #' + ticket.issueNumber + ': ' + (eIss.message || eIss));
    }
  }
  return removed;
}
function postReconciledVerdictComment(deps, repoInfo, ticket, decision) {
  try {
    deps.githubTracker(repoInfo).postComment(ticket.prNumber, decision.comment);
  } catch (eC) {
    deps.warn('  ⚠️ reconciliation comment failed (labels already reconciled): ' + (eC.message || eC));
  }
  deps.log('  ✅ ' + ticket.key + ' verdict reconciled — newest wins: ' + decision.effective.record.verdict + (decision.effective.conflict ? ' (conflict logged)' : ''));
}
function computeReconcileDecision(deps, repoInfo, ticket, probe, machineLogins) {
  var records = readVerdictRecords(deps, repoInfo, ticket.prNumber, machineLogins);
  var issueLabels = linkedIssueLabels(deps, repoInfo, ticket.issueNumber);
  var prHasRework = probe.labels.indexOf(reviewVerdictsModule.LABEL_REWORK) !== -1;
  var issueHasRework = !!(issueLabels && issueLabels.indexOf(reviewVerdictsModule.LABEL_REWORK) !== -1);
  var checksRed = records.length && (prHasRework || issueHasRework) ? deps.headHasRealFailure(repoInfo, probe.headSha) : false;
  return reviewVerdictsModule.reconcileDecision(records, probe.headSha, {
    prHasApproved: probe.labels.indexOf(reviewVerdictsModule.LABEL_APPROVED) !== -1,
    prHasRework: prHasRework,
    issueHasRework: issueHasRework,
    checksRed: checksRed
  });
}
function reconcileReviewVerdicts(deps, repoInfo, ticket, machineLogins) {
  var probe = prHeadAndLabels(deps, repoInfo, ticket.prNumber);
  if (!probe) {
    return false;
  }
  if (prTerminalStateModule.isTerminalPrState(probe.state, probe.merged)) {
    deps.log('  ⏭️  PR #' + ticket.prNumber + ' is ' + (probe.state || 'TERMINAL') + ' — terminal: verdict reconcile exits (gh-1369)');
    return false;
  }
  var decision = computeReconcileDecision(deps, repoInfo, ticket, probe, machineLogins);
  if (!decision) {
    return false;
  }
  var removed = removeReconciledLoserLabels(deps, repoInfo, ticket, probe, decision);
  if (removed) {
    postReconciledVerdictComment(deps, repoInfo, ticket, decision);
  }
  return removed;
}
function isMachinePrForSweep(pr, machineAuthor, owner) {
  var branch = String(pr.head && pr.head.ref || '');
  return branch.indexOf('ai/') === 0 || machineAuthorModule.isMachineAuthored({
    author: pr.user && pr.user.login || '',
    branch: branch,
    title: pr.title
  }, machineAuthor, owner);
}
function runNakedPrSweep(deps, repoInfo) {
  try {
    var prs = validationProbesModule.mcpParse(deps.listOpenPrs(repoInfo));
    var list = Array.isArray(prs) ? prs : [];
    var machineAuthor = machineAuthorModule.resolveMachineAuthor(deps.jobParams, deps.projectConfig);
    var tr = deps.githubTracker(repoInfo);
    return nakedPrReconcileModule.sweep(list, {
      bodyLinker: deps.bodyLinker,
      issueLabels: function (n) {
        return linkedIssueLabels(deps, repoInfo, n);
      },
      prComments: function (n) {
        return deps.fetchPrCommentList(repoInfo, n);
      },
      isMachine: function (pr) {
        return isMachinePrForSweep(pr, machineAuthor, repoInfo.owner);
      },
      addLabel: function (n, l) {
        tr.addLabel(n, l);
      },
      comment: function (n, body) {
        tr.postComment(n, body);
      },
      log: deps.log,
      dry: deps.dry
    });
  } catch (e) {
    deps.warn('  ⚠️ naked-PR sweep failed (fail-open): ' + (e.message || e));
    return [];
  }
}
module.exports = {
  RED_HEAD_MARKER_RE: RED_HEAD_MARKER_RE,
  EMPTY_LAP_MARKER_RE: EMPTY_LAP_MARKER_RE,
  PLACEHOLDER_PARK_MARKER: PLACEHOLDER_PARK_MARKER,
  REWORK_WITHHELD_MARKER_RE: REWORK_WITHHELD_MARKER_RE,
  redHeadCapOf: redHeadCapOf,
  redHeadSkipEnabled: redHeadSkipEnabled,
  redHeadMarkerLine: redHeadMarkerLine,
  noopLapMaxOf: noopLapMaxOf,
  failMarkerState: failMarkerState,
  redHeadBlocked: redHeadBlocked,
  prHeadAndLabels: prHeadAndLabels,
  verdictMachineLogins: verdictMachineLogins,
  readVerdictRecords: readVerdictRecords,
  linkedIssueLabels: linkedIssueLabels,
  reworkArmGate: reworkArmGate,
  reconcileReviewVerdicts: reconcileReviewVerdicts,
  runNakedPrSweep: runNakedPrSweep
};
