/**
 * CI Analyst — postJSAction: parse the verdict, create ONE GitHub issue.
 *
 * Runs AFTER the CLI agent. The agent wrote outputs/response.md whose FIRST
 * line is the strict verdict JSON:
 *
 *   {"adequate": true, "reason": "...", "summary": "...", "suspected_cause": "..."}
 *
 * This action owns the issue side effect (the prompt is read-only):
 *   - adequate && !dryRun -> create ONE issue "[ci-heal] <workflows>: failing"
 *     (labels ci-heal + wf:<name> per affected workflow + agent:dev, assignee
 *     machineAuthor), deduplicated against open ci-heal issues with the same
 *     title. Tools: github_search_issues / github_create_issue /
 *     github_add_labels / github_assign_issue.
 *   - adequate && dryRun  -> NO mutation; only the result record is written.
 *   - !adequate           -> nothing to hand to the dev leg; record + return.
 *
 * GitHub owner/repo: taken from customParams.targetRepository ("owner/repo"
 * string or an object carrying repository/full_name); when absent the calls
 * go unbound and the runtime's configured GitHub repo applies.
 *
 * Every outcome is recorded to outputs/ci_analyst_result.json. An issue
 * creation failure throws (uncaught => the run fails loudly); a missing or
 * unparsable verdict is recorded and returns true (the response itself is
 * the human-visible artifact, the caller decides what a verdict-less run means).
 *
 * GraalJS-compatible: var declarations, plain functions, no arrow functions,
 * no template literals, no Node APIs.
 */

var CI_RESULT_TARGET = 'outputs/ci_analyst_result.json';
var CI_HEAL_LABEL = 'ci-heal';
var DEV_LABEL = 'agent:dev';
var VERDICT_KEYS = ['adequate', 'reason', 'summary', 'suspected_cause'];

// ── customParams / response resolution (postBugCreation.js pattern) ──────────

function resolveCustomParams(params) {
    if (params && params.jobParams && params.jobParams.customParams) return params.jobParams.customParams;
    if (params && params.customParams) return params.customParams;
    if (typeof customParams !== 'undefined' && customParams) return customParams;
    return {};
}

function resolveResponseText(params) {
    if (params && params.jobParams && params.jobParams.response) return String(params.jobParams.response);
    if (params && params.response) return String(params.response);
    if (typeof response !== 'undefined' && response) return String(response);
    return '';
}

function normalizeDryRun(value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined || value === '') return false;
    return String(value).toLowerCase() === 'true';
}

/** "owner/repo" | {repository|repo|full_name:"owner/repo"} | "" -> {owner, repo} (either may stay null). */
function resolveOwnerRepo(targetRepository) {
    var raw = targetRepository;
    if (raw && typeof raw === 'object') {
        raw = raw.repository || raw.repo || raw.full_name || '';
    }
    var text = raw ? String(raw).trim() : '';
    var slash = text.indexOf('/');
    if (slash > 0 && slash < text.length - 1) {
        return { owner: text.slice(0, slash), repo: text.slice(slash + 1) };
    }
    return { owner: null, repo: null };
}

// ── verdict parsing ──────────────────────────────────────────────────────────

/** First single-line strict JSON object in the response that carries "adequate". */
function parseVerdict(responseText) {
    if (!responseText) return null;
    var lines = String(responseText).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.length < 2 || line.charAt(0) !== '{' || line.charAt(line.length - 1) !== '}') continue;
        if (line.indexOf('"adequate"') === -1) continue;
        try {
            var parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && typeof parsed.adequate === 'boolean') {
                var verdict = { adequate: parsed.adequate, line: i + 1 };
                for (var k = 0; k < VERDICT_KEYS.length; k++) {
                    var key = VERDICT_KEYS[k];
                    if (key !== 'adequate' && typeof parsed[key] === 'string') verdict[key] = parsed[key];
                }
                return verdict;
            }
        } catch (e) {
            // not JSON — keep scanning
        }
    }
    return null;
}

// ── context file (workflow names + log tails for the issue body) ─────────────

/** Parse the staged CI context JSON (best effort — a broken context still allows the issue). */
function parseContext(contextPath) {
    var empty = { workflows: [], failingRuns: [], newestSha: null };
    if (!contextPath) return empty;
    var raw = file_read({ path: contextPath });
    if (!raw) return empty;
    var parsed;
    try {
        parsed = JSON.parse(String(raw));
    } catch (e) {
        return empty;
    }
    if (!parsed || typeof parsed !== 'object') return empty;
    var workflows = [];
    if (Object.prototype.toString.call(parsed.monitoredWorkflows) === '[object Array]') {
        for (var i = 0; i < parsed.monitoredWorkflows.length; i++) {
            var name = String(parsed.monitoredWorkflows[i] || '').trim();
            if (name) workflows.push(name);
        }
    }
    var failingRuns = [];
    var newestSha = null;
    if (Object.prototype.toString.call(parsed.runs) === '[object Array]') {
        for (var j = 0; j < parsed.runs.length; j++) {
            var run = parsed.runs[j] || {};
            var conclusion = String(run.conclusion || '').toLowerCase();
            if (conclusion === 'failure') {
                failingRuns.push({
                    workflow: String(run.workflow || '').trim(),
                    url: String(run.url || '').trim(),
                    sha: String(run.sha || '').trim(),
                    logTail: String(run.logTail || '')
                });
            }
            if (run.sha && !newestSha) newestSha = String(run.sha);
        }
    }
    return { workflows: workflows, failingRuns: failingRuns, newestSha: newestSha };
}

// ── issue assembly ───────────────────────────────────────────────────────────

/** Affected workflows: failing runs first, else the monitored set, else one generic label set. */
function affectedWorkflows(context, verdict) {
    var names = [];
    var i;
    for (i = 0; i < context.failingRuns.length; i++) {
        var name = context.failingRuns[i].workflow;
        if (name && names.indexOf(name) === -1) names.push(name);
    }
    if (names.length === 0) {
        names = context.workflows.slice(0);
    }
    return names;
}

function buildIssueTitle(workflowNames) {
    if (!workflowNames || workflowNames.length === 0) return '[ci-heal] ci: failing';
    return '[ci-heal] ' + workflowNames.join(',') + ': failing';
}

function truncate(text, max) {
    var value = String(text || '');
    if (value.length <= max) return value;
    return value.slice(0, max) + '\n... (truncated)';
}

function buildIssueBody(verdict, context, targetRepository) {
    var lines = [];
    lines.push('## CI failure analysis (automated)');
    lines.push('');
    lines.push(verdict.summary || '(no summary)');
    lines.push('');
    lines.push('**Suspected cause:** ' + (verdict.suspected_cause || '(unknown)'));
    lines.push('');
    lines.push('**Classification reason:** ' + (verdict.reason || '(unspecified)'));
    lines.push('');
    if (context.failingRuns.length > 0) {
        lines.push('**Failing runs:**');
        for (var i = 0; i < context.failingRuns.length; i++) {
            var run = context.failingRuns[i];
            var label = run.workflow || 'workflow';
            var sha = run.sha ? ' (sha `' + run.sha + '`)' : '';
            lines.push('- [' + label + '](' + run.url + ')' + sha);
        }
        lines.push('');
    }
    if (targetRepository) lines.push('**Repository:** ' + targetRepository);
    lines.push('');
    lines.push('<details><summary>Log excerpt (failed jobs)</summary>');
    lines.push('');
    for (var j = 0; j < context.failingRuns.length; j++) {
        var failing = context.failingRuns[j];
        if (!failing.logTail) continue;
        lines.push('**' + (failing.workflow || 'workflow') + '** — `' + (failing.sha || 'n/a') + '`:');
        lines.push('');
        lines.push('```text');
        lines.push(truncate(failing.logTail, 2000));
        lines.push('```');
        lines.push('');
    }
    lines.push('</details>');
    lines.push('');
    lines.push('---');
    lines.push('<sub>Filed by the ci_analyst agent leg. A follow-up dev leg picks this issue up; do not edit the title/labels.</sub>');
    return lines.join('\n');
}

function buildLabels(workflowNames) {
    var labels = [CI_HEAL_LABEL, DEV_LABEL];
    for (var i = 0; i < workflowNames.length; i++) {
        var wfLabel = 'wf:' + workflowNames[i];
        if (labels.indexOf(wfLabel) === -1) labels.push(wfLabel);
    }
    return labels;
}

/** Extract the issue number from a create/search result (raw REST shape or normalized ticket). */
function issueNumberOf(created) {
    if (!created) return null;
    if (typeof created.number === 'number' || typeof created.number === 'string') return created.number;
    if (typeof created.id === 'number' || typeof created.id === 'string') return created.id;
    var key = created.key || '';
    var hash = String(key).indexOf('#');
    if (hash !== -1) {
        var tail = String(key).slice(hash + 1);
        if (/^\d+$/.test(tail)) return parseInt(tail, 10);
    }
    return null;
}

function issueUrlOf(created) {
    if (!created) return null;
    if (created.html_url) return created.html_url;
    if (created.url) return created.url;
    return null;
}

// ── GitHub calls (unbound owner/repo = runtime-configured repo) ──────────────

function githubIssueArgs(ownerRepo, number) {
    var args = {};
    if (ownerRepo.owner) args.owner = ownerRepo.owner;
    if (ownerRepo.repo) args.repo = ownerRepo.repo;
    if (number !== null && number !== undefined) args.number = number;
    return args;
}

function findOpenDuplicate(ownerRepo, title) {
    if (typeof github_search_issues !== 'function') return null;
    var query = 'is:open is:issue label:' + CI_HEAL_LABEL + ' in:title "' + title + '"';
    var args = { query: query };
    if (ownerRepo.owner) args.workspace = ownerRepo.owner;
    if (ownerRepo.repo) args.repository = ownerRepo.repo;
    var page;
    try {
        page = github_search_issues(args);
    } catch (e) {
        console.error('ci_analyst: dedupe search failed — proceeding to create (' + e + ')');
        return null;
    }
    var items = page && page.items ? page.items : (Object.prototype.toString.call(page) === '[object Array]' ? page : []);
    for (var i = 0; i < items.length; i++) {
        var item = items[i] || {};
        var itemTitle = String(item.title || '');
        if (itemTitle === title) return item;
    }
    return null;
}

// ── action ───────────────────────────────────────────────────────────────────

function action(params) {
    var custom = resolveCustomParams(params);
    var responseText = resolveResponseText(params);
    var dryRun = normalizeDryRun(custom.dryRun);
    var ownerRepo = resolveOwnerRepo(custom.targetRepository);
    var contextPath = custom.contextPath ? String(custom.contextPath) : 'input/ci_analyst_context.md';

    var verdict = parseVerdict(responseText);
    var context = parseContext(contextPath);
    var workflowNames = affectedWorkflows(context, verdict);
    var result = {
        dryRun: dryRun,
        verdictParsed: verdict !== null,
        adequate: verdict ? verdict.adequate : null,
        issueCreated: false,
        duplicate: false
    };

    if (!verdict) {
        console.error('ci_analyst: no strict verdict JSON line found in outputs/response.md — skipping issue creation');
        result.error = 'no verdict JSON line in response';
        file_write({ path: CI_RESULT_TARGET, content: JSON.stringify(result, null, 2) + '\n' });
        return true;
    }

    result.verdict = { adequate: verdict.adequate, reason: verdict.reason, summary: verdict.summary };

    if (!verdict.adequate) {
        console.log('ci_analyst: verdict = noise — no issue created');
        file_write({ path: CI_RESULT_TARGET, content: JSON.stringify(result, null, 2) + '\n' });
        return true;
    }
    if (dryRun) {
        console.log('ci_analyst: dryRun=true — verdict recorded, NO issue created');
        file_write({ path: CI_RESULT_TARGET, content: JSON.stringify(result, null, 2) + '\n' });
        return true;
    }

    var title = buildIssueTitle(workflowNames);
    var duplicate = findOpenDuplicate(ownerRepo, title);
    if (duplicate) {
        result.duplicate = true;
        result.issueUrl = issueUrlOf(duplicate);
        console.log('ci_analyst: open ci-heal issue already exists for this title — not creating a second one' +
            (result.issueUrl ? ' (' + result.issueUrl + ')' : ''));
        file_write({ path: CI_RESULT_TARGET, content: JSON.stringify(result, null, 2) + '\n' });
        return true;
    }

    var createArgs = githubIssueArgs(ownerRepo, null);
    createArgs.title = title;
    createArgs.body = buildIssueBody(verdict, context, custom.targetRepository ? String(custom.targetRepository) : '');
    var created = github_create_issue(createArgs);
    var number = issueNumberOf(created);
    if (number === null || number === undefined) {
        throw new Error('ci_analyst: github_create_issue returned no issue number for "' + title + '"');
    }
    result.issueCreated = true;
    result.issueNumber = number;
    result.issueUrl = issueUrlOf(created);
    console.log('ci_analyst: created issue #' + number + (result.issueUrl ? ' ' + result.issueUrl : ''));

    var labels = buildLabels(workflowNames);
    if (typeof github_add_labels === 'function') {
        try {
            var labelArgs = githubIssueArgs(ownerRepo, number);
            labelArgs.labels = labels;
            github_add_labels(labelArgs);
            result.labels = labels;
        } catch (labelError) {
            // The issue exists — a failed labeling must not nullify it; the
            // error is recorded and the caller sees it in ci_analyst_result.json.
            console.error('ci_analyst: github_add_labels failed (' + labelError + ')');
            result.labelError = String(labelError);
        }
    } else {
        console.error('ci_analyst: github_add_labels unavailable — issue created without labels');
    }

    var machineAuthor = custom.machineAuthor ? String(custom.machineAuthor).trim() : '';
    if (machineAuthor && typeof github_assign_issue === 'function') {
        try {
            var assignArgs = githubIssueArgs(ownerRepo, number);
            assignArgs.user = machineAuthor;
            github_assign_issue(assignArgs);
            result.assignedTo = machineAuthor;
        } catch (assignError) {
            console.error('ci_analyst: github_assign_issue failed (' + assignError + ')');
            result.assignError = String(assignError);
        }
    } else if (!machineAuthor) {
        console.error('ci_analyst: customParams.machineAuthor empty — issue left unassigned');
    }

    file_write({ path: CI_RESULT_TARGET, content: JSON.stringify(result, null, 2) + '\n' });
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        parseVerdict: parseVerdict,
        normalizeDryRun: normalizeDryRun,
        resolveOwnerRepo: resolveOwnerRepo,
        resolveCustomParams: resolveCustomParams,
        resolveResponseText: resolveResponseText,
        parseContext: parseContext,
        affectedWorkflows: affectedWorkflows,
        buildIssueTitle: buildIssueTitle,
        buildIssueBody: buildIssueBody,
        buildLabels: buildLabels,
        issueNumberOf: issueNumberOf,
        issueUrlOf: issueUrlOf,
        truncate: truncate,
        CI_RESULT_TARGET: CI_RESULT_TARGET,
        CI_HEAL_LABEL: CI_HEAL_LABEL,
        DEV_LABEL: DEV_LABEL
    };
}
