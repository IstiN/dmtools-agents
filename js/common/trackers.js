/**
 * Tracker-agnostic ticket helpers — the scm.js analog for trackers.
 *
 * Every operation goes through the generic tracker_* tool family; the
 * runtime routes to whichever tracker backend is configured
 * (Jira | ADO | GitHub issues). Agent code written against this module
 * no longer depends on jiraHelpers or the jira_* globals directly.
 *
 * On runtimes that do not expose the tracker_* family (legacy Java
 * DMTools), every operation transparently falls back to its native
 * jira_* twin, so scripts stay portable during the migration.
 *
 * Factory: createTracker(config)
 *   config.repository: { owner, repo }  // expands bare GitHub issue numbers
 *   config.labels: { aiGenerated }      // overrides LABELS.AI_GENERATED
 *
 * Per-agent override via JSON customParams:
 *   { "customParams": { "targetRepository": { "owner": "MyOrg", "repo": "my-repo" } } }
 */

const { STATUSES, LABELS } = require('../config.js');

/**
 * Parse a tool result that may arrive as an object or a JSON string.
 * Non-JSON strings pass through untouched (scm.js convention).
 */
function _parseJson(raw) {
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
}

/**
 * Normalize a collection of label entries into plain names.
 * Jira/ADO give strings; GitHub gives [{ name: '...' }].
 */
function _labelNames(raw) {
    var parsed = _parseJson(raw);
    if (!Array.isArray(parsed)) return [];
    var names = [];
    for (var i = 0; i < parsed.length; i++) {
        var entry = parsed[i];
        if (typeof entry === 'string') {
            names.push(entry);
        } else if (entry && typeof entry.name === 'string') {
            names.push(entry.name);
        }
    }
    return names;
}

/**
 * Normalize one comment into { author, body, created }.
 * Candidates cover Jira, GitHub, and ADO field namings; unknown shapes
 * keep their raw body field when present.
 */
function _normalizeComment(raw) {
    var c = _parseJson(raw);
    if (!c || typeof c !== 'object') return null;
    var author = '';
    var authorCandidates = [c.author, c.user, c.createdBy];
    for (var i = 0; i < authorCandidates.length; i++) {
        var a = authorCandidates[i];
        if (!a) continue;
        if (typeof a === 'string') { author = a; break; }
        if (a.displayName || a.login || a.uniqueName) {
            author = a.displayName || a.login || a.uniqueName;
            break;
        }
    }
    return {
        author: author,
        body: c.body || c.text || '',
        created: c.created || c.created_at || c.createdDate || null
    };
}

/**
 * Read a ticket author out of backend-specific assignee shapes.
 */
function _assigneeName(fields) {
    var candidates = [
        fields.assignee, fields.assignments,
        fields['System.AssignedTo']
    ];
    for (var i = 0; i < candidates.length; i++) {
        var a = candidates[i];
        if (!a) continue;
        if (typeof a === 'string') return a;
        if (a.displayName || a.login || a.uniqueName || a.accountId) {
            return a.displayName || a.login || a.uniqueName || a.accountId;
        }
    }
    return null;
}

function createTracker(config) {
    var owner = (config && config.repository && config.repository.owner) || '';
    var repo  = (config && config.repository && config.repository.repo)  || '';
    var aiLabel = (config && config.labels && config.labels.aiGenerated)
        || LABELS.AI_GENERATED;

    /**
     * Expand a bare numeric issue number into "owner/repo#N" when the
     * repository is configured. Every other key shape passes through
     * untouched ("PROJ-123", "acme/widgets#7", ADO work-item ids).
     */
    function expandKey(key) {
        var k = String(key == null ? '' : key).trim();
        if (/^\d+$/.test(k) && owner && repo) {
            return owner + '/' + repo + '#' + k;
        }
        return k;
    }

    /**
     * Normalize any backend's ticket payload into a flat view:
     * { key, id, title, status, assignee, labels, description, url, raw: null }
     * Returns null for empty/unparseable input. The raw payload is
     * deliberately not embedded — agents needing backend specifics should
     * call the tracker_* tools directly.
     */
    function normalizeTicket(raw) {
        var t = _parseJson(raw);
        if (!t || typeof t !== 'object') return null;
        if (typeof t === 'string') return null;

        // Already flat / previously normalized.
        if (typeof t.key === 'string' && !t.fields) {
            return _flatTicket(t.key, t.id, t.title, t.status, t.assignee,
                _labelNames(t.labels), t.description || t.body, t.html_url || t.url);
        }

        // Jira: { key, id, fields: { summary, status: { name }, ... } }
        if (t.fields && typeof t.fields === 'object' && !t.fields['System.Title']) {
            var f = t.fields;
            return _flatTicket(
                t.key || (t.id != null ? String(t.id) : null),
                t.id != null ? String(t.id) : null,
                f.summary || null,
                f.status && f.status.name ? f.status.name : null,
                _assigneeName(f),
                _labelNames(f.labels),
                f.description || null,
                null
            );
        }

        // ADO: { id, fields: { 'System.Title', 'System.State', ... } }
        if (t.fields && t.fields['System.Title'] !== undefined) {
            var af = t.fields;
            return _flatTicket(
                t.id != null ? String(t.id) : null,
                t.id != null ? String(t.id) : null,
                af['System.Title'] || null,
                af['System.State'] || null,
                _assigneeName(af),
                _labelNames(af['System.Tags']),
                af['System.Description'] || null,
                null
            );
        }

        // GitHub: { number, title, state, ... }
        if (t.number !== undefined) {
            var ghKey = owner && repo
                ? owner + '/' + repo + '#' + t.number
                : (t.key != null ? String(t.key) : '#' + t.number);
            return _flatTicket(
                ghKey,
                t.id != null ? String(t.id) : null,
                t.title || null,
                t.state || null,
                _assigneeName(t),
                _labelNames(t.labels),
                t.body || null,
                t.html_url || null
            );
        }

        return null;
    }

    function _flatTicket(key, id, title, status, assignee, labels, description, url) {
        return {
            key: key,
            id: id || null,
            title: title || null,
            status: status || null,
            assignee: typeof assignee === 'string' ? assignee : _assigneeName({ assignee: assignee }),
            labels: labels || [],
            description: description || null,
            url: url || null,
            raw: null
        };
    }

    // ── tool dispatch ──────────────────────────────────────────────────────
    //
    // Each operation probes its own tracker_* tool: runtimes expose the
    // family as a whole, but probing per operation keeps the fallback
    // correct even if a future runtime ships the family incrementally.

    function getTicket(key) {
        var k = expandKey(key);
        if (typeof tracker_get_ticket !== 'undefined') {
            return normalizeTicket(tracker_get_ticket({ key: k }));
        }
        return normalizeTicket(jira_get_ticket({ key: k }));
    }

    function search(query) {
        var page;
        if (typeof tracker_search !== 'undefined') {
            page = _parseJson(tracker_search({ query: query }));
        } else {
            page = _parseJson(jira_search_by_jql({ jql: query }));
        }
        var list = page;
        if (page && typeof page === 'object' && !Array.isArray(page)) {
            list = page.issues || page.value || page.workItems || [];
        }
        if (!Array.isArray(list)) return [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var n = normalizeTicket(list[i]);
            if (n) out.push(n);
        }
        return out;
    }

    function postComment(key, comment) {
        var k = expandKey(key);
        if (typeof tracker_post_comment !== 'undefined') {
            return tracker_post_comment({ key: k, comment: comment });
        }
        return jira_post_comment({ key: k, comment: comment });
    }

    function getComments(key) {
        var k = expandKey(key);
        var page;
        if (typeof tracker_get_comments !== 'undefined') {
            page = _parseJson(tracker_get_comments({ key: k }));
        } else {
            page = _parseJson(jira_get_comments({ key: k }));
        }
        var list = page;
        if (page && typeof page === 'object' && !Array.isArray(page)) {
            list = page.comments || page.value || [];
        }
        if (!Array.isArray(list)) return [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var c = _normalizeComment(list[i]);
            if (c) out.push(c);
        }
        return out;
    }

    function addLabel(key, label) {
        var k = expandKey(key);
        if (typeof tracker_add_label !== 'undefined') {
            return tracker_add_label({ key: k, label: label });
        }
        return jira_add_label({ key: k, label: label });
    }

    function removeLabel(key, label) {
        var k = expandKey(key);
        if (typeof tracker_remove_label !== 'undefined') {
            return tracker_remove_label({ key: k, label: label });
        }
        return jira_remove_label({ key: k, label: label });
    }

    function moveToStatus(key, status) {
        var k = expandKey(key);
        if (typeof tracker_move_to_status !== 'undefined') {
            return tracker_move_to_status({ key: k, status: status });
        }
        return jira_move_to_status({ key: k, statusName: status });
    }

    function assignTo(key, user) {
        var k = expandKey(key);
        if (typeof tracker_assign_to !== 'undefined') {
            return tracker_assign_to({ key: k, user: user });
        }
        return jira_assign_ticket_to({ key: k, accountId: user });
    }

    function createTicket(project, type, title, description) {
        var raw;
        if (typeof tracker_create_ticket !== 'undefined') {
            raw = tracker_create_ticket({
                project: project,
                type: type,
                title: title,
                description: description
            });
        } else {
            raw = jira_create_ticket({
                project: project,
                issueType: type,
                summary: title,
                description: description
            });
        }
        return extractTicketKey(raw);
    }

    /**
     * Common post-processing flow (jiraHelpers.assignForReview parity):
     * assign to the initiator, move to the review status, add the AI
     * label, and drop the WIP label when given. A WIP cleanup failure is
     * logged but does not fail the operation; a core step failure does.
     */
    function assignForReview(ticketKey, initiatorId, wipLabel, targetStatus) {
        var statusName = targetStatus || STATUSES.IN_REVIEW;
        try {
            console.log('Processing ticket:', ticketKey);
            assignTo(ticketKey, initiatorId);
            moveToStatus(ticketKey, statusName);
            addLabel(ticketKey, aiLabel);
            if (wipLabel) {
                try {
                    removeLabel(ticketKey, wipLabel);
                    console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
                } catch (labelError) {
                    console.warn('Failed to remove WIP label "' + wipLabel + '":', labelError);
                }
            }
            console.log('✅ Assigned to initiator and moved to ' + statusName);
            return {
                success: true,
                message: 'Ticket ' + ticketKey + ' assigned and moved to ' + statusName
            };
        } catch (error) {
            console.error('❌ Error in assignForReview:', error);
            return { success: false, error: error.toString() };
        }
    }

    return {
        provider: function () { return 'tracker'; },
        getTicket: getTicket,
        search: search,
        postComment: postComment,
        getComments: getComments,
        addLabel: addLabel,
        removeLabel: removeLabel,
        moveToStatus: moveToStatus,
        assignTo: assignTo,
        createTicket: createTicket,
        normalizeTicket: normalizeTicket,
        extractTicketKey: extractTicketKey,
        assignForReview: assignForReview
    };
}

/**
 * Extract a ticket key from a tool result (object or JSON string).
 * Mirrors jiraHelpers.extractTicketKey so migration is drop-in.
 */
function extractTicketKey(result) {
    if (!result) {
        return null;
    }
    if (typeof result === 'string') {
        try {
            var parsed = JSON.parse(result);
            return parsed && parsed.key ? parsed.key : null;
        } catch (error) {
            return null;
        }
    }
    if (typeof result === 'object' && typeof result.key === 'string') {
        return result.key;
    }
    return null;
}

module.exports = {
    createTracker: createTracker,
    extractTicketKey: extractTicketKey
};
