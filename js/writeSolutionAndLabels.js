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
const { JIRA_FIELDS } = require('./config.js');

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
// Formatter — Jira wiki markup
// ---------------------------------------------------------------------------

function buildJiraSection(sorted) {
    var lines = [];
    lines.push('----');
    lines.push('h2. Affected Repositories');
    lines.push('');
    lines.push('|| # || Repository || Reason || Depends On ||');

    sorted.forEach(function(r, idx) {
        var deps = (Array.isArray(r.depends_on) && r.depends_on.length > 0)
            ? r.depends_on.join(', ')
            : '\u2014';
        lines.push('| ' + (idx + 1) + ' | ' + r.name + ' | ' + (r.reason || '') + ' | ' + deps + ' |');
    });

    // Mermaid diagram (only when there are edges)
    var edges = [];
    sorted.forEach(function(r) {
        if (Array.isArray(r.depends_on)) {
            r.depends_on.forEach(function(dep) { edges.push('    ' + dep + ' --> ' + r.name); });
        }
    });
    if (edges.length > 0) {
        lines.push('');
        lines.push('{code:mermaid}');
        lines.push('graph LR');
        edges.forEach(function(e) { lines.push(e); });
        lines.push('{code}');
    }

    // JSON anchor for createRepoTasks script
    lines.push('');
    lines.push('{code:json|title=affected_repos}');
    lines.push(JSON.stringify(sorted, null, 2));
    lines.push('{code}');
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

    sorted.forEach(function(r, idx) {
        var deps = (Array.isArray(r.depends_on) && r.depends_on.length > 0)
            ? r.depends_on.join(', ')
            : '\u2014';
        lines.push('| ' + (idx + 1) + ' | ' + r.name + ' | ' + (r.reason || '') + ' | ' + deps + ' |');
    });

    var edges = [];
    sorted.forEach(function(r) {
        if (Array.isArray(r.depends_on)) {
            r.depends_on.forEach(function(dep) { edges.push('    ' + dep + ' --> ' + r.name); });
        }
    });
    if (edges.length > 0) {
        lines.push('');
        lines.push('```mermaid');
        lines.push('graph LR');
        edges.forEach(function(e) { lines.push(e); });
        lines.push('```');
    }

    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(sorted, null, 2));
    lines.push('```');
    lines.push('---');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tracker detection
// ---------------------------------------------------------------------------

function detectTrackerType() {
    try {
        var t = java.lang.System.getenv('DEFAULT_TRACKER');
        if (t) return t.toLowerCase().trim();
    } catch (e) { /* not in Java context (tests) */ }
    return 'jira';
}

// ---------------------------------------------------------------------------
// Main action
// ---------------------------------------------------------------------------

function action(params) {
    var result = base.action(params);
    if (!result.success) {
        return result;
    }

    var ticketKey = params.ticket && params.ticket.key;
    var customParams = params.customParams || (params.jobParams && params.jobParams.customParams) || {};
    var solutionField = customParams.solutionField || JIRA_FIELDS.SOLUTION;

    try {
        var reposJson = outputFiles.readOutputFile('affected_repos.json');
        if (reposJson) {
            var raw = JSON.parse(reposJson);
            if (Array.isArray(raw) && raw.length > 0) {
                var sorted = topologicalSort(raw);
                var trackerType = detectTrackerType();
                var section = (trackerType === 'ado')
                    ? buildMarkdownSection(sorted)
                    : buildJiraSection(sorted);

                // Append section to the solution field
                try {
                    var freshTicket = jira_get_ticket({ key: ticketKey, fields: [solutionField] });
                    var freshFields = freshTicket && (freshTicket.fields || freshTicket);
                    var existing = (freshFields && freshFields[solutionField]) || '';
                    jira_update_field({
                        key: ticketKey,
                        field: solutionField,
                        value: existing + '\n\n' + section
                    });
                    console.log('Appended affected repos section to "' + solutionField + '" for ' + ticketKey);
                } catch (fe) {
                    console.warn('Failed to append affected repos section:', fe);
                }

                // Add repo labels
                sorted.forEach(function(r) {
                    var label = (r.name || '').toString().trim();
                    if (label) {
                        try {
                            jira_add_label({ key: ticketKey, label: label });
                            console.log('Added repo label "' + label + '" to ' + ticketKey);
                        } catch (le) {
                            console.warn('Failed to add repo label "' + label + '":', le);
                        }
                    }
                });
            }
        }
    } catch (e) {
        console.warn('Failed to process affected_repos.json:', e);
    }

    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        topologicalSort: topologicalSort,
        buildJiraSection: buildJiraSection,
        buildMarkdownSection: buildMarkdownSection
    };
}
