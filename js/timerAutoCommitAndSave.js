/**
 * Timer JS Action — Auto-commit, push, and save session artefacts
 *
 * Executed periodically (every timerIntervalSeconds) while CLI commands run.
 * Ensures code changes are never lost even if the runner crashes.
 *
 * Actions performed on each tick:
 * 1. If there are uncommitted changes in targetRepository workingDir → commit + push
 * 2. If there is accumulated CLI output → save a snapshot as a release asset
 *    (GitHub or GitLab, resolved from config.scm.provider / customParams.scmProvider)
 *
 * params available:
 *   params.currentCliOutput — accumulated CLI stdout so far
 *   params.jobParams.customParams — agent config customParams
 *   params.ticket — current ticket object (key, fields, etc.)
 *   params.jobParams.metadata.contextId — agent name (e.g. "sf_story_development")
 */

var releaseArtefacts = require('./common/releaseArtefacts.js');
var gitStaging = require('./common/gitStaging.js');
var mergeState = require('./common/mergeState.js');
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

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) ||
           params.customParams ||
           {};
}

function getTicketKey(params) {
    if (params.ticket && params.ticket.key) return params.ticket.key;
    if (params.ticketKey) return params.ticketKey;
    return null;
}

function getContextId(params) {
    var metadata = (params.jobParams && params.jobParams.metadata) || {};
    return metadata.contextId || 'unknown_agent';
}

/**
 * Auto-commit and push any uncommitted changes in the target repo working dir.
 * Returns true if a commit was made.
 */
function autoCommitAndPush(customParams, ticketKey) {
    var targetRepo = customParams.targetRepository || {};
    // Fallback: explicit runner customParams → the job working directory.
    // A missing config must never silently disable crash-safety commits
    // (dev legs ran for years without targetRepository — the timer was a
    // silent no-op there and kill-timeout runs lost the workspace).
    var workingDir = targetRepo.workingDir || '.';
    if (!targetRepo.workingDir) {
        console.warn('⏱️ timer: targetRepository.workingDir not configured — falling back to the job directory');
    }

    // Safety net: never auto-commit/push while sitting on the base branch
    // (develop/main/...). If setup failed to switch onto the ticket branch
    // (e.g. checkout error, missing PR), HEAD stays on baseBranch — pushing
    // WIP snapshots there would land straight in the mainline history instead
    // of the intended ticket branch.
    if (targetRepo.baseBranch) {
        var currentBranch;
        try {
            currentBranch = cli_execute_command({
                command: 'git rev-parse --abbrev-ref HEAD',
                workingDirectory: workingDir
            });
        } catch (e) {
            console.log('⏱️ timer: could not determine current branch, skipping:', e.toString().substring(0, 100));
            return false;
        }
        if (currentBranch && cleanCommandOutput(currentBranch) === targetRepo.baseBranch) {
            console.warn('⏱️ timer: HEAD is on base branch "' + targetRepo.baseBranch +
                '" — refusing to auto-commit/push (branch setup likely failed)');
            return false;
        }
    }

    // gh-761: skip the tick while a merge is in progress. MERGE_HEAD present
    // means a conflicted merge of the base branch sits unconcluded in the
    // working tree (the rework setup leaves it there for the agent to
    // resolve; the agent's own merge of origin/main may be mid-conflict).
    // A blind `git add -A && git commit` here would stage the unmerged paths
    // — conflict markers and all — and FINALIZE that merge as a 'WIP
    // auto-save' commit pushed to origin: silent branch corruption. The
    // probe runs BEFORE the dirty-tree check (a mid-merge status is always
    // dirty) and must come after the base-branch guard, which cheaply rules
    // out the more dangerous wrong-branch case first. The next tick after
    // the merge concludes (or is aborted) resumes normal auto-saving; the
    // session artefact upload in action() is git-independent and still runs.
    if (mergeState.isMergeInProgress(function (command) {
        return cli_execute_command({ command: command, workingDirectory: workingDir });
    }, workingDir)) {
        console.warn('⏱️ timer: MERGE_HEAD exists — merge in progress, skipping auto-commit/push this tick ' +
            '(a blind add/commit would finalize the conflicted merge and bake conflict markers into a WIP auto-save)');
        return false;
    }

    // Check for changes using git status
    var statusOutput;
    try {
        statusOutput = cli_execute_command({
            command: 'git status --porcelain',
            workingDirectory: workingDir
        });
    } catch (e) {
        console.log('⏱️ timer: git status failed:', e.toString().substring(0, 100));
        return false;
    }

    if (!statusOutput || !statusOutput.trim()) {
        return false;
    }

    // There are changes — commit and push
    var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    var commitMsg = ticketKey + ' WIP auto-save ' + timestamp;

    try {
        cli_execute_command({
            // Untrack machine-local runtime logs that older/poisoned
            // branches may already carry (gh-628: the timer itself swept
            // .dmtools/credential-helper.log — the credential helper's
            // serving trace — into three commits on ai/gh-628). Pathspec
            // exclusion alone cannot help a TRACKED file's changes, so the
            // cleanup removes them from the index. Shared canonical list:
            // js/common/gitStaging.js. One command (the old copilot-sessions
            // cleanup merged in) keeps the call count identical for tests.
            command: gitStaging.buildUntrackCommand(),
            workingDirectory: workingDir
        });
    } catch (cleanupErr) {
        console.log('⏱️ timer: session cache cleanup skipped:', cleanupErr.toString().substring(0, 100));
    }

    try {
        cli_execute_command({
            // `:!factory-kit`: the factory workflow's nested machine-infra
            // repo (when a pin still lands it in the workspace) is a gitlink
            // a bare `git add -A` cannot stage — exit 128 kills the timer
            // (live: fa gh-1044 leg 2026-10-03, clip 1791017320716).
            // `:!.dmtools/...` runtime logs (gh-628): the machine's runtime
            // artifacts live INSIDE the committed .dmtools/ directory
            // (config.js, runners/), so the directory itself cannot be
            // ignored — the credential helper's serving trace, fa trace and
            // run logs, the watchdog stall capture and the session store
            // must be excluded by pathspec, exactly like copilot-sessions.
            // `.dmtools-session-output.log` is this timer's own CLI-stdout
            // snapshot at the job root — a crash mid-upload leaves it
            // behind, and the next broad add would commit the full session
            // log into the ticket branch. Shared canonical list:
            // js/common/gitStaging.js.
            // gh-683 (live fa run 37153405587 — this timer's add was the
            // FIRST casualty of git's ignored-pathspec guard): naming an
            // existing ignored-untracked path in a `:!` exclusion pathspec
            // fails the whole add. The check-ignore probe below drops the
            // exclusion for every path git already ignores, so the timer's
            // WIP save can never die on the guard again.
            // gh-1164 (live fa runs 37153882406 + 37220167230): `factory-kit`
            // must go through the SAME probe — appended statically, it kept
            // tripping the guard every 5 minutes for 40+ minutes whenever the
            // kit was materialized AND gitignored, and the dev agent's work
            // died uncommitted with the runner.
            command: 'git add -A -- ' + gitStaging.buildStagingPathspecs(function (args) {
                return cli_execute_command({
                    command: args.command,
                    workingDirectory: workingDir
                });
            }, ['factory-kit']),
            workingDirectory: workingDir
        });
    } catch (e) {
        console.error('⏱️ timer: git add failed:', e.toString().substring(0, 100));
        return false;
    }

    try {
        cli_execute_command({
            command: 'git commit -m "' + commitMsg + '"',
            workingDirectory: workingDir
        });
    } catch (e) {
        // Could be "nothing to commit" after add
        console.log('⏱️ timer: git commit:', e.toString().substring(0, 100));
        return false;
    }

    try {
        cli_execute_command({
            command: 'git push origin HEAD',
            workingDirectory: workingDir
        });
        console.log('⏱️ timer: ✅ auto-committed and pushed: ' + commitMsg);
        return true;
    } catch (e) {
        console.error('⏱️ timer: git push failed:', e.toString().substring(0, 100));
        return false;
    }
}

/**
 * Save CLI output snapshot to releases as an artefact.
 * The asset name includes the agent contextId to distinguish between agents.
 *
 * Uses working-dir-relative paths (FileTools blocks /tmp/ as path traversal).
 * Uploads .log directly — no zip needed (timer doesn't inherit CLI_ALLOWED_COMMANDS,
 * so `zip` is not in whitelist; raw .log upload is simpler and sufficient).
 */
function saveSessionArtefact(params, customParams, ticketKey, contextId, currentCliOutput) {
    var artefactRepo = releaseArtefacts.resolveArtefactRepository(customParams);
    if (!artefactRepo) {
        return;
    }

    if (!currentCliOutput || !currentCliOutput.trim()) {
        return;
    }

    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var scmProvider = (projectConfig.scm && projectConfig.scm.provider) || 'github';

    var assetName = contextId + '-session.log';
    var tagTemplate = customParams.cacheToReleases && customParams.cacheToReleases.releaseTagTemplate;
    var nameTemplate = customParams.cacheToReleases && customParams.cacheToReleases.releaseNameTemplate;

    var tag = releaseArtefacts.buildTag(ticketKey, tagTemplate);
    var releaseConfig = { tagTemplate: tagTemplate, nameTemplate: nameTemplate };

    // Write to working dir (FileTools blocks /tmp/ paths)
    var outputFile = '.dmtools-session-output.log';

    var snapshotTimestamp = new Date().toISOString();
    var snapshotHeader = '=== ⏱️ TIMER SESSION SNAPSHOT START (saved at ' + snapshotTimestamp + ') ===\n' +
                         '=== This is a periodic snapshot of the running agent output, NOT a new agent run ===\n\n';
    var snapshotFooter = '\n\n=== ⏱️ TIMER SESSION SNAPSHOT END ===\n';

    try {
        file_write({ path: outputFile, content: snapshotHeader + currentCliOutput + snapshotFooter });
    } catch (e) {
        console.error('⏱️ timer: failed to write CLI output file:', e.toString().substring(0, 100));
        return;
    }

    // Upload .log directly to release (no zip, no CLI commands needed)
    var result = releaseArtefacts.uploadRawFile(
        artefactRepo.owner, artefactRepo.repo, ticketKey, releaseConfig, outputFile, assetName, scmProvider
    );
    if (result.success) {
        console.log('⏱️ timer: ✅ session saved: ' + assetName + ' → ' + tag + ' (' + scmProvider + ')');
    } else {
        console.error('⏱️ timer: session upload failed:', String(result.error).substring(0, 150));
    }

    // Cleanup
    try { file_delete({ path: outputFile }); } catch (e) { /* ignore */ }
}

/**
 * Main timer action entry point.
 */
function action(params) {
    var customParams = resolveCustomParams(params);
    var ticketKey = getTicketKey(params);
    var contextId = getContextId(params);
    var currentCliOutput = params.currentCliOutput || '';

    if (!ticketKey) {
        console.log('⏱️ timer: no ticketKey available, skipping');
        return;
    }

    // 1. Auto-commit and push changes
    autoCommitAndPush(customParams, ticketKey);

    // 2. Save currentCliOutput to releases as session artefact
    saveSessionArtefact(params, customParams, ticketKey, contextId, currentCliOutput);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
