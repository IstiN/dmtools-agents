/**
 * Check Story Tests Passed — postJSAction for story_done_check agent.
 *
 * Runs on every SM cycle for each Story in "In Testing".
 * - If all linked Test Cases are "Passed" → moves the Story to "Done".
 * - If any linked Test Case is still in an in-flight review/automation status
 *   (In Review - Passed/Failed, In Development, etc.) → releases the lock and
 *   waits for the review/merge/automation agents to finish.
 * - If any linked Test Case is "Failed" and has no linked non-Done bug → waits
 *   for bulk_bugs_creation to create/link the bug.
 * - If any linked Test Case has a linked non-Done bug → moves the Story to
 *   "Bug To Fix" so the bug-fix pipeline can run.
 * - Otherwise all non-passed Test Cases are ready for re-test (bugs Done or no
 *   bugs) → moves the Story back to "Ready For Testing" to trigger a re-run.
 *
 * gh-1080 CRAP split: parameter parsing, TC classification and the
 * outcome dispatch are small top-level helpers; action() only orchestrates.
 * Tracker/post calls and their order are byte-identical to the pre-split flow.
 *
 * gh-1330: a concluded story whose TCs include Skipped/Irrelevant ones must not
 * claim "All Test Cases Passed". The Done report shows the per-status buckets,
 * every skipped TC is stamped with a machine-parseable skip marker (story key,
 * reason, date — "skipped" means unverified, not exonerated), and the optional
 * `skipsNeedHuman` customParam flags the story for human review instead of
 * moving it to Done (default off — the automation flow is unchanged).
 */

const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const trackersModule = require('./common/trackers.js');
const linkedIssuesReport = require('./common/linkedIssuesReport.js');

// ── gh-1080: pure parse helpers ──────────────────────────────────────────────

function parseCheckParams(params) {
    var customParams = params.jobParams && params.jobParams.customParams;
    return {
        ticketKey: params.ticket && params.ticket.key,
        customParams: customParams,
        removeLabel: customParams && customParams.removeLabel,
        // gh-1330: opt-in knob (default off) — flag the story for human review
        // instead of Done when skipped TCs exist.
        skipsNeedHuman: !!(customParams && customParams.skipsNeedHuman),
        // gh-1330: optional reason recorded in the per-TC skip markers.
        skipReason: (customParams && customParams.skipReason) || null
    };
}

function resolveCustomStatuses(jiraConfig, customParams) {
    // Legacy override channel: customParams.customStatuses still wins over .dmtools/config.js statuses
    return Object.assign({}, jiraConfig.statuses, (customParams && customParams.customStatuses) || {});
}

function buildCheckContext(params) {
    var parsed = parseCheckParams(params);
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var jiraConfig = projectConfig.jira;
    return {
        ticketKey: parsed.ticketKey,
        customParams: parsed.customParams,
        removeLabel: parsed.removeLabel,
        skipsNeedHuman: parsed.skipsNeedHuman,
        skipReason: parsed.skipReason,
        tracker: trackersModule.createTracker(projectConfig, parsed.customParams || {}),
        statuses: resolveCustomStatuses(jiraConfig, parsed.customParams),
        testCaseType: jiraConfig.issueTypes.TEST_CASE || 'Test Case',
        bugType: jiraConfig.issueTypes.BUG || 'Bug'
    };
}

// ── gh-1080: pure classify helpers (tracker access is injected via `gate`) ───

function isFinalStage(tc, gate) {
    return gate.hasStage(tc, 'PASSED', gate.statuses.PASSED) ||
        gate.hasStage(tc, 'SKIPPED', gate.statuses.SKIPPED) ||
        gate.hasStage(tc, 'IRRELEVANT', gate.statuses.IRRELEVANT);
}

/**
 * Drops one Test Case into exactly one bucket:
 * inFlight (review/automation still running), pendingBug (open linked bug),
 * waitingForBugs (Failed, no bug yet) or readyForRetest (everything else).
 */
function classifyTestCase(tc, gate, buckets) {
    if (isFinalStage(tc, gate)) return;

    if (gate.inFlight(tc)) {
        buckets.inFlight.push(tc.key);
        return;
    }

    var pendingBugKey = gate.pendingBugKey(tc.key);
    if (pendingBugKey) {
        buckets.pendingBug.push({ key: tc.key, status: gate.statusOf(tc), bugKey: pendingBugKey });
        return;
    }

    if (gate.hasStage(tc, 'FAILED', gate.statuses.FAILED)) {
        buckets.waitingForBugs.push(tc.key);
    } else {
        buckets.readyForRetest.push(tc.key);
    }
}

function bucketTestCases(allTCs, gate) {
    var buckets = { inFlight: [], pendingBug: [], waitingForBugs: [], readyForRetest: [] };
    allTCs.forEach(function(tc) {
        classifyTestCase(tc, gate, buckets);
    });
    return buckets;
}

function allTestsConcluded(buckets) {
    return buckets.inFlight.length === 0 &&
        buckets.pendingBug.length === 0 &&
        buckets.waitingForBugs.length === 0 &&
        buckets.readyForRetest.length === 0;
}

// ── gh-1330: truthful bucket reporting ───────────────────────────────────────

// Needs-human label for the opt-in `skipsNeedHuman` flow (default off).
var NEEDS_HUMAN_SKIPS_LABEL = 'needs_human_skips';

// Per-TC skip marker label — also the stamping idempotency gate (one marker
// per story; a TC skipped by two different stories carries one label each).
function skipMarkerLabelFor(storyKey) {
    return 'skipped_at_' + storyKey;
}

/**
 * Splits concluded TCs into per-status counts plus the skipped TC objects.
 * Uses the same gate (tracker.hasStage) as the flow classification, so a
 * stage_skipped marker counts as Skipped in 'label' mode exactly like the
 * Done decision does. `other` is defensive: allTestsConcluded() guarantees
 * every TC reached a final stage — the summary stays truthful if that ever
 * changes.
 */
function statusBuckets(allTCs, gate) {
    var counts = { passed: 0, skipped: 0, irrelevant: 0, other: 0 };
    var skippedTcs = [];
    (allTCs || []).forEach(function(tc) {
        if (gate.hasStage(tc, 'PASSED', gate.statuses.PASSED)) {
            counts.passed++;
        } else if (gate.hasStage(tc, 'SKIPPED', gate.statuses.SKIPPED)) {
            counts.skipped++;
            skippedTcs.push(tc);
        } else if (gate.hasStage(tc, 'IRRELEVANT', gate.statuses.IRRELEVANT)) {
            counts.irrelevant++;
        } else {
            counts.other++;
        }
    });
    return { counts: counts, skippedTcs: skippedTcs };
}

/**
 * One line for the Done report: every non-zero bucket, fixed order.
 * Only Skipped gets the "never executed" qualifier — Irrelevant means the TC
 * is no longer applicable, not untested.
 */
function buildBucketSummary(counts) {
    var parts = [];
    if (counts.passed > 0) parts.push(counts.passed + ' Passed');
    if (counts.skipped > 0) parts.push(counts.skipped + ' Skipped (never executed — see TC comments)');
    if (counts.irrelevant > 0) parts.push(counts.irrelevant + ' Irrelevant (no longer applicable)');
    if (counts.other > 0) parts.push(counts.other + ' Other');
    return parts.join(', ');
}

/**
 * The story Done comment. A fully green suite (skipped + irrelevant == 0)
 * keeps the exact pre-gh-1330 wording; anything else reports the buckets and
 * never claims "All … Passed".
 */
function buildStoryDoneComment(counts, totalTCs) {
    if (counts.skipped + counts.irrelevant === 0) {
        return 'h3. ✅ Story Complete — All Test Cases Passed\n\n' +
            'All *' + totalTCs + '* linked Test Case(s) are in *Passed* status.\n\n' +
            'The story has been automatically moved to *Done*.';
    }

    var comment = 'h3. ✅ Story Complete — Test Cases Concluded\n\n' +
        'Test results: ' + buildBucketSummary(counts) + '.\n\n' +
        'All *' + totalTCs + '* linked Test Case(s) reached a final status; ' +
        'the story has been automatically moved to *Done*.';

    if (counts.skipped > 0) {
        comment += '\n\n⚠️ Skipped Test Cases were *never executed* against this story — ' +
            '"skipped" means *unverified, not exonerated*: no baseline exists for them. ' +
            'See the skip markers on each skipped Test Case.';
    }
    return comment;
}

/**
 * Machine-parseable skip marker posted on the skipped TC itself: story key,
 * reason and date on one line so a future failure of this TC carries its
 * "never executed during <story>" context even for readers who never open the
 * story.
 */
function buildSkipMarkerComment(storyKey, tcKey, reason, dateStr) {
    return 'h3. ⏭️ Skipped At Story Done-Check — Never Executed\n\n' +
        '[tc-skip-marker] skipped at ' + storyKey + ' done-check (' + (reason || 'no reason recorded') + '), ' +
        'never executed — ' + dateStr + '\n\n' +
        'This Test Case was *not executed* when story *' + storyKey + '* was concluded: ' +
        '"skipped" means *unverified, not exonerated*, and no baseline exists for this TC. ' +
        'A later failure is *not automatically unrelated* — treat this TC as fresh.';
}

/**
 * The needs-human flag comment for the opt-in `skipsNeedHuman` flow.
 */
function buildSkipsNeedHumanComment(counts, totalTCs) {
    return 'h3. ⚠️ Story Done-Check Found Skipped Test Cases — Needs Human\n\n' +
        'Test results: ' + buildBucketSummary(counts) + ' (' + totalTCs + ' linked Test Case(s) concluded).\n\n' +
        '*skipsNeedHuman* is enabled: skipped Test Cases need human review before this story ' +
        'can move to *Done*. The story stays in *In Testing*.\n\n' +
        'Skipped Test Cases were stamped with skip markers — they were *never executed* against ' +
        'this story ("skipped" = *unverified, not exonerated*).';
}

function action(params) {
    const ctx = buildCheckContext(params);
    const tracker = ctx.tracker;
    const ticketKey = ctx.ticketKey;

    function releaseLock() {
        if (ticketKey && ctx.removeLabel) {
            try {
                tracker.removeLabel(ticketKey, ctx.removeLabel);
                console.log('Released SM label — will re-check next cycle');
            } catch (e) {
                console.warn('Failed to remove SM label:', e);
            }
        }
    }

    function postTokenUsageSafely() {
        tokenUsageComment.postTokenUsageSafely(ticketKey, params);
    }

    function findLinkedTCs() {
        try {
            // JQL text: provider-specific query (WIQL on ado)
            // gh-916: in label mode the stage gates also read markers, so labels are requested;
            // 'none' mode sends the exact same fields list as before.
            var fields = ['key', 'status'];
            if (tracker.stageFallback() === 'label') fields = fields.concat(['labels']);
            return tracker.searchIssues(linkedIssuesReport.buildLinkedIssuesQuery(tracker.provider(), ticketKey, 'issuetype = "' + ctx.testCaseType + '"', { issueType: ctx.testCaseType }), {
                fields: fields,
                maxResults: 100
            }) || [];
        } catch (e) {
            console.warn('Failed to fetch linked Test Cases:', e);
            return [];
        }
    }

    function findLinkedBugs(tcKey) {
        try {
            // JQL text: provider-specific query (WIQL on ado)
            return tracker.searchIssues(linkedIssuesReport.buildLinkedIssuesQuery(tracker.provider(), tcKey, 'issuetype = "' + ctx.bugType + '"', { issueType: ctx.bugType }), {
                fields: ['key', 'status'],
                maxResults: 50
            }) || [];
        } catch (e) {
            console.warn('Failed to fetch linked bugs for', tcKey, e);
            return [];
        }
    }

    function findPendingBugKey(tcKey) {
        var bugs = findLinkedBugs(tcKey);
        for (var i = 0; i < bugs.length; i++) {
            var status = bugs[i].fields && bugs[i].fields.status && bugs[i].fields.status.name;
            if (status !== ctx.statuses.DONE) {
                return bugs[i].key;
            }
        }
        return null;
    }

    // gh-916: stage gates go through tracker.hasStage — a TC marked stage_<key> by a rejected
    // transition counts as being in the stage when jira.stageFallback is 'label'; in the default
    // 'none' mode hasStage compares the status only (the exact previous behaviour).
    function isInFlightStatus(tc) {
        var status = tcStatus(tc);
        return tracker.hasStage(tc, 'IN_REVIEW_PASSED', ctx.statuses.IN_REVIEW_PASSED) ||
            tracker.hasStage(tc, 'IN_REVIEW_FAILED', ctx.statuses.IN_REVIEW_FAILED) ||
            status === ctx.statuses.IN_DEVELOPMENT ||
            status === ctx.statuses.READY_FOR_DEVELOPMENT;
    }

    function tcStatus(tc) {
        return tc && tc.fields && tc.fields.status && tc.fields.status.name;
    }

    function classificationGate() {
        return {
            statuses: ctx.statuses,
            hasStage: function(tc, stageKey, statusName) { return tracker.hasStage(tc, stageKey, statusName); },
            statusOf: tcStatus,
            inFlight: isInFlightStatus,
            pendingBugKey: findPendingBugKey
        };
    }

    // ── gh-1080: outcome steps (extracted verbatim from the pre-split flow) ──

    // gh-1330: the Done completion now reports per-status buckets — a suite
    // with skipped/irrelevant TCs must not claim "All Test Cases Passed".
    function completeStoryDone(counts, totalTCs) {
        console.log('Concluded TC buckets — passed:', counts.passed, 'skipped:', counts.skipped,
            'irrelevant:', counts.irrelevant, '— moving', ticketKey, 'to Done');

        tracker.moveToStatus(ticketKey, ctx.statuses.DONE);

        tracker.postComment(ticketKey, buildStoryDoneComment(counts, totalTCs));

        console.log('✅ Story', ticketKey, 'moved to Done');

        postTokenUsageSafely();

        return {
            success: true,
            action: 'moved_to_done',
            totalTCs: totalTCs,
            passedTCs: counts.passed,
            skippedTCs: counts.skipped,
            irrelevantTCs: counts.irrelevant,
            ticketKey: ticketKey
        };
    }

    // Step 3: Some TCs have open bugs → Story must wait in Bug To Fix
    function moveStoryToBugToFix(pendingBugTCs) {
        var bugList = pendingBugTCs.map(function(item) {
            return '*' + item.bugKey + '* (from ' + item.key + ')';
        }).join('\n');

        console.log('Found', pendingBugTCs.length, 'TC(s) with pending bugs — moving Story to Bug To Fix');

        // gh-916: BUG_TO_FIX can be tag-only (restricted ADO workflows) — stage-label fallback.
        var bugToFixMove = tracker.moveToStatusOrMark(ticketKey, ctx.statuses.BUG_TO_FIX, 'BUG_TO_FIX');
        if (bugToFixMove.moved || bugToFixMove.marked) {
            tracker.postComment(ticketKey, 'h3. 🐛 Story Moved to Bug To Fix\n\n' +
                    'The following linked Test Cases have open bugs:\n\n' + bugList + '\n\n' +
                    'The Story has been moved to *Bug To Fix*. It will return to *Ready For Testing* once all linked bugs are *Done*.');

            console.log('✅ Story', ticketKey, 'moved to Bug To Fix');
        }
        releaseLock();

        postTokenUsageSafely();

        return { success: true, action: 'moved_to_bug_to_fix', pendingBugTCs: pendingBugTCs.length, ticketKey: ticketKey };
    }

    // Step 5: All remaining non-passed TCs are ready for re-test → back to Ready For Testing
    function moveStoryToReadyForTesting(readyForRetestCount) {
        console.log('All non-passed TCs are ready for re-test — moving Story to Ready For Testing');

        // gh-916: READY_FOR_TESTING can be tag-only (restricted ADO workflows) — stage-label fallback.
        var retestMove = tracker.moveToStatusOrMark(ticketKey, ctx.statuses.READY_FOR_TESTING, 'READY_FOR_TESTING');
        if (retestMove.moved || retestMove.marked) {
            tracker.postComment(ticketKey, 'h3. 🔄 Story Ready for Re-test\n\n' +
                    'All linked bugs are resolved. The Story has been moved back to *Ready For Testing* to re-run the linked Test Cases.');

            console.log('✅ Story', ticketKey, 'moved to Ready For Testing');
        }
        releaseLock();

        postTokenUsageSafely();

        return { success: true, action: 'moved_to_ready_for_testing', readyForRetestTCs: readyForRetestCount, ticketKey: ticketKey };
    }

    // gh-1330: best-effort skip marker — the comment carries the context, the
    // label is the idempotency gate. Each write fails soft: a marker failure
    // must never block the story completion.
    function stampSkipMarkerOnTc(tcKey, reason, dateStr, existingLabels) {
        var markerLabel = skipMarkerLabelFor(ticketKey);
        if ((existingLabels || []).indexOf(markerLabel) !== -1) {
            console.log('Skip marker already on', tcKey, '— not stamping again');
            return false;
        }
        var stamped = false;
        try {
            tracker.postComment(tcKey, buildSkipMarkerComment(ticketKey, tcKey, reason, dateStr));
            stamped = true;
        } catch (e) {
            console.warn('Failed to post skip marker comment on', tcKey, ':', e);
        }
        try {
            tracker.addLabel(tcKey, markerLabel);
            stamped = true;
        } catch (e) {
            console.warn('Failed to add skip marker label on', tcKey, ':', e);
        }
        return stamped;
    }

    function stampSkipMarkers(skippedTcs, reason) {
        var dateStr = new Date().toISOString().slice(0, 10);
        var stamped = [];
        skippedTcs.forEach(function(tc) {
            var existingLabels = tc.fields && tc.fields.labels;
            if (stampSkipMarkerOnTc(tc.key, reason, dateStr, existingLabels)) {
                stamped.push(tc.key);
            }
        });
        return stamped;
    }

    // gh-1330: opt-in skipsNeedHuman flow — flag the story instead of moving it
    // to Done. No lock release: the flow stops until a human resolves the skips
    // and re-triggers the check (the flag is posted once; re-checks stay quiet).
    function flagSkipsNeedHuman(counts, totalTCs) {
        var alreadyFlagged = false;
        try {
            var story = tracker.getIssue(ticketKey);
            var labels = (story && story.fields && story.fields.labels) || [];
            alreadyFlagged = labels.indexOf(NEEDS_HUMAN_SKIPS_LABEL) !== -1;
        } catch (e) {
            console.warn('Could not read story labels — treating the needs-human flag as not set:', e);
        }

        if (!alreadyFlagged) {
            tracker.addLabel(ticketKey, NEEDS_HUMAN_SKIPS_LABEL);
            tracker.postComment(ticketKey, buildSkipsNeedHumanComment(counts, totalTCs));
            console.log('⚠️ skipsNeedHuman:', ticketKey, 'flagged for human review —', counts.skipped, 'skipped TC(s), story NOT moved to Done');
        } else {
            console.log('⚠️ skipsNeedHuman:', ticketKey, 'already flagged — leaving it for human review');
        }

        postTokenUsageSafely();

        return {
            success: true,
            action: 'needs_human_skips',
            totalTCs: totalTCs,
            passedTCs: counts.passed,
            skippedTCs: counts.skipped,
            irrelevantTCs: counts.irrelevant,
            alreadyFlagged: alreadyFlagged,
            ticketKey: ticketKey
        };
    }

    function applyCheckOutcome(buckets, allTCs, gate, totalTCs) {
        if (allTestsConcluded(buckets)) {
            var split = statusBuckets(allTCs, gate);

            // gh-1330: stamp the skip context on the TCs themselves BEFORE the
            // story moves — a Done story is never re-checked, so the markers
            // must exist even if the move (or a later step) fails.
            if (split.counts.skipped > 0) {
                stampSkipMarkers(split.skippedTcs, ctx.skipReason);
                if (ctx.skipsNeedHuman) {
                    return flagSkipsNeedHuman(split.counts, totalTCs);
                }
            }

            return completeStoryDone(split.counts, totalTCs);
        }

        // Step 2: Some TCs are still being reviewed/developed — wait for those agents
        if (buckets.inFlight.length > 0) {
            console.log(buckets.inFlight.length, 'TC(s) still in review/automation — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting_in_flight', totalTCs: totalTCs, inFlightTCs: buckets.inFlight, ticketKey: ticketKey };
        }

        if (buckets.pendingBug.length > 0) {
            return moveStoryToBugToFix(buckets.pendingBug);
        }

        // Step 4: Some Failed TCs still have no linked bug — wait for bulk_bugs_creation
        if (buckets.waitingForBugs.length > 0) {
            console.log('Failed TCs without linked bugs — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting_for_bugs', totalTCs: totalTCs, waitingForBugsTCs: buckets.waitingForBugs, ticketKey: ticketKey };
        }

        return moveStoryToReadyForTesting(buckets.readyForRetest.length);
    }

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Story done check for', ticketKey, '===');

        const allTCs = findLinkedTCs();
        const totalTCs = allTCs.length;
        console.log('Linked Test Cases:', totalTCs);

        if (totalTCs === 0) {
            console.log('No linked Test Cases found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_test_cases', ticketKey: ticketKey };
        }

        const gate = classificationGate();
        const buckets = bucketTestCases(allTCs, gate);
        return applyCheckOutcome(buckets, allTCs, gate, totalTCs);

    } catch (error) {
        console.error('❌ Error in checkStoryTestsPassed:', error);
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        // gh-1330: truthful bucket reporting helpers — exported for direct
        // characterization tests.
        statusBuckets,
        buildBucketSummary,
        buildStoryDoneComment,
        buildSkipMarkerComment,
        buildSkipsNeedHumanComment,
        skipMarkerLabelFor
    };
}
