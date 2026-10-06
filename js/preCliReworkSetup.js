/**
 * Pre-CLI Rework Setup Action (preCliJSAction for pr_rework agent)
 * 1. Finds the existing PR for the ticket
 * 2. Checks out the PR branch
 * 3. Merges origin/{baseBranch} into the PR branch (auto-update, before setup commands run —
 *    see the comment above the detectMergeConflicts() call for why the order matters)
 * 4. Runs project-specific setup commands (build/verify) against the now-updated branch
 * 5. Writes input folder: pr_info.md, pr_diff.txt, pr_discussions.md, pr_discussions_raw.json
 * 6. Fetches question subtasks with answers (extra context)
 * 7. Posts "Rework Started" comment to the ticket (Jira/ADO/GitHub via common/trackers.js),
 *    rendered in the ticket's markup flavor (Markdown on GitHub, wiki on Jira — gh-770)
 */

var configLoader = require('./configLoader.js');
var trackersModule = require('./common/trackers.js');
var commentMarkup = require('./common/commentMarkup.js');
const gh = require('./common/githubHelpers.js');
const gitOps = require('./common/gitOps.js');
const { resolveStatuses } = require('./config.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
const fetchParentContextToInput = require('./fetchParentContextToInput.js');
var restoreFromReleases = require('./restoreFromReleases.js');
var setupCommands = require('./common/setupCommands.js');
var baseBranchMarker = require('./common/baseBranchMarker.js');

/**
 * Optionally syncs the PR's base branch with its own upstream (config.git.baseBranch)
 * before merge-conflict detection runs. Relevant in two-branch mode, where the PR's base is
 * a long-lived branch (e.g. "release/rc_*") that can drift stale relative to
 * config.git.baseBranch over time. Delegates to a project-specific hook
 * (customParams.branchSyncFnPath) because syncing may require bypassing branch-protection
 * rules that block direct pushes to that branch — same rationale as
 * customParams.branchCreateFnPath in checkoutBranch.js.
 *
 * No-op when branchSyncFnPath isn't configured, or when the PR's base already IS
 * config.git.baseBranch (nothing to sync). Failures are logged and swallowed — the sync is
 * a best-effort freshness step, not a hard prerequisite for the rest of the rework flow.
 *
 * @param {string} baseBranch    - the PR's base branch (prDetails.base.ref)
 * @param {Object} customParams  - agent customParams (may contain branchSyncFnPath)
 * @param {Object} config        - resolved project config (config.git.baseBranch, workingDir)
 */
function syncBaseBranchIfConfigured(baseBranch, customParams, config) {
    if (!customParams || !customParams.branchSyncFnPath || !baseBranch || baseBranch === config.git.baseBranch) {
        return;
    }
    var branchSyncFn = configLoader.loadHookFn(customParams.branchSyncFnPath, 'branchSyncFnPath');
    if (!branchSyncFn) {
        return;
    }
    try {
        console.log('Syncing base branch', baseBranch, 'via', customParams.branchSyncFnPath);
        branchSyncFn({
            branchName: baseBranch,
            targetBranch: config.git.baseBranch,
            workingDir: config.workingDir,
            config: config
        });
        cli_execute_command({ command: gh.buildOriginFetchCommand() });
    } catch (e) {
        console.warn('branchSyncFnPath failed (non-fatal):', e && e.toString ? e.toString() : String(e));
    }
}

// Defensive cap on Jira/tracker comment length for any failSetup() caller. The
// setupCommands module already truncates its own embedded command output at the
// source (see truncateSetupError), but other failure messages here (e.g. branch
// checkout errors) could still, in principle, be arbitrarily long — Jira rejects
// comments over ~350000 characters, and previously that rejection was silently
// swallowed, leaving the ticket with no visible failure reason at all.
var truncateForComment = setupCommands.truncateSetupError;

/**
 * Build the "Automated Rework Started" comment in the flavor of the ticket's
 * tracker (gh-770). The template historically hard-coded Jira wiki markup
 * (h3., {panel:bgColor=...}, {code}), which renders as raw text garbage on
 * GitHub issues; the flavor comes from common/commentMarkup.js so the same
 * script renders Markdown on GitHub and wiki on Jira.
 *
 * @param {Object} flavor - a commentMarkup flavor bag (forTicket/forFlavor)
 * @param {Object} ctx    - { prNumber, prUrl, branchName, conflictFiles, failedChecks }
 * @returns {string} the rendered comment
 */
function buildReworkStartedComment(flavor, ctx) {
    var m = flavor;
    var comment = m.h(3, '🔧 Automated Rework Started') + '\n\n' +
        m.bold('Pull Request') + ': ' + m.link('PR #' + ctx.prNumber, ctx.prUrl) + '\n' +
        m.bold('Branch') + ': ' + m.code(ctx.branchName) + '\n\n';

    var conflicts = ctx.conflictFiles || [];
    if (conflicts.length > 0) {
        comment += m.panel(null,
            '⚠️ ' + m.bold('Merge conflicts detected') + ' — ' + conflicts.length +
                ' file(s) must be resolved before rework can be applied:\n' +
            conflicts.map(function (f) { return '* ' + m.code(f); }).join('\n'),
            'bgColor=#FFEBE6|borderColor=#DE350B') + '\n\n';
    }

    var checks = ctx.failedChecks || [];
    if (checks.length > 0) {
        comment += m.panel(null,
            '⚠️ ' + m.bold('CI checks failing') + ' — ' + checks.length + ' check(s) must pass before merge:\n' +
            checks.map(function (c) { return '* ' + m.code(c.name); }).join('\n') +
            '\nError logs: ' + m.code('ci_failures.md') + ' (summary) and ' + m.code('ci_failures_full.log') + ' (full logs).',
            'bgColor=#FFEBE6|borderColor=#DE350B') + '\n\n';
    }

    comment += 'AI Teammate is fixing issues raised in the code review.\n\n' +
        m.italic('Fix results will be posted shortly...');
    return comment;
}

function failSetup(tracker, ticketKey, inputFolder, message, customParams) {
    try {
        file_write({
            path: inputFolder + '/rework_setup_failed.md',
            content: '# Rework Setup Failed\n\n' + message + '\n'
        });
    } catch (e) {
        console.warn('Failed to write rework setup failure marker:', e);
    }
    try {
        var m = commentMarkup.forTicket(ticketKey, customParams);
        tracker.postComment(
            ticketKey,
            m.h(3, '❌ Rework Setup Failed') + '\n\n' + truncateForComment(message)
        );
    } catch (e) {
        // PR-anchored reworks (#544): a 'pr-N' key parses to no tracker
        // ticket — the comment is best-effort, the failure marker file is
        // the source of truth.
        console.error('Failed to post rework setup failure comment to ' + ticketKey + ':', e && e.toString ? e.toString() : String(e));
    }
    throw new Error(message);
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var inputFolder = actualParams.inputFolderPath;
        var ticketKey = inputFolder.split('/').pop();
        // PR-anchored rework (#544): a `pr-N` contextId makes the PR itself
        // the anchor — the labeled PR has no local issue (guest/issue-less
        // PR the owner labeled agent:rework). The PR number is taken
        // directly, no findPRForTicket body/branch scrape; tracker status
        // moves and ticket comments are skipped (a 'pr-N' key parses to no
        // GitHub issue — comments would throw).
        var anchorMatch = /^pr-(\d+)$/.exec(String(ticketKey || ''));
        var jp0 = params.jobParams || params;
        const prAnchor = (anchorMatch ? parseInt(anchorMatch[1], 10) : null) ||
            (parseInt(jp0.prNumber || jp0.pr || '', 10) || null);
        // paramsForConfigLoad re-attaches params.ticket (sibling of jobParams in the
        // real Teammate execution path) so baseBranchResolverFnPath can key off the
        // ticket's fixVersion — see configLoader.js for details.
        var config = configLoader.loadProjectConfig(configLoader.paramsForConfigLoad(params));
        var customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
        var scm = configLoader.createScm(config);
        var statuses = resolveStatuses(customParams, config.jira && config.jira.statuses);
        // Probe the tracker provider once — the same script then runs unchanged
        // on Jira / ADO / GitHub deployments.
        var tracker = trackersModule.createTracker(config, customParams);

        // Restore configured artefacts (e.g. cosmo test reports) from GitHub Release — non-fatal
        try { restoreFromReleases.action(params); } catch (e) { console.warn('⚠️ restoreFromReleases failed (non-fatal):', e); }

        console.log('=== Rework setup for:', ticketKey, '===');

        // Move ticket to In Development (visible "actively being worked" marker, mirrors the
        // same transition in preCliDevelopmentSetup.js for fresh development). Opt-in only
        // (config.jira.markReworkInDevelopment) — projects whose rework bounce-back target
        // already IS an "actively being worked" status (e.g. the default IN_REWORK) don't need
        // this extra transition; enable it for projects that bounce back to a "queued" status
        // instead (e.g. READY_FOR_DEVELOPMENT) so there is still a visible marker once work starts.
        if (config.jira && config.jira.markReworkInDevelopment && !prAnchor) {
            try {
                tracker.moveToStatus(ticketKey, statuses.IN_DEVELOPMENT);
                console.log('Moved ' + ticketKey + ' to ' + statuses.IN_DEVELOPMENT);
            } catch (e) {
                console.warn('Failed to move ticket to ' + statuses.IN_DEVELOPMENT + ':', e);
            }
        }

        // Step 1: GitHub repo info — prefer targetRepository from config over git remote
        var repoInfo = null;
        if (config.repository && config.repository.owner && config.repository.repo) {
            repoInfo = { owner: config.repository.owner, repo: config.repository.repo };
            console.log('Using targetRepository from config:', repoInfo.owner + '/' + repoInfo.repo);
        } else {
            repoInfo = scm.getRemoteRepoInfo();
        }
        if (!repoInfo) {
            const err = 'Could not determine GitHub repository from git remote';
            try {
                var mRepoFail = commentMarkup.forTicket(ticketKey, customParams);
                tracker.postComment(ticketKey, mRepoFail.h(3, '❌ Rework Setup Failed') + '\n\n' + err);
            } catch (e) {}
            return { success: false, error: err };
        }

        // Step 2: Find existing PR — PR-anchored (#544): the anchor IS the PR.
        var pr;
        if (prAnchor) {
            console.log('PR-anchored rework: PR #' + prAnchor + ' (no ticket lookup, #544)');
            pr = { number: prAnchor };
        } else {
            var prSearchOptions = config.prSearchFn ? { prSearchFn: config.prSearchFn } : {};
            pr = gh.findPRForTicket(scm, ticketKey, prSearchOptions);
        }
        if (!pr) {
            failSetup(
                tracker,
                ticketKey,
                inputFolder,
                'No Pull Request found for ticket ' + ticketKey + '. Cannot start rework without an existing PR.',
                customParams
            );
        }

        // Step 3: PR details
        const prDetails = gh.getPRDetails(scm, pr.number);
        if (!prDetails) {
            failSetup(tracker, ticketKey, inputFolder, 'Failed to fetch PR details for PR #' + pr.number, customParams);
        }

        // Step 4: Checkout PR branch
        const branchName = prDetails.head ? prDetails.head.ref : null;
        if (!branchName) {
            failSetup(tracker, ticketKey, inputFolder, 'Could not determine branch from PR details', customParams);
        }
        try {
            gitOps.checkoutPRBranch(branchName, config.workingDir, config.git.baseBranch);
        } catch (e) {
            failSetup(tracker, ticketKey, inputFolder, 'Failed to checkout branch: ' + e.toString(), customParams);
        }

        const baseBranch = prDetails.base ? prDetails.base.ref : config.git.baseBranch;

        // Persist the PR's real base branch to outputs/pr_base_branch.txt so that
        // quality-gate shell commands (static strings in the job's JSON config, unable
        // to reference config.git.baseBranch at runtime) can read the actual target
        // branch instead of relying on a hardcoded literal like "origin/master" — see
        // js/common/baseBranchMarker.js docblock for the full rationale.
        baseBranchMarker.writeBaseBranchMarker(baseBranch);

        // Step 4.4: Optionally sync the PR's base branch with its own upstream — see
        // syncBaseBranchIfConfigured() docblock for the rationale.
        syncBaseBranchIfConfigured(baseBranch, customParams, config);

        // Step 4.5: Merge base branch and detect conflicts.
        // Always merges origin/{baseBranch} so the branch stays up to date.
        // If conflicts exist, writes merge_conflicts.md to the input folder.
        //
        // This MUST run before Step 4.6 (setup commands): setupCommands typically builds
        // and tests the repo (e.g. `mvn clean verify`), and the PR branch itself can be
        // arbitrarily stale relative to baseBranch — including fixes to the very tests
        // setupCommands runs (a flaky/broken test fixed on baseBranch stays broken on any
        // PR branch forked before that fix, until the PR branch is brought up to date).
        // Running the merge first means setup commands validate the code the CLI agent is
        // about to work on top of (merged, even if only staged/uncommitted), not a stale
        // pre-merge snapshot — this is the "auto-update the branch on every rework run"
        // behavior that should hold out of the box, not depend on someone remembering to
        // rebase the PR branch manually.
        const conflictFiles = gitOps.detectMergeConflicts(baseBranch, inputFolder, config.workingDir);

        // Step 4.6: Run project-specific prerequisite/setup commands (e.g. install
        // JDK/Maven, verify build credentials) before the CLI agent starts fixing code.
        try {
            var setupResult = setupCommands.runSetupCommands(customParams, config.workingDir);
            var setupWarnings = setupCommands.buildSetupWarningsMarkdown(setupResult);
            if (setupWarnings) {
                try {
                    file_write({ path: inputFolder + '/setup_warnings.md', content: setupWarnings });
                    console.log('⚠️ Wrote setup_warnings.md (non-fatal setup command failure(s))');
                } catch (writeErr) {
                    console.warn('Failed to write setup_warnings.md:', writeErr);
                }
            }
        } catch (e) {
            failSetup(tracker, ticketKey, inputFolder, 'Environment setup failed: ' + (e && e.toString ? e.toString() : String(e)), customParams);
        }

        // Step 4.7: Detect failed CI checks — writes ci_failures.md if any failed
        const headSha = prDetails.head ? prDetails.head.sha : null;
        const failedChecks = gh.detectFailedChecks(scm, headSha, inputFolder, config.scm && config.scm.jenkinsBasePath);

        // Step 5: Diff + discussions (human-readable + raw with IDs)
        const diff = gitOps.getPRDiff(baseBranch, branchName, config.workingDir);

        console.log('Fetching PR discussions...');
        const discussionData = gh.fetchDiscussionsAndRawData(scm, pr.number);

        // Step 6: Write all context files
        gitOps.writePRContext(inputFolder, prDetails, diff, discussionData.markdown, discussionData.rawThreads);

        // Step 7: Fetch question subtasks with answers
        try {
            fetchQuestionsToInput.action(actualParams);
        } catch (e) {
            console.warn('Failed to fetch questions (non-fatal):', e);
        }

        // Step 8: tracker comment — skipped for PR-anchored reworks (#544):
        // a 'pr-N' key parses to no tracker ticket (the PR comment comes
        // from the post action instead).
        if (prAnchor) {
            console.log('PR-anchored rework: skipping tracker comment (no ticket, #544)');
        } else try {
            // Rendered in the flavor of the ticket's tracker (gh-770):
            // Markdown on GitHub issues, wiki markup on Jira.
            tracker.postComment(ticketKey, buildReworkStartedComment(
                commentMarkup.forTicket(ticketKey, customParams),
                {
                    prNumber: prDetails.number,
                    prUrl: prDetails.html_url,
                    branchName: branchName,
                    conflictFiles: conflictFiles,
                    failedChecks: failedChecks
                }
            ));
        } catch (e) {
            console.warn('Failed to post tracker comment:', e);
        }

        console.log('✅ Rework setup complete — branch:', branchName, '| PR #' + prDetails.number);

        // Enrich input with [BA]/[SA]/[VD] context from parent siblings
        try {
            fetchParentContextToInput.action(params);
        } catch (e) {
            console.warn('fetchParentContextToInput failed (non-fatal):', e);
        }

        return {
            success: true,
            prNumber: prDetails.number,
            prUrl: prDetails.html_url,
            branchName: branchName,
            owner: repoInfo.owner,
            repo: repoInfo.repo
        };

    } catch (error) {
        console.error('❌ Error in preCliReworkSetup:', error);
        try {
            const ticketKey = (params.inputFolderPath ||
                (params.jobParams && params.jobParams.inputFolderPath) || '').split('/').pop();
            if (ticketKey) {
                // Post the error to the ticket via the probed tracker provider
                var errorTracker = (typeof tracker !== 'undefined' && tracker) ? tracker : null;
                if (!errorTracker) {
                    try {
                        errorTracker = trackersModule.createTracker(
                            configLoader.loadProjectConfig(configLoader.paramsForConfigLoad(params)),
                            (params.jobParams && params.jobParams.customParams) || params.customParams);
                    } catch (trackerError) {
                        console.error('Failed to create tracker for error comment:', trackerError);
                    }
                }
                if (errorTracker) {
                    // Flavor follows the ticket's tracker (gh-770): Markdown
                    // on GitHub issues, wiki markup on Jira.
                    var errorCustomParams = (params.jobParams && params.jobParams.customParams) || params.customParams;
                    var em = commentMarkup.forTicket(ticketKey, errorCustomParams);
                    errorTracker.postComment(
                        ticketKey,
                        em.h(3, '❌ Rework Setup Error') + '\n\n' + em.code(truncateForComment(error.toString()))
                    );
                }
            }
        } catch (e) {
            console.error('Failed to post rework setup error comment:', e && e.toString ? e.toString() : String(e));
        }
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, syncBaseBranchIfConfigured, truncateForComment, buildReworkStartedComment };
}
