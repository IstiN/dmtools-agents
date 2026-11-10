/**
 * Shared branch-setup helpers for the pre-CLI setup actions and branch checkout.
 *
 * Why this exists (gh-1247): checkoutBranch.js, preCliDevelopmentSetup.js,
 * preCliTestAutomationSetup.js, preCliStoryTestAutomationSetup.js,
 * preCliMobileTestAutomationSetup.js, preCliTestReworkSetup.js and
 * prepareTestPRForReview.js each carried their own copy of the same
 * branch/marker/setup logic (author config, targeted fetches, branch probes,
 * two-branch feature setup, .git/info/exclude guards, conflict guidance, PR
 * lookups), which the duplication gate flagged at 2-20% per file. The canonical
 * implementations live here ONCE; each action keeps a thin local delegate so
 * its exact commands, log lines and order are unchanged (characterization
 * suites pin them).
 *
 * Design constraints:
 * - ZERO requires on purpose: every collaborator (prHelper, configLoader) is
 *   passed in by the caller, so unit tests can load this module without a
 *   require map and callers keep full control over mock injection.
 * - GraalJS-safe: `var` + plain functions only.
 *
 * Conventions:
 * - `exec(command)` runs ONE git/shell command (through the caller's own
 *   cli_execute_command wrapper, including its workingDirectory handling) and
 *   returns the raw output.
 * - `warnMessage` parameters are optional: pass null for the silent probes.
 */

/**
 * Best-effort git author configuration — failures are warnings only.
 * `logSuccess` keeps checkoutBranch.js's legacy 'Configured git author' line;
 * every other caller passes false (they never logged success).
 */
function configureGitAuthor(exec, config, logSuccess) {
    try {
        exec('git config user.name "' + config.git.authorName + '"');
        exec('git config user.email "' + config.git.authorEmail + '"');
        if (logSuccess) console.log('Configured git author');
    } catch (e) {
        console.warn('Failed to configure git author:', e);
    }
}

/** Targeted origin fetch of exactly `branchNames` — failures are warnings only. */
function fetchBranchRefs(prHelper, exec, branchNames, warnMessage) {
    try {
        var targetedFetch = prHelper.buildTargetedOriginFetchCommand(branchNames);
        if (targetedFetch) exec(targetedFetch);
    } catch (e) {
        console.warn(warnMessage, e);
    }
}

/**
 * `git branch --list` capture for `branchName`, cleaned of wrapper artifacts.
 * `warnMessage` (optional) is logged with the error when the probe fails —
 * pass null for the silent two-branch feature probes.
 */
function readLocalBranchList(prHelper, exec, branchName, warnMessage) {
    try {
        return prHelper.cleanCommandOutput(exec('git branch --list "' + branchName + '"') || '');
    } catch (e) {
        if (warnMessage) console.warn(warnMessage, e);
        return '';
    }
}

/** Strict ls-remote existence probe (gh-912) — `warnMessage` optional. */
function probeRemoteBranch(prHelper, exec, workingDir, branchName, warnMessage) {
    try {
        return prHelper.remoteBranchExists(exec, workingDir, branchName);
    } catch (e) {
        if (warnMessage) console.warn(warnMessage, e);
        return false;
    }
}

/**
 * Two-branch mode: make the feature branch exist — via the configured
 * branchCreateFnPath hook (project-specific mechanism, e.g. an external CI
 * job; the hook is responsible for making the branch exist on origin, so it
 * is fetched and checked out like any other pre-existing remote branch) or
 * the caller's plain-creation tail (`createPlain(featureBranchName)`), which
 * differs per action (checkout+pull vs explicit refspec fetch + checkout -B).
 */
function createFeatureBranch(prHelper, configLoader, exec, config, customParams, ticket, featureBranchName, createPlain) {
    var branchCreateFn = customParams.branchCreateFnPath
        ? configLoader.loadHookFn(customParams.branchCreateFnPath, 'branchCreateFnPath')
        : null;
    if (branchCreateFn) {
        console.log('Two-branch mode: delegating feature branch creation to', customParams.branchCreateFnPath, '→', featureBranchName);
        branchCreateFn({
            branchName: featureBranchName,
            baseBranch: config.git.baseBranch,
            workingDir: config.workingDir,
            ticket: ticket,
            config: config
        });
        exec(prHelper.buildOriginFetchCommand());
        exec('git checkout -b ' + featureBranchName + ' origin/' + featureBranchName);
    } else {
        console.log('Two-branch mode: creating feature branch from', config.git.baseBranch + ':', featureBranchName);
        createPlain(featureBranchName);
    }
}

/**
 * Two-branch mode: ensure the feature branch exists and check it out.
 * Returns the feature branch name — the dev branch is created from it.
 * `createPlain(featureBranchName)` is the no-hook creation tail (see
 * createFeatureBranch).
 */
function establishFeatureBranch(prHelper, configLoader, exec, workingDir, config, customParams, ticket, createPlain) {
    var featureBranchName = configLoader.resolveBranchName(config, ticket, 'feature');
    var featureLocal = readLocalBranchList(prHelper, exec, featureBranchName, null);
    var featureRemoteExists = probeRemoteBranch(prHelper, exec, workingDir, featureBranchName, null);
    var route = prHelper.decideFeatureBranchRoute(featureLocal.trim(), featureRemoteExists);
    if (route === 'create') {
        createFeatureBranch(prHelper, configLoader, exec, config, customParams, ticket, featureBranchName, createPlain);
    } else if (route === 'checkout-remote') {
        exec('git checkout -b ' + featureBranchName + ' origin/' + featureBranchName);
    } else {
        exec('git checkout ' + featureBranchName);
    }
    console.log('Two-branch mode: dev branch will be created from feature branch:', featureBranchName);
    return featureBranchName;
}

/** True when any trimmed line of `lines` equals `entry`. */
function hasExcludeEntry(lines, entry) {
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim() === entry) return true;
    }
    return false;
}

/**
 * Ensure `entry` (e.g. 'outputs/', '.codegraph/') is listed in the target
 * repo's .git/info/exclude — local-only, never committed, idempotent.
 * `commentLine` documents WHY the entry must stay untracked; `warnMessage`
 * identifies the caller in the non-fatal failure log.
 */
function ensureGitInfoExclude(entry, commentLine, warnMessage) {
    try {
        var content = '';
        try { content = file_read({ path: '.git/info/exclude' }) || ''; } catch (e) { content = ''; }
        if (hasExcludeEntry(content.split('\n'), entry)) return;
        var sep = content && content.charAt(content.length - 1) !== '\n' ? '\n' : '';
        file_write({
            path: '.git/info/exclude',
            content: content + sep + '\n' + commentLine + '\n' + entry + '\n'
        });
    } catch (e) {
        console.warn(warnMessage, e);
    }
}

// ── gh-1318: fresh leg input/ stash — fresh regenerated context must win ────
// The tracker regenerates input/ before every leg; a branch that already
// carries an ask-mode WIP snapshot of the OLD input/ either refuses checkout
// ("untracked working tree files would be overwritten") or gets the fresh
// copy cleaned away and serves the stale pre-answer copy to the agent. The
// fresh copy is stashed aside (mv, not cp — instant, no duplicate storage)
// for the duration of branch setup and overlaid back afterwards, exactly
// like the .codegraph guard. Recover-first: a setup that crashed between
// stash and restore left the backup dir holding the only fresh copy.
// Commands go through `bash -c` (builtins/rm/mv/test are not in the
// cli_execute_command whitelist); one action per call — the metacharacter
// guard forbids `;`/`&&` even inside the quotes.

/** Backup dir name — hidden, outside input/, seeded into the local excludes. */
var INPUT_STASH_DIR = '.input.branch-setup-bak';

/** True when `dir` exists in the exec's working directory (probe failure = absent). */
function testDirectoryExists(exec, dir) {
    try {
        exec('bash -c "test -d ' + dir + '"');
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Move the freshly regenerated input/ aside for the duration of branch setup.
 * Returns true when the stash is in place (callers must restore afterwards);
 * false when there was nothing to stash or the move failed — the caller then
 * degrades to its pre-guard behavior (clean/checkout as before), never a
 * throw: a broken guard must not break branch setup.
 *
 * Crash window: a previous setup that died between stash and restore left
 * INPUT_STASH_DIR holding the ONLY copy of the fresh input/ (input/ itself
 * absent). That backup already IS the stash — it stays put and the restore
 * moves it back into place; re-stashing a recovered copy would just churn
 * two renames.
 */
function stashFreshInput(exec) {
    if (testDirectoryExists(exec, 'input')) {
        try {
            exec('bash -c "rm -rf ' + INPUT_STASH_DIR + '"');
            exec('bash -c "mv input ' + INPUT_STASH_DIR + '"');
            return true;
        } catch (e) {
            console.warn('Could not stash fresh input/ before branch setup:', e);
            return false;
        }
    }
    if (testDirectoryExists(exec, INPUT_STASH_DIR)) {
        console.log('input/ absent but the previous setup left a fresh-input backup in ' +
            INPUT_STASH_DIR + ' — treating it as the stash (crash recovery)');
        return true;
    }
    return false;
}

/**
 * Overlay the stashed fresh input/ back over whatever the checkout left
 * behind — the branch-tracked stale snapshot (tracked copy → replaced), a
 * refusal-leftover (nothing there → backup simply moves in), or a clean
 * tree (same). `stashed` false is an absolute no-op; a vanished backup is a
 * loud warning that never deletes the current input/ without a replacement.
 */
function restoreFreshInput(exec, stashed) {
    if (!stashed) return;
    if (!testDirectoryExists(exec, INPUT_STASH_DIR)) {
        console.warn('Fresh input/ stash vanished during branch setup — leaving input/ as checked out');
        return;
    }
    try {
        exec('bash -c "rm -rf input"');
        exec('bash -c "mv ' + INPUT_STASH_DIR + ' input"');
        console.log('Fresh leg input/ restored over the branch-tracked copy');
    } catch (e) {
        console.warn('Could not restore fresh input/ after branch setup:', e);
    }
}

/**
 * gh-1318 root cause: input/, outputs/ and the input stash dir are ephemeral
 * leg context, not branch content — seed them into .git/info/exclude so no
 * `git add -A` (auto-save timer, final commit) ever stages them again.
 * Local-only (never a committed .gitignore line), idempotent, best-effort.
 * Note: file ops resolve against the process cwd — the job root, which is
 * exactly the checkout that sees regenerated input/ in single-repo
 * deployments (the collision case this seed exists for).
 */
function ensureLegContextLocalExcludes() {
    ensureGitInfoExclude(
        'input/',
        '# Ticket leg input (regenerated per-run by the tracker) - must never be committed',
        'Could not add input/ to .git/info/exclude:'
    );
    ensureGitInfoExclude(
        'outputs/',
        '# Job output artifacts (response.md, gate markers) - must never be committed',
        'Could not add outputs/ to .git/info/exclude:'
    );
    ensureGitInfoExclude(
        INPUT_STASH_DIR + '/',
        '# input/ branch-setup stash (crash window must never leak into a commit)',
        'Could not add ' + INPUT_STASH_DIR + '/ to .git/info/exclude:'
    );
}

/**
 * gh-1318 leg-context heal, run by both dev-setup paths right after a
 * successful dev-branch checkout:
 * 1. seed the excludes (above) — keeps every later `git add` from staging
 *    leg context, so ask-mode WIP snapshots stop carrying input/<ticket>/
 *    onto the branch in the first place;
 * 2. untrack leg context the branch ALREADY carries (a poisoned ask-mode
 *    snapshot) — index-only, the working-tree copy stays, and the leg's
 *    final commit pushes the untracking upstream.
 * `exec` runs git commands in the checkout; `untrackLegContext` is
 * js/common/gitStaging.untrackLegContextArtifacts (passed in — this module
 * stays require-free). Both halves are best-effort: failures warn, never
 * block the checkout.
 */
function healLegContextArtifacts(exec, untrackLegContext) {
    ensureLegContextLocalExcludes();
    try {
        var untracked = untrackLegContext(exec);
        if (untracked && untracked.length) {
            console.log('Untracked branch-committed leg context (' + untracked.length +
                ' path(s) under input/ or outputs/)');
        }
    } catch (e) {
        console.warn('Could not untrack branch-committed leg context (non-fatal):', e);
    }
}

/** True when HEAD carries commits not in origin/<baseBranch> (`git cherry`). */
function branchHasUniquePatches(prHelper, exec, baseBranch, warnMessage) {
    try {
        var cherry = prHelper.cleanCommandOutput(exec('git cherry origin/' + baseBranch + ' HEAD') || '');
        if (!cherry.trim()) return false;
        var lines = cherry.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].trim().indexOf('+') === 0) return true;
        }
        return false;
    } catch (e) {
        console.warn(warnMessage, e);
        return true;
    }
}

/** Merge base of two refs via the shared fallback script; '' on failure. */
function findMergeBase(prHelper, exec, left, right) {
    try {
        return prHelper.cleanCommandOutput(exec('bash agents/scripts/git-merge-base-or-empty.sh ' + left + ' ' + right) || '');
    } catch (e) {
        return '';
    }
}

/**
 * `git merge-tree` details for the conflict-guidance file; falls back to the
 * caller's `noMergeBaseText` when no merge base exists and to the raw error
 * string when the probe itself fails.
 */
function collectMergeTreeDetails(prHelper, exec, baseBranch, noMergeBaseText) {
    try {
        var mergeBase = findMergeBase(prHelper, exec, 'HEAD', 'origin/' + baseBranch);
        if (mergeBase) {
            return prHelper.cleanCommandOutput(exec('git merge-tree ' + mergeBase + ' HEAD origin/' + baseBranch) || '');
        }
        return noMergeBaseText;
    } catch (mergeTreeError) {
        return mergeTreeError && mergeTreeError.toString ? mergeTreeError.toString() : String(mergeTreeError);
    }
}

/**
 * Write input/<ticketKey>/merge_conflicts.md. The header/footer are fixed;
 * `intro` names the kind of work on the branch ('work', 'test automation
 * work'), `guidance` is the resolution paragraph, and `notes` is an optional
 * extra paragraph (null to omit).
 */
function writeBranchConflictGuidance(ticketKey, branchName, baseBranch, details, intro, guidance, notes) {
    try {
        var content = '# Branch Conflict Guidance\n\n' +
            'Branch `' + branchName + '` has ' + intro + ' that is not already merged into `origin/' + baseBranch + '`, ' +
            'and `origin/' + baseBranch + '` is not an ancestor of this branch.\n\n' +
            guidance + '\n\n' +
            (notes ? notes + '\n\n' : '') +
            'Details:\n\n```\n' + (details || '(not available)') + '\n```\n';
        file_write({
            path: 'input/' + ticketKey + '/merge_conflicts.md',
            content: content
        });
    } catch (e) {
        console.warn('Could not write branch conflict guidance:', e);
    }
}

/** rev-list based ancestry check; false (after warning) when the probe fails. */
function isAncestorRefRevList(prHelper, exec, ancestor, descendant, warnPrefix) {
    try {
        var output = prHelper.cleanCommandOutput(
            exec('git rev-list -1 ' + ancestor + ' --not ' + descendant) || ''
        );
        return output.trim() === '';
    } catch (e) {
        console.warn(warnPrefix + ' ' + ancestor + ' -> ' + descendant + ':', e);
        return false;
    }
}

/**
 * Resolve the {actualParams, folder, ticketKey, config} tuple every pre-CLI
 * setup derives from params: the input folder identifies the ticket and the
 * jobParams carry the project config.
 */
function resolveInputParams(params, loadProjectConfigFn) {
    var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
    var folder = actualParams.inputFolderPath;
    var ticketKey = folder.split('/').pop();
    var config = loadProjectConfigFn(params.jobParams || params);
    return { actualParams: actualParams, folder: folder, ticketKey: ticketKey, config: config };
}

/**
 * Open-PR lookup for `branchName` ('test/<KEY>' style): logs the search,
 * returns the first open PR whose head ref matches, null when none matches.
 * Throws propagate to the caller's own handler (each action pins its own
 * error log wording).
 */
function findOpenTestPrForBranch(scm, branchName) {
    console.log('Searching for PR on branch:', branchName);
    var openPRs = scm.listPrs('open');
    var openMatch = openPRs.filter(function(pr) {
        return pr.head && pr.head.ref && pr.head.ref === branchName;
    });
    if (openMatch.length > 0) {
        console.log('Found open test PR #' + openMatch[0].number);
        return openMatch[0];
    }
    return null;
}

/** First open PR whose head ref equals `branchName`, else null (warns on failure). */
function findPrForBranch(scm, branchName, warnMessage, logFn) {
    try {
        var openPRs = scm.listPrs('open') || [];
        return openPRs.find(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName;
        }) || null;
    } catch (e) {
        (logFn || console.warn)(warnMessage, e);
        return null;
    }
}

/** First merged (closed + merged_at) PR whose head ref equals `branchName`, else null. */
function findMergedPrForBranch(scm, branchName) {
    var closedPRs = scm.listPrs('closed') || [];
    var mergedMatch = closedPRs.filter(function(pr) {
        return pr.head && pr.head.ref && pr.head.ref === branchName && pr.merged_at;
    });
    return mergedMatch.length > 0 ? mergedMatch[0] : null;
}

/**
 * gh-1247: shared checkout prologue for the preCli*Setup flows — formats the
 * test branch name, wires the git exec helper, configures the author and
 * fetches branch refs. `deps` carries the caller's {configLoader, prHelper,
 * runGit} so this module stays free of concrete dependencies. Returns
 * {branchName, workingDir, exec} for the ticket-specific tail.
 */
function checkoutTestBranchHead(ticketKey, config, deps) {
    var branchName = deps.configLoader.formatBranchName(config.git.branchPrefix.test, ticketKey);
    var workingDir = config.workingDir || null;
    var exec = function (cmd) { return deps.runGit(cmd, workingDir); };
    console.log('Setting up branch:', branchName);

    configureGitAuthor(exec, config, false);
    // gh-1247: the `|| 'main'` fallback is preCliTestAutomationSetup's original
    // behavior, kept as intentional hardening for callers whose config always
    // sets git.baseBranch (preCliStoryTestAutomationSetup previously had no
    // default — with baseBranch set the fetch list is identical).
    fetchBranchRefs(deps.prHelper, exec, [branchName, (config.git && config.git.baseBranch) || 'main'],
        'Could not fetch remote branches:');
    return { branchName: branchName, workingDir: workingDir, exec: exec };
}

/**
 * gh-1356 / gh-1413: returns true when `params` carries dryRun: true (or 'true')
 * at the top level, under `jobParams`, under `customParams`, or under
 * `jobParams.customParams`.
 */
function isDryRunFlag(val) {
    return val === true || val === 'true';
}

function isDryRunParams(params) {
    if (!params) return false;
    if (isDryRunFlag(params.dryRun)) return true;
    if (params.customParams && isDryRunFlag(params.customParams.dryRun)) return true;
    var jp = params.jobParams;
    if (!jp) return false;
    if (isDryRunFlag(jp.dryRun)) return true;
    return !!(jp.customParams && isDryRunFlag(jp.customParams.dryRun));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        configureGitAuthor: configureGitAuthor,
        fetchBranchRefs: fetchBranchRefs,
        readLocalBranchList: readLocalBranchList,
        probeRemoteBranch: probeRemoteBranch,
        createFeatureBranch: createFeatureBranch,
        establishFeatureBranch: establishFeatureBranch,
        ensureGitInfoExclude: ensureGitInfoExclude,
        stashFreshInput: stashFreshInput,
        restoreFreshInput: restoreFreshInput,
        ensureLegContextLocalExcludes: ensureLegContextLocalExcludes,
        healLegContextArtifacts: healLegContextArtifacts,
        INPUT_STASH_DIR: INPUT_STASH_DIR,
        branchHasUniquePatches: branchHasUniquePatches,
        findMergeBase: findMergeBase,
        collectMergeTreeDetails: collectMergeTreeDetails,
        writeBranchConflictGuidance: writeBranchConflictGuidance,
        isAncestorRefRevList: isAncestorRefRevList,
        resolveInputParams: resolveInputParams,
        findOpenTestPrForBranch: findOpenTestPrForBranch,
        findPrForBranch: findPrForBranch,
        findMergedPrForBranch: findMergedPrForBranch,
        checkoutTestBranchHead: checkoutTestBranchHead
        , isDryRunParams: isDryRunParams
    };
}
