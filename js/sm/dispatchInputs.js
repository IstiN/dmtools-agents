/**
 * Dispatch-input builders for js/sm/workflowDispatch.js (gh-1540 rework).
 *
 * The gh-1540 `{branch}` placeholder grew buildWorkflowDispatchInputs past
 * the CRAP ≤ 8 ratchet (quality CI: NEW > 8, CC 9 at 92.9% — the one
 * uncovered statement being the anchor.ok=false skip), and the extraction
 * helpers pushed workflowDispatch.js past its 40 top-level functions pin.
 * These four pure helpers are the cyclomatic-lean split: each carries at
 * most two branch points, so no function in the pair of modules can breach
 * the CRAP threshold regardless of its coverage, and both modules stay
 * within the module-size gate. Behavior pins live in test_smAgent.js
 * ('dispatch-input builder anchor semantics (gh-1540 rework)').
 */
'use strict';

var buildEncodedConfigModule = require('../common/buildEncodedConfig.js');

function bareDispatchInputs(ticketKey, rule, effectiveConfig, resolvedCf, concurrencyKey, projectKey) {
  return {
    concurrency_key: concurrencyKey, display_key: ticketKey,
    input_jql: buildEncodedConfigModule.resolveTicketInputJql(ticketKey, effectiveConfig),
    config_file: resolvedCf,
    encoded_config: buildEncodedConfigModule.buildEncodedConfig(ticketKey, rule, effectiveConfig),
    project_key: projectKey
  };
}
function dispatchAnchorIssueVal(anchor, ticketKey) {
  if (anchor.issueNumber !== null) return anchor.issueNumber;
  if (anchor.prAnchoredFallback) return '';
  return ticketKey;
}
function expandDispatchInputValue(template, ticketKey, issueVal, it) {
  // gh-1540: {branch} carries the item branch — the ai-teammate
  // concurrency group keys on it (same head = one queue; unrelated
  // branches and default-ref lanes keep their own groups).
  return String(template)
    .replace(/\{key\}/g, String(ticketKey))
    .replace(/\{issueNumber\}/g, String(issueVal))
    .replace(/\{prNumber\}/g, String(it.prNumber || ''))
    .replace(/\{branch\}/g, String(it.branch || ''));
}
function applyPrAnchoredFallbackInputs(inputs, anchor, it) {
  if (!anchor.prAnchoredFallback) return inputs;
  inputs.issue = '';
  inputs.pr = String(it.prNumber);
  return inputs;
}
function stripUnexpectedDispatchInputs(inputs, errMessage) {
  var m = /Unexpected inputs provided:\s*\[([^\]]+)\]/i.exec(String(errMessage || ''));
  if (!m || !inputs) return null;
  var stripped = {};
  var removed = false;
  Object.keys(inputs).forEach(function (k) { stripped[k] = inputs[k]; });
  var re = /\\?"([^"\\]+)\\?"/g, match;
  while ((match = re.exec(m[1])) !== null) {
    if (Object.prototype.hasOwnProperty.call(stripped, match[1])) {
      delete stripped[match[1]];
      removed = true;
    }
  }
  return removed ? stripped : null;
}
function triggerWorkflowCompatible(scm, repoInfo, plan, inputs) {
  try {
    return scm.triggerWorkflow(repoInfo.owner, repoInfo.repo, plan.workflowFile, JSON.stringify(inputs), plan.workflowRef);
  } catch (e) {
    var fallback = stripUnexpectedDispatchInputs(inputs, e && e.message);
    if (!fallback) throw e;
    return scm.triggerWorkflow(repoInfo.owner, repoInfo.repo, plan.workflowFile, JSON.stringify(fallback), plan.workflowRef);
  }
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    bareDispatchInputs: bareDispatchInputs,
    dispatchAnchorIssueVal: dispatchAnchorIssueVal,
    expandDispatchInputValue: expandDispatchInputValue,
    applyPrAnchoredFallbackInputs: applyPrAnchoredFallbackInputs,
    stripUnexpectedDispatchInputs: stripUnexpectedDispatchInputs,
    triggerWorkflowCompatible: triggerWorkflowCompatible
  };
}
