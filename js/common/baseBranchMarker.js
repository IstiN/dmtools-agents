/**
 * Persists the job's resolved base branch to a well-known output file so that
 * quality-gate shell commands can read it back.
 *
 * Why this exists: `customParams.feedbackLoop.qualityGates.gates[].command` is a
 * static shell string baked into a project's JSON config at authoring time — it
 * cannot reference `config.git.baseBranch` (resolved at runtime, e.g. via
 * `baseBranchResolverFnPath` keyed off the ticket's fixVersion, or a PR's own
 * actual base ref) because there is no templating/interpolation step between the
 * JSON config and the shell command string. In practice this means gate scripts
 * that need a "diff against the base branch" ref (e.g. a SpotBugs or coverage
 * new-code scan) end up with a single hardcoded literal like "origin/master" —
 * which silently produces wrong (too-broad or empty) results for any repo/ticket
 * that releases via a non-default branch (e.g. a versioned "develop/{version}"
 * branch), instead of failing loudly.
 *
 * The fix: write the ACTUAL resolved base branch name (no "origin/" prefix) to
 * `outputs/pr_base_branch.txt` once it's known (from a preCliJSAction hook), so a
 * gate script can read it back and use `origin/<content>` instead of a hardcoded
 * ref, falling back to its own default candidates if the file is absent/empty/stale.
 *
 * Written to `outputs/` (the job root), NOT inside `config.workingDir` (the target
 * repo's own git checkout) — so it can never be accidentally picked up by a later
 * `git add .`/`git add -A` in the target repo and leak into a commit. Gate commands
 * run with `workingDirectory` set to `config.workingDir` (conventionally 2 directory
 * levels below the job root, e.g. "./dependencies/<repo>") and already reference the
 * job root via a "../../..." relative prefix (e.g. "../../agents/scripts/foo.sh") —
 * scripts consuming this marker file should follow the same "../../outputs/..." convention.
 *
 * @param {string} baseBranch - the resolved base branch name, WITHOUT any "origin/"
 *                              prefix (e.g. "master", "develop/3.9.0"). No-op if falsy.
 */
function writeBaseBranchMarker(baseBranch) {
    if (!baseBranch) return;
    try {
        file_write({ path: 'outputs/pr_base_branch.txt', content: String(baseBranch) });
    } catch (e) {
        console.warn('writeBaseBranchMarker: failed to write outputs/pr_base_branch.txt (non-fatal):',
            e && e.toString ? e.toString() : String(e));
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { writeBaseBranchMarker };
}
