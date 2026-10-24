/**
 * E2E Post-Action: Write Solution + Affected Repositories Section + Labels
 *
 * Extends writeSolutionAndDiagrams by:
 *   1. Running the base write-solution flow (response.md → ticket, diagram, assign, move)
 *   2. Appending a formatted Affected Repositories section to the solution field
 *      (human-readable table + mermaid dependency flow + JSON anchor for createRepoTasks)
 *   3. Labelling the ticket with each affected repository name
 *
 * Supports both Jira (wiki markup) and ADO (markdown) via DEFAULT_TRACKER env var.
 * outputs/affected_repos.json is optional — gracefully skipped if absent or empty.
 */

const base = require('./writeSolutionAndDiagrams.js');
const outputFiles = require('./common/outputFiles.js');
var trackersModule = require('./common/trackers.js');
var trackerFieldValue = require('./common/trackerFieldValue.js');
var affectedReposSection = require('./common/affectedReposSection.js');
const { JIRA_FIELDS } = require('./config.js');
var configLoader = null;
try { configLoader = require('./configLoader.js'); } catch (e) {}

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

function topologicalSort(repos) {
    var normalised = repos.map(function(r) {
        return typeof r === 'string' ? { name: r } : r;
    });
    var byName = {};
    normalised.forEach(function(r) { byName[r.name] = r; });

    var sorted = [];
    var visited = {};

    function visit(name) {
        if (visited[name]) return;
        visited[name] = true;
        var r = byName[name];
        if (r && Array.isArray(r.depends_on)) {
            r.depends_on.forEach(function(dep) { if (byName[dep]) visit(dep); });
        }
        if (r) sorted.push(r);
    }

    normalised.forEach(function(r) { visit(r.name); });
    return sorted;
}

// ---------------------------------------------------------------------------
// Shared section builders (pure) — used by the Jira/ADO/Confluence formatters
// ---------------------------------------------------------------------------

/** 'a, b' for non-empty depends_on, em-dash otherwise. (thin wrapper — shared impl in common/affectedReposSection.js) */
function formatRepoDeps(r) {
    return affectedReposSection.formatRepoDeps(r);
}

/** GFM/wiki table rows: | # | name | reason | deps | */
function buildRepoTableRows(sorted) {
    return affectedReposSection.buildRepoTableRows(sorted);
}

/** Mermaid dependency edges ('    dep --> name'), in sorted order. */
function buildDependencyEdges(sorted) {
    return affectedReposSection.buildDependencyEdges(sorted);
}

function buildJiraSection(sorted) {
    var lines = [];
    lines.push('----');
    lines.push('h2. Affected Repositories');
    lines.push('');
    lines.push('|| # || Repository || Reason || Depends On ||');
    affectedReposSection.appendSectionBody(lines, sorted, affectedReposSection.JIRA_FENCES);
    lines.push('----');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Formatter — ADO / Markdown
// ---------------------------------------------------------------------------

function buildMarkdownSection(sorted) {
    var lines = [];
    lines.push('---');
    lines.push('## Affected Repositories');
    lines.push('');
    lines.push('| # | Repository | Reason | Depends On |');
    lines.push('|---|---|---|---|');
    affectedReposSection.appendSectionBody(lines, sorted, affectedReposSection.MARKDOWN_FENCES);
    lines.push('---');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Formatter — Confluence markdown (no JSON anchor; that's tracker-field-only)
// ---------------------------------------------------------------------------

function buildConfluenceMarkdownSection(sorted) {
    var lines = [];
    lines.push('## Affected Repositories');
    lines.push('');
    lines.push('| # | Repository | Reason | Depends On |');
    lines.push('|---|---|');
    // Mermaid dependency diagram (only when there are edges) — a single, plain
    // (unfenced) diagram, consistent with instructions/common/diagram_output_contract.md.
    // The Confluence markdown→storage converter wraps it with the correct macro itself.
    affectedReposSection.appendSectionBody(lines, sorted, affectedReposSection.CONFLUENCE_FENCES);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tracker detection
// ---------------------------------------------------------------------------

function resolveProjectConfig(params) {
    return configLoader ? configLoader.loadProjectConfig(params) : null;
}

function _providerOfTracker(tracker) {
    if (!tracker || typeof tracker.provider !== 'function') return null;
    var p = tracker.provider();
    return p ? String(p).toLowerCase().trim() : null;
}

function detectTrackerType(tracker) {
    try {
        var t = java.lang.System.getenv('DEFAULT_TRACKER');
        if (t) return t.toLowerCase().trim();
    } catch (e) { /* not in Java context (tests) */ }
    return _providerOfTracker(tracker) || 'jira';
}

// ---------------------------------------------------------------------------
// gh-1187 CRAP split — small step helpers extracted from action()
// ---------------------------------------------------------------------------

/** Parse outputs/affected_repos.json and topologically sort it; null when absent/empty/non-array. */
function readSortedRepos() {
    var reposJson = outputFiles.readOutputFile('affected_repos.json');
    if (!reposJson) {
        return null;
    }
    var raw = JSON.parse(reposJson);
    if (!Array.isArray(raw) || raw.length === 0) {
        return null;
    }
    return topologicalSort(raw);
}

/** Ticket key / customParams / solution field of the append step. */
function resolveAppendContext(params) {
    var customParams = params.customParams || (params.jobParams && params.jobParams.customParams) || {};
    return {
        ticketKey: params.ticket && params.ticket.key,
        customParams: customParams,
        solutionField: customParams.solutionField || JIRA_FIELDS.SOLUTION
    };
}

/** Current value of the solution field, with the ADF guard. Empty string when absent/ADF. */
function currentFieldValue(tracker, ticketKey, solutionField) {
    var rawValue = trackerFieldValue.readRawFieldValue(tracker, ticketKey, solutionField);
    if (rawValue && typeof rawValue === 'object') {
        console.warn('Field "' + solutionField + '" is ADF — falling back to response.md as base');
        return '';
    }
    return rawValue ? rawValue.toString().trim() : '';
}

/**
 * Base text the repos section is appended to: the tracker field's current value
 * when readable and non-empty, otherwise outputs/response.md (empty when even
 * that is missing). Mirrors the historical fallback chain exactly.
 */
function resolveAppendBase(tracker, ticketKey, solutionField) {
    var existingBase = '';
    try {
        existingBase = currentFieldValue(tracker, ticketKey, solutionField);
    } catch (ge) {
        console.warn('Could not read current value of "' + solutionField + '" — falling back to response.md:', ge);
    }
    if (existingBase) {
        console.log('Using current Jira field as base (' + existingBase.length + ' chars)');
        return existingBase;
    }
    var fallback = outputFiles.readOutputFile('response.md');
    existingBase = fallback ? fallback.trim() : '';
    console.log('Using response.md as fallback base (' + existingBase.length + ' chars)');
    return existingBase;
}

/** Append base + section to the field. Non-fatal: a failed write is logged. */
function appendReposSectionQuietly(tracker, ticketKey, solutionField, section) {
    try {
        var existingBase = resolveAppendBase(tracker, ticketKey, solutionField);
        tracker.updateField(ticketKey, solutionField, existingBase + '\n\n' + section);
        console.log('Appended affected repos section to "' + solutionField + '" for ' + ticketKey);
    } catch (fe) {
        console.warn('Failed to append affected repos section:', fe);
    }
}

/** One label per repo name (trimmed); blank names skipped, failures non-fatal. */
function addRepoLabelsQuietly(tracker, ticketKey, sorted) {
    sorted.forEach(function(r) {
        var label = (r.name || '').toString().trim();
        if (!label) {
            return;
        }
        try {
            tracker.addLabel(ticketKey, label);
            console.log('Added repo label "' + label + '" to ' + ticketKey);
        } catch (le) {
            console.warn('Failed to add repo label "' + label + '":', le);
        }
    });
}

/**
 * Everything base.action() success adds: the Affected Repositories section on
 * the solution field plus one label per affected repo. Invalid repos payloads
 * throw up to the caller's non-fatal catch (same as the original inline flow).
 */
function applyAffectedRepos(params) {
    var ctx = resolveAppendContext(params);

    var sorted = readSortedRepos();
    if (!sorted) {
        return;
    }
    var tracker = trackersModule.createTracker(resolveProjectConfig(params), ctx.customParams);
    var trackerType = detectTrackerType(tracker);
    var section = (trackerType === 'ado')
        ? buildMarkdownSection(sorted)
        : buildJiraSection(sorted);

    appendReposSectionQuietly(tracker, ctx.ticketKey, ctx.solutionField, section);
    addRepoLabelsQuietly(tracker, ctx.ticketKey, sorted);
}

// ---------------------------------------------------------------------------
// Main action
// ---------------------------------------------------------------------------

function action(params) {
    var result = base.action(params);
    if (!result.success) {
        return result;
    }

    try {
        applyAffectedRepos(params);
    } catch (e) {
        console.warn('Failed to process affected_repos.json:', e);
    }

    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        topologicalSort: topologicalSort,
        formatRepoDeps: formatRepoDeps,
        buildRepoTableRows: buildRepoTableRows,
        buildDependencyEdges: buildDependencyEdges,
        buildJiraSection: buildJiraSection,
        buildMarkdownSection: buildMarkdownSection,
        buildConfluenceMarkdownSection: buildConfluenceMarkdownSection,
        readSortedRepos: readSortedRepos,
        resolveAppendContext: resolveAppendContext,
        currentFieldValue: currentFieldValue,
        resolveAppendBase: resolveAppendBase,
        appendReposSectionQuietly: appendReposSectionQuietly,
        addRepoLabelsQuietly: addRepoLabelsQuietly,
        applyAffectedRepos: applyAffectedRepos
    };
}
