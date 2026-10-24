/**
 * Checkout Branch Pre-CLI Action
 * Creates or checks out the feature branch for the ticket before the CLI agent runs.
 * Branch name format: ai/<TICKET-KEY>
 * If the branch already exists (locally or remotely), it is checked out directly.
 * postAction (developTicketAndCreatePR) then just commits and pushes the current branch.
 *
 * Two-branch mode (config.git.featureBranch.enabled): when the "feature" branch doesn't
 * exist yet remotely, customParams.branchCreateFnPath can point to a JS file (module.exports
 * = function(ctx)) that creates it by some project-specific mechanism instead of a plain
 * `git push -u origin` — e.g. a repo whose branch-protection rules block direct pushes for
 * that branch pattern and require going through an external CI job. See loadHookFn() in
 * configLoader.js for the loading contract. When not configured, behavior is unchanged.
 */

const { GIT_CONFIG } = require('./config.js');
var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
var branchSetup = require('./common/branchSetup.js');

// Adapter matching the (command, workingDir) signature of the
// common/pullRequest.js probe helpers (gh-912) — this action always runs in
// the job root, so workingDir stays unset.
function runCommandForProbes(command) {
    return cli_execute_command({ command: command });
}

// ── gh-1190: checkoutBranch seam split ──────────────────────────────────────
// Mirrors the preCliDevelopmentSetup.js gh-1042 extraction pattern: pure
// route decisions plus small side-effecting clusters keep action() linear;
// the exact commands, log lines and their order are unchanged
// (characterization tests: js/unit-tests/test_checkoutBranch.js).

/** Pure: customParams resolution for both Teammate and standalone runs. */
function resolveActionCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/** Best-effort git author configuration — failures are warnings only. */
function configureGitAuthor(config) {
    branchSetup.configureGitAuthor(runCommandForProbes, config, true);
}

// Fetch latest remote state — target branch only (owner 2026-10-03:
// blanket fetches are banned; feature-branch checks use ls-remote).
function fetchTargetBranch(config) {
    branchSetup.fetchBranchRefs(prHelper, runCommandForProbes, [config.git.baseBranch], 'Could not fetch remote branches:');
    console.log('Fetched target branch:', config.git.baseBranch);
}

/**
 * `git branch --list` capture for `branchName`, cleaned of wrapper artifacts.
 * `warnMessage` (optional) is logged with the error when the probe fails —
 * pass null for the silent two-branch feature probes.
 */
function readLocalBranchList(branchName, warnMessage) {
    return branchSetup.readLocalBranchList(prHelper, runCommandForProbes, branchName, warnMessage);
}

/** Strict ls-remote existence probe (gh-912) — `warnMessage` optional. */
function probeRemoteBranch(branchName, warnMessage) {
    return branchSetup.probeRemoteBranch(prHelper, runCommandForProbes, null, branchName, warnMessage);
}

/** Plain (no-hook) two-branch feature creation tail for this action. */
function createFeatureBranchPlain(config, featureBranchName) {
    cli_execute_command({ command: 'git checkout ' + config.git.baseBranch });
    cli_execute_command({ command: 'git pull origin ' + config.git.baseBranch });
    cli_execute_command({ command: 'git checkout -b ' + featureBranchName });
    cli_execute_command({ command: 'git push -u origin ' + featureBranchName });
}

/**
 * Two-branch mode: make the feature branch exist — via the configured
 * branchCreateFnPath hook (project-specific mechanism, e.g. an external CI
 * job; the hook is responsible for making the branch exist on origin, so it
 * is fetched and checked out like any other pre-existing remote branch) or a
 * plain base-branch checkout + push when no hook is configured.
 */
function createFeatureBranch(config, customParams, ticket, featureBranchName) {
    branchSetup.createFeatureBranch(prHelper, configLoader, runCommandForProbes, config, customParams, ticket, featureBranchName, function (name) {
        createFeatureBranchPlain(config, name);
    });
}

/**
 * Two-branch mode: ensure the feature branch exists and check it out.
 * Returns the feature branch name — the dev branch is created from it.
 */
function establishFeatureBranch(config, customParams, ticket) {
    return branchSetup.establishFeatureBranch(prHelper, configLoader, runCommandForProbes, null, config, customParams, ticket, function (name) {
        createFeatureBranchPlain(config, name);
    });
}

/**
 * Dev-branch checkout decision tree: exists locally → plain checkout;
 * exists on remote → tracking checkout; absent → create from branchBase.
 */
function checkoutDevBranch(branchName, branchBase) {
    var localBranches = readLocalBranchList(branchName, 'Error checking local branches:');
    if (localBranches.trim()) {
        // Branch exists locally — check it out
        console.log('Branch exists locally, checking out:', branchName);
        cli_execute_command({ command: 'git checkout ' + branchName });
        return;
    }

    var remoteBranchExists = probeRemoteBranch(branchName, 'Error checking remote branches:');
    if (remoteBranchExists) {
        // Exists on remote — checkout tracking remote
        console.log('Branch exists on remote, checking out with tracking:', branchName);
        cli_execute_command({ command: 'git checkout -b ' + branchName + ' origin/' + branchName });
        return;
    }

    // New branch — start from base branch (or feature branch in two-branch mode)
    console.log('Creating new branch from', branchBase + ':', branchName);
    cli_execute_command({ command: 'git checkout ' + branchBase });
    cli_execute_command({ command: 'git pull origin ' + branchBase });
    cli_execute_command({ command: 'git checkout -b ' + branchName });
}

function action(params) {
    try {
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var customParams = resolveActionCustomParams(params);
        var ticketKey = params.ticket.key;
        var branchName = configLoader.resolveBranchName(config, params.ticket, 'development');

        console.log('Setting up branch for ticket:', ticketKey, '→', branchName);

        configureGitAuthor(config);
        fetchTargetBranch(config);

        // In two-branch mode, ensure feature branch exists before creating dev branch
        var branchBase = config.git.baseBranch;
        if (config.git.featureBranch && config.git.featureBranch.enabled) {
            branchBase = establishFeatureBranch(config, customParams, params.ticket);
        }

        checkoutDevBranch(branchName, branchBase);

        console.log('Branch ready:', branchName);

    } catch (error) {
        console.error('Error in checkoutBranch:', error);
        // Non-fatal: log but do not block CLI execution
    }
}

// Guarded export — dmtools invokes the top-level `action` global directly as a
// preCliJSAction, but exposing it via module.exports also lets unit tests load this file
// in isolation (see js/unit-tests/test_checkoutBranch.js).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        // gh-1190: seam helpers exposed for direct characterization tests.
        resolveActionCustomParams: resolveActionCustomParams,
        configureGitAuthor: configureGitAuthor,
        fetchTargetBranch: fetchTargetBranch,
        readLocalBranchList: readLocalBranchList,
        probeRemoteBranch: probeRemoteBranch,
        createFeatureBranch: createFeatureBranch,
        establishFeatureBranch: establishFeatureBranch,
        checkoutDevBranch: checkoutDevBranch
    };
}
