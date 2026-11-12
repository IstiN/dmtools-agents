/**
 * GitLab MR↔issue linkage wait — factory post-run check race fix.
 *
 * GitLab extracts the 'Closes #N' reference from an MR description
 * asynchronously (a Sidekiq worker runs after the MR is created). The GitLab
 * factory pipeline (factory-teammate.yml helpers) queries
 * issues/:iid/related_merge_requests immediately after dmtools exits and
 * fails the dev leg with "Dev run finished without an open merge request"
 * when the list is still empty — a false negative observed live: the MR
 * existed and was linked moments later, but the issue was already parked
 * with needs-human.
 *
 * afterMrCreated(mr, body) is called by the scm.js GitLab provider right
 * after gitlab_create_mr: it blocks until GitLab reports the created MR in
 * the issue's related_merge_requests (bounded), so by the time dmtools exits
 * the pipeline check is guaranteed to see the link. Outside GitLab CI the
 * required environment variables are absent and this is a no-op.
 */

var MAX_ATTEMPTS = 24;
var INTERVAL_MS = 5000;

// Reads one env var: Java (GraalJS host) first, then process.env (node harness).
function envValue(name) {
    var fromJava = javaEnv(name);
    if (fromJava !== null) return fromJava;
    return nodeEnv(name);
}

function javaEnv(name) {
    try {
        if (typeof java === 'undefined') return null;
        var value = java.lang.System.getenv(name);
        return value === null || value === undefined ? null : String(value);
    } catch (e) {
        return null;
    }
}

function nodeEnv(name) {
    try {
        if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
            return String(process.env[name]);
        }
    } catch (e) {}
    return '';
}

function sleepMs(ms) {
    try {
        if (typeof java !== 'undefined') java.lang.Thread.sleep(ms);
    } catch (e) {}
}

function defaultRunCommand(args) {
    return cli_execute_command(args);
}

function resolveDeps(deps) {
    deps = deps || {};
    return {
        env: deps.env || envValue,
        sleep: deps.sleep || sleepMs,
        runCommand: deps.runCommand || defaultRunCommand,
        maxAttempts: deps.maxAttempts || MAX_ATTEMPTS
    };
}

function hasCiEnv(env) {
    return Boolean(env('CI_API_V4_URL') && env('CI_PROJECT_ID') && env('GITLAB_TOKEN'));
}

// $GITLAB_TOKEN expands inside the job shell, so the token never appears in
// the logged tool arguments.
function relatedMrsCommand(apiUrl, projectId, issueIid) {
    var endpoint = apiUrl + '/projects/' + projectId + '/issues/' + issueIid +
        '/related_merge_requests?per_page=100';
    return 'bash -c \'curl --fail --silent --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "' + endpoint + '"\'';
}

function parseRelated(raw) {
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { return []; }
    }
    return Array.isArray(raw) ? raw : [];
}

// project_id must match too — a same-iid MR from another project must not
// satisfy the wait.
function containsLinkedMr(related, mrIid, projectId) {
    for (var i = 0; i < related.length; i++) {
        var candidate = related[i] || {};
        if (String(candidate.iid) === String(mrIid) && String(candidate.project_id) === String(projectId)) {
            return true;
        }
    }
    return false;
}

// One API probe: 'linked' | 'retry' | 'abort' (abort = the CLI whitelist
// rejected the command — that never recovers, so polling must stop).
function pollOnce(command, mrIid, projectId, runCommand) {
    try {
        var related = parseRelated(runCommand({ command: command }));
        return containsLinkedMr(related, mrIid, projectId) ? 'linked' : 'retry';
    } catch (e) {
        var message = String((e && e.message) || e);
        console.warn('Related merge requests lookup failed:', message);
        return message.indexOf('Command not allowed') !== -1 || message.indexOf('not whitelisted') !== -1
            ? 'abort' : 'retry';
    }
}

function pollUntilLinked(command, mrIid, projectId, d) {
    for (var attempt = 1; attempt <= d.maxAttempts; attempt++) {
        var outcome = pollOnce(command, mrIid, projectId, d.runCommand);
        if (outcome === 'linked') {
            console.log('✅ GitLab linked MR !' + mrIid + ' to its issue');
            return true;
        }
        if (outcome === 'abort') break;
        if (attempt < d.maxAttempts) d.sleep(INTERVAL_MS);
    }
    console.warn('GitLab did not report MR !' + mrIid + ' as a related merge request in time; ' +
        'the factory post-run MR check may fail.');
    return false;
}

/**
 * Blocks until the issue closed by `description` ('Closes #N', same project)
 * lists MR !mrIid among its related merge requests. Returns true when the
 * link is visible; false when it timed out or there was nothing to wait for
 * (no MR iid, no same-project Closes line, or not a GitLab CI factory run).
 */
function waitForIssueLink(mrIid, description, deps) {
    var d = resolveDeps(deps);
    var closes = /\bCloses\s+#(\d+)\b/i.exec(String(description || ''));
    if (!mrIid || !closes || !hasCiEnv(d.env)) return false;
    console.log('Waiting for GitLab to link MR !' + mrIid + ' to issue #' + closes[1] + '...');
    var command = relatedMrsCommand(d.env('CI_API_V4_URL'), d.env('CI_PROJECT_ID'), closes[1]);
    return pollUntilLinked(command, mrIid, d.env('CI_PROJECT_ID'), d);
}

// The scm.js GitLab provider seam: passthrough of the normalized MR so the
// call folds into the existing assignment without changing its shape.
function afterMrCreated(mr, body, deps) {
    if (mr && mr.number) waitForIssueLink(mr.number, body, deps);
    return mr;
}

module.exports = {
    afterMrCreated: afterMrCreated,
    waitForIssueLink: waitForIssueLink,
    // internals exposed for direct unit coverage (keeps per-function CRAP low)
    envValue: envValue,
    javaEnv: javaEnv,
    nodeEnv: nodeEnv,
    sleepMs: sleepMs,
    resolveDeps: resolveDeps,
    hasCiEnv: hasCiEnv,
    relatedMrsCommand: relatedMrsCommand,
    parseRelated: parseRelated,
    containsLinkedMr: containsLinkedMr,
    pollOnce: pollOnce,
    pollUntilLinked: pollUntilLinked,
    defaultRunCommand: defaultRunCommand
};
