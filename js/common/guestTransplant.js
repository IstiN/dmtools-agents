/**
 * Guest transplant (gh-1140) — the pure half of the `po_accept` rule.
 *
 * A third-party fork PR, once a human labels it `po_accept`, is
 * transplanted by the SM into a machine PR of the base repository:
 * branch `ai/guest-<N>` (cut at main) via the API merges endpoint, a
 * machine PR `[guest #N] <title>` with a Co-authored-by trailer and a
 * body linking the source, the source closed with a transplant comment
 * naming both SHAs, review verdicts carried iff the diff is identical.
 * From the transplant on, the PR is an ordinary machine PR — zero
 * fork-specific lanes, zero permanent guest mode (the gh-113 manual-arm
 * lane stays untouched as the pre-existing fallback).
 *
 * Invariants this module enforces by construction:
 *   - NOTHING here ever targets a fork-owned ref: every command builder
 *     addresses the BASE repo and the machine-owned `ai/guest-<N>`
 *     branch only. Fork heads enter as a SHA argument to the merges API
 *     — never as a dispatch ref, never as a check-run target.
 *   - The Security Gate (AC3) is validated structurally:
 *     `validateGateWiring` refuses any job graph where a secret-consuming
 *     job does not transitively `needs` a gate job, and the serialized
 *     dispatch plan orders every gate job ahead of every secret job.
 *   - Only a HUMAN actor's label arms a transplant (AC5): the labeled
 *     event must exist and its actor must not match the machine-login
 *     allowlist; missing proof refuses (fail closed — the label is the
 *     voucher for executing foreign code in our CI).
 *   - One live transplant per source (snapshot semantics): the arm
 *     marker records the head SHA at arm time; a force-push between arm
 *     and tick transplants the RECORDED sha (E1, no TOCTOU); an orphan
 *     branch from a dead tick is completed from the marker or GC'd (E5).
 *
 * Orchestrated by the `transplant_guest_pr` localAction (smAgent.js);
 * the sequence here is the whole decision — the wiring only executes
 * steps and turns a merges-API 409 into `parkSteps('conflict', …)`.
 *
 * Configuration (inert by default, REG-guest113 — the rule fires only
 * where the project configures it): `.dmtools/config.js`
 * `smGuestTransplant: { label: 'po_accept', parkedLabel: 'blocked',
 * branchPrefix: 'ai/guest-', baseBranch: 'main', carryLabels: [...],
 * titleMaxLen: 80, gate: { gateJobs: [...], secretJobs: [...] } }`.
 *
 * GraalJS constraints: var declarations, plain functions, JSON-safe
 * data. One hoisted require (./machineAuthor.js — a pure leaf), never
 * lazy (gh-823 pack-require rule).
 */

'use strict';

var machineAuthorModule = require('./machineAuthor.js');

// ── Shipped defaults (owner open question 1: the label ships as
// `po_accept`; the knob renames it per project without code changes). ──
var DEFAULTS = {
    label: 'po_accept',
    parkedLabel: 'blocked',
    branchPrefix: 'ai/guest-',
    baseBranch: 'main',
    titlePrefix: '[guest #{N}]',
    carryLabels: ['ai_pr_reviewed', 'pr_approved'],
    titleMaxLen: 80,
    gateJobs: ['security-gate'],
    secretJobs: ['validate']
};

var NOREPLY_HOST = 'users.noreply.github.com';
var SHA_RE = /^[0-9a-f]{40}$/;

function strOr(v, dflt) {
    return (typeof v === 'string' && v) ? v : dflt;
}

function strArrayOr(v, dflt) {
    if (!Array.isArray(v)) return dflt;
    var out = [];
    for (var i = 0; i < v.length; i++) {
        if (typeof v[i] === 'string' && v[i]) out.push(v[i]);
    }
    return out.length ? out : dflt;
}

function intOr(v, dflt) {
    return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : dflt;
}

// ── Config resolution ────────────────────────────────────────────────────

// Normalize the gate manifest: the repo-configurable list of secret-free
// security jobs that must run FIRST and the secret-consuming jobs that
// must wait behind them (AC3). Absent entries keep the defaults.
function normalizeGate(gateCfg) {
    var g = (gateCfg && typeof gateCfg === 'object') ? gateCfg : {};
    return {
        gateJobs: strArrayOr(g.gateJobs, DEFAULTS.gateJobs.slice()),
        secretJobs: strArrayOr(g.secretJobs, DEFAULTS.secretJobs.slice())
    };
}

// The sm-style knob: inert (null) unless the project configures the
// section — jobParams first, then the project config (same
// override-before-default priority every machineSm knob uses). An
// explicit `enabled: false` keeps the rule inert even when the section
// exists (the off switch).
function resolveGuestTransplantConfig(jobParams, projectConfig) {
    var section = (projectConfig && projectConfig.smGuestTransplant) ||
        (jobParams && jobParams.smGuestTransplant) || null;
    if (!section || typeof section !== 'object') return null;
    if (section.enabled === false) return null;
    return {
        label: strOr(section.label, DEFAULTS.label),
        parkedLabel: strOr(section.parkedLabel, DEFAULTS.parkedLabel),
        branchPrefix: strOr(section.branchPrefix, DEFAULTS.branchPrefix),
        baseBranch: strOr(section.baseBranch, DEFAULTS.baseBranch),
        titlePrefix: strOr(section.titlePrefix, DEFAULTS.titlePrefix),
        carryLabels: strArrayOr(section.carryLabels, DEFAULTS.carryLabels.slice()),
        titleMaxLen: intOr(section.titleMaxLen, DEFAULTS.titleMaxLen),
        gate: normalizeGate(section.gate),
        maxGcBranches: intOr(section.maxGcBranches, 10)
    };
}

// ── Predicates ───────────────────────────────────────────────────────────

// Cross-repo head test: the head repository full name ('owner/repo') must
// exist and differ from the base. null (deleted fork / missing payload)
// and malformed specs read SAME-REPO (fail closed — a guest we cannot
// attribute is never transplanted).
function isCrossRepoHead(headFull, owner, repo) {
    if (typeof headFull !== 'string' || headFull.indexOf('/') === -1) return false;
    var parts = headFull.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    return !(parts[0] === owner && parts[1] === repo);
}

function transplantBranchName(branchPrefix, prNumber) {
    return String(branchPrefix) + String(prNumber);
}

function parseGuestBranch(branch, branchPrefix) {
    var b = String(branch || '');
    var p = String(branchPrefix || '');
    if (!b || !p || b.indexOf(p) !== 0) return null;
    var tail = b.substring(p.length);
    return /^\d+$/.test(tail) ? parseInt(tail, 10) : null;
}

// ── Sanitizers (threat model: attacker-controlled strings become branch
// and PR names — length-sanitized, no newline smuggling into commands). ──

function sanitizeGuestTitle(title, maxLen) {
    var cap = intOr(maxLen, DEFAULTS.titleMaxLen);
    var t = String(title == null ? '' : title);
    // Control chars and every newline flavor collapse to spaces — a
    // title can never smuggle a second line into a command or body.
    t = t.replace(/[\x00-\x1f\x7f\r\n\t]+/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length > cap) t = t.substring(0, cap).trim();
    return t;
}

function sanitizeCoAuthor(name, login) {
    var n = String(name == null ? '' : name)
        .replace(/[\x00-\x1f\x7f<>"`\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ').trim();
    if (!n) n = 'guest';
    if (n.length > 60) n = n.substring(0, 60).trim();
    var l = String(login == null ? '' : login).replace(/[^A-Za-z0-9\-_\[\]]/g, '');
    if (!l) l = 'guest';
    return n + ' <' + l + '@' + NOREPLY_HOST + '>';
}

function guestPrTitle(cfg, sourceNumber, title) {
    var prefix = String((cfg && cfg.titlePrefix) || DEFAULTS.titlePrefix)
        .replace(/\{N\}/g, String(sourceNumber));
    var body = sanitizeGuestTitle(title, (cfg && cfg.titleMaxLen) || DEFAULTS.titleMaxLen);
    var rest = body || 'guest change';
    var cap = (cfg && cfg.titleMaxLen) || DEFAULTS.titleMaxLen;
    var full = sanitizeGuestTitle(prefix + ' ' + rest, cap);
    return full || prefix.trim();
}

function guestPrBody(opts) {
    var o = opts || {};
    var full = String(o.sourceFull || 'owner/repo');
    var url = 'https://github.com/' + full + '/pull/' + String(o.sourcePrNumber);
    var lines = [
        'Transplants guest PR ' + full + '#' + String(o.sourcePrNumber) +
            ' (' + sanitizeGuestTitle(o.sourceTitle, 200) + ') by ' +
            sanitizeCoAuthor(o.sourceAuthor, o.sourceLogin) + '.',
        '',
        'Source head: `' + String(o.headSha || 'unknown') + '`',
        'Source: ' + url,
        '',
        'Co-authored-by: ' + sanitizeCoAuthor(o.sourceAuthor, o.sourceLogin),
        '',
        'Security Gate: ' + ((o.gateJobs || []).join(', ') || 'security-gate') +
            ' must conclude green before any secret-consuming validation job runs.'
    ];
    if (o.carriedLabels && o.carriedLabels.length) {
        lines.push('');
        lines.push('Carried review verdicts: ' + o.carriedLabels.join(', ') + ' (identical diff).');
    } else {
        lines.push('');
        lines.push('Fresh review + validation (diff drifted or unavailable).');
    }
    return lines.join('\n');
}

// ── Arm marker (snapshot semantics; the machine-parseable state) ─────────

var MARKER_KEYS = ['state', 'source', 'head', 'branch', 'transplant', 'merged', 'reason'];

function markerHumanLine(f) {
    if (f.state === 'parked') {
        return '🧬 Guest transplant parked (' + String(f.reason || 'unknown reason') +
            ') for #' + String(f.source) + ' at head `' + String(f.head || '') + '`.';
    }
    if (f.state === 'transplanted') {
        return '🧬 Guest transplant of #' + String(f.source) + ' complete → #' +
            String(f.transplant) + ' (merged at `' + String(f.merged || '') + '`).';
    }
    return '🧬 Guest transplant armed for #' + String(f.source) + ' at head `' +
        String(f.head || '') + '` — branch `' + String(f.branch || '') +
        '` will carry it through the Security Gate.';
}

// One machine-parseable comment: an HTML-comment payload (stable key
// order) + one human line. Parse is tolerant to the human text.
function transplantMarkerComment(fields) {
    var f = fields || {};
    var pairs = [];
    for (var i = 0; i < MARKER_KEYS.length; i++) {
        var k = MARKER_KEYS[i];
        if (f[k] === undefined || f[k] === null || f[k] === '') continue;
        pairs.push(k + '="' + String(f[k]).replace(/["\\\r\n]/g, ' ') + '"');
    }
    return '<!-- guest-transplant ' + pairs.join(' ') + ' -->\n' + markerHumanLine(f);
}

// Newest marker across a comment feed (chronological — last wins).
// Accepts [{body}] items or raw strings. null when none (fail closed).
function parseTransplantMarker(comments) {
    if (!comments || !comments.length) return null;
    var found = null;
    for (var i = 0; i < comments.length; i++) {
        var body = String((comments[i] && comments[i].body) || comments[i] || '');
        var m = /<!--\s*guest-transplant\s+([\s\S]*?)-->/.exec(body);
        if (!m) continue;
        var obj = {};
        var pairRe = /([a-z]+)="([^"]*)"/g;
        var pm;
        while ((pm = pairRe.exec(m[1])) !== null) obj[pm[1]] = pm[2];
        if (!obj.state) continue;
        if (obj.source) obj.source = parseInt(obj.source, 10);
        if (obj.transplant) obj.transplant = parseInt(obj.transplant, 10);
        found = obj;
    }
    return found;
}

// E1 — the transplant sha: the sha RECORDED AT ARM TIME wins over the
// current head (a force-push between arm and tick never re-arms the
 // transplant); `drifted` only informs the audit. No sha at all → null.
function resolveTransplantSha(marker, currentHeadSha) {
    var recorded = marker && marker.head;
    if (recorded && SHA_RE.test(String(recorded))) {
        return {
            sha: String(recorded),
            drifted: !!(currentHeadSha && currentHeadSha !== recorded)
        };
    }
    if (currentHeadSha && SHA_RE.test(String(currentHeadSha))) {
        return { sha: String(currentHeadSha), drifted: false };
    }
    return null;
}

// ── Verdict carry (AC6) ──────────────────────────────────────────────────

// Byte fingerprint of a unified diff: CRLF and trailing-newline variance
// normalize away; everything else (blob index lines included — they are
// content-addressed) must match byte-for-byte for the carry.
function diffFingerprint(diffText) {
    if (typeof diffText !== 'string' || !diffText.length) return null;
    var t = diffText.replace(/\r\n/g, '\n');
    t = t.replace(/\n+$/, '\n');
    if (t.charAt(t.length - 1) !== '\n') t += '\n';
    return t;
}

// AC6: verdicts carry iff the transplanted diff is byte-identical to the
// reviewed source diff; every degraded read is a fresh pipeline.
function carryDecision(sourceDiff, transplantDiff, cfg) {
    var fp1 = diffFingerprint(sourceDiff);
    var fp2 = diffFingerprint(transplantDiff);
    if (fp1 === null) return { carry: false, labels: [], reason: 'source-diff-unavailable' };
    if (fp2 === null) return { carry: false, labels: [], reason: 'transplant-diff-unavailable' };
    if (fp1 === fp2) {
        return { carry: true, labels: ((cfg && cfg.carryLabels) || []).slice(),
                 reason: 'identical-diff' };
    }
    return { carry: false, labels: [], reason: 'diff-drifted' };
}

// ── Arm-actor classification (AC5 instruction hierarchy) ─────────────────

// 'human' | 'machine' | 'unverified'. No labeled event, no actor login →
// 'unverified' — the caller refuses (fail closed: a machine actor, or a
// proof-less arm, never authorizes executing foreign code).
function classifyArmActor(armEvent, machineLogins) {
    var login = armEvent && armEvent.login;
    if (!login) return 'unverified';
    var logins = machineAuthorModule.machineAuthorLogins(
        Array.isArray(machineLogins) ? machineLogins.join(',') : machineLogins);
    if (!logins.length) return 'human';
    return machineAuthorModule.loginMatchesList(login, logins) ? 'machine' : 'human';
}

// ── Comments ─────────────────────────────────────────────────────────────

function buildTransplantComment(fields) {
    var f = fields || {};
    var carried = (f.carriedLabels && f.carriedLabels.length)
        ? 'Carried review verdicts: ' + f.carriedLabels.join(', ') + '.'
        : 'No verdicts carried — the transplant runs a fresh review + validation pipeline.';
    return '🧬 Guest transplant complete: source head `' + String(f.sourceSha || '') +
        '` merged at `' + String(f.mergedSha || '') + '` → #' + String(f.transplantPrNumber || '') +
        '.\n\n' + carried + '\n\nStandard machine pipeline follows (Security Gate first).';
}

// AC4 park: a DISTINCT reason per fallback path, and the `parked-head: `
// line the existing #633 head-change reset probe reads. No sha (no-ref
// park) omits the line — the park then clears via the legacy probes.
function parkComment(reason, detail, headSha) {
    var lines = ['⚠️ Guest transplant parked — ' + String(reason) + '.'];
    if (detail) lines.push(String(detail));
    if (headSha && SHA_RE.test(String(headSha))) {
        lines.push('');
        lines.push('parked-head: ' + String(headSha));
    }
    return lines.join('\n');
}

// ── Transport command builders (gh CLI; base repo + machine refs ONLY) ──

function buildCreateRefCommand(owner, repo, branch, sha) {
    return 'gh api repos/' + owner + '/' + repo + '/git/refs -X POST' +
        ' -f ref=refs/heads/' + branch + ' -f sha=' + sha;
}

function buildApiMergeCommand(owner, repo, branch, headSha) {
    return 'gh api repos/' + owner + '/' + repo + '/merges -X POST' +
        ' -f base=' + branch + ' -f head=' + headSha;
}

function buildCreateGuestPrCommand(owner, repo, payloadPath) {
    return 'gh api repos/' + owner + '/' + repo + '/pulls -X POST --input ' + payloadPath;
}

function buildGuestPrPayload(o) {
    return JSON.stringify({
        title: String(o.title || ''),
        head: String(o.branch || ''),
        base: String(o.baseBranch || DEFAULTS.baseBranch),
        body: String(o.body || ''),
        maintainer_can_modify: false
    });
}

function buildClosePrCommand(owner, repo, prNumber) {
    return 'gh api repos/' + owner + '/' + repo + '/pulls/' + String(prNumber) +
        ' -X PATCH -f state=closed';
}

function buildDeleteRefCommand(owner, repo, branch) {
    return 'gh api repos/' + owner + '/' + repo + '/git/refs/heads/' + branch + ' -X DELETE';
}

function buildMainHeadCommand(owner, repo, baseBranch) {
    return 'gh api repos/' + owner + '/' + repo + '/branches/' + baseBranch +
        ' --jq .commit.sha';
}

function buildListBranchesCommand(owner, repo) {
    return 'gh api repos/' + owner + '/' + repo + '/branches --paginate --jq .[].name';
}

function buildFindPrByHeadCommand(owner, repo, branch) {
    return 'gh api "repos/' + owner + '/' + repo + '/pulls?head=' + owner + ':' + branch +
        '&state=all"';
}

function buildListLabelEventsCommand(owner, repo, prNumber) {
    return 'gh api repos/' + owner + '/' + repo + '/issues/' + String(prNumber) +
        '/events --paginate';
}

// Newest `labeled` event for ONE label from an events feed (JSON array;
// chronological — last match wins). null when none / unusable (the
// caller refuses — fail closed).
function parseLabelEvents(raw, labelName) {
    var list = null;
    try {
        var obj = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        list = Array.isArray(obj) ? obj : null;
    } catch (e) { list = null; }
    if (!list) return null;
    var newest = null;
    for (var i = 0; i < list.length; i++) {
        var ev = list[i];
        if (!ev || ev.event !== 'labeled') continue;
        var name = (ev.label && typeof ev.label === 'object') ? ev.label.name : ev.label;
        if (String(name) !== String(labelName)) continue;
        newest = {
            login: (ev.actor && ev.actor.login) || null,
            createdAt: ev.created_at || null
        };
    }
    return newest;
}

// ── Security Gate (AC3) ──────────────────────────────────────────────────

// Transitive `needs` closure: does `jobId` reach any id in `wantedIds`?
// Cycles guarded by the seen-set; unknown job refs simply do not close.
function transitivelyNeeds(jobId, wantedIds, jobsById, seen) {
    if (wantedIds[jobId]) return true;
    if (seen[jobId]) return false;
    seen[jobId] = true;
    var job = jobsById[jobId];
    if (!job || !job.needs || !job.needs.length) return false;
    for (var i = 0; i < job.needs.length; i++) {
        if (transitivelyNeeds(String(job.needs[i]), wantedIds, jobsById, seen)) return true;
    }
    return false;
}

function toIdSet(list) {
    var set = {};
    (list || []).forEach(function (id) { set[String(id)] = true; });
    return set;
}

// AC3 structural check: every manifest job must EXIST in the graph, and
// every secret-consuming job must transitively `needs` a gate job.
function validateGateWiring(jobs, gate) {
    var out = { ok: false, violations: [] };
    if (!Array.isArray(jobs) || !jobs.length || !gate) return out;
    var jobsById = {};
    jobs.forEach(function (j) {
        if (j && j.id) jobsById[String(j.id)] = { id: String(j.id), needs: (j.needs || []).map(String) };
    });
    var gateSet = toIdSet(gate.gateJobs);
    var violations = [];
    gate.gateJobs.forEach(function (g) {
        if (!jobsById[String(g)]) violations.push('gate job "' + g + '" is absent from the workflow graph');
    });
    gate.secretJobs.forEach(function (s) {
        if (!jobsById[String(s)]) {
            violations.push('secret job "' + s + '" is absent from the workflow graph');
            return;
        }
        if (!transitivelyNeeds(String(s), gateSet, jobsById, {})) {
            violations.push('secret job "' + s + '" does not transitively need a security gate job');
        }
    });
    out.violations = violations;
    out.ok = violations.length === 0;
    return out;
}

// Deterministic topological serialization with the gate-first invariant:
// every gate job precedes every secret job regardless of graph shape
// (the wiring check above already proved each secret job reachable from
// a gate job). Ties keep the manifest/input order — the plan string is
// byte-stable for the UT byte-scan.
function gateOrderedIds(jobs, gate) {
    var jobsById = {};
    jobs.forEach(function (j) {
        if (j && j.id) jobsById[String(j.id)] = { id: String(j.id), needs: (j.needs || []).map(String) };
    });
    var gateSet = toIdSet(gate.gateJobs);
    var secretSet = toIdSet(gate.secretJobs);
    var emitted = {};
    var order = [];
    function emit(id, stack) {
        if (emitted[id] || stack[id]) return;
        stack[id] = true;
        var job = jobsById[id];
        if (job) {
            job.needs.forEach(function (n) { emit(n, stack); });
        }
        emitted[id] = true;
        order.push(id);
        // eslint-disable-next-line no-param-reassign
        stack[id] = false;
    }
    function emitTier(tierSet) {
        jobs.forEach(function (j) {
            if (j && j.id && tierSet[String(j.id)]) emit(String(j.id), {});
        });
    }
    // Gate tier first, then everything else (helpers, build jobs), then
    // the secret tier — the order invariant survives any input order.
    emitTier(gateSet);
    jobs.forEach(function (j) {
        if (j && j.id && !gateSet[String(j.id)] && !secretSet[String(j.id)]) emit(String(j.id), {});
    });
    emitTier(secretSet);
    return order;
}

// The dispatch plan for a guest-transplant validation leg: wiring must
// be valid, then the byte-stable plan string names the workflow and the
// gate-first job order (UT-gate byte-scan). ok:false → no plan.
function guestValidationDispatchPlan(jobs, gate, workflowFile) {
    var wiring = validateGateWiring(jobs, gate);
    if (!wiring.ok) {
        return { ok: false, plan: null, order: [], violations: wiring.violations };
    }
    var order = gateOrderedIds(jobs, gate);
    return {
        ok: true,
        plan: String(workflowFile || 'workflow') + ': ' + order.join(' -> '),
        order: order,
        violations: []
    };
}

// ── The decision core (UT-plan) ──────────────────────────────────────────

function step(op, fields) {
    var s = { op: op };
    if (fields) {
        for (var k in fields) s[k] = fields[k];
    }
    return s;
}

// AC4 fallback path: park the source with the machine park label and a
// distinct-reason comment (the #633 `parked-head:` line when a sha
// exists). No branch, no PR — nothing else.
function parkSteps(reason, ctx) {
    var cfg = ctx.cfg;
    var conflict = reason === 'conflict';
    var text = parkComment(
        conflict
            ? 'merge conflict at transplant time — the fork head no longer merges clean into main'
            : 'no-ref: the source head is unreadable (branch deleted or sha unavailable)',
        conflict
            ? 'Re-arm happens automatically when a human push changes the head (parked-head reset).'
            : 'Restore the fork branch (or re-open a PR) to re-arm the transplant.',
        ctx.headSha);
    return [
        step('add_label', { prNumber: ctx.source.prNumber, label: cfg.parkedLabel }),
        step('comment', { prNumber: ctx.source.prNumber, text: text, reason: reason })
    ];
}

// The transplant body of the sequence — merge the recorded sha into the
// branch, open the machine PR, probe the carry, close the source. Shared
// by the fresh path and the orphan completion (which skips the marker
// and ref-create steps its caller already satisfied).
function transplantBodySteps(ctx, sha) {
    var cfg = ctx.cfg;
    var branch = transplantBranchName(cfg.branchPrefix, ctx.source.prNumber);
    var title = guestPrTitle(cfg, ctx.source.prNumber, ctx.source.title);
    var sourceFull = ctx.base.owner + '/' + ctx.base.repo;
    var body = guestPrBody({
        sourceFull: sourceFull,
        sourcePrNumber: ctx.source.prNumber,
        sourceTitle: ctx.source.title,
        sourceAuthor: ctx.source.author,
        sourceLogin: ctx.source.author,
        headSha: sha,
        gateJobs: cfg.gate.gateJobs
    });
    return [
        step('merge', { branch: branch, headSha: sha }),
        step('open_pr', {
            branch: branch, baseBranch: cfg.baseBranch, title: title, body: body
        }),
        step('carry_decision', { branch: branch }),
        step('transplant_comment', { prNumber: ctx.source.prNumber, branch: branch, sha: sha }),
        step('close_pr', { prNumber: ctx.source.prNumber })
    ];
}

// The one decision core. Input/output shapes are documented in the test
// suite; every branch maps to exactly one AC/edge case.
function transplantSequence(input) {
    var cfg = input.cfg;
    var source = input.source || {};
    var labels = source.labels || [];
    var base = input.base || { owner: '', repo: '', baseBranch: cfg.baseBranch };
    var audit = 'guest-transplant: #' + String(source.prNumber) + ' ';

    // AC5 — a source closed by hand before the tick is skipped.
    if (source.state && source.state !== 'OPEN') {
        return { decision: 'skip', reason: 'source-closed', steps: [],
                 audit: audit + 'skipped — source is ' + source.state };
    }
    // The configured label must actually be present.
    if (labels.indexOf(cfg.label) === -1) {
        return { decision: 'skip', reason: 'not-armed', steps: [],
                 audit: audit + 'skipped — no ' + cfg.label + ' label' };
    }
    // AC5 — only a HUMAN actor's label arms a transplant; missing proof
    // refuses (fail closed — the label is the voucher).
    var actor = classifyArmActor(input.armEvent, input.machineLogins);
    if (actor !== 'human') {
        return { decision: 'refuse', reason: actor === 'machine' ? 'machine-actor' : 'actor-unverified',
                 steps: [], audit: audit + 'REFUSED — arm actor is ' + actor + ' (audit only, no action)' };
    }
    // E3 — transplant is cross-repo only; a same-repo label is a no-op.
    if (!isCrossRepoHead(source.headRepo, base.owner, base.repo)) {
        return { decision: 'skip', reason: 'same-repo', steps: [],
                 audit: audit + 'skipped — same-repo head (transplant is cross-repo only)' };
    }
    // AC5 — snapshot semantics: one live transplant per source.
    if (input.openTransplantPr ||
        (input.marker && input.marker.state === 'transplanted')) {
        return { decision: 'noop', reason: 'already-transplanted', steps: [],
                 audit: audit + 'no-op — transplant already exists' };
    }

    var parkedHere = labels.indexOf(cfg.parkedLabel) !== -1;
    var marker = input.marker || null;

    // AC4 — the park is a pure function of the head (#633 semantics): a
    // parked source whose head CHANGED re-arms (label off, transplant
    // proceeds below); an unchanged head stays parked; a human 'blocked'
    // with NO park marker of ours is a human hold — never touched.
    if (parkedHere) {
        var isOurPark = marker && marker.state === 'parked';
        if (!isOurPark) {
            return { decision: 'skip', reason: 'human-blocked', steps: [],
                     audit: audit + 'skipped — ' + cfg.parkedLabel + ' without a transplant park marker (human hold)' };
        }
        var moved = input.headSha && marker.head && input.headSha !== marker.head;
        if (!moved) {
            return { decision: 'noop', reason: 'parked-head-unchanged', steps: [],
                     audit: audit + 'no-op — parked head unchanged' };
        }
        var unpark = [step('remove_label', { prNumber: source.prNumber, label: cfg.parkedLabel })];
        var rearmMarker = step('comment', {
            prNumber: source.prNumber,
            text: transplantMarkerComment({
                state: 'armed', source: source.prNumber,
                head: input.headSha,
                branch: transplantBranchName(cfg.branchPrefix, source.prNumber)
            })
        });
        return {
            decision: 'transplant',
            reason: 'park-reset',
            steps: unpark.concat([rearmMarker, step('create_ref', {
                branch: transplantBranchName(cfg.branchPrefix, source.prNumber),
                atBranch: cfg.baseBranch
            })]).concat(transplantBodySteps(
                { cfg: cfg, base: base, source: source }, input.headSha)),
            audit: audit + 'park reset — head moved ' + String(marker.head) + ' → ' +
                String(input.headSha) + ' (re-arming the transplant)'
        };
    }

    // The transplant sha: the marker's recorded arm-time sha wins (E1).
    var shaInfo = resolveTransplantSha(marker, input.headSha);
    if (!shaInfo) {
        // AC4 fallback — no readable head: park with the no-ref reason.
        var steps = parkSteps('no-ref', { cfg: cfg, source: source, headSha: null });
        return { decision: 'park', reason: 'no-ref', steps: steps,
                 audit: audit + 'parked — no-ref (source head unreadable)' };
    }

    var branch = transplantBranchName(cfg.branchPrefix, source.prNumber);

    // E5 — an orphan branch from a dead tick completes from the marker
    // (merge re-issued: an already-merged API merge is a harmless
    // no-content answer) instead of crashing the key idempotency.
    if (input.branchExists && !input.openTransplantPr) {
        if (!marker) {
            return { decision: 'gc-orphan', reason: 'orphan-branch-no-marker',
                     steps: [step('delete_ref', { branch: branch })],
                     audit: audit + 'GC — orphan branch ' + branch + ' with no arm marker' };
        }
        return {
            decision: 'complete-orphan',
            reason: 'orphan-branch-completed',
            steps: transplantBodySteps({ cfg: cfg, base: base, source: source }, shaInfo.sha),
            audit: audit + 'completing orphan transplant from branch ' + branch
        };
    }

    // Fresh transplant: record the arm marker (the snapshot for E1/E5),
    // cut the branch at main, merge the recorded sha, open the machine PR.
    var fresh = [];
    if (!marker) {
        fresh.push(step('comment', {
            prNumber: source.prNumber,
            text: transplantMarkerComment({
                state: 'armed', source: source.prNumber, head: shaInfo.sha, branch: branch
            })
        }));
    }
    fresh.push(step('create_ref', { branch: branch, atBranch: cfg.baseBranch }));
    return {
        decision: 'transplant',
        reason: shaInfo.drifted ? 'armed-sha-drifted' : 'fresh',
        steps: fresh.concat(transplantBodySteps({ cfg: cfg, base: base, source: source }, shaInfo.sha)),
        audit: audit + 'transplanting head ' + shaInfo.sha +
            (shaInfo.drifted ? ' (RECORDED at arm time — current head moved)' : '') +
            ' onto ' + branch
    };
}

// ── Branch GC sweep (AC7) ────────────────────────────────────────────────

// One sweep entry per guest branch: {branch, prState: 'OPEN'|'CLOSED'|
// 'MERGED'|null, marker: parsed marker|null}. ANY closed state deletes
// the branch; a branch-less PR-less orphan with an armed marker
// completes (E5); a marker-less orphan GCs. Garbage degrades to no steps.
function gcSteps(sweep) {
    if (!Array.isArray(sweep)) return [];
    var steps = [];
    sweep.forEach(function (e) {
        if (!e || !e.branch) return;
        if (e.prState === 'CLOSED' || e.prState === 'MERGED') {
            steps.push(step('delete_ref', { branch: e.branch }));
            return;
        }
        if (e.prState === 'OPEN') return;
        // No PR on this branch (yet/anymore).
        if (e.marker && e.marker.state === 'armed' && e.marker.head) {
            steps.push(step('complete_orphan', {
                branch: e.branch,
                sourcePrNumber: e.marker.source,
                headSha: e.marker.head
            }));
            return;
        }
        steps.push(step('delete_ref', { branch: e.branch }));
    });
    return steps;
}

module.exports = {
    DEFAULTS: DEFAULTS,
    resolveGuestTransplantConfig: resolveGuestTransplantConfig,
    normalizeGate: normalizeGate,
    isCrossRepoHead: isCrossRepoHead,
    transplantBranchName: transplantBranchName,
    parseGuestBranch: parseGuestBranch,
    sanitizeGuestTitle: sanitizeGuestTitle,
    sanitizeCoAuthor: sanitizeCoAuthor,
    guestPrTitle: guestPrTitle,
    guestPrBody: guestPrBody,
    transplantMarkerComment: transplantMarkerComment,
    parseTransplantMarker: parseTransplantMarker,
    resolveTransplantSha: resolveTransplantSha,
    diffFingerprint: diffFingerprint,
    carryDecision: carryDecision,
    classifyArmActor: classifyArmActor,
    buildTransplantComment: buildTransplantComment,
    parkComment: parkComment,
    parkSteps: parkSteps,
    buildCreateRefCommand: buildCreateRefCommand,
    buildApiMergeCommand: buildApiMergeCommand,
    buildCreateGuestPrCommand: buildCreateGuestPrCommand,
    buildGuestPrPayload: buildGuestPrPayload,
    buildClosePrCommand: buildClosePrCommand,
    buildDeleteRefCommand: buildDeleteRefCommand,
    buildMainHeadCommand: buildMainHeadCommand,
    buildListBranchesCommand: buildListBranchesCommand,
    buildFindPrByHeadCommand: buildFindPrByHeadCommand,
    buildListLabelEventsCommand: buildListLabelEventsCommand,
    parseLabelEvents: parseLabelEvents,
    transitivelyNeeds: transitivelyNeeds,
    validateGateWiring: validateGateWiring,
    guestValidationDispatchPlan: guestValidationDispatchPlan,
    gateOrderedIds: gateOrderedIds,
    transplantSequence: transplantSequence,
    gcSteps: gcSteps
};
