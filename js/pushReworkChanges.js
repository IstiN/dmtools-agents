/**
 * Push Rework Changes Post-Action
 * postJSAction for pr_rework agent:
 * 1. Stages, commits, and pushes changes to the existing PR branch
 * 2. Posts replies to each open PR review thread and resolves the threads
 * 3. Posts the fix summary (outputs/response.md) as a top-level PR comment
 * 4. Moves ticket to "In Review"
 * 5. Posts completion comment to the ticket (Jira/ADO/GitHub via common/trackers.js)
 */

var configLoader = require('./configLoader.js');
var scmModule = require('./common/scm.js');
const commentMarkup = require('./common/commentMarkup.js');
var trackersModule = require('./common/trackers.js');
var submoduleHelper = require('./common/submodules.js');
var prHelper = require('./common/pullRequest.js');
var ghHelpers = require('./common/githubHelpers.js');
var feedbackLoop = require('./common/feedbackLoop.js');
var autoStart = require('./common/autoStart.js');
var outputFiles = require('./common/outputFiles.js');
var gitStaging = require('./common/gitStaging.js');
var labelListModule = require('./common/labelList.js');
var forkCheckout = require('./common/forkCheckout.js');
const { GIT_CONFIG, STATUSES, LABELS, resolveStatuses } = require('./config.js');
var cacheToReleases = require('./cacheToReleases.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var ticketKeyShapes = require('./common/ticketKeyShapes.js');
// gh-957: the no-op loop guard's lap markers — the post-action stamps one
// per leg close ({head, pushed, resolved}) so the SM arm actions can bound
// consecutive empty laps on one head.
var reworkLoopGuard = require('./common/reworkLoopGuard.js');
// gh-1119: owned CI-violation accounting — the setup-time snapshot
// (ci_violations.json) is validated against the fix summary before the
// rework cycle may close.
var ciViolations = require('./common/ciViolations.js');
var toolchainSummary = require('./common/toolchainSummary.js');

// ── gh-957: lap audit (loop guard) + audit-resolve support ──────────────────
//
// The rework no-op loop (live dart #424, 7 legs / 2h): every leg closed
// 'successful' with zero pushed commits and zero resolved threads, and the
// arm rule re-armed on the next tick every time. Two mechanisms close it:
//
//   Lap markers — every leg close (success, blocked, or audit-resolve) posts
//                 ONE machine-parseable marker {head, pushed, resolved, at}
//                 (js/common/reworkLoopGuard.js). The SM arm actions count
//                 consecutive no-op laps (pushed 0 AND resolved 0) on one
//                 head and withhold + escalate at the cap.
//   Audit-resolve — a leg that determines every open thread is already
//                 addressed/invalid MUST be able to resolve those threads
//                 with an explanatory reply per thread (the rework run URL
//                 rides the reply for the audit trail) — even with zero
//                 pushed commits. The agents#827 no-change guard only
//                 blocks when reply coverage is INCOMPLETE: a reply on every
//                 open thread is not a silent drop.

/**
 * Best-effort URL of the rework run driving this post-action
 * (https://github.com/<owner>/<repo>/actions/runs/<id>). Available on the
 * Actions runner; null on local teammate runs — callers degrade to a
 * run-URL-less audit line.
 */
function reworkRunUrl() {
    try {
        var server = java.lang.System.getenv('GITHUB_SERVER_URL');
        var repo = java.lang.System.getenv('GITHUB_REPOSITORY');
        var runId = java.lang.System.getenv('GITHUB_RUN_ID');
        if (server && repo && runId) {
            return String(server) + '/' + String(repo) + '/actions/runs/' + String(runId);
        }
    } catch (e) { /* local run — no run identity */ }
    return null;
}

/**
 * Reads the head this rework pass started from
 * (input/<ticketKey>/rework_base_head.txt, written by preCliReworkSetup) —
 * the head the lap marker anchors to. Returns null when unknown.
 */
function readReworkBaseHead(ticketKey) {
    try {
        var base = String(file_read({ path: inputFolderFor(ticketKey) + '/rework_base_head.txt' }) || '').trim();
        return /^[0-9a-f]{7,40}$/i.test(base) ? base : null;
    } catch (e) {
        return null;
    }
}

/**
 * Stamps the gh-957 lap marker on the PR. Fail-quiet by design: the audit
 * must never break the leg close.
 */
function postLapMarker(scm, prNumber, headSha, pushed, resolved) {
    var body = reworkLoopGuard.buildLapMarker(headSha, pushed, resolved, reworkRunUrl());
    if (!body) return;
    try {
        scm.addComment(prNumber, body);
        console.log('📓 rework lap marker posted on PR #' + prNumber + ': head ' +
            String(headSha).substring(0, 7) + ', pushed ' + (pushed ? 1 : 0) + ', resolved ' + resolved);
    } catch (e) {
        console.warn('Failed to post rework lap marker on PR #' + prNumber + ':', e.message || e);
    }
}

// The input folder dmtools created for this run. It is not always input/<ticketKey>: on a
// GitHub-tracker deployment the Java runtime names the folder after the router key (input/gh-5)
// while the ticket key is owner/repo#5, so reading input/<ticketKey>/pr_info.md found nothing and the
// finished rework was never pushed. The Dart runtime and older runtimes still create
// input/<ticketKey>. The folder is resolved through ticketKeyShapes.inputFolderCandidates — the
// folder the runtime passed (params.inputFolderPath; the Java runtime passes it to pre-CLI actions
// only), then the Java-derived name, then the legacy input/<ticketKey> — taking the first that holds
// the setup's context, else the first candidate. Paths stay relative to the job root like every
// other read here. Reset once per action() run.
var currentInputFolderName = null;
var resolvedInputFolder = null;

// Files preCliReworkSetup leaves in the run's folder: pr_info.md on success, rework_setup_failed.md
// when it found no PR.
var RUN_CONTEXT_FILES = ['pr_info.md', 'rework_setup_failed.md'];

function inputFolderNameOf(inputFolderPath) {
    var segments = String(inputFolderPath || '').replace(/[\\/]+$/, '').split(/[\\/]/);
    return segments[segments.length - 1] || null;
}

// The folder name the runtime passed, from whichever params layer carries it; null when none does.
function runInputFolderName(params, actualParams) {
    var jobParams = params.jobParams || {};
    return inputFolderNameOf(params.inputFolderPath || actualParams.inputFolderPath || jobParams.inputFolderPath);
}

function readsNonEmpty(path) {
    try {
        return String(file_read({ path: path }) || '').trim() !== '';
    } catch (e) {
        return false;
    }
}

function holdsRunContext(folder) {
    return RUN_CONTEXT_FILES.some(function(name) { return readsNonEmpty(folder + '/' + name); });
}

function inputFolderFor(ticketKey) {
    if (resolvedInputFolder && resolvedInputFolder.key === ticketKey) return resolvedInputFolder.folder;
    var explicit = currentInputFolderName ? 'input/' + currentInputFolderName : null;
    var candidates = ticketKeyShapes.inputFolderCandidates(explicit, ticketKey);
    var folder = candidates.filter(holdsRunContext)[0] || candidates[0];
    resolvedInputFolder = { key: ticketKey, folder: folder };
    return folder;
}

/**
 * Wraps feedbackLoop.resumeAgent() so an unexpected failure inside it (e.g. its own
 * mkdir/bash/run-agent.sh --continue self-invocation being blocked by a
 * misconfigured CLI_ALLOWED_COMMANDS whitelist) can never throw out of a call site.
 * Every caller treats { attempted: false } as "could not resume" and falls through to
 * posting an honest error comment / resetting the ticket — an uncaught throw here would
 * skip that fallback entirely and leave the ticket silently stuck.
 */
function tryResumeAgent(options) {
    try {
        return feedbackLoop.resumeAgent(options);
    } catch (resumeError) {
        console.error('tryResumeAgent: feedbackLoop.resumeAgent failed unexpectedly — treating as "not attempted" so the caller\'s reset/error-comment fallback still runs:', resumeError);
        return { attempted: false };
    }
}

/**
 * Returns true if the Jira ticket has the pr_approved label.
 */
function hasPrApprovedLabel(ticket) {
    var labels = (ticket && ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
    return labels.indexOf(LABELS.PR_APPROVED) !== -1;
}

/**
 * pr_approved stickiness beats rework completion (owner rule 2026-09-21):
 * once a review concluded APPROVED, NO later rework leg may clear
 * ai_pr_reviewed or arm a re-review — the reworked head just re-validates
 * and merges. The verdict lives on the PR (REST labels: [{name}] objects
 * or strings); the ticket-hydration path (hasPrApprovedLabel) is the
 * fallback when the PR body is unavailable.
 */
function prHasApproved(pr, ticket) {
    if (pr && Array.isArray(pr.labels)) {
        for (var i = 0; i < pr.labels.length; i++) {
            var l = pr.labels[i];
            var name = (l && typeof l === 'object') ? l.name : l;
            if (name === LABELS.PR_APPROVED) return true;
        }
    }
    return hasPrApprovedLabel(ticket);
}

function removeConfiguredLabels(tracker, ticketKey, customParams) {
    labelListModule.normalizeLabels(customParams && customParams.removeLabel, customParams && customParams.removeLabels)
        .forEach(function(label) {
            try {
                tracker.removeLabel(ticketKey, label);
                console.log('✅ Removed SM label:', label);
            } catch (e) {
                console.warn('Failed to remove SM label ' + label + ':', e);
            }
        });
}

function resolveCustomParams(params, actualParams, config) {
    var merged = {};
    var patch = configLoader.resolveInstructions(
        'pr_rework',
        null,
        config
    ).jobParamPatch;
    if (patch && patch.customParams) {
        Object.assign(merged, patch.customParams);
    }
    Object.assign(
        merged,
        (params.jobParams && params.jobParams.customParams) ||
            (actualParams && actualParams.customParams) ||
            params.customParams ||
            {}
    );
    return merged;
}

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

/**
 * gh-1195 CRAP split: the owner/repo parsed from a git remote URL — https or
 * ssh form, trailing .git stripped; null when the remote is not a github.com
 * URL. Pure.
 */
function parseGitHubRemoteUrl(remoteUrl) {
    const match = String(remoteUrl || '').match(/github\.com[:/]([^/]+)\/([^/?#\s]+)/);
    if (!match) {
        return null;
    }
    return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

function getGitHubRepoInfo() {
    try {
        return parseGitHubRemoteUrl(cleanCommandOutput(
            cli_execute_command({ command: 'git config --get remote.origin.url' }) || ''
        ));
    } catch (error) {
        console.error('Failed to get GitHub repo info:', error);
        return null;
    }
}

/**
 * Greppable failure marker for PR-lookup failures in the post-action. Appears
 * in the leg log, in the action result (job summary), and in the tracker error
 * comment — so an operator can find every empty-rework-lap incident by grep.
 */
var PR_LOOKUP_FAILED_PREFIX = 'PR-LOOKUP-FAILED:';

function findPRForTicket(scm, ticketKey) {
    // PR-anchored (githubSource #544): a pseudo-ticket key 'pr-N' IS the PR —
    // resolve it directly by number via the shared helper's deterministic
    // get-by-number path. Never list-scan a pseudo key: the PR's title/branch
    // reference the ORIGINAL work item (live fa #1212, 2026-10-04: key
    // 'pr-1212', branch 'ai/gh-1204' — the scan matched nothing and the
    // replies/resolutions were silently skipped). Jira-shaped keys keep the
    // unchanged substring scan below (byte-identical jiraSource behavior).
    if (/^pr-(\d+)$/.test(String(ticketKey || ''))) {
        return ghHelpers.findPRForTicket(scm, ticketKey);
    }
    try {
        const openPRs = scm.listPrs('open');

        const matching = openPRs.filter(function(pr) {
            return (pr.title && pr.title.indexOf(ticketKey) !== -1) ||
                   (pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1);
        });

        if (matching.length > 0) {
            return matching[0];
        }

        console.warn('No open PR found for ticket', ticketKey);
        return null;
    } catch (error) {
        console.error('Failed to find PR:', error);
        return null;
    }
}

function configureGitAuthor(config) {
    try {
        cli_execute_command({ command: 'git config user.name "' + config.git.authorName + '"' });
        cli_execute_command({ command: 'git config user.email "' + config.git.authorEmail + '"' });
        return true;
    } catch (error) {
        console.error('Failed to configure git author:', error);
        return false;
    }
}

/**
 * gh-711 (live fa queue 2026-10-04, fa #1212/#1217/#1221/#1222/#1223/#1225):
 * a rework commit message may carry a CI-skip directive (project-configured
 * `formats.commitMessage.rework` template — "correct" for CI-noise on
 * data-only branches). On a validation-bound PR branch that directive
 * suppresses CI entirely: the required check never registers on the new
 * head and the PR sits BLOCKED with green latches until a human dispatches
 * ci.yml manually. A rework push exists precisely to re-validate the PR,
 * so the directive is stripped here — GitHub honors skip directives
 * case-insensitively ([skip ci], [ci skip], [no ci], [skip actions],
 * [actions skip]), the whole bracket token is removed, and the cleaned-up
 * whitespace collapse keeps the message readable. Branches that genuinely
 * must not run CI (e.g. factory-data publishes) never pass through here.
 */
function stripCiSkipTokens(message) {
    if (!message) return message;
    return String(message)
        .replace(/\[(skip[\s-]?ci|ci[\s-]?skip|no[\s-]?ci|skip[\s-]?actions|actions[\s-]?skip)\]/gi, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

/**
 * agents#827: did this rework pass change any PRODUCTION file relative to the PR head the pass started
 * from? The setup records that head in input/<KEY>/rework_base_head.txt. A plain "head moved" check is
 * fooled by the timer's `WIP auto-save` commits (they move the branch even when they only carry
 * outputs/ housekeeping), so this compares file content, not commits — and still counts a WIP commit
 * that holds a real fix. Returns true/false, or null when it cannot be determined (old setup, git
 * error): callers fail open on null.
 */
function hasRealCodeChanges(ticketKey, config) {
    var base = null;
    try {
        base = String(file_read({ path: inputFolderFor(ticketKey) + '/rework_base_head.txt' }) || '').trim();
    } catch (e) { return null; }
    if (!/^[0-9a-f]{7,40}$/i.test(base)) return null;
    var workingDir = config && config.workingDir || null;
    var opts = workingDir ? { workingDirectory: workingDir } : {};
    try {
        var out = cleanCommandOutput(cli_execute_command(Object.assign({}, opts, {
            command: 'git diff --name-only ' + base + ' HEAD -- . ' +
                "':!outputs' ':!input' ':!.dmtools' ':!.dmtools-logs' ':!.dmtools-session-output.log'"
        })) || '');
        return out.trim().length > 0;
    } catch (e) {
        console.warn('hasRealCodeChanges probe failed (fail-open):', e.message || e);
        return null;
    }
}

// ── gh-1082: pure parse/build/decide helpers for commitAndPush() ─────────────
// Extracted from commitAndPush() without changing the tracker/SCM/git/file
// call order or any observable text. Each helper is directly unit-tested in
// js/unit-tests/test_pushReworkChanges.js (commitAndPush — branch decisions).

/**
 * The command-local cli_execute_command option bag for a workingDir.
 */
function reworkCmdOpts(workingDir) {
    return workingDir ? { workingDirectory: workingDir } : {};
}

/**
 * Reads input/<ticketKey>/pr_info.md (written by preCliReworkSetup) and
 * parses the expected PR **Branch** head from it. Throws the refusing
 * "Missing PR context file" error when the file cannot be read.
 * Returns { prInfo, headBranch } — headBranch null when the header is absent.
 */
function readReworkPrInfoHeadBranch(ticketKey) {
    try {
        var prInfoPath = inputFolderFor(ticketKey) + '/pr_info.md';
        var prInfo = file_read({ path: prInfoPath }) || '';
        var branchMatch = prInfo.match(/\*\*Branch\*\*:\s*`([^`]+)`/);
        return { prInfo: prInfo, headBranch: branchMatch ? branchMatch[1].trim() : null };
    } catch (e) {
        throw new Error('Missing PR context file ' + inputFolderFor(ticketKey) + '/pr_info.md. Rework setup did not find or checkout a PR; refusing to commit or push.');
    }
}

/**
 * The PR's base branch parsed from the pr_info.md **Branch** head line
 * ("**Branch**: `head` → `base`") — null when absent/unparsable.
 */
function parseReworkBaseBranch(prInfo) {
    try {
        var baseMatch = prInfo.match(/\*\*Branch\*\*:\s*`[^`]+`\s*→\s*`([^`]+)`/);
        return (baseMatch && baseMatch[1]) ? baseMatch[1].trim() : null;
    } catch (e) { return null; }
}

/**
 * The base branch a rework push must never touch: the pr_info.md base line
 * first, then config.git.baseBranch, then main.
 */
function resolveReworkBaseBranch(config, prInfo) {
    return parseReworkBaseBranch(prInfo) || (config.git && config.git.baseBranch) || 'main';
}

/**
 * True when the checked-out branch differs from the expected PR branch and
 * a forced checkout is required.
 */
function reworkBranchMismatch(expectedBranch, currentBranch) {
    return !!expectedBranch && currentBranch !== expectedBranch;
}

/**
 * Forces the expected PR branch when the CLI agent switched branches.
 * Returns the branch name the subsequent commit/push must run on: the
 * expected branch after a successful checkout, else the current branch.
 */
function checkoutExpectedBranch(cmd, expectedBranch, currentBranch) {
    if (!reworkBranchMismatch(expectedBranch, currentBranch)) return currentBranch;
    console.warn('⚠️ Branch mismatch — forcing checkout to expected branch:', expectedBranch);
    try {
        cmd('git checkout ' + expectedBranch);
        console.log('✅ Switched to expected branch:', expectedBranch);
        return expectedBranch;
    } catch (e) {
        console.warn('Could not checkout expected branch, using current:', currentBranch, e);
        return currentBranch;
    }
}

/**
 * The hard base-branch invariant: true when the branch about to be
 * committed/pushed IS the base branch (the forced checkout above failed).
 */
function isBaseBranchViolation(branchName, baseBranch) {
    return !!branchName && branchName === baseBranch;
}

/**
 * The refusal error for the base-branch invariant.
 */
function baseBranchRefusalMessage(branchName, baseBranch, expectedBranch) {
    return 'Refusing to commit/push: current branch "' + branchName +
        '" is the base branch (' + baseBranch + '), not the expected PR branch "' + expectedBranch + '".';
}

/**
 * gh-628 runtime-artifact untrack cleanup — best-effort: a failure is
 * warned about and never blocks staging.
 */
function untrackRuntimeArtifactsQuietly(cmd) {
    try {
        // gh-628: untrack machine-local runtime logs carried by
        // already-poisoned branches (a broad add swept the credential
        // helper's serving trace onto ai/gh-628); the staging pathspec
        // below keeps them out going forward. Shared canonical list:
        // js/common/gitStaging.js.
        gitStaging.untrackRuntimeArtifacts(cmd);
    } catch (cleanupErr) {
        console.warn('Could not remove tracked Copilot session cache before staging:', cleanupErr);
    }
}

/**
 * True when the staged diff stat is non-empty (something to commit).
 */
function hasStagedChanges(status) {
    return !!status.trim();
}

/**
 * The rework commit message: the configured format template with
 * {ticketKey}, with any CI-skip directive stripped (gh-711).
 */
function buildReworkCommitMessage(config, ticketKey) {
    return stripCiSkipTokens(configLoader.formatTemplate(config.formats.commitMessage.rework, {ticketKey: ticketKey}));
}

/**
 * Commits the staged changes when the diff stat is non-empty; warns and
 * leaves the history alone otherwise. Returns whether a commit was made.
 */
function commitStagedReworkChanges(cmd, status, config, ticketKey) {
    if (!hasStagedChanges(status)) {
        console.warn('No file changes detected — pushing existing commits only');
        return false;
    }
    cmd('git commit -m "' + buildReworkCommitMessage(config, ticketKey) + '"');
    console.log('✅ Committed rework changes');
    return true;
}

/**
 * agents#895 opt-in switch: fold WIP auto-save commits only when
 * customParams.squashReworkWip is exactly true.
 */
function squashEnabled(customParams) {
    return !!(customParams && customParams.squashReworkWip === true);
}

/**
 * The push ladder for the rework head: a normal push first; when it fails,
 * synchronize with origin/<branch> (fetch + merge) and retry once. A failed
 * retry throws — never a force-push over remote updates.
 */
function pushReworkBranch(cmd, branchName, pushPlan) {
    try {
        cmd(pushPlan.push);
    } catch (pushError) {
        console.warn('Normal push failed; synchronizing with origin/' + branchName + ' before retry:', pushError.message || pushError);
        try {
            cmd(pushPlan.fetch);
            cmd(pushPlan.merge);
            cmd(pushPlan.retry);
        } catch (syncPushError) {
            throw new Error(
                'Could not push rework branch after synchronizing with origin/' + branchName +
                '. Refusing to force-push over remote updates. Error: ' +
                (syncPushError.message || syncPushError)
            );
        }
    }
}

/**
 * The sync gate: a rework push never proceeds on a branch that failed to
 * synchronize with origin/<baseBranch>.
 */
function assertReworkBranchSynced(syncResult, baseBranch) {
    if (!syncResult.success) {
        throw new Error('Could not sync PR branch with origin/' + baseBranch + ' before rework push: ' + syncResult.error);
    }
}

/**
 * The agents#895 WIP-squash step, gated by the opt-in switch: folds the
 * timer's WIP auto-save commits only when customParams.squashReworkWip is
 * exactly true; otherwise history is untouched (false).
 */
function squashReworkWipIfEnabled(cmd, ticketKey, config, workingDir, customParams) {
    if (!squashEnabled(customParams)) return false;
    return squashReworkWipCommits(cmd, ticketKey, config, workingDir);
}

function commitAndPush(ticketKey, config, customParams) {
    var workingDir = config.workingDir || null;
    var cmdOpts = reworkCmdOpts(workingDir);
    var cmd = function(command) { return cli_execute_command(Object.assign({}, cmdOpts, { command: command })); };

    // Read expected branch from pr_info.md (written by preCliReworkSetup).
    // Do NOT trust git branch --show-current — the CLI agent may have switched branches.
    var prInfoCtx = readReworkPrInfoHeadBranch(ticketKey);
    var prInfo = prInfoCtx.prInfo;
    var expectedBranch = prInfoCtx.headBranch;
    if (!expectedBranch) {
        throw new Error('Could not determine expected PR branch from ' + inputFolderFor(ticketKey) + '/pr_info.md; refusing to commit or push.');
    }
    var baseBranch = resolveReworkBaseBranch(config, prInfo);

    var currentBranch = cleanCommandOutput(cmd('git branch --show-current') || '');
    console.log('Current branch:', currentBranch, '| Expected:', expectedBranch);

    var branchName = checkoutExpectedBranch(cmd, expectedBranch, currentBranch);

    // Hard invariant: never commit/push while sitting on the base branch —
    // if the forced checkout above didn't work and we're still parked on
    // baseBranch, refuse rather than pushing WIP straight into the mainline.
    if (isBaseBranchViolation(branchName, baseBranch)) {
        throw new Error(baseBranchRefusalMessage(branchName, baseBranch, expectedBranch));
    }

    submoduleHelper.pushManagedSubmodules({
        run: cmd,
        cleanOutput: cleanCommandOutput,
        config: config,
        customParams: customParams,
        ticketKey: ticketKey
    });

    untrackRuntimeArtifactsQuietly(cmd);

    // `:!factory-kit` — nested machine-infra gitlink must not kill rework staging (#648 class)
    // `:!.dmtools/...` runtime logs (gh-628) — excluded by pathspec because
    // they live next to COMMITTED .dmtools/ files.
    // gh-683 (live fa run 37153405587): the check-ignore probe (via cmd)
    // drops exclusions for paths git already ignores — naming an existing
    // ignored-untracked path in an exclusion pathspec trips git add's
    // ignored-files guard and kills the leg.
    // gh-1164: `factory-kit` is probe-filtered like the runtime artifacts —
    // a static `:!factory-kit` exclusion trips git add's ignored-pathspec
    // guard when the kit is materialized AND gitignored.
    cmd('git add . -- ' + gitStaging.buildStagingPathspecs(function (args) {
        return cmd(args.command);
    }, ['factory-kit']));

    const status = prHelper.readStagedDiffStat(cmd, workingDir);
    var hasChanges = commitStagedReworkChanges(cmd, status, config, ticketKey);

    // agents#895: the timer already committed (and pushed) the work as "WIP auto-save" commits, so the
    // clean rework commit above is often never created. Opt-in (customParams.squashReworkWip): when EVERY
    // commit since the rework base is a WIP auto-save (or the commit just made) and none is a merge, fold
    // them into one commit with the rework message and push it with --force-with-lease.
    var squashed = squashReworkWipIfEnabled(cmd, ticketKey, config, workingDir, customParams);

    var syncResult = prHelper.syncBranchWithBase({
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        runCommand: function(command, dir) {
            var args = { command: command };
            if (dir) args.workingDirectory = dir;
            return cli_execute_command(args);
        }
    });
    assertReworkBranchSynced(syncResult, baseBranch);

    // gh-1096: a fork PR head is pushed back to the FORK's token URL
    // (gh-1070 maintainer-edit contract); same-repo commands unchanged.
    var pushPlan = forkCheckout.reworkPushPlan(forkCheckout.readForkHead(prInfo), branchName, squashed);
    pushReworkBranch(cmd, branchName, pushPlan);

    verifyReworkPushed(cmd, branchName, pushPlan.fork);

    console.log('✅ Pushed to remote branch:', branchName);
    return { branch: branchName, hasChanges: hasChanges };
}

// gh-912: verify the push produced a real refs/heads/<branch> ref line on
// origin — stderr noise never counts as the branch existing. gh-1096: a fork
// head lives on the fork, not origin; the push itself is the proof there.
function verifyReworkPushed(cmd, branchName, isFork) {
    if (isFork) return;
    var remoteBranchExists = false;
    try {
        remoteBranchExists = prHelper.remoteBranchExists(cmd, null, branchName);
    } catch (lsRemoteErr) {
        console.warn('Error checking remote branches:', lsRemoteErr);
    }
    if (!remoteBranchExists) {
        throw new Error('Branch was not successfully pushed to remote');
    }
}

/**
 * agents#895: squash the timer's WIP auto-save commits into one commit with the rework message.
 * Returns true only when it rewrote history. Fails closed (returns false, history untouched) when the
 * rework base is unknown, HEAD has no commits since it, any commit is not a WIP auto-save / the rework
 * commit, or any commit is a merge.
 */
function squashReworkWipCommits(cmd, ticketKey, config, workingDir) {
    try {
        var base = String(file_read({ path: inputFolderFor(ticketKey) + '/rework_base_head.txt' }) || '').trim();
        if (!/^[0-9a-f]{7,40}$/i.test(base)) return false;
        var range = base + '..HEAD';
        var merges = cleanCommandOutput(cmd('git rev-list --merges ' + range) || '').trim();
        if (merges) return false;
        var subjects = cleanCommandOutput(cmd('git log --format=%s ' + range) || '').split('\n')
            .map(function (l) { return l.trim(); }).filter(Boolean);
        if (subjects.length < 2) return false;
        var reworkMsg = stripCiSkipTokens(configLoader.formatTemplate(config.formats.commitMessage.rework, { ticketKey: ticketKey }));
        var allOurs = subjects.every(function (sub) { return /WIP auto-save/.test(sub) || sub === reworkMsg; });
        if (!allOurs) return false;
        cmd('git reset --soft ' + base);
        cmd('git commit -m "' + reworkMsg + '"');
        console.log('✅ Squashed ' + subjects.length + ' WIP/rework commits into one: ' + reworkMsg);
        return true;
    } catch (e) {
        console.warn('squashReworkWipCommits skipped (history untouched):', e.message || e);
        return false;
    }
}

/**
 * Extracts review-thread ids (GitHub GraphQL node ids, PRRT_...) cited anywhere
 * in a text — typically the rework response/fix summary. A rework that cites a
 * thread id is claiming that thread's findings as addressed, so those threads
 * MUST be resolved (gh-692); this is the citeable fallback when the AI-written
 * review_replies.json is missing or lacks threadIds.
 */
function extractCitedThreadIds(text) {
    var ids = [];
    var seen = {};
    String(text || '').replace(/PRRT_[A-Za-z0-9_]+/g, function(m) {
        if (!seen[m]) { seen[m] = true; ids.push(m); }
        return m;
    });
    return ids;
}

/**
 * The candidate paths of the setup-time thread snapshot, in read order: the
 * job-root input folder first, then the workingDir-relative copy when the
 * run has a workingDir.
 */
function rawThreadSnapshotCandidates(ticketKey, outputOptions) {
    var candidates = [inputFolderFor(ticketKey) + '/pr_discussions_raw.json'];
    if (outputOptions && outputOptions.workingDir) {
        candidates.push(outputOptions.workingDir + '/' + inputFolderFor(ticketKey) + '/pr_discussions_raw.json');
    }
    return candidates;
}

/**
 * The thread list of a parsed snapshot payload: a {"threads": [...]} export,
 * a top-level array export, or [].
 */
function threadsOfParsedSnapshot(parsed) {
    return (parsed && parsed.threads) ? parsed.threads : (Array.isArray(parsed) ? parsed : []);
}

/**
 * The thread list of one snapshot candidate, or null when the file is
 * missing/blank/unparsable or carries no threads — any of which means "try
 * the next candidate".
 */
function readRawThreadsSnapshot(path) {
    try {
        var raw = file_read({ path: path });
        if (!raw || !String(raw).trim()) return null;
        var threads = threadsOfParsedSnapshot(JSON.parse(raw));
        return (threads && threads.length > 0) ? threads : null;
    } catch (e) { return null; }
}

/**
 * Reads the setup-time thread snapshot input/<ticketKey>/pr_discussions_raw.json
 * (written by preCliReworkSetup via gitOps.writePRContext). Each thread carries
 * BOTH ids needed post-rework: rootCommentId (inline reply target) and threadId
 * (resolve target). Returns [] when missing or unparsable.
 */
function readInputRawThreads(ticketKey, outputOptions) {
    if (!ticketKey) return [];
    var candidates = rawThreadSnapshotCandidates(ticketKey, outputOptions);
    for (var i = 0; i < candidates.length; i++) {
        var threads = readRawThreadsSnapshot(candidates[i]);
        if (threads) return threads;
    }
    return [];
}

/**
 * Indexes a thread list by both id kinds (stringified keys — the AI output and
 * the snapshot may disagree on number vs string).
 */
function buildThreadLookup(threads) {
    var byRoot = {};
    var byThread = {};
    (threads || []).forEach(function(t) {
        if (!t) return;
        if (t.rootCommentId !== null && t.rootCommentId !== undefined) {
            byRoot[String(t.rootCommentId)] = t;
        }
        if (t.threadId) byThread[String(t.threadId)] = t;
    });
    return { byRoot: byRoot, byThread: byThread };
}

// ── gh-799: complete rework picture + honest live-rechecked completion ───────
// Live incident (fa PR #1420, run 37806292238, 2026-10-08): the completion
// comment was written from the STALE input snapshot ("...no code changes are
// required") while the PR's review state required changes, and a reply carried
// "threadId": null. These helpers close two of the three contract gaps:
// reply-targeting coverage (LOUD, never silent) and completion honesty (the
// completion comment is generated from a LIVE unresolved-threads re-fetch,
// with per-thread accounting for drift and unaddressed threads).

/**
 * A thread the rework agent is accountable for: still unresolved and not
 * bot-authored informational noise (bot flag present only on some providers —
 * absent means human, per the SCM abstraction).
 */
function isOpenThread(t) {
    return !!t && t.resolved !== true && t.bot !== true;
}

/**
 * Stable key for cross-source thread matching: prefer the GraphQL thread id,
 * fall back to the root comment db id (prefixed so the two id spaces can
 * never collide in a shared key set). Returns null for an unnamed thread.
 */
function threadKeyOf(t) {
    if (!t) return null;
    if (t.threadId) return String(t.threadId);
    if (t.rootCommentId !== null && t.rootCommentId !== undefined) return 'c' + t.rootCommentId;
    return null;
}

function threadKeySet(threads) {
    var keys = {};
    (threads || []).forEach(function(t) {
        var k = threadKeyOf(t);
        if (k) keys[k] = true;
    });
    return keys;
}

/**
 * gh-1061 AC3: an open thread that can NEVER receive a targeted reply —
 * threadKeyOf() is null (no threadId AND no rootCommentId). These are the
 * machine-notice shapes (red-head markers, rework-consume payloads, prior
 * blocked comments): review_replies.json addresses threads by id, so a null-id
 * thread sits in the gh-957 coverage-gate denominator forever and the gate can
 * never pass (live: dmtools-dart PR #420 / gh-395 blocked-looping for a week).
 * Excluded from the gate denominator; reported as informational context only.
 */
function isUnaddressableThread(t) {
    return !!t && threadKeyOf(t) === null;
}

/**
 * The thread-id part of a label: threadId, else 'comment#<rootCommentId>',
 * else 'no-id'. Shared by threadLabel (full label), shortThreadId (capped)
 * and the open-thread accounting block — one id rendering instead of three
 * inline copies (gh-1220 CRAP split).
 */
function threadIdLabel(t) {
    return t.threadId ||
        (t.rootCommentId !== null && t.rootCommentId !== undefined ? 'comment#' + t.rootCommentId : 'no-id');
}

/**
 * The file:line location of a thread, or null when it has no path.
 */
function threadLocation(t) {
    return t.path ? (t.path + (t.line ? ':' + t.line : '')) : null;
}

/**
 * The first body line of a thread (the reviewer's title), hard-capped at
 * 120 chars (117 + trailing '...').
 */
function threadBodyExcerpt(t) {
    var body = String(t.body || '').split('\n')[0].trim();
    return body.length > 120 ? body.substring(0, 117) + '...' : body;
}

/**
 * Human-readable thread identification for logs and completion comments:
 * id, file:line location, and the first body line (the reviewer's title).
 */
function threadLabel(t) {
    if (!t) return '(unknown thread)';
    var loc = threadLocation(t);
    var body = threadBodyExcerpt(t);
    return threadIdLabel(t) +
        (loc ? ' (' + loc + ')' : '') +
        (body ? ' — "' + body + '"' : '');
}

/**
 * gh-1061 AC2: the thread-id part of the compact label — threadId, else
 * 'comment#<rootCommentId>', else 'no-id', hard-capped at 16 chars.
 */
function shortThreadId(t) {
    var id = String(threadIdLabel(t));
    return id.length > 16 ? id.substring(0, 13) + '...' : id;
}

/** gh-1061 AC2: hard-cap a string at cap chars, trailing '...' included. */
function capLen(s, cap) {
    return s.length > cap ? s.substring(0, cap - 3) + '...' : s;
}

/**
 * gh-1061 AC2: compact one-line thread label for the blocked-comment fold —
 * id plus a short body snippet, hard-capped at maxLen so a 39-thread
 * enumeration stays inside the ~2000-char comment budget (threadLabel's
 * 120-char body cap would blow the budget on its own).
 */
function threadShortLabel(t, maxLen) {
    if (!t) return '(unknown thread)';
    var body = String(t.body || '').split('\n')[0].trim();
    return capLen(shortThreadId(t) + (body ? ' — "' + body + '"' : ''), maxLen || 40);
}

/**
 * Reads + parses outputs/review_replies.json. Returns { missing, replies } —
 * missing=true only when the file itself is absent/blank, so callers can
 * distinguish "no reply file" from "a reply file with zero rows".
 */
function readRepliesArray(outputOptions) {
    var raw = outputFiles.readOutputFile('review_replies.json', outputOptions || {});
    if (!raw) return { missing: true, replies: [] };
    try {
        var data = JSON.parse(raw);
        return { missing: false, replies: (data && data.replies) ? data.replies : [] };
    } catch (e) {
        console.warn('Failed to parse review_replies.json:', e.message || e);
        return { missing: false, replies: [] };
    }
}

/**
 * True when reply and thread name the SAME GraphQL thread id (stringified —
 * the AI output and the snapshot may disagree on number vs string).
 */
function replyMatchesThreadId(reply, thread) {
    return !!(reply && thread && thread.threadId && reply.threadId &&
        String(thread.threadId) === String(reply.threadId));
}

/**
 * True when the reply claims the thread's root comment — by rootCommentId or
 * inReplyToId (either id proves the thread was addressed). rootId arrives
 * already stringified (post-enrichment parity), falsy never reaches here.
 */
function replyMatchesRootId(reply, rootId) {
    if (reply.rootCommentId !== null && reply.rootCommentId !== undefined &&
        String(reply.rootCommentId) === rootId) return true;
    if (reply.inReplyToId !== null && reply.inReplyToId !== undefined &&
        String(reply.inReplyToId) === rootId) return true;
    return false;
}

/**
 * gh-799 AC2: reply-targeting coverage. N open threads in the input snapshot
 * vs how many of them a reply row actually targets — matched by threadId OR
 * rootCommentId/inReplyToId in either direction (post-enrichment parity: 
 * postThreadReplies fills one id from the other, so either id proves the
 * thread was addressed; the input snapshot and the AI output may carry
 * different id kinds for the same thread). A null-threadId reply with no
 * comment id (the live incident shape) targets nothing.
 */
function replyTargetsThread(reply, thread) {
    if (!reply || !thread) return false;
    if (replyMatchesThreadId(reply, thread)) return true;
    var rootId = (thread.rootCommentId !== null && thread.rootCommentId !== undefined)
        ? String(thread.rootCommentId) : null;
    if (!rootId) return false;
    return replyMatchesRootId(reply, rootId);
}

function buildReplyCoverage(inputThreads, replies) {
    var open = (inputThreads || []).filter(isOpenThread);
    // gh-1061 AC3: null-id machine notices can never receive a targeted reply
    // — keep them OUT of the coverage-gate denominator (they are reported as
    // informational context instead). A PR whose only open threads are
    // null-id notices must not blocked-loop on coverage grounds forever.
    // Review follow-up: ONE partition pass builds both buckets — a single
    // classification, so the two sets can never drift apart.
    var unaddressable = [];
    var addressable = [];
    open.forEach(function(t) {
        (isUnaddressableThread(t) ? unaddressable : addressable).push(t);
    });
    var unaddressed = addressable.filter(function(t) {
        var targeted = false;
        (replies || []).forEach(function(r) {
            if (replyTargetsThread(r, t)) targeted = true;
        });
        return !targeted;
    });
    return {
        openCount: addressable.length,
        targetedCount: addressable.length - unaddressed.length,
        unaddressed: unaddressed,
        unaddressable: unaddressable,
        totalOpenCount: open.length
    };
}

/**
 * Greppable loud marker for the reply-coverage gap (gh-799 AC2). Appears in
 * the leg log AND (via buildReworkCompletionComment) in the completion comment
 * — an untargeted reply must never be silently folded into a "nothing
 * required" story.
 */
var REPLY_COVERAGE_GAP_PREFIX = 'REPLY-COVERAGE-GAP:';

function logReplyCoverageGap(coverage) {
    var unaddressed = (coverage && coverage.unaddressed) || [];
    if (unaddressed.length === 0) return [];
    var openCount = coverage.openCount || 0;
    var lines = [REPLY_COVERAGE_GAP_PREFIX + ' only ' + (openCount - unaddressed.length) + '/' + openCount +
        ' open review thread(s) have a targeted reply in outputs/review_replies.json'];
    unaddressed.forEach(function(t) {
        lines.push(REPLY_COVERAGE_GAP_PREFIX + ' thread NOT addressed by any reply: ' + threadLabel(t));
    });
    lines.forEach(function(line) { console.warn('⚠️ ' + line); });
    return lines;
}

/**
 * gh-799 AC3/AC5: LIVE unresolved-thread re-check — same call the input prep
 * makes (scm.fetchDiscussions), executed at completion time. The completion
 * comment must describe the PR as it is NOW, so threads that appeared mid-run
 * are caught (the live incident: threads arrived 19 minutes after the leg
 * started) instead of being masked by the stale snapshot.
 *
 * Fail-safe toward honesty: when the probe is unavailable or fails, fall back
 * to the input snapshot (last known state) — never silently to zero.
 */
function fetchLiveOpenThreads(scm, pr, inputThreads) {
    var fallback = (inputThreads || []).filter(isOpenThread);
    if (!scm || typeof scm.fetchDiscussions !== 'function' || !pr || !pr.number) {
        console.warn('⚠️ Live unresolved-thread re-check unavailable — falling back to the rework input snapshot (' +
            fallback.length + ' open thread(s))');
        return fallback;
    }
    try {
        var data = scm.fetchDiscussions(String(pr.number));
        var threads = (data && data.rawThreads && data.rawThreads.threads) || [];
        var open = threads.filter(isOpenThread);
        console.log('Live unresolved-thread re-check: ' + open.length + ' open thread(s) on PR #' + pr.number + ' at completion time');
        return open;
    } catch (e) {
        console.warn('⚠️ Live unresolved-thread re-check failed (falling back to the input snapshot, ' +
            fallback.length + ' open thread(s)):', e.message || e);
        return fallback;
    }
}

/**
 * gh-799: the latest CONCLUDED review verdict (CHANGES_REQUESTED / APPROVED),
 * or null when there is none / the probe is unavailable. Fail-open to null
 * (same convention as headMovedSinceLastReview) — a broken verdict probe must
 * not stall the completion, and the live-thread re-check is the primary gate.
 */
function latestConcludedVerdict(scm, pr) {
    var concluded = concludedReviewsSorted(scm, pr);
    return concluded.length > 0 ? concluded[concluded.length - 1].state : null;
}

/**
 * A CONCLUDED review verdict — the only states the rework gates act on
 * (COMMENTED and unknown states are never blocking evidence).
 */
function isConcludedReview(r) {
    return !!r && (r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED');
}

/** The submission timestamp key of the oldest-first verdict order. */
function reviewSubmittedAt(r) {
    return String(r.submitted_at || '');
}

/** Oldest-first comparator over concluded reviews (equal timestamps never drop an entry). */
function compareConcludedReviewsBySubmittedAt(a, b) {
    return reviewSubmittedAt(a) < reviewSubmittedAt(b) ? -1 : 1;
}

/** The concluded reviews of a review list, oldest first. */
function concludedReviewsOf(reviews) {
    return (reviews || []).filter(isConcludedReview).sort(compareConcludedReviewsBySubmittedAt);
}

/**
 * Concluded (CHANGES_REQUESTED / APPROVED) reviews of a PR, oldest first.
 * Shared by the token-burn guard and the completion verdict gate. Returns []
 * when the provider exposes no reviews or the probe fails — callers apply
 * their own fail-open semantics.
 */
function concludedReviewsSorted(scm, pr) {
    try {
        if (!scm || typeof scm.listReviews !== 'function' || !pr || !pr.number) return [];
        return concludedReviewsOf(scm.listReviews(pr.number));
    } catch (e) {
        console.warn('Review-verdict probe failed (fail-open):', e.message || e);
        return [];
    }
}

/**
 * gh-799 wording selection over {input threads × live threads × verdict ×
 * reply coverage}. Priority order is honesty-first:
 *   open-threads            — live unresolved threads exist → list them (AC3/AC5)
 *   unaddressed-replies     — threads closed but some input threads never got
 *                             a targeted reply (AC2)
 *   changes-requested-verdict — nothing open, but the reviewer still requires
 *                             changes (never "no code changes required")
 *   clean                   — nothing open, everything covered, no blocking
 *                             verdict → the historical wording (AC4)
 */
function selectReworkCompletionWording(liveOpenCount, unaddressedCount, verdict) {
    if (liveOpenCount > 0) return 'open-threads';
    if (unaddressedCount > 0) return 'unaddressed-replies';
    if (verdict === 'CHANGES_REQUESTED') return 'changes-requested-verdict';
    return 'clean';
}

/**
 * Membership probe by either id kind (threadId or the 'c'-prefixed root
 * comment id) — the live fetch and the input snapshot may disagree on which
 * ids they carry.
 */
function threadKeySetContains(keySet, t) {
    if (!t) return false;
    if (t.threadId && keySet[String(t.threadId)]) return true;
    if (t.rootCommentId !== null && t.rootCommentId !== undefined && keySet['c' + t.rootCommentId]) return true;
    return false;
}

/**
 * WHY a live open thread is still open: it appeared mid-run (not in the
 * rework input snapshot — drift, AC5), was never targeted by a reply (AC2),
 * or was replied to but is still open.
 */
function openThreadAccountingReason(t, inputKeys, unaddressedKeys, repliesFileRef) {
    var key = threadKeyOf(t);
    if (!key || !threadKeySetContains(inputKeys, t)) {
        return '🆕 appeared mid-run (not present in the rework input snapshot)';
    }
    if (threadKeySetContains(unaddressedKeys, t)) {
        return 'not addressed by any reply in ' + repliesFileRef;
    }
    return 'reply posted, thread still open';
}

/**
 * One accounting bullet: the labeled thread (id, location, title) with its
 * still-open reason.
 */
function openThreadAccountingLine(m, t, inputKeys, unaddressedKeys) {
    var loc = threadLocation(t);
    var body = threadBodyExcerpt(t);
    var reason = openThreadAccountingReason(t, inputKeys, unaddressedKeys, m.inline('outputs/review_replies.json'));
    return '* ' + m.inline(threadIdLabel(t)) +
        (loc ? ' — ' + m.inline(loc) : '') +
        (body ? ' — "' + body + '"' : '') +
        ' — ' + reason;
}

/**
 * Per-thread accounting block for the open-threads completion comment: every
 * live open thread listed with WHY it is still open — appeared mid-run (drift,
 * AC5), never targeted by a reply (AC2), or replied to but still open.
 * Membership is checked by either id kind (threadId or rootCommentId) because
 * the live fetch and the input snapshot may disagree on which ids they carry.
 */
function buildOpenThreadAccountingBlock(m, liveOpen, inputThreads, unaddressed) {
    var inputKeys = threadKeySet(inputThreads);
    var unaddressedKeys = threadKeySet(unaddressed);
    var lines = liveOpen.map(function(t) {
        return openThreadAccountingLine(m, t, inputKeys, unaddressedKeys);
    });
    return lines.join('\n') + '\n';
}

// ── gh-1195 CRAP split: one builder per completion wording ───────────────────
// Each historical branch of buildReworkCompletionComment, verbatim, in its
// own named function; the dispatcher only selects the wording. Byte-identical
// output — pinned by the gh-799 completion suites in
// js/unit-tests/test_pushReworkChanges.js.

/** The open-threads wording: per-thread accounting for every live open thread. */
function openThreadsCompletionComment(m, ctx, liveOpen, unaddressed) {
    var comment = m.h(3, '⚠️ Rework Completed — ' + liveOpen.length + ' review thread(s) remain open') + '\n';
    if (ctx.prUrl) comment += m.bold('Pull Request') + ': ' + ctx.prUrl + '\n';
    if (ctx.branchName) comment += m.bold('Branch') + ': ' + m.inline(ctx.branchName) + '\n';
    comment += '\n' + m.bold('Rework pushed; ' + liveOpen.length +
        ' review thread(s) remain open — the SM will re-arm a threads-rework.') + '\n';
    comment += buildOpenThreadAccountingBlock(m, liveOpen, ctx.inputThreads || [], unaddressed);
    return comment;
}

/** The unaddressed-replies wording: every input thread no reply targeted. */
function unaddressedRepliesCompletionComment(m, ctx, unaddressed) {
    var comment = m.h(3, '⚠️ Rework Completed — some review threads had no targeted reply') + '\n';
    if (ctx.prUrl) comment += m.bold('Pull Request') + ': ' + ctx.prUrl + '\n';
    comment += '\nAll review threads are now resolved, but ' + unaddressed.length +
        ' open thread(s) from the rework input had no targeted reply in ' +
        m.inline('outputs/review_replies.json') + ':\n';
    comment += unaddressed.map(function(t) { return '* ' + threadLabel(t); }).join('\n') + '\n';
    return comment;
}

/** The changes-requested-verdict wording: the verdict still blocks the merge. */
function changesRequestedCompletionComment(m, ctx) {
    var comment = m.h(3, ctx.codeChangesCommitted ? '✅ Rework Completed' : '✅ Rework Analysis Completed') + '\n';
    if (ctx.prUrl) comment += m.bold('Pull Request') + ': ' + ctx.prUrl + '\n';
    if (ctx.codeChangesCommitted) {
        comment += m.bold('Branch') + ': ' + m.inline(ctx.branchName) + '\n';
        comment += '\nRework changes were pushed.\n';
    } else {
        comment += '\nThe rework analysis completed without code changes.\n';
    }
    comment += '\n' + m.bold('The latest review verdict is still CHANGES_REQUESTED') +
        ' — the SM will re-check before this PR can merge.\n';
    return comment;
}

/** The clean wording — the historical text, byte-identical (AC4). */
function cleanCompletionComment(m, ctx) {
    var comment;
    if (ctx.codeChangesCommitted) {
        comment = m.h(3, '✅ Rework Completed') + '\n\n';
        comment += m.bold('Branch') + ': ' + m.inline(ctx.branchName) + '\n';
        if (ctx.prUrl) {
            comment += m.bold('Pull Request') + ': ' + ctx.prUrl + '\n';
        }
        comment += '\nAI Teammate has addressed all PR review comments and pushed the fixes.\n';
    } else {
        comment = m.h(3, '✅ Rework Analysis Completed') + '\n\n';
        if (ctx.prUrl) {
            comment += m.bold('Pull Request') + ': ' + ctx.prUrl + '\n';
        }
        comment += '\nAI Teammate analyzed all PR review comments and determined no code changes are required.\n';
    }
    return comment;
}

/**
 * The "fix summary posted" trailer: the clean wording flows straight on after
 * its closing sentence; every other wording leads the trailer with a newline.
 */
function completionPrCommentSuffix(wording) {
    if (wording === 'clean') {
        return 'A fix summary has been posted as a comment on the Pull Request.';
    }
    return '\nA fix summary has been posted as a comment on the Pull Request.';
}

/**
 * gh-799: builds the completion ticket comment from the LIVE PR state.
 * "No code changes are required" is allowed ONLY on the clean path (zero live
 * open threads, every input thread covered by a reply, verdict not
 * CHANGES_REQUESTED) — where it is byte-identical to the historical wording
 * (AC4, no regression). Everything else gets the truthful form with
 * thread-by-thread accounting.
 *
 * @param {Object} m   - commentMarkup flavor bag (per-tracker rendering)
 * @param {Object} ctx - { ticketKey, prUrl, branchName, prCommentPosted,
 *                       codeChangesCommitted, liveOpenThreads, inputThreads,
 *                       unaddressed, verdict }
 */
function buildReworkCompletionComment(m, ctx) {
    var liveOpen = (ctx.liveOpenThreads || []).filter(isOpenThread);
    var unaddressed = ctx.unaddressed || [];
    var verdict = ctx.verdict || null;
    var wording = selectReworkCompletionWording(liveOpen.length, unaddressed.length, verdict);

    var comment;
    if (wording === 'open-threads') {
        comment = openThreadsCompletionComment(m, ctx, liveOpen, unaddressed);
    } else if (wording === 'unaddressed-replies') {
        comment = unaddressedRepliesCompletionComment(m, ctx, unaddressed);
    } else if (wording === 'changes-requested-verdict') {
        comment = changesRequestedCompletionComment(m, ctx);
    } else {
        // Clean path — the historical wording, byte-identical (AC4).
        comment = cleanCompletionComment(m, ctx);
    }
    if (ctx.prCommentPosted) {
        comment += completionPrCommentSuffix(wording);
    }
    return comment;
}

/**
 * gh-799: gathers the live completion state in one place — input snapshot,
 * reply coverage (LOUD-logged when gapped), live open threads, verdict —
 * for postJiraComment/buildReworkCompletionComment.
 */
function buildCompletionLiveState(scm, pr, ticketKey, config) {
    var outputOpts = { ticketKey: ticketKey, workingDir: (config && config.workingDir) || null };
    var inputThreads = readInputRawThreads(ticketKey, outputOpts);
    var replies = readRepliesArray(outputOpts).replies;
    var coverage = buildReplyCoverage(inputThreads, replies);
    logReplyCoverageGap(coverage);
    return {
        inputThreads: inputThreads,
        unaddressed: coverage.unaddressed,
        liveOpenThreads: fetchLiveOpenThreads(scm, pr, inputThreads),
        verdict: latestConcludedVerdict(scm, pr)
    };
}

/**
 * gh-692 closure step: after posting replies, make ONE fresh API pass over the
 * PR's review threads and resolve every still-open thread this rework addressed —
 * matched by threadId/rootCommentId from review_replies.json, by the setup-time
 * snapshot, or by the thread ids cited in the rework response (MUST-resolve).
 *
 * Why this exists (live fa #1194, 2026-10-04): the rework leg fixed the findings
 * and pushed, but the review threads stayed open because the raw discussion
 * export lacked threadIds — postThreadReplies could not resolve what it could not
 * name. With the threads open, the threadsResolved:true re-review rule never
 * matches while the unresolved-threads rule (gh-683) keeps re-arming rework:
 * an infinite loop whose only exit is a human. A fresh sweep at resolution time
 * re-fetches the current thread ids, closing the loop even when every earlier
 * id source was incomplete.
 *
 * Fail-open by design: probe/resolution errors are logged, never thrown — a
 * broken sweep must not fail the rework leg.
 */
/**
 * True when a fresh-swept thread is addressed by this rework: cited by
 * threadId in the response text, claimed in review_replies.json by
 * threadId, or claimed by root comment id.
 */
function isAddressedThread(t, byThreadId, byRootId, cited) {
    return (t.threadId && (byThreadId[String(t.threadId)] || cited.indexOf(String(t.threadId)) !== -1)) ||
        (t.rootCommentId !== null && t.rootCommentId !== undefined && byRootId[String(t.rootCommentId)]);
}

/**
 * Count one successful resolution toward the gh-957 lap marker (no-op when
 * the caller passed no counter).
 */
function countResolution(counter) {
    if (!counter) return;
    counter.resolved = (counter.resolved || 0) + 1;
}

/**
 * The fresh open-thread sweep: re-reads the PR's live threads and resolves
 * every still-open one this rework addressed. Fail-quiet: a sweep probe
 * failure degrades to the cited-ids direct resolution below. Returns
 * {resolvedCount, resolvedViaSweep} — the latter keeps the cited pass from
 * double-resolving.
 */
function sweepAddressedThreads(scm, pullRequestId, freshThreads, addressed, counter) {
    var byThreadId = addressed.byThreadId;
    var byRootId = addressed.byRootId;
    var cited = addressed.cited;
    var resolvedCount = 0;
    var resolvedViaSweep = {};
    (freshThreads || []).forEach(function(t) {
        if (!t || t.resolved === true) return;
        if (!isAddressedThread(t, byThreadId, byRootId, cited)) return;
        try {
            scm.resolveThread(pullRequestId, { threadId: t.threadId });
            console.log('✅ Resolved still-open addressed thread (fresh sweep):', t.threadId);
            resolvedCount++;
            countResolution(counter);
            if (t.threadId) resolvedViaSweep[String(t.threadId)] = true;
        } catch (e) {
            console.warn('Failed to resolve thread', t.threadId + ':', e.message || e);
        }
    });
    return { resolvedCount: resolvedCount, resolvedViaSweep: resolvedViaSweep };
}

/**
 * Threads cited in the rework response MUST be resolved even when the sweep
 * could not confirm them open (probe failed, pagination, stale flags) —
 * resolve them directly; resolving an already-resolved thread is harmless.
 */
function resolveCitedThreads(scm, pullRequestId, cited, resolvedViaSweep, counter) {
    var resolvedCount = 0;
    (cited || []).forEach(function(threadId) {
        if (resolvedViaSweep[String(threadId)]) return;
        try {
            scm.resolveThread(pullRequestId, { threadId: threadId });
            console.log('✅ Resolved thread cited in rework response:', threadId);
            resolvedCount++;
            countResolution(counter);
        } catch (e) {
            console.warn('Failed to resolve cited thread', threadId + ':', e.message || e);
        }
    });
    return resolvedCount;
}

/**
 * The live thread re-read for the closure sweep: the rawThreads list from
 * fetchDiscussions, [] when the provider lacks the probe or it fails.
 */
function fetchFreshThreadsForSweep(scm, pullRequestId) {
    if (!(scm && typeof scm.fetchDiscussions === 'function')) return [];
    try {
        var data = scm.fetchDiscussions(String(pullRequestId));
        return ((data && data.rawThreads && data.rawThreads.threads) || []);
    } catch (e) {
        console.warn('Fresh review-thread sweep failed (falling back to direct resolution of cited ids):', e.message || e);
        return [];
    }
}

function resolveRemainingAddressedThreads(scm, pullRequestId, addressed) {
    var cited = (addressed && addressed.citedThreadIds) || [];
    var byThreadId = (addressed && addressed.addressedThreadIds) || {};
    var byRootId = (addressed && addressed.addressedRootIds) || {};
    // gh-957: optional lap-accounting counter ({resolved: N}) — incremented on
    // every successful resolution so the leg close can stamp an accurate lap
    // marker (zero-resolved laps are what the SM loop guard counts).
    var counter = (addressed && addressed.resolutions) || null;
    var hasWork = cited.length > 0 ||
        Object.keys(byThreadId).length > 0 ||
        Object.keys(byRootId).length > 0;
    if (!hasWork) return 0;

    var sweep = sweepAddressedThreads(scm, pullRequestId,
        fetchFreshThreadsForSweep(scm, pullRequestId),
        { byThreadId: byThreadId, byRootId: byRootId, cited: cited }, counter);
    return sweep.resolvedCount +
        resolveCitedThreads(scm, pullRequestId, cited, sweep.resolvedViaSweep, counter);
}

/**
 * gh-957: the audit line appended to every reply when the leg changed no
 * code (audit-resolve) — resolution without a code change is allowed ONLY
 * with this per-thread explanation (rework run URL when known).
 */
function buildAuditResolveLine(auditNoCodeChange, runUrl) {
    if (!auditNoCodeChange) return null;
    return '\n\n— Audit (gh-957): no code change required — this thread is already addressed on the current head' +
        (runUrl ? (' or an invalid finding. Resolved by rework run ' + runUrl + '.') : '. (rework run URL unavailable on this runner)');
}

/**
 * One untargeted reply's combined top-level fallback text: a single item
 * posts as-is; several are numbered into ONE comment (anti-spam).
 */
function buildCombinedUntargetedComment(untargeted) {
    if (untargeted.length === 1) return untargeted[0].text;
    const lines = untargeted.map(function(u, i) {
        return (i + 1) + '. ' + u.text + (u.threadId ? ' (thread ' + u.threadId + ')' : '');
    });
    return '✅ Addressed ' + untargeted.length + ' review comment(s) without a specific inline target:\n\n' + lines.join('\n');
}

/**
 * The reply anchor id from whichever field the agent wrote
 * (inReplyToId first, rootCommentId as the input-schema fallback).
 */
function firstPresentId(item) {
    if (item.inReplyToId) return item.inReplyToId;
    return item.rootCommentId || null;
}

/**
 * The root comment id the setup-time snapshot holds for a threadId — null
 * when the snapshot lacks the thread or its root id.
 */
function threadRootIdOrNull(lookup, threadId) {
    var t = threadId ? lookup.byThread[String(threadId)] : null;
    if (!t || t.rootCommentId === null || t.rootCommentId === undefined) return null;
    return t.rootCommentId;
}

/**
 * The threadId the snapshot holds for a root comment id — null when unknown.
 */
function fillThreadIdFromRoot(lookup, inReplyToId) {
    if (!inReplyToId) return null;
    var byRoot = lookup.byRoot[String(inReplyToId)];
    return (byRoot && byRoot.threadId) ? byRoot.threadId : null;
}

/**
 * gh-692 id enrichment: fill a missing inReplyToId from the setup-time
 * snapshot (matched by threadId) and a missing threadId from the snapshot
 * (matched by root id) — either id makes the reply threaded AND its thread
 * resolvable. Mutates item.threadId when fillable; returns the anchor id.
 */
function enrichReplyIds(item, lookup) {
    var inReplyToId = firstPresentId(item);
    if (!inReplyToId && item.threadId) {
        inReplyToId = threadRootIdOrNull(lookup, item.threadId) || inReplyToId;
    }
    if (!item.threadId && inReplyToId) {
        item.threadId = fillThreadIdFromRoot(lookup, inReplyToId);
    }
    return inReplyToId;
}

/**
 * The reply text: a path reference resolves to the file content, anything
 * else posts as-is; an empty/absent ref falls back to the generic marker.
 */
function resolveReplyText(replyRef, outputOptions) {
    if (!replyRef) return '✅ Addressed.';
    const looksLikePath = replyRef.indexOf('outputs/') === 0 ||
        replyRef.indexOf('/') !== -1 ||
        replyRef.indexOf('.md') !== -1;
    if (looksLikePath) {
        const fileContent = outputFiles.readOutputFile(replyRef, outputOptions);
        if (fileContent && fileContent.trim()) {
            return fileContent.trim();
        }
    }
    return replyRef;
}

/**
 * Resolve one reply's thread and count the resolution for the gh-957 lap
 * marker. No-op when the reply carries no threadId.
 */
function resolveReplyThread(scm, pullRequestId, thread, item, resolutions) {
    if (!item.threadId) return;
    try {
        scm.resolveThread(pullRequestId, thread);
        console.log('✅ Resolved thread', item.threadId);
        if (resolutions) resolutions.resolved = (resolutions.resolved || 0) + 1;
    } catch (e) {
        console.warn('Failed to resolve thread', item.threadId + ':', e.message || e);
    }
}

/**
 * Post one prepared reply: an inline threaded reply when an anchor id
 * exists, else queue it for the combined top-level fallback (anti-spam —
 * never one generic comment per item). Resolves the thread either way.
 */
function postReplyAndResolve(scm, pullRequestId, item, thread, replyText, state) {
    if (thread.rootCommentId) {
        // Normal case: post an inline threaded reply — this appears nested
        // inside the review conversation, not as a new top-level PR comment.
        try {
            scm.replyToThread(pullRequestId, thread, replyText);
            console.log('✅ Replied to comment #' + thread.rootCommentId);
            state.posted++;
        } catch (e) {
            console.warn('Failed to post reply:', e.message || e);
        }
    } else {
        // No comment id available at all — a threaded reply is not possible.
        // Queue it instead of posting a separate top-level PR comment per
        // item, which would spam the conversation with repeated generic text.
        state.untargeted.push({ threadId: item.threadId || null, text: replyText });
    }
    resolveReplyThread(scm, pullRequestId, thread, item, state.resolutions);
}

/**
 * One reply row of the per-item pass (gh-1220 CRAP split of
 * postThreadReplies): enrich ids from the setup-time snapshot, resolve the
 * reply text, track every claimed id for the closure sweep, then post + resolve.
 * Call order is byte-identical to the former inline body.
 */
function postOneThreadReply(scm, pullRequestId, item, lookup, outputOptions, auditLine, addressed, state) {
    // Accept both the documented field names (inReplyToId/reply) and the
    // input-schema field names (rootCommentId/body) — the AI agent commonly
    // mirrors field names from input/<TICKET>/pr_discussions_raw.json
    // instead of renaming them for output. gh-692 fills either missing id
    // from the setup-time snapshot so the reply is threaded + resolvable.
    const inReplyToId = enrichReplyIds(item, lookup);
    const replyText = resolveReplyText(item.reply || item.body, outputOptions) + (auditLine || '');
    const thread = { rootCommentId: inReplyToId, threadId: item.threadId || null };

    // Track every id this rework claims as addressed — the closure sweep
    // below retries resolution for anything the per-item pass could not
    // name or complete.
    if (item.threadId) addressed.threadIds[String(item.threadId)] = true;
    if (inReplyToId) addressed.rootIds[String(inReplyToId)] = true;

    postReplyAndResolve(scm, pullRequestId, item, thread, replyText, state);
}

/**
 * The single combined top-level comment for every untargeted reply
 * (anti-spam — never one generic comment per item). Returns 1 when posted,
 * 0 otherwise; a failed post is warned about, never thrown.
 */
function postCombinedUntargetedComment(scm, pullRequestId, untargeted) {
    if (untargeted.length === 0) return 0;
    try {
        // Post exactly one combined top-level comment for all untargeted replies
        // instead of one generic comment per item.
        scm.addComment(pullRequestId, buildCombinedUntargetedComment(untargeted));
        console.log('✅ Posted 1 combined comment for ' + untargeted.length + ' untargeted repl' + (untargeted.length === 1 ? 'y' : 'ies'));
        return 1;
    } catch (e) {
        console.warn('Failed to post combined untargeted reply comment:', e.message || e);
        return 0;
    }
}

/**
 * Post replies to each review thread and resolve them.
 * Reads outputs/review_replies.json produced by the cursor agent.
 *
 * JSON format: { "replies": [{ "inReplyToId": 123, "threadId": "PRRT_...", "reply": "outputs/review_replies/thread1.md" }] }
 * The "reply" field may be a path to a Markdown file (preferred) or inline text (legacy).
 *
 * Defensive fallback: also accepts "rootCommentId" (instead of "inReplyToId") and
 * "body" (instead of "reply", as inline text) — the AI agent frequently mirrors
 * field names from input/<TICKET>/pr_discussions_raw.json (rootCommentId/body)
 * rather than renaming them to the documented output schema.
 *
 * Id enrichment (gh-692): a missing threadId/inReplyToId is filled in from the
 * setup-time snapshot input/<ticketKey>/pr_discussions_raw.json (matched by the
 * id that IS present), so a reply becomes threaded and its thread resolvable
 * even when the agent dropped one of the two ids.
 *
 * Closure sweep (gh-692): after the per-item pass, resolveRemainingAddressedThreads()
 * resolves every still-open thread the rework addressed — including threads whose
 * ids only appear in the rework response text (outputOptions.responseText). Without
 * this step the threadsResolved:true re-review rule can never match.
 *
 * Anti-spam: replies without any usable comment id (no inReplyToId/rootCommentId,
 * even after enrichment) cannot be posted as an inline threaded reply. Instead of
 * posting one generic top-level PR comment per such item (which spams the
 * conversation with repeated "✅ Addressed." messages), all of them are batched into
 * a single combined top-level comment — the specified fallback for unciteable items.
 */
function postThreadReplies(scm, pullRequestId, outputOptions) {
    outputOptions = outputOptions || {};
    var lookup = buildThreadLookup(readInputRawThreads(outputOptions.ticketKey, outputOptions));

    // gh-799: shared reader — the completion live-state reads the same file the
    // same way, so coverage accounting and reply posting can never drift apart.
    var repliesFile = readRepliesArray(outputOptions);
    if (repliesFile.missing) {
        console.warn('outputs/review_replies.json not found — skipping thread replies');
    }

    const replies = repliesFile.replies;
    if (replies.length === 0) {
        console.log('No thread replies to post');
    }

    const untargeted = [];
    const addressed = { threadIds: {}, rootIds: {} };
    // gh-957: lap-accounting counter — incremented on every successful
    // resolution so the leg close can stamp an accurate lap marker.
    const state = { posted: 0, untargeted: untargeted, resolutions: outputOptions.resolutions || null };
    // gh-957 audit-resolve: when the leg changed no code, every reply below
    // carries the audit line (rework run URL) — resolution without a code
    // change is allowed ONLY with this per-thread explanation.
    const auditLine = buildAuditResolveLine(outputOptions.auditNoCodeChange, outputOptions.runUrl);

    replies.forEach(function(item) {
        postOneThreadReply(scm, pullRequestId, item, lookup, outputOptions, auditLine, addressed, state);
    });
    state.posted += postCombinedUntargetedComment(scm, pullRequestId, untargeted);

    // Closure step (gh-692): sweep the PR's fresh open threads and resolve every
    // still-open thread this rework addressed — plus the ids cited in the rework
    // response, which MUST be resolved. Runs even when review_replies.json was
    // missing entirely.
    resolveRemainingAddressedThreads(scm, pullRequestId, {
        citedThreadIds: extractCitedThreadIds(outputOptions.responseText),
        addressedThreadIds: addressed.threadIds,
        addressedRootIds: addressed.rootIds,
        resolutions: outputOptions.resolutions || null
    });

    console.log('Posted ' + state.posted + '/' + replies.length + ' thread replies');
    return state.posted;
}

function postPRComment(scm, pullRequestId, fixSummary, ticketKey, repliesPosted) {
    try {
        var commentText;
        if (repliesPosted > 0) {
            // When review thread replies exist, keep the top-level comment minimal.
            // The detailed answers live in the thread replies.
            commentText = '## 🔧 Rework Complete — ' + ticketKey + '\n\n' +
                'All review feedback has been addressed in the thread replies above.';
        } else {
            commentText = '## 🔧 Rework Complete — ' + ticketKey + '\n\n' +
                'All PR review comments have been addressed. See fix summary below.\n\n' +
                '---\n\n' +
                fixSummary;
        }
        scm.addComment(pullRequestId, commentText);
        console.log('✅ Posted fix summary to PR #' + pullRequestId);
        return true;
    } catch (error) {
        console.error('Failed to post PR comment:', error);
        return false;
    }
}

/**
 * gh-799: posts the completion comment generated from the LIVE PR state
 * (buildCompletionLiveState — live unresolved-thread re-check + verdict probe
 * + reply coverage). liveState may be null for legacy callers — that maps to
 * the clean path, preserving the historical wording.
 */
function postJiraComment(tracker, ticketKey, prUrl, branchName, prCommentPosted, codeChangesCommitted, fixSummary, liveState) {
    try {
        const m = commentMarkup.forTicket(ticketKey);
        const live = liveState || {};
        const comment = buildReworkCompletionComment(m, {
            ticketKey: ticketKey,
            prUrl: prUrl,
            branchName: branchName,
            prCommentPosted: prCommentPosted,
            codeChangesCommitted: codeChangesCommitted,
            liveOpenThreads: live.liveOpenThreads || [],
            inputThreads: live.inputThreads || [],
            unaddressed: live.unaddressed || [],
            verdict: live.verdict || null
        });

        tracker.postComment(ticketKey, comment);
        console.log('✅ Posted completion comment to ticket:', ticketKey);
    } catch (error) {
        console.error('Failed to post tracker comment:', error);
    }
}

function isInterruptedReworkResponse(response) {
    var text = String(response || '');
    return text.indexOf('CLI command executed but did not produce output file') !== -1 ||
        text.indexOf('Command failed (exit code 124)') !== -1 ||
        text.indexOf('Copilot command timed out') !== -1 ||
        text.indexOf('outputs/response.md missing') !== -1 ||
        text.indexOf('"path":"interrupted"') !== -1 ||
        text.indexOf('"path": "interrupted"') !== -1;
}

/**
 * Fatal (non-interruption) CLI failure in the rework response.
 *
 * Live pathology 2026-09-29 (IstiN/flutter_agent_harness #1052 machine loop):
 * a rework CLI command that exited non-zero (exit code 1) was announced as
 * "✅ Rework Complete" because only interruption-class failures (timeout exit
 * 124, missing output file) were detected. The loop then re-validated a head
 * that could never go green — forever.
 *
 * The `Error: Command failed (exit code N)` marker is written by the
 * CliExecutionHelper into the RAW command log; it only reaches the response
 * when the CLI died WITHOUT writing outputs/response.md (a completed agent's
 * response comes from the output file, which never embeds this helper
 * marker). So seeing it here means the rework CLI run failed outright.
 * Exit 124 stays in the interruption class — [isInterruptedReworkResponse]
 * owns it and its resume-once semantics.
 */
function isFailedCliReworkResponse(response) {
    var m = /Error: Command failed \(exit code (\d+)\)/.exec(String(response || ''));
    if (!m) return false;
    var code = parseInt(m[1], 10);
    return code !== 0 && code !== 124;
}

/**
 * Terminal handler for a fatally failed rework CLI run: surface the failure
 * honestly instead of announcing completion. Mirrors [handleInterruptedRework]
 * semantics (leave PR conversations open, reset the ticket for retry) but
 * posts a failure comment and reports success:false so callers/metrics see it.
 */
function handleFailedReworkCli(tracker, ticketKey, branchName, customParams, statuses, error) {
    console.warn('Rework CLI failed with a non-zero exit — surfacing the failure instead of announcing completion.');
    try {
        const mi = commentMarkup.forTicket(ticketKey);
        tracker.postComment(
            ticketKey,
            mi.h(3, '❌ Rework CLI Failed') + '\nThe rework CLI command exited with a non-zero code. No completion is claimed; PR conversations were left open. The ticket was moved back to ' + mi.bold(statuses.IN_REWORK) + ' for retry.\n'
                + mi.code(String(error).substring(0, 2000))
        );
    } catch (e) {
        console.warn('Failed to post failed-rework comment:', e.message || e);
    }
    try {
        tracker.moveToStatus(ticketKey, statuses.IN_REWORK);
        console.log('✅ Moved', ticketKey, 'back to', statuses.IN_REWORK, 'for retry');
    } catch (e) {
        console.warn('Failed to move ticket back to ' + statuses.IN_REWORK + ':', e.message || e);
    }
    removeConfiguredLabels(tracker, ticketKey, customParams || {});
    return {
        success: false,
        path: 'rework-cli-failed',
        ticketKey: ticketKey,
        branchName: branchName
    };
}

/**
 * Reads input/<ticketKey>/rework_setup_failed.md, written by preCliReworkSetup's
 * failSetup() when it could not find/checkout a PR for the ticket (e.g. "no PR
 * found for ticket"). Returns the file content, or null if the file does not
 * exist (the normal, working-PR path).
 */
function readReworkSetupFailure(ticketKey) {
    try {
        var content = file_read({ path: inputFolderFor(ticketKey) + '/rework_setup_failed.md' });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        return null;
    }
}

/**
 * Rework setup already failed (most commonly: no PR found for the ticket) before
 * the CLI agent even ran. There is no branch/PR to push changes to, and retrying
 * the CLI cannot conjure one up — in the observed incident, retrying instead led
 * the CLI agent to fabricate a fake pr_info.md just to satisfy the "refuse to
 * commit on base branch" guard. Skip commitAndPush() and the resumeAgent retry
 * entirely, and just make sure Jira reflects what happened.
 */
function handleReworkSetupAlreadyFailed(tracker, ticketKey, customParams, failureContent) {
    console.warn('⚠️ Rework setup already failed (no PR found) for', ticketKey, '— skipping commit/push and CLI retry.');
    try {
        var m = commentMarkup.forTicket(ticketKey);
        var comment = m.h(3, '❌ Rework Push Skipped — Setup Already Failed') + '\n\n' +
            'Rework setup did not find (or could not check out) a Pull Request for this ticket, ' +
            'so there is no branch to push changes to. Retrying the CLI agent cannot fix a missing PR, ' +
            'so the push step was skipped rather than retried.\n\n';
        if (failureContent) {
            comment += m.code(failureContent.trim());
        } else {
            comment += 'See ' + m.inline(inputFolderFor(ticketKey) + '/rework_setup_failed.md') + ' for details.';
        }
        tracker.postComment(ticketKey, comment);
        console.log('✅ Posted rework-setup-already-failed comment to ticket:', ticketKey);
    } catch (e) {
        console.warn('Failed to post rework-setup-already-failed comment:', e.message || e);
    }
    removeConfiguredLabels(tracker, ticketKey, customParams || {});
    return {
        success: true,
        path: 'rework-setup-already-failed',
        ticketKey: ticketKey,
        error: 'Rework setup already failed (no PR found for ticket); push step skipped.'
    };
}

function handleInterruptedRework(tracker, ticketKey, branchName, customParams, statuses) {
    console.warn('Rework CLI was interrupted before writing required outputs; leaving PR conversations open and resetting ticket for retry.');
    try {
        const mi = commentMarkup.forTicket(ticketKey);
        tracker.postComment(
            ticketKey,
            mi.h(3, '⏸️ Rework Interrupted') + '\n\nThe AI agent pushed any staged partial changes, but it was interrupted before writing ' + mi.code('outputs/response.md') + ' and ' + mi.code('outputs/review_replies.json') + '. PR conversations were left open. The ticket was moved back to ' + mi.bold(statuses.IN_REWORK) + ' for retry.\n\n' + mi.bold('Branch') + ': ' + mi.code(branchName)
        );
    } catch (e) {
        console.warn('Failed to post interrupted rework comment:', e.message || e);
    }
    try {
        tracker.moveToStatus(ticketKey, statuses.IN_REWORK);
        console.log('✅ Moved', ticketKey, 'back to', statuses.IN_REWORK, 'for retry');
    } catch (e) {
        console.warn('Failed to move ticket back to ' + statuses.IN_REWORK + ':', e.message || e);
    }
    removeConfiguredLabels(tracker, ticketKey, customParams || {});
    return {
        success: true,
        path: 'rework-interrupted',
        ticketKey: ticketKey,
        branchName: branchName
    };
}

/**
 * GitHub machine loop, token-burn guard (live pathology 2026-09-21,
 * epam/dmtools-dart #194): a rework run that pushed NO new commits used to
 * clear ai_pr_reviewed and auto-start a fresh LLM review of the SAME head —
 * a full reviewer pass that just restated the standing findings ("round 2,
 * unchanged commit"). The last concluded PR review's commit_id is the
 * durable "what the verdict covered" marker: when it equals the PR head,
 * the rework was a no-op and the verdict still stands.
 *
 * Returns true when a fresh review IS wanted (head moved, no concluded
 * reviews, or the probe failed — fail-open so the review loop can never
 * stall on a broken probe).
 */
function headMovedSinceLastReview(scm, pr) {
    try {
        // gh-799: shared concluded-review probe (same filter + sort as
        // latestConcludedVerdict) — one id-source of truth for review verdicts.
        var concluded = concludedReviewsSorted(scm, pr);
        if (!concluded.length) { return true; }
        var last = concluded[concluded.length - 1];
        var headSha = pr.head && (pr.head.sha || pr.head);
        if (last.commit_id && headSha && String(last.commit_id) === String(headSha)) {
            return false;
        }
    } catch (e) {
        console.warn('headMovedSinceLastReview probe failed (fail-open):', e.message || e);
    }
    return true;
}

/**
 * gh-957 audit-resolve gate decision (pure — extracted from action for the
 * CRAP budget and the failed-probe semantics, review thread 'realCodeChanges
 * mislabels a failed probe as a no-op lap'). Combines the two independent
 * change signals into one decision per leg close:
 *   realCodeChanges     — hasRealCodeChanges() probe: true/false, or null
 *                         when the git diff probe itself failed (unknown)
 *   codeChangesCommitted— commitAndPush()'s own hasChanges (a rework commit
 *                         actually landed this leg)
 *   openThreadCount     — open ADDRESSABLE threads in the input snapshot
 *                         (gh-1061: null-id machine notices are excluded —
 *                         they can never receive a targeted reply)
 *   unaddressedCount    — open addressable threads with no targeted reply
 * Returns { blocked, auditResolve, lapPushed }:
 *   lapPushed    — a real change landed (either signal) — the lap marker
 *                  records it so a genuine progress lap is NEVER counted as
 *                  a no-op: a failed probe must not escalate a healthy PR
 *                  one lap early.
 *   blocked      — no change CONFIRMED, open threads AND incomplete reply
 *                  coverage: the historical agents#827 blocked path.
 *   auditResolve — no change (confirmed, or ASSUMED when the probe failed
 *                  and no commit landed) with full reply coverage:
 *                  resolution is allowed ONLY with the per-thread audit
 *                  line. When commits landed under a failed probe we cannot
 *                  claim "no code change" — the normal resolving path (no
 *                  audit line) applies.
 */
function evaluateAuditResolveGate(realCodeChanges, codeChangesCommitted, openThreadCount, unaddressedCount) {
    var lapPushed = realCodeChanges === true || codeChangesCommitted === true;
    var blocked = realCodeChanges === false && openThreadCount > 0 && unaddressedCount > 0;
    var auditResolve = !blocked && openThreadCount > 0 && !lapPushed;
    return { blocked: blocked, auditResolve: auditResolve, lapPushed: lapPushed };
}

/**
 * gh-1061 AC2/AC3: the unaddressed-thread enumeration for the blocked comment
 * — one collapsed <details> block: 3 inline previews, "…and N more", then the
 * full list with hard-capped labels so a 39-thread case stays inside the
 * ~2000-char body budget. Null-id machine notices are listed as informational
 * context, explicitly marked as excluded from the coverage gate.
 */
function buildUnaddressedThreadsFold(unaddressed, unaddressable) {
    var lines = [];
    lines.push('<details>');
    lines.push('<summary><b>' + unaddressed.length + ' open review thread(s) had no targeted reply</b> in ' +
        '<code>outputs/review_replies.json</code> (gh-957 coverage gate) — click to expand the full list</summary>');
    lines.push('');
    unaddressed.slice(0, 3).forEach(function(t) {
        lines.push('- <code>' + threadShortLabel(t, 48) + '</code>');
    });
    if (unaddressed.length > 3) {
        lines.push('…and ' + (unaddressed.length - 3) + ' more:');
        lines.push('');
        unaddressed.slice(3).forEach(function(t) {
            // gh-1063 review follow-up (thread 6): the remainder lines carry
            // the same bullet + <code> format as the 3 previews — the
            // expanded full list no longer alternates between two formats.
            // The label cap drops 32 -> 20 so the wrapper's 14 extra chars
            // per line stay inside the AC2 ~2000-char comment budget.
            lines.push('- <code>' + threadShortLabel(t, 20) + '</code>');
        });
    }
    if (unaddressable.length > 0) {
        lines.push('');
        lines.push(unaddressable.length + ' machine-notice thread(s) have no thread id and can never receive ' +
            'a targeted reply — excluded from the coverage gate (gh-1061), informational only:');
        unaddressable.forEach(function(t) {
            lines.push('- ' + threadShortLabel(t, 48));
        });
    }
    lines.push('');
    lines.push('</details>');
    return lines.join('\n');
}

/**
 * gh-1061 review follow-up: the blocked comment's ⚠️ header line. openCount
 * is the ADDRESSABLE count — the same quantity the gh-957 coverage gate uses
 * — so the header can never disagree with the fold below it. totalOpenCount
 * (all open threads, machine notices included) is reconciled in a
 * parenthetical clause when it differs; when the caller does not pass it,
 * the total is derived from the unaddressable list.
 */
function blockedHeader(openCount, totalOpenCount, unaddressable) {
    var total = (typeof totalOpenCount === 'number') ? totalOpenCount
        : openCount + (unaddressable ? unaddressable.length : 0);
    var header = '⚠️ Rework is **blocked**: no code changes were made while ' + openCount +
        ' review thread(s) are still open';
    if (total > openCount) {
        header += ' (' + total + ' open in total — ' + (total - openCount) +
            ' machine-notice thread(s) excluded from the coverage gate, informational only)';
    }
    return header;
}

/**
 * gh-1061 AC1/AC2/AC4: compose the blocked-rework PR comment. The agent's
 * outputs/response.md is the message a blocked pass exists to deliver, so it
 * leads verbatim (first block after the ⚠️ header); the thread-coverage
 * evidence moves into a collapsed fold. A missing response.md is called out
 * explicitly — never silently omitted (live: dmtools-dart PR #420 / gh-395 —
 * the leg's API-choice question reached no human and the PR blocked-looped
 * for a week).
 * Review follow-up: the header line lives in blockedHeader() — openCount is
 * the ADDRESSABLE count (the gate quantity), totalOpenCount reconciles it.
 */
function buildBlockedReworkComment(openCount, unaddressed, unaddressable, reason, runUrl, totalOpenCount) {
    var message = blockedHeader(openCount, totalOpenCount, unaddressable) +
        '. Threads were NOT resolved; the PR is parked (`blocked` label, gh-1060) and the ' +
        'rework/review arms are stripped from both carriers.';
    var summary = String(reason || '').trim();
    if (summary && summary !== '_(No fix summary generated)_') {
        message += '\n' + summary;
    } else if (runUrl) {
        message += '\n_The agent wrote no response.md — see run log ' + runUrl + '._';
    } else {
        message += '\n_The agent wrote no response.md — nothing from the agent\'s run reached this ' +
            'comment; see the raw run log._';
    }
    if (unaddressed.length > 0 || unaddressable.length > 0) {
        message += '\n' + buildUnaddressedThreadsFold(unaddressed, unaddressable);
    }
    return message;
}

/**
 * gh-1060 (live dart gh-395 / PR #420, 2026-10-18 18:55Z — leg run 39156398849
 * concluded blocked, the issue sat at status:Blocked, the PR kept its
 * agent:rework arm and every tick re-dispatched a rework leg until a human
 * stripped the label): the BLOCKED conclusion must park the PR too. Two
 * parallel "blocked" vocabularies existed with no bridge — the issue-side
 * status:Blocked is read by NO SM rule, while the SM's park vocabulary is
 * the PR-side `blocked` label (engine-level freeze: githubSource
 * matchesGuards/_prSideBlockedLabel and queryPrs filter it for every rule).
 * One atomic park closes the loop: label the PR `blocked` (freezes the pair
 * for every lane) and strip the agent:rework / agent:review arms from BOTH
 * carriers (a leftover arm would re-dispatch the moment a human unblocks).
 * Unblocking is human-symmetric by construction (AC2): removing `blocked`
 * from the PR — or moving the issue off status:Blocked — re-admits the pair
 * to the standard lanes; no hidden second switch, no auto-unblock heuristic
 * (non-goal). Every write is best-effort: a failed label write must not
 * mask the Blocked move the caller already performed.
 */
/**
 * gh-1060 CRAP split helpers (ratchet: parkBlockedPr measured CC 13 / CRAP
 * 14.6 > CRAP_THRESHOLD — CRAP is bounded below by CC, so only splitting
 * lowers it; same gh-957 pattern as the handleReworkBlocked area below).
 * Each helper is best-effort: a failed label write must not mask the
 * Blocked move the caller already performed.
 */

// Normalize a raw GitHub REST label list to plain names: the payload from
// scm.listPrs('open') carries [{name}] objects, not strings
// (githubSource.prLabels / prHasApproved pattern).
function prLabelNames(pr) {
    return (pr.labels || []).map(function(l) { return (l && l.name) || l; });
}

// Label the PR `blocked` — the SM park vocabulary (engine-level freeze in
// githubSource matchesGuards/_prSideBlockedLabel/queryPrs).
function labelPrBlocked(scm, pr) {
    try {
        scm.addLabel(pr.number, 'blocked');
        console.log('✅ Labeled PR #' + pr.number + ' blocked (gh-1060 park — SM freeze vocabulary)');
    } catch (e) {
        console.warn('Failed to label PR #' + pr.number + ' blocked:', e.message || e);
    }
}

// Strip one arm from the PR. A leftover arm would re-dispatch a leg the
// moment a human unblocks, so strip unconditionally when the PR carries
// labels at all (a 404 on an absent label is tolerated by the try/catch).
function stripArmFromPr(scm, pr, arm) {
    if (prLabelNames(pr).length === 0) return;
    try {
        scm.removeLabel(pr.number, arm);
        console.log('✅ Stripped ' + arm + ' from PR #' + pr.number + ' (gh-1060 park)');
    } catch (e) {
        console.warn('Failed to strip ' + arm + ' from PR #' + pr.number + ':', e.message || e);
    }
}

// Strip one arm from the issue carrier — best-effort, mirroring the PR side.
function stripArmFromIssue(tracker, ticketKey, arm) {
    try {
        tracker.removeLabel(ticketKey, arm);
        console.log('✅ Stripped ' + arm + ' from ' + ticketKey + ' (gh-1060 park)');
    } catch (e) {
        console.warn('Failed to strip ' + arm + ' from ' + ticketKey + ':', e.message || e);
    }
}

function parkBlockedPr(scm, tracker, pr, ticketKey) {
    var ARMS = ['agent:rework', 'agent:review'];
    if (scm && pr && pr.number != null) {
        labelPrBlocked(scm, pr);
        ARMS.forEach(function(arm) { stripArmFromPr(scm, pr, arm); });
    }
    ARMS.forEach(function(arm) { stripArmFromIssue(tracker, ticketKey, arm); });
}

// ── gh-1195 CRAP split: best-effort steps of the blocked close ───────────────
// Each step keeps its historical log lines and fail-quiet semantics; the
// sequence in handleReworkBlocked is unchanged.

/** The ❌ leg-log line — the open count reconciled with machine-notice totals. */
function blockedLogLine(coverage) {
    var openCount = coverage.openCount;
    return '❌ Rework blocked (no code changes, ' + openCount + ' open addressable thread(s)' +
        (coverage.totalOpenCount > openCount ? ', ' + coverage.totalOpenCount + ' open in total' : '') + ')';
}

/** Best-effort PR comment — a post failure never blocks the Blocked close. */
function postBlockedPrComment(scm, prNumber, message) {
    try {
        scm.addComment(prNumber, message);
    } catch (e) {
        console.warn('Failed to post blocked rework comment on PR #' + prNumber + ':', e.message || e);
    }
}

/** The Blocked move — best-effort, defaulting to the literal 'Blocked' name. */
function moveToBlockedStatus(tracker, ticketKey, statuses) {
    var blocked = (statuses && statuses.BLOCKED) || 'Blocked';
    try {
        tracker.moveToStatus(ticketKey, blocked);
        console.log('✅ Moved', ticketKey, 'to', blocked);
    } catch (e) {
        console.warn('Failed to move ' + ticketKey + ' to ' + blocked + ':', e.message || e);
    }
}

/**
 * The leg-context WIP label (<contextId>_wip) — removed best-effort when the
 * run carries a context id at all.
 */
function removeContextWipLabel(tracker, ticketKey, actualParams) {
    var wip = actualParams ? wipLabelOf(actualParams) : null;
    if (wip) {
        try { tracker.removeLabel(ticketKey, wip); } catch (e) { /* non-fatal */ }
    }
}

/**
 * agents#827 + gh-957: the rework pass produced no production change while
 * review threads are open AND reply coverage is incomplete (gh-957 tightens
 * the gate — full coverage takes the audit-resolve path instead). Posts the
 * blocked comment (gh-1061: response.md leads, thread dump folded), moves the
 * ticket to Blocked, parks the PR (gh-1060 — `blocked` label + arms stripped
 * from both carriers), and stamps a no-op lap marker (pushed 0, resolved 0)
 * so the SM loop guard can bound consecutive empty laps on this head.
 * Review follow-up (gh-1063): the coverage snapshot arrives as ONE object —
 * the buildReplyCoverage result — instead of four positional params, so the
 * signature cannot grow a 12th argument on the next follow-up.
 */
function handleReworkBlocked(scm, tracker, pr, ticketKey, statuses, fixSummary, coverage, actualParams) {
    var openCount = coverage.openCount;
    var message = buildBlockedReworkComment(openCount, coverage.unaddressed || [], coverage.unaddressable || [],
        fixSummary, reworkRunUrl(), coverage.totalOpenCount);
    console.error(blockedLogLine(coverage));
    postBlockedPrComment(scm, pr.number, message);
    // gh-957: the empty lap counts toward the SM no-op loop guard.
    postLapMarker(scm, pr.number, readReworkBaseHead(ticketKey), false, 0);
    moveToBlockedStatus(tracker, ticketKey, statuses);
    // gh-1060: bridge the two blocked vocabularies — park the PR in the same
    // breath as the Blocked move (blocked label + arms stripped, one atomic
    // park), otherwise the armed PR loops rework legs on the blocked ticket.
    parkBlockedPr(scm, tracker, pr, ticketKey);
    removeContextWipLabel(tracker, ticketKey, actualParams);
    return { success: false, blocked: true, error: 'Rework blocked: no code changes while ' + openCount + ' review thread(s) are open' };
}

// ── gh-1119: owned CI violations may not be dismissed as unrelated ───────────
//
// Live pathology (#433, rework run 39308030238): the gate (crap4dart) failed
// on a file the PR ITSELF added; the violation line was buried in the raw
// tails, the leg concluded "violation is in code the PR does not touch" and
// pushed without fixing. preCliReworkSetup now opens ci_failures.md with the
// owned/foreign violation tables (gh-1119); this gate closes the loop on the
// post-rework side: with owned violations open, a fix summary that dismisses
// them wholesale ("not caused by this PR", "unrelated", "infra") or leaves
// them unaccounted FAILS the leg — never a "Rework Complete" announcement
// over an open owned red. The empty lap marker keeps the gh-957 no-op loop
// guard counting.

/** Parse one snapshot file's content into a violation array, or []. */
function violationsFromSnapshot(raw) {
    if (!raw || !String(raw).trim()) return [];
    var parsed = JSON.parse(raw);
    var violations = (parsed && parsed.violations) ? parsed.violations : (Array.isArray(parsed) ? parsed : []);
    return (violations && violations.length > 0) ? violations : [];
}

/** Reads the setup-time violation snapshot (input/<ticketKey>/ci_violations.json). */
function readInputViolations(ticketKey, workingDir) {
    var candidates = [inputFolderFor(ticketKey) + '/ci_violations.json'];
    if (workingDir) candidates.push(workingDir + '/' + inputFolderFor(ticketKey) + '/ci_violations.json');
    for (var i = 0; i < candidates.length; i++) {
        try {
            var violations = violationsFromSnapshot(file_read({ path: candidates[i] }));
            if (violations.length > 0) return violations;
        } catch (e) { /* try next candidate */ }
    }
    return [];
}

/** The rejection comment: per-item errors, the owned table, what the leg must do. */
function buildOwnedViolationsRejectedComment(violations, verdict) {
    var lines = ['### ❌ Rework rejected — owned CI violations not accounted', ''];
    (verdict.errors || []).forEach(function(err) {
        lines.push('- ' + err);
    });
    lines.push('');
    lines.push(ciViolations.buildViolationsMarkdown(ciViolations.ownedViolations(violations)));
    lines.push('Fix every owned violation (or dispute each one in the rework summary with ' +
        '`fixed` / `disputed: <reason>`), then re-run the leg. This leg is marked failed and the ' +
        'no-op loop guard counts it.');
    return lines.join('\n');
}

/**
 * The head a lap marker anchors to: the setup-time base head
 * (rework_base_head.txt) when known, else the PR's current head.
 */
function lapMarkerHeadOf(ticketKey, pr) {
    return readReworkBaseHead(ticketKey) ||
        ((pr && pr.head && (pr.head.sha || pr.head)) || null);
}

/** Best-effort rejection comment on the PR — a post failure never rethrows. */
function postRejectionComment(scm, prNumber, message) {
    try {
        scm.addComment(prNumber, message);
    } catch (e) {
        console.warn('Failed to post owned-violations rejection comment on PR #' + prNumber + ':', e.message || e);
    }
}

/** Marks the leg failed: PR comment + an EMPTY lap marker (pushed 0) for the loop guard. */
function handleOwnedViolationsRejected(scm, ticketKey, pr, violations, verdict) {
    var message = buildOwnedViolationsRejectedComment(violations, verdict);
    console.error('❌ Rework rejected — owned CI violations not accounted: ' +
        (verdict.errors || []).join(' | '));
    postRejectionComment(scm, pr.number, message);
    // gh-957: the leg closed without an owned fix — it counts as an empty lap
    // regardless of any WIP housekeeping commits that were pushed.
    postLapMarker(scm, pr.number, lapMarkerHeadOf(ticketKey, pr), false, 0);
    return {
        success: false,
        path: 'owned-violations-rejected',
        ticketKey: ticketKey,
        error: 'Owned CI violations not accounted in the rework summary: ' +
            (verdict.errors || []).join(' | ')
    };
}

/**
 * gh-1119 AC6 gate: validates the fix summary against the owned violations
 * the setup snapshot recorded. Rejection is the failure path — the leg is
 * marked failed and the no-op loop guard counts it.
 */
function runOwnedViolationsGate(ticketKey, config, scm, tracker, pr, fixSummary) {
    var violations;
    try {
        violations = readInputViolations(ticketKey, config && config.workingDir);
    } catch (e) {
        violations = [];
    }
    if (!violations || violations.length === 0) return { rejected: false };
    var verdict = ciViolations.validateOwnedViolationsSummary(fixSummary, violations);
    if (verdict.ok) {
        console.log('✅ Owned CI violations accounted in the rework summary (' +
            ciViolations.ownedViolations(violations).length + ' owned)');
        return { rejected: false };
    }
    return {
        rejected: true,
        result: handleOwnedViolationsRejected(scm, ticketKey, pr, violations, verdict)
    };
}

// gh-957 CRAP split (ratchet: action regressed 263.3 -> 288.5 against the
// released baseline): the completion tail of action extracted into small
// single-responsibility helpers. Behavior-preserving — the original block
// order, comments and log lines live on in the helpers; each is covered by
// the dedicated suite in test_pushReworkChanges.js so the ratchet stays
// under CRAP_THRESHOLD for the new functions too.

// Post general fix summary as a top-level PR comment only when there are no
// review thread replies. When replies exist, the thread replies themselves are
// sufficient; an extra top-level comment is noise — except non-blocking gate
// warnings, which are worth a short standalone comment even then, since they
// wouldn't otherwise be visible anywhere on the PR.
function hasMeaningfulSummary(fixSummary) {
    return fixSummary && fixSummary.length > 50
        && fixSummary !== '_(No fix summary generated)_';
}

function postCompletionPrComment(scm, pr, ticketKey, fixSummary, fixSummaryWithWarnings, repliesPosted, nonBlockingGateWarningBlock, codeChangesCommitted) {
    if (repliesPosted > 0) {
        console.log('ℹ️ Review thread replies posted — skipping general PR comment');
        if (nonBlockingGateWarningBlock) {
            try {
                scm.addComment(pr.number, '## ⚠️ Non-blocking gate warnings' + nonBlockingGateWarningBlock);
            } catch (e) {
                console.warn('Failed to post non-blocking gate warning comment:', e);
            }
        }
        return false;
    }
    if (codeChangesCommitted || hasMeaningfulSummary(fixSummary)) {
        return postPRComment(scm, pr.number, fixSummaryWithWarnings, ticketKey, repliesPosted);
    }
    console.log('ℹ️ No thread replies, no code changes, and no meaningful summary — skipping general PR comment');
    return false;
}

// Ticket finalization on the completion path: In Review move, initiator
// assign-back, WIP label removal, SM idempotency-label removal.
function wipLabelOf(actualParams) {
    return actualParams.metadata && actualParams.metadata.contextId
        ? actualParams.metadata.contextId + '_wip'
        : null;
}

function finalizeTicketState(tracker, ticketKey, statuses, actualParams, customParams) {
    try {
        tracker.moveToStatus(ticketKey, statuses.IN_REVIEW);
        console.log('✅ Moved', ticketKey, 'to', statuses.IN_REVIEW);
    } catch (statusError) {
        console.warn('Failed to move ticket to In Review:', statusError);
    }

    // Assign back to initiator (if provided)
    try {
        const initiatorId = actualParams.initiator;
        if (initiatorId) {
            tracker.assignTo(ticketKey, initiatorId);
            console.log('✅ Assigned ticket back to initiator');
        }
    } catch (e) {
        console.warn('Failed to assign ticket:', e);
    }

    // Remove WIP label if present
    const wipLabel = wipLabelOf(actualParams);
    if (wipLabel) {
        try {
            tracker.removeLabel(ticketKey, wipLabel);
            console.log('Removed WIP label:', wipLabel);
        } catch (e) {
            console.warn('Failed to remove WIP label:', e);
        }
    }

    // Remove SM idempotency label so the ticket can be re-triggered next cycle
    removeConfiguredLabels(tracker, ticketKey, customParams);
}

// GitHub machine loop latches. A no-op rework (no new commits since the last
// review's head) keeps the latch and goes straight back to rework — no LLM
// re-review of the unchanged head; owner rule (sticky approval): never
// re-review an approved PR.
function latchGateOpen(stickyApproved, freshReviewWanted, pr) {
    return !!(!stickyApproved && !freshReviewWanted && pr && pr.number);
}

function rearmNoopRework(scm, tracker, pr, ticketKey) {
    try {
        tracker.addLabel(ticketKey, 'agent:rework');
        console.log('✅ No-op rework: verdict head unchanged — agent:rework re-armed on ' + ticketKey);
    } catch (e) {
        console.warn('Failed to re-arm agent:rework on ' + ticketKey + ':', e.message || e);
    }
    try {
        scm.addComment(pr.number,
            '⚠️ Rework finished with **no new commits** — the previous review verdict (same head) ' +
            'still stands and its findings are unchanged. Re-review skipped (token guard); rework re-armed.');
    } catch (e) {
        console.warn('Failed to post no-op rework comment on PR #' + pr.number + ':', e.message || e);
    }
}

function noopLapDecisions(scm, tracker, pr, ticketKey, stickyApproved, freshReviewWanted, resolvedCount) {
    if (!latchGateOpen(stickyApproved, freshReviewWanted, pr)) return;
    if (resolvedCount === 0) {
        rearmNoopRework(scm, tracker, pr, ticketKey);
        return;
    }
    console.log('ℹ️ No-op push but ' + resolvedCount + ' thread(s) resolved this lap (gh-957 audit-resolve)' +
        ' — agent:rework NOT re-armed; the threadsResolved sweep owns the next step');
}

function stickyApprovalNotice(scm, pr, stickyApproved) {
    if (stickyApproved && pr && pr.number) {
        // Owner rule (sticky approval): never re-review an approved PR.
        // The rework pushed its fixes; validation re-runs on the new
        // head and merge-validated closes the loop. Keep BOTH latches
        // (pr_approved + ai_pr_reviewed) and arm nothing.
        try {
            scm.addComment(pr.number,
                '✅ Rework finished. `pr_approved` is sticky (approved once — never re-reviewed): ' +
                'the new head re-validates and merges directly.');
        } catch (e) {
            console.warn('Failed to post sticky-approval comment on PR #' + pr.number + ':', e.message || e);
        }
        console.log('ℹ️ Sticky approval on PR #' + pr.number + ' — re-review NOT armed; re-validation + merge follow');
    }
}

function clearAiReviewedLatch(pr, freshReviewWanted, repoInfo) {
    if (freshReviewWanted && pr && pr.number && typeof github_remove_label === 'function') {
        try {
            github_remove_label({
                workspace: repoInfo.owner, repository: repoInfo.repo,
                number: pr.number, label: 'ai_pr_reviewed'
            });
            console.log('✅ Cleared ai_pr_reviewed on PR #' + pr.number + ' — fresh review armed');
        } catch (e) {
            console.warn('Failed to clear ai_pr_reviewed on PR #' + pr.number + ':', e.message || e);
        }
    }
}

// Auto-start pr_review after rework is pushed to In Review (opt-in via customParams).
function ticketOf(params, actualParams) {
    return actualParams.ticket || (params.jobParams && params.jobParams.ticket);
}

function autoStartReviewSkipReason(freshReviewWanted, stickyApproved, ticket) {
    if (!freshReviewWanted) return 'rework pushed no new commits (token guard)';
    if (stickyApproved) return 'pr_approved is sticky on the PR (owner rule 2026-09-21)';
    if (hasPrApprovedLabel(ticket)) return 'ticket has pr_approved label';
    return null;
}

function triggerAutoStartReview(ticketKey, customParams, config, reviewConfigFile, scm) {
    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: ticketKey,
            customParams: customParams,
            config: config,
            configFile: reviewConfigFile,
            label: 'pr_review',
            scm: scm,
            stripKeys: [
                'removeLabel',
                'autoStartReview',
                'autoStartReviewConfigFile'
            ]
        });
    } catch (e) {
        console.warn('⚠️ autoStartReview trigger failed:', e.message || e);
        return false;
    }
}

function runAutoStartReview(scm, config, ticketKey, params, actualParams, customParams, freshReviewWanted, stickyApproved) {
    var reviewStarted = false;
    var reviewConfigFile = customParams && customParams.autoStartReviewConfigFile;
    if (!(customParams && customParams.autoStartReview && reviewConfigFile)) {
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams, scm: scm });
        return false;
    }
    var skipReason = autoStartReviewSkipReason(freshReviewWanted, stickyApproved, ticketOf(params, actualParams));
    if (skipReason) {
        console.log('ℹ️ autoStartReview: skipped — ' + skipReason);
    } else {
        reviewStarted = triggerAutoStartReview(ticketKey, customParams, config, reviewConfigFile, scm);
    }
    if (!reviewStarted) {
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams, scm: scm });
    }
    return reviewStarted;
}

function cacheCompletionArtifacts(params) {
    try { cacheToReleases.action(params); } catch (e) { console.warn('⚠️ cacheToReleases failed (non-fatal):', e); }
}

// gh-957: stamp the lap marker (head the leg started from, whether a
// real change landed, how many threads the leg resolved) — the SM
// no-op loop guard counts consecutive empty laps on one head.
function stampCompletionLapMarker(scm, pr, ticketKey, lapGate, lapResolutions) {
    postLapMarker(
        scm,
        pr.number,
        readReworkBaseHead(ticketKey) || (pr.head && (pr.head.sha || pr.head)) || null,
        lapGate.lapPushed,
        lapResolutions.resolved
    );
}

function postCompletionTokenUsage(params, ticketKey) {
    // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
    // wrote outputs/*_usage.json during the agent run. gh-1249: the
    // try/catch transport is shared with recoverMergedPRTicket.js via
    // tokenUsageComment.postRunTokenUsageSafely.
    tokenUsageComment.postRunTokenUsageSafely(params, ticketKey);
}

// ── action stage helpers (gh-1011 CRAP rework) ──────────────────────────────
// Extracted verbatim from the former action monolith. Stage order, git/SCM
// calls, tracker calls, log lines and every return shape are byte-identical
// to the inline code they replace — pinned by the characterization suite in
// js/unit-tests/test_pushReworkChanges.js. Resume outcomes are reported as
// { resume: true } so action can re-enter itself exactly where the inline
// `return action(params)` did.

// Pre-push quality + policy gates. Hard gate failures throw (they land in
// action's catch exactly like the inline throws did); non-blocking failures
// are assembled into the warning block appended to the completion comments.
function runPrePushGates(ticketKey, customParams, fixSummary) {
    var gateResult = feedbackLoop.runQualityGates({
        ticketKey: ticketKey,
        customParams: customParams,
        section: 'qualityGates'
    });
    if (!gateResult.success) {
        throw new Error('Quality gate failed before rework push: ' + gateResult.failedGate + '\n' + gateResult.error);
    }
    var policyResult = feedbackLoop.runPolicyGates({
        ticketKey: ticketKey,
        customParams: customParams,
        section: 'policyGates'
    });
    if (!policyResult.success) {
        throw new Error('Policy gate failed before rework push: ' + policyResult.failedGate + '\n' + policyResult.error);
    }

    // Non-blocking gate failures (e.g. spotbugs findings unrelated to the PR, marked
    // "blocking": false in config) don't abort the push/PR-reply flow, but should still
    // be visible to the developer/reviewer rather than silently swallowed.
    var nonBlockingGateWarnings = [].concat(
        gateResult.nonBlockingFailures || [],
        policyResult.nonBlockingFailures || []
    );
    var nonBlockingGateWarningBlock = '';
    if (nonBlockingGateWarnings.length > 0) {
        var warningLines = nonBlockingGateWarnings.map(function(f) {
            return '- **' + f.name + '**: ' + String(f.error).substring(0, 500);
        });
        nonBlockingGateWarningBlock = '\n\n⚠️ **Non-blocking gate warnings** (did not block this push):\n' + warningLines.join('\n');
        console.warn('⚠️ Non-blocking gate failures (push/replies continue):\n' + warningLines.join('\n'));
    }
    return {
        fixSummaryWithWarnings: fixSummary + nonBlockingGateWarningBlock,
        nonBlockingGateWarningBlock: nonBlockingGateWarningBlock
    };
}

// Commit and push, mapping the failure modes onto outcome objects: one
// resume attempt, then an honest failure comment + result (never a fake
// completion announcement).
function commitAndPushWithRecovery(ticketKey, config, customParams, tracker) {
    try {
        const pushResult = commitAndPush(ticketKey, config, customParams);
        return {
            resume: false,
            failed: false,
            branchName: pushResult.branch,
            codeChangesCommitted: pushResult.hasChanges
        };
    } catch (gitError) {
        console.error('Git operations failed:', gitError);
        var resume = tryResumeAgent({
            ticketKey: ticketKey,
            customParams: customParams,
            section: 'postAction',
            stage: 'rework_git_operations',
            error: gitError.toString()
        });
        if (resume.attempted) {
            return { resume: true };
        }
        try {
            var pm = commentMarkup.forTicket(ticketKey);
            tracker.postComment(
                ticketKey,
                pm.h(3, '❌ Rework Push Failed') + '\n\n' + pm.code(gitError.toString()) + '\n\nPlease check the logs and retry.'
            );
        } catch (e) {}
        return { resume: false, failed: true, error: gitError.toString() };
    }
}

// Post-publish gates run after the push. A gate-requested resume is reported
// back; otherwise the failure comment is posted and the gate error returned.
function runPostPublishGatesOrFail(ticketKey, config, customParams, tracker) {
    var postPublishGateResult = feedbackLoop.runPostPublishGates({
        ticketKey: ticketKey,
        customParams: customParams,
        section: 'postPublishGates',
        workingDir: config.workingDir || null
    });
    if (postPublishGateResult.success) {
        return { resume: false, failed: false };
    }
    var gateError = 'Post-publish quality gate failed: ' +
        postPublishGateResult.failedGate + '\n' + postPublishGateResult.error;
    if (postPublishGateResult.resumeAttempted) {
        return { resume: true };
    }
    try {
        var qm = commentMarkup.forTicket(ticketKey);
        tracker.postComment(
            ticketKey,
            qm.h(3, '❌ Rework Quality Gate Failed') + '\n\n' + qm.code(gateError) + '\n\nThe branch was pushed before running this gate. Please check the logs and retry.'
        );
    } catch (e) {}
    return { resume: false, failed: true, error: gateError };
}

// Interrupted leg (agent died mid-run, no outputs): one resume attempt, then
// the interrupted-rework handler.
function resumeOrHandleInterrupted(ticketKey, customParams, tracker, branchName, statuses, fixSummary) {
    var interruptedResume = tryResumeAgent({
        ticketKey: ticketKey,
        customParams: customParams,
        section: 'postAction',
        stage: 'rework_missing_outputs',
        error: fixSummary
    });
    if (interruptedResume.attempted) {
        return { resume: true };
    }
    return { resume: false, result: handleInterruptedRework(tracker, ticketKey, branchName, customParams, statuses) };
}

// Fatal CLI failure (non-zero exit ≠ interruption): one resume attempt, then
// the honest failure path — never a "Rework Complete" announcement
// (live 2026-09-29: exit 1 was announced as completion, the #1052 loop).
function resumeOrHandleFailedCli(ticketKey, customParams, tracker, branchName, statuses, fixSummary) {
    var failedResume = tryResumeAgent({
        ticketKey: ticketKey,
        customParams: customParams,
        section: 'postAction',
        stage: 'rework_cli_failed',
        error: String(fixSummary).substring(0, 2000)
    });
    if (failedResume.attempted) {
        return { resume: true };
    }
    return { resume: false, result: handleFailedReworkCli(tracker, ticketKey, branchName, customParams, statuses, fixSummary) };
}

// Resolve the repository — prefer targetRepository from config over the git
// remote. Throws the loud PR-LOOKUP-FAILED error when undeterminable.
function resolveRepoInfo(config, scm, ticketKey) {
    if (config.repository && config.repository.owner && config.repository.repo) {
        var fromConfig = { owner: config.repository.owner, repo: config.repository.repo };
        console.log('Using targetRepository from config:', fromConfig.owner + '/' + fromConfig.repo);
        return fromConfig;
    }
    var fromRemote = scm.getRemoteRepoInfo();
    if (!fromRemote) {
        throw new Error(PR_LOOKUP_FAILED_PREFIX +
            ' could not determine the GitHub repository (no config.repository, git remote unparsable) for ticket ' +
            ticketKey + ' — the rework PR replies/comments cannot be posted and the rework cycle is NOT closed.');
    }
    return fromRemote;
}

// Find PR to post comment. Loud failure instead of silent skip (live fa #1212,
// run 37200002499, 2026-10-04): the old silent skip left review threads
// unresolved, still moved the ticket to In Review, removed the rework labels
// and declared the cycle closed — SM re-armed rework on the same unresolved
// threads → infinite empty-lap loop.
function requirePrForTicket(scm, ticketKey, branchName) {
    const pr = findPRForTicket(scm, ticketKey);
    if (!pr) {
        console.error(PR_LOOKUP_FAILED_PREFIX + ' no Pull Request found for ticket ' + ticketKey +
            " after the rework push (branch '" + branchName + "') — PR replies/resolutions skipped;" +
            ' failing the leg instead of closing the cycle.');
        throw new Error(PR_LOOKUP_FAILED_PREFIX + ' no Pull Request found for ticket ' + ticketKey +
            " after the rework push (branch '" + branchName + "'). Review-thread replies/resolutions and the" +
            ' fix-summary comment were NOT posted; the rework cycle was NOT closed — failing loudly instead of' +
            ' silently skipping (silent skip re-arms empty rework laps forever, live fa #1212 2026-10-04).');
    }
    return pr;
}

// gh-957 audit-resolve lap gate: a pass that changed no production file while
// review threads are open is BLOCKED only when the reply coverage is
// INCOMPLETE. Full targeted-reply coverage resolves threads with the audit
// line even with zero pushed commits; incomplete coverage keeps the
// historical blocked path.
function runLapGate(ticketKey, config, codeChangesCommitted, actualParams, statuses, scm, tracker, pr, fixSummary) {
    // gh-1119 AC6: with owned CI violations open, a fix summary that dismisses
    // them ("not caused by this PR") or leaves them unaccounted fails the leg
    // BEFORE any lap/audit logic — the completion path never runs.
    var violationsGate = runOwnedViolationsGate(ticketKey, config, scm, tracker, pr, fixSummary);
    if (violationsGate.rejected) {
        return { blocked: true, result: violationsGate.result };
    }
    var realCodeChanges = hasRealCodeChanges(ticketKey, config);
    var outputOptsForCoverage = { ticketKey: ticketKey, workingDir: config.workingDir || null };
    var inputSnapshotThreads = readInputRawThreads(ticketKey, outputOptsForCoverage);
    var openInputThreads = inputSnapshotThreads.filter(isOpenThread);
    var replyCoverage = buildReplyCoverage(inputSnapshotThreads, readRepliesArray(outputOptsForCoverage).replies);
    // gh-1061 AC3: the gate denominator counts only ADDRESSABLE open threads —
    // null-id machine notices can never receive a targeted reply, so a PR
    // whose open threads are all null-id must not enter the blocked path on
    // coverage grounds (live: dmtools-dart PR #420 / gh-395 week-long loop).
    var lapGate = evaluateAuditResolveGate(realCodeChanges, codeChangesCommitted,
        replyCoverage.openCount, replyCoverage.unaddressed.length);
    if (lapGate.blocked) {
        // gh-1061 review follow-up: the blocked comment's header counts the
        // ADDRESSABLE open threads only — the same quantity the gate above
        // uses — while totalOpenCount (machine notices included) is passed
        // through so the header reconciles with the fold instead of
        // disagreeing with it.
        if (replyCoverage.totalOpenCount > replyCoverage.openCount) {
            console.log('ℹ️ ' + (replyCoverage.totalOpenCount - replyCoverage.openCount) +
                ' open thread(s) are null-id machine notices — excluded from the coverage gate denominator');
        }
        // gh-1063 review follow-up: the whole buildReplyCoverage snapshot is
        // passed as ONE coverage object — openCount/unaddressed/unaddressable/
        // totalOpenCount stay together and the call site is self-documenting.
        return {
            blocked: true,
            result: handleReworkBlocked(scm, tracker, pr, ticketKey, statuses, fixSummary,
                replyCoverage, actualParams)
        };
    }
    // gh-957 audit-resolve is live when the gate above passed with zero
    // code changes: every open thread has a targeted reply and the
    // resolve pass below closes them with the audit trail. A FAILED diff
    // probe (null) with no landed commit is treated as no-change too —
    // resolution without the audit line is never allowed on an unknown
    // tree.
    if (lapGate.auditResolve) {
        console.log('ℹ️ gh-957 audit-resolve: no code changes but ' + openInputThreads.length +
            ' open thread(s) fully covered by targeted replies — resolving with audit trail');
    }
    return { blocked: false, lapGate: lapGate };
}

// Outer-catch cleanup: one resume attempt, then best-effort error comment via
// the probed tracker provider. Never rethrows — the step fails with the
// error result exactly like the inline catch did.
function errorTicketKeyOf(params) {
    var actualParams = params.ticket ? params : (params.jobParams || params);
    return (actualParams && actualParams.ticket && actualParams.ticket.key) || null;
}

function errorCustomParamsOf(params) {
    var actualParams = params.ticket ? params : (params.jobParams || params);
    return (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
}

function resolveErrorTracker(params, customParams, tracker) {
    if (tracker) {
        return tracker;
    }
    return buildErrorTracker(params, customParams);
}

// Tracker-less error path: the failure happened before the tracker was
// probed, so rebuild one from the project config — when even that fails the
// error comment is skipped, never rethrown.
function buildErrorTracker(params, customParams) {
    try {
        return trackersModule.createTracker(
            configLoader.loadProjectConfig(params.jobParams || params), customParams);
    } catch (trackerError) {
        console.error('Failed to create tracker for error comment:', trackerError);
        return null;
    }
}

function postReworkErrorComment(errorTracker, ticketKey, error) {
    if (!errorTracker) return;
    var em = commentMarkup.forTicket(ticketKey);
    errorTracker.postComment(
        ticketKey,
        em.h(3, '❌ Rework Workflow Error') + '\n\n' + em.code(error.toString())
    );
}

function handleActionError(params, error, tracker) {
    console.error('❌ Error in pushReworkChanges:', error);
    try {
        const ticketKey = errorTicketKeyOf(params);
        if (!ticketKey) {
            return { success: false, error: error.toString() };
        }
        const customParams = errorCustomParamsOf(params);
        var resume = tryResumeAgent({
            ticketKey: ticketKey,
            customParams: customParams,
            section: 'postAction',
            stage: 'rework_post_action',
            error: error.toString()
        });
        if (resume.attempted) {
            return action(params);
        }
        postReworkErrorComment(resolveErrorTracker(params, customParams, tracker), ticketKey, error);
        return { success: false, error: error.toString() };
    } catch (e) {}
    return { success: false, error: error.toString() };
}

// gh-1137: the fix summary (the leg summary) must state which Dart SDK the
// leg verified with — `toolchain: dart <v> (CI: <pin>, match: yes|no)` — so
// format/analyzer claims are checkable against CI (live #433: a mismatched
// SDK made the leg dispute a mechanical red). No-op on failure, on non-Dart
// repos, and when the line is already carried.
function annotateFixSummary(response, config) {
    return toolchainSummary.withToolchainLine(
        response,
        { workingDir: config && config.workingDir }
    ) || '_(No fix summary generated)_';
}

// ── action stage helpers (gh-1195 CRAP split) ────────────────────────────────
// Extracted verbatim from the former action prologue/ladder/tail. Stage order,
// git/SCM calls, tracker calls, log lines and every return shape are
// byte-identical to the inline code they replace — pinned by the action
// characterization suites in js/unit-tests/test_pushReworkChanges.js.

// The setup prologue: resolve params, project config, SCM, custom params, the
// fix summary and the statuses — in exactly the order action used to.
function actionSetup(params) {
    const actualParams = params.ticket ? params : (params.jobParams || params);
    const ticketKey = actualParams.ticket.key;
    currentInputFolderName = runInputFolderName(params, actualParams);
    resolvedInputFolder = null;
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var scm = scmModule.createScm(config);
    const customParams = resolveCustomParams(params, actualParams, config);
    const fixSummary = annotateFixSummary(actualParams.response, config);
    const statuses = resolveStatuses(customParams, config.jira && config.jira.statuses);
    return {
        actualParams: actualParams,
        ticketKey: ticketKey,
        config: config,
        scm: scm,
        customParams: customParams,
        fixSummary: fixSummary,
        statuses: statuses
    };
}

// Commit and push, then the post-publish gates — each mapping its failure
// modes onto outcome objects (one resume attempt, then an honest failure).
// A resume is reported as { resume: true } so action can re-enter itself.
function pushAndPublishOrFail(ticketKey, config, customParams, tracker) {
    var pushOutcome = commitAndPushWithRecovery(ticketKey, config, customParams, tracker);
    if (pushOutcome.resume) {
        return { resume: true };
    }
    if (pushOutcome.failed) {
        return { failed: true, error: pushOutcome.error };
    }
    var publishOutcome = runPostPublishGatesOrFail(ticketKey, config, customParams, tracker);
    if (publishOutcome.resume) {
        return { resume: true };
    }
    if (publishOutcome.failed) {
        return { failed: true, error: publishOutcome.error };
    }
    return {
        branchName: pushOutcome.branchName,
        codeChangesCommitted: pushOutcome.codeChangesCommitted
    };
}

// The interrupted / failed-CLI ladder: a resume attempt then the honest
// terminal handler for each; null when the response is neither — the leg
// continues to the completion tail.
function resumeOrFailLadder(ticketKey, customParams, tracker, branchName, statuses, fixSummary) {
    if (isInterruptedReworkResponse(fixSummary)) {
        return resumeOrHandleInterrupted(ticketKey, customParams, tracker, branchName, statuses, fixSummary);
    }
    // Fatal CLI failure (non-zero exit ≠ interruption): one resume attempt,
    // then the honest failure path — never a "Rework Complete" announcement
    // (live 2026-09-29: exit 1 was announced as completion, the #1052 loop).
    if (isFailedCliReworkResponse(fixSummary)) {
        return resumeOrHandleFailedCli(ticketKey, customParams, tracker, branchName, statuses, fixSummary);
    }
    return null;
}

// The completion tail: PR lookup, lap gate, thread replies, PR/ticket
// comments, machine-loop latches, auto-start, artefact caching and the lap
// stamp — in exactly the order action used to run them.
function completeReworkLeg(params, setup, tracker, branchName, codeChangesCommitted, gateSummary) {
    var scm = setup.scm;
    var config = setup.config;
    var ticketKey = setup.ticketKey;
    var actualParams = setup.actualParams;
    var statuses = setup.statuses;
    var fixSummary = setup.fixSummary;
    var fixSummaryWithWarnings = gateSummary.fixSummaryWithWarnings;
    var nonBlockingGateWarningBlock = gateSummary.nonBlockingGateWarningBlock;

    // Find PR to post comment — prefer targetRepository from config over git remote
    var repoInfo = resolveRepoInfo(config, scm, ticketKey);
    const pr = requirePrForTicket(scm, ticketKey, branchName);
    // agents#827 + gh-957: rework only reworks — but a pass that changed no
    // production file while review threads are open is BLOCKED only when
    // the reply coverage is INCOMPLETE. A leg that put a targeted,
    // explanatory reply on EVERY open thread (already addressed on the
    // head / invalid finding) is allowed to resolve those threads with
    // the audit line (rework run URL) even with zero pushed commits —
    // a reply per thread is not a silent drop. Incomplete coverage keeps
    // the historical blocked path (threads NOT resolved, ticket Blocked)
    // and the gh-957 lap marker records the empty lap for the SM guard.
    var lapGateRun = runLapGate(ticketKey, config, codeChangesCommitted, actualParams, statuses,
        scm, tracker, pr, fixSummary);
    if (lapGateRun.blocked) {
        return lapGateRun.result;
    }
    var lapGate = lapGateRun.lapGate;
    let prCommentPosted = false;

    // Reply to each review thread and resolve it. responseText feeds the
    // gh-692 closure sweep: threads cited in the rework response MUST be
    // resolved even when review_replies.json lacks their ids. The
    // resolutions counter feeds the gh-957 lap marker.
    const lapResolutions = { resolved: 0 };
    const repliesPosted = postThreadReplies(scm, pr.number, {
        ticketKey: ticketKey,
        workingDir: config.workingDir || null,
        responseText: fixSummary,
        resolutions: lapResolutions,
        auditNoCodeChange: lapGate.auditResolve,
        runUrl: reworkRunUrl()
    });
    console.log('Thread replies posted:', repliesPosted);

    prCommentPosted = postCompletionPrComment(scm, pr, ticketKey, fixSummary, fixSummaryWithWarnings,
        repliesPosted, nonBlockingGateWarningBlock, codeChangesCommitted);

    finalizeTicketState(tracker, ticketKey, statuses, actualParams, setup.customParams);

    // Post completion comment to the ticket.
    // gh-799: the comment is generated from a LIVE unresolved-thread
    // re-check + verdict probe + reply coverage — never from the stale
    // input snapshot. Open threads (including mid-run arrivals) are listed
    // with per-thread accounting; "no code changes are required" only on
    // the verified-clean path.
    const prUrl = pr ? pr.html_url : null;
    postJiraComment(tracker, ticketKey, prUrl, branchName, prCommentPosted, codeChangesCommitted,
        fixSummaryWithWarnings, buildCompletionLiveState(scm, pr, ticketKey, config));

    // GitHub machine loop: the once-guard lives on the PR (ai_pr_reviewed),
    // not the issue. Clear it so the reworked head gets a FRESH review —
    // otherwise review-after-dev (notPrLabels: ai_pr_reviewed) skips the
    // PR forever and the loop stalls after one review round.
    var stickyApproved = prHasApproved(pr, actualParams.ticket || (params.jobParams && params.jobParams.ticket));
    var freshReviewWanted = !stickyApproved && headMovedSinceLastReview(scm, pr);
    stickyApprovalNotice(scm, pr, stickyApproved);
    noopLapDecisions(scm, tracker, pr, ticketKey, stickyApproved, freshReviewWanted, lapResolutions.resolved);
    clearAiReviewedLatch(pr, freshReviewWanted, repoInfo);

    runAutoStartReview(scm, config, ticketKey, params, actualParams, setup.customParams, freshReviewWanted, stickyApproved);

    // Cache configured artefacts (e.g. cosmo test reports) to GitHub Release — non-fatal
    cacheCompletionArtifacts(params);

    console.log('✅ Rework workflow completed successfully');

    stampCompletionLapMarker(scm, pr, ticketKey, lapGate, lapResolutions);
    postCompletionTokenUsage(params, ticketKey);

    return {
        success: true,
        message: ticketKey + ' rework pushed, PR commented, moved to ' + statuses.IN_REVIEW,
        branchName: branchName,
        prUrl: prUrl,
        prCommentPosted: prCommentPosted
    };
}

function action(params) {
    var tracker = null;
    try {
        var setup = actionSetup(params);
        // Probe the tracker provider once — the same script then runs unchanged
        // on Jira / ADO / GitHub deployments.
        tracker = trackersModule.createTracker(setup.config, setup.customParams);

        console.log('=== Push rework changes for:', setup.ticketKey, '===');

        // Configure git
        configureGitAuthor(setup.config);

        var gateSummary = runPrePushGates(setup.ticketKey, setup.customParams, setup.fixSummary);

        // If rework setup already failed (e.g. no PR found for this ticket), there is
        // nothing to commit/push to and no amount of CLI retrying can fix a missing PR.
        // Bail out here, before touching git at all.
        var reworkSetupFailure = readReworkSetupFailure(setup.ticketKey);
        if (reworkSetupFailure !== null) {
            return handleReworkSetupAlreadyFailed(tracker, setup.ticketKey, setup.customParams, reworkSetupFailure);
        }

        // Commit and push + post-publish gates
        var pushOutcome = pushAndPublishOrFail(setup.ticketKey, setup.config, setup.customParams, tracker);
        if (pushOutcome.resume) {
            return action(params);
        }
        if (pushOutcome.failed) {
            return { success: false, error: pushOutcome.error };
        }

        var failOutcome = resumeOrFailLadder(setup.ticketKey, setup.customParams, tracker,
            pushOutcome.branchName, setup.statuses, setup.fixSummary);
        if (failOutcome) {
            if (failOutcome.resume) {
                return action(params);
            }
            return failOutcome.result;
        }

        return completeReworkLeg(params, setup, tracker, pushOutcome.branchName,
            pushOutcome.codeChangesCommitted, gateSummary);

    } catch (error) {
        return handleActionError(params, error, tracker);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, getGitHubRepoInfo, parseGitHubRemoteUrl,
    actionSetup, pushAndPublishOrFail, resumeOrFailLadder, completeReworkLeg,
    openThreadsCompletionComment, unaddressedRepliesCompletionComment, changesRequestedCompletionComment, cleanCompletionComment, completionPrCommentSuffix,
    blockedLogLine, postBlockedPrComment, moveToBlockedStatus, removeContextWipLabel,
    hasMeaningfulSummary, isUnaddressableThread, threadShortLabel, buildUnaddressedThreadsFold, buildBlockedReworkComment, postCompletionPrComment, wipLabelOf, finalizeTicketState, latchGateOpen, rearmNoopRework, noopLapDecisions, stickyApprovalNotice, clearAiReviewedLatch, ticketOf, autoStartReviewSkipReason, triggerAutoStartReview, runAutoStartReview, cacheCompletionArtifacts, stampCompletionLapMarker, postCompletionTokenUsage, squashReworkWipCommits, hasRealCodeChanges, evaluateAuditResolveGate, buildAuditResolveLine, buildCombinedUntargetedComment, enrichReplyIds, resolveReplyText, postReplyAndResolve, resolveReplyThread, firstPresentId, threadRootIdOrNull, fillThreadIdFromRoot, isAddressedThread, sweepAddressedThreads, resolveCitedThreads, fetchFreshThreadsForSweep, resolveCustomParams, isInterruptedReworkResponse, isFailedCliReworkResponse, handleFailedReworkCli, postThreadReplies, commitAndPush, readReworkSetupFailure, headMovedSinceLastReview, extractCitedThreadIds, readInputRawThreads, buildThreadLookup, resolveRemainingAddressedThreads, isOpenThread, threadKeyOf, threadLabel, readRepliesArray, buildReplyCoverage, replyTargetsThread, logReplyCoverageGap, fetchLiveOpenThreads, latestConcludedVerdict, concludedReviewsSorted, selectReworkCompletionWording, buildOpenThreadAccountingBlock, buildReworkCompletionComment, buildCompletionLiveState, postJiraComment, reworkRunUrl, readReworkBaseHead, postLapMarker, parkBlockedPr, handleReworkBlocked, reworkCmdOpts, readReworkPrInfoHeadBranch, parseReworkBaseBranch, resolveReworkBaseBranch, reworkBranchMismatch, checkoutExpectedBranch, isBaseBranchViolation, baseBranchRefusalMessage, untrackRuntimeArtifactsQuietly, hasStagedChanges, buildReworkCommitMessage, commitStagedReworkChanges, squashEnabled, pushReworkBranch, assertReworkBranchSynced, squashReworkWipIfEnabled, readInputViolations, runOwnedViolationsGate, handleOwnedViolationsRejected, buildOwnedViolationsRejectedComment,
    // gh-1220: helpers extracted from the CRAP-target functions — exported for
    // direct unit testing (per-function CRAP ratchet).
    threadIdLabel, threadLocation, threadBodyExcerpt, replyMatchesThreadId, replyMatchesRootId,
    isConcludedReview, reviewSubmittedAt, compareConcludedReviewsBySubmittedAt, concludedReviewsOf,
    rawThreadSnapshotCandidates, threadsOfParsedSnapshot, readRawThreadsSnapshot, openThreadAccountingReason, openThreadAccountingLine,
    postOneThreadReply, postCombinedUntargetedComment };
}
