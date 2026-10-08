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
 * tickets/search/comments/status/assign/create and labels — add/remove
 * route to the canonical ado_add_work_item_label / ado_remove_work_item_label
 * tools (System.Tags); github covers everything — search/assignTo/moveToStatus
 * prefer the dedicated issue tools (github_search_issues, github_assign_issue,
 * github_move_issue_to_status) when the runtime exposes them (Java runtime),
 * with graceful degradation where it does not (Dart catalog): moveToStatus
 * falls back to close-on-done + status-as-label over the basic issue tools,
 * while search/assignTo throw a clear error.
 */

const { STATUSES, LABELS } = require('../config.js');
// Single owner of the GitHub key-shape convention (gh-770): the router's
// issue-number parser derives from it, so a key the convention accepts can
// never die with "cannot parse GitHub issue key".
const ticketKeyShapes = require('./ticketKeyShapes.js');

/**
 * Parse a tool result that may arrive as an object or a JSON string.
 * Non-JSON strings pass through untouched (scm.js convention).
 */
function _parseJson(raw) {
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    // GraalJS host objects expose their data only through toJSON() — materialise them.
    if (raw && typeof raw === 'object' && typeof raw.toJSON === 'function') {
        try { return JSON.parse(JSON.stringify(raw)); } catch (e) { return raw; }
    }
    return raw;
}

/**
 * Normalize a collection of label entries into plain names.
 * Jira/ADO give strings; GitHub gives [{ name: '...' }].
 */
function _labelNames(raw) {
    // ADO keeps tags as ONE string in System.Tags: "a; b; c".
    if (typeof raw === 'string' && raw.indexOf('[') !== 0) {
        return raw.split(';').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
    }
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
        // gh-N (gh-1308) is the GitHub router key convention — parsed via the
        // shared shape owner (common/ticketKeyShapes.js, gh-770). Without it
        // every comment/label/status op on a gh-N ticket would throw and the
        // machine-loop scripts would silently lose their tracker updates.
        var n = ticketKeyShapes.githubIssueNumberIn(k);
        if (n === null) {
            throw new Error('trackers: cannot parse GitHub issue key: ' + key);
        }
        return n;
    }

    /**
     * Build the argument bag for the dedicated GitHub issue tools
     * (github_assign_issue / github_move_issue_to_status). Carries BOTH the
     * composite key and the explicit owner/repo/number parts so the call
     * works against runtimes whose tool schema accepts only one of the two
     * shapes: the Java tools resolve either (explicit parts win over key),
     * the Dart issue family speaks owner/repo/number. For composite keys the
     * parts are parsed FROM THE KEY (the key is authoritative); for bare
     * numbers the configured repository fills in.
     */
    function githubIssueArgs(key) {
        var k = expandKey(key);
        var m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(k);
        if (m) {
            return { key: k, owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
        }
        var args = { key: k, number: githubIssueNumber(k) };
        if (owner) args.owner = owner;
        if (repo) args.repo = repo;
        return args;
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



    // Jira payloads pass through UNCHANGED even when the requested fields omit
    // summary (e.g. fields:['key','status']) — only non-Jira-shaped ones convert.
    function _jiraView(raw) {
        var t = _parseJson(raw);
        if (t && typeof t === 'object' && t.fields && typeof t.fields === 'object'
            && t.fields['System.Title'] === undefined) return t;
        return toIssueView(t);
    }

    function jiraGetIssue(key, fields) {
        var args = { key: key };
        if (fields) args.fields = fields;
        return _jiraView(jira_get_ticket(args));
    }

    function jiraSearchIssues(query, opts) {
        var args = { jql: query };
        if (opts && opts.fields) args.fields = opts.fields;
        if (opts && opts.maxResults) args.maxResults = opts.maxResults;
        return _issueList(jira_search_by_jql(args), 'issues', _jiraView);
    }

    function jiraLinkIssues(sourceKey, targetKey, relationship) {
        return jira_link_issues({ sourceKey: sourceKey, anotherKey: targetKey, relationship: relationship });
    }

    function jiraUpdateField(key, field, value) {
        return jira_update_field({ key: key, field: field, value: value });
    }

    function jiraUpdateDescription(key, description) {
        return jira_update_description({ key: key, description: description });
    }

    function jiraSetPriority(key, priority) {
        return jira_set_priority({ key: key, priority: priority });
    }

    function jiraAttachFile(key, name, filePath, contentType) {
        var args = { ticketKey: key, name: name, filePath: filePath };
        if (contentType) args.contentType = contentType;
        return jira_attach_file_to_ticket(args);
    }

    function jiraFieldCode(project, fieldName) {
        var r = jira_get_field_custom_code({ project: project, fieldName: fieldName });
        if (r && typeof r === 'object' && r.result) r = r.result;
        return typeof r === 'string' ? r : null;
    }

    function jiraCreateWithParent(project, type, title, description, parentKey, extra) {
        var args = { project: project, issueType: type, summary: title, description: description, parentKey: parentKey };
        if (extra && extra.labels) args.labels = extra.labels;
        return extractTicketKey(jira_create_ticket_with_parent(args));
    }

    function jiraCreateWithFields(project, fieldsJson) {
        return extractTicketKey(jira_create_ticket_with_json({ project: project, fieldsJson: fieldsJson }));
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

    function adoAddLabel(key, label) {
        return ado_add_work_item_label({ id: String(key), label: label });
    }

    function adoRemoveLabel(key, label) {
        return ado_remove_work_item_label({ id: String(key), label: label });
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


    // ado_update_field / ado_attach_file / ado_set_priority / ado_get_field_code ship with the Java
    // (dm.ai#663) and Dart (dmtools-dart#373) runtimes. `typeof <identifier>` is safe for an
    // undeclared name and resolves both real host globals and test mocks, so an older runtime that
    // lacks a tool gets a precise message instead of a ReferenceError.
    function adoMissingTool(name, why) {
        return new Error('trackers: ado provider needs the ' + name + ' tool for ' + why +
            ' — not available in this runtime (needs dmtools with epam/dm.ai#661)');
    }

    function adoGetIssue(key, fields) {
        var args = { id: String(key) };
        if (fields) args.fields = fields;
        return toIssueView(ado_get_work_item(args));
    }

    function adoSearchIssues(query, opts) {
        var args = { wiql: query };
        if (opts && opts.fields) args.fields = opts.fields;
        return _issueList(ado_search_by_wiql(args), 'value');
    }

    function adoLinkIssues(sourceKey, targetKey, relationship) {
        return ado_link_work_items({ sourceId: String(sourceKey), targetId: String(targetKey), relationship: relationship });
    }

    var ADO_FIELD_ALIASES = { summary: 'System.Title', title: 'System.Title', description: 'System.Description',
        priority: 'Microsoft.VSTS.Common.Priority', labels: 'System.Tags', tags: 'System.Tags' };

    function adoUpdateField(key, field, value) {
        var f = String(field);
        var lower = f.toLowerCase();
        if (lower === 'description') return ado_update_description({ id: String(key), description: String(value) });
        if (lower === 'labels' || lower === 'tags') {
            return ado_update_tags({ id: String(key), tags: Array.isArray(value) ? value.join('; ') : String(value) });
        }
        if (typeof ado_update_field !== 'function') throw adoMissingTool('ado_update_field', 'updating field "' + f + '"');
        return ado_update_field({ id: String(key), field: ADO_FIELD_ALIASES[lower] || f, value: value });
    }

    function adoUpdateDescription(key, description) {
        return ado_update_description({ id: String(key), description: description });
    }

    var ADO_PRIORITY = { blocker: 1, highest: 1, critical: 1, high: 2, major: 2, medium: 3, normal: 3, low: 4, minor: 4, lowest: 4, trivial: 4 };

    function adoSetPriority(key, priority) {
        var n = /^\d+$/.test(String(priority)) ? parseInt(priority, 10) : ADO_PRIORITY[String(priority).toLowerCase()];
        if (!n) throw new Error('trackers: unknown priority "' + priority + '" for the ado provider');
        if (typeof ado_set_priority === 'function') {
            return ado_set_priority({ id: String(key), priority: String(priority) });
        }
        return adoUpdateField(key, 'Microsoft.VSTS.Common.Priority', n);
    }

    function adoAttachFile(key, name, filePath, contentType) {
        var args = { id: String(key), name: name, filePath: filePath };
        if (contentType) args.contentType = contentType;
        if (typeof ado_attach_file !== 'function') throw adoMissingTool('ado_attach_file', 'attaching "' + name + '"');
        return ado_attach_file(args);
    }

    function adoFieldCode(project, fieldName) {
        if (typeof ado_get_field_code !== 'function') return null;   // callers treat null as "use the human name"
        var r = ado_get_field_code({ project: project, fieldName: fieldName });
        if (r && typeof r === 'object' && r.result) r = r.result;
        return typeof r === 'string' ? r : null;
    }

    function adoCreateWithParent(project, type, title, description, parentKey, extra) {
        var id = adoCreateTicket(project, type, title, description);
        if (id && parentKey) {
            ado_link_work_items({ sourceId: String(id), targetId: String(parentKey), relationship: 'parent' });
        }
        if (id && extra && extra.labels) {
            for (var i = 0; i < extra.labels.length; i++) {
                ado_add_work_item_label({ id: String(id), label: extra.labels[i] });
            }
        }
        return id;
    }

    function adoCreateWithFields(project, fieldsJson) {
        var f = (typeof fieldsJson === 'string') ? JSON.parse(fieldsJson) : (fieldsJson || {});
        var type = f.workItemType || f['System.WorkItemType'];
        var title = f.title || f['System.Title'];
        if (!type || !title) {
            throw new Error('trackers: createTicketWithFields on ado needs workItemType and title (ADO field names)');
        }
        var rest = {};
        Object.keys(f).forEach(function (k) {
            if (k !== 'workItemType' && k !== 'System.WorkItemType' && k !== 'title' && k !== 'System.Title') rest[k] = f[k];
        });
        var raw = ado_create_work_item({ project: project, workItemType: type, title: title, fieldsJson: JSON.stringify(rest) });
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
            return github_move_issue_to_status(
                Object.assign({ statusName: s }, githubIssueArgs(key))
            );
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
        // github_assign_issue (Java runtime) accepts both the composite key
        // and explicit owner/repo/number parts (see githubIssueArgs).
        if (typeof github_assign_issue === 'function') {
            return github_assign_issue(
                Object.assign({ user: user }, githubIssueArgs(key))
            );
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
            createTicket: jiraCreateTicket,
            getIssue: jiraGetIssue,
            searchIssues: jiraSearchIssues,
            linkIssues: jiraLinkIssues,
            updateField: jiraUpdateField,
            updateDescription: jiraUpdateDescription,
            setPriority: jiraSetPriority,
            attachFile: jiraAttachFile,
            fieldCode: jiraFieldCode,
            createTicketWithParent: jiraCreateWithParent,
            createTicketWithFields: jiraCreateWithFields
        },
        ado: {
            getTicket: adoGetTicket,
            search: adoSearch,
            postComment: adoPostComment,
            getComments: adoGetComments,
            addLabel: adoAddLabel,
            removeLabel: adoRemoveLabel,
            moveToStatus: adoMoveToStatus,
            assignTo: adoAssignTo,
            createTicket: adoCreateTicket,
            getIssue: adoGetIssue,
            searchIssues: adoSearchIssues,
            linkIssues: adoLinkIssues,
            updateField: adoUpdateField,
            updateDescription: adoUpdateDescription,
            setPriority: adoSetPriority,
            attachFile: adoAttachFile,
            fieldCode: adoFieldCode,
            createTicketWithParent: adoCreateWithParent,
            createTicketWithFields: adoCreateWithFields
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
            createTicket: githubCreateTicket,
            // Not expressible on GitHub issues — fail with a clear, provider-named error.
            getIssue: function (key) { return toIssueView(githubGetTicket(key)); },
            searchIssues: function (query) {
                return githubSearch(query).map(function (n) { return toIssueView(n); });
            },
            linkIssues: function () { unsupported('linkIssues'); },
            updateField: function () { unsupported('updateField'); },
            updateDescription: function () { unsupported('updateDescription'); },
            setPriority: function () { unsupported('setPriority'); },
            attachFile: function () { unsupported('attachFile'); },
            fieldCode: function () { return null; },
            createTicketWithParent: function () { unsupported('createTicketWithParent'); },
            createTicketWithFields: function () { unsupported('createTicketWithFields'); }
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
            return _extraFields(_flatTicket(
                t.key || (t.id != null ? String(t.id) : null),
                t.id != null ? String(t.id) : null,
                f.summary || null,
                f.status && f.status.name ? f.status.name : null,
                _assigneeName(f),
                _labelNames(f.labels),
                f.description || null,
                null
            ), {
                issueType: f.issuetype && f.issuetype.name ? f.issuetype.name : null,
                parentKey: f.parent && f.parent.key ? f.parent.key : null,
                fixVersions: _namesOf(f.fixVersions)
            });
        }

        // ADO: { id, fields: { 'System.Title', 'System.State', ... } }
        if (t.fields && t.fields['System.Title'] !== undefined) {
            var af = t.fields;
            return _extraFields(_flatTicket(
                t.id != null ? String(t.id) : null,
                t.id != null ? String(t.id) : null,
                af['System.Title'] || null,
                af['System.State'] || null,
                _assigneeName(af),
                _labelNames(af['System.Tags']),
                af['System.Description'] || null,
                null
            ), {
                issueType: af['System.WorkItemType'] || null,
                parentKey: af['System.Parent'] != null ? String(af['System.Parent']) : null,
                fixVersions: []
            });
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

    function _namesOf(list) {
        var out = [];
        if (!Array.isArray(list)) return out;
        for (var i = 0; i < list.length; i++) {
            if (typeof list[i] === 'string') out.push(list[i]);
            else if (list[i] && typeof list[i].name === 'string') out.push(list[i].name);
        }
        return out;
    }

    /** Add the provider-neutral extras (issue type, parent, fix versions) to a flat view. */
    function _extraFields(flat, extra) {
        flat.issueType = extra.issueType || null;
        flat.parentKey = extra.parentKey || null;
        flat.fixVersions = extra.fixVersions || [];
        return flat;
    }


    /**
     * Jira-shaped view of any backend's ticket: { key, id, fields: { summary, status:{name},
     * labels:[...], issuetype:{name}, description, assignee, parent:{key}, fixVersions:[{name}] }, raw }.
     * Many scripts read ticket.fields.* (43 files); this keeps them provider-neutral without
     * rewriting each reader. Jira payloads pass through UNCHANGED (full fidelity: custom fields,
     * issuelinks, ...); other providers get the neutral subset built from normalizeTicket().
     */
    function toIssueView(rawTicket) {
        var t = _parseJson(rawTicket);
        if (t && typeof t === 'object' && t.fields && t.fields.summary !== undefined) return t;
        // Jira payload fetched with a fields filter (e.g. fields:['Description']) carries no summary —
        // still a Jira payload: pass it through unchanged (ADO items always carry System.Title).
        if (t && typeof t === 'object' && !Array.isArray(t) && t.fields && typeof t.fields === 'object' &&
            t.fields['System.Title'] === undefined) return t;
        var n = normalizeTicket(t);
        if (!n) return null;
        var fields = {
            summary: n.title,
            status: { name: n.status },
            labels: n.labels || [],
            issuetype: { name: n.issueType },
            description: n.description,
            assignee: n.assignee ? { displayName: n.assignee } : null,
            fixVersions: (n.fixVersions || []).map(function (v) { return { name: v }; })
        };
        if (n.parentKey) fields.parent = { key: n.parentKey };
        return { key: n.key, id: n.id, fields: fields, raw: t };
    }

    /** A search result (page object or bare array) as an array of Jira-shaped issue views. */
    function _issueList(rawPage, listField, viewFn) {
        viewFn = viewFn || toIssueView;
        var page = _parseJson(rawPage);
        var list = page && typeof page === 'object' && !Array.isArray(page)
            ? (page[listField] || []) : (Array.isArray(page) ? page : []);
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var v = viewFn(list[i]);
            if (v) out.push(v);
        }
        return out;
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
        getIssue: function (k, f) { return impl.getIssue(k, f); },
        searchIssues: function (q, o) { return impl.searchIssues(q, o); },
        linkIssues: function (s, t, r) { return impl.linkIssues(s, t, r); },
        updateField: function (k, f, v) { return impl.updateField(k, f, v); },
        updateDescription: function (k, d) { return impl.updateDescription(k, d); },
        setPriority: function (k, p) { return impl.setPriority(k, p); },
        attachFile: function (k, n, fp, ct) { return impl.attachFile(k, n, fp, ct); },
        fieldCode: function (p, n) { return impl.fieldCode(p, n); },
        createTicketWithParent: function (p, t, ti, d, pk, x) { return impl.createTicketWithParent(p, t, ti, d, pk, x); },
        createTicketWithFields: function (p, f) { return impl.createTicketWithFields(p, f); },
        normalizeTicket: normalizeTicket,
        toIssueView: toIssueView,
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
