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
 *   payloadList(p, opts) — the list tools have returned both bare arrays and
 *                      wrapped objects ({ items: [...] } /
 *                      { pullRequests: [...] }) across bridge versions.
 *                      Every consumer normalizes through here: a wrapped
 *                      payload iterated as a bare array has length
 *                      undefined, the loop never runs, and the op
 *                      vanishes from the log (gh-952 review). Anything
 *                      that is not one of the three list shapes reads as
 *                      an empty list — a missing payload never throws.
 *                      opts.preferPullRequests: when both keys co-occur,
 *                      pullRequests wins — the precedence mergeBot.js
 *                      had pre-gh-1250 (sm/mergeBot.js listArray checked
 *                      pullRequests first); mergeTrigger.js's original
 *                      asList checked items first, which stays the
 *                      default.
 *
 * GraalJS-compatible: var/plain functions only, no Node APIs.
 */

function parseMcp(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (e) { return {}; }
}

function listOf(v) {
    return Array.isArray(v) ? v : null;
}

function payloadList(parsed, options) {
    if (Array.isArray(parsed)) return parsed;
    if (!parsed) return [];
    // Hoist the pullRequests-array probe (listOf) so the precedence branches
    // below stay single-condition (keeps cyclomatic complexity within the
    // CRAP threshold — gh-1258 ratchet).
    var prs = listOf(parsed.pullRequests);
    if (prs && options && options.preferPullRequests) return prs;
    if (listOf(parsed.items)) return parsed.items;
    return prs || [];
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseMcp: parseMcp, payloadList: payloadList };
}
