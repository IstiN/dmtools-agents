/**
 * Create Repository Development Sub-tasks — Multi-Task Variant
 *
 * Like createRepoTasks.js, reads the {code:json|title=affected_repos} block from
 * a story-solution (SA) ticket description and creates development Sub-tasks
 * under the same parent as the SA ticket — but supports splitting a single
 * repository's work into several independently trackable Sub-tasks via an
 * optional `tasks` array on a repo entry (see
 * instructions/story_solution/affected_repos_multi_task_split.md).
 *
 * Backward compatible: a repo entry with no `tasks` array still produces
 * exactly one Sub-task, identical to createRepoTasks.js.
 *
 * Summary format:   [repo] <task title OR repo-level reason>
 * Description:      Your scope only development for [repo] based on solution in
 *                   [SA link] and parent acceptance criteria [parent link]
 *
 * Duplicate-safe: skips (repo, title) pairs that already have a matching
 * Sub-task under the parent.
 *
 * gh-1004: action was one 200+ line function (CRAP 57.2). The pure decisions
 * and payload builders are extracted below so action only orchestrates; every
 * helper is covered directly by js/unit-tests/test_createRepoTasksMulti.js.
 * gh-1245: every helper shared with createRepoTasks.js lives in
 * js/common/repoTaskShared.js — this module keeps only the multi-task
 * flattening/sorting and the per-task plan shaping.
 */

var shared = require('./common/repoTaskShared.js');

// ---------------------------------------------------------------------------
// Flatten repo entries (with optional `tasks`) into a flat list of tasks,
// each carrying a globally-unique key "repo:id" and resolved depends_on keys.
// (gh-1228 CRAP split: normalising, per-repo flattening and dependency
// resolution live in small pure helpers below.)
// ---------------------------------------------------------------------------

function normaliseRepoEntry(repo) {
    return typeof repo === 'string' ? { name: repo } : repo;
}

/** Emit one flat task per explicit `tasks` entry, registering each "repo:id" key. */
function flattenExplicitRepoTasks(repo, repoName, repoTaskKeys, flat) {
    repoTaskKeys[repoName] = [];
    repo.tasks.forEach(function(t) {
        var id = t.id || t.title;
        var key = repoName + ':' + id;
        repoTaskKeys[repoName].push(key);
        flat.push({
            key: key,
            repo: repoName,
            title: t.title || id,
            reason: t.reason || '',
            rawDependsOn: Array.isArray(t.depends_on) ? t.depends_on : [],
            repoLevelDependsOn: Array.isArray(repo.depends_on) ? repo.depends_on : []
        });
    });
}

/** Emit the implicit single task for a repo with no `tasks` — identical to createRepoTasks.js behaviour. */
function flattenImplicitRepoTask(repo, repoName, repoTaskKeys, flat) {
    var implicitKey = repoName + ':' + repoName;
    repoTaskKeys[repoName] = [implicitKey];
    flat.push({
        key: implicitKey,
        repo: repoName,
        title: repo.reason || repoName,
        reason: repo.reason || '',
        rawDependsOn: [],
        repoLevelDependsOn: Array.isArray(repo.depends_on) ? repo.depends_on : []
    });
}

function hasFlatTaskKey(flat, key) {
    return flat.some(function(f) { return f.key === key; });
}

/** Resolve one depends_on reference into the concrete task key(s) it points at. */
function resolveDepRef(ref, ownRepo, repoTaskKeys, flat) {
    if (ref.indexOf(':') !== -1) {
        // Already a fully-qualified "repo:id" reference
        return repoTaskKeys[ref.split(':')[0]] && hasFlatTaskKey(flat, ref) ? [ref] : [];
    }
    if (repoTaskKeys[ref]) {
        // Bare repo name → depends on all of that repo's tasks
        return repoTaskKeys[ref].slice();
    }
    // Bare task id within the same repo
    var sameRepoKey = ownRepo + ':' + ref;
    return hasFlatTaskKey(flat, sameRepoKey) ? [sameRepoKey] : [];
}

/** Resolve a task's rawDependsOn + repoLevelDependsOn into a deduped key list. */
function resolveTaskDependsOn(task, repoTaskKeys, flat) {
    var resolved = {};
    task.rawDependsOn.concat(task.repoLevelDependsOn).forEach(function(ref) {
        resolveDepRef(ref, task.repo, repoTaskKeys, flat).forEach(function(k) {
            if (k !== task.key) resolved[k] = true;
        });
    });
    return Object.keys(resolved);
}

function flattenTasks(repos) {
    // repoName -> array of task keys ("repo:id"), used to expand bare-repo-name deps
    var repoTaskKeys = {};
    var flat = [];

    repos.map(normaliseRepoEntry).forEach(function(repo) {
        var repoName = repo.name;
        if (!repoName) return;

        if (Array.isArray(repo.tasks) && repo.tasks.length > 0) {
            flattenExplicitRepoTasks(repo, repoName, repoTaskKeys, flat);
        } else {
            flattenImplicitRepoTask(repo, repoName, repoTaskKeys, flat);
        }
    });

    // Resolve depends_on references into concrete task keys.
    flat.forEach(function(t) {
        t.depends_on = resolveTaskDependsOn(t, repoTaskKeys, flat);
    });

    return flat;
}

// ---------------------------------------------------------------------------
// Topological sort over the flattened task graph
// ---------------------------------------------------------------------------

function topologicalSortTasks(tasks) {
    var byKey = {};
    tasks.forEach(function(t) { byKey[t.key] = t; });

    var sorted = [];
    var visited = {};

    function visit(key) {
        if (visited[key]) return;
        visited[key] = true;
        var t = byKey[key];
        if (t) {
            t.depends_on.forEach(function(dep) { if (byKey[dep]) visit(dep); });
            sorted.push(t);
        }
    }

    tasks.forEach(function(t) { visit(t.key); });
    return sorted;
}

function buildTaskPlan(repos) {
    return topologicalSortTasks(flattenTasks(repos));
}

// ---------------------------------------------------------------------------
// Plan shaping (gh-1245): one plan per flattened task, consumed by the shared
// createSubTasks() creation loop in js/common/repoTaskShared.js.
// ---------------------------------------------------------------------------

function buildTaskSubTaskPlans(tasks, saKey, parentKey, baseUrl) {
    return tasks.map(function(t) {
        var summary = shared.buildScopedSummary(t.repo, t.title);
        return {
            summary: summary,
            description: shared.buildScopeDescription(t.repo, saKey, parentKey, baseUrl, t.reason),
            // Dedup key is "[repo] title" (not just "[repo]") so multiple tasks
            // in the same repo don't falsely collide.
            dedupeLabel: summary,
            skipLog: '"' + summary + '"',
            skipValue: summary,
            mapKey: t.key,
            buildRecord: function(createdKey) {
                return { taskKey: t.key, repo: t.repo, key: createdKey, summary: summary, depends_on: t.depends_on };
            },
            buildErrorRecord: function(e) {
                return { taskKey: t.key, repo: t.repo, key: null, summary: summary, error: e.toString(), depends_on: [] };
            }
        };
    });
}

function createSubTasks(tracker, tasks, projectKey, parentKey, saKey, baseUrl, ticketLabels, existingSummaries) {
    var plans = buildTaskSubTaskPlans(tasks, saKey, parentKey, baseUrl);
    var options = {
        projectKey: projectKey,
        parentKey: parentKey,
        ticketLabels: ticketLabels
    };
    var outcome = shared.createSubTasks(tracker, plans, options, existingSummaries);
    return { created: outcome.created, skipped: outcome.skipped, taskKeyMap: outcome.keyMap };
}

// ---------------------------------------------------------------------------
// Per-module behaviour wrappers (gh-1245) — the exported names and contracts
// are unchanged since gh-1004/gh-1197; each delegates to the shared helper.
// ---------------------------------------------------------------------------

function buildTaskSummary(repo, title) {
    return shared.buildScopedSummary(repo, title);
}

function buildTaskDescription(repo, reason, saKey, parentKey, baseUrl) {
    return shared.buildScopeDescription(repo, saKey, parentKey, baseUrl, reason);
}

function decideDuplicate(existingSummaries, summary) {
    return shared.decideDuplicate(existingSummaries, summary);
}

function buildSummaryComment(created, skipped, baseUrl) {
    return shared.buildSummaryComment(created, skipped, baseUrl, 'summary');
}

function describeTaskPlan(repos, tasks) {
    return 'Flattened into ' + tasks.length + ' task(s) across ' + shared.repoNamesCsv(repos);
}

function postOutcomeSummaryComment(tracker, saKey, baseUrl, outcome) {
    shared.postOutcomeSummaryComment(tracker, saKey, baseUrl, outcome, 'summary');
}

function taskKeyMapOf(outcome) {
    return outcome.taskKeyMap;
}

function action(params) {
    return shared.runRepoTaskAction(params, {
        scriptName: 'createRepoTasksMulti',
        labelField: 'summary',
        keyMapOf: taskKeyMapOf,
        buildUnits: buildTaskPlan,
        describeUnits: describeTaskPlan,
        createSubTasks: createSubTasks
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseAffectedRepos: shared.parseAffectedRepos,
        flattenTasks: flattenTasks,
        topologicalSortTasks: topologicalSortTasks,
        normaliseRepoEntry: normaliseRepoEntry,
        flattenExplicitRepoTasks: flattenExplicitRepoTasks,
        flattenImplicitRepoTask: flattenImplicitRepoTask,
        resolveDepRef: resolveDepRef,
        resolveTaskDependsOn: resolveTaskDependsOn,
        buildTaskPlan: buildTaskPlan,
        buildTaskSummary: buildTaskSummary,
        buildTaskDescription: buildTaskDescription,
        decideDuplicate: decideDuplicate,
        extractCreatedKey: shared.extractCreatedKey,
        buildSummaryComment: buildSummaryComment,
        loadExistingSummaries: shared.loadExistingSummaries,
        createSubTasks: createSubTasks,
        wireDependencies: shared.wireDependencies,
        postSummaryComment: shared.postSummaryComment,
        extractSaKey: shared.extractSaKey,
        resolveTaskOptions: shared.resolveTaskOptions,
        resolveSaTicketContext: shared.resolveSaTicketContext,
        resolveParentSummary: shared.resolveParentSummary,
        requireAffectedRepos: shared.requireAffectedRepos,
        repoNamesCsv: shared.repoNamesCsv,
        describeTaskPlan: describeTaskPlan,
        postOutcomeSummaryComment: postOutcomeSummaryComment,
        buildTaskSubTaskPlans: buildTaskSubTaskPlans,
        action: action
    };
}
