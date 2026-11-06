/**
 * Deterministic GitLab intake/polling. Shell owns only single operations (API,
 * identity, development/publishing and existing isolated lifecycle/rework).
 * No provider tools, AI calls, Node APIs or environment access are needed here.
 */
var BRIDGE_MARKER = '__DMTOOLS_GITLAB_RESULT__';

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function commandOutput(result) {
    if (result && typeof result === 'object') {
        if (result.exitCode !== undefined && Number(result.exitCode) !== 0) {
            throw new Error('GitLab bridge command failed: exit ' + result.exitCode);
        }
        if (result.output !== undefined) return String(result.output);
        if (result.stdout !== undefined) return String(result.stdout);
    }
    return String(result === undefined || result === null ? '' : result);
}

function runtimeBridge(path) {
    return function (name, args) {
        var command = 'bash ' + shellQuote(path) + ' ' + shellQuote(name);
        for (var i = 0; i < args.length; i++) command += ' ' + shellQuote(args[i]);
        var output = commandOutput(cli_execute_command({ command: command }));
        var marker = output.lastIndexOf(BRIDGE_MARKER);
        if (marker < 0) throw new Error('GitLab bridge returned no result envelope for ' + name);
        var result = JSON.parse(output.substring(marker + BRIDGE_MARKER.length).trim());
        if (typeof result.exitCode !== 'number' || typeof result.output !== 'string') {
            throw new Error('Invalid GitLab bridge result for ' + name);
        }
        if (result.exitCode !== 0) {
            throw new Error('GitLab bridge ' + name + ' failed (exit ' + result.exitCode + '): ' + result.output);
        }
        return result.output;
    };
}

function has(item, label) { return (item.labels || []).indexOf(label) >= 0; }
function blocked(item, automatic) {
    return has(item, 'blocked') || has(item, 'agent:skip') || (automatic && has(item, 'needs-human'));
}
function forceLeg(item) {
    return has(item, 'agent:rework') ? 'rework' : has(item, 'agent:review') ? 'review' : '';
}
function labelTitles(values) {
    return (values || []).map(function (v) { return typeof v === 'string' ? v : v.title || v.name || ''; });
}
function addedLabels(payload) {
    var labels = (payload.changes || {}).labels || {};
    var previous = labelTitles(labels.previous);
    return labelTitles(labels.current).filter(function (label) { return previous.indexOf(label) < 0; });
}
function webhook(context, automatic) {
    if (context.trigger !== 'issue_webhook') return null;
    var payload = context.payload;
    if (!payload || (payload.object_kind !== 'issue' && (!automatic || payload.object_kind !== 'merge_request')) ||
        !payload.object_attributes || typeof payload.object_attributes.iid !== 'number') {
        throw new Error('Invalid GitLab factory webhook payload');
    }
    var kind = payload.object_kind;
    var attributes = payload.object_attributes;
    var changes = payload.changes || {};
    var added = addedLabels(payload);
    var opened = attributes.action === 'open' || attributes.action === 'reopen';
    var actionable = added.some(function (label) {
        return label === 'agent:review' || label === 'agent:rework' || (kind === 'issue' && label === 'agent:dev');
    });
    var ignore;
    if (!automatic) {
        ignore = changes.labels !== undefined && changes.labels !== null && added.length === 0;
    } else if (kind === 'issue') {
        var keys = Object.keys(changes);
        var progressOnly = keys.length > 0 && keys.every(function (key) { return key === 'description' || key === 'updated_at'; });
        ignore = !opened && (progressOnly || (changes.labels !== undefined && changes.labels !== null && !actionable));
    } else {
        ignore = !opened && (attributes.oldrev === undefined || attributes.oldrev === null) && !actionable;
    }
    return { kind: kind, iid: attributes.iid, ignore: ignore };
}

function poll(job, io) {
    job = job || {};
    io = io || {};
    var mode = job.mode || 'automatic';
    if (mode !== 'automatic' && mode !== 'legacy') throw new Error('Unsupported GitLab polling mode: ' + mode);
    var automatic = mode === 'automatic';
    var bridge = io.bridge || runtimeBridge(job.bridgePath || '.dmtools/scripts/gitlab-factory-agent.sh');
    var log = io.log || function (text) {
        if (typeof console !== 'undefined' && console.log) console.log(text);
        else if (typeof print === 'function') print(text);
    };
    function call(name, args) { return bridge(name, args || []); }
    function api(method, path, args) { return JSON.parse(call('api', [method, path].concat(args || []))); }
    function list(path) {
        var result = [], page = 1, batch;
        do {
            batch = api('GET', path + (path.indexOf('?') < 0 ? '?' : '&') + 'per_page=100&page=' + page);
            if (!Array.isArray(batch)) throw new Error('GitLab list response is not an array: ' + path);
            result = result.concat(batch);
            page++;
        } while (batch.length === 100);
        return result;
    }
    function operation(name, args) {
        var output = call(name, args);
        if (output) log(output);
        return output;
    }
    var context = JSON.parse(call('context'));
    var hook = webhook(context, automatic);
    if (hook && hook.ignore) { log('Ignoring factory progress/status echo; no actionable change.'); return { ignored: true }; }
    var project = '/projects/' + encodeURIComponent(context.projectId);
    function issuePath(iid) { return project + '/issues/' + iid; }
    function mrPath(iid) { return project + '/merge_requests/' + iid; }
    function lifecycle(mr, issue, force) { operation('lifecycle', [String(mr), issue ? String(issue) : '', force || '']); }
    function updateLabels(path, result, trigger) {
        var args = ['--form-string', 'add_labels=' + result];
        if (trigger) args = args.concat(['--form-string', 'remove_labels=' + trigger]);
        if (trigger === 'agent:review') {
            JSON.parse(call('api-role', ['.dmtools/runners/fa-review.json', 'PUT', path].concat(args)));
        } else api('PUT', path, args);
    }
    if (automatic && context.mrIid) {
        if (!/^[0-9]+$/.test(String(context.mrIid))) throw new Error('Invalid MR IID');
        lifecycle(context.mrIid, '', context.leg);
        return { processed: true };
    }
    if (automatic && hook && hook.kind === 'merge_request') {
        var target = api('GET', mrPath(hook.iid));
        if (String(target.source_branch || '').indexOf('ai/issue-') === 0) lifecycle(hook.iid, '', forceLeg(target));
        return { processed: true };
    }
    var issues = list(project + '/issues?state=opened');
    var machine = automatic ? api('GET', '/user').username : job.machine || '';
    if (automatic && !machine) throw new Error('GitLab development identity has no username');
    function assigned(issue) {
        return (issue.assignees || []).some(function (a) { return a.username === machine; });
    }
    for (var i = 0; i < issues.length; i++) {
        var issue = issues[i];
        if ((hook && issue.iid !== hook.iid) || blocked(issue, automatic)) continue;
        var review = has(issue, 'agent:review');
        var rework = has(issue, 'agent:rework');
        if (automatic) {
            if (!(review || rework || (!has(issue, 'ai_developed') && !has(issue, 'ai_pr_reviewed') && (has(issue, 'agent:dev') || assigned(issue))))) continue;
            issue = api('GET', issuePath(issue.iid));
            var related = list(issuePath(issue.iid) + '/related_merge_requests').filter(function (mr) { return mr.state === 'opened'; });
            if (related.length > 1) throw new Error('Multiple open MRs are linked to issue #' + issue.iid + '; refusing to guess.');
            var force = forceLeg(issue);
            var mrIid;
            if (related.length) {
                mrIid = related[0].iid;
            } else {
                if (force) throw new Error('Review/rework requires an existing open MR linked to issue #' + issue.iid);
                var config = '.dmtools/runners/' + (has(issue, 'bug') ? 'fa-bug-dev.json' : 'fa-story-dev.json');
                var developed;
                try {
                    developed = operation('develop', [String(issue.iid), config, mode, job.baseBranch || 'main']);
                } catch (error) {
                    api('PUT', issuePath(issue.iid), ['--data-urlencode', 'add_labels=needs-human']);
                    throw error;
                }
                var match = /(?:^|\n)__DMTOOLS_CREATED_MR__([0-9]+)\s*$/.exec(developed);
                if (!match) throw new Error('Development did not return a created MR IID.');
                mrIid = match[1];
            }
            call('labels', [String(mrIid), String(issue.iid), 'ai_developed,agent:review', 'agent:dev']);
            lifecycle(mrIid, issue.iid, force);
        } else {
            var labels = issue.labels || [];
            var busy = labels.some(function (label) {
                return ['status:In Development', 'status:In Review', 'status:In Rework', 'ai_developed', 'ai_pr_reviewed'].indexOf(label) >= 0 ||
                    /in progress|_wip|rework-round-/.test(label);
            });
            if (!review && !(rework && !has(issue, 'status:In Rework')) && (busy || !(assigned(issue) || has(issue, 'agent:dev')))) continue;
            if (!review && rework && has(issue, 'status:In Rework')) continue;
            var trigger = review ? 'agent:review' : rework ? 'agent:rework' : has(issue, 'agent:dev') ? 'agent:dev' : '';
            var runner = review ? 'fa-review' : rework ? 'fa-rework' : has(issue, 'bug') ? 'fa-bug-dev' : 'fa-story-dev';
            operation('legacy-issue', [String(issue.iid), '.dmtools/runners/' + runner + '.json', trigger, job.baseBranch || 'main']);
            updateLabels(issuePath(issue.iid), review ? 'ai_pr_reviewed' : 'ai_developed', trigger);
        }
    }
    if (hook) return { processed: true };
    var mrs = list(project + '/merge_requests?state=opened');
    for (var j = 0; j < mrs.length; j++) {
        var mr = mrs[j];
        if (automatic) {
            if (!blocked(mr, true) && String(mr.source_branch || '').indexOf('ai/issue-') === 0) lifecycle(mr.iid);
        } else {
            if (has(mr, 'blocked')) continue;
            var mrTrigger = has(mr, 'agent:review') ? 'agent:review' : has(mr, 'agent:rework') ? 'agent:rework' : '';
            if (mrTrigger) {
                operation('legacy-mr', [String(mr.iid), '.dmtools/runners/' + (mrTrigger === 'agent:review' ? 'fa-review' : 'fa-rework') + '.json', mrTrigger]);
                updateLabels(mrPath(mr.iid), mrTrigger === 'agent:review' ? 'ai_pr_reviewed' : 'ai_developed', mrTrigger);
            } else if ((mr.author || {}).username === machine && has(mr, 'pr_approved') && (mr.head_pipeline || {}).status === 'success') {
                operation('merge', [String(mr.iid)]);
            }
        }
    }
    return { processed: true };
}

function action(params) { return poll((params || {}).jobParams || params || {}); }
if (typeof module !== 'undefined') module.exports = { action: action, poll: poll, commandOutput: commandOutput };
