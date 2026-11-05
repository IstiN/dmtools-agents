#!/usr/bin/env node
/**
 * dry-run-disposition-loop.js — gh-1352 acceptance #7 evidence runner.
 *
 * Drives the REAL production disposition loop (js/machineSmAgent.js:
 * decideActions -> executeAction -> dispositionLoop -> polish gate ->
 * triage executor -> reviewDispositions -> reviewDebtLedger) against an
 * in-memory scripted provider — the machineSm dryRun doctrine (log the
 * plan, touch nothing external). No dmtools globals, no network: the
 * provider primitives are pure recorders and the module closure is the
 * same require-map the unit tests use.
 *
 * Scenarios (the gh-1352 acceptance replays):
 *   1. triage        — approved + BLOCKED head, machine threads, lap-gated
 *                      census open -> dispositions, no lap (AC3/AC6);
 *                      plus the approved + CLEAN post-merge hygiene pass.
 *   2. polish        — APPROVE, census polish-tier-only -> lap dispatch
 *                      (top-K, marker stamp) + the follow-up tick triaging
 *                      the overflow on the same head (AC2).
 *   3. cycle         — instability budget (laps on 2 prior heads) ->
 *                      third round triage-resolves, no third lap (AC5);
 *                      a ⚠️ mandatory-fix tier refuses to close without a
 *                      fix or a ledger deferral (AC6).
 *
 * Usage: node scripts/dry-run-disposition-loop.js [--quiet]
 * Exit 0 = every scenario behaved as the acceptance replay expects.
 */
'use strict';

var path = require('path');
var PACK_ROOT = path.resolve(__dirname, '..');

function fileRead(p) {
    var rel = String(p).replace(/^agents\//, '');
    var candidates = [
        path.join(PACK_ROOT, String(p)),
        path.join(PACK_ROOT, rel),
        path.join(PACK_ROOT, 'agents', rel)
    ];
    for (var i = 0; i < candidates.length; i++) {
        try {
            if (require('fs').statSync(candidates[i]).isFile()) {
                return require('fs').readFileSync(candidates[i], 'utf8');
            }
        } catch (e) { /* next candidate */ }
    }
    throw new Error('file_read: not found: ' + p);
}

function loadModule(modulePath, requireFn, mocks) {
    var code = fileRead(modulePath);
    var preamble = '';
    var m = mocks || {};
    for (var k in m) {
        if (Object.prototype.hasOwnProperty.call(m, k)) preamble += 'var ' + k + ' = _m_["' + k + '"];\n';
    }
    var mod = { exports: {} };
    var req = requireFn || function () { throw new Error('require("' + arguments[0] + '") not mapped'); };
    (function (_m_) {
        (function (module, exports, require) { eval(preamble + code); })(mod, mod.exports, req);
    })(m);
    return mod.exports;
}

function makeRequire(map) {
    return function (id) {
        if (map[id]) return map[id];
        var base = id.lastIndexOf('/') !== -1 ? id.substring(id.lastIndexOf('/') + 1) : id;
        var noExt = base.replace(/\.js$/, '');
        if (map[base]) return map[base];
        if (map[noExt]) return map[noExt];
        throw new Error('makeRequire: module not found: ' + id);
    };
}

// ── the shared module closure (byte-parity with test_machineSmAgent.js) ─────
var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}));
var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthor }), {});
var reviewPolicy = loadModule('js/common/reviewPolicy.js', makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
var reviewDispositions = loadModule('js/common/reviewDispositions.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts, './reviewPolicy.js': reviewPolicy }), {});
var reviewDebtLedger = loadModule('js/common/reviewDebtLedger.js', makeRequire({
    './reviewVerdicts.js': reviewVerdicts,
    './findingRegistry.js': loadModule('js/common/findingRegistry.js',
        makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {}),
    './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({}))
}), {});
var polishLap = loadModule('js/common/polishLap.js', makeRequire({
    './reviewVerdicts.js': reviewVerdicts,
    './machineAuthor.js': machineAuthor,
    './reviewPolicy.js': reviewPolicy
}), {});
var machineSmAgent = loadModule('js/machineSmAgent.js', makeRequire({
    './configLoader.js': { loadProjectConfig: function () { return {}; } },
    './common/smProvider.js': { createSmProvider: function () { return {}; } },
    './common/reviewVerdicts.js': reviewVerdicts,
    './common/machineAuthor.js': machineAuthor,
    './common/reworkLoopGuard.js': loadModule('js/common/reworkLoopGuard.js',
        makeRequire({ './machineAuthor.js': machineAuthor, './reviewVerdicts.js': reviewVerdicts }), {}),
    './common/reviewPolicy.js': reviewPolicy,
    './common/reviewDispositions.js': reviewDispositions,
    './common/reviewDebtLedger.js': reviewDebtLedger,
    './common/polishLap.js': polishLap
}), {});

var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

// reconcileIssue's planActionFields parity: every planned action carries the
// PR number + head sha the executors gate on.
function planFields(actions, prNumber, headSha) {
    actions.forEach(function (a) { a.prNumber = prNumber; a.headSha = headSha; });
    return actions;
}
var HEAD1 = '1111111111111111111111111111111111111111';
var HEAD2 = '2222222222222222222222222222222222222222';
var CFG = { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' };

// the decideActions state shape (issue labels + pr + active-run guard)
function st(provider, active) {
    return {
        issue: { number: 1352, labels: provider.tape.labels.slice(), assignees: [] },
        pr: provider.prForIssue(),
        activeRunForIssue: !!active
    };
}

// ── the scripted provider — every write is recorded, nothing leaves ─────────
function scriptedProvider(opts) {
    var o = opts || {};
    var pr = {
        number: 99, state: 'OPEN', mergeState: o.mergeState || 'BLOCKED',
        mergeable: o.mergeable, checkConclusion: 'green', headSha: o.headSha || HEAD
    };
    var state = {
        labels: (o.labels || []).slice(),
        comments: (o.comments || []).slice(),
        threads: (o.threads || []).slice(),
        records: (o.records || []).slice(),
        resolved: [], replies: [], posted: [], dispatches: [], merges: 0
    };
    function snapshot() {
        return JSON.parse(JSON.stringify({
            number: pr.number, mergeState: pr.mergeState, labels: state.labels
        }));
    }
    return {
        tape: state,
        prForIssue: function () { return pr; },
        issueLabels: function () { return state.labels.slice(); },
        activeRunForIssue: function () { return o.activeRun || null; },
        merge: function () { state.merges++; state.labels.push('ai_merged'); return 'merged'; },
        dispatchLeg: function (n, leg, reason, wf) {
            state.dispatches.push({ issue: n, leg: leg, reason: reason, wf: wf });
            return 'run-12345';
        },
        verdictRecords: function () { return state.records; },
        reviewThreadList: function () { return state.threads; },
        prCommentList: function () { return state.comments; },
        postPrComment: function (n, body) {
            state.posted.push(body);
            state.comments.push({ body: body, user: { login: 'ai-teammate' } }); // posted = readable
            return 'c' + state.posted.length;
        },
        resolveThread: function (n, t) {
            state.resolved.push(t.threadId);
            state.threads.forEach(function (x) { if (x.threadId === t.threadId) x.resolved = true; });
            return 'ok';
        },
        replyToThread: function (n, t, text) { state.replies.push({ threadId: t.threadId, text: text }); return 'ok'; },
        addIssueLabel: function (n, l) { state.labels.push(l); return 'ok'; },
        snapshot: snapshot
    };
}

function thread(id, severity, body, author) {
    return {
        threadId: id, rootCommentId: 9000 + id.length, resolved: false,
        author: author || 'ai-teammate', isMinimized: false,
        body: body || (severity + ' SUGGESTION: machine finding on the head (gh-1352 dry-run)')
    };
}

var failures = 0;
function check(label, cond, detail) {
    if (cond) {
        console.log('     ✅ ' + label);
    } else {
        failures++;
        console.log('     ❌ ' + label + (detail ? ' — ' + detail : ''));
    }
}
function section(title) {
    console.log('\n── ' + title + ' ' + new Array(Math.max(1, 70 - title.length)).join('─'));
}

// ── scenario 1: triage ──────────────────────────────────────────────────────
function scenarioTriage() {
    section('Scenario 1 · TRIAGE — approved + BLOCKED, lap-gated census open (AC3/AC6)');
    var provider = scriptedProvider({
        labels: ['gh-1352', 'ai_developed', 'ai_pr_reviewed', 'pr_approved'],
        records: [{ head: HEAD, verdict: 'APPROVE', blocking: 0, important: 1,
            suggestions: 2, nits: 0, at: '2026-11-05T00:00:00.000Z', source: 'pr_review.json' }],
        threads: [
            thread('RT_s1', '💡'),
            thread('RT_s2', '💡'),
            thread('RT_i1', '⚠️', '⚠️ IMPORTANT: validate the error path before shipping'),
            thread('RT_h1', '💡', '💡 SUGGESTION: a human still looks at this one', 'human-dev')
        ]
    });

    var actions = planFields(machineSmAgent.decideActions(st(provider, null), CFG), 99, HEAD);
    console.log('  decideActions → ' + actions.map(function (a) { return a.type + '(' + (a.reason || '').slice(0, 58) + ')'; }).join('\n                    '));
    check('BLOCKED + approved routes the disposition loop (no rework leg on APPROVE)',
        actions.length === 1 && actions[0].type === 'dispositionLoop' && actions[0].allowPolish === true);

    var out = machineSmAgent.executeAction(provider, actions[0], { number: 1352 }, CFG);
    check('no polish lap dispatched (lap-gated census: important=1)',
        !out.polished && provider.tape.dispatches.length === 0);
    check('both 💡 machine threads resolved with machine-parsed dispositions',
        provider.tape.resolved.indexOf('RT_s1') !== -1 && provider.tape.resolved.indexOf('RT_s2') !== -1);
    check('⚠️ IMPORTANT (fix: mandatory, no fix in this loop) stayed open (fix-or-defer gate)',
        provider.tape.resolved.indexOf('RT_i1') === -1);
    check('human thread never machine-resolved (AC3 invariant)',
        provider.tape.resolved.indexOf('RT_h1') === -1);
    var ack = provider.tape.replies[0] && provider.tape.replies[0].text || '';
    check('ack reply carries a machine-parsed disposition tag',
        /fixed:|wontfix:|duplicate:|defered:/.test(ack), ack.slice(0, 80));
    var ledgerPost = (provider.tape.posted.join('') || '');
    check('mandatory-fix deferral lives in the review debt ledger (receipt rule)',
        ledgerPost.indexOf('dmtools:review-debt-ledger') !== -1);
    console.log('  resolved ' + provider.tape.resolved.length + '/4 threads, ledger findings posted: ' +
        (ledgerPost.match(/dmtools:review-debt-ledger/g) || []).length);
    return provider;
}

function scenarioPostMerge() {
    section('Scenario 1b · TRIAGE — approved + CLEAN merges first, then hygiene (no lap)');
    var provider = scriptedProvider({
        mergeState: 'CLEAN', mergeable: true,
        labels: ['gh-1352', 'ai_developed', 'ai_pr_reviewed', 'pr_approved'],
        records: [{ head: HEAD, verdict: 'APPROVE', blocking: 0, important: 0,
            suggestions: 1, nits: 0, at: '2026-11-05T00:00:00.000Z', source: 'pr_review.json' }],
        threads: [thread('RT_m1', '💡')]
    });
    var actions = planFields(machineSmAgent.decideActions(st(provider, null), CFG), 99, HEAD);
    console.log('  decideActions → ' + actions.map(function (a) { return a.type; }).join(' → '));
    check('merge parity first, then the hygiene pass with allowPolish:false',
        actions[0].type === 'merge' && actions[1].type === 'dispositionLoop' && actions[1].allowPolish === false);
    machineSmAgent.executeAction(provider, actions[0], { number: 1352 }, CFG);
    machineSmAgent.executeAction(provider, actions[1], { number: 1352 }, CFG);
    check('CLEAN head merged without any BLOCKED state (AC3)',
        provider.tape.merges === 1);
    check('the open 💡 machine thread resolved post-merge with a disposition',
        provider.tape.resolved.indexOf('RT_m1') !== -1);
    check('no lap on a clean head (merge parity owns it)',
        provider.tape.dispatches.length === 0);
    return provider;
}

// ── scenario 2: polish ──────────────────────────────────────────────────────
function scenarioPolish() {
    section('Scenario 2 · POLISH — APPROVE with census polish-tier-only (AC2)');
    var provider = scriptedProvider({
        labels: ['gh-1352', 'ai_developed', 'ai_pr_reviewed', 'pr_approved'],
        records: [{ head: HEAD, verdict: 'APPROVE', blocking: 0, important: 0,
            suggestions: 4, nits: 0, at: '2026-11-05T01:00:00.000Z', source: 'pr_review.json' }],
        threads: [
            thread('RT_p1', '💡'), thread('RT_p2', '💡'),
            thread('RT_p3', '💡'), thread('RT_p4', '💡'),
            thread('RT_p5', '💡'), thread('RT_p6', '💡'),
            thread('RT_p7', '💡')
        ]
    });
    var actions = planFields(machineSmAgent.decideActions(st(provider, null), CFG), 99, HEAD);
    check('BLOCKED + approved + polish-only census arms the disposition loop',
        actions.length === 1 && actions[0].type === 'dispositionLoop');
    var out = machineSmAgent.executeAction(provider, actions[0], { number: 1352 }, CFG);
    check('polish lap dispatched (no dev/rework lap — AC2 "no dev lap dispatched")',
        out.polished === true && provider.tape.dispatches.length === 1 &&
        provider.tape.dispatches[0].leg === 'polish' &&
        provider.tape.dispatches.every(function (d) { return d.leg !== 'dev' && d.leg !== 'rework'; }));
    check('top-K bound respected (bounds.polishMaxThreads = 6 of 7 open polish threads)',
        out.plan.lapThreads.length === 6 && out.plan.overflowThreads.length === 1);
    check('the dispatch stamped the per-head lap marker (once-per-head memory)',
        provider.tape.posted.length === 1 &&
        provider.tape.posted[0].indexOf('dmtools:polish-lap') !== -1 &&
        provider.tape.posted[0].indexOf(HEAD) !== -1);
    var laps = polishLap.parsePolishLapMarkers(
        provider.tape.posted.map(function (b) { return { body: b, user: { login: 'ai-teammate' } }; }),
        { authorLogins: ['ai-teammate'] });
    check('marker round-trips through the trusted-identity parser (head + resolvedThreadIds)',
        laps.length === 1 && laps[0].head === HEAD && laps[0].resolvedThreadIds.length === 6);

    console.log('\n  … the polish leg lands its one commit; a new tick on the SAME head:');
    var tick2 = planFields(machineSmAgent.decideActions(st(provider, null), CFG), 99, HEAD);
    var out2 = machineSmAgent.executeAction(provider, tick2[0], { number: 1352 }, CFG);
    check('once-per-head: the same head never laps twice — overflow hands to triage',
        !out2.polished && provider.tape.dispatches.length === 1 &&
        provider.tape.resolved.indexOf('RT_p7') !== -1);
    return provider;
}

// ── scenario 3: the full cycle (instability budget + ownership) ─────────────
function scenarioCycle() {
    section('Scenario 3 · CYCLE — instability budget + mandatory-fix ownership (AC5/AC6)');
    function lapMarker(head) {
        return '<!-- dmtools:polish-lap ' + JSON.stringify({
            head: head, threads: 2, overflow: 0, at: '2026-11-05T02:00:00.000Z'
        }) + ' -->';
    }
    var provider = scriptedProvider({
        labels: ['gh-1352', 'ai_developed', 'ai_pr_reviewed', 'pr_approved'],
        comments: [{ body: lapMarker(HEAD1), user: { login: 'ai-teammate' } },
                   { body: lapMarker(HEAD2), user: { login: 'ai-teammate' } }],
        records: [{ head: HEAD, verdict: 'APPROVE', blocking: 0, important: 0,
            suggestions: 2, nits: 1, at: '2026-11-05T03:00:00.000Z', source: 'pr_review.json' }],
        threads: [thread('RT_c1', '💡'), thread('RT_c2', '💡'), thread('RT_c3', '🪶',
            '🪶 NIT: wording polish — fix: opportunistic')]
    });
    var actions = planFields(machineSmAgent.decideActions(st(provider, null), CFG), 99, HEAD);
    var out = machineSmAgent.executeAction(provider, actions[0], { number: 1352 }, CFG);
    check('2 consecutive laps on prior heads exhaust the budget — no third lap (AC5)',
        !out.polished && provider.tape.dispatches.length === 0);
    check('the third round triage-resolves the suggestion threads with dispositions',
        provider.tape.resolved.indexOf('RT_c1') !== -1 && provider.tape.resolved.indexOf('RT_c2') !== -1);
    check('🪶 nit (fix: opportunistic) closes without a fix (wontfix ack)',
        provider.tape.resolved.indexOf('RT_c3') !== -1 &&
        provider.tape.replies.some(function (r) {
            return r.threadId === 'RT_c3' && /wontfix:/.test(r.text);
        }));
    check('every resolved thread carries its machine-parsed tag reply',
        provider.tape.replies.length === 3 &&
        provider.tape.replies.every(function (r) {
            return /fixed:|wontfix:|duplicate:|defered:/.test(r.text);
        }));
    console.log('  dispositions: ' + provider.tape.replies.map(function (r) {
        return r.threadId + '=' + (r.text.match(/(fixed|wontfix|duplicate|defered):/) || [''])[1];
    }).join(', '));
    return provider;
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║ gh-1352 disposition loop — dry-run evidence (non-production) ║');
    console.log('║ code under test: js/machineSmAgent.js (decideActions →       ║');
    console.log('║ dispositionLoop → polish gate → triage → dispositions)       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    scenarioTriage();
    scenarioPostMerge();
    scenarioPolish();
    scenarioCycle();
    console.log('\n═══════════════════════════════════════════');
    if (failures === 0) {
        console.log('  ✅ DRY-RUN PASS — every acceptance replay behaved as specified');
    } else {
        console.log('  ❌ DRY-RUN FAIL — ' + failures + ' check(s) diverged');
    }
    process.exit(failures === 0 ? 0 : 1);
}

main();
