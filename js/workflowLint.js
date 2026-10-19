/**
 * Minimal workflow-file lint — trigger extraction + duplicate-key detection.
 *
 * Guards the gh-676 incident class: while .github/workflows/ai-teammate.yml
 * was unparseable (#669 merge residue — duplicate permission keys, fixed in
 * #671), GitHub kept a stale push-event registration, so every machine-sm
 * state-publish push to `factory-data` spawned an instant-fail event=push
 * run with zero jobs. Two invariants keep that class dead:
 *
 *   1. The AI Teammate stub declares EXACTLY its intended triggers
 *      (issues + workflow_dispatch — no push).
 *   2. No committed workflow contains duplicate mapping keys (YAML hard
 *      error → unparseable stretch → phantom registrations).
 *
 * This module is a deliberately small, dependency-free, indent-aware YAML
 * scanner — enough for workflow-shaped files, not a general YAML parser.
 * Pure functions only: no dmtools globals, safe to load anywhere.
 *
 * GraalJS constraints apply (var / plain functions, no Node APIs).
 */

// A mapping-key line: optional "- " list marker, a key, then a colon.
// The key may be quoted; '#', ':' cannot appear unquoted inside it.
var KEY_LINE_RE = /^(-[ \t]+)?("[^"]*"|'[^']*'|[^:#]+?)[ \t]*:([ \t].*)?$/;

// A block scalar introducer: value ends with | or > plus optional +/-/digit.
var BLOCK_SCALAR_RE = /^[|>][0-9]*[+-]?$/;

function indentOf(line) {
    var m = /^[ \t]*/.exec(line);
    return m ? m[0].length : 0;
}

function unquote(key) {
    if (key.length >= 2) {
        var q = key.charAt(0);
        if ((q === '"' || q === "'") && key.charAt(key.length - 1) === q) {
            return key.slice(1, -1);
        }
    }
    return key;
}

// Parse the inline `[a, b, ...]` payload of a flow list, dropping comments
// and blank entries, unquoting each item.
function flowItems(inline) {
    var flow = inline.replace(/^\[[ \t]*/, '').replace(/[ \t]*\].*$/, '');
    var parts = flow === '' ? [] : flow.split(',');
    var out = [];
    for (var k = 0; k < parts.length; k++) {
        var item = parts[k].replace(/[ \t]+#.*$/, '').trim();
        if (item !== '') {
            out.push(unquote(item));
        }
    }
    return out;
}

/**
 * Top-level event triggers of a workflow file: ['issues', 'workflow_dispatch'].
 * Handles the block form (on:\n  issues:) and the flow list form
 * (on: [push, ...]); nested trigger options (types, inputs, cron) never
 * leak into the result. Returns [] when the file has no on: block.
 */
function extractTriggers(text) {
    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var m = /^on:[ \t]*(.*)$/.exec(lines[i]);
        if (!m) {
            continue;
        }
        var inline = m[1].replace(/[ \t]+#.*$/, '').trim();
        if (inline === '') {
            // Block form: trigger names are the keys at the first indent
            // level under `on:`; dedent to column 0 ends the block.
            var triggers = [];
            var childIndent = -1;
            for (var j = i + 1; j < lines.length; j++) {
                var line = lines[j];
                if (line.trim() === '') {
                    continue;
                }
                var indent = indentOf(line);
                if (indent === 0) {
                    break;
                }
                var km = KEY_LINE_RE.exec(line.trim());
                if (!km) {
                    continue;
                }
                if (childIndent === -1) {
                    childIndent = indent;
                }
                if (indent === childIndent) {
                    triggers.push(unquote(km[2].trim()));
                }
            }
            return triggers;
        }
        if (inline.charAt(0) === '[') {
            return flowItems(inline);
        }
        return [inline]; // flow mapping form — report as one opaque entry
    }
    return [];
}

/**
 * The `types:` list of the `issues:` trigger, e.g. ['assigned'] (gh-1076:
 * the ai-teammate stub must fire on assigned ONLY — the labeled trigger
 * re-fired the workflow on the factory's own consequence labels). Parses
 * the flow form (types: [assigned, labeled]) and the block list form
 * (types:\n      - assigned). Returns null when the file has no issues
 * trigger, the issues trigger declares no types key, or `on:` is in the
 * flow-list form (no per-trigger options there).
 */
function extractIssueTypes(text) {
    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var m = /^on:[ \t]*(.*)$/.exec(lines[i]);
        if (!m) {
            continue;
        }
        if (m[1].replace(/[ \t]+#.*$/, '').trim() !== '') {
            continue; // flow form — no per-trigger options to read
        }
        // Block form: locate the `issues:` key at the trigger indent.
        var childIndent = -1;
        for (var j = i + 1; j < lines.length; j++) {
            var line = lines[j];
            if (line.trim() === '') {
                continue;
            }
            if (line.trim().charAt(0) === '#') {
                continue;
            }
            var indent = indentOf(line);
            if (indent === 0) {
                break;
            }
            var km = KEY_LINE_RE.exec(line.trim());
            if (!km) {
                continue;
            }
            if (childIndent === -1) {
                childIndent = indent;
            }
            if (indent !== childIndent) {
                continue;
            }
            if (unquote(km[2].trim()) !== 'issues') {
                continue;
            }
            // Inside the issues: block — the first `types:` key at its own
            // indent level; a dedent back to the issues level ends the scan.
            var typesIndent = -1;
            for (var k = j + 1; k < lines.length; k++) {
                var tl = lines[k];
                if (tl.trim() === '') {
                    continue;
                }
                if (tl.trim().charAt(0) === '#') {
                    continue;
                }
                var ti = indentOf(tl);
                if (ti <= indent) {
                    break;
                }
                var tkm = KEY_LINE_RE.exec(tl.trim());
                if (!tkm) {
                    continue;
                }
                if (typesIndent === -1) {
                    typesIndent = ti;
                }
                if (ti !== typesIndent) {
                    continue;
                }
                if (unquote(tkm[2].trim()) !== 'types') {
                    continue;
                }
                var inline = (tkm[3] || '').replace(/[ \t]+#.*$/, '').trim();
                if (inline.charAt(0) === '[') {
                    return flowItems(inline);
                }
                // Block list form: `- item` entries deeper than types:.
                var items = [];
                for (var q = k + 1; q < lines.length; q++) {
                    var ql = lines[q];
                    if (ql.trim() === '') {
                        continue;
                    }
                    var qi = indentOf(ql);
                    if (qi <= ti) {
                        break;
                    }
                    var qm = /^-[ \t]+(.*?)[ \t]*$/.exec(ql.trim());
                    if (qm) {
                        items.push(unquote(qm[1].replace(/[ \t]+#.*$/, '').trim()));
                    }
                }
                return items;
            }
            return null; // issues: block without a types: key
        }
        return null; // no issues: trigger
    }
    return null;
}

/**
 * Duplicate mapping keys within the same mapping, as [{key, line}] entries
 * (one per extra occurrence, `line` = 1-based line of the duplicate).
 * Tolerances that keep this a lint and not a false-positive machine:
 *   - list items start a fresh mapping (two steps may both use `name:`);
 *   - block-scalar content (run: |, run-name: >-) is never parsed as keys;
 *   - full-line comments and blank lines are ignored.
 */
function findDuplicateKeys(text) {
    var lines = String(text).split(/\r?\n/);
    // Frames of open mappings: { indent, keys }. A key at indent I pops
    // every frame with indent >= I, then records itself in the parent.
    var stack = [];
    var dups = [];
    var scalarIndent = -1; // >= 0 while inside a block scalar keyed at that indent

    for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        if (raw.trim() === '') {
            continue; // blanks never end a block scalar
        }
        var indent = indentOf(raw);
        if (scalarIndent >= 0) {
            if (indent > scalarIndent) {
                continue; // scalar content — not YAML structure
            }
            scalarIndent = -1; // dedent ends the scalar
        }
        var content = raw.slice(indent);
        if (content.charAt(0) === '#') {
            continue;
        }
        if (content === '---' || content === '...') {
            stack = [];
            continue;
        }
        var m = KEY_LINE_RE.exec(content);
        if (!m) {
            continue; // scalar list entries like "- main" carry no keys
        }
        var isListItem = !!m[1];
        var key = unquote(m[2].trim());
        if (isListItem) {
            // Fresh mapping per item: pop the previous item's frame.
            // Frame indent I+1 sits between the "- " column and the
            // item's continuation keys at I+2.
            while (stack.length && stack[stack.length - 1].indent >= indent + 1) {
                stack.pop();
            }
            stack.push({ indent: indent + 1, keys: {} });
        } else {
            while (stack.length && stack[stack.length - 1].indent >= indent) {
                stack.pop();
            }
            if (stack.length) {
                var parent = stack[stack.length - 1];
                if (parent.keys[key]) {
                    dups.push({ key: key, line: i + 1 });
                } else {
                    parent.keys[key] = true;
                }
            }
            // Frame for this key's potential children.
            stack.push({ indent: indent, keys: {} });
        }
        // Block scalar: every deeper line belongs to the value.
        if (m[3] && BLOCK_SCALAR_RE.test(m[3].trim())) {
            scalarIndent = indent;
        }
    }
    return dups;
}

module.exports = {
    extractTriggers: extractTriggers,
    extractIssueTypes: extractIssueTypes,
    findDuplicateKeys: findDuplicateKeys
};
