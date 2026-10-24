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
        var lines = content.split('\n');
        var alreadyPresent = false;
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].trim() === entry) { alreadyPresent = true; break; }
        }
        if (!alreadyPresent) {
            var sep = content && content.charAt(content.length - 1) !== '\n' ? '\n' : '';
            file_write({
                path: '.git/info/exclude',
                content: content + sep + '\n' + commentLine + '\n' + entry + '\n'
            });
        }
    } catch (e) {
        console.warn(warnMessage, e);
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
    fetchBranchRefs(deps.prHelper, exec, [branchName, (config.git && config.git.baseBranch) || 'main'],
        'Could not fetch remote branches:');
    return { branchName: branchName, workingDir: workingDir, exec: exec };
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
    };
}
