/**
 * CI Analyst — postJSAction: parse the verdict, create ONE GitHub issue.
 *
 * Runs AFTER the CLI agent. The agent wrote outputs/response.md whose FIRST
 * line is the strict verdict JSON (self-heal state machine v2.3):
 *
 *   {"verdict": "adequate"|"needs-human"|"noise", "classification": "<tag>",
 *    "reason": "...", "summary": "...", "suspected_cause": "..."}
 *
 * A legacy line carrying only the boolean "adequate" (v0.0.1 contract) is
 * still accepted: true -> "adequate", false -> "noise".
 *
 * Routing (v2.3):
 *   - adequate    -> dedupe-search, create ONE issue "[ci-heal] <wfs>: failing"
 *                    (labels ci-heal + wf:<name> per affected workflow + agent:dev)
 *                    and ASSIGN machineAuthor. Assignment IS the dev-leg arming
 *                    act (dev-on-assignment matches assignee; labels arm nothing).
 *                    Empty/missing machineAuthor + adequate = LOUD business
 *                    failure ({success:false} record + throw) BEFORE any GitHub
 *                    call — a silent unassigned issue would stall the loop.
 *                    A failed assignment call is equally loud (same stall).
 *   - needs-human -> create ONE issue "[ci-heal] <wfs>: failing (needs-human)"
 *                    WITHOUT any assignment; labels ci-heal + wf:<name> +
 *                    needs-human + agent:skip (agent:skip is in dev-on-assignment's
 *                    notLabels — belt and suspenders if a human assigns later).
 *                    machineAuthor is NOT required for this class.
 *   - noise       -> zero GitHub calls; only the result record is written.
 *   - dryRun      -> no mutation at all (verdict recorded only).
 *
 * NO reopen of previous issues, ever: follow-ups are NEW issues that reference
 * the predecessor in the body ("Follows up #N (closed at <short sha>)" from the
 * context's optional previousIncidents array). This action structurally never
 * calls any reopen/update-issue API.
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
var NEEDS_HUMAN_LABEL = 'needs-human';
var SKIP_LABEL = 'agent:skip';
var VERDICT_CLASSES = ['adequate', 'needs-human', 'noise'];
var VERDICT_KEYS = ['verdict', 'classification', 'reason', 'summary', 'suspected_cause', 'adequate'];

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

/** Route a parsed verdict object to its class; null when it matches no contract. */
function resolveVerdictClass(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.verdict === 'string' && VERDICT_CLASSES.indexOf(parsed.verdict) !== -1) {
        return parsed.verdict;
    }
    if (typeof parsed.adequate === 'boolean') return parsed.adequate ? 'adequate' : 'noise'; // legacy v0.0.1
    return null;
}

/** First single-line strict JSON object in the response that carries a verdict class. */
function parseVerdict(responseText) {
    if (!responseText) return null;
    var lines = String(responseText).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.length < 2 || line.charAt(0) !== '{' || line.charAt(line.length - 1) !== '}') continue;
        if (line.indexOf('"verdict"') === -1 && line.indexOf('"adequate"') === -1) continue;
        try {
            var parsed = JSON.parse(line);
            var verdictClass = resolveVerdictClass(parsed);
            if (verdictClass !== null) {
                var verdict = {
                    verdict: verdictClass,
                    classification: (typeof parsed.classification === 'string') ? parsed.classification : '',
                    adequate: verdictClass === 'adequate',
                    line: i + 1
                };
                for (var k = 0; k < VERDICT_KEYS.length; k++) {
                    var key = VERDICT_KEYS[k];
                    if (key !== 'verdict' && key !== 'adequate' && key !== 'classification' &&
                        typeof parsed[key] === 'string') verdict[key] = parsed[key];
                }
                var linked = parsed.linksIssue !== undefined && parsed.linksIssue !== null ? parseInt(parsed.linksIssue, 10) : NaN;
                if (!isNaN(linked) && linked > 0) verdict.linksIssue = linked;
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
    var empty = { workflows: [], failingRuns: [], newestSha: null, previousIncidents: [] };
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
    // previousIncidents: [{issue, title, closedAt, closedByCommit}] — passed
    // through VERBATIM (the kicker stages them; the analyst reasoned over them).
    var previousIncidents = [];
    if (Object.prototype.toString.call(parsed.previousIncidents) === '[object Array]') {
        previousIncidents = parsed.previousIncidents;
    }
    var openIncidents = [];
    if (Object.prototype.toString.call(parsed.openIncidents) === '[object Array]') {
        openIncidents = parsed.openIncidents;
    }
    return { workflows: workflows, failingRuns: failingRuns, newestSha: newestSha, previousIncidents: previousIncidents, openIncidents: openIncidents };
}

// ── issue assembly ───────────────────────────────────────────────────────────

/** Affected workflows: failing runs first, else the monitored set. */
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

/** adequate/noise keep the v0.0.1 title; needs-human gets a distinct suffix so
 *  title-dedupe never suppresses an adequate issue behind an open escalation. */
function buildIssueTitle(workflowNames, verdictClass) {
    var prefix = (!workflowNames || workflowNames.length === 0) ? 'ci' : workflowNames.join(',');
    if (verdictClass === 'needs-human') return '[ci-heal] ' + prefix + ': failing (needs-human)';
    return '[ci-heal] ' + prefix + ': failing';
}

function truncate(text, max) {
    var value = String(text || '');
    if (value.length <= max) return value;
    return value.slice(0, max) + '\n... (truncated)';
}

function shortSha(commit) {
    var value = String(commit || '').trim();
    return value.length > 7 ? value.slice(0, 7) : value;
}

/** previousIncidents from the staged context (preferred) or customParams (array or JSON string). */
function resolvePreviousIncidents(context, custom) {
    if (context.previousIncidents && context.previousIncidents.length > 0) return context.previousIncidents;
    var raw = custom ? custom.previousIncidents : null;
    if (!raw) return [];
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { return []; }
    }
    if (Object.prototype.toString.call(raw) === '[object Array]') return raw;
    return [];
}

/** openIncidents from the staged context (preferred) or customParams (array or JSON string). */
function resolveOpenIncidents(context, custom) {
    if (context.openIncidents && context.openIncidents.length > 0) return context.openIncidents;
    var raw = custom ? custom.openIncidents : null;
    if (!raw) return [];
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { return []; }
    }
    if (Object.prototype.toString.call(raw) === '[object Array]') return raw;
    return [];
}

/** True when the linked issue number is among the staged OPEN incidents.
 *  A closed/unknown number falls back to normal filing: a re-broken cause
 *  after the linked fix merged is a NEW incident, not a comment. */
function isOpenIncident(openIncidents, number) {
    if (!openIncidents || number === null || number === undefined) return false;
    for (var i = 0; i < openIncidents.length; i++) {
        var item = openIncidents[i] || {};
        if (parseInt(item.number, 10) === number) return true;
    }
    return false;
}

function buildLinkedComment(verdict, context, linkedNumber) {
    var lines = [];
    lines.push('## Analyst linkage (same root cause — no new issue filed)');
    lines.push('');
    lines.push(verdict.summary || '(no summary)');
    lines.push('');
    lines.push('**Suspected cause:** ' + (verdict.suspected_cause || '(unknown)'));
    lines.push('');
    lines.push('**Classification:** `' + (verdict.classification || 'unspecified') + '`' +
        (verdict.reason ? ' (`' + verdict.reason + '`)' : ''));
    if (context.failingRuns && context.failingRuns.length > 0) {
        lines.push('');
        lines.push('**New evidence — failing runs under this root:**');
        for (var i = 0; i < context.failingRuns.length; i++) {
            var run = context.failingRuns[i];
            var label = run.workflow || 'workflow';
            var sha = run.sha ? ' (sha `' + run.sha + '`)' : '';
            lines.push('- [' + label + '](' + run.url + ')' + sha);
        }
    }
    lines.push('');
    lines.push('The fix continues under this issue; no duplicate was filed (v0.0.3 linkage).');
    return lines.join('\n');
}

function buildFollowUpLines(previousIncidents) {
    var lines = [];
    if (!previousIncidents || previousIncidents.length === 0) return lines;
    lines.push('**Follow-ups:**');
    for (var i = 0; i < previousIncidents.length; i++) {
        var incident = previousIncidents[i] || {};
        var issue = incident.issue !== undefined && incident.issue !== null ? String(incident.issue) : '';
        if (!issue) continue;
        if (issue.charAt(0) !== '#') issue = '#' + issue;
        lines.push('- Follows up ' + issue + ' (closed at ' + shortSha(incident.closedByCommit) + ')');
    }
    return lines;
}

/** Enumerated work list: every live failing run in the analyzed window, with its SHA. */
function buildWorkList(failingRuns) {
    var lines = [];
    if (!failingRuns || failingRuns.length === 0) return lines;
    lines.push('**Work list (live causes in the analyzed run window):**');
    lines.push('');
    for (var i = 0; i < failingRuns.length; i++) {
        var run = failingRuns[i];
        var link = run.url ? '[' + (run.workflow || 'workflow') + ' run](' + run.url + ')' : (run.workflow || 'workflow');
        lines.push((i + 1) + '. ' + link + ' @ `' + (run.sha || 'n/a') + '`');
    }
    return lines;
}

function buildEscalationParagraph(verdict) {
    var lines = [];
    lines.push('**Escalation — needs human:** a machine fix was NOT advisable for this failure' +
        ' (classification `' + (verdict.classification || 'unknown') + '`' +
        (verdict.reason ? ', reason `' + verdict.reason + '`' : '') + '):');
    lines.push('');
    lines.push('workflow-infrastructure, credential/token, or flaky-test causes cannot be' +
        ' closed by a dev-leg pull request — automating them would burn machine cycles' +
        ' without removing the failure. A human must triage this issue and close it' +
        ' manually; there is NO `Closes #N` fix protocol here and no dev leg is assigned.');
    return lines;
}

function buildIssueBody(verdict, context, targetRepository, previousIncidents) {
    var verdictClass = verdict.verdict || (verdict.adequate ? 'adequate' : 'noise');
    var lines = [];
    lines.push('## CI failure analysis (automated)');
    lines.push('');
    lines.push(verdict.summary || '(no summary)');
    lines.push('');
    lines.push('**Suspected cause:** ' + (verdict.suspected_cause || '(unknown)'));
    lines.push('');
    lines.push('**Classification:** `' + (verdict.classification || 'unspecified') + '` — verdict **' + verdictClass + '**' +
        (verdict.reason ? ' (`' + verdict.reason + '`)' : ''));
    lines.push('');
    if (verdictClass === 'needs-human') {
        lines = lines.concat(buildEscalationParagraph(verdict));
        lines.push('');
    }
    if (context.failingRuns.length > 0) {
        lines.push('**Failing runs:**');
        for (var i = 0; i < context.failingRuns.length; i++) {
            var run = context.failingRuns[i];
            var label = run.workflow || 'workflow';
            var sha = run.sha ? ' (sha `' + run.sha + '`)' : '';
            lines.push('- [' + label + '](' + run.url + ')' + sha);
        }
        lines.push('');
        lines = lines.concat(buildWorkList(context.failingRuns));
        lines.push('');
    }
    var followUps = buildFollowUpLines(previousIncidents);
    if (followUps.length > 0) {
        lines = lines.concat(followUps);
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
    if (verdictClass === 'adequate') {
        lines.push('**Fix protocol:** the PR that fixes this issue MUST close it natively — include' +
            ' `Closes #<this issue number>` in the PR description. The native close records the' +
            ' closure commit, which is the state anchor the CI kicker uses to treat older failing' +
            ' runs as that incident\'s history.');
        lines.push('');
    }
    lines.push('---');
    lines.push('<sub>Filed by the ci_analyst agent leg. Do not edit the title/labels.</sub>');
    return lines.join('\n');
}

/** adequate -> [ci-heal, agent:dev, wf:*]; needs-human -> [ci-heal, needs-human, agent:skip, wf:*]. */
function buildLabels(workflowNames, verdictClass) {
    var labels = [CI_HEAL_LABEL];
    if (verdictClass === 'needs-human') {
        labels.push(NEEDS_HUMAN_LABEL, SKIP_LABEL);
    } else {
        labels.push(DEV_LABEL);
    }
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
    var previousIncidents = resolvePreviousIncidents(context, custom);
    var workflowNames = affectedWorkflows(context, verdict);
    var verdictClass = verdict ? verdict.verdict : null;
    var result = {
        dryRun: dryRun,
        verdictParsed: verdict !== null,
        verdict: verdictClass,
        adequate: verdict ? verdict.adequate : null,
        issueCreated: false,
        duplicate: false
    };
    if (verdict && verdict.classification) result.classification = verdict.classification;

    function writeResult() {
        file_write({ path: CI_RESULT_TARGET, content: JSON.stringify(result, null, 2) + '\n' });
    }

    if (!verdict) {
        console.error('ci_analyst: no strict verdict JSON line found in outputs/response.md — skipping issue creation');
        result.error = 'no verdict JSON line in response';
        writeResult();
        return true;
    }

    result.summary = verdict.summary;

    if (verdictClass === 'noise') {
        console.log('ci_analyst: verdict = noise — no issue created');
        writeResult();
        return true;
    }
    if (dryRun) {
        console.log('ci_analyst: dryRun=true — verdict recorded, NO issue created');
        writeResult();
        return true;
    }

    // v0.0.3 linkage: same root cause as an OPEN incident -> comment on that
    // issue instead of filing a duplicate. No assignment changes: the linked
    // issue keeps owning the fix (its arm already stands). A failed comment
    // is recorded but NOT fatal — the next kick re-detects the lane (its
    // wf: label has no open issue yet) and re-links, so nothing stalls.
    if (verdict.linksIssue !== undefined) {
        var openIncidents = resolveOpenIncidents(context, custom);
        var linkedNumber = verdict.linksIssue;
        if (isOpenIncident(openIncidents, linkedNumber)) {
            var commentArgs = githubIssueArgs(ownerRepo, linkedNumber);
            commentArgs.body = buildLinkedComment(verdict, context, linkedNumber);
            var commentFn = null;
            if (typeof github_add_issue_comment === 'function') commentFn = github_add_issue_comment;
            else if (typeof github_create_issue_comment === 'function') commentFn = github_create_issue_comment;
            else if (typeof github_issue_comment === 'function') commentFn = github_issue_comment;
            if (commentFn === null) {
                result.linkError = 'no issue-comment global available (' + commentNames.join('|') + ')';
                console.error('ci_analyst: ' + result.linkError);
            } else {
                try {
                    commentFn(commentArgs);
                    result.linkedIssue = linkedNumber;
                    result.linked = true;
                    console.log('ci_analyst: linked to open issue #' + linkedNumber + ' (same root cause) — no new issue filed');
                    writeResult();
                    return true;
                } catch (linkErr) {
                    result.linkError = String(linkErr);
                    console.error('ci_analyst: comment on #' + linkedNumber + ' failed (' + linkErr + ') — next kick will re-link');
                }
            }
        } else {
            console.log('ci_analyst: linksIssue #' + linkedNumber + ' is not among open incidents — filing normally (re-broken after fix)');
        }
    }

    // LOUD business failure guard: adequate + no machineAuthor = an unassigned
    // issue nothing will ever arm on. Fail BEFORE any GitHub call.
    var machineAuthor = custom.machineAuthor ? String(custom.machineAuthor).trim() : '';
    if (verdictClass === 'adequate' && machineAuthor === '') {
        result.success = false;
        result.machineAuthorMissing = true;
        result.error = 'adequate verdict requires customParams.machineAuthor — assignment is the dev-leg arming act; refusing to create a silent unassigned issue';
        console.error('ci_analyst: ' + result.error);
        writeResult();
        throw new Error('ci_analyst: ' + result.error);
    }

    var title = buildIssueTitle(workflowNames, verdictClass);
    var duplicate = findOpenDuplicate(ownerRepo, title);
    if (duplicate) {
        result.duplicate = true;
        result.issueUrl = issueUrlOf(duplicate);
        console.log('ci_analyst: open ci-heal issue already exists for this title — not creating a second one' +
            (result.issueUrl ? ' (' + result.issueUrl + ')' : ''));
        writeResult();
        return true;
    }

    var createArgs = githubIssueArgs(ownerRepo, null);
    createArgs.title = title;
    createArgs.body = buildIssueBody(verdict, context, custom.targetRepository ? String(custom.targetRepository) : '', previousIncidents);
    var created = github_create_issue(createArgs);
    var number = issueNumberOf(created);
    if (number === null || number === undefined) {
        throw new Error('ci_analyst: github_create_issue returned no issue number for "' + title + '"');
    }
    result.issueCreated = true;
    result.issueNumber = number;
    result.issueUrl = issueUrlOf(created);
    if (verdictClass === 'needs-human') result.needsHuman = true;
    console.log('ci_analyst: created issue #' + number + ' (verdict ' + verdictClass + ')' +
        (result.issueUrl ? ' ' + result.issueUrl : ''));

    var labels = buildLabels(workflowNames, verdictClass);
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

    if (verdictClass === 'adequate') {
        if (typeof github_assign_issue === 'function') {
            try {
                var assignArgs = githubIssueArgs(ownerRepo, number);
                assignArgs.user = machineAuthor;
                github_assign_issue(assignArgs);
                result.assignedTo = machineAuthor;
            } catch (assignError) {
                // Assignment IS the dev-leg arming act — a failed assignment
                // leaves exactly the silent stall the guard above prevents.
                result.success = false;
                result.assignError = String(assignError);
                console.error('ci_analyst: github_assign_issue failed (' + assignError + ') — the issue stays unarmed');
                writeResult();
                throw new Error('ci_analyst: github_assign_issue failed for #' + number + ' (' + assignError + ')');
            }
        } else {
            console.error('ci_analyst: github_assign_issue unavailable — issue created without assignee');
        }
    }
    // needs-human: deliberately NO assignment (unassigned matches dev-on-assignment
    // on nothing; agent:skip additionally guards a manual assignment).

    writeResult();
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        parseVerdict: parseVerdict,
        resolveVerdictClass: resolveVerdictClass,
        normalizeDryRun: normalizeDryRun,
        resolveOwnerRepo: resolveOwnerRepo,
        resolveCustomParams: resolveCustomParams,
        resolveResponseText: resolveResponseText,
        parseContext: parseContext,
        affectedWorkflows: affectedWorkflows,
        buildIssueTitle: buildIssueTitle,
        buildIssueBody: buildIssueBody,
        buildWorkList: buildWorkList,
        buildFollowUpLines: buildFollowUpLines,
        buildLabels: buildLabels,
        resolvePreviousIncidents: resolvePreviousIncidents,
        resolveOpenIncidents: resolveOpenIncidents,
        isOpenIncident: isOpenIncident,
        buildLinkedComment: buildLinkedComment,
        shortSha: shortSha,
        issueNumberOf: issueNumberOf,
        issueUrlOf: issueUrlOf,
        truncate: truncate,
        CI_RESULT_TARGET: CI_RESULT_TARGET,
        CI_HEAL_LABEL: CI_HEAL_LABEL,
        DEV_LABEL: DEV_LABEL,
        NEEDS_HUMAN_LABEL: NEEDS_HUMAN_LABEL,
        SKIP_LABEL: SKIP_LABEL,
        VERDICT_CLASSES: VERDICT_CLASSES
    };
}
