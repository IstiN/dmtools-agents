/**
 * Tracker-agnostic ticket helpers — the scm.js analog for trackers.
 *
 * Maps generic ticket operations onto CANONICAL tracker tools per
 * configured provider — jira_* (default), ado_*, github_* — exactly like
 * scm.js maps SCM operations onto providers.
 *
 * Why canonical tools and not the tracker_* family: on the Java runtime
 * tracker_* exists solely as a CLI alias (resolved via DEFAULT_TRACKER in
 * McpCliHandler); the JS surface exposes canonical names only. Provider
 * mapping therefore lives in this layer, in JS.
 *
 * Factory: createTracker(config, customParams)
 *   Provider probing order (first non-empty, valid value wins):
 *     1. customParams.trackerProvider   — per-agent override, e.g.
 *        { "customParams": { "trackerProvider": "ado" } }
 *     2. config.tracker.provider        — project config, 'jira' | 'ado' | 'github'
 *     3. DEFAULT_TRACKER env var        — the deployment-level signal; it
 *        reflects which tracker integration is actually active in the Java
 *        runtime (jira_* / ado_* / github_* tools). This is what lets the
 *        same script run unchanged on GitHub-tracker deployments whose
 *        project config never mentions a tracker.
 *     4. config.defaultTracker          — configLoader-consistent fallback
 *     5. 'jira'                         — default
 *   config.repository: { owner, repo }  // GitHub issue key expansion
 *   config.labels: { aiGenerated }      // overrides LABELS.AI_GENERATED
 *
 * Per-agent override via JSON customParams:
 *   { "customParams": { "trackerProvider": "ado" } }
 *
 * Provider capabilities: jira supports every operation; ado covers
 * tickets/search/comments/status/assign/create (labels are not exposed by
 * the ado toolset); github covers everything — search/assignTo/moveToStatus
 * prefer the dedicated issue tools (github_search_issues, github_assign_issue,
 * github_move_issue_to_status) when the runtime exposes them (Java runtime),
 * with graceful degradation where it does not (Dart catalog): moveToStatus
 * falls back to close-on-done + status-as-label over the basic issue tools,
 * while search/assignTo throw a clear error.
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
 * Read a ticket assignee out of backend-specific shapes.
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

/**
 * Read the DEFAULT_TRACKER env var when running under GraalJS (Java host
 * access); null everywhere else (plain JS test harnesses) or when unset.
 */
function _defaultTrackerEnv() {
    try {
        var v = java.lang.System.getenv('DEFAULT_TRACKER');
        return v ? String(v).trim() : null;
    } catch (e) {
        return null;
    }
}

function createTracker(config, customParams) {
    var VALID = ['jira', 'ado', 'github'];
    var raw =
        (customParams && customParams.trackerProvider) ||
        (config && config.tracker && config.tracker.provider) ||
        _defaultTrackerEnv() ||
        (config && config.defaultTracker) ||
        '';
    var providerName = VALID.indexOf(String(raw).toLowerCase()) !== -1
        ? String(raw).toLowerCase()
        : 'jira';
    var owner = (config && config.repository && config.repository.owner) || '';
    var repo  = (config && config.repository && config.repository.repo)  || '';
    var aiLabel = (config && config.labels && config.labels.aiGenerated)
        || LABELS.AI_GENERATED;

    function provider() {
        return providerName;
    }

    function unsupported(op) {
        throw new Error(
            'trackers: operation "' + op + '" is not supported by the ' +
            providerName + ' provider'
        );
    }

    /**
     * Expand a bare numeric issue number into "owner/repo#N" (GitHub
     * keys) when the repository is configured. Other keys pass through.
     */
    function expandKey(key) {
        var k = String(key == null ? '' : key).trim();
        if (/^\d+$/.test(k) && owner && repo) {
            return owner + '/' + repo + '#' + k;
        }
        return k;
    }

    function githubIssueNumber(key) {
        var k = expandKey(key);
        var m = /^[\w.-]+\/[\w.-]+#(\d+)$/.exec(k) || /^(\d+)$/.exec(k);
        if (!m) {
            throw new Error('trackers: cannot parse GitHub issue key: ' + key);
        }
        return parseInt(m[1], 10);
    }

    // ── jira provider (canonical jira_* tools) ────────────────────────────

    function jiraGetTicket(key) {
        return normalizeTicket(jira_get_ticket({ key: key }));
    }

    function jiraSearch(query) {
        return _ticketPage(jira_search_by_jql({ jql: query }), 'issues');
    }

    function jiraPostComment(key, comment) {
        return jira_post_comment({ key: key, comment: comment });
    }

    function jiraGetComments(key) {
        return _commentPage(jira_get_comments({ key: key }), 'comments');
    }

    function jiraMoveToStatus(key, status) {
        return jira_move_to_status({ key: key, statusName: status });
    }

    function jiraAssignTo(key, user) {
        return jira_assign_ticket_to({ key: key, accountId: user });
    }

    function jiraCreateTicket(project, type, title, description) {
        return extractTicketKey(jira_create_ticket_basic({
            project: project,
            issueType: type,
            summary: title,
            description: description
        }));
    }

    // ── ado provider (canonical ado_* tools) ──────────────────────────────

    function adoGetTicket(key) {
        return normalizeTicket(ado_get_work_item({ id: String(key) }));
    }

    function adoSearch(query) {
        return _ticketPage(ado_search_by_wiql({ wiql: query }), 'value');
    }

    function adoPostComment(key, comment) {
        return ado_add_work_item_comment({ id: String(key), comment: comment });
    }

    function adoGetComments(key) {
        return _commentPage(ado_get_work_item_comments({ id: String(key) }), 'value');
    }

    function adoMoveToStatus(key, status) {
        return ado_move_to_state({ id: String(key), state: status });
    }

    function adoAssignTo(key, user) {
        return ado_assign_work_item({ id: String(key), userEmail: user });
    }

    function adoCreateTicket(project, type, title, description) {
        var raw = ado_create_work_item({
            project: project,
            workItemType: type,
            title: title,
            description: description
        });
        // ADO work items identify by numeric id, not by key.
        var parsed = _parseJson(raw);
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.key === 'string') return parsed.key;
            if (parsed.id != null) return String(parsed.id);
        }
        return extractTicketKey(raw);
    }

    // ── github provider (canonical github_* issue tools; Dart runtime) ────

    function githubGetTicket(key) {
        // github_get_issue schema (Dart catalog): workspace/repository/
        // issueNumber — not the REST-style owner/repo/issue_number.
        return normalizeTicket(github_get_issue({
            workspace: owner,
            repository: repo,
            issueNumber: githubIssueNumber(key)
        }));
    }

    function githubMoveToStatus(key, status) {
        var s = String(status || '').trim();
        if (!s) {
            throw new Error('trackers: cannot map GitHub status: ' + status);
        }
        // Prefer the dedicated issue tool when the runtime exposes it (Java
        // runtime): it also maps done/closed/completed/resolved → close and
        // open/reopened/todo/backlog/in progress → reopen, with any other
        // status applied as an issue label.
        if (typeof github_move_issue_to_status === 'function') {
            return github_move_issue_to_status({ statusName: s, key: expandKey(key) });
        }
        // Fallback for runtimes without the dedicated tool (Dart catalog):
        // GitHub issues have no status field — done/closed close the issue,
        // any other status is carried as an issue label.
        var n = githubIssueNumber(key);
        var sl = s.toLowerCase();
        if (sl === 'done' || sl === 'closed') {
            return github_close_issue({ owner: owner, repo: repo, number: n });
        }
        return github_add_labels({
            owner: owner,
            repo: repo,
            number: n,
            labels: [s]
        });
    }

    function githubSearch(query) {
        // github_search_issues (Java runtime) scopes the query to the
        // configured repo automatically when it lacks a repo: qualifier.
        if (typeof github_search_issues === 'function') {
            return _ticketPage(github_search_issues({
                query: query,
                workspace: owner || undefined,
                repository: repo || undefined
            }), 'items');
        }
        unsupported('search');
    }

    function githubAssignTo(key, user) {
        // github_assign_issue (Java runtime) accepts the composite key
        // directly and resolves owner/repo/number from it.
        if (typeof github_assign_issue === 'function') {
            return github_assign_issue({ user: user, key: expandKey(key) });
        }
        unsupported('assignTo');
    }

    function githubAddLabel(key, label) {
        return github_add_labels({
            owner: owner,
            repo: repo,
            number: githubIssueNumber(key),
            labels: [label]
        });
    }

    function githubRemoveLabel(key, label) {
        return github_remove_label({
            owner: owner,
            repo: repo,
            number: githubIssueNumber(key),
            label: label
        });
    }

    function githubPostComment(key, comment) {
        // github_create_comment POSTs to issues/{n}/comments (PRs are
        // issues upstream), so it serves plain-issue comments too; the
        // number argument keeps the tool's canonical pullRequestId name.
        return github_create_comment({
            workspace: owner,
            repository: repo,
            pullRequestId: githubIssueNumber(key),
            text: comment
        });
    }

    function githubGetComments(key) {
        // github_get_pr_comments merges the review-comments page (empty
        // for plain issues — the runtime tolerates its 404) with the
        // issue discussion page and returns a flat array.
        return _commentPage(github_get_pr_comments({
            workspace: owner,
            repository: repo,
            pullRequestId: githubIssueNumber(key)
        }));
    }

    function githubCreateTicket(project, type, title, description) {
        // project/type are Jira/ADO concepts — GitHub issues only have a
        // title and a markdown body.
        var t = normalizeTicket(github_create_issue({
            owner: owner,
            repo: repo,
            title: title,
            body: description
        }));
        return t ? t.key : null;
    }

    // ── dispatch tables ───────────────────────────────────────────────────

    var impls = {
        jira: {
            getTicket: jiraGetTicket,
            search: jiraSearch,
            postComment: jiraPostComment,
            getComments: jiraGetComments,
            addLabel: function (key, label) {
                return jira_add_label({ key: key, label: label });
            },
            removeLabel: function (key, label) {
                return jira_remove_label({ key: key, label: label });
            },
            moveToStatus: jiraMoveToStatus,
            assignTo: jiraAssignTo,
            createTicket: jiraCreateTicket
        },
        ado: {
            getTicket: adoGetTicket,
            search: adoSearch,
            postComment: adoPostComment,
            getComments: adoGetComments,
            addLabel: function () { unsupported('addLabel'); },
            removeLabel: function () { unsupported('removeLabel'); },
            moveToStatus: adoMoveToStatus,
            assignTo: adoAssignTo,
            createTicket: adoCreateTicket
        },
        github: {
            getTicket: githubGetTicket,
            search: githubSearch,
            postComment: githubPostComment,
            getComments: githubGetComments,
            addLabel: githubAddLabel,
            removeLabel: githubRemoveLabel,
            moveToStatus: githubMoveToStatus,
            assignTo: githubAssignTo,
            createTicket: githubCreateTicket
        }
    };
    var impl = impls[providerName];

    /**
     * Normalize any backend's ticket payload into a flat view:
     * { key, id, title, status, assignee, labels, description, url, raw: null }
     * Returns null for empty/unparseable input. The raw payload is
     * deliberately not embedded — agents needing backend specifics should
     * call the provider tools directly.
     */
    function normalizeTicket(rawTicket) {
        var t = _parseJson(rawTicket);
        if (!t || typeof t !== 'object' || typeof t === 'string') return null;

        // Already flat / previously normalized.
        if (typeof t.key === 'string' && !t.fields) {
            return _flatTicket(t.key, t.id, t.title, t.status, t.assignee,
                _labelNames(t.labels), t.description || t.body, t.html_url || t.url);
        }

        // Jira: { key, id, fields: { summary, status: { name }, ... } }
        if (t.fields && typeof t.fields === 'object' && t.fields.summary !== undefined) {
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

    function _ticketPage(rawPage, listField) {
        var page = _parseJson(rawPage);
        var list = page && typeof page === 'object' && !Array.isArray(page)
            ? (page[listField] || [])
            : (Array.isArray(page) ? page : []);
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var n = normalizeTicket(list[i]);
            if (n) out.push(n);
        }
        return out;
    }

    function _commentPage(rawPage, listField) {
        var page = _parseJson(rawPage);
        var list = page && typeof page === 'object' && !Array.isArray(page)
            ? (page[listField] || [])
            : (Array.isArray(page) ? page : []);
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var c = _normalizeComment(list[i]);
            if (c) out.push(c);
        }
        return out;
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
            impl.assignTo(ticketKey, initiatorId);
            impl.moveToStatus(ticketKey, statusName);
            impl.addLabel(ticketKey, aiLabel);
            if (wipLabel) {
                try {
                    impl.removeLabel(ticketKey, wipLabel);
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
        provider: provider,
        getTicket: function (k) { return impl.getTicket(k); },
        search: function (q) { return impl.search(q); },
        postComment: function (k, c) { return impl.postComment(k, c); },
        getComments: function (k) { return impl.getComments(k); },
        addLabel: function (k, l) { return impl.addLabel(k, l); },
        removeLabel: function (k, l) { return impl.removeLabel(k, l); },
        moveToStatus: function (k, s) { return impl.moveToStatus(k, s); },
        assignTo: function (k, u) { return impl.assignTo(k, u); },
        createTicket: function (p, t, ti, d) { return impl.createTicket(p, t, ti, d); },
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
