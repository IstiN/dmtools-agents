/**
 * Shared Affected-Repositories section builders (gh-1250 dedup).
 *
 * Pure formatting helpers for the "Affected Repositories" block appended to
 * the solution field (writeSolutionAndLabels.js) and the Confluence page
 * (writeSolutionAndDiagrams.js, via the lazy require cycle-breaker). The
 * repo-table rows, the mermaid dependency graph and the JSON anchor appeared
 * identically in three formatters (Jira wiki, ADO markdown, Confluence
 * markdown) — the per-format differences are only the code-fence tokens, so
 * they live in the exported FENCES constants.
 *
 * GraalJS-compatible: var declarations, plain functions, no arrow functions.
 */

/** 'a, b' for non-empty depends_on, em-dash otherwise. */
function formatRepoDeps(r) {
    return (Array.isArray(r.depends_on) && r.depends_on.length > 0)
        ? r.depends_on.join(', ')
        : '\u2014';
}

/** GFM/wiki table rows: | # | name | reason | deps | */
function buildRepoTableRows(sorted) {
    var rows = [];
    sorted.forEach(function(r, idx) {
        rows.push('| ' + (idx + 1) + ' | ' + r.name + ' | ' + (r.reason || '') + ' | ' + formatRepoDeps(r) + ' |');
    });
    return rows;
}

/** Mermaid dependency edges ('    dep --> name'), in sorted order. */
function buildDependencyEdges(sorted) {
    var edges = [];
    sorted.forEach(function(r) {
        if (Array.isArray(r.depends_on)) {
            r.depends_on.forEach(function(dep) { edges.push('    ' + dep + ' --> ' + r.name); });
        }
    });
    return edges;
}

// Per-format code fences for the section body.
//   - jsonOpen/jsonClose are omitted for Confluence: the JSON anchor is a
//     tracker-field-only payload (createRepoTasks parses it back out of the
//     field), meaningless on a Confluence page.
var JIRA_FENCES = {
    mermaidOpen: '{code}',
    mermaidClose: '{code}',
    jsonOpen: '{code:json|title=affected_repos}',
    jsonClose: '{code}'
};

var MARKDOWN_FENCES = {
    mermaidOpen: '```mermaid',
    mermaidClose: '```',
    jsonOpen: '```json',
    jsonClose: '```'
};

var CONFLUENCE_FENCES = {
    mermaidOpen: '```mermaid',
    mermaidClose: '```'
};

/** Mermaid dependency graph block ('graph LR' + edges), only when there are edges. */
function appendMermaidEdges(lines, sorted, fenceOpen, fenceClose) {
    var edges = buildDependencyEdges(sorted);
    if (edges.length > 0) {
        lines.push('');
        lines.push(fenceOpen);
        lines.push('graph LR');
        edges.forEach(function(e) { lines.push(e); });
        lines.push(fenceClose);
    }
}

/** JSON anchor block: the machine-readable payload createRepoTasks parses. */
function appendJsonAnchor(lines, sorted, fenceOpen, fenceClose) {
    lines.push('');
    lines.push(fenceOpen);
    lines.push(JSON.stringify(sorted, null, 2));
    lines.push(fenceClose);
}

/**
 * Append the full section body for sorted repos to lines (in place): the repo
 * table rows, the mermaid dependency graph (only when there are edges) and,
 * unless fences.jsonOpen is absent (Confluence), the JSON anchor block.
 */
function appendSectionBody(lines, sorted, fences) {
    buildRepoTableRows(sorted).forEach(function(row) { lines.push(row); });
    appendMermaidEdges(lines, sorted, fences.mermaidOpen, fences.mermaidClose);
    if (fences.jsonOpen) {
        appendJsonAnchor(lines, sorted, fences.jsonOpen, fences.jsonClose);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatRepoDeps: formatRepoDeps,
        buildRepoTableRows: buildRepoTableRows,
        buildDependencyEdges: buildDependencyEdges,
        appendSectionBody: appendSectionBody,
        JIRA_FENCES: JIRA_FENCES,
        MARKDOWN_FENCES: MARKDOWN_FENCES,
        CONFLUENCE_FENCES: CONFLUENCE_FENCES
    };
}
