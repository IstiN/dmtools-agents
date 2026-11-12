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
var gitStaging = require('./common/gitStaging.js');
var trackersModule = require('./common/trackers.js');
var commentMarkup = require('./common/commentMarkup.js');
var legFailureReport = require('./common/legFailureReport.js');
var legStartSignal = require('./common/legStartSignal.js');
// gh-1436: plan-mode execution path — the plan-protocol prompt appendix is
// materialized here (preCli, before the agent launches) at the runtime path
// the dev leg configs' conditional cliPrompts entry points at.
// gh-1437: adaptive legs route through the same appendix (the decision
// carrier is the runtime file's existence) — the dispatcher below sends
// plan legs down the unchanged plan path and adaptive legs through the
// signal-driven decision (js/common/developmentModeAdaptive.js).
var developmentModePlan = require('./common/developmentModePlan.js');
var developmentModeAdaptive = require('./common/developmentModeAdaptive.js');

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
        runCmd({ command: 'git merge-base --is-ancestor ' + ancestor + ' ' + descendant, expectNonZeroExit: true });
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
    discardRuntimeArtifactModifications();
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

// gh-1358: pipeline-owned runtime artifacts that ARE tracked in the repo but
// get rewritten by every leg — a stale local modification of one of them
// aborts `git checkout` with "local changes would be overwritten" and the
// whole leg dies at branch setup (four consecutive dev-leg failures on
// #1352). The helpers below run best-effort before every branch switch:
// non-fatal (warn and continue — the checkout reports any real conflict that
// remains). Once gh-1358 untracks the marker on master and a branch aligns
// with it, both are no-ops.
var PIPELINE_RUNTIME_ARTIFACTS = ['.dmtools-target-workingdir'];

/** Best-effort: reset a stale local modification of one runtime artifact. */
function resetRuntimeArtifact(artifact) {
    try {
        runCmd({ command: 'git checkout -- ' + artifact });
    } catch (resetErr) {
        console.warn('Could not reset runtime artifact', artifact + ':', resetErr);
    }
}

/** Best-effort: stop tracking one runtime artifact on the current branch. */
function untrackRuntimeArtifact(artifact) {
    try {
        runCmd({ command: 'git rm --cached --ignore-unmatch ' + artifact });
    } catch (rmErr) {
        console.warn('Could not untrack runtime artifact', artifact + ':', rmErr);
    }
}

/** Reset + untrack every known runtime artifact before a branch switch. */
function discardRuntimeArtifactModifications() {
    PIPELINE_RUNTIME_ARTIFACTS.forEach(resetRuntimeArtifact);
    PIPELINE_RUNTIME_ARTIFACTS.forEach(untrackRuntimeArtifact);
}

/** Local dev branch: checkout, then align with the base branch. */
function checkoutLocalBranchWithAlign(ticketKey, branchName, rebaseBase) {
    discardRuntimeArtifactModifications();
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
    discardRuntimeArtifactModifications();
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

    // gh-1318: the freshly regenerated input/ IS the current truth — stash it
    // aside for the duration of branch setup. A branch that already carries an
    // ask-mode WIP snapshot of the OLD input/ used to make the checkout REFUSE
    // ("untracked working tree files would be overwritten") and abort the leg;
    // with the stash in place there is nothing untracked left to collide, and
    // the restore below overlays the fresh copy over whatever the checked-out
    // branch materialized. Restore runs in finally: even a failed checkout
    // gives the reporter's answer back.
    var stashedFreshInput = branchSetup.stashFreshInput(runCommandStr);

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
        // gh-1318 root-cause heal: seed input//outputs into .git/info/exclude
        // and untrack what the branch already carries — best-effort, only on
        // a successful checkout (nothing was checked out otherwise).
        branchSetup.healLegContextArtifacts(runCommandStr, gitStaging.untrackLegContextArtifacts);
    } finally {
        restoreGeneratedIndex();
        branchSetup.restoreFreshInput(runCommandStr, stashedFreshInput);
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

// ── gh-1363: leg-failure reports that carry context ──────────────────────────
// The setup failure path shares the js/common/legFailureReport.js builder with
// the workflow failure-notice step (scripts/report-leg-failure.sh): a failing
// leg reports its phase (here: always 'setup'), the failing step (the setup
// stage), a bounded excerpt, run id + link when the CI env provides them, the
// canonical leg-start pre-flight line, and the repeat count against prior
// failure-signature lines on the same ticket (an existing surface — no new
// persistence; the signature normalization is the pure module's).

// The workflow name this path signs its failures with — distinct from the
// workflow-file signatures so a setup failure and a workflow-step failure of
// the same ticket never collapse into one repeat count.
var SETUP_FAILURE_WORKFLOW = 'preCliDevelopmentSetup';

/** The pre-flight line captured at leg start (module state, like _workingDir). */
var _preflightLine = null;
/** The raw pre-flight state — the head SHA feeds the leg-start status (gh-1364). */
var _preflightState = null;
/** gh-1364 exactly-once guards: the leg emits its leg-start line a single time. */
var _legStartEmitted = false;
var _legStartLine = null;

/**
 * gh-1363 leg-start signal: collect the canonical
 * `git pre-flight: branch=… head=… dirty=… staged=… paths=[…]` line BEFORE the
 * first git operation mutates the workspace — it is the one thing a post-hoc
 * analyzer can never reconstruct. Best-effort: any git failure leaves the
 * state unknown (the report simply omits the line), never fatal.
 */
function collectPreflightStateStep() {
    try {
        var state = legFailureReport.collectPreflightState(runCommandStr);
        _preflightState = state;
        _preflightLine = legFailureReport.preflightLine(state);
        if (_preflightLine) console.log(_preflightLine);
        return _preflightLine;
    } catch (e) {
        console.warn('pre-flight state collection failed (non-fatal):', e && e.message ? e.message : e);
        return null;
    }
}

/** The remembered leg-start pre-flight line (null when never collected). */
function currentPreflightLine() {
    return _preflightLine;
}

/** The raw pre-flight state (gh-1364 uses the head SHA; null when never collected). */
function currentPreflightHeadSha() {
    return _preflightState && _preflightState.head ? _preflightState.head : null;
}

/** Best-effort env read via the dmtools Java bridge; null when unavailable. */
function readJavaEnv(name) {
    try {
        var v = java.lang.System.getenv(name);
        if (v !== null && v !== undefined) return String(v);
    } catch (e) { /* no java bridge — node harness / standalone */ }
    return null;
}

/** Best-effort env read via the node harness `process` global; null when unavailable. */
function readProcessEnv(name) {
    try {
        if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
            return String(process.env[name]);
        }
    } catch (e) { /* no process global */ }
    return null;
}

/** Best-effort env read: Java bridge first (dmtools), node harness fallback. */
function readEnvVar(name) {
    return readJavaEnv(name) || readProcessEnv(name);
}

/** Comment objects ({body}|{text} shapes, null entries tolerated) → body strings. */
function commentBodies(comments) {
    var bodies = [];
    var list = comments || [];
    for (var i = 0; i < list.length; i++) {
        bodies.push((list[i] && (list[i].body || list[i].text)) || '');
    }
    return bodies;
}

/**
 * Prior-failure repeat count for this ticket: machine-readable
 * `failure-signature:` lines from the ticket's own comments (existing
 * surface — no new persistence). Returns { signature, repeatCount } or null
 * when the tracker cannot list comments (legacy stubs) or the read fails —
 * the report then omits the repeat line instead of guessing.
 */
function deriveSetupRepeatCount(tracker, ticketKey, stage, errorMessage) {
    try {
        if (!tracker.getComments) return null;
        var signature = legFailureReport.failureSignature({
            workflow: SETUP_FAILURE_WORKFLOW, step: stage, message: errorMessage
        });
        return {
            signature: signature,
            repeatCount: legFailureReport.consecutiveRepeatCount(
                signature,
                legFailureReport.parseSignatureLines(commentBodies(tracker.getComments(ticketKey)))
            )
        };
    } catch (e) {
        console.warn('setup failure repeat-count derivation failed (non-fatal):', e && e.message ? e.message : e);
        return null;
    }
}

/**
 * Build the "Development Setup Error" comment in the flavor of the ticket's
 * tracker (gh-770). The template historically hard-coded Jira wiki markup
 * (h3., *bold*, {code}) and was posted via raw jira_post_comment; on a
 * GitHub-backed tracker that renders as raw text garbage.
 *
 * gh-1363: an optional `context` enriches the comment into a full leg-failure
 * report through the shared js/common/legFailureReport.js builder — phase
 * (always 'setup' here), failing step (the stage), bounded excerpt (the error
 * itself), run id + link, the leg-start pre-flight line, the repeat phrase
 * and the machine-readable signature line. Without a context the output is
 * byte-identical to the historical template.
 *
 * @param {Object} flavor       - a commentMarkup flavor bag (forTicket/forFlavor)
 * @param {string} stage        - setup stage that failed (e.g. "Git Branch Setup")
 * @param {string} errorMessage - the failure detail (truncated to the shared bound)
 * @param {Object} [context]    - { preflightLine, runId, runUrl, repeatCount, signature }
 * @returns {string} the rendered comment
 */
function buildSetupErrorComment(flavor, stage, errorMessage, context) {
    var m = flavor;
    var comment = m.h(3, m.bold('Development Setup Error')) + '\n\n' +
        m.bold('Stage:') + ' ' + stage + '\n' +
        m.bold('Error:') + ' ' + m.code(truncateForComment(errorMessage)) + '\n\n' +
        'Development was stopped before code generation because the target git branch could not be prepared.';
    if (context) {
        comment += '\n' + legFailureReport.renderReport(m, {
            preflightLine: context.preflightLine,
            phase: 'setup',
            step: stage,
            runId: context.runId,
            runUrl: context.runUrl,
            // The legacy block above already posts the error text as `Error:`
            // — a default excerpt equal to it would render the same bytes
            // twice. Only a caller-provided excerpt DISTINCT from the error
            // (e.g. a different log tail) earns its own section (gh-1363
            // review).
            excerpt: (context.excerpt != null && context.excerpt !== errorMessage) ? context.excerpt : null,
            repeatCount: context.repeatCount,
            signature: context.signature
        });
    }
    return comment;
}

/**
 * Fill every missing context field the module can derive: the repeat
 * signature (prior ticket comments), the leg-start pre-flight line and the
 * CI run identity. Returns the (mutated) context — extraction keeps
 * postSetupErrorComment a single try/post/warn (crap ratchet, gh-1363).
 */
function deriveEnrichmentContext(tracker, ticketKey, stage, errorMessage, context) {
    var ctx = context || {};
    if (!ctx.signature) {
        var derived = deriveSetupRepeatCount(tracker, ticketKey, stage, errorMessage);
        if (derived) {
            ctx.signature = derived.signature;
            ctx.repeatCount = derived.repeatCount;
        }
    }
    if (!ctx.preflightLine && _preflightLine) ctx.preflightLine = _preflightLine;
    if (!ctx.runUrl) {
        ctx.runUrl = legFailureReport.runUrlFromEnv(readEnvVar);
        ctx.runId = legFailureReport.runIdFromEnv(readEnvVar);
    }
    return ctx;
}

/** Any collected context item → the report renders enriched. */
function isEnrichedContext(ctx) {
    return !!(ctx.preflightLine || ctx.runUrl || ctx.runId || ctx.signature);
}

/**
 * Post the setup-error comment through the probed tracker (gh-770) so it
 * lands on Jira/ADO/GitHub alike, in the ticket's markup flavor. Best-effort:
 * a posting failure is warned, never fatal — the setup error itself is the
 * signal that stops the leg.
 *
 * gh-1363: the comment is enriched into a leg-failure report when context
 * exists — the leg-start pre-flight line (collected by
 * collectPreflightStateStep), the CI run identity (env), and the repeat
 * count derived from prior failure-signature lines on the ticket. An
 * enrichment-less call (nothing collected, legacy tracker stub) keeps the
 * byte-identical historical comment.
 */
function postSetupErrorComment(config, customParams, ticketKey, stage, errorMessage, context) {
    try {
        var tracker = trackersModule.createTracker(config, customParams || {});
        var ctx = deriveEnrichmentContext(tracker, ticketKey, stage, errorMessage, context);
        tracker.postComment(
            ticketKey,
            buildSetupErrorComment(
                commentMarkup.forTicket(ticketKey, customParams),
                stage,
                errorMessage,
                isEnrichedContext(ctx) ? ctx : undefined
            )
        );
    } catch (commentError) {
        console.warn('Failed to post setup error comment:', commentError);
    }
}

// ── gh-1364: the leg-start phase signal ──────────────────────────────────────
// Machine-readable answer to "can agent legs currently start work on this
// main SHA?" — in the 2026-11-04 outage every leg died in the setup phase and
// the only way to know that was to open run logs by hand. Every leg crosses
// the setup boundary, so the boundary emits the signal itself:
//   1. ALWAYS one summary line: `leg-start: ok (branch <name>)` or
//      `leg-start: failed (<reason-class>: <first error line>)` (formats and
//      the closed reason set live in js/common/legStartSignal.js);
//   2. BEST-EFFORT commit status on the head SHA the leg ran against —
//      leg-start/ok (description: branch name) / leg-start/failed
//      (description: reason class) — via the same github_create_commit_status
//      plumbing js/common/ci.js uses. A posting failure must never fail the
//      leg: warn and continue (the same trade-off as the tracker comments).
// Exactly once per leg: the emit helpers flip a module flag, so a checkout
// failure followed by the action-level catch reports the signal once.
// Acting on the signal (gating dispatch, parking) is issue 02's analyzer +
// SM policy — this wiring only emits.

/** The remembered leg-start summary line (null until the boundary is crossed). */
function currentLegStartLine() {
    return _legStartLine;
}

function markLegStartEmitted(line) {
    _legStartEmitted = true;
    _legStartLine = line;
    return line;
}

/**
 * Fresh `git rev-parse HEAD` probe — the fallback when the pre-flight head is
 * absent or not a SHA (post-checkout that is the dev branch tip — still the
 * truest "where the leg runs"). Null when the probe fails or answers a
 * non-SHA (gh-1364 rework: extracted so resolveLegStartHeadSha stays a thin
 * remembered→fresh chain under the CRAP ratchet).
 */
function probeFreshHeadSha() {
    try {
        var sha = cleanCommandOutput(runCmd({ command: 'git rev-parse HEAD' }) || '').trim();
        if (legStartSignal.isValidHeadSha(sha)) return sha;
    } catch (e) {
        console.warn('leg-start: head SHA not resolvable (commit status skipped):', e && e.message ? e.message : e);
    }
    return null;
}

/**
 * The head SHA the leg ran against: the pre-flight head captured before any
 * git operation mutated the workspace, else a fresh rev-parse. Null when
 * neither resolves — the status then stays log-only.
 */
function resolveLegStartHeadSha() {
    var remembered = currentPreflightHeadSha();
    if (legStartSignal.isValidHeadSha(remembered)) return remembered;
    return probeFreshHeadSha();
}

/**
 * Post the leg-start commit status — best-effort end to end. The skip guards
 * (no config / non-github tracker / no repository scope) are the pure
 * `resolveLegStartStatusTarget` chain in js/common/legStartSignal.js (gh-1364
 * rework); here stays the small posting path: resolve the head, build the
 * payload, post. A null config never reaches the tracker build — the helper
 * skips it first (createTracker's own fallback loader is throw-safe). An
 * unresolvable head or a throwing status API is warned, never fatal. Returns
 * the posted args, or null when skipped/failed.
 */
function postLegStartStatusBestEffort(config, customParams, body) {
    try {
        var target = legStartSignal.resolveLegStartStatusTarget(
            config, trackersModule.createTracker(config, customParams || {}).provider());
        if (target.skip) {
            if (target.warn) console.warn(target.warn);
            return null;
        }
        var sha = resolveLegStartHeadSha();
        if (!sha) return null;
        var args = legStartSignal.buildCommitStatusArgs({
            workspace: target.workspace,
            repository: target.repository,
            sha: sha,
            ok: body.ok === true,
            branchName: body.branchName,
            reasonClass: body.reasonClass,
            runUrl: legFailureReport.runUrlFromEnv(readEnvVar)
        });
        github_create_commit_status(args);
        console.log('Posted commit status ' + args.context + ' on ' + sha.substring(0, 8) +
            (args.targetUrl ? ' → ' + args.targetUrl : ''));
        return args;
    } catch (e) {
        console.warn('leg-start commit status posting failed (non-fatal):', e);
        return null;
    }
}

/** The ok half: setup crossed, the dev branch is ready. Returns the line (null when already emitted). */
function emitLegStartOk(config, customParams, branchName) {
    if (_legStartEmitted) return null;
    markLegStartEmitted(legStartSignal.okSummaryLine(branchName));
    console.log(_legStartLine);
    postLegStartStatusBestEffort(config, customParams, { ok: true, branchName: branchName });
    return _legStartLine;
}

/** The failed half: classify the setup error into the closed set, log, post best-effort. */
function emitLegStartFailed(config, customParams, errorText) {
    if (_legStartEmitted) return null;
    var reasonClass = legStartSignal.classifySetupError(errorText);
    markLegStartEmitted(legStartSignal.failedSummaryLine(reasonClass, errorText));
    console.log(_legStartLine);
    postLegStartStatusBestEffort(config, customParams, { ok: false, reasonClass: reasonClass });
    return _legStartLine;
}

/**
 * The ok step at the end of the setup phase (after branch setup AND the
 * environment-setup commands — the last steps that can stop the leg before
 * the agent starts). Best-effort: a signal failure never fails the leg.
 */
function runLegStartOkStep(config, customParams, params, actualParams, ticketKey) {
    try {
        var ticket = params.ticket || actualParams.ticket || { key: ticketKey, fields: {} };
        emitLegStartOk(config, customParams, configLoader.resolveBranchName(config, ticket, 'development'));
    } catch (e) {
        console.warn('leg-start ok signal failed (non-fatal):', e);
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

/** Detect dryRun mode on top-level params, jobParams, actualParams, or customParams (gh-1356). */
function isDryRunParams(params) {
    return branchSetup.isDryRunParams(params);
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
        emitLegStartFailed(config, customParams, branchError);
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

/**
 * Remember the head this pass starts from, so developTicketAndCreatePR can
 * squash timer WIP auto-save commits made during this pass into one clean
 * development commit (gh-1308). Optional helper — a failure leaves the
 * fallback to origin/<baseBranch> merge-base active.
 */
function writeDevBaseHead(folder) {
    if (!folder) return;
    try {
        var sha = cleanCommandOutput(runCmd({ command: 'git rev-parse HEAD' }) || '').trim();
        if (/^[0-9a-f]{7,40}$/i.test(sha)) {
            file_write({ path: folder + '/dev_base_head.txt', content: sha });
        }
    } catch (e) {
        console.warn('Could not write dev_base_head.txt (non-fatal):', e && e.message ? e.message : e);
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
        emitLegStartFailed(config, customParams, setupError);
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

// ── gh-1436: plan-mode appendix materialization ─────────────────────────────
// When the resolved developmentMode is "plan", the dev leg configs carry a
// conditional cliPrompts entry whose prompt is the RUNTIME path
// .dmtools/development-mode-plan-appendix.md. The appendix must exist at that
// path BEFORE prompt assembly reads it (conditions and prompt files are
// evaluated after this setup, before the agent launches). The step resolves
// the text — engine default, or the workflow's
// developmentModeConfig.plan.appendixFile used verbatim — writes it, and seeds
// the path into .git/info/exclude so the agent's `git add -A` never stages the
// materialization (the durable artifact is the agent-committed
// .dmtools/plan-snapshot.md). Inactive (default) mode performs zero IO and
// zero log output — invariant P1 (default legs byte-identical). A failed
// resolution (unreadable override, unwritable path) is a CONFIG error: the
// leg fails fast before the agent launch with the offending path named.

/**
 * Materialize the plan-mode appendix when the leg runs in plan mode.
 * @returns the materialization result ({ ok, active, ... }) — null never.
 * @throws when plan mode is active but the appendix cannot be materialized.
 */
function runPlanModeAppendixStep(customParams) {
    var result = developmentModePlan.materializePlanAppendix(customParams);
    (result.warnings || []).forEach(function (w) { console.warn(w); });
    if (!result.active) return result;
    if (!result.ok) {
        throw new Error(result.error);
    }
    branchSetup.ensureGitInfoExclude(
        developmentModePlan.PLAN_APPENDIX_FILE_PATH,
        developmentModePlan.PLAN_APPENDIX_EXCLUDE_COMMENT,
        'Could not exclude the plan-mode appendix from git:'
    );
    console.log('📝 developmentMode=plan: ' + (result.overridden ? 'override' : 'engine default') +
        ' appendix materialized → ' + result.path);
    return result;
}

/**
 * The reporting wrapper (same shape as runSetupCommandsStep): a failed plan
 * setup posts the setup-error comment (Plan Mode Setup) and rethrows — the
 * prompt would otherwise assemble with the runtime path as a dangling entry.
 */
function runPlanModeAppendixStepOrReport(customParams, config, ticketKey) {
    try {
        runPlanModeAppendixStep(customParams);
    } catch (e) {
        var planError = decideErrorMessage(e);
        console.error('Plan-mode appendix setup failed:', planError);
        postSetupErrorComment(config, customParams, ticketKey, 'Plan Mode Setup', planError);
        emitLegStartFailed(config, customParams, planError);
        throw new Error('Plan-mode setup failed: ' + planError);
    }
}

// ── gh-1437: adaptive routing — same appendix, signal-driven decision ───────
// When the resolved developmentMode is "adaptive", the ENGINE decides
// plan-vs-default from ticket signals (js/common/developmentModeAdaptive.js):
// routed-to-plan materializes the appendix exactly like a plan leg,
// routed-to-default and shadowMode legs remove stale appendix state instead.
// The decision itself never fails the leg (permissive config philosophy);
// only a failed appendix RESOLUTION (unreadable override, unwritable path)
// does — the same config-error class the plan path reports.

/** Ticket title+body for the signal extractor — tracker-agnostic (gh-1442
 *  resolvers: Jira fields.summary/description, ADO System.Title/System.
 *  Description, GitHub top-level title/body), so adaptive routing reads the
 *  real text on every tracker instead of silently routing default on ADO. */
function ticketTextForAdaptive(ticket) {
    return trackersModule.ticketSummaryOf(ticket) + '\n' + trackersModule.ticketDescriptionOf(ticket);
}

/**
 * The adaptive step: evaluate, flush warnings + log lines, materialize or
 * clean up. A failed appendix resolution throws (the caller reports it like
 * a plan-mode setup failure).
 * @returns the adaptive materialization result.
 * @throws when the leg routed to plan but the appendix cannot be materialized.
 */
function runAdaptiveModeAppendixStep(customParams, ticket) {
    var result = developmentModeAdaptive.materializeAdaptiveAppendix(customParams, ticketTextForAdaptive(ticket));
    (result.warnings || []).forEach(function (w) { console.warn(w); });
    (result.logLines || []).forEach(function (l) { console.log(l); });
    if (result.error) {
        throw new Error(result.error);
    }
    if (result.materialized) {
        branchSetup.ensureGitInfoExclude(
            developmentModePlan.PLAN_APPENDIX_FILE_PATH,
            developmentModePlan.PLAN_APPENDIX_EXCLUDE_COMMENT,
            'Could not exclude the plan-mode appendix from git:'
        );
    }
    return result;
}

/**
 * The development-mode appendix dispatcher: plan legs take the unchanged
 * gh-1436 plan path, adaptive legs take the signal-driven decision, every
 * other mode stays on the zero-IO plan path (which no-ops for non-plan).
 */
function runDevelopmentModeAppendixStep(customParams, ticket) {
    var mode = developmentModeAdaptive.resolvedDevelopmentMode(customParams);
    if (mode === 'adaptive') {
        return runAdaptiveModeAppendixStep(customParams, ticket);
    }
    return runPlanModeAppendixStep(customParams);
}

/**
 * The reporting wrapper for the dispatcher (same contract as
 * runPlanModeAppendixStepOrReport): a failed setup posts the setup-error
 * comment (Plan Mode Setup) and rethrows.
 */
function runDevelopmentModeAppendixStepOrReport(customParams, config, ticketKey, ticket) {
    try {
        return runDevelopmentModeAppendixStep(customParams, ticket);
    } catch (e) {
        var modeError = decideErrorMessage(e);
        console.error('Development-mode appendix setup failed:', modeError);
        postSetupErrorComment(config, customParams, ticketKey, 'Plan Mode Setup', modeError);
        emitLegStartFailed(config, customParams, modeError);
        throw new Error('Development-mode setup failed: ' + modeError);
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
        if (isDryRunParams(params)) {
            console.log('[dryRun] Skipping mutating development setup (branch checkout, setup commands, tracker/SCM writes)');
            fetchQuestionsToInput.action(actualParams);
            runFetchLinkedTestsStep(actualParams);
            runFetchParentContextStep(actualParams);
            return { success: true, dryRun: true };
        }
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

        // 1.4. Leg-start pre-flight line (gh-1363): captured BEFORE any git
        // operation mutates the workspace — the one thing a post-hoc analyzer
        // can never reconstruct. Best-effort, never fatal.
        // The capture runs BEFORE checkoutBranch() (step 2) assigns _workingDir
        // — resolve the configured target workspace first, or the git probes
        // run in the agents repo and the report mislabels branch/head
        // (gh-1363 review: wrong-workspace pre-flight line).
        _workingDir = config.workingDir;
        collectPreflightStateStep();

        // 1.5. Assert the dev-leg transition labels (gh-716): agent:dev ON,
        // stale agent:review / ai_developed cleared — so ANY dispatch path
        // (SM-armed or manual) shows the card on the factory board's
        // Development lane. GitHub deployments only; non-fatal.
        runDevTransitionAssertion(ticketKey, config, customParams);

        // 2. Checkout or create feature branch. gh-1318: this comes BEFORE the
        // In Development move — a checkout that fails here used to strand the
        // ticket in In Development with no branch, no recovery lane and only a
        // setup-error comment. The status move below only runs for a branch
        // that was actually prepared.
        checkoutBranchOrReport(config, customParams, ticketKey, actualParams, params);

        // 2.5. Move ticket to In Development — only now, after branch setup
        // succeeded (gh-1318 ordering).
        moveTicketToInDevelopment(config, customParams, ticketKey, statuses);

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

        writeDevBaseHead(folder);
        // gh-1436/gh-1437: materialize the development-mode appendix (after
        // checkout: .git/info/exclude seeding needs the repo; before the agent
        // launches: the prompt assembly reads it post-setup). Plan legs
        // materialize always; adaptive legs route by ticket signals; other
        // modes no-op with zero IO. Config errors fail the leg fast, with the
        // offending path named.
        runDevelopmentModeAppendixStepOrReport(customParams, config, ticketKey, params.ticket || actualParams.ticket);
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

        // 3.6. gh-1364: the setup boundary is crossed — the dev branch is ready and
        // the environment is installed. Emit the leg-start ok signal (one summary
        // line + best-effort leg-start/ok commit status on the head SHA).
        runLegStartOkStep(config, customParams, params, actualParams, ticketKey);

        // 4. Fetch linked test cases (with failure comments) into input folder
        // Gives the bug agent context about what the test asserts and why it's failing
        runFetchLinkedTestsStep(actualParams);

        // 5. Fetch [BA]/[SA]/[VD] context from parent siblings into input folder
        runFetchParentContextStep(actualParams);

    } catch (error) {
        console.error('Error in preCliDevelopmentSetup:', error);
        // gh-1364: a setup-phase death outside the two report-wrapped steps
        // (config load, question fetch, …) still marks the leg failed —
        // exactly-once guarded (checkout/environment failures already
        // emitted); dryRun legs never cross the boundary and stay silent.
        if (!isDryRunParams(params)) {
            emitLegStartFailed(config, customParams, decideErrorMessage(error));
        }
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
        isDryRunParams,
        decideErrorMessage,
        runRestoreFromReleasesStep,
        moveTicketToInDevelopment,
        runDevTransitionAssertion,
        checkoutBranchOrReport,
        runExistingWorkReportStep,
        writeDevBaseHead,
        writeSetupWarningsFile,
        runSetupCommandsStep,
        runFetchLinkedTestsStep,
        runFetchParentContextStep,
        // gh-1436: plan-mode appendix materialization — exported for unit tests.
        runPlanModeAppendixStep,
        runPlanModeAppendixStepOrReport,
        // gh-1437: adaptive routing dispatcher — exported for unit tests.
        runDevelopmentModeAppendixStep,
        runDevelopmentModeAppendixStepOrReport,
        runAdaptiveModeAppendixStep,
        ticketTextForAdaptive,
        // gh-1363: leg-failure report wiring — exported for direct unit testing.
        collectPreflightStateStep,
        currentPreflightLine,
        deriveSetupRepeatCount,
        readEnvVar,
        // gh-1364: leg-start phase signal wiring — exported for direct unit testing.
        currentPreflightHeadSha,
        currentLegStartLine,
        resolveLegStartHeadSha,
        probeFreshHeadSha,
        postLegStartStatusBestEffort,
        emitLegStartOk,
        emitLegStartFailed,
        runLegStartOkStep,
        // gh-1363 rework: enrichment helpers extracted for the crap ratchet.
        deriveEnrichmentContext,
        isEnrichedContext,
        commentBodies,
        readJavaEnv,
        readProcessEnv,
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
