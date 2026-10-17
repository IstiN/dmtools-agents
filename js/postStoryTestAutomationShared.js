/**
 * Shared helpers for the story test-automation post-actions
 * (js/postStoryTestAutomationResults.js, js/postStoryTestAutomationReview.js).
 *
 * Extracted in the gh-1008 CRAP split: the tracker lazy-init holder,
 * resume-attempt markers, markdown→Jira-wiki conversion, quiet label removal
 * and the git publish/push operations. Behavior and posted strings stay
 * byte-identical to the originals — they are posted verbatim to the tracker.
 *
 * The git ops take the pullRequest helper as a factory argument so test
 * suites inject the same instance the calling module uses.
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

    function publishExistingBranch(branchName, workingDir) {
        // Ensure the local remote-tracking ref is fresh before any push decision.
        fetchRemoteBranch(branchName, workingDir);

        var localSha = revParse('HEAD', workingDir);
        var remoteSha = revParse('origin/' + branchName, workingDir);

        if (localSha && remoteSha && localSha === remoteSha) {
            console.log('Local branch already matches origin/' + branchName + '; no push needed');
            return { success: true, noNewCommit: true };
        }

        var mergeBase = (localSha && remoteSha) ? findMergeBase('HEAD', 'origin/' + branchName, workingDir) : '';

        if (mergeBase === remoteSha && mergeBase !== localSha) {
            // Local is strictly ahead of remote (fast-forward).
            try {
                runInRepo('git push -u origin ' + branchName, workingDir);
                return { success: true, noNewCommit: true };
            } catch (e) {
                console.warn('Fast-forward push failed:', e);
            }
        } else if (mergeBase === localSha && mergeBase !== remoteSha) {
            // Remote moved ahead while we had no local changes to keep. Adopt remote state.
            console.log('Remote ' + branchName + ' is ahead of local branch; resetting to origin/' + branchName);
            runInRepo('git reset --hard origin/' + branchName, workingDir);
            return { success: true, noNewCommit: true };
        }

        // Branches diverged or no remote yet; fall back to push with refreshed lease.
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

    function performGitOperations(branchName, commitMessage, workingDir, testFilesPath) {
        var addPath = testFilesPath || 'testing/';
        var inspectPath = addPath.replace(/\/$/, '') || '.';
        try {
            try {
                var lsOutput = runInRepo('git status --short -- ' + inspectPath, workingDir) || '';
                console.log('Git status for ' + inspectPath + ':', cleanCommandOutput(lsOutput) || '(empty)');
            } catch (e) {
                console.warn('Could not list ' + inspectPath + ':', e);
            }

            console.log('Staging test path:', addPath);
            runInRepo('git add ' + addPath, workingDir);

            var stagedOutput = cleanCommandOutput(runInRepo('git diff --cached --stat', workingDir) || '');
            console.log('Staged changes:', stagedOutput || '(none)');

            if (!stagedOutput || !stagedOutput.trim()) {
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

            console.log('Committing...');
            runInRepo('git commit -m "' + prHelper.sanitizeCommitMessage(commitMessage) + '"', workingDir);

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

            var remoteBranchExists = false;
            try {
                // gh-912: verify the push produced a real refs/heads/<branch> ref
                // line — stderr noise never counts as the branch existing.
                remoteBranchExists = prHelper.remoteBranchExists(runInRepo, workingDir, branchName);
            } catch (lsRemoteErr) {
                console.warn('Error checking remote branches:', lsRemoteErr);
            }
            if (!remoteBranchExists) {
                throw new Error('Branch not found on remote after push');
            }

            console.log('✅ Git operations completed');
            return { success: true, branchName: branchName };

        } catch (error) {
            console.error('Git operations failed:', error);
            return { success: false, error: error.toString() };
        }
    }

    return {
        fetchRemoteBranch: fetchRemoteBranch,
        revParse: revParse,
        findMergeBase: findMergeBase,
        publishExistingBranch: publishExistingBranch,
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
        createGitOps: createGitOps
    };
}
