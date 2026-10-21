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
 *
 * Parent → child: createTicketWithParent works on every provider (on GitHub
 * the child becomes a SUB-ISSUE of the parent). listChildTickets(parentKey)
 * returns the children in the parent's order and is GitHub-only (sub-issues);
 * jira/ado throw. Both GitHub calls go to the REST API through `gh api`:
 * no runtime ships a sub-issue tool yet, so the runner needs the GitHub CLI
 * installed and authenticated (GH_TOKEN). Without it the calls fail with an
 * error that says so, instead of a parse error on the shell's output.
 */

const { STATUSES, LABELS, stageLabel: stageLabelOf } = require('../config.js');
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

/**
 * Read ADO_PROJECT when running under GraalJS (Java host access); null elsewhere or when unset.
 */
function _adoProjectEnv() {
    try {
        var v = java.lang.System.getenv('ADO_PROJECT');
        return v ? String(v).trim() : null;
    } catch (e) {
        return null;
    }
}

function _cfgSection(config, key) {
    return (config && config[key]) || {};
}

function _rawProviderCandidate(config, customParams) {
    customParams = customParams || {};
    return customParams.trackerProvider || _cfgSection(config, 'tracker').provider || _defaultTrackerEnv() || (config && config.defaultTracker) || '';
}

function _resolveProviderName(config, customParams) {
    var low = String(_rawProviderCandidate(config, customParams)).toLowerCase();
    return ['jira', 'ado', 'github'].indexOf(low) !== -1 ? low : 'jira';
}

function _resolveAdoMarkdown(config, customParams) {
    customParams = customParams || {};
    var raw = customParams.adoTextFormat || _cfgSection(config, 'tracker').adoTextFormat || 'markdown';
    return String(raw).toLowerCase() === 'markdown';
}

function _rawStageFallbackCandidate(config, customParams) {
    customParams = customParams || {};
    return customParams.stageFallback || _cfgSection(config, 'tracker').stageFallback || _cfgSection(config, 'jira').stageFallback || 'none';
}

function _resolveStageFallback(config, customParams) {
    return String(_rawStageFallbackCandidate(config, customParams)).toLowerCase() === 'label' ? 'label' : 'none';
}

function _copyStringStatusKeys(target, source) {
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (typeof source[k] === 'string') target[k] = source[k];
    }
}

function _copyStatusEntries(target, source, providerName) {
    if (!source || typeof source !== 'object') return;
    _copyStringStatusKeys(target, source);
    var provMap = providerName && source[providerName];
    if (provMap && typeof provMap === 'object') Object.assign(target, provMap);
}

function _buildEffectiveStatuses(config, customParams, providerName) {
    customParams = customParams || {};
    var merged = Object.assign({}, STATUSES);
    _copyStatusEntries(merged, _cfgSection(config, 'jira').statuses, providerName);
    _copyStatusEntries(merged, _cfgSection(config, 'tracker').statuses, providerName);
    _copyStatusEntries(merged, customParams.customStatuses, providerName);
    return merged;
}

function _findStageKeyForStatus(statusMap, statusName) {
    if (!statusName || !statusMap) return null;
    var target = String(statusName).trim().toLowerCase();
    var keys = Object.keys(statusMap);
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (String(statusMap[k] || '').trim().toLowerCase() === target) return k;
    }
    return null;
}

function createTracker(config, customParams) {
    var providerName = _resolveProviderName(config, customParams);
    var adoMarkdown = _resolveAdoMarkdown(config, customParams);
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

    // Adds format:'markdown' only when enabled: the html default sends the exact previous args, so a
    // runtime without the 'format' parameter (older dmtools) keeps working unchanged.
    function withAdoFormat(args) {
        if (adoMarkdown) args.format = 'markdown';
        return args;
    }

    function adoPostComment(key, comment) {
        return ado_add_work_item_comment(withAdoFormat({ id: String(key), comment: comment }));
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

    /**
     * The ADO project to create work items in. Scripts written for Jira derive the project from the ticket key
     * (`PROJ-12` -> `PROJ`); an ADO work item id is a bare number, so that yields the id ("879") and ADO answers
     * TF200016 "project does not exist" (agents#870, live). A value that is empty or only digits is therefore
     * not a project name: use the configured one (config.tracker.adoProject, config.jira.project, ADO_PROJECT).
     * A real project name is passed through unchanged.
     */
    function adoProjectFor(project) {
        var p = String(project == null ? '' : project).trim();
        if (p && !/^\d+$/.test(p)) return p;
        return (config && config.tracker && config.tracker.adoProject) ||
            (config && config.jira && config.jira.project) ||
            _adoProjectEnv() ||
            p;
    }

    function adoCreateTicket(project, type, title, description) {
        var raw = ado_create_work_item(withAdoFormat({
            project: adoProjectFor(project),
            workItemType: type,
            title: title,
            description: description
        }));
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

    // agents#899: Jira-style column names mapped to ADO reference names; Jira-only identity columns dropped
    // (the id always comes back), and Title/State/Tags/Type are always requested so the result is a complete ADO
    // item that normalizeTicket can turn into a key, on every dmtools version.
    var ADO_SEARCH_COLUMNS = { labels: 'System.Tags', tags: 'System.Tags', summary: 'System.Title', title: 'System.Title',
        status: 'System.State', state: 'System.State', description: 'System.Description' };

    var ADO_SEARCH_SKIP = { key: true, id: true, comment: true, comments: true };

    function adoSearchFields(fields) {
        var out = ['System.Title', 'System.State', 'System.Tags', 'System.WorkItemType'];
        for (var i = 0; i < (fields || []).length; i++) {
            var raw = String(fields[i]);
            var low = raw.toLowerCase();
            if (ADO_SEARCH_SKIP[low]) continue;
            var mapped = ADO_SEARCH_COLUMNS[low] || raw;
            if (out.indexOf(mapped) === -1) out.push(mapped);
        }
        return out;
    }

    function adoSearchIssues(query, opts) {
        var args = { wiql: query };
        args.fields = adoSearchFields(opts && opts.fields);
        return _issueList(ado_search_by_wiql(args), 'value');
    }

    function adoLinkIssues(sourceKey, targetKey, relationship) {
        return ado_link_work_items({ sourceId: String(sourceKey), targetId: String(targetKey), relationship: relationship });
    }

    var ADO_FIELD_ALIASES = { summary: 'System.Title', title: 'System.Title', description: 'System.Description',
        priority: 'Microsoft.VSTS.Common.Priority', labels: 'System.Tags', tags: 'System.Tags' };

    var ADO_SHORT_FIELDS = {
        summary: true, title: true, state: true, assignedto: true, priority: true, storypoints: true, effort: true,
        'system.title': true, 'system.state': true, 'system.assignedto': true, 'system.tags': true,
        'system.areapath': true, 'system.iterationpath': true, 'microsoft.vsts.common.priority': true,
        'microsoft.vsts.scheduling.storypoints': true, 'microsoft.vsts.scheduling.effort': true
    };

    function adoUpdateField(key, field, value) {
        var f = String(field);
        var lower = f.toLowerCase();
        if (lower === 'description') return ado_update_description(withAdoFormat({ id: String(key), description: String(value) }));
        if (lower === 'labels' || lower === 'tags') {
            return ado_update_tags({ id: String(key), tags: Array.isArray(value) ? value.join('; ') : String(value) });
        }
        if (typeof ado_update_field !== 'function') throw adoMissingTool('ado_update_field', 'updating field "' + f + '"');
        var args = { id: String(key), field: ADO_FIELD_ALIASES[lower] || f, value: value };
        // Only large text fields take a format; short fields (title, state, priority, ...) never do.
        if (!ADO_SHORT_FIELDS[lower] && !ADO_SHORT_FIELDS[String(args.field).toLowerCase()]) withAdoFormat(args);
        return ado_update_field(args);
    }

    function adoUpdateDescription(key, description) {
        return ado_update_description(withAdoFormat({ id: String(key), description: description }));
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
        var raw = ado_create_work_item(withAdoFormat({ project: adoProjectFor(project), workItemType: type, title: title, fieldsJson: JSON.stringify(rest) }));
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

    // ── github sub-issues (REST via gh) ───────────────────────────────────
    //
    // GitHub models a parent → child relation as SUB-ISSUES (ordered; the
    // order is the parent's list order). No dmtools runtime ships a sub-issue
    // tool, so these two calls go to the REST API through `gh api`, the way
    // the SM's own probes already do (smProvider.js). The command lines carry
    // no shell metacharacters — cli_execute_command rejects them, so query
    // parameters go as -F fields of an explicit GET, never as '&' in the path.
    //
    // Requirement: the GitHub CLI (`gh`), installed and authenticated
    // (GH_TOKEN) on the runner. It does not follow the runtime's GitHub
    // configuration (base URL, token from dmtools.env) — replace these calls
    // with runtime tools once the runtimes ship them.

    var SUB_ISSUE_PAGE_SIZE = 100;
    // GitHub caps a parent at 100 sub-issues; the guard only bounds a misbehaving API.
    var SUB_ISSUE_MAX_PAGES = 10;

    function githubRestViaGh(method, path, fields) {
        var cmd = 'gh api --method ' + method + ' ' + path;
        (fields || []).forEach(function (f) { cmd += ' -F ' + f; });
        var out = String(cli_execute_command({ command: cmd }) || '');
        var start = out.search(/[\[{]/);
        if (start === -1) {
            // No JSON at all: gh is missing, not authenticated, or the shell refused the command.
            throw new Error('trackers: GitHub sub-issues need the GitHub CLI (gh) installed and ' +
                'authenticated (GH_TOKEN) on the runner; `' + cmd + '` returned: ' +
                (out.trim().substring(0, 200) || '(no output)'));
        }
        return _parseJson(out.substring(start));
    }

    function githubParentArgs(parentKey) {
        var parent = githubIssueArgs(parentKey);
        if (!parent.owner || !parent.repo) {
            throw new Error('trackers: no repository for GitHub issue ' + parentKey +
                ' (use an owner/repo#N key or configure repository)');
        }
        return parent;
    }

    function githubCreateTicketWithParent(project, type, title, description, parentKey) {
        // project/type are Jira/ADO concepts. The child is created as a plain
        // issue, then attached to the parent as a sub-issue; the sub-issue
        // API takes the child's REST id, not its number.
        var parent = githubParentArgs(parentKey);
        var child = normalizeTicket(github_create_issue({
            owner: parent.owner,
            repo: parent.repo,
            title: title,
            body: description
        }));
        if (!child || !child.id) {
            throw new Error('trackers: github_create_issue returned no issue id for "' + title + '"');
        }
        githubRestViaGh('POST',
            'repos/' + parent.owner + '/' + parent.repo + '/issues/' + parent.number + '/sub_issues',
            ['sub_issue_id=' + child.id]);
        return child.key;
    }

    // One page of sub-issues (1-based page), as the raw REST list.
    function githubSubIssuePage(parent, parentKey, page) {
        var list = githubRestViaGh('GET',
            'repos/' + parent.owner + '/' + parent.repo + '/issues/' + parent.number + '/sub_issues',
            ['per_page=' + SUB_ISSUE_PAGE_SIZE, 'page=' + page]);
        if (!Array.isArray(list)) {
            throw new Error('trackers: unexpected sub_issues response for ' + parentKey);
        }
        return list;
    }

    // Every sub-issue of the parent, in the parent's order (all pages).
    function githubListChildTickets(parentKey) {
        var parent = githubParentArgs(parentKey);
        var out = [];
        for (var page = 1; page <= SUB_ISSUE_MAX_PAGES; page++) {
            var list = githubSubIssuePage(parent, parentKey, page);
            list.forEach(function (raw) {
                var t = normalizeTicket(raw);
                if (t) out.push(t);
            });
            if (list.length < SUB_ISSUE_PAGE_SIZE) break;
        }
        return out;
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
            createTicketWithFields: jiraCreateWithFields,
            listChildTickets: function () { unsupported('listChildTickets'); }
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
            createTicketWithFields: adoCreateWithFields,
            listChildTickets: function () { unsupported('listChildTickets'); }
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
            // A child is a sub-issue of its parent (see githubCreateTicketWithParent).
            createTicketWithParent: githubCreateTicketWithParent,
            createTicketWithFields: function () { unsupported('createTicketWithFields'); },
            listChildTickets: githubListChildTickets
        }
    };
    var impl = impls[providerName];

    /** True when a payload's `fields` is an ADO field bag (any System.* reference name), whichever columns were asked for. */
    function _isAdoFields(f) {
        if (!f || typeof f !== 'object') return false;
        for (var k in f) {
            if (Object.prototype.hasOwnProperty.call(f, k) && String(k).indexOf('System.') === 0) return true;
        }
        return false;
    }

    /**
     * Normalize any backend's ticket payload into a flat view — a thin
     * decide-dispatch over per-provider parse helpers so this shared entry
     * point stays under the CRAP budget (gh-1036); each _normalize* helper
     * pins exactly one payload shape.
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
            return _normalizeFlatTicket(t);
        }

        // Jira: { key, id, fields: { summary, status: { name }, ... } }
        if (t.fields && typeof t.fields === 'object' && t.fields.summary !== undefined) {
            return _normalizeJiraTicket(t);
        }

        // ADO: { id, fields: { 'System.Title', 'System.State', ... } }
        if (_isAdoFields(t.fields)) {
            return _normalizeAdoTicket(t);
        }

        // GitHub: { number, title, state, ... }
        if (t.number !== undefined) {
            return _normalizeGithubTicket(t);
        }

        return null;
    }

    /** Flat / already-normalized payload: field pass-through, body/url fallbacks. */
    function _normalizeFlatTicket(t) {
        return _flatTicket(t.key, t.id, t.title, t.status, t.assignee,
            _labelNames(t.labels), t.description || t.body, t.html_url || t.url);
    }

    /** Jira payload → flat view + the neutral extras (issue type, parent, fix versions). */
    function _normalizeJiraTicket(t) {
        var f = t.fields;
        return _extraFields(_flatTicket(
            t.key || (t.id != null ? String(t.id) : null),
            t.id != null ? String(t.id) : null,
            f.summary || null,
            _nameOf(f.status),
            _assigneeName(f),
            _labelNames(f.labels),
            f.description || null,
            null
        ), {
            issueType: _nameOf(f.issuetype),
            parentKey: _parentKeyOf(f),
            fixVersions: _namesOf(f.fixVersions)
        });
    }

    /** ADO payload → flat view + the neutral extras (ADO carries no fix versions). */
    function _normalizeAdoTicket(t) {
        var af = t.fields;
        return _extraFields(_flatTicket(
            _adoKey(t),
            _adoKey(t),
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

    /** GitHub payload → flat view; the repo-scoped key needs owner/repo context. */
    function _normalizeGithubTicket(t) {
        return _flatTicket(
            _githubKey(t),
            t.id != null ? String(t.id) : null,
            t.title || null,
            t.state || null,
            _assigneeName(t),
            _labelNames(t.labels),
            t.body || null,
            t.html_url || null
        );
    }

    /** { name }-shaped Jira sub-objects (status/issuetype) → their name, else null. */
    function _nameOf(obj) {
        return obj && obj.name ? obj.name : null;
    }

    /** Jira parent link → the parent key, else null. */
    function _parentKeyOf(f) {
        return f.parent && f.parent.key ? f.parent.key : null;
    }

    /** ADO work item id → string key, else null. */
    function _adoKey(t) {
        return t.id != null ? String(t.id) : null;
    }

    /** GitHub issue key: 'owner/repo#N' with repository context, else t.key or '#N'. */
    function _githubKey(t) {
        if (owner && repo) return owner + '/' + repo + '#' + t.number;
        return t.key != null ? String(t.key) : '#' + t.number;
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
            !_isAdoFields(t.fields)) return t;
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
            if (initiatorId === undefined || initiatorId === null || String(initiatorId).trim() === '') {
                // agents#874: without an initiator there is nobody to assign to; the provider tools reject an
                // empty assignee (ADO: "Required parameter 'userEmail' is missing") and the whole hand-off —
                // status move, AI label — used to be lost. Skip only the assignment.
                console.warn('⚠️ No initiator for ' + ticketKey + ' — skipping assignment; the ticket is still moved to ' +
                    statusName + ' and labelled. Set "initiator" in the job params to assign it.');
            } else {
                impl.assignTo(ticketKey, initiatorId);
            }
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

    // agents#856: how a rejected status transition is handled. 'none' (default) keeps the exact previous
    // behaviour — the error propagates to the caller, which logs it. 'label' leaves a stage marker on the
    // ticket instead, so a restricted workflow (no such state, no admin rights) does not silently lose the
    // hand-off. Set via customParams.stageFallback or config.jira.stageFallback.
    var stageFallback = _resolveStageFallback(config, customParams);
    var effectiveStatuses = _buildEffectiveStatuses(config, customParams, providerName);
    var _stageLabel = stageLabelOf;
    var STAGE_LABEL_PREFIX = _stageLabel('');   // 'stage_'

    /**
     * agents#907: every stage marker that must go once a hand-off progresses. The caller-supplied
     * previousStageKey alone is not enough — a skipped stage or a mismatched previous key left the old
     * marker behind, so the ticket carried two stage_* labels and the SM re-selected it. Reads the
     * ticket's labels (label mode only) and returns all stage_* labels except `keepLabel`; the
     * previous-stage label is always included so the old contract holds even when the read fails.
     */
    function _staleStageLabels(ticketKey, keepLabel, previousStageKey) {
        var stale = [];
        function add(l) { if (l && l !== keepLabel && stale.indexOf(l) === -1) stale.push(l); }
        if (previousStageKey) add(_stageLabel(previousStageKey));
        try {
            var ticket = normalizeTicket(impl.getTicket(ticketKey));
            var labels = (ticket && ticket.labels) || [];
            for (var i = 0; i < labels.length; i++) {
                var l = String(labels[i]);
                if (l.indexOf(STAGE_LABEL_PREFIX) === 0) add(l);
            }
        } catch (e) {
            console.warn('Could not read labels of ' + ticketKey + ' for stage-label cleanup (non-fatal):', e && e.message ? e.message : e);
        }
        return stale;
    }

    function _removeLabels(ticketKey, labels) {
        for (var i = 0; i < labels.length; i++) {
            try { impl.removeLabel(ticketKey, labels[i]); } catch (e) { /* label may already be gone */ }
        }
    }

    /**
     * Moves the ticket to a stage status; when the tracker rejects the transition and the fallback is
     * enabled, marks the stage with a `stage_<key>` label, drops the previous stage label and explains why
     * in a comment. Returns { moved, marked, label, error } so callers can report what really happened.
     * With stageFallback 'none' (default) a rejected transition throws, exactly like moveToStatus.
     *
     * @param {string} ticketKey
     * @param {string} statusName  the status to move to
     * @param {string} stageKey    stable stage name used for the label (e.g. 'PO_REVIEW')
     * @param {string} [previousStageKey] optional, kept for compatibility: its label is always removed; in
     *        'label' mode every other stale stage_* label on the ticket is removed as well (agents#907)
     */
    function _resolveStageKey(statusName, stageKey) {
        if (stageKey) return stageKey;
        return _findStageKeyForStatus(effectiveStatuses, statusName) || statusName;
    }

    function _errorText(err, fallback) {
        if (!err) return fallback;
        return String(err.message || err);
    }

    function _addStageMarkerOrThrow(ticketKey, statusName, label, reason) {
        try {
            impl.addLabel(ticketKey, label);
        } catch (labelError) {
            throw new Error('Status transition to "' + statusName + '" was rejected (' + reason +
                ') and the stage label "' + label + '" could not be added: ' + _errorText(labelError, 'unknown error'));
        }
    }

    function _postFallbackComment(ticketKey, statusName, label, reason) {
        try {
            impl.postComment(ticketKey, 'Could not move this ticket to "' + statusName + '" (' + reason +
                '). The stage is recorded with the label `' + label + '` instead.');
        } catch (commentError) {
            console.warn('Could not post the stage-fallback comment on ' + ticketKey + ':', commentError);
        }
    }

    function _applyFallbackStageLabel(ticketKey, statusName, stageKey, previousStageKey, moveError) {
        var label = _stageLabel(_resolveStageKey(statusName, stageKey));
        var reason = _errorText(moveError, 'unknown error');
        _addStageMarkerOrThrow(ticketKey, statusName, label, reason);
        _removeLabels(ticketKey, _staleStageLabels(ticketKey, label, previousStageKey));
        _postFallbackComment(ticketKey, statusName, label, reason);
        console.warn('⚠️ ' + ticketKey + ': transition to "' + statusName + '" rejected — marked with label "' + label + '"');
        return { moved: false, marked: true, label: label, error: reason };
    }

    function moveToStatusOrMark(ticketKey, statusName, stageKey, previousStageKey) {
        if (providerName === 'github') {
            impl.moveToStatus(ticketKey, statusName);
            return { moved: true, marked: false, label: null, error: null };
        }
        try {
            impl.moveToStatus(ticketKey, statusName);
            if (stageFallback === 'label') {
                _removeLabels(ticketKey, _staleStageLabels(ticketKey, null, previousStageKey));
            }
            return { moved: true, marked: false, label: null, error: null };
        } catch (moveError) {
            if (stageFallback !== 'label') {
                throw moveError;
            }
            return _applyFallbackStageLabel(ticketKey, statusName, stageKey, previousStageKey, moveError);
        }
    }

    function moveToStatus(ticketKey, statusName, stageKey, previousStageKey) {
        if (providerName === 'github') {
            return impl.moveToStatus(ticketKey, statusName);
        }
        return moveToStatusOrMark(ticketKey, statusName, stageKey, previousStageKey);
    }

    function moveToStatusStrict(ticketKey, statusName) {
        return impl.moveToStatus(ticketKey, statusName);
    }

    /**
     * Whether a ticket is in a stage: really in `statusName`, or (label mode only) carrying the
     * `stage_<key>` marker that a rejected transition to it left behind (gh-916). The 'none' default
     * never consults labels — exactly the `ticket.status === statusName` comparison the status gates
     * did before, with no extra reads. Accepts both ticket shapes in use: the flat normalized view
     * ({ status, labels }) and the Jira-shaped issue view ({ fields: { status: { name }, labels } }).
     *
     * @param {Object} ticket    - ticket as returned by getTicket/getIssue/searchIssues
     * @param {string} stageKey  - stage name whose marker is accepted in label mode (e.g. 'PASSED')
     * @param {string} statusName - the real status name the stage maps to (e.g. statuses.PASSED)
     */
    function hasStage(ticket, stageKey, statusName) {
        if (!ticket) return false;
        var fields = ticket.fields || {};
        var status = (ticket.status !== undefined && ticket.status !== null)
            ? ticket.status
            : (fields.status && fields.status.name !== undefined && fields.status.name !== null
                ? fields.status.name : null);
        if (statusName !== undefined && status === statusName) return true;
        if (stageFallback !== 'label') return false;
        return _labelNames(ticket.labels || fields.labels || []).indexOf(_stageLabel(stageKey)) !== -1;
    }

    return {
        provider: provider,
        stageFallback: function () { return stageFallback; },
        moveToStatusOrMark: moveToStatusOrMark,
        hasStage: hasStage,
        getTicket: function (k) { return impl.getTicket(k); },
        search: function (q) { return impl.search(q); },
        postComment: function (k, c) { return impl.postComment(k, c); },
        getComments: function (k) { return impl.getComments(k); },
        addLabel: function (k, l) { return impl.addLabel(k, l); },
        removeLabel: function (k, l) { return impl.removeLabel(k, l); },
        moveToStatus: moveToStatus,
        moveToStatusStrict: moveToStatusStrict,
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
        listChildTickets: function (k) { return impl.listChildTickets(k); },
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

/**
 * A GitHub tracker bound to one repository (agents: move to the tracker abstraction).
 *
 * The SM and the merge bot address issues/PRs of a repository taken from the RULE context, not from the
 * project config, and used to call github_add_labels / github_remove_label / github_create_comment directly.
 * This returns the same tracker object every other script uses, pinned to that repository, so those writes go
 * through addLabel / removeLabel / postComment (one call shape per operation, the provider differences stay
 * inside this module). Behaviour is the previous one: the wrapper sends the argument names every dmtools
 * version already accepts (owner/repo/number, labels:[x], text).
 *
 * @param {string} owner repository owner
 * @param {string} repo  repository name
 * @returns {Object} tracker (see createTracker)
 */
function createGithubTracker(owner, repo) {
    return createTracker(
        { repository: { owner: owner || '', repo: repo || '' }, tracker: { provider: 'github' } },
        { trackerProvider: 'github' }
    );
}

module.exports = {
    createTracker: createTracker,
    createGithubTracker: createGithubTracker,
    extractTicketKey: extractTicketKey
};
