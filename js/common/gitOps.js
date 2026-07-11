/**
 * SCM-agnostic git operations for PR setup actions.
 *
 * Unlike js/common/githubHelpers.js (which wraps GitHub-only REST/GraphQL
 * calls — PR conversations, check-runs, job logs), everything in this module
 * is plain `git` CLI plumbing invoked via `cli_execute_command`. It works
 * identically for GitHub- and GitLab-backed repositories, since neither the
 * branch checkout nor the diff/conflict/context logic ever calls a
 * provider-specific tool.
 *
 * Used by preCliReworkSetup.js, preCliTestReworkSetup.js,
 * preparePRForReview.js, prepareTestPRForReview.js (regardless of
 * config.scm.provider).
 *
 * Writes the following files to input/{ticketKey}/ (via writePRContext):
 *   pr_info.md            — PR metadata
 *   pr_diff.txt           — git diff context, truncated when large
 *   pr_discussions.md     — human-readable review threads + comments
 *   pr_discussions_raw.json — structured threads with IDs for reply/resolve
 */

const { GIT_CONFIG } = require('../config.js');
const prHelper = require('./pullRequest.js');

var MAX_PR_DIFF_CONTEXT_CHARS = 12000;

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

/**
 * Switches the working tree onto `branchName` (creating a local tracking
 * branch from origin when needed). Assumes the working tree is already clean —
 * callers (checkoutPRBranch) are responsible for stashing local state first.
 */
function _switchToBranch(branchName, cmd) {
    var localBranchExists = function() {
        return cleanCommandOutput(cmd('git branch --list "' + branchName + '"') || '').trim() !== '';
    };

    // Update remote refs; blobless repos already have the commit graph
    cmd(prHelper.buildOriginFetchCommand('--prune'));

    if (localBranchExists()) {
        cmd('git checkout ' + branchName);
        cmd('git pull origin ' + branchName);
    } else {
        const remoteBranch = cleanCommandOutput(cmd('git ls-remote --heads origin ' + branchName) || '');
        if (remoteBranch.trim()) {
            try {
                cmd(prHelper.buildOriginFetchCommand(branchName + ':' + branchName));
            } catch (e) {
                cmd(prHelper.buildOriginFetchCommand(branchName));
            }

            if (localBranchExists()) {
                cmd('git checkout ' + branchName);
            } else {
                try {
                    cmd('git checkout -b ' + branchName + ' origin/' + branchName);
                } catch (e) {
                    if (!localBranchExists()) {
                        throw e;
                    }
                    cmd('git checkout ' + branchName);
                }
            }
        } else {
            throw new Error('Branch not found locally or remotely: ' + branchName);
        }
    }
}

/**
 * Checks out `branchName`, self-healing around a dirty/untracked working tree
 * instead of ever failing the whole setup step or leaving HEAD parked on
 * `baseBranch` (the failure mode that causes WIP auto-save commits to land on
 * develop/main instead of the ticket branch).
 *
 * Strategy ("stage, switch, reapply"):
 *   1. Snapshot any local changes (tracked + untracked) via `git stash -u` so
 *      the tree is guaranteed clean before switching branches.
 *   2. Switch onto `branchName` (create local tracking branch from origin if
 *      needed).
 *   3. Reapply the snapshot on top of the new branch. If it doesn't apply
 *      cleanly, we do NOT fail — the conflict markers are left in the working
 *      tree for the CLI agent (or a human) to resolve as part of its task;
 *      `hadConflict: true` is returned so callers can surface this.
 *   4. Hard invariant: if, after all of this, HEAD still equals `baseBranch`,
 *      recreate `branchName` from `origin/baseBranch` rather than ever
 *      returning while sitting on the base branch.
 *
 * @param {string} branchName
 * @param {string} [workingDir]
 * @param {string} [baseBranch] - when provided, enforces the "never stay on
 *        baseBranch" invariant (step 4). Omit only for call sites that don't
 *        know the base branch; the stash-based self-healing (steps 1-3) still
 *        applies either way.
 * @returns {{ branch: string, hadConflict: boolean }}
 */
function checkoutPRBranch(branchName, workingDir, baseBranch) {
    console.log('Checking out PR branch:', branchName);
    var cmdOpts = workingDir ? { workingDirectory: workingDir } : {};
    var cmd = function(command) { return cli_execute_command(Object.assign({}, cmdOpts, { command: command })); };

    cmd('git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"');
    cmd('git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"');

    // 1. Snapshot local state so a dirty tree can never block the switch below.
    var dirty = cleanCommandOutput(cmd('git status --porcelain') || '').trim();
    var stashed = false;
    if (dirty) {
        console.log('Working tree has local changes — stashing before branch switch');
        cmd('git add -A');
        try {
            cmd('git stash push -u -m "preflight-checkout-' + branchName + '"');
            stashed = true;
        } catch (e) {
            console.warn('git stash push failed, proceeding without a safety snapshot:', e);
        }
    }

    // 2. Switch branches — tree is clean now, so this should never fail on
    //    "untracked files would be overwritten" again.
    _switchToBranch(branchName, cmd);

    // 3. Reapply the snapshot on top of the target branch.
    var hadConflict = false;
    if (stashed) {
        try {
            cmd('git stash pop');
        } catch (popErr) {
            hadConflict = true;
            console.warn('⚠️ Reapplying local snapshot onto ' + branchName + ' produced conflicts — leaving conflict markers in place:', popErr);
        }
    }

    // 4. Hard invariant: never report success while parked on the base branch.
    if (baseBranch) {
        var current = cleanCommandOutput(cmd('git rev-parse --abbrev-ref HEAD') || '').trim();
        if (current === baseBranch) {
            console.warn('⚠️ Still on base branch "' + baseBranch + '" after checkout — recreating ' + branchName + ' from origin/' + baseBranch);
            cmd('git checkout -B ' + branchName + ' origin/' + baseBranch);
        }
    }

    console.log('✅ Checked out branch:', branchName, hadConflict ? '(with unresolved conflicts from local snapshot)' : '');
    return { branch: branchName, hadConflict: hadConflict };
}

function getPRDiff(baseBranch, headBranch, workingDir) {
    var cmdOpts = workingDir ? { workingDirectory: workingDir } : {};
    var cmd = function(command) { return cli_execute_command(Object.assign({}, cmdOpts, { command: command })); };
    try {
        console.log('Generating diff between', baseBranch, 'and', headBranch, workingDir ? '(in ' + workingDir + ')' : '');

        // Unshallow if needed so there is a full merge base available
        try {
            var isShallow = cleanCommandOutput(cmd('git rev-parse --is-shallow-repository') || 'false');
            if (isShallow.trim() === 'true') {
                cmd('git fetch --unshallow');
                console.log('Unshallowed repository for full merge base detection');
            } else {
                console.log('Repository is already complete (not shallow), skipping unshallow');
            }
        } catch (e) {
            // ignore — already complete or unshallow not supported
        }

        // First try three-dot diff (shows only changes on headBranch since divergence)
        try {
            const diff = cmd('git diff ' + baseBranch + '...' + headBranch) || '';
            console.log('Diff size:', diff.length, 'chars');
            return cleanCommandOutput(diff);
        } catch (e1) {
            console.warn('Three-dot diff failed (likely no merge base), trying with origin/ prefix:', e1.message || e1);
        }

        // Fallback: try with explicit origin/ prefix on base branch
        try {
            const originBase = baseBranch.indexOf('origin/') === 0 ? baseBranch : 'origin/' + baseBranch;
            const diff = cmd('git diff ' + originBase + '...' + headBranch) || '';
            console.log('Diff size (origin fallback):', diff.length, 'chars');
            return cleanCommandOutput(diff);
        } catch (e2) {
            console.warn('Origin-prefix diff also failed, trying merge-base approach:', e2.message || e2);
        }

        // Last resort: find explicit merge-base commit and diff from there
        try {
            const originBase = baseBranch.indexOf('origin/') === 0 ? baseBranch : 'origin/' + baseBranch;
            const mergeBase = cleanCommandOutput(cmd('git merge-base ' + originBase + ' ' + headBranch) || '');
            if (mergeBase && mergeBase.trim().length > 0) {
                const diff = cmd('git diff ' + mergeBase.trim() + '...' + headBranch) || '';
                console.log('Diff size (merge-base fallback):', diff.length, 'chars');
                return cleanCommandOutput(diff);
            }
        } catch (e3) {
            console.warn('Merge-base diff also failed:', e3.message || e3);
        }

        console.error('All diff strategies failed for', baseBranch, '...', headBranch);
        return '';
    } catch (e) {
        console.error('Failed to get PR diff:', e);
        return '';
    }
}

/**
 * Detects merge conflicts between the current branch and `origin/{baseBranch}`.
 *
 * `checkoutPRBranch` already runs `git fetch origin --prune`, so the remote
 * base branch ref is up to date before this is called.
 *
 * @param {string} baseBranch  - base branch name (e.g. "main")
 * @param {string} inputFolder - input/{ticketKey} path
 * @returns {string[]} list of conflicting file paths (empty when clean)
 */
function detectMergeConflicts(baseBranch, inputFolder, workingDir) {
    var cmdOpts = workingDir ? { workingDirectory: workingDir } : {};
    var cmd = function(command) { return cli_execute_command(Object.assign({}, cmdOpts, { command: command })); };
    try {
        console.log('Checking for merge conflicts with origin/' + baseBranch + (workingDir ? ' in ' + workingDir : '') + '...');

        try {
            var isShallow = cleanCommandOutput(cmd('git rev-parse --is-shallow-repository') || 'false');
            if (isShallow.trim() === 'true') {
                cmd('git fetch --unshallow');
                console.log('Unshallowed repository for full merge base detection');
            }
        } catch (e) {
            // ignore — already complete or unshallow not supported
        }

        cmd('git merge origin/' + baseBranch + ' --no-commit --no-ff');

        // If we reach here the merge is clean — staged but not committed
        console.log('No merge conflicts — base branch changes staged');
        return [];

    } catch (mergeError) {
        // git merge exits non-zero when there are unresolved conflicts
        try {
            var statusRaw = cleanCommandOutput(cmd('git status --short') || '');

            // Lines prefixed UU, AA, DD, AU, UA, DU, UD are conflict markers
            var conflictLines = statusRaw.split('\n').filter(function(line) {
                return /^(UU|AA|DD|AU|UA|DU|UD) /.test(line.trim());
            });

            if (conflictLines.length === 0) {
                // Not a conflict error — abort and move on
                try { cmd('git merge --abort'); } catch (e) {}
                console.warn('Merge failed (non-conflict reason):', mergeError.message || mergeError);
                return [];
            }

            var conflictFiles = conflictLines.map(function(l) {
                return l.trim().substring(3).trim();
            });
            console.warn('⚠️ Merge conflicts in ' + conflictFiles.length + ' file(s):', conflictFiles.join(', '));

            var md = '# ⚠️ Merge Conflicts — Resolve Before Rework\n\n';
            md += 'This branch has conflicts with `' + baseBranch + '`. ';
            md += conflictFiles.length + ' file(s) contain conflict markers:\n\n';
            conflictFiles.forEach(function(f) { md += '- `' + f + '`\n'; });
            md += '\n## Resolution Steps\n\n';
            md += '1. Open each conflicting file and resolve the `<<<<<<<` / `=======` / `>>>>>>>` markers\n';
            md += '2. Stage each resolved file: `git add <file>`\n';
            md += '3. Once all conflicts are resolved, proceed with fixes from `pr_discussions.md`\n\n';
            md += '**Do NOT run `git commit` or `git merge --abort`** — the commit and push are handled automatically.\n';

            file_write({ path: inputFolder + '/merge_conflicts.md', content: md });
            console.log('✅ Wrote merge_conflicts.md');

            // Leave the working directory in the conflicted merge state so the agent can resolve it
            return conflictFiles;

        } catch (statusError) {
            console.warn('Could not determine merge state after conflict:', statusError);
            try { cmd('git merge --abort'); } catch (e) {}
            return [];
        }
    }
}

function trimLargeTextForInput(content, label, maxChars) {
    var text = content || '';
    var limit = maxChars || MAX_PR_DIFF_CONTEXT_CHARS;
    if (text.length <= limit) return text;

    var headChars = Math.floor(limit * 0.65);
    var tailChars = limit - headChars;
    return [
        '# ' + label + ' Truncated',
        '',
        'Original size: ' + text.length + ' characters.',
        'Kept: first ' + headChars + ' and last ' + tailChars + ' characters.',
        '',
        'The full diff is available in the checked-out PR branch. Use `git diff` or CodeGraph for focused source navigation instead of relying only on this file.',
        '',
        '```diff',
        text.substring(0, headChars),
        '',
        '... [' + (text.length - limit) + ' characters omitted] ...',
        '',
        text.substring(text.length - tailChars),
        '```'
    ].join('\n');
}

function writeInputFile(path, content, label) {
    var text = content || '';
    console.log('Writing ' + label + ' to ' + path + ' (' + text.length + ' chars)');
    file_write({ path: path, content: text });
    console.log('Wrote ' + label + ' to ' + path);
}

/**
 * Write PR context files to input folder.
 * Writes: pr_info.md, pr_diff.txt, pr_discussions.md, pr_discussions_raw.json
 *
 * @param {string}      inputFolder  - input/{ticketKey} path
 * @param {Object}      prDetails    - PR object (GitHub or GitLab, normalized)
 * @param {string}      diff         - git diff text
 * @param {string|null} markdown     - discussions markdown (from githubHelpers.fetchDiscussionsAndRawData)
 * @param {Object|null} rawThreads   - raw threads with IDs (from githubHelpers.fetchDiscussionsAndRawData)
 */
function writePRContext(inputFolder, prDetails, diff, markdown, rawThreads) {
    // pr_info.md
    let prInfo = '# Pull Request Information\n\n';
    prInfo += '- **PR #**: ' + prDetails.number + '\n';
    prInfo += '- **URL**: ' + prDetails.html_url + '\n';
    prInfo += '- **Title**: ' + prDetails.title + '\n';
    prInfo += '- **Author**: ' + (prDetails.user ? prDetails.user.login : 'unknown') + '\n';
    prInfo += '- **Branch**: `' + (prDetails.head ? prDetails.head.ref : 'unknown') +
              '` → `' + (prDetails.base ? prDetails.base.ref : 'unknown') + '`\n';
    prInfo += '- **State**: ' + prDetails.state + '\n';
    prInfo += '- **Files Changed**: ' + (prDetails.changed_files || 0) + '\n';
    prInfo += '- **Additions**: +' + (prDetails.additions || 0) + '\n';
    prInfo += '- **Deletions**: -' + (prDetails.deletions || 0) + '\n';
    prInfo += '- **Created**: ' + (prDetails.created_at || '') + '\n';
    prInfo += '- **Updated**: ' + (prDetails.updated_at || '') + '\n';
    if (prDetails.body) {
        prInfo += '\n## PR Description\n\n' + prDetails.body + '\n';
    }
    writeInputFile(inputFolder + '/pr_info.md', prInfo, 'pr_info.md');

    // pr_diff.txt
    var diffContext = trimLargeTextForInput(diff || 'No diff available', 'PR Diff', MAX_PR_DIFF_CONTEXT_CHARS);
    writeInputFile(inputFolder + '/pr_diff.txt', diffContext, 'pr_diff.txt');

    // pr_discussions.md
    if (markdown) {
        writeInputFile(inputFolder + '/pr_discussions.md', markdown, 'pr_discussions.md');
    }

    // pr_discussions_raw.json
    if (rawThreads) {
        writeInputFile(
            inputFolder + '/pr_discussions_raw.json',
            JSON.stringify(rawThreads, null, 2),
            'pr_discussions_raw.json (' + rawThreads.threads.length + ' threads)'
        );
    }

    console.log('✅ PR context written to', inputFolder);
}

module.exports = {
    cleanCommandOutput: cleanCommandOutput,
    checkoutPRBranch: checkoutPRBranch,
    getPRDiff: getPRDiff,
    detectMergeConflicts: detectMergeConflicts,
    trimLargeTextForInput: trimLargeTextForInput,
    writeInputFile: writeInputFile,
    writePRContext: writePRContext
};
