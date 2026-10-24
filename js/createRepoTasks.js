/**
 * Create Repository Development Sub-tasks
 *
 * Reads the {code:json|title=affected_repos} block from a story-solution (SA)
 * ticket description and creates one development Sub-task per repository under
 * the same parent as the SA ticket.
 *
 * Summary format:   [repo] [parent summary]
 * Description:      Your scope only development for [repo] based on solution in
 *                   [SA link] and parent acceptance criteria [parent link]
 *
 * Duplicate-safe: skips repos that already have a matching Sub-task under the parent.
 *
 * gh-1004: action was one 200+ line function (CRAP 180.9). The pure decisions
 * and payload builders are extracted so action only orchestrates; every
 * helper is covered directly by js/unit-tests/test_createRepoTasks.js.
 * gh-1245: every helper shared with createRepoTasksMulti.js lives in
 * js/common/repoTaskShared.js — this module only shapes per-repo Sub-task
 * plans on top of the shared creation loop.
 */

var shared = require('./common/repoTaskShared.js');
var trackersModule = require('./common/trackers.js');

// ---------------------------------------------------------------------------
// Plan shaping (gh-1245): one plan per repository, consumed by the shared
// createSubTasks() creation loop in js/common/repoTaskShared.js.
// ---------------------------------------------------------------------------

function buildRepoSubTaskPlans(repos, parentSummary, saKey, parentKey, baseUrl) {
    var plans = [];
    repos.forEach(function(repo) {
        var repoName = typeof repo === 'string' ? repo : repo.name;
        if (!repoName) return;

        var summary = shared.buildScopedSummary(repoName, parentSummary);
        var description = shared.buildScopeDescription(repoName, saKey, parentKey, baseUrl);

        plans.push({
            summary: summary,
            description: description,
            // A repo is a duplicate when any existing summary carries its tag.
            dedupeLabel: '[' + repoName + ']',
            skipLog: repoName,
            skipValue: repoName,
            mapKey: repoName,
            buildRecord: function(createdKey) {
                return { repo: repoName, key: createdKey, summary: summary, depends_on: repo.depends_on || [] };
            },
            buildErrorRecord: function(e) {
                return { repo: repoName, key: null, error: e.toString(), depends_on: [] };
            }
        });
    });
    return plans;
}

function createSubTasks(tracker, repos, projectKey, parentKey, parentSummary, saKey, baseUrl, ticketLabels, existingSummaries) {
    var plans = buildRepoSubTaskPlans(repos, parentSummary, saKey, parentKey, baseUrl);
    var outcome = shared.createSubTasks(tracker, plans, {
        projectKey: projectKey,
        parentKey: parentKey,
        ticketLabels: ticketLabels
    }, existingSummaries);
    return { created: outcome.created, skipped: outcome.skipped, repoKeyMap: outcome.keyMap };
}

// ---------------------------------------------------------------------------
// Per-module behaviour wrappers (gh-1245) — the exported names and contracts
// are unchanged since gh-1004/gh-1197; each delegates to the shared helper.
// ---------------------------------------------------------------------------

function decideDuplicate(existingSummaries, repoName) {
    return shared.decideDuplicate(existingSummaries, '[' + repoName + ']');
}

function buildRepoSummary(repoName, parentSummary) {
    return shared.buildScopedSummary(repoName, parentSummary);
}

function buildScopeDescription(repoName, saKey, parentKey, baseUrl) {
    return shared.buildScopeDescription(repoName, saKey, parentKey, baseUrl);
}

function buildSummaryComment(created, skipped, baseUrl) {
    return shared.buildSummaryComment(created, skipped, baseUrl, 'repo');
}

function postOutcomeSummaryComment(tracker, saKey, baseUrl, outcome) {
    shared.postOutcomeSummaryComment(tracker, saKey, baseUrl, outcome, 'repo');
}

function action(params) {
    try {
        var saInfo = shared.extractSaKey(params);
        if (saInfo.error) {
            return { success: false, error: saInfo.error };
        }
        var saKey = saInfo.saKey;

        console.log('createRepoTasks: processing SA ticket ' + saKey);

        var options = shared.resolveTaskOptions(params);
        var tracker = trackersModule.createTracker(shared.resolveProjectConfig(params), options.customParams);

        var saContext = shared.resolveSaTicketContext(tracker, saKey);
        if (!saContext.parentKey) {
            return { success: false, error: 'SA ticket ' + saKey + ' has no parent ticket' };
        }
        console.log('Parent ticket: ' + saContext.parentKey);

        var parentSummary = shared.resolveParentSummary(tracker, saContext.parentKey);

        var reposInfo = shared.requireAffectedRepos(saContext.description, saKey);
        if (reposInfo.error) {
            return { success: false, error: reposInfo.error };
        }
        var repos = reposInfo.repos;
        console.log('Found ' + repos.length + ' affected repo(s): ' + shared.repoNamesCsv(repos));

        var baseUrl = shared.getJiraBaseUrl();
        var projectKey = saContext.parentKey.split('-')[0];

        // Load existing Sub-tasks under the parent to avoid duplicates
        var existingSummaries = shared.loadExistingSummaries(tracker, saContext.parentKey);

        var outcome = createSubTasks(tracker, repos, projectKey, saContext.parentKey, parentSummary, saKey, baseUrl, options.ticketLabels, existingSummaries);

        // Wire dependencies: blocker Blocks dependent + move dependent to Blocked status
        shared.wireDependencies(tracker, outcome.created, outcome.repoKeyMap, options.blocksRelationship, options.blockedStatus);

        postOutcomeSummaryComment(tracker, saKey, baseUrl, outcome);

        var successCount = outcome.created.filter(function(c) { return !c.error; }).length;
        return {
            success: true,
            message: 'Created ' + successCount + ' Sub-task(s) under ' + saContext.parentKey + ', skipped ' + outcome.skipped.length,
            created: successCount,
            skipped: outcome.skipped.length
        };

    } catch (error) {
        console.error('Error in createRepoTasks:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        buildRepoSubTaskPlans: buildRepoSubTaskPlans,
        createSubTasks: createSubTasks,
        decideDuplicate: decideDuplicate,
        buildRepoSummary: buildRepoSummary,
        buildScopeDescription: buildScopeDescription,
        buildSummaryComment: buildSummaryComment,
        postOutcomeSummaryComment: postOutcomeSummaryComment,
        parseAffectedRepos: shared.parseAffectedRepos,
        extractCreatedKey: shared.extractCreatedKey,
        loadExistingSummaries: shared.loadExistingSummaries,
        wireDependencies: shared.wireDependencies,
        postSummaryComment: shared.postSummaryComment,
        extractSaKey: shared.extractSaKey,
        resolveTaskOptions: shared.resolveTaskOptions,
        resolveSaTicketContext: shared.resolveSaTicketContext,
        resolveParentSummary: shared.resolveParentSummary,
        requireAffectedRepos: shared.requireAffectedRepos,
        repoNamesCsv: shared.repoNamesCsv
    };
}
