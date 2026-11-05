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
 *
 * Decision core (decideActions) is pure and unit-tested; all GitHub I/O
 * goes through `gh` via cli_execute_command and is injectable/mocks-able
 * through jobParams.ghRunner for tests.
 */
'use strict';

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

// Highest rework-round label, 0 when none — mirrors ai-teammate.yml
// MAX_AUTO_REWORK_ROUNDS bookkeeping.
function countReworkRounds(labels) {
    var rounds = 0;
    labels.forEach(function (l) {
        var m = /^rework-round-(\d+)$/.exec(l);
        if (m) rounds = Math.max(rounds, parseInt(m[1], 10));
    });
    return rounds;
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
        // under the reviewPolicy — fixed / wontfix / duplicate / defered
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

function decideActions(state, cfg) {
    var labels = issueLabelsOf(state);
    var has = function (l) { return labels.indexOf(l) !== -1; };
    var maxRounds = maxReworkRoundsOf(cfg);

    var skip = decideEngineSkip(has, state.activeRunForIssue);
    if (skip) return [skip];

    // Rework round cap — mirrors ai-teammate.yml MAX_AUTO_REWORK_ROUNDS:
    // escalate instead of looping rework forever.
    var rounds = countReworkRounds(labels);
    var reworkExhausted = rounds >= maxRounds;

    var pr = state.pr;
    if (!pr) return decideNoPrActions(has);

    if (pr.state !== 'OPEN') return decideClosedPrActions(pr);

    if (pr.checkConclusion === 'pending') {
        return [{ type: 'skip', reason: 'PR #' + pr.number + ' checks pending' }];
    }

    if (pr.checkConclusion === 'red') {
        return decideRedPrActions(pr, has, reworkExhausted, rounds);
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

function executeAction(provider, action, issue, cfg) {
    switch (action.type) {
        case 'dispatch':
            return provider.dispatchLeg(issue.number, action.leg, action.reason, cfg.workflowFile);
        case 'label':
            return provider.addIssueLabel(issue.number, action.label);
        case 'updateBranch':
            return provider.updateBranch(action.prNumber);
        case 'merge':
            return provider.merge(action.prNumber);
        case 'closeIssue':
            return provider.closeIssue(issue.number, cfg.closeComment);
        case 'resolveSuggestionThreads':
            return resolveSuggestionThreads(provider, action.prNumber, action.headSha, cfg);
        case 'dispositionLoop':
            return dispositionLoop(provider, issue, action, cfg);
        default:
            return null;
    }
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
// the `defered: <id>` tag value. The ledger core dedups (the same
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
 *   defered: <id>     the tier's fix is mandatory and the debt ledger is
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
function resolveSuggestionThreads(provider, prNumber, headSha, cfg) {
    var none = { resolved: 0, fixed: 0, wontfix: 0, duplicate: 0, defered: 0, needsFixOrDefer: 0 };
    if (!supportsThreadResolution(provider)) {
        console.warn('  ⚠️ resolveSuggestionThreads: provider lacks the verdict/thread primitives — skipped (gitlab twin has none yet)');
        return none;
    }
    var logins = machineLoginsOf(cfg);
    if (!headSha || !logins.length) {
        console.log('  ⏭️  resolveSuggestionThreads on PR #' + prNumber +
            ': no head sha or no machine logins configured — nothing resolves (fail closed)');
        return none;
    }
    var sel = selectResolvableThreadsFor(provider, prNumber, headSha, logins, cfg);
    if (sel.gate !== 'approve') {
        console.log('  ⏭️  resolveSuggestionThreads on PR #' + prNumber +
            ': verdict gate "' + sel.gate + '" — nothing resolves (fail closed)');
        return none;
    }
    if (!sel.resolvable.length) {
        console.log('  ⏭️  resolveSuggestionThreads on PR #' + prNumber +
            ': no eligible threads (human ' + sel.skipped.human + ', blocking ' + sel.skipped.blocking +
            ', already resolved ' + sel.skipped.resolved + ', no id ' + sel.skipped.noThreadId + ')');
        return none;
    }
    var policy = (cfg && cfg.reviewPolicy) || reviewPolicyModule.defaultPolicy();
    var ledgerOk = ledgerAvailableOn(provider);
    var out = { resolved: 0, fixed: 0, wontfix: 0, duplicate: 0, defered: 0, needsFixOrDefer: 0 };
    sel.resolvable.forEach(function (t) {
        var disp = reviewDispositionsModule.dispositionForThread(t, policy, { allowDefer: ledgerOk });
        if (!disp) {
            // fix mandatory with no deferral available — the thread stays
            // open (the fix-or-defer gate; never close unfixed work).
            out.needsFixOrDefer++;
            return;
        }
        if (disp.defer) {
            try {
                disp.value = deferThreadToLedger(provider, prNumber, t, disp.tier, logins);
            } catch (eLedger) {
                console.warn('  ⚠️ debt-ledger append failed on PR #' + prNumber + ': ' +
                    (eLedger.message || eLedger) + ' — the thread stays open (fail closed)');
                out.needsFixOrDefer++;
                return;
            }
            if (!disp.value) {
                console.warn('  ⚠️ debt-ledger append did not stamp a finding id on PR #' + prNumber +
                    ' — the thread stays open (fail closed)');
                out.needsFixOrDefer++;
                return;
            }
        }
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
    });
    console.log('  ✅ resolveSuggestionThreads on PR #' + prNumber + ': resolved ' + out.resolved +
        '/' + sel.resolvable.length + ' machine thread(s) — fixed ' + out.fixed + ', wontfix ' +
        out.wontfix + ', defered ' + out.defered + ', needs-fix-or-defer ' + out.needsFixOrDefer);
    return out;
}

/**
 * gh-1352 — the disposition loop executor (the BLOCKED branch's action,
 * and the post-merge hygiene pass): dispatch the bounded polish lap when
 * the approved head's census is polish-tier-only (once per head,
 * instability-budgeted — the lap owns its threads), otherwise hand every
 * selected thread to the triage executor with dispositions. The polish
 * gate failing (records/primitives) falls OPEN to triage — the loop is
 * never wedged by one leg's read.
 */
function dispositionLoop(provider, issue, action, cfg) {
    var prNumber = action.prNumber;
    var headSha = action.headSha;
    // executeAction passes the full issue object; tests and callers may
    // pass the bare number — normalize once (the provider primitive takes
    // the number).
    var issueNo = issue && issue.number !== undefined ? issue.number : issue;
    if (action.allowPolish !== false) {
        try {
            var d = polishGateDecision(provider, prNumber, headSha, cfg);
            if (d && d.dispatch) {
                console.log('  🔬 gh-' + issueNo + ' polish lap dispatched on PR #' + prNumber +
                    ' (' + d.reason + ', top-K ' + (d.plan ? d.plan.lapThreads.length : 0) +
                    ', overflow ' + (d.plan ? d.plan.overflowThreads.length : 0) + ')');
                if (!dispatchPolishLap(provider, issueNo, prNumber, headSha, d.plan, cfg)) {
                    console.warn('  ⚠️ polish-lap marker could not be stamped on PR #' + prNumber +
                        ' — the lap stays home (fail closed: an unstamped lap cannot honour ' +
                        'once-per-head) — the threads triage below');
                    return resolveSuggestionThreads(provider, prNumber, headSha, cfg);
                }
                return { polished: true, plan: d.plan };
            }
            if (d && d.trigger) {
                console.log('  ⏭️  gh-' + issue.number + ' polish lap not dispatched (' + d.reason +
                    ') — the threads triage below');
            }
        } catch (ePolish) {
            console.warn('  ⚠️ polish gate failed on PR #' + prNumber + ': ' +
                (ePolish.message || ePolish) + ' — falling open to triage');
        }
    }
    return resolveSuggestionThreads(provider, prNumber, headSha, cfg);
}

// gh-1352 — stamp the per-head lap marker BEFORE the leg dispatch (the
// once-per-head + instability-budget memory lives on the PR; a dispatch
// without it is invisible to the next tick's gate and laps forever).
// Returns false when the marker is unbuildable (no head) or the post
// fails — the caller falls open to triage and never dispatches.
function dispatchPolishLap(provider, issueNumber, prNumber, headSha, plan, cfg) {
    var lapIds = (plan && plan.lapThreads || []).map(function (t) { return t && t.threadId; })
        .filter(function (id) { return !!id; });
    var marker = polishLapModule.buildPolishLapMarker(headSha, {
        threads: plan ? plan.lapThreads.length : 0,
        overflow: plan ? plan.overflowThreads.length : 0,
        resolvedThreadIds: lapIds
    });
    if (!marker) return false;
    try {
        provider.postPrComment(prNumber, marker);
    } catch (eStamp) {
        console.warn('  ⚠️ polish-lap marker post failed on PR #' + prNumber + ': ' +
            (eStamp.message || eStamp));
        return false;
    }
    provider.dispatchLeg(issueNumber, 'polish',
        'gh-1352 bounded polish lap (top-K ' + lapIds.length + ', overflow ' +
        (plan ? plan.overflowThreads.length : 0) + ')', cfg.workflowFile);
    return true;
}

// The polish-lap gate (gh-1352 scope 3): the effective APPROVE record for
// the head, the parsed lap markers (machine-authored only) and the open
// thread list feed the pure polishDecision. Returns null when the gate
// cannot run (no head/logins, missing comment primitives — postPrComment
// included: the dispatch must stamp its per-head marker, the once-per-head
// + instability-budget memory) — never throws.
function polishGateDecision(provider, prNumber, headSha, cfg) {
    var logins = machineLoginsOf(cfg);
    if (!headSha || !logins.length || typeof provider.prCommentList !== 'function' ||
        typeof provider.postPrComment !== 'function' ||
        typeof provider.verdictRecords !== 'function' ||
        typeof provider.reviewThreadList !== 'function') {
        return null;
    }
    var records = provider.verdictRecords(prNumber, { authorLogins: logins });
    var effective = reviewVerdictsModule.latestVerdictForHead(records, headSha);
    if (!effective) return null;
    var policy = (cfg && cfg.reviewPolicy) || reviewPolicyModule.defaultPolicy();
    var laps = polishLapModule.parsePolishLapMarkers(provider.prCommentList(prNumber), { authorLogins: logins });
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
    var machineLabels = ['agent:dev', 'agent:rework', 'agent:review',
        'ai_developed', 'ai_pr_reviewed', 'pr_approved', 'needs-human'];
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
        filterLiveActiveIssues: filterLiveActiveIssues
    };
}
