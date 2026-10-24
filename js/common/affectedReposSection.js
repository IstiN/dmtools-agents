/**
 * Shared Affected-Repositories section builders (gh-1250 dedup).
 *
 * Pure formatting helpers for the "Affected Repositories" block appended to
 * the solution field (writeSolutionAndLabels.js) and the Confluence page
 * (writeSolutionAndDiagrams.js, via the lazy require cycle-breaker). The
 * repo-table rows and the mermaid dependency graph appeared identically in
 * three formatters (Jira wiki, ADO markdown, Confluence markdown) — the
 * per-format differences are only the fence tokens, so they are parameters.
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

/** Append the repo table rows for sorted repos to lines (in place). */
function appendRepoTableRows(lines, sorted) {
    buildRepoTableRows(sorted).forEach(function(row) { lines.push(row); });
}

/**
 * Append the mermaid dependency graph for sorted repos to lines (in place).
 * The whole block is skipped when there are no edges. fenceOpen/fenceClose
 * are the per-format code fences: jira '{code}'/'{code}', markdown
 * '```mermaid'/'```'.
 */
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatRepoDeps: formatRepoDeps,
        buildRepoTableRows: buildRepoTableRows,
        buildDependencyEdges: buildDependencyEdges,
        appendRepoTableRows: appendRepoTableRows,
        appendMermaidEdges: appendMermaidEdges
    };
}
