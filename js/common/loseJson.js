/**
 * loseJson.js — lenient JSON coercion helpers shared across the runtime
 * modules (gh-1248 dedup): `parseJsonLose` parses a string and hands the
 * ORIGINAL string back on parse failure (never throws); `toArrayLose`
 * coerces a parsed envelope (listField / extra list fields / bare array /
 * single object) into a plain array.
 *
 * Pure module — no dmtools globals. GraalJS-clean (var + plain functions,
 * JSON-safe data only).
 */
'use strict';

/**
 * JSON.parse that never throws: a non-string input rides through as-is, a
 * broken string comes back unchanged (callers treat it as raw data).
 */
function parseJsonLose(raw) {
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
}

/**
 * The shared envelope-flattening head every `_toArray` copy carried:
 *   Array            → itself
 *   { value: [...] } → value        (REST list envelopes, all callers)
 *   { <f>: [...] }   → first extra list field present (caller-specific)
 *   anything else    → [parsed] or [] when null/undefined
 *
 * @param {*} raw           raw tool answer (string or parsed)
 * @param {string[]} fields caller-specific list fields beyond `value`
 * @returns {Array} the flattened list
 */
function toArrayLose(raw, fields) {
    var parsed = parseJsonLose(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && parsed.value) return parsed.value;
    for (var i = 0; i < (fields || []).length; i++) {
        if (parsed && parsed[fields[i]]) return parsed[fields[i]];
    }
    return parsed ? [parsed] : [];
}

module.exports = {
    parseJsonLose: parseJsonLose,
    toArrayLose: toArrayLose
};
