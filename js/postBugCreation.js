/**
 * Post Bug Creation Action (postJSAction for bug_creation agent)
 *
 * Reads outputs/bug_decision.json written by the AI:
 *   { "action": "link", "existingKey": "PROJ-XXX" }
 *   { "action": "create", "summary": "...", "description": "outputs/bug_description.md" }
 *   { "action": "none", "reason": "..." }
 *
 * For link/create: links/creates bug, moves TC to "Bug To Fix", removes trigger labels.
 * For none:        posts comment, moves TC to In Rework, removes trigger labels.
 *
 * Link direction: Bug "blocks" TC (TC is blocked by the Bug until it's fixed).
 */

const { LABELS } = require('./config.js');
const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const trackersModule = require('./common/trackers.js');

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
        if (urlMatch) return urlMatch[1];
        // tracker.createTicket already returns the bare key (e.g. PROJ-123 or an ADO id)
        return /^[A-Za-z0-9_.#\/-]+$/.test(result.trim()) ? result.trim() : null;
    }
    return result.key || null;
}

function linkBugToTC(tracker, ticketKey, bugKey) {
    // Bug "blocks" TC: sourceKey=TC, anotherKey=Bug, relationship='Blocks'
    // → Bug is the blocker, TC is blocked (TC cannot pass until bug is fixed)
    tracker.linkIssues(ticketKey, bugKey, 'Blocks');
    console.log('✅ Linked:', bugKey, 'blocks', ticketKey);
}

function moveFailedTcToRework(tracker, ticketKey, jiraConfig) {
    tracker.moveToStatus(ticketKey, jiraConfig.statuses.IN_REWORK);
    console.log('🔧 Moved', ticketKey, 'to', jiraConfig.statuses.IN_REWORK);
    try {
        tracker.removeLabel(ticketKey, 'sm_test_automation_triggered');
        console.log('✅ Removed sm_test_automation_triggered');
    } catch (e) {}
}

function action(params) {
    var tracker;
    try {
        var ticketKey = params.ticket.key;
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var jiraConfig = projectConfig.jira;
        tracker = trackersModule.createTracker(projectConfig, (params.jobParams && params.jobParams.customParams) || params.customParams || {});
        console.log('=== Processing bug creation decision for', ticketKey, '===');

        var customParams = params.jobParams && params.jobParams.customParams;
        var smTriggerLabel = customParams && customParams.removeLabel;

        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'bug_creation_wip';

        var decision = readDecisionJson();
        if (!decision) {
            tracker.postComment(ticketKey, 'h3. ⚠️ Bug Creation Error\n\nCould not read bug_decision.json. Check workflow logs.');
            try { tracker.removeLabel(ticketKey, wipLabel); } catch (e) {}
            // KEEP sm_bug_creation_triggered label — TC stays in Failed, removing
            // the label would cause SM to re-trigger in an infinite loop.
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
                linkBugToTC(tracker, ticketKey, bugKey);
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
                tracker.postComment(ticketKey, 'h3. ⚠️ Bug Creation Skipped\n\nNo summary provided in bug_decision.json.');
                try { tracker.removeLabel(ticketKey, wipLabel); } catch (e) {}
                // KEEP sm_bug_creation_triggered — TC stays Failed, prevent re-fire loop.
                return { success: false, error: 'No bug summary' };
            }

            try {
                var projectKey = ticketKey.split('-')[0];
                var result = tracker.createTicket(projectKey, 'Bug', summary, description);
                bugKey = extractKeyFromResult(result);

                if (bugKey) {
                    linkBugToTC(tracker, ticketKey, bugKey);
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

            try { tracker.postComment(ticketKey, comment); } catch (e) {}
            try {
                tracker.moveToStatus(ticketKey, jiraConfig.statuses.PASSED);
                console.log('✅ Tests pass — moved', ticketKey, 'to', jiraConfig.statuses.PASSED);
            } catch (e) {
                console.warn('Failed to move to Passed:', e);
            }
            try { tracker.removeLabel(ticketKey, wipLabel); } catch (e) {}
            if (smTriggerLabel) {
                try { tracker.removeLabel(ticketKey, smTriggerLabel); } catch (e) {}
            }
            return { success: true, ticketKey: ticketKey, bugKey: null, action: 'tests_pass' };

        } else {
            // action: none — test code issue, not an app bug
            comment = 'h3. ℹ️ No Bug Created\n\n' +
                (decision.reason || 'AI determined no bug creation or linking is required.') +
                '\n\n_TC moved to *In Rework* so the test automation can be fixed instead of staying in *Failed*._';

            try { tracker.postComment(ticketKey, comment); } catch (e) {}
            moveFailedTcToRework(tracker, ticketKey, jiraConfig);
            try { tracker.removeLabel(ticketKey, wipLabel); } catch (e) {}
            if (smTriggerLabel) {
                try { tracker.removeLabel(ticketKey, smTriggerLabel); } catch (e) {}
            }
            console.log('ℹ️ No product bug for', ticketKey, '— moved to In Rework for test automation fixes');
            return { success: true, ticketKey: ticketKey, bugKey: null, action: 'none' };
        }

        // Post Jira comment
        try {
            tracker.postComment(ticketKey, comment);
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Move TC to Bug To Fix after successful link or create
        if (bugLinked) {
            try {
                tracker.moveToStatus(ticketKey, jiraConfig.statuses.BUG_TO_FIX);
                console.log('✅ Moved', ticketKey, 'to', jiraConfig.statuses.BUG_TO_FIX);
            } catch (e) {
                console.warn('Failed to move to Bug To Fix:', e);
            }

            // Move the bug to Ready For Development so it gets picked up
            if (bugKey) {
                try {
                    tracker.moveToStatus(bugKey, jiraConfig.statuses.READY_FOR_DEVELOPMENT);
                    console.log('✅ Moved bug', bugKey, 'to', jiraConfig.statuses.READY_FOR_DEVELOPMENT);
                } catch (e) {
                    console.warn('Failed to move bug to Ready For Development:', e);
                }
            }
        }

        // Remove WIP label
        try { tracker.removeLabel(ticketKey, wipLabel); } catch (e) {}

        // Remove SM trigger label (TC is now in Bug To Fix, not Failed — rule won't re-fire anyway)
        if (smTriggerLabel) {
            try {
                tracker.removeLabel(ticketKey, smTriggerLabel);
                console.log('✅ Removed SM trigger label:', smTriggerLabel);
            } catch (e) {}
        }

        // Always remove sm_test_automation_triggered when TC reaches Bug To Fix.
        // The test automation agent leaves this label on Failed TCs — it must be
        // cleaned up here so the TC can be re-triggered after the bug is fixed.
        try {
            tracker.removeLabel(ticketKey, 'sm_test_automation_triggered');
            console.log('✅ Removed sm_test_automation_triggered');
        } catch (e) {}

        console.log('✅ Bug creation workflow complete for', ticketKey, '— bugKey:', bugKey || 'none');

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return { success: true, ticketKey: ticketKey, bugKey: bugKey, action: decision.action };

    } catch (error) {
        console.error('❌ Error in postBugCreation:', error);
        try {
            tracker.postComment(params.ticket.key, 'h3. ❌ Bug Creation Error\n\n{code}' + error.toString() + '{code}');
        } catch (e) {}
        // Release SM trigger label so SM can retry next cycle
        var customParamsOnErr = params.jobParams && params.jobParams.customParams;
        var smLabelOnErr = customParamsOnErr && customParamsOnErr.removeLabel;
        if (smLabelOnErr) {
            try { tracker.removeLabel(params.ticket.key, smLabelOnErr); } catch (e) {}
        }
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
