/**
 * Plan sequencer — the SM localAction advance_plan (rule plan-advance).
 *
 * For one planned parent (it carries issuePlanning.plannedLabel, set by the
 * intake post-action on GitHub): read its sub-issues and the plan recorded in
 * its comments, then start the sub-issues whose blockers are closed (dev label
 * + a comment on the parent) or close the parent when every sub-issue is
 * closed. The decision itself lives in issuePlan.decideNextSteps.
 *
 * Sub-issues exist on GitHub only. On any other tracker this returns
 * { type: 'unsupported' } without a tracker call, so a Jira/ADO project that
 * happens to use the planned label does not fail every tick.
 *
 * Convergent: the dev label is added once (a started sub-issue is not started
 * again) and a closed parent no longer matches the open-issue query.
 */

var issuePlan = require('./issuePlan.js');

// key → closed?, answering from the listed sub-issues first and the tracker for any other key.
function closedLookup(tracker, children) {
    var known = {};
    children.forEach(function (c) { known[issuePlan.sameRef(c.key)] = issuePlan.isClosed(c); });
    return function (key) {
        var ref = issuePlan.sameRef(key);
        if (known[ref] === undefined) known[ref] = issuePlan.isClosed(tracker.getTicket(key));
        return known[ref];
    };
}

function startChildren(tracker, parentKey, decision, cfg) {
    decision.start.forEach(function (child) { tracker.addLabel(child.key, cfg.devLabel); });
    tracker.postComment(parentKey, issuePlan.renderStartComment(decision, cfg));
}

function completePlan(tracker, parentKey, decision, closeIssue) {
    tracker.postComment(parentKey, issuePlan.renderCompleteComment(decision));
    closeIssue(parentKey);
}

/**
 * Advance one planned parent.
 *
 * @param {Object}   tracker   trackers.js tracker bound to the parent's repository
 * @param {string}   parentKey the planned parent (issue number or key)
 * @param {Object}   cfg       issuePlan.resolvePlanningConfig() result
 * @param {Object}   options   { dryRun: boolean, closeIssue: function(parentKey) }
 * @returns {{type: string, start: Array<Object>, total: number}} the decision taken
 *   (type 'unsupported' when the tracker has no sub-issues)
 */
function advancePlan(tracker, parentKey, cfg, options) {
    if (!tracker || tracker.provider() !== 'github') return { type: 'unsupported', start: [], total: 0 };
    var opts = options || {};
    var children = tracker.listChildTickets(parentKey);
    var plan = issuePlan.findPlan(tracker.getComments(parentKey));
    var decision = issuePlan.decideNextSteps(children, plan, cfg, closedLookup(tracker, children));
    if (opts.dryRun) return decision;
    if (decision.type === 'start') startChildren(tracker, parentKey, decision, cfg);
    if (decision.type === 'complete') completePlan(tracker, parentKey, decision, opts.closeIssue);
    return decision;
}

var DESCRIPTIONS = {
    unsupported: 'skipped — sub-issues exist on GitHub only',
    empty: 'labeled planned but has no sub-issues — nothing to sequence',
    blocked: 'waiting — a blocker of this issue is still open',
    wait: 'waiting — no sub-issue can start yet',
    complete: 'every sub-issue is closed — closing the issue'
};

/** One log line for a decision. */
function describe(decision, cfg) {
    if (decision.type !== 'start') return DESCRIPTIONS[decision.type] || decision.type;
    return 'starting ' + decision.start.map(function (c) { return c.key; }).join(', ') + ' +' + cfg.devLabel;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { advancePlan: advancePlan, describe: describe };
}
