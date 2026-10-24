/**
 * mcpParse — shared MCP-bridge payload normalization (gh-1250).
 *
 * The snake_case github_*, jira_*, cli_* bridge tools return their payload
 * in whatever shape the backing SDK produced: an already-parsed object, a
 * JSON string, an error-message body, or null/undefined on a 404-ish
 * miss. Every action script used to carry its own copy of these two
 * normalizers (mergeTrigger.js and sm/mergeBot.js had byte-identical
 * parseMcp copies); they drift only by accident, so they live here once.
 *
 *   parseMcp(raw)    — null/undefined → {}, object passthrough (by
 *                      reference), JSON.parse(String(raw)) with the
 *                      parse failure swallowed → {} (a bridge error body
 *                      is handled by the caller's own checks).
 *   payloadList(p)   — the list tools have returned both bare arrays and
 *                      wrapped objects ({ items: [...] } /
 *                      { pullRequests: [...] }) across bridge versions.
 *                      Every consumer normalizes through here: a wrapped
 *                      payload iterated as a bare array has length
 *                      undefined, the loop never runs, and the op
 *                      vanishes from the log (gh-952 review). Anything
 *                      that is not one of the three list shapes reads as
 *                      an empty list — a missing payload never throws.
 *
 * GraalJS-compatible: var/plain functions only, no Node APIs.
 */

function parseMcp(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (e) { return {}; }
}

function payloadList(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    if (parsed && Array.isArray(parsed.pullRequests)) return parsed.pullRequests;
    return [];
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseMcp: parseMcp, payloadList: payloadList };
}
