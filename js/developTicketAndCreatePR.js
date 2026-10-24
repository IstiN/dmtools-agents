/**
 * Develop Ticket and Create PR Action
 * Handles git operations, branch creation, commit, push, and PR creation after cursor agent development
 */

// Import common helper functions
const { extractTicketKey } = require('./common/jiraHelpers.js');
const prHelper = require('./common/pullRequest.js');
const submoduleHelper = require('./common/submodules.js');
const feedbackLoop = require('./common/feedbackLoop.js');
var configLoader = require('./configLoader.js');
var autoStart = require('./common/autoStart.js');
var outputFiles = require('./common/outputFiles.js');
const { GIT_CONFIG, STATUSES, LABELS, resolveStatuses } = require('./config.js');
var cacheToReleases = require('./cacheToReleases.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const commentMarkup = require('./common/commentMarkup.js');
const gitStaging = require('./common/gitStaging.js');
// gh-1087: quota circuit-breaker — a hard provider-quota failure (403
// usage-limit body / exhausted provider chain) parks the lane instead of
// burning a per-tick retry against the quota wall.
var quotaBreaker = require('./common/quotaCircuitBreaker.js');
var toolchainSummary = require('./common/toolchainSummary.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}

function hasPrApprovedLabel(ticket) {
    var labels = (ticket && ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
    return labels.indexOf(LABELS.PR_APPROVED) !== -1;
}

// Universal working-directory-aware wrapper for cli_execute_command.
// When config.workingDir is set (via customParams.targetRepository.workingDir),
// all git/shell commands are executed inside that directory.
var _workingDir = null;
var _scm = null;
function runCmd(args) {
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

/**
 * Clean command output from script wrapper artifacts
 * Removes "Script started/done" lines that DMTools CLI adds
 *
 * @param {string} output - Raw command output
 * @returns {string} Cleaned output
 */
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

/**
 * Generate unique branch name with collision detection
 * Appends _1, _2, _3 etc. if branch already exists locally or remotely
 */
function generateUniqueBranchName(branchPrefix, ticketKey) {
    const baseBranchName = branchPrefix + '/' + ticketKey;

    // Check if base branch exists locally or remotely
    try {
        // No blanket fetch (owner rule 2026-10-03): the remote pattern check
        // below queries the remote directly via ls-remote.
        // Check local branches
        const localBranches = runCmd({
            command: 'git branch --list "*' + baseBranchName + '*"'
        }) || '';

        // Check remote branches — direct remote query, no fetch needed.
        // gh-912: keep only real `<sha>\trefs/...` ref lines — a
        // `warning: redirecting to …` line (central-mode insteadOf origin,
        // git ≥ 2.54) must not read as "name already taken" and force a
        // bogus _1 suffix onto the first run of every ticket.
        const remoteBranches = prHelper.remoteRefLines(runCmd({
            command: 'git ls-remote --heads origin "' + baseBranchName + '*"'
        }) || '');

        const allBranches = localBranches + '\n' + remoteBranches;

        // If no branches exist with this base name, use it
        if (!allBranches.trim() || allBranches.trim() === '\n') {
            return baseBranchName;
        }

        // Try with suffixes _1, _2, _3, etc.
        for (let i = 1; i <= 10; i++) {
            const candidateName = baseBranchName + '_' + i;
            if (allBranches.indexOf(candidateName) === -1) {
                return candidateName;
            }
        }

        // Fallback: use timestamp suffix if too many collisions
        const timestamp = Date.now();
        return baseBranchName + '_' + timestamp;

    } catch (error) {
        console.warn('Error checking existing branches, using base name:', error);
        return baseBranchName;
    }
}

/**
 * Configure git author for AI Teammate commits
 *
 * @returns {boolean} True if successful
 */
function configureGitAuthor(config) {
    try {
        runCmd({
            command: 'git config user.name "' + config.git.authorName + '"'
        });

        runCmd({
            command: 'git config user.email "' + config.git.authorEmail + '"'
        });

        console.log('✅ Configured git author as AI Teammate');
        return true;

    } catch (error) {
        console.error('Failed to configure git author:', error);
        return false;
    }
}

/**
 * Push already-committed changes to remote (used when CLI agent committed its own work).
 */
function performPushOnly(branchName, baseBranch) {
    console.log('Pushing pre-committed changes to remote...');
    var syncResult = prHelper.syncBranchWithBase({
        branchName: branchName,
        baseBranch: baseBranch || 'main',
        workingDir: _workingDir,
        runCommand: function (command, workingDir) {
            var args = { command: command };
            if (workingDir) args.workingDirectory = workingDir;
            return cli_execute_command(args);
        }
    });
    if (!syncResult.success) {
        return { success: false, isMergeSyncFailure: true, error: syncResult.error };
    }

    // gh-1190: the push attempt + failure detection reuse the gh-1003
    // helpers (pushBranchToRemote / detectPushFailure) — identical soft-
    // rejection markers and exception handling as the original inline chain.
    var pushAttempt = pushBranchToRemote(function (command) { return runCmd({ command: command }); }, branchName);
    if (detectPushFailure(pushAttempt.output, pushAttempt.threw)) {
        var forceRetry = retryForcePushAfterRejection(branchName);
        if (forceRetry) return forceRetry;
    }

    var lsRemote = runCmd({ command: 'git ls-remote --heads origin ' + branchName }) || '';
    if (branchMissingOnRemote(lsRemote, branchName)) {
        return { success: false, isPushFailure: true, error: 'Branch not found on remote after push' };
    }

    console.log('✅ Push-only git operations completed successfully');
    return { success: true, branchName: branchName };
}

/**
 * gh-1190: the hard-rejection markers shared by the --force retry check in
 * performPushOnly — detectPushFailure's marker list minus the two soft
 * signals ('non-fast-forward' and the generic 'rejected') a force push is
 * allowed to produce on a legitimately diverged branch.
 */
function isHardPushRejection(output) {
    var markers = ['remote rejected', 'GH013', 'error: failed to push', 'push declined'];
    for (var i = 0; i < markers.length; i++) {
        if (output.indexOf(markers[i]) !== -1) {
            return true;
        }
    }
    return false;
}

/**
 * gh-1190: the --force retry after a rejected push in performPushOnly (the
 * branch may have diverged from a previous interrupted run). Returns the
 * failure result when the force push is still hard-rejected, null when the
 * retry went through (the caller proceeds to the remote verification).
 */
function retryForcePushAfterRejection(branchName) {
    console.log('Push rejected — retrying with --force...');
    var forceOutput = '';
    try {
        forceOutput = runCmd({ command: 'git push -u origin ' + branchName + ' --force' }) || '';
    } catch (forceErr) {
        forceOutput = String(forceErr);
    }
    if (isHardPushRejection(forceOutput)) {
        return { success: false, isPushFailure: true, error: 'Push still rejected after force: ' + forceOutput.substring(0, 300) };
    }
    return null;
}

/**
 * gh-1003: pure commit-message sanitizer extracted from performGitOperations
 * so the escape chain is unit-testable in isolation. The replace order is
 * behaviour (each escape feeds the next), kept verbatim.
 */
function sanitizeCommitMessage(message) {
    return message
        .replace(/"/g, '\\"')
        .replace(/[><|;`$\r\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * gh-1003: `parseInt(output, 10) || 0` was repeated inside
 * performGitOperations; one named helper owns the rev-list count parsing
 * (NaN/blank → 0).
 */
function parseAheadCount(output) {
    return parseInt(output, 10) || 0;
}

/**
 * gh-1003: predicate for "does the staged diff-stat report anything" —
 * the original `!statusOutput || !statusOutput.trim()` gate, inverted so the
 * call site reads as a positive question.
 */
function hasStagedChanges(statusOutput) {
    return !!statusOutput && !!statusOutput.trim();
}

/**
 * gh-1003: push-failure detector extracted from performGitOperations.
 * `threwException` is evaluated FIRST, matching the original `||` chain
 * short-circuit: a thrown push fails without scanning the output text.
 */
function detectPushFailure(output, threwException) {
    if (threwException) {
        return true;
    }
    var markers = ['remote rejected', 'GH013', 'error: failed to push', 'push declined', 'non-fast-forward', 'rejected'];
    for (var i = 0; i < markers.length; i++) {
        if (output.indexOf(markers[i]) !== -1) {
            return true;
        }
    }
    return false;
}

/**
 * gh-1003: remote-branch presence probe extracted from performGitOperations'
 * post-push verification — same `refs/heads/<branch>` substring check.
 */
function branchMissingOnRemote(lsRemoteOutput, branchName) {
    return (lsRemoteOutput || '').indexOf('refs/heads/' + branchName) === -1;
}

/**
 * gh-1003: the `git push -u origin <branch>` attempt extracted from
 * performGitOperations. On a non-zero exit the cli tool throws; the original
 * code converted the exception to text and treated it as a failure signal —
 * preserved here via the `threw` flag.
 */
function pushBranchToRemote(runCommand, branchName) {
    try {
        return { output: runCommand('git push -u origin ' + branchName) || '', threw: false };
    } catch (pushErr) {
        // git push exits with non-zero (e.g. non-fast-forward) — cli_execute_command throws
        return { output: String(pushErr), threw: true };
    }
}

/**
 * gh-1003: `git rev-list --count` probe extracted from performGitOperations'
 * nothing-staged handling. `warnMessage` keeps the two distinct historical
 * log lines ("commits ahead of <ref>" vs "remote branch commits") byte-identical.
 */
function probeCommitsAhead(runCommand, refExpression, warnMessage) {
    var output = '';
    try {
        output = cleanCommandOutput(runCommand('git rev-list --count ' + refExpression)) || '';
    } catch (e) {
        console.warn(warnMessage, e);
    }
    return parseAheadCount(output);
}

/**
 * gh-1003: the whole "nothing staged" decision tree extracted from
 * performGitOperations: did the agent already commit (→ push-only), was the
 * branch already pushed (→ proceed to PR creation), or is there genuinely no
 * work (→ the historical no-changes error). Log lines and return shapes are
 * preserved verbatim.
 */
function resolveNothingStagedOutcome(runCommand, branchName, baseBranch) {
    var originRef = baseBranch ? 'origin/' + baseBranch : 'origin/main';
    console.log('Nothing staged — checking whether the agent already committed or pushed its work...');
    var commitsAhead = probeCommitsAhead(runCommand, originRef + '..HEAD', 'Could not check commits ahead of ' + originRef + ':');
    if (commitsAhead > 0) {
        console.log('No uncommitted changes, but branch is ' + commitsAhead + ' commit(s) ahead of ' + originRef + ' — agent already committed. Skipping commit step.');
        // Jump straight to push after syncing with the latest base branch.
        return performPushOnly(branchName, baseBranch);
    }

    // Check if the remote branch already has commits not yet in origin/main
    // (e.g. agent pushed in a previous run but was interrupted before PR creation)
    var remoteCommitsAhead = 0;
    try {
        try { runCommand(prHelper.buildOriginFetchCommand(branchName)); } catch (e) { }
        remoteCommitsAhead = probeCommitsAhead(runCommand, originRef + '..origin/' + branchName, 'Could not check remote branch commits:');
    } catch (e) {
        console.warn('Could not check remote branch commits:', e);
    }
    if (remoteCommitsAhead > 0) {
        console.log('Remote branch origin/' + branchName + ' is ' + remoteCommitsAhead + ' commit(s) ahead of ' + originRef + ' — branch already pushed. Skipping push, proceeding to PR creation.');
        // No push needed — return success so the caller proceeds to PR creation
        return { success: true, branchName: branchName };
    }

    console.warn('No changes to commit');
    return {
        success: false,
        error: 'No changes were made by the development process'
    };
}

/**
 * Stage changes, commit, and push on current branch
 *
 * @param {string} branchName - Current branch name (already checked out by preCliJSAction)
 * @param {string} commitMessage - Commit message
 * @param {string} baseBranch - Base branch used to detect existing local/remote commits
 * @param {Object} config - Resolved project config, including optional managed submodules
 * @param {Object} customParams - Runtime custom params, including optional managed submodules
 * @param {string} ticketKey - Ticket key used for managed submodule commit messages
 * @returns {Object} Result with success status and branch name
 */
function performGitOperations(branchName, commitMessage, baseBranch, config, customParams, ticketKey) {
    try {
        submoduleHelper.pushManagedSubmodules({
            run: function (command) {
                return runCmd({ command: command });
            },
            cleanOutput: cleanCommandOutput,
            config: config,
            customParams: customParams,
            ticketKey: ticketKey
        });

        try {
            // gh-628: machine-local runtime logs live inside the committed
            // .dmtools/ directory — untrack them on already-poisoned
            // branches; the staging pathspec below keeps them out going
            // forward. Shared canonical list: js/common/gitStaging.js.
            gitStaging.untrackRuntimeArtifacts(function (command) { return runCmd({ command: command }); });
        } catch (cleanupErr) {
            console.warn('Could not remove tracked Copilot session cache before staging:', cleanupErr);
        }

        // Stage all changes
        // `:!factory-kit` — the factory workflow's kit step materializes a
        // NESTED git repo at $GITHUB_WORKSPACE/factory-kit (git init + one
        // sparse checkout); staging a gitlink that "does not have a commit
        // checked out" fails the whole add with exit 128 and kills the PR
        // post-action (live gh-1000, 2026-10-03: dev leg green, "Git
        // operations failed" — no PR). Excluded like copilot-sessions.
        // `:!.dmtools/...` runtime logs (gh-628) — excluded by pathspec
        // because they live next to COMMITTED .dmtools/ files.
        // gh-683 (live fa run 37153405587): `git add` trips its
        // ignored-pathspec guard when an exclusion pathspec NAMES a path
        // that is gitignored and exists untracked — buildStagingPathspecs
        // probes each artifact with `git check-ignore` (via runCmd) and
        // omits the exclusion for paths git already ignores, so this add
        // can never hit the "paths are ignored" guard.
        // gh-1164 (live fa runs 37153882406 + 37220167230): `factory-kit`
        // goes through the same probe — a static `:!factory-kit` exclusion
        // trips the very same guard when the kit is materialized AND
        // gitignored, silently starving the leg's commits.
        // gh-729: this line is the LAST visible step before the silent 23s
        // in live fa gh-1197 (run 37234028759) — the tail must log every
        // step so a stall/kill here is diagnosable from the job log.
        console.log('Staging working tree (check-ignore probe-filtered exclusions)...');
        runCmd({
            command: 'git add . -- ' + gitStaging.buildStagingPathspecs(runCmd, ['factory-kit'])
        });

        // Check if there are changes to commit
        const statusOutput = prHelper.readStagedDiffStat(function (command) {
            return runCmd({ command: command });
        }, _workingDir);

        // gh-1003: the whole nothing-staged decision tree (agent already
        // committed / branch already pushed / genuinely nothing) lives in
        // resolveNothingStagedOutcome; the gh-729 step logging moved with it.
        if (!hasStagedChanges(statusOutput)) {
            return resolveNothingStagedOutcome(function (command) {
                return runCmd({ command: command });
            }, branchName, baseBranch);
        }

        // Commit changes — sanitize message to avoid shell metacharacter rejection
        var safeMessage = sanitizeCommitMessage(commitMessage);
        console.log('Committing changes...');
        runCmd({
            command: 'git commit -m "' + safeMessage + '"'
        });

        var syncResult = prHelper.syncBranchWithBase({
            branchName: branchName,
            baseBranch: baseBranch || 'main',
            workingDir: _workingDir,
            runCommand: function (command, workingDir) {
                var args = { command: command };
                if (workingDir) args.workingDirectory = workingDir;
                return cli_execute_command(args);
            }
        });
        if (!syncResult.success) {
            return {
                success: false,
                isMergeSyncFailure: true,
                error: syncResult.error
            };
        }

        // Push to remote
        console.log('Pushing to remote...');
        // gh-1003: the push attempt + failure detection live in
        // pushBranchToRemote / detectPushFailure — same soft-rejection markers
        // and exception handling as the original inline chain.
        const pushAttempt = pushBranchToRemote(function (command) {
            return runCmd({ command: command });
        }, branchName);
        var pushOutput = pushAttempt.output;
        const pushFailed = detectPushFailure(pushOutput, pushAttempt.threw);

        if (pushFailed) {
            return {
                success: false,
                isPushFailure: true,
                error: 'Push was rejected by remote: ' + pushOutput.substring(0, 500)
            };
        }

        // Verify branch is actually present on remote
        console.log('Verifying branch is pushed to remote...');
        const lsRemoteOutput = runCmd({
            command: 'git ls-remote --heads origin ' + branchName
        }) || '';

        // ls-remote stdout contains refs/heads/<branch> when the branch exists
        if (branchMissingOnRemote(lsRemoteOutput, branchName)) {
            return {
                success: false,
                isPushFailure: true,
                error: 'Branch was not found on remote after push'
            };
        }

        console.log('✅ Git operations completed successfully');
        return {
            success: true,
            branchName: branchName
        };

    } catch (error) {
        console.error('Git operations failed:', error);
        return {
            success: false,
            error: error.toString()
        };
    }
}

/**
 * Create Pull Request using GitHub CLI
 * Expects outputs/response.md to already exist with PR body content
 *
 * @param {string} title - PR title
 * @param {string} branchName - Branch name to use as head
 * @returns {Object} Result with success status and PR URL
 */
function createPullRequest(title, branchName, baseBranch, ticketKey) {
    console.log('Creating Pull Request...');

    function remoteBranchExists(branch) {
        var output = runCmd({ command: 'git ls-remote --heads origin ' + branch }) || '';
        return output.indexOf('refs/heads/' + branch) !== -1;
    }

    // gh-729: verify loudly — a silent missing base/head ref used to be the
    // only signal between the staging probes and the gh pr create call.
    console.log('Verifying PR branches exist on origin (base: ' + baseBranch + ', head: ' + branchName + ')...');

    try {
        if (!remoteBranchExists(baseBranch)) {
            return {
                success: false,
                error: 'PR base branch does not exist on remote: ' + baseBranch +
                    '. In two-branch mode the release/target branch must be pushed before PR creation.'
            };
        }
        if (!remoteBranchExists(branchName)) {
            return {
                success: false,
                error: 'PR head branch does not exist on remote: ' + branchName +
                    '. The development branch push did not complete successfully.'
            };
        }
    } catch (verifyErr) {
        return {
            success: false,
            error: 'Could not verify remote PR branches before PR creation: ' + verifyErr.toString()
        };
    }

    return prHelper.createPullRequest({
        title: title,
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: _workingDir,
        scm: _scm,
        // gh-737: the merge bot links approved issues to PRs ONLY via
        // 'Closes #N' in the body — guarantee the canonical line by
        // construction for every dev-leg PR.
        ticketKey: ticketKey,
        bodyFileCandidates: ['outputs/response.md'],
        defaultBody: 'Development changes.',
        runCommand: function (command, workingDir) {
            var args = { command: command };
            if (workingDir) args.workingDirectory = workingDir;
            return cli_execute_command(args);
        }
    });
}

/**
 * Post comment to Jira ticket with PR details
 *
 * @param {string} ticketKey - Ticket key
 * @param {string} prUrl - Pull Request URL
 * @param {string} branchName - Git branch name
 */
function postPRCommentToJira(ticketKey, prUrl, branchName) {
    try {
        const m = commentMarkup.forTicket(ticketKey);
        let comment = m.h(3, m.bold('Development Completed')) + '\n\n';
        comment += m.bold('Branch:') + ' ' + m.inline(branchName) + '\n';

        if (prUrl) {
            comment += m.bold('Pull Request:') + ' ' + prUrl + '\n';
        } else {
            comment += m.bold('Pull Request:') + ' Created (check GitHub for URL)\n';
        }

        comment += '\nAI Teammate has completed the implementation and created a pull request for review.';

        getTracker().postComment(ticketKey, comment);

        console.log('✅ Posted PR comment to', ticketKey);

    } catch (error) {
        console.error('Failed to post comment to Jira:', error);
    }
}

/**
 * Post error comment to Jira ticket
 *
 * @param {string} ticketKey - Ticket key
 * @param {string} stage - Stage where error occurred
 * @param {string} errorMessage - Error message
 */
function postErrorCommentToJira(ticketKey, stage, errorMessage) {
    try {
        const m = commentMarkup.forTicket(ticketKey);
        let comment = m.h(3, m.bold('Development Workflow Error')) + '\n\n';
        comment += m.bold('Stage:') + ' ' + stage + '\n';
        comment += m.bold('Error:') + ' ' + m.code(errorMessage) + '\n\n';
        comment += 'Please check the logs for more details and retry the workflow if needed.';

        getTracker().postComment(ticketKey, comment);

        console.log('Posted error comment to', ticketKey);

    } catch (error) {
        console.error('Failed to post error comment to Jira:', error);
    }
}

/**
 * Detects CLI/environment failures that a retry can never fix — e.g. the configured
 * AI_AGENT_PROVIDER binary (cursor-agent, kimi, claude, ...) is missing from the
 * runner's PATH, or AI_AGENT_PROVIDER names an unknown provider. run-agent.sh surfaces
 * these as "Command failed (exit code 127)" (127 = shell "command not found"), unlike
 * transient failures (rate limits, timeouts = exit code 124) that a resume/retry can
 * plausibly resolve. Silently resetting the ticket for retry on this class of error
 * just loops forever, since the missing tool never appears on its own.
 *
 * `cliReportedFatalError` is Teammate's own authoritative signal (params.currentCliHasFatalError,
 * set whenever cliResult.hasFatalError() is true — covers provider/network errors such as HTTP
 * 5xx that never match the regexes below) and always wins over the text heuristics: relying on
 * text-sniffing alone let those failures fall through as a plain "interrupted, will retry",
 * masking a non-retryable failure as a transient one.
 */
function isFatalCliEnvironmentError(responseText, cliReportedFatalError) {
    if (cliReportedFatalError) {
        return true;
    }
    var text = String(responseText || '');
    return /exit code 127\)/.test(text) ||
        /not found in PATH/i.test(text) ||
        /Error: unknown provider/i.test(text);
}

function postFatalCliEnvironmentErrorToJira(ticketKey, errorMessage) {
    try {
        const m = commentMarkup.forTicket(ticketKey);
        getTracker().postComment(ticketKey, m.h(3, '❌ AI CLI Environment Failure') + '\n\n' +
                'The configured AI CLI tool could not run on the runner (e.g. missing binary or misconfigured provider):\n\n' + m.code(errorMessage) + '\n\n' +
                'This is an infrastructure/setup problem, not a normal work-item issue — retrying will fail the same way until the runner environment is fixed. The job has been failed explicitly instead of silently looping on retry.');
    } catch (e) {
        console.error('Failed to post fatal CLI environment error comment:', e);
    }
}

/**
 * Posts the fatal-error comment and throws a marked Error so it propagates out of
 * action() uncaught (see the outer catch below) instead of being swallowed into the
 * usual "reset for retry" recovery path.
 */
function throwFatalCliEnvironmentError(ticketKey, errorMessage) {
    postFatalCliEnvironmentErrorToJira(ticketKey, errorMessage);
    var err = new Error('Fatal CLI/environment failure: ' + errorMessage);
    err.fatalCliEnvironment = true;
    throw err;
}

/**
 * Reads outputs/response.md (with ticketKey/workingDir candidate expansion),
 * returning null when it is missing or blank. Shared by the missing-response
 * cold-reset sites below so the read shape stays identical everywhere.
 */
function readResponseMd(ticketKey) {
    try {
        return outputFiles.readOutputFile('response.md', {
            ticketKey: ticketKey,
            workingDir: _workingDir
        });
    } catch (e) {
        return null;
    }
}

/**
 * gh-775: recovery gate for a missing/blank outputs/response.md, shared by
 * both cold-reset sites. Order is fixed by the acceptance criteria:
 *
 *   1. Fatal CLI/environment class (missing provider binary, unknown provider,
 *      fatal provider error) → throwFatalCliEnvironmentError. A resume can
 *      never fix that class, so the resume never preempts it (AC6).
 *   2. Otherwise exactly ONE bounded resume attempt re-invokes the provider
 *      wrapper with the follow-up prompt — "the verification run hung:
 *      bash_job stop it, note it, write outputs/response.md and finish" — so
 *      a session that lost time to a hung background child can still land the
 *      deliverable (AC2). Zero tracker side effects happen before the attempt
 *      resolves; the caller only reaches its comment/status/wip sequence when
 *      the deliverable is STILL missing (AC4).
 *
 * Returns the re-read response content, or null when the resume is not
 * applicable / did not land — the caller then continues into its existing
 * cold-reset path unchanged.
 */
// gh-1087: the caller's development context for the quota gate — the park
// labels the open PR and resolves jobParams config. Callers without a full
// ctx (standalone recovery) get a minimal derived one.
function quotaContextOf(ctx, ticketKey, customParams) {
    if (ctx) return ctx;
    return {
        ticketKey: ticketKey,
        customParams: customParams,
        metadata: null,
        expectedBranch: null,
        branchName: null,
        jobParams: {}
    };
}

// gh-1087 AC1/AC2 gate: runs BEFORE the fatal-environment throw and the
// bounded resume — a resume against an exhausted provider chain is a
// guaranteed 403 burn, and a quota wall is not a CLI-environment defect.
// No-op unless the failure text classifies as quota_exhausted.
function quotaParkGate(quotaCtx) {
    var quota = quotaClassificationOf(quotaCtx);
    if (quota) {
        parkQuotaExhaustedDevelopment(quotaCtx, quota);
    }
}

function recoverMissingResponse(ticketKey, customParams, developmentSummary, cliHasFatalError, cliErrorMessage, ctx) {
    var quotaCtx = quotaContextOf(ctx, ticketKey, customParams);
    quotaCtx.cliErrorMessage = cliErrorMessage;
    quotaCtx.developmentSummary = developmentSummary;
    quotaParkGate(quotaCtx);
    if (isFatalCliEnvironmentError(developmentSummary, cliHasFatalError)) {
        console.error('CLI/environment failure detected (e.g. AI CLI binary missing from PATH, or a fatal provider/network error reported by dmtools) — failing the job explicitly instead of resetting for retry.');
        throwFatalCliEnvironmentError(ticketKey, cliErrorMessage || developmentSummary);
    }
    // gh-1121: a whole-provider-chain transient outage (Provider chain
    // exhausted with only 5xx/429/network attempts — no quota/auth text)
    // gets ONE resume of the persisted fa session even when the generic
    // feedbackLoop flag is off, after a configurable backoff. The cold
    // reset below stays the fallback when the resume also fails (or is
    // explicitly opted out), and the reset comment then names the real
    // cause (providers + codes) instead of guessing a rate limit.
    var outage = providerOutageOf(cliErrorMessage, developmentSummary);
    if (outage) {
        return tryResumeForProviderOutage(ticketKey, customParams, outage, ctx);
    }
    return tryGenericResumeForMissingResponse(ticketKey, customParams);
}

// gh-1121 log labels for the outage hand-off — the honest models/codes lists
// with the same fallbacks the reset header uses (outageResetHeaderOf).
function outageModelsLabelOf(outage) {
    return (outage && outage.models && outage.models.length) ? outage.models.join(', ') : 'unknown models';
}

function outageCodesLabelOf(outage) {
    return (outage && outage.codes && outage.codes.length) ? outage.codes.join(', ') : 'n/a';
}

// gh-1121: the bounded outage resume — ONE re-invocation of the persisted fa
// session after the configured backoff (see resumeOnceForProviderOutage).
// Returns the recovered outputs/response.md content when the resume landed
// it, null to continue to the existing reset path. The classified outage is
// stashed on ctx so the reset comment can name the real cause (models+codes).
function tryResumeForProviderOutage(ticketKey, customParams, outage, ctx) {
    console.log('⏸️ Whole provider chain failed with transient errors (' +
        outageModelsLabelOf(outage) + '; codes: ' + outageCodesLabelOf(outage) + ') — classified provider_transient (gh-1121).');
    if (ctx) ctx.providerOutage = outage;
    var outageResume = feedbackLoop.resumeOnceForProviderOutage({
        ticketKey: ticketKey,
        customParams: customParams
    });
    if (!outageResume.attempted) {
        console.log('Bounded outage resume not attempted (' + (outageResume.reason || 'unknown') + ') — continuing to the existing reset path.');
        return null;
    }
    var outageRecovered = readResponseMd(ticketKey);
    if (outageRecovered && outageRecovered.trim()) {
        console.log('✅ Bounded outage resume landed outputs/response.md — continuing the normal path (no cold reset).');
        return outageRecovered;
    }
    console.log('Bounded outage resume did not land outputs/response.md — continuing to the existing reset path.');
    return null;
}

// gh-75: the generic bounded resume for a missing deliverable — returns the
// recovered outputs/response.md content, or null to continue to the existing
// reset path. Split out of recoverMissingResponse for the CRAP gate.
function tryGenericResumeForMissingResponse(ticketKey, customParams) {
    var resume = feedbackLoop.resumeOnceForMissingResponse({
        ticketKey: ticketKey,
        customParams: customParams
    });
    if (!resume.attempted) {
        console.log('Bounded resume for the missing deliverable not attempted (' + (resume.reason || 'disabled') + ') — continuing to the existing reset path.');
        return null;
    }
    var recovered = readResponseMd(ticketKey);
    if (recovered && recovered.trim()) {
        console.log('✅ Bounded resume landed outputs/response.md — continuing the normal path (no cold reset).');
        return recovered;
    }
    console.log('Bounded resume did not land outputs/response.md — continuing to the existing reset path.');
    return null;
}

/**
 * Throws a marked Error so a Git-Operations failure propagates out of
 * action() and the workflow run is RED — the SM (and any human watching
 * the run list) can tell a dead dev letter from a green one.
 *
 * gh-683 (live fa run 37153405587, fa gh-1206..1210, 2026-10-03): the dev
 * leg did all the work, the staging add died on git's ignored-pathspec
 * guard, and the leg then posted the error comment, moved the ticket back
 * to Ready For Development and returned { success: true } — a silent
 * no-PR loop the conveyor could not see. resetDevelopmentForRetry() has
 * ALREADY posted the stage comment and reset the ticket before this
 * throws, so the failure stays retryable; only the run's conclusion
 * changes (green → red). Same propagation mechanism as
 * throwFatalCliEnvironmentError above.
 */
function throwGitOperationsFailure(stage, errorMessage) {
    var err = new Error('Git operations failure (' + stage + '): ' + errorMessage);
    err.gitOperationsFailure = true;
    throw err;
}

/**
 * Throws a marked Error so a Pull-Request-creation failure propagates out of
 * action() and the workflow run is RED — same mechanism and rationale as
 * throwGitOperationsFailure (gh-683).
 *
 * gh-729 (live fa gh-1197, run 37234028759, 2026-10-04): the dev leg's
 * PR-creation tail produced NO PR and the leg still reported success and
 * armed review — a missing-PR outcome must never read as plain success.
 * resetDevelopmentForRetry() has ALREADY posted the stage comment and reset
 * the ticket before this throws, so the failure stays retryable; only the
 * run's conclusion changes (green → red).
 */
function throwPrCreationFailure(stage, errorMessage) {
    var err = new Error('Pull Request creation failure (' + stage + '): ' + errorMessage);
    err.prCreationFailure = true;
    throw err;
}

/**
 * Throws a marked Error so an interrupted-agent "reset for retry" propagates
 * out of action() and the workflow run is RED — same mechanism and rationale
 * as throwGitOperationsFailure (gh-683) and throwPrCreationFailure (gh-729).
 *
 * gh-742 (live dmtools-dart gh-350, run 37316571468, 2026-10-05): the CLI
 * agent was interrupted mid-way — "outputs/response.md missing after commit —
 * CLI agent was interrupted mid-way. Resetting for retry." — and the leg then
 * returned { success: true }. The green no-PR leg read as "dev done": the
 * wrapper armed agent:review on an issue with no PR and no closing
 * explanation, and no retry ever fired. The interrupted comment + Ready For
 * Development reset have ALREADY happened before this throws, so the failure
 * stays retryable; only the run's conclusion changes (green → red), which
 * keeps the wrapper from reaching its review-arming step.
 */
function throwInterruptedReset(ticketKey) {
    var err = new Error('CLI agent interrupted mid-run — ' + ticketKey + ' was reset for retry; failing the run so a no-PR leg is not read as success (gh-742)');
    err.interruptedReset = true;
    throw err;
}

function labelsToRemove(customParams, metadata) {
    var labels = [];
    if (customParams && customParams.removeLabel) labels.push(customParams.removeLabel);
    if (customParams && Array.isArray(customParams.removeLabels)) {
        customParams.removeLabels.forEach(function (label) { labels.push(label); });
    }
    if (metadata && metadata.contextId) labels.push(metadata.contextId + '_wip');

    var seen = {};
    return labels.filter(function (label) {
        if (!label || seen[label]) return false;
        seen[label] = true;
        return true;
    });
}

function resetDevelopmentForRetry(ticketKey, statuses, customParams, metadata, stage, errorMessage) {
    postErrorCommentToJira(ticketKey, stage, errorMessage);

    try {
        getTracker().moveToStatus(ticketKey, statuses.READY_FOR_DEVELOPMENT);
        console.log('✅ Moved', ticketKey, 'to', statuses.READY_FOR_DEVELOPMENT, 'after development workflow error');
    } catch (e) {
        console.warn('Failed to move ' + ticketKey + ' to ' + statuses.READY_FOR_DEVELOPMENT + ':', e);
    }

    labelsToRemove(customParams, metadata).forEach(function (label) {
        try {
            getTracker().removeLabel(ticketKey, label);
            console.log('✅ Removed retry-blocking label:', label);
        } catch (e) {
            console.warn('Failed to remove retry-blocking label ' + label + ':', e);
        }
    });
}

function resumeDevelopmentAgent(params, ticketKey, customParams, stage, errorMessage, promptOverride) {
    // feedbackLoop.resumeAgent() itself shells out (mkdir/bash/run-agent.sh --continue).
    // If that self-invocation is ever blocked (e.g. a misconfigured CLI_ALLOWED_COMMANDS
    // whitelist) or fails for any other unexpected reason, it can throw instead of returning
    // { attempted: false }. Every call site below treats a falsy return as "could not resume"
    // and falls through to resetDevelopmentForRetry() to post an honest error comment and move
    // the ticket back to Ready For Development. An uncaught throw here would skip that recovery
    // path entirely, silently leaving the ticket stuck with no explanation. Treat any such
    // failure the same as "not resumed" so the existing reset-for-retry fallback always runs.
    try {
        return feedbackLoop.resumeAgent({
            ticketKey: ticketKey,
            customParams: customParams,
            section: 'postAction',
            stage: stage,
            error: errorMessage,
            promptOverride: promptOverride
        }).attempted;
    } catch (resumeError) {
        console.error('resumeDevelopmentAgent: feedbackLoop.resumeAgent failed unexpectedly — treating as "not resumed" so the ticket can still be reset for retry:', resumeError);
        return false;
    }
}

// ── Post-session landing guard (gh-1164) ────────────────────────────────────
// Live fa gh-1164 (runs 37153882406 + 37220167230, 2026-10-03/04): a dev agent
// did real work live, the timer autosave's staging add FAILED on every tick
// (git's ignored-pathspec guard), the work died uncommitted with the runner,
// and the NEXT leg — on a fresh branch off main, reading session memory —
// mistook main's release tip for its own work commit, declared done, and hit
// "No changes to commit": response.md claimed changes, the branch carried
// none, and the ticket moved to In Review with no PR. The guard below runs
// BEFORE the 'No Code Changes Needed' comment path: when the branch carries
// no work but the agent's response CLAIMS changes, resume the agent with a
// promptOverride telling it its changes never landed.

/**
 * True when the current branch carries dev work: commits ahead of the base
 * branch, or a non-trivial working tree (runtime artifacts and the
 * factory-kit nested repo never count — they are machine-local noise).
 */
function branchCarriesWork(baseBranch) {
    var originRef = 'origin/' + (baseBranch || 'main');
    try {
        var log = cleanCommandOutput(runCmd({ command: 'git log ' + originRef + '..HEAD --oneline' }) || '');
        if (log.trim()) return true;
    } catch (e) {
        console.warn('Landing guard: could not inspect ' + originRef + '..HEAD:', e);
    }
    try {
        var status = runCmd({ command: 'git status --porcelain' }) || '';
        var lines = status.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line.trim()) continue;
            if (gitStaging.isRuntimeArtifactStatusLine(line)) continue;
            if (/^(\?\?|A )\s+factory-kit(\/|$)/.test(line)) continue;
            // The job's own scratch output (response.md etc.) is the CLAIM,
            // never the work — an untracked outputs/ leftover must not
            // satisfy the guard on its own.
            if (/^\?\?\s+outputs\//.test(line)) continue;
            return true;
        }
    } catch (e) {
        console.warn('Landing guard: could not inspect git status:', e);
    }
    return false;
}

/**
 * True when the agent's response CLAIMS file changes were made (vs. an
 * honest "no changes needed" analysis, e.g. "the fix is already present").
 * Heuristic: a "What changed" section, or change-verbs naming concrete
 * files/paths. False negatives are safe (the ticket just follows the
 * existing no-changes comment path); the gh-1164 response shape
 * ("### What changed" + bullet list of edited files) must never slip through.
 */
function responseClaimsChanges(text) {
    if (!text) return false;
    if (/what changed/i.test(text)) return true;
    return /(created|added|modified|updated|implemented|moved|edited|deleted|rewrote|refactored)\b[^\n]*(\.`?[A-Za-z0-9_\/-]+\.(js|ts|dart|md|yaml|yml|json|java|kt|kts|swift|py|rb|go|rs|sh|gradle|xml|html|css|scss)`?|`[A-Za-z0-9_\/.-]+`)/i.test(text);
}

var LANDING_GUARD_STAGE = 'development_landing_guard';
var LANDING_GUARD_ERROR = 'Agent response claims code changes, but the branch carries none ' +
    '(no commits ahead of the base branch, clean working tree).';
var LANDING_GUARD_PROMPT = [
    'Your reported changes did not land in the git tree — the branch has no commits ahead of the base branch and the working tree is clean, but your response.md claims code changes were made.',
    '',
    'A previous session likely did the work in a different working directory or its commits were never created (e.g. staging failed silently). Session memory and main\'s tip are NOT your work — verify against the git tree itself.',
    '',
    'What to do:',
    '- Verify the working directory you are in (git rev-parse --show-toplevel, git branch --show-current).',
    '- Check whether your changes exist anywhere (git log, git status, git stash list).',
    '- Re-apply the changes from your plan/response if they are genuinely absent.',
    '- Ensure the changes are present in the working tree so they can be staged and committed by the post-action.',
    '- Update outputs/response.md to reflect what you ACTUALLY re-applied.',
    '- Do not push; the post-action will commit and push after you finish.'
].join('\n');

/**
 * Retry push after asking the agent to fix the commit
 * Used when push is rejected (e.g. GitHub push protection blocked a secret)
 *
 * @param {string} ticketKey - Jira ticket key
 * @param {string} branchName - Branch name to push
 * @param {string} pushError - Error message from the failed push
 * @returns {Object} Result with success status
 */
function retryAfterPushFailure(ticketKey, branchName, pushError) {
    console.log('Push failed — asking agent to fix commit and retrying...');

    // Write error details for the agent
    const errorFilePath = 'input/' + ticketKey + '/push_error.md';
    try {
        file_write({
            path: errorFilePath,
            content: '# Push Error — Please Fix\n\n' +
                'The git push was rejected. Error:\n\n```\n' + pushError + '\n```\n\n' +
                '**What to do:**\n' +
                '1. Identify what caused the push to be rejected (e.g. a secret/credentials file in the commit)\n' +
                '2. Remove it from the commit:\n' +
                '   ```\n' +
                '   git rm --cached <filename>\n' +
                '   git commit --amend --no-edit\n' +
                '   ```\n' +
                '3. Do NOT push — just fix the commit history\n'
        });
        console.log('Wrote push error to', errorFilePath);
    } catch (e) {
        console.warn('Could not write push_error.md:', e);
    }

    // For non-fast-forward: force push (branch diverged from remote, our local is newer)
    console.log('Retrying with force push...');
    var retryOutput = '';
    try {
        retryOutput = runCmd({ command: 'git push -u origin ' + branchName + ' --force' }) || '';
    } catch (forceErr) {
        retryOutput = String(forceErr);
    }
    var retryFailed = retryOutput.indexOf('remote rejected') !== -1 ||
        retryOutput.indexOf('GH013') !== -1 ||
        retryOutput.indexOf('error: failed to push') !== -1 ||
        retryOutput.indexOf('push declined') !== -1;

    if (retryFailed) {
        return { success: false, error: 'Push still rejected after agent fix: ' + retryOutput.substring(0, 300) };
    }

    // Verify branch is on remote
    var lsOutput = runCmd({ command: 'git ls-remote --heads origin ' + branchName }) || '';
    if (lsOutput.indexOf('refs/heads/' + branchName) === -1) {
        return { success: false, error: 'Branch not found on remote after retry push' };
    }

    console.log('✅ Push succeeded after agent fix');
    return { success: true };
}

// ── gh-930: decision helpers extracted from action() ────────────────────────
// action() used to be a ~500-line CC-125 monolith (CRAP 973.8). Each helper
// below owns ONE decision of the leg; the orchestration inside action() stays
// linear and keeps the exact order of tracker/SCM calls and log lines. Every
// helper is exercised by the leg outcome characterization suite
// (js/unit-tests/test_developTicketAndCreatePR.js).

var INITIAL_GIT_STAGES = {
    resumeStage: 'development_git_push',
    resetStage: 'Git Push (after retry)',
    retryErrorPrefix: 'Git push failed even after retry: ',
    genericResumeStage: 'development_git_operations',
    genericResetStage: 'Git Operations',
    noChanges: 'recover'
};

var GATE_FIX_GIT_STAGES = {
    resumeStage: 'gate_fix_git_push',
    resetStage: 'Gate Fix Git Push (after retry)',
    retryErrorPrefix: 'Gate fix push failed even after retry: ',
    genericResumeStage: 'gate_fix_git_operations',
    genericResetStage: 'Gate Fix Git Operations',
    // The feedback loop did not produce additional file changes; nothing to push.
    noChanges: 'log'
};

function actualParamsOf(params) {
    // Handle both Teammate workflow and standalone dmtools execution
    // - Teammate workflow: params.ticket exists directly
    // - Standalone dmtools (JSRunner): params.jobParams.ticket
    return params.ticket ? params : (params.jobParams || params);
}

function customParamsOf(params, actualParams) {
    return (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
}

function ticketDescriptorOf(actualParams) {
    return {
        ticket: actualParams.ticket,
        ticketKey: actualParams.ticket.key,
        ticketSummary: actualParams.ticket.fields.summary,
        ticketDescription: actualParams.ticket.fields.description || '',
        developmentSummary: actualParams.response || '',
        // Teammate's authoritative CLI-outcome signal — see isFatalCliEnvironmentError().
        cliHasFatalError: actualParams.currentCliHasFatalError === true,
        cliErrorMessage: actualParams.currentCliErrorMessage || null,
        metadata: actualParams.metadata,
        initiator: actualParams.initiator
    };
}

function initDevelopmentContext(params) {
    var actualParams = actualParamsOf(params);
    // paramsForConfigLoad re-attaches params.ticket (sibling of jobParams in the
    // real Teammate execution path) so baseBranchResolverFnPath can key off the
    // ticket's fixVersion — see configLoader.js for details.
    var config = configLoader.loadProjectConfig(configLoader.paramsForConfigLoad(params));
    _workingDir = config.workingDir || null;
    _scm = configLoader.createScm(config);
    var customParams = customParamsOf(params, actualParams);
    initTracker(config, customParams);
    var ctx = ticketDescriptorOf(actualParams);
    // gh-1087: park label name + probe cadence are jobParams config.
    ctx.jobParams = params.jobParams || {};
    // Resolve statuses — allows per-project overrides via customParams.customStatuses
    ctx.customParams = customParams;
    ctx.statuses = resolveStatuses(customParams, config.jira && config.jira.statuses);
    ctx.config = config;
    ctx.expectedBranch = configLoader.resolveBranchName(config, params.ticket || actualParams.ticket, 'development');
    console.log('Processing development workflow for ticket:', ctx.ticketKey);
    console.log('Ticket summary:', ctx.ticketSummary);
    return ctx;
}

function findOpenPrForBranch(scm, branchName) {
    var openPrs = scm.listPrs('open') || [];
    return openPrs.filter(function (pr) {
        return pr && pr.head && pr.head.ref === branchName;
    })[0];
}

function reuseOpenPrResult(ctx, existingPr) {
    var existingUrl = existingPr.html_url || existingPr.url || '';
    console.log('⚠️  PR already open for', ctx.ticketKey, ':', existingUrl || ('#' + existingPr.number), '— skipping re-development');
    var m = commentMarkup.forTicket(ctx.ticketKey);
    try {
        getTracker().postComment(ctx.ticketKey, m.h(3, 'ℹ️ PR Already Open') + '\n\n' +
                'A pull/merge request already exists for this ticket: ' + (existingUrl || ('#' + existingPr.number)) + '\n\n' +
                'Moved ticket to ' + m.bold('In Review') + ' for review.');
    } catch (e) { }
    try {
        getTracker().moveToStatus(ctx.ticketKey, ctx.statuses.IN_REVIEW);
        console.log('✅ Moved', ctx.ticketKey, 'to In Review');
    } catch (e) { console.warn('Failed to move to In Review:', e); }
    return { success: true, path: 'pr_already_open', ticketKey: ctx.ticketKey };
}

function reuseOpenPrOrLower(ctx) {
    try {
        var existingPr = findOpenPrForBranch(_scm, ctx.expectedBranch);
        if (existingPr) return reuseOpenPrResult(ctx, existingPr);
    } catch (prCheckErr) {
        console.warn('Could not check existing PRs (non-fatal):', prCheckErr);
    }
    return null;
}

function cleanStalePrApprovedLabel(ctx) {
    if (!hasPrApprovedLabel(ctx.ticket)) return false;
    console.log('🧹 Removing stale pr_approved label from', ctx.ticketKey);
    var cleaned = false;
    try {
        getTracker().removeLabel(ctx.ticketKey, LABELS.PR_APPROVED);
        console.log('✅ Removed pr_approved from Jira ticket');
        cleaned = true;
    } catch (e) { console.warn('Could not remove pr_approved from Jira:', e); }
    // Also try to remove from source-control PR/MR if branch already has one open
    try {
        var prForCleanup = findOpenPrForBranch(_scm, ctx.expectedBranch);
        if (prForCleanup && prForCleanup.number) {
            _scm.removeLabel(prForCleanup.number, LABELS.PR_APPROVED);
            console.log('✅ Removed pr_approved from source-control PR/MR #' + prForCleanup.number);
        }
    } catch (e) { console.warn('Could not remove pr_approved from source-control PR/MR (non-fatal):', e); }
    return cleaned;
}

function ensureExpectedBranchCheckedOut(expectedBranch) {
    var rawBranchOutput = runCmd({ command: 'git branch --show-current' }) || '';
    var currentBranch = cleanCommandOutput(rawBranchOutput);
    console.log('Current branch in workingDir:', currentBranch);
    if (currentBranch === expectedBranch) return null;
    console.warn('⚠️  Branch mismatch: expected "' + expectedBranch + '" but found "' + currentBranch + '". Forcing checkout to expected branch.');
    try {
        // Try to checkout expected branch (should already exist from preCliJSAction)
        runCmd({ command: 'git checkout ' + expectedBranch });
        console.log('✅ Switched to expected branch:', expectedBranch);
        return null;
    } catch (checkoutErr) {
        console.warn('Expected branch not found, creating it:', checkoutErr);
        try {
            runCmd({ command: 'git checkout -b ' + expectedBranch });
            console.log('✅ Created and switched to branch:', expectedBranch);
            return null;
        } catch (createErr) {
            return 'Could not checkout expected branch "' + expectedBranch + '": ' + createErr;
        }
    }
}

function isNoChangesError(errorMessage) {
    return !!errorMessage && errorMessage.indexOf('No changes were made') !== -1;
}

function wipLabelFor(metadata) {
    return metadata && metadata.contextId ? metadata.contextId + '_wip' : null;
}

function removeWipLabelQuietly(ticketKey, wipLabel) {
    if (!wipLabel) return;
    try { getTracker().removeLabel(ticketKey, wipLabel); } catch (e) { }
}

function recoverPushFailure(params, ctx, gitResult, stages) {
    // Push was rejected — ask the agent to fix the commit, then retry
    var retryResult = retryAfterPushFailure(ctx.ticketKey, ctx.branchName, gitResult.error);
    if (retryResult.success) return null; // push succeeded after agent fix — continue
    if (resumeDevelopmentAgent(params, ctx.ticketKey, ctx.customParams, stages.resumeStage, retryResult.error)) {
        return { resume: true };
    }
    resetDevelopmentForRetry(ctx.ticketKey, ctx.statuses, ctx.customParams, ctx.metadata, stages.resetStage, retryResult.error);
    return { result: { success: true, path: 'development-reset-for-retry', error: stages.retryErrorPrefix + retryResult.error } };
}

function noChangesResponse(ctx) {
    var agentResponse = readResponseMd(ctx.ticketKey);
    // gh-775: response.md missing/blank AND the session may still be resumable
    // (a hung background verification job stalled the run after the real work
    // was done). Fatal CLI/environment errors are checked FIRST — a resume
    // can never fix them — then exactly ONE bounded resume attempt runs,
    // before ANY tracker side effect in the paths below.
    if (!agentResponse || !agentResponse.trim()) {
        agentResponse = recoverMissingResponse(ctx.ticketKey, ctx.customParams, ctx.developmentSummary, ctx.cliHasFatalError, ctx.cliErrorMessage, ctx);
    }
    return (agentResponse && agentResponse.trim()) ? agentResponse : null;
}

function landingGuardResume(params, ctx, agentResponse) {
    // gh-1164 landing guard: response.md claims work but the branch carries
    // none → the changes never landed (dead autosave, wrong working dir,
    // fresh-branch amnesia). Resume the agent to re-apply BEFORE declaring
    // "no code changes needed"; only when the resume is not attempted
    // (disabled/exhausted/non-recoverable) fall through to the honest
    // no-changes comment path.
    if (branchCarriesWork(ctx.prTarget) || !responseClaimsChanges(agentResponse)) return null;
    console.warn('⚠️ Landing guard: response.md claims changes but the branch carries no work — resuming the agent to re-apply them.');
    if (resumeDevelopmentAgent(params, ctx.ticketKey, ctx.customParams, LANDING_GUARD_STAGE, LANDING_GUARD_ERROR, LANDING_GUARD_PROMPT)) {
        return { resume: true };
    }
    console.warn('Landing guard: resume not attempted (disabled/exhausted/non-recoverable) — falling back to the no-changes path.');
    return null;
}

function finalizeNoChangesOutcome(ctx, agentResponse) {
    // Case A: agent finished successfully, no code changes needed.
    console.log('No git changes detected — agent completed successfully (response.md present). Treating as "no change needed".');
    try {
        getTracker().postComment(ctx.ticketKey, commentMarkup.forTicket(ctx.ticketKey).h(3, 'ℹ️ No Code Changes Needed') + '\n\nThe AI agent completed its analysis and determined no code changes are required (e.g. the fix is already present in the target branch, or the ticket was resolved by a previous change).\n\n' + commentMarkup.forTicket(ctx.ticketKey).bold('Agent analysis:') + '\n\n' + agentResponse);
    } catch (e) {
        console.warn('Failed to post agent analysis comment:', e);
    }
    try {
        getTracker().moveToStatus(ctx.ticketKey, ctx.statuses.IN_REVIEW);
        console.log('✅ Moved', ctx.ticketKey, 'to', ctx.statuses.IN_REVIEW, '(no code changes needed)');
    } catch (e) {
        console.warn('Failed to move ticket to ' + ctx.statuses.IN_REVIEW + ':', e);
    }
    removeWipLabelQuietly(ctx.ticketKey, wipLabelFor(ctx.metadata));
    return { success: true, path: 'no-changes-needed', ticketKey: ctx.ticketKey };
}

function interruptedNoChangesComment(ticketKey, outage) {
    var m = commentMarkup.forTicket(ticketKey);
    // gh-1121 AC5: name the real cause — an honest "provider outage" with the
    // failing models and codes, never a guessed "rate limit" when the chain
    // answered 5xx.
    if (outage && outage.kind === 'provider_transient') {
        return m.h(3, quotaBreaker.outageResetHeaderOf(outage)) + '\nThe whole provider chain failed with transient errors, interrupting the AI agent before it could finish. The ticket has been reset to ' + m.bold('Ready For Development') + ' and will be automatically retried.';
    }
    return m.h(3, '⏸️ Development Interrupted') + '\n\nThe AI agent was interrupted (likely hit a rate limit) before completing the implementation. The ticket has been reset to ' + m.bold('Ready For Development') + ' and will be automatically retried.';
}

function interruptedPartialWorkComment(ticketKey, branchName, outage) {
    var m = commentMarkup.forTicket(ticketKey);
    if (outage && outage.kind === 'provider_transient') {
        return m.h(3, quotaBreaker.outageResetHeaderOf(outage)) + '\nThe whole provider chain failed with transient errors, interrupting the AI agent mid-run (partial work was pushed to branch ' + m.bold(branchName) + '). The ticket has been reset to ' + m.bold('Ready For Development') + ' and will be automatically retried.\n\nThe agent can resume from the existing branch.';
    }
    return m.h(3, '⏸️ Development Interrupted') + '\n\nThe AI agent was interrupted before completing the implementation (partial work was pushed to branch ' + m.bold(branchName) + '). The ticket has been reset to ' + m.bold('Ready For Development') + ' and will be automatically retried.\n\nThe agent can resume from the existing branch.';
}

/**
 * gh-1087: shared failure-classification text contract — concatenates every
 * failure signal the leg has (Teammate's authoritative CLI error message +
 * the CLI output summary) into one text for quotaBreaker.classifyFailure.
 * Exported so the bug leg classifies byte-identically.
 */
function classifyInterruptedText(cliErrorMessage, developmentSummary) {
    return String(cliErrorMessage || '') + '\n' + String(developmentSummary || '');
}

/**
 * gh-1121: classifies the leg's failure text as a whole-provider-chain
 * transient outage (kind provider_transient) — null otherwise. Quota
 * evidence keeps priority (I1): classifyFailure never returns
 * provider_transient for a 403/quota chain, so this helper cannot divert
 * a quota wall into the outage resume.
 */
function providerOutageOf(cliErrorMessage, developmentSummary) {
    var cls = quotaBreaker.classifyFailure(classifyInterruptedText(cliErrorMessage, developmentSummary));
    return (cls && cls.kind === 'provider_transient') ? cls : null;
}

/**
 * gh-1087 AC1 gate: classifies the leg's failure text. Returns the
 * classification when the leg must be PARKED (quota_exhausted), null
 * otherwise (transient/unknown keeps the gh-742 reset-for-retry path).
 */
function quotaClassificationOf(ctx) {
    var cls = quotaBreaker.classifyFailure(classifyInterruptedText(ctx.cliErrorMessage, ctx.developmentSummary));
    return (cls && cls.kind === 'quota_exhausted') ? cls : null;
}

/**
 * gh-1087 AC2: parks the ticket's lane on a hard provider-quota failure —
 * label on the ticket (and on the open PR for the leg's branch, if one
 * exists) plus a reason comment naming the provider, the quota window and
 * the reset condition. The ticket is deliberately NOT moved: no Ready For
 * Development reset (an immediate retry is guaranteed to fail again), the
 * SM dispatch lanes skip the park label, and a bounded probe (or a human)
 * lifts the park later (AC3).
 *
 * The run still fails loudly (marked quotaPark error, same dead-letter
 * contract as gh-742) so a parked no-PR leg never reads as green success.
 */
// gh-1087 AC2: the open PR for the leg's branch (if any) carries the park
// label too, so the PR reads parked to humans and review automation.
function parkLabelOpenPr(parkLabel, branchName) {
    try {
        var pr = findOpenPrForBranch(_scm, branchName);
        if (pr && pr.number) {
            _scm.addLabel(pr.number, parkLabel);
            console.log('🅿️  Added quota park label', parkLabel, 'to PR #' + pr.number);
        }
    } catch (e) {
        console.warn('Failed to label the open PR with the quota park label (non-fatal):', e);
    }
}

function parkQuotaExhaustedDevelopment(ctx, classification) {
    var jobParams = ctx.jobParams || {};
    var parkLabel = quotaBreaker.parkLabelOf(jobParams);
    var everyN = quotaBreaker.probeEveryOf(jobParams);
    var m = commentMarkup.forTicket(ctx.ticketKey);
    try {
        getTracker().postComment(ctx.ticketKey, quotaBreaker.parkComment(m, classification, parkLabel, everyN));
    } catch (e) { }
    try {
        getTracker().addLabel(ctx.ticketKey, parkLabel);
        console.log('🅿️  Added quota park label', parkLabel, 'to', ctx.ticketKey);
    } catch (e) {
        console.warn('Failed to add quota park label ' + parkLabel + ':', e);
    }
    parkLabelOpenPr(parkLabel, ctx.expectedBranch || ctx.branchName);
    removeWipLabelQuietly(ctx.ticketKey, wipLabelFor(ctx.metadata));
    console.log('🅿️  Quota-exhausted leg parked — ticket NOT reset; the SM will skip the', parkLabel,
        'lane until the quota window resets (probe every', everyN, 'ticks) or a human removes the label.');
    throwQuotaPark(ctx.ticketKey, parkLabel);
}

/**
 * gh-1087: the marked-error twin of throwInterruptedReset — the park side
 * effects above have ALREADY happened before this throws, so only the run's
 * conclusion changes (green → red dead letter).
 */
function throwQuotaPark(ticketKey, parkLabel) {
    var err = new Error('Provider quota exhausted — ' + ticketKey + ' was parked with label ' + parkLabel +
        ' instead of reset for retry (gh-1087)');
    err.quotaPark = true;
    throw err;
}

function resetInterruptedDevelopment(ctx, commentBody) {
    // gh-1087 AC1/AC2: a hard provider-quota failure parks the lane instead
    // of resetting for retry — resetting here would re-dispatch the same leg
    // into the same exhausted provider chain on the next SM tick (per-tick
    // retry burn). Transient/unknown classifications fall through to the
    // classic gh-742 reset unchanged (AC4).
    var quota = quotaClassificationOf(ctx);
    if (quota) {
        parkQuotaExhaustedDevelopment(ctx, quota);
    }
    try {
        getTracker().postComment(ctx.ticketKey, commentBody);
    } catch (e) { }
    try {
        getTracker().moveToStatus(ctx.ticketKey, ctx.statuses.READY_FOR_DEVELOPMENT);
        console.log('✅ Moved', ctx.ticketKey, 'to Ready For Development for retry');
    } catch (e) {
        console.warn('Failed to move ticket to Ready For Development:', e);
    }
    removeWipLabelQuietly(ctx.ticketKey, wipLabelFor(ctx.metadata));
    // gh-742: ticket is reset for retry — fail the RUN so the leg
    // is a visible dead letter (not a green no-PR leg the wrapper
    // reads as "dev done" and arms review on).
    throwInterruptedReset(ctx.ticketKey);
}

function recoverNoChangesOutcome(params, ctx) {
    var agentResponse = noChangesResponse(ctx);
    if (agentResponse) {
        var guard = landingGuardResume(params, ctx, agentResponse);
        if (guard) return guard;
        return { result: finalizeNoChangesOutcome(ctx, agentResponse) };
    }
    // Case B: agent was genuinely interrupted, OR the CLI/environment itself is
    // broken (e.g. missing AI CLI binary, or a fatal provider/network error) —
    // the latter can never self-resolve via retry. The fatal class was already
    // diverted by recoverMissingResponse() above (gh-775 AC6: the resume never
    // preempts it), so this block only runs for a genuinely interrupted agent
    // whose one bounded resume attempt (if any) did not land the deliverable.
    console.log('No git changes detected AND no response.md — CLI agent was interrupted. Resetting ticket for retry.');
    resetInterruptedDevelopment(ctx, interruptedNoChangesComment(ctx.ticketKey, ctx.providerOutage));
}

function recoverGenericGitFailure(params, ctx, gitResult, stages) {
    if (resumeDevelopmentAgent(params, ctx.ticketKey, ctx.customParams, stages.genericResumeStage, gitResult.error)) {
        return { resume: true };
    }
    resetDevelopmentForRetry(ctx.ticketKey, ctx.statuses, ctx.customParams, ctx.metadata, stages.genericResetStage, gitResult.error);
    // gh-683: ticket is reset for retry — fail the RUN so the SM
    // sees a dead dev letter instead of a green no-PR leg.
    throwGitOperationsFailure(stages.genericResetStage, gitResult.error);
}

function recoverGitOutcome(params, ctx, gitResult, stages) {
    if (gitResult.success) return null;
    if (gitResult.isPushFailure) return recoverPushFailure(params, ctx, gitResult, stages);
    if (isNoChangesError(gitResult.error)) {
        if (stages.noChanges === 'log') {
            console.log('No additional changes after quality gate feedback loop — continuing to PR creation.');
            return null;
        }
        return recoverNoChangesOutcome(params, ctx);
    }
    return recoverGenericGitFailure(params, ctx, gitResult, stages);
}

function gateResetResult(ctx, stage, error) {
    resetDevelopmentForRetry(ctx.ticketKey, ctx.statuses, ctx.customParams, ctx.metadata, stage, error);
    return { success: true, path: 'development-reset-for-retry', error: error };
}

function ensureResponseForPrBody(ctx) {
    var responseContent = readResponseMd(ctx.ticketKey);
    if (!responseContent || !responseContent.trim()) {
        // gh-775: fatal CLI/environment errors are checked FIRST (a resume can
        // never fix them — AC6), then exactly ONE bounded resume attempt: the
        // session may still be alive with a hung background verification child,
        // one step away from writing the deliverable (live fa gh-1341). The
        // tracker side effects below fire only if the deliverable is still
        // missing after the attempt resolves.
        responseContent = recoverMissingResponse(ctx.ticketKey, ctx.customParams, ctx.developmentSummary, ctx.cliHasFatalError, ctx.cliErrorMessage, ctx) || responseContent;
        if (!responseContent || !responseContent.trim()) {
            // Agent was interrupted after committing partial work (e.g. outputs/rca.md) but
            // before writing response.md. Reset ticket for retry rather than posting an error.
            console.log('outputs/response.md missing after commit — CLI agent was interrupted mid-way. Resetting for retry.');
            resetInterruptedDevelopment(ctx, interruptedPartialWorkComment(ctx.ticketKey, ctx.branchName, ctx.providerOutage));
        }
    }
    // gh-1137: the PR body (the leg summary) must state which Dart SDK the leg
    // verified with — `toolchain: dart <v> (CI: <pin>, match: yes|no)` — so
    // format/analyzer claims are checkable against CI. No-op on failure, on
    // non-Dart repos, and when the agent already carried the line.
    return toolchainSummary.withToolchainLine(responseContent, { workingDir: _workingDir });
}

function recoverPrCreationFailure(params, ctx, prResult) {
    // gh-729: the reason must be visible in the JOB LOG itself — the
    // live gh-1197 leg had no error line at all between the staging
    // probes and cleanup, so the failure class (nothing-to-push vs
    // gh-error vs guard) was unknowable without re-running by hand.
    console.error('❌ Pull Request creation failed — no PR exists for ' + ctx.ticketKey + ':', prResult.error);
    if (resumeDevelopmentAgent(params, ctx.ticketKey, ctx.customParams, 'development_pr_creation', prResult.error)) {
        return { resume: true };
    }
    resetDevelopmentForRetry(ctx.ticketKey, ctx.statuses, ctx.customParams, ctx.metadata, 'Pull Request Creation', prResult.error);
    // gh-729: ticket is reset for retry — fail the RUN so a no-PR leg
    // is a visible dead letter instead of a green silent success
    // (same propagation mechanism as throwGitOperationsFailure).
    throwPrCreationFailure('Pull Request Creation', prResult.error);
}

function assignAndMoveToReview(ctx) {
    // Assign ticket to initiator
    try {
        if (ctx.initiator) {
            getTracker().assignTo(ctx.ticketKey, ctx.initiator);
            console.log('✅ Assigned ticket to initiator');
        }
    } catch (error) {
        console.warn('Failed to assign ticket to initiator:', error);
    }

    // Move ticket to In Review status
    try {
        getTracker().moveToStatus(ctx.ticketKey, ctx.statuses.IN_REVIEW);
        console.log('✅ Moved ' + ctx.ticketKey + ' to In Review');
    } catch (error) {
        console.warn('Failed to move ticket to In Review:', error);
    }
}

function applyDevelopmentOutcomeLabels(ctx) {
    // Add label to indicate AI development
    try {
        getTracker().addLabel(ctx.ticketKey, LABELS.AI_DEVELOPED);
    } catch (error) {
        console.warn('Failed to add ai_developed label:', error);
    }

    // Remove WIP label if configured (dynamically generated from contextId)
    var wipLabel = wipLabelFor(ctx.metadata);
    if (wipLabel) {
        try {
            getTracker().removeLabel(ctx.ticketKey, wipLabel);
            console.log('Removed WIP label "' + wipLabel + '" from ' + ctx.ticketKey);
        } catch (labelError) {
            console.warn('Failed to remove WIP label "' + wipLabel + '":', labelError);
        }
    }
}

function autoStartReviewConfigFileOf(customParams) {
    if (!customParams || !customParams.autoStartReview) return null;
    return customParams.autoStartReviewConfigFile || null;
}

function autoStartReviewBlockedByPrApproved(ctx, prApprovedCleaned) {
    if (!hasPrApprovedLabel(ctx.ticket) || prApprovedCleaned) return false;
    console.log('ℹ️ autoStartReview: skipped — ticket has pr_approved label');
    return true;
}

function triggerAutoStartReview(ctx, reviewConfigFile) {
    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: ctx.ticketKey,
            customParams: ctx.customParams,
            config: ctx.config,
            configFile: reviewConfigFile,
            label: 'pr_review',
            scm: _scm,
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

function maybeAutoStartReview(ctx, prApprovedCleaned) {
    // Auto-start pr_review after PR is created and ticket moved to In Review (opt-in)
    var reviewConfigFile = autoStartReviewConfigFileOf(ctx.customParams);
    if (!reviewConfigFile) return false;
    if (autoStartReviewBlockedByPrApproved(ctx, prApprovedCleaned)) return false;
    return triggerAutoStartReview(ctx, reviewConfigFile);
}

function postDevelopmentTelemetry(params, ctx) {
    // Cache configured artefacts (e.g. cosmo test reports) to GitHub Release — non-fatal
    try { cacheToReleases.action(params); } catch (e) { console.warn('⚠️ cacheToReleases failed (non-fatal):', e); }

    // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
    // wrote outputs/*_usage.json during the agent run.
    try {
        tokenUsageComment.postTokenUsageComments(ctx.ticketKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

function rethrownAsIs(error) {
    // Marked failures already performed their tracker side effects before
    // throwing — rethrow them so the run is RED and the dead leg stays
    // visible (fatal CLI environment; gh-683 / gh-729 / gh-742 dead letters;
    // gh-1087 quota park).
    return !!(error && (error.fatalCliEnvironment || error.gitOperationsFailure ||
        error.prCreationFailure || error.interruptedReset || error.quotaPark));
}

function recoverUnexpectedError(params, error) {
    // Try to reset ticket for retry instead of leaving it stuck In Development.
    try {
        var actualParams = actualParamsOf(params);
        if (actualParams && actualParams.ticket && actualParams.ticket.key) {
            var customParams = customParamsOf(params, actualParams);
            var errConfig = configLoader.loadProjectConfig(configLoader.paramsForConfigLoad(params));
            var statuses = resolveStatuses(customParams, errConfig.jira && errConfig.jira.statuses);
            if (resumeDevelopmentAgent(
                params,
                actualParams.ticket.key,
                customParams,
                'development_post_action',
                error.toString()
            )) {
                return { resume: true };
            }
            resetDevelopmentForRetry(
                actualParams.ticket.key,
                statuses,
                customParams,
                actualParams.metadata,
                'Workflow Execution',
                error.toString()
            );
        }
    } catch (commentError) {
        console.error('Failed to reset development ticket after error:', commentError);
    }
    return null;
}

// ── gh-1190: action() seam split — same calls in the same order ─────────────
// The publish pipeline and the success/failure tails moved into named
// clusters so the orchestration function stays under the CRAP gate. Log
// lines, tracker/SCM/git call order and return shapes are unchanged
// (characterization tests: js/unit-tests/test_developTicketAndCreatePR.js).

/** Git author + expected-branch checkout; a failure returns the gate-reset terminal. */
function prepareDevelopmentGitStage(ctx) {
    if (!configureGitAuthor(ctx.config)) {
        return gateResetResult(ctx, 'Git Configuration', 'Failed to configure git author');
    }

    // Always use the expected branch (ai/<ticketKey>), computed from ticket key.
    // Do NOT trust git branch --show-current — the CLI agent may have switched branches.
    // Force checkout to the expected branch before committing to prevent pushing to develop/main.
    var checkoutError = ensureExpectedBranchCheckedOut(ctx.expectedBranch);
    if (checkoutError) {
        return gateResetResult(ctx, 'Git Branch Checkout', checkoutError);
    }
    return null;
}

/** A stage outcome: { resume: true } recurses into action(), anything else is the terminal. */
function stageOutcomeOf(params, outcome) {
    if (outcome.resume) return action(params);
    return outcome.result;
}

/**
 * The publish pipeline: initial push → quality gates → policy gates →
 * gate-fix push → post-publish gates. Returns the terminal value to return
 * from action(), or null when the leg continues to PR creation.
 */
function runPublishPipeline(params, ctx, branchName, commitMessage) {
    // Push the agent's work before running quality gates.
    // If the gate feedback loop fails and cannot resume, the branch is already on remote
    // and a retry can continue from the pushed state instead of losing all changes.
    var initialOutcome = recoverGitOutcome(params, ctx,
        performGitOperations(branchName, commitMessage, ctx.prTarget, ctx.config, ctx.customParams, ctx.ticketKey),
        INITIAL_GIT_STAGES);
    if (initialOutcome) {
        return stageOutcomeOf(params, initialOutcome);
    }

    var gateResult = feedbackLoop.runQualityGates({
        ticketKey: ctx.ticketKey,
        customParams: ctx.customParams,
        section: 'qualityGates'
    });
    if (!gateResult.success) {
        return gateResetResult(ctx, 'Quality Gate', 'Quality gate failed before development publish: ' + gateResult.failedGate + '\n' + gateResult.error);
    }
    var policyResult = feedbackLoop.runPolicyGates({
        ticketKey: ctx.ticketKey,
        customParams: ctx.customParams,
        section: 'policyGates'
    });
    if (!policyResult.success) {
        return gateResetResult(ctx, 'Policy Gate', 'Policy gate failed before development publish: ' + policyResult.failedGate + '\n' + policyResult.error);
    }

    // Push any fixes the gate feedback loop applied to the working tree.
    var gateFixOutcome = recoverGitOutcome(params, ctx,
        performGitOperations(branchName, commitMessage + ' (quality gate fixes)', ctx.prTarget, ctx.config, ctx.customParams, ctx.ticketKey),
        GATE_FIX_GIT_STAGES);
    if (gateFixOutcome) {
        return stageOutcomeOf(params, gateFixOutcome);
    }

    var postPublishGateResult = feedbackLoop.runPostPublishGates({
        ticketKey: ctx.ticketKey,
        customParams: ctx.customParams,
        section: 'postPublishGates',
        workingDir: _workingDir
    });
    if (!postPublishGateResult.success) {
        if (postPublishGateResult.resumeAttempted) {
            return action(params);
        }
        return gateResetResult(ctx, 'Post-Publish Quality Gate', 'Post-publish quality gate failed: ' +
            postPublishGateResult.failedGate + '\n' + postPublishGateResult.error);
    }
    return null;
}

/** PR creation with the gh-729 failure recovery; recurses on a successful resume. */
function createDevelopmentPr(params, ctx, branchName) {
    var prTitle = configLoader.formatTemplate(ctx.config.formats.prTitle.development, { ticketKey: ctx.ticketKey, ticketSummary: ctx.ticketSummary });
    var prResult = createPullRequest(prTitle, branchName, ctx.prTarget, ctx.ticketKey);

    if (!prResult.success) {
        var prOutcome = recoverPrCreationFailure(params, ctx, prResult);
        if (prOutcome.resume) return action(params);
    }
    return prResult;
}

/** Assign → In Review → PR comment → labels → auto-start review → telemetry → success result. */
function finalizeDevelopmentSuccess(params, ctx, branchName, prResult, prApprovedCleaned) {
    assignAndMoveToReview(ctx);

    // Post comment with PR details
    postPRCommentToJira(ctx.ticketKey, prResult.prUrl, branchName);

    applyDevelopmentOutcomeLabels(ctx);

    console.log('✅ Development workflow completed successfully — PR: ' + (prResult.prUrl || '(URL not captured — PR was created)'));

    if (!maybeAutoStartReview(ctx, prApprovedCleaned)) {
        autoStart.triggerSmIfIdle({ config: ctx.config, customParams: ctx.customParams });
    }

    postDevelopmentTelemetry(params, ctx);

    return {
        success: true,
        message: 'Ticket ' + ctx.ticketKey + ' developed, committed, and PR created',
        branchName: branchName,
        prUrl: prResult.prUrl
    };
}

/**
 * The outer-catch recovery: marked failures rethrow (dead letters already
 * did their tracker side effects), an attempted resume recurses into
 * action(), anything else is the reset-for-retry "success" result.
 */
function concludeActionFailure(params, error) {
    console.error('❌ Error in development workflow:', error);

    if (rethrownAsIs(error)) {
        throw error;
    }

    var recovery = recoverUnexpectedError(params, error);
    if (recovery && recovery.resume) {
        return action(params);
    }

    return {
        success: true,
        path: 'development-reset-for-retry',
        error: error.toString()
    };
}

/**
 * Main action function - orchestrates the entire workflow
 *
 * @param {Object} params - Parameters from Teammate job
 * @param {Object} params.ticket - Jira ticket object
 * @param {string} params.response - Response content from cursor agent (development summary)
 * @param {string} params.initiator - Initiator account ID
 * @returns {Object} Result object with success status
 */
function action(params) {
    try {
        var ctx = initDevelopmentContext(params);

        // ── Early exit: PR already open for this branch ──────────────────────
        // If a PR already exists, a previous run created it but failed to move
        // the ticket to In Review. Move now and skip re-development.
        var earlyResult = reuseOpenPrOrLower(ctx);
        if (earlyResult) return earlyResult;

        // ── Clean up stale pr_approved labels from previous review cycle ────
        // When story/bug development is re-triggered (e.g. after rework or manual restart),
        // the pr_approved label from a prior review must be removed so the new review
        // cycle starts clean and onApproved triggers don't fire prematurely.
        var prApprovedCleaned = cleanStalePrApprovedLabel(ctx);

        // Configure git author and force-checkout the expected branch.
        var prepFailure = prepareDevelopmentGitStage(ctx);
        if (prepFailure) return prepFailure;
        var branchName = ctx.expectedBranch;
        ctx.branchName = branchName;
        console.log('Using branch:', branchName);

        // Prepare commit message and PR target
        var commitMessage = configLoader.formatTemplate(ctx.config.formats.commitMessage.development, { ticketKey: ctx.ticketKey, ticketSummary: ctx.ticketSummary });
        ctx.prTarget = configLoader.resolvePRTargetBranch(ctx.config, params.ticket || ctx.ticket);

        var publishTerminal = runPublishPipeline(params, ctx, branchName, commitMessage);
        if (publishTerminal) return publishTerminal;

        var responseContent = ensureResponseForPrBody(ctx);
        console.log('Using outputs/response.md as PR body (' + responseContent.length + ' characters)');

        var prResult = createDevelopmentPr(params, ctx, branchName);

        return finalizeDevelopmentSuccess(params, ctx, branchName, prResult, prApprovedCleaned);

    } catch (error) {
        return concludeActionFailure(params, error);
    }
}
// Export for dmtools standalone execution
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action, throwInterruptedReset, throwQuotaPark, recoverMissingResponse, generateUniqueBranchName,
        // gh-1087: the bug leg reuses the classification contract and the
        // quota park path entry points so both legs classify byte-identically.
        classifyInterruptedText, quotaClassificationOf, parkQuotaExhaustedDevelopment,
        // gh-1003: pure helpers extracted from performGitOperations — exported
        // for direct characterization tests.
        sanitizeCommitMessage, parseAheadCount, hasStagedChanges, detectPushFailure,
        branchMissingOnRemote, pushBranchToRemote, probeCommitsAhead, resolveNothingStagedOutcome,
        // gh-1190: performPushOnly/action seam helpers — exported for direct
        // characterization tests.
        isHardPushRejection, retryForcePushAfterRejection, performPushOnly,
        prepareDevelopmentGitStage, stageOutcomeOf, runPublishPipeline,
        createDevelopmentPr, finalizeDevelopmentSuccess, concludeActionFailure
    };
}
