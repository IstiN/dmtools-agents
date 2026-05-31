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

    for (var i = 0; i < lines.length; i++) {
        var request = parseRequestsLine(lines[i]);
        if (request) {
            lastRequests = request;
            continue;
        }

        var tokens = parseTokensLine(lines[i]);
        if (tokens) {
            samples.push(Object.assign({}, lastRequests || {}, tokens));
        }
    }

    if (!samples.length) return null;
    var finalSample = samples[samples.length - 1];
    finalSample.samples = samples.length;
    return finalSample;
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
        'requests', 'requestTier', 'requestDuration',
        'readTokens', 'writeTokens', 'cachedTokens', 'reasoningTokens',
        'samples', 'url'
    ];
    var out = [headers.join(',')];
    rows.forEach(function(row) {
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
                reasoningTokens: 0
            };
        }
        var bucket = map[key];
        bucket.runs += 1;
        bucket.requests += row.requests || 0;
        bucket.readTokens += row.readTokens || 0;
        bucket.writeTokens += row.writeTokens || 0;
        bucket.cachedTokens += row.cachedTokens || 0;
        bucket.reasoningTokens += row.reasoningTokens || 0;
    });
    return Object.keys(map).sort().map(function(key) {
        var item = map[key];
        item.avgReadTokens = item.runs ? Math.round(item.readTokens / item.runs) : 0;
        item.avgWriteTokens = item.runs ? Math.round(item.writeTokens / item.runs) : 0;
        item.avgCachedTokens = item.runs ? Math.round(item.cachedTokens / item.runs) : 0;
        item.avgReasoningTokens = item.runs ? Math.round(item.reasoningTokens / item.runs) : 0;
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

function htmlEscape(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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
        '.wrap{padding:12px 28px 32px;display:grid;gap:16px}.kpis{display:grid;grid-template-columns:repeat(5,minmax(140px,1fr));gap:12px}' +
        '.kpi,.panel{background:var(--panel);border:1px solid var(--grid);border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.04)}.kpi{padding:14px}.kpi b{display:block;font-size:22px;margin-top:4px}.kpi span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}' +
        '.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}.panel{padding:16px}.panel h2{font-size:16px;margin:0 0 12px}.chart{width:100%;height:280px;display:block}' +
        'table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border-bottom:1px solid var(--grid);text-align:left;white-space:nowrap}th{font-size:12px;color:var(--muted);font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums}.scroll{overflow:auto;max-height:520px}' +
        '.legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;color:var(--muted);font-size:12px}.dot{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:5px}' +
        '@media(max-width:900px){.kpis,.grid{grid-template-columns:1fr}.wrap,header{padding-left:16px;padding-right:16px}}\n' +
        '</style>\n</head>\n<body>\n<header><h1>AI Teammate Token Usage</h1><p>Generated ' + htmlEscape(summary.generatedAt) + ' from completed workflow logs.</p></header>\n' +
        '<main class="wrap">\n<section class="kpis">' +
        '<div class="kpi"><span>Runs Parsed</span><b>' + summary.runsWithTokens + '</b></div>' +
        '<div class="kpi"><span>Read Tokens</span><b>' + formatShort(summary.totals.readTokens) + '</b></div>' +
        '<div class="kpi"><span>Write Tokens</span><b>' + formatShort(summary.totals.writeTokens) + '</b></div>' +
        '<div class="kpi"><span>Cached Tokens</span><b>' + formatShort(summary.totals.cachedTokens) + '</b></div>' +
        '<div class="kpi"><span>Reasoning Tokens</span><b>' + formatShort(summary.totals.reasoningTokens) + '</b></div>' +
        '</section>\n<section class="grid"><div class="panel"><h2>Daily Token Trend</h2><canvas id="daily" class="chart"></canvas><div class="legend"><span><i class="dot" style="background:#2563eb"></i>read</span><span><i class="dot" style="background:#059669"></i>write</span><span><i class="dot" style="background:#b7791f"></i>cached</span><span><i class="dot" style="background:#dc2626"></i>reasoning</span></div></div>' +
        '<div class="panel"><h2>Tokens By Agent</h2><canvas id="agents" class="chart"></canvas></div></section>\n' +
        '<section class="panel"><h2>Agent Totals And Averages</h2><div class="scroll"><table><thead><tr><th>Agent</th><th>Runs</th><th>Read</th><th>Avg Read</th><th>Write</th><th>Avg Write</th><th>Cached</th><th>Reasoning</th></tr></thead><tbody>' +
        topAgents.map(function(a) {
            return '<tr><td>' + htmlEscape(a.key) + '</td><td class="num">' + a.runs + '</td><td class="num">' + formatShort(a.readTokens) + '</td><td class="num">' + formatShort(a.avgReadTokens) + '</td><td class="num">' + formatShort(a.writeTokens) + '</td><td class="num">' + formatShort(a.avgWriteTokens) + '</td><td class="num">' + formatShort(a.cachedTokens) + '</td><td class="num">' + formatShort(a.reasoningTokens) + '</td></tr>';
        }).join('') +
        '</tbody></table></div></section>\n' +
        '<section class="panel"><h2>Recent Runs</h2><div class="scroll"><table><thead><tr><th>Created</th><th>Agent</th><th>Key</th><th>Conclusion</th><th>Read</th><th>Write</th><th>Cached</th><th>Reasoning</th><th>Run</th></tr></thead><tbody>' +
        recentRows.map(function(r) {
            return '<tr><td>' + htmlEscape(r.createdAt) + '</td><td>' + htmlEscape(r.agent) + '</td><td>' + htmlEscape(r.ticketKey) + '</td><td>' + htmlEscape(r.conclusion) + '</td><td class="num">' + formatShort(r.readTokens) + '</td><td class="num">' + formatShort(r.writeTokens) + '</td><td class="num">' + formatShort(r.cachedTokens) + '</td><td class="num">' + formatShort(r.reasoningTokens) + '</td><td><a href="' + htmlEscape(r.url) + '">#' + htmlEscape(r.runNumber) + '</a></td></tr>';
        }).join('') +
        '</tbody></table></div></section>\n</main>\n<script>const DATA=' + payload.replace(/</g, '\\u003c') + ';\n' +
        'function short(v){v=v||0;if(v>=1e9)return(v/1e9).toFixed(1).replace(/\\.0$/,"")+"b";if(v>=1e6)return(v/1e6).toFixed(1).replace(/\\.0$/,"")+"m";if(v>=1e3)return(v/1e3).toFixed(1).replace(/\\.0$/,"")+"k";return String(v)}' +
        'function drawBars(id, labels, series){const c=document.getElementById(id),ctx=c.getContext("2d"),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);const pad={l:54,r:14,t:12,b:54};const max=Math.max(1,...series.flatMap(s=>s.values));ctx.strokeStyle="#e1e5ea";ctx.fillStyle="#5f6b7a";ctx.font="12px -apple-system,Segoe UI,sans-serif";for(let i=0;i<=4;i++){let y=pad.t+(h-pad.t-pad.b)*i/4;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();ctx.fillText(short(max*(1-i/4)),6,y+4)}const groupW=(w-pad.l-pad.r)/Math.max(1,labels.length),barW=Math.max(3,groupW/(series.length+1));labels.forEach((lab,i)=>{series.forEach((s,j)=>{let val=s.values[i]||0,bh=(h-pad.t-pad.b)*val/max,x=pad.l+i*groupW+j*barW+barW*.35,y=h-pad.b-bh;ctx.fillStyle=s.color;ctx.fillRect(x,y,barW*.8,bh)});ctx.save();ctx.translate(pad.l+i*groupW+groupW*.35,h-pad.b+10);ctx.rotate(-Math.PI/5);ctx.fillStyle="#5f6b7a";ctx.fillText(lab,0,0);ctx.restore()})}' +
        'const daily=DATA.summary.byDay;drawBars("daily",daily.map(x=>x.key),[{color:"#2563eb",values:daily.map(x=>x.readTokens)},{color:"#059669",values:daily.map(x=>x.writeTokens)},{color:"#b7791f",values:daily.map(x=>x.cachedTokens)},{color:"#dc2626",values:daily.map(x=>x.reasoningTokens)}]);' +
        'const agents=DATA.summary.byAgent.slice().sort((a,b)=>(b.readTokens+b.writeTokens+b.cachedTokens+b.reasoningTokens)-(a.readTokens+a.writeTokens+a.cachedTokens+a.reasoningTokens)).slice(0,12);drawBars("agents",agents.map(x=>x.key),[{color:"#7c3aed",values:agents.map(x=>x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens)}]);' +
        'addEventListener("resize",()=>{drawBars("daily",daily.map(x=>x.key),[{color:"#2563eb",values:daily.map(x=>x.readTokens)},{color:"#059669",values:daily.map(x=>x.writeTokens)},{color:"#b7791f",values:daily.map(x=>x.cachedTokens)},{color:"#dc2626",values:daily.map(x=>x.reasoningTokens)}]);drawBars("agents",agents.map(x=>x.key),[{color:"#7c3aed",values:agents.map(x=>x.readTokens+x.writeTokens+x.cachedTokens+x.reasoningTokens)}])});' +
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
        reasoningTokens: 0
    };
    rows.forEach(function(row) {
        Object.keys(totals).forEach(function(key) {
            totals[key] += row[key] || 0;
        });
    });
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
    var jsonPath = custom.jsonPath || (outputDir + '/ai_teammate_token_usage.json');
    var htmlPath = custom.htmlPath || (outputDir + '/ai_teammate_token_usage.html');

    console.log('AI Teammate Token Usage Reporter — ' + custom.workspace + '/' + custom.repository + ' [' + custom.workflowId + ']');
    var runs = listCompletedRuns(custom);
    console.log('Found ' + runs.length + ' completed workflow run(s)');

    var rows = [];
    var logEvery = custom.logEvery || 50;
    var verbose = custom.verbose === true || custom.verbose === 'true';
    for (var i = 0; i < runs.length; i++) {
        var run = runs[i];
        var meta = extractAgentAndKey(run);
        var runId = String(run.id || run.databaseId);
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
                requests: usage.requests || 0,
                requestTier: usage.requestTier || '',
                requestDuration: usage.requestDuration || '',
                readTokens: usage.readTokens || 0,
                writeTokens: usage.writeTokens || 0,
                cachedTokens: usage.cachedTokens || 0,
                reasoningTokens: usage.reasoningTokens || 0,
                samples: usage.samples || 1,
                url: run.html_url || run.htmlUrl || ''
            });
            if (verbose) {
                console.log('    tokens read=' + usage.readTokens + ' write=' + usage.writeTokens + ' cached=' + usage.cachedTokens + ' reasoning=' + usage.reasoningTokens);
            }
        } catch (e) {
            console.warn('    failed to process run ' + runId + ': ' + (e.message || e));
        }
    }

    var summary = buildSummary(rows, runs.length);
    var payload = { summary: summary, rows: rows };
    writeOutput(csvPath, buildCsv(rows));
    writeOutput(jsonPath, JSON.stringify(payload, null, 2));
    writeOutput(htmlPath, buildHtml(rows, summary));

    console.log('Wrote CSV: ' + csvPath);
    console.log('Wrote JSON: ' + jsonPath);
    console.log('Wrote HTML: ' + htmlPath);
    return { success: true, csvPath: csvPath, jsonPath: jsonPath, htmlPath: htmlPath, summary: summary };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        parseNumberWithSuffix: parseNumberWithSuffix,
        parseTokensLine: parseTokensLine,
        extractTokenUsage: extractTokenUsage,
        extractAgentAndKey: extractAgentAndKey,
        listCompletedRuns: listCompletedRuns,
        buildCsv: buildCsv,
        buildSummary: buildSummary
    };
}
