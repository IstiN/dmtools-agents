/**
 * Pre-CLI snapshot setup — optional codegraph branch alignment for non-dev agents.
 *
 * Use case: BA / SA / discovery / questions agents need a codegraph snapshot that
 * matches the branch the implementation will eventually target. While dev agents
 * already align the branch in preCliDevelopmentSetup, other agents run against the
 * static checkout created by setup/checkout.sh (usually the repo default branch).
 *
 * Behavior:
 *   1. Optionally chains the agent's original preCliJSAction (configured via
 *      customParams.chainedPreCliJSAction) so existing setup is preserved.
 *   2. Resolves config.git.snapshotBranch through configLoader, which may invoke a
 *      project-specific snapshotBranchResolverFnPath (e.g. based on fixVersion).
 *   3. If a snapshotBranch different from the current HEAD is resolved, checks it
 *      out in targetRepository.workingDir and syncs codegraph.
 *
 * The action is fully backward-compatible: if no snapshotBranchResolverFnPath is
 * configured, or if targetRepository.workingDir is missing, it returns success
 * immediately without touching git state.
 */

var configLoader = require('./configLoader.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function runCommand(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

function lastNonEmptyLine(output) {
    var lines = cleanCommandOutput(output || '').split(/\r?\n/)
        .map(function(line) { return line.trim(); })
        .filter(function(line) { return line; });
    return lines[lines.length - 1] || '';
}

function currentBranch(workingDir) {
    try {
        return lastNonEmptyLine(runCommand('git rev-parse --abbrev-ref HEAD', workingDir));
    } catch (e) {
        return '';
    }
}

function checkoutSnapshotBranch(workingDir, branchName) {
    if (!workingDir || !branchName) return false;

    var current = currentBranch(workingDir);
    if (current === branchName) {
        try {
            runCommand('git pull origin ' + branchName + ' --ff-only', workingDir);
            console.log('preCliSnapshotSetup: already on ' + branchName + ', pulled latest');
            return true;
        } catch (e) {
            console.warn('preCliSnapshotSetup: pull failed:', e.message || e);
            return true; // still on right branch
        }
    }

    try {
        runCommand('git fetch origin ' + branchName, workingDir);
    } catch (e) {
        console.warn('preCliSnapshotSetup: could not fetch origin/' + branchName + ':', e.message || e);
    }

    try {
        runCommand('git checkout ' + branchName, workingDir);
    } catch (e) {
        console.log('preCliSnapshotSetup: local branch missing — creating from origin/' + branchName);
        runCommand('git checkout -B ' + branchName + ' origin/' + branchName, workingDir);
    }

    try {
        runCommand('git pull origin ' + branchName + ' --ff-only', workingDir);
    } catch (e) {
        console.warn('preCliSnapshotSetup: could not fast-forward ' + branchName + ':', e.message || e);
    }

    console.log('preCliSnapshotSetup: checked out snapshot branch ' + branchName + ' in ' + workingDir);
    return true;
}

function syncCodegraph(workspace) {
    try {
        runCommand('codegraph sync "' + workspace + '"', workspace);
        console.log('preCliSnapshotSetup: codegraph sync completed');
        return true;
    } catch (e) {
        console.warn('preCliSnapshotSetup: codegraph sync failed:', e.message || e);
        return false;
    }
}

function action(params) {
    try {
        var actualParams = params.ticket ? params : (params.jobParams || params);
        var customParams = actualParams.customParams || {};

        // 1. Preserve existing preCliJSAction behavior by chaining.
        var chained = customParams.chainedPreCliJSAction;
        if (chained) {
            try {
                // Paths in agent JSONs are relative to agents/js/.
                var chainedModule = require('./' + chained);
                if (chainedModule && typeof chainedModule.action === 'function') {
                    console.log('preCliSnapshotSetup: chaining ' + chained);
                    var chainedResult = chainedModule.action(params);
                    if (chainedResult === false) {
                        console.warn('preCliSnapshotSetup: chained action returned false — aborting');
                        return false;
                    }
                }
            } catch (chainError) {
                console.warn('preCliSnapshotSetup: chained action failed (non-fatal):', chainError.message || chainError);
            }
        }

        // 2. Resolve config. snapshotBranch is filled by snapshotBranchResolverFnPath if configured.
        // paramsForConfigLoad re-attaches params.ticket (sibling of jobParams in the
        // real Teammate execution path) so snapshotBranchResolverFnPath can key off the
        // ticket's fixVersion — see configLoader.js for details.
        var config = configLoader.loadProjectConfig(configLoader.paramsForConfigLoad(params));
        var snapshotBranch = config.git && config.git.snapshotBranch;
        if (!snapshotBranch) {
            console.log('preCliSnapshotSetup: no snapshotBranch configured — nothing to do');
            return true;
        }

        var targetRepo = config.customParams && config.customParams.targetRepository;
        var workingDir = targetRepo && targetRepo.workingDir;
        if (!workingDir) {
            console.log('preCliSnapshotSetup: no targetRepository.workingDir — skipping checkout');
            return true;
        }

        // 3. Align the dependency checkout with the snapshot branch.
        checkoutSnapshotBranch(workingDir, snapshotBranch);

        // 4. Refresh codegraph index so BA/SA/discovery agents see the aligned snapshot.
        var workspace = config.workingDir || '.';
        syncCodegraph(workspace);

        return true;
    } catch (error) {
        console.error('preCliSnapshotSetup: unexpected error:', error);
        // Never block the agent because of a snapshot setup failure.
        return true;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
