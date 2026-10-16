/**
 * Issue planning contract — the single owner of everything the issue_planning
 * agent and the SM plan sequencer must agree on:
 *
 *   - the planning knobs (labels, child cap, plan file) and their defaults;
 *   - the outputs/plan.json shape the CLI agent writes and how it is validated;
 *   - how a child issue body names its parent and its place in the plan;
 *   - the sequential next-step decision the SM takes on a planned parent.
 *
 * Flow: a big issue gets the issue_planning leg. The agent either keeps it whole
 * (split:false → the post-action adds the dev label, development starts as usual)
 * or splits it into ordered children (split:true → createPlannedSubIssues.js
 * creates them as sub-issues of the parent and labels the parent `plannedLabel`).
 * From then on the SM rule plan-advance (localAction advance_plan) starts ONE
 * child at a time: it adds the dev label to the first open child once every
 * earlier child is closed, and closes the parent when every child is closed.
 *
 * Pure functions only — no tracker or tool calls — so the post-action and the
 * SM share one tested decision core.
 *
 * Project override (.dmtools/config.js), per-agent override (customParams):
 *   issuePlanning: {
 *     devLabel:     'agent:dev',          // label that starts the dev leg of an issue
 *     plannedLabel: 'ai_planned',         // marks a parent whose children are created
 *     maxChildren:  8,                    // a plan with more children is rejected
 *     planFile:     'outputs/plan.json'   // where the CLI agent writes the plan
 *   }
 */

var DEFAULTS = {
    devLabel: 'agent:dev',
    plannedLabel: 'ai_planned',
    maxChildren: 8,
    planFile: 'outputs/plan.json'
};

// Hidden marker on the plan summary comment, so a reader (or a later tool) can
// find the comment that lists the children without parsing prose.
var PLAN_MARKER = '<!-- dmtools:issue-plan -->';

var MAX_TITLE_LENGTH = 256;

function positiveInt(value) {
    var n = typeof value === 'string' ? parseInt(value, 10) : value;
    if (typeof n !== 'number' || !isFinite(n)) return null;
    n = Math.floor(n);
    return n > 0 ? n : null;
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Merge the defaults with the project config and the per-agent customParams
 * (customParams win). Unknown or invalid values fall back to the default.
 *
 * @param {Object} projectConfig loaded .dmtools/config.js (may be null)
 * @param {Object} customParams  agent / job customParams (may be null)
 * @returns {{devLabel: string, plannedLabel: string, maxChildren: number, planFile: string}}
 */
function resolvePlanningConfig(projectConfig, customParams) {
    var layers = [
        (projectConfig && projectConfig.issuePlanning) || {},
        (customParams && customParams.issuePlanning) || {}
    ];
    var cfg = {
        devLabel: DEFAULTS.devLabel,
        plannedLabel: DEFAULTS.plannedLabel,
        maxChildren: DEFAULTS.maxChildren,
        planFile: DEFAULTS.planFile
    };
    layers.forEach(function (layer) {
        if (nonEmptyString(layer.devLabel)) cfg.devLabel = nonEmptyString(layer.devLabel);
        if (nonEmptyString(layer.plannedLabel)) cfg.plannedLabel = nonEmptyString(layer.plannedLabel);
        if (positiveInt(layer.maxChildren)) cfg.maxChildren = positiveInt(layer.maxChildren);
        if (nonEmptyString(layer.planFile)) cfg.planFile = nonEmptyString(layer.planFile);
    });
    return cfg;
}

/**
 * Parse and validate the plan the CLI agent wrote.
 *
 *   { "split": false, "reason": "..." }
 *   { "split": true,  "reason": "...",
 *     "children": [ { "title": "...", "bodyFile": "outputs/plan/1.md" }, ... ] }
 *
 * A child carries its description in `bodyFile` (preferred: large text stays
 * out of the JSON) or inline in `body`. Children are kept in the given order —
 * that order IS the delivery sequence.
 *
 * @param {string}   raw      content of the plan file ('' when missing)
 * @param {Function} readFile path → text ('' when missing), for bodyFile
 * @param {Object}   cfg      resolvePlanningConfig() result
 * @returns {{ok: boolean, error: (string|undefined), split: boolean, reason: string,
 *            children: Array<{title: string, body: string}>}}
 */
function parsePlan(raw, readFile, cfg) {
    var fail = function (error) {
        return { ok: false, error: error, split: false, reason: '', children: [] };
    };
    if (!nonEmptyString(raw)) return fail(cfg.planFile + ' is missing or empty');

    var plan;
    try {
        plan = JSON.parse(raw);
    } catch (e) {
        return fail(cfg.planFile + ' is not valid JSON: ' + e);
    }
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return fail(cfg.planFile + ' must be a JSON object');
    }
    if (typeof plan.split !== 'boolean') {
        return fail(cfg.planFile + ': "split" must be true or false');
    }
    var reason = nonEmptyString(plan.reason) || '';
    if (!plan.split) {
        return { ok: true, split: false, reason: reason, children: [] };
    }

    if (!Array.isArray(plan.children)) {
        return fail(cfg.planFile + ': "children" must be an array when split is true');
    }
    if (plan.children.length < 2) {
        return fail(cfg.planFile + ': a split needs at least 2 children, got ' + plan.children.length +
            ' (use split:false to keep the issue whole)');
    }
    if (plan.children.length > cfg.maxChildren) {
        return fail(cfg.planFile + ': ' + plan.children.length + ' children exceed the limit of ' +
            cfg.maxChildren + ' (issuePlanning.maxChildren)');
    }

    var children = [];
    for (var i = 0; i < plan.children.length; i++) {
        var c = plan.children[i] || {};
        var title = nonEmptyString(c.title);
        if (!title) return fail(cfg.planFile + ': child ' + (i + 1) + ' has no title');
        if (title.length > MAX_TITLE_LENGTH) {
            return fail(cfg.planFile + ': child ' + (i + 1) + ' title is longer than ' + MAX_TITLE_LENGTH + ' characters');
        }
        var body = null;
        if (nonEmptyString(c.bodyFile)) {
            body = nonEmptyString(readFile(c.bodyFile));
            if (!body) return fail(cfg.planFile + ': child ' + (i + 1) + ' bodyFile ' + c.bodyFile + ' is missing or empty');
        } else {
            body = nonEmptyString(c.body);
        }
        if (!body) return fail(cfg.planFile + ': child ' + (i + 1) + ' has neither bodyFile nor body');
        children.push({ title: title, body: body });
    }
    return { ok: true, split: true, reason: reason, children: children };
}

/**
 * Short reference to a ticket for comments and child bodies: '#12' for a
 * GitHub issue ('owner/repo#12', 'gh-12', '#12', 12), the key itself otherwise.
 */
function displayRef(key) {
    var k = String(key == null ? '' : key);
    var m = /#(\d+)$/.exec(k) || /^gh-(\d+)$/.exec(k) || /^(\d+)$/.exec(k);
    return m ? '#' + m[1] : k;
}

/** The description of child `index` (1-based) of `total`: parent link, place in the plan, then the agent's body. */
function renderChildBody(parentKey, index, total, body) {
    return 'Part of ' + displayRef(parentKey) + ' — step ' + index + ' of ' + total +
        ' of a sequential plan. The steps are delivered one at a time, in order.\n\n' + body;
}

/** The comment on the parent listing the created children in delivery order. */
function renderPlanComment(childKeys, reason, cfg) {
    var lines = [PLAN_MARKER, '**Plan: ' + childKeys.length + ' steps, delivered one at a time.**', ''];
    if (reason) lines.push(reason, '');
    childKeys.forEach(function (k, i) {
        lines.push((i + 1) + '. ' + displayRef(k));
    });
    lines.push('', 'Each step starts when the previous one is closed (label `' + cfg.devLabel +
        '` on the next step). This issue closes when every step is closed.');
    return lines.join('\n');
}

function labelsOf(ticket) {
    if (!ticket) return [];
    if (Array.isArray(ticket.labels)) return ticket.labels;
    return (ticket.fields && Array.isArray(ticket.fields.labels)) ? ticket.fields.labels : [];
}

function isClosed(ticket) {
    var s = String((ticket && (ticket.status || ticket.state)) || '').toLowerCase();
    return s === 'closed' || s === 'done';
}

/**
 * The sequential next step for a planned parent.
 *
 * @param {Array<Object>} children the parent's children in plan order, flat tracker
 *        views ({key, status|state, labels})
 * @param {Object} cfg resolvePlanningConfig() result
 * @returns {{type: string, child: (Object|undefined), index: (number|undefined), total: number}}
 *   type 'empty'    — the parent has no children (a broken plan; nothing to do)
 *   type 'complete' — every child is closed: close the parent
 *   type 'wait'     — the first open child is already started (carries devLabel)
 *   type 'start'    — the first open child is not started yet: add devLabel to it
 *   index is 1-based.
 */
function decideNextStep(children, cfg) {
    var list = Array.isArray(children) ? children : [];
    if (list.length === 0) return { type: 'empty', total: 0 };
    for (var i = 0; i < list.length; i++) {
        if (isClosed(list[i])) continue;
        var started = labelsOf(list[i]).indexOf(cfg.devLabel) !== -1;
        return { type: started ? 'wait' : 'start', child: list[i], index: i + 1, total: list.length };
    }
    return { type: 'complete', total: list.length };
}

/** The comment on the parent when the SM starts a step. */
function renderStepComment(step, cfg) {
    return 'Step ' + step.index + ' of ' + step.total + ': starting ' + displayRef(step.child.key) +
        ' (label `' + cfg.devLabel + '`).';
}

/** The comment on the parent when every step is closed. */
function renderCompleteComment(step) {
    return 'All ' + step.total + ' steps of the plan are closed — closing this issue.';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULTS: DEFAULTS,
        PLAN_MARKER: PLAN_MARKER,
        resolvePlanningConfig: resolvePlanningConfig,
        parsePlan: parsePlan,
        displayRef: displayRef,
        renderChildBody: renderChildBody,
        renderPlanComment: renderPlanComment,
        decideNextStep: decideNextStep,
        renderStepComment: renderStepComment,
        renderCompleteComment: renderCompleteComment
    };
}
