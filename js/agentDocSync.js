/**
 * Agent Documentation Sync (JSRunner)
 *
 * Reads sm.json to discover all agent configs in the pipeline, then reads each
 * config and its referenced prompt files to generate a structured Confluence page
 * documenting every agent.
 *
 * The generated page is fully managed by this job — do not edit manually.
 * Run agent_doc_sync.json to refresh after any agent config changes.
 *
 * customParams:
 *   smJsonPath         — path to sm.json              (default: "agents/sm.json")
 *   confluenceSpace    — Confluence space key          (required, e.g. "AS")
 *   confluencePageTitle — Confluence page title        (required)
 *   confluencePageId   — page ID for direct lookup    (optional, faster than title search)
 *   confluenceParentId — parent page ID for creation  (optional)
 */

// ─── Main ─────────────────────────────────────────────────────────────────────

function action(params) {
    var custom      = (params.jobParams && params.jobParams.customParams) || {};
    var smJsonPath  = custom.smJsonPath          || 'agents/sm.json';
    var space       = custom.confluenceSpace;
    var pageTitle   = custom.confluencePageTitle;
    var pageId      = custom.confluencePageId    || null;
    var parentId    = custom.confluenceParentId  || null;

    if (!space || !pageTitle) {
        console.error('❌ customParams must include confluenceSpace and confluencePageTitle');
        return { success: false, error: 'Missing required customParams: confluenceSpace, confluencePageTitle' };
    }

    // 1. Discover agent configs from sm.json
    console.log('📖 Reading SM config: ' + smJsonPath);
    var rules = loadSmRules(smJsonPath);
    if (!rules || rules.length === 0) {
        console.error('❌ No SM rules found in ' + smJsonPath);
        return { success: false, error: 'No SM rules found in ' + smJsonPath };
    }
    console.log('Found ' + rules.length + ' SM rules');

    // 2. Build doc entries from unique configFile references
    var entries = buildDocEntries(rules);
    if (entries.length === 0) {
        console.error('❌ No documentable agents found — refusing to publish empty page');
        return { success: false, error: 'No documentable agents found' };
    }
    console.log('Documenting ' + entries.length + ' unique agents');

    // 3. Build full page HTML
    var html = buildPageHtml(entries, smJsonPath);

    // 4. Fetch current page and update or create
    var currentPage = fetchPage(pageId, pageTitle, space);
    if (currentPage) {
        var existingId     = pageId || currentPage.id;
        var existingParent = extractParentId(currentPage) || parentId || '';
        console.log('📝 Updating page "' + pageTitle + '" (id: ' + existingId + ')');
        confluence_update_page_with_history(
            existingId,
            pageTitle,
            html,
            existingParent,
            space,
            'Auto-sync: ' + entries.length + ' agents documented from ' + smJsonPath
        );
        console.log('✅ Page updated');
    } else if (parentId) {
        console.log('🆕 Creating page "' + pageTitle + '" under parent ' + parentId);
        confluence_create_page(pageTitle, html, parentId, space);
        console.log('✅ Page created');
    } else {
        console.error('❌ Page "' + pageTitle + '" not found. Set confluenceParentId to allow creation.');
        return { success: false, error: 'Page not found; set confluenceParentId to create it' };
    }

    return { success: true, agentsDocumented: entries.length };
}

// ─── SM rule discovery ────────────────────────────────────────────────────────

function loadSmRules(smJsonPath) {
    var content = tryReadFile(smJsonPath);
    if (!content) {
        console.warn('⚠️  Could not read ' + smJsonPath);
        return [];
    }
    try {
        var smConfig = JSON.parse(content);
        // sm.json is a JSRunner config; rules live in params.jobParams.rules
        var jobParams = (smConfig.params && smConfig.params.jobParams) || {};
        return jobParams.rules || [];
    } catch (e) {
        console.error('❌ Failed to parse ' + smJsonPath + ': ' + (e.message || e));
        return [];
    }
}

// ─── Doc entry construction ───────────────────────────────────────────────────

function buildDocEntries(rules) {
    var seen    = {};
    var ordered = [];

    for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        var cf   = rule.configFile;

        // Skip rules without a config file or that run locally as orchestration helpers
        if (!cf || rule.localExecution) continue;

        if (!seen[cf]) {
            var entry = buildEntry(cf, rule);
            if (entry) {
                seen[cf] = entry;
                ordered.push(entry);
            }
        } else {
            // Same config referenced from multiple rules — record extra trigger
            seen[cf].triggers.push({
                description: rule.description || '',
                jql:         rule.jql         || ''
            });
        }
    }

    // Stable sort by config file name
    ordered.sort(function(a, b) {
        return a.configFile < b.configFile ? -1 : a.configFile > b.configFile ? 1 : 0;
    });
    return ordered;
}

function buildEntry(configFilePath, firstRule) {
    var configContent = tryReadFile(configFilePath);
    if (!configContent) {
        console.warn('⚠️  Could not read config: ' + configFilePath);
        return null;
    }

    var config;
    try {
        config = JSON.parse(configContent);
    } catch (e) {
        console.warn('⚠️  Invalid JSON in ' + configFilePath + ': ' + (e.message || e));
        return null;
    }

    var params      = config.params      || {};
    var agentParams = params.agentParams || {};
    var agentName   = configFilePath.replace(/^.*\//, '').replace(/\.json$/, '');
    var jobType     = config.name        || 'Unknown';

    var actionText = extractActionFromPrompt(params.cliPrompt, agentParams.aiRole, jobType);
    var outputText = inferOutput(params, agentParams);

    return {
        configFile : configFilePath,
        agentName  : agentName,
        jobType    : jobType,
        triggers   : [{ description: firstRule.description || '', jql: firstRule.jql || '' }],
        action     : actionText,
        output     : outputText
    };
}

// ─── Prompt / output extraction ───────────────────────────────────────────────

function extractActionFromPrompt(cliPrompt, aiRole, jobType) {
    var rolePrefix = aiRole ? 'AI Role: ' + aiRole + '. ' : '';

    if (cliPrompt) {
        var content = tryReadFile(cliPrompt);
        if (content) {
            var lines  = content.split('\n');
            var para   = [];
            var inPara = false;
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line.startsWith('#'))           { inPara = false; continue; }
                if (line === '')                    { if (inPara && para.length > 0) break; continue; }
                inPara = true;
                para.push(line);
                if (para.length >= 3) break;
            }
            if (para.length > 0) {
                return (rolePrefix + para.join(' ')).substring(0, 300);
            }
        }
    }

    return rolePrefix ? rolePrefix.trim() : jobType + ' job';
}

function inferOutput(params, agentParams) {
    var parts = [];

    var outputType = params.outputType;
    if (outputType && outputType !== 'none') parts.push('Output type: ' + outputType);

    if (params.attachResponseAsFile) parts.push('AI response attached as file');

    if (params.postJSAction) {
        parts.push('Post-action: ' + params.postJSAction.replace(/^.*\//, ''));
    }

    if (agentParams && agentParams.formattingRules) {
        parts.push(agentParams.formattingRules.substring(0, 120));
    }

    return parts.length > 0 ? parts.join('. ') : 'Updates Jira ticket';
}

// ─── Confluence helpers ───────────────────────────────────────────────────────

function fetchPage(pageId, title, space) {
    if (pageId) {
        try {
            var raw = confluence_content_by_id(pageId);
            if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
            console.warn('⚠️  confluence_content_by_id failed: ' + (e.message || e));
        }
    }
    try {
        var raw = confluence_find_content_by_title_and_space(title, space);
        if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
        console.warn('⚠️  confluence_find_content_by_title_and_space failed: ' + (e.message || e));
    }
    return null;
}

function extractParentId(page) {
    if (!page) return null;
    var ancestors = page.ancestors;
    if (Array.isArray(ancestors) && ancestors.length > 0) {
        return ancestors[ancestors.length - 1].id;
    }
    return null;
}

// ─── HTML generation ──────────────────────────────────────────────────────────

function buildPageHtml(entries, smJsonPath) {
    var rows = entries.map(function(e) {
        var triggerCell = e.triggers.map(function(t) {
            var desc = t.description ? '<strong>' + esc(t.description) + '</strong><br/>' : '';
            var jql  = t.jql        ? '<code>'   + esc(t.jql)         + '</code>'        : '';
            return desc + jql;
        }).join('<hr/>');

        return '<tr>' +
            '<td><code>' + esc(e.agentName) + '</code></td>' +
            '<td>' + triggerCell + '</td>' +
            '<td>' + esc(e.action) + '</td>' +
            '<td>' + esc(e.output) + '</td>' +
            '</tr>';
    }).join('');

    return '<p><em>Auto-generated by <code>agent_doc_sync.json</code> from <code>' +
        esc(smJsonPath) + '</code>. Do not edit manually — run the job to refresh.</em></p>' +
        '<h2>Agent Reference</h2>' +
        '<table><tbody>' +
        '<tr><th>Agent Name</th><th>Trigger (SM rule)</th><th>Action</th><th>Output</th></tr>' +
        rows +
        '</tbody></table>';
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function tryReadFile(path) {
    if (!path) return null;
    try {
        var content = file_read(path);
        return (content && content.trim()) ? content : null;
    } catch (e) {
        return null;
    }
}

function esc(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
