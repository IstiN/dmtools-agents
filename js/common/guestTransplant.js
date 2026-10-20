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
 *     branch from a dead tick is completed from the marker or GC'd (E5 —
 *     the sweep's completion re-entry bypasses the actor/cross-repo
 *     refusals via input.completionRentry: the marker already vetted the
 *     arm); a tick that died between open_pr and close_pr RESUMES the
 *     interrupted tail (carry, comment, close) on the existing machine PR.
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
// section — the PROJECT config wins, then jobParams (the same project-
// override-before-jobParams priority resolveMachineSmConfig uses for
// every machineSm knob). An explicit `enabled: false` keeps the rule
// inert even when the section exists (the off switch).
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
    var cap = (cfg && cfg.titleMaxLen) || DEFAULTS.titleMaxLen;
    var prefix = String((cfg && cfg.titlePrefix) || DEFAULTS.titlePrefix)
        .replace(/\{N\}/g, String(sourceNumber));
    var body = sanitizeGuestTitle(title, cap);
    var rest = body || 'guest change';
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

// ONE comment body → the marker object, or null when the body carries no
// complete marker (no HTML payload, or no state — a half-written marker
// never reads as a transplant snapshot; fail closed).
function _markerObject(body) {
    var m = /<!--\s*guest-transplant\s+([\s\S]*?)-->/.exec(body);
    if (!m) return null;
    var obj = {};
    var pairRe = /([a-z]+)="([^"]*)"/g;
    var pm;
    while ((pm = pairRe.exec(m[1])) !== null) obj[pm[1]] = pm[2];
    if (!obj.state) return null;
    if (obj.source) obj.source = parseInt(obj.source, 10);
    if (obj.transplant) obj.transplant = parseInt(obj.transplant, 10);
    return obj;
}

// Newest marker across a comment feed (chronological — last wins).
// Accepts [{body}] items or raw strings. null when none (fail closed).
function parseTransplantMarker(comments) {
    if (!comments || !comments.length) return null;
    var found = null;
    for (var i = 0; i < comments.length; i++) {
        var body = String((comments[i] && comments[i].body) || comments[i] || '');
        var hit = _markerObject(body);
        if (hit) found = hit;
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

// 'human' | 'machine' | 'unverified'. No labeled event, no actor login,
// NO CONFIGURED ALLOWLIST → 'unverified' — the caller refuses (fail
// closed: a machine actor, a proof-less arm, or a deployment that
// cannot verify actor classes never authorizes executing foreign code;
// this is the one gate whose degraded direction must be "no action",
// matching the module header's missing-proof-refuses invariant).
function classifyArmActor(armEvent, machineLogins) {
    var login = armEvent && armEvent.login;
    if (!login) return 'unverified';
    var logins = machineAuthorModule.machineAuthorLogins(
        Array.isArray(machineLogins) ? machineLogins.join(',') : machineLogins);
    if (!logins.length) return 'unverified';
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
// The events feed as an array (JSON text or an already-parsed array).
// null when neither — the caller refuses (fail closed).
function _parsedEventList(raw) {
    var list = null;
    try {
        var obj = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        list = Array.isArray(obj) ? obj : null;
    } catch (e) { list = null; }
    return list;
}

// The event's actor login, or null when the feed omits the actor.
function _eventActorLogin(ev) {
    return (ev.actor && ev.actor.login) || null;
}

// ONE feed event → {login, createdAt} when it labels the wanted label,
// null otherwise (not a labeled event / different label). Both the
// {name} object and the plain-string label spelling are accepted.
function _labeledEventFor(ev, labelName) {
    if (!ev || ev.event !== 'labeled') return null;
    var name = (ev.label && typeof ev.label === 'object') ? ev.label.name : ev.label;
    if (String(name) !== String(labelName)) return null;
    return {
        login: _eventActorLogin(ev),
        createdAt: ev.created_at || null
    };
}

// Newest `labeled` event for ONE label from an events feed (JSON array;
// chronological — last match wins). null when none / unusable (the
// caller refuses — fail closed).
function parseLabelEvents(raw, labelName) {
    var list = _parsedEventList(raw);
    if (!list) return null;
    var newest = null;
    for (var i = 0; i < list.length; i++) {
        var hit = _labeledEventFor(list[i], labelName);
        if (hit) newest = hit;
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
// The workflow graph keyed by job id (the wiring check's lookup shape).
function _jobsByIdOf(jobs) {
    var jobsById = {};
    jobs.forEach(function (j) {
        if (j && j.id) jobsById[String(j.id)] = { id: String(j.id), needs: (j.needs || []).map(String) };
    });
    return jobsById;
}

// The manifest violations: absent gate jobs, absent secret jobs, secret
// jobs that never reach a gate job through the needs graph.
function _wiringViolations(jobsById, gate) {
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
    return violations;
}

// AC3 structural check: every manifest job must EXIST in the graph, and
// every secret-consuming job must transitively `needs` a gate job.
function validateGateWiring(jobs, gate) {
    var out = { ok: false, violations: [] };
    if (!Array.isArray(jobs) || !jobs.length || !gate) return out;
    var violations = _wiringViolations(_jobsByIdOf(jobs), gate);
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

// ── The decision core (UT-plan) — decomposed ─────────────────────────────
// transplantSequence stays the ONE entry point; each AC/edge case below
// maps to exactly one focused helper (the CRAP gate caps per-function
// complexity — a 27-branch core violates it even at full coverage).

// AC5 — a source closed by hand before the tick, or the configured label
// missing entirely: both skip (the rule query should have filtered them).
function _transplantSkipDecision(source, cfg, audit) {
    var labels = source.labels || [];
    if (source.state && source.state !== 'OPEN') {
        return { decision: 'skip', reason: 'source-closed', steps: [],
                 audit: audit + 'skipped — source is ' + source.state };
    }
    if (labels.indexOf(cfg.label) === -1) {
        return { decision: 'skip', reason: 'not-armed', steps: [],
                 audit: audit + 'skipped — no ' + cfg.label + ' label' };
    }
    return null;
}

// AC5 — only a HUMAN actor's label arms a transplant (missing proof, or
// an unconfigurable actor class, refuses — fail closed); E3 —
// cross-repo heads only. The E5 COMPLETION RE-ENTRY (input.completionRentry,
// the GC sweep finishing an armed-marker orphan through a synthetic
// headless ticket) bypasses both checks: the arm actor was already vetted
// when the `armed` marker was written, and a null headRepo is exactly the
// state the completion exists to recover from (before the bypass the
// re-entry always died here as skip/same-repo — a permanent zombie).
function _transplantRefuseDecision(input, source, base, audit) {
    if (input.completionRentry) return null;
    var actor = classifyArmActor(input.armEvent, input.machineLogins);
    if (actor !== 'human') {
        return { decision: 'refuse', reason: actor === 'machine' ? 'machine-actor' : 'actor-unverified',
                 steps: [], audit: audit + 'REFUSED — arm actor is ' + actor + ' (audit only, no action)' };
    }
    if (!isCrossRepoHead(source.headRepo, base.owner, base.repo)) {
        return { decision: 'skip', reason: 'same-repo', steps: [],
                 audit: audit + 'skipped — same-repo head (transplant is cross-repo only)' };
    }
    return null;
}

// The tail every transplant shares: carry probe → transplant comment →
// source close. The fresh path runs it after merge + open_pr; a RESUME
// (a tick that died between open_pr and close_pr) runs it alone against
// the EXISTING machine PR instead of noop-ing on it forever.
function _resumeTailSteps(sourcePrNumber, branch) {
    return [
        step('carry_decision', { branch: branch }),
        step('transplant_comment', { prNumber: sourcePrNumber, branch: branch }),
        step('close_pr', { prNumber: sourcePrNumber })
    ];
}

// AC5 snapshot semantics for an EXISTING transplant: a 'transplanted'
// marker is terminal (noop); an OPEN machine PR beside an 'armed' marker
// is a tick that died between open_pr and close_pr — RESUME the
// interrupted tail with the existing PR number (the wiring seeds the
// carry probe from resumePrNumber); any other openTransplantPr shape
// (no readable marker, a parked marker) stays the conservative noop.
function _existingTransplantDecision(input, marker, branch, audit) {
    if (marker && marker.state === 'transplanted') {
        return { decision: 'noop', reason: 'already-transplanted', steps: [],
                 audit: audit + 'no-op — transplant already exists' };
    }
    if (input.openTransplantPr && marker && marker.state === 'armed') {
        return {
            decision: 'transplant',
            reason: 'resume-after-open-pr',
            resumePrNumber: input.openTransplantPr.number,
            steps: _resumeTailSteps(input.source.prNumber, branch),
            audit: audit + 'resuming the interrupted transplant tail on open machine PR #' +
                String(input.openTransplantPr.number) + ' (carry probe → comment → close)'
        };
    }
    if (input.openTransplantPr) {
        return { decision: 'noop', reason: 'already-transplanted', steps: [],
                 audit: audit + 'no-op — transplant already exists' };
    }
    return null;
}

// The refusal chain in decision order: actor/cross-repo refusals first,
// then the existing-transplant snapshot states (noop/resume).
function _refusalOrExisting(input, source, base, branch, audit) {
    var refusal = _transplantRefuseDecision(input, source, base, audit);
    if (refusal) return refusal;
    return _existingTransplantDecision(input, input.marker, branch, audit);
}

// AC4 — the park is a pure function of the head (#633 semantics): a
// parked source whose head CHANGED re-arms (label off, transplant
// proceeds); an unchanged head stays parked; a human 'blocked' with NO
// park marker of ours is a human hold — never touched.
function _parkResetDecision(input, cfg, source, marker, base, audit) {
    var labels = source.labels || [];
    if (labels.indexOf(cfg.parkedLabel) === -1) return null;
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

// E5 — an orphan branch from a dead tick completes from the marker
// (merge re-issued: an already-merged API merge is a harmless no-content
// answer) instead of crashing the key idempotency; a marker-less orphan
// is unrecoverable and GCs.
function _orphanDecision(input, cfg, source, base, marker, shaInfo, branch, audit) {
    if (!input.branchExists || input.openTransplantPr) return null;
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

// Fresh transplant: record the arm marker (the snapshot for E1/E5), cut
// the branch at main, merge the recorded sha, open the machine PR.
function _freshSequence(input, cfg, source, base, marker, shaInfo, branch, audit) {
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

// The one decision core. Input/output shapes are documented in the test
// suite; every branch maps to exactly one AC/edge case.
function transplantSequence(input) {
    var cfg = input.cfg;
    var source = input.source || {};
    var base = input.base || { owner: '', repo: '', baseBranch: cfg.baseBranch };
    var audit = 'guest-transplant: #' + String(source.prNumber) + ' ';
    var branch = transplantBranchName(cfg.branchPrefix, source.prNumber);

    var skip = _transplantSkipDecision(source, cfg, audit);
    if (skip) return skip;
    var refusal = _refusalOrExisting(input, source, base, branch, audit);
    if (refusal) return refusal;

    var marker = input.marker;

    var parked = _parkResetDecision(input, cfg, source, marker, base, audit);
    if (parked) return parked;

    // The transplant sha: the marker's recorded arm-time sha wins (E1).
    var shaInfo = resolveTransplantSha(marker, input.headSha);
    if (!shaInfo) {
        // AC4 fallback — no readable head: park with the no-ref reason.
        var steps = parkSteps('no-ref', { cfg: cfg, source: source, headSha: null });
        return { decision: 'park', reason: 'no-ref', steps: steps,
                 audit: audit + 'parked — no-ref (source head unreadable)' };
    }

    var orphan = _orphanDecision(input, cfg, source, base, marker, shaInfo, branch, audit);
    if (orphan) return orphan;

    return _freshSequence(input, cfg, source, base, marker, shaInfo, branch, audit);
}

// ── Branch GC sweep (AC7) + the pure halves of the sweep wiring ──────────

// The find-PRs-by-head list decides a branch's GC state: an OPEN PR on
// the head (ANY of them — a stale closed machine PR may share the branch
// with a live open one) keeps the branch alive; only when every PR on
// the head is closed does the newest-first list's first entry hand the
// branch to the GC. No usable entry (empty list, no states) reads null —
// the caller probes the orphan marker (fail closed).
function prStateFromFindList(list) {
    if (!Array.isArray(list)) return null;
    var first = null;
    for (var i = 0; i < list.length; i++) {
        var st = String((list[i] && list[i].state) || '').toUpperCase();
        if (!st) continue;
        if (!first) first = st;
        if (st === 'OPEN') return 'OPEN';
    }
    return first;
}

// The sweep's actionable window (the maxGcBranches knob, shipped 10):
// how many ACTIONABLE (GC-able / completable) branches one tick executes.
function gcActionableCap(maxGcBranches) {
    return intOr(maxGcBranches, 10);
}

// The sweep's over-scan bound (the gh-1027 shape: cap + 15): how many
// branch entries one tick may PROBE while collecting the actionable
// window — a long OPEN-transplant prefix cannot starve the closed-PR
// branches behind it, and the probes stay bounded.
var GC_OVERSCAN = 15;

function gcScanBudget(maxGcBranches) {
    return gcActionableCap(maxGcBranches) + GC_OVERSCAN;
}

// The gh transport spells a merges-API conflict into the error message
// ('Merge conflict' + HTTP 409). ONLY the merge step's thrown error is
// ever tested against this (the wiring marks eMerge.isMergeConflict in
// the merge catch) — a substring hit anywhere else must not swap in the
// AC4 park plan.
function isMergeConflictError(e) {
    var msg = String((e && e.message) || e || '');
    return msg.indexOf('Merge conflict') !== -1 ||
        msg.toLowerCase().indexOf('conflict') !== -1 ||
        msg.indexOf('409') !== -1;
}

// The orphan half of a sweep entry: an armed marker completes (E5),
// anything else (no marker / a parked marker) is a dead branch — GC.
function _orphanStep(e) {
    if (e.marker && e.marker.state === 'armed' && e.marker.head) {
        return step('complete_orphan', {
            branch: e.branch,
            sourcePrNumber: e.marker.source,
            headSha: e.marker.head
        });
    }
    return step('delete_ref', { branch: e.branch });
}

// ONE sweep entry → its GC step, or null when the branch is left alone
// (no branch name, or a live OPEN transplant PR still on it).
function _gcEntryStep(e) {
    if (!e || !e.branch) return null;
    if (e.prState === 'CLOSED' || e.prState === 'MERGED') {
        return step('delete_ref', { branch: e.branch });
    }
    if (e.prState === 'OPEN') return null;
    // No PR on this branch (yet/anymore).
    return _orphanStep(e);
}

// One sweep entry per guest branch: {branch, prState: 'OPEN'|'CLOSED'|
// 'MERGED'|null, marker: parsed marker|null}. ANY closed state deletes
// the branch; a branch-less PR-less orphan with an armed marker
// completes (E5); a marker-less orphan GCs. Garbage degrades to no steps.
function gcSteps(sweep) {
    if (!Array.isArray(sweep)) return [];
    var steps = [];
    sweep.forEach(function (e) {
        var s = _gcEntryStep(e);
        if (s) steps.push(s);
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
    gcSteps: gcSteps,
    prStateFromFindList: prStateFromFindList,
    gcActionableCap: gcActionableCap,
    gcScanBudget: gcScanBudget,
    isMergeConflictError: isMergeConflictError
};
