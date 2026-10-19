var configLoader = require('./configLoader.js');
// gh-1108: ONE run-title vocabulary (issue/pr anchors + legs) with the
// event-dedup module, and the fa gh-781 producer's gh transport for the
// tokens publish — both pure, both required at the top (hoisted per the
// pack-require rule: init-time requires resolve file-relative).
var teammateEventDedup = require('./common/teammateEventDedup.js');
var tokenUsage = require('./factory/token_usage.js');

/**
 * AI Teammate Token Usage Reporter (JSRunner)
 *
 * Downloads completed GitHub Actions logs for ai-teammate runs, extracts Copilot
 * token summaries printed by CommandLineUtils, and writes CSV/JSON/HTML outputs.
 *
 * gh-1108: the same scan also projects the rows into the keyed per-leg tokens
 * map the factory tick consumes ({'pr-N'/'issue-N': [{leg, at, prompt,
 * completion, total, cacheRead, model}]}) and — opt-in, customParams
 * publishTokens — publishes it to the factory-data branch as
 * data/<tokensAsset>.json, completing the producer→publish→tick link
 * (dm.ai board TOKENS · R/W for this factory).
 */

function parseJson(raw, fallback) {
    if (raw == null) return fallback;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function asArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value.workflow_runs && Array.isArray(value.workflow_runs)) return value.workflow_runs;
    if (value.jobs && Array.isArray(value.jobs)) return value.jobs;
    if (value.result) return asArray(parseJson(value.result, value.result));
    return [];
}

function parseNumberWithSuffix(raw) {
    if (raw == null) return 0;
    var text = String(raw).trim().toLowerCase().replace(/,/g, '');
    var match = text.match(/^([0-9]+(?:\.[0-9]+)?)([kmb])?$/);
    if (!match) return 0;
    var value = parseFloat(match[1]);
    var suffix = match[2] || '';
    if (suffix === 'k') value *= 1000;
    if (suffix === 'm') value *= 1000000;
    if (suffix === 'b') value *= 1000000000;
    return Math.round(value);
}

function parseRequestsLine(line) {
    var match = String(line || '').match(/Requests\s+([0-9]+)\s+([^(\n\r]+)?(?:\(([^)]+)\))?/);
    if (!match) return null;
    return {
        requests: parseInt(match[1], 10) || 0,
        requestTier: (match[2] || '').trim(),
        requestDuration: (match[3] || '').trim()
    };
}

// Extracts the JSON payload of an fa-tokens ledger line by balanced-brace
// scanning, so a payload wrapped in a larger log line (or followed by trailing
// text) is found reliably. Returns null when no complete {...} object follows
// the 'fa-tokens:' marker.
function extractFaPayload(text) {
    var marker = String(text || '').indexOf('fa-tokens:');
    if (marker === -1) return null;
    var start = text.indexOf('{', marker);
    if (start === -1) return null;
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < text.length; i++) {
        var ch = text.charAt(i);
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.substring(start, i + 1);
        }
    }
    return null;
}

function parseTokensLine(line) {
    var text = String(line || '');

    // fa ledger log line (resume-aware): fa-tokens: {"sessionId":...,"segment":N,
    // "input":...,"output":...,"cacheRead":...,"requests":...,"source":"reported"|"estimated"}
    var faPayload = extractFaPayload(text);
    if (faPayload != null) {
        var payload = parseJson(faPayload, null);
        // Only consume the line as an fa ledger entry when the payload is a
        // valid object carrying token counts; otherwise fall through to the
        // CommandLineUtils parsing below so the line is not silently dropped.
        if (payload && typeof payload === 'object' &&
            (payload.input != null || payload.output != null || payload.cacheRead != null)) {
            var faSegment = parseInt(payload.segment, 10);
            return {
                readTokens: parseInt(payload.input, 10) || 0,
                writeTokens: parseInt(payload.output, 10) || 0,
                cachedTokens: parseInt(payload.cacheRead, 10) || 0,
                reasoningTokens: 0,
                requests: parseInt(payload.requests, 10) || 0,
                requestTier: '',
                requestDuration: '',
                source: String(payload.source || ''),
                faSessionId: String(payload.sessionId || ''),
                faSegment: isNaN(faSegment) ? null : faSegment,
                rawTokensLine: text.trim()
            };
        }
    }

    if (text.indexOf('Tokens') === -1) return null;

    var readMatch = text.match(/(?:↑|\^|read(?:\s+tokens?)?)\s*([0-9][0-9.,]*\s*[kmb]?)/i);
    var writeMatch = text.match(/(?:↓|v|write(?:\s+tokens?)?)\s*([0-9][0-9.,]*\s*[kmb]?)/i);
    var cachedMatch = text.match(/([0-9][0-9.,]*\s*[kmb]?)\s*\(cached\)/i);
    var reasoningMatch = text.match(/([0-9][0-9.,]*\s*[kmb]?)\s*\(reasoning\)/i);

    if (!readMatch && !writeMatch && !cachedMatch && !reasoningMatch) return null;
    return {
        readTokens: parseNumberWithSuffix(readMatch && readMatch[1]),
        writeTokens: parseNumberWithSuffix(writeMatch && writeMatch[1]),
        cachedTokens: parseNumberWithSuffix(cachedMatch && cachedMatch[1]),
        reasoningTokens: parseNumberWithSuffix(reasoningMatch && reasoningMatch[1]),
        rawTokensLine: text.trim()
    };
}

function newUsageTracking() {
    return {
        lastRequests: null,
        samples: [],
        seenFaSegments: {},
        resumeDetected: false,
        resumeStages: [],
        feedbackLoopCount: 0,
        rateLimitRetryCount: 0,
        rateLimitDetected: false,
        timeoutCount: 0
    };
}

// Classifies one log line's resume markers: a feedback-loop line carries its
// stage, while a bare '--resume' / 'run-agent.sh --continue' marker only flags
// the resume. The feedback-loop shape wins when a line matches both.
function parseResumeSignal(line) {
    var resumeMatch = line.match(/Feedback loop: resuming agent for\s+(.+?)\s+attempt\s+([0-9]+)\/([0-9]+)/);
    if (resumeMatch) {
        return { resumed: true, feedbackStage: (resumeMatch[1] || 'resume') + ' ' + resumeMatch[2] + '/' + resumeMatch[3] };
    }
    // 'run-agent.sh --continue' (without '--resume') is the recovery command shape
    // used since --continue and --resume were found to be mutually exclusive in the
    // Copilot CLI; kept alongside the older '--continue --resume' shape (still
    // matched via the '--resume' check above) so historical logs still parse.
    if (line.indexOf('--resume') !== -1 || line.indexOf('run-agent.sh --continue') !== -1) {
        return { resumed: true, feedbackStage: null };
    }
    return { resumed: false, feedbackStage: null };
}

// Classifies one log line's rate-limit signals: only the explicit Copilot
// retry wording counts a retry; the looser wording only flags detection.
function parseRateLimitSignal(line) {
    if (/Copilot rate limit detected; retrying/i.test(line)) {
        return { retry: true, detected: true };
    }
    return { retry: false, detected: /rate limit|limit reset|You've hit your rate limit/i.test(line) };
}

function isTimeoutLine(lower) {
    return lower.indexOf('exit code 124') !== -1 ||
        lower.indexOf('timed out') !== -1 ||
        lower.indexOf('command timeout') !== -1 ||
        lower.indexOf('timeout guard') !== -1;
}

function applyResumeSignal(tracking, signal) {
    if (!signal.resumed) return;
    tracking.resumeDetected = true;
    if (signal.feedbackStage) {
        tracking.feedbackLoopCount += 1;
        tracking.resumeStages.push(signal.feedbackStage);
    }
}

function applyRateLimitSignal(tracking, signal) {
    if (signal.retry) tracking.rateLimitRetryCount += 1;
    if (signal.detected) tracking.rateLimitDetected = true;
}

// Applies one log line's resume / rate-limit / timeout signals to the tracking
// state, preserving the original scan order.
function applyLogSignals(tracking, line, lower) {
    applyResumeSignal(tracking, parseResumeSignal(line));
    applyRateLimitSignal(tracking, parseRateLimitSignal(line));
    if (isTimeoutLine(lower)) tracking.timeoutCount += 1;
}

// The fa ledger is resume-aware: the same sessionId emits one line per
// segment, so dedupe by (sessionId, segment) to avoid double-counting
// resumed segments if a line is replayed in the logs. Lines without a
// segment field keep faSegment null and are never deduped. Returns true when
// the tokens sample is a replay that must be skipped.
function isFaSegmentReplay(tracking, tokens) {
    if (!tokens.faSessionId || tokens.faSegment == null) return false;
    var segmentKey = tokens.faSessionId + ':' + tokens.faSegment;
    if (tracking.seenFaSegments[segmentKey]) return true;
    tracking.seenFaSegments[segmentKey] = true;
    return false;
}

function appendUsageSample(tracking, tokens) {
    var base = { attemptIndex: tracking.samples.length + 1 };
    if (tokens.requests == null && tracking.lastRequests) base = Object.assign(base, tracking.lastRequests);
    tracking.samples.push(Object.assign(base, tokens));
}

function collectUsageSamples(tracking, lines) {
    for (var i = 0; i < lines.length; i++) {
        var line = String(lines[i] || '');
        applyLogSignals(tracking, line, line.toLowerCase());
        var request = parseRequestsLine(lines[i]);
        if (request) {
            tracking.lastRequests = request;
            continue;
        }
        var tokens = parseTokensLine(lines[i]);
        if (tokens && !isFaSegmentReplay(tracking, tokens)) {
            appendUsageSample(tracking, tokens);
        }
    }
}

function collectFaSourceKeys(samples) {
    var faSources = {};
    samples.forEach(function(sample) {
        if (sample.source) faSources[sample.source] = true;
    });
    return Object.keys(faSources).sort();
}

// '', the single source when all samples agree, or 'mixed' when they disagree.
function usageSourceLabel(faSourceKeys) {
    if (faSourceKeys.length === 0) return '';
    if (faSourceKeys.length === 1) return faSourceKeys[0];
    return 'mixed';
}

// Sums the per-sample token/request counters into the aggregate.
function sumUsageSamples(aggregate, samples) {
    samples.forEach(function(sample) {
        aggregate.requests += sample.requests || 0;
        aggregate.readTokens += sample.readTokens || 0;
        aggregate.writeTokens += sample.writeTokens || 0;
        aggregate.cachedTokens += sample.cachedTokens || 0;
        aggregate.reasoningTokens += sample.reasoningTokens || 0;
    });
    return aggregate;
}

function buildUsageAggregate(tracking) {
    if (!tracking.samples.length) return null;
    var finalSample = tracking.samples[tracking.samples.length - 1];
    var aggregate = {
        source: usageSourceLabel(collectFaSourceKeys(tracking.samples)),
        requests: 0,
        requestTier: finalSample.requestTier || '',
        requestDuration: finalSample.requestDuration || '',
        readTokens: 0,
        writeTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        samples: tracking.samples.length,
        resumeDetected: tracking.resumeDetected || tracking.samples.length > 1,
        resumeStages: tracking.resumeStages,
        feedbackLoopCount: tracking.feedbackLoopCount,
        rateLimitRetryCount: tracking.rateLimitRetryCount,
        rateLimitDetected: tracking.rateLimitDetected,
        timeoutCount: tracking.timeoutCount,
        attempts: tracking.samples
    };
    return sumUsageSamples(aggregate, tracking.samples);
}

function extractTokenUsage(logs) {
    var tracking = newUsageTracking();
    collectUsageSamples(tracking, String(logs || '').split(/\r?\n/));
    return buildUsageAggregate(tracking);
}

function normalizeLogPayload(raw) {
    if (raw == null) return '';
    if (typeof raw !== 'string') {
        if (raw.result) return normalizeLogPayload(raw.result);
        if (raw.logs) return normalizeLogPayload(raw.logs);
        return JSON.stringify(raw);
    }
    var parsed = parseJson(raw, null);
    if (parsed && parsed.result) return normalizeLogPayload(parsed.result);
    if (parsed && parsed.logs) return normalizeLogPayload(parsed.logs);
    return raw;
}

function getRunTitle(run) {
    return run.display_title || run.displayTitle || run.name || run.run_name || '';
}

function extractAgentAndKey(run) {
    var title = getRunTitle(run);
    var parts = title.split(/\s+:\s+/);
    var configFile = parts[0] || '';
    var agent = configFile.replace(/^.*\//, '').replace(/\.json$/, '') || 'unknown';
    var keyMatch = title.match(/[A-Z][A-Z0-9]+-\d+/);
    return {
        title: title,
        configFile: configFile,
        agent: agent,
        ticketKey: keyMatch ? keyMatch[0] : ''
    };
}

function isoDay(value) {
    if (!value) return '';
    return String(value).substring(0, 10);
}

function todayIsoDay() {
    return new Date().toISOString().substring(0, 10);
}

function toWindowStart(value) {
    var text = String(value || todayIsoDay());
    return text.length === 10 ? text + 'T00:00:00Z' : text;
}

function toWindowEnd(value) {
    var text = String(value || todayIsoDay());
    return text.length === 10 ? text + 'T23:59:59Z' : text;
}

function formatWindowTime(ms) {
    return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function addMilliseconds(iso, count) {
    return formatWindowTime(Date.parse(iso) + count);
}

function midpointTime(startIso, endIso) {
    return formatWindowTime(Math.floor((Date.parse(startIso) + Date.parse(endIso)) / 2));
}

function toCsvValue(value) {
    if (value == null) return '';
    var text = String(value);
    if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
}

function buildCsv(rows) {
    var headers = [
        'runId', 'runNumber', 'createdAt', 'startedAt', 'updatedAt', 'day',
        'conclusion', 'agent', 'ticketKey', 'configFile', 'title',
        'durationSeconds', 'duration',
        'requests', 'requestTier', 'requestDuration',
        'readTokens', 'writeTokens', 'cachedTokens', 'reasoningTokens',
        'samples', 'resumeDetected', 'resumeStages',
        'feedbackLoopCount', 'rateLimitRetryCount', 'rateLimitDetected', 'timeoutCount',
        'source', 'url'
    ];
    var out = [headers.join(',')];
    rows.forEach(function(row) {
        out.push(headers.map(function(key) { return toCsvValue(row[key]); }).join(','));
    });
    return out.join('\n') + '\n';
}

function buildAttemptsCsv(attemptRows) {
    var headers = [
        'runId', 'runNumber', 'createdAt', 'day', 'conclusion', 'durationSeconds', 'duration',
        'agent', 'ticketKey', 'attemptIndex', 'resumeDetected',
        'feedbackLoopCount', 'rateLimitRetryCount', 'rateLimitDetected', 'timeoutCount',
        'requests', 'requestTier', 'requestDuration',
        'readTokens', 'writeTokens', 'cachedTokens', 'reasoningTokens',
        'rawTokensLine', 'source', 'url'
    ];
    var out = [headers.join(',')];
    attemptRows.forEach(function(row) {
        out.push(headers.map(function(key) { return toCsvValue(row[key]); }).join(','));
    });
    return out.join('\n') + '\n';
}

function groupBy(rows, keyFn) {
    var map = {};
    rows.forEach(function(row) {
        var key = keyFn(row) || 'unknown';
        if (!map[key]) {
            map[key] = {
                key: key,
                runs: 0,
                requests: 0,
                readTokens: 0,
                writeTokens: 0,
                cachedTokens: 0,
                reasoningTokens: 0,
                samples: 0,
                resumedRuns: 0,
                feedbackLoopCount: 0,
                rateLimitRetryCount: 0,
                rateLimitRuns: 0,
                timeoutCount: 0,
                timeoutRuns: 0,
                durationSeconds: 0,
                durationRuns: 0
            };
        }
        var bucket = map[key];
        bucket.runs += 1;
        bucket.requests += row.requests || 0;
        bucket.readTokens += row.readTokens || 0;
        bucket.writeTokens += row.writeTokens || 0;
        bucket.cachedTokens += row.cachedTokens || 0;
        bucket.reasoningTokens += row.reasoningTokens || 0;
        bucket.samples += row.samples || 0;
        if (row.resumeDetected) bucket.resumedRuns += 1;
        bucket.feedbackLoopCount += row.feedbackLoopCount || 0;
        bucket.rateLimitRetryCount += row.rateLimitRetryCount || 0;
        if (row.rateLimitDetected) bucket.rateLimitRuns += 1;
        bucket.timeoutCount += row.timeoutCount || 0;
        if (row.timeoutCount) bucket.timeoutRuns += 1;
        bucket.durationSeconds += row.durationSeconds || 0;
        if (row.durationSeconds) bucket.durationRuns += 1;
    });
    return Object.keys(map).sort().map(function(key) {
        var item = map[key];
        item.avgReadTokens = item.runs ? Math.round(item.readTokens / item.runs) : 0;
        item.avgWriteTokens = item.runs ? Math.round(item.writeTokens / item.runs) : 0;
        item.avgCachedTokens = item.runs ? Math.round(item.cachedTokens / item.runs) : 0;
        item.avgReasoningTokens = item.runs ? Math.round(item.reasoningTokens / item.runs) : 0;
        item.avgDurationSeconds = item.durationRuns ? Math.round(item.durationSeconds / item.durationRuns) : 0;
        item.avgDuration = formatDuration(item.avgDurationSeconds);
        item.totalDuration = formatDuration(item.durationSeconds);
        return item;
    });
}

function formatShort(value) {
    value = value || 0;
    if (value >= 1000000000) return (value / 1000000000).toFixed(1).replace(/\.0$/, '') + 'b';
    if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
    if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(value);
}

function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds || 0));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secs = seconds % 60;
    if (hours) return hours + 'h ' + minutes + 'm';
    if (minutes) return minutes + 'm ' + secs + 's';
    return secs + 's';
}

function calculateDurationSeconds(run) {
    run = run || {};
    var start = run.run_started_at || run.runStartedAt || run.started_at || run.startedAt || run.created_at || run.createdAt;
    var end = run.updated_at || run.updatedAt || run.completed_at || run.completedAt;
    var startMs = Date.parse(start || '');
    var endMs = Date.parse(end || '');
    if (isNaN(startMs) || isNaN(endMs) || endMs < startMs) return 0;
    return Math.round((endMs - startMs) / 1000);
}

function calculateRunnerStats(rows) {
    var intervals = [];
    var totalSeconds = 0;
    rows.forEach(function(row) {
        var durationSeconds = row.durationSeconds || 0;
        totalSeconds += durationSeconds;
        var startMs = Date.parse(row.startedAt || row.createdAt || '');
        var endMs = Date.parse(row.updatedAt || '');
        if (isNaN(startMs) && !isNaN(Date.parse(row.createdAt || ''))) startMs = Date.parse(row.createdAt);
        if ((isNaN(endMs) || endMs < startMs) && !isNaN(startMs) && durationSeconds > 0) {
            endMs = startMs + durationSeconds * 1000;
        }
        if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) return;
        intervals.push({ start: startMs, end: endMs });
    });

    var events = [];
    intervals.forEach(function(interval) {
        events.push({ time: interval.start, delta: 1 });
        events.push({ time: interval.end, delta: -1 });
    });
    events.sort(function(a, b) {
        if (a.time !== b.time) return a.time - b.time;
        return a.delta - b.delta;
    });

    var concurrent = 0;
    var maxConcurrent = 0;
    events.forEach(function(event) {
        concurrent += event.delta;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    });

    var minStart = intervals.length ? intervals[0].start : 0;
    var maxEnd = intervals.length ? intervals[0].end : 0;
    intervals.forEach(function(interval) {
        if (interval.start < minStart) minStart = interval.start;
        if (interval.end > maxEnd) maxEnd = interval.end;
    });
    var wallSeconds = intervals.length && maxEnd > minStart ? Math.round((maxEnd - minStart) / 1000) : 0;
    var avgConcurrent = wallSeconds ? totalSeconds / wallSeconds : 0;

    return {
        totalRunnerSeconds: totalSeconds,
        totalRunnerTime: formatDuration(totalSeconds),
        totalRunnerDays: Math.round((totalSeconds / 86400) * 10) / 10,
        intervalRuns: intervals.length,
        wallSeconds: wallSeconds,
        wallTime: formatDuration(wallSeconds),
        maxConcurrentRuns: maxConcurrent,
        avgConcurrentRuns: Math.round(avgConcurrent * 10) / 10
    };
}

function htmlEscape(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function sortAttr(value) {
    return ' data-sort="' + htmlEscape(value == null ? '' : value) + '"';
}

function buildHtml(rows, summary) {
    var payload = JSON.stringify({ rows: rows, summary: summary })
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/'/g, '\\u0027')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    var topAgents = summary.byAgent.slice().sort(function(a, b) {
        return (b.readTokens + b.writeTokens + b.cachedTokens + b.reasoningTokens) -
               (a.readTokens + a.writeTokens + a.cachedTokens + a.reasoningTokens);
    }).slice(0, 20);
    var recentRows = rows.slice().sort(function(a, b) {
        return String(b.createdAt).localeCompare(String(a.createdAt));
    }).slice(0, 200);

    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '<title>AI Teammate Token Usage</title>\n<style>\n' +
        ':root{color-scheme:light;--bg:#f6f7f9;--panel:#fff;--ink:#18202a;--muted:#5f6b7a;--grid:#e1e5ea;--blue:#2563eb;--green:#059669;--amber:#b7791f;--red:#dc2626;--violet:#7c3aed}' +
        '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}' +
        'header{padding:24px 28px 12px}h1{margin:0 0 6px;font-size:26px;letter-spacing:0}p{margin:0;color:var(--muted)}' +
        '.wrap{padding:12px 28px 32px;display:grid;gap:16px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:12px}' +
        '.kpi,.panel{background:var(--panel);border:1px solid var(--grid);border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.04)}.kpi{padding:14px}.kpi b{display:block;font-size:22px;margin-top:4px}.kpi span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}' +
        '.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}.panel{padding:16px}.panel h2{font-size:16px;margin:0 0 12px}.chart{width:100%;height:340px;display:block}.pie{height:300px}' +
        'table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border-bottom:1px solid var(--grid);text-align:left;white-space:nowrap}th{font-size:12px;color:var(--muted);font-weight:600}th.sortable{cursor:pointer;user-select:none}th.sortable:after{content:"";display:inline-block;margin-left:5px;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #9aa4b2;vertical-align:middle}th.sortable.desc:after{border-top:0;border-bottom:5px solid #9aa4b2}td.num{text-align:right;font-variant-numeric:tabular-nums}.scroll{overflow:auto;max-height:520px}' +
        '.legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;color:var(--muted);font-size:12px}.dot{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:5px}.tooltip{position:fixed;z-index:10;display:none;max-width:260px;padding:8px 10px;border:1px solid #cfd6df;border-radius:6px;background:#111827;color:#fff;font-size:12px;line-height:1.4;box-shadow:0 8px 20px rgba(0,0,0,.18);pointer-events:none;white-space:pre-line}' +
        '.src-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;line-height:1.5;border:1px solid transparent}.src-rep{background:#ecfdf5;color:#047857;border-color:#a7f3d0}.src-est{background:#fffbeb;color:#b45309;border-style:dashed;border-color:#f59e0b}.src-unknown{background:#f1f5f9;color:#475569;border-style:dotted;border-color:#cbd5e1}.row-est td{background:#fffbeb}' +
        '@media(max-width:900px){.kpis,.grid{grid-template-columns:1fr}.wrap,header{padding-left:16px;padding-right:16px}}\n' +
        '</style>\n</head>\n<body>\n<header><h1>AI Teammate Token Usage</h1><p>Generated ' + htmlEscape(summary.generatedAt) + ' from completed workflow logs.</p></header>\n' +
        '<main class="wrap">\n<section class="kpis">' +
        '<div class="kpi"><span>Runs Parsed</span><b>' + summary.runsWithTokens + '</b></div>' +
        '<div class="kpi"><span>Attempts</span><b>' + summary.totals.samples + '</b></div>' +
        '<div class="kpi"><span>Resume Runs</span><b>' + summary.totals.resumedRuns + '</b></div>' +
        '<div class="kpi"><span>Loops</span><b>' + summary.totals.feedbackLoopCount + '</b></div>' +
        '<div class="kpi"><span>Limit Retries</span><b>' + summary.totals.rateLimitRetryCount + '</b></div>' +
        '<div class="kpi"><span>Timeouts</span><b>' + summary.totals.timeoutCount + '</b></div>' +
        '<div class="kpi"><span>Avg Duration</span><b>' + htmlEscape(summary.totals.avgDuration || '0s') + '</b></div>' +
        '<div class="kpi"><span>Runner Time</span><b>' + htmlEscape(summary.runnerStats.totalRunnerTime || '0s') + '</b></div>' +
        '<div class="kpi"><span>Runner Days</span><b>' + htmlEscape(summary.runnerStats.totalRunnerDays || 0) + '</b></div>' +
        '<div class="kpi"><span>Max Runners</span><b>' + htmlEscape(summary.runnerStats.maxConcurrentRuns || 0) + '</b></div>' +
        '<div class="kpi"><span>Avg Runners</span><b>' + htmlEscape(summary.runnerStats.avgConcurrentRuns || 0) + '</b></div>' +
        '<div class="kpi"><span>Read Tokens</span><b>' + formatShort(summary.totals.readTokens) + '</b></div>' +
        '<div class="kpi"><span>Write Tokens</span><b>' + formatShort(summary.totals.writeTokens) + '</b></div>' +
        '<div class="kpi"><span>Cached Tokens</span><b>' + formatShort(summary.totals.cachedTokens) + '</b></div>' +
        '<div class="kpi"><span>Reasoning Tokens</span><b>' + formatShort(summary.totals.reasoningTokens) + '</b></div>' +
        '</section>\n<section class="grid"><div class="panel"><h2>Daily Token Trend</h2><canvas id="daily" class="chart"></canvas><div class="legend"><span><i class="dot" style="background:#2563eb"></i>read</span><span><i class="dot" style="background:#059669"></i>write</span><span><i class="dot" style="background:#b7791f"></i>cached</span><span><i class="dot" style="background:#dc2626"></i>reasoning</span><span><i class="dot" style="background:#ef4444;border-radius:50%"></i>fails with limits</span></div></div>' +
        '<div class="panel"><h2>Tokens By Agent</h2><canvas id="agents" class="chart"></canvas></div></section>\n' +
        '<section class="grid"><div class="panel"><h2>Daily Runner Time</h2><canvas id="runnerDaily" class="chart"></canvas><div class="legend"><span><i class="dot" style="background:#0891b2"></i>runner time</span><span><i class="dot" style="background:#ef4444;border-radius:50%"></i>fails with limits</span></div></div>' +
        '<div class="panel"><h2>Runs By Day</h2><canvas id="runsDaily" class="chart"></canvas></div></section>\n' +
        '<section class="grid"><div class="panel"><h2>Runner Time By Agent</h2><canvas id="runnerAgents" class="chart"></canvas></div>' +
        '<div class="panel"><h2>Avg Run Time By Agent</h2><canvas id="avgRunnerAgents" class="chart"></canvas></div></section>\n' +
        '<section class="grid"><div class="panel"><h2>Agent Token Share</h2><canvas id="agentPie" class="chart pie"></canvas><div id="agentPieLegend" class="legend"></div></div>' +
        '<div class="panel"><h2>Token Type Share</h2><canvas id="tokenPie" class="chart pie"></canvas><div id="tokenPieLegend" class="legend"></div></div></section>\n' +
        '<section class="panel"><h2>Agent Totals And Averages</h2><div class="scroll"><table id="agentTable"><thead><tr><th class="sortable" data-type="text">Agent</th><th class="sortable" data-type="number">Runs</th><th class="sortable" data-type="number">Attempts</th><th class="sortable" data-type="number">Resume Runs</th><th class="sortable" data-type="number">Loops</th><th class="sortable" data-type="number">Limit Retries</th><th class="sortable" data-type="number">Timeouts</th><th class="sortable" data-type="number">Runner Time</th><th class="sortable" data-type="number">Avg Duration</th><th class="sortable" data-type="number">Read</th><th class="sortable" data-type="number">Avg Read</th><th class="sortable" data-type="number">Write</th><th class="sortable" data-type="number">Avg Write</th><th class="sortable" data-type="number">Cached</th><th class="sortable" data-type="number">Reasoning</th></tr></thead><tbody>' +
        topAgents.map(function(a) {
            return '<tr><td' + sortAttr(a.key) + '>' + htmlEscape(a.key) + '</td><td class="num"' + sortAttr(a.runs) + '>' + a.runs + '</td><td class="num"' + sortAttr(a.samples) + '>' + a.samples + '</td><td class="num"' + sortAttr(a.resumedRuns) + '>' + a.resumedRuns + '</td><td class="num"' + sortAttr(a.feedbackLoopCount) + '>' + a.feedbackLoopCount + '</td><td class="num"' + sortAttr(a.rateLimitRetryCount) + '>' + a.rateLimitRetryCount + '</td><td class="num"' + sortAttr(a.timeoutCount) + '>' + a.timeoutCount + '</td><td class="num"' + sortAttr(a.durationSeconds) + '>' + htmlEscape(a.totalDuration || '0s') + '</td><td class="num"' + sortAttr(a.avgDurationSeconds) + '>' + htmlEscape(a.avgDuration || '0s') + '</td><td class="num"' + sortAttr(a.readTokens) + '>' + formatShort(a.readTokens) + '</td><td class="num"' + sortAttr(a.avgReadTokens) + '>' + formatShort(a.avgReadTokens) + '</td><td class="num"' + sortAttr(a.writeTokens) + '>' + formatShort(a.writeTokens) + '</td><td class="num"' + sortAttr(a.avgWriteTokens) + '>' + formatShort(a.avgWriteTokens) + '</td><td class="num"' + sortAttr(a.cachedTokens) + '>' + formatShort(a.cachedTokens) + '</td><td class="num"' + sortAttr(a.reasoningTokens) + '>' + formatShort(a.reasoningTokens) + '</td></tr>';
        }).join('') +
        '</tbody></table></div></section>\n' +
        '<section class="panel"><h2>Recent Runs</h2><div class="scroll"><table id="runsTable"><thead><tr><th class="sortable" data-type="text">Created</th><th class="sortable" data-type="text">Agent</th><th class="sortable" data-type="text">Key</th><th class="sortable" data-type="text">Conclusion</th><th class="sortable" data-type="number">Duration</th><th class="sortable" data-type="number">Attempts</th><th class="sortable" data-type="text">Resume</th><th class="sortable" data-type="number">Loops</th><th class="sortable" data-type="number">Limit Retries</th><th class="sortable" data-type="number">Timeouts</th><th class="sortable" data-type="number">Read</th><th class="sortable" data-type="number">Write</th><th class="sortable" data-type="number">Cached</th><th class="sortable" data-type="number">Reasoning</th><th class="sortable" data-type="text">Source</th><th class="sortable" data-type="number">Run</th></tr></thead><tbody>' +
        recentRows.map(function(r) {
            var rowClass = r.source === 'estimated' ? '<tr class="row-est">' : '<tr>';
            var sourceBadge = '';
            if (r.source) {
                var srcClass = r.source === 'estimated' ? 'src-est' : (r.source === 'reported' ? 'src-rep' : 'src-unknown');
                sourceBadge = '<span class="src-badge ' + srcClass + '">' + htmlEscape(r.source) + '</span>';
            }
            return rowClass + '<td' + sortAttr(r.createdAt) + '>' + htmlEscape(r.createdAt) + '</td><td' + sortAttr(r.agent) + '>' + htmlEscape(r.agent) + '</td><td' + sortAttr(r.ticketKey) + '>' + htmlEscape(r.ticketKey) + '</td><td' + sortAttr(r.conclusion) + '>' + htmlEscape(r.conclusion) + '</td><td class="num"' + sortAttr(r.durationSeconds) + '>' + htmlEscape(r.duration || '0s') + '</td><td class="num"' + sortAttr(r.samples) + '>' + htmlEscape(r.samples || 1) + '</td><td' + sortAttr(r.resumeDetected ? 'yes' : 'no') + '>' + (r.resumeDetected ? 'yes' : 'no') + '</td><td class="num"' + sortAttr(r.feedbackLoopCount) + '>' + (r.feedbackLoopCount || 0) + '</td><td class="num"' + sortAttr(r.rateLimitRetryCount) + '>' + (r.rateLimitRetryCount || 0) + '</td><td class="num"' + sortAttr(r.timeoutCount) + '>' + (r.timeoutCount || 0) + '</td><td class="num"' + sortAttr(r.readTokens) + '>' + formatShort(r.readTokens) + '</td><td class="num"' + sortAttr(r.writeTokens) + '>' + formatShort(r.writeTokens) + '</td><td class="num"' + sortAttr(r.cachedTokens) + '>' + formatShort(r.cachedTokens) + '</td><td class="num"' + sortAttr(r.reasoningTokens) + '>' + formatShort(r.reasoningTokens) + '</td><td' + sortAttr(r.source || '') + '>' + sourceBadge + '</td><td' + sortAttr(r.runNumber) + '><a href="' + htmlEscape(r.url) + '">#' + htmlEscape(r.runNumber) + '</a></td></tr>';
        }).join('') +
        '</tbody></table></div></section>\n</main><div id="chartTooltip" class="tooltip"></div>\n<script>const DATA=JSON.parse("' + payload + '");\n' +
        'function short(v){v=v||0;if(v>=1e9)return(v/1e9).toFixed(1).replace(/\\.0$/,"")+"b";if(v>=1e6)return(v/1e6).toFixed(1).replace(/\\.0$/,"")+"m";if(v>=1e3)return(v/1e3).toFixed(1).replace(/\\.0$/,"")+"k";return String(v)}' +
        'function dur(v){v=Math.max(0,Math.round(v||0));const d=Math.floor(v/86400),h=Math.floor(v%86400/3600),m=Math.floor(v%3600/60),s=v%60;if(d)return d+"d "+h+"h";if(h)return h+"h "+m+"m";if(m)return m+"m "+s+"s";return s+"s"}' +
        'function labelLines(label,mode){let text=String(label||"");if(mode==="date")text=text.slice(5);if(mode==="agent"){const chunks=text.split("_");const lines=[];let line="";chunks.forEach(part=>{const next=line?line+"_"+part:part;if(next.length>14&&line){lines.push(line);line=part}else line=next});if(line)lines.push(line);return lines.slice(0,4)}return [text]}' +
        'function tip(){return document.getElementById("chartTooltip")}function showTip(ev,text){const t=tip();if(!t)return;t.textContent=text;t.style.display="block";const x=Math.min(innerWidth-280,ev.clientX+14),y=Math.min(innerHeight-120,ev.clientY+14);t.style.left=Math.max(8,x)+"px";t.style.top=Math.max(8,y)+"px"}function hideTip(){const t=tip();if(t)t.style.display="none"}' +
        'function bindTooltip(c,items){c._items=items;c.onmousemove=e=>{const r=c.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,hit=(c._items||[]).find(it=>x>=it.x&&x<=it.x+it.w&&y>=it.y&&y<=it.y+it.h);if(hit)showTip(e,hit.text);else hideTip()};c.onmouseleave=hideTip}' +
        'function drawBars(id, labels, series, options){options=options||{};const fmt=options.valueFormat==="duration"?dur:short;const c=document.getElementById(id),ctx=c.getContext("2d"),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight,items=[];c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);const pad={l:54,r:18,t:12,b:options.bottom||82};const max=Math.max(1,...series.flatMap(s=>s.values));ctx.strokeStyle="#e1e5ea";ctx.fillStyle="#5f6b7a";ctx.font="12px -apple-system,Segoe UI,sans-serif";for(let i=0;i<=4;i++){let y=pad.t+(h-pad.t-pad.b)*i/4;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();ctx.fillText(fmt(max*(1-i/4)),6,y+4)}const groupW=(w-pad.l-pad.r)/Math.max(1,labels.length),barW=Math.max(3,Math.min(18,groupW/(series.length+1)));labels.forEach((lab,i)=>{series.forEach((s,j)=>{let val=s.values[i]||0,bh=(h-pad.t-pad.b)*val/max,x=pad.l+i*groupW+(groupW-series.length*barW)/2+j*barW,y=h-pad.b-bh;ctx.fillStyle=s.color;ctx.fillRect(x,y,barW*.75,bh);items.push({x:x,y:y,w:barW*.75,h:Math.max(2,bh),text:String(lab)+"\\n"+(s.label||"value")+": "+fmt(val)})});const lines=labelLines(lab,options.labelMode);ctx.fillStyle="#5f6b7a";ctx.textAlign="center";ctx.textBaseline="top";lines.forEach((line,k)=>ctx.fillText(line,pad.l+i*groupW+groupW/2,h-pad.b+10+k*13,Math.max(28,groupW-4)));ctx.textAlign="left";ctx.textBaseline="alphabetic"});(options.markers||[]).forEach(m=>{const vals=m.values||[],mmax=Math.max(1,...vals);labels.forEach((lab,i)=>{const val=vals[i]||0;if(!val)return;const x=pad.l+i*groupW+groupW/2,y=pad.t+10+(1-val/mmax)*44;ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fillStyle=m.color||"#ef4444";ctx.fill();ctx.strokeStyle="#fff";ctx.lineWidth=1.5;ctx.stroke();items.push({x:x-8,y:y-8,w:16,h:16,text:String(lab)+"\\n"+(m.label||"marker")+": "+short(val)})})});bindTooltip(c,items)}' +
        'function drawPie(id,legendId,items){const c=document.getElementById(id),ctx=c.getContext("2d"),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight,hit=[];c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);const total=items.reduce((s,x)=>s+x.value,0)||1,cx=w/2,cy=h/2,r=Math.min(w,h)*.34;let a=-Math.PI/2;items.forEach(x=>{const start=a,span=x.value/total*Math.PI*2;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a,a+span);ctx.closePath();ctx.fillStyle=x.color;ctx.fill();hit.push({start:start,end:start+span,label:x.label,value:x.value});a+=span});c._items=[];c.onmousemove=e=>{const rect=c.getBoundingClientRect(),mx=e.clientX-rect.left-cx,my=e.clientY-rect.top-cy,dist=Math.sqrt(mx*mx+my*my);let ang=Math.atan2(my,mx);if(ang<-Math.PI/2)ang+=Math.PI*2;const found=dist<=r&&hit.find(x=>ang>=x.start&&ang<=x.end);if(found)showTip(e,found.label+": "+short(found.value)+" ("+((found.value/total)*100).toFixed(1)+"%)");else hideTip()};c.onmouseleave=hideTip;const el=document.getElementById(legendId);el.innerHTML=items.map(x=>"<span><i class=\\"dot\\" style=\\"background:"+x.color+"\\"></i>"+x.label+" "+short(x.value)+"</span>").join("")}' +
        'function makeSortable(id){const table=document.getElementById(id);if(!table)return;table.querySelectorAll("th.sortable").forEach((th,idx)=>th.addEventListener("click",()=>{const desc=!th.classList.contains("desc");table.querySelectorAll("th").forEach(h=>h.classList.remove("desc","asc"));th.classList.add(desc?"desc":"asc");const type=th.dataset.type||"text",body=table.tBodies[0],rows=Array.from(body.rows);rows.sort((a,b)=>{let av=a.cells[idx].dataset.sort||a.cells[idx].textContent,bv=b.cells[idx].dataset.sort||b.cells[idx].textContent;if(type==="number"){av=parseFloat(av)||0;bv=parseFloat(bv)||0;return desc?bv-av:av-bv}return desc?String(bv).localeCompare(String(av)):String(av).localeCompare(String(bv))});rows.forEach(r=>body.appendChild(r))}))}' +
        'const daily=DATA.summary.byDay,limitFails=daily.map(x=>(x.rateLimitRetryCount||0)+(x.rateLimitRuns||0));drawBars("daily",daily.map(x=>x.key),[{label:"read",color:"#2563eb",values:daily.map(x=>x.readTokens)},{label:"write",color:"#059669",values:daily.map(x=>x.writeTokens)},{label:"cached",color:"#b7791f",values:daily.map(x=>x.cachedTokens)},{label:"reasoning",color:"#dc2626",values:daily.map(x=>x.reasoningTokens)}],{labelMode:"date",bottom:70,markers:[{label:"fails with limits",color:"#ef4444",values:limitFails}]});' +
        'const agents=DATA.summary.byAgent.slice().sort((a,b)=>(b.readTokens+b.writeTokens+b.cachedTokens+b.reasoningTokens)-(a.readTokens+a.writeTokens+a.cachedTokens+a.reasoningTokens)).slice(0,12);drawBars("agents",agents.map(x=>x.key),[{label:"total",color:"#7c3aed",values:agents.map(x=>x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens)}],{labelMode:"agent",bottom:112});' +
        'const runnerAgents=DATA.summary.byAgent.slice().sort((a,b)=>b.durationSeconds-a.durationSeconds).slice(0,12);drawBars("runnerDaily",daily.map(x=>x.key),[{label:"runner time",color:"#0891b2",values:daily.map(x=>x.durationSeconds)}],{labelMode:"date",bottom:70,valueFormat:"duration",markers:[{label:"fails with limits",color:"#ef4444",values:limitFails}]});drawBars("runsDaily",daily.map(x=>x.key),[{label:"runs",color:"#4f46e5",values:daily.map(x=>x.runs)},{label:"attempts",color:"#ea580c",values:daily.map(x=>x.samples)}],{labelMode:"date",bottom:70});drawBars("runnerAgents",runnerAgents.map(x=>x.key),[{label:"runner time",color:"#0f766e",values:runnerAgents.map(x=>x.durationSeconds)}],{labelMode:"agent",bottom:112,valueFormat:"duration"});drawBars("avgRunnerAgents",runnerAgents.map(x=>x.key),[{label:"avg run time",color:"#ca8a04",values:runnerAgents.map(x=>x.avgDurationSeconds)}],{labelMode:"agent",bottom:112,valueFormat:"duration"});' +
        'const colors=["#2563eb","#059669","#b7791f","#dc2626","#7c3aed","#0891b2","#ea580c","#4f46e5","#64748b"];const agentPie=agents.slice(0,8).map((x,i)=>({label:x.key,value:x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens,color:colors[i%colors.length]}));const agentOther=DATA.summary.byAgent.reduce((s,x)=>s+x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens,0)-agentPie.reduce((s,x)=>s+x.value,0);if(agentOther>0)agentPie.push({label:"other",value:agentOther,color:"#94a3b8"});const tokenPie=[{label:"read",value:DATA.summary.totals.readTokens,color:"#2563eb"},{label:"write",value:DATA.summary.totals.writeTokens,color:"#059669"},{label:"cached",value:DATA.summary.totals.cachedTokens,color:"#b7791f"},{label:"reasoning",value:DATA.summary.totals.reasoningTokens,color:"#dc2626"}];drawPie("agentPie","agentPieLegend",agentPie);drawPie("tokenPie","tokenPieLegend",tokenPie);makeSortable("agentTable");makeSortable("runsTable");' +
        'addEventListener("resize",()=>{drawBars("daily",daily.map(x=>x.key),[{label:"read",color:"#2563eb",values:daily.map(x=>x.readTokens)},{label:"write",color:"#059669",values:daily.map(x=>x.writeTokens)},{label:"cached",color:"#b7791f",values:daily.map(x=>x.cachedTokens)},{label:"reasoning",color:"#dc2626",values:daily.map(x=>x.reasoningTokens)}],{labelMode:"date",bottom:70,markers:[{label:"fails with limits",color:"#ef4444",values:limitFails}]});drawBars("agents",agents.map(x=>x.key),[{label:"total",color:"#7c3aed",values:agents.map(x=>x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens)}],{labelMode:"agent",bottom:112});drawBars("runnerDaily",daily.map(x=>x.key),[{label:"runner time",color:"#0891b2",values:daily.map(x=>x.durationSeconds)}],{labelMode:"date",bottom:70,valueFormat:"duration",markers:[{label:"fails with limits",color:"#ef4444",values:limitFails}]});drawBars("runsDaily",daily.map(x=>x.key),[{label:"runs",color:"#4f46e5",values:daily.map(x=>x.runs)},{label:"attempts",color:"#ea580c",values:daily.map(x=>x.samples)}],{labelMode:"date",bottom:70});drawBars("runnerAgents",runnerAgents.map(x=>x.key),[{label:"runner time",color:"#0f766e",values:runnerAgents.map(x=>x.durationSeconds)}],{labelMode:"agent",bottom:112,valueFormat:"duration"});drawBars("avgRunnerAgents",runnerAgents.map(x=>x.key),[{label:"avg run time",color:"#ca8a04",values:runnerAgents.map(x=>x.avgDurationSeconds)}],{labelMode:"agent",bottom:112,valueFormat:"duration"});drawPie("agentPie","agentPieLegend",agentPie);drawPie("tokenPie","tokenPieLegend",tokenPie)});' +
        '</script>\n</body>\n</html>\n';
}

function fetchWorkflowRunsPage(custom, status, created, page) {
    var raw = github_list_workflow_runs(
        custom.workspace,
        custom.repository,
        status,
        custom.workflowId || 'ai-teammate.yml',
        custom.perStatusLimit || custom.limit || 100,
        page,
        created
    );
    var parsed = parseJson(raw, raw);
    return {
        total: parsed && typeof parsed.total_count === 'number' ? parsed.total_count : null,
        runs: asArray(parsed)
    };
}

function collectRunsForWindow(custom, status, startDay, endDay, seen, runs, depth) {
    var created = startDay + '..' + endDay;
    var firstPage = fetchWorkflowRunsPage(custom, status, created, 1);
    var total = firstPage.total;
    var windowMs = Date.parse(endDay) - Date.parse(startDay);

    if (total != null && total >= 1000 && windowMs > 60000) {
        var mid = midpointTime(startDay, endDay);
        collectRunsForWindow(custom, status, startDay, mid, seen, runs, depth + 1);
        collectRunsForWindow(custom, status, addMilliseconds(mid, 1000), endDay, seen, runs, depth + 1);
        return;
    }

    var pageRuns = firstPage.runs;
    var page = 1;
    while (pageRuns.length) {
        pageRuns.forEach(function(run) {
            var id = String(run.id || run.databaseId || '');
            if (!id || seen[id]) return;
            seen[id] = true;
            if (run.status && run.status !== 'completed') return;
            runs.push(run);
        });
        if (custom.maxRuns && runs.length >= custom.maxRuns) return;
        if (pageRuns.length < (custom.perStatusLimit || custom.limit || 100)) return;
        page++;
        if (page > (custom.maxPages || 100)) return;
        pageRuns = fetchWorkflowRunsPage(custom, status, created, page).runs;
    }
}

function listCompletedRuns(custom) {
    var workspace = custom.workspace;
    var repository = custom.repository;
    var workflowId = custom.workflowId || 'ai-teammate.yml';
    var statuses = custom.statuses || ['completed'];
    if (typeof statuses === 'string') statuses = statuses.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    var perStatusLimit = custom.perStatusLimit || custom.limit || 100;
    var maxPages = custom.maxPages || 100;
    var seen = {};
    var runs = [];

    statuses.forEach(function(status) {
        custom.perStatusLimit = perStatusLimit;
        custom.maxPages = maxPages;
        if (custom.created === false || custom.created === 'false') {
            collectRunsForWindow(custom, status, '1970-01-01T00:00:00Z', toWindowEnd(todayIsoDay()), seen, runs, 0);
        } else {
            collectRunsForWindow(custom, status, toWindowStart(custom.createdStart || custom.since || '2020-01-01'), toWindowEnd(custom.createdEnd || todayIsoDay()), seen, runs, 0);
        }
    });

    runs.sort(function(a, b) {
        return String(b.created_at || b.createdAt || '').localeCompare(String(a.created_at || a.createdAt || ''));
    });
    if (custom.maxRuns && runs.length > custom.maxRuns) runs = runs.slice(0, custom.maxRuns);
    return runs;
}

function downloadRunLogs(custom, run) {
    var runId = String(run.id || run.databaseId);
    if (typeof github_get_workflow_run_logs === 'function') {
        return normalizeLogPayload(github_get_workflow_run_logs({
            workspace: custom.workspace,
            repository: custom.repository,
            runId: runId
        }));
    }

    var jobsRaw = github_get_workflow_run_jobs({
        workspace: custom.workspace,
        repository: custom.repository,
        runId: runId
    });
    var jobs = asArray(parseJson(jobsRaw, jobsRaw));
    var chunks = [];
    jobs.forEach(function(job) {
        var jobId = job.id || job.databaseId;
        if (!jobId) return;
        chunks.push(normalizeLogPayload(github_get_job_logs({
            workspace: custom.workspace,
            repository: custom.repository,
            jobId: String(jobId)
        })));
    });
    return chunks.join('\n');
}

function buildSummary(rows, totalRuns) {
    var totals = {
        requests: 0,
        readTokens: 0,
        writeTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        samples: 0,
        resumedRuns: 0,
        feedbackLoopCount: 0,
        rateLimitRetryCount: 0,
        rateLimitRuns: 0,
        timeoutCount: 0,
        timeoutRuns: 0,
        durationSeconds: 0,
        durationRuns: 0
    };
    rows.forEach(function(row) {
        Object.keys(totals).forEach(function(key) {
            totals[key] += row[key] || 0;
        });
        if (row.resumeDetected) totals.resumedRuns += 1;
        if (row.rateLimitDetected) totals.rateLimitRuns += 1;
        if (row.timeoutCount) totals.timeoutRuns += 1;
        if (row.durationSeconds) totals.durationRuns += 1;
    });
    totals.avgDurationSeconds = totals.durationRuns ? Math.round(totals.durationSeconds / totals.durationRuns) : 0;
    totals.avgDuration = formatDuration(totals.avgDurationSeconds);
    var runnerStats = calculateRunnerStats(rows);
    return {
        generatedAt: new Date().toISOString(),
        totalRuns: totalRuns,
        runsWithTokens: rows.length,
        runsWithoutTokens: Math.max(0, totalRuns - rows.length),
        totals: totals,
        runnerStats: runnerStats,
        byDay: groupBy(rows, function(row) { return row.day; }),
        byAgent: groupBy(rows, function(row) { return row.agent; })
    };
}

function writeOutput(path, content) {
    file_write({ path: path, content: content });
}

function readInput(path) {
    return file_read({ path: path });
}

function readJsonFile(path, fallback) {
    try {
        return parseJson(readInput(path), fallback);
    } catch (e) {
        return fallback;
    }
}

// Parses the requested sleep duration, clamping unparseable and non-positive
// values to a no-op 0.
function parseSleepMilliseconds(ms) {
    return Math.max(0, parseInt(ms, 10) || 0);
}

function hasJavaThread() {
    return !!(typeof Java !== 'undefined' && Java.type);
}

// Real pause under GraalJS / the JVM-hosted runners.
function sleepViaJavaThread(ms) {
    Java.type('java.lang.Thread').sleep(ms);
}

// Busy-wait fallback for engines without the Java interop (unit-test harnesses).
function sleepViaBusyWait(ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) {}
}

// Pauses the current thread for the given duration. Trivial on purpose: the
// duration parsing and the engine-specific strategies live in the small
// helpers above, so this reads as a decision table and stays easy to inject
// around in tests.
function sleepMilliseconds(ms) {
    var duration = parseSleepMilliseconds(ms);
    if (duration <= 0) return;
    if (hasJavaThread()) {
        sleepViaJavaThread(duration);
        return;
    }
    sleepViaBusyWait(duration);
}

function loadUsageCache(path) {
    var cache = readJsonFile(path, null);
    if (!cache || typeof cache !== 'object') return { version: 1, entries: {} };
    if (!cache.entries || typeof cache.entries !== 'object') cache.entries = {};
    cache.version = cache.version || 1;
    return cache;
}

function writeUsageCache(path, cache) {
    cache.updatedAt = new Date().toISOString();
    writeOutput(path, JSON.stringify(cache, null, 2));
}

function buildRowsFromCache(cache) {
    var rows = [];
    var attemptRows = [];
    Object.keys(cache.entries || {}).forEach(function(runId) {
        var entry = cache.entries[runId];
        if (!entry || !entry.row) return;
        rows.push(entry.row);
        (entry.attemptRows || []).forEach(function(attemptRow) { attemptRows.push(attemptRow); });
    });
    rows.sort(function(a, b) {
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    attemptRows.sort(function(a, b) {
        var byDate = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
        if (byDate !== 0) return byDate;
        return (a.attemptIndex || 0) - (b.attemptIndex || 0);
    });
    return { rows: rows, attemptRows: attemptRows };
}

// Returns the first truthy argument, or the last argument when all preceding
// ones are falsy — the multi-value form of the `a || b || c` chain.
function firstDefined() {
    for (var i = 0; i < arguments.length - 1; i++) {
        if (arguments[i]) return arguments[i];
    }
    return arguments[arguments.length - 1];
}

function verboseLog(verbose, message) {
    if (verbose) console.log(message);
}

function resolveWorkspace(custom, projectConfig) {
    custom.workspace = custom.workspace || custom.owner;
    if (!custom.workspace || custom.workspace.indexOf('{') !== -1) {
        custom.workspace = projectConfig.repository && projectConfig.repository.owner;
    }
}

function resolveRepositoryName(custom, projectConfig) {
    custom.repository = custom.repository || custom.repo;
    if (!custom.repository || custom.repository.indexOf('{') !== -1) {
        custom.repository = projectConfig.repository && projectConfig.repository.repo;
    }
}

// Resolves workspace/repository (with {placeholder} fallback to the project
// config) and the default workflow id, mutating customParams in place.
function resolveRepository(custom, projectConfig) {
    resolveWorkspace(custom, projectConfig);
    resolveRepositoryName(custom, projectConfig);
    custom.workflowId = custom.workflowId || 'ai-teammate.yml';
    return custom;
}

function resolveOutputPaths(custom) {
    var outputDir = firstDefined(custom.outputDir, 'outputs/token_usage');
    return {
        outputDir: outputDir,
        csvPath: firstDefined(custom.csvPath, outputDir + '/ai_teammate_token_usage.csv'),
        attemptsCsvPath: firstDefined(custom.attemptsCsvPath, outputDir + '/ai_teammate_token_usage_attempts.csv'),
        jsonPath: firstDefined(custom.jsonPath, outputDir + '/ai_teammate_token_usage.json'),
        htmlPath: firstDefined(custom.htmlPath, outputDir + '/ai_teammate_token_usage.html'),
        cachePath: firstDefined(custom.cachePath, outputDir + '/ai_teammate_token_usage_cache.json')
    };
}

function parseMaxLogDownloads(custom) {
    var parsed = parseInt(custom.maxLogDownloads, 10);
    if (custom.maxLogDownloads == null || custom.maxLogDownloads === '') return null;
    if (isNaN(parsed)) return 0;
    return Math.max(0, parsed);
}

function parseCacheOptions(custom) {
    return {
        useCache: custom.useCache !== false && custom.useCache !== 'false',
        cacheWriteEvery: Math.max(1, parseInt(custom.cacheWriteEvery || 25, 10) || 25),
        logDownloadSleepMs: parseInt(custom.logDownloadSleepMs || 0, 10) || 0,
        maxLogDownloads: parseMaxLogDownloads(custom)
    };
}

function shouldLogRunProgress(verbose, index, total, logEvery) {
    return verbose || index === 0 || (index + 1) % logEvery === 0 || index === total - 1;
}

function renderOnlyReport(custom, paths) {
    var inputJsonPath = firstDefined(custom.inputJsonPath, paths.jsonPath);
    var existing = parseJson(readInput(inputJsonPath), null);
    if (!existing || !existing.summary || !existing.rows) {
        return { success: false, error: 'Cannot render HTML: invalid token usage JSON at ' + inputJsonPath };
    }
    writeOutput(paths.htmlPath, buildHtml(existing.rows, existing.summary));
    console.log('Wrote HTML: ' + paths.htmlPath);
    return { success: true, renderOnly: true, jsonPath: inputJsonPath, htmlPath: paths.htmlPath, summary: existing.summary };
}

function cacheOnlyReport(paths) {
    var cacheOnly = loadUsageCache(paths.cachePath);
    var cached = buildRowsFromCache(cacheOnly);
    var cachedTotalRuns = Object.keys(cacheOnly.entries || {}).length;
    var summaryFromCache = buildSummary(cached.rows, cachedTotalRuns);
    summaryFromCache.cache = {
        enabled: true,
        path: paths.cachePath,
        cacheOnly: true,
        hits: cached.rows.length,
        logDownloads: 0,
        maxLogDownloads: 0,
        stoppedByDownloadLimit: false,
        logDownloadSleepMs: 0
    };
    var cachedPayload = { summary: summaryFromCache, rows: cached.rows, attempts: cached.attemptRows };
    writeOutput(paths.csvPath, buildCsv(cached.rows));
    writeOutput(paths.attemptsCsvPath, buildAttemptsCsv(cached.attemptRows));
    writeOutput(paths.jsonPath, JSON.stringify(cachedPayload, null, 2));
    writeOutput(paths.htmlPath, buildHtml(cached.rows, summaryFromCache));
    console.log('Wrote CSV: ' + paths.csvPath);
    console.log('Wrote attempts CSV: ' + paths.attemptsCsvPath);
    console.log('Wrote JSON: ' + paths.jsonPath);
    console.log('Wrote HTML: ' + paths.htmlPath);
    console.log('Cache-only report rows=' + cached.rows.length + ', log downloads=0');
    return { success: true, cacheOnly: true, csvPath: paths.csvPath, attemptsCsvPath: paths.attemptsCsvPath, jsonPath: paths.jsonPath, htmlPath: paths.htmlPath, summary: summaryFromCache };
}

function buildUsageRow(run, meta, durationSeconds, duration, usage) {
    return {
        runId: String(firstDefined(run.id, run.databaseId)),
        runNumber: firstDefined(run.run_number, run.runNumber, ''),
        createdAt: firstDefined(run.created_at, run.createdAt, ''),
        startedAt: firstDefined(run.run_started_at, run.runStartedAt, ''),
        updatedAt: firstDefined(run.updated_at, run.updatedAt, ''),
        day: isoDay(firstDefined(run.created_at, run.createdAt, run.run_started_at, run.runStartedAt)),
        conclusion: firstDefined(run.conclusion, ''),
        agent: meta.agent,
        ticketKey: meta.ticketKey,
        configFile: meta.configFile,
        title: meta.title,
        durationSeconds: durationSeconds,
        duration: duration,
        requests: firstDefined(usage.requests, 0),
        requestTier: firstDefined(usage.requestTier, ''),
        requestDuration: firstDefined(usage.requestDuration, ''),
        readTokens: firstDefined(usage.readTokens, 0),
        writeTokens: firstDefined(usage.writeTokens, 0),
        cachedTokens: firstDefined(usage.cachedTokens, 0),
        reasoningTokens: firstDefined(usage.reasoningTokens, 0),
        samples: firstDefined(usage.samples, 1),
        resumeDetected: usage.resumeDetected === true,
        resumeStages: firstDefined(usage.resumeStages, []).join('; '),
        feedbackLoopCount: firstDefined(usage.feedbackLoopCount, 0),
        rateLimitRetryCount: firstDefined(usage.rateLimitRetryCount, 0),
        rateLimitDetected: usage.rateLimitDetected === true,
        timeoutCount: firstDefined(usage.timeoutCount, 0),
        source: firstDefined(usage.source, ''),
        url: firstDefined(run.html_url, run.htmlUrl, '')
    };
}

function buildAttemptRow(run, meta, durationSeconds, duration, usage, attempt) {
    return {
        runId: String(firstDefined(run.id, run.databaseId)),
        runNumber: firstDefined(run.run_number, run.runNumber, ''),
        createdAt: firstDefined(run.created_at, run.createdAt, ''),
        day: isoDay(firstDefined(run.created_at, run.createdAt, run.run_started_at, run.runStartedAt)),
        conclusion: firstDefined(run.conclusion, ''),
        durationSeconds: durationSeconds,
        duration: duration,
        agent: meta.agent,
        ticketKey: meta.ticketKey,
        attemptIndex: firstDefined(attempt.attemptIndex, 1),
        resumeDetected: usage.resumeDetected === true,
        feedbackLoopCount: firstDefined(usage.feedbackLoopCount, 0),
        rateLimitRetryCount: firstDefined(usage.rateLimitRetryCount, 0),
        rateLimitDetected: usage.rateLimitDetected === true,
        timeoutCount: firstDefined(usage.timeoutCount, 0),
        requests: firstDefined(attempt.requests, 0),
        requestTier: firstDefined(attempt.requestTier, ''),
        requestDuration: firstDefined(attempt.requestDuration, ''),
        readTokens: firstDefined(attempt.readTokens, 0),
        writeTokens: firstDefined(attempt.writeTokens, 0),
        cachedTokens: firstDefined(attempt.cachedTokens, 0),
        reasoningTokens: firstDefined(attempt.reasoningTokens, 0),
        rawTokensLine: firstDefined(attempt.rawTokensLine, ''),
        source: firstDefined(attempt.source, ''),
        url: firstDefined(run.html_url, run.htmlUrl, '')
    };
}

function buildCacheSummaryInfo(options, paths, state) {
    return {
        enabled: options.useCache,
        path: options.useCache ? paths.cachePath : '',
        hits: state.cacheHits,
        logDownloads: state.downloadedLogs,
        maxLogDownloads: options.maxLogDownloads,
        stoppedByDownloadLimit: state.stoppedByDownloadLimit,
        logDownloadSleepMs: options.logDownloadSleepMs
    };
}

function writeReportOutputs(paths, rows, attemptRows, summary) {
    var payload = { summary: summary, rows: rows, attempts: attemptRows };
    writeOutput(paths.csvPath, buildCsv(rows));
    writeOutput(paths.attemptsCsvPath, buildAttemptsCsv(attemptRows));
    writeOutput(paths.jsonPath, JSON.stringify(payload, null, 2));
    writeOutput(paths.htmlPath, buildHtml(rows, summary));
    console.log('Wrote CSV: ' + paths.csvPath);
    console.log('Wrote attempts CSV: ' + paths.attemptsCsvPath);
    console.log('Wrote JSON: ' + paths.jsonPath);
    console.log('Wrote HTML: ' + paths.htmlPath);
}

// Reads the cache entry for a run and classifies it: a cached row, a cached
// "no usage" marker, or null when the run must be (re-)processed — including
// error entries, which the original loop fell through to re-download.
function getCachedRunState(cache, runId, useCache) {
    if (!useCache) return null;
    var cached = cache.entries[runId];
    if (!cached) return null;
    if (cached.row) return { kind: 'row', row: cached.row, attemptRows: cached.attemptRows || [] };
    if (cached.noUsage) return { kind: 'noUsage' };
    return null;
}

function applyCachedRunState(state, cachedRun) {
    if (!cachedRun) return false;
    if (cachedRun.kind === 'row') {
        state.rows.push(cachedRun.row);
        cachedRun.attemptRows.forEach(function(attemptRow) { state.attemptRows.push(attemptRow); });
        state.cacheHits += 1;
        verboseLog(state.verbose, '    cache hit');
        return true;
    }
    state.cacheHits += 1;
    verboseLog(state.verbose, '    cache hit: no token summary');
    return true;
}

function cacheNoUsage(state, runId, options) {
    if (!options.useCache) return;
    state.cache.entries[runId] = { runId: runId, noUsage: true, cachedAt: new Date().toISOString() };
}

function cacheRunUsage(state, runId, row, attemptRows, options) {
    state.cache.entries[runId] = {
        runId: runId,
        cachedAt: new Date().toISOString(),
        row: row,
        attemptRows: attemptRows
    };
    if (state.downloadedLogs % options.cacheWriteEvery === 0) writeUsageCache(state.cachePath, state.cache);
}

function newUsageCollectionState(custom, paths, options) {
    return {
        rows: [],
        attemptRows: [],
        cache: options.useCache ? loadUsageCache(paths.cachePath) : { version: 1, entries: {} },
        downloadedLogs: 0,
        cacheHits: 0,
        stoppedByDownloadLimit: false,
        verbose: custom.verbose === true || custom.verbose === 'true',
        cachePath: paths.cachePath
    };
}

function recordRunFailure(state, runId, options, error) {
    if (options.useCache) {
        state.cache.entries[runId] = { runId: runId, error: String(error.message || error), cachedAt: new Date().toISOString() };
    }
    console.warn('    failed to process run ' + runId + ': ' + (error.message || error));
}

// Downloads and parses one run's logs, appending the aggregate and attempt
// rows to the collection state (or caching a noUsage marker).
function processRunLogs(custom, run, runId, meta, durationSeconds, duration, state, options) {
    if (options.maxLogDownloads != null && state.downloadedLogs >= options.maxLogDownloads) {
        state.stoppedByDownloadLimit = true;
        verboseLog(state.verbose, '    skipped: maxLogDownloads reached');
        return;
    }
    if (state.downloadedLogs > 0 && options.logDownloadSleepMs > 0) sleepMilliseconds(options.logDownloadSleepMs);
    var logs = downloadRunLogs(custom, run);
    state.downloadedLogs += 1;
    var usage = extractTokenUsage(logs);
    if (!usage) {
        cacheNoUsage(state, runId, options);
        verboseLog(state.verbose, '    no token summary found');
        return;
    }
    var row = buildUsageRow(run, meta, durationSeconds, duration, usage);
    var runAttemptRows = [];
    state.rows.push(row);
    (usage.attempts || []).forEach(function(attempt) {
        var attemptRow = buildAttemptRow(run, meta, durationSeconds, duration, usage, attempt);
        state.attemptRows.push(attemptRow);
        runAttemptRows.push(attemptRow);
    });
    if (options.useCache) cacheRunUsage(state, runId, row, runAttemptRows, options);
    verboseLog(state.verbose, '    tokens read=' + usage.readTokens + ' write=' + usage.writeTokens + ' cached=' + usage.cachedTokens + ' reasoning=' + usage.reasoningTokens + ' attempts=' + usage.samples);
}

function collectUsageRows(custom, runs, paths, options) {
    var logEvery = custom.logEvery || 50;
    var state = newUsageCollectionState(custom, paths, options);
    for (var i = 0; i < runs.length; i++) {
        var run = runs[i];
        var meta = extractAgentAndKey(run);
        var runId = String(run.id || run.databaseId);
        var durationSeconds = calculateDurationSeconds(run);
        var duration = formatDuration(durationSeconds);
        if (shouldLogRunProgress(state.verbose, i, runs.length, logEvery)) {
            console.log('  [' + (i + 1) + '/' + runs.length + '] ' + runId + ' ' + meta.title);
        }
        try {
            if (applyCachedRunState(state, getCachedRunState(state.cache, runId, options.useCache))) continue;
            processRunLogs(custom, run, runId, meta, durationSeconds, duration, state, options);
        } catch (e) {
            recordRunFailure(state, runId, options, e);
        }
    }
    if (options.useCache) writeUsageCache(paths.cachePath, state.cache);
    return state;
}

// ── gh-1108 — keyed per-leg tokens: projection + factory-data publish ────────
// The producer→publish→tick link: the SAME scan that writes the CSV/JSON/
// HTML reports also projects the rows into the keyed map the SM tick
// consumes (factoryState.tokensMapOf → normalizeTokens → card.tokens) and
// publishes it to the factory-data branch — the transport the tick's
// fetchTokensFromBranch probes with statePublish.tokensAsset. Rows are
// decorative end to end: any projection/publish miss degrades to a status,
// never fails the report.

/**
 * Run title → token-row anchor. ONE title vocabulary with
 * teammateEventDedup: the issue anchor via issueOfRunName (stub '#<n>' and
 * factory 'gh-<n>' families, trailing-digit guarded), the leg via
 * legOfRunName (stub tail / '▶ leg (SM)' / emoji families), plus a
 * whole-token 'pr-<n>' scan for the PR-anchored dispatch slot (the stub's
 * '· pr-<N>', gh-1075). pr wins over issue — the finer anchor when a title
 * carries both. Returns { key, pr, issue, leg }; key is null when NEITHER
 * anchor resolves — an unresolvable run yields no row, never a wrong key.
 */
function prAnchorOf(text) {
    var re = /(?:^|[^0-9a-zA-Z])pr-(\d+)/g;
    var m = re.exec(text);
    while (m) {
        var after = text.charAt(m.index + m[0].length);
        if (after === '' || after < '0' || after > '9') return parseInt(m[1], 10);
        m = re.exec(text);
    }
    return null;
}

function parseRunAnchor(title) {
    var text = String(title || '');
    var pr = prAnchorOf(text);
    var issue = teammateEventDedup.issueOfRunName(text);
    return {
        pr: pr,
        issue: issue,
        leg: teammateEventDedup.legOfRunName(text) || '',
        key: pr != null ? 'pr-' + pr : (issue != null ? 'issue-' + issue : null)
    };
}

/**
 * Leg fallback when the title carries none (pre-gh-1065 event-path titles):
 * the runner-config basename family — *rework* → rework, *review* → review,
 * *develop* → dev, else '' (honest unknown; resolveLeg's rework-first
 * discipline from js/factory/token_usage.js).
 */
function legFromAgent(agent) {
    var stem = String(agent || '');
    if (!stem) return '';
    if (stem.indexOf('rework') !== -1) return 'rework';
    if (stem.indexOf('review') !== -1) return 'review';
    if (stem.indexOf('develop') !== -1) return 'dev';
    return '';
}

/** One reporter row → the printf row contract (see buildTokensMap). */
function tokenRowOf(row, anchor) {
    var prompt = +row.readTokens || 0;
    var completion = +row.writeTokens || 0;
    return {
        leg: anchor.leg || legFromAgent(row.agent),
        at: String(row.createdAt || ''),
        prompt: prompt,
        completion: completion,
        total: prompt + completion,
        cacheRead: +row.cachedTokens || 0,
        model: ''
    };
}

/** Bucket rows by their run-title anchor; unanchorable rows drop. */
function collectTokenRows(rows, byKey) {
    (Array.isArray(rows) ? rows : []).forEach(function(row) {
        if (!row) return;
        var anchor = parseRunAnchor(row.title);
        if (!anchor.key) return;
        (byKey[anchor.key] = byKey[anchor.key] || []).push(tokenRowOf(row, anchor));
    });
}

/** Retention cut for one key's rows: window filter + at-sort + tail cap. */
function retainTokenKey(rows, cutoff, keepPerKey) {
    var kept = rows
        .filter(function(r) { return String(r.at || '') >= cutoff; })
        .sort(function(a, b) { return String(a.at).localeCompare(String(b.at)); });
    return kept.length > keepPerKey ?
        kept.slice(kept.length - keepPerKey) : kept;
}

/** int-or-default for the retention knobs (hand-edited configs). */
function intOrDefault(value, dflt) {
    return (value == null || value === '') ? dflt : parseInt(value, 10);
}

/** Retention knobs → { cutoff, keepPerKey } (fa producer defaults). */
function retentionOpts(opts) {
    opts = opts || {};
    return {
        cutoff: tokenUsage.cutoffIso(
            opts.now ? new Date(opts.now) : new Date(),
            intOrDefault(opts.windowDays, tokenUsage.DEFAULT_WINDOW_DAYS)),
        keepPerKey: intOrDefault(opts.keepPerKey, tokenUsage.ROW_KEEP)
    };
}

/**
 * The keyed tokens projection: reporter rows → the map form the tick
 * consumes ('pr-N'/'issue-N' → rows). One row per RUN (the run's summed
 * usage) in the printf row contract {leg, at, prompt, completion, total,
 * cacheRead, model}: prompt = read, completion = write, total = prompt +
 * completion, cacheRead = cached. The logs carry no model id yet — model
 * stays '' (normTokenRow → null downstream; pricing skips it, tokens still
 * render). Rows without a resolvable anchor drop (never a wrong key).
 * Retention mirrors the fa producer (js/factory/token_usage.js): rows
 * older than windowDays (default 14) drop, the newest keepPerKey (default
 * ROW_KEEP = 40) survive per key, sorted by at ascending. Numbers only —
 * no log text, no URLs (the snapshot's privacy invariant).
 */
function buildTokensMap(rows, opts) {
    var retention = retentionOpts(opts);
    var byKey = {};
    collectTokenRows(rows, byKey);
    var map = {};
    Object.keys(byKey).forEach(function(key) {
        var kept = retainTokenKey(byKey[key], retention.cutoff, retention.keepPerKey);
        if (kept.length) map[key] = kept;
    });
    return map;
}

/**
 * Publish the keyed tokens map to the factory-data branch (data/<asset>),
 * the exact transport shape of the fa gh-781 producer
 * (js/factory/token_usage.js): bootstrap the branch (422 already-exists is
 * the normal case), then up to `attempts` GET-sha → PUT cycles; a PUT
 * conflict refetches and retries. An empty map SKIPS with zero gh traffic
 * — a rebuild that found no rows must never erase the previous file. Asset
 * default mirrors fetchPreviousState's derivation —
 * data/<repoName>-tokens.json — so a shared multi-factory branch stays
 * isolated even when the deployment forgets the explicit tokensAsset knob
 * (ai_teammate_token_usage_reporter.json sets agents-tokens.json; AC3).
 *
 * opts: repo ('O/R', required), branch (default factory-data), asset,
 *      attempts (default 3). io: exec({command}) → {output|stdout};
 *      log(line).
 * Returns { status, reason, path, keyCount, rowCount, attempts } — status
 * 'published' | 'skipped' | 'gave-up'; never throws.
 */
/** Key count + total rows of a keyed tokens map (non-map → empty stats). */
function tokensMapStats(map) {
    var keys = (map && typeof map === 'object' && !Array.isArray(map)) ?
        Object.keys(map) : [];
    var rowCount = 0;
    keys.forEach(function(k) {
        if (Array.isArray(map[k])) rowCount += map[k].length;
    });
    return { keys: keys, rowCount: rowCount };
}

/** The skip contract: any reason here means zero gh traffic. */
function tokensSkipReason(stats, opts, exec) {
    if (!stats.keys.length || !stats.rowCount) return 'no-rows';
    var repo = String(opts.repo || '');
    if (!repo || repo.indexOf('/') === -1) return 'no-repo';
    if (typeof exec !== 'function') return 'no-exec';
    return null;
}

/** Publish target: asset / branch / path / attempts (fa defaults). */
function tokensTargetOf(opts, repo) {
    var asset = opts.asset || (repo.split('/')[1] || 'factory') + '-tokens.json';
    return {
        asset: asset,
        branch: opts.branch || tokenUsage.DEFAULT_DATA_BRANCH,
        path: 'data/' + asset,
        attempts: opts.attempts || tokenUsage.DEFAULT_ATTEMPTS
    };
}

/** The exec-output text extraction (factoryState's execOut discipline). */
function ghText(exec, command) {
    var res = exec({ command: command });
    return String((res && (res.output || res.stdout)) || res || '').trim();
}

/** 422 already-exists is the normal case — absorb it. */
function tryBootstrapBranch(exec, repo, branch) {
    try { exec({ command: tokenUsage.bootstrapBranchCommand(repo, branch) }); }
    catch (eBoot) { /* branch exists */ }
}

/**
 * One GET-sha → PUT cycle: true when the PUT landed, false on conflict
 * (the caller refetches and retries). A 404 sha probe = first publish.
 */
function tokensPutAttempt(exec, repo, target, json) {
    var sha = '';
    try {
        sha = ghText(exec, tokenUsage.contentsShaCommand(
            repo, target.path, target.branch));
    } catch (eSha) { sha = ''; }
    if (sha.indexOf('Not Found') !== -1) sha = '';
    try {
        exec({ command: tokenUsage.contentsPutCommand(repo, target.path, {
            branch: target.branch,
            message: 'factory leg tokens — ' + json.rows + ' rows [skip ci]',
            json: json.text,
            sha: sha
        }) });
        return true;
    } catch (ePut) { return false; }
}

/**
 * Publish the keyed tokens map to the factory-data branch (data/<asset>),
 * the exact transport shape of the fa gh-781 producer
 * (js/factory/token_usage.js): bootstrap the branch (422 already-exists is
 * the normal case), then up to `attempts` GET-sha → PUT cycles; a PUT
 * conflict refetches and retries. An empty map SKIPS with zero gh traffic
 * — a rebuild that found no rows must never erase the previous file. Asset
 * default mirrors fetchPreviousState's derivation —
 * data/<repoName>-tokens.json — so a shared multi-factory branch stays
 * isolated even when the deployment forgets the explicit tokensAsset knob
 * (ai_teammate_token_usage_reporter.json sets agents-tokens.json; AC3).
 *
 * opts: repo ('O/R', required), branch (default factory-data), asset,
 *      attempts (default 3). io: exec({command}) → {output|stdout};
 *      log(line).
 * Returns { status, reason, path, keyCount, rowCount, attempts } — status
 * 'published' | 'skipped' | 'gave-up'; never throws.
 */
function publishTokensMap(map, opts, io) {
    opts = opts || {};
    io = io || {};
    var log = io.log || function() {};
    var stats = tokensMapStats(map);
    var result = { status: 'skipped', reason: null, path: null,
        keyCount: stats.keys.length, rowCount: stats.rowCount, attempts: 0 };
    var skip = tokensSkipReason(stats, opts, io.exec);
    if (skip) {
        result.reason = skip;
        log('::warning::tokens publish skipped — ' + skip);
        return result;
    }
    var repo = String(opts.repo || '');
    var target = tokensTargetOf(opts, repo);
    result.path = target.path;
    tryBootstrapBranch(io.exec, repo, target.branch);
    var json = { text: JSON.stringify(map), rows: stats.rowCount };
    for (var attempt = 1; attempt <= target.attempts; attempt++) {
        if (tokensPutAttempt(io.exec, repo, target, json)) {
            result.status = 'published';
            result.attempts = attempt;
            return result;
        }
        result.attempts = attempt;
        log('token publish attempt ' + attempt + ' conflicted — refetching');
    }
    result.status = 'gave-up';
    log('::warning::tokens publish gave up after ' + target.attempts +
        ' attempts (concurrent writes) — rows are decorative, the next scan retries');
    return result;
}

/** gh 'O/R' from the reporter's split workspace/repository params. */
function tokensRepoOf(custom) {
    if (custom.tokensRepo) return custom.tokensRepo;
    if (custom.workspace && custom.repository) {
        return custom.workspace + '/' + custom.repository;
    }
    return custom.repository || '';
}

/**
 * customParams → publish options. repo rides the resolved repository
 * ('{owner}'/'{repo}' resolve before this runs); the branch defaults to
 * factory-data; the asset must be SET by deployments on shared branches
 * (agents-tokens.json here). tokensNow pins the retention clock (tests);
 * tokensWindowDays/tokensKeepPerKey ride the fa defaults.
 */
function parsePublishOptions(custom) {
    custom = custom || {};
    return {
        enabled: custom.publishTokens === true || custom.publishTokens === 'true',
        repo: tokensRepoOf(custom),
        branch: custom.tokensBranch || tokenUsage.DEFAULT_DATA_BRANCH,
        asset: custom.tokensAsset || '',
        windowDays: custom.tokensWindowDays,
        keepPerKey: custom.tokensKeepPerKey,
        now: custom.tokensNow || ''
    };
}

/** Asset default mirroring fetchPreviousState's <repoName> derivation. */
function defaultTokensAsset(repo) {
    return (String(repo || '').split('/')[1] || 'factory') + '-tokens.json';
}

/** The 🪙 publish provenance line (sibling of the tick's 🪙 line). */
function tokensPublishLine(res) {
    return '🪙 tokens publish: ' + res.status +
        (res.path ? ' → ' + res.path : '') +
        (res.reason ? ' (' + res.reason + ')' : '') +
        ' [' + res.rowCount + ' rows / ' + res.keyCount + ' keys]' +
        (res.attempts ? ' after ' + res.attempts + ' attempt(s)' : '');
}

/**
 * The action-side link (gh-1108): project rows → local keyed copy next to
 * the other report outputs → branch publish. Disabled unless customParams
 * publishTokens is set; every failure logs and returns null — the report
 * itself is never failed by the decorative tokens stream.
 */
function publishKeyedTokens(custom, paths, rows) {
    var opts = parsePublishOptions(custom);
    if (!opts.enabled) return null;
    var map = buildTokensMap(rows, opts);
    opts.asset = opts.asset || defaultTokensAsset(opts.repo);
    var localPath = (paths && paths.outputDir ? paths.outputDir :
        'outputs/token_usage') + '/' + opts.asset;
    try { writeOutput(localPath, JSON.stringify(map, null, 2)); }
    catch (eLocal) { /* the local copy is a convenience — the branch is the transport */ }
    var exec = typeof cli_execute_command === 'function' ? cli_execute_command : null;
    var res = publishTokensMap(map, opts, {
        exec: exec,
        log: function(line) { console.log(line); }
    });
    console.log(tokensPublishLine(res));
    return {
        status: res.status,
        reason: res.reason,
        path: res.path,
        asset: opts.asset,
        localPath: localPath,
        keyCount: res.keyCount,
        rowCount: res.rowCount,
        attempts: res.attempts
    };
}

/** The action result, with the optional tokens publish summary attached. */
function actionResultOf(paths, summary, tokensPublish) {
    var result = { success: true, csvPath: paths.csvPath, attemptsCsvPath: paths.attemptsCsvPath, jsonPath: paths.jsonPath, htmlPath: paths.htmlPath, summary: summary };
    if (tokensPublish) result.tokens = tokensPublish;
    return result;
}

/**
 * The cache-only report path, plus the gh-1108 keyed publish: the cache
 * already holds every row the scan ever parsed, so the keyed map rebuilds
 * without a single log download.
 */
function cacheOnlyReportAndPublish(custom, paths) {
    var cachedResult = cacheOnlyReport(paths);
    publishKeyedTokens(custom, paths,
        buildRowsFromCache(loadUsageCache(paths.cachePath)).rows);
    return cachedResult;
}

function action(params) {
    var custom = (params && params.jobParams && params.jobParams.customParams) || {};
    var projectConfig = configLoader.loadProjectConfig(params || {});
    resolveRepository(custom, projectConfig);

    if (!custom.workspace || !custom.repository) {
        return { success: false, error: 'customParams.workspace and customParams.repository are required' };
    }

    var paths = resolveOutputPaths(custom);
    var options = parseCacheOptions(custom);

    if (custom.renderOnly === true || custom.renderOnly === 'true') {
        return renderOnlyReport(custom, paths);
    }

    if (custom.cacheOnly === true || custom.cacheOnly === 'true') {
        return cacheOnlyReportAndPublish(custom, paths);
    }

    console.log('AI Teammate Token Usage Reporter — ' + custom.workspace + '/' + custom.repository + ' [' + custom.workflowId + ']');
    var runs = listCompletedRuns(custom);
    console.log('Found ' + runs.length + ' completed workflow run(s)');

    var state = collectUsageRows(custom, runs, paths, options);
    var summary = buildSummary(state.rows, runs.length);
    summary.cache = buildCacheSummaryInfo(options, paths, state);
    writeReportOutputs(paths, state.rows, state.attemptRows, summary);

    console.log('Cache hits=' + state.cacheHits + ', log downloads=' + state.downloadedLogs + (state.stoppedByDownloadLimit ? ', stopped by maxLogDownloads' : ''));

    // gh-1108: the keyed tokens projection + factory-data publish (opt-in,
    // customParams.publishTokens) — the producer→publish→tick link. Runs
    // AFTER the report outputs so a publish miss can never lose the report.
    return actionResultOf(paths, summary,
        publishKeyedTokens(custom, paths, state.rows));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        parseNumberWithSuffix: parseNumberWithSuffix,
        parseTokensLine: parseTokensLine,
        extractTokenUsage: extractTokenUsage,
        newUsageTracking: newUsageTracking,
        parseResumeSignal: parseResumeSignal,
        parseRateLimitSignal: parseRateLimitSignal,
        isTimeoutLine: isTimeoutLine,
        applyLogSignals: applyLogSignals,
        isFaSegmentReplay: isFaSegmentReplay,
        appendUsageSample: appendUsageSample,
        collectUsageSamples: collectUsageSamples,
        collectFaSourceKeys: collectFaSourceKeys,
        usageSourceLabel: usageSourceLabel,
        sumUsageSamples: sumUsageSamples,
        buildUsageAggregate: buildUsageAggregate,
        extractAgentAndKey: extractAgentAndKey,
        calculateDurationSeconds: calculateDurationSeconds,
        formatDuration: formatDuration,
        listCompletedRuns: listCompletedRuns,
        buildCsv: buildCsv,
        buildAttemptsCsv: buildAttemptsCsv,
        buildSummary: buildSummary,
        buildHtml: buildHtml,
        loadUsageCache: loadUsageCache,
        sortAttr: sortAttr,
        firstDefined: firstDefined,
        resolveRepository: resolveRepository,
        resolveOutputPaths: resolveOutputPaths,
        parseCacheOptions: parseCacheOptions,
        parseMaxLogDownloads: parseMaxLogDownloads,
        parseSleepMilliseconds: parseSleepMilliseconds,
        hasJavaThread: hasJavaThread,
        sleepMilliseconds: sleepMilliseconds,
        shouldLogRunProgress: shouldLogRunProgress,
        renderOnlyReport: renderOnlyReport,
        cacheOnlyReport: cacheOnlyReport,
        buildUsageRow: buildUsageRow,
        buildAttemptRow: buildAttemptRow,
        buildCacheSummaryInfo: buildCacheSummaryInfo,
        writeReportOutputs: writeReportOutputs,
        getCachedRunState: getCachedRunState,
        applyCachedRunState: applyCachedRunState,
        processRunLogs: processRunLogs,
        collectUsageRows: collectUsageRows,
        parseRunAnchor: parseRunAnchor,
        legFromAgent: legFromAgent,
        buildTokensMap: buildTokensMap,
        parsePublishOptions: parsePublishOptions,
        publishTokensMap: publishTokensMap,
        publishKeyedTokens: publishKeyedTokens
    };
}
