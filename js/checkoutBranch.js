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

// Adapter matching the (command, workingDir) signature of the
// common/pullRequest.js probe helpers (gh-912) — this action always runs in
// the job root, so workingDir stays unset.
function runCommandForProbes(command) {
    return cli_execute_command({ command: command });
}

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function action(params) {
    try {
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
        var ticketKey = params.ticket.key;
        var branchName = configLoader.resolveBranchName(config, params.ticket, 'development');

        console.log('Setting up branch for ticket:', ticketKey, '→', branchName);

        // Configure git author
        try {
            cli_execute_command({ command: 'git config user.name "' + config.git.authorName + '"' });
            cli_execute_command({ command: 'git config user.email "' + config.git.authorEmail + '"' });
            console.log('Configured git author');
        } catch (e) {
            console.warn('Failed to configure git author:', e);
        }

        // Fetch latest remote state — target branch only (owner 2026-10-03:
        // blanket fetches are banned; feature-branch checks use ls-remote).
        try {
            var baseFetch = prHelper.buildTargetedOriginFetchCommand([config.git.baseBranch]);
            if (baseFetch) cli_execute_command({ command: baseFetch });
            console.log('Fetched target branch:', config.git.baseBranch);
        } catch (e) {
            console.warn('Could not fetch remote branches:', e);
        }

        // In two-branch mode, ensure feature branch exists before creating dev branch
        var branchBase = config.git.baseBranch;
        if (config.git.featureBranch && config.git.featureBranch.enabled) {
            var featureBranchName = configLoader.resolveBranchName(config, params.ticket, 'feature');
            var featureLocal = '';
            try {
                featureLocal = cleanCommandOutput(cli_execute_command({ command: 'git branch --list "' + featureBranchName + '"' }) || '');
            } catch (e) {}
            var featureRemoteExists = false;
            try {
                featureRemoteExists = prHelper.remoteBranchExists(runCommandForProbes, null, featureBranchName);
            } catch (e) {}
            if (!featureLocal.trim() && !featureRemoteExists) {
                var branchCreateFn = customParams.branchCreateFnPath
                    ? configLoader.loadHookFn(customParams.branchCreateFnPath, 'branchCreateFnPath')
                    : null;
                if (branchCreateFn) {
                    console.log('Two-branch mode: delegating feature branch creation to', customParams.branchCreateFnPath, '→', featureBranchName);
                    branchCreateFn({
                        branchName: featureBranchName,
                        baseBranch: config.git.baseBranch,
                        workingDir: config.workingDir,
                        ticket: params.ticket,
                        config: config
                    });
                    // The hook is responsible for making featureBranchName exist on origin
                    // (e.g. via an external CI job) — fetch it and check it out like any
                    // other pre-existing remote branch.
                    cli_execute_command({ command: prHelper.buildOriginFetchCommand() });
                    cli_execute_command({ command: 'git checkout -b ' + featureBranchName + ' origin/' + featureBranchName });
                } else {
                    console.log('Two-branch mode: creating feature branch from', config.git.baseBranch + ':', featureBranchName);
                    cli_execute_command({ command: 'git checkout ' + config.git.baseBranch });
                    cli_execute_command({ command: 'git pull origin ' + config.git.baseBranch });
                    cli_execute_command({ command: 'git checkout -b ' + featureBranchName });
                    cli_execute_command({ command: 'git push -u origin ' + featureBranchName });
                }
            } else if (featureRemoteExists && !featureLocal.trim()) {
                cli_execute_command({ command: 'git checkout -b ' + featureBranchName + ' origin/' + featureBranchName });
            } else {
                cli_execute_command({ command: 'git checkout ' + featureBranchName });
            }
            branchBase = featureBranchName;
            console.log('Two-branch mode: dev branch will be created from feature branch:', featureBranchName);
        }

        // Check if branch exists locally
        var localBranches = '';
        try {
            var rawLocal = cli_execute_command({ command: 'git branch --list "' + branchName + '"' }) || '';
            localBranches = cleanCommandOutput(rawLocal);
        } catch (e) {
            console.warn('Error checking local branches:', e);
        }

        if (localBranches.trim()) {
            // Branch exists locally — check it out
            console.log('Branch exists locally, checking out:', branchName);
            cli_execute_command({ command: 'git checkout ' + branchName });
        } else {
            // Check if branch exists on remote
            var remoteBranchExists = false;
            try {
                // gh-912: decide on a real refs/heads/<branch> ref line — a
                // warning-only capture (central-mode insteadOf origin, git ≥
                // 2.54) must classify as "branch absent".
                remoteBranchExists = prHelper.remoteBranchExists(runCommandForProbes, null, branchName);
            } catch (e) {
                console.warn('Error checking remote branches:', e);
            }

            if (remoteBranchExists) {
                // Exists on remote — checkout tracking remote
                console.log('Branch exists on remote, checking out with tracking:', branchName);
                cli_execute_command({ command: 'git checkout -b ' + branchName + ' origin/' + branchName });
            } else {
                // New branch — start from base branch (or feature branch in two-branch mode)
                console.log('Creating new branch from', branchBase + ':', branchName);
                cli_execute_command({ command: 'git checkout ' + branchBase });
                cli_execute_command({ command: 'git pull origin ' + branchBase });
                cli_execute_command({ command: 'git checkout -b ' + branchName });
            }
        }

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
    module.exports = { action };
}
