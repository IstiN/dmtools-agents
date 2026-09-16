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
// ─────────────────────────────────────────────────────────────────────────────
function decideActions(state, cfg) {
    var actions = [];
    var labels = (state.issue && state.issue.labels) || [];
    var has = function (l) { return labels.indexOf(l) !== -1; };
    var maxRounds = (cfg && cfg.maxReworkRounds) || 2;

    if (has('needs-human')) {
        actions.push({ type: 'skip', reason: 'needs-human — waiting for a human' });
        return actions;
    }
    if (state.activeRunForIssue) {
        actions.push({ type: 'skip', reason: 'active AI Teammate run for this issue' });
        return actions;
    }

    // Rework round cap — mirrors ai-teammate.yml MAX_AUTO_REWORK_ROUNDS:
    // escalate instead of looping rework forever.
    var rounds = 0;
    labels.forEach(function (l) {
        var m = /^rework-round-(\d+)$/.exec(l);
        if (m) rounds = Math.max(rounds, parseInt(m[1], 10));
    });
    var reworkExhausted = rounds >= maxRounds;

    var pr = state.pr;
    if (!pr) {
        // No open PR and nothing merged for this issue yet.
        if (has('ai_developed')) {
            actions.push({ type: 'dispatch', leg: 'rework',
                reason: 'ai_developed but no open PR (dead dev run)' });
        } else if (has('agent:dev')) {
            actions.push({ type: 'dispatch', leg: 'dev',
                reason: 'agent:dev labeled, no PR yet (dead dev letter)' });
        } else if (has('agent:rework')) {
            actions.push({ type: 'dispatch', leg: 'rework',
                reason: 'stale agent:rework with no PR' });
        } else {
            actions.push({ type: 'skip', reason: 'no PR and no machine leg to (re)fire' });
        }
        return actions;
    }

    if (pr.state !== 'OPEN') {
        if (pr.state === 'MERGED') {
            actions.push({ type: 'closeIssue',
                reason: 'linked PR #' + pr.number + ' merged (Fixes #N safety net)' });
        } else {
            actions.push({ type: 'skip', reason: 'linked PR #' + pr.number + ' is ' + pr.state });
        }
        return actions;
    }

    if (pr.checkConclusion === 'pending') {
        actions.push({ type: 'skip', reason: 'PR #' + pr.number + ' checks pending' });
        return actions;
    }

    if (pr.checkConclusion === 'red') {
        if (reworkExhausted) {
            actions.push({ type: 'label', label: 'needs-human',
                reason: 'CI red after ' + rounds + ' rework rounds — escalating' });
        } else {
            actions.push({ type: 'dispatch', leg: 'rework',
                reason: 'CI red on PR #' + pr.number + (has('agent:rework')
                    ? ' (stale agent:rework — dead letter re-fire)'
                    : '') });
        }
        return actions;
    }

    // ── green below ──────────────────────────────────────────────────────────
    if (has('pr_approved')) {
        if (pr.mergeState === 'BEHIND') {
            actions.push({ type: 'updateBranch',
                reason: 'approved but behind main — updating branch' });
        } else if (pr.mergeState === 'CLEAN' || pr.mergeable === true) {
            actions.push({ type: 'merge',
                reason: 'approved + green + mergeable (merge-trigger parity)' });
        } else {
            actions.push({ type: 'skip',
                reason: 'approved but merge state ' + pr.mergeState });
        }
        return actions;
    }

    if (has('ai_developed') && !has('ai_pr_reviewed')) {
        actions.push({ type: 'dispatch', leg: 'review',
            reason: 'green PR #' + pr.number + ' awaits machine review' });
        return actions;
    }
    if (has('ai_pr_reviewed') && !has('pr_approved')) {
        // Reviewed but the verdict never reached approve. The review leg
        // itself labels agent:rework for CHANGES_REQUESTED verdicts; if
        // that label is present with no active run it is another dead
        // letter — re-fire it. Otherwise wait (verdict processing pending).
        if (has('agent:rework')) {
            actions.push({ type: 'dispatch', leg: 'rework',
                reason: 'stale agent:rework after review (dead letter re-fire)' });
        } else {
            actions.push({ type: 'skip',
                reason: 'reviewed, verdict not approve — awaiting rework labeling' });
        }
        return actions;
    }

    actions.push({ type: 'skip', reason: 'steady state' });
    return actions;
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
        default:
            return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// JSRunner entry point
// ─────────────────────────────────────────────────────────────────────────────
function action(params) {
    var p = params.jobParams || params;
    var projectConfig = {};
    try {
        projectConfig = configLoader.loadProjectConfig({ configPath: p.configPath }) || {};
    } catch (e) { projectConfig = {}; }
    var override = projectConfig.machineSm || {};

    var cfg = {
        dryRun:            override.dryRun            !== undefined ? override.dryRun            : (p.dryRun || false),
        maxConcurrentRuns: override.maxConcurrentRuns !== undefined ? override.maxConcurrentRuns : (p.maxConcurrentRuns || 1),
        maxReworkRounds:   override.maxReworkRounds   !== undefined ? override.maxReworkRounds   : (p.maxReworkRounds || 2),
        workflowFile:      override.workflowFile      || p.workflowFile   || 'ai-teammate.yml',
        branchPrefix:      override.branchPrefix      || p.branchPrefix   || 'ai/gh-',
        agentHandle:       override.agentHandle       || p.agentHandle    || 'ai-teammate',
        issueLimit:        override.issueLimit        || p.issueLimit     || 50,
        closeComment:      override.closeComment      || p.closeComment   || 'Machine SM: linked PR merged — closing the loop.'
    };
    var repoCfg = (projectConfig.repository && projectConfig.repository.owner &&
        projectConfig.repository.repo && projectConfig.repository) ||
        (p.repository || (p.repo ? { owner: String(p.repo).split('/')[0], repo: String(p.repo).split('/')[1] } : null));

    if (!repoCfg || !repoCfg.owner || !repoCfg.repo) {
        console.error('❌ machineSm: repository required (.dmtools/config.js repository or jobParams.repo owner/repo)');
        return { success: false, error: 'Missing repo' };
    }

    // Forge selection: scm.provider (github | gitlab) — scm.js contract.
    var scmCfg = (projectConfig.scm && projectConfig.scm.provider)
        ? projectConfig.scm
        : (p.scm || { provider: 'github' });
    var provider;
    try {
        provider = smProviderModule.createSmProvider({
            scm: scmCfg, repository: repoCfg
        });
    } catch (e) {
        console.error('❌ machineSm: ' + (e.message || e));
        return { success: false, error: String(e.message || e) };
    }

    console.log('Machine SM — ' + repoCfg.owner + '/' + repoCfg.repo + ' [' + provider.provider + ']' +
        (cfg.dryRun ? ' [DRY RUN]' : '') + ' (cap ' + cfg.maxConcurrentRuns + ', rounds ' + cfg.maxReworkRounds + ')');

    // 1. Global concurrency gate — the user contract: with parallel runs
    //    in flight, wait them out; the cron tick re-fires soon.
    var activeIssues = provider.activeMachineRuns(cfg.workflowFile);
    if (activeIssues.length >= cfg.maxConcurrentRuns) {
        console.log('  ⏳ idle — active machine run(s) for ' +
            (activeIssues.join(', ') === 'unknown' ? 'this project' : 'issue(s) ' + activeIssues.join(', ')) +
            '; waiting for the next tick');
        return { success: true, idle: true, waitingFor: activeIssues };
    }

    // 2. Reconcile every machine-managed issue through the provider.
    var machineLabels = ['agent:dev', 'agent:rework', 'agent:review',
        'ai_developed', 'ai_pr_reviewed', 'pr_approved', 'needs-human'];
    var issues = provider.listMachineIssues(machineLabels, cfg.agentHandle, cfg.issueLimit);

    var dispatched = 0, acted = 0, skipped = 0, failures = 0;
    var activeSet = {};
    activeIssues.forEach(function (n) { activeSet[n] = true; });

    issues.forEach(function (issue) {
        var prRef = provider.findPr(issue.number, cfg.branchPrefix);
        var pr = prRef && prRef.state === 'OPEN' ? provider.prStatus(prRef.number) : prRef;
        var state = {
            issue: issue,
            pr: pr,
            activeRunForIssue: !!activeSet[issue.number] || !!activeSet['unknown']
        };
        var acts = decideActions(state, cfg);
        acts.forEach(function (a) {
            if (a.type === 'skip') {
                skipped++;
                console.log('  ⏭️  gh-' + issue.number + ': ' + a.reason);
                return;
            }
            a.prNumber = prRef ? prRef.number : null;
            console.log('  ' + (cfg.dryRun ? '[dry] ' : '') + '▶️  gh-' + issue.number + ' ' +
                a.type + (a.leg ? ':' + a.leg : '') + ' — ' + a.reason);
            if (cfg.dryRun) { acted++; if (a.type === 'dispatch') dispatched++; return; }
            try {
                executeAction(provider, a, issue, cfg);
                acted++;
                if (a.type === 'dispatch') dispatched++;
            } catch (e) {
                failures++;
                console.error('  ❌ gh-' + issue.number + ' ' + a.type + ' failed: ' + (e.message || e));
            }
        });
    });

    console.log('\n══ Machine SM complete — acted: ' + acted + ' (dispatched ' + dispatched +
        '), skipped: ' + skipped + ', failures: ' + failures + ' ══');
    return { success: failures === 0, acted: acted, dispatched: dispatched, skipped: skipped, failures: failures };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        decideActions: decideActions,
        issueFromRunTitle: issueFromRunTitle
    };
}
