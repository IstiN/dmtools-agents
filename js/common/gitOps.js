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
var gitStaging = require('./gitStaging.js');
var forkCheckout = require('./forkCheckout.js');

var MAX_PR_DIFF_CONTEXT_CHARS = 12000;

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
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

    // Targeted fetch of just this branch (owner rule 2026-10-03: blanket
    // `fetch origin --prune` cost 134s on big repos; the base branch is
    // fetched explicitly by ensureRemoteBranchRef in checkoutPRBranch).
    // Forced remote-tracking refspec (+refs/heads/<b>:refs/remotes/origin/<b>)
    // — a plain '<branch>:<branch>' refspec would try to update the local
    // branch ref and fails when HEAD is on that branch.
    var targetedFetch = prHelper.buildTargetedOriginFetchCommand([branchName]);
    if (targetedFetch) cmd(targetedFetch);

    if (localBranchExists()) {
        cmd('git checkout ' + branchName);
        // Use reset --hard instead of pull: after a force-push (e.g. a rebase),
        // local and remote branches diverge and 'git pull' fails with
        // "Need to specify how to reconcile divergent branches".
        // The remote is always the source of truth for an existing PR branch.
        cmd('git reset --hard origin/' + branchName);
    } else {
        // gh-912: decide on a real refs/heads/<branch> ref line — a
        // warning-only capture (central-mode insteadOf origin, git ≥ 2.54)
        // must classify as "branch absent" so the caller gets the explicit
        // not-found decision instead of a fatal mid-fetch/mid-checkout.
        var remoteBranchExists = prHelper.remoteBranchExists(cmd, null, branchName);
        if (remoteBranchExists) {
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
 * gh-1096: a fork PR's head branch never exists on origin — check the PR
 * head out through its always-fetchable pull ref (refs/pull/<N>/head) onto
 * a local branch named after the PR branch.
 */
function _checkoutPullRef(branchName, cmd, pullRef) {
    console.log('Fork PR head: checking out ' + pullRef + ' as ' + branchName);
    cmd(prHelper.buildOriginFetchCommand(pullRef));
    cmd('git checkout -B ' + branchName + ' FETCH_HEAD');
}

// gh-1096: pull-ref checkout for a fork head, the origin-branch switch otherwise.
function _switchOrPullRef(branchName, cmd, pullRef) {
    if (pullRef) return _checkoutPullRef(branchName, cmd, pullRef);
    return _switchToBranch(branchName, cmd);
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
 * @param {string} [pullRef] - gh-1096: refs/pull/<N>/head for a FORK PR head
 *        (the branch is absent on origin); omitted for same-repo PRs.
 * @returns {{ branch: string, hadConflict: boolean }}
 */
function checkoutPRBranch(branchName, workingDir, baseBranch, pullRef) {
    console.log('Checking out PR branch:', branchName);
    var cmdOpts = workingDir ? { workingDirectory: workingDir } : {};
    var cmd = function(command) { return cli_execute_command(Object.assign({}, cmdOpts, { command: command })); };

    cmd('git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"');
    cmd('git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"');

    // 1. Snapshot local state so a dirty tree can never block the switch below.
    // factory-kit excluded: the factory workflow's nested machine-infra repo
    // (git init inside the workspace) is a gitlink `git add -A` cannot stage
    // (exit 128, live gh-1000 timer auto-commits failing all session long).
    var dirty = cleanCommandOutput(cmd('git status --porcelain') || '')
        .split('\n')
        .filter(function (line) { return line.trim() && !/^(\?\?|A )\s+factory-kit(\/|$)/.test(line); })
        .join('\n').trim();
    var stashed = false;
    if (dirty) {
        console.log('Working tree has local changes — stashing before branch switch');
        // gh-1164: probe-filtered — a static `:!factory-kit` exclusion trips
        // git add's ignored-pathspec guard when the kit exists AND is
        // gitignored; when it is NOT ignored (the nested-gitlink case) the
        // exclusion is kept and the guard cannot fire.
        cmd('git add -A -- ' + gitStaging.buildExclusionPathspecs(['factory-kit'], function (args) {
            return cmd(args.command);
        }));
        try {
            cmd('git stash push -u -m "preflight-checkout-' + branchName + '"');
            stashed = true;
        } catch (e) {
            console.warn('git stash push failed, proceeding without a safety snapshot:', e);
        }
    }

    // 2. Switch branches — tree is clean now, so this should never fail on
    //    "untracked files would be overwritten" again.
    _switchOrPullRef(branchName, cmd, pullRef);

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
        // Make sure origin/<baseBranch> tracking ref exists before anything
        // downstream (detectMergeConflicts, getPRDiff, syncBranchWithBase)
        // relies on it — a plain `fetch --prune` above only refreshes refs
        // already tracked per the remote's configured refspec, which is
        // insufficient for a base branch never explicitly fetched before
        // (e.g. a fixVersion-derived "develop/3.9.0" in a shallow CI clone).
        prHelper.ensureRemoteBranchRef(cmd, workingDir, baseBranch);

        var current = cleanCommandOutput(cmd('git rev-parse --abbrev-ref HEAD') || '').trim();
        if (current === baseBranch) {
            console.warn('⚠️ Still on base branch "' + baseBranch + '" after checkout — recreating ' + branchName + ' from origin/' + baseBranch);
            cmd('git checkout -B ' + branchName + ' origin/' + baseBranch);
        }
    }

    console.log('✅ Checked out branch:', branchName, hadConflict ? '(with unresolved conflicts from local snapshot)' : '');
    return { branch: branchName, hadConflict: hadConflict };
}

// ── getPRDiff helpers (gh-962) ───────────────────────────────────────────────
// Extracted verbatim from the former getPRDiff monolith (CRAP 506). The git
// command strings, fallback order and every log line are byte-identical to
// the inline code they replace — pinned by the characterization suite in
// js/unit-tests/test_gitOps.js.

// 'origin/x' → 'x'; anything else passes through unchanged.
function stripOriginPrefix(branchName) {
    return branchName.indexOf('origin/') === 0 ? branchName.slice('origin/'.length) : branchName;
}

// 'x' → 'origin/x'; an already-prefixed name passes through unchanged.
function withOriginPrefix(branchName) {
    return branchName.indexOf('origin/') === 0 ? branchName : 'origin/' + branchName;
}

// Unshallow if needed so there is a full merge base available. A failing
// probe stays silent — the repository is already complete or unshallow is
// not supported (same swallow as the original inline block).
function _unshallowForMergeBase(cmd) {
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
}

// Runs one git command. Returns the CLEANED capture plus the RAW length —
// the "Diff size: N chars" log lines count the raw capture (wrapper trailer
// included), exactly like the original inline code did. A null/undefined
// throw rethrows so it surfaces in getPRDiff's outer catch exactly like the
// original `e.message` dereference did — it must NOT be converted into a
// fallback attempt.
function _runDiffCommand(cmd, command) {
    try {
        var raw = cmd(command) || '';
        return { ok: true, raw: raw, diff: cleanCommandOutput(raw) };
    } catch (e) {
        if (!e) throw e;
        return { ok: false, error: e.message || e };
    }
}

// First strategy: three-dot diff (shows only changes on headBranch since
// divergence). Returns the diff, or null (after the original warn) on failure.
function _tryThreeDotDiff(cmd, baseBranch, headBranch) {
    var result = _runDiffCommand(cmd, 'git diff ' + baseBranch + '...' + headBranch);
    if (result.ok) {
        console.log('Diff size:', result.raw.length, 'chars');
        return result.diff;
    }
    console.warn('Three-dot diff failed (likely no merge base), trying with origin/ prefix:', result.error);
    return null;
}

// Fallback: three-dot diff with an explicit origin/ prefix on the base branch.
function _tryOriginFallbackDiff(cmd, baseBranch, headBranch) {
    var result = _runDiffCommand(cmd, 'git diff ' + withOriginPrefix(baseBranch) + '...' + headBranch);
    if (result.ok) {
        console.log('Diff size (origin fallback):', result.raw.length, 'chars');
        return result.diff;
    }
    console.warn('Origin-prefix diff also failed, trying merge-base approach:', result.error);
    return null;
}

// Last resort: find the explicit merge-base commit and diff from there. An
// EMPTY merge-base silently falls through to the all-failed log (original
// behaviour — only command failures warn).
function _tryMergeBaseDiff(cmd, baseBranch, headBranch) {
    var probe = _runDiffCommand(cmd, 'git merge-base ' + withOriginPrefix(baseBranch) + ' ' + headBranch);
    if (!probe.ok) {
        console.warn('Merge-base diff also failed:', probe.error);
        return null;
    }
    var mergeBase = probe.diff;
    if (mergeBase && mergeBase.trim().length > 0) {
        var result = _runDiffCommand(cmd, 'git diff ' + mergeBase.trim() + '...' + headBranch);
        if (result.ok) {
            console.log('Diff size (merge-base fallback):', result.raw.length, 'chars');
            return result.diff;
        }
        console.warn('Merge-base diff also failed:', result.error);
    }
    return null;
}

function getPRDiff(baseBranch, headBranch, workingDir) {
    var cmdOpts = workingDir ? { workingDirectory: workingDir } : {};
    var cmd = function(command) { return cli_execute_command(Object.assign({}, cmdOpts, { command: command })); };
    try {
        console.log('Generating diff between', baseBranch, 'and', headBranch, workingDir ? '(in ' + workingDir + ')' : '');

        // Make sure origin/<baseBranch> tracking ref exists, in case this is
        // called standalone (without a preceding checkoutPRBranch in the same
        // working dir) against a base branch never fetched with an explicit
        // refspec before.
        prHelper.ensureRemoteBranchRef(cmd, workingDir, stripOriginPrefix(baseBranch));

        // Unshallow if needed so there is a full merge base available
        _unshallowForMergeBase(cmd);

        // First try three-dot diff (shows only changes on headBranch since divergence)
        var diff = _tryThreeDotDiff(cmd, baseBranch, headBranch);
        if (diff !== null) return diff;

        // Fallback: try with explicit origin/ prefix on base branch
        diff = _tryOriginFallbackDiff(cmd, baseBranch, headBranch);
        if (diff !== null) return diff;

        // Last resort: find explicit merge-base commit and diff from there
        diff = _tryMergeBaseDiff(cmd, baseBranch, headBranch);
        if (diff !== null) return diff;

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
// Extracted verbatim from the former detectMergeConflicts monolith
// (gh-1011 CRAP rework). The git command strings, log/warn lines, fallback
// order and return shapes are byte-identical to the inline code they
// replace — pinned by the characterization suites in
// js/unit-tests/test_gitOps.js (gh-802 AC3a + gh-1011 conflict handling).

// The host surfaces CLI exit codes as a COMMAND_EXIT_CODE=N trailer in the
// thrown message — parse it back out.
function _commandExitCode(error) {
    var msg = error && error.message ? error.message : String(error);
    var m = String(msg).match(/COMMAND_EXIT_CODE=(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

// Unshallow if needed so there is a full merge base available. A failing
// probe (or a failing unshallow) stays silent — the repository is already
// complete or unshallow is not supported (same swallow as the original
// inline block).
function _unshallowIfNeeded(cmd) {
    try {
        var isShallow = cleanCommandOutput(cmd('git rev-parse --is-shallow-repository') || 'false');
        if (isShallow.trim() === 'true') {
            cmd('git fetch --unshallow');
            console.log('Unshallowed repository for full merge base detection');
        }
    } catch (e) {
        // ignore — already complete or unshallow not supported
    }
}

// Detect whether the just-completed merge staged base changes. gh-802 AC3a:
// only claim "staged" when the merge actually staged something — an
// up-to-date branch merges as a no-op. Exit 1 from the quiet diff is the
// expected staged signal; any other failure keeps the conservative "staged"
// assumption but is announced.
function _mergeStagedChanges(cmd) {
    try {
        cmd('git diff --cached --quiet HEAD'); // exit 0 → nothing staged
        return false;
    } catch (eQuiet) {
        var quietExitCode = _commandExitCode(eQuiet);
        if (quietExitCode !== 1) {
            console.warn('git diff --cached --quiet failed (assuming staged):',
                eQuiet && eQuiet.message ? eQuiet.message : String(eQuiet));
        }
        return true;
    }
}

// Lines prefixed UU, AA, DD, AU, UA, DU, UD are conflict markers — map them
// to their file names, trimmed.
function _extractConflictFiles(statusRaw) {
    return String(statusRaw || '').split('\n').filter(function(line) {
        return /^(UU|AA|DD|AU|UA|DU|UD) /.test(line.trim());
    }).map(function(l) {
        return l.trim().substring(3).trim();
    });
}

function _buildMergeConflictsMarkdown(baseBranch, conflictFiles) {
    var md = '# ⚠️ Merge Conflicts — Resolve Before Rework\n\n';
    md += 'This branch has conflicts with `' + baseBranch + '`. ';
    md += conflictFiles.length + ' file(s) contain conflict markers:\n\n';
    conflictFiles.forEach(function(f) { md += '- `' + f + '`\n'; });
    md += '\n## Resolution Steps\n\n';
    md += '1. Open each conflicting file and resolve the `<<<<<<<` / `=======` / `>>>>>>>` markers\n';
    md += '2. Stage each resolved file: `git add <file>`\n';
    md += '3. Once all conflicts are resolved, proceed with fixes from `pr_discussions.md`\n\n';
    md += '**Do NOT run `git commit` or `git merge --abort`** — the commit and push are handled automatically.\n';
    return md;
}

function _writeMergeConflictsFile(inputFolder, baseBranch, conflictFiles) {
    file_write({ path: inputFolder + '/merge_conflicts.md', content: _buildMergeConflictsMarkdown(baseBranch, conflictFiles) });
    console.log('✅ Wrote merge_conflicts.md');
}

// git merge exits non-zero when there are unresolved conflicts. Inspect the
// short status for conflict markers; write merge_conflicts.md and leave the
// working directory in the conflicted merge state so the agent can resolve
// it. Every failure fallback returns [] exactly like the original inline
// catch block.
function _handleMergeError(cmd, inputFolder, baseBranch, mergeError) {
    try {
        var statusRaw = cleanCommandOutput(cmd('git status --short') || '');
        var conflictFiles = _extractConflictFiles(statusRaw);

        if (conflictFiles.length === 0) {
            // Not a conflict error — abort and move on
            try { cmd('git merge --abort'); } catch (e) {}
            console.warn('Merge failed (non-conflict reason):', mergeError.message || mergeError);
            return [];
        }

        console.warn('⚠️ Merge conflicts in ' + conflictFiles.length + ' file(s):', conflictFiles.join(', '));
        _writeMergeConflictsFile(inputFolder, baseBranch, conflictFiles);
        return conflictFiles;
    } catch (statusError) {
        console.warn('Could not determine merge state after conflict:', statusError);
        try { cmd('git merge --abort'); } catch (e) {}
        return [];
    }
}

function detectMergeConflicts(baseBranch, inputFolder, workingDir) {
    var cmdOpts = workingDir ? { workingDirectory: workingDir } : {};
    var cmd = function(command) { return cli_execute_command(Object.assign({}, cmdOpts, { command: command })); };
    try {
        console.log('Checking for merge conflicts with origin/' + baseBranch + (workingDir ? ' in ' + workingDir : '') + '...');

        // See getPRDiff/checkoutPRBranch — ensure the tracking ref exists in
        // case this is the first git command in the working dir to reference
        // origin/<baseBranch>.
        prHelper.ensureRemoteBranchRef(cmd, workingDir, baseBranch);

        _unshallowIfNeeded(cmd);

        cmd('git merge origin/' + baseBranch + ' --no-commit --no-ff');

        // If we reach here the merge is clean — staged but not committed.
        // gh-802 AC3a: only claim "base branch changes staged" when the merge
        // actually staged something — an up-to-date branch merges as a no-op
        // and the old unconditional line was a false statement in the log.
        var stagedChanges = _mergeStagedChanges(cmd);
        console.log(stagedChanges
            ? 'No merge conflicts — base branch changes staged'
            : 'No merge conflicts — branch already up to date with origin/' + baseBranch);
        return [];

    } catch (mergeError) {
        // git merge exits non-zero when there are unresolved conflicts
        return _handleMergeError(cmd, inputFolder, baseBranch, mergeError);
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
/**
 * gh-806 AC4 + gh-957 AC3: serialize the open threads (already-resolved ones
 * filtered out — a rework/review leg must not spend a duplicate reply pass on
 * closed conversations) WITH the GraphQL census riding along (arm-rule
 * unresolved count + trusted-author breakdown) — the rework leg's input and
 * the SM arm's threads count stay the SAME source.
 */
function writeDiscussionsRawJson(inputFolder, rawThreads) {
    var allThreads = (rawThreads.threads || []);
    var openThreads = allThreads.filter(function(t) { return !!t && t.resolved !== true; });
    if (openThreads.length !== allThreads.length) {
        console.log('Filtered ' + (allThreads.length - openThreads.length) +
            ' already-resolved thread(s) out of pr_discussions_raw.json (gh-806 AC4)');
    }
    writeInputFile(
        inputFolder + '/pr_discussions_raw.json',
        JSON.stringify({ threads: openThreads, census: rawThreads.census || null }, null, 2),
        'pr_discussions_raw.json (' + openThreads.length + ' threads)'
    );
}

// ── gh-1226 (CRAP ratchet): pure pr_info.md builders ─────────────────────────
// Same block order and fallback strings as the former inline prInfo assembly —
// pinned by the writePRContext characterization tests.

// PR #/URL/title/author/branch lines plus the fork checkout line (gh-806).
function _prInfoHeader(prDetails) {
    var prInfo = '# Pull Request Information\n\n';
    prInfo += '- **PR #**: ' + prDetails.number + '\n';
    prInfo += '- **URL**: ' + prDetails.html_url + '\n';
    prInfo += '- **Title**: ' + prDetails.title + '\n';
    prInfo += '- **Author**: ' + (prDetails.user ? prDetails.user.login : 'unknown') + '\n';
    prInfo += '- **Branch**: `' + (prDetails.head ? prDetails.head.ref : 'unknown') +
              '` → `' + (prDetails.base ? prDetails.base.ref : 'unknown') + '`\n';
    prInfo += forkCheckout.forkHeadInfoLine(prDetails);
    return prInfo;
}

// State/change-stat/timestamp lines; absent numbers and dates render neutral.
function _prInfoStats(prDetails) {
    var prInfo = '- **State**: ' + prDetails.state + '\n';
    prInfo += '- **Files Changed**: ' + (prDetails.changed_files || 0) + '\n';
    prInfo += '- **Additions**: +' + (prDetails.additions || 0) + '\n';
    prInfo += '- **Deletions**: -' + (prDetails.deletions || 0) + '\n';
    prInfo += '- **Created**: ' + (prDetails.created_at || '') + '\n';
    prInfo += '- **Updated**: ' + (prDetails.updated_at || '') + '\n';
    return prInfo;
}

function _prInfoMarkdown(prDetails) {
    var prInfo = _prInfoHeader(prDetails) + _prInfoStats(prDetails);
    if (prDetails.body) {
        prInfo += '\n## PR Description\n\n' + prDetails.body + '\n';
    }
    return prInfo;
}

function writePRContext(inputFolder, prDetails, diff, markdown, rawThreads) {
    // pr_info.md
    writeInputFile(inputFolder + '/pr_info.md', _prInfoMarkdown(prDetails), 'pr_info.md');

    // pr_diff.txt
    var diffContext = trimLargeTextForInput(diff || 'No diff available', 'PR Diff', MAX_PR_DIFF_CONTEXT_CHARS);
    writeInputFile(inputFolder + '/pr_diff.txt', diffContext, 'pr_diff.txt');

    // pr_discussions.md
    if (markdown) {
        writeInputFile(inputFolder + '/pr_discussions.md', markdown, 'pr_discussions.md');
    }

    // pr_discussions_raw.json
    if (rawThreads) {
        writeDiscussionsRawJson(inputFolder, rawThreads);
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
    writeDiscussionsRawJson: writeDiscussionsRawJson,
    writePRContext: writePRContext
};
