/**
 * Post Bug Creation Action (postJSAction for bug_creation agent)
 *
 * Reads outputs/bug_decision.json written by the AI:
 *   { "action": "link", "existingKey": "PROJ-XXX" }
 *   { "action": "create", "summary": "...", "description": "outputs/bug_description.md" }
 *   { "action": "none", "reason": "..." }
 *
 * For link/create: links/creates bug, moves TC to "Bug To Fix", removes trigger labels.
 * For none:        posts comment, keeps TC in Failed, keeps trigger label (prevents re-fire).
 *
 * Link direction: Bug "blocks" TC (TC is blocked by the Bug until it's fixed).
 */

const { STATUSES, LABELS } = require('./config.js');

function readFile(path) {
    try {
        var content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        return null;
    }
}

function readDecisionJson() {
    try {
        var raw = readFile('outputs/bug_decision.json');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to parse bug_decision.json:', e);
        return null;
    }
}

function extractKeyFromResult(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        // jira_create_ticket_basic returns a JSON string: {"id":"...","key":"PROJ-123",...}
        try {
            var parsed = JSON.parse(result);
            if (parsed && parsed.key) return parsed.key;
        } catch (e) {}
        // fallback: try /browse/ URL pattern
        var urlMatch = result.match(/\/browse\/([A-Z]+-\d+)/);
        return urlMatch ? urlMatch[1] : null;
    }
    return result.key || null;
}

function linkBugToTC(ticketKey, bugKey) {
    // Bug "blocks" TC: sourceKey=TC, anotherKey=Bug, relationship='Blocks'
    // → Bug is the blocker, TC is blocked (TC cannot pass until bug is fixed)
    jira_link_issues({
        sourceKey: ticketKey,
        anotherKey: bugKey,
        relationship: 'Blocks'
    });
    console.log('✅ Linked:', bugKey, 'blocks', ticketKey);
}

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        console.log('=== Processing bug creation decision for', ticketKey, '===');

        var customParams = params.jobParams && params.jobParams.customParams;
        var smTriggerLabel = customParams && customParams.removeLabel;

        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'bug_creation_wip';

        var decision = readDecisionJson();
        if (!decision) {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ⚠️ Bug Creation Error\n\nCould not read bug_decision.json. Check workflow logs.'
            });
            try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
            return { success: false, error: 'No bug_decision.json' };
        }

        console.log('Decision:', decision.action, decision.existingKey || decision.summary || '');

        var bugKey = null;
        var comment = '';
        var bugLinked = false;

        if (decision.action === 'link' && decision.existingKey) {
            // Link to existing bug
            bugKey = decision.existingKey;
            try {
                linkBugToTC(ticketKey, bugKey);
                bugLinked = true;
                comment = 'h3. 🔗 Existing Bug Linked\n\n' +
                    'Found matching bug: *' + bugKey + '*\n\n' +
                    (decision.reason ? '_' + decision.reason + '_' : '');
            } catch (e) {
                console.warn('Failed to link existing bug:', e);
                comment = 'h3. ⚠️ Bug Link Failed\n\n' +
                    'Found matching bug *' + bugKey + '* but could not create link: ' + e;
            }

        } else if (decision.action === 'create') {
            // Create new bug
            var summary = decision.summary;
            var descriptionPath = decision.description;
            var description = (descriptionPath ? readFile(descriptionPath) : null)
                || decision.descriptionText
                || summary;

            if (!summary) {
                jira_post_comment({ key: ticketKey, comment: 'h3. ⚠️ Bug Creation Skipped\n\nNo summary provided in bug_decision.json.' });
                try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
                return { success: false, error: 'No bug summary' };
            }

            try {
                var projectKey = ticketKey.split('-')[0];
                var result = jira_create_ticket_basic(projectKey, 'Bug', summary, description);
                bugKey = extractKeyFromResult(result);

                if (bugKey) {
                    linkBugToTC(ticketKey, bugKey);
                    bugLinked = true;
                    comment = 'h3. 🐛 New Bug Created\n\n' +
                        'Created: *' + bugKey + '*\n' +
                        '*Summary*: ' + summary + '\n\n' +
                        (decision.reason ? '_' + decision.reason + '_' : '');
                } else {
                    comment = 'h3. ⚠️ Bug Created (key not extracted)\n\nBug was created but key could not be parsed from result.';
                }
            } catch (e) {
                console.error('Failed to create bug:', e);
                comment = 'h3. ❌ Bug Creation Failed\n\n{code}' + e.toString() + '{code}';
            }

        } else if (decision.action === 'tests_pass') {
            // Tests are currently passing — ticket status is stale, move to Passed
            comment = 'h3. ✅ Tests Passing — Moving to Passed\n\n' +
                (decision.reason || 'All tests passed in the most recent run — the underlying issue has been fixed.') +
                '\n\n_Ticket status was stale. TC automatically moved to *Passed*._';

            try { jira_post_comment({ key: ticketKey, comment: comment }); } catch (e) {}
            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.PASSED });
                console.log('✅ Tests pass — moved', ticketKey, 'to', STATUSES.PASSED);
            } catch (e) {
                console.warn('Failed to move to Passed:', e);
            }
            try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
            if (smTriggerLabel) {
                try { jira_remove_label({ key: ticketKey, label: smTriggerLabel }); } catch (e) {}
            }
            return { success: true, ticketKey: ticketKey, bugKey: null, action: 'tests_pass' };

        } else {
            // action: none — test code issue, not an app bug
            comment = 'h3. ℹ️ No Bug Created\n\n' +
                (decision.reason || 'AI determined no bug creation or linking is required.') +
                '\n\n_TC remains in Failed status for manual review._';

            try { jira_post_comment({ key: ticketKey, comment: comment }); } catch (e) {}
            try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
            if (smTriggerLabel) {
                try { jira_remove_label({ key: ticketKey, label: smTriggerLabel }); } catch (e) {}
            }
            console.log('ℹ️ No action taken for', ticketKey, '— TC stays in Failed');
            return { success: true, ticketKey: ticketKey, bugKey: null, action: 'none' };
        }

        // Post Jira comment
        try {
            jira_post_comment({ key: ticketKey, comment: comment });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Move TC to Bug To Fix after successful link or create
        if (bugLinked) {
            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.BUG_TO_FIX });
                console.log('✅ Moved', ticketKey, 'to', STATUSES.BUG_TO_FIX);
            } catch (e) {
                console.warn('Failed to move to Bug To Fix:', e);
            }

            // Move the bug to Ready For Development so it gets picked up
            if (bugKey) {
                try {
                    jira_move_to_status({ key: bugKey, statusName: STATUSES.READY_FOR_DEVELOPMENT });
                    console.log('✅ Moved bug', bugKey, 'to', STATUSES.READY_FOR_DEVELOPMENT);
                } catch (e) {
                    console.warn('Failed to move bug to Ready For Development:', e);
                }
            }
        }

        // Remove WIP label
        try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}

        // Remove SM trigger label (TC is now in Bug To Fix, not Failed — rule won't re-fire anyway)
        if (smTriggerLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: smTriggerLabel });
                console.log('✅ Removed SM trigger label:', smTriggerLabel);
            } catch (e) {}
        }

        // Always remove sm_test_automation_triggered when TC reaches Bug To Fix.
        // The test automation agent leaves this label on Failed TCs — it must be
        // cleaned up here so the TC can be re-triggered after the bug is fixed.
        try {
            jira_remove_label({ key: ticketKey, label: 'sm_test_automation_triggered' });
            console.log('✅ Removed sm_test_automation_triggered');
        } catch (e) {}

        console.log('✅ Bug creation workflow complete for', ticketKey, '— bugKey:', bugKey || 'none');
        return { success: true, ticketKey: ticketKey, bugKey: bugKey, action: decision.action };

    } catch (error) {
        console.error('❌ Error in postBugCreation:', error);
        try {
            jira_post_comment({
                key: params.ticket.key,
                comment: 'h3. ❌ Bug Creation Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        // Release SM trigger label so SM can retry next cycle
        var customParamsOnErr = params.jobParams && params.jobParams.customParams;
        var smLabelOnErr = customParamsOnErr && customParamsOnErr.removeLabel;
        if (smLabelOnErr) {
            try { jira_remove_label({ key: params.ticket.key, label: smLabelOnErr }); } catch (e) {}
        }
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
