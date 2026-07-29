/**
 * Fetch Parent Context To Input
 *
 * Opt-in, fully configurable context enrichment for pre-CLI agents.
 * Activated by project config (`jira.parentContextFetch.enabled`) or by SM/job
 * overrides (`customParams.parentContextFetch`).
 *
 * Workflow:
 *   1. Resolve the current ticket's parent key (from ticket.fields.parent).
 *   2. Run a JQL query ({parentKey} placeholder replaced) to find sibling tickets.
 *   3. Fetch each result with the configured fields.
 *   4. Match each result against configured contexts (by summary prefix).
 *   5. Write one markdown file per matched context into the input folder.
 *
 * Project configuration (preferred; use human-readable field names):
 *
 *   jira: {
 *     fields: {
 *       acceptanceCriteria: 'Acceptance Criteria'
 *     },
 *     parentContextFetch: {
 *       enabled: true
 *     }
 *   }
 *
 * Optional SM/job override:
 *
 *   customParams.parentContextFetch = {
 *     fields: ['key', 'summary', 'description', 'status', 'Acceptance Criteria', 'comment'],
 *     resolveFieldNames: false, // optional; true resolves human Jira names to customfield_* IDs at runtime
 *
 *     contexts: [
 *       {
 *         prefix: '[BA]',                   // case-insensitive match in summary
 *         file:   'parent_context_ba.md',   // output filename in input folder
 *         label:  'Business Analysis',      // heading in the markdown file
 *         description: 'Short explanation shown to the AI agent'
 *       },
 *       ...
 *     ],
 *
 *     // childQuestions (optional): for each matched BA/SA/VD ticket, also fetch
 *     // its [Q] question sub-tasks and append them to the context file.
 *     // {contextTicketKey} is replaced with the actual ticket key at runtime.
 *     childQuestions: {
 *       jql: 'parent = {contextTicketKey} AND labels = Q ORDER BY created ASC',
 *       answerField: 'description'   // Jira field holding the answer (default: 'description')
 *     }
 *   }
 *
 * If parent context fetching is not enabled in config/overrides → function is a no-op.
 * All errors are non-fatal; missing parent or empty results → silent skip.
 */

var configLoader = null;
try { configLoader = require('./configLoader.js'); } catch (e) { /* optional in unit tests */ }

// Note: "[" / "]" are Lucene range-query metacharacters, so inside a JQL quoted
// string they must be escaped with a literal backslash (\\[ / \\]) to be treated
// as plain text — a single backslash (\[) is rejected outright as an illegal JQL
// string escape sequence (only \\, \", \', \t, \n, \r, \<space>, \uXXXX are valid).
var DEFAULT_JQL = 'parent = {parentKey} AND (summary ~ "\\\\[BA\\\\]" OR summary ~ "\\\\[SA\\\\]" OR summary ~ "\\\\[VD\\\\]") ORDER BY created ASC';

var DEFAULT_FIELDS = ['key', 'summary', 'description', 'status', 'comment'];

var DEFAULT_CONTEXTS = [
    {
        prefix: '[BA]',
        file: 'parent_context_ba.md',
        label: 'Business Analysis',
        description: 'Business Analysis defines the acceptance criteria (ACs), business rules, and user flows. ' +
            'This is the authoritative source of truth for what must be implemented and tested. Every AC must be addressed.'
    },
    {
        prefix: '[SA]',
        file: 'parent_context_sa.md',
        label: 'Solution Architecture',
        description: 'Solution Architecture describes the technical design, data model, API contracts, and ' +
            'architectural decisions. Follow this design when implementing or reviewing code.'
    },
    {
        prefix: '[VD]',
        file: 'parent_context_vd.md',
        label: 'Visual Design',
        description: 'Visual Design contains UI mockups, component specifications, and design notes. ' +
            'Align the implementation with the expected look and feel described here.'
    }
];

function mergeObjects(base, override) {
    var result = {};
    var key;
    for (key in (base || {})) {
        if (Object.prototype.hasOwnProperty.call(base, key)) result[key] = base[key];
    }
    for (key in (override || {})) {
        if (Object.prototype.hasOwnProperty.call(override, key)) result[key] = override[key];
    }
    return result;
}

function buildDefaultFields(projectConfig) {
    var fields = DEFAULT_FIELDS.slice();
    var customFields = projectConfig && projectConfig.jira && projectConfig.jira.fields
        ? projectConfig.jira.fields
        : {};

    for (var key in customFields) {
        if (Object.prototype.hasOwnProperty.call(customFields, key)) {
            var fieldName = customFields[key];
            // Aggregate only human-readable field names; skip raw customfield_* IDs
            // (e.g. bugSolution: 'customfield_10400' is technical, not for context)
            if (typeof fieldName === 'string' && fieldName.indexOf('customfield_') !== 0) {
                if (fields.indexOf(fieldName) === -1) {
                    fields.push(fieldName);
                }
            }
        }
    }
    return fields;
}

function resolveParentContextConfig(projectConfig, customParams) {
    var projectCfg = projectConfig && projectConfig.jira
        ? projectConfig.jira.parentContextFetch
        : null;
    var legacyDirectCfg = customParams && (customParams.jql || customParams.fields || customParams.contexts || customParams.childQuestions)
        ? customParams
        : null;
    var overrideCfg = customParams && (customParams.parentContextFetch || legacyDirectCfg);

    if (!projectCfg && !overrideCfg) return null;

    if (overrideCfg) {
        if (overrideCfg.enabled === false) return null;
        var overrideMergedCfg = mergeObjects(projectCfg || {}, overrideCfg);
        // Presence of the SM/job override is enough to enable this feature unless
        // it explicitly sets enabled:false. This preserves the old customParams API.
        if (overrideMergedCfg.enabled === false) overrideMergedCfg.enabled = true;
        return overrideMergedCfg;
    }

    if (!projectCfg || projectCfg.enabled !== true) return null;
    return projectCfg;
}

function isSystemField(fieldName) {
    return fieldName === 'key' ||
        fieldName === 'summary' ||
        fieldName === 'description' ||
        fieldName === 'status' ||
        fieldName === 'comment';
}

function resolveFieldName(fieldName, projectKey, fieldLabels, shouldResolve) {
    if (!fieldName || isSystemField(fieldName) || fieldName.indexOf('customfield_') === 0) {
        return fieldName;
    }

    if (!shouldResolve) {
        return fieldName;
    }

    if (typeof jira_get_field_custom_code !== 'function') {
        return fieldName;
    }

    try {
        var resolved = jira_get_field_custom_code({ project: projectKey, fieldName: fieldName });
        if (resolved && typeof resolved === 'object' && resolved.result) resolved = resolved.result;
        if (resolved && typeof resolved === 'string' && resolved.indexOf('customfield_') === 0) {
            fieldLabels[resolved] = fieldName;
            return resolved;
        }
    } catch (e) {
        console.warn('fetchParentContextToInput: could not resolve field "' + fieldName + '" — using as provided');
    }

    return fieldName;
}

function resolveFetchFields(fields, projectKey, fieldLabels, shouldResolve) {
    var resolved = [];
    for (var i = 0; i < fields.length; i++) {
        var fieldName = fields[i];
        var resolvedName = resolveFieldName(fieldName, projectKey, fieldLabels, shouldResolve);
        if (resolved.indexOf(resolvedName) === -1) {
            resolved.push(resolvedName);
        }
    }
    return resolved;
}

/**
 * Find a field value in dmtools-returned fields object.
 * DMTools returns custom fields as "Label (customfield_ID)" keys,
 * so we need to match by suffix or exact name.
 */
function findFieldValue(fields, fieldName) {
    if (!fields || !fieldName) return undefined;
    // Exact match first
    if (fieldName in fields) return fields[fieldName];
    // Match by suffix "(fieldName)" — dmtools format: "Label (customfield_12345)"
    var suffix = '(' + fieldName + ')';
    var keys = Object.keys(fields);
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf(suffix) > -1) return fields[k];
    }
    return undefined;
}

/**
 * Extract human-readable label from dmtools field key.
 * "Acceptance Criteria (customfield_10397)" → "Acceptance Criteria"
 */
function extractFieldLabel(fieldKey) {
    var match = fieldKey.match(/^(.+?)\s*\(customfield_\d+\)$/);
    return match ? match[1].trim() : fieldKey;
}

/**
 * Render all fetched fields of a ticket into a markdown section.
 * Fields from the JQL search result + optionally the full ticket re-fetch.
 * @param {Object} fields       - ticket fields object
 * @param {Array}  configFields - field IDs/names requested
 * @param {Object} fieldLabels  - optional map of fieldId → human-readable label
 */
function renderFieldsMarkdown(fields, configFields, fieldLabels) {
    var labels = fieldLabels || {};
    var lines = [];
    var skip = { key: true, summary: true, status: true }; // already in header
    for (var i = 0; i < configFields.length; i++) {
        var fieldName = configFields[i];
        if (skip[fieldName]) continue;
        var val = findFieldValue(fields, fieldName);
        if (val === undefined || val === null || val === '') continue;

        // Special rendering for Jira comment field
        if (fieldName === 'comment') {
            var commentBlock = renderCommentsMarkdown(val);
            if (commentBlock) lines.push(commentBlock);
            continue;
        }

        var displayVal = (typeof val === 'object') ? JSON.stringify(val, null, 2) : String(val);
        // Use provided label, else extract from dmtools key format, else strip customfield_ prefix
        var displayName = labels[fieldName] || extractFieldLabel(fieldName);
        lines.push('**' + displayName + ':**\n\n' + displayVal);
    }
    return lines.join('\n\n');
}

/**
 * Render Jira comment field as a readable markdown section.
 * Handles both {total, comments:[]} shape and plain arrays.
 */
function renderCommentsMarkdown(commentField) {
    var comments = [];
    if (Array.isArray(commentField)) {
        comments = commentField;
    } else if (commentField && Array.isArray(commentField.comments)) {
        comments = commentField.comments;
    }
    if (comments.length === 0) return '';

    var lines = ['**Comments:**\n'];
    for (var i = 0; i < comments.length; i++) {
        var c = comments[i];
        var author = (c.author && (c.author.displayName || c.author.emailAddress)) || 'Unknown';
        var date = c.created ? c.created.substring(0, 10) : '';
        var body = c.body || '';
        lines.push('> **' + author + '** (' + date + '):\n>\n> ' + body.replace(/\n/g, '\n> '));
    }
    return lines.join('\n\n');
}

/**
 * Fetch the parent story itself and write it to parent-{KEY}.md,
 * and optionally also as a named context file (e.g. parent_context_ba.md)
 * when cfg.parentAsContext is configured.
 *
 * cfg.parentAsContext = {
 *   file:        'parent_context_ba.md',  // output file in input folder
 *   label:       'Business Analysis',     // heading label
 *   description: 'Short explanation...'   // optional blurb shown to AI
 * }
 */
function fetchParentStory(folder, parentKey, cfg, projectConfig, projectKey, fieldLabels) {
    var parentFields = cfg.parentFields || cfg.fields || buildDefaultFields(projectConfig);
    // Ensure base fields are present
    var fetchParentFields = parentFields.slice();
    ['key', 'summary', 'status'].forEach(function(f) {
        if (fetchParentFields.indexOf(f) === -1) fetchParentFields.unshift(f);
    });
    fetchParentFields = resolveFetchFields(fetchParentFields, projectKey, fieldLabels, cfg.resolveFieldNames === true);

    try {
        var parentTicket = jira_get_ticket({ key: parentKey, fields: fetchParentFields });
        if (!parentTicket || !parentTicket.fields) {
            console.warn('fetchParentContextToInput: parent ticket ' + parentKey + ' returned empty fields');
            return;
        }

        var pf = parentTicket.fields;
        var summary = pf.summary || parentKey;
        var status = pf.status && pf.status.name || 'Unknown';
        var fieldsContent = renderFieldsMarkdown(pf, fetchParentFields, fieldLabels);

        // Always write parent-{KEY}.md
        var md = '# Parent Story — ' + summary + '\n\n';
        md += '**Ticket:** ' + parentKey + '\n';
        md += '**Status:** ' + status + '\n\n';
        md += '---\n\n';
        md += fieldsContent || '_No content available._';
        md += '\n';

        var filePath = folder + '/parent-' + parentKey + '.md';
        file_write(filePath, md);
        console.log('✅ fetchParentContextToInput: wrote parent-' + parentKey + '.md');

        // Optionally also write as a named context file (e.g. parent_context_ba.md)
        var pac = cfg.parentAsContext;
        if (pac && pac.file) {
            var label = pac.label || 'Parent Context';
            var ctxMd = '# ' + label + ' — ' + summary + '\n\n';
            if (pac.description) {
                ctxMd += '> **' + label + '** (' + parentKey + '): ' + pac.description + '\n\n';
            }
            ctxMd += '**Ticket:** ' + parentKey + '\n';
            ctxMd += '**Status:** ' + status + '\n\n';
            ctxMd += '---\n\n';
            ctxMd += fieldsContent || '_No content available._';
            ctxMd += '\n';

            var ctxFilePath = folder + '/' + pac.file;
            file_write(ctxFilePath, ctxMd);
            console.log('✅ fetchParentContextToInput: wrote ' + pac.file + ' (parentAsContext from ' + parentKey + ')');
        }
    } catch (e) {
        console.warn('fetchParentContextToInput: failed to fetch parent story ' + parentKey + ' (non-fatal):', e.message || e);
    }
}

/**
 * Main action — called from pre-CLI setup scripts.
 * No-op when parent context fetching is not enabled in project config or overrides.
 */
function action(params) {
    try {
        var jobParams  = params.jobParams || params;
        var actualParams = params.inputFolderPath ? params : jobParams;
        var customParams = (jobParams.customParams) || {};
        var projectConfig = configLoader && configLoader.loadProjectConfig
            ? configLoader.loadProjectConfig(jobParams)
            : null;
        var cfg = resolveParentContextConfig(projectConfig, customParams);

        if (!cfg) {
            // Feature not enabled for this project/agent — silent no-op
            return;
        }

        var folder = actualParams.inputFolderPath;
        var ticket = actualParams.ticket || (jobParams.ticket);
        var ticketKey = folder ? folder.split('/').pop() : (ticket && ticket.key);

        if (!ticketKey) {
            console.warn('fetchParentContextToInput: cannot determine ticketKey — skipping');
            return;
        }

        // 1. Get parent key
        var ticketFields = ticket && ticket.fields;
        if (!ticketFields) {
            try {
                var fetched = jira_get_ticket({ key: ticketKey });
                ticketFields = fetched && fetched.fields;
            } catch (e) {
                console.warn('fetchParentContextToInput: could not fetch ticket ' + ticketKey + ' — skipping', e);
                return;
            }
        }

        var parentKey = ticketFields && ticketFields.parent && ticketFields.parent.key;
        if (!parentKey) {
            console.log('fetchParentContextToInput: ' + ticketKey + ' has no parent — skipping');
            return;
        }

        // Resolve configured options with defaults after parent is known so human-readable
        // custom fields can be resolved by project key when Jira requires customfield_* IDs.
        var jqlTemplate = cfg.jql || DEFAULT_JQL;
        var siblingFields = cfg.siblingFields || cfg.fields || buildDefaultFields(projectConfig);
        var contexts    = cfg.contexts || DEFAULT_CONTEXTS;
        var fieldLabels = cfg.fieldLabels || {};
        var childQuestionsCfg = cfg.childQuestions || null;
        var projectKey = (projectConfig && projectConfig.jira && projectConfig.jira.project) ||
            parentKey.split('-')[0] ||
            ticketKey.split('-')[0];

        // 2. Fetch parent story itself (unless explicitly disabled)
        if (cfg.includeParentStory !== false) {
            fetchParentStory(folder, parentKey, cfg, projectConfig, projectKey, fieldLabels);
        }

        // Always ensure base fields are present for sibling search
        var fetchFields = siblingFields.slice();
        ['key', 'summary', 'status'].forEach(function(f) {
            if (fetchFields.indexOf(f) === -1) fetchFields.unshift(f);
        });
        fetchFields = resolveFetchFields(fetchFields, projectKey, fieldLabels, cfg.resolveFieldNames === true);

        // 3. Run JQL with {parentKey} replaced
        var jql = jqlTemplate.replace(/\{parentKey\}/g, parentKey);
        console.log('fetchParentContextToInput: parent=' + parentKey + ', JQL: ' + jql);

        var results = [];
        try {
            results = jira_search_by_jql({ jql: jql, fields: fetchFields }) || [];
        } catch (e) {
            console.warn('fetchParentContextToInput: JQL search failed — skipping', e);
            return;
        }

        console.log('fetchParentContextToInput: ' + results.length + ' results found');
        if (results.length === 0) return;

        // 3. Match each result to a context and write file
        for (var i = 0; i < results.length; i++) {
            var item = results[i];
            var itemFields = item.fields || {};
            var summary = itemFields.summary || '';

            for (var j = 0; j < contexts.length; j++) {
                var ctx = contexts[j];
                if (summary.toUpperCase().indexOf(ctx.prefix.toUpperCase()) === -1) continue;

                // Re-fetch full ticket if any requested field is missing in search result
                var needsFullFetch = fetchFields.some(function(f) {
                    if (f === 'key') return false; // key lives on the issue object, not fields
                    return findFieldValue(itemFields, f) === undefined;
                });
                if (needsFullFetch) {
                    try {
                        var full = jira_get_ticket({ key: item.key });
                        if (full && full.fields) {
                            // Merge: full ticket fields override partial search result
                            var merged = {};
                            for (var k in itemFields) { merged[k] = itemFields[k]; }
                            for (var k2 in full.fields) { merged[k2] = full.fields[k2]; }
                            itemFields = merged;
                        }
                    } catch (e) {
                        console.warn('fetchParentContextToInput: re-fetch failed for ' + item.key + ' (using partial data)', e);
                    }
                }

                // Build markdown
                var md = '# ' + ctx.label + ' — ' + summary + '\n\n';
                if (ctx.description) {
                    md += '> **' + ctx.label + '** (' + item.key + '): ' + ctx.description + '\n\n';
                }
                md += '**Ticket:** ' + item.key + '\n';
                md += '**Status:** ' + (itemFields.status && itemFields.status.name || 'Unknown') + '\n\n';
                md += '---\n\n';

                var fieldsContent = renderFieldsMarkdown(itemFields, fetchFields, fieldLabels);
                md += fieldsContent || '_No content available._';
                md += '\n';

                var filePath = folder + '/' + ctx.file;
                try {
                    file_write(filePath, md);
                    console.log('✅ fetchParentContextToInput: wrote ' + ctx.file + ' (' + item.key + ')');
                } catch (writeErr) {
                    console.warn('fetchParentContextToInput: failed to write ' + filePath, writeErr);
                }

                // Append [Q] question sub-tasks of this context ticket (if configured)
                if (childQuestionsCfg) {
                    try {
                        var qJql = (childQuestionsCfg.jql || 'parent = {contextTicketKey} AND labels = Q ORDER BY created ASC')
                            .replace(/\{contextTicketKey\}/g, item.key);
                        var answerField = childQuestionsCfg.answerField || 'description';
                        var qResults = jira_search_by_jql({
                            jql: qJql,
                            fields: ['key', 'summary', 'description', 'status', answerField]
                        }) || [];
                        if (qResults.length > 0) {
                            var qMd = '\n\n---\n\n## Questions & Answers (' + item.key + ')\n\n';
                            for (var q = 0; q < qResults.length; q++) {
                                var qItem = qResults[q];
                                var qf = qItem.fields || {};
                                var answer = qf[answerField] || qf[answerField.toLowerCase()] || null;
                                qMd += '**Q' + (q + 1) + ': ' + (qf.summary || qItem.key) + '**\n\n';
                                if (qf.description && qf.description !== answer) {
                                    qMd += qf.description + '\n\n';
                                }
                                qMd += answer
                                    ? '_Answer: ' + answer + '_\n\n'
                                    : '_Answer: (not yet answered)_\n\n';
                            }
                            try {
                                var existing = file_read({ path: filePath }) || '';
                                file_write(filePath, existing + qMd);
                                console.log('✅ fetchParentContextToInput: appended ' + qResults.length + ' Q(s) to ' + ctx.file);
                            } catch (appendErr) {
                                console.warn('fetchParentContextToInput: failed to append questions to ' + ctx.file, appendErr);
                            }
                        }
                    } catch (qErr) {
                        console.warn('fetchParentContextToInput: childQuestions fetch failed for ' + item.key + ' (non-fatal):', qErr);
                    }
                }

                break;
            }
        }

    } catch (error) {
        console.warn('fetchParentContextToInput: unexpected error (non-fatal):', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
