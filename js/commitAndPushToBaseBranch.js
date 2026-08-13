/**
 * Commit and Push To Base Branch Action
 *
 * Generic postJSAction for direct-to-main iteration loops (no branch, no PR).
 * Useful for content/artifact repos where the deliverable is deployed
 * automatically from the default branch (e.g. static-site pipelines) and the
 * agent should publish immediately.
 *
 * Steps:
 * 1. If the working tree is clean — post an optional "no changes" comment and finish.
 * 2. Optional pre-push gate command (customParams.directPush.gateCommand) run in
 *    workingDir; when it fails, nothing is pushed and the output is commented.
 * 3. git add -A, commit, pull --rebase, push to baseBranch.
 * 4. Optional Jira comment with customParams.directPush.successComment
 *    (supports {ticketKey} and {url} placeholders; url comes from
 *    customParams.directPush.resultUrlTemplate, also with {ticketKey}).
 *
 * Configuration (customParams.directPush):
 *   - commitMessage:    e.g. "Update {ticketKey} artifacts"
 *   - gateCommand:      e.g. "bash scripts/gate.sh {ticketKey}" (optional,
 *                       supports {ticketKey}). Must be a SINGLE plain command —
 *                       the executor rejects shell metacharacters
 *                       (&&, ||, |, ;, >, <). Wrap logic in a script file.
 *   - resultUrlTemplate: e.g. "https://example.com/{ticketKey}/" (optional)
 *   - successComment:   comment posted on success (optional)
 *   - noChangesComment: comment posted when nothing changed (optional)
 */

const { extractTicketKey } = require('./common/jiraHelpers.js');
var configLoader = require('./configLoader.js');

var _workingDir = null;
function runCmd(args) {
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function (line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function render(template, ticketKey) {
    var url = '';
    if (template && template.resultUrlTemplate) {
        url = template.resultUrlTemplate.split('{ticketKey}').join(ticketKey);
    }
    return (template && template.text ? template.text : '')
        .split('{ticketKey}').join(ticketKey)
        .split('{url}').join(url);
}

function postComment(ticketKey, message) {
    try {
        jira_post_comment(ticketKey, message);
    } catch (e) {
        console.warn('commitAndPushToBaseBranch: comment failed:', e.toString());
    }
}

function action(params) {
    var ticketKey = extractTicketKey(params) || (params.ticket && params.ticket.key);
    if (!ticketKey) {
        console.error('commitAndPushToBaseBranch: could not determine ticket key');
        return false;
    }

    var config = configLoader.loadProjectConfig(params.jobParams || params);
    _workingDir = config.workingDir || null;
    var baseBranch = (config.git && config.git.baseBranch) || 'main';
    var opts = (config.customParams && config.customParams.directPush) || {};

    try {
        var status = cleanCommandOutput(runCmd({ command: 'git status --porcelain' }));
        if (!status) {
            console.log('commitAndPushToBaseBranch: no changes to commit');
            if (opts.noChangesComment) {
                postComment(ticketKey, render({ text: opts.noChangesComment, resultUrlTemplate: opts.resultUrlTemplate }, ticketKey));
            }
            return true;
        }

        if (opts.gateCommand) {
            // NOTE: cli_execute_command rejects shell metacharacters
            // (&&, ||, |, ;, >, <, ...). gateCommand must be a single plain
            // invocation — wrap any logic into a script in the target repo
            // (e.g. "bash scripts/gate.sh {ticketKey}").
            var gateCmd = opts.gateCommand.split('{ticketKey}').join(ticketKey);
            try {
                var gateOut = cleanCommandOutput(runCmd({ command: gateCmd }));
                console.log('commitAndPushToBaseBranch: gate passed. ' + gateOut);
            } catch (gateError) {
                console.error('commitAndPushToBaseBranch: gate failed, not pushing:', gateError.toString());
                postComment(ticketKey, 'Pre-push gate failed, changes NOT pushed:\n\n```\n' + gateError.toString().slice(-1500) + '\n```');
                return false;
            }
        }

        var message = (opts.commitMessage || 'Update {ticketKey} artifacts').split('{ticketKey}').join(ticketKey);
        runCmd({ command: 'git add -A' });
        runCmd({ command: 'git commit -m "' + message.replace(/"/g, '\\"') + '" --no-verify' });
        runCmd({ command: 'git pull --rebase origin ' + baseBranch });
        runCmd({ command: 'git push origin HEAD:' + baseBranch });
        console.log('commitAndPushToBaseBranch: pushed to ' + baseBranch);

        if (opts.successComment) {
            postComment(ticketKey, render({ text: opts.successComment, resultUrlTemplate: opts.resultUrlTemplate }, ticketKey));
        }
        return true;
    } catch (e) {
        console.error('commitAndPushToBaseBranch failed:', e.toString());
        postComment(ticketKey, 'Push to ' + baseBranch + ' failed: ' + e.toString().slice(0, 1000));
        return false;
    }
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
