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

module.exports = { resolveMachineAuthor: resolveMachineAuthor };
