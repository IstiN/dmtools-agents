/**
 * Post Test Rework Results Action (postJSAction for pr_test_automation_rework)
 * After cursor agent fixes test issues and re-runs the test:
 * 1. Reads outputs/test_automation_result.json (new test result after fixes)
 * 2. Stages testing/ folder, commits, force-pushes to existing PR branch
 * 3. Replies to and resolves PR review threads (from outputs/review_replies.json)
 * 4. Posts PR comment with fix summary
 * 5. If test passed  → moves to In Review - Passed
 * 6. If test failed  → moves to In Review - Failed (bug may have changed)
 * 7. Posts Jira comment, removes WIP label
 *
 * gh-928: the action orchestration was split into pure planners/parsers
 * (normalizeTestStatus, buildResultErrorMessage, buildPRReworkComment,
 * buildAutoPRTitle, prNumberFromUrl, buildFallbackPR, prMatchesBranch) and
 * thin executors (runPublishGates, releaseReworkLock, postReworkBodyAndComment,
 * handleReplyItem, triggerAutoStart, resumeOrReport). Side effects, call order,
 * log lines and result shapes are unchanged — characterization-tested by
 * js/unit-tests/test_postTestReworkResults.js.
 */

var configLoader = require('./configLoader.js');
var autoStart = require('./common/autoStart.js');
var feedbackLoop = require('./common/feedbackLoop.js');
var prHelper = require('./common/pullRequest.js');
var mergeState = require('./common/mergeState.js');
const { GIT_CONFIG, LABELS } = require('./config.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackersModule = require('./common/trackers.js');
var commentMarkup = require('./common/commentMarkup.js');
var shared = require('./postStoryTestAutomationShared.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackerOps = shared.createTrackerHolder(trackersModule);
var initTracker = trackerOps.initTracker;
var getTracker = trackerOps.getTracker;


/**
 * Build the "Test Rework Completed" comment in the flavor of the ticket's
 * tracker (gh-770). The template historically hard-coded Jira wiki markup
 * (h3., *bold*, {code}) and was posted via raw jira_post_comment; on a
 * GitHub-backed tracker that renders as raw text garbage.
 *
 * @param {Object} flavor - a commentMarkup flavor bag (forTicket/forFlavor)
 * @param {Object} ctx    - { passed, testStatus, branchName, prUrl, fixSummary }
 * @returns {string} the rendered comment
 */
function buildTestReworkResultComment(flavor, ctx) {
    var m = flavor;
    var statusEmoji = ctx.passed ? '✅' : '❌';
    var comment = m.h(3, '🔧 Test Rework Completed') + '\n\n' +
        m.bold('Re-run result') + ': ' + statusEmoji + ' ' + m.bold(String(ctx.testStatus).toUpperCase()) + '\n' +
        m.bold('Branch') + ': ' + m.inline(ctx.branchName) + '\n';
    if (ctx.prUrl) {
        comment += m.bold('Pull Request') + ': ' + ctx.prUrl + '\n';
    }
    comment += '\n' + ctx.fixSummary;
    return comment;
}

// cleanCommandOutput: the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function readFile(path) {
    // Canonical file_read-based reader in postStoryTestAutomationShared.js (gh-1246).
    return shared.readFileOrNull(path);
}

function readResultJson() {
    try {
        const raw = readFile('outputs/test_automation_result.json');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to parse test_automation_result.json:', e);
        return null;
    }
}

function findTestPRForTicket(scm, ticketKey) {
    try {
        const branchName = 'test/' + ticketKey;
        const openPRs = scm.listPrs('open') || [];
        const match = openPRs.filter(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName;
        });
        if (match.length > 0) return match[0];
        console.warn('No open test PR found for branch', branchName);
        return null;
    } catch (e) {
        console.error('Failed to find PR:', e);
        return null;
    }
}

// ── gh-928 pure planners/parsers ─────────────────────────────────────────────

/**
 * Normalize a raw test-result status into the canonical passed/failed token.
 * Anything else is returned verbatim (the workflow treats it as not-passed).
 */
function normalizeTestStatus(rawStatus) {
    return (rawStatus === 'pass' || rawStatus === 'passed') ? 'passed' :
           (rawStatus === 'fail' || rawStatus === 'failed') ? 'failed' :
           rawStatus;
}

/**
 * The operator-facing message for an unreadable/invalid rework result JSON.
 * Distinguishes "file missing or empty" from "present but no status field".
 */
function buildResultErrorMessage(result) {
    return !result
        ? 'Could not read outputs/test_automation_result.json — file missing or empty.'
        : 'outputs/test_automation_result.json is missing required "status" field (got: ' + JSON.stringify(result) + '). The agent must write { "status": "passed" | "failed", ... }.';
}

/** The rework WIP label follows the workflow context when one is declared. */
function resolveWipLabel(actualParams) {
    return actualParams.metadata && actualParams.metadata.contextId
        ? actualParams.metadata.contextId + '_wip'
        : 'pr_test_automation_rework_wip';
}

/** Whether an open-PR list entry points at the given branch. */
function prMatchesBranch(pr, branchName) {
    return pr.head && pr.head.ref === branchName;
}

/** "KEY Summary" title for an auto-created rework PR, degrading to the key. */
function buildAutoPRTitle(ticket, ticketKey) {
    const summary = ticket && ticket.fields ? (ticket.fields.summary || ticketKey) : ticketKey;
    return ticketKey + ' ' + summary;
}

/** Best-effort PR number from a GitHub compare URL; null when not parseable. */
function prNumberFromUrl(prUrl) {
    if (!prUrl) return null;
    var m = prUrl.match(/\/pull\/(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
}

/** Minimal PR shape built from a createPullRequest result (SCM-shape fallback). */
function buildFallbackPR(prResult, branchName) {
    return {
        number: prNumberFromUrl(prResult.prUrl),
        html_url: prResult.prUrl,
        head: { ref: branchName }
    };
}

/** The "🔧 Test Rework Complete" PR comment (GitHub Markdown). */
function buildPRReworkComment(ticketKey, testStatus, passed, prBodyContent) {
    const statusEmoji = passed ? '✅' : '❌';
    return '## 🔧 Test Rework Complete — ' + ticketKey + '\n\n' +
        '**Re-run result**: ' + statusEmoji + ' ' + testStatus.toUpperCase() + '\n\n' +
        '---\n\n' + prBodyContent;
}

// ── gh-1083: action() split — pure planners (called by the executors below) ──

/**
 * Which params shape carries the ticket (gh-1083): the ticket-shaped
 * dispatch params resolve to themselves, the jobParams-wrapped shape
 * unwraps to the jobParams body.
 */
function resolveActionContext(params) {
    var actualParams = params.ticket ? params : (params.jobParams || params);
    return { actualParams: actualParams, ticketKey: actualParams.ticket.key };
}

/** The operator-facing fix summary, degrading to the no-summary placeholder. */
function fixSummaryOf(actualParams) {
    return (actualParams && actualParams.response) || '_(No fix summary)_';
}

/** True when the rework result JSON is unreadable or carries no status. */
function isMissingResult(result) {
    return !result || !result.status;
}

/** Project config for the rework job (jobParams-wrapped or bare dispatch). */
function loadReworkProjectConfig(params) {
    return configLoader.loadProjectConfig(params.jobParams || params);
}

/** The SM idempotency label to remove after the run (null when not configured). */
function smRemoveLabelOf(customParams) {
    return (customParams && customParams.removeLabel) || null;
}

/**
 * Whether the test PR must merge the base branch before pushing (gh-1083).
 * Mirrors the original inline condition EXACTLY — strict `mergeable === false`
 * (an undefined mergeable is NOT dirty) — and a missing PR is never dirty.
 */
function decidePrIsDirty(pr) {
    if (!pr) return false;
    return pr.mergeable_state === 'dirty' || pr.mergeStateStatus === 'DIRTY' || pr.mergeable === false;
}

/** The In Review - Passed/Failed status pair for the rework outcome. */
function decideReworkTargetStatus(passed, statuses) {
    return passed
        ? { stageKey: 'IN_REVIEW_PASSED', targetStatus: statuses.IN_REVIEW_PASSED }
        : { stageKey: 'IN_REVIEW_FAILED', targetStatus: statuses.IN_REVIEW_FAILED };
}

// ── gh-1083: action() split — thin executors (side effects, unchanged order) ─

/** Missing/unreadable rework result: ⚠️ Rework Error comment + unlock. */
function reportMissingResult(ticketKey, result, config, customParams, releaseLock) {
    var errMsg = buildResultErrorMessage(result);
    console.error(errMsg);
    var tracker = trackersModule.createTracker(config, customParams);
    var mErr = commentMarkup.forTicket(ticketKey, customParams);
    try {
        tracker.postComment(
            ticketKey,
            mErr.h(3, '⚠️ Rework Error') + '\n\n' + errMsg + '\n\nCheck CI logs for the agent output.'
        );
    } catch (e) {}
    releaseLock();
    return { success: false, error: errMsg };
}

/** Configure the git author for the rework commit/push (failures ignored). */
function configureReworkGitAuthor(config) {
    try {
        cli_execute_command({ command: 'git config user.name "' + config.git.authorName + '"' });
        cli_execute_command({ command: 'git config user.email "' + config.git.authorEmail + '"' });
    } catch (e) {}
}

/** Step 2.5: the test PR for the ticket + its dirty state (with the dirty log line). */
function resolveReworkPr(scm, ticketKey, config) {
    var pr = findTestPRForTicket(scm, ticketKey);
    var prIsDirty = decidePrIsDirty(pr);
    if (pr && prIsDirty) {
        console.log('PR #' + pr.number + ' is dirty — will merge origin/' + ((config.git && config.git.baseBranch) || 'main'));
    }
    return { pr: pr, prIsDirty: prIsDirty };
}

/**
 * Step 2 git half: commitAndPush with the failure protocol — consult
 * resumeAgent once (a retry re-runs action(params)), otherwise ❌ Rework
 * Push Failed + unlock. Returns { branchName } on success or { terminal }
 * for the caller to return unchanged.
 */
function pushReworkBranch(params, ticketKey, passed, config, customParams, prIsDirty, releaseLock) {
    try {
        return { branchName: commitAndPush(ticketKey, passed, config, prIsDirty) };
    } catch (e) {
        console.error('Git operations failed:', e);
        if (resumeOrReport(ticketKey, customParams, config, 'test_rework_git_operations', '❌ Rework Push Failed', e)) {
            return { terminal: action(params) };
        }
        releaseLock();
        return { terminal: { success: false, error: e.toString() } };
    }
}

/** Step 3: thread replies, body refresh and the rework summary comment — when a PR exists. */
function publishReworkPrArtifacts(scm, pr, ticketKey, testStatus, passed, fixSummary) {
    if (!pr) {
        console.warn('No PR/MR found — skipping source-control comment');
        return;
    }
    postThreadReplies(scm, pr.number);

    // Post PR comment with fix summary + new test result (GitHub Markdown from pr_body.md)
    var prBodyContent = readFile('outputs/pr_body.md') || fixSummary;
    postReworkBodyAndComment(scm, pr, ticketKey, testStatus, passed, prBodyContent);
}

/** Step 4: move the ticket to In Review - Passed/Failed; returns the target status name. */
function moveReworkTicket(ticketKey, passed, jiraConfig) {
    var target = decideReworkTargetStatus(passed, jiraConfig.statuses);
    try {
        // gh-916: In Review - Passed/Failed can be tag-only (restricted ADO workflows) — stage-label fallback.
        var moveResult = getTracker().moveToStatusOrMark(ticketKey, target.targetStatus, target.stageKey);
        if (moveResult.moved || moveResult.marked) {
            console.log('✅ Moved', ticketKey, 'to', target.targetStatus);
        }
    } catch (e) {
        console.warn('Failed to move ticket status:', e);
    }
    return target.targetStatus;
}

/** Step 6: the flavored "Test Rework Completed" tracker comment (non-fatal on failure). */
function postReworkTrackerComment(ticketKey, config, customParams, pr, testStatus, branchName, passed, fixSummary) {
    try {
        trackersModule.createTracker(config, customParams).postComment(
            ticketKey,
            buildTestReworkResultComment(
                commentMarkup.forTicket(ticketKey, customParams),
                {
                    passed: passed,
                    testStatus: testStatus,
                    branchName: branchName,
                    prUrl: pr ? pr.html_url : null,
                    fixSummary: fixSummary
                }
            )
        );
    } catch (e) {
        console.warn('Failed to post tracker comment:', e);
    }
}

/** Token usage summary comments (outputs/*_usage.json); failures are non-fatal. */
function postReworkUsageComments(ticketKey, params) {
    // Canonical guarded wrapper in common/tokenUsageComment.js (gh-1246).
    tokenUsageComment.postUsageSummariesSafely(ticketKey, params);
}

/**
 * Outer-catch resume consult (gh-1083): mirrors the original key resolution
 * and its swallow-all wrapper — true means the caller must re-run action(params).
 */
function shouldResumeRework(params, customParams, config, error) {
    try {
        var key = (params.ticket || (params.jobParams && params.jobParams.ticket) || {}).key;
        if (key) {
            if (resumeOrReport(key, customParams, config, 'test_rework_post_action', '❌ Test Rework Error', error)) {
                return true;
            }
        }
    } catch (e) {}
    return false;
}

// ── gh-928 thin executors (side effects, unchanged order) ────────────────────

/** Quality + policy gates, in order; throws on the first failed gate. */
function runPublishGates(ticketKey, customParams) {
    var gateResult = feedbackLoop.runQualityGates({
        ticketKey: ticketKey,
        customParams: customParams,
        section: 'qualityGates'
    });
    if (!gateResult.success) {
        throw new Error('Quality gate failed before test rework publish: ' + gateResult.failedGate + '\n' + gateResult.error);
    }
    var policyResult = feedbackLoop.runPolicyGates({
        ticketKey: ticketKey,
        customParams: customParams,
        section: 'policyGates'
    });
    if (!policyResult.success) {
        throw new Error('Policy gate failed before test rework publish: ' + policyResult.failedGate + '\n' + policyResult.error);
    }
}

/** Release the rework WIP label (and the custom SM label when configured). */
function releaseReworkLock(ticketKey, wipLabel, removeLabel) {
    try { getTracker().removeLabel(ticketKey, wipLabel); } catch (e) {}
    if (removeLabel) {
        try {
            getTracker().removeLabel(ticketKey, removeLabel);
            console.log('✅ Removed SM label:', removeLabel);
        } catch (e) {}
    }
}

/** PR body refresh + rework summary comment; failures are non-fatal warns. */
function postReworkBodyAndComment(scm, pr, ticketKey, testStatus, passed, prBodyContent) {
    try {
        // gh-960: once the PR entered the merge queue (validation armed) or is
        // merged/closed, the body is final — a rewrite there lands too late for
        // GitHub to parse closing keywords (live #956/#952). The summary comment
        // is unaffected and still posts.
        if (prHelper.isPrBodyFrozen(pr)) {
            console.warn('PR #' + (pr && pr.number) + ' body is final (merge queue entered or merged) — skipping body rewrite (gh-960)');
        } else {
            updatePullRequestBody(scm, pr.number, ticketKey, testStatus, prBodyContent);
        }
        scm.addComment(pr.number, buildPRReworkComment(ticketKey, testStatus, passed, prBodyContent));
        console.log('✅ Posted rework summary to PR');
    } catch (e) {
        console.warn('Failed to post PR comment:', e);
    }
}

/** The review-thread identifier for a reply item (threadId, else discussionId). */
function replyThreadIdOf(item) {
    return item.threadId || item.discussionId;
}

/**
 * One outputs/review_replies.json entry: post the explicit thread reply
 * and/or resolve the thread. Mutates the tally; call order is list order.
 */
function handleReplyItem(scm, pullRequestId, item, tally) {
    const thread = {
        rootCommentId: item.inReplyToId,
        threadId: replyThreadIdOf(item)
    };
    const replyText = item.reply ? String(item.reply).trim() : '';

    // Only post a reply when the agent explicitly wrote one AND we have the
    // identifiers needed to reply inside the existing review thread. Without
    // rootCommentId GitHub's SCM fallback creates a generic issue comment,
    // which is what produces the huge "✅ Addressed." comment floods.
    if (replyText && item.inReplyToId) {
        try {
            scm.replyToThread(pullRequestId, thread, replyText);
            tally.posted++;
        } catch (e) {
            console.warn('Failed to reply to comment #' + item.inReplyToId + ':', e);
        }
    } else if (replyText) {
        console.log('Skipping reply for thread without rootCommentId — would become a generic issue comment');
    }

    if (item.threadId) {
        try {
            scm.resolveThread(pullRequestId, { threadId: item.threadId });
            tally.resolved++;
        } catch (e) {
            console.warn('Failed to resolve thread', item.threadId + ':', e);
        }
    }
}

function updatePullRequestBody(scm, prNumber, ticketKey, testStatus, bodyContent) {
    if (!bodyContent) return false;

    try {
        // gh-960: a pre-queue body refresh must never drop the canonical
        // 'Closes #N' line — the merge bot links approved issues by it (gh-737)
        // and GitHub parses it from the current body at any edit.
        const refreshed = '## ' + ticketKey + ' Result: ' + testStatus.toUpperCase() + '\n\n' +
            '**Latest rework result:** `' + testStatus.toUpperCase() + '`\n\n' +
            '---\n\n' + bodyContent;
        const body = prHelper.ensureClosesLine(refreshed, ticketKey);
        if (scm.updatePrBody) {
            // gh-960 rework (review thread js/postTestReworkResults.js:279):
            // updatePrBody is a live seam — _githubUpdatePrBody returns null when
            // the PATCH fails, so a null result must warn, not print a green check.
            var ok = scm.updatePrBody(prNumber, body);
            if (ok) {
                console.log('✅ Updated PR/MR body with latest test rework result');
            } else {
                console.warn('PR body update failed — summary comment still posted');
            }
            return !!ok;
        }
        console.warn('SCM provider does not support updatePrBody — posting summary comment only');
        return false;
    } catch (e) {
        console.warn('Failed to update PR body with latest rework result:', e.message || e);
        return false;
    }
}

/**
 * gh-761: canonical MERGE_HEAD probe (js/common/mergeState.js). The previous
 * local duplicate drifted — it returned true on ANY non-throwing call, so a
 * non-throwing command with empty output read as "merge in progress" and
 * silently skipped rework commits and base-branch merges. The canonical
 * probe requires non-empty output (the merge-head SHA).
 */
function isMergeInProgress() {
    return mergeState.isMergeInProgress(function (command) {
        return cli_execute_command({ command: command });
    });
}

function isSubmodulePath(path) {
    // Canonical probe in common/pullRequest.js (gh-1246) — kept as a local
    // wrapper because this module runs commands without a workingDir.
    return prHelper.isSubmodulePath(function(command) {
        return cli_execute_command({ command: command });
    }, null, path);
}

// ── gh-981 pure path classification + thin git executors ─────────────────────
// stageUnmergedPaths was CRAP 174.6. The path classification is pure
// (parse*/decide*) and pinned directly; the git side effects stay in thin
// executors called in the same order with the same commands/log lines.

/** Split a command output into trimmed, non-empty lines (path list probe). */
function parsePathList(output) {
    return cleanCommandOutput(output || '')
        .split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
}

/**
 * Extract the unique file paths still carrying conflict markers from
 * `git diff --cached --check` output, in first-seen order. Lines are matched
 * verbatim (no per-line trim) — the check output is machine-formatted.
 */
function parseConflictMarkerPaths(diffCheckOutput) {
    const filesWithMarkers = [];
    (diffCheckOutput || '').split('\n').forEach(function(line) {
        const match = line.match(/^(.+?):\d+:\s+conflict marker/);
        if (match) {
            const path = match[1].trim();
            if (filesWithMarkers.indexOf(path) === -1) filesWithMarkers.push(path);
        }
    });
    return filesWithMarkers;
}

/** testing/ paths keep our (rework/test-branch) side; everything else takes main's. */
function decideConflictSide(path) {
    return path.indexOf('testing/') === 0 ? 'ours' : 'theirs';
}

/** Resolve files that still contain conflict markers by picking one side. */
function stageConflictMarkerFiles(filesWithMarkers) {
    if (filesWithMarkers.length === 0) return;
    console.warn('⚠️ Conflict markers remain in ' + filesWithMarkers.length + ' file(s); auto-resolving');
    filesWithMarkers.forEach(function(f) {
        if (decideConflictSide(f) === 'ours') {
            console.log('  Keeping test-branch version for', f);
            cli_execute_command({ command: 'git checkout --ours -- "' + f + '"' });
        } else {
            console.log('  Keeping main version for', f);
            cli_execute_command({ command: 'git checkout --theirs -- "' + f + '"' });
        }
        cli_execute_command({ command: 'git add -- "' + f + '"' });
    });
}

/**
 * Submodule conflicts cannot be resolved with `git add` or marker cleanup.
 * For rework branches we always want the base-branch (origin/<base>) submodule
 * state; feature work should not change submodules directly.
 */
function stageSubmoduleConflicts(config, stillUnmerged) {
    const submoduleConflicts = stillUnmerged.filter(function(f) { return isSubmodulePath(f); });
    if (submoduleConflicts.length === 0) return;
    console.warn('⚠️ Submodule merge conflict(s); adopting origin/' + ((config.git && config.git.baseBranch) || 'main') + ' version:', submoduleConflicts.join(', '));
    submoduleConflicts.forEach(function(f) {
        cli_execute_command({ command: 'git checkout --theirs -- "' + f + '"' });
        cli_execute_command({ command: 'git add -- "' + f + '"' });
    });
}

function stageUnmergedPaths(config) {
    const unmerged = parsePathList(
        cli_execute_command({ command: 'git diff --name-only --diff-filter=U' })
    );

    if (unmerged.length === 0) return;

    console.log('Staging ' + unmerged.length + ' unmerged path(s):', unmerged.join(', '));
    unmerged.forEach(function(f) {
        cli_execute_command({ command: 'git add -- "' + f + '"' });
    });

    stageConflictMarkerFiles(parseConflictMarkerPaths(cleanCommandOutput(
        cli_execute_command({ command: 'git diff --cached --check' }) || ''
    )));

    const stillList = parsePathList(
        cli_execute_command({ command: 'git diff --name-only --diff-filter=U' })
    );
    if (stillList.length > 0) {
        stageSubmoduleConflicts(config, stillList);
    }

    const stillUnmerged = cleanCommandOutput(
        cli_execute_command({ command: 'git diff --name-only --diff-filter=U' }) || ''
    ).trim();
    if (stillUnmerged) {
        throw new Error('Unable to resolve merge conflicts: ' + stillUnmerged);
    }
}

function commitIfNeeded(ticketKey, passed, config) {
    const statusOutput = prHelper.readStagedDiffStat(function(command) {
        return cli_execute_command({ command: command });
    });
    const mergeInProgress = isMergeInProgress();

    if (!statusOutput.trim() && !mergeInProgress) {
        console.warn('No changes to commit in testing/ — pushing existing commits only');
        return false;
    }

    const result = passed ? 'fix' : 'update';
    const reworkCommitMsg = configLoader.formatTemplate(config.formats.commitMessage.testRework, {ticketKey: ticketKey, result: result});
    cli_execute_command({
        command: 'git commit -m "' + reworkCommitMsg.replace(/"/g, '\\"') + '"'
    });
    console.log('✅ Committed rework changes');
    return true;
}

// ── gh-1192: commitAndPush decomposed into thin git executors ────────────────
// Same commands, same order, same failure protocol — only the control flow
// moved into named units so every branch is unit-testable.

/** The current branch name (empty string when undeterminable). */
function currentBranchName() {
    return cleanCommandOutput(
        cli_execute_command({ command: 'git branch --show-current' }) || ''
    );
}

/** Guard: rework must never be committed straight to the base branch. */
function guardReworkBranch(branchName, ticketKey) {
    if (!branchName) throw new Error('Could not determine current git branch');

    if (branchName === 'main' || branchName === 'master') {
        throw new Error('Refusing to commit rework directly to "' + branchName + '". Expected test/' + ticketKey + ' branch. preCliJSAction may have failed to checkout the correct branch.');
    }
}

/** Dirty PR: commit pending test fixes, then merge the base without committing. */
function mergeBaseWhenDirty(ticketKey, passed, config, baseBranch) {
    // Commit any test fixes first so the working tree/index is clean for the merge.
    cli_execute_command({ command: 'git add testing/' });
    commitIfNeeded(ticketKey, passed, config);
    console.log('PR is dirty — starting merge of origin/' + baseBranch);
    try {
        cli_execute_command({ command: 'git merge origin/' + baseBranch + ' --no-commit --no-ff' });
    } catch (e) {
        // Conflicts are expected for a dirty PR.
    }
}

/** Push the rework branch, escalating to --force when the normal push is rejected. */
function pushReworkBranchToRemote(branchName) {
    try {
        cli_execute_command({ command: 'git push -u origin ' + branchName });
    } catch (e) {
        console.log('Normal push failed, force pushing...');
        cli_execute_command({ command: 'git push -u origin ' + branchName + ' --force' });
    }
}

/**
 * gh-912: verify the push produced a real refs/heads/<branch> ref line and
 * extract the SHA FROM THAT LINE — the old `capture.split(/\s+/)[0]` read
 * `warning:` (git ≥ 2.54 prints a redirect warning on every network
 * command against a central-mode insteadOf origin) and misreported a
 * successful push as "Push rejected".
 */
function verifyPushedBranch(localSha, branchName) {
    const remoteSha = prHelper.remoteBranchSha(function(command) {
        return cli_execute_command({ command: command });
    }, null, branchName);
    if (!remoteSha) throw new Error('Branch not found on remote after push');

    if (localSha && !remoteSha.startsWith(localSha.substring(0, 10))) {
        throw new Error('Push rejected: local HEAD ' + localSha.substring(0, 10) + ' does not match remote ' + remoteSha.substring(0, 10) + '. Branch protection may have blocked the push.');
    }
}

function commitAndPush(ticketKey, passed, config, prIsDirty) {
    const branchName = currentBranchName();
    guardReworkBranch(branchName, ticketKey);

    const baseBranch = (config.git && config.git.baseBranch) || 'main';
    console.log('Current branch:', branchName, '| base:', baseBranch, '| PR dirty:', !!prIsDirty);

    cli_execute_command({ command: 'git config user.name "' + config.git.authorName + '"' });
    cli_execute_command({ command: 'git config user.email "' + config.git.authorEmail + '"' });

    try {
        cli_execute_command({ command: 'git fetch origin ' + baseBranch });
    } catch (e) {
        console.warn('Could not fetch origin/' + baseBranch + ':', e);
    }

    var mergeInProgress = isMergeInProgress();

    if (!mergeInProgress && prIsDirty) {
        mergeBaseWhenDirty(ticketKey, passed, config, baseBranch);
    }

    // Stage test fixes and any resolved conflict files.
    cli_execute_command({ command: 'git add testing/' });
    stageUnmergedPaths(config);

    // Commit. If a merge is in progress this creates the merge commit.
    commitIfNeeded(ticketKey, passed, config);

    // Get local HEAD SHA to verify push actually succeeded
    const localSha = cleanCommandOutput(
        cli_execute_command({ command: 'git rev-parse HEAD' }) || ''
    ).substring(0, 40);

    pushReworkBranchToRemote(branchName);

    verifyPushedBranch(localSha, branchName);

    console.log('✅ Pushed to remote branch:', branchName);
    return branchName;
}

function createPRIfMissing(scm, branchName, ticketKey, config) {
    try {
        const openPRs = scm.listPrs('open') || [];
        const existing = openPRs.filter(function(pr) {
            return prMatchesBranch(pr, branchName);
        });
        if (existing.length > 0) {
            console.log('PR already exists: #' + existing[0].number);
            return existing[0];
        }

        console.log('No open PR/MR found — creating one...');
        var ticket;
        try { ticket = getTracker().getIssue(ticketKey); } catch (e) { ticket = null; }
        const prTitle = buildAutoPRTitle(ticket, ticketKey);

        const prResult = prHelper.createPullRequest({
            scm: scm,
            title: prTitle,
            branchName: branchName,
            baseBranch: config.git.baseBranch,
            // gh-737: merge bot links approved issues via 'Closes #N' — emit it
            // by construction on this auto-created rework PR.
            ticketKey: ticketKey,
            bodyContent: 'Auto-created PR after test rework.\n\nTicket: ' + ticketKey
        });
        if (prResult && prResult.success) {
            console.log('✅ Created PR for', branchName, ':', prResult.prUrl || '(URL unknown)');
            // Re-fetch so downstream code gets a consistent PR shape from the SCM.
            // CHARACTERIZED QUIRK (gh-928): findTestPRForTicket returns the PR
            // object itself, so `refreshed.pr` is undefined — a successful
            // re-fetch yields NO downstream PR today. Preserved as-is on
            // purpose; see test_postTestReworkResults.js.
            const refreshed = findTestPRForTicket(scm, ticketKey);
            if (refreshed) return refreshed.pr;
            // Fallback: build minimal shape from URL if the SCM response differs.
            return buildFallbackPR(prResult, branchName);
        }
        console.warn('Could not create PR/MR:', prResult && prResult.error);
        return null;
    } catch (e) {
        console.warn('createPRIfMissing error:', e);
        return null;
    }
}

function resolveCustomParams(params, actualParams, config) {
    var merged = {};
    var patch = configLoader.resolveInstructions(
        'pr_test_automation_rework',
        null,
        config
    ).jobParamPatch;
    if (patch && patch.customParams) {
        Object.assign(merged, patch.customParams);
    }
    Object.assign(
        merged,
        (actualParams && actualParams.customParams) ||
            (params.jobParams && params.jobParams.customParams) ||
            params.customParams ||
            {}
    );
    return merged;
}

function postThreadReplies(scm, pullRequestId) {
    const repliesJson = readFile('outputs/review_replies.json');
    if (!repliesJson) {
        console.warn('outputs/review_replies.json not found — skipping thread replies');
        return 0;
    }

    let data;
    try {
        data = JSON.parse(repliesJson);
    } catch (e) {
        console.warn('Failed to parse review_replies.json:', e);
        return 0;
    }

    const replies = (data && data.replies) ? data.replies : [];
    if (replies.length === 0) return 0;

    const tally = { posted: 0, resolved: 0 };
    replies.forEach(function(item) {
        handleReplyItem(scm, pullRequestId, item, tally);
    });

    console.log('Resolved ' + tally.resolved + '/' + replies.length + ' review thread(s); posted ' + tally.posted + ' explicit reply(ies)');
    return tally.posted;
}

/**
 * Shared failure handling for the git-operations and outer catches: consult
 * resumeAgent once; when no resume was attempted, post the flavored failure
 * comment. Returns true when the caller must re-run action(params).
 */
function resumeOrReport(ticketKey, customParams, config, stage, title, error) {
    var resume = feedbackLoop.resumeAgent({
        ticketKey: ticketKey,
        customParams: customParams,
        section: 'postAction',
        stage: stage,
        error: error.toString()
    });
    if (resume.attempted) {
        return true;
    }
    var em = commentMarkup.forTicket(ticketKey, customParams);
    trackersModule.createTracker(config, customParams).postComment(
        ticketKey,
        em.h(3, title) + '\n\n' + em.code(error.toString())
    );
    return false;
}

/** autoStartReview configured-workflow trigger, falling back to the SM idle trigger. */
function triggerAutoStart(ticketKey, customParams, config) {
    var autoStarted = shared.triggerAutoStartReviewWorkflow(autoStart, ticketKey, customParams, config, 'pr_test_automation_review');
    if (!autoStarted) {
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
    }
    return autoStarted;
}

function action(params) {
    var ctx = resolveActionContext(params);
    const actualParams = ctx.actualParams;
    const ticketKey = ctx.ticketKey;
    var config = loadReworkProjectConfig(params);
    var jiraConfig = config.jira;
    var scm = configLoader.createScm(config);
    const customParams = resolveCustomParams(params, actualParams, config);
    initTracker(config, customParams);
    const removeLabel = smRemoveLabelOf(customParams);
    const wipLabel = resolveWipLabel(actualParams);

    function releaseLock() {
        releaseReworkLock(ticketKey, wipLabel, removeLabel);
    }

    try {
        const fixSummary = fixSummaryOf(actualParams);
        console.log('=== Processing test rework results for', ticketKey, '===');

        // Step 1: Read new test result
        const result = readResultJson();
        if (isMissingResult(result)) {
            return reportMissingResult(ticketKey, result, config, customParams, releaseLock);
        }

        const rawStatus = result.status.toLowerCase();
        const testStatus = normalizeTestStatus(rawStatus);
        const passed = testStatus === 'passed';
        console.log('Re-run result:', result.status, '→ normalized:', testStatus);

        // Step 2: Configure git + commit/push testing/ only
        configureReworkGitAuthor(config);

        runPublishGates(ticketKey, customParams);

        // Step 2.5: Determine whether the test PR is dirty so the git step can merge main.
        var prState = resolveReworkPr(scm, ticketKey, config);
        var pr = prState.pr;

        var pushed = pushReworkBranch(params, ticketKey, passed, config, customParams, prState.prIsDirty, releaseLock);
        if (pushed.terminal) {
            return pushed.terminal;
        }
        var branchName = pushed.branchName;

        // Step 3: Ensure PR exists; create if missing (e.g. preCliJSAction failed to create it)
        if (!pr && branchName) {
            pr = createPRIfMissing(scm, branchName, ticketKey, config);
        }

        publishReworkPrArtifacts(scm, pr, ticketKey, testStatus, passed, fixSummary);

        // Step 4: Move ticket to In Review - Passed or In Review - Failed
        // Bug creation/linking is handled by the bug_creation agent when TC reaches Failed status
        const targetStatus = moveReworkTicket(ticketKey, passed, jiraConfig);

        // Step 6: Post tracker comment — flavor follows the ticket's
        // tracker (gh-770): Markdown on GitHub issues, wiki markup on Jira.
        postReworkTrackerComment(ticketKey, config, customParams, pr, testStatus, branchName, passed, fixSummary);

        // Step 7 & 8: Remove WIP label + SM idempotency label
        releaseLock();

        triggerAutoStart(ticketKey, customParams, config);

        console.log('✅ Test rework complete — re-run:', testStatus, '→', targetStatus);

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        postReworkUsageComments(ticketKey, params);

        return {
            success: true,
            testStatus: testStatus,
            jiraStatus: targetStatus,
            ticketKey: ticketKey
        };

    } catch (error) {
        console.error('❌ Error in postTestReworkResults:', error);
        if (shouldResumeRework(params, customParams, config, error)) {
            return action(params);
        }
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        resolveCustomParams,
        commitIfNeeded,
        commitAndPush,
        buildTestReworkResultComment,
        // gh-928 extracted planners/parsers and thin executors (test surface):
        normalizeTestStatus,
        buildResultErrorMessage,
        resolveWipLabel,
        prMatchesBranch,
        buildAutoPRTitle,
        prNumberFromUrl,
        buildFallbackPR,
        buildPRReworkComment,
        runPublishGates,
        releaseReworkLock,
        postReworkBodyAndComment,
        updatePullRequestBody,
        replyThreadIdOf,
        handleReplyItem,
        resumeOrReport,
        triggerAutoStart,
        // gh-981: stageUnmergedPaths split into pure path classification + git executors:
        stageUnmergedPaths,
        parsePathList,
        parseConflictMarkerPaths,
        decideConflictSide,
        stageConflictMarkerFiles,
        stageSubmoduleConflicts,
        // gh-1083: action() split — pure planners (test surface):
        resolveActionContext,
        fixSummaryOf,
        isMissingResult,
        decidePrIsDirty,
        decideReworkTargetStatus,
        loadReworkProjectConfig,
        smRemoveLabelOf,
        // gh-1192: commitAndPush decomposed into thin git executors (test surface):
        currentBranchName,
        guardReworkBranch,
        mergeBaseWhenDirty,
        pushReworkBranchToRemote,
        verifyPushedBranch
    };
}
