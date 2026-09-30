/**
 * Machine-author resolution for the #687 PR lifecycle.
 *
 * Whose login counts as "the machine" (the bot the harness authors PRs
 * through) is deployment-specific — this repo never hardcodes it. All
 * machine-keyed guards (the `notMachine` review rule, the rework re-arm
 * in PR-anchored reviews, the SM `prMachineAuthor` query gate) resolve through
 * this single helper. Resolution order:
 *
 *   1. `jobParams.machineAuthor` — the JSON parameter at factory setup:
 *      factory-sm.yml `machine-author` input lands in the `dmtools run`
 *      override (`{"params":{"jobParams":{...,"machineAuthor":"..."}}}}`).
 *      The global-level knob: set once by the harness (machine-sm.yml),
 *      valid for every repo the factory runs against.
 *   2. `config.machineAuthor` — the per-repo `.dmtools/config.js` knob,
 *      for fleets where different repos run different bots.
 *   3. `null` — no machine author configured. Every guard keyed on it is
 *      inert/fail-closed per guard: all green PRs are reviewable
 *      (notMachine inert), no `agent:rework` re-arm on verdicts, and the
 *      SM `prMachineAuthor` rules match nothing (no auto legs at all).
 *      Note: `pr_approved` arming on APPROVE is NOT author-gated — the
 *      owner rule auto-approves external PRs too; only auto-REWORK is
 *      machine-only.
 *
 * @param {Object|null} jobParams job params carrying an optional override
 *                                (accepts the sm ctx: it exposes the same
 *                                `machineAuthor` field).
 * @param {Object|null} config    project config (.dmtools/config.js)
 * @returns {string|null} the machine login, or null when unconfigured
 */
function resolveMachineAuthor(jobParams, config) {
    if (jobParams && jobParams.machineAuthor) {
        return String(jobParams.machineAuthor);
    }
    if (config && config.machineAuthor) {
        return String(config.machineAuthor);
    }
    return null;
}

// Release-bump PRs (the auto-release flow, fa #1093) are authored by the
// REPO OWNER, not by the machine login: `scripts/auto_release.sh` runs in
// CI on main and creates `chore/release-vX.Y.Z` through the owner's
// RELEASE_PAT, so GitHub records the owner as the PR author. The
// deployment knob (`machineAuthor`, e.g. `ai-teammate`) never matches
// them — `prMachineAuthor` rules fired nothing and `notMachine` rules
// kept claiming them, so every release bump stalled outside the machine
// loop (live: fa #1104, 2026-09-30, hand-driven review leg).
//
// Owner rule 2026-09-30: a release-bump PR authored by the REPO OWNER
// counts as machine-authored. Fail-closed everywhere else:
//   - no owner resolvable → false (the shape alone proves nothing);
//   - author != owner → false (a foreigner pushing a chore/release-v*
//     branch is NOT machine — the auto-release flow can only ever author
//     from repo credentials);
//   - anything not matching the bump shape → false.
// The shape: branch `chore/release-v*` (auto_release.sh) OR title
// `chore(release): …` (the squash subject the bump PR carries).
var RELEASE_BUMP_BRANCH_RE = /^chore\/release-v/;
var RELEASE_BUMP_TITLE_RE = /^chore\(release\):/;

function itemAuthor(item) {
    return String((item && (item.author || (item.pr && item.pr.author))) || '');
}

function isMachineReleaseBump(item, owner) {
    var author = itemAuthor(item);
    if (!owner || !author) return false;
    if (author.toLowerCase() !== String(owner).toLowerCase()) return false;
    var branch = String((item && (item.branch || (item.pr && item.pr.branch))) || '');
    var title = String((item && (item.title || (item.pr && item.pr.title))) || '');
    return RELEASE_BUMP_BRANCH_RE.test(branch) || RELEASE_BUMP_TITLE_RE.test(title);
}

/**
 * The single machine-authorship predicate for every author-keyed guard
 * (`prMachineAuthor` positive gate, `notMachine` negative filter): the
 * deployment's machine login OR a release-bump PR authored by the repo
 * owner (see isMachineReleaseBump). Everything else — including an
 * owner-authored PR with a non-bump shape — is NOT machine.
 */
function isMachineAuthored(item, machineAuthor, owner) {
    if (machineAuthor && itemAuthor(item) === machineAuthor) return true;
    return isMachineReleaseBump(item, owner);
}

module.exports = {
    resolveMachineAuthor: resolveMachineAuthor,
    isMachineReleaseBump: isMachineReleaseBump,
    isMachineAuthored: isMachineAuthored
};
