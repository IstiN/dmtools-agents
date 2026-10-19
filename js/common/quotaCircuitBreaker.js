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
 *   probeDue(priorCount, everyN)       → is a probe due this tick?
 *   probeMarkerLine(n)                 → durable per-ticket probe counter line
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
    var has403 = FORBIDDEN_RE.test(t);
    var quotaBody = QUOTA_BODY_RE.test(t);
    var chainExhausted = CHAIN_EXHAUSTED_RE.test(t);
    var window = extractQuotaWindow(t);
    // Quota evidence: a 403 carrying a quota/billing body, an explicit quota
    // window, or an exhausted-provider-chain tail that follows quota/403
    // responses. Quota ALWAYS wins over transient signals — a mixed chain
    // (429 retries first, 403 usage-limit last) is a quota wall, not a blip.
    var quota = (has403 && quotaBody) || window || (chainExhausted && (quotaBody || has403));
    if (quota) {
        return {
            kind: 'quota_exhausted',
            provider: extractProvider(t),
            window: window,
            evidence: (has403 ? 'HTTP 403' : (chainExhausted ? 'provider chain exhausted' : 'usage limit'))
        };
    }
    if (RATE_LIMIT_RE.test(t) || TIMEOUT_RE.test(t)) {
        return { kind: 'transient', provider: extractProvider(t), window: null, evidence: null };
    }
    return null;
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
    return 'bash -c \'curl -fsS -m 30 -o /dev/null -X POST "$FA_PROVIDER_BASE_URL/chat/completions" ' +
        '-H "Authorization: Bearer $FA_PROVIDER_API_KEY" -H "Content-Type: application/json" ' +
        '-d "{\\"model\\":\\"$FA_PROVIDER_MODEL\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"ping\\"}],\\"max_tokens\\":1}"\'';
}

// Probe cadence is COUNT-based, not wall-clock: each recorded probe posts a
// 'quota-probe: <n>' marker line on the ticket, so a probe fires on ticks
// where the recorded count is a multiple of everyN (0 = first tick after the
// park — a misclassification self-corrects immediately).
function probeDue(priorProbeCount, everyN) {
    var n = (typeof everyN === 'number' && everyN > 0) ? everyN : DEFAULT_PROBE_EVERY_TICKS;
    return (priorProbeCount % n) === 0;
}

function probeMarkerLine(count) {
    return 'quota-probe: ' + count;
}

function countProbeMarkers(bodies) {
    var count = 0;
    var re = /^\s*quota-probe:\s*(\d+)\s*$/gm;
    var list = Array.isArray(bodies) ? bodies : [];
    for (var i = 0; i < list.length; i++) {
        var body = String((list[i] && (list[i].body || list[i])) || '');
        re.lastIndex = 0;
        var m;
        while ((m = re.exec(body)) !== null) {
            var n = parseInt(m[1], 10);
            if (n > count) count = n;
        }
    }
    return count;
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
    var labels = (ticket && ticket.labels) ||
        (ticket && ticket.fields && ticket.fields.labels) || [];
    return labels.indexOf(label) !== -1;
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
    parkLabelOf: parkLabelOf,
    probeEveryOf: probeEveryOf,
    probeCommandOf: probeCommandOf,
    probeDue: probeDue,
    probeMarkerLine: probeMarkerLine,
    countProbeMarkers: countProbeMarkers,
    shouldSkipForQuotaPark: shouldSkipForQuotaPark,
    parkComment: parkComment,
    unparkComment: unparkComment,
    probeFailureComment: probeFailureComment
};
