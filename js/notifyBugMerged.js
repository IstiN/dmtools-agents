/**
 * Notify Bug Merged Post-Action
 * postJSAction for bug_merged agent.
 *
 * Called when a Bug PR is merged and the ticket reaches "Merged" status.
 * 1. Generates RCA + prevention summary and writes it to the Solution field.
 * 2. Posts a Jira comment.
 * 3. Removes SM idempotency label.
 * Status transition to "Ready For Testing" is handled by the SM targetStatus rule.
 */

const { LABELS } = require('./config.js');

/**
 * Find the bug fix development comment from Jira comments.
 * The bug_development agent posts a comment that contains "Bug Fix Summary"
 * or "Root Cause" sections from outputs/response.md.
 */
function findDevSummaryComment(comments) {
    if (!comments || !Array.isArray(comments)) return '';
    const markers = ['Bug Fix Summary', 'Root Cause', 'rca.md', 'Fix Applied'];
    const found = comments.filter(function(c) {
        const body = c.body || '';
        return markers.some(function(m) { return body.indexOf(m) !== -1; });
    });
    // Use the most recent matching comment
    return found.length > 0 ? found[found.length - 1].body : '';
}

/**
 * Use AI to generate a Solution field value from the bug description + dev summary.
 * Writes the result to the Jira "Solution" field so the TestCasesGenerator
 * has RCA context when generating regression and prevention test cases.
 */
function updateSolutionField(ticketKey, ticketDescription, comments) {
    try {
        const devSummary = findDevSummaryComment(comments);

        const prompt =
            'You are writing the *Solution* field for a Jira Bug ticket.\n' +
            'The field must be in Jira Markup and cover three sections:\n\n' +
            'h4. Root Cause\n' +
            '1-3 sentences: the exact technical cause of the bug (file / function / condition if known).\n\n' +
            'h4. Fix Applied\n' +
            '1-3 sentences: what was changed and why.\n\n' +
            'h4. Prevention\n' +
            '1-3 bullet points: what tests, patterns, or guards prevent this class of bug from recurring.\n\n' +
            'Bug Description:\n' +
            (ticketDescription || '(not available)') + '\n\n' +
            'Bug Fix Summary (from development agent):\n' +
            (devSummary || '(not available)') + '\n\n' +
            'Write ONLY the field content — no preamble, no markdown fences.';

        const solution = gemini_ai_chat(prompt);
        if (!solution || solution.trim() === '') {
            console.warn('AI returned empty solution — skipping Solution field update');
            return;
        }

        jira_update_field({
            key: ticketKey,
            field: 'Solution',
            value: solution.trim()
        });
        console.log('✅ Updated Solution field with RCA + prevention summary');
    } catch (e) {
        console.warn('Failed to update Solution field:', e.message || e);
    }
}

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const ticketDescription = params.ticket.fields && params.ticket.fields.description
            ? params.ticket.fields.description : '';
        console.log('=== Bug merged notification for', ticketKey, '===');

        // Step 1: Fetch ticket comments for RCA extraction
        let comments = [];
        try {
            comments = jira_get_comments({ key: ticketKey }) || [];
            console.log('Fetched', comments.length, 'comments for RCA extraction');
        } catch (e) {
            console.warn('Could not fetch comments:', e);
        }

        // Step 2: Update Solution field with AI-generated RCA + prevention
        updateSolutionField(ticketKey, ticketDescription, comments);

        // Step 3: Post merge notification
        try {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ✅ Bug Fix Merged — Ready for Testing\n\nThe bug fix PR has been merged and the ticket has been moved to *Ready For Testing*.\n\nThe *Solution* field has been updated with the Root Cause Analysis and prevention notes for use by the test case generator.'
            });
            console.log('✅ Posted merge notification to Jira');
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 4: Remove WIP label
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip' : null;
        if (wipLabel) {
            try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
        }

        // Step 5: Remove SM idempotency label
        const customParams = params.jobParams && params.jobParams.customParams;
        const removeLabel = customParams && customParams.removeLabel;
        if (removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('✅ Removed SM label:', removeLabel);
            } catch (e) {}
        }

        return { success: true, ticketKey };

    } catch (error) {
        console.error('❌ Error in notifyBugMerged:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
