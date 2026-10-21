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
var prHelper = require('./common/pullRequest.js');
var gitStaging = require('./common/gitStaging.js');
var trackersModule = require('./common/trackers.js');

var _workingDir = null;
var _tracker = null;
function runCmd(args) {
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
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
        _tracker.postComment(ticketKey, message);
    } catch (e) {
        console.warn('commitAndPushToBaseBranch: comment failed:', e.toString());
    }
}

// ── gh-1082: pure parse/build/decide helpers for action() ────────────────────
// Extracted from action() (CRAP 37.3 → target ≤ 8) without changing the
// external call order or any observable text. Each helper is directly
// unit-tested in js/unit-tests/test_commitAndPushToBaseBranch.js.

/**
 * The ticket key driving this action: the tracker-extracted key, falling
 * back to params.ticket.key.
 */
function resolveTicketKey(params) {
    return extractTicketKey(params) || (params.ticket && params.ticket.key);
}

/**
 * The customParams bag the tracker is created from: project-config
 * customParams first, then jobParams, then top-level params.
 */
function resolveTrackerCustomParams(config, params) {
    return config.customParams ||
        (params.jobParams && params.jobParams.customParams) ||
        params.customParams ||
        {};
}

/**
 * The branch to push to: config.git.baseBranch, defaulting to main.
 */
function resolveBaseBranch(config) {
    return (config.git && config.git.baseBranch) || 'main';
}

/**
 * The customParams.directPush option block (empty when absent).
 */
function resolveDirectPushOptions(config) {
    return (config.customParams && config.customParams.directPush) || {};
}

/**
 * Everything action() needs after loadProjectConfig: workingDir, tracker
 * params, base branch, and the directPush option block.
 */
function buildDirectPushContext(config, params) {
    return {
        workingDir: config.workingDir || null,
        trackerParams: resolveTrackerCustomParams(config, params),
        baseBranch: resolveBaseBranch(config),
        opts: resolveDirectPushOptions(config)
    };
}

/**
 * The command-local cli_execute_command option bag for a workingDir.
 */
function buildCmdOpts(workingDir) {
    return workingDir ? { workingDirectory: workingDir } : {};
}

/**
 * The commit message: the configured template (default "Update {ticketKey}
 * artifacts") with {ticketKey} substituted.
 */
function buildCommitMessage(opts, ticketKey) {
    return (opts.commitMessage || 'Update {ticketKey} artifacts').split('{ticketKey}').join(ticketKey);
}

/**
 * The pre-push gate command with {ticketKey} substituted.
 */
function buildGateCommand(gateCommand, ticketKey) {
    return gateCommand.split('{ticketKey}').join(ticketKey);
}

/**
 * The tracker comment posted when the pre-push gate fails: the error tail
 * (last 1500 chars) inside a code fence.
 */
function gateFailureComment(gateError) {
    return 'Pre-push gate failed, changes NOT pushed:\n\n```\n' + gateError.toString().slice(-1500) + '\n```';
}

/**
 * The tracker comment posted when the push itself fails: the error head
 * (first 1000 chars).
 */
function pushFailureComment(baseBranch, error) {
    return 'Push to ' + baseBranch + ' failed: ' + error.toString().slice(0, 1000);
}

/**
 * Posts the rendered comment for an optional directPush text option
 * (noChangesComment / successComment) when it is configured.
 */
function maybePostTicketComment(opts, textKey, ticketKey) {
    if (!opts[textKey]) return;
    postComment(ticketKey, render({ text: opts[textKey], resultUrlTemplate: opts.resultUrlTemplate }, ticketKey));
}

function action(params) {
    var ticketKey = resolveTicketKey(params);
    if (!ticketKey) {
        console.error('commitAndPushToBaseBranch: could not determine ticket key');
        return false;
    }

    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var ctx = buildDirectPushContext(config, params);
    _workingDir = ctx.workingDir;
    _tracker = trackersModule.createTracker(config, ctx.trackerParams);

    try {
        var status = cleanCommandOutput(runCmd({ command: 'git status --porcelain' }));
        if (!status) {
            console.log('commitAndPushToBaseBranch: no changes to commit');
            maybePostTicketComment(ctx.opts, 'noChangesComment', ticketKey);
            return true;
        }

        if (ctx.opts.gateCommand) {
            // NOTE: cli_execute_command rejects shell metacharacters
            // (&&, ||, |, ;, >, <, ...). gateCommand must be a single plain
            // invocation — wrap any logic into a script in the target repo
            // (e.g. "bash scripts/gate.sh {ticketKey}").
            try {
                var gateOut = cleanCommandOutput(runCmd({ command: buildGateCommand(ctx.opts.gateCommand, ticketKey) }));
                console.log('commitAndPushToBaseBranch: gate passed. ' + gateOut);
            } catch (gateError) {
                console.error('commitAndPushToBaseBranch: gate failed, not pushing:', gateError.toString());
                postComment(ticketKey, gateFailureComment(gateError));
                return false;
            }
        }

        var message = buildCommitMessage(ctx.opts, ticketKey);
        // `:!factory-kit` — nested machine-infra gitlink must not die on add -A (#648 class).
        // gh-1164: probe-filtered — naming an existing gitignored factory-kit in ANY
        // pathspec (exclusions included) trips git add's ignored-pathspec guard.
        runCmd({ command: 'git add -A -- ' + gitStaging.buildExclusionPathspecs(['factory-kit'], runCmd) });
        runCmd({ command: 'git commit -m "' + message.replace(/"/g, '\\"') + '" --no-verify' });
        runCmd({ command: 'git pull --rebase origin ' + ctx.baseBranch });
        runCmd({ command: 'git push origin HEAD:' + ctx.baseBranch });
        console.log('commitAndPushToBaseBranch: pushed to ' + ctx.baseBranch);

        maybePostTicketComment(ctx.opts, 'successComment', ticketKey);
        return true;
    } catch (e) {
        console.error('commitAndPushToBaseBranch failed:', e.toString());
        postComment(ticketKey, pushFailureComment(ctx.baseBranch, e));
        return false;
    }
}

if (typeof module !== 'undefined') {
    module.exports = {
        action: action,
        resolveTicketKey: resolveTicketKey,
        resolveTrackerCustomParams: resolveTrackerCustomParams,
        resolveBaseBranch: resolveBaseBranch,
        resolveDirectPushOptions: resolveDirectPushOptions,
        buildDirectPushContext: buildDirectPushContext,
        buildCmdOpts: buildCmdOpts,
        buildCommitMessage: buildCommitMessage,
        buildGateCommand: buildGateCommand,
        gateFailureComment: gateFailureComment,
        pushFailureComment: pushFailureComment
    };
}
