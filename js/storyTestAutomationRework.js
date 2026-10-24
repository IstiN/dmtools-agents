/**
 * Story Test Automation Rework Action
 * Applies review feedback to the Story test PR and re-triggers review.
 *
 * gh-1080 CRAP split: parameter parsing and every action() step (push-failure
 * result, SCM announcement, In Testing move, Jira comment, review trigger,
 * token usage, error result) are named helpers — the tracker/SCM/git/file
 * calls and their order are unchanged.
 */

var configLoader = require('./configLoader.js');
var autoStart = require('./common/autoStart.js');
var prHelper = require('./common/pullRequest.js');
var mergeState = require('./common/mergeState.js');
const { LABELS } = require('./config.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var trackersModule = require('./common/trackers.js');

function smLabelForContext(contextId) {
    if (!contextId) return null;
    var map = {
        'story_test_automation_rework': 'sm_story_test_rework_triggered',
        'bug_test_automation_rework': 'sm_bug_test_rework_triggered'
    };
    return map[contextId] || null;
}

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function readFile(path) {
    try {
        const content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        console.warn('Could not read file ' + path + ':', e);
        return null;
    }
}

function runInRepo(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

// ── gh-1006: pure parse/build/decide helpers extracted from mergeMain ──

function configureGitAuthor(runInRepoFn, config, workingDir) {
    try {
        runInRepoFn('git config user.name "' + config.git.authorName + '"', workingDir);
        runInRepoFn('git config user.email "' + config.git.authorEmail + '"', workingDir);
    } catch (e) {
        console.warn('Could not configure git author:', e);
    }
}

function parseConflictedFiles(statusOutput) {
    return statusOutput.split('\n').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
}

function decideConflictSide(storyKey, file) {
    return file.indexOf('testing/tests/' + storyKey + '/') === 0 ? 'ours' : 'theirs';
}

function buildMergeCommitMessage(storyKey) {
    return storyKey + ' test rework: merge origin/main and resolve test conflicts';
}

function resolveMergeConflicts(runInRepoFn, workingDir, storyKey) {
    var status = cleanCommandOutput(runInRepoFn('git diff --name-only --diff-filter=U', workingDir) || '');
    var conflicts = parseConflictedFiles(status);
    if (conflicts.length === 0) {
        throw new Error('git merge origin/main failed and no conflicted files were found');
    }

    conflicts.forEach(function(file) {
        try {
            if (decideConflictSide(storyKey, file) === 'ours') {
                runInRepoFn('git checkout --ours -- "' + file + '"', workingDir);
                console.log('✅ Resolved conflict keeping branch version for ticket test file:', file);
            } else {
                runInRepoFn('git checkout --theirs -- "' + file + '"', workingDir);
                console.log('✅ Resolved conflict keeping origin/main version:', file);
            }
            runInRepoFn('git add "' + file + '"', workingDir);
        } catch (e) {
            throw new Error('Failed to resolve conflict for ' + file + ': ' + e);
        }
    });
}

function commitResolvedMerge(runInRepoFn, workingDir, storyKey) {
    try {
        runInRepoFn('git commit -m "' + buildMergeCommitMessage(storyKey).replace(/"/g, '\\"') + '"', workingDir);
        console.log('✅ Committed merge with auto-resolved test conflicts');
    } catch (e) {
        throw new Error('Failed to commit auto-resolved merge: ' + e);
    }
}

function mergeMain(storyKey, config) {
    var workingDir = config.workingDir || null;

    // gh-761: never start a merge on top of an unconcluded one. When
    // MERGE_HEAD exists (the agent left a conflicted base-branch merge
    // unresolved), the old flow finalized that FOREIGN merge: `git merge
    // origin/main` failed with "You have not concluded your merge", the
    // fallback then read the LEFTOVER unmerged paths, auto-resolved them
    // with --ours/--theirs and committed — baking conflict markers into a
    // merge nobody deliberately resolved. Refuse with an actionable error
    // instead; the job fails visibly and the tree stays exactly as the
    // agent left it.
    if (mergeState.isMergeInProgress(runInRepo, workingDir)) {
        throw new Error('mergeMain: a merge is already in progress (MERGE_HEAD exists) in ' +
            (workingDir || '.') + ' — conclude or abort the unconcluded merge before rework can merge origin/main for ' + storyKey);
    }

    configureGitAuthor(runInRepo, config, workingDir);

    console.log('Fetching origin/main to keep test branch up to date...');
    try {
        runInRepo('git fetch origin main', workingDir);
    } catch (e) {
        throw new Error('Failed to fetch origin/main: ' + e);
    }

    console.log('Unshallowing repository so git merge can find merge base...');
    try {
        runInRepo('git fetch --unshallow', workingDir);
    } catch (e) {
        console.warn('Unshallow fetch failed (may already be complete):', e);
    }

    var mergeOutput = '';
    try {
        mergeOutput = cleanCommandOutput(runInRepo('git merge origin/main --no-edit', workingDir) || '');
        console.log('✅ Merged origin/main into test branch');
        return;
    } catch (mergeError) {
        var mergeErrStr = (mergeError && mergeError.toString ? mergeError.toString() : String(mergeError)) + ' ' + mergeOutput;
        console.warn('git merge origin/main failed:', mergeErrStr);
        console.warn('Attempting auto-resolution for ticket test files...');
    }

    resolveMergeConflicts(runInRepo, workingDir, storyKey);
    commitResolvedMerge(runInRepo, workingDir, storyKey);
}

// ── gh-1229: commitAndPush decomposed into small steps; behavior is
//    byte-identical to the previous inline flow. ──

/** Current checked-out branch, or '' when git could not tell. */
function currentBranchName(workingDir) {
    return cleanCommandOutput(runInRepo('git branch --show-current', workingDir) || '');
}

/** Commit the staged testing/ changes; a clean staging area only warns. */
function commitTestingChanges(storyKey, config, workingDir) {
    var statusOutput = cleanCommandOutput(runInRepo('git diff --cached --stat', workingDir) || '');
    if (statusOutput.trim()) {
        var commitMsg = configLoader.formatTemplate(config.formats.commitMessage.testRework, {
            ticketKey: storyKey,
            result: 'address review comments'
        });
        runInRepo('git commit -m "' + commitMsg.replace(/"/g, '\\"') + '"', workingDir);
        console.log('✅ Committed rework changes');
    } else {
        console.warn('No changes to commit in testing/ — pushing existing commits only');
    }
}

/** Push the branch; a rejected normal push falls back to --force. */
function pushBranchToRemote(branchName, workingDir) {
    try {
        runInRepo('git push -u origin ' + branchName, workingDir);
    } catch (e) {
        console.log('Normal push failed, force pushing...');
        runInRepo('git push -u origin ' + branchName + ' --force', workingDir);
    }
}

/**
 * gh-912: verify the push produced a real refs/heads/<branch> ref line —
 * stderr noise never counts as the branch existing. Non-fatal probe.
 */
function remoteBranchExistsAfterPush(workingDir, branchName) {
    try {
        return prHelper.remoteBranchExists(runInRepo, workingDir, branchName);
    } catch (lsRemoteErr) {
        console.warn('Error checking remote branches:', lsRemoteErr);
        return false;
    }
}

function commitAndPush(storyKey, config) {
    var workingDir = config.workingDir || null;
    var branchName = currentBranchName(workingDir);
    if (!branchName) throw new Error('Could not determine current git branch');
    if (branchName === 'main' || branchName === 'master') {
        throw new Error('Refusing to commit rework directly to "' + branchName + '". Expected test/' + storyKey);
    }

    console.log('Current branch:', branchName);
    mergeMain(storyKey, config);
    runInRepo('git config user.name "' + config.git.authorName + '"', workingDir);
    runInRepo('git config user.email "' + config.git.authorEmail + '"', workingDir);
    runInRepo('git add testing/', workingDir);

    commitTestingChanges(storyKey, config, workingDir);

    pushBranchToRemote(branchName, workingDir);

    if (!remoteBranchExistsAfterPush(workingDir, branchName)) throw new Error('Branch not found on remote after push');
    console.log('✅ Pushed to remote branch:', branchName);
    return branchName;
}

// ── gh-1006: pure parse/build/decide helpers extracted from postThreadReplies ──

// Returns the reply list to process, or null when there is nothing to do
// (missing file, unparseable JSON, or empty list). Emits the same warnings
// as the original inline flow.
function parseReviewReplies(repliesJson) {
    if (!repliesJson) {
        console.warn('outputs/review_replies.json not found — skipping thread replies');
        return null;
    }
    var data;
    try {
        data = JSON.parse(repliesJson);
    } catch (e) {
        console.warn('Failed to parse review_replies.json:', e);
        return null;
    }
    var replies = (data && data.replies) ? data.replies : [];
    return replies.length ? replies : null;
}

function buildThreadReplyTarget(item) {
    return {
        rootCommentId: item.inReplyToId,
        threadId: item.threadId || item.discussionId
    };
}

function replyTextFor(item) {
    return item.reply || '✅ Addressed.';
}

function postThreadReply(scm, pullRequestId, item) {
    try {
        scm.replyToThread(pullRequestId, buildThreadReplyTarget(item), replyTextFor(item));
        return true;
    } catch (e) {
        console.warn('Failed to reply to comment #' + item.inReplyToId + ':', e);
        return false;
    }
}

function resolveThreadIfPresent(scm, pullRequestId, item) {
    if (!item.threadId) return;
    try {
        scm.resolveThread(pullRequestId, { threadId: item.threadId });
    } catch (e) {
        console.warn('Failed to resolve thread', item.threadId + ':', e);
    }
}

function postThreadReplies(scm, pullRequestId) {
    var replies = parseReviewReplies(readFile('outputs/review_replies.json'));
    if (!replies) return 0;

    var posted = 0;
    replies.forEach(function(item) {
        if (postThreadReply(scm, pullRequestId, item)) posted++;
        resolveThreadIfPresent(scm, pullRequestId, item);
    });
    console.log('Posted ' + posted + '/' + replies.length + ' thread replies');
    return posted;
}

function findStoryPR(scm, storyKey) {
    try {
        const branchName = 'test/' + storyKey;
        const openPRs = scm.listPrs('open') || [];
        return openPRs.find(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName;
        }) || null;
    } catch (e) {
        console.error('Failed to find PR:', e);
        return null;
    }
}

// ── gh-1080: pure parse helper extracted from action ─────────────────────────

function parseReworkParams(params) {
    const actualParams = params.ticket ? params : (params.jobParams || params);
    const jobCustomParams = params.jobParams && params.jobParams.customParams;
    return {
        actualParams: actualParams,
        storyKey: actualParams.ticket.key,
        customParams: jobCustomParams || params.customParams || {},
        contextId: actualParams.metadata && actualParams.metadata.contextId,
        initiator: params.initiator
    };
}

function buildReworkContext(params) {
    const parsed = parseReworkParams(params);
    const config = configLoader.loadProjectConfig(params.jobParams || params);
    return {
        actualParams: parsed.actualParams,
        storyKey: parsed.storyKey,
        customParams: parsed.customParams,
        initiator: parsed.initiator,
        config: config,
        jiraConfig: config.jira,
        scm: configLoader.createScm(config),
        tracker: trackersModule.createTracker(config, parsed.customParams),
        // gh-916/gh-1006: SM label fallback by context, WIP label derived from it.
        removeLabel: parsed.customParams.removeLabel || smLabelForContext(parsed.contextId),
        wipLabel: parsed.contextId ? parsed.contextId + '_wip' : null
    };
}

function action(params) {
    const ctx = buildReworkContext(params);
    const actualParams = ctx.actualParams;
    const storyKey = ctx.storyKey;
    const config = ctx.config;
    const jiraConfig = ctx.jiraConfig;
    const scm = ctx.scm;
    const customParams = ctx.customParams;
    const tracker = ctx.tracker;
    // Hoisted like the pre-split `var pr`: assigned only after commitAndPush
    // succeeds, and releaseLock() below must observe "undefined" until then.
    var pr;

    function releaseWipLock() {
        if (ctx.wipLabel) {
            try { tracker.removeLabel(storyKey, ctx.wipLabel); } catch (e) {}
        } else {
            // If contextId is missing, clean up both known WIP labels defensively.
            try { tracker.removeLabel(storyKey, 'story_test_automation_rework_wip'); } catch (e) {}
            try { tracker.removeLabel(storyKey, 'bug_test_automation_rework_wip'); } catch (e) {}
        }
        if (ctx.removeLabel) {
            try {
                tracker.removeLabel(storyKey, ctx.removeLabel);
                console.log('✅ Removed SM label:', ctx.removeLabel);
            } catch (e) {}
        }
    }

    function releaseLock() {
        releaseWipLock();
        try {
            tracker.removeLabel(storyKey, LABELS.TEST_PR_REWORK_NEEDED);
            console.log('✅ Removed test_pr_rework_needed label');
        } catch (e) {}

        // The review agent adds this label to both Jira and the GitHub PR,
        // so the rework agent must remove it from both places.
        if (pr && pr.number) {
            try {
                scm.removeLabel(pr.number, LABELS.TEST_PR_REWORK_NEEDED);
                console.log('✅ Removed test_pr_rework_needed label from GitHub PR');
            } catch (e) {}
        }
    }

    function pushFailedResult(e) {
        console.error('Git operations failed:', e);
        tracker.postComment(storyKey, 'h3. ❌ Story Test Rework Push Failed\n\n{code}' + e.toString() + '{code}'
        );
        releaseWipLock();
        return { success: false, error: e.toString() };
    }

    // Step 2: Reply to review threads + announce the rework on the PR
    function announceReworkOnScm(prFound, fixSummary) {
        if (!prFound) return;
        postThreadReplies(scm, prFound.number);
        try {
            scm.addComment(prFound.number, '## 🔧 Story Test Rework Complete — ' + storyKey + '\n\n' + fixSummary);
        } catch (e) {
            console.warn('Failed to post PR rework comment:', e);
        }
    }

    // Step 3: Move Story back to In Testing
    function moveStoryBackToInTesting() {
        try {
            // gh-916: IN_TESTING can be tag-only (restricted ADO workflows) — stage-label fallback.
            var moveResult = tracker.moveToStatusOrMark(storyKey, jiraConfig.statuses.IN_TESTING, 'IN_TESTING');
            if (moveResult.moved || moveResult.marked) {
                console.log('✅ Moved Story', storyKey, 'to', jiraConfig.statuses.IN_TESTING);
            }
        } catch (e) {
            console.warn('Failed to move Story to In Testing:', e);
        }
    }

    // Step 4: Post Jira comment
    function postReworkJiraComment(branchName, prFound, fixSummary) {
        try {
            var comment = 'h3. 🔧 Story Test Rework Completed\n\n';
            comment += '*Branch*: {code}' + branchName + '{code}\n';
            if (prFound) comment += '*Pull Request*: ' + prFound.html_url + '\n';
            comment += '\n' + fixSummary;
            tracker.postComment(storyKey, comment);
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }
    }

    // Step 5: Trigger review
    function triggerReworkReview() {
        releaseLock();
        var autoStarted = false;
        if (customParams.autoStartReview && customParams.autoStartReviewConfigFile) {
            try {
                autoStarted = autoStart.triggerConfiguredWorkflowForTicket({
                    ticketKey: storyKey,
                    customParams: customParams,
                    config: config,
                    configFile: customParams.autoStartReviewConfigFile,
                    label: 'pr_story_test_automation_review',
                    stripKeys: ['removeLabel', 'autoStartReview', 'autoStartReviewConfigFile']
                });
            } catch (e) {
                console.warn('⚠️ autoStartReview trigger failed:', e.message || e);
            }
        }
        if (!autoStarted) {
            autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
        }
    }

    function postTokenUsageSafely() {
        tokenUsageComment.postTokenUsageSafely(storyKey, null, { initiator: ctx.initiator, tracker: tracker });
    }

    function reworkErrorResult(error) {
        console.error('❌ Error in storyTestAutomationRework:', error);
        try {
            tracker.postComment(storyKey, 'h3. ❌ Story Test Rework Error\n\n{code}' + error.toString() + '{code}'
            );
        } catch (e) {}
        releaseLock();
        return { success: false, error: error.toString() };
    }

    try {
        const fixSummary = actualParams.response || '_(No fix summary)_';
        console.log('=== Processing story test automation rework for', storyKey, '===');

        // Step 1: Commit/push testing/
        var branchName;
        try {
            branchName = commitAndPush(storyKey, config);
        } catch (e) {
            return pushFailedResult(e);
        }

        pr = findStoryPR(scm, storyKey);
        announceReworkOnScm(pr, fixSummary);

        moveStoryBackToInTesting();

        postReworkJiraComment(branchName, pr, fixSummary);

        triggerReworkReview();

        postTokenUsageSafely();

        return {
            success: true,
            storyKey: storyKey,
            prUrl: pr ? pr.html_url : null
        };

    } catch (error) {
        return reworkErrorResult(error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, mergeMain, postThreadReplies, commitAndPush };
}
