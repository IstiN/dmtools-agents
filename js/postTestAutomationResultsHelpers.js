/**
 * Pure helpers for js/postTestAutomationResults.js (gh-961).
 *
 * Every function here is side-effect free: string building and pure
 * decisions extracted from action() so the orchestration function shrinks
 * below the CRAP threshold. Strings must stay byte-identical to the
 * originals — they are posted verbatim to the tracker.
 */

function parseOutcome(result) {
    var status = ((result && result.status) || '').toLowerCase();
    return {
        status: status,
        passed: status === 'passed',
        blockedByHuman: status === 'blocked_by_human'
    };
}

function decideWipLabel(metadata) {
    return metadata && metadata.contextId
        ? metadata.contextId + '_wip'
        : 'test_case_automation_wip';
}

function decideSmTriggerLabel(params) {
    var customParams = params.jobParams && params.jobParams.customParams;
    return (customParams && customParams.removeLabel) || null;
}

function buildMissingResultComment(partialPushed) {
    var comment = 'h3. ⚠️ Test Automation Error\n\nCLI exited without producing result JSON (likely hit rate limit or crashed).\n';
    if (partialPushed) {
        comment += 'Partial code was pushed to the branch — next retry will continue from there.\n';
    }
    comment += 'Ticket moved back to *Backlog* so SM can retry.';
    return comment;
}

function buildMissingSetupItem(item) {
    var text = '* *' + (item.name || '?') + '*';
    if (item.description) {
        text += ': ' + item.description;
    }
    text += '\n';
    if (item.how_to_add) {
        text += '{code:bash}' + item.how_to_add + '{code}\n';
    }
    return text;
}

function buildBlockedComment(result, prUrl) {
    var comment = 'h3. 🚫 Test Automation Blocked — Awaiting Human Setup\n\n';
    if (result.blocked_reason) {
        comment += result.blocked_reason + '\n\n';
    }
    if (result.missing && result.missing.length > 0) {
        comment += 'h4. Required setup:\n\n';
        for (var i = 0; i < result.missing.length; i++) {
            comment += buildMissingSetupItem(result.missing[i]);
        }
    }
    if (prUrl) {
        comment += '\n*Test Branch PR* (test code is ready, skips without credentials): ' + prUrl;
    }
    comment += '\n\nOnce setup is complete, move this ticket back to *Backlog* to trigger re-run.';
    return comment;
}

function buildFinalComment(jiraComment, prUrl, noCodeChanges) {
    var comment = jiraComment || '';
    if (prUrl) {
        comment += '\n\n*Test Branch PR*: ' + prUrl;
    }
    if (noCodeChanges) {
        comment += '\n\nℹ️ _Test code unchanged from previous run — PR review step skipped._';
    }
    return comment;
}

function buildPrFailureComment(branchName, error) {
    return 'h3. ⚠️ PR Creation Failed\n\nTest code was pushed to branch {code}' + branchName +
        '{code} but the Pull Request could not be created.\n\n' +
        'Ticket moved back to *Backlog* — will be re-processed automatically. The next run will detect the existing branch and create the PR.\n\n' +
        'Error: ' + (error || 'unknown');
}

function buildGitFailureComment(error) {
    return 'h3. ⚠️ Git Operations Failed\n\nFailed to commit/push test code: ' + error +
        '\n\nTicket moved back to *Backlog* — will be re-processed automatically.';
}

function buildConflictComment(branchName, baseBranch, prUrl) {
    return 'h3. 🚫 Test Automation Blocked — PR Conflicts With Main\n\n' +
        'The test automation branch {code}' + branchName + '{code} still conflicts with {code}' + baseBranch + '{code} after the agent run.\n\n' +
        '*Pull Request:* ' + prUrl + '\n\n' +
        'A {code}merge_conflicts.md{code} guidance file was present for this run, which means the existing test branch could not be safely auto-aligned with {code}origin/' + baseBranch + '{code}. ' +
        'Do not send this PR into automated review until the branch is deliberately synced with main and only ticket-specific test automation changes remain.\n\n' +
        'Ticket moved to *Blocked* for human conflict resolution.';
}

function buildErrorComment(error) {
    return 'h3. ❌ Test Automation Error\n\n{code}' + error.toString() + '{code}';
}

function buildPartialCommitMessage(baseMessage) {
    return baseMessage + ' (partial — CLI interrupted)';
}

function decideTargetStatus(passed, noCodeChanges, statuses) {
    if (passed) {
        return noCodeChanges
            ? { stage: 'PASSED', statusName: statuses.PASSED }
            : { stage: 'IN_REVIEW_PASSED', statusName: statuses.IN_REVIEW_PASSED };
    }
    return noCodeChanges
        ? { stage: 'FAILED', statusName: statuses.FAILED }
        : { stage: 'IN_REVIEW_FAILED', statusName: statuses.IN_REVIEW_FAILED };
}

/**
 * Ticket identity for action() logging/comments (gh-1083): the key, the
 * operator-facing summary (fields.summary degrading to the key) and the
 * project key (part before the first dash).
 */
function resolveTicketIdentity(params) {
    var ticketKey = params.ticket.key;
    var ticketSummary = params.ticket.fields ? params.ticket.fields.summary : ticketKey;
    return {
        ticketKey: ticketKey,
        ticketSummary: ticketSummary,
        projectKey: ticketKey.split('-')[0]
    };
}

/**
 * Which route the git stage of action() takes (gh-1083): a new commit means
 * create the PR, a no-op sync means skip straight to the outcome move, a
 * failed git result means reset to Backlog. Mirrors the original
 * `gitResult.success && !gitResult.noNewCommit` /
 * `else if (gitResult.noNewCommit)` / `else` chain EXACTLY — note the second
 * condition intentionally ignores `success`, and a null gitResult throws
 * here exactly like the original field access threw in action().
 */
function decideGitStageRoute(gitResult) {
    if (gitResult.success && !gitResult.noNewCommit) return 'create-pr';
    if (gitResult.noNewCommit) return 'no-new-commit';
    return 'git-failure';
}

/**
 * Dispatch params for action() (gh-1083): the jobParams body when wrapped,
 * the params object itself otherwise.
 */
function resolveJobParams(params) {
    return params.jobParams || params;
}

/**
 * Where the run works (gh-1083): the configured workingDir (null = repo root)
 * and the test-files path to stage (default testing/).
 */
function resolveRunPaths(config, customParams) {
    return {
        workingDir: config.workingDir || null,
        testFilesPath: customParams.testFilesGlob || 'testing/'
    };
}

/** The PASSED/FAILED completion-log word for the run outcome. */
function decideOutcomeWord(passed) {
    return passed ? 'PASSED' : 'FAILED';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseOutcome: parseOutcome,
        decideWipLabel: decideWipLabel,
        decideSmTriggerLabel: decideSmTriggerLabel,
        buildMissingResultComment: buildMissingResultComment,
        buildMissingSetupItem: buildMissingSetupItem,
        buildBlockedComment: buildBlockedComment,
        buildFinalComment: buildFinalComment,
        buildPrFailureComment: buildPrFailureComment,
        buildGitFailureComment: buildGitFailureComment,
        buildConflictComment: buildConflictComment,
        buildErrorComment: buildErrorComment,
        buildPartialCommitMessage: buildPartialCommitMessage,
        decideTargetStatus: decideTargetStatus,
        resolveTicketIdentity: resolveTicketIdentity,
        decideGitStageRoute: decideGitStageRoute,
        resolveJobParams: resolveJobParams,
        resolveRunPaths: resolveRunPaths,
        decideOutcomeWord: decideOutcomeWord
    };
}
