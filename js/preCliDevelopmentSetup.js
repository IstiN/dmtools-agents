/**
 * Pre-CLI Development Setup Action
 * Combined preCliJSAction for development agents:
 * 1. Moves ticket to In Development status
 * 2. Checks out the feature branch (creating if needed) — ai/<TICKET-KEY>
 * 3. Fetches existing question subtasks with answers into the input folder
 *
 * Used by: story_development.json, test_case_automation.json
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
const { GIT_CONFIG, STATUSES, resolveStatuses } = require('./config.js');
const fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
const fetchLinkedTestsToInput = require('./fetchLinkedTestsToInput.js');
const fetchParentContextToInput = require('./fetchParentContextToInput.js');
var restoreFromReleases = require('./restoreFromReleases.js');
var setupCommands = require('./common/setupCommands.js');
var baseBranchMarker = require('./common/baseBranchMarker.js');
var branchSetup = require('./common/branchSetup.js');
var trackersModule = require('./common/trackers.js');
var commentMarkup = require('./common/commentMarkup.js');

// Universal working-directory-aware wrapper for cli_execute_command.
// When config.workingDir is set (via customParams.targetRepository.workingDir),
// all git/shell commands are executed inside that directory.
var _workingDir = null;
function runCmd(args) {
    if (_workingDir) args.workingDirectory = _workingDir;
    return cli_execute_command(args);
}

// Adapter matching the (command, workingDir) signature expected by
// common/pullRequest.js helpers (e.g. ensureRemoteBranchRef) — workingDir is
// captured via the module-level _workingDir closure by runCmd already, so the
// second argument here is accepted but unused.
function runCommandStr(command) {
    return runCmd({ command: command });
}

/**
 * Clean command output from script wrapper artifacts and line-anchored git
 * noise — delegated to the canonical helper (gh-823 one-copy rule; gh-912
 * warning filter lives there once).
 * @param {string} output - Raw command output
 * @returns {string} Cleaned output
 */
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function branchHasUniquePatches(baseBranch) {
    return branchSetup.branchHasUniquePatches(prHelper, runCommandStr, baseBranch, 'Could not inspect unique branch patches:');
}

function isAncestorRef(ancestor, descendant) {
    try {
        runCmd({ command: 'git merge-base --is-ancestor ' + ancestor + ' ' + descendant });
        return true;
    } catch (e) {
        return false;
    }
}

function findMergeBase(left, right) {
    return branchSetup.findMergeBase(prHelper, runCommandStr, left, right);
}

function alignBranchWithBase(ticketKey, branchName, baseBranch) {
    if (isAncestorRef('HEAD', 'origin/' + baseBranch)) {
        console.log('Branch changes are already included in origin/' + baseBranch + ', resetting local branch:', branchName);
        runCmd({ command: 'git reset --hard origin/' + baseBranch });
        return;
    }

    if (!branchHasUniquePatches(baseBranch)) {
        console.log('Branch has no unique patches versus origin/' + baseBranch + ', resetting local branch:', branchName);
        runCmd({ command: 'git reset --hard origin/' + baseBranch });
        return;
    }

    if (isAncestorRef('origin/' + baseBranch, 'HEAD')) {
        console.log('Branch already contains origin/' + baseBranch + ':', branchName);
        return;
    }
    console.warn('Branch does not contain origin/' + baseBranch + ':', branchName);

    var details = branchSetup.collectMergeTreeDetails(
        prHelper,
        runCommandStr,
        baseBranch,
        'No merge base found between HEAD and origin/' + baseBranch + '. The local checkout is likely shallow or the branch history is unrelated to the current base.'
    );
    branchSetup.writeBranchConflictGuidance(
        ticketKey,
        branchName,
        baseBranch,
        details.substring(0, 6000),
        'work',
        'Do not discard the branch work automatically. If a merge conflict appears while syncing with `origin/' + baseBranch + '`, ' +
            'resolve it deliberately. In most cases, prefer `origin/' + baseBranch + '` for repository setup, generated workflow/config files, ' +
            'and shared infrastructure, then re-apply only the ticket-specific implementation that is still relevant.',
        null
    );
    console.warn('Keeping divergent branch ' + branchName + '; conflict guidance written for the agent.');
}

// ── Generated index guard (.codegraph) ──────────────────────────────────────
// `codegraph init/sync` (CI setup step) stages .codegraph/ into the git index.
// If an older run auto-committed that generated index onto the target branch,
// `git checkout <branch>` fails with "Your local changes ... would be
// overwritten". Move the index aside for the duration of branch setup and
// restore it afterwards; if the checked-out branch still tracks .codegraph,
// untrack it so the next auto-commit removes it (self-healing).
// Shell builtins (if/mv/rm/test) are not in the cli_execute_command
// whitelist — wrap them in `bash -c` (whitelisted). IMPORTANT: dmtools'
// shell-metacharacter guard scans the whole string passed to cli_execute_command,
// including the text quoted inside `bash -c "..."` — it does NOT parse quoting,
// so a single `bash -c` call can never contain `;`, `&&`, `||`, `>`/`>>`, etc.,
// even safely inside its own quotes. Every previous attempt at chaining
// if/then/&&/>> inside one bash -c call was silently rejected with
// "disallowed shell metacharacters" on every run, making this guard a no-op.
// Do branching/sequencing in JS instead, and use file_read/file_write (not
// shell grep/printf/>>) for the .gitignore edit.
function commandSucceeds(command) {
    try {
        runCmd({ command: command });
        return true;
    } catch (e) {
        return false;
    }
}

function stashGeneratedIndex() {
    try { runCmd({ command: 'git rm -r --cached --ignore-unmatch .codegraph' }); } catch (e) { }
    if (!commandSucceeds('bash -c "test -d .codegraph"')) return;
    try {
        try { runCmd({ command: 'bash -c "rm -rf .codegraph.branch-setup-bak"' }); } catch (e) { }
        runCmd({ command: 'bash -c "mv .codegraph .codegraph.branch-setup-bak"' });
    } catch (e) {
        console.warn('Could not move .codegraph aside before branch setup:', e);
    }
}

function ensureCodegraphLocalExclude() {
    // .git/info/exclude (not .gitignore): the entry must never reach the
    // target repo's committed files — agents run `git add -A`, and a
    // factory-written .gitignore line would leak into every agent PR.
    branchSetup.ensureGitInfoExclude(
        '.codegraph/',
        '# CodeGraph generated index - regenerated per-run, must never be committed',
        'Could not add .codegraph/ to .git/info/exclude:'
    );
}

function restoreGeneratedIndex() {
    try { runCmd({ command: 'git rm -r --cached --ignore-unmatch .codegraph' }); } catch (e) { }
    ensureCodegraphLocalExclude();
    if (!commandSucceeds('bash -c "test -d .codegraph.branch-setup-bak"')) return;
    try {
        try { runCmd({ command: 'bash -c "rm -rf .codegraph"' }); } catch (e) { }
        runCmd({ command: 'bash -c "mv .codegraph.branch-setup-bak .codegraph"' });
    } catch (e) {
        console.warn('Could not restore .codegraph after branch setup:', e);
    }
}

// ── gh-1190: checkoutBranch seam split ──────────────────────────────────────
// Mirrors the checkoutBranch.js extraction: pure route decisions plus small
// side-effecting clusters keep checkoutBranch() linear; the exact commands,
// log lines and their order are unchanged (characterization tests:
// js/unit-tests/test_preCliDevelopmentSetup.js).

/** Best-effort git author configuration — failures are warnings only. */
function configureSetupAuthor(config) {
    branchSetup.configureGitAuthor(runCommandStr, config, false);
}

/** Targeted origin fetch of the dev + rebase-base branches — warnings only. */
function fetchDevBranchRefs(branchName, rebaseBase) {
    branchSetup.fetchBranchRefs(prHelper, runCommandStr, [branchName, rebaseBase], 'Could not fetch remote branches:');
}

/**
 * `git branch --list` capture for `branchName`, cleaned of wrapper artifacts.
 * `warnMessage` (optional) is logged with the error when the probe fails —
 * pass null for the silent two-branch feature probes.
 */
function readLocalBranchList(branchName, warnMessage) {
    return branchSetup.readLocalBranchList(prHelper, runCommandStr, branchName, warnMessage);
}

/** Strict ls-remote existence probe (gh-912) — `warnMessage` optional. */
function probeRemoteBranch(branchName, warnMessage) {
    // gh-912: decide on a real refs/heads/<branch> ref line — a
    // warning-only capture (central-mode insteadOf origin, git ≥
    // 2.54) must classify as "branch absent" so the create-branch
    // path runs instead of a fatal checkout of a missing ref.
    return branchSetup.probeRemoteBranch(prHelper, runCommandStr, _workingDir, branchName, warnMessage);
}

/** Plain (no-hook) two-branch feature creation tail for this action. */
function createFeatureBranchPlain(config, featureBranchName) {
    // ensureRemoteBranchRef fetches with an explicit destination refspec
    // (+refs/heads/<b>:refs/remotes/origin/<b>) so origin/<baseBranch> exists
    // even in a shallow/single-branch CI clone that never checked this branch
    // out before (e.g. a fixVersion-derived "develop/3.0") — a plain
    // `git checkout <baseBranch>` would otherwise fail with "pathspec ...
    // did not match any file(s) known to git".
    prHelper.ensureRemoteBranchRef(runCommandStr, _workingDir, config.git.baseBranch);
    runCmd({ command: 'git checkout -B ' + config.git.baseBranch + ' origin/' + config.git.baseBranch });
    runCmd({ command: 'git checkout -b ' + featureBranchName });
    runCmd({ command: 'git push -u origin ' + featureBranchName });
}

/**
 * Two-branch mode: make the feature branch exist — via the configured
 * branchCreateFnPath hook (project-specific mechanism; the hook is
 * responsible for making the branch exist on origin, so it is fetched and
 * checked out like any other pre-existing remote branch) or a plain
 * base-branch reset + push when no hook is configured.
 */
function createFeatureBranch(config, customParams, ticket, featureBranchName) {
    branchSetup.createFeatureBranch(prHelper, configLoader, runCommandStr, config, customParams, ticket, featureBranchName, function (name) {
        createFeatureBranchPlain(config, name);
    });
}

/**
 * Two-branch mode: ensure the feature branch exists and check it out.
 * Returns the feature branch name — the dev branch is created from it.
 */
function establishFeatureBranch(config, customParams, ticket) {
    return branchSetup.establishFeatureBranch(prHelper, configLoader, runCommandStr, _workingDir, config, customParams, ticket, function (name) {
        createFeatureBranchPlain(config, name);
    });
}

/** Local dev branch: checkout, then align with the base branch. */
function checkoutLocalBranchWithAlign(ticketKey, branchName, rebaseBase) {
    console.log('Branch exists locally, aligning with base:', branchName);
    runCmd({ command: 'git checkout ' + branchName });
    alignBranchWithBase(ticketKey, branchName, rebaseBase);
}

/**
 * Pre-existing remote dev branch: fetch it explicitly (git fetch origin
 * --prune may not populate the local branch if the repo is sparse/shallow),
 * check it out, then align with base — falling back to a hard reset from
 * origin when the fetch+checkout fails.
 */
function checkoutExistingRemoteBranch(ticketKey, branchName, rebaseBase) {
    console.log('Branch exists on remote, fetching and aligning with base:', branchName);
    try {
        runCmd({ command: prHelper.buildOriginFetchCommand(branchName + ':' + branchName) });
        runCmd({ command: 'git checkout ' + branchName });
    } catch (fetchCheckoutErr) {
        console.warn('fetch+checkout failed, resetting local branch from origin:', fetchCheckoutErr);
        prHelper.ensureRemoteBranchRef(runCommandStr, _workingDir, branchName);
        runCmd({ command: 'git checkout -B ' + branchName + ' origin/' + branchName });
    }
    alignBranchWithBase(ticketKey, branchName, rebaseBase);
}

/**
 * Brand-new dev branch: in two-branch mode first ensure the feature branch
 * exists (it becomes the base), then create the dev branch from branchBase.
 */
function createNewDevBranch(config, customParams, ticket, branchName) {
    var branchBase = config.git.baseBranch;
    if (config.git.featureBranch && config.git.featureBranch.enabled) {
        branchBase = establishFeatureBranch(config, customParams, ticket);
    }
    console.log('Creating new branch from', branchBase + ':', branchName);
    // ensureRemoteBranchRef fetches with an explicit destination refspec so
    // origin/<branchBase> actually exists locally before checkout — a plain
    // `git fetch origin <branchBase>` (no destination refspec) only updates
    // FETCH_HEAD, so a subsequent `git checkout <branchBase>` fails with
    // "pathspec ... did not match any file(s) known to git" whenever branchBase
    // was never checked out in this clone before (e.g. a fresh/shallow CI clone,
    // or a fixVersion-derived base branch like "develop/3.9.0" seen for the first
    // time on this runner/cache).
    prHelper.ensureRemoteBranchRef(runCommandStr, _workingDir, branchBase);
    runCmd({ command: 'git checkout -B ' + branchBase + ' origin/' + branchBase });
    runCmd({ command: 'git checkout -b ' + branchName });
}

function checkoutBranch(ticketKey, config, ticket, customParams) {
    ticket = ticket || { key: ticketKey, fields: {} };
    customParams = customParams || {};
    _workingDir = config.workingDir || null;
    // Write workingDir to a known file so CLI shell scripts (e.g. create_test_commit.sh)
    // can discover the correct dependency dir without duplicating resolution logic.
    if (_workingDir) {
        try { file_write({ path: '.dmtools-target-workingdir', content: _workingDir }); } catch (e) { }
    }
    var branchName = configLoader.resolveBranchName(config, ticket, 'development');
    var rebaseBase = configLoader.resolvePRTargetBranch(config, ticket);
    console.log('Setting up branch:', branchName);

    stashGeneratedIndex();

    try {
        configureSetupAuthor(config);
        fetchDevBranchRefs(branchName, rebaseBase);

        var localBranches = readLocalBranchList(branchName, 'Error checking local branches:');
        if (localBranches.trim()) {
            checkoutLocalBranchWithAlign(ticketKey, branchName, rebaseBase);
        } else if (probeRemoteBranch(branchName, 'Error checking remote branches:')) {
            checkoutExistingRemoteBranch(ticketKey, branchName, rebaseBase);
        } else {
            createNewDevBranch(config, customParams, ticket, branchName);
        }

        console.log('Branch ready:', branchName);
    } finally {
        restoreGeneratedIndex();
    }
}

// ── Existing remote work report (gh-1164) ───────────────────────────────────
// Live fa gh-1164 (run 37220167230): a resumed dev leg started on a fresh
// branch, read session memory, and mistook main's release tip for its own
// work commit — because nothing in the input folder told it what
// origin/<devBranch> ALREADY carried. Mirrors how preCliReworkSetup.js
// surfaces existing state (PR diff/discussions into the input folder): one
// ls-remote always, one log/diff only when the branch exists, and the result
// lands in input/<ticketKey>/existing_work.md so the agent sees previous
// rounds' work before it starts.
//
// gh-1229: the metric collection / report rendering is decomposed into small
// helpers (each with a single non-fatal degradation path).

/** Best-effort refresh of exactly the two refs the report compares (gh-729). */
function refreshExistingWorkRefs(baseBranch, branchName) {
    try {
        var fetchCmd = prHelper.buildTargetedOriginFetchCommand([baseBranch, branchName]);
        if (fetchCmd) runCmd({ command: fetchCmd });
    } catch (e) {
        console.warn('Could not refresh refs for existing-work report (non-fatal):', e);
    }
}

/** Ahead-count with three-dot --right-only merge-base semantics; '?' on failure. */
function countCommitsAhead(originRef, branchRef) {
    try {
        return cleanCommandOutput(runCmd({ command: 'git rev-list --count --right-only ' + originRef + '...' + branchRef }) || '') || '0';
    } catch (e) {
        console.warn('Could not count branch commits (non-fatal):', e);
        return '?';
    }
}

/** Oneline log of the branch's own commits; '' on failure (non-fatal). */
function commitLogLines(originRef, branchRef) {
    try {
        return cleanCommandOutput(runCmd({ command: 'git log --oneline -20 ' + originRef + '..' + branchRef }) || '');
    } catch (e) {
        return '';
    }
}

/** Brief file stat of the branch vs base; '' on failure (non-fatal). */
function diffStatLines(originRef, branchRef) {
    try {
        return cleanCommandOutput(runCmd({ command: 'git diff --shortstat ' + originRef + '...' + branchRef }) || '');
    } catch (e) {
        return '';
    }
}

/** The existing_work.md body: resumed-leg warning + metrics + commit list. */
function buildExistingWorkReport(branchName, originRef, branchRef, metrics) {
    var content = '# Existing Work on Remote Branch\n\n' +
        '⚠️ `' + branchRef + '` already exists — this is a RESUMED development leg. ' +
        'Previous rounds\' work lives on this branch. Do NOT mistake the base branch tip (' + originRef + ') ' +
        'or session-memory claims for your own landed work — the commits below are what actually exists.\n\n' +
        '- Branch: `' + branchName + '` (remote)\n' +
        '- Base: `' + originRef + '`\n' +
        '- Commits ahead of base: ' + metrics.commitsAhead + '\n' +
        '- Diff vs base: ' + (metrics.diffStat || '(no diff)') + '\n';
    if (metrics.logLines) {
        content += '\n## Commits ahead of base\n\n```\n' + metrics.logLines + '\n```\n';
    }
    return content;
}

function reportExistingDevBranch(ticketKey, config, ticket, inputFolder) {
    var branchName = configLoader.resolveBranchName(config, ticket, 'development');
    var baseBranch = configLoader.resolvePRTargetBranch(config, ticket);

    var lsRemoteExists = false;
    try {
        lsRemoteExists = prHelper.remoteBranchExists(runCommandStr, _workingDir, branchName);
    } catch (e) {
        console.warn('Could not check remote branch state (non-fatal):', e);
        return false;
    }
    if (!lsRemoteExists) {
        console.log('No existing remote branch origin/' + branchName + ' — fresh development leg');
        return false;
    }

    var originRef = 'origin/' + baseBranch;
    var branchRef = 'origin/' + branchName;
    // gh-729 (live fa gh-1197, run 37234028759): the ahead-count used to run
    // against the local origin/<base> tracking ref, which a cached/shallow
    // checkout never refreshes — the report claimed 'Commits ahead of base:
    // 2343' on a 15-commit branch while the three-dot diff two lines below
    // said '(no diff)'. Refresh EXACTLY the two refs the report compares
    // (targeted refspecs, no blanket fetch — owner rule 2026-10-03) before
    // counting, and count with a three-dot --right-only range so the number
    // carries the same merge-base semantics as the diff it is printed next
    // to (a fully-merged branch counts 0 ahead instead of main's history).
    refreshExistingWorkRefs(baseBranch, branchName);
    var metrics = {
        commitsAhead: countCommitsAhead(originRef, branchRef),
        logLines: commitLogLines(originRef, branchRef),
        diffStat: diffStatLines(originRef, branchRef)
    };

    try {
        file_write({ path: inputFolder + '/existing_work.md', content: buildExistingWorkReport(branchName, originRef, branchRef, metrics) });
        console.log('📋 Reported existing remote work: ' + branchRef + ' is ' + metrics.commitsAhead +
            ' commit(s) ahead of ' + originRef + ' → ' + inputFolder + '/existing_work.md');
    } catch (e) {
        console.warn('Could not write existing_work.md (non-fatal):', e);
    }
    return true;
}

// ── Dev-leg transition assertion (gh-716) ────────────────────────────────────
// The factory board's Development lane reads GitHub labels: agent:dev ON and
// ai_developed OFF means "dev leg running". The SM sets agent:dev when IT
// arms the leg — a MANUAL dispatch (gh workflow run ai-teammate.yml
// -f issue=N -f leg=dev) bypasses that labeling and the card vanishes from
// the board (live fa gh-1164: leg running 40+ min, Development column
// empty). So the setup asserts the transition itself, on ANY dispatch path:
// clear stale agent:review / ai_developed left over from a previous cycle,
// then add agent:dev.
// GitHub-tracker deployments ONLY — these labels are the GitHub
// machine-loop state; Jira/ADO tickets must not be touched. Never fatal: a
// labeling failure costs board visibility, never the development run
// (same trade-off as the status move below).
function assertDevLegTransition(ticketKey, config, customParams) {
    try {
        var tracker = trackersModule.createTracker(config, customParams || {});
        if (tracker.provider() !== 'github') return;
        // Factory issue keys are 'gh-N' shaped — take the trailing number,
        // exactly like smAgent's github addLabel/removeRuleLabel do (the
        // trackers.js key expansion only handles bare numeric keys).
        var m = /(\d+)$/.exec(String(ticketKey));
        if (!m) {
            console.warn('assertDevLegTransition: no issue number in key "' + ticketKey +
                '" — skipping label assertion');
            return;
        }
        var params = { number: parseInt(m[1], 10) };
        // gh-683 bug D: without workspace/repository the github bridge
        // rejects the call ("Issue reference requires owner/repo/number")
        // and the label never lands — scope it whenever the config knows
        // the target repo (mirrors smAgent.addRuleLabels).
        if (config.repository && config.repository.owner && config.repository.repo) {
            params.workspace = config.repository.owner;
            params.repository = config.repository.repo;
        }
        ['agent:review', 'ai_developed'].forEach(function (label) {
            try {
                github_remove_label(Object.assign({ label: label }, params));
                console.log('Cleared stale ' + label + ' from ' + ticketKey);
            } catch (e) {
                // label absent — the normal case, nothing to clear
            }
        });
        github_add_labels(Object.assign({ labels: ['agent:dev'] }, params));
        console.log('Asserted agent:dev on ' + ticketKey + ' — dev leg visible on the board');
    } catch (e) {
        console.warn('assertDevLegTransition failed (non-fatal):', e);
    }
}

// Defensive cap on Jira/tracker comment length — see setupCommands.truncateSetupError
// for rationale (Jira rejects comments over ~350000 chars; unbounded error messages
// here could silently fail to post, leaving the ticket with no failure visibility).
var truncateForComment = setupCommands.truncateSetupError;

/**
 * Build the "Development Setup Error" comment in the flavor of the ticket's
 * tracker (gh-770). The template historically hard-coded Jira wiki markup
 * (h3., *bold*, {code}) and was posted via raw jira_post_comment; on a
 * GitHub-backed tracker that renders as raw text garbage.
 *
 * @param {Object} flavor       - a commentMarkup flavor bag (forTicket/forFlavor)
 * @param {string} stage        - setup stage that failed (e.g. "Git Branch Setup")
 * @param {string} errorMessage - the failure detail (truncated to the shared bound)
 * @returns {string} the rendered comment
 */
function buildSetupErrorComment(flavor, stage, errorMessage) {
    var m = flavor;
    return m.h(3, m.bold('Development Setup Error')) + '\n\n' +
        m.bold('Stage:') + ' ' + stage + '\n' +
        m.bold('Error:') + ' ' + m.code(truncateForComment(errorMessage)) + '\n\n' +
        'Development was stopped before code generation because the target git branch could not be prepared.';
}

/**
 * Post the setup-error comment through the probed tracker (gh-770) so it
 * lands on Jira/ADO/GitHub alike, in the ticket's markup flavor. Best-effort:
 * a posting failure is warned, never fatal — the setup error itself is the
 * signal that stops the leg.
 */
function postSetupErrorComment(config, customParams, ticketKey, stage, errorMessage) {
    try {
        var tracker = trackersModule.createTracker(config, customParams || {});
        tracker.postComment(
            ticketKey,
            buildSetupErrorComment(commentMarkup.forTicket(ticketKey, customParams), stage, errorMessage)
        );
    } catch (commentError) {
        console.warn('Failed to post setup error comment:', commentError);
    }
}

// ── gh-1042: helpers extracted from action() ────────────────────────────────
// Same tracker/SCM/git/file calls in the same order; the pure parse/build/
// decide helpers are exported for direct unit testing. Mirrors the
// preCliReworkSetup.js extraction pattern (gh-1002).

/**
 * params resolution: Teammate workflow (inputFolderPath on params) vs
 * standalone dmtools execution (JSRunner: params.jobParams.inputFolderPath).
 */
function parseActualParams(params) {
    return params.inputFolderPath ? params : (params.jobParams || params);
}

/**
 * customParams resolution — params.jobParams.customParams wins over
 * actualParams.customParams (jobParams path is the real Teammate execution).
 */
function parseCustomParams(params, actualParams) {
    return (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
}

/** 'input/PROJ-1' → 'PROJ-1' (the ticket key is the input folder's basename). */
function parseTicketKeyOf(folder) {
    return folder.split('/').pop();
}

/** String form of an arbitrary thrown value (Error or plain value). */
function decideErrorMessage(e) {
    return e && e.toString ? e.toString() : String(e);
}

/** Restore configured artefacts (e.g. cosmo test reports) from GitHub Release — non-fatal. */
function runRestoreFromReleasesStep(params) {
    try { restoreFromReleases.action(params); } catch (e) { console.warn('⚠️ restoreFromReleases failed (non-fatal):', e); }
}

/** Move ticket to In Development — a tracker failure is a warning only. */
function moveTicketToInDevelopment(config, customParams, ticketKey, statuses) {
    try {
        trackersModule.createTracker(config, customParams || {}).moveToStatus(ticketKey, statuses.IN_DEVELOPMENT);
        console.log('Moved ' + ticketKey + ' to ' + statuses.IN_DEVELOPMENT);
    } catch (e) {
        console.warn('Failed to move ticket to ' + statuses.IN_DEVELOPMENT + ':', e);
    }
}

/** gh-716 label assertion step (agent:dev ON, stale labels cleared) — non-fatal. */
function runDevTransitionAssertion(ticketKey, config, customParams) {
    try {
        assertDevLegTransition(ticketKey, config, customParams);
    } catch (e) {
        console.warn('Failed to assert dev transition labels (non-fatal):', e);
    }
}

/**
 * Checkout or create the dev branch (step 2). On failure posts the setup
 * error comment (Git Branch Setup) and rethrows — the leg cannot start
 * without a prepared branch.
 */
function checkoutBranchOrReport(config, customParams, ticketKey, actualParams, params) {
    try {
        var ticket = params.ticket || actualParams.ticket || { key: ticketKey, fields: {} };
        checkoutBranch(ticketKey, config, ticket, customParams);
    } catch (e) {
        var branchError = decideErrorMessage(e);
        console.error('Branch checkout failed:', branchError);
        postSetupErrorComment(config, customParams, ticketKey, 'Git Branch Setup', branchError);
        throw new Error('Git branch setup failed: ' + branchError);
    }
}

/** gh-1164 existing-remote-work report step — non-fatal. */
function runExistingWorkReportStep(ticketKey, config, actualParams, params, folder) {
    try {
        var ticketForReport = params.ticket || actualParams.ticket || { key: ticketKey, fields: {} };
        reportExistingDevBranch(ticketKey, config, ticketForReport, folder);
    } catch (e) {
        console.warn('reportExistingDevBranch failed (non-fatal):', e);
    }
}

/** Write setup_warnings.md (best-effort — an unwritable file must not fail the leg). */
function writeSetupWarningsFile(folder, setupWarnings) {
    try {
        file_write({ path: folder + '/setup_warnings.md', content: setupWarnings });
        console.log('⚠️ Wrote setup_warnings.md (non-fatal setup command failure(s))');
    } catch (writeErr) {
        console.warn('Failed to write setup_warnings.md:', writeErr);
    }
}

/**
 * Project-specific prerequisite/setup commands (step 3.5, e.g. install
 * JDK/Maven, verify build credentials). On failure posts the setup error
 * comment (Environment Setup) and rethrows — the leg cannot code without the
 * environment.
 */
function runSetupCommandsStep(customParams, config, folder, ticketKey) {
    try {
        var setupResult = setupCommands.runSetupCommands(customParams, config.workingDir);
        var setupWarnings = setupCommands.buildSetupWarningsMarkdown(setupResult);
        if (setupWarnings) {
            writeSetupWarningsFile(folder, setupWarnings);
        }
    } catch (e) {
        var setupError = decideErrorMessage(e);
        console.error('Setup commands failed:', setupError);
        postSetupErrorComment(config, customParams, ticketKey, 'Environment Setup', setupError);
        throw new Error('Environment setup failed: ' + setupError);
    }
}

/** Fetch linked test cases (step 4) — non-fatal extra context. */
function runFetchLinkedTestsStep(actualParams) {
    try {
        fetchLinkedTestsToInput.action(actualParams);
    } catch (e) {
        console.warn('fetchLinkedTestsToInput failed (non-fatal):', e);
    }
}

/** Fetch [BA]/[SA]/[VD] parent context (step 5) — non-fatal extra context. */
function runFetchParentContextStep(actualParams) {
    try {
        fetchParentContextToInput.action(actualParams);
    } catch (e) {
        console.warn('fetchParentContextToInput failed (non-fatal):', e);
    }
}

function action(params) {
    try {
        // Handle both Teammate workflow and standalone dmtools execution
        // - Teammate workflow: params.inputFolderPath exists directly
        // - Standalone dmtools (JSRunner): params.jobParams.inputFolderPath
        var actualParams = parseActualParams(params);
        // paramsForConfigLoad re-attaches params.ticket (sibling of jobParams in the
        // real Teammate execution path) so baseBranchResolverFnPath/snapshotBranchResolverFnPath
        // can key off the ticket's fixVersion — see configLoader.js for details.
        var config = configLoader.loadProjectConfig(configLoader.paramsForConfigLoad(params));
        var customParams = parseCustomParams(params, actualParams);
        var statuses = resolveStatuses(customParams, config.jira && config.jira.statuses);

        // Restore configured artefacts (e.g. cosmo test reports) from GitHub Release — non-fatal
        runRestoreFromReleasesStep(params);

        var folder = actualParams.inputFolderPath;
        var ticketKey = parseTicketKeyOf(folder);

        // 1. Move ticket to In Development
        moveTicketToInDevelopment(config, customParams, ticketKey, statuses);

        // 1.5. Assert the dev-leg transition labels (gh-716): agent:dev ON,
        // stale agent:review / ai_developed cleared — so ANY dispatch path
        // (SM-armed or manual) shows the card on the factory board's
        // Development lane. GitHub deployments only; non-fatal.
        runDevTransitionAssertion(ticketKey, config, customParams);

        // 2. Checkout or create feature branch
        checkoutBranchOrReport(config, customParams, ticketKey, actualParams, params);

        // Persist the resolved base branch to outputs/pr_base_branch.txt so that
        // quality-gate shell commands (static strings in the job's JSON config, unable
        // to reference config.git.baseBranch at runtime) can read the actual branch
        // this ticket develops against instead of relying on a hardcoded literal like
        // "origin/master" — see js/common/baseBranchMarker.js docblock for the rationale.
        // Written AFTER checkout: writing it before left an untracked file in the working
        // tree that collided with `git checkout -B <branch> origin/<branch>` whenever a
        // prior run had leaked this same marker into a commit on that branch (e.g. via a
        // `git add -A` auto-save), aborting checkout with "untracked working tree files
        // would be overwritten".
        baseBranchMarker.writeBaseBranchMarker(config.git.baseBranch);

        // 2.5. Surface existing remote dev-branch work into the input folder (gh-1164):
        // a resumed leg must see previous rounds' commits instead of mistaking the
        // base branch tip for its own work. Cheap: one ls-remote (+ one log/diff when
        // the branch exists); never fatal.
        runExistingWorkReportStep(ticketKey, config, actualParams, params, folder);

        // 3. Fetch questions with answers into input folder
        fetchQuestionsToInput.action(actualParams);

        // 3.5. Run project-specific prerequisite/setup commands (e.g. install JDK/Maven,
        // verify build credentials) before the CLI agent starts coding.
        runSetupCommandsStep(customParams, config, folder, ticketKey);

        // 4. Fetch linked test cases (with failure comments) into input folder
        // Gives the bug agent context about what the test asserts and why it's failing
        runFetchLinkedTestsStep(actualParams);

        // 5. Fetch [BA]/[SA]/[VD] context from parent siblings into input folder
        runFetchParentContextStep(actualParams);

    } catch (error) {
        console.error('Error in preCliDevelopmentSetup:', error);
        throw error;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        checkoutBranch,
        reportExistingDevBranch,
        assertDevLegTransition,
        buildSetupErrorComment,
        postSetupErrorComment,
        // gh-1042: helpers extracted from action() to bring its CRAP under the
        // quality-gate threshold — exported for direct unit testing (mirrors
        // the preCliReworkSetup.js gh-1002 pattern).
        parseActualParams,
        parseCustomParams,
        parseTicketKeyOf,
        decideErrorMessage,
        runRestoreFromReleasesStep,
        moveTicketToInDevelopment,
        runDevTransitionAssertion,
        checkoutBranchOrReport,
        runExistingWorkReportStep,
        writeSetupWarningsFile,
        runSetupCommandsStep,
        runFetchLinkedTestsStep,
        runFetchParentContextStep,
        // gh-1190: checkoutBranch seam helpers exported for direct unit testing.
        configureSetupAuthor,
        fetchDevBranchRefs,
        readLocalBranchList,
        probeRemoteBranch,
        createFeatureBranch,
        establishFeatureBranch,
        checkoutLocalBranchWithAlign,
        checkoutExistingRemoteBranch,
        createNewDevBranch,
        // gh-1229: existing-work report decomposition — exported for direct tests.
        buildExistingWorkReport,
        countCommitsAhead,
        commitLogLines,
        diffStatLines
    };
}
