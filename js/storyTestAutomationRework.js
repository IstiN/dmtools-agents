/**
 * Story Test Automation Rework Action
 * Applies review feedback to the Story test PR and re-triggers review.
 */

var configLoader = require('./configLoader.js');
var autoStart = require('./common/autoStart.js');
var prHelper = require('./common/pullRequest.js');
const { STATUSES } = require('./config.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
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

function commitAndPush(storyKey, config) {
    var workingDir = config.workingDir || null;
    var branchName = cleanCommandOutput(runInRepo('git branch --show-current', workingDir) || '');
    if (!branchName) throw new Error('Could not determine current git branch');
    if (branchName === 'main' || branchName === 'master') {
        throw new Error('Refusing to commit rework directly to "' + branchName + '". Expected test/' + storyKey);
    }

    console.log('Current branch:', branchName);
    runInRepo('git config user.name "' + config.git.authorName + '"', workingDir);
    runInRepo('git config user.email "' + config.git.authorEmail + '"', workingDir);
    runInRepo('git add testing/', workingDir);

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

    try {
        runInRepo('git push -u origin ' + branchName, workingDir);
    } catch (e) {
        console.log('Normal push failed, force pushing...');
        runInRepo('git push -u origin ' + branchName + ' --force', workingDir);
    }

    var remoteCheck = cleanCommandOutput(runInRepo('git ls-remote --heads origin ' + branchName, workingDir) || '');
    if (!remoteCheck.trim()) throw new Error('Branch not found on remote after push');
    console.log('✅ Pushed to remote branch:', branchName);
    return branchName;
}

function postThreadReplies(scm, pullRequestId) {
    const repliesJson = readFile('outputs/review_replies.json');
    if (!repliesJson) {
        console.warn('outputs/review_replies.json not found — skipping thread replies');
        return 0;
    }
    var data;
    try {
        data = JSON.parse(repliesJson);
    } catch (e) {
        console.warn('Failed to parse review_replies.json:', e);
        return 0;
    }
    const replies = (data && data.replies) ? data.replies : [];
    if (replies.length === 0) return 0;

    var posted = 0;
    replies.forEach(function(item) {
        try {
            scm.replyToThread(pullRequestId, {
                rootCommentId: item.inReplyToId,
                threadId: item.threadId || item.discussionId
            }, item.reply || '✅ Addressed.');
            posted++;
        } catch (e) {
            console.warn('Failed to reply to comment #' + item.inReplyToId + ':', e);
        }
        if (item.threadId) {
            try {
                scm.resolveThread(pullRequestId, { threadId: item.threadId });
            } catch (e) {
                console.warn('Failed to resolve thread', item.threadId + ':', e);
            }
        }
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

function action(params) {
    const actualParams = params.ticket ? params : (params.jobParams || params);
    const storyKey = actualParams.ticket.key;
    const config = configLoader.loadProjectConfig(params.jobParams || params);
    const scm = configLoader.createScm(config);
    const customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
    const removeLabel = customParams.removeLabel;
    const wipLabel = actualParams.metadata && actualParams.metadata.contextId
        ? actualParams.metadata.contextId + '_wip'
        : 'story_test_automation_rework_wip';

    function releaseLock() {
        try { jira_remove_label({ key: storyKey, label: wipLabel }); } catch (e) {}
        if (removeLabel) {
            try {
                jira_remove_label({ key: storyKey, label: removeLabel });
                console.log('✅ Removed SM label:', removeLabel);
            } catch (e) {}
        }
    }

    try {
        const fixSummary = actualParams.response || '_(No fix summary)_';
        console.log('=== Processing story test automation rework for', storyKey, '===');

        // Step 1: Commit/push testing/
        var branchName;
        try {
            branchName = commitAndPush(storyKey, config);
        } catch (e) {
            console.error('Git operations failed:', e);
            jira_post_comment({
                key: storyKey,
                comment: 'h3. ❌ Story Test Rework Push Failed\n\n{code}' + e.toString() + '{code}'
            });
            releaseLock();
            return { success: false, error: e.toString() };
        }

        // Step 2: Reply to review threads
        var pr = findStoryPR(scm, storyKey);
        if (pr) {
            postThreadReplies(scm, pr.number);
            try {
                scm.addComment(pr.number, '## 🔧 Story Test Rework Complete — ' + storyKey + '\n\n' + fixSummary);
            } catch (e) {
                console.warn('Failed to post PR rework comment:', e);
            }
        }

        // Step 3: Move Story back to In Testing
        try {
            jira_move_to_status({ key: storyKey, statusName: STATUSES.IN_TESTING });
            console.log('✅ Moved Story', storyKey, 'to', STATUSES.IN_TESTING);
        } catch (e) {
            console.warn('Failed to move Story to In Testing:', e);
        }

        // Step 4: Post Jira comment
        try {
            var comment = 'h3. 🔧 Story Test Rework Completed\n\n';
            comment += '*Branch*: {code}' + branchName + '{code}\n';
            if (pr) comment += '*Pull Request*: ' + pr.html_url + '\n';
            comment += '\n' + fixSummary;
            jira_post_comment({ key: storyKey, comment: comment });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 5: Trigger review
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

        try {
            tokenUsageComment.postTokenUsageComments(storyKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return {
            success: true,
            storyKey: storyKey,
            prUrl: pr ? pr.html_url : null
        };

    } catch (error) {
        console.error('❌ Error in storyTestAutomationRework:', error);
        try {
            jira_post_comment({
                key: storyKey,
                comment: 'h3. ❌ Story Test Rework Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
