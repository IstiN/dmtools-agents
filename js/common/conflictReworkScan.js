// gh-1027: per-tick scan budget for the conflict-rework rule.
//
// An already-reported DIRTY PR must not consume a rule-limit slot: gh-1025
// raised the limit 1 -> 5, which only pushed the starvation class out to
// 5+ parked markers (live 2026-10-18: fa #983 parked every tick behind its
// own marker while unreported PRs were never evaluated, each still costing
// a github_get_pr_comments fetch). The engine loop now scans candidates
// until `limit` ACTIONABLE (unreported) ones were processed, and this
// module bounds that scan so a long parked queue cannot fan the per-tick
// comments fetches without limit.
//
// Bounded, not eliminated (the same tradeoff gh-922's
// TRIGGER_FALLTHROUGH_RESERVE documents): parked markers beyond the budget
// ahead of the first unreported candidate re-starve one tick's slice —
// they drain as their rework legs land, so the bound only ever costs a
// tick of delay, never a deadlock.
//
// Shared by js/smAgent.js (the rule loop's break condition) and
// js/sm/sources/githubSource.js (queryPrs' candidate slice) — the two must
// agree, or the query slice re-cuts the queue before the loop ever sees
// the candidates behind the parked markers.
'use strict';

// Extra already-reported candidates a tick may scan past the rule limit.
var OVERSCAN = 15;

// Total candidates the conflict-rework rule may scan per tick for a given
// rule limit. A non-positive/invalid limit degrades to the overscan alone
// (callers with no rule limit are uncapped anyway and never consult this).
function scanLimit(limit) {
    var l = (typeof limit === 'number' && isFinite(limit) && limit > 0)
        ? Math.floor(limit) : 0;
    return l + OVERSCAN;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { OVERSCAN: OVERSCAN, scanLimit: scanLimit };
}
