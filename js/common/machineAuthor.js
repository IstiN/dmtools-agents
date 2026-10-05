/**
 * Machine-author resolution for the #687 PR lifecycle.
 *
 * Whose login counts as "the machine" (the identities the harness authors
 * PRs through) is deployment-specific — this repo never hardcodes it. The
 * knob is a comma-separated LIST of logins since gh-728 (owner directive
 * 2026-10-05: 'ai-teammate,github-actions[bot]' — the CI bot opens its own
 * PRs, live fa PR #1249): `resolveMachineAuthor` returns the raw string;
 * `machineAuthorLogins` splits it; `isMachineAuthored` (authors) and
 * `isMachineLogin` (commit actors) match any entry. All machine-keyed
 * guards (the `notMachine` review rule, the rework re-arm in PR-anchored
 * reviews, the SM `prMachineAuthor` query gate, the sticky-park RESET)
 * resolve through these helpers. Resolution order:
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
 * @returns {string|null} the raw machine-login string (possibly a
 *                        comma-separated list), or null when unconfigured
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

/**
 * The raw config string as a LIST of machine logins (gh-728): the knob is
 * a comma-separated string — 'ai-teammate,github-actions[bot]' — and
 * every machine-keyed guard treats it as a SET of logins (a deployment may
 * run several machine identities: the agent harness bot AND the CI bot
 * that opens its own PRs, live fa PR #1249). Trimmed per entry; empty
 * entries dropped; null/absent → the empty list, so every guard keyed on
 * it fails closed exactly like the historical single-login null.
 *
 * @param {string|null} machineAuthor raw resolveMachineAuthor output
 * @returns {string[]} the login entries (possibly empty)
 */
function machineAuthorLogins(machineAuthor) {
    if (!machineAuthor) return [];
    var raw = String(machineAuthor).split(',');
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var entry = raw[i].trim();
        if (entry) out.push(entry);
    }
    return out;
}

/**
 * Case-insensitive membership test for ACTOR probes (the sticky-park
 * RESET in smAgent.js): those have always lowercase-compared the head
 * commit's GitHub login against the machine login — with a list, a push
 * by ANY entry is machine movement (the park survives every machine
 * login's push, not just the first one's).
 *
 * @param {string|null} login      the actor/committer login to test
 * @param {string|null} machineAuthor raw resolveMachineAuthor output
 * @returns {boolean} true when login matches any list entry
 */
function isMachineLogin(login, machineAuthor) {
    var l = String(login || '').toLowerCase();
    if (!l) return false;
    var entries = machineAuthorLogins(machineAuthor);
    for (var i = 0; i < entries.length; i++) {
        if (entries[i].toLowerCase() === l) return true;
    }
    return false;
}

// Release-bump PRs (the auto-release flow, fa #1093) are authored by the
// REPO OWNER, not by a machine login: `scripts/auto_release.sh` runs in
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
 * (`prMachineAuthor` positive gate, `notMachine` negative filter, the
 * rework re-arms): the deployment's machine logins (the knob is a
 * comma-separated LIST since gh-728 — trim + case-SENSITIVE exact match
 * per entry; PR authors arrive canonicalized from the API) OR a
 * release-bump PR authored by the repo owner (see isMachineReleaseBump).
 * Everything else — including an owner-authored PR with a non-bump
 * shape — is NOT machine. Unconfigured (null/empty knob) → only the
 * release-bump carve-out can match.
 */
function isMachineAuthored(item, machineAuthor, owner) {
    var author = itemAuthor(item);
    if (author && machineAuthorLogins(machineAuthor).indexOf(author) !== -1) return true;
    return isMachineReleaseBump(item, owner);
}

module.exports = {
    resolveMachineAuthor: resolveMachineAuthor,
    machineAuthorLogins: machineAuthorLogins,
    isMachineLogin: isMachineLogin,
    isMachineReleaseBump: isMachineReleaseBump,
    isMachineAuthored: isMachineAuthored
};
