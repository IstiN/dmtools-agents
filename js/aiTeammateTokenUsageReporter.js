var configLoader = require('./configLoader.js');

/**
 * AI Teammate Token Usage Reporter (JSRunner)
 *
 * Downloads completed GitHub Actions logs for ai-teammate runs, extracts Copilot
 * token summaries printed by CommandLineUtils, and writes CSV/JSON/HTML outputs.
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

function parseTokensLine(line) {
    var text = String(line || '');
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

function extractTokenUsage(logs) {
    var lines = String(logs || '').split(/\r?\n/);
    var lastRequests = null;
    var samples = [];
    var resumeDetected = false;
    var resumeStages = [];
    var feedbackLoopCount = 0;
    var rateLimitRetryCount = 0;
    var rateLimitDetected = false;
    var timeoutCount = 0;

    for (var i = 0; i < lines.length; i++) {
        var line = String(lines[i] || '');
        var lower = line.toLowerCase();
        var resumeMatch = line.match(/Feedback loop: resuming agent for\s+(.+?)\s+attempt\s+([0-9]+)\/([0-9]+)/);
        if (resumeMatch) {
            resumeDetected = true;
            feedbackLoopCount += 1;
            resumeStages.push((resumeMatch[1] || 'resume') + ' ' + resumeMatch[2] + '/' + resumeMatch[3]);
        } else if (line.indexOf('--resume') !== -1 || line.indexOf('--continue --resume') !== -1) {
            resumeDetected = true;
        }
        if (/Copilot rate limit detected; retrying/i.test(line)) {
            rateLimitRetryCount += 1;
            rateLimitDetected = true;
        } else if (/rate limit|limit reset|You've hit your rate limit/i.test(line)) {
            rateLimitDetected = true;
        }
        if (lower.indexOf('exit code 124') !== -1 ||
            lower.indexOf('timed out') !== -1 ||
            lower.indexOf('command timeout') !== -1 ||
            lower.indexOf('timeout guard') !== -1) {
            timeoutCount += 1;
        }

        var request = parseRequestsLine(lines[i]);
        if (request) {
            lastRequests = request;
            continue;
        }

        var tokens = parseTokensLine(lines[i]);
        if (tokens) {
            samples.push(Object.assign({ attemptIndex: samples.length + 1 }, lastRequests || {}, tokens));
        }
    }

    if (!samples.length) return null;
    var finalSample = samples[samples.length - 1];
    var aggregate = {
        requests: 0,
        requestTier: finalSample.requestTier || '',
        requestDuration: finalSample.requestDuration || '',
        readTokens: 0,
        writeTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        samples: samples.length,
        resumeDetected: resumeDetected || samples.length > 1,
        resumeStages: resumeStages,
        feedbackLoopCount: feedbackLoopCount,
        rateLimitRetryCount: rateLimitRetryCount,
        rateLimitDetected: rateLimitDetected,
        timeoutCount: timeoutCount,
        attempts: samples
    };
    samples.forEach(function(sample) {
        aggregate.requests += sample.requests || 0;
        aggregate.readTokens += sample.readTokens || 0;
        aggregate.writeTokens += sample.writeTokens || 0;
        aggregate.cachedTokens += sample.cachedTokens || 0;
        aggregate.reasoningTokens += sample.reasoningTokens || 0;
    });
    return aggregate;
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
        'url'
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
        'rawTokensLine', 'url'
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
    var payload = JSON.stringify({ rows: rows, summary: summary });
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
        '.wrap{padding:12px 28px 32px;display:grid;gap:16px}.kpis{display:grid;grid-template-columns:repeat(11,minmax(105px,1fr));gap:12px}' +
        '.kpi,.panel{background:var(--panel);border:1px solid var(--grid);border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.04)}.kpi{padding:14px}.kpi b{display:block;font-size:22px;margin-top:4px}.kpi span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}' +
        '.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}.panel{padding:16px}.panel h2{font-size:16px;margin:0 0 12px}.chart{width:100%;height:340px;display:block}.pie{height:300px}' +
        'table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border-bottom:1px solid var(--grid);text-align:left;white-space:nowrap}th{font-size:12px;color:var(--muted);font-weight:600}th.sortable{cursor:pointer;user-select:none}th.sortable:after{content:"";display:inline-block;margin-left:5px;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #9aa4b2;vertical-align:middle}th.sortable.desc:after{border-top:0;border-bottom:5px solid #9aa4b2}td.num{text-align:right;font-variant-numeric:tabular-nums}.scroll{overflow:auto;max-height:520px}' +
        '.legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;color:var(--muted);font-size:12px}.dot{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:5px}.tooltip{position:fixed;z-index:10;display:none;max-width:260px;padding:8px 10px;border:1px solid #cfd6df;border-radius:6px;background:#111827;color:#fff;font-size:12px;line-height:1.4;box-shadow:0 8px 20px rgba(0,0,0,.18);pointer-events:none;white-space:pre-line}' +
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
        '<div class="kpi"><span>Read Tokens</span><b>' + formatShort(summary.totals.readTokens) + '</b></div>' +
        '<div class="kpi"><span>Write Tokens</span><b>' + formatShort(summary.totals.writeTokens) + '</b></div>' +
        '<div class="kpi"><span>Cached Tokens</span><b>' + formatShort(summary.totals.cachedTokens) + '</b></div>' +
        '<div class="kpi"><span>Reasoning Tokens</span><b>' + formatShort(summary.totals.reasoningTokens) + '</b></div>' +
        '</section>\n<section class="grid"><div class="panel"><h2>Daily Token Trend</h2><canvas id="daily" class="chart"></canvas><div class="legend"><span><i class="dot" style="background:#2563eb"></i>read</span><span><i class="dot" style="background:#059669"></i>write</span><span><i class="dot" style="background:#b7791f"></i>cached</span><span><i class="dot" style="background:#dc2626"></i>reasoning</span></div></div>' +
        '<div class="panel"><h2>Tokens By Agent</h2><canvas id="agents" class="chart"></canvas></div></section>\n' +
        '<section class="grid"><div class="panel"><h2>Agent Token Share</h2><canvas id="agentPie" class="chart pie"></canvas><div id="agentPieLegend" class="legend"></div></div>' +
        '<div class="panel"><h2>Token Type Share</h2><canvas id="tokenPie" class="chart pie"></canvas><div id="tokenPieLegend" class="legend"></div></div></section>\n' +
        '<section class="panel"><h2>Agent Totals And Averages</h2><div class="scroll"><table id="agentTable"><thead><tr><th class="sortable" data-type="text">Agent</th><th class="sortable" data-type="number">Runs</th><th class="sortable" data-type="number">Attempts</th><th class="sortable" data-type="number">Resume Runs</th><th class="sortable" data-type="number">Loops</th><th class="sortable" data-type="number">Limit Retries</th><th class="sortable" data-type="number">Timeouts</th><th class="sortable" data-type="number">Avg Duration</th><th class="sortable" data-type="number">Read</th><th class="sortable" data-type="number">Avg Read</th><th class="sortable" data-type="number">Write</th><th class="sortable" data-type="number">Avg Write</th><th class="sortable" data-type="number">Cached</th><th class="sortable" data-type="number">Reasoning</th></tr></thead><tbody>' +
        topAgents.map(function(a) {
            return '<tr><td' + sortAttr(a.key) + '>' + htmlEscape(a.key) + '</td><td class="num"' + sortAttr(a.runs) + '>' + a.runs + '</td><td class="num"' + sortAttr(a.samples) + '>' + a.samples + '</td><td class="num"' + sortAttr(a.resumedRuns) + '>' + a.resumedRuns + '</td><td class="num"' + sortAttr(a.feedbackLoopCount) + '>' + a.feedbackLoopCount + '</td><td class="num"' + sortAttr(a.rateLimitRetryCount) + '>' + a.rateLimitRetryCount + '</td><td class="num"' + sortAttr(a.timeoutCount) + '>' + a.timeoutCount + '</td><td class="num"' + sortAttr(a.avgDurationSeconds) + '>' + htmlEscape(a.avgDuration || '0s') + '</td><td class="num"' + sortAttr(a.readTokens) + '>' + formatShort(a.readTokens) + '</td><td class="num"' + sortAttr(a.avgReadTokens) + '>' + formatShort(a.avgReadTokens) + '</td><td class="num"' + sortAttr(a.writeTokens) + '>' + formatShort(a.writeTokens) + '</td><td class="num"' + sortAttr(a.avgWriteTokens) + '>' + formatShort(a.avgWriteTokens) + '</td><td class="num"' + sortAttr(a.cachedTokens) + '>' + formatShort(a.cachedTokens) + '</td><td class="num"' + sortAttr(a.reasoningTokens) + '>' + formatShort(a.reasoningTokens) + '</td></tr>';
        }).join('') +
        '</tbody></table></div></section>\n' +
        '<section class="panel"><h2>Recent Runs</h2><div class="scroll"><table id="runsTable"><thead><tr><th class="sortable" data-type="text">Created</th><th class="sortable" data-type="text">Agent</th><th class="sortable" data-type="text">Key</th><th class="sortable" data-type="text">Conclusion</th><th class="sortable" data-type="number">Duration</th><th class="sortable" data-type="number">Attempts</th><th class="sortable" data-type="text">Resume</th><th class="sortable" data-type="number">Loops</th><th class="sortable" data-type="number">Limit Retries</th><th class="sortable" data-type="number">Timeouts</th><th class="sortable" data-type="number">Read</th><th class="sortable" data-type="number">Write</th><th class="sortable" data-type="number">Cached</th><th class="sortable" data-type="number">Reasoning</th><th class="sortable" data-type="number">Run</th></tr></thead><tbody>' +
        recentRows.map(function(r) {
            return '<tr><td' + sortAttr(r.createdAt) + '>' + htmlEscape(r.createdAt) + '</td><td' + sortAttr(r.agent) + '>' + htmlEscape(r.agent) + '</td><td' + sortAttr(r.ticketKey) + '>' + htmlEscape(r.ticketKey) + '</td><td' + sortAttr(r.conclusion) + '>' + htmlEscape(r.conclusion) + '</td><td class="num"' + sortAttr(r.durationSeconds) + '>' + htmlEscape(r.duration || '0s') + '</td><td class="num"' + sortAttr(r.samples) + '>' + htmlEscape(r.samples || 1) + '</td><td' + sortAttr(r.resumeDetected ? 'yes' : 'no') + '>' + (r.resumeDetected ? 'yes' : 'no') + '</td><td class="num"' + sortAttr(r.feedbackLoopCount) + '>' + (r.feedbackLoopCount || 0) + '</td><td class="num"' + sortAttr(r.rateLimitRetryCount) + '>' + (r.rateLimitRetryCount || 0) + '</td><td class="num"' + sortAttr(r.timeoutCount) + '>' + (r.timeoutCount || 0) + '</td><td class="num"' + sortAttr(r.readTokens) + '>' + formatShort(r.readTokens) + '</td><td class="num"' + sortAttr(r.writeTokens) + '>' + formatShort(r.writeTokens) + '</td><td class="num"' + sortAttr(r.cachedTokens) + '>' + formatShort(r.cachedTokens) + '</td><td class="num"' + sortAttr(r.reasoningTokens) + '>' + formatShort(r.reasoningTokens) + '</td><td' + sortAttr(r.runNumber) + '><a href="' + htmlEscape(r.url) + '">#' + htmlEscape(r.runNumber) + '</a></td></tr>';
        }).join('') +
        '</tbody></table></div></section>\n</main><div id="chartTooltip" class="tooltip"></div>\n<script>const DATA=' + payload.replace(/</g, '\\u003c') + ';\n' +
        'function short(v){v=v||0;if(v>=1e9)return(v/1e9).toFixed(1).replace(/\\.0$/,"")+"b";if(v>=1e6)return(v/1e6).toFixed(1).replace(/\\.0$/,"")+"m";if(v>=1e3)return(v/1e3).toFixed(1).replace(/\\.0$/,"")+"k";return String(v)}' +
        'function labelLines(label,mode){let text=String(label||"");if(mode==="date")text=text.slice(5);if(mode==="agent"){const chunks=text.split("_");const lines=[];let line="";chunks.forEach(part=>{const next=line?line+"_"+part:part;if(next.length>14&&line){lines.push(line);line=part}else line=next});if(line)lines.push(line);return lines.slice(0,4)}return [text]}' +
        'function tip(){return document.getElementById("chartTooltip")}function showTip(ev,text){const t=tip();if(!t)return;t.textContent=text;t.style.display="block";const x=Math.min(innerWidth-280,ev.clientX+14),y=Math.min(innerHeight-120,ev.clientY+14);t.style.left=Math.max(8,x)+"px";t.style.top=Math.max(8,y)+"px"}function hideTip(){const t=tip();if(t)t.style.display="none"}' +
        'function bindTooltip(c,items){c._items=items;c.onmousemove=e=>{const r=c.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,hit=(c._items||[]).find(it=>x>=it.x&&x<=it.x+it.w&&y>=it.y&&y<=it.y+it.h);if(hit)showTip(e,hit.text);else hideTip()};c.onmouseleave=hideTip}' +
        'function drawBars(id, labels, series, options){options=options||{};const c=document.getElementById(id),ctx=c.getContext("2d"),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight,items=[];c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);const pad={l:54,r:18,t:12,b:options.bottom||82};const max=Math.max(1,...series.flatMap(s=>s.values));ctx.strokeStyle="#e1e5ea";ctx.fillStyle="#5f6b7a";ctx.font="12px -apple-system,Segoe UI,sans-serif";for(let i=0;i<=4;i++){let y=pad.t+(h-pad.t-pad.b)*i/4;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();ctx.fillText(short(max*(1-i/4)),6,y+4)}const groupW=(w-pad.l-pad.r)/Math.max(1,labels.length),barW=Math.max(3,Math.min(18,groupW/(series.length+1)));labels.forEach((lab,i)=>{series.forEach((s,j)=>{let val=s.values[i]||0,bh=(h-pad.t-pad.b)*val/max,x=pad.l+i*groupW+(groupW-series.length*barW)/2+j*barW,y=h-pad.b-bh;ctx.fillStyle=s.color;ctx.fillRect(x,y,barW*.75,bh);items.push({x:x,y:y,w:barW*.75,h:Math.max(2,bh),text:String(lab)+"\\n"+(s.label||"tokens")+": "+short(val)})});const lines=labelLines(lab,options.labelMode);ctx.fillStyle="#5f6b7a";ctx.textAlign="center";ctx.textBaseline="top";lines.forEach((line,k)=>ctx.fillText(line,pad.l+i*groupW+groupW/2,h-pad.b+10+k*13,Math.max(28,groupW-4)));ctx.textAlign="left";ctx.textBaseline="alphabetic"});bindTooltip(c,items)}' +
        'function drawPie(id,legendId,items){const c=document.getElementById(id),ctx=c.getContext("2d"),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight,hit=[];c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);const total=items.reduce((s,x)=>s+x.value,0)||1,cx=w/2,cy=h/2,r=Math.min(w,h)*.34;let a=-Math.PI/2;items.forEach(x=>{const start=a,span=x.value/total*Math.PI*2;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a,a+span);ctx.closePath();ctx.fillStyle=x.color;ctx.fill();hit.push({start:start,end:start+span,label:x.label,value:x.value});a+=span});c._items=[];c.onmousemove=e=>{const rect=c.getBoundingClientRect(),mx=e.clientX-rect.left-cx,my=e.clientY-rect.top-cy,dist=Math.sqrt(mx*mx+my*my);let ang=Math.atan2(my,mx);if(ang<-Math.PI/2)ang+=Math.PI*2;const found=dist<=r&&hit.find(x=>ang>=x.start&&ang<=x.end);if(found)showTip(e,found.label+": "+short(found.value)+" ("+((found.value/total)*100).toFixed(1)+"%)");else hideTip()};c.onmouseleave=hideTip;const el=document.getElementById(legendId);el.innerHTML=items.map(x=>"<span><i class=\\"dot\\" style=\\"background:"+x.color+"\\"></i>"+x.label+" "+short(x.value)+"</span>").join("")}' +
        'function makeSortable(id){const table=document.getElementById(id);if(!table)return;table.querySelectorAll("th.sortable").forEach((th,idx)=>th.addEventListener("click",()=>{const desc=!th.classList.contains("desc");table.querySelectorAll("th").forEach(h=>h.classList.remove("desc","asc"));th.classList.add(desc?"desc":"asc");const type=th.dataset.type||"text",body=table.tBodies[0],rows=Array.from(body.rows);rows.sort((a,b)=>{let av=a.cells[idx].dataset.sort||a.cells[idx].textContent,bv=b.cells[idx].dataset.sort||b.cells[idx].textContent;if(type==="number"){av=parseFloat(av)||0;bv=parseFloat(bv)||0;return desc?bv-av:av-bv}return desc?String(bv).localeCompare(String(av)):String(av).localeCompare(String(bv))});rows.forEach(r=>body.appendChild(r))}))}' +
        'const daily=DATA.summary.byDay;drawBars("daily",daily.map(x=>x.key),[{label:"read",color:"#2563eb",values:daily.map(x=>x.readTokens)},{label:"write",color:"#059669",values:daily.map(x=>x.writeTokens)},{label:"cached",color:"#b7791f",values:daily.map(x=>x.cachedTokens)},{label:"reasoning",color:"#dc2626",values:daily.map(x=>x.reasoningTokens)}],{labelMode:"date",bottom:70});' +
        'const agents=DATA.summary.byAgent.slice().sort((a,b)=>(b.readTokens+b.writeTokens+b.cachedTokens+b.reasoningTokens)-(a.readTokens+a.writeTokens+a.cachedTokens+a.reasoningTokens)).slice(0,12);drawBars("agents",agents.map(x=>x.key),[{label:"total",color:"#7c3aed",values:agents.map(x=>x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens)}],{labelMode:"agent",bottom:112});' +
        'const colors=["#2563eb","#059669","#b7791f","#dc2626","#7c3aed","#0891b2","#ea580c","#4f46e5","#64748b"];const agentPie=agents.slice(0,8).map((x,i)=>({label:x.key,value:x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens,color:colors[i%colors.length]}));const agentOther=DATA.summary.byAgent.reduce((s,x)=>s+x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens,0)-agentPie.reduce((s,x)=>s+x.value,0);if(agentOther>0)agentPie.push({label:"other",value:agentOther,color:"#94a3b8"});const tokenPie=[{label:"read",value:DATA.summary.totals.readTokens,color:"#2563eb"},{label:"write",value:DATA.summary.totals.writeTokens,color:"#059669"},{label:"cached",value:DATA.summary.totals.cachedTokens,color:"#b7791f"},{label:"reasoning",value:DATA.summary.totals.reasoningTokens,color:"#dc2626"}];drawPie("agentPie","agentPieLegend",agentPie);drawPie("tokenPie","tokenPieLegend",tokenPie);makeSortable("agentTable");makeSortable("runsTable");' +
        'addEventListener("resize",()=>{drawBars("daily",daily.map(x=>x.key),[{label:"read",color:"#2563eb",values:daily.map(x=>x.readTokens)},{label:"write",color:"#059669",values:daily.map(x=>x.writeTokens)},{label:"cached",color:"#b7791f",values:daily.map(x=>x.cachedTokens)},{label:"reasoning",color:"#dc2626",values:daily.map(x=>x.reasoningTokens)}],{labelMode:"date",bottom:70});drawBars("agents",agents.map(x=>x.key),[{label:"total",color:"#7c3aed",values:agents.map(x=>x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens)}],{labelMode:"agent",bottom:112});drawPie("agentPie","agentPieLegend",agentPie);drawPie("tokenPie","tokenPieLegend",tokenPie)});' +
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
    return {
        generatedAt: new Date().toISOString(),
        totalRuns: totalRuns,
        runsWithTokens: rows.length,
        runsWithoutTokens: Math.max(0, totalRuns - rows.length),
        totals: totals,
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

function action(params) {
    var custom = (params && params.jobParams && params.jobParams.customParams) || {};
    var projectConfig = configLoader.loadProjectConfig(params || {});
    custom.workspace = custom.workspace || custom.owner;
    custom.repository = custom.repository || custom.repo;
    if (!custom.workspace || custom.workspace.indexOf('{') !== -1) {
        custom.workspace = projectConfig.repository && projectConfig.repository.owner;
    }
    if (!custom.repository || custom.repository.indexOf('{') !== -1) {
        custom.repository = projectConfig.repository && projectConfig.repository.repo;
    }
    custom.workflowId = custom.workflowId || 'ai-teammate.yml';

    if (!custom.workspace || !custom.repository) {
        return { success: false, error: 'customParams.workspace and customParams.repository are required' };
    }

    var outputDir = custom.outputDir || 'outputs/token_usage';
    var csvPath = custom.csvPath || (outputDir + '/ai_teammate_token_usage.csv');
    var attemptsCsvPath = custom.attemptsCsvPath || (outputDir + '/ai_teammate_token_usage_attempts.csv');
    var jsonPath = custom.jsonPath || (outputDir + '/ai_teammate_token_usage.json');
    var htmlPath = custom.htmlPath || (outputDir + '/ai_teammate_token_usage.html');

    if (custom.renderOnly === true || custom.renderOnly === 'true') {
        var inputJsonPath = custom.inputJsonPath || jsonPath;
        var existing = parseJson(readInput(inputJsonPath), null);
        if (!existing || !existing.summary || !existing.rows) {
            return { success: false, error: 'Cannot render HTML: invalid token usage JSON at ' + inputJsonPath };
        }
        writeOutput(htmlPath, buildHtml(existing.rows, existing.summary));
        console.log('Wrote HTML: ' + htmlPath);
        return { success: true, renderOnly: true, jsonPath: inputJsonPath, htmlPath: htmlPath, summary: existing.summary };
    }

    console.log('AI Teammate Token Usage Reporter — ' + custom.workspace + '/' + custom.repository + ' [' + custom.workflowId + ']');
    var runs = listCompletedRuns(custom);
    console.log('Found ' + runs.length + ' completed workflow run(s)');

    var rows = [];
    var attemptRows = [];
    var logEvery = custom.logEvery || 50;
    var verbose = custom.verbose === true || custom.verbose === 'true';
    for (var i = 0; i < runs.length; i++) {
        var run = runs[i];
        var meta = extractAgentAndKey(run);
        var runId = String(run.id || run.databaseId);
        var durationSeconds = calculateDurationSeconds(run);
        var duration = formatDuration(durationSeconds);
        if (verbose || i === 0 || (i + 1) % logEvery === 0 || i === runs.length - 1) {
            console.log('  [' + (i + 1) + '/' + runs.length + '] ' + runId + ' ' + meta.title);
        }

        try {
            var logs = downloadRunLogs(custom, run);
            var usage = extractTokenUsage(logs);
            if (!usage) {
                if (verbose) console.log('    no token summary found');
                continue;
            }

            rows.push({
                runId: runId,
                runNumber: run.run_number || run.runNumber || '',
                createdAt: run.created_at || run.createdAt || '',
                startedAt: run.run_started_at || run.runStartedAt || '',
                updatedAt: run.updated_at || run.updatedAt || '',
                day: isoDay(run.created_at || run.createdAt || run.run_started_at || run.runStartedAt),
                conclusion: run.conclusion || '',
                agent: meta.agent,
                ticketKey: meta.ticketKey,
                configFile: meta.configFile,
                title: meta.title,
                durationSeconds: durationSeconds,
                duration: duration,
                requests: usage.requests || 0,
                requestTier: usage.requestTier || '',
                requestDuration: usage.requestDuration || '',
                readTokens: usage.readTokens || 0,
                writeTokens: usage.writeTokens || 0,
                cachedTokens: usage.cachedTokens || 0,
                reasoningTokens: usage.reasoningTokens || 0,
                samples: usage.samples || 1,
                resumeDetected: usage.resumeDetected === true,
                resumeStages: (usage.resumeStages || []).join('; '),
                feedbackLoopCount: usage.feedbackLoopCount || 0,
                rateLimitRetryCount: usage.rateLimitRetryCount || 0,
                rateLimitDetected: usage.rateLimitDetected === true,
                timeoutCount: usage.timeoutCount || 0,
                url: run.html_url || run.htmlUrl || ''
            });
            (usage.attempts || []).forEach(function(attempt) {
                attemptRows.push({
                    runId: runId,
                    runNumber: run.run_number || run.runNumber || '',
                    createdAt: run.created_at || run.createdAt || '',
                    day: isoDay(run.created_at || run.createdAt || run.run_started_at || run.runStartedAt),
                    conclusion: run.conclusion || '',
                    durationSeconds: durationSeconds,
                    duration: duration,
                    agent: meta.agent,
                    ticketKey: meta.ticketKey,
                    attemptIndex: attempt.attemptIndex || 1,
                    resumeDetected: usage.resumeDetected === true,
                    feedbackLoopCount: usage.feedbackLoopCount || 0,
                    rateLimitRetryCount: usage.rateLimitRetryCount || 0,
                    rateLimitDetected: usage.rateLimitDetected === true,
                    timeoutCount: usage.timeoutCount || 0,
                    requests: attempt.requests || 0,
                    requestTier: attempt.requestTier || '',
                    requestDuration: attempt.requestDuration || '',
                    readTokens: attempt.readTokens || 0,
                    writeTokens: attempt.writeTokens || 0,
                    cachedTokens: attempt.cachedTokens || 0,
                    reasoningTokens: attempt.reasoningTokens || 0,
                    rawTokensLine: attempt.rawTokensLine || '',
                    url: run.html_url || run.htmlUrl || ''
                });
            });
            if (verbose) {
                console.log('    tokens read=' + usage.readTokens + ' write=' + usage.writeTokens + ' cached=' + usage.cachedTokens + ' reasoning=' + usage.reasoningTokens + ' attempts=' + usage.samples);
            }
        } catch (e) {
            console.warn('    failed to process run ' + runId + ': ' + (e.message || e));
        }
    }

    var summary = buildSummary(rows, runs.length);
    var payload = { summary: summary, rows: rows, attempts: attemptRows };
    writeOutput(csvPath, buildCsv(rows));
    writeOutput(attemptsCsvPath, buildAttemptsCsv(attemptRows));
    writeOutput(jsonPath, JSON.stringify(payload, null, 2));
    writeOutput(htmlPath, buildHtml(rows, summary));

    console.log('Wrote CSV: ' + csvPath);
    console.log('Wrote attempts CSV: ' + attemptsCsvPath);
    console.log('Wrote JSON: ' + jsonPath);
    console.log('Wrote HTML: ' + htmlPath);
    return { success: true, csvPath: csvPath, attemptsCsvPath: attemptsCsvPath, jsonPath: jsonPath, htmlPath: htmlPath, summary: summary };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        parseNumberWithSuffix: parseNumberWithSuffix,
        parseTokensLine: parseTokensLine,
        extractTokenUsage: extractTokenUsage,
        extractAgentAndKey: extractAgentAndKey,
        calculateDurationSeconds: calculateDurationSeconds,
        formatDuration: formatDuration,
        listCompletedRuns: listCompletedRuns,
        buildCsv: buildCsv,
        buildAttemptsCsv: buildAttemptsCsv,
        buildSummary: buildSummary,
        buildHtml: buildHtml,
        sortAttr: sortAttr
    };
}
