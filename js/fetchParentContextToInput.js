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
var trackersModule = require('./common/trackers.js');

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

/** jira.fields map of the project config ({} when absent). */
function getJiraCustomFields(projectConfig) {
    return projectConfig && projectConfig.jira && projectConfig.jira.fields
        ? projectConfig.jira.fields
        : {};
}

/**
 * Aggregate only human-readable field names; skip raw customfield_* IDs
 * (e.g. bugSolution: 'customfield_10400' is technical, not for context).
 */
function isHumanReadableFieldName(fieldName) {
    return typeof fieldName === 'string' && fieldName.indexOf('customfield_') !== 0;
}

function pushIfAbsent(fields, fieldName) {
    if (fields.indexOf(fieldName) === -1) fields.push(fieldName);
}

function buildDefaultFields(projectConfig) {
    var fields = DEFAULT_FIELDS.slice();
    var customFields = getJiraCustomFields(projectConfig);
    for (var key in customFields) {
        if (Object.prototype.hasOwnProperty.call(customFields, key) && isHumanReadableFieldName(customFields[key])) {
            pushIfAbsent(fields, customFields[key]);
        }
    }
    return fields;
}

/** jira.parentContextFetch of the project config (null when absent). */
function getProjectParentContextFetch(projectConfig) {
    return projectConfig && projectConfig.jira
        ? projectConfig.jira.parentContextFetch
        : null;
}

/**
 * Legacy customParams API: the presence of jql/fields/contexts/childQuestions
 * directly on customParams is itself an override.
 */
function hasLegacyDirectOverrides(customParams) {
    return !!(customParams && (customParams.jql || customParams.fields || customParams.contexts || customParams.childQuestions));
}

/**
 * The SM/job override object: customParams.parentContextFetch when present,
 * else the whole customParams when it carries legacy direct keys, else null.
 */
function resolveOverrideCfg(customParams) {
    if (!customParams) return null;
    if (customParams.parentContextFetch) return customParams.parentContextFetch;
    return hasLegacyDirectOverrides(customParams) ? customParams : null;
}

/** Merge the override over the project config; an explicit disable stays a no-op. */
function resolveOverrideConfig(projectCfg, overrideCfg) {
    if (overrideCfg.enabled === false) return null;
    var overrideMergedCfg = mergeObjects(projectCfg || {}, overrideCfg);
    // Presence of the SM/job override is enough to enable this feature unless
    // it explicitly sets enabled:false. This preserves the old customParams API.
    if (overrideMergedCfg.enabled === false) overrideMergedCfg.enabled = true;
    return overrideMergedCfg;
}

/** Project-config-only mode needs an explicit enabled:true. */
function resolveProjectOnlyConfig(projectCfg) {
    if (!projectCfg || projectCfg.enabled !== true) return null;
    return projectCfg;
}

function resolveParentContextConfig(projectConfig, customParams) {
    var projectCfg = getProjectParentContextFetch(projectConfig);
    var overrideCfg = resolveOverrideCfg(customParams);

    if (!projectCfg && !overrideCfg) return null;
    if (overrideCfg) return resolveOverrideConfig(projectCfg, overrideCfg);
    return resolveProjectOnlyConfig(projectCfg);
}

function isSystemField(fieldName) {
    return fieldName === 'key' ||
        fieldName === 'summary' ||
        fieldName === 'description' ||
        fieldName === 'status' ||
        fieldName === 'comment';
}

/** Guard: only non-system, non-customfield names need a tracker lookup. */
function needsNameResolution(fieldName) {
    return !fieldName || isSystemField(fieldName) || fieldName.indexOf('customfield_') === 0;
}

/** dmtools may wrap the field code in a {result: ...} envelope — unwrap once. */
function unwrapTrackerResult(resolved) {
    if (resolved && typeof resolved === 'object' && resolved.result) return resolved.result;
    return resolved;
}

/** Record the human label for a resolved customfield_* code; null when not a code. */
function resolvedCustomFieldCode(resolved, fieldName, fieldLabels) {
    if (resolved && typeof resolved === 'string' && resolved.indexOf('customfield_') === 0) {
        fieldLabels[resolved] = fieldName;
        return resolved;
    }
    return null;
}

function resolveFieldName(fieldName, projectKey, fieldLabels, shouldResolve, tracker) {
    if (needsNameResolution(fieldName) || !shouldResolve || !tracker) {
        return fieldName;
    }

    try {
        var resolved = unwrapTrackerResult(tracker.fieldCode(projectKey, fieldName));
        var fieldCode = resolvedCustomFieldCode(resolved, fieldName, fieldLabels);
        if (fieldCode) return fieldCode;
    } catch (e) {
        console.warn('fetchParentContextToInput: could not resolve field "' + fieldName + '" — using as provided');
    }

    return fieldName;
}

function resolveFetchFields(fields, projectKey, fieldLabels, shouldResolve, tracker) {
    var resolved = [];
    for (var i = 0; i < fields.length; i++) {
        var fieldName = fields[i];
        var resolvedName = resolveFieldName(fieldName, projectKey, fieldLabels, shouldResolve, tracker);
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
 * Extract the comment list from a Jira comment field.
 * Handles both {total, comments:[]} shape and plain arrays.
 */
function extractComments(commentField) {
    if (Array.isArray(commentField)) return commentField;
    if (commentField && Array.isArray(commentField.comments)) return commentField.comments;
    return [];
}

/**
 * Render one comment as a blockquote line: author, date, body.
 */
function renderCommentLine(c) {
    var author = (c.author && (c.author.displayName || c.author.emailAddress)) || 'Unknown';
    var date = c.created ? c.created.substring(0, 10) : '';
    var body = c.body || '';
    return '> **' + author + '** (' + date + '):\n>\n> ' + body.replace(/\n/g, '\n> ');
}

/**
 * Render Jira comment field as a readable markdown section.
 * Returns '' when there are no comments.
 */
function renderCommentsMarkdown(commentField) {
    var comments = extractComments(commentField);
    if (comments.length === 0) return '';

    var lines = ['**Comments:**\n'];
    for (var i = 0; i < comments.length; i++) {
        lines.push(renderCommentLine(comments[i]));
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
/** Fields to fetch for the parent story: parentFields → fields → defaults. */
function resolveParentFetchFields(cfg, projectConfig, projectKey, fieldLabels, tracker) {
    var parentFields = cfg.parentFields || cfg.fields || buildDefaultFields(projectConfig);
    return resolveFetchFields(ensureBaseFields(parentFields), projectKey, fieldLabels, cfg.resolveFieldNames === true, tracker);
}

/** Rendered field section of a parent story ('_No content available._' when empty). */
function renderParentFieldsContent(pf, fetchParentFields, fieldLabels) {
    return renderFieldsMarkdown(pf, fetchParentFields, fieldLabels) || '_No content available._';
}

function buildParentStoryMarkdown(parentKey, pf, fieldsContent) {
    var summary = pf.summary || parentKey;
    var status = pf.status && pf.status.name || 'Unknown';
    var md = '# Parent Story — ' + summary + '\n\n';
    md += '**Ticket:** ' + parentKey + '\n';
    md += '**Status:** ' + status + '\n\n';
    md += '---\n\n';
    md += fieldsContent;
    md += '\n';
    return md;
}

function buildParentAsContextMarkdown(pac, parentKey, pf, fieldsContent) {
    var label = pac.label || 'Parent Context';
    var summary = pf.summary || parentKey;
    var status = pf.status && pf.status.name || 'Unknown';
    var ctxMd = '# ' + label + ' — ' + summary + '\n\n';
    if (pac.description) {
        ctxMd += '> **' + label + '** (' + parentKey + '): ' + pac.description + '\n\n';
    }
    ctxMd += '**Ticket:** ' + parentKey + '\n';
    ctxMd += '**Status:** ' + status + '\n\n';
    ctxMd += '---\n\n';
    ctxMd += fieldsContent;
    ctxMd += '\n';
    return ctxMd;
}

/**
 * Optionally write the parent story also as a named context file
 * (e.g. parent_context_ba.md) — cfg.parentAsContext = { file, label, description }.
 */
function writeParentAsContextFile(folder, parentKey, pac, pf, fieldsContent) {
    if (!pac || !pac.file) return;
    var ctxMd = buildParentAsContextMarkdown(pac, parentKey, pf, fieldsContent);
    file_write(folder + '/' + pac.file, ctxMd);
    console.log('✅ fetchParentContextToInput: wrote ' + pac.file + ' (parentAsContext from ' + parentKey + ')');
}

function fetchParentStory(folder, parentKey, cfg, projectConfig, projectKey, fieldLabels, tracker) {
    var fetchParentFields = resolveParentFetchFields(cfg, projectConfig, projectKey, fieldLabels, tracker);

    try {
        var parentTicket = tracker.getIssue(parentKey, fetchParentFields);
        if (!parentTicket || !parentTicket.fields) {
            console.warn('fetchParentContextToInput: parent ticket ' + parentKey + ' returned empty fields');
            return;
        }

        var pf = parentTicket.fields;
        var fieldsContent = renderParentFieldsContent(pf, fetchParentFields, fieldLabels);

        // Always write parent-{KEY}.md
        file_write(folder + '/parent-' + parentKey + '.md', buildParentStoryMarkdown(parentKey, pf, fieldsContent));
        console.log('✅ fetchParentContextToInput: wrote parent-' + parentKey + '.md');

        // Optionally also write as a named context file (e.g. parent_context_ba.md)
        writeParentAsContextFile(folder, parentKey, cfg.parentAsContext, pf, fieldsContent);
    } catch (e) {
        console.warn('fetchParentContextToInput: failed to fetch parent story ' + parentKey + ' (non-fatal):', e.message || e);
    }
}

/**
 * Main action — called from pre-CLI setup scripts.
 * No-op when parent context fetching is not enabled in project config or overrides.
 */

/**
 * Determine the ticket key: the input folder name wins over the ticket object.
 */
function resolveTicketKey(folder, ticket) {
    return folder ? folder.split('/').pop() : (ticket && ticket.key);
}

/**
 * Determine the ticket fields: from the passed ticket, else fetch by key.
 * Returns null ONLY when the fetch itself failed (caller must bail out —
 * the warning is logged here); returns undefined when the ticket was fetched
 * but carries no fields (caller falls through to the no-parent path).
 */
function resolveTicketFields(tracker, ticket, ticketKey) {
    var ticketFields = ticket && ticket.fields;
    if (ticketFields) return ticketFields;
    try {
        var fetched = tracker.getIssue(ticketKey);
        return fetched ? fetched.fields : undefined;
    } catch (e) {
        console.warn('fetchParentContextToInput: could not fetch ticket ' + ticketKey + ' — skipping', e);
        return null;
    }
}

/**
 * Project key for custom-field resolution: project config, else key prefix.
 */
function resolveProjectKey(projectConfig, parentKey, ticketKey) {
    return (projectConfig && projectConfig.jira && projectConfig.jira.project) ||
        parentKey.split('-')[0] ||
        ticketKey.split('-')[0];
}

/**
 * Resolve the run options from the merged config, applying defaults.
 */
function resolveFetchOptions(cfg, projectConfig) {
    return {
        jqlTemplate: cfg.jql || DEFAULT_JQL,
        siblingFields: cfg.siblingFields || cfg.fields || buildDefaultFields(projectConfig),
        contexts: cfg.contexts || DEFAULT_CONTEXTS,
        fieldLabels: cfg.fieldLabels || {},
        childQuestionsCfg: cfg.childQuestions || null
    };
}

/**
 * key/summary/status must always be requested so the header can be rendered.
 */
function ensureBaseFields(fields) {
    var fetchFields = fields.slice();
    ['key', 'summary', 'status'].forEach(function(f) {
        if (fetchFields.indexOf(f) === -1) fetchFields.unshift(f);
    });
    return fetchFields;
}

/**
 * Run the sibling JQL ({parentKey} replaced). Returns null when the search
 * failed (non-fatal); otherwise the result list (possibly empty).
 */
function searchSiblingTickets(tracker, jqlTemplate, parentKey, fetchFields) {
    var jql = jqlTemplate.replace(/\{parentKey\}/g, parentKey);
    console.log('fetchParentContextToInput: parent=' + parentKey + ', JQL: ' + jql);

    var results;
    try {
        // JQL text: provider-specific query (WIQL on ado)
        results = tracker.searchIssues(jql, { fields: fetchFields }) || [];
    } catch (e) {
        console.warn('fetchParentContextToInput: JQL search failed — skipping', e);
        return null;
    }

    console.log('fetchParentContextToInput: ' + results.length + ' results found');
    return results;
}

/**
 * Find the first context whose prefix (case-insensitive) appears in the summary.
 */
function findMatchingContext(summary, contexts) {
    for (var j = 0; j < contexts.length; j++) {
        if (summary.toUpperCase().indexOf(contexts[j].prefix.toUpperCase()) !== -1) return contexts[j];
    }
    return null;
}

/**
 * True when any requested field is missing in the search result
 * (key lives on the issue object, not in fields).
 */
function needsFullFetch(itemFields, fetchFields) {
    for (var i = 0; i < fetchFields.length; i++) {
        var f = fetchFields[i];
        if (f === 'key') continue;
        if (findFieldValue(itemFields, f) === undefined) return true;
    }
    return false;
}

/**
 * Re-fetch the full ticket; null when the fetch failed (non-fatal).
 */
function fetchFullTicket(tracker, itemKey) {
    try {
        return tracker.getIssue(itemKey);
    } catch (e) {
        console.warn('fetchParentContextToInput: re-fetch failed for ' + itemKey + ' (using partial data)', e);
        return null;
    }
}

/**
 * Merge full-ticket fields over the partial search result.
 * Full-ticket fields override; itemFields is returned untouched on empty full.
 */
function mergeTicketFields(itemFields, full) {
    if (!full || !full.fields) return itemFields;
    var merged = {};
    for (var k in itemFields) { merged[k] = itemFields[k]; }
    for (var k2 in full.fields) { merged[k2] = full.fields[k2]; }
    return merged;
}

/**
 * Build the markdown header for one matched context file.
 */
function buildContextMarkdown(ctx, itemKey, summary, itemFields, fieldsContent) {
    var md = '# ' + ctx.label + ' — ' + summary + '\n\n';
    if (ctx.description) {
        md += '> **' + ctx.label + '** (' + itemKey + '): ' + ctx.description + '\n\n';
    }
    md += '**Ticket:** ' + itemKey + '\n';
    md += '**Status:** ' + (itemFields.status && itemFields.status.name || 'Unknown') + '\n\n';
    md += '---\n\n';
    md += fieldsContent || '_No content available._';
    md += '\n';
    return md;
}

/**
 * Write one context file; write errors are non-fatal.
 */
function writeContextFile(filePath, md, ctxFile, itemKey) {
    try {
        file_write(filePath, md);
        console.log('✅ fetchParentContextToInput: wrote ' + ctxFile + ' (' + itemKey + ')');
    } catch (writeErr) {
        console.warn('fetchParentContextToInput: failed to write ' + filePath, writeErr);
    }
}

/**
 * Resolve the answer of a question item: the configured answer field,
 * falling back to its lowercase spelling.
 */
function findAnswer(qf, answerField) {
    return qf[answerField] || qf[answerField.toLowerCase()] || null;
}

/**
 * Render one question entry: title, description (when it is not the answer
 * itself), and the answer (or an explicit unanswered marker).
 */
function renderQuestionEntry(qItem, index, answerField) {
    var qf = qItem.fields || {};
    var answer = findAnswer(qf, answerField);
    var qMd = '**Q' + index + ': ' + (qf.summary || qItem.key) + '**\n\n';
    if (qf.description && qf.description !== answer) {
        qMd += qf.description + '\n\n';
    }
    qMd += answer
        ? '_Answer: ' + answer + '_\n\n'
        : '_Answer: (not yet answered)_\n\n';
    return qMd;
}

/**
 * Render the Questions & Answers appendix for one context ticket.
 */
function renderQuestionsMarkdown(itemKey, qResults, answerField) {
    var qMd = '\n\n---\n\n## Questions & Answers (' + itemKey + ')\n\n';
    for (var q = 0; q < qResults.length; q++) {
        qMd += renderQuestionEntry(qResults[q], q + 1, answerField);
    }
    return qMd;
}

/**
 * Fetch [Q] question sub-tasks of a context ticket (when configured) and
 * append them to its context file. All failures are non-fatal.
 */
function appendChildQuestions(filePath, itemKey, ctxFile, childQuestionsCfg, tracker) {
    try {
        var qJql = (childQuestionsCfg.jql || 'parent = {contextTicketKey} AND labels = Q ORDER BY created ASC')
            .replace(/\{contextTicketKey\}/g, itemKey);
        var answerField = childQuestionsCfg.answerField || 'description';
        var qResults = tracker.searchIssues(qJql, {
            fields: ['key', 'summary', 'description', 'status', answerField]
        }) || [];
        if (qResults.length === 0) return;

        var qMd = renderQuestionsMarkdown(itemKey, qResults, answerField);
        try {
            var existing = file_read({ path: filePath }) || '';
            file_write(filePath, existing + qMd);
            console.log('✅ fetchParentContextToInput: appended ' + qResults.length + ' Q(s) to ' + ctxFile);
        } catch (appendErr) {
            console.warn('fetchParentContextToInput: failed to append questions to ' + ctxFile, appendErr);
        }
    } catch (qErr) {
        console.warn('fetchParentContextToInput: childQuestions fetch failed for ' + itemKey + ' (non-fatal):', qErr);
    }
}

/** jobParams win when present; flat params double as jobParams. */
function resolveActionJobParams(params) {
    return params.jobParams || params;
}

/** The input folder lives on the run params; jobParams are the fallback. */
function resolveActualParams(params, jobParams) {
    return params.inputFolderPath ? params : jobParams;
}

function resolveActionCustomParams(jobParams) {
    return (jobParams.customParams) || {};
}

/** Project config through the (optional) configLoader; null when unavailable. */
function loadProjectConfigForAction(jobParams) {
    return configLoader && configLoader.loadProjectConfig
        ? configLoader.loadProjectConfig(jobParams)
        : null;
}

function resolveActionTicket(actualParams, jobParams) {
    return actualParams.ticket || (jobParams.ticket);
}

/**
 * Ticket key + parent key for the run, logging the skip reasons. Returns null
 * when the run must stop: key unknown, ticket fetch failed, or no parent.
 */
function resolveContextAnchor(tracker, ticket, folder) {
    var ticketKey = resolveTicketKey(folder, ticket);

    if (!ticketKey) {
        console.warn('fetchParentContextToInput: cannot determine ticketKey — skipping');
        return null;
    }

    // 1. Get parent key
    var ticketFields = resolveTicketFields(tracker, ticket, ticketKey);
    if (ticketFields === null) return null; // fetch failed — warning already logged

    var parentKey = ticketFields && ticketFields.parent && ticketFields.parent.key;
    if (!parentKey) {
        console.log('fetchParentContextToInput: ' + ticketKey + ' has no parent — skipping');
        return null;
    }

    return { ticketKey: ticketKey, parentKey: parentKey };
}

/** Sibling search fields: always base fields, resolved to tracker codes when asked. */
function resolveSiblingFetchFields(cfg, opts, projectKey, tracker) {
    // Always ensure base fields are present for sibling search
    return resolveFetchFields(ensureBaseFields(opts.siblingFields), projectKey, opts.fieldLabels, cfg.resolveFieldNames === true, tracker);
}

/**
 * Run the sibling JQL ({parentKey} replaced) and write one file per matched
 * context. An empty or failed search is a silent no-op.
 */
function writeSiblingContextFiles(tracker, opts, fetchFields, parentKey, folder) {
    // 3. Run JQL with {parentKey} replaced and match each result to a context
    var results = searchSiblingTickets(tracker, opts.jqlTemplate, parentKey, fetchFields);
    if (!results || results.length === 0) return;

    // 4. Write one file per matched context
    for (var i = 0; i < results.length; i++) {
        processContextItem(results[i], opts, fetchFields, folder, tracker);
    }
}

function action(params) {
    try {
        var jobParams = resolveActionJobParams(params);
        var actualParams = resolveActualParams(params, jobParams);
        var customParams = resolveActionCustomParams(jobParams);
        var projectConfig = loadProjectConfigForAction(jobParams);
        var cfg = resolveParentContextConfig(projectConfig, customParams);
        var tracker = trackersModule.createTracker(projectConfig, customParams);

        if (!cfg) {
            // Feature not enabled for this project/agent — silent no-op
            return;
        }

        var ticket = resolveActionTicket(actualParams, jobParams);
        var anchor = resolveContextAnchor(tracker, ticket, actualParams.inputFolderPath);
        if (!anchor) return;

        // Resolve configured options with defaults after parent is known so human-readable
        // custom fields can be resolved by project key when Jira requires customfield_* IDs.
        var opts = resolveFetchOptions(cfg, projectConfig);
        var projectKey = resolveProjectKey(projectConfig, anchor.parentKey, anchor.ticketKey);

        // 2. Fetch parent story itself (unless explicitly disabled)
        if (cfg.includeParentStory !== false) {
            fetchParentStory(actualParams.inputFolderPath, anchor.parentKey, cfg, projectConfig, projectKey, opts.fieldLabels, tracker);
        }

        var fetchFields = resolveSiblingFetchFields(cfg, opts, projectKey, tracker);
        writeSiblingContextFiles(tracker, opts, fetchFields, anchor.parentKey, actualParams.inputFolderPath);

    } catch (error) {
        console.warn('fetchParentContextToInput: unexpected error (non-fatal):', error);
    }
}

/**
 * Match one search result against the configured contexts and write its file.
 * Unmatched results are skipped; per-item failures are non-fatal.
 */
function processContextItem(item, opts, fetchFields, folder, tracker) {
    var itemFields = item.fields || {};
    var summary = itemFields.summary || '';

    var ctx = findMatchingContext(summary, opts.contexts);
    if (!ctx) return;

    // Re-fetch full ticket if any requested field is missing in search result
    if (needsFullFetch(itemFields, fetchFields)) {
        itemFields = mergeTicketFields(itemFields, fetchFullTicket(tracker, item.key));
    }

    // Build markdown
    var fieldsContent = renderFieldsMarkdown(itemFields, fetchFields, opts.fieldLabels);
    var md = buildContextMarkdown(ctx, item.key, summary, itemFields, fieldsContent);

    var filePath = folder + '/' + ctx.file;
    writeContextFile(filePath, md, ctx.file, item.key);

    // Append [Q] question sub-tasks of this context ticket (if configured)
    if (opts.childQuestionsCfg) {
        appendChildQuestions(filePath, item.key, ctx.file, opts.childQuestionsCfg, tracker);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        // Pure helpers, exported for direct unit testing:
        resolveParentContextConfig: resolveParentContextConfig,
        buildDefaultFields: buildDefaultFields,
        resolveFieldName: resolveFieldName,
        resolveFetchFields: resolveFetchFields,
        needsNameResolution: needsNameResolution,
        unwrapTrackerResult: unwrapTrackerResult,
        resolvedCustomFieldCode: resolvedCustomFieldCode
    };
}
