/**
 * Machine-author resolution for the #687 PR lifecycle.
 *
 * Whose login counts as "the machine" (the bot the harness authors PRs
 * through) is deployment-specific — this repo never hardcodes it. All
 * machine-keyed guards (the `notMachine` review rule, the `pr_approved`
 * arming gate in PR-anchored reviews, the rework re-arm) resolve through
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
 *      inert: all green PRs are reviewable, and a PR-anchored review
 *      verdict never arms `pr_approved` nor re-arms `agent:rework`
 *      (external semantics — the verdict comment is the whole report).
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

module.exports = { resolveMachineAuthor: resolveMachineAuthor };
