/**
 * SM Agent — Scrum Master automation (JSRunner)
 *
 * Reads an array of rules from params.rules (defined in agents/sm.json)
 * and for each rule:
 *   1. Queries Jira by rule.jql (with {jiraProject}/{parentTicket} interpolation)
 *   2. Optionally transitions each ticket to rule.targetStatus
 *   3. Runs the agent for each matching ticket, via one of three modes:
 *      - dispatch (default) — triggers an ai-teammate GitHub Actions workflow (async)
 *      - localExecution: true — runs the agent config's postJSAction directly in the
 *        SM process (pure JS, no AI CLI, no checkout — for fast/safe operations)
 *      - localTeammate: true — runs the FULL teammate pipeline (checkout/branch switch,
 *        AI CLI, PR/Jira actions) synchronously on the local machine via
 *        scripts/run-teammate-local.sh, one ticket at a time (no GitHub Actions runner)
 *
 * Configuration:
 *   Loads project config from .dmtools/config.js (via configLoader).
 *   If config.smRules is provided, uses those instead of params.rules (full override).
 *   Repository owner/repo from config override params when present.
 *   JQL placeholders {jiraProject} and {parentTicket} are resolved from config.
 *   jobParams.maxTriggeredWorkflows (or maxWorkflowsPerRun) limits total active plus newly
 *   dispatched workflows across all non-local rules.
 *   Override priority: config.smMaxWorkflows (from .dmtools/config.js) > sm.json value.
 *   jobParams.forceLocalTeammate — set via a CLI JSON override (note the outer `params`
 *   wrapper — `dmtools run <file> <override>` deep-merges into the whole {name, params}
 *   job config, not directly into params.jobParams; a bare {"jobParams":{...}} override
 *   is silently ignored):
 *   `dmtools run agents/sm.json '{"params":{"jobParams":{"forceLocalTeammate":true}}}'`
 *   to switch EVERY default-dispatch rule to the local teammate pipeline for that run,
 *   without editing sm.json/.dmtools/config.js. Rules with localExecution:true are
 *   unaffected; a rule can still opt out with an explicit `localTeammate: false`.
 *
 * Rule fields:
 *   jql            (required) — JQL to find tickets (supports {jiraProject}, {parentTicket})
 *   configFile     (required) — agents/*.json to pass as config_file workflow input
 *   configPath     (optional) — path to a project config (.dmtools/config.js) for this rule
 *                               overrides the global config; enables multi-project orchestration
 *   description    (optional) — human-readable label shown in logs
 *   targetStatus   (optional) — Jira status to transition tickets to before triggering
 *   workflowFile   (optional) — GitHub Actions workflow file  (default: ai-teammate.yml)
 *   workflowRef    (optional) — git ref for dispatch           (default: main)
 *   concurrencyKey (optional) — workflow concurrency key override (default: ticket key)
 *   projectKey     (optional) — value passed as the `project_key` workflow input so the runner
 *                               activates the correct project-specific dependency setup (e.g. "myproject",
 *                               "bice"). Auto-derived from configPath basename when not set
 *                               (e.g. ".dmtools/configs/myproject.js" → "myproject").
 *   skipIfLabel    (optional) — skip ticket if it already has this label (idempotency)
 *   skipIfLabels   (optional) — skip ticket if it already has any of these labels
 *   addLabel       (optional) — add this label after triggering (idempotency marker)
 *   addLabels      (optional) — add these labels after triggering
 *   recoverStaleTriggerLabel (optional) — if true, remove skip labels when no matching
 *                               active workflow exists and continue processing. Trigger
 *                               labels that are also added by the same rule recover by
 *                               default; set false to opt out.
 *   enabled        (optional) — set to false to disable the rule entirely (default: true)
 *   limit          (optional) — max number of tickets to process per run (default: 50)
 *   localExecution (optional) — if true, run postJSAction directly (no runner, no AI/CLI)
 *   localTeammate  (optional) — if true, run the full teammate pipeline (checkout, AI CLI,
 *                               PR/Jira actions) synchronously in-process via
 *                               scripts/run-teammate-local.sh instead of dispatching a
 *                               GitHub Actions workflow_dispatch. Tickets are processed
 *                               strictly one at a time (the local checkout is reused across
 *                               tickets, so no concurrency/workflowBudget accounting applies).
 *                               Secrets are read from the calling shell's environment or from
 *                               dmtools.env (see scripts/run-agent.sh loader) — never from
 *                               GitHub Actions secrets.
 *   localTeammateScript (optional) — path to the local runner script
 *                               (default: agents/scripts/run-teammate-local.sh)
 */

// Dry-run mode: log every side effect instead of performing it (dispatches,
// label moves, status moves, local executions). Set from jobParams.dryRun.
var DRY = false;

var configLoader = require('./configLoader.js');
var smSource = require('./sm/sourceResolver.js');
var scmModule = require('./common/scm.js');
var factoryStateModule = require('./factoryState.js');
var buildEncodedConfigModule = require('./common/buildEncodedConfig.js');
var machineAuthorModule = require('./common/machineAuthor.js');
var smProviderModule = require('./common/smProvider.js');

// Project config loaded once in action() — used as global default for rules without configPath
var projectConfig = null;
var STALE_NON_RUNNING_WORKFLOW_MS = 6 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the effective config for a rule.
 * If rule.configPath is set, loads that config (enables per-rule / multi-project override).
 * Otherwise falls back to the global projectConfig.
 */
function loadRuleConfig(rule) {
    if (!rule.configPath) return projectConfig;
    var ruleConfig = configLoader.loadProjectConfig({ configPath: rule.configPath });
    console.log('  🔧 Rule config: ' + rule.configPath +
        (ruleConfig.jira.project ? ' (project: ' + ruleConfig.jira.project + ')' : ''));
    return ruleConfig;
}

function parseWorkflowRuns(raw) {
    if (!raw) return [];
    var parsed = raw;
    if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch (e) { return []; }
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.workflow_runs)) return parsed.workflow_runs;
    if (parsed && Array.isArray(parsed.runs)) return parsed.runs;
    return [];
}

function labelList(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function isRuleTriggerLabel(rule, label) {
    var labels = labelList(rule.addLabel).concat(labelList(rule.addLabels));
    for (var i = 0; i < labels.length; i++) {
        if (labels[i] === label) return true;
    }
    return false;
}

function shouldRecoverStaleTriggerLabel(rule, label) {
    if (rule.recoverStaleTriggerLabel === true) return true;
    if (rule.recoverStaleTriggerLabel === false) return false;
    return isRuleTriggerLabel(rule, label);
}

function hasActiveTargetWorkflowRun(scm, workflowFile, configFile, ticketKey) {
    if (!scm || typeof scm.listWorkflowRuns !== 'function') return false;

    var expectedRunName = configFile + ' : ' + ticketKey;
    var expectedRunNameSuffix = ' : ' + ticketKey;
    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];

    for (var i = 0; i < statuses.length; i++) {
        var runs = [];
        try {
            runs = parseWorkflowRuns(scm.listWorkflowRuns(statuses[i], workflowFile, 50));
        } catch (e) {
            console.warn('  ⚠️  Could not inspect active workflow runs (' + statuses[i] + '): ' + (e.message || e));
            continue;
        }

        for (var j = 0; j < runs.length; j++) {
            var run = runs[j] || {};
            if (isStaleNonRunningWorkflowRun(run, statuses[i])) continue;
            // GitHub REST carries BOTH fields: `name` is the workflow name
            // ('AI Teammate') while `display_title` is the per-run title
            // ('▶ review (SM) · gh-702'). Name-first made the stub-title
            // match dead code — every SM-dispatched run slipped the
            // in-flight guard and duplicated (live: gh-702 review ×2).
            var runName = run.display_title || run.displayTitle || run.name || '';
            var matchesOldName = runName === expectedRunName;
            var matchesDisplayName = runName.indexOf(configFile + ' : ') === 0 &&
                runName.substring(runName.length - expectedRunNameSuffix.length) === expectedRunNameSuffix;
            // Stub-title match (#687): the caller-side stub names its runs
            // '▶ <leg> (SM) · gh-<key>' / '· pr-<key>' — recognize the
            // ticket key token so PR-anchored dispatches are not re-fired
            // on every tick while the review is still running.
            var matchesStubName = runName.indexOf('· ' + ticketKey) !== -1;
            if (matchesOldName || matchesDisplayName || matchesStubName) {
                console.log('  ⏭️  ' + ticketKey + ' skipped (active workflow already exists: ' + expectedRunName + ')');
                return true;
            }
        }
    }

    return false;
}

function workflowRunTimestamp(run) {
    var value = run && (run.updated_at || run.updatedAt || run.created_at || run.createdAt);
    if (!value) return null;
    var timestamp = Date.parse(value);
    return isNaN(timestamp) ? null : timestamp;
}

function isStaleNonRunningWorkflowRun(run, status) {
    if (status === 'in_progress') return false;
    var timestamp = workflowRunTimestamp(run);
    if (!timestamp) return false;
    return (Date.now() - timestamp) > STALE_NON_RUNNING_WORKFLOW_MS;
}

function workflowRunAge(run) {
    var timestamp = workflowRunTimestamp(run);
    if (!timestamp) return '';

    var ageMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (ageMinutes < 60) return ageMinutes + 'm';
    var ageHours = Math.floor(ageMinutes / 60);
    var remainingMinutes = ageMinutes % 60;
    return ageHours + 'h' + (remainingMinutes ? ' ' + remainingMinutes + 'm' : '');
}

function formatWorkflowRunSummary(run, fallbackStatus) {
    run = run || {};
    var title = run.display_title || run.displayTitle || run.name || 'workflow run';
    var status = run.status || fallbackStatus || 'active';
    var age = workflowRunAge(run);
    var id = run.id || run.databaseId || run.run_number || run.runNumber || '?';
    var url = run.html_url || run.htmlUrl || run.url || '';
    return title + ' [' + status + ', age ' + (age || '?') + ', id ' + id + ']' + (url ? ' ' + url : '');
}

function collectActiveWorkflowRuns(scm, workflowFile) {
    if (!scm || typeof scm.listWorkflowRuns !== 'function') return { count: 0, summaries: [] };

    var statuses = ['queued', 'in_progress', 'waiting', 'pending'];
    var seen = {};
    var count = 0;
    var summaries = [];

    for (var i = 0; i < statuses.length; i++) {
        var runs = [];
        try {
            runs = parseWorkflowRuns(scm.listWorkflowRuns(statuses[i], workflowFile, 50));
        } catch (e) {
            console.warn('  ⚠️  Could not count active workflow runs (' + statuses[i] + '): ' + (e.message || e));
            continue;
        }

        for (var j = 0; j < runs.length; j++) {
            var run = runs[j] || {};
            if (isStaleNonRunningWorkflowRun(run, statuses[i])) continue;
            var id = run.id || run.databaseId || run.run_number || ((run.name || run.display_title || '') + ':' + j + ':' + statuses[i]);
            if (!seen[id]) {
                seen[id] = true;
                count += 1;
                summaries.push(formatWorkflowRunSummary(run, statuses[i]));
            }
        }
    }

    return { count: count, summaries: summaries };
}

function countActiveWorkflowRuns(scm, workflowFile) {
    return collectActiveWorkflowRuns(scm, workflowFile).count;
}

function logBlockingWorkflowRuns(workflowBudget, workflowFile) {
    if (!workflowBudget || !workflowBudget.activeRunSummariesByWorkflow) return;
    var summaries = workflowBudget.activeRunSummariesByWorkflow[workflowFile] || [];
    if (!summaries.length) return;

    console.log('  Blocking active workflow run(s):');
    summaries.slice(0, 5).forEach(function(summary) {
        console.log('   - ' + summary);
    });
    if (summaries.length > 5) {
        console.log('   - ... +' + (summaries.length - 5) + ' more');
    }
}

function ensureWorkflowBudgetActiveCount(workflowBudget, scm, workflowFile) {
    if (!workflowBudget) return;
    if (!workflowBudget.activeCountsByWorkflow) workflowBudget.activeCountsByWorkflow = {};
    if (workflowBudget.activeCountsByWorkflow[workflowFile]) return;
    if (!workflowBudget.activeRunSummariesByWorkflow) workflowBudget.activeRunSummariesByWorkflow = {};

    var active = collectActiveWorkflowRuns(scm, workflowFile);
    var activeCount = active.count;
    workflowBudget.activeCount = (workflowBudget.activeCount || 0) + activeCount;
    workflowBudget.remaining = Math.max(0, workflowBudget.remaining - activeCount);
    workflowBudget.activeCountsByWorkflow[workflowFile] = true;
    workflowBudget.activeRunSummariesByWorkflow[workflowFile] = active.summaries;

    if (activeCount > 0) {
        console.log('  Active workflow cap accounting: ' + activeCount + ' active, ' + workflowBudget.remaining + ' dispatch slot(s) left');
        logBlockingWorkflowRuns(workflowBudget, workflowFile);
    }
}

// Creates the SCM client pinned to the rule's EFFECTIVE target repo.
// The SM engine runs from the dmtools-agents checkout, so createScm's
// git-remote autodetect would otherwise resolve the ENGINE repo whenever
// the config carries no explicit repository (live: the in-flight guard
// listed runs in IstiN/dmtools-agents while the dispatch went to
// flutter_agent_harness — duplicate review gh-691).
function createTargetScm(effectiveConfig, repoInfo) {
    if (!repoInfo || !repoInfo.owner || !repoInfo.repo) {
        return scmModule.createScm(effectiveConfig);
    }
    var cfg = {};
    if (effectiveConfig) {
        for (var k in effectiveConfig) {
            if (Object.prototype.hasOwnProperty.call(effectiveConfig, k)) cfg[k] = effectiveConfig[k];
        }
    }
    cfg.repository = { owner: repoInfo.owner, repo: repoInfo.repo };
    return scmModule.createScm(cfg);
}

function isWorkflowBudgetExhausted(rule, effectiveConfig, workflowBudget, repoInfo) {
    if (!workflowBudget) return false;

    var workflowFile = rule.workflowFile || 'ai-teammate.yml';
    var scm = createTargetScm(effectiveConfig, repoInfo);
    ensureWorkflowBudgetActiveCount(workflowBudget, scm, workflowFile);
    return workflowBudget.remaining <= 0;
}

// True when `issueNumber` resolves to an existing LOCAL issue in repoInfo
// (#544): the body-scrape path (githubSource.linkedIssueNumber) already skips
// repo-qualified cross-repo refs, but a BARE '#N' can still dangle (deleted
// issue, or a ref pointing at a repo the qualifier missed). Anchoring a
// dispatch on such a number 404s in the factory guard — verify existence
// here and let the caller degrade to a PR-anchored dispatch.
//
// Bridge reality (live: dmd #266, run 36332635090 — the AUTO review dispatch
// anchored gh-601): the sync github_get_issue tool does NOT throw on 404 —
// it returns the REST error BODY ('{"message":"Not Found",...}'). The
// original try/catch-only check therefore trusted any non-throwing result
// and the dangling scrape anchored gh-<N> on the AUTO review/rework paths.
// The result body is inspected: a real issue JSON carries its `number`; an
// error body carries `message`. Anything unverifiable counts as missing —
// this check only runs when the item has a PR anchor (it.prNumber), so the
// PR-anchored fallback is always viable, while a bogus gh-<N> anchor 404s
// the factory guard and reds the whole SM cycle. Forges/runtimes without
// the github_get_issue tool skip the check and trust the scrape (legacy
// behavior, unchanged).
function localIssueExists(repoInfo, issueNumber) {
    if (typeof github_get_issue !== 'function') return true;
    var res;
    try {
        res = github_get_issue({
            workspace: repoInfo.owner,
            repository: repoInfo.repo,
            issueNumber: issueNumber
        });
    } catch (e) {
        return false; // throwing bridges (mocks, some forges) — 404 throws
    }
    var obj = res;
    if (typeof res === 'string') {
        try { obj = JSON.parse(res); } catch (e2) { obj = null; }
    }
    if (obj && typeof obj === 'object') {
        return typeof obj.number === 'number' && !obj.message;
    }
    return false; // empty/unparseable body — unverifiable, do not anchor
}

function triggerWorkflow(repoInfo, ticketKey, rule, effectiveConfig, workflowBudget, item) {
    var workflowFile = rule.workflowFile || 'ai-teammate.yml';
    // workflowRef may reference the matched item: '{branch}' dispatches the
    // leg ON the PR head so GitHub links the run to the PR (checks + PR
    // timeline) — e.g. review/rework legs become pr-visible runs. An empty
    // expansion (no linked PR / no head) falls back to 'main'.
    var workflowRef  = rule.workflowRef  || 'main';
    var it0 = item || {};
    workflowRef = String(workflowRef)
        .replace(/\{branch\}/g, String(it0.branch || ''))
        .replace(/\{prNumber\}/g, String(it0.prNumber || ''));
    if (!workflowRef) workflowRef = 'main';
    var resolvedCf   = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
    var concurrencyKey = rule.concurrencyKey || ticketKey;

    // Resolve project_key: explicit rule field takes priority, then auto-derive from configPath
    // e.g. ".dmtools/configs/myproject.js" → "myproject", ".dmtools/configs/bice.js" → "bice"
    var projectKey = rule.projectKey || '';
    if (!projectKey && effectiveConfig && effectiveConfig._configPath) {
        var cp = effectiveConfig._configPath;
        var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
        if (base && base !== 'config') projectKey = base;
    }

    try {
        var scm = createTargetScm(effectiveConfig, repoInfo);
        ensureWorkflowBudgetActiveCount(workflowBudget, scm, workflowFile);
        if (workflowBudget && workflowBudget.remaining <= 0) {
            console.log('  ⏭️  ' + ticketKey + ' skipped (global workflow cap reached: ' + workflowBudget.initial + ')');
            logBlockingWorkflowRuns(workflowBudget, workflowFile);
            return false;
        }
        if (hasActiveTargetWorkflowRun(scm, workflowFile, resolvedCf, concurrencyKey)) {
            return false;
        }
        var inputs;
        if (rule.inputs) {
            // Rule-declared dispatch inputs (github-source rules): values may
            // reference the matched item via '{key}' / '{issueNumber}' /
            // '{prNumber}' placeholders.
            var it = item || {};
            // {issueNumber} on a PR-carrier item without a linked issue must
            // NOT fall back to the ticket key — dispatching issue='pr-N'
            // breaks the factory guard's anchor validation.
            var needsIssue = Object.keys(rule.inputs).some(function (k) {
                return String(rule.inputs[k]).indexOf('{issueNumber}') !== -1;
            });
            // #544: the linked issue on a PR-carrier item came from a body
            // scrape — verify it resolves to an EXISTING LOCAL issue before
            // anchoring the dispatch on it. A cross-repo/dangling ref
            // ('dm.ai #601') would 404 in the factory guard.
            var issueNumber = (it.issueNumber === undefined || it.issueNumber === null)
                ? null : it.issueNumber;
            if (needsIssue && issueNumber !== null && it.prNumber) {
                if (!localIssueExists(repoInfo, issueNumber)) {
                    console.log('  ⚠️  #' + issueNumber + ' scraped from PR #' + it.prNumber +
                        ' does not exist in ' + repoInfo.owner + '/' + repoInfo.repo +
                        ' (cross-repo or dangling ref) — not a local anchor (#544)');
                    issueNumber = null;
                }
            }
            var prAnchoredFallback = false;
            if (needsIssue && issueNumber === null) {
                // #544 owner rule 3 (PR-only anchor): the labeled PR has no
                // resolvable LOCAL issue — anchor the leg on the PR itself
                // (inputs.pr) instead of skipping. Covers guest/issue-less
                // PRs: a drive-by PR the owner labels agent:rework MUST be
                // reworkable. The factory guard's PR-anchored branch runs
                // the rework leg on pr-<N>.
                if (it.prNumber) {
                    prAnchoredFallback = true;
                    console.log('  🔀 ' + ticketKey + ' links no local issue — dispatching PR-anchored instead (#544)');
                } else {
                    console.log('  ⏭️  ' + ticketKey + ' skipped (rule "' + (rule.id || '') +
                        '" needs {issueNumber} but the item links no issue and has no PR anchor)');
                    return false;
                }
            }
            inputs = {};
            Object.keys(rule.inputs).forEach(function (k) {
                inputs[k] = String(rule.inputs[k])
                    .replace(/\{key\}/g, String(ticketKey))
                    .replace(/\{issueNumber\}/g, String(issueNumber !== null ? issueNumber : (prAnchoredFallback ? '' : ticketKey)))
                    .replace(/\{prNumber\}/g, String(it.prNumber || ''));
            });
            if (prAnchoredFallback) {
                inputs.issue = '';
                inputs.pr = String(it.prNumber);
            }
        } else {
            inputs = {
                concurrency_key: concurrencyKey,
                display_key:     ticketKey,
                input_jql:       'key = ' + ticketKey,
                config_file:     resolvedCf,
                encoded_config:  buildEncodedConfigModule.buildEncodedConfig(ticketKey, rule, effectiveConfig),
                project_key:     projectKey
            };
        }
        if (DRY) {
            console.log('  [dry] ▶️ ' + ticketKey + ' dispatch:' + workflowFile + ' inputs=' + JSON.stringify(inputs));
            return;
        }
        scm.triggerWorkflow(
            repoInfo.owner,
            repoInfo.repo,
            workflowFile,
            JSON.stringify(inputs),
            workflowRef
        );
        console.log('  ✅ Triggered ' + workflowFile + '@' + workflowRef + ' for ' + ticketKey +
            (projectKey ? ' [project_key=' + projectKey + ']' : ''));
        return true;
    } catch (e) {
        console.warn('  ⚠️  Workflow trigger failed for ' + ticketKey + ': ' + (e.message || e));
        return false;
    }
}

/**
 * Runs the full teammate pipeline locally (synchronously) instead of dispatching a
 * GitHub Actions workflow_dispatch. Delegates checkout/branch-switching, the AI CLI
 * run, and PR/Jira post-actions to scripts/run-teammate-local.sh — the same
 * agents/*.json config and dmtools `run` entrypoint used by ai-teammate.yml, just
 * invoked on the local machine instead of a runner.
 *
 * Because cli_execute_command() blocks until the child process exits, calling this
 * from the same sequential ticket loop as triggerWorkflow() naturally enforces
 * one-ticket-at-a-time processing — no separate queue/scheduler is needed.
 */
function runTeammateLocally(ticketKey, rule, effectiveConfig) {
    var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
    // isLocal=true marks the encoded config with customParams.localTeammate=true so
    // any autoStartReview/autoStartRework chaining triggered by this job's postJSAction
    // (see js/common/autoStart.js) keeps running on this machine instead of dispatching
    // a GitHub Actions workflow_dispatch that can't see this checkout's in-flight state.
    var encodedConfig = buildEncodedConfigModule.buildEncodedConfig(ticketKey, rule, effectiveConfig, true);

    var projectKey = rule.projectKey || '';
    if (!projectKey && effectiveConfig && effectiveConfig._configPath) {
        var cp = effectiveConfig._configPath;
        var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
        if (base && base !== 'config') projectKey = base;
    }

    var scriptPath = rule.localTeammateScript || 'agents/scripts/run-teammate-local.sh';
    // Write the encoded config to a temp file rather than inlining it as a CLI argument —
    // avoids shell-escaping a large/multiline JSON blob (the script reads it back with $(cat ...)).
    var encodedConfigFile = '';
    if (encodedConfig) {
        var safeTicket = ticketKey.replace(/[^A-Za-z0-9_-]/g, '_');
        encodedConfigFile = '.dmtools/local-run-encoded-config-' + safeTicket + '.json';
        try {
            file_write({ path: encodedConfigFile, content: encodedConfig });
        } catch (e) {
            console.warn('  ⚠️  Could not write encoded config file: ' + (e.message || e));
            encodedConfigFile = '';
        }
    }

    // config.git.baseBranch (project override) takes precedence over rule.baseBranch;
    // run-teammate-local.sh itself defaults to "main" when --base-branch is omitted,
    // which silently breaks on any project whose default branch is named differently
    // (e.g. "master") — always pass it explicitly when we know it.
    var baseBranch = (effectiveConfig && effectiveConfig.git && effectiveConfig.git.baseBranch)
        || rule.baseBranch || '';

    var cmd = 'bash ' + scriptPath +
        ' --config-file ' + resolvedCf +
        ' --ticket ' + ticketKey +
        (encodedConfigFile ? ' --encoded-config-file ' + encodedConfigFile : '') +
        (projectKey ? ' --project-key ' + projectKey : '') +
        (baseBranch ? ' --base-branch ' + baseBranch : '');

    console.log('  🖥️  [local] ' + cmd);

    var ok = true;
    try {
        cli_execute_command({ command: cmd });
        console.log('  ✅ Local run complete for ' + ticketKey);
    } catch (e) {
        ok = false;
        console.error('  ❌ Local teammate run failed for ' + ticketKey + ': ' + (e.message || e));
    }

    if (encodedConfigFile) {
        // Bare "rm" isn't in the CLI executor's whitelist (gh, gcloud, npm, docker,
        // ansible, git, dmtools, kubectl, az, terraform, bash, yarn, aws) and throws a
        // SecurityException — wrap in "bash -c" (which is whitelisted) so this best-effort
        // temp-file cleanup doesn't log a noisy, misleading security-violation error.
        try { cli_execute_command({ command: 'bash -c "rm -f ' + encodedConfigFile + '"' }); } catch (e2) {}
    }

    return ok;
}

function moveStatus(ticketKey, targetStatus) {
    try {
        if (DRY) { console.log('  [dry] 🔀 ' + ticketKey + ' → ' + targetStatus); }
        else { jira_move_to_status({ key: ticketKey, statusName: targetStatus }); }
        console.log('  ✅ ' + ticketKey + ' → ' + targetStatus);
    } catch (e) {
        console.warn('  ⚠️  Status transition failed for ' + ticketKey + ': ' + (e.message || e));
    }
}

function hasLabel(ticket, label) {
    if (!label) return false;
    // State items from the sources are flattened ({labels: [...]}); raw Jira
    // ticket objects keep them under fields.labels.
    var labels = ticket.labels ||
        ((ticket.fields && ticket.fields.labels) ? ticket.fields.labels : []);
    return labels.indexOf(label) !== -1;
}

function normalizeLabels(singleLabel, labelList) {
    var labels = [];
    if (singleLabel) labels.push(singleLabel);
    if (Array.isArray(labelList)) {
        labelList.forEach(function(label) {
            if (label && labels.indexOf(label) === -1) labels.push(label);
        });
    }
    return labels;
}

function firstMatchingLabel(ticket, labels) {
    for (var i = 0; i < labels.length; i++) {
        if (hasLabel(ticket, labels[i])) return labels[i];
    }
    return null;
}

function addRuleLabels(ticketKey, rule, repoInfo) {
    normalizeLabels(rule.addLabel, rule.addLabels).forEach(function(label) {
        try {
            if (rule.source === 'github') {
                var n = /(\d+)$/.exec(String(ticketKey));
                // gh-683 bug D (live fa #1194, 2026-10-04): without
                // workspace/repository the github bridge answers "Issue
                // reference requires owner/repo/number" and the label
                // never lands — include them whenever the rule context
                // knows the repo.
                if (n) {
                    var params = { number: parseInt(n[1], 10), labels: [label] };
                    if (repoInfo && repoInfo.owner && repoInfo.repo) {
                        params.workspace = repoInfo.owner;
                        params.repository = repoInfo.repo;
                    }
                    github_add_labels(params);
                }
            } else {
                if (DRY) { console.log('  [dry] 🏷️ ' + ticketKey + ' +' + label); }
                else { jira_add_label({ key: ticketKey, label: label }); }
            }
        } catch (e) {}
    });
}

// True when the rule's own target config (e.g. pr_review.json, pr_rework.json,
// bug_development.json) already removes this exact addLabel itself via
// customParams.removeLabel/removeLabels — i.e. the job manages the label's full
// lifecycle (add is implied by dispatch, remove happens on its own completion) and
// smAgent must not re-add it afterward. See processRule()'s localTeammate handling.
function ruleTargetSelfManagesLabel(rule) {
    var addLabels = normalizeLabels(rule.addLabel, rule.addLabels);
    if (!addLabels.length || !rule.configFile) return false;
    try {
        var raw = file_read({ path: rule.configFile });
        var targetConfig = JSON.parse(raw);
        var customParams = (targetConfig.params && targetConfig.params.customParams) || {};
        var removeLabels = normalizeLabels(customParams.removeLabel, customParams.removeLabels);
        return addLabels.some(function(label) { return removeLabels.indexOf(label) !== -1; });
    } catch (e) {
        return false;
    }
}

function removeRuleLabel(ticketKey, label, rule, repoInfo) {
    if (!ticketKey || !label) return;
    try {
        if (rule && rule.source === 'github') {
            var n = /(\d+)$/.exec(String(ticketKey));
            // gh-683 bug D (live fa #1194, 2026-10-04): the call carried NO
            // workspace/repository (and `labels:[…]` where the bridge reads
            // singular `label`) — the tool errored "Issue reference requires
            // owner/repo/number", the trigger label was never consumed, and
            // every later tick re-dispatched the same no-op leg. Pass the
            // rule context's repo and the singular param the bridge reads.
            if (n) {
                if (DRY) { console.log('  [dry] 🏷️ ' + ticketKey + ' -' + label); return; }
                var params = { number: parseInt(n[1], 10), label: label };
                if (repoInfo && repoInfo.owner && repoInfo.repo) {
                    params.workspace = repoInfo.owner;
                    params.repository = repoInfo.repo;
                }
                github_remove_label(params);
            }
        } else {
            if (DRY) { console.log('  [dry] 🏷️ ' + ticketKey + ' -' + label); }
            else { jira_remove_label({ key: ticketKey, label: label }); }
        }
        console.log('  🏷️  Removed stale trigger label "' + label + '" from ' + ticketKey);
    } catch (e) {
        console.warn('  ⚠️  Could not remove stale trigger label "' + label + '" from ' + ticketKey + ': ' + (e.message || e));
    }
}

function normalizePositiveInt(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    var normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
}

// ─── Local execution ──────────────────────────────────────────────────────────

function runLocalAction(jsPath, ticket, agentParams) {
    // CWD portability: agents/ prefix present when running from the parent
    // repo, absent when running from the agents checkout root — try both.
    var actionCode = file_read({ path: jsPath });
    if ((!actionCode || !actionCode.trim()) && jsPath.indexOf('agents/') === 0) {
        actionCode = file_read({ path: jsPath.substring('agents/'.length) });
    }
    if ((!actionCode || !actionCode.trim()) && jsPath.indexOf('agents/') !== 0) {
        actionCode = file_read({ path: 'agents/' + jsPath });
    }
    if (!actionCode || !actionCode.trim()) throw new Error('Cannot read: ' + jsPath);

    var configCode = file_read({ path: 'agents/js/config.js' });
    if (!configCode || !configCode.trim()) configCode = file_read({ path: 'js/config.js' });
    if (!configCode || !configCode.trim()) throw new Error('Cannot read: config.js');

    var scmCode = file_read({ path: 'agents/js/common/scm.js' });
    if (!scmCode || !scmCode.trim()) scmCode = file_read({ path: 'js/common/scm.js' });
    if (!scmCode || !scmCode.trim()) throw new Error('Cannot read: common/scm.js');

    var configLoaderCode = file_read({ path: 'agents/js/configLoader.js' });
    if (!configLoaderCode || !configLoaderCode.trim()) configLoaderCode = file_read({ path: 'js/configLoader.js' });

    var script =
        '(function() {\n' +
        '  var _cm = { exports: {} };\n' +
        '  (function(module, exports) {\n' + configCode + '\n  })(_cm, _cm.exports);\n' +
        '  var _scm = { exports: {} };\n' +
        '  (function(module, exports, require) {\n' + scmCode + '\n  })(_scm, _scm.exports, function(id) { return _cm.exports; });\n' +
        '  var _cl = { exports: {} };\n' +
        (configLoaderCode ?
        '  (function(module, exports, require) {\n' + configLoaderCode + '\n  })(_cl, _cl.exports, function(id) { return id.indexOf("scm.js") !== -1 ? _scm.exports : _cm.exports; });\n' :
        '') +
        '  var _am = { exports: {} };\n' +
        '  (function(module, exports, require) {\n' + actionCode + '\n  })(\n' +
        '    _am, _am.exports,\n' +
        '    function(id) {\n' +
        '      if (id === "./configLoader.js" || id === "./configLoader") return _cl.exports;\n' +
        '      if (id.indexOf("scm.js") !== -1) return _scm.exports;\n' +
        '      return _cm.exports;\n' +
        '    }\n' +
        '  );\n' +
        '  return _am.exports;\n' +
        '})()';

    var exported = eval(script);
    if (!exported || typeof exported.action !== 'function') {
        throw new Error('No action() exported from: ' + jsPath);
    }
    return exported.action({ ticket: ticket, jobParams: agentParams });
}

function processRuleLocally(rule, globalRepoInfo, ruleIndex) {
    if (DRY) {
        console.log('\n══ [LOCAL·DRY] ' + (rule.description || ('Rule #' + (ruleIndex + 1))) + ' ══');
        console.log('  [dry] local execution skipped');
        return { processedKeys: [], skippedKeys: [] };
    }
    var effectiveConfig = loadRuleConfig(rule);
    var interpolatedJql = configLoader.interpolateJql(rule.jql, effectiveConfig);
    var effectiveRepoInfo = globalRepoInfo || {};

    var label = rule.description || ('Rule #' + (ruleIndex + 1));
    console.log('\n══ [LOCAL] ' + label + ' ══');
    if (rule.source && rule.source !== 'jira') {
        console.log('   Query[' + rule.source + ']: ' + JSON.stringify(rule.query || {}) +
            (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
    } else {
        console.log('   JQL: ' + interpolatedJql + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
    }

    if (rule.enabled === false) {
        console.log('  ⏸️  Rule disabled — skipping');
        return { processedKeys: [], skippedKeys: [] };
    }

    var needsJqlLocal = !rule.source || rule.source === 'jira';
    if ((needsJqlLocal ? !rule.jql : !rule.query) || !rule.configFile) {
        console.warn('  ⚠️  Skipping rule — ' + (needsJqlLocal ? 'jql' : 'query') +
            ' and configFile are required');
        return { processedKeys: [], skippedKeys: [] };
    }

    var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
    var agentConfig = null;
    var cfCandidates = [resolvedCf];
    // CWD portability: the config may sit in an agents/ checkout root while
    // we run from the parent repo (or vice versa) — try both layouts.
    if (resolvedCf.indexOf('agents/') === 0) cfCandidates.push(resolvedCf.substring('agents/'.length));
    else cfCandidates.push('agents/' + resolvedCf.replace(/^agents\//, ''));
    for (var ci = 0; ci < cfCandidates.length && !agentConfig; ci++) {
        try {
            var raw = file_read({ path: cfCandidates[ci] });
            if (raw && raw.trim()) agentConfig = JSON.parse(raw);
        } catch (e) { /* try next layout */ }
    }
    if (!agentConfig) {
        console.error('  ❌ Cannot read/parse configFile: ' + resolvedCf);
        return { processedKeys: [], skippedKeys: [] };
    }

    var agentParams = agentConfig.params || {};
    var postJSActionPath = agentParams.postJSAction;
    // The rule's target repo rides the job params (config.repository wins over
    // any value in the agent JSON) — local actions must never fall back to the
    // git remote of this checkout (dmtools-agents when SM runs from it).
    agentParams = Object.assign({}, agentParams, {
        repository: (effectiveConfig.repository && effectiveConfig.repository.owner)
            ? effectiveConfig.repository
            : { owner: effectiveRepoInfo.owner, repo: effectiveRepoInfo.repo }
    });

    if (!postJSActionPath) {
        console.warn('  ⚠️  No postJSAction in ' + resolvedCf + ' — cannot run locally');
        return { processedKeys: [], skippedKeys: [] };
    }

    var tickets = [];
    try {
        var sourceMod = smSource.resolve(rule);
        tickets = sourceMod.query(rule, {
            config: effectiveConfig, repoInfo: effectiveRepoInfo, jql: interpolatedJql,
            machineAuthor: machineAuthorModule.resolveMachineAuthor(
                RUN_JOB_PARAMS, effectiveConfig)
        }) || [];
    } catch (e) {
        console.error('  ❌ state query failed: ' + (e.message || e));
        throw e;
    }

    if (typeof rule.limit === 'number' && tickets.length > rule.limit) {
        console.log('  Limiting from ' + tickets.length + ' to ' + rule.limit + ' ticket(s)');
        tickets = tickets.slice(0, rule.limit);
    }

    if (tickets.length === 0) {
        console.log('  No tickets found.');
        return { processedKeys: [], skippedKeys: [] };
    }

    console.log('  Found ' + tickets.length + ' ticket(s) — running locally via ' + postJSActionPath);

    var processedKeys = [];
    var skippedKeys = [];

    tickets.forEach(function(ticket) {
        var key = ticket.key;

        var skipLabel = firstMatchingLabel(ticket, normalizeLabels(rule.skipIfLabel, rule.skipIfLabels));
        if (skipLabel) {
            // Local execution is synchronous — there is never an in-flight
            // workflow run between ticks, so a surviving lock label means the
            // previous local action crashed: recover and retry.
            if (shouldRecoverStaleTriggerLabel(rule, skipLabel)) {
                console.log('  ♻️  ' + key + ' has stale lock ' + skipLabel + ' (local run finished) — recovering');
                removeRuleLabel(key, skipLabel, rule, effectiveRepoInfo);
            } else {
                console.log('  ⏭️  ' + key + ' skipped (label: ' + skipLabel + ')');
                skippedKeys.push(key);
                return;
            }
        }

        if (rule.targetStatus) {
            moveStatus(key, rule.targetStatus);
        }

        var fullTicket;
        try {
            var ticketRaw = jira_get_ticket(key);
            fullTicket = (typeof ticketRaw === 'string') ? JSON.parse(ticketRaw) : ticketRaw;
            if (!fullTicket || !fullTicket.key) throw new Error('Empty ticket returned');
        } catch (e) {
            console.warn('  ⚠️  jira_get_ticket(' + key + ') failed (' + e + '), falling back to search-result data');
            fullTicket = ticket;
            if (!fullTicket || !fullTicket.key) {
                console.error('  ❌ Search-result fallback also has no key for ' + key);
                return;
            }
        }

        try {
            console.log('  ▶️  ' + key + ' → ' + postJSActionPath);
            var result = runLocalAction(postJSActionPath, fullTicket, agentParams);
            console.log('  ✅ ' + key + ' done — action: ' + (result && result.action || JSON.stringify(result).substring(0, 80)));
            processedKeys.push(key);

            addRuleLabels(key, rule, effectiveRepoInfo);
        } catch (e) {
            console.error('  ❌ Local execution failed for ' + key + ': ' + (e.message || e));
        }
    });

    return { processedKeys: processedKeys, skippedKeys: skippedKeys };
}

// ─── Rule processor ───────────────────────────────────────────────────────────

// Run context (set once per action() invocation): PR-lifecycle
// localActions read the silent/source tokens from here (#687).
var RUN_JOB_PARAMS = {};

function processRule(rule, globalRepoInfo, ruleIndex, workflowBudget) {
    if (rule.localExecution) {
        return processRuleLocally(rule, globalRepoInfo, ruleIndex);
    }

    // localTeammate runs synchronously in-process — the workflow cap only bounds
    // concurrent/outstanding GitHub Actions dispatches, so it applies neither
    // here nor to localActions (inline curl/API calls, no dispatch).
    if (!rule.localTeammate && !rule.localAction && workflowBudget && workflowBudget.remaining <= 0) {
        var skippedLabel = rule.description || ('Rule #' + (ruleIndex + 1));
        var workflowFile = rule.workflowFile || 'ai-teammate.yml';
        console.log('\n══ ' + skippedLabel + ' ══');
        console.log('  ⏭️  Global workflow cap reached (' + workflowBudget.initial + ') — skipping rule');
        logBlockingWorkflowRuns(workflowBudget, workflowFile);
        return { processedKeys: [], skippedKeys: [] };
    }

    // Load per-rule config if rule.configPath is set; otherwise use global projectConfig.
    // This enables multi-project orchestration: each rule can target a different project.
    var effectiveConfig = loadRuleConfig(rule);

    // Effective repo: rule config > global config > globalRepoInfo fallback
    var effectiveOwner = (effectiveConfig.repository && effectiveConfig.repository.owner) || globalRepoInfo.owner;
    var effectiveRepo  = (effectiveConfig.repository && effectiveConfig.repository.repo)  || globalRepoInfo.repo;
    var effectiveRepoInfo = { owner: effectiveOwner, repo: effectiveRepo };

    // Bridge-free checks: refresh tick-stamped validation verdicts BEFORE
    // this rule's source reads the rollup, so green/red rules see the
    // dispatched run's conclusion in the same tick (owner 2026-09-23).
    if (rule.source === 'github' && (rule.query || {}).type === 'pr') {
        try {
            // stampValidationChecksFor hoists within processRule's scope.
            syncValidationChecks(effectiveRepoInfo, function (sha, st, co, url) {
                stampValidationChecksForModule(effectiveRepoInfo, sha, st, co, url);
            });
        } catch (e) {
            console.warn('  ⚠️  validation-check sync failed: ' + (e.message || e));
        }
    }

    // JQL interpolation per rule using effectiveConfig (so {jiraProject} resolves correctly per project)
    var interpolatedJql = configLoader.interpolateJql(rule.jql, effectiveConfig);

    var label = rule.description || ('Rule #' + (ruleIndex + 1));
    console.log('\n══ ' + label + ' ══');
    if (rule.source && rule.source !== 'jira') {
        var qdesc = JSON.stringify(rule.query || {});
        console.log('   Query[' + rule.source + ']: ' + qdesc + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
    } else {
        console.log('   JQL: ' + interpolatedJql + (rule.limit ? ' (limit: ' + rule.limit + ')' : ''));
    }

    if (rule.enabled === false) {
        console.log('  ⏸️  Rule disabled — skipping');
        return { processedKeys: [], skippedKeys: [] };
    }

    // Source-aware requirement check: classic rules need jql; github rules
    // need a query object. configFile is required by both.
    var needsJql = !rule.source || rule.source === 'jira';
    // GitHub rules with explicit rule.inputs pin the runner via workflow
    // inputs (issue/leg) — configFile is only mandatory for the classic
    // config_file dispatch shape. localAction rules (close-on-merge) need
    // neither: they act directly, no dispatch happens.
    if ((needsJql ? !rule.jql : !rule.query) || (!rule.configFile && !rule.inputs && !rule.localAction)) {
        console.warn('  ⚠️  Skipping rule — ' + (needsJql ? 'jql' : 'query') +
            ' and configFile (or inputs) are required');
        return { processedKeys: [], skippedKeys: [] };
    }

    var tickets = [];
    try {
        var sourceMod = smSource.resolve(rule);
        tickets = sourceMod.query(rule, {
            config: effectiveConfig, repoInfo: effectiveRepoInfo, jql: interpolatedJql,
            machineAuthor: machineAuthorModule.resolveMachineAuthor(
                RUN_JOB_PARAMS, effectiveConfig)
        }) || [];
    } catch (e) {
        console.error('  ❌ state query failed: ' + (e.message || e));
        throw e;
    }

    // Computed once per rule (not per ticket) — see ruleTargetSelfManagesLabel() and its
    // use in the localTeammate branch below.
    var ruleSelfManagesLabel = rule.localTeammate && ruleTargetSelfManagesLabel(rule);
    if (ruleSelfManagesLabel) {
        console.log('  ℹ️  Target job self-manages "' + (rule.addLabel || rule.addLabels) +
            '" — smAgent will not re-add it after a local run');
    }

    var ruleLimit = (typeof rule.limit === 'number' && rule.limit > 0) ? Math.floor(rule.limit) : null;
    var effectiveLimit = ruleLimit;
    // The workflow budget caps concurrent AI-RUN dispatches. localActions
    // (update_branch, validate_pr, merge_pr, complete_validation, close_issue,
    // fail_validation, unarm_validation, conflict_rework)
    // run inline curl/API calls — they neither start workflows nor compete
    // for dispatch slots, so the budget must not throttle them (live bug:
    // one active review run zeroed the budget and silent-update-behind
    // freshened exactly ONE of four behind PRs per tick).
    var budgetCapped = !rule.localTeammate && !rule.localAction;
    if (workflowBudget && budgetCapped) {
        effectiveLimit = effectiveLimit === null
            ? workflowBudget.remaining
            : Math.min(effectiveLimit, workflowBudget.remaining);
    }

    if (effectiveLimit !== null && tickets.length > effectiveLimit) {
        console.log('  Will trigger up to ' + effectiveLimit + ' ticket(s) after skipping active/stale labels');
    }

    if (tickets.length === 0) {
        console.log('  No tickets found.');
        return { processedKeys: [], skippedKeys: [] };
    }

    console.log('  Found ' + tickets.length + ' ticket(s)');

    var processedKeys = [];
    var skippedKeys   = [];

    for (var idx = 0; idx < tickets.length; idx++) {
        if (!rule.localTeammate && !rule.localAction && workflowBudget && workflowBudget.remaining <= 0) {
            break;
        }
        if (effectiveLimit !== null && processedKeys.length >= effectiveLimit) {
            break;
        }
        var ticket = tickets[idx];
        var key = ticket.key;

        var skipLabel = firstMatchingLabel(ticket, normalizeLabels(rule.skipIfLabel, rule.skipIfLabels));
        if (skipLabel) {
            // Stale-label recovery is based on inspecting active GitHub Actions runs — not
            // meaningful for localTeammate (there is no async run to inspect); just skip.
            if (!rule.localTeammate && shouldRecoverStaleTriggerLabel(rule, skipLabel)) {
                var workflowFile = rule.workflowFile || 'ai-teammate.yml';
                var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
                var scm = createTargetScm(effectiveConfig, effectiveRepoInfo);
                var activeKey = rule.concurrencyKey || key;
                if (hasActiveTargetWorkflowRun(scm, workflowFile, resolvedCf, activeKey)) {
                    skippedKeys.push(key);
                    continue;
                }
                console.log('  ♻️  ' + key + ' has ' + skipLabel + ' but no active workflow — recovering stale trigger label');
                removeRuleLabel(key, skipLabel, rule, effectiveRepoInfo);
            } else {
                console.log('  ⏭️  ' + key + ' skipped (label: ' + skipLabel + ')');
                skippedKeys.push(key);
                continue;
            }
        }

        // localAction rules act directly on the source (no workflow dispatch,
        // no AI runner) — e.g. close-on-merge finishing the cycle. Idempotency
        // comes from the query itself: issues are searched with is:open, so a
        // closed issue never matches again.
        if (rule.localAction === 'close_issue') {
            try {
                github_close_issue({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.issueNumber
                });
                console.log('  ✅ ' + key + ' issue #' + ticket.issueNumber +
                    ' closed (linked PR #' + ticket.prNumber + ' merged)');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ close_issue failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'mark_developed') {
            // Machine-loop backfill: the dev leg opened a green PR but the
            // post-action labeling it grew up with is Jira-only, so GitHub
            // issues linger in `in progress` and the review rule (which
            // gates on ai_developed) never fires. The SM itself detects
            // the completed-development shape (issue in progress + OPEN
            // green PR) and labels the ISSUE — self-healing every stuck
            // ticket on the first tick after deploy, no manual backfill.
            try {
                github_add_labels({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.issueNumber,
                    labels: ['ai_developed']
                });
                console.log('  ✅ ' + key + ' issue #' + ticket.issueNumber +
                    ' labeled ai_developed (green PR #' + ticket.prNumber + ')');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ mark_developed failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'arm_review') {
            // Stale-verdict re-review (PR #690): the review's
            // CHANGES_REQUESTED was pinned to an older commit; fixes were
            // pushed and checks went green. Re-arm agent:review on the PR
            // — review-on-label dispatches the runner, the runner consumes
            // the label and re-reviews the current head. The fresh verdict
            // carries the head's commit_id, so the stale query never
            // matches it again (convergent, no loop).
            try {
                github_add_labels({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber,
                    labels: ['agent:review']
                });
                console.log('  ✅ ' + key + ' agent:review re-armed (stale CHANGES_REQUESTED on PR #' + ticket.prNumber + ')');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ arm_review failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        // Silent branch refresh = a git merge push, NOT the GitHub
        // update-branch APIs. Live-verified dead ends for
        // github-actions[bot]: the GraphQL mutation (gh pr update-branch)
        // is denied regardless of token scopes, and the REST endpoint is
        // PUT-only (PATCH 404s) yet still 403s the bot with "user doesn't
        // have permission to update head repository". A plain git push on
        // the runner's checkout IS allowed with the workflow token — and
        // workflow-token pushes trigger no workflows, which is the whole
        // point of the silent path. The merge aborts on conflicts (a DIRTY
        // PR is skipped with an error, the correct semantics).
        function silentUpdateBranch(branchName) {
            // The reconcile job's working directory is the dmtools-agents
            // engine checkout (live: `git fetch origin` there fetched
            // dmtools-agents and every PR pathspec 404'd) — clone the
            // TARGET repo instead. `gh repo clone` rides GH_TOKEN; with
            // the workflow token that push is silent (a PAT in its place
            // would fire CI — do not point silent-token at a PAT).
            var dir = '/tmp/sm-silent-update-' + Date.now() + '-' +
                      String(branchName).replace(/[^a-zA-Z0-9._-]/g, '_');
            cli_execute_command({
                command: 'gh repo clone ' + effectiveRepoInfo.owner + '/' +
                         effectiveRepoInfo.repo + ' ' + dir +
                         ' -- --no-tags --single-branch --branch ' + branchName +
                         ' --depth 200' +
                         ' && cd ' + dir +
                         ' && git fetch --no-tags --depth 200 origin main' +
                         // Skip when main is already contained: two ticks racing
                         // on the same branch produced a branch-into-itself
                         // merge commit (dart gh-191, 14:08) that moved the head
                         // past a green validation for no reason.
                         //
                         // ROOT FIX (fa 2026-10-01): the old form
                         //   clone && fetch && ! ancestor || exit 0 && merge...
                         // left-associates as
                         //   (clone && fetch && !ancestor) || (exit 0 && merge...)
                         // so a CLONE/NETWORK failure took the `|| exit 0`
                         // branch, exited 0, and the reconcile logged
                         // "branch silently updated" while the head NEVER
                         // moved — the PR stayed BEHIND forever (live: fa
                         // #1128 cohort parked since 2026-09-13; pr-1133's
                         // visible clone failure was the rare case that
                         // escaped the mask). The no-op skip must scope to
                         // the ancestor check ONLY: failures now propagate,
                         // the caller logs 'update_branch failed', and the
                         // next tick retries (self-healing by design).
                         ' && if git merge-base --is-ancestor FETCH_HEAD HEAD; then' +
                         ' echo "silent-update: already up to date"' +
                         ' && exit 0; fi' +
                         ' && git -c user.name=sm-silent-update' +
                         ' -c user.email=sm-silent-update@users.noreply.github.com' +
                         ' merge --no-edit FETCH_HEAD' +
                         // The anonymous clone of a public repo carries no
                         // push credentials ("could not read Username" —
                         // live). Push via a one-off token URL: sh expands
                         // ${GH_TOKEN} from the child env (the workflow
                         // token there), and the token never appears in
                         // this script or the logged command line.
                         ' && git push https://x-access-token:${GH_TOKEN}@github.com/' +
                         effectiveRepoInfo.owner + '/' + effectiveRepoInfo.repo +
                         '.git ' + branchName
            });
        }

        // Validation trigger (dispatch-only CI): no push ever fires CI on
        // its own — the SM is the only trigger. The PAT update-branch dance
        // (a source-token push DOES fire CI) is retired: a workflow_dispatch
        // run lands directly on the branch head, needs no actor checks, and
        // branch freshness stays with silent-update-behind (the validate
        // rules already exclude BEHIND PRs). The CI workflow file is a
        // per-repo knob: rule.ciWorkflow > jobParams.ciWorkflow (factory-sm
        // `ci-workflow` input) > 'quality.yml'.
        function dispatchCiWorkflow(branchName) {
            var ciWorkflow = rule.ciWorkflow ||
                ((RUN_JOB_PARAMS || {}).ciWorkflow) || 'quality.yml';
            if (DRY) {
                // Live bug (fa 2026-09-27): a DRY SM tick really dispatched
                // CI — `gh workflow run` fired outside every dry guard. The
                // unarmed real run then shadowed every later tick's
                // duplicate-dispatch guard and no rule could consume its
                // verdict (no ai_validating arm). DRY means NO side effects.
                console.log('  🧪 [dry] validation dispatch skipped (gh workflow run ' +
                            ciWorkflow + ' @ ' + branchName + ')');
                return;
            }
            cli_execute_command({
                command: 'gh workflow run ' + ciWorkflow +
                         ' --repo ' + effectiveRepoInfo.owner + '/' +
                         effectiveRepoInfo.repo + ' --ref ' + branchName
            });
        }

        // ── Bridge-free validation checks (owner 2026-09-23) ──────────────
        // "sm стартанул триггер... ушел спать" — the tick IS the mirror. No
        // ci-gate waiter jobs burning runner slots for 85 minutes: when the
        // caller configures jobParams.validationChecks (JSON array of the
        // branch-protection required check names), the SM stamps those
        // checks itself — in_progress right after the dispatch (below) and
        // the dispatched run's verdict on every subsequent pass (see
        // syncValidationChecks, hooked ahead of each PR rule's source
        // query). Repos without the knob keep the bridge architecture.


        // ── PR-lifecycle localActions (issue #687: the SM owns the loop) ──
        // They act on the PR directly (type:pr rules; ticket.prNumber set,
        // ticket.issueNumber null). Idempotency comes from the query guards:
        // each action flips exactly the fact its rule filtered on.

        if (rule.localAction === 'update_branch') {
            // Open PR behind main → silent refresh via a git merge push on
            // the runner checkout (workflow-token pushes trigger no
            // workflows → the CI matrix does not re-run).
            if (!ticket.branch) {
                console.error('  ❌ update_branch: no head branch on ' + key + ' — skipped');
                continue;
            }
            try {
                // Sticky validation_failed park (owner 2026-09-27, live:
                // fa#923 — a GUEST PR cycled arm→CI red→park→silent-update
                // →pending→re-arm every tick, defeating the #550 red-park
                // and holding the validate-armed limit-1 slot hostage while
                // 10 green-latched PRs starved; owner rule: 'у гостя если
                // красное то следующий должны пробовать мержить').
                //   SET (below): a guest whose CURRENT head has red checks
                //     gets the label — validate-armed's query excludes it
                //     and the validate_pr action refuses to dispatch any
                //     validation CI for it. Machine PRs never get the
                //     label (fa pushes their heads; they re-enter on a new
                //     head as today).
                //   RESET (first): the park clears only on a HUMAN push
                //     NEWER than the validation_failed event — the label is
                //     removed and the PR re-enters the queue. Machine
                //     movement NEVER clears it: the SM's own silent-update
                //     merges ('sm-silent-update' committer) and the agent
                //     legs' pushes (machineAuthor login, e.g. the rework
                //     WIP auto-saves on fa pr-1094) are not new work.
                var parkLabelVf = 'validation_failed';
                var labelsVf = ticket.labels || [];
                var uHead = (ticket.pr && ticket.pr.headSha) || ticket.headSha;
                var prMachineAuthorU = machineAuthorModule.resolveMachineAuthor(RUN_JOB_PARAMS, effectiveConfig);
                var isMachinePrU = machineAuthorModule.isMachineAuthored(
                    ticket, prMachineAuthorU, effectiveRepoInfo.owner);
                var unparkedThisPass = false;
                if (labelsVf.indexOf(parkLabelVf) !== -1) {
                    var lastCommitter = uHead ? headCommitIdentity(effectiveRepoInfo, uHead) : null;
                    var actorVf = uHead ? headCommitActor(effectiveRepoInfo, uHead) : null;
                    var parkedAtVf = parkedSince(effectiveRepoInfo, ticket.prNumber);
                    var actorLoginVf = ((actorVf && actorVf.login) || '').toLowerCase();
                    var machineLoginVf = String(prMachineAuthorU || '').toLowerCase();
                    var machinePushVf = lastCommitter === 'sm-silent-update' ||
                        (!!machineLoginVf && !!actorLoginVf && actorLoginVf === machineLoginVf);
                    var freshPushVf = !!(actorVf && actorVf.date && parkedAtVf &&
                        Date.parse(actorVf.date) > Date.parse(parkedAtVf));
                    // Head-change without its own red verdict (dmtools-
                    // agents#633, live fa#1139 2026-10-02): the park's
                    // verdict belongs to the sha in the park comment. A
                    // silent rebase moves the head to a sha that has NEVER
                    // been validated — the red the park punished is void
                    // (the rebase literally merged main in: exactly the
                    // medicine for a moved-base red, live fa#1114 —
                    // parked red, re-validated green, merged). Clear the
                    // park and let validate-armed give the NEW head its
                    // first verdict; if it is genuinely content-red the
                    // fail-validation path re-parks it one CI cycle later.
                    // Guards: park comment sha must be known AND differ,
                    // and the sha-keyed dispatched-verdict probe must NOT
                    // report 'failure' for the current head (fail closed:
                    // probe error keeps the park, same as parkedSince).
                    var parkedHeadVf = parkedHeadSha(effectiveRepoInfo, ticket.prNumber);
                    var headChangedNoVerdictVf = !!uHead && parkedHeadVf !== null &&
                        parkedHeadVf !== '' && uHead !== parkedHeadVf &&
                        latestDispatchedVerdict(effectiveRepoInfo,
                            rule.ciWorkflow || ((RUN_JOB_PARAMS || {}).ciWorkflow) || 'quality.yml',
                            uHead) !== 'failure';
                    if (lastCommitter === null || actorVf === null || parkedAtVf === null) {
                        console.warn('  ⚠️  ' + key + ' ' + parkLabelVf +
                            ': park probe failed (commit actor / park time) — keeping the park (fail closed)');
                    } else if (headChangedNoVerdictVf) {
                        if (!DRY) {
                            try {
                                github_remove_label({
                                    workspace: effectiveRepoInfo.owner,
                                    repository: effectiveRepoInfo.repo,
                                    number: ticket.prNumber,
                                    label: parkLabelVf
                                });
                            } catch (eUnparkHc) {
                                console.warn('  ⚠️  un-park label failed: ' + (eUnparkHc.message || eUnparkHc));
                            }
                            try {
                                github_create_comment({
                                    workspace: effectiveRepoInfo.owner,
                                    repository: effectiveRepoInfo.repo,
                                    number: ticket.prNumber,
                                    body: '🅿️→▶ validation_failed cleared — the park was set on head `' +
                                        parkedHeadVf + '`, but the head is now `' + uHead +
                                        '` (silent refresh merged main in) and this head has no red ' +
                                        'verdict of its own. The old verdict does not transfer across ' +
                                        'sha changes — re-entering validation for a first verdict.'
                                });
                            } catch (eUnparkHcC) {
                                console.warn('  ⚠️  un-park comment failed: ' + (eUnparkHcC.message || eUnparkHcC));
                            }
                        }
                        console.log('  ▶ ' + key + ' ' + parkLabelVf +
                            ' cleared: head changed to ' + uHead.slice(0, 8) +
                            ' since the park (' + parkedHeadVf.slice(0, 8) +
                            ') and carries no red verdict — re-validating');
                        unparkedThisPass = true;
                    } else if (machinePushVf) {
                        console.log('  🅿️  ' + key + ' ' + parkLabelVf +
                            ' holds — head moved by the machine (' +
                            (lastCommitter === 'sm-silent-update' ? 'sm-silent-update' : actorLoginVf) +
                            '); silent-updates and agent auto-saves are not new work');
                    } else if (!freshPushVf) {
                        console.log('  🅿️  ' + key + ' ' + parkLabelVf +
                            ' holds — the head predates the park event (no new push since)');
                    } else {
                        if (!DRY) {
                            try {
                                github_remove_label({
                                    workspace: effectiveRepoInfo.owner,
                                    repository: effectiveRepoInfo.repo,
                                    number: ticket.prNumber,
                                    label: parkLabelVf
                                });
                            } catch (eUnparkVf) {
                                console.warn('  ⚠️  un-park label failed: ' + (eUnparkVf.message || eUnparkVf));
                            }
                            try {
                                github_create_comment({
                                    workspace: effectiveRepoInfo.owner,
                                    repository: effectiveRepoInfo.repo,
                                    number: ticket.prNumber,
                                    body: '🅿️→▶ validation_failed cleared — the head `' + uHead +
                                        '` was pushed by `' + (actorLoginVf || lastCommitter) +
                                        '` (human, newer than the park event) — re-entering validation.'
                                });
                            } catch (eUnparkVfC) {
                                console.warn('  ⚠️  un-park comment failed: ' + (eUnparkVfC.message || eUnparkVfC));
                            }
                        }
                        console.log('  ▶ ' + key + ' ' + parkLabelVf +
                            ' cleared: HUMAN push newer than the park — re-entering validation');
                        unparkedThisPass = true;
                    }
                }
                if (!unparkedThisPass && !isMachinePrU &&
                    labelsVf.indexOf(parkLabelVf) === -1 &&
                    headChecksRed(effectiveRepoInfo, ticket.prNumber)) {
                    if (!DRY) {
                        try {
                            github_add_labels({
                                workspace: effectiveRepoInfo.owner,
                                repository: effectiveRepoInfo.repo,
                                number: ticket.prNumber,
                                labels: [parkLabelVf]
                            });
                        } catch (eParkVf) {
                            console.warn('  ⚠️  park label failed: ' + (eParkVf.message || eParkVf));
                        }
                        try {
                            github_create_comment({
                                workspace: effectiveRepoInfo.owner,
                                repository: effectiveRepoInfo.repo,
                                number: ticket.prNumber,
                                body: '🛑 validation_failed — the current head `' + uHead +
                                    '` has failing checks. This GUEST PR is parked: no validation ' +
                                    'CI is dispatched for it and the merge window skips it until a ' +
                                    'HUMAN push newer than the park clears it (machine pushes — ' +
                                    'silent-updates, agent auto-saves — never do). The failure itself ' +
                                    'is reported separately. parked-head: ' + uHead
                            });
                        } catch (eParkVfC) {
                            console.warn('  ⚠️  park comment failed: ' + (eParkVfC.message || eParkVfC));
                        }
                    }
                    console.log('  🅿️  ' + key + ' head checks red on a guest PR — ' +
                        parkLabelVf + ' set, merge window advances');
                }
                silentUpdateBranch(ticket.branch);
                console.log('  ✅ ' + key + ' branch silently updated (no CI)');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ update_branch failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'validate_pr') {
            // Dispatch the CI workflow on the head branch and arm the
            // ai_validating marker. Pre- and post-approval validation share
            // this action: pre-review (validate-fresh) latches ai_validated
            // on green; post-approval (validate-armed, sticky pr_approved)
            // merges on green. A dispatch failure leaves the marker un-armed
            // — the next tick retries (self-healing).
            // Sticky-park backstop (owner 2026-09-27, live: fa#923): a PR
            // carrying validation_failed gets NO CI trigger at all until a
            // non-machine push clears the label. validate-armed's query
            // already excludes it; this guard backstops validate-fresh and
            // any other rule sharing this action — the label is the single
            // source of truth. NOT processedKeys: the limit-1 slot moves on.
            if ((ticket.labels || []).indexOf('validation_failed') !== -1) {
                // Park RESET (dmtools-agents, live fa 2026-10-03): the
                // human-push unpark probe lives in update_branch — but that
                // rule only matches BEHIND PRs, so a guest PR whose head is
                // NOT behind (fix commit on the same base) NEVER runs it
                // and the park outlives any human push (live: vendor pushed
                // 16:01 to five parked PRs; two hours later not one label
                // cleared — update_branch never fired for any of them).
                // Same identity rules as update_branch's RESET, fail closed:
                // only a NON-machine push NEWER than the newest park event
                // clears the label and lets this dispatch proceed.
                var vprActor = headCommitActor(effectiveRepoInfo, ticket.headSha);
                var vprParkedAt = parkedSince(effectiveRepoInfo, ticket.prNumber);
                var vprMachineLogin = String(machineAuthorModule.resolveMachineAuthor(
                    RUN_JOB_PARAMS, effectiveConfig) || '').toLowerCase();
                var vprActorLogin = ((vprActor && vprActor.login) || '').toLowerCase();
                var vprMachinePush = vprActorLogin === 'sm-silent-update' ||
                    (!!vprMachineLogin && vprActorLogin === vprMachineLogin);
                var vprFreshPush = !!(vprActor && vprActor.date && vprParkedAt &&
                    Date.parse(vprActor.date) > Date.parse(vprParkedAt));
                if (vprActor !== null && vprParkedAt !== null && vprFreshPush && !vprMachinePush) {
                    if (!DRY) {
                        try {
                            github_remove_label({ workspace: effectiveRepoInfo.owner,
                                repository: effectiveRepoInfo.repo,
                                number: ticket.prNumber, label: 'validation_failed' });
                        } catch (eVfClr) {
                            console.warn('  ⚠️  un-park label failed: ' + (eVfClr.message || eVfClr));
                        }
                        try {
                            github_create_comment({ workspace: effectiveRepoInfo.owner,
                                repository: effectiveRepoInfo.repo, number: ticket.prNumber,
                                body: '🅿️→▶ validation_failed cleared — human push by `' +
                                    (vprActorLogin || 'unknown') + '` at ' + vprActor.date +
                                    ' is newer than the park (' + vprParkedAt +
                                    '). Re-entering validation (update_branch RESET never ' +
                                    'ran: the head is not BEHIND — live fa 2026-10-03).' });
                        } catch (eVfSay) {}
                    }
                    console.log('  ▶ ' + key + ' park cleared (fresh human push) — validation proceeds');
                } else {
                    console.log('  ⏭️  ' + key + ' validation_failed — parked; NO validation CI' +
                                ' until a HUMAN push newer than the park clears it');
                    continue;
                }
            }
            if (!ticket.branch) {
                console.error('  ❌ validate_pr: no head branch on ' + key + ' — skipped');
                continue;
            }
            try {
                // Duplicate-dispatch guard (owner 2026-09-23: manual-tick
                // spam + cron landed inside GitHub's check-run visibility
                // window — each tick saw "armed, checks none" on a head
                // whose dispatch had JUST fired and re-dispatched; 4 wasted
                // hosted CI runs on one PR). Ask for this head's dispatched
                // runs first: an active one means the arm is already in
                // flight — skip, the validation-sync loop owns the stamping.
                // ONE probe bundle feeds every guard below (was up to 4
                // sequential gh api rounds per candidate): a single
                // worker round when runAsync is wired, the four helpers
                // on the main engine otherwise.
                var vHead0 = (ticket.pr && ticket.pr.headSha) || ticket.headSha;
                var vCiWf = rule.ciWorkflow ||
                    ((RUN_JOB_PARAMS || {}).ciWorkflow) || 'quality.yml';
                var vProbe = vHead0 ? probeDispatchedState(effectiveRepoInfo, vCiWf, vHead0) : null;
                if (vProbe && vProbe.active) {
                    console.log('  ⏭️  ' + key +
                                ' validation already dispatching on this head — skip');
                    continue;
                }
                // Green-cover guard (rule flag skipIfGreenCi — the
                // revalidate-armed-green dead-zone rule): if the head
                // already carries a COMPLETED green dispatched CI run,
                // re-running it cannot change a still-BLOCKED mergeState
                // (the unmet required check is not this workflow's) — skip
                // instead of looping CI every tick. Rules without the flag
                // are unaffected.
                if (rule.skipIfGreenCi && vProbe && vProbe.green) {
                    console.log('  ⏭️  ' + key +
                                ' head already carries a green dispatched CI run' +
                                ' — blocker is not this CI; skip re-dispatch');
                    continue;
                }
                // Latch-skip (owner 2026-09-27 — rule flag skipIfValidatedHead,
                // set on validate-armed): the PR carries the ai_validated
                // latch AND the CURRENT head still carries the
                // completed-green dispatched validation run (head SHA ==
                // the SHA the last green validation ran on — any silent-
                // update refresh or push moves the SHA and this guard
                // passes through to a real re-validation) AND the whole
                // check rollup is green — re-running CI proves nothing.
                // Arm ai_validating WITHOUT a dispatch; merge-validated
                // consumes the arm on the existing green in the same tick.
                // Dispatch-mode deployments only: the probe requires a real
                // dispatched run (bridge-free stamped repos never match).
                if (rule.skipIfValidatedHead && vProbe &&
                    (ticket.labels || []).indexOf('ai_validated') !== -1 &&
                    vProbe.green &&
                    validationRollupGreen(effectiveRepoInfo, ticket.prNumber)) {
                    github_add_labels({
                        workspace: effectiveRepoInfo.owner,
                        repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber,
                        labels: ['ai_validating']
                    });
                    console.log('  ⏭️  ' + key + ' latch-skip: head unchanged since the green' +
                                ' validation — arm only, merge window proceeds on the existing green');
                    processedKeys.push(key);
                    continue;
                }
                // Red-current-head defer (owner 2026-09-27, live: fa wave
                // stall — the oldest APPROVED PR was a guest whose head
                // validation had FAILED; validate-armed kept re-dispatching
                // CI on the unchanged red head every guard window, hogging
                // the limit-1 FIFO slot while nine green-latched approved
                // PRs waited behind it for hours). If THIS head's latest
                // concluded dispatched verdict is FAILURE, the red verdict
                // is still current — re-running CI on the same SHA cannot
                // pass. Park the candidate: no dispatch, no arm, and the
                // limit-1 window advances to the next approved PR.
                // Machine-authored PRs re-enter as today: the rework leg
                // pushes a new head and this head-SHA-keyed probe no longer
                // matches. Guest PRs get one park comment per head (the
                // machine cannot push for them — a human must act; the
                // fail path has already reported the red separately).
                if (rule.deferRedHead && vProbe &&
                    vProbe.verdict === 'failure') {
                    var prMachineAuthor = machineAuthorModule.resolveMachineAuthor(RUN_JOB_PARAMS, effectiveConfig);
                    var isMachinePrForPark = machineAuthorModule.isMachineAuthored(
                        ticket, prMachineAuthor, effectiveRepoInfo.owner);
                    if (!isMachinePrForPark) {
                        var parkMarker = '🅿️ Validation red — PR parked';
                        var alreadyParked = false;
                        try {
                            var parkCommentsRaw = github_get_pr_comments({
                                workspace: effectiveRepoInfo.owner,
                                repository: effectiveRepoInfo.repo,
                                pullRequestId: ticket.prNumber
                            });
                            var parkCommentsObj = typeof parkCommentsRaw === 'string'
                                ? JSON.parse(parkCommentsRaw) : (parkCommentsRaw || []);
                            var parkCommentList = Array.isArray(parkCommentsObj)
                                ? parkCommentsObj
                                : (parkCommentsObj.comments || parkCommentsObj.items || []);
                            alreadyParked = parkCommentList.some(function (c) {
                                var b = String((c && c.body) || '');
                                return b.indexOf(parkMarker) !== -1 &&
                                    b.indexOf(String(vHead0)) !== -1;
                            });
                        } catch (eParkRead) { /* read failed — comment again is safe */ }
                        if (!alreadyParked && !DRY) {
                            try {
                                github_create_comment({
                                    workspace: effectiveRepoInfo.owner,
                                    repository: effectiveRepoInfo.repo,
                                    number: ticket.prNumber,
                                    body: parkMarker + ' — the current head `' + vHead0 +
                                        '` failed validation and the head has not moved. ' +
                                        'Re-running CI on the same SHA cannot pass, so the merge ' +
                                        'window skips this PR until the head moves (push a fix or ' +
                                        'rebase). The failure itself is reported separately above.'
                                });
                            } catch (eParkComment) {
                                console.warn('  ⚠️  park comment failed: ' + (eParkComment.message || eParkComment));
                            }
                        }
                    }
                    console.log('  🅿️  ' + key + ' red verdict still current on this head — parked, merge window advances');
                    continue; // NOT processedKeys — the limit-1 slot must move on
                }
                // Superseded-head cleanup (owner 2026-09-23): any active
                // dispatched run on an older head of THIS branch is pure
                // waste — cancel before arming the fresh one.
                if (vHead0) {
                    cancelStaleDispatchedRuns(effectiveRepoInfo, vCiWf,
                                              ticket.branch, vHead0);
                }
                dispatchCiWorkflow(ticket.branch);
                var vHead = vHead0;
                if (vHead) {
                    stampValidationChecksForModule(effectiveRepoInfo, vHead, 'in_progress', null, null);
                }
                github_add_labels({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber,
                    labels: ['ai_validating']
                });
                console.log('  🧪 ' + key + ' validation dispatched (CI runs on the head via workflow_dispatch)');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ validate_pr failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'unarm_validation') {
            // Validated-but-stale: ai_validating armed, validation green, but
            // base moved before the merge tick (mergeState BEHIND/BLOCKED).
            // silent-update-behind excludes ai_validating and merge-validated
            // needs CLEAN — without this unarm the PR deadlocks (live: fa
            // pr-744). Drop the marker; next ticks: silent refresh → merge
            // window re-validates the fresh head (422-arm covers the
            // already-fresh case) → merge.
            try {
                github_remove_label({
                    workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber, label: 'ai_validating'
                });
                console.log('  🔓 ' + key + ' unarmed (validated head went stale) — refresh + re-validate follows');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ unarm_validation failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'conflict_rework') {
            // Owner rule 2026-09-21: a machine PR whose branch CONFLICTS with
            // main (silent-update's git merge cannot land; mergeState DIRTY)
            // must not sit in the queue forever — send it to rework: the
            // agent resolves the conflicts and pushes, then the normal
            // validate → (pr_approved sticky) merge flow resumes. Guests get
            // the report only (same owner rule as fail_validation: rework is
            // machine-author-only). Once per head: a conflict-marker comment
            // carrying the current head sha means this head was already
            // reported+armed.
            //
            // gh-683 bug C (live fa #677/PR #676, 2026-10-03 21:09Z): the
            // marker comment used to be posted BEFORE arming, so a starved
            // PR-anchored dispatch (triggerWorkflow false under the global
            // workflow cap / active-run guard) or a failed label add left a
            // "reported" corpse — every later tick suppressed on the comment
            // and the linked issue NEVER got agent:rework (owner armed it by
            // hand 2026-10-04 ~05:10Z; the leg fired 05:12Z instantly).
            // Invariants now: (1) arm FIRST, marker comment LAST — the
            // marker only ever lands once the rework is actually armed;
            // (2) suppression self-heals — a marker whose re-arm never
            // landed (label absent on the linked issue) re-arms instead of
            // suppressing: suppression keys on the LABEL, the comment is
            // only the once-per-head pacing for the REPORT.
            try {
                var headSha = (ticket.pr && ticket.pr.headSha) || null;
                if (!headSha) {
                    try {
                        var cpr = github_get_pr({
                            workspace: effectiveRepoInfo.owner,
                            repository: effectiveRepoInfo.repo,
                            pullRequestId: ticket.prNumber
                        });
                        var cprObj = typeof cpr === 'string' ? JSON.parse(cpr) : (cpr || {});
                        headSha = (cprObj.head && (cprObj.head.sha || cprObj.head)) || null;
                    } catch (e5) { /* stays null — dedup degrades to marker-only */ }
                }
                var marker = '⚠️ Merge conflict with main';
                var alreadyReported = false;
                try {
                    var commentsRaw = github_get_pr_comments({
                        workspace: effectiveRepoInfo.owner,
                        repository: effectiveRepoInfo.repo,
                        pullRequestId: ticket.prNumber
                    });
                    var commentsObj = typeof commentsRaw === 'string' ? JSON.parse(commentsRaw) : (commentsRaw || []);
                    var commentList = Array.isArray(commentsObj)
                        ? commentsObj
                        : (commentsObj.comments || commentsObj.items || []);
                    alreadyReported = commentList.some(function (c) {
                        var b = String((c && c.body) || '');
                        return b.indexOf(marker) !== -1 &&
                            (!headSha || b.indexOf(String(headSha)) !== -1);
                    });
                } catch (e6) { /* read failed — treat as not reported */ }

                // Resolve machine-author + linked issue BEFORE the marker
                // check — the self-heal below needs to know whether the
                // re-arm actually landed (gh-683 bug C).
                var cMachineAuthor = machineAuthorModule.resolveMachineAuthor(RUN_JOB_PARAMS, effectiveConfig);
                var cIsMachinePr = machineAuthorModule.isMachineAuthored(
                    ticket, cMachineAuthor, effectiveRepoInfo.owner);
                var cLinked = null;
                if (cIsMachinePr) {
                    try {
                        var bodyRaw = github_get_pr({
                            workspace: effectiveRepoInfo.owner,
                            repository: effectiveRepoInfo.repo,
                            pullRequestId: ticket.prNumber
                        });
                        var bodyObj = typeof bodyRaw === 'string' ? JSON.parse(bodyRaw) : (bodyRaw || {});
                        var cm = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(String(bodyObj.body || ''));
                        if (cm) cLinked = parseInt(cm[1], 10);
                    } catch (e8) { console.warn('  ⚠️ linked-issue lookup failed: ' + (e8.message || e8)); }
                    if (!cLinked && ticket.branch) {
                        // Linkage grammar of the merge trigger: 'gh-<n>' AND
                        // '<n>-slug' branches (#579: 'fix/1074-web-shift-safety'
                        // resolved to nothing under the gh-<n>-only scan).
                        var cbm = /(?:^|\/)(?:gh-(\d+)|(\d+)-[a-z0-9._-]+)$/i.exec(String(ticket.branch));
                        if (cbm) cLinked = parseInt(cbm[1] || cbm[2], 10);
                    }
                }
                // The re-arm anchors on an OPEN local issue: the issue-rework
                // rule matches open issues only, so labelling a CLOSED (fixed
                // elsewhere) or dangling issue is a dead letter — the
                // conflicted PR waits on rework forever (live: fa #1075 DIRTY
                // with linked #1074 CLOSED since 2026-09-30 08:24Z, no leg
                // ever fired). Not OPEN → PR-anchored rework dispatch below
                // (the #544 fallback shape).
                var cLinkedOpen = false;
                var cIssueHasRework = false;
                if (cIsMachinePr && cLinked) {
                    try {
                        if (typeof github_get_issue === 'function') {
                            var liRaw = github_get_issue({
                                workspace: effectiveRepoInfo.owner,
                                repository: effectiveRepoInfo.repo,
                                issueNumber: cLinked
                            });
                            var liObj = typeof liRaw === 'string' ? JSON.parse(liRaw) : (liRaw || null);
                            var liOk = liObj && typeof liObj === 'object' &&
                                typeof liObj.number === 'number' && !liObj.message;
                            cLinkedOpen = !!liOk &&
                                String(liObj.state || 'open').toLowerCase() === 'open';
                            cIssueHasRework = cLinkedOpen && Array.isArray(liObj.labels) &&
                                liObj.labels.some(function (l) { return l && l.name === 'agent:rework'; });
                        } else {
                            cLinkedOpen = true; // legacy bridges: trust the scrape
                        }
                    } catch (e9) { cLinkedOpen = false; }
                }

                if (alreadyReported) {
                    // gh-683 bug C self-heal: the marker is once-per-head
                    // pacing for the REPORT, not proof the re-arm landed. A
                    // machine PR whose linked OPEN issue does NOT carry
                    // agent:rework re-arms right here — the label is the
                    // functional bit (idempotent add if the read was stale).
                    if (!DRY && cIsMachinePr && cLinked && cLinkedOpen && !cIssueHasRework) {
                        github_add_labels({
                            workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                            number: cLinked, labels: ['agent:rework']
                        });
                        console.log('  🔁 ' + key + ' conflict marker present but issue #' + cLinked +
                            ' has no agent:rework — re-armed (gh-683 self-heal)');
                    }
                    console.log('  ⏭️  ' + key + ' conflict already reported for head — waiting on rework');
                    processedKeys.push(key);
                    continue;
                }
                try {
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validating'
                    });
                } catch (e7) { /* absent label is fine */ }
                var cReworkNote = (cLinked && cLinkedOpen)
                    ? ' Rework re-queued (linked issue #' + cLinked + ' re-armed): resolve the conflicts and push — validation re-runs automatically.'
                    : (cLinked
                        ? ' Rework dispatched as a PR-anchored conflict rework leg (linked issue #' + cLinked + ' is not OPEN): resolve the conflicts and push — validation re-runs automatically.'
                        : ' Rework dispatched as a PR-anchored conflict rework leg (no linked issue): resolve the conflicts and push — validation re-runs automatically.');
                var cReport = cIsMachinePr
                    ? (marker + ' — the silent branch update could not merge main (conflict).' +
                       (headSha ? ' (head `' + headSha + '`)' : '') +
                       cReworkNote +
                       ' (approval latch kept — no re-review after the fix)')
                    : (marker + ' — the silent branch update could not merge main (conflict).' +
                       (headSha ? ' (head `' + headSha + '`)' : '') +
                       ' Guest PR: rebase onto main and push — validation re-runs automatically; auto-rework is reserved for the machine account.');

                // Arm FIRST (gh-683 bug C): whatever arming means for this PR,
                // it must land BEFORE the marker comment — a starved dispatch
                // or failed label add must leave NO marker, so the next tick
                // retries instead of suppressing forever.
                var armed = true;
                if (cIsMachinePr) {
                    if (cLinked && cLinkedOpen) {
                        if (!DRY) {
                            github_add_labels({
                                workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                                number: cLinked, labels: ['agent:rework']
                            });
                        }
                    } else {
                        // #579: no OPEN linked issue (missing, dangling, or
                        // already CLOSED) — anchor the rework on the PR itself,
                        // the same leg the rework-on-label rule dispatches (#544
                        // fallback shape). triggerWorkflow returns false on the
                        // global workflow cap, an active same-key run, or a
                        // dispatch failure — treat all as NOT armed (retry next
                        // tick); in DRY it logs and returns undefined — armed.
                        armed = DRY || triggerWorkflow(effectiveRepoInfo, key, {
                            id: 'conflict-rework',
                            workflowFile: 'ai-teammate.yml',
                            workflowRef: '{branch}',
                            inputs: {
                                issue: '',
                                leg: 'rework',
                                reason: 'sm: merge conflict with main, no OPEN linked issue - PR-anchored conflict rework',
                                pr: '{prNumber}'
                            }
                        }, effectiveConfig, workflowBudget, { prNumber: ticket.prNumber, branch: ticket.branch }) === true;
                    }
                }
                if (!armed) {
                    console.log('  ⏳ ' + key + ' conflict rework arming deferred (workflow cap / active run) — marker NOT posted, retrying next tick (gh-683)');
                    continue;
                }
                if (!DRY) github_create_comment({
                    workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber, body: cReport
                });
                console.log('  🔁 ' + key + ' merge conflict with main — ' +
                    (cIsMachinePr
                        ? ((cLinked && cLinkedOpen)
                            ? 'rework re-queued (issue #' + cLinked + ')'
                            : 'PR-anchored rework dispatched')
                        : 'guest PR, report only'));
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ conflict_rework failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'merge_pr') {
            // Validated green + CLEAN + APPROVED → squash-merge, then clear
            // the armed markers. ai_validating no longer implies armed
            // (pre-review validation uses the same marker): verify the
            // sticky pr_approved latch on the PR itself — an un-approved
            // green head latches ai_validated and defers to review instead
            // of merging (defense in depth for the rule guards).
            try {
                var gateRaw = github_get_pr({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    pullRequestId: ticket.prNumber
                });
                var gatePr = {};
                try {
                    gatePr = typeof gateRaw === 'string' ? JSON.parse(gateRaw) : (gateRaw || {});
                } catch (gateParseErr) { gatePr = {}; }
                var gateLabels = (gatePr.labels || []).map(function (l) {
                    return (l && l.name) || l;
                });
                if (gateLabels.indexOf('pr_approved') === -1) {
                    // Pre-review validation green: latch, unarm, review
                    // follows (review-after-dev requires ai_validated).
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validating'
                    });
                    github_add_labels({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, labels: ['ai_validated']
                    });
                    console.log('  ✅ ' + key + ' validated (no approval yet) — ai_validated latched, review follows');
                    processedKeys.push(key);
                    continue;
                }
                var mergeRaw = github_merge_pr({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    pullRequestId: ticket.prNumber,
                    mergeMethod: 'squash'
                });
                // The HTTP layer returns the raw body for error statuses
                // (Java parity) — a 405 "not mergeable" arrives as
                // {"merged": false, ...} with NO thrown error (live: fa
                // pr-753 — the merge was refused, the SM still cleared
                // pr_approved/ai_validating and logged "squash-merged",
                // orphaning the armed PR). Anything but an explicit
                // merged:true is a failure: keep the markers so the loop
                // self-heals (unarm-stale → refresh → re-validate → retry).
                var mergeResp = {};
                try {
                    mergeResp = typeof mergeRaw === 'string' ? JSON.parse(mergeRaw) : (mergeRaw || {});
                } catch (parseErr) { /* non-JSON body counts as refusal */ }
                if (mergeResp.merged !== true) {
                    throw new Error('merge refused: ' +
                        (typeof mergeRaw === 'string' ? mergeRaw : JSON.stringify(mergeRaw)));
                }
                try {
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validating'
                    });
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'pr_approved'
                    });
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validated'
                    });
                } catch (e2) { /* absent labels are fine post-merge */ }
                console.log('  🎉 ' + key + ' squash-merged');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ merge_pr failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.localAction === 'complete_validation') {
            // Pre-review validation green (not CLEAN-armed, not approved):
            // latch ai_validated, unarm ai_validating — review-after-dev
            // dispatches the review leg on the latched head. Idempotent by
            // the query guard (only fires while ai_validating is armed).
            try {
                github_remove_label({
                    workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber, label: 'ai_validating'
                });
                github_add_labels({
                    workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber, labels: ['ai_validated']
                });
                console.log('  ✅ ' + key + ' validation green — ai_validated latched, review follows');
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ complete_validation failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        var sweepFailure = false;
        if (rule.localAction === 'sweep_stale_validation') {
            // Stale-arm sweeper (live: fa #999 — ai_validating held 7h with
            // a concluded green CI and no verdict consumed; the ai_validating
            // mutex stayed held forever. unarm-stale-validation covers BEHIND
            // only). ai_validating + the head's dispatched validation run
            // CONCLUDED (success or failure — CANCELLED is never a verdict)
            // more than rule.staleMinutes ago (default 15 — the check-
            // visibility/verdict race window; a fresher conclusion may still
            // be consumed by the same-tick verdict rules) and the arm was
            // never consumed → unarm. Success side: unarm + re-latch
            // ai_validated (complete_validation parity — the merge window
            // re-flows; validate-armed latch-skips on the unchanged head).
            // Failure side: fall through to the standard fail path below
            // (report + machine-only rework re-arm — fail_validation parity).
            var sHead = (ticket.pr && ticket.pr.headSha) || ticket.headSha;
            var sCiWf = rule.ciWorkflow ||
                ((RUN_JOB_PARAMS || {}).ciWorkflow) || 'quality.yml';
            var sStaleMin = (typeof rule.staleMinutes === 'number' && rule.staleMinutes > 0)
                ? rule.staleMinutes : 15;
            var sProbe = sHead ? probeDispatchedState(effectiveRepoInfo, sCiWf, sHead) : null;
            var sRun = sProbe ? sProbe.newest : null;
            var sOld = false;
            if (sRun && sRun.status === 'completed' &&
                sRun.conclusion && sRun.conclusion !== 'cancelled') {
                var sDone = Date.parse(sRun.updated_at || sRun.created_at || '');
                sOld = !isNaN(sDone) && (Date.now() - sDone) > sStaleMin * 60 * 1000;
            }
            if (!sOld) {
                console.log('  ⏭️  ' + key + ' sweep: no concluded-and-stale validation run' +
                            ' on the head — arm stays');
                continue;
            }
            if (sRun.conclusion === 'success') {
                try {
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validating'
                    });
                    github_add_labels({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, labels: ['ai_validated']
                    });
                    console.log('  🧹 ' + key + ' stale arm swept (validation green, verdict never' +
                                ' consumed) — unarmed + ai_validated re-latched');
                    processedKeys.push(key);
                } catch (e) {
                    console.error('  ❌ sweep_stale_validation failed for ' + key + ': ' + (e.message || e));
                }
                continue;
            }
            sweepFailure = true; // concluded red → the standard fail path below owns it
            console.log('  🧹 ' + key + ' stale arm swept (validation red, never consumed)' +
                        ' — unarming + standard fail handling');
        }

        if (rule.localAction === 'fail_validation' || sweepFailure) {
            // Validation CI went red: unarm, tell the PR, and requeue the
            // machine loop by re-arming agent:rework on the linked issue
            // (the existing rework-on-red-ci rule picks it up). External
            // PRs without a linked issue get the report only.
            // Owner rule 2026-09-21: auto-REWORK is machine-author-ONLY.
            // Accounts other than the machine login are guests: they get
            // review + validation and NEVER a rework arm (they fix their
            // own findings; the SM re-validates on their push). A guest
            // "fixes #<n>" body must not arm rework on a machine ticket.
            try {
                try {
                    github_remove_label({
                        workspace: effectiveRepoInfo.owner, repository: effectiveRepoInfo.repo,
                        number: ticket.prNumber, label: 'ai_validating'
                    });
                } catch (e3) { /* absent label is fine */ }
                var machineAuthor = machineAuthorModule.resolveMachineAuthor(RUN_JOB_PARAMS, effectiveConfig);
                var isMachinePr = !!machineAuthor && !!ticket.author &&
                    String(ticket.author).toLowerCase() === String(machineAuthor).toLowerCase();
                var linked = null;
                if (isMachinePr) {
                    try {
                        var prRaw = github_get_pr({
                            workspace: effectiveRepoInfo.owner,
                            repository: effectiveRepoInfo.repo,
                            pullRequestId: ticket.prNumber
                        });
                        var prObj = typeof prRaw === 'string' ? JSON.parse(prRaw) : (prRaw || {});
                        var m = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(String(prObj.body || ''));
                        if (m) linked = parseInt(m[1], 10);
                    } catch (e4) { console.warn('  ⚠️ linked-issue lookup failed: ' + (e4.message || e4)); }
                    // Fallback (live: fa pr-750 — body said "Fixes the Play Store
                    // rejection (gh-746)", no closing keyword): machine PRs carry
                    // the issue in the branch name (ai/gh-<n>). Guest branches
                    // get nothing — the owner rule keeps auto-rework
                    // machine-only, so the fallback must be too.
                    if (!linked && ticket.branch) {
                        var bm = /(?:^|\/)gh-(\d+)$/i.exec(String(ticket.branch));
                        if (bm) linked = parseInt(bm[1], 10);
                    }
                }
                // pr_approved is STICKY (owner rule 2026-09: no re-review
                // after the first approval — review tokens are the budget).
                // Validation red post-approval re-arms rework only; the
                // fixed head re-validates via validate-armed and merges —
                // the reviewer never re-fires. Pre-review red also skips
                // this block: no approval exists to unarm. (Supersedes the
                // fa pr-750 unarm fix: the validate↔fail burn it patched is
                // now closed by the latch itself.)
                // Failed-run link (owner 2026-10-01): the report says CI
                // went red — link the exact red run(s) on this head so the
                // reader (a guest especially) never hunts the runs tab.
                // Graceful '' on any miss (no head SHA, empty run list,
                // tool error): the report posts without the link and
                // NOTHING else in this action changes.
                var failedRunsLine = failedRunLinksLine(effectiveRepoInfo,
                    rule.ciWorkflow || ((RUN_JOB_PARAMS || {}).ciWorkflow) || 'quality.yml',
                    (ticket.pr && ticket.pr.headSha) || ticket.headSha);
                var report = (isMachinePr
                    ? ('⚠️ Validation CI went red on the head — merge aborted, rework re-queued.' +
                       (linked ? ' (linked issue #' + linked + ' re-armed)' : '') +
                       ' (approval latch kept — no re-review after fixes)')
                    : '⚠️ Validation CI went red on the head. Guest PR: fix the findings and push — ' +
                      'validation re-runs automatically; auto-rework is reserved for the machine account.')
                    + (failedRunsLine ? '\n' + failedRunsLine : '');
                github_create_comment({
                    workspace: effectiveRepoInfo.owner,
                    repository: effectiveRepoInfo.repo,
                    number: ticket.prNumber,
                    body: report
                });
                if (isMachinePr && linked) {
                    github_add_labels({
                        workspace: effectiveRepoInfo.owner,
                        repository: effectiveRepoInfo.repo,
                        number: linked,
                        labels: ['agent:rework']
                    });
                } else if (!isMachinePr) {
                    // GUEST PRs get the validation_failed PARK LABEL
                    // (dmtools-agents#1179 mirror, live fa 2026-10-02: 11
                    // manual mitigations in one night — the report-only
                    // branch left the PR eligible for validate-armed, which
                    // re-selected it as the OLDEST approved candidate every
                    // tick and froze the whole FIFO behind a red guest
                    // head). The label is exactly what the sticky-park rule
                    // would set; the un-park path (human push newer than
                    // the park) clears it, so a guest fix still re-enters
                    // validation. Machine PRs never get the label: their
                    // rework cycle pushes a new head and validate-armed's
                    // notLabels:[validation_failed] would lock them out of
                    // the re-validation the rework exists for.
                    try {
                        github_add_labels({
                            workspace: effectiveRepoInfo.owner,
                            repository: effectiveRepoInfo.repo,
                            number: ticket.prNumber,
                            labels: ['validation_failed']
                        });
                    } catch (eGuestPark) {
                        console.warn('  ⚠️  guest park label failed: ' +
                            (eGuestPark.message || eGuestPark));
                    }
                }
                console.log('  🔁 ' + key + ' validation failed — ' +
                    (isMachinePr ? 'rework re-queued' + (linked ? ' (issue #' + linked + ')' : '')
                                 : 'guest PR, parked (validation_failed) + reported'));
                processedKeys.push(key);
            } catch (e) {
                console.error('  ❌ fail_validation failed for ' + key + ': ' + (e.message || e));
            }
            continue;
        }

        if (rule.targetStatus) {
            if (!rule.localTeammate && isWorkflowBudgetExhausted(rule, effectiveConfig, workflowBudget, effectiveRepoInfo)) {
                console.log('  ⏭️  ' + key + ' skipped before transition (global workflow cap reached: ' + workflowBudget.initial + ')');
                break;
            }
            moveStatus(key, rule.targetStatus);
        }

        // localTeammate runs the *entire* job (checkout, AI CLI, postJSAction) synchronously
        // before returning here — unlike the async workflow_dispatch path, there is no in-flight
        // gap left to guard once it returns. Jobs whose own customParams already
        // remove/removeLabels this exact addLabel (pr_review, pr_rework, bug_development, ...)
        // are trusted to manage it themselves — e.g. clearing it on completion so the next
        // review<->rework cycle can re-trigger. Re-adding it here afterward would immediately
        // stomp on that cleanup and permanently stick the ticket, since local rules have no
        // stale-label recovery. Only add it when the target job does *not* already self-manage it.
        var triggered = rule.localTeammate
            ? runTeammateLocally(key, rule, effectiveConfig)
            : triggerWorkflow(effectiveRepoInfo, key, rule, effectiveConfig, workflowBudget, ticket);

        if (triggered && !ruleSelfManagesLabel) addRuleLabels(key, rule, effectiveRepoInfo);

        // consumeLabels: the matched label IS the request (e.g. agent:rework
        // on a PR — a human's manual rework ask on any author). Consume it on
        // dispatch or every later tick re-fires; the issue-anchored runner's
        // customParams.removeLabels only reaches the ISSUE's labels, never
        // the PR's. Reuses the stale-label removal primitive (no-op in DRY).
        if (triggered && rule.consumeLabels) {
            normalizeLabels(null, rule.consumeLabels).forEach(function (label) {
                removeRuleLabel(key, label, rule, effectiveRepoInfo);
            });
        }

        if (triggered) {
            processedKeys.push(key);
            if (!rule.localTeammate && workflowBudget) workflowBudget.remaining -= 1;
        }
    }

    // ── Factory state publishing (owner 2026-09-23, OPT-IN) ──────────────
    // jobParams.statePublish = {channel:'release', repo?, tag?, asset?} —
    // anything else (absent / none) publishes nothing. Renders the snapshot
    // from the same sources the reconcile pass read and uploads it as a
    // release asset (public prerelease; the board reads the CDN link, no
    // tokens in the browser, no rate limits). The workflow input arrives as
    // an escaped JSON STRING — parse before guarding.
    var spCfgRaw = (RUN_JOB_PARAMS || {}).statePublish;
    if (typeof spCfgRaw === 'string') {
        try { spCfgRaw = JSON.parse(spCfgRaw); } catch (eSp0) { spCfgRaw = null; }
    }
    if (((spCfgRaw || {}).channel) === 'release' && !DRY) {
        try {
            var spCfg = spCfgRaw;
            var spRepo = (spCfg.repo ? (function () {
                    var parts = String(spCfg.repo).split('/');
                    return { owner: parts[0], repo: parts[1] };
                })() : (effectiveRepoInfo && effectiveRepoInfo.owner) ?
                effectiveRepoInfo : null);
            if (spRepo && spRepo.owner && spRepo.repo) {
                var spPrs = mcpParse(github_list_prs({
                    workspace: spRepo.owner, repository: spRepo.repo, state: 'open'
                }));
                var spPrList = Array.isArray(spPrs) ? spPrs :
                    ((spPrs && (spPrs.pullRequests || spPrs.data || spPrs.items)) || []);
                var spRuns = mcpParse(github_list_workflow_runs({
                    workspace: spRepo.owner, repository: spRepo.repo, perPage: 50
                })) || {};
                var spRunList = spRuns.workflow_runs || spRuns.workflowRuns || [];
                var spFull = spRepo.owner + '/' + spRepo.repo;
                // Schema 2 sources (owner 2026-10-01): recently merged PRs
                // (merged_recent lane — GitHub merged_at is exact), the
                // issue-side dev handoff (development lane; agent:dev =
                // dev leg running, ai_developed hands off to the PR side),
                // and the PREVIOUS snapshot off the factory-data branch —
                // one extra gh call, the accumulation source for label
                // timestamps (reviewedAt/approvedAt/validatingAt/
                // devStartedAt). All three degrade to empty/null on any
                // miss: a partial snapshot beats a dead tick.
                var spMerged = [];
                try {
                    var spM = mcpParse(github_list_prs({
                        workspace: spRepo.owner, repository: spRepo.repo,
                        state: 'merged'
                    }));
                    spMerged = Array.isArray(spM) ? spM : [];
                } catch (eMerged) { /* merged lane empty this tick */ }
                // v3: ALL open issues in one search call — feeds both the
                // development lane (agent:dev) and the backlog section
                // (in_dev / queued / blocked / inbox, see factoryState).
                var spIssues = [];
                try {
                    var spD = mcpParse(github_search_issues({
                        query: 'repo:' + spFull + ' is:issue is:open'
                    }));
                    spIssues = Array.isArray(spD) ? spD :
                        ((spD && (spD.items || spD.data)) || []);
                } catch (eDevs) { /* development + backlog empty this tick */ }
                // v3: OPTIONAL per-leg token usage — factories whose legs
                // report usage (fa's bench) drop a keyed JSON file in the
                // tick's checkout (statePublish.tokensFile); any miss just
                // publishes token-less cards (board renders "—").
                var spTokens = factoryStateModule.readTokensFile(
                    (spCfg && spCfg.tokensFile) ||
                        factoryStateModule.DEFAULT_TOKENS_FILE,
                    function (p) { return file_read({ path: p }); });
                var spPrev = factoryStateModule.fetchPreviousState(
                    spFull, spCfg, function (a) {
                        return cli_execute_command(a);
                    });
                var spState = factoryStateModule.buildFactoryState({
                    repoInfo: spRepo,
                    prs: spPrList,
                    mergedPrs: spMerged,
                    issues: spIssues,
                    machineAuthor: machineAuthorModule.resolveMachineAuthor(
                        RUN_JOB_PARAMS, effectiveConfig),
                    tokens: spTokens,
                    runs: spRunList,
                    checkNames: validationCheckNames() || [],
                    prev: spPrev,
                    dryRun: DRY,
                    processed: processedKeys
                });
                var spUrl = factoryStateModule.publishFactoryState(
                    spState, spCfg, function (args) {
                        // MUST return: publishFactoryState probes the
                        // existing-file sha through this lambda — without
                        // the return the probe yields undefined, the PUT
                        // goes out sha-less and every update 422s
                        // ("sha wasn't supplied") after the first create.
                        return cli_execute_command(args);
                    });
                console.log('  📡 factory state published → ' + spUrl);
                try {
                    var hUrl = factoryStateModule.updateHistory(
                        spState, spCfg, function (a) {
                            return cli_execute_command(a);
                        });
                    console.log('  🕘 factory state history updated → ' + hUrl);
                } catch (eHist) {
                    // history is a board affordance — never fail the tick
                    console.warn('  ⚠️  factory state history failed: ' +
                                 (eHist.message || eHist));
                }
            }
        } catch (ePub) {
            console.warn('  ⚠️  factory state publish failed: ' +
                         (ePub.message || ePub));
        }
    }

    return { processedKeys: processedKeys, skippedKeys: skippedKeys };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function resolveWorkflowCap(jsonCap, projectCfg) {
    // Priority: config.smMaxWorkflows (from .dmtools/config.js) > sm.json default
    if (projectCfg && typeof projectCfg.smMaxWorkflows !== 'undefined') {
        var n = normalizePositiveInt(projectCfg.smMaxWorkflows);
        if (n) { console.log('  Workflow cap override (config.smMaxWorkflows): ' + n); return n; }
    }
    return normalizePositiveInt(jsonCap);
}


// Patches rules from project config smRuleOverrides, matched by rule id
// (github rules carry stable ids) or configFile (jira rules).
function applyRuleOverrides(rules, overrides) {
    if (!overrides || typeof overrides !== 'object') return rules;
    return rules.map(function(rule) {
        var patch = overrides[rule.id] || overrides[rule.configFile];
        if (!patch) return rule;
        var patched = {};
        Object.keys(rule).forEach(function(k) { patched[k] = rule[k]; });
        Object.keys(patch).forEach(function(k) { patched[k] = patch[k]; });
        console.log('SM Agent: Patched rule "' + (rule.id || rule.description || rule.configFile) + '" with override:', JSON.stringify(patch));
        return patched;
    });
}

// Active dispatched run for a head SHA? (duplicate-dispatch guard.)
// Reuses the same workflow filter the validation-sync loop reads; a
// pending run is invisible until GitHub materializes it (~30s), so a
// completed run newer than 15 minutes on the same head also counts as
// "in flight" — the arm label + stamps cover the rest.
// Cancel in-flight dispatched validations on superseded heads of this
// branch (owner 2026-09-23: when the branch moves after a dispatch, the
// old runs can never stamp a verdict on the current head — cancel them
// instead of burning the hosted queue). Scoped by head_branch === the
// PR's branch, so a concurrent validation of a DIFFERENT PR is untouchable.
function cancelStaleDispatchedRuns(repoInfo, ciWorkflow, branch, currentSha) {
    if (!branch || !currentSha) return 0;
    try {
        var res = cli_execute_command({
            command: 'gh api "repos/' + repoInfo.owner + '/' +
                     repoInfo.repo +
                     '/actions/workflows/' + ciWorkflow +
                     '/runs?event=workflow_dispatch&per_page=50"'
        });
        var runs = mcpParse((res || {}).output ||
                            (res || {}).stdout || res);
        var list = (runs && runs.workflow_runs) || [];
        var stale = list.filter(function (r) {
            return r && r.head_branch === branch &&
                   r.head_sha !== currentSha &&
                   (r.status === 'queued' || r.status === 'in_progress' ||
                    r.status === 'waiting' || r.status === 'pending');
        });
        var cancelled = 0;
        stale.forEach(function (r) {
            try {
                cli_execute_command({
                    command: 'gh api -X POST repos/' +
                        repoInfo.owner + '/' + repoInfo.repo +
                        '/actions/runs/' + r.id + '/cancel || true'
                });
                cancelled++;
                console.log('  🛑 cancelled stale validation run ' + r.id +
                            ' on superseded head ' +
                            String(r.head_sha).slice(0, 7) + ' (' +
                            branch + ')');
            } catch (e2) {
                console.warn('  ⚠️  cancel of stale run ' + r.id +
                             ' failed: ' + (e2.message || e2));
            }
        });
        return cancelled;
    } catch (e) {
        // Fail OPEN: a stale-cancel probe error must not wedge the arm —
        // worst case is the wasted runs we are trying to prevent.
        console.warn('  ⚠️  stale-cancel probe failed: ' + (e.message || e));
        return 0;
    }
}

// ── Dispatched-CI probe bundle (read fan-out for the runAsync pool) ─────
// Every dispatched-CI guard used to fire its own `gh api .../runs?head_sha`
// round per matched item (measured: the validate_pr guards alone cost 2-4
// sequential gh calls per candidate). ONE worker round now computes all
// four facets of the head's dispatched-run state; the main-side fallback
// (Java/GraalJS parity, unit tests) runs the same four helpers
// sequentially and assembles the identical shape. The source is a STRING
// literal of a CLOSURE-FREE function — fn.toString()-serialized for the
// worker engines, direct-evaled in-process on the fallback — so it carries
// its own mcpParse copy and takes everything via args. Per-facet defaults
// mirror each helper's try/catch warn-and-default (fail OPEN/closed
// exactly like today). READ-ONLY: cancelStaleDispatchedRuns stays on the
// main engine (it is a WRITE).
var PROBE_WORKER_SOURCE = [
    'function(args) {',
    '    function mcpParse(result) {',
    '        if (!result) return null;',
    "        if (typeof result === 'string') {",
    '            try { return JSON.parse(result); } catch (e) { return null; }',
    '        }',
    '        return result;',
    '    }',
    '    // Defaults = each helper catch-branch: active/green fail OPEN,',
    '    // verdict/newest fail CLOSED (null).',
    "    var out = { active: false, verdict: null, green: false, newest: null };",
    '    try {',
    '        var res = cli_execute_command({',
    "            command: 'gh api \"repos/' + args.repo.owner + '/' + args.repo.repo +",
    "                '/actions/workflows/' + args.ciWorkflow +",
    "                '/runs?head_sha=' + args.headSha +",
    "                '&event=workflow_dispatch&per_page=5\"'",
    '        });',
    '        var parsed = mcpParse((res || {}).output || (res || {}).stdout || res);',
    '        var list = (parsed && parsed.workflow_runs) || [];',
    '        var now = Date.now();',
    '    // active — hasActiveDispatchedRun semantics: any queued/in-progress/',
    '    // waiting/pending run, or a completed one whose CONCLUSION is younger',
    '    // than the 15-min check-visibility grace.',
    '        out.active = list.some(function (r) {',
    "            if (r.status === 'queued' || r.status === 'in_progress' ||",
    "                r.status === 'waiting' || r.status === 'pending') return true;",
    "            if (r.status === 'completed') {",
    '                var endTs = r.updated_at || r.created_at;',
    '                var age = now - new Date(endTs).getTime();',
    '                return age >= 0 && age < 15 * 60 * 1000;',
    '            }',
    '            return false;',
    '        });',
    '    // green — hasSuccessfulDispatchedRun semantics: any completed run with',
    '    // conclusion success on this head (a canceled run leaves no verdict).',
    "        out.green = list.some(function (r) {",
    "            return r.status === 'completed' && r.conclusion === 'success';",
    '        });',
    '    // verdict — latestDispatchedVerdict semantics: the newest CONCLUSION',
    '    // of a completed non-cancelled run (CANCELLED is never a verdict).',
    '        var concluded = list.filter(function (r) {',
    "            return r.status === 'completed' && r.conclusion &&",
    "                r.conclusion !== 'cancelled';",
    '        });',
    '        if (concluded.length) {',
    '            concluded.sort(function (a, b) {',
    '                return new Date(b.updated_at || b.created_at).getTime() -',
    '                       new Date(a.updated_at || a.created_at).getTime();',
    '            });',
    '            out.verdict = concluded[0].conclusion;',
    '        }',
    '    // newest — newestDispatchedRun semantics: the newest run on this head,',
    '    // any status/conclusion.',
    '        if (list.length) {',
    '            var sorted = list.slice();',
    '            sorted.sort(function (a, b) {',
    '                return Date.parse(b.updated_at || b.created_at || 0) -',
    '                       Date.parse(a.updated_at || a.created_at || 0);',
    '            });',
    '            out.newest = sorted[0];',
    '        }',
    '    } catch (e) {',
    "        console.warn('  ⚠️  dispatched-state probe failed: ' + (e.message || e));",
    '    }',
    '    return out;',
    '}'
].join('\n');

/**
 * The 'Failed run: <url>' report line for fail_validation (owner
 * 2026-10-01): the newest 1-3 TERMINAL RED (failure/timed_out) dispatched
 * runs of `ciWorkflow` on THIS exact head — the same list source and shape
 * the verdict stamps and factoryState's headVerdict read
 * (github_list_workflow_runs; REST is newest-first, sorted explicitly
 * anyway). Both report variants (machine + guest) append it so the reader
 * sees WHERE it went red without hunting the runs tab. Graceful by
 * contract: missing head SHA, empty list, or any tool error → '' — the
 * report posts without the link and never dies.
 */
function failedRunLinksLine(repoInfo, ciWorkflow, headSha) {
    if (!repoInfo || !ciWorkflow || !headSha) return '';
    try {
        var runs = mcpParse(github_list_workflow_runs({
            workspace: repoInfo.owner, repository: repoInfo.repo,
            workflowId: ciWorkflow, perPage: 50
        })) || {};
        var list = runs.workflow_runs || runs.workflowRuns || [];
        var red = list.filter(function (r) {
            return r && r.event === 'workflow_dispatch' &&
                r.head_sha === headSha &&
                r.status === 'completed' &&
                (r.conclusion === 'failure' || r.conclusion === 'timed_out');
        });
        red.sort(function (a, b) {
            return new Date(b.updated_at || b.created_at).getTime() -
                   new Date(a.updated_at || a.created_at).getTime();
        });
        var urls = red.slice(0, 3).map(function (r) { return r.html_url; })
            .filter(function (u) { return !!u; });
        if (!urls.length) return '';
        return (urls.length === 1 ? 'Failed run: ' : 'Failed runs: ') +
               urls.join(', ');
    } catch (e) {
        console.warn('  ⚠️  failed-run link lookup failed: ' + (e.message || e));
        return '';
    }
}

function probeDispatchedState(repoInfo, ciWorkflow, headSha) {
    // runAsync wired (jobParams.parallelWorkers >= 2): ONE worker round.
    // Fallback: the four existing helpers on the main engine — identical
    // shape, identical per-facet defaults.
    if (typeof runAsync === 'function') {
        // runAsync takes the FUNCTION object (it re-serializes the source
        // via fn.toString() for the worker engine).
        return runAsync(eval('(' + PROBE_WORKER_SOURCE + ')'), {
            repo: repoInfo, ciWorkflow: ciWorkflow, headSha: headSha
        }).wait();
    }
    return {
        active: hasActiveDispatchedRun(repoInfo, ciWorkflow, headSha),
        verdict: latestDispatchedVerdict(repoInfo, ciWorkflow, headSha),
        green: hasSuccessfulDispatchedRun(repoInfo, ciWorkflow, headSha),
        newest: newestDispatchedRun(repoInfo, ciWorkflow, headSha)
    };
}

function hasActiveDispatchedRun(repoInfo, ciWorkflow, headSha) {
    try {
        var res = cli_execute_command({
            command: 'gh api "repos/' + repoInfo.owner + '/' +
                     repoInfo.repo +
                     '/actions/workflows/' + ciWorkflow +
                     '/runs?head_sha=' + headSha +
                     '&event=workflow_dispatch&per_page=5"'
        });
        var runs = mcpParse((res || {}).output ||
                            (res || {}).stdout || res);
        var list = (runs && runs.workflow_runs) || [];
        var now = Date.now();
        return list.some(function (r) {
            if (r.status === 'queued' || r.status === 'in_progress' ||
                r.status === 'waiting' || r.status === 'pending') return true;
            if (r.status === 'completed') {
                // Grace from the run's CONCLUSION (updated_at), not its
                // creation: the check-run visibility race only lasts ~15
                // min after the verdict lands. Counting from created_at let
                // a long-queued-then-cancelled/red run shadow re-dispatch
                // far beyond its conclusion, and pinned the grace window to
                // a point that had nothing to do with the verdict (live: fa
                // wave stall 2026-09-27 — red heads could not re-validate
                // for the whole created_at+15min span after a slow run).
                var endTs = r.updated_at || r.created_at;
                var age = now - new Date(endTs).getTime();
                return age >= 0 && age < 15 * 60 * 1000;
            }
            return false;
        });
    } catch (e) {
        // Fail OPEN: a probe error must not wedge the arm — worst case
        // is the pre-guard duplicate we are trying to prevent.
        console.warn('  ⚠️  dispatch-guard probe failed: ' + (e.message || e));
        return false;
    }
}


function latestDispatchedVerdict(repoInfo, ciWorkflow, headSha) {
    // Latest CONCLUDED verdict of a dispatched validation run on this exact
    // head ('success' / 'failure' / ...), or null when none concluded.
    // CANCELLED is never a verdict (a cancel leaves no signal — the
    // dead-zone/re-dispatch rules own that state), so cancelled
    // conclusions are skipped here. Fail CLOSED (null) on probe errors:
    // callers must only PARK on an explicitly observed red verdict.
    try {
        var res = cli_execute_command({
            command: 'gh api "repos/' + repoInfo.owner + '/' +
                     repoInfo.repo +
                     '/actions/workflows/' + ciWorkflow +
                     '/runs?head_sha=' + headSha +
                     '&event=workflow_dispatch&per_page=5"'
        });
        var runs = mcpParse((res || {}).output ||
                            (res || {}).stdout || res);
        var list = ((runs && runs.workflow_runs) || []).filter(function (r) {
            return r.status === 'completed' && r.conclusion &&
                r.conclusion !== 'cancelled';
        });
        if (!list.length) return null;
        list.sort(function (a, b) {
            return new Date(b.updated_at || b.created_at).getTime() -
                   new Date(a.updated_at || a.created_at).getTime();
        });
        return list[0].conclusion;
    } catch (e) {
        console.warn('  ⚠️  verdict probe failed: ' + (e.message || e));
        return null;
    }
}

function hasSuccessfulDispatchedRun(repoInfo, ciWorkflow, headSha) {    // Green-CI cover probe (rule flag skipIfGreenCi — used by
    // revalidate-armed-green): a COMPLETED dispatched run with conclusion
    // 'success' on this exact head means CI already passed here. If the
    // mergeState is still BLOCKED then, the unmet required check belongs
    // to ANOTHER workflow — re-dispatching this one cannot fix it, and
    // without this guard the rule would re-dispatch on every tick
    // forever. CANCELLED completions do NOT cover: a canceled run leaves
    // no verdict (concurrency-cancel on racing dispatches is exactly how
    // an armed head loses its CI — live: fa pr-922, 2026-09-26).
    try {
        var res = cli_execute_command({
            command: 'gh api "repos/' + repoInfo.owner + '/' +
                     repoInfo.repo +
                     '/actions/workflows/' + ciWorkflow +
                     '/runs?head_sha=' + headSha +
                     '&event=workflow_dispatch&per_page=5"'
        });
        var runs = mcpParse((res || {}).output ||
                            (res || {}).stdout || res);
        var list = (runs && runs.workflow_runs) || [];
        return list.some(function (r) {
            return r.status === 'completed' && r.conclusion === 'success';
        });
    } catch (e) {
        // Fail OPEN (dispatch): a probe error costs at most one extra run.
        console.warn('  ⚠️  green-cover probe failed: ' + (e.message || e));
        return false;
    }
}

function validationRollupGreen(repoInfo, prNumber) {
    // Latch-skip probe (rule flag skipIfValidatedHead — validate-armed):
    // the WHOLE check rollup must be green — the dispatched run alone only
    // covers the validation workflow; a red FOREIGN required check must
    // force the normal validation path (the merge window gates on the full
    // rollup too). Fail CLOSED: a probe error costs at most one redundant
    // validation run, never a skipped one.
    try {
        var provider = smProviderModule.createSmProvider({
            scm: { provider: 'github' },
            repository: repoInfo
        });
        var st = provider.prStatus(prNumber);
        return !!st && st.checkConclusion === 'green';
    } catch (e) {
        console.warn('  ⚠️  latch-skip rollup probe failed: ' + (e.message || e));
        return false;
    }
}

function headChecksRed(repoInfo, prNumber) {
    // Sticky-park SET probe (owner 2026-09-27, live: fa#923): does the PR
    // head carry a red (failure) check RIGHT NOW? Same provider status
    // rollup the latch-skip guard uses (checkConclusion 'red'). Fail OPEN
    // (false): a missed label costs at most one more arm cycle (the
    // deferRedHead park still catches it), never a wrongful park.
    try {
        var provider = smProviderModule.createSmProvider({
            scm: { provider: 'github' },
            repository: repoInfo
        });
        var st = provider.prStatus(prNumber);
        return !!st && st.checkConclusion === 'red';
    } catch (e) {
        console.warn('  ⚠️  red-rollup probe failed: ' + (e.message || e));
        return false;
    }
}

function headCommitIdentity(repoInfo, headSha) {
    // Sticky-park RESET probe (owner 2026-09-27): the LAST commit's
    // committer name. 'sm-silent-update' is the identity
    // silentUpdateBranch sets explicitly on its merge commits — anything
    // else means an author push / a non-machine actor moved the head and
    // the validation_failed park must clear. Returns the committer name
    // ('' when unknown — treated as non-machine by the caller:
    // revalidate rather than starve), or null when the probe fails (the
    // caller keeps the park — fail CLOSED: an SM head must never slip
    // through on a dead probe).
    try {
        var res = cli_execute_command({
            command: 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo +
                     '/commits/' + headSha + '" --jq ".commit.committer.name"'
        });
        var out = (res || {}).output || (res || {}).stdout || res;
        return String(out == null ? '' : out).trim().replace(/^"|"$/g, '');
    } catch (e) {
        console.warn('  ⚠️  head-commit probe failed: ' + (e.message || e));
        return null;
    }
}

function headCommitActor(repoInfo, headSha) {
    // Sticky-park RESET probe v2 (owner 2026-09-30, live fa pr-1094): the
    // GitHub-linked account that carries the head commit plus its commit
    // date. login = author.login || committer.login — the deployment's
    // machineAuthor login carries every agent-leg push (the rework WIP
    // auto-saves land as ai-teammate), so a machine push is recognizable
    // by LOGIN, not by git name: the agent's git identity ("AI Teammate"
    // <agent.ai.native@gmail.com>) differs from the workflow identities.
    // Returns {login, date} or null (fail closed: the caller keeps the
    // park — a dead probe must never un-park).
    try {
        var res = cli_execute_command({
            command: 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo +
                     '/commits/' + headSha +
                     '" --jq \'{login: (.author.login // .committer.login // ""), date: .committer.date}\''
        });
        var parsed = mcpParse((res || {}).output || (res || {}).stdout || res);
        if (!parsed || typeof parsed !== 'object') return null;
        return { login: String(parsed.login || ''), date: String(parsed.date || '') };
    } catch (e) {
        console.warn('  ⚠️  head-commit actor probe failed: ' + (e.message || e));
        return null;
    }
}

function parkedSince(repoInfo, prNumber) {
    // Sticky-park RESET probe: ISO time of the newest validation_failed
    // 'labeled' event — the park's start. The RESET requires the clearing
    // push to be NEWER than this moment; the head that the park was set
    // on predates the event by definition, so an old red head cannot
    // clear its own park. Returns the ISO string or null (fail closed).
    try {
        var res = cli_execute_command({
            command: 'gh api "repos/' + repoInfo.owner + '/' + repoInfo.repo +
                     '/issues/' + prNumber +
                     '/events?per_page=100" --jq \'[.[] | select(.event == "labeled" and .label.name == "validation_failed") | .created_at] | max // ""\''
        });
        var out = String((res || {}).output || (res || {}).stdout || res || '')
            .trim().replace(/^"|"$/g, '');
        return out || null;
    } catch (e) {
        console.warn('  ⚠️  park-time probe failed: ' + (e.message || e));
        return null;
    }
}

function parkedHeadSha(repoInfo, prNumber) {
    // Sticky-park RESET probe v2 (dmtools-agents#633, live fa#1139
    // 2026-10-02): the head sha the NEWEST park comment recorded
    // ('parked-head: <sha>'). The park verdict is only valid for THAT
    // sha; a silent rebase moves the head to a sha that has never been
    // validated, and the sticky park must not outlive its verdict.
    // Returns the 40-hex sha or '' when no park comment is found.
    // Probe failure returns null (fail closed: no sha → no head-change
    // clear; the human-push RESET path still applies).
    try {
        var res = github_get_pr_comments({
            workspace: repoInfo.owner, repository: repoInfo.repo,
            pullRequestId: prNumber
        });
        var obj = typeof res === 'string' ? JSON.parse(res) : (res || []);
        var list = Array.isArray(obj) ? obj : (obj.comments || obj.items || []);
        var sha = '';
        list.forEach(function (c) {
            var b = String((c && c.body) || '');
            if (b.indexOf('parked-head: ') === -1) return;
            var tail = b.slice(b.lastIndexOf('parked-head: ') + 13);
            var m = /^([0-9a-f]{40})/.exec(tail.trim());
            if (m) sha = m[1];
        });
        return sha;
    } catch (e) {
        console.warn('  ⚠️  park-head probe failed: ' + (e.message || e));
        return null;
    }
}

function newestDispatchedRun(repoInfo, ciWorkflow, headSha) {
    // Newest dispatched CI run on this exact head (any status/conclusion),
    // or null. Stale-arm sweeper probe — must FAIL CLOSED (null): an
    // unwarranted unarm tears a live arm; a missed sweep retries next tick.
    try {
        var res = cli_execute_command({
            command: 'gh api "repos/' + repoInfo.owner + '/' +
                     repoInfo.repo +
                     '/actions/workflows/' + ciWorkflow +
                     '/runs?head_sha=' + headSha +
                     '&event=workflow_dispatch&per_page=5"'
        });
        var runs = mcpParse((res || {}).output ||
                            (res || {}).stdout || res);
        var list = (runs && runs.workflow_runs) || [];
        if (!list.length) return null;
        list.sort(function (a, b) {
            return Date.parse(b.updated_at || b.created_at || 0) -
                   Date.parse(a.updated_at || a.created_at || 0);
        });
        return list[0];
    } catch (e) {
        console.warn('  ⚠️  stale-arm probe failed: ' + (e.message || e));
        return null;
    }
}


// ── Bridge-free validation checks (owner 2026-09-23) ──────────────────
// Shared helpers for tick-stamped checks. parseMcp parity: bridge tools
// may return decoded objects, JSON strings, or {data:…} envelopes.
function mcpParse(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return null; }
    }
    return result;
}

function validationCheckNames() {
    var raw = (RUN_JOB_PARAMS || {}).validationChecks;
    if (!raw) return null;
    if (Array.isArray(raw)) return raw.length ? raw : null;
    if (typeof raw === 'string') {
        try {
            var arr = JSON.parse(raw);
            return (Array.isArray(arr) && arr.length) ? arr : null;
        } catch (e) { return null; }
    }
    return null;
}

function stampLinkBlock(repoInfo, runUrl, conclusion) {
    // Stamp deep links (owner 2026-09-27): a concluded stamp check-run
    // created WITHOUT details_url renders 'This check concluded as …' plus
    // the generic 'View more details on GitHub Actions' — nowhere to click
    // through to the real run. The stamp therefore carries details_url (the
    // failing JOB on red, the umbrella run otherwise — a stamp aggregates
    // the whole dispatched run) and a markdown jobs table in the summary.
    // Fail-soft everywhere: the run link alone already beats the generic
    // landing, and a broken jobs probe must never lose the verdict stamp.
    var block = {
        detailsUrl: runUrl || null,
        summary: runUrl ? ('Dispatched run: ' + runUrl)
                        : 'Stamped by the SM tick (bridge-free mode).'
    };
    if (!runUrl) return block;
    var m = /\/runs\/(\d+)/.exec(String(runUrl));
    if (!m) return block;
    try {
        var res = cli_execute_command({
            command: 'gh api repos/' + repoInfo.owner + '/' + repoInfo.repo +
                     '/actions/runs/' + m[1] + '/jobs?per_page=100'
        });
        var parsed = mcpParse((res || {}).output ||
                              (res || {}).stdout || res);
        var jobs = (parsed && parsed.jobs) || [];
        if (!jobs.length) return block;
        var lines = ['| Job | Result |', '| --- | --- |'];
        jobs.forEach(function (j) {
            var verdict = j.conclusion ? (j.status === 'completed' ? j.conclusion : j.status)
                                       : j.status;
            var link = j.html_url || runUrl;
            lines.push('| [' + String(j.name).replace(/"/g, "'") + '](' + link + ') | ' +
                       verdict + ' |');
        });
        block.summary = ('Dispatched run: ' + runUrl + '\n' + lines.join('\n') +
                         '\n_Stamped by the SM tick (bridge-free mode)._').replace(/"/g, "'");
        // Red verdict: land the reviewer on the FAILING JOB directly, not
        // the umbrella run (success keeps the umbrella — one click lists
        // every job).
        if (conclusion === 'failure') {
            var failing = jobs.filter(function (j) {
                return ['failure', 'timed_out', 'action_required',
                        'startup_failure', 'stale'].indexOf(j.conclusion) !== -1;
            })[0];
            if (failing && failing.html_url) block.detailsUrl = failing.html_url;
        }
    } catch (e) {
        console.warn('  ⚠️  stamp job-table probe failed: ' + (e.message || e));
    }
    return block;
}

function stampValidationChecksForModule(repoInfo, headSha, status, conclusion, runUrl) {
            var names = validationCheckNames();
            if (!names || !headSha) return;
            // Check runs are GitHub-App-only ("You must authenticate via a
            // GitHub App") — the tick PAT cannot create them. The workflow
            // token (jobParams.silentToken) IS an App token with
            // checks:write on the repo the tick runs in. Swap GH_TOKEN for
            // the gh child exactly like silentUpdateBranch does, restore
            // after (sourceToken).
            var appToken = (RUN_JOB_PARAMS || {}).silentToken;
            var sourceTok = (RUN_JOB_PARAMS || {}).sourceToken;
            var swapped = false;
            if (appToken) {
                try {
                    set_env_variable('GH_TOKEN', appToken);
                    swapped = true;
                } catch (e) {
                    console.warn('  ⚠️  token swap failed, stamps use the PAT: ' + (e.message || e));
                }
            }
            try {
                // One jobs probe per stamp, shared by every stamped check
                // name (they all echo the same dispatched run).
                var linkBlock = stampLinkBlock(repoInfo, runUrl, conclusion);
                names.forEach(function (checkName) {
                    if (DRY) {
                        console.log('  🧪 [dry] stamp "' + checkName + '" ' +
                                    status + (conclusion ? '/' + conclusion : ''));
                        return;
                    }
                    // POST /repos/{o}/{r}/check-runs — head_sha is a FIELD,
                    // never a path segment (sha-in-path 404s). github_create
                    // _check_run is MCP-registry-only (not a JS-bridge tool).
                    // details_url + the jobs table (stampLinkBlock) turn the
                    // PR Checks-tab entry into a clickable path to the real
                    // workflow run / failing job (owner 2026-09-27).
                    try {
                        var cmd = 'gh api -X POST repos/' + repoInfo.owner +
                                  '/' + repoInfo.repo + '/check-runs' +
                                  ' -f name="' + checkName + '"' +
                                  ' -f head_sha=' + headSha +
                                  ' -f status="' + status + '"' +
                                  (conclusion ? (' -f conclusion="' + conclusion + '"') : '') +
                                  (linkBlock.detailsUrl ?
                                      (' -f details_url="' + linkBlock.detailsUrl + '"') : '') +
                                  ' -f title="SM validation' +
                                  (conclusion ? (': ' + conclusion) : ' (tick-dispatched)') + '"' +
                                  ' -f summary="' + linkBlock.summary + '"';
                        cli_execute_command({ command: cmd });
                    } catch (e) {
                        console.warn('  ⚠️  stamp "' + checkName + '" on ' +
                                     String(headSha).slice(0, 7) + ': ' + (e.message || e));
                    }
                });
            } finally {
                if (swapped && sourceTok) {
                    try { set_env_variable('GH_TOKEN', sourceTok); } catch (e2) {}
                }
            }
        }

// One sync per repo per tick-process (the hook fires per PR rule; a
// short window stops repeat API passes inside a single tick).
var validationCheckSync = { repo: null, at: 0 };

// Refresh the stamped validation checks for every ai_validating PR in the
// repo from the newest dispatched ci runs (CANCELLED is never a verdict —
// gh-191; newest terminal non-cancelled run decides, else newest active).
function syncValidationChecks(repoInfo, stampFn) {
    if (!validationCheckNames() || !repoInfo || !repoInfo.owner || !repoInfo.repo) return;
    var repoKey = repoInfo.owner + '/' + repoInfo.repo;
    var now = Date.now();
    if (validationCheckSync.repo === repoKey && (now - validationCheckSync.at) < 5000) return;
    validationCheckSync = { repo: repoKey, at: now };
    var ciWorkflow = ((RUN_JOB_PARAMS || {}).ciWorkflow) || 'quality.yml';
    var prs = mcpParse(github_list_prs({
        workspace: repoInfo.owner, repository: repoInfo.repo, state: 'open'
    }));
    var prList = Array.isArray(prs) ? prs :
        ((prs && (prs.pullRequests || prs.data || prs.items)) || []);
    var armed = prList.filter(function (pr) {
        return pr.head && pr.head.sha && pr.head.ref &&
            (pr.labels || []).some(function (l) {
                return (l && l.name) === 'ai_validating';
            });
    });
    if (!armed.length) return;
    // NOTE: workspace/repository are REQUIRED — _repoSeg builds the URL
    // from the args; without them it degenerates to /repos// and 404s
    // (live: first bridge-free ticks stamped nothing, exactly this).
    var runs = mcpParse(github_list_workflow_runs({
        workspace: repoInfo.owner, repository: repoInfo.repo,
        workflowId: ciWorkflow, perPage: 50
    })) || {};
    var runList = runs.workflow_runs || runs.workflowRuns || [];
    var runsErr = (runList.length === 0 && runs && runs.message) || null;
    if (runsErr) {
        // Live 2026-09-23: the workflow-id form 404s for the tick PAT on
        // fa (while gh CLI dispatch works) — fall back to the all-runs
        // endpoint and filter by the workflow PATH client-side.
        var all = mcpParse(github_list_workflow_runs({
            workspace: repoInfo.owner, repository: repoInfo.repo, perPage: 50
        })) || {};
        var allList = all.workflow_runs || all.workflowRuns || [];
        var want = '.github/workflows/' + ciWorkflow;
        runList = allList.filter(function (r) { return r.path === want; });
        console.log('  ℹ️  validation-sync: workflow-id form failed (' +
                    String(runsErr).slice(0, 60) + ') — all-runs fallback: ' +
                    runList.length + ' runs');
    }
    if (!runList.length) {
        console.log('  ℹ️  validation-sync: 0 runs from ' + ciWorkflow +
                    ' — raw: ' + JSON.stringify(runs).slice(0, 200));
    }
    var syncDebug = { armed: armed.length, runs: runList.length };
    armed.forEach(function (pr) {
        var headSha = pr.head.sha;
        // REST lists newest-first; only THIS head's dispatched runs count.
        var mine = runList.filter(function (r) {
            return r.event === 'workflow_dispatch' && r.head_sha === headSha;
        });
        if (!mine.length) return; // dispatch not landed; validate_pr stamps
        var active = mine.filter(function (r) {
            return r.status === 'queued' || r.status === 'in_progress' ||
                   r.status === 'waiting' || r.status === 'pending';
        });
        var terminal = mine.filter(function (r) {
            return r.status === 'completed' && r.conclusion &&
                   r.conclusion !== 'cancelled';
        });
        if (terminal.length) {
            var t = terminal[0];
            console.log('  📍 stamp verdict pr#' + pr.number + ' ' +
                        t.conclusion + ' run ' + t.id +
                        ' (stampFn: ' + typeof stampFn + ')');
            try {
                stampFn(headSha, 'completed',
                        t.conclusion === 'success' ? 'success' : 'failure',
                        t.html_url);
            } catch (e) {
                console.warn('  ⚠️  verdict stamp threw: ' + (e.message || e) +
                             ' / stack: ' + String(e.stack || '').split('\n').slice(0, 3).join(' | '));
            }
        } else if (active.length) {
            console.log('  📍 stamp in-progress pr#' + pr.number +
                        ' (stampFn: ' + typeof stampFn + ')');
            try {
                stampFn(headSha, 'in_progress', null, active[0].html_url);
            } catch (e) {
                console.warn('  ⚠️  in-progress stamp threw: ' + (e.message || e));
            }
        }
    });
    console.log('  ℹ️  validation-sync: ' + JSON.stringify(syncDebug));
}

function action(params) {
    var p     = params.jobParams || params;
    RUN_JOB_PARAMS = p;    DRY = p.dryRun === true;
    if (DRY) console.log('🧪 DRY RUN — no side effects will be performed');
    var rules = p.rules;

    // Load global project configuration (used as default when rules have no configPath)
    projectConfig = configLoader.loadProjectConfig(p);

    var configuredWorkflowCap = resolveWorkflowCap(
        typeof p.maxTriggeredWorkflows !== 'undefined' ? p.maxTriggeredWorkflows : p.maxWorkflowsPerRun,
        projectConfig
    );
    var workflowBudget = configuredWorkflowCap ? { initial: configuredWorkflowCap, remaining: configuredWorkflowCap } : null;

    // Use smRules from config if provided (full override)
    if (projectConfig.smRules && Array.isArray(projectConfig.smRules) && projectConfig.smRules.length > 0) {
        console.log('SM Agent: Using smRules override from project config (' + projectConfig.smRules.length + ' rules)');
        rules = projectConfig.smRules;
    }

    // Apply smRuleOverrides from project config — patches individual rules by
    // id (github rules) or configFile (jira rules). Example in .dmtools/config.js:
    //   smRuleOverrides: {
    //     'rework-on-red-ci':            { enabled: false },
    //     'merge-approved-fifo':         { limit: 2 },
    //     'agents/bulk_bugs_creation.json': { enabled: true }
    //   }
    rules = applyRuleOverrides(rules, projectConfig.smRuleOverrides);

    // Global "run everything locally" override — set via a CLI JSON override, e.g.:
    //   dmtools run agents/sm.json '{"params":{"jobParams":{"forceLocalTeammate":true}}}'
    // NOTE the outer "params" wrapper: `dmtools run <file> <override>` deep-merges the
    // override into the whole {name, params} job config object, not directly into
    // params.jobParams — a bare {"jobParams":{...}} override (missing the "params"
    // wrapper) is silently ignored, no error, jobParams just stays at sm.json's defaults.
    // Forces every default-dispatch rule to run through the local teammate pipeline
    // (as if it had localTeammate:true) instead of a GitHub Actions workflow_dispatch —
    // no env var needed; dmtools' own CLI JSON-override mechanism is the switch. Rules
    // already using localExecution:true (pure-JS, no checkout/AI CLI) are left untouched.
    // A rule can opt out even while the override is
    // active by setting `localTeammate: false` explicitly.
    if (p.forceLocalTeammate && rules) {
        var forcedCount = 0;
        rules = rules.map(function(rule) {
            if (rule.localExecution || rule.localTeammate === false || rule.localTeammate) {
                return rule;
            }
            forcedCount++;
            var forced = {};
            Object.keys(rule).forEach(function(k) { forced[k] = rule[k]; });
            forced.localTeammate = true;
            return forced;
        });
        console.log('SM Agent: forceLocalTeammate override active — ' + forcedCount +
            ' rule(s) switched from dispatch to local execution');
    }

    // Targeted mode: bypass all JQL rules and dispatch a single agent to a single ticket.
    // Activated when targetTicket + targetAgent are present in jobParams (or encoded_config override).
    // Finds the existing rule for targetAgent (respecting smRules/smRuleOverrides) and inherits all
    // its properties (localExecution, concurrencyKey, addLabel, etc.) — only the JQL is replaced.
    // Idempotency skip labels are stripped so targeted runs always proceed regardless of prior state.
    var targetTicket = p.targetTicket;
    var targetAgent  = p.targetAgent;
    if (targetTicket && targetAgent) {
        console.log('SM Agent: Targeted mode — ticket: ' + targetTicket + ', agent: ' + targetAgent);

        var matchedRule = null;
        if (rules) {
            var normalizeAgent = function(cf) { return cf ? cf.replace(/^agents\//, '') : ''; };
            var normalizedTarget = normalizeAgent(targetAgent);
            for (var ri = 0; ri < rules.length; ri++) {
                if (normalizeAgent(rules[ri].configFile) === normalizedTarget) {
                    matchedRule = rules[ri];
                    break;
                }
            }
        }

        var targetedRule;
        if (matchedRule) {
            targetedRule = {};
            Object.keys(matchedRule).forEach(function(k) { targetedRule[k] = matchedRule[k]; });
            targetedRule.jql = 'key = ' + targetTicket;
            targetedRule.description = 'Targeted: ' + targetAgent + ' for ' + targetTicket;
            delete targetedRule.skipIfLabel;
            delete targetedRule.skipIfLabels;
            console.log('  Found matching rule — inheriting localExecution=' + (!!targetedRule.localExecution) +
                ', concurrencyKey=' + (targetedRule.concurrencyKey || targetTicket));
        } else {
            console.log('  No matching rule found for ' + targetAgent + ' — using minimal synthetic rule');
            // Read localExecution from the agent config so agents with localExecution:true
            // run directly in the SM job (skipping the ai-teammate checkout pipeline).
            var agentLocalExecution = false;
            try {
                var agentRaw = file_read({ path: targetAgent });
                if (agentRaw) {
                    var agentJsonParsed = JSON.parse(agentRaw);
                    if (agentJsonParsed && agentJsonParsed.params && agentJsonParsed.params.localExecution === true) {
                        agentLocalExecution = true;
                    }
                }
            } catch (e) {
                console.warn('  Could not read agent config to detect localExecution:', e);
            }
            targetedRule = {
                description: 'Targeted: ' + targetAgent + ' for ' + targetTicket,
                jql: 'key = ' + targetTicket,
                configFile: targetAgent,
                enabled: true,
                localExecution: agentLocalExecution
            };
            if (agentLocalExecution) {
                console.log('  Agent config has localExecution:true — will run locally (no checkout pipeline)');
            }
        }

        rules = [targetedRule];
        workflowBudget = null; // no cap for explicit single-ticket runs
    }

    if (!rules || rules.length === 0) {
        console.error('❌ No rules defined in jobParams.rules or project config');
        return { success: false, error: 'No rules defined' };
    }

    // Global repo fallback: used by rules that don't specify their own configPath.
    // Accepts split owner/repo fields or a combined "owner/repo" string (the
    // SM_REPO=github.repository shape used by the sm.yml template).
    var owner = (projectConfig.repository.owner) || p.owner;
    var repo  = (projectConfig.repository.repo)  || p.repo;
    if ((!owner || !repo) && typeof repo === 'string' && repo.indexOf('/') !== -1) {
        var seg = repo.split('/');
        owner = owner || seg[0];
        repo = seg[1];
    }

    if (!owner || !repo) {
        console.error('❌ Repository owner and repo are required (set in .dmtools/config.js or jobParams)');
        return { success: false, error: 'Missing owner or repo' };
    }

    var globalRepoInfo = { owner: owner, repo: repo };
    console.log('SM Agent — ' + globalRepoInfo.owner + '/' + globalRepoInfo.repo + ' (' + rules.length + ' rules)');
    if (projectConfig.jira.project) {
        console.log('  Jira project: ' + projectConfig.jira.project);
    }
    if (workflowBudget) {
        console.log('  Workflow cap per run: ' + workflowBudget.initial);
    }

    // NOTE: JQL interpolation is now done per-rule inside processRule using each rule's
    // effective config. Rules with configPath get their own {jiraProject}/{parentTicket} resolved.

    var allProcessedKeys = [];
    var allSkippedKeys   = [];

    rules.forEach(function(rule, i) {
        var result = processRule(rule, globalRepoInfo, i, workflowBudget);
        allProcessedKeys = allProcessedKeys.concat(result.processedKeys);
        allSkippedKeys   = allSkippedKeys.concat(result.skippedKeys);
    });

    console.log('\n══ SM Agent complete — processed: ' + allProcessedKeys.length + ' ' +
        (allProcessedKeys.length ? '[' + allProcessedKeys.join(', ') + ']' : '') +
        ', skipped: ' + allSkippedKeys.length +
        (allSkippedKeys.length ? ' [' + allSkippedKeys.join(', ') + ']' : '') + ' ══');

    return {
        success: true,
        processed: allProcessedKeys.length,
        skipped: allSkippedKeys.length,
        processedKeys: allProcessedKeys,
        skippedKeys: allSkippedKeys
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, applyRuleOverridesForTest: applyRuleOverrides,
        probeDispatchedState: probeDispatchedState,
        failedRunLinksLine: failedRunLinksLine };
}
