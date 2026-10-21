/**
 * Issue plan contract — what the intake post-action (createIntakeTickets.js)
 * writes on GitHub and the SM plan sequencer (planAdvance.js) reads back:
 *
 *   - the planning knobs (labels, parallelism) and their defaults;
 *   - the hidden marker that ties a created sub-issue to its intake entry, so a
 *     re-run reuses the sub-issue instead of creating a duplicate;
 *   - the hidden plan marker on a planned parent that records the blockedBy
 *     ordering of its sub-issues (GitHub has no issue links the runtimes expose);
 *   - the next-step decision the SM takes on a planned parent.
 *
 * Flow on GitHub: intake decomposes a big issue into stories.json entries; the
 * post-action creates them as sub-issues of the issue (stories of a new epic as
 * sub-issues of that epic), records the blockedBy ordering in a plan comment and
 * labels every parent `plannedLabel`. From then on the SM rule plan-advance
 * (localAction advance_plan) starts the sub-issues whose blockers are closed,
 * at most `maxParallel` at a time, by adding the dev label, and closes the
 * parent when every sub-issue is closed.
 *
 * Pure functions only — no tracker or tool calls.
 *
 * Project override (.dmtools/config.js), per-agent override (customParams):
 *   issuePlanning: {
 *     devLabel:     'agent:dev',   // label that starts the dev leg of an issue
 *     devAssignee:  null,          // optional assignee login (e.g. 'ai-teammate') when starting a sub-issue
 *     plannedLabel: 'ai_planned',  // marks a parent whose sub-issues are sequenced
 *     maxParallel:  1              // sub-issues of one parent in development at once
 *   }
 */

var DEFAULTS = {
    devLabel: 'agent:dev',
    devAssignee: null,
    plannedLabel: 'ai_planned',
    maxParallel: 1
};

var PLAN_MARKER_PREFIX = '<!-- dmtools:issue-plan ';
var ITEM_MARKER_PREFIX = '<!-- dmtools:intake-item ';
var MARKER_SUFFIX = ' -->';

function positiveInt(value) {
    var n = typeof value === 'string' ? parseInt(value, 10) : value;
    if (typeof n !== 'number' || !isFinite(n)) return null;
    n = Math.floor(n);
    return n > 0 ? n : null;
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// The issuePlanning block of a project config or of customParams ({} when absent).
function issuePlanningOf(source) {
    return (source && source.issuePlanning) || {};
}

// One override layer over cfg: a valid value replaces the current one, an invalid one is ignored.
function applyPlanningLayer(cfg, layer) {
    var devLabel = nonEmptyString(layer.devLabel);
    var devAssignee = nonEmptyString(layer.devAssignee);
    var plannedLabel = nonEmptyString(layer.plannedLabel);
    var maxParallel = positiveInt(layer.maxParallel);
    if (devLabel) cfg.devLabel = devLabel;
    if (devAssignee) cfg.devAssignee = devAssignee;
    if (plannedLabel) cfg.plannedLabel = plannedLabel;
    if (maxParallel) cfg.maxParallel = maxParallel;
    return cfg;
}

/**
 * Merge the defaults with the project config and the per-agent customParams
 * (customParams win). Unknown or invalid values fall back to the default.
 *
 * @param {Object} projectConfig loaded .dmtools/config.js (may be null)
 * @param {Object} customParams  agent / job customParams (may be null)
 * @returns {{devLabel: string, devAssignee: (string|null), plannedLabel: string, maxParallel: number}}
 */
function resolvePlanningConfig(projectConfig, customParams) {
    var cfg = {
        devLabel: DEFAULTS.devLabel,
        devAssignee: DEFAULTS.devAssignee,
        plannedLabel: DEFAULTS.plannedLabel,
        maxParallel: DEFAULTS.maxParallel
    };
    applyPlanningLayer(cfg, issuePlanningOf(projectConfig));
    return applyPlanningLayer(cfg, issuePlanningOf(customParams));
}

/** Canonical form of a ticket key for comparisons. */
function sameRef(key) {
    return String(key == null ? '' : key).trim().toLowerCase();
}

/**
 * Short reference to a ticket for comments: '#12' for a GitHub issue
 * ('owner/repo#12', 'gh-12', '#12', 12), the key itself otherwise.
 */
function displayRef(key) {
    var k = String(key == null ? '' : key);
    var m = /#(\d+)$/.exec(k) || /^gh-(\d+)$/.exec(k) || /^(\d+)$/.exec(k);
    return m ? '#' + m[1] : k;
}

// The text between a marker prefix and the marker end, or null.
function markerPayload(text, prefix, fromEnd) {
    var s = String(text == null ? '' : text);
    var start = fromEnd ? s.lastIndexOf(prefix) : s.indexOf(prefix);
    if (start === -1) return null;
    var end = s.indexOf(MARKER_SUFFIX, start + prefix.length);
    return end === -1 ? null : s.substring(start + prefix.length, end).trim();
}

// ── intake item marker ────────────────────────────────────────────────────

/** Hidden marker naming the intake entry a sub-issue was created from. */
function itemMarker(itemId) {
    return ITEM_MARKER_PREFIX + String(itemId) + MARKER_SUFFIX;
}

/** The intake entry id a sub-issue body carries, or null. */
function itemIdOf(body) {
    return markerPayload(body, ITEM_MARKER_PREFIX, false) || null;
}

function sameTitle(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/**
 * The existing sub-issue that already stands for an intake entry: the one whose
 * marker names the entry, else the one with the same title. null when none.
 *
 * @param {Array<Object>} children flat sub-issue views ({key, title, description})
 * @param {string} itemId the entry id (its tempId, or its position)
 * @param {string} title  the entry summary
 */
function findExistingItem(children, itemId, title) {
    var list = Array.isArray(children) ? children : [];
    var byMarker = list.filter(function (c) { return itemIdOf(c.description) === String(itemId); });
    if (byMarker.length) return byMarker[0];
    var byTitle = list.filter(function (c) { return sameTitle(c.title, title); });
    return byTitle.length ? byTitle[0] : null;
}

// ── plan marker ───────────────────────────────────────────────────────────

/**
 * Hidden marker recording the ordering of a planned parent:
 *   blockedBy — keys that must be closed before any sub-issue of this parent starts;
 *   deps      — sub-issue key → keys that must be closed before it starts.
 */
function renderPlanMarker(plan) {
    var data = {
        blockedBy: (plan && plan.blockedBy) || [],
        deps: (plan && plan.deps) || {}
    };
    return PLAN_MARKER_PREFIX + JSON.stringify(data) + MARKER_SUFFIX;
}

/** The plan a comment body records, or null when it carries no (readable) plan marker. */
function parsePlanMarker(body) {
    var payload = markerPayload(body, PLAN_MARKER_PREFIX, true);
    if (payload === null) return null;
    try {
        var data = JSON.parse(payload);
        return {
            blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy : [],
            deps: data.deps && typeof data.deps === 'object' ? data.deps : {}
        };
    } catch (e) {
        return null;
    }
}

/**
 * The plan recorded on a parent: the marker of the LAST comment that carries
 * one (a re-run posts a newer plan). An empty plan when there is none.
 *
 * @param {Array<Object>} comments normalized comments ({body}) in creation order
 */
function findPlan(comments) {
    var list = Array.isArray(comments) ? comments : [];
    for (var i = list.length - 1; i >= 0; i--) {
        var plan = parsePlanMarker(list[i] && list[i].body);
        if (plan) return plan;
    }
    return { blockedBy: [], deps: {} };
}

/** The keys recorded as blockers of `key` in the plan. */
function blockersOf(plan, key) {
    var deps = (plan && plan.deps) || {};
    var wanted = sameRef(key);
    var match = Object.keys(deps).filter(function (k) { return sameRef(k) === wanted; })[0];
    return match && Array.isArray(deps[match]) ? deps[match] : [];
}

// ── next-step decision ────────────────────────────────────────────────────

function labelsOf(ticket) {
    if (!ticket) return [];
    if (Array.isArray(ticket.labels)) return ticket.labels;
    return (ticket.fields && Array.isArray(ticket.fields.labels)) ? ticket.fields.labels : [];
}

function hasLabel(ticket, label) {
    return labelsOf(ticket).indexOf(label) !== -1;
}

function isClosed(ticket) {
    var s = String((ticket && (ticket.status || ticket.state)) || '').toLowerCase();
    return s === 'closed' || s === 'done';
}

function allClosed(keys, isKeyClosed) {
    return keys.every(function (k) { return isKeyClosed(k); });
}

// Open leaf sub-issues already in development (carry the dev label).
function activeChildren(open, cfg) {
    return open.filter(function (c) { return hasLabel(c, cfg.devLabel); });
}

// Open leaf sub-issues not started yet whose recorded blockers are all closed, in plan order.
function readyChildren(open, plan, cfg, isKeyClosed) {
    return open.filter(function (c) {
        if (hasLabel(c, cfg.devLabel) || hasLabel(c, cfg.plannedLabel)) return false;
        return allClosed(blockersOf(plan, c.key), isKeyClosed);
    });
}

function parentBlockers(plan) {
    return (plan && plan.blockedBy) ? plan.blockedBy : [];
}

function pickStartBatch(open, plan, cfg, isKeyClosed) {
    var slots = cfg.maxParallel - activeChildren(open, cfg).length;
    if (slots <= 0) return [];
    return readyChildren(open, plan, cfg, isKeyClosed).slice(0, slots);
}

/**
 * The next step for a planned parent.
 *
 * A sub-issue that is itself planned (it carries plannedLabel — an epic with
 * its own sub-issues) is advanced by its own rule match: it never gets the dev
 * label and does not count against maxParallel here.
 *
 * @param {Array<Object>} children    the parent's sub-issues in order, flat views ({key, status, labels})
 * @param {Object}        plan        findPlan() result
 * @param {Object}        cfg         resolvePlanningConfig() result
 * @param {Function}      isKeyClosed key → true when that ticket is closed
 * @returns {{type: string, start: Array<Object>, total: number}}
 *   type 'empty'    — the parent has no sub-issues (nothing to do)
 *   type 'blocked'  — a blocker of the parent itself is still open
 *   type 'complete' — every sub-issue is closed: close the parent
 *   type 'wait'     — nothing can start now (all slots busy, or blockers open)
 *   type 'start'    — add the dev label to every sub-issue in `start`
 */
function decideNextSteps(children, plan, cfg, isKeyClosed) {
    var list = Array.isArray(children) ? children : [];
    if (list.length === 0) return { type: 'empty', start: [], total: 0 };
    if (!allClosed(parentBlockers(plan), isKeyClosed)) return { type: 'blocked', start: [], total: list.length };
    var open = list.filter(function (c) { return !isClosed(c); });
    if (open.length === 0) return { type: 'complete', start: [], total: list.length };
    var start = pickStartBatch(open, plan, cfg, isKeyClosed);
    return { type: start.length ? 'start' : 'wait', start: start, total: list.length };
}

/** The comment on the parent when the SM starts sub-issues. */
function renderStartComment(decision, cfg) {
    var detail = 'label `' + cfg.devLabel + '`' +
        (cfg && cfg.devAssignee ? ', assignee `' + cfg.devAssignee + '`' : '');
    return 'Starting ' + decision.start.map(function (c) { return displayRef(c.key); }).join(', ') +
        ' (' + detail + ').';
}

/** The comment on the parent when every sub-issue is closed. */
function renderCompleteComment(decision) {
    return 'All ' + decision.total + ' sub-issues of the plan are closed — closing this issue.';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULTS: DEFAULTS,
        resolvePlanningConfig: resolvePlanningConfig,
        sameRef: sameRef,
        displayRef: displayRef,
        itemMarker: itemMarker,
        itemIdOf: itemIdOf,
        findExistingItem: findExistingItem,
        renderPlanMarker: renderPlanMarker,
        parsePlanMarker: parsePlanMarker,
        findPlan: findPlan,
        blockersOf: blockersOf,
        isClosed: isClosed,
        decideNextSteps: decideNextSteps,
        renderStartComment: renderStartComment,
        renderCompleteComment: renderCompleteComment
    };
}
