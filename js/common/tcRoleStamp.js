/**
 * tcRoleStamp.js — the gh-1345 mechanical TC role stamping.
 *
 * gh-1329 made TC failure attribution mechanical, but the role marker
 * (`Verifies: <BUG-KEY>` / `Regression guard: <scope>`) was still written by
 * the generating agent into the TC description as guidance-only prose — an
 * unmarked TC silently defaults to own-oracle and the triage inherits the
 * agent's memory. This module makes the stamp mechanical end to end:
 *
 *   Stamp       the TC-generator leg's post-action (stampTcRoles.js) plans a
 *               marker for every created TC whose description carries none;
 *               already-marked TCs keep their prose (never re-stamped).
 *
 *   Plan        exactly ONE oracle per bug: among the unmarked linked TCs the
 *               LOWEST key becomes the bug's own oracle (`Verifies: <BUG>`) —
 *               the mandatory regression test is rule-listed first and the
 *               generator creates in order — every other unmarked TC becomes
 *               `Regression guard: <scope>` (scope = the bug summary, the
 *               pinned behavior it protects).
 *
 *   Read        the automation setup leg parses the stamped first line back
 *               into structured role fields (role / verifies /
 *               regressionGuard) — the automation leg reads the machine
 *               stamp, never agent prose.
 *
 * Pure module — no dmtools globals, GraalJS-clean (var + plain functions,
 * JSON-safe data).
 */
'use strict';

var VERIFIES_PREFIX = 'Verifies:';
var GUARD_PREFIX = 'Regression guard:';

// The first non-empty line is the role line (the creation rules pin the
// marker there; a marker below other prose is prose, not a stamp).
var VERIFIES_RE = /^verifies:\s*(\S+)\s*$/i;
var GUARD_RE = /^regression guard:\s*(.+?)\s*$/i;

function firstNonEmptyLine(description) {
    var lines = String(description || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line) return line;
    }
    return '';
}

/**
 * Parses the role marker from a TC description.
 * Returns { kind: 'verifies'|'guard', key, scope, line } or null when the
 * first non-empty line carries no marker.
 */
function parseRoleMarker(description) {
    var line = firstNonEmptyLine(description);
    if (!line) return null;
    var m = VERIFIES_RE.exec(line);
    if (m) return { kind: 'verifies', key: m[1], scope: null, line: line };
    m = GUARD_RE.exec(line);
    if (m) return { kind: 'guard', key: null, scope: m[1], line: line };
    return null;
}

function numericKey(key) {
    var m = /(\d+)\s*$/.exec(String(key || ''));
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

function descriptionOf(tc) {
    return (tc && tc.fields && tc.fields.description) || (tc && tc.description) || '';
}

function tcKeyOf(tc) {
    return String((tc && tc.key) || '');
}

/**
 * The mechanical stamp plan for a set of linked TCs of one bug.
 * Returns [{ tcKey, marker }] for exactly the TCs that need a stamp.
 *
 * Rules (see the module header): already-marked TCs are skipped; an existing
 * oracle marking THIS bug suppresses the oracle election; otherwise the
 * lowest-key unmarked TC becomes the oracle and the rest become guards with
 * the bug summary as scope (falling back to the bug key).
 */
function stampPlan(tcs, bugKey, bugSummary) {
    var list = Array.isArray(tcs) ? tcs : [];
    var hasOracle = false;
    list.forEach(function(tc) {
        var marker = parseRoleMarker(descriptionOf(tc));
        if (marker && marker.kind === 'verifies' &&
            String(marker.key).toLowerCase() === String(bugKey || '').toLowerCase()) {
            hasOracle = true;
        }
    });

    var scope = String(bugSummary || '').trim() || String(bugKey || '');
    var unmarked = list.filter(function(tc) { return !parseRoleMarker(descriptionOf(tc)); });
    unmarked.sort(function(a, b) {
        var d = numericKey(tcKeyOf(a)) - numericKey(tcKeyOf(b));
        return d !== 0 ? d : (tcKeyOf(a) < tcKeyOf(b) ? -1 : 1);
    });

    var plan = [];
    unmarked.forEach(function(tc) {
        if (!hasOracle) {
            plan.push({ tcKey: tcKeyOf(tc), marker: VERIFIES_PREFIX + ' ' + bugKey });
            hasOracle = true;
        } else {
            plan.push({ tcKey: tcKeyOf(tc), marker: GUARD_PREFIX + ' ' + scope });
        }
    });
    return plan;
}

/**
 * Prepends the marker as the FIRST description line (the creation-rule
 * contract). Idempotent: a description that already starts with the marker
 * is returned unchanged.
 */
function stampedDescription(description, marker) {
    var original = String(description || '');
    if (firstNonEmptyLine(original).toLowerCase() === String(marker || '').toLowerCase()) {
        return original;
    }
    return marker + '\n\n' + original;
}

/**
 * The automation leg's structured reading of a stamped description:
 * { role, verifies, regressionGuard } fields shaped for the triage's
 * resolveTcRole — or {} when the description carries no marker (the
 * legacy-safe own-oracle fallback stays with the triage engine).
 */
function roleFieldsFromDescription(description, bugKey) {
    var marker = parseRoleMarker(description);
    if (!marker) return {};
    if (marker.kind === 'verifies') {
        return { role: 'verifies', verifies: marker.key };
    }
    return { role: 'regression guard', regressionGuard: true };
}

/**
 * Annotates linked-TC entries with the structured role fields read from
 * their (stamped) descriptions. Entries without a marker pass through
 * untouched; null entries are preserved.
 */
function annotateWithRoles(tcs, bugKey) {
    var list = Array.isArray(tcs) ? tcs : [];
    return list.map(function(tc) {
        if (!tc) return tc;
        var fields = roleFieldsFromDescription(
            (tc.fields && tc.fields.description) || tc.description || '', bugKey);
        if (!fields.role) return tc;
        var out = Object.assign({}, tc);
        Object.keys(fields).forEach(function(k) { out[k] = fields[k]; });
        return out;
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VERIFIES_PREFIX: VERIFIES_PREFIX,
        GUARD_PREFIX: GUARD_PREFIX,
        parseRoleMarker: parseRoleMarker,
        stampPlan: stampPlan,
        stampedDescription: stampedDescription,
        roleFieldsFromDescription: roleFieldsFromDescription,
        annotateWithRoles: annotateWithRoles
    };
}
