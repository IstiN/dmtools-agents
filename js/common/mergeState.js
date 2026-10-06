/**
 * Shared git merge-state probes (gh-761).
 *
 * A conflicted merge of the base branch sits unconcluded in the working tree
 * (MERGE_HEAD present) until someone deliberately resolves or aborts it:
 * the rework setup leaves that state for the CLI agent on purpose, and the
 * agent's own `git merge origin/main` can be mid-conflict at any tick.
 *
 * Every commit- or merge-producing site must consult this ONE probe before
 * touching the tree (same canonical-helper rationale as gitStaging.js —
 * duplicated probes drift):
 *   - js/timerAutoCommitAndSave.js — a blind `git add -A && git commit`
 *     would stage the unmerged paths (conflict markers included) and
 *     FINALIZE the foreign merge as a 'WIP auto-save' commit pushed to
 *     origin: silent branch corruption flowing into validation/review.
 *   - js/common/pullRequest.js syncBranchWithBase — `git merge` on top of
 *     MERGE_HEAD fails ("You have not concluded your merge") and the
 *     resolveMergeConflicts/abort fallback would then auto-resolve — or
 *     silently abort — the agent's in-flight merge.
 *   - js/storyTestAutomationRework.js mergeMain — same finalize-a-foreign-
 *     merge hazard through its --ours/--theirs auto-resolution.
 *
 * `runCommand` follows the (command, workingDir) convention shared with
 * common/pullRequest.js — pass the site's cli_execute_command wrapper so the
 * probe executes in the SAME working directory as the commit/merge it gates.
 *
 * GraalJS-compatible: var/plain functions only, no Node APIs.
 */

/**
 * True when MERGE_HEAD resolves — a merge is in progress in that working tree.
 *
 * Real git prints the merge-head SHA and exits 0 when MERGE_HEAD exists; it
 * exits 1 (cli_execute_command throws) when it doesn't. Requiring non-empty
 * output in addition to a non-throwing call keeps loose test doubles that
 * return '' for unknown commands on the "not in progress" path.
 */
function isMergeInProgress(runCommand, workingDir) {
    if (typeof runCommand !== 'function') return false;
    try {
        var out = runCommand('git rev-parse --quiet --verify MERGE_HEAD', workingDir);
        return !!(out && String(out).trim());
    } catch (e) {
        return false; // exit 1 — no MERGE_HEAD, the normal case
    }
}

module.exports = {
    isMergeInProgress: isMergeInProgress
};
