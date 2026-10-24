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

// gh-1025 (live 2026-10-18, SM tick 39103844372): GitHub reports App
// authors WITH a `[bot]` suffix (`dmtools-factory-bot[bot]`) while the
// deployment knob lists the bare login (`dmtools-factory-bot`, added by
// #988 — which therefore never matched). Every prMachineAuthor SM rule
// failed closed for ~8h: zero rework legs, zero arms, queue silently
// dead. Comparisons strip ONE trailing `[bot]` (case-insensitive) from
// both sides; a bare `bot` ending without brackets (`robot`) is never
// touched, and different bots still never match (`dependabot[bot]` !=
// `dmtools-factory-bot`).
function stripBotSuffix(login) {
    return String(login || '').replace(/\[bot\]$/i, '');
}

/**
 * Case-insensitive membership test for ACTOR probes (the sticky-park
 * RESET in smAgent.js): those have always lowercase-compared the head
 * commit's GitHub login against the machine login — with a list, a push
 * by ANY entry is machine movement (the park survives every machine
 * login's push, not just the first one's). The `[bot]` suffix is
 * normalized on both sides (gh-1025).
 *
 * @param {string|null} login      the actor/committer login to test
 * @param {string|null} machineAuthor raw resolveMachineAuthor output
 * @returns {boolean} true when login matches any list entry
 */
function isMachineLogin(login, machineAuthor) {
    var l = stripBotSuffix(String(login || '').toLowerCase());
    if (!l) return false;
    var entries = machineAuthorLogins(machineAuthor);
    for (var i = 0; i < entries.length; i++) {
        if (stripBotSuffix(entries[i].toLowerCase()) === l) return true;
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

// Carrier-field reader: the SM item shape carries author/branch/title
// either flat on the item or on the linked pr payload (both appear in the
// wild — issue-carrier items are flat, prStatus payloads nest under pr).
// Missing everywhere reads as ''.
function itemField(item, field) {
    return String((item && (item[field] || (item.pr && item.pr[field]))) || '');
}

function itemAuthor(item) {
    return itemField(item, 'author');
}

function isMachineReleaseBump(item, owner) {
    var author = itemAuthor(item);
    if (!owner || !author) return false;
    if (author.toLowerCase() !== String(owner).toLowerCase()) return false;
    // The shape: branch `chore/release-v*` (auto_release.sh) OR title
    // `chore(release): …` (the squash subject the bump PR carries).
    return RELEASE_BUMP_BRANCH_RE.test(itemField(item, 'branch')) ||
        RELEASE_BUMP_TITLE_RE.test(itemField(item, 'title'));
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
    if (author) {
        // gh-1025: the bare login part stays case-SENSITIVE (design);
        // only the API's App `[bot]` suffix is normalized away.
        var bareAuthor = stripBotSuffix(author);
        // gh-1025 review: a degenerate '[bot]'-only author strips to ''
        // and must never match ('' === '' would trust everyone).
        if (bareAuthor) {
            var entries = machineAuthorLogins(machineAuthor);
            for (var i = 0; i < entries.length; i++) {
                if (stripBotSuffix(entries[i]) === bareAuthor) return true;
            }
        }
    }
    return isMachineReleaseBump(item, owner);
}

/**
 * Comment/thread-layer trust test (gh-1025 review): the verdict/consume/lap
 * markers and the machine-thread census match comment AUTHORS against the
 * machine allowlist. Same normalization as the login predicates — both
 * sides lowercased and stripped of one trailing `[bot]` — so a marker
 * authored by `dmtools-factory-bot[bot]` (the App identity) is trusted
 * under the bare knob entry `dmtools-factory-bot`. Empty-after-strip never
 * matches; a different bot never matches.
 *
 * @param {string|null} login       comment/thread author login
 * @param {string[]}    loginsList  allowlist entries (machineAuthorLogins output)
 * @returns {boolean}
 */
function loginMatchesList(login, loginsList) {
    var l = stripBotSuffix(String(login || '').toLowerCase());
    if (!l) return false;
    var list = Array.isArray(loginsList) ? loginsList : [];
    for (var i = 0; i < list.length; i++) {
        var e = stripBotSuffix(String(list[i] || '').toLowerCase());
        if (e && e === l) return true;
    }
    return false;
}

module.exports = {
    resolveMachineAuthor: resolveMachineAuthor,
    machineAuthorLogins: machineAuthorLogins,
    isMachineLogin: isMachineLogin,
    isMachineReleaseBump: isMachineReleaseBump,
    isMachineAuthored: isMachineAuthored,
    stripBotSuffix: stripBotSuffix,
    loginMatchesList: loginMatchesList
};
