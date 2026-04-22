/**
 * Fetch Parent Context To Input
 *
 * Opt-in, fully configurable context enrichment for pre-CLI agents.
 * Activated only when `customParams.parentContextFetch` is defined.
 *
 * Workflow:
 *   1. Resolve the current ticket's parent key (from ticket.fields.parent).
 *   2. Run a JQL query ({parentKey} placeholder replaced) to find sibling tickets.
 *   3. Fetch each result with the configured fields.
 *   4. Match each result against configured contexts (by summary prefix).
 *   5. Write one markdown file per matched context into the input folder.
 *
 * Configuration (all fields optional except being present at all):
 *
 *   customParams.parentContextFetch = {
 *     // JQL to find context siblings. {parentKey} is replaced at runtime.
 *     jql: 'parent = {parentKey} AND (summary ~ "[BA]" OR summary ~ "[SA]" OR summary ~ "[VD]") ORDER BY created ASC',
 *
 *     // Jira fields to fetch for each matched ticket.
 *     fields: ['key', 'summary', 'description', 'status', 'customfield_10001'],
 *
 *     // fieldLabels: optional map of fieldId → human-readable display name.
 *     fieldLabels: { 'customfield_11700': 'Acceptance Criteria' },
 *
 *     // Contexts: how to match and name each file.
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
 * If `customParams.parentContextFetch` is absent → function is a no-op.
 * All errors are non-fatal; missing parent or empty results → silent skip.
 */

var DEFAULT_JQL = 'parent = {parentKey} AND (summary ~ "\\[BA\\]" OR summary ~ "\\[SA\\]" OR summary ~ "\\[VD\\]") ORDER BY created ASC';

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
        var val = fields[fieldName];
        if (val === undefined || val === null || val === '') continue;

        // Special rendering for Jira comment field
        if (fieldName === 'comment') {
            var commentBlock = renderCommentsMarkdown(val);
            if (commentBlock) lines.push(commentBlock);
            continue;
        }

        var displayVal = (typeof val === 'object') ? JSON.stringify(val, null, 2) : String(val);
        // Use provided label, else strip customfield_ prefix for readability
        var displayName = labels[fieldName] || fieldName.replace(/^customfield_\d+$/, fieldName);
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
 * Main action — called from pre-CLI setup scripts.
 * No-op when customParams.parentContextFetch is absent.
 */
function action(params) {
    try {
        var jobParams  = params.jobParams || params;
        var actualParams = params.inputFolderPath ? params : jobParams;
        var customParams = (jobParams.customParams) || {};
        var cfg = customParams.parentContextFetch;

        if (!cfg) {
            // Feature not configured for this agent — silent no-op
            return;
        }

        var folder = actualParams.inputFolderPath;
        var ticket = actualParams.ticket || (jobParams.ticket);
        var ticketKey = folder ? folder.split('/').pop() : (ticket && ticket.key);

        if (!ticketKey) {
            console.warn('fetchParentContextToInput: cannot determine ticketKey — skipping');
            return;
        }

        // Resolve configured options with defaults
        var jqlTemplate = cfg.jql || DEFAULT_JQL;
        var fields      = cfg.fields || DEFAULT_FIELDS;
        var contexts    = cfg.contexts || DEFAULT_CONTEXTS;
        var fieldLabels = cfg.fieldLabels || {};
        var childQuestionsCfg = cfg.childQuestions || null;

        // Always ensure base fields are present
        var fetchFields = fields.slice();
        ['key', 'summary', 'status'].forEach(function(f) {
            if (fetchFields.indexOf(f) === -1) fetchFields.unshift(f);
        });

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

        // 2. Run JQL with {parentKey} replaced
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
                    return !(f in itemFields) || itemFields[f] === undefined;
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

module.exports = { action: action };
