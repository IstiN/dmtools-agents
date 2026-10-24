/**
 * Shared helpers for the story test-automation post-actions
 * (js/postStoryTestAutomationResults.js, js/postStoryTestAutomationReview.js,
 * js/postTestAutomationResults.js, js/postMobileTestAutomationResults.js,
 * js/postTestReworkResults.js, js/storyTestAutomationRework.js).
 *
 * Extracted in the gh-1008 CRAP split; extended in gh-1246 with the
 * output-file readers, git-author config, autoStart-review trigger and
 * test-PR creation previously duplicated across those post-actions. the tracker lazy-init holder,
 * resume-attempt markers, markdown→Jira-wiki conversion, quiet label removal
 * and the git publish/push operations. Behavior and posted strings stay
 * byte-identical to the originals — they are posted verbatim to the tracker.
 *
 * The git ops take the pullRequest helper as a factory argument so test
 * suites inject the same instance the calling module uses. Every function
 * stays ≤ CC 8 so the per-function CRAP ratchet (new keys must be ≤ 8)
 * holds even before coverage is applied.
 */

/**
 * Tracker-agnostic ticket operations holder (jira / ado / github): creates
 * the tracker lazily per action() run and resets on re-init, replacing the
 * module-level _trackerCtx/_trackerInst singletons both post-actions used to
 * duplicate.
 */
function createTrackerHolder(trackersModule) {
    var ctx = { config: null, customParams: {} };
    var inst = null;
    return {
        initTracker: function(config, customParams) {
            ctx = { config: config || null, customParams: customParams || {} };
            inst = null;
        },
        getTracker: function() {
            if (!inst) inst = trackersModule.createTracker(ctx.config, ctx.customParams);
            return inst;
        }
    };
}

function readAttemptMarker(markerPath) {
    try {
        var raw = file_read({ path: markerPath });
        var value = parseInt(raw || '0', 10);
        return isNaN(value) ? 0 : value;
    } catch (e) {
        return 0;
    }
}

function writeAttemptMarker(markerPath, attempt) {
    try {
        file_write({ path: markerPath, content: String(attempt) });
    } catch (e) {
        console.warn('Could not write resume attempt marker:', e);
    }
}

function markdownToJiraWiki(markdown) {
    if (!markdown) return '';
    var text = String(markdown);
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, function(_, language, code) {
        return '{code' + (language ? ':' + language : '') + '}\n' + code.trim() + '\n{code}';
    });
    text = text
        .replace(/^####\s+(.+)$/gm, 'h4. $1')
        .replace(/^###\s+(.+)$/gm, 'h3. $1')
        .replace(/^##\s+(.+)$/gm, 'h2. $1')
        .replace(/^#\s+(.+)$/gm, 'h1. $1')
        .replace(/^\s*-\s+/gm, '* ')
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/`([^`\n]+)`/g, '{{$1}}')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '[$1|$2]');
    return text.trim();
}

function removeLabelSafely(getTracker, key, label) {
    try {
        getTracker().removeLabel(key, label);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * gh-1246: output-file reader pair shared by the test-automation
 * post-actions. readFile reads a root-relative outputs path; readOutputFile
 * normalizes ticket-subdir and workingDir variants. Both delegate to the
 * outputFiles module so path normalization stays in one place.
 */
function makeOutputFileReaders(outputFiles) {
    function readFile(path) {
        return outputFiles.readOutputFile(path, {});
    }

    function readOutputFile(relativePath, workingDir, ticketKey) {
        return outputFiles.readOutputFile(relativePath, {
            workingDir: workingDir,
            ticketKey: ticketKey
        });
    }

    return {
        readFile: readFile,
        readOutputFile: readOutputFile
    };
}

/**
 * gh-1246: file_read based output read used by the rework post-actions:
 * null for missing/empty content, a warn (never a throw) on read errors.
 */
function readFileOrNull(path) {
    try {
        var content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        console.warn('Could not read file ' + path + ':', e);
        return null;
    }
}

/**
 * gh-1246: configure the git author for commits (non-fatal). The runCommand
 * dependency is called as runCommand(command, workingDir) so callers keep
 * their own runInRepo semantics.
 */
function configureGitAuthor(runCommand, config, workingDir) {
    try {
        runCommand('git config user.name "' + config.git.authorName + '"', workingDir);
        runCommand('git config user.email "' + config.git.authorEmail + '"', workingDir);
    } catch (e) {
        console.warn('Failed to configure git author:', e);
    }
}

/**
 * gh-1246: autoStartReview configured-workflow trigger shared by every
 * test-automation post/rework action. Returns the trigger result, or false
 * when not configured or the trigger threw (logged, never rethrown).
 */
function triggerAutoStartReviewWorkflow(autoStart, ticketKey, customParams, config, label) {
    if (!customParams || !customParams.autoStartReview || !customParams.autoStartReviewConfigFile) {
        return false;
    }
    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: ticketKey,
            customParams: customParams,
            config: config,
            configFile: customParams.autoStartReviewConfigFile,
            label: label,
            stripKeys: ['removeLabel', 'autoStartReview', 'autoStartReviewConfigFile']
        });
    } catch (e) {
        console.warn('⚠️ autoStartReview trigger failed:', e.message || e);
        return false;
    }
}

/**
 * gh-1246: create (or find) the test-automation PR. gh-737: the merge bot
 * links approved issues via 'Closes #N' — emitted by construction on every
 * test PR. defaultBody is a caller option because the posted fallback body
 * differs per action ('Automated test automation changes.' vs the story
 * variant) and is posted verbatim.
 */
function createTestPullRequest(prHelper, runCommand, readFile, options) {
    console.log('Creating Pull Request...');
    return prHelper.createPullRequest({
        title: options.title,
        branchName: options.branchName,
        baseBranch: options.baseBranch,
        workingDir: options.workingDir,
        scm: options.scm,
        ticketKey: options.ticketKey,
        bodyFileCandidates: ['outputs/pr_body.md', 'outputs/response.md'],
        defaultBody: options.defaultBody,
        runCommand: runCommand,
        readFile: readFile
    });
}

/**
 * gh-1246: canonical success/failure results of a git-operations block —
 * the log lines and result shapes are pinned by characterization tests.
 */
function gitOperationsSuccess(branchName) {
    console.log('✅ Git operations completed');
    return { success: true, branchName: branchName };
}

function gitOperationsFailure(error) {
    console.error('Git operations failed:', error);
    return { success: false, error: error.toString() };
}

function runInRepo(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

/**
 * Git publish/push operations shared by the story test-automation post-action.
 * All functions take (branchName|…, workingDir) and never throw — failures
 * are reported as { success: false, error } result objects or false.
 */
function createGitOps(prHelper) {
    function cleanCommandOutput(output) {
        return prHelper.cleanCommandOutput(output);
    }

    function fetchRemoteBranch(branchName, workingDir) {
        try {
            runInRepo('git fetch origin ' + branchName, workingDir);
            return true;
        } catch (e) {
            console.warn('Could not fetch remote branch origin/' + branchName + ':', e);
            return false;
        }
    }

    function revParse(ref, workingDir) {
        try {
            return cleanCommandOutput(runInRepo('git rev-parse ' + ref, workingDir) || '').trim();
        } catch (e) {
            return '';
        }
    }

    function findMergeBase(left, right, workingDir) {
        try {
            return cleanCommandOutput(runInRepo('git merge-base ' + left + ' ' + right, workingDir) || '').trim();
        } catch (e) {
            return '';
        }
    }

    function sameHead(localSha, remoteSha) {
        return !!(localSha && remoteSha && localSha === remoteSha);
    }

    function isAheadOfRemote(mergeBase, remoteSha, localSha) {
        return !!(mergeBase && mergeBase === remoteSha && mergeBase !== localSha);
    }

    function isBehindRemote(mergeBase, remoteSha, localSha) {
        return !!(mergeBase && mergeBase === localSha && mergeBase !== remoteSha);
    }

    /**
     * Pure sync decision for a branch whose local/remote shas are known:
     * 'identical' | 'ahead' (fast-forward) | 'behind' (adopt remote) | 'diverged'.
     */
    function syncDecision(localSha, remoteSha, mergeBase) {
        if (sameHead(localSha, remoteSha)) return 'identical';
        if (isAheadOfRemote(mergeBase, remoteSha, localSha)) return 'ahead';
        if (isBehindRemote(mergeBase, remoteSha, localSha)) return 'behind';
        return 'diverged';
    }

    function pushBranchWithLease(branchName, workingDir) {
        try {
            runInRepo('git push -u origin ' + branchName, workingDir);
            return { success: true, noNewCommit: true };
        } catch (pushErr) {
            console.log('Normal push failed, retrying with --force-with-lease...');
            try {
                runInRepo('git push -u origin ' + branchName + ' --force-with-lease', workingDir);
                return { success: true, noNewCommit: true };
            } catch (forcePushErr) {
                console.warn('Failed to publish existing branch:', forcePushErr);
                return { success: false, error: 'No test files were written and the synced branch could not be pushed' };
            }
        }
    }

    function publishExistingBranch(branchName, workingDir) {
        // Ensure the local remote-tracking ref is fresh before any push decision.
        fetchRemoteBranch(branchName, workingDir);

        var localSha = revParse('HEAD', workingDir);
        var remoteSha = revParse('origin/' + branchName, workingDir);
        var mergeBase = (localSha && remoteSha) ? findMergeBase('HEAD', 'origin/' + branchName, workingDir) : '';

        var decision = syncDecision(localSha, remoteSha, mergeBase);

        if (decision === 'identical') {
            console.log('Local branch already matches origin/' + branchName + '; no push needed');
            return { success: true, noNewCommit: true };
        }

        if (decision === 'ahead') {
            // Local is strictly ahead of remote (fast-forward).
            try {
                runInRepo('git push -u origin ' + branchName, workingDir);
                return { success: true, noNewCommit: true };
            } catch (e) {
                console.warn('Fast-forward push failed:', e);
            }
        } else if (decision === 'behind') {
            // Remote moved ahead while we had no local changes to keep. Adopt remote state.
            console.log('Remote ' + branchName + ' is ahead of local branch; resetting to origin/' + branchName);
            runInRepo('git reset --hard origin/' + branchName, workingDir);
            return { success: true, noNewCommit: true };
        }

        // Branches diverged (or the fast-forward push failed); push with refreshed lease.
        return pushBranchWithLease(branchName, workingDir);
    }

    /**
     * Logs the working-tree state (gh-1190 diagnostic seam, exported so the
     * post-actions keep their pinned test surface).
     */
    function logStagingDiagnostics(inspectPath, workingDir) {
        try {
            var lsOutput = runInRepo('git status --short -- ' + inspectPath, workingDir) || '';
            console.log('Git status for ' + inspectPath + ':', cleanCommandOutput(lsOutput) || '(empty)');
        } catch (e) {
            console.warn('Could not list ' + inspectPath + ':', e);
        }
    }

    /**
     * Logs the working-tree state and stages the test path.
     * Returns the `git diff --cached --stat` output (empty when nothing staged).
     */
    function inspectAndStage(addPath, inspectPath, workingDir) {
        logStagingDiagnostics(inspectPath, workingDir);

        console.log('Staging test path:', addPath);
        runInRepo('git add ' + addPath, workingDir);

        return cleanCommandOutput(runInRepo('git diff --cached --stat', workingDir) || '');
    }

    /**
     * Nothing new to commit: publish the branch state as-is (push when the
     * remote branch is missing, otherwise adopt/publish the existing one).
     */
    function handleNoStagedChanges(addPath, branchName, workingDir) {
        console.warn('No new staged changes in ' + addPath + ' (files may already exist on branch)');
        var remoteBranchExists = false;
        try {
            // gh-912: decide on a real refs/heads/<branch> ref line — a
            // warning-only capture (central-mode insteadOf origin, git
            // ≥ 2.54) must classify as "branch absent" so the push runs.
            remoteBranchExists = prHelper.remoteBranchExists(runInRepo, workingDir, branchName);
        } catch (lsRemoteErr) {
            console.warn('Error checking remote branches:', lsRemoteErr);
        }
        if (!remoteBranchExists) {
            console.log('No remote branch found, pushing current branch state...');
            try {
                runInRepo('git push -u origin ' + branchName, workingDir);
            } catch (pushErr) {
                console.warn('Failed to push branch:', pushErr);
                return { success: false, error: 'No test files were written and could not push branch' };
            }
        } else {
            var publishResult = publishExistingBranch(branchName, workingDir);
            if (!publishResult.success) {
                return publishResult;
            }
        }
        return { success: true, branchName: branchName, noNewCommit: true };
    }

    /**
     * Pushes the current HEAD, escalating normal push → --force-with-lease →
     * --force on rejections.
     */
    function pushWithEscalation(branchName, workingDir) {
        console.log('Pushing to remote...');
        fetchRemoteBranch(branchName, workingDir);
        try {
            runInRepo('git push -u origin ' + branchName, workingDir);
        } catch (e) {
            console.log('Normal push failed, retrying with --force-with-lease...');
            try {
                runInRepo('git push -u origin ' + branchName + ' --force-with-lease', workingDir);
            } catch (leaseErr) {
                console.log('Force-with-lease push failed, force pushing...');
                runInRepo('git push -u origin ' + branchName + ' --force', workingDir);
            }
        }
    }

    /**
     * gh-912: verify the push produced a real refs/heads/<branch> ref line —
     * stderr noise never counts as the branch existing.
     */
    function verifyRemoteBranchPresent(branchName, workingDir) {
        var remoteBranchExists = false;
        try {
            remoteBranchExists = prHelper.remoteBranchExists(runInRepo, workingDir, branchName);
        } catch (lsRemoteErr) {
            console.warn('Error checking remote branches:', lsRemoteErr);
        }
        if (!remoteBranchExists) {
            throw new Error('Branch not found on remote after push');
        }
    }

    function performGitOperations(branchName, commitMessage, workingDir, testFilesPath) {
        var addPath = testFilesPath || 'testing/';
        var inspectPath = addPath.replace(/\/$/, '') || '.';
        try {
            var stagedOutput = inspectAndStage(addPath, inspectPath, workingDir);
            console.log('Staged changes:', stagedOutput || '(none)');

            if (!stagedOutput || !stagedOutput.trim()) {
                return handleNoStagedChanges(addPath, branchName, workingDir);
            }

            console.log('Committing...');
            runInRepo('git commit -m "' + prHelper.sanitizeCommitMessage(commitMessage) + '"', workingDir);

            pushWithEscalation(branchName, workingDir);
            verifyRemoteBranchPresent(branchName, workingDir);

            return gitOperationsSuccess(branchName);

        } catch (error) {
            return gitOperationsFailure(error);
        }
    }

    return {
        fetchRemoteBranch: fetchRemoteBranch,
        revParse: revParse,
        findMergeBase: findMergeBase,
        syncDecision: syncDecision,
        pushBranchWithLease: pushBranchWithLease,
        publishExistingBranch: publishExistingBranch,
        logStagingDiagnostics: logStagingDiagnostics,
        inspectAndStage: inspectAndStage,
        handleNoStagedChanges: handleNoStagedChanges,
        pushWithEscalation: pushWithEscalation,
        verifyRemoteBranchPresent: verifyRemoteBranchPresent,
        performGitOperations: performGitOperations
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        createTrackerHolder: createTrackerHolder,
        readAttemptMarker: readAttemptMarker,
        writeAttemptMarker: writeAttemptMarker,
        markdownToJiraWiki: markdownToJiraWiki,
        removeLabelSafely: removeLabelSafely,
        runInRepo: runInRepo,
        createGitOps: createGitOps,
        // gh-1246 dedup exports:
        makeOutputFileReaders: makeOutputFileReaders,
        readFileOrNull: readFileOrNull,
        configureGitAuthor: configureGitAuthor,
        triggerAutoStartReviewWorkflow: triggerAutoStartReviewWorkflow,
        createTestPullRequest: createTestPullRequest,
        gitOperationsSuccess: gitOperationsSuccess,
        gitOperationsFailure: gitOperationsFailure
    };
}
