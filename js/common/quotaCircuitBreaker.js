/**
 * quotaCircuitBreaker.js — gh-1087 quota circuit-breaker (pure logic, no dmtools globals).
 *
 * A hard provider-quota failure (HTTP 403 usage-limit / billing body — e.g.
 * "weekly (7-day) usage limit" — or a "Provider chain exhausted" tail that
 * follows quota responses) must PARK the leg lane instead of burning a
 * per-tick retry against a wall that cannot succeed until the quota window
 * resets. Transient interruptions (429 rate-limit blips, timeouts, network
 * cuts) keep the classic gh-742 reset-for-retry behavior.
 *
 * Everything here is a pure function so the classifier, the park decision,
 * the SM dispatch-lane exclusion and the probe cadence are unit-testable
 * without any tracker/CLI mocks:
 *
 *   classifyFailure(text)              → { kind: 'quota_exhausted' | 'transient' | null, ... }
 *   parkLabelOf(jobParams)             → park label name (default 'provider_quota')
 *   probeEveryOf(jobParams)            → probe cadence in SM ticks (default 3)
 *   probeCommandOf(jobParams)          → cheap provider ping shell command
 *   redactCommand(command)             → log-safe probe command (credentials masked)
 *   probeDue(completedTicks, everyN)   → is a probe due this tick?
 *   tickMarkerLine(n)                  → durable per-tick cadence marker line
 *   probeMarkerLine(n)                 → durable per-probe counter line
 *   countTickMarkers(bodies)           → park ticks already recorded
 *   countProbeMarkers(bodies)          → probe attempts already recorded
 *   shouldSkipForQuotaPark(t,rule,jp)  → SM dispatch-lane exclusion predicate
 *   parkComment(m, cls, label, everyN) → ticket/PR park comment (markup-object driven)
 *   unparkComment(m, label, count)     → probe-success un-park comment
 */

var DEFAULT_PARK_LABEL = 'provider_quota';
var DEFAULT_PROBE_EVERY_TICKS = 3;

// Hard-quota bodies: usage-limit / quota / billing vocabulary. A bare 403 is
// NOT enough (some gateways answer 403 for auth too) — the quota vocabulary
// (or an exhausted-chain tail, see classifyFailure) must corroborate it.
var QUOTA_BODY_RE = /usage\s*limit|quota|billing|insufficient\s+(?:credit|quota|balance)|credit[s]?\s+exhausted|plan\s+limit|spend\s+limit/i;
var FORBIDDEN_RE = /\b403\b/;
var CHAIN_EXHAUSTED_RE = /provider chain exhausted/i;
// Transient signals — a retry CAN plausibly succeed on the next tick.
var RATE_LIMIT_RE = /\b429\b/i;
var TIMEOUT_RE = /rate\s*limit|timeout|timed?\s*out|econnreset|etimedout|socket hang up|network error|temporar/i;
// gh-1121: an exhausted chain whose attempts carry 401-style auth text is a
// credential problem, not an outage — a resume can never fix it. (403 and
// quota vocabulary are excluded earlier by the quota branch's priority — I1.)
var AUTH_TEXT_RE = /\b401\b|unauthorized|invalid[\s_-]?api[\s_-]?key|authentication failed/i;

// gh-1121: transient-outage evidence extraction for the honest reset comment.
// Live shapes (run 39315836954):
//   zai/glm-5.3-flash returned 500 {"code":"1234",...}
//   kimi-for-coding hit 429 Rate limit reached
var OUTAGE_CODE_RE = /\b(5\d{2}|429)\b/g;
var OUTAGE_MODEL_RES = [
    /([A-Za-z0-9][\w.-]*(?:\/[\w.-]+)+)\s+(?:returned|responded with|answered|failed with|hit)\s+(?:HTTP\/?)?\s*(?:5\d{2}|429)/gi,
    /(?:^|[\s"'(])([A-Za-z0-9][\w-]{2,})\s+(?:then\s+)?hit\s+(?:HTTP\/?)?\s*(?:5\d{2}|429)/gi,
    /provider\s*[:\["']+\s*([A-Za-z0-9][\w.-]*)/gi
];
var OUTAGE_EXTRACT_CAP = 6;

function collectMatches(text, re, cap) {
    var found = [];
    var seen = {};
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
        var value = m[1];
        if (value && !seen[value]) {
            seen[value] = true;
            found.push(value);
            if (found.length >= cap) break;
        }
    }
    re.lastIndex = 0;
    return found;
}

function extractOutageModels(text) {
    var models = [];
    OUTAGE_MODEL_RES.forEach(function (re) {
        collectMatches(text, re, OUTAGE_EXTRACT_CAP).forEach(function (model) {
            if (models.indexOf(model) === -1) models.push(model);
        });
    });
    return models;
}

function extractOutageCodes(text) {
    return collectMatches(text, OUTAGE_CODE_RE, OUTAGE_EXTRACT_CAP);
}

// gh-1121 AC5: the honest reset header — names the model list and the codes
// so the comment says "provider outage" instead of guessing "rate limit"
// when the chain answered 5xx. Shared by the story and bug interrupted-leg
// comment builders so both legs word the reset identically.
function outageResetHeaderOf(outage) {
    var models = (outage && outage.models && outage.models.length) ? outage.models.join(', ') : 'unknown models';
    var codes = (outage && outage.codes && outage.codes.length) ? outage.codes.join(', ') : 'transient errors';
    return '⏸️ Provider outage (' + models + ', ' + codes + ') — reset for retry';
}

function extractQuotaWindow(text) {
    var m = /((?:weekly|daily|monthly|hourly|yearly)(?:\s*\([^)]*\))?)\s+(?:usage\s+)?limit/i.exec(text);
    if (m) return m[1];
    m = /((?:7|14|24|30)-day)\s+(?:usage\s+)?limit/i.exec(text);
    if (m) return m[1];
    m = /(usage\s+limit)\s+((?:weekly|daily|monthly|hourly|yearly)(?:\s*\([^)]*\))?)/i.exec(text);
    if (m) return m[2];
    return null;
}

function extractProvider(text) {
    // Live shape: z.ai glm-5.3-flash answered 403 "weekly (7-day) usage limit"
    var m = /([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z]{2,})+)\s+[\w.-]+\s+(?:answered|returned|responded with)\s+403/i.exec(text);
    if (m) return m[1];
    m = /provider\s*[:\["']+\s*([A-Za-z0-9._-]+)/i.exec(text);
    if (m) return m[1];
    m = /(?:^|[\s"'(])([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:ai|com|dev|io|net|org))\b/i.exec(text);
    if (m) return m[1];
    return null;
}

function classifyFailure(text) {
    var t = String(text || '');
    if (!t.trim()) return null;
    var window = extractQuotaWindow(t);
    // Quota ALWAYS wins over transient signals — a mixed chain (429 retries
    // first, 403 usage-limit last) is a quota wall, not a blip.
    if (hasQuotaEvidence(t, window)) {
        return {
            kind: 'quota_exhausted',
            provider: extractProvider(t),
            window: window,
            evidence: quotaEvidenceOf(t)
        };
    }
    // gh-1121: the exhausted-chain tail whose attempts are ONLY transient
    // (5xx / 429 / network — no 401 auth text; 403/quota already excluded by
    // the priority branch above, I1) is a whole-chain OUTAGE, not a blip: the
    // dev leg may resume the persisted fa session once instead of cold-reset.
    var outage = providerOutageClassificationOf(t);
    if (outage) return outage;
    if (RATE_LIMIT_RE.test(t) || TIMEOUT_RE.test(t)) {
        return { kind: 'transient', provider: extractProvider(t), window: null, evidence: null };
    }
    return null;
}

// gh-1121: classifies the exhausted-chain tail whose attempts are ONLY
// transient (5xx / 429 / network — no 401 auth text) as a whole-chain OUTAGE.
// Returns the provider_transient classification object, or null when the text
// is not an outage. Split out of classifyFailure to keep both under the CRAP
// gate (gh-1121 quality run: classifyFailure CC 9 > threshold 8).
function providerOutageClassificationOf(t) {
    if (!CHAIN_EXHAUSTED_RE.test(t) || AUTH_TEXT_RE.test(t)) return null;
    var models = extractOutageModels(t);
    return {
        kind: 'provider_transient',
        provider: models[0] || extractProvider(t),
        models: models,
        codes: extractOutageCodes(t),
        window: null,
        evidence: 'provider chain exhausted'
    };
}

// Quota evidence: a 403 carrying a quota/billing body, an explicit quota
// window, or an exhausted-provider-chain tail that follows quota/403
// responses.
function hasQuotaEvidence(t, window) {
    var has403 = FORBIDDEN_RE.test(t);
    var quotaBody = QUOTA_BODY_RE.test(t);
    return (has403 && quotaBody) || window || (CHAIN_EXHAUSTED_RE.test(t) && (quotaBody || has403));
}

function quotaEvidenceOf(t) {
    if (FORBIDDEN_RE.test(t)) return 'HTTP 403';
    if (CHAIN_EXHAUSTED_RE.test(t)) return 'provider chain exhausted';
    return 'usage limit';
}

function parkLabelOf(jobParams) {
    var label = jobParams && jobParams.quotaParkLabel;
    return (typeof label === 'string' && label.trim()) ? label.trim() : DEFAULT_PARK_LABEL;
}

function probeEveryOf(jobParams) {
    var n = jobParams && parseInt(jobParams.quotaProbeEveryNTicks, 10);
    return (n > 0) ? n : DEFAULT_PROBE_EVERY_TICKS;
}

/**
 * Cheap provider ping — one minimal chat completion against the fa provider
 * config (FA_PROVIDER_BASE_URL / FA_PROVIDER_API_KEY / FA_PROVIDER_MODEL).
 * curl --fail makes a 403 quota wall exit non-zero, so a still-exhausted
 * provider keeps the park. Projects using another provider shape override the
 * whole command via jobParams.quotaProbeCommand.
 */
function probeCommandOf(jobParams) {
    var cmd = jobParams && jobParams.quotaProbeCommand;
    if (typeof cmd === 'string' && cmd.trim()) return cmd;
    return 'bash -c \'curl --fail -sS -m 30 -o /dev/null -X POST "$FA_PROVIDER_BASE_URL/chat/completions" ' +
        '-H "Authorization: Bearer $FA_PROVIDER_API_KEY" -H "Content-Type: application/json" ' +
        '-d "{\\"model\\":\\"$FA_PROVIDER_MODEL\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"ping\\"}],\\"max_tokens\\":1}"\'';
}

// Sensitive header / credential shapes that must never reach SM job logs or
// CI artifacts when an operator overrides jobParams.quotaProbeCommand with an
// inline secret (e.g. -H "Authorization: Bearer sk-...").
var SENSITIVE_VALUE_RE = /((?:authorization|x-api-key|api[-_]?key|token|secret)[\w-]*\s*[:=]\s*(?:bearer\s+)?"?)([^\s'"]+)("?)/gi;
var ENV_REF_RE = /^\$[\w{}]/;

/**
 * gh-1087 review thread 2: the probe command is logged on every probe. The
 * default only references env-var NAMES ($FA_PROVIDER_API_KEY — safe), but a
 * free-form operator override may inline a credential. Mask sensitive values
 * while leaving env-var references (and the safe default) untouched.
 */
function redactCommand(command) {
    return String(command || '').replace(SENSITIVE_VALUE_RE, function (match, prefix, value, suffix) {
        if (ENV_REF_RE.test(value)) return match;
        return prefix + '***' + suffix;
    });
}

// Probe cadence is TICK-based, not attempts-based (gh-1087 review thread 1):
// every SM tick the probe handler records a lightweight 'quota-park-tick: n'
// marker on the ticket, so the completed-tick count advances even between
// probes. A probe fires when the completed tick count is a multiple of
// everyN (0 = first tick after the park — a misclassification self-corrects
// immediately). An attempts-only counter would deadlock: after the first
// failed probe the count is 1 forever and 1 % N never fires probe #2.
function probeDue(completedTicks, everyN) {
    var n = (typeof everyN === 'number' && everyN > 0) ? everyN : DEFAULT_PROBE_EVERY_TICKS;
    return (completedTicks % n) === 0;
}

function tickMarkerLine(count) {
    return 'quota-park-tick: ' + count;
}

function probeMarkerLine(count) {
    return 'quota-probe: ' + count;
}

// Highest <n> across all 'markerRe' lines in the comment bodies (each body is
// a string or a { body: ... } object). The shared counter behind
// countTickMarkers / countProbeMarkers.
function maxMarkerNumber(bodies, markerRe) {
    var count = 0;
    var list = Array.isArray(bodies) ? bodies : [];
    for (var i = 0; i < list.length; i++) {
        var body = String((list[i] && (list[i].body || list[i])) || '');
        markerRe.lastIndex = 0;
        var m;
        while ((m = markerRe.exec(body)) !== null) {
            var n = parseInt(m[1], 10);
            if (n > count) count = n;
        }
    }
    return count;
}

function countTickMarkers(bodies) {
    return maxMarkerNumber(bodies, /^\s*quota-park-tick:\s*(\d+)\s*$/gm);
}

function countProbeMarkers(bodies) {
    return maxMarkerNumber(bodies, /^\s*quota-probe:\s*(\d+)\s*$/gm);
}

function labelsOf(ticket) {
    return (ticket && ticket.labels) ||
        (ticket && ticket.fields && ticket.fields.labels) || [];
}

/**
 * gh-1087 AC2/AC3 — the SM dispatch-lane exclusion. A ticket carrying the
 * park label is skipped by EVERY rule except the quota-probe rule itself
 * (rule.quotaParkProbe === true), which must keep reaching parked tickets to
 * probe the quota window and lift the park.
 */
function shouldSkipForQuotaPark(ticket, rule, jobParams) {
    var label = parkLabelOf(jobParams);
    if (!label) return false;
    if (rule && rule.quotaParkProbe === true) return false;
    return labelsOf(ticket).indexOf(label) !== -1;
}

function parkComment(m, classification, parkLabel, everyN) {
    var provider = (classification && classification.provider) || 'the provider';
    var windowText = (classification && classification.window) || 'usage';
    return m.h(3, '🅿️ Provider Quota Exhausted — Lane Parked') + '\n\n' +
        'The AI development leg hit a hard provider-quota wall: ' + m.bold(provider) + ' answered ' +
        m.bold('HTTP 403') + ' (' + windowText + ' limit) — the whole provider chain is exhausted. ' +
        'Unlike a transient rate limit, an immediate retry is guaranteed to fail again until the quota window resets.\n\n' +
        'The ticket (and its PR, if one exists) is parked with label ' + m.code(parkLabel) + ':\n' +
        '- The ticket is ' + m.bold('NOT') + ' reset to Ready For Development — SM dispatch lanes skip it while the label is present.\n' +
        '- The park self-lifts: the SM runs a bounded probe (one cheap provider ping every ' + everyN + ' ticks, not a full leg) and removes the label on the first success.\n' +
        '- A human can un-park immediately by removing the ' + m.code(parkLabel) + ' label (e.g. after reconfiguring the provider).';
}

function unparkComment(m, parkLabel, probeCount) {
    return m.h(3, '▶️ Provider Quota Probe Succeeded — Lane Un-Parked') + '\n\n' +
        'Probe ' + m.code('#' + probeCount) + ' against the provider succeeded — the quota window has reset (or the provider was reconfigured). ' +
        'The ' + m.code(parkLabel) + ' label is removed and development retries resume on the next SM tick.';
}

function probeFailureComment(m, parkLabel, probeCount, everyN, detail) {
    return m.h(3, '🅿️ Provider Quota Probe Still Blocked') + '\n\n' +
        'Probe ' + m.code('#' + probeCount) + ' against the provider is still quota-blocked' +
        (detail ? ' (' + m.code(detail) + ')' : '') + '. The ' + m.code(parkLabel) +
        ' park stays; the next probe fires in ~' + everyN + ' SM ticks. Remove the label manually to un-park immediately.';
}

module.exports = {
    DEFAULT_PARK_LABEL: DEFAULT_PARK_LABEL,
    DEFAULT_PROBE_EVERY_TICKS: DEFAULT_PROBE_EVERY_TICKS,
    classifyFailure: classifyFailure,
    extractQuotaWindow: extractQuotaWindow,
    extractProvider: extractProvider,
    extractOutageModels: extractOutageModels,
    extractOutageCodes: extractOutageCodes,
    outageResetHeaderOf: outageResetHeaderOf,
    parkLabelOf: parkLabelOf,
    probeEveryOf: probeEveryOf,
    probeCommandOf: probeCommandOf,
    redactCommand: redactCommand,
    probeDue: probeDue,
    tickMarkerLine: tickMarkerLine,
    probeMarkerLine: probeMarkerLine,
    countTickMarkers: countTickMarkers,
    countProbeMarkers: countProbeMarkers,
    shouldSkipForQuotaPark: shouldSkipForQuotaPark,
    parkComment: parkComment,
    unparkComment: unparkComment,
    probeFailureComment: probeFailureComment
};
