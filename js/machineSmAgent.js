/**
 * Machine SM Agent — GitHub-issues machine-loop watchdog (JSRunner).
 *
 * The dark-factory loop over GitHub issues (dev → PR → CI → rework → AI
 * review → merge → close) relies on `labeled` events to wake the
 * ai-teammate workflow. Labels added with the workflow's own GITHUB_TOKEN
 * do NOT fire `labeled` events (GitHub rule), so every machine-added
 * label — agent:rework after red CI, pr_approved after an APPROVE verdict
 * — is a dead letter unless a human re-arms it (issue #116). This agent
 * is the safety net: a deterministic reconciler (no AI CLI, no LLM) that
 * runs on a short cron tick, reads the ACTUAL state of every
 * machine-managed issue (labels, linked PR, check rollup, merge state,
 * active workflow runs) and performs whatever step the state calls for —
 * dispatching legs directly via workflow_dispatch (GITHUB_TOKEN CAN
 * dispatch; only label events are mute), updating branches, merging
 * approved PRs, closing issues whose PRs merged.
 *
 * Concurrency contract: if any AI Teammate run is queued/in_progress the
 * agent idles for the whole tick (the cron re-fires soon — short ticks,
 * no long sleeps), so parallel runs finish before new legs start and the
 * per-issue concurrency group in ai-teammate.yml never cancels mid-flight
 * work. `maxConcurrentRuns` (default 1) relaxes this when the machine can
 * afford parallel legs.
 *
 * Configuration (override priority, sm-style):
 *   1. jobParams in agents/machine_sm.json (defaults)
 *   2. .dmtools/config.js `machineSm` section (project override)
 *      { machineSm: { dryRun: true, maxConcurrentRuns: 1, ... } }
 *   3. CLI JSON override (outer `params` wrapper — same quirk as sm):
 *      dmtools run agents/machine_sm.json '{"params":{"jobParams":{"dryRun":true}}}'
 *
 * jobParams fields:
 *   dryRun            — log the plan, perform no action (default false)
 *   maxConcurrentRuns — idle unless active AI Teammate runs < this (default 1)
 *   maxReworkRounds   — mirrors ai-teammate.yml MAX_AUTO_REWORK_ROUNDS (default 2)
 *   workflowFile      — the machine workflow to dispatch (default ai-teammate.yml)
 *   branchPrefix      — machine dev-branch prefix (default 'ai/gh-')
 *   agentHandle       — assignee that marks an issue machine-managed (default 'ai-teammate')
 *   issueLimit        — how many open issues to scan per tick (default 50)
 *   closeComment      — comment posted by the close-issue safety net
 *   machineAuthor     — the machine-identity allowlist (comma-separated)
 *   failureAnalysis   — gh-1366, the AI failure-analyzer leg (optional;
 *                       ABSENT → disabled silently). { afterFailures:
 *                       consecutive same-signature failures before the
 *                       analyzer dispatches (default 4); blockedLabel:
 *                       the park label (default 'sm:leg-blocked');
 *                       backoff: the transient-retry interval multiplier
 *                       (integer >= 1, default 1 = off) — gh-1380 makes
 *                       it real: after a pre-classified transient crossing
 *                       the SM absorbs backoff-1 further SM ticks before
 *                       the retry leg dispatches; transientPatterns
 *                       (gh-1380): regex source strings matched
 *                       case-insensitively against the gh-1363-normalized
 *                       signature — a streak matching ANY of them is
 *                       classified transient by the deterministic
 *                       pre-classifier (zero AI calls; the consumed
 *                       counter resets like a gh-1366 transient verdict;
 *                       MISSING/EMPTY → every failure routes to the AI
 *                       analyzer; defaults exported as
 *                       failureAnalyzer.DEFAULT_TRANSIENT_PATTERNS);
 *                       analyzerEnabled (gh-1380, default true): false
 *                       turns the AI analyzer leg off — the
 *                       pre-classifier + backoff still run (no AI
 *                       anywhere) }. Malformed → hard validation error at
 *                       SM start. On the failure path the SM classifies
 *                       known-transient signatures itself and dispatches
 *                       the `analyze` leg only for unrecognized ones at
 *                       the exact threshold crossing; a deterministic-infra
 *                       verdict parks the issue (label + ONE diagnostic
 *                       comment) until the label is removed or the issue
 *                       is re-assigned.
 *
 * Decision core (decideActions) is pure and unit-tested; all GitHub I/O
 * goes through `gh` via cli_execute_command and is injectable/mocks-able
 * through jobParams.ghRunner for tests.
 */
'use strict';

var configModule = require('./config.js');
var configLoader = require('./configLoader.js');
// gh-828 (hoisted, never lazy — the gh-823 pack-require rule): the
// post-APPROVE thread-resolution leg classifies threads through the
// reviewVerdicts pure helpers, and the machine-auth allowlist comes from
// the machineAuthor knob.
var reviewVerdictsModule = require('./common/reviewVerdicts.js');
var machineAuthorModule = require('./common/machineAuthor.js');
// gh-1352 (epic §4-disposition, part 3/4): the triage path closes
// machine-owned threads with machine-parsed disposition tags under the
// resolved reviewPolicy, defers mandatory-fix work to the review debt
// ledger, and dispatches the bounded polish lap when the approved head's
// census is polish-tier-only.
var reviewDispositionsModule = require('./common/reviewDispositions.js');
var reviewDebtLedgerModule = require('./common/reviewDebtLedger.js');
var reviewPolicyModule = require('./common/reviewPolicy.js');
var polishLapModule = require('./common/polishLap.js');
// gh-1352 rework round: the instability budget counts CONSECUTIVE polish
// laps — the machine-stamped dmtools:rework-lap markers are the
// non-polish dispatch evidence that breaks consecutiveness (the reset).
var reworkLoopGuardModule = require('./common/reworkLoopGuard.js');
// gh-1366: the AI failure-analyzer leg — the pure contract (config knobs,
// streak crossing, verdict markers, park diagnostic) shared by the SM
// decision core and the analyzer leg itself.
var failureAnalyzerModule = require('./common/failureAnalyzer.js');
// gh-1366: the park diagnostic renders in the machine loop's markdown
// flavor (commentMarkup.forFlavor('markdown')).
var commentMarkupModule = require('./common/commentMarkup.js');
// gh-1366: the failureAnalysis block override merge (shallow, knob-level).
var mergeObjectsModule = require('./common/mergeObjects.js');

// ─────────────────────────────────────────────────────────────────────────────
// Pure decision core — decideActions(state, cfg) → actions[]
//
// state = {
//   issue:  { number, labels: [..], assignees: [..] },
//   pr:     null | { number, state: 'OPEN'|'MERGED'|'CLOSED',
//                    checkConclusion: 'red'|'green'|'pending'|'none',
//                    mergeState: 'CLEAN'|'BEHIND'|'DIRTY'|'BLOCKED'|'UNKNOWN',
//                    mergeable: bool|null },
//   activeRunForIssue: bool
// }
// cfg = { maxReworkRounds: int }
//
// gh-1185 (CRAP): the decision table is split into the pure per-stage
// selectors below — engine-level skips, no-PR dead letters, closed-PR
// handling, red-CI routing, approved-green routing and the unapproved-green
// tail. decideActions stays the sequencer; every reason string and action
// shape is verbatim.
// ─────────────────────────────────────────────────────────────────────────────

function issueLabelsOf(state) {
    return (state.issue && state.issue.labels) || [];
}

function maxReworkRoundsOf(cfg) {
    return (cfg && cfg.maxReworkRounds) || 2;
}

// 'blocked' = human hold (fa #939): the official freeze switch — the
// reconciler skips the item ENTIRELY (no dead-letter re-fire, no branch
// update, no merge, no close) until a human removes the label.
// Engine-level, evaluated before every other decision; the SM rule
// engine (githubSource.matchesGuards) honors the same label.
function decideEngineSkip(has, activeRunForIssue) {
    if (has('blocked')) {
        return { type: 'skip', reason: 'blocked — human hold; the machine skips this item entirely' };
    }
    if (has('needs-human')) {
        return { type: 'skip', reason: 'needs-human — waiting for a human' };
    }
    if (activeRunForIssue) {
        return { type: 'skip', reason: 'active AI Teammate run for this issue' };
    }
    return null;
}

// Highest rework-round label, 0 when none — canonical in config.js, shared
// with Jira autoStartRework and ai-teammate.yml MAX_AUTO_REWORK_ROUNDS.
function countReworkRounds(labels) {
    return configModule.countReworkRounds(labels);
}

// No open PR and nothing merged for this issue yet: re-fire the dead
// letter of whichever machine leg last touched the issue.
function decideNoPrActions(has) {
    if (has('ai_developed')) {
        return [{ type: 'dispatch', leg: 'rework',
            reason: 'ai_developed but no open PR (dead dev run)' }];
    }
    if (has('agent:dev')) {
        return [{ type: 'dispatch', leg: 'dev',
            reason: 'agent:dev labeled, no PR yet (dead dev letter)' }];
    }
    if (has('agent:rework')) {
        return [{ type: 'dispatch', leg: 'rework',
            reason: 'stale agent:rework with no PR' }];
    }
    return [{ type: 'skip', reason: 'no PR and no machine leg to (re)fire' }];
}

// Merged PR closes the issue (Fixes #N safety net); any other non-open
// state is a plain skip.
function decideClosedPrActions(pr) {
    if (pr.state === 'MERGED') {
        return [{ type: 'closeIssue',
            reason: 'linked PR #' + pr.number + ' merged (Fixes #N safety net)' }];
    }
    return [{ type: 'skip', reason: 'linked PR #' + pr.number + ' is ' + pr.state }];
}

// CI red: escalate to a human once the rework-round cap is spent, else
// re-fire rework (a stale agent:rework here is a dead letter — re-fire it).
function decideRedPrActions(pr, has, reworkExhausted, rounds) {
    if (reworkExhausted) {
        return [{ type: 'label', label: 'needs-human',
            reason: 'CI red after ' + rounds + ' rework rounds — escalating' }];
    }
    return [{ type: 'dispatch', leg: 'rework',
        reason: 'CI red on PR #' + pr.number + (has('agent:rework')
            ? ' (stale agent:rework — dead letter re-fire)'
            : '') }];
}

// ── green + approved ─────────────────────────────────────────────────────
// BEHIND updates the branch; CLEAN (or mergeable=true) merges with
// merge-trigger parity and then triages leftover machine threads; BLOCKED
// is the unresolved-thread conversation gate (gh-828) resolved in-tick by
// the gh-1352 disposition loop; anything else waits for a human look.
function decideApprovedGreenActions(pr) {
    if (pr.mergeState === 'BEHIND') {
        return [{ type: 'updateBranch',
            reason: 'approved but behind main — updating branch' }];
    }
    if (pr.mergeState === 'CLEAN' || pr.mergeable === true) {
        return [{ type: 'merge',
            reason: 'approved + green + mergeable (merge-trigger parity)' },
        { type: 'dispositionLoop', allowPolish: false,
            reason: 'post-merge triage hygiene (gh-1352): resolve machine-owned threads with policy dispositions (no polish lap — merge parity owns a clean head)' }];
    }
    if (pr.mergeState === 'BLOCKED') {
        // gh-828 (live fa #1457–#1470, 2026-10-10): BLOCKED on an
        // approved green head is the unresolved-thread conversation
        // gate (gh-683 branch protection). gh-1352 generalizes the
        // in-tick resolution into the DISPOSITION LOOP: the bounded
        // polish lap dispatches when the census is polish-tier-only
        // (once per head, instability-budgeted), and every machine-owned
        // thread otherwise closes with a machine-parsed disposition tag
        // under the reviewPolicy — fixed / wontfix / duplicate / deferred
        // (mandatory-fix tiers defer INTO the review debt ledger, so a
        // deferral is never a silent drop). Human threads never resolve
        // here (AC3) — they keep BLOCKED and surface to humans. If
        // threads were not the blocker (e.g. a pending required check
        // also reads BLOCKED), the loop is a harmless no-op and the
        // next tick re-evaluates.
        return [{ type: 'dispositionLoop', allowPolish: true,
            reason: 'approved + BLOCKED — the disposition loop (gh-828/gh-1352): polish lap when the census is polish-only, else triage with dispositions' }];
    }
    return [{ type: 'skip',
        reason: 'approved but merge state ' + pr.mergeState }];
}

// Green PR without approval: route the review leg, re-fire a dead rework
// letter, or wait in the steady state.
function decideGreenUnapprovedActions(has, pr) {
    if (has('ai_developed') && !has('ai_pr_reviewed')) {
        return [{ type: 'dispatch', leg: 'review',
            reason: 'green PR #' + pr.number + ' awaits machine review' }];
    }
    if (has('ai_pr_reviewed') && !has('pr_approved')) {
        // Reviewed but the verdict never reached approve. The review leg
        // itself labels agent:rework for CHANGES_REQUESTED verdicts; if
        // that label is present with no active run it is another dead
        // letter — re-fire it. Otherwise wait (verdict processing pending).
        if (has('agent:rework')) {
            return [{ type: 'dispatch', leg: 'rework',
                reason: 'stale agent:rework after review (dead letter re-fire)' }];
        }
        return [{ type: 'skip',
            reason: 'reviewed, verdict not approve — awaiting rework labeling' }];
    }
    return [{ type: 'skip', reason: 'steady state' }];
}

// ── gh-1366: the failure-analyzer stages ──────────────────────────────────
// Evaluated between the engine-level human holds and the routing: a parked
// issue skips entirely (the label is the human latch), and a fresh
// deterministic-infra verdict is APPLIED (park action) before any
// re-dispatch can happen. Every stage fails safe to null — disabled config
// or an unavailable issue-comment read leaves the loop byte-identical.

function failureAnalysisEnabledOf(cfg) {
    return !!(cfg && cfg.failureAnalysis && cfg.failureAnalysis.enabled);
}

function failureAnalysisStateOf(state) {
    return (state && state.failureAnalysis && state.failureAnalysis.available)
        ? state.failureAnalysis
        : null;
}

/**
 * The pre-routing gate: parked-skip or the park application. Returns the
 * ONE action to return from decideActions, or null (feature off, state
 * unavailable, nothing parked, no deterministic verdict for the current
 * streak signature).
 */
function failureAnalysisGate(state, cfg) {
    if (!failureAnalysisEnabledOf(cfg)) return null;
    var faState = failureAnalysisStateOf(state);
    if (!faState) return null;
    var faCfg = cfg.failureAnalysis;
    var labels = issueLabelsOf(state);
    if (labels.indexOf(faCfg.blockedLabel) !== -1) {
        return { type: 'skip', reason: 'parked by the failure analyzer (deterministic infra) — ' +
            'remove ' + faCfg.blockedLabel + ' (or re-assign the issue) to resume dispatch' };
    }
    var verdict = failureAnalyzerModule.latestVerdictForSignature(faState.verdicts, faState.streakSignature);
    if (verdict && verdict.classification === 'deterministic-infra' &&
        !failureAnalyzerModule.coveringParkMarker(faState.parkMarkers, verdict)) {
        // The park applies ONCE per verdict EPISODE: the trusted park
        // markers carry the parked signature + analysis time, so a marker
        // covering THIS verdict means the machine already parked it. When
        // the marker exists and the label is gone, a HUMAN cleared the
        // park (the landed-fix gesture, AC4) — the stale verdict must not
        // re-park. A NEW episode (a different signature, or a fresher
        // verdict after a failed human fix) is never covered → parks with
        // its own diagnostic; a label-add that failed last tick has NO
        // marker at all → re-enters the gate (the label is retried).
        return { type: 'park', verdict: verdict,
            reason: 'deterministic-infra verdict' +
                failureAnalyzerModule.confidenceSuffix(verdict.confidence) + ' — parking: ' +
                String(verdict.suspected_root_cause || 'root cause not stated') };
    }
    return null;
}

/**
 * gh-1380: the index of the FIRST dispatch action, or -1. The gates that
 * divert, stamp, or absorb a retry all key on it.
 */
function firstDispatchIndex(actions) {
    for (var i = 0; i < actions.length; i++) {
        if (actions[i].type === 'dispatch') return i;
    }
    return -1;
}

/**
 * The blind-retry gate (gh-1366 AC1): a re-dispatch decision crossing the
 * afterFailures threshold is diverted to the analyzer leg ONCE — exactly
 * the crossing, so a crashed analyzer (no verdict → nothing consumed)
 * moves the streak past the threshold and blind retries continue (AC5).
 * Only dispatch actions divert; escalations (needs-human labels) ride on.
 *
 * gh-1380: the deterministic transient pre-classifier runs FIRST at the
 * crossing — pure logic, zero AI. A signature matching any configured
 * `transientPatterns` regex is classified BY THE SM ITSELF: the verdict
 * stamp lands (the audit trail + the consumption discount that resets the
 * effective counter, gh-1366 transient semantics) and the retry dispatch
 * rides through — or, with backoff > 1, waits out the window (the
 * classification tick IS backoff tick 1; see gateTransientBackoff).
 * Unrecognized signatures divert to the analyzer leg exactly as today —
 * unless analyzerEnabled is false (no AI anywhere: plain blind retry).
 */
function gateBlindRedispatch(actions, state, cfg) {
    if (!failureAnalysisEnabledOf(cfg)) return actions;
    var faState = failureAnalysisStateOf(state);
    if (!faState) return actions;
    var faCfg = cfg.failureAnalysis;
    var consumed = failureAnalyzerModule.consumedCount(faState.verdicts, faState.streakSignature);
    if (!failureAnalyzerModule.analysisDue(faState.streakCount, consumed, faCfg.afterFailures)) {
        return actions;
    }
    var firstDispatch = firstDispatchIndex(actions);
    if (firstDispatch === -1) return actions;
    var stamp = failureAnalyzerModule.transientPreClassifierVerdict(
        faState.streakSignature, faCfg.transientPatterns, faState.streakCount, faCfg.backoff);
    if (stamp) {
        var stampAction = {
            type: 'transientVerdict',
            verdict: stamp,
            reason: 'known-transient failure signature — pre-classified transient without AI' +
                (faState.streakSignature ? ' (signature: ' + faState.streakSignature + ')' : '')
        };
        if (faCfg.backoff > 1) {
            return actions.slice(0, firstDispatch).concat([stampAction]).concat(actions.slice(firstDispatch + 1));
        }
        return actions.slice(0, firstDispatch).concat([stampAction]).concat(actions.slice(firstDispatch));
    }
    if (faCfg.analyzerEnabled === false) return actions;
    var diverted = {
        type: 'dispatch',
        leg: failureAnalyzerModule.ANALYZE_LEG,
        reason: 'failure streak of ' + faCfg.afterFailures + ' identical failures — the analyzer leg ' +
            'classifies transient vs deterministic before more blind retries' +
            (faState.streakSignature ? ' (signature: ' + faState.streakSignature + ')' : '')
    };
    return actions.slice(0, firstDispatch).concat([diverted]).concat(actions.slice(firstDispatch + 1));
}

/**
 * gh-1380: the transient-backoff gate. While the latest same-signature
 * pre-classifier stamp carries an OPEN backoff window (ticks still to
 * absorb, no new failure since the stamp — the stamp consumed that streak
 * depth), dispatch actions are replaced by the tick re-stamp: the retry
 * interval is multiplied by failureAnalysis.backoff. Non-dispatch actions
 * (labels, merges, escalations) ride through untouched; the window can
 * only ever pace the retry, never stop the loop (a stamp-less or served
 * window leaves the actions verbatim).
 */
function gateTransientBackoff(actions, state, cfg) {
    if (!failureAnalysisEnabledOf(cfg)) return actions;
    var faState = failureAnalysisStateOf(state);
    if (!faState) return actions;
    var pending = failureAnalyzerModule.pendingTransientBackoff(
        faState.verdicts, faState.streakSignature, faState.streakCount);
    if (!pending) return actions;
    var firstDispatch = firstDispatchIndex(actions);
    if (firstDispatch === -1) return actions;
    var tickAction = {
        type: 'transientVerdict',
        verdict: failureAnalyzerModule.backoffTickVerdictRecord(pending),
        reason: 'transient backoff window open — absorbing tick ' + (pending.ticksSoFar + 1) +
            ' of ' + pending.backoffTicks + ' before the retry resumes' +
            (faState.streakSignature ? ' (signature: ' + faState.streakSignature + ')' : '')
    };
    return actions.slice(0, firstDispatch).concat([tickAction]).concat(actions.slice(firstDispatch + 1));
}

function decideActions(state, cfg) {
    var labels = issueLabelsOf(state);
    var has = function (l) { return labels.indexOf(l) !== -1; };
    var maxRounds = maxReworkRoundsOf(cfg);

    var skip = decideEngineSkip(has, state.activeRunForIssue);
    if (skip) return [skip];

    // gh-1366: the analyzer's park states — before any routing.
    var faGate = failureAnalysisGate(state, cfg);
    if (faGate) return [faGate];

    // Rework round cap — mirrors ai-teammate.yml MAX_AUTO_REWORK_ROUNDS:
    // escalate instead of looping rework forever.
    var rounds = countReworkRounds(labels);
    var reworkExhausted = rounds >= maxRounds;

    var pr = state.pr;
    if (!pr) return gateTransientBackoff(gateBlindRedispatch(decideNoPrActions(has), state, cfg), state, cfg);

    if (pr.state !== 'OPEN') return decideClosedPrActions(pr);

    if (pr.checkConclusion === 'pending') {
        return [{ type: 'skip', reason: 'PR #' + pr.number + ' checks pending' }];
    }

    if (pr.checkConclusion === 'red') {
        return gateTransientBackoff(gateBlindRedispatch(decideRedPrActions(pr, has, reworkExhausted, rounds), state, cfg), state, cfg);
    }

    // ── green below ──────────────────────────────────────────────────────────
    if (has('pr_approved')) return decideApprovedGreenActions(pr);
    return decideGreenUnapprovedActions(has, pr);
}

// ─────────────────────────────────────────────────────────────────────────────
// Forge I/O — delegated to the SCM-agnostic provider (common/smProvider.js);
// github and gitlab both speak the same contract.
// ─────────────────────────────────────────────────────────────────────────────
var smProviderModule = require('./common/smProvider.js');

// Parse "gh-<n>" out of a machine run display title (kept here: the pure
// core tests pin it).
function issueFromRunTitle(title) {
    var m = /gh-(\d+)/.exec(String(title || ''));
    return m ? parseInt(m[1], 10) : null;
}

// gh-1352 crap lap: the executor table replaces the 8-arm switch — each
// arm is its own function (declared above; function declarations hoist)
// and the dispatcher stays a two-branch lookup.
var ACTION_EXECUTORS = {
    dispatch: function (provider, action, issue, cfg) {
        return provider.dispatchLeg(issue.number, action.leg, action.reason, cfg.workflowFile);
    },
    label: function (provider, action, issue) {
        return provider.addIssueLabel(issue.number, action.label);
    },
    updateBranch: function (provider, action) {
        return provider.updateBranch(action.prNumber);
    },
    merge: function (provider, action) {
        return provider.merge(action.prNumber);
    },
    closeIssue: function (provider, action, issue, cfg) {
        return provider.closeIssue(issue.number, cfg.closeComment);
    },
    resolveSuggestionThreads: function (provider, action, issue, cfg) {
        return resolveSuggestionThreads(provider, action.prNumber, action.headSha, cfg);
    },
    dispositionLoop: function (provider, action, issue, cfg) {
        return dispositionLoop(provider, issue, action, cfg);
    },
    // gh-1366: apply a deterministic-infra verdict — the park label (the
    // latch that actually stops re-dispatch) + the ONE diagnostic comment.
    park: function (provider, action, issue, cfg) {
        return applyFailurePark(provider, issue, action, cfg);
    },
    // gh-1380: the SM's own pre-classifier verdict stamp — the machine
    // marker that classifies a known-transient streak without any AI call
    // (the audit trail + the consumption discount + the backoff tick
    // counter). Rides the same failure-verdict protocol as the analyzer.
    transientVerdict: function (provider, action, issue) {
        return provider.postIssueComment(issue.number,
            failureAnalyzerModule.buildFailureVerdictComment(action.verdict));
    }
};

// gh-1366 — the park executor. The gate fires only for an episode no
// trusted marker covers, so every fired park posts its own diagnostic.
// The LABEL lands FIRST: it is the latch that actually stops re-dispatch,
// so a failed write degrades to the SAFE half-applied state (parked, no
// diagnostic — the parked-skip tick log still names the park) instead of
// a diagnostic claiming "re-dispatch is STOPPED" while retries continue.
// A failed comment post leaves the verdict uncovered: when a human later
// clears the label, the gate re-fires and the park re-applies complete.
function applyFailurePark(provider, issue, action, cfg) {
    var faCfg = (cfg && cfg.failureAnalysis) || {};
    var label = faCfg.blockedLabel || failureAnalyzerModule.DEFAULT_BLOCKED_LABEL;
    provider.addIssueLabel(issue.number, label);
    return provider.postIssueComment(issue.number, failureAnalyzerModule.parkDiagnosticComment(
        action.verdict, label, commentMarkupModule.forFlavor('markdown')));
}

function executeAction(provider, action, issue, cfg) {
    var exec = ACTION_EXECUTORS[action.type];
    return exec ? exec(provider, action, issue, cfg) : null;
}

// gh-828 — the post-APPROVE in-tick thread-resolution leg (the missing
// owner from the withheld-arm branch, live fa #1457–#1470). Gate on the
// head's effective machine verdict record — parsed with the machine-author
// allowlist (gh-828 review round 2: the marker format is public, so a
// forged APPROVE from any comment-capable identity must stay invisible) —
// via the reviewVerdicts pure selector, then per selected thread RESOLVE
// FIRST and post the ack reply only on success (review round 3: a failed
// resolve must not leave an ack behind for the next tick to duplicate).
// Idempotent (already-resolved threads are filtered by selection) and
// bounded (maxResolveThreads per tick, default 20). Fail-closed
// everywhere: no head sha, no machine logins configured, missing provider
// primitives (gitlab), or a non-APPROVE / blocking census record → zero
// resolutions. A per-thread failure is logged and never aborts the rest.
//
// gh-1185 (CRAP): decomposed into the verbatim stages — the provider
// primitive gate, the cfg knobs, the verdict-thread selection and the
// resolve-first per-thread loop.
function supportsThreadResolution(provider) {
    return !!provider && typeof provider.verdictRecords === 'function' &&
        typeof provider.reviewThreadList === 'function' &&
        typeof provider.replyToThread === 'function' &&
        typeof provider.resolveThread === 'function';
}

function machineLoginsOf(cfg) {
    return (cfg && cfg.machineLogins) || [];
}

function resolveMaxThreadsKnob(cfg) {
    return (cfg && cfg.maxResolveThreads) || reviewVerdictsModule.DEFAULT_RESOLVE_THREADS_CAP;
}

function selectResolvableThreadsFor(provider, prNumber, headSha, logins, cfg) {
    var records = provider.verdictRecords(prNumber, { authorLogins: logins });
    var threads = provider.reviewThreadList(prNumber);
    return reviewVerdictsModule.selectResolvableThreads(records, headSha, threads, {
        machineLogins: logins,
        maxThreads: resolveMaxThreadsKnob(cfg)
    });
}

// gh-1352: the review debt ledger primitives on the provider — without
// them (gitlab twin, bare test mocks) deferral is unavailable and
// mandatory-fix tiers skip (needsFixOrDefer) instead of closing unfixed.
function ledgerAvailableOn(provider) {
    return typeof provider.prCommentList === 'function' &&
        typeof provider.postPrComment === 'function';
}

// Defer ONE machine-owned thread into the review debt ledger (gh-1352):
// append the finding keyed by the #1332 identity, post the ledger marker +
// the async digest in ONE comment, and return the stamped finding id —
// the `deferred: <id>` tag value. The ledger core dedups (the same
// observation re-raised refreshes occurrences) and reopens swept findings,
// so a deferral that re-appears never duplicates.
function deferThreadToLedger(provider, prNumber, thread, tierKey, logins) {
    var comments = provider.prCommentList(prNumber);
    var opts = { authorLogins: logins };
    var l = reviewDebtLedgerModule.latestDebtLedger(comments, opts) ||
        reviewDebtLedgerModule.emptyLedger();
    l = reviewDebtLedgerModule.appendDebtFinding(l, {
        threadId: thread.threadId,
        path: thread.path || '',
        claim: thread.body || '',
        severityClass: tierKey,
        originPr: prNumber,
        threadUrl: thread.threadUrl || null
    });
    provider.postPrComment(prNumber,
        reviewDebtLedgerModule.buildDebtMarker(l) + '\n' +
        reviewDebtLedgerModule.buildDebtDigest(l));
    var stamped = null;
    l.findings.forEach(function (f) {
        if (f && (f.originThread === thread.threadId)) stamped = f.id;
    });
    return stamped;
}

/**
 * gh-1352 — the triage executor (the gh-828 resolution leg generalized):
 * each selected machine-owned thread closes under the resolved reviewPolicy
 * with a machine-parsed disposition tag —
 *
 *   fixed: <ref>      a lap addressed it (opts.fixedThreadIds);
 *   wontfix: <reason> the tier's fix is never/opportunistic (nits by
 *                     default policy);
 *   deferred: <id>    the tier's fix is mandatory and the debt ledger is
 *                     reachable — the finding lives in the review-side
 *                     ledger (the batched sweep PR owns it);
 *   (skip)            fix mandatory and NO deferral available → the thread
 *                     stays open, counted as needsFixOrDefer (the new
 *                     severity-aware skip beside threadSkipReason).
 *
 * Resolve FIRST, ack only on success (gh-828 review round 3); the ledger
 * append lands BEFORE the resolve so a failed deferral never closes a
 * mandatory-fix thread. Returns the per-tag counters.
 */
// The triage gate (gh-828 + gh-1352): provider primitives, head + logins,
// the verdict gate and the thread selection — { ok, sel } with the skip
// already logged. Fail closed: any miss leaves nothing to resolve.
function triageGate(provider, prNumber, headSha, logins, cfg) {
    if (!supportsThreadResolution(provider)) {
        console.warn('  ⚠️ resolveSuggestionThreads: provider lacks the verdict/thread primitives — skipped (gitlab twin has none yet)');
        return { ok: false };
    }
    if (!headSha || !logins.length) {
        console.log('  ⏭️  resolveSuggestionThreads on PR #' + prNumber +
            ': no head sha or no machine logins configured — nothing resolves (fail closed)');
        return { ok: false };
    }
    var sel = selectResolvableThreadsFor(provider, prNumber, headSha, logins, cfg);
    if (sel.gate !== 'approve') {
        console.log('  ⏭️  resolveSuggestionThreads on PR #' + prNumber +
            ': verdict gate "' + sel.gate + '" — nothing resolves (fail closed)');
        return { ok: false };
    }
    if (!sel.resolvable.length) {
        console.log('  ⏭️  resolveSuggestionThreads on PR #' + prNumber +
            ': no eligible threads (human ' + sel.skipped.human + ', blocking ' + sel.skipped.blocking +
            ', already resolved ' + sel.skipped.resolved + ', no id ' + sel.skipped.noThreadId + ')');
        return { ok: false };
    }
    return { ok: true, sel: sel };
}

// The defer half of one thread's disposition (gh-1352): mandatory-fix
// tiers defer INTO the review debt ledger; a failed or unstamped append
// leaves the thread open (fail closed — never close unfixed work).
// Returns true when the caller may resolve the thread.
function deferOrCount(provider, prNumber, t, disp, logins, out) {
    if (!disp.defer) return true;
    try {
        disp.value = deferThreadToLedger(provider, prNumber, t, disp.tier, logins);
    } catch (eLedger) {
        console.warn('  ⚠️ debt-ledger append failed on PR #' + prNumber + ': ' +
            (eLedger.message || eLedger) + ' — the thread stays open (fail closed)');
        out.needsFixOrDefer++;
        return false;
    }
    // Defense in depth: a stamped append always names its thread; an
    // unstamped one closes nothing (the id scan came up empty).
    if (!disp.value) {
        console.warn('  ⚠️ debt-ledger append did not stamp a finding id on PR #' + prNumber +
            ' — the thread stays open (fail closed)');
        out.needsFixOrDefer++;
        return false;
    }
    return true;
}

// One selected thread: disposition, defer-or-count, resolve FIRST, ack
// only on success (gh-828 review round 3). A per-thread failure is logged
// and never aborts the rest.
function resolveSelectedThread(provider, prNumber, t, policy, ledgerOk, logins, out) {
    var disp = reviewDispositionsModule.dispositionForThread(t, policy, { allowDefer: ledgerOk });
    if (!disp) {
        // fix mandatory with no deferral available — the thread stays
        // open (the fix-or-defer gate; never close unfixed work).
        out.needsFixOrDefer++;
        return;
    }
    if (!deferOrCount(provider, prNumber, t, disp, logins, out)) return;
    var ack = reviewDispositionsModule.buildThreadAckReply(
        { tag: disp.tag, value: disp.value, tier: disp.tier });
    try {
        provider.resolveThread(prNumber, t);
        out.resolved++;
        out[disp.tag] = (out[disp.tag] || 0) + 1;
    } catch (eResolve) {
        console.warn('  ⚠️ resolveThread failed on PR #' + prNumber + ': ' + (eResolve.message || eResolve));
        return;
    }
    try {
        provider.replyToThread(prNumber, t, ack);
    } catch (eReply) {
        console.warn('  ⚠️ ack reply failed on a resolved thread of PR #' + prNumber + ': ' + (eReply.message || eReply));
    }
}

// The per-tag triage counters (one shape, two consumers — the no-thread
// early return and the live tally; `duplicate` rides the audit log too).
function triageCounters() {
    return { resolved: 0, fixed: 0, wontfix: 0, duplicate: 0, deferred: 0, needsFixOrDefer: 0 };
}

function resolveSuggestionThreads(provider, prNumber, headSha, cfg) {
    var logins = machineLoginsOf(cfg);
    var gate = triageGate(provider, prNumber, headSha, logins, cfg);
    if (!gate.ok) return triageCounters();
    var policy = (cfg && cfg.reviewPolicy) || reviewPolicyModule.defaultPolicy();
    var ledgerOk = ledgerAvailableOn(provider);
    var out = triageCounters();
    gate.sel.resolvable.forEach(function (t) {
        resolveSelectedThread(provider, prNumber, t, policy, ledgerOk, logins, out);
    });
    console.log('  ✅ resolveSuggestionThreads on PR #' + prNumber + ': resolved ' + out.resolved +
        '/' + gate.sel.resolvable.length + ' machine thread(s) — fixed ' + out.fixed + ', wontfix ' +
        out.wontfix + ', duplicate ' + out.duplicate + ', deferred ' + out.deferred +
        ', needs-fix-or-defer ' + out.needsFixOrDefer);
    return out;
}

// Counts of a plan field for the audit logs (null-safe).
function lapCountOf(plan, key) {
    return ((plan && plan[key]) || []).length;
}

// The polish-lap attempt for one disposition-loop tick: gate → decision →
// marker-first dispatch. Returns { polished: true, plan } when the lap
// dispatched; null when the threads fall open to triage (gate miss,
// trigger miss, unstampable marker — all logged; the loop is never
// wedged by one leg's read).
function tryPolishLap(provider, issue, issueNo, prNumber, headSha, cfg) {
    try {
        var d = polishGateDecision(provider, prNumber, headSha, cfg);
        if (d && d.dispatch) {
            console.log('  🔬 gh-' + issueNo + ' polish lap dispatched on PR #' + prNumber +
                ' (' + d.reason + ', top-K ' + lapCountOf(d.plan, 'lapThreads') +
                ', overflow ' + lapCountOf(d.plan, 'overflowThreads') + ')');
            if (!dispatchPolishLap(provider, issueNo, prNumber, headSha, d.plan, cfg)) {
                console.warn('  ⚠️ polish-lap marker could not be stamped on PR #' + prNumber +
                    ' — the lap stays home (fail closed: an unstamped lap cannot honour ' +
                    'once-per-head) — the threads triage below');
                return resolveSuggestionThreads(provider, prNumber, headSha, cfg);
            }
            return { polished: true, plan: d.plan };
        }
        if (d && d.trigger) {
            console.log('  ⏭️  gh-' + issueNo + ' polish lap not dispatched (' + d.reason +
                ') — the threads triage below');
        }
    } catch (ePolish) {
        console.warn('  ⚠️ polish gate failed on PR #' + prNumber + ': ' +
            (ePolish.message || ePolish) + ' — falling open to triage');
    }
    return null;
}

/**
 * gh-1352 — the disposition loop executor (the BLOCKED branch's action,
 * and the post-merge hygiene pass): dispatch the bounded polish lap when
 * the approved head's census is polish-tier-only (once per head,
 * instability-budgeted — the lap owns its threads), otherwise hand every
 * selected thread to the triage executor with dispositions. The polish
 * gate failing (records/primitives) falls OPEN to triage.
 */
function dispositionLoop(provider, issue, action, cfg) {
    var prNumber = action.prNumber;
    var headSha = action.headSha;
    // executeAction passes the full issue object; tests and callers may
    // pass the bare number — normalize once (the provider primitive takes
    // the number).
    var issueNo = issue && issue.number !== undefined ? issue.number : issue;
    if (action.allowPolish !== false) {
        var polished = tryPolishLap(provider, issue, issueNo, prNumber, headSha, cfg);
        if (polished) return polished;
    }
    return resolveSuggestionThreads(provider, prNumber, headSha, cfg);
}

// The thread ids a lap was planned to address (the marker's `fixed:`
// evidence for the triage path).
function lapThreadIdsOf(plan) {
    return ((plan && plan.lapThreads) || [])
        .map(function (t) { return t && t.threadId; })
        .filter(function (id) { return !!id; });
}

// Stamps the per-head lap marker on the PR — the once-per-head +
// instability-budget memory lives on the PR, so the stamp lands BEFORE
// the leg dispatch. Returns false when the marker is unbuildable (no
// head) or the post fails — the caller never dispatches unstamped.
function stampPolishLapMarker(provider, prNumber, marker) {
    if (!marker) return false;
    try {
        provider.postPrComment(prNumber, marker);
    } catch (eStamp) {
        console.warn('  ⚠️ polish-lap marker post failed on PR #' + prNumber + ': ' +
            (eStamp.message || eStamp));
        return false;
    }
    return true;
}

// gh-1352 — dispatch the bounded polish lap, marker-first.
function dispatchPolishLap(provider, issueNumber, prNumber, headSha, plan, cfg) {
    var lapIds = lapThreadIdsOf(plan);
    var marker = polishLapModule.buildPolishLapMarker(headSha, {
        threads: lapCountOf(plan, 'lapThreads'),
        overflow: lapCountOf(plan, 'overflowThreads'),
        resolvedThreadIds: lapIds
    });
    if (!stampPolishLapMarker(provider, prNumber, marker)) return false;
    provider.dispatchLeg(issueNumber, 'polish',
        'gh-1352 bounded polish lap (top-K ' + lapIds.length + ', overflow ' +
        lapCountOf(plan, 'overflowThreads') + ')', cfg.workflowFile);
    return true;
}

// The polish-lap gate's primitive check — the dispatch must be able to
// READ the verdict/threads/laps and STAMP its per-head marker
// (postPrComment included); a provider missing any of them degrades to
// triage (fail-safe, never wedged).
function polishGatePrimitivesReady(provider, logins, headSha) {
    return !!headSha && logins.length > 0 &&
        typeof provider.prCommentList === 'function' &&
        typeof provider.postPrComment === 'function' &&
        typeof provider.verdictRecords === 'function' &&
        typeof provider.reviewThreadList === 'function';
}

// The polish-lap gate (gh-1352 scope 3): the effective APPROVE record for
// the head, the parsed lap markers (machine-authored only) and the open
// thread list feed the pure polishDecision. Returns null when the gate
// cannot run (no head/logins, missing comment primitives) — never throws.
function polishGateDecision(provider, prNumber, headSha, cfg) {
    var logins = machineLoginsOf(cfg);
    if (!polishGatePrimitivesReady(provider, logins, headSha)) {
        return null;
    }
    var records = provider.verdictRecords(prNumber, { authorLogins: logins });
    var effective = reviewVerdictsModule.latestVerdictForHead(records, headSha);
    if (!effective) return null;
    var policy = (cfg && cfg.reviewPolicy) || reviewPolicyModule.defaultPolicy();
    // The cross-head bounds consume the MERGED lap history: polish-lap
    // markers + rework-lap markers (the non-polish dispatch evidence),
    // one time-sorted stream — the budget counts CONSECUTIVE polish laps
    // and resets when a rework lap sits between them (gh-1352 review).
    var comments = provider.prCommentList(prNumber);
    var laps = polishLapModule.mergedLapHistory(
        polishLapModule.parsePolishLapMarkers(comments, { authorLogins: logins }),
        reworkLoopGuardModule.parseLapMarkers(comments, { authorLogins: logins }));
    return polishLapModule.polishDecision(effective.record, policy,
        provider.reviewThreadList(prNumber), headSha, laps);
}

// ─────────────────────────────────────────────────────────────────────────────
// gh-980: config/state resolution helpers extracted from action() — the
// sm-style override-before-jobParams priority, verbatim semantics.
// ─────────────────────────────────────────────────────────────────────────────

// Knob with an explicit-undefined override check: the project override wins
// even over an explicit falsy jobParams value (e.g. dryRun:false).
function pickKnob(overrideVal, pVal, dflt) {
    return overrideVal !== undefined ? overrideVal : (pVal || dflt);
}

function resolveMaxResolveThreads(override, p, dflt) {
    if (typeof override.maxResolveThreads === 'number' && override.maxResolveThreads > 0) {
        return Math.floor(override.maxResolveThreads);
    }
    if (typeof p.maxResolveThreads === 'number' && p.maxResolveThreads > 0) {
        return Math.floor(p.maxResolveThreads);
    }
    return dflt;
}

// gh-828: the post-APPROVE thread-resolution leg resolves ONLY threads
// authored by the machine identities (the gh-728 comma-separated list
// knob, same resolution chain as every other machine-keyed guard).
// Unconfigured → empty list → the leg fails closed and resolves
// nothing (human threads would otherwise be closed by the machine).
// First truthy value among three candidates — the sm-style string-knob
// defaulting pattern (override || jobParams || built-in default).
function firstDefined(a, b, c) {
    return a || b || c;
}

function resolveMachineSmConfig(p, projectConfig) {
    var override = (projectConfig && projectConfig.machineSm) || {};
    var cfg = {
        dryRun:            pickKnob(override.dryRun, p.dryRun, false),
        maxConcurrentRuns: pickKnob(override.maxConcurrentRuns, p.maxConcurrentRuns, 1),
        maxReworkRounds:   pickKnob(override.maxReworkRounds, p.maxReworkRounds, 2),
        workflowFile:      firstDefined(override.workflowFile, p.workflowFile, 'ai-teammate.yml'),
        branchPrefix:      firstDefined(override.branchPrefix, p.branchPrefix, 'ai/gh-'),
        agentHandle:       firstDefined(override.agentHandle, p.agentHandle, 'ai-teammate'),
        issueLimit:        firstDefined(override.issueLimit, p.issueLimit, 50),
        closeComment:      firstDefined(override.closeComment, p.closeComment, 'Machine SM: linked PR merged — closing the loop.')
    };
    cfg.machineLogins = machineAuthorModule.machineAuthorLogins(
        machineAuthorModule.resolveMachineAuthor(p, projectConfig));
    // gh-828 review round 4: same override-before-p priority as every other
    // machineSm knob — a project-config cap silently ignored would leave an
    // operator tuning the wrong bound.
    cfg.maxResolveThreads = resolveMaxResolveThreads(override, p,
        reviewVerdictsModule.DEFAULT_RESOLVE_THREADS_CAP);
    // gh-1366: the failure-analyzer knobs ride the same override chain —
    // `machineSm.failureAnalysis` (project) over `jobParams.failureAnalysis`
    // (job), knob by knob like every other machineSm knob. Missing
    // everywhere → disabled silently; a malformed block THROWS here (hard
    // validation error at SM start — the house rule).
    var faBlock = (override.failureAnalysis || p.failureAnalysis)
        ? mergeObjectsModule.mergeObjects(p.failureAnalysis, override.failureAnalysis)
        : undefined;
    cfg.failureAnalysis = failureAnalyzerModule.resolveFailureAnalysisConfig(faBlock);
    // gh-1352: the disposition loop closes threads under the resolved
    // reviewPolicy (projectConfig.reviewPolicy > jobParams.reviewPolicy >
    // the built-in default) — the same resolution chain the review leg's
    // verdict layer uses (gh-1351), so triage and review never disagree
    // about what a tier requires.
    cfg.reviewPolicy = reviewPolicyModule.resolveReviewPolicy(projectConfig, p);
    return cfg;
}

function resolveRepoCfg(projectConfig, p) {
    var projectRepo = projectConfig && projectConfig.repository;
    if (projectRepo && projectRepo.owner && projectRepo.repo) return projectRepo;
    if (p.repository) return p.repository;
    if (p.repo) return { owner: String(p.repo).split('/')[0], repo: String(p.repo).split('/')[1] };
    return null;
}

function loadMachineSmProjectConfig(p) {
    try {
        return configLoader.loadProjectConfig({ configPath: p.configPath }) || {};
    } catch (e) {
        return {};
    }
}

// Forge selection: scm.provider (github | gitlab) — scm.js contract.
function resolveScmCfg(projectConfig, p) {
    return (projectConfig.scm && projectConfig.scm.provider)
        ? projectConfig.scm
        : (p.scm || { provider: 'github' });
}

// Provider creation is fail-closed: the error string lands in the result.
function createSmProviderOrError(scmCfg, repoCfg) {
    try {
        return { provider: smProviderModule.createSmProvider({ scm: scmCfg, repository: repoCfg }) };
    } catch (e) {
        return { error: String(e.message || e) };
    }
}

// gh-952 (live fa 2026-10-17): a run whose linked PR is MERGED is
// archaeology, not a slot event — it can never be consumed by the loop.
// Probe result kinds: 'unknown' (issue indeterminate — never dropped),
// 'merged' (release the slot), 'live', 'error' (fail closed — keep).
function probeOrphanRun(provider, n, branchPrefix) {
    if (n === 'unknown') return { kind: 'unknown' };
    try {
        var ref = provider.findPr(n, branchPrefix);
        if (ref && ref.state === 'MERGED') return { kind: 'merged', prNumber: ref.number };
        return { kind: 'live' };
    } catch (eOrphan) {
        return { kind: 'error' };
    }
}

function filterLiveActiveIssues(provider, activeIssues, branchPrefix) {
    return activeIssues.filter(function (n) {
        var probe = probeOrphanRun(provider, n, branchPrefix);
        if (probe.kind === 'merged') {
            console.log('  🔓 gh-' + n + ': the active run\'s linked PR #' + probe.prNumber +
                ' is MERGED (owner bypass) — it can never be consumed; releasing the slot (gh-952)');
            return false;
        }
        if (probe.kind === 'error') {
            console.warn('  ⚠️  gh-' + n + ': orphan-slot probe failed — keeping the run in the count (fail closed)');
        }
        return true;
    });
}

// gh-1366: the machine-issue query labels — the park label joins the query
// only while the analyzer is enabled (parked issues stay listed so the
// parked-skip reason stays observable in the tick log).
function machineQueryLabelsOf(cfg) {
    var machineLabels = ['agent:dev', 'agent:rework', 'agent:review',
        'ai_developed', 'ai_pr_reviewed', 'pr_approved', 'needs-human'];
    if (failureAnalysisEnabledOf(cfg)) {
        machineLabels.push(cfg.failureAnalysis.blockedLabel);
    }
    return machineLabels;
}

// gh-1366: the pure derivation of one issue's failure-analysis state from
// its comment history (the gh-1363 machine-readable signature lines + the
// analyzer verdict markers + the trusted park markers).
function failureAnalysisStateFrom(comments, machineLogins) {
    var bodies = comments.map(function (c) {
        return c && (c.body !== undefined ? c.body : c);
    });
    var streak = failureAnalyzerModule.failureStreak(bodies);
    var authorOpts = { authorLogins: machineLogins || [] };
    return {
        available: true,
        streakSignature: streak ? streak.signature : null,
        streakCount: streak ? streak.count : 0,
        verdicts: failureAnalyzerModule.parseFailureVerdicts(comments, authorOpts),
        parkMarkers: failureAnalyzerModule.parkMarkersFrom(comments, authorOpts)
    };
}

// gh-1366: one issue's failure-analysis state. A provider without the
// issue-comment primitive (the gitlab twin, bare test mocks) → null: every
// gate fails safe to today's behavior. A READ failure is equally fail-safe
// — the loop is never wedged by one leg's input.
function collectFailureAnalysisState(provider, issueNumber, machineLogins) {
    if (typeof provider.issueComments !== 'function') return null;
    try {
        return failureAnalysisStateFrom(provider.issueComments(issueNumber) || [], machineLogins);
    } catch (eFa) {
        console.warn('  ⚠️ gh-' + issueNumber + ' failure-analysis read failed (fail-safe, blind retry): ' +
            (eFa.message || eFa));
        return null;
    }
}

// One issue through the reconcile loop: probe the linked PR, run the pure
// decision core, execute (or plan, in dryRun) every action. Returns the
// per-issue counters action() aggregates.
function buildIssueState(provider, issue, branchPrefix, activeSet) {
    var prRef = provider.findPr(issue.number, branchPrefix);
    var pr = prRef && prRef.state === 'OPEN' ? provider.prStatus(prRef.number) : prRef;
    return {
        prRef: prRef,
        pr: pr,
        state: {
            issue: issue,
            pr: pr,
            activeRunForIssue: !!activeSet[issue.number] || !!activeSet['unknown']
        }
    };
}

function planActionFields(a, prRef, pr) {
    a.prNumber = prRef ? prRef.number : null;
    a.headSha = (pr && pr.headSha) || null;
}

function logAction(issue, a, cfg) {
    console.log('  ' + (cfg.dryRun ? '[dry] ' : '') + '▶️  gh-' + issue.number + ' ' +
        a.type + (a.leg ? ':' + a.leg : '') + ' — ' + a.reason);
}

// Executes one non-skip action unless dryRun; returns 'planned' | 'acted' | 'failed'.
function applyIssueAction(provider, issue, cfg, a) {
    if (cfg.dryRun) return 'planned';
    try {
        executeAction(provider, a, issue, cfg);
        return 'acted';
    } catch (e) {
        console.error('  ❌ gh-' + issue.number + ' ' + a.type + ' failed: ' + (e.message || e));
        return 'failed';
    }
}

function reconcileIssue(provider, issue, cfg, activeSet) {
    var counters = { acted: 0, dispatched: 0, skipped: 0, failures: 0 };
    var built = buildIssueState(provider, issue, cfg.branchPrefix, activeSet);
    // gh-1366: the analyzer state rides ONLY while the feature is enabled
    // — the disabled loop stays byte-identical today INCLUDING I/O: no
    // issue-comment read per issue per tick for gates that can never fire
    // (both gates bail on failureAnalysisEnabledOf first).
    built.state.failureAnalysis = failureAnalysisEnabledOf(cfg)
        ? collectFailureAnalysisState(provider, issue.number, cfg.machineLogins)
        : null;
    var acts = decideActions(built.state, cfg);
    for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        if (a.type === 'skip') {
            counters.skipped++;
            console.log('  ⏭️  gh-' + issue.number + ': ' + a.reason);
            continue;
        }
        planActionFields(a, built.prRef, built.pr);
        logAction(issue, a, cfg);
        var outcome = applyIssueAction(provider, issue, cfg, a);
        if (outcome === 'failed') { counters.failures++; continue; }
        counters.acted++;
        if (a.type === 'dispatch') counters.dispatched++;
    }
    return counters;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSRunner entry point
// ─────────────────────────────────────────────────────────────────────────────
function action(params) {
    var p = params.jobParams || params;
    var projectConfig = loadMachineSmProjectConfig(p);

    var cfg = resolveMachineSmConfig(p, projectConfig);
    var repoCfg = resolveRepoCfg(projectConfig, p);

    if (!repoCfg || !repoCfg.owner || !repoCfg.repo) {
        console.error('❌ machineSm: repository required (.dmtools/config.js repository or jobParams.repo owner/repo)');
        return { success: false, error: 'Missing repo' };
    }

    var providerResult = createSmProviderOrError(resolveScmCfg(projectConfig, p), repoCfg);
    if (providerResult.error !== undefined) {
        console.error('❌ machineSm: ' + providerResult.error);
        return { success: false, error: providerResult.error };
    }
    var provider = providerResult.provider;

    console.log('Machine SM — ' + repoCfg.owner + '/' + repoCfg.repo + ' [' + provider.provider + ']' +
        (cfg.dryRun ? ' [DRY RUN]' : '') + ' (cap ' + cfg.maxConcurrentRuns + ', rounds ' + cfg.maxReworkRounds + ')');

    // 1. Global concurrency gate — the user contract: with parallel runs
    //    in flight, wait them out; the cron tick re-fires soon.
    var activeIssues = provider.activeMachineRuns(cfg.workflowFile);
    var liveActiveIssues = filterLiveActiveIssues(provider, activeIssues, cfg.branchPrefix);
    if (liveActiveIssues.length >= cfg.maxConcurrentRuns) {
        console.log('  ⏳ idle — active machine run(s) for ' +
            (liveActiveIssues.join(', ') === 'unknown' ? 'this project' : 'issue(s) ' + liveActiveIssues.join(', ')) +
            '; waiting for the next tick');
        return { success: true, idle: true, waitingFor: liveActiveIssues };
    }

    // 2. Reconcile every machine-managed issue through the provider.
    var machineLabels = machineQueryLabelsOf(cfg);
    var issues = provider.listMachineIssues(machineLabels, cfg.agentHandle, cfg.issueLimit);

    var dispatched = 0, acted = 0, skipped = 0, failures = 0;
    var activeSet = {};
    liveActiveIssues.forEach(function (n) { activeSet[n] = true; });

    issues.forEach(function (issue) {
        var counters = reconcileIssue(provider, issue, cfg, activeSet);
        acted += counters.acted;
        dispatched += counters.dispatched;
        skipped += counters.skipped;
        failures += counters.failures;
    });

    console.log('\n══ Machine SM complete — acted: ' + acted + ' (dispatched ' + dispatched +
        '), skipped: ' + skipped + ', failures: ' + failures + ' ══');
    return { success: failures === 0, acted: acted, dispatched: dispatched, skipped: skipped, failures: failures };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        decideActions: decideActions,
        issueFromRunTitle: issueFromRunTitle,
        // gh-1242: exported for unit tests (every switch arm incl. the
        // gh-828 thread-resolution leg).
        resolveSuggestionThreads: resolveSuggestionThreads,
        // gh-1352: the disposition loop (polish gate + triage executor).
        dispositionLoop: dispositionLoop,
        polishGateDecision: polishGateDecision,
        executeAction: executeAction,
        resolveMachineSmConfig: resolveMachineSmConfig,
        resolveRepoCfg: resolveRepoCfg,
        probeOrphanRun: probeOrphanRun,
        filterLiveActiveIssues: filterLiveActiveIssues,
        // gh-1366: the failure-analyzer stages (the scripted replay suite
        // covers them through action(); the pure gates are exported for
        // surgical unit tests).
        failureAnalysisGate: failureAnalysisGate,
        gateBlindRedispatch: gateBlindRedispatch,
        // gh-1380: the transient-backoff gate (surgical unit tests).
        gateTransientBackoff: gateTransientBackoff,
        applyFailurePark: applyFailurePark
    };
}
