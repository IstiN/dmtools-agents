/**
 * Post Bulk Bugs Creation Action (postJSAction for bulk_bugs_creation agent)
 *
 * Reads outputs/bulk_bug_decisions.json written by the AI:
 * {
 *   "processed": ["TS-984", "TS-954", "TS-909"],
 *   "newBugs": [
 *     {
 *       "summary": "...",
 *       "priority": "Medium",
 *       "descriptionFile": "outputs/bug_001_description.md",
 *       "linkedTCs": ["TS-984", "TS-954"]
 *     }
 *   ],
 *   "links": [{ "tcKey": "TS-909", "bugKey": "TS-123" }],
 *   "skipped": [{ "tcKey": "TS-YYY", "reason": "..." }]
 * }
 *
 * Safety: ONLY TCs listed in "processed" are acted upon.
 * TCs not in "processed" are left untouched (stay in Failed, no label added).
 *
 * For newBugs:  create bug, link all linkedTCs, move linkedTCs to "Bug To Fix"
 * For links:    link TC to existing bug, move TC to "Bug To Fix"
 * For skipped:  move TC to In Rework so test automation can be fixed
 */

const { STATUSES, LABELS } = require('./config.js');
var feedbackLoop = require('./common/feedbackLoop.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

function readFile(path) {
    try {
        var content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        console.warn('Could not read file:', path, e);
        return null;
    }
}

function readDecisions() {
    try {
        var raw = readFile('outputs/bulk_bug_decisions.json');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to parse bulk_bug_decisions.json:', e);
        return null;
    }
}

function extractKeyFromResult(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try {
            var parsed = JSON.parse(result);
            if (parsed && parsed.key) return parsed.key;
        } catch (e) {}
        var urlMatch = result.match(/\/browse\/([A-Z]+-\d+)/);
        return urlMatch ? urlMatch[1] : null;
    }
    return result.key || null;
}

function linkBugToTC(tcKey, bugKey) {
    jira_link_issues({
        sourceKey: tcKey,
        anotherKey: bugKey,
        relationship: 'Blocks'
    });
    console.log('  ✅ Linked:', bugKey, 'blocks', tcKey);
}

function extractTickets(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (typeof result === 'string') {
        try {
            var parsed = JSON.parse(result);
            return extractTickets(parsed);
        } catch (e) {
            return [];
        }
    }
    if (Array.isArray(result.issues)) return result.issues;
    if (Array.isArray(result.data)) return result.data;
    if (Array.isArray(result.results)) return result.results;
    return [];
}

function findLinkedNonDoneBug(tcKey) {
    if (!tcKey || typeof jira_search_by_jql !== 'function') return null;
    try {
        var result = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + tcKey + '") AND issuetype = Bug AND status not in (Done)',
            fields: ['key', 'summary', 'status'],
            maxResults: 1
        });
        var tickets = extractTickets(result);
        return tickets.length > 0 ? (tickets[0].key || null) : null;
    } catch (e) {
        console.warn('  ⚠️ Could not live-check linked non-Done bugs for', tcKey, e);
        return null;
    }
}

function findAnyLinkedNonDoneBug(tcKeys) {
    for (var i = 0; i < tcKeys.length; i++) {
        var bugKey = findLinkedNonDoneBug(tcKeys[i]);
        if (bugKey) return bugKey;
    }
    return null;
}

function moveToBugToFix(tcKey) {
    try {
        jira_move_to_status({ key: tcKey, statusName: STATUSES.BUG_TO_FIX || 'Bug To Fix' });
        console.log('  📋 Moved to Bug To Fix:', tcKey);
    } catch (e) {
        console.warn('  ⚠️ Could not move to Bug To Fix:', tcKey, e);
    }
}

function addTriggerLabel(tcKey, label) {
    try {
        jira_add_label({ key: tcKey, label: label });
    } catch (e) {
        console.warn('  ⚠️ Could not add label', label, 'to', tcKey, e);
    }
}

function postComment(tcKey, comment) {
    try {
        jira_post_comment({ key: tcKey, comment: comment });
    } catch (e) {
        console.warn('  ⚠️ Could not post comment to', tcKey, e);
    }
}

function removeTriggerLabel(ticketKey, label) {
    if (!ticketKey || !label) return;
    try {
        jira_remove_label({ key: ticketKey, label: label });
        console.log('  🏷️ Removed SM trigger label "' + label + '" from ' + ticketKey);
    } catch (e) {
        console.warn('  ⚠️ Could not remove label', label, 'from', ticketKey, e);
    }
}

function removeProcessingLabels(tcKey, labels) {
    labels.forEach(function(label) {
        removeTriggerLabel(tcKey, label);
    });
}

function markResolved(resolvedSet, tcKey) {
    if (tcKey) resolvedSet[tcKey] = true;
}

function moveFailedTcToRework(tcKey) {
    jira_move_to_status({ key: tcKey, statusName: STATUSES.IN_REWORK || 'In Rework' });
    console.log('  🔧 Moved to ' + (STATUSES.IN_REWORK || 'In Rework') + ':', tcKey);
    try {
        jira_remove_label({ key: tcKey, label: 'sm_test_automation_triggered' });
    } catch (e) {}
}

function action(params) {
    try {
        var actualParams = params.jobParams || params;
        var customParams = actualParams.customParams || {};
        var triggerLabel = customParams.removeLabel || 'sm_bug_creation_triggered';
        var smTriggerLabel = customParams.smTriggerLabel || 'sm_bulk_bugs_creation_triggered';

        console.log('=== Processing bulk bug creation decisions ===');

        var decisions = readDecisions();
        if (!decisions) {
            console.error('❌ Could not read bulk_bug_decisions.json — attempting recovery');

            // Remove SM trigger label so SM can re-dispatch on next run
            var triggerTicketKey = (actualParams.ticket && actualParams.ticket.key) || null;
            removeTriggerLabel(triggerTicketKey, smTriggerLabel);

            // Try feedback loop resume — tell agent to produce the output file
            var resume = feedbackLoop.resumeAgent({
                ticketKey: triggerTicketKey || 'unknown',
                customParams: customParams,
                section: 'postAction',
                stage: 'bulk_bugs_output',
                error: 'The AI agent did not produce the required outputs/bulk_bug_decisions.json file. ' +
                    'The file must be valid JSON with keys: processed (array of TC keys), ' +
                    'newBugs (array of bug definitions with summary, priority, descriptionFile, linkedTCs), ' +
                    'links (array of {tcKey, bugKey} for existing bugs), ' +
                    'skipped (array of {tcKey, reason}). ' +
                    'Read input/failed_tcs.json and input/open_bugs.json, then write the decisions file.'
            });

            if (resume.attempted) {
                console.log('🔄 Feedback loop resumed agent — re-running post-action');
                return action(params);
            }

            return { success: false, error: 'Missing bulk_bug_decisions.json, resume not attempted: ' + (resume.reason || 'unknown') };
        }

        var processed = decisions.processed || [];
        var newBugs = decisions.newBugs || [];
        var links = decisions.links || [];
        var skipped = decisions.skipped || [];
        var fixedByBug = decisions.fixedByBug || [];

        if (fixedByBug.length > 0) {
            console.error('❌ fixedByBug is not supported for bulk bug creation; Done bugs are excluded from matching');
            fixedByBug.forEach(function(fixDef) {
                if (fixDef && fixDef.tcKey) {
                    removeProcessingLabels(fixDef.tcKey, [triggerLabel, smTriggerLabel]);
                }
            });
            return {
                success: false,
                error: 'fixedByBug is not supported; create or link a non-Done bug, or skip only confirmed test-code issues'
            };
        }

        console.log('Decisions: ' + newBugs.length + ' new bugs, ' + links.length + ' links, ' +
            skipped.length + ' skipped');
        console.log('Processed TCs: ' + processed.join(', '));

        var results = { created: [], linked: [], skipped: [], released: [], errors: [] };

        // Build a set of processed TC keys for safety check
        var processedSet = {};
        processed.forEach(function(k) { processedSet[k] = true; });
        var resolvedSet = {};

        // ── 1. Create new bugs and link their TCs ─────────────────────────────
        newBugs.forEach(function(bugDef, idx) {
            var summary = bugDef.summary;
            if (!summary) {
                console.warn('  ⚠️ Skipping newBug[' + idx + '] — no summary');
                return;
            }

            var description = null;
            if (bugDef.descriptionFile) {
                description = readFile(bugDef.descriptionFile);
                if (!description) {
                    console.warn('  ⚠️ descriptionFile not found:', bugDef.descriptionFile, '— using summary as fallback');
                    description = summary;
                }
            } else {
                description = summary;
            }

            var linkedTCs = bugDef.linkedTCs || [];
            console.log('  Creating bug:', summary, '| links to:', linkedTCs.join(', '));

            var existingBugKey = findAnyLinkedNonDoneBug(linkedTCs);
            if (existingBugKey) {
                console.log('  🔁 Existing linked non-Done bug found during live re-check:', existingBugKey);
                linkedTCs.forEach(function(tcKey) {
                    if (!processedSet[tcKey]) {
                        console.warn('  ⚠️ TC', tcKey, 'not in processed list — skipping (safety guard)');
                        return;
                    }
                    try {
                        linkBugToTC(tcKey, existingBugKey);
                        moveToBugToFix(tcKey);
                        removeProcessingLabels(tcKey, [triggerLabel, smTriggerLabel]);
                        postComment(tcKey,
                            'h3. 🔗 Existing Bug Linked (Batch Live Re-check)\n\n' +
                            'Linked to existing non-Done bug: *' + existingBugKey + '*'
                        );
                        results.linked.push({ tcKey: tcKey, bugKey: existingBugKey, source: 'live_recheck' });
                        markResolved(resolvedSet, tcKey);
                    } catch (e) {
                        console.error('  ❌ Failed to link', tcKey, '→', existingBugKey, ':', e);
                        results.errors.push({ tcKey: tcKey, bugKey: existingBugKey, error: e.toString() });
                    }
                });
                return;
            }

            var bugKey = null;
            try {
                var projectKey = (linkedTCs[0] || 'TS-1').split('-')[0];
                var priority = bugDef.priority || 'Medium';
                var result = jira_create_ticket_basic(projectKey, 'Bug', summary, description);
                bugKey = extractKeyFromResult(result);
            } catch (e) {
                console.error('  ❌ Failed to create bug:', e);
                results.errors.push({ summary: summary, error: e.toString() });
                return;
            }

            if (!bugKey) {
                console.warn('  ⚠️ Bug created but key could not be extracted for:', summary);
                results.errors.push({ summary: summary, error: 'key not extracted' });
                return;
            }

            console.log('  🐛 Created bug:', bugKey);

            // Link each TC to the new bug
            linkedTCs.forEach(function(tcKey) {
                if (!processedSet[tcKey]) {
                    console.warn('  ⚠️ TC', tcKey, 'not in processed list — skipping (safety guard)');
                    return;
                }
                try {
                    linkBugToTC(tcKey, bugKey);
                    moveToBugToFix(tcKey);
                    removeProcessingLabels(tcKey, [triggerLabel, smTriggerLabel]);
                    postComment(tcKey,
                        'h3. 🐛 New Bug Created (Batch)\n\n' +
                        'Created: *' + bugKey + '*\n' +
                        '*Summary*: ' + summary
                    );
                    results.created.push({ tcKey: tcKey, bugKey: bugKey });
                    markResolved(resolvedSet, tcKey);
                } catch (e) {
                    console.error('  ❌ Failed to process TC', tcKey, ':', e);
                    results.errors.push({ tcKey: tcKey, bugKey: bugKey, error: e.toString() });
                }
            });
        });

        // ── 2. Link TCs to existing bugs ─────────────────────────────────────
        links.forEach(function(linkDef) {
            var tcKey = linkDef.tcKey;
            var bugKey = linkDef.bugKey;

            if (!tcKey || !bugKey) {
                console.warn('  ⚠️ Invalid link entry:', JSON.stringify(linkDef));
                return;
            }
            if (!processedSet[tcKey]) {
                console.warn('  ⚠️ TC', tcKey, 'not in processed list — skipping (safety guard)');
                return;
            }

            console.log('  Linking', tcKey, '→', bugKey);
            try {
                linkBugToTC(tcKey, bugKey);
                moveToBugToFix(tcKey);
                removeProcessingLabels(tcKey, [triggerLabel, smTriggerLabel]);
                postComment(tcKey,
                    'h3. 🔗 Existing Bug Linked (Batch)\n\n' +
                    'Linked to existing bug: *' + bugKey + '*'
                );
                results.linked.push({ tcKey: tcKey, bugKey: bugKey });
                markResolved(resolvedSet, tcKey);
            } catch (e) {
                console.error('  ❌ Failed to link', tcKey, '→', bugKey, ':', e);
                results.errors.push({ tcKey: tcKey, bugKey: bugKey, error: e.toString() });
            }
        });

        // ── 3. Test-code issues → In Rework so they leave Failed and rework runs ─
        skipped.forEach(function(skipDef) {
            var tcKey = skipDef.tcKey;
            if (!tcKey) return;
            if (!processedSet[tcKey]) {
                console.warn('  ⚠️ TC', tcKey, 'not in processed list — skipping (safety guard)');
                return;
            }
            console.log('  Skipping', tcKey, '—', skipDef.reason || 'no reason given');
            moveFailedTcToRework(tcKey);
            try {
                removeProcessingLabels(tcKey, [triggerLabel, smTriggerLabel]);
                console.log('  🏷️ Removed trigger labels from', tcKey, '— eligible for rework');
            } catch (e) {}
            postComment(tcKey,
                'h3. ℹ️ No Bug Created (Batch) — Test Code Issue\n\n' +
                '*Reason*: ' + (skipDef.reason || 'AI determined this is a test code issue, not an application bug.') +
                '\n\n_TC moved to *In Rework* so the test automation can be fixed instead of staying in *Failed*._'
            );
            results.skipped.push({ tcKey: tcKey, reason: skipDef.reason });
            markResolved(resolvedSet, tcKey);
        });

        // ── 4. Recovery guard: processed TCs must never keep a stale bulk lock ──
        processed.forEach(function(tcKey) {
            if (!tcKey || resolvedSet[tcKey]) return;

            console.warn('  ⚠️ Processed TC has no successful bulk outcome:', tcKey);
            var linkedBugKey = findLinkedNonDoneBug(tcKey);
            if (linkedBugKey) {
                moveToBugToFix(tcKey);
                removeProcessingLabels(tcKey, [triggerLabel, smTriggerLabel]);
                postComment(tcKey,
                    'h3. 🔗 Existing Bug Found After Batch\n\n' +
                    'Bulk bug creation did not produce a final decision for this TC, ' +
                    'but a linked non-Done bug already exists: *' + linkedBugKey + '*.\n\n' +
                    '_TC moved to *Bug To Fix* and stale bug-creation locks were removed._'
                );
                results.linked.push({ tcKey: tcKey, bugKey: linkedBugKey, source: 'post_batch_recovery' });
                markResolved(resolvedSet, tcKey);
                return;
            }

            removeProcessingLabels(tcKey, [triggerLabel, smTriggerLabel]);
            postComment(tcKey,
                'h3. ⚠️ Bulk Bug Creation Released\n\n' +
                'Bulk bug creation processed this TC but did not create, link, or skip it. ' +
                'No linked non-Done bug was found during the post-action live check.\n\n' +
                '_Stale bug-creation locks were removed so the next bulk cycle can retry from Failed._'
            );
            results.released.push({ tcKey: tcKey, reason: 'no bulk outcome and no linked non-Done bug' });
        });

        // ── Summary ───────────────────────────────────────────────────────────
        console.log('=== Bulk bug creation complete ===');
        console.log('  Created:', results.created.length, 'bug links');
        console.log('  Linked:', results.linked.length, 'to existing bugs');
        console.log('  Skipped:', results.skipped.length);
        console.log('  Released:', results.released.length, 'without outcome');
        console.log('  Errors:', results.errors.length);

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments((actualParams.ticket && actualParams.ticket.key) || null, { initiator: actualParams.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return { success: true, results: results };

    } catch (e) {
        console.error('postBulkBugsCreation failed:', e);
        throw e;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
