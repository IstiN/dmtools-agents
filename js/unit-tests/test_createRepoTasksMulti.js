/**
 * Unit tests for js/createRepoTasksMulti.js
 */

function makeModule(globals) {
    var defaultGlobals = {
        java: { lang: { System: { getenv: function() { return 'https://jira.example.com'; } } } },
        jira_get_ticket: function() { return { fields: {} }; },
        jira_search_by_jql: function() { return []; },
        jira_create_ticket_with_parent: function() { return '{"key":"PROJ-2"}'; },
        jira_link_issues: function() {},
        jira_move_to_status: function() {},
        jira_post_comment: function() {}
    };
    for (var k in (globals || {})) { defaultGlobals[k] = globals[k]; }

    return loadModule(
        'js/createRepoTasksMulti.js',
        makeRequire({ './config.js': configModule, './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'), './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), defaultGlobals) }),
        defaultGlobals
    );
}

// ---------------------------------------------------------------------------
// flattenTasks
// ---------------------------------------------------------------------------

suite('createRepoTasksMulti — flattenTasks', function() {
    test('repo with no tasks array produces one implicit task', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([{ name: 'repo-a', reason: 'Do the thing' }]);
        assert.equal(flat.length, 1, 'one implicit task');
        assert.equal(flat[0].repo, 'repo-a', 'repo name kept');
        assert.equal(flat[0].title, 'Do the thing', 'reason used as title');
        assert.deepEqual(flat[0].depends_on, [], 'no deps');
    });

    test('repo with tasks array produces one task per entry', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([{
            name: 'backend-service',
            tasks: [
                { id: 'schema', title: 'Add schema migration', reason: 'r1' },
                { id: 'processor', title: 'Implement processor', reason: 'r2', depends_on: ['schema'] }
            ]
        }]);
        assert.equal(flat.length, 2, 'two tasks');
        assert.equal(flat[0].key, 'backend-service:schema', 'first task key');
        assert.equal(flat[1].key, 'backend-service:processor', 'second task key');
        assert.deepEqual(flat[1].depends_on, ['backend-service:schema'], 'same-repo bare id resolved to qualified key');
    });

    test('bare repo-name dependency expands to all of that repo\'s task keys', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([
            {
                name: 'backend-service',
                tasks: [
                    { id: 'schema', title: 'Schema' },
                    { id: 'processor', title: 'Processor' }
                ]
            },
            {
                name: 'frontend-app',
                depends_on: ['backend-service']
            }
        ]);
        var frontendTask = flat.filter(function(t) { return t.repo === 'frontend-app'; })[0];
        assert.equal(frontendTask.depends_on.length, 2, 'depends on both backend-service tasks');
        assert.equal(frontendTask.depends_on.indexOf('backend-service:schema') !== -1, true, 'includes schema task');
        assert.equal(frontendTask.depends_on.indexOf('backend-service:processor') !== -1, true, 'includes processor task');
    });

    test('fully-qualified "repo:id" cross-repo dependency resolves to exact task', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([
            {
                name: 'backend-service',
                tasks: [
                    { id: 'schema', title: 'Schema' },
                    { id: 'processor', title: 'Processor' }
                ]
            },
            {
                name: 'frontend-app',
                tasks: [
                    { id: 'view', title: 'View', depends_on: ['backend-service:processor'] }
                ]
            }
        ]);
        var viewTask = flat.filter(function(t) { return t.key === 'frontend-app:view'; })[0];
        assert.deepEqual(viewTask.depends_on, ['backend-service:processor'], 'exact cross-repo task dependency resolved');
    });

    test('unresolvable dependency reference is silently dropped, not fatal', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([
            { name: 'repo-a', tasks: [{ id: 't1', title: 'T1', depends_on: ['nonexistent'] }] }
        ]);
        assert.deepEqual(flat[0].depends_on, [], 'unresolved ref dropped');
    });
});

// ---------------------------------------------------------------------------
// topologicalSortTasks
// ---------------------------------------------------------------------------

suite('createRepoTasksMulti — topologicalSortTasks', function() {
    test('orders prerequisite tasks before dependents', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([{
            name: 'backend-service',
            tasks: [
                { id: 'processor', title: 'Processor', depends_on: ['schema'] },
                { id: 'schema', title: 'Schema' }
            ]
        }]);
        var sorted = mod.topologicalSortTasks(flat);
        var keys = sorted.map(function(t) { return t.key; });
        assert.equal(keys.indexOf('backend-service:schema') < keys.indexOf('backend-service:processor'), true, 'schema before processor');
    });
});

// ---------------------------------------------------------------------------
// parseAffectedRepos (shared logic with createRepoTasks.js)
// ---------------------------------------------------------------------------

suite('createRepoTasksMulti — parseAffectedRepos', function() {
    test('extracts JSON array from {code:json|title=affected_repos} block', function() {
        var mod = makeModule();
        var desc = '{code:json|title=affected_repos}\n[{"name":"repo-a"}]\n{code}';
        var repos = mod.parseAffectedRepos(desc);
        assert.equal(repos.length, 1, 'one repo');
    });

    test('returns empty array when marker absent', function() {
        var mod = makeModule();
        assert.equal(mod.parseAffectedRepos('nothing here').length, 0, 'empty array');
    });
});

// ---------------------------------------------------------------------------
// action — end to end
// ---------------------------------------------------------------------------

suite('createRepoTasksMulti — action', function() {
    var reposJson = JSON.stringify([
        {
            name: 'backend-service',
            reason: 'Schema + processor',
            tasks: [
                { id: 'schema', title: 'Add schema migration', reason: 'Flyway migration' },
                { id: 'processor', title: 'Implement processor', reason: 'Consumes schema', depends_on: ['schema'] }
            ]
        },
        {
            name: 'frontend-app',
            reason: 'New view',
            depends_on: ['backend-service']
        }
    ]);
    var description = 'Solution text\n\n{code:json|title=affected_repos}\n' + reposJson + '\n{code}\n\n----';

    test('creates one Sub-task per flattened task, not per repo', function() {
        var created = [];
        var ticketCounter = 200;
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Build example feature' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function(opts) {
                ticketCounter++;
                created.push(opts);
                return '{"key":"PROJ-' + ticketCounter + '"}';
            },
            jira_link_issues: function() {},
            jira_move_to_status: function() {},
            jira_post_comment: function() {}
        });

        var result = mod.action({ ticket: { key: 'PROJ-100' } });

        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 3, 'three sub-tasks: schema, processor, frontend-app view');
        assert.equal(created[0].summary, '[backend-service] Add schema migration', 'first task summary');
        assert.equal(created[1].summary, '[backend-service] Implement processor', 'second task summary');
        assert.equal(created[2].summary, '[frontend-app] New view', 'implicit single-task repo summary');
    });

    test('links cross-task dependencies (same repo and cross repo) and moves dependents to Blocked', function() {
        var links = [];
        var moved = [];
        var ticketCounter = 300;
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Story' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function() {
                ticketCounter++;
                return '{"key":"PROJ-' + ticketCounter + '"}';
            },
            jira_link_issues: function(opts) { links.push(opts); },
            jira_move_to_status: function(opts) { moved.push(opts); },
            jira_post_comment: function() {}
        });

        mod.action({ ticket: { key: 'PROJ-100' } });

        // schema(301) blocks processor(302); both schema+processor block frontend-app view(303)
        assert.equal(links.length, 3, 'three Blocks links (1 intra-repo + 2 cross-repo)');
        assert.equal(moved.length, 2, 'processor and frontend-app view moved to Blocked');
    });

    test('repo entry without tasks array still creates exactly one Sub-task (backward compatible)', function() {
        var created = [];
        var flatDescription = 'Solution\n\n{code:json|title=affected_repos}\n' +
            JSON.stringify([{ name: 'core-db', reason: 'DB migration' }]) + '\n{code}';
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: flatDescription, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Story' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function(opts) { created.push(opts); return '{"key":"PROJ-401"}'; },
            jira_post_comment: function() {}
        });

        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 1, 'exactly one sub-task');
        assert.equal(created[0].summary, '[core-db] DB migration', 'summary uses repo-level reason as title');
    });

    test('skips (repo, title) pairs that already exist as Sub-tasks', function() {
        var created = [];
        var ticketCounter = 500;
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Story' } };
            },
            jira_search_by_jql: function() {
                return [{ fields: { summary: '[backend-service] Add schema migration' } }]; // already exists
            },
            jira_create_ticket_with_parent: function(opts) {
                ticketCounter++;
                created.push(opts);
                return '{"key":"PROJ-' + ticketCounter + '"}';
            },
            jira_post_comment: function() {}
        });

        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 2, 'schema task skipped, other two created');
        assert.equal(result.skipped, 1, 'one skipped');
    });

    test('truncates an overlong AI-generated task title so the Jira summary stays under 255 chars', function() {
        var longTitle = 'A'.repeat(300); // realistic case: GENSGENP-53750 saw a 319-char summary rejected by Jira
        var created = [];
        var longDescription = 'Solution\n\n{code:json|title=affected_repos}\n' +
            JSON.stringify([{ name: 'lims-ui', reason: 'x', tasks: [{ id: 't1', title: longTitle }] }]) +
            '\n{code}';
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: longDescription, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Story' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function(opts) { created.push(opts); return '{"key":"PROJ-601"}'; },
            jira_post_comment: function() {}
        });

        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 1, 'one sub-task created');
        assert.equal(created[0].summary.length <= 255, true, 'summary truncated to Jira limit');
        assert.equal(created[0].summary.slice(-3), '...', 'truncated summary ends with ellipsis');
    });

    test('returns error when SA ticket has no parent', function() {
        var mod = makeModule({
            jira_get_ticket: function() {
                return { fields: { description: description, parent: null } };
            }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, false, 'fails without parent');
    });

    test('returns error when no affected_repos block in description', function() {
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: 'no repos here', parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Story' } };
            }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, false, 'fails without repos block');
    });

    test('module.exports is guarded with typeof for postJSAction compatibility', function() {
        var code = file_read({ path: 'js/createRepoTasksMulti.js' });
        var hasGuard = code.indexOf('typeof module') !== -1 && code.indexOf('module.exports') !== -1;
        assert.equal(hasGuard, true, 'module.exports must be inside typeof module guard');
    });
});

// ---------------------------------------------------------------------------
// action — branch coverage (gh-1004)
// ---------------------------------------------------------------------------

suite('createRepoTasksMulti — action branch coverage', function() {
    var reposJson = JSON.stringify([
        {
            name: 'backend-service',
            reason: 'Schema + processor',
            tasks: [
                { id: 'schema', title: 'Add schema migration', reason: 'Flyway migration' },
                { id: 'processor', title: 'Implement processor', reason: 'Consumes schema', depends_on: ['schema'] }
            ]
        }
    ]);
    var description = 'Solution\n\n{code:json|title=affected_repos}\n' + reposJson + '\n{code}\n\n----';

    function makeHappyModule(overrides) {
        var base = {
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Build example feature' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function() { return '{"key":"PROJ-201"}'; },
            jira_link_issues: function() {},
            jira_move_to_status: function() {},
            jira_post_comment: function() {}
        };
        for (var k in (overrides || {})) { base[k] = overrides[k]; }
        return makeModule(base);
    }

    test('returns error when params carry no ticket key', function() {
        var mod = makeHappyModule();
        var result = mod.action({});
        assert.equal(result.success, false, 'fails without ticket key');
        assert.equal(result.error, 'No ticket key in params', 'error message');
    });

    test('outer catch returns failure when the tracker call throws', function() {
        var mod = makeHappyModule({
            jira_get_ticket: function() { throw new Error('tracker down'); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, false, 'fails when tracker throws');
        assert.equal(result.error.indexOf('tracker down') !== -1, true, 'underlying error preserved');
    });

    test('searchIssues failure is tolerated and tasks are still created', function() {
        var created = [];
        var mod = makeHappyModule({
            jira_search_by_jql: function() { throw new Error('search broken'); },
            jira_create_ticket_with_parent: function(opts) { created.push(opts); return '{"key":"PROJ-201"}'; }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds without dedupe');
        assert.equal(created.length, 2, 'both tasks created');
    });

    test('non-array searchIssues result is treated as no existing sub-tasks', function() {
        var created = [];
        var mod = makeHappyModule({
            jira_search_by_jql: function() { return 42; },
            jira_create_ticket_with_parent: function(opts) { created.push(opts); return '{"key":"PROJ-201"}'; }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 2, 'both tasks created');
    });

    test('a failing create does not stop the remaining tasks', function() {
        var created = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function(opts) {
                if (opts.summary.indexOf('schema') !== -1) { throw new Error('create failed'); }
                created.push(opts);
                return '{"key":"PROJ-202"}';
            }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 1, 'only processor created');
        assert.equal(result.created, 1, 'error entry not counted as created');
    });

    test('an empty create result leaves no key for dependency wiring', function() {
        var links = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function() { return ''; },
            jira_link_issues: function(opts) { links.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(links.length, 0, 'no links without resolvable keys');
    });

    test('dependency on a task that failed to create is skipped without failing', function() {
        var links = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function(opts) {
                if (opts.summary.indexOf('schema') !== -1) { throw new Error('create failed'); }
                return '{"key":"PROJ-202"}';
            },
            jira_link_issues: function(opts) { links.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(links.length, 0, 'no link when blocker task was not created');
    });

    test('no move to Blocked when every link attempt fails', function() {
        var moved = [];
        var mod = makeHappyModule({
            jira_link_issues: function() { throw new Error('link failed'); },
            jira_move_to_status: function(opts) { moved.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(moved.length, 0, 'dependent not moved when no link succeeded');
    });

    test('moveToStatus failure is swallowed', function() {
        var mod = makeHappyModule({
            jira_move_to_status: function() { throw new Error('move failed'); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
    });

    test('postComment failure is swallowed', function() {
        var mod = makeHappyModule({
            jira_post_comment: function() { throw new Error('comment failed'); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
    });

    test('posts the sub-task summary comment with error and ok lines', function() {
        var comments = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function(opts) {
                if (opts.summary.indexOf('schema') !== -1) { throw new Error('boom'); }
                return '{"key":"PROJ-302"}';
            },
            jira_post_comment: function(opts) { comments.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(result.created, 1, 'failed task not counted');
        assert.equal(comments.length, 1, 'one comment posted');
        assert.equal(comments[0].key, 'PROJ-100', 'comment goes to the SA ticket');
        var lines = comments[0].comment.split('\n');
        assert.equal(lines[0], 'h3. Development Sub-tasks', 'Jira wiki header');
        assert.equal(lines[2].indexOf('❌') !== -1, true, 'error line marker');
        assert.equal(lines[2].indexOf('Add schema migration') !== -1, true, 'error line uses the summary');
        assert.equal(lines[2].indexOf('boom') !== -1, true, 'error line carries the error');
        assert.equal(lines[3], '* ✅ [PROJ-302|https://jira.example.com/browse/PROJ-302] — [backend-service] Implement processor', 'ok line uses the summary');
    });
});

// ---------------------------------------------------------------------------
// extracted helpers (gh-1004)
// ---------------------------------------------------------------------------

suite('createRepoTasksMulti — extracted helpers', function() {
    function throwsIf(behavior, flag) {
        if (behavior && behavior[flag]) {
            throw new Error(flag.replace(/Error$/, '') + ' failed');
        }
    }

    function resultFor(behavior, key, fallback) {
        return behavior && typeof behavior[key] !== 'undefined' ? behavior[key] : fallback;
    }

    function fakeTracker(behavior) {
        var calls = { create: [], link: [], move: [], comment: [], search: [] };
        return {
            calls: calls,
            createTicketWithParent: function(project, type, title, desc, parentKey, extra) {
                calls.create.push({ project: project, issueType: type, summary: title, description: desc, parentKey: parentKey, labels: extra && extra.labels });
                throwsIf(behavior, 'createError');
                return resultFor(behavior, 'createResult', 'PROJ-9');
            },
            linkIssues: function(sourceKey, anotherKey, relationship) {
                calls.link.push({ sourceKey: sourceKey, anotherKey: anotherKey, relationship: relationship });
                throwsIf(behavior, 'linkError');
            },
            moveToStatus: function(key, statusName) {
                calls.move.push({ key: key, statusName: statusName });
                throwsIf(behavior, 'moveError');
            },
            postComment: function(key, comment) { calls.comment.push({ key: key, comment: comment }); },
            searchIssues: function(jql, opts) {
                calls.search.push({ jql: jql, opts: opts });
                throwsIf(behavior, 'searchError');
                return resultFor(behavior, 'searchResult', []);
            }
        };
    }

    test('buildTaskPlan flattens and topologically sorts repo tasks', function() {
        var mod = makeModule();
        var plan = mod.buildTaskPlan([{
            name: 'backend-service',
            tasks: [
                { id: 'processor', title: 'Processor', depends_on: ['schema'] },
                { id: 'schema', title: 'Schema' }
            ]
        }]);
        assert.equal(plan.length, 2, 'two tasks');
        assert.equal(plan[0].key, 'backend-service:schema', 'dependency first');
        assert.equal(plan[1].key, 'backend-service:processor', 'dependent second');
    });

    test('buildTaskSummary prefixes repo tag and truncates at 255 chars', function() {
        var mod = makeModule();
        assert.equal(mod.buildTaskSummary('repo-a', 'Do it'), '[repo-a] Do it', 'prefixed summary');
        var long = mod.buildTaskSummary('repo-a', 'A'.repeat(300));
        assert.equal(long.length, 255, 'truncated to Jira limit');
        assert.equal(long.slice(-3), '...', 'ends with ellipsis');
    });

    test('buildTaskDescription includes reason, SA link and parent link', function() {
        var mod = makeModule();
        var withReason = mod.buildTaskDescription('repo-a', 'because', 'PROJ-100', 'PROJ-50', 'https://jira.example.com');
        assert.equal(withReason.indexOf('because\n\n') === 0, true, 'reason leads');
        assert.equal(withReason.indexOf('*repo-a*') !== -1, true, 'repo emphasized');
        assert.equal(withReason.indexOf('[PROJ-100|https://jira.example.com/browse/PROJ-100]') !== -1, true, 'SA link');
        var noReason = mod.buildTaskDescription('repo-a', '', 'PROJ-100', 'PROJ-50', 'https://j');
        assert.equal(noReason.indexOf('\n\n') === 0, false, 'no reason preamble when empty');
        assert.equal(noReason.indexOf('Your scope') === 0, true, 'scope leads when no reason');
    });

    test('decideDuplicate matches the exact summary', function() {
        var mod = makeModule();
        assert.equal(mod.decideDuplicate(['[repo-a] Do it'], '[repo-a] Do it'), true, 'exact match');
        assert.equal(mod.decideDuplicate(['[repo-a] Do other'], '[repo-a] Do it'), false, 'no substring match');
        assert.equal(mod.decideDuplicate([], '[repo-a] Do it'), false, 'empty list');
    });

    test('extractCreatedKey passes strings through and reads key/id from objects', function() {
        var mod = makeModule();
        assert.equal(mod.extractCreatedKey('PROJ-7'), 'PROJ-7', 'plain key string');
        assert.equal(mod.extractCreatedKey(''), null, 'empty string yields null');
        assert.equal(mod.extractCreatedKey({ key: 'PROJ-8' }), 'PROJ-8', 'object with key');
        assert.equal(mod.extractCreatedKey({ id: 'PROJ-9' }), 'PROJ-9', 'object with id');
        assert.equal(mod.extractCreatedKey(null), null, 'null');
        var hostile = {};
        Object.defineProperty(hostile, 'key', { get: function() { throw new Error('nope'); } });
        assert.equal(mod.extractCreatedKey(hostile), null, 'throwing accessor yields null');
    });

    test('buildSummaryComment lists ok and error lines plus skips', function() {
        var mod = makeModule();
        var comment = mod.buildSummaryComment(
            [{ summary: '[backend-service] Implement processor', key: 'PROJ-302' }, { summary: '[backend-service] Add schema migration', key: null, error: 'Error: boom' }],
            ['[backend-service] Add schema migration'],
            'https://jira.example.com'
        );
        var lines = comment.split('\n');
        assert.equal(lines[0], 'h3. Development Sub-tasks', 'header');
        assert.equal(lines[2], '* ✅ [PROJ-302|https://jira.example.com/browse/PROJ-302] — [backend-service] Implement processor', 'ok line');
        assert.equal(lines[3].indexOf('❌') !== -1 && lines[3].indexOf('boom') !== -1, true, 'error line');
        assert.equal(lines[5], '_Skipped (already exist): [backend-service] Add schema migration_', 'skipped footer');
        var none = mod.buildSummaryComment([], [], 'https://jira.example.com');
        assert.equal(none, 'h3. Development Sub-tasks\n\n', 'no entries, no skips');
    });

    test('loadExistingSummaries maps issue summaries and tolerates failures', function() {
        var mod = makeModule();
        var t = fakeTracker({ searchResult: [{ fields: { summary: '[a] S' } }] });
        assert.deepEqual(mod.loadExistingSummaries(t, 'PROJ-50'), ['[a] S'], 'summaries mapped');
        assert.equal(t.calls.search[0].jql, 'parent = PROJ-50 AND issuetype = Sub-task', 'JQL scoped to parent');
        var failing = fakeTracker({ searchError: true });
        assert.deepEqual(mod.loadExistingSummaries(failing, 'PROJ-50'), [], 'search failure yields empty list');
        var garbage = fakeTracker({ searchResult: {} });
        assert.deepEqual(mod.loadExistingSummaries(garbage, 'PROJ-50'), [], 'non-array yields empty list');
    });

    test('createSubTasks creates one ticket per flat task, skipping exact duplicates', function() {
        var mod = makeModule();
        var t = fakeTracker();
        var tasks = [
            { key: 'r:one', repo: 'r', title: 'One', depends_on: ['r:two'] },
            { key: 'r:two', repo: 'r', title: 'Two', depends_on: [] }
        ];
        var out = mod.createSubTasks(t, tasks, 'PROJ', 'PROJ-50', 'PROJ-100', 'https://jira.example.com', ['development'], ['[r] Two']);
        assert.equal(t.calls.create.length, 1, 'duplicate skipped');
        assert.equal(out.created.length, 1, 'one created entry');
        assert.deepEqual(out.skipped, ['[r] Two'], 'skipped summary recorded');
        assert.deepEqual(out.taskKeyMap, { 'r:one': 'PROJ-9' }, 'key map by task key');
        assert.equal(out.created[0].depends_on.length, 1, 'deps kept for wiring');
        var failing = fakeTracker({ createError: true });
        var out2 = mod.createSubTasks(failing, tasks, 'PROJ', 'PROJ-50', 'PROJ-100', 'https://j', ['development'], []);
        assert.equal(out2.created.length, 2, 'error entries recorded');
        assert.equal(out2.created[0].error.indexOf('create failed') !== -1, true, 'error captured');
        assert.deepEqual(out2.taskKeyMap, {}, 'no key on failure');
    });

    test('wireDependencies links blockers, moves dependents once per dependent', function() {
        var mod = makeModule();
        var t = fakeTracker();
        mod.wireDependencies(
            t,
            [{ taskKey: 'r:two', key: 'PROJ-202', depends_on: ['r:one'] }],
            { 'r:one': 'PROJ-201' },
            'Blocks', 'Blocked'
        );
        assert.equal(t.calls.link.length, 1, 'one link for resolvable dep');
        assert.equal(t.calls.link[0].sourceKey, 'PROJ-201', 'blocker is the source');
        assert.equal(t.calls.link[0].anotherKey, 'PROJ-202', 'dependent is the target');
        assert.equal(t.calls.move.length, 1, 'one move');
        assert.equal(t.calls.move[0].statusName, 'Blocked', 'blocked status');
        var t2 = fakeTracker();
        mod.wireDependencies(t2, [{ taskKey: 'r:two', key: 'PROJ-202', depends_on: ['ghost'] }], {}, 'Blocks', 'Blocked');
        assert.equal(t2.calls.link.length, 0, 'missing blocker produces no link');
        var t3 = fakeTracker({ linkError: true });
        mod.wireDependencies(t3, [{ taskKey: 'r:two', key: 'PROJ-202', depends_on: ['r:one'] }], { 'r:one': 'PROJ-201' }, 'Blocks', 'Blocked');
        assert.equal(t3.calls.move.length, 0, 'no move when the only link fails');
        var t4 = fakeTracker({ moveError: true });
        mod.wireDependencies(t4, [{ taskKey: 'r:two', key: 'PROJ-202', depends_on: ['r:one'] }], { 'r:one': 'PROJ-201' }, 'Blocks', 'Blocked');
        assert.equal(t4.calls.link.length, 1, 'link attempted when move fails');
        assert.equal(t4.calls.move.length, 1, 'move attempted');
    });

    test('postSummaryComment posts and swallows failures', function() {
        var mod = makeModule();
        var t = fakeTracker();
        mod.postSummaryComment(t, 'PROJ-100', 'body');
        assert.equal(t.calls.comment.length, 1, 'comment posted');
        assert.equal(t.calls.comment[0].key, 'PROJ-100', 'to the SA ticket');
        var t2 = fakeTracker({});
        t2.postComment = function() { throw new Error('comment failed'); };
        mod.postSummaryComment(t2, 'PROJ-100', 'body');
    });
});

// ---------------------------------------------------------------------------
// action-phase helpers (gh-1197)
// ---------------------------------------------------------------------------

suite('createRepoTasksMulti — action-phase helpers', function() {

    function commentTracker() {
        var calls = { comment: [] };
        return {
            calls: calls,
            postComment: function(key, comment) { calls.comment.push({ key: key, comment: comment }); }
        };
    }

    test('extractSaKey reads the ticket key and reports a sentinel error without one', function() {
        var mod = makeModule();
        assert.deepEqual(mod.extractSaKey({ ticket: { key: 'PROJ-100' } }), { saKey: 'PROJ-100' }, 'key extracted');
        assert.deepEqual(mod.extractSaKey({ ticket: {} }), { error: 'No ticket key in params' }, 'missing key');
        assert.deepEqual(mod.extractSaKey({}), { error: 'No ticket key in params' }, 'missing ticket');
    });

    test('resolveTaskOptions defaults relationship/status/labels and honours customParams at both levels', function() {
        var mod = makeModule();
        var defaults = mod.resolveTaskOptions({});
        assert.deepEqual(
            [defaults.blocksRelationship, defaults.blockedStatus, defaults.ticketLabels],
            ['Blocks', 'Blocked', ['development']],
            'defaults'
        );
        var nested = mod.resolveTaskOptions({ jobParams: { customParams: { blocksRelationship: 'rel', blockedStatus: 'Hold', labels: ['y'] } } });
        assert.deepEqual(
            [nested.blocksRelationship, nested.blockedStatus, nested.ticketLabels],
            ['rel', 'Hold', ['y']],
            'jobParams-nested customParams are read'
        );
    });

    function ticketOf(ticket) {
        return { getIssue: function() { return ticket; } };
    }

    test('resolveSaTicketContext reads description and parent from fields (or the bare ticket)', function() {
        var mod = makeModule();
        var ctx = mod.resolveSaTicketContext(ticketOf({ fields: { description: 'desc text', parent: { key: 'PROJ-50' } } }), 'PROJ-100');
        assert.equal(ctx.description, 'desc text', 'description read from fields');
        assert.equal(ctx.parentKey, 'PROJ-50', 'parent key read from fields');

        var bare = mod.resolveSaTicketContext(ticketOf({ description: 42, parent: 'PLAIN-1' }), 'PROJ-100');
        assert.equal(bare.description, '42', 'non-string description is stringified');
        assert.equal(bare.parentKey, null, 'non-object parent yields null key');

        var none = mod.resolveSaTicketContext(ticketOf({ fields: { parent: null } }), 'PROJ-100');
        assert.equal(none.description, '', 'missing description yields empty string');
        assert.equal(none.parentKey, null, 'null parent yields null key');

        var objectParent = mod.resolveSaTicketContext(ticketOf({ fields: { parent: { key: 'K-9' } } }), 'PROJ-100');
        assert.equal(objectParent.parentKey, 'K-9', 'object parent yields key');

        var noKeyParent = mod.resolveSaTicketContext(ticketOf({ fields: { parent: {} } }), 'PROJ-100');
        assert.ok(!noKeyParent.parentKey, 'object parent without key yields no key (undefined)');
    });

    test('resolveParentSummary prefers the parent summary and falls back to the key', function() {
        var mod = makeModule();
        assert.equal(
            mod.resolveParentSummary({ getIssue: function() { return { fields: { summary: 'Story' } } } }, 'PROJ-50'),
            'Story', 'summary from fields'
        );
        assert.equal(
            mod.resolveParentSummary({ getIssue: function() { return { fields: {} } } }, 'PROJ-50'),
            'PROJ-50', 'missing summary falls back to the parent key'
        );
    });

    test('requireAffectedRepos separates the repos payload from the no-repos error', function() {
        var mod = makeModule();
        var ok = mod.requireAffectedRepos('prefix {code:json|title=affected_repos}\n[{"name":"a"}]\n{code}', 'PROJ-100');
        assert.deepEqual(ok.repos, [{ name: 'a' }], 'repos parsed');
        var bad = mod.requireAffectedRepos('no repos here', 'PROJ-100');
        assert.equal(bad.error, 'No affected repos found in PROJ-100 — ensure writeSolutionAndLabels ran first', 'error message preserved');
    });

    test('describeTaskPlan summarises the flattened task count across repo names', function() {
        var mod = makeModule();
        var repos = [{ name: 'core-db', tasks: [{ id: '1' }, { id: '2' }] }, 'plain-repo'];
        var tasks = mod.buildTaskPlan(repos);
        assert.equal(
            mod.describeTaskPlan(repos, tasks),
            'Flattened into 3 task(s) across core-db, plain-repo',
            'plan summary text'
        );
    });

    test('postOutcomeSummaryComment posts only when something was created or skipped', function() {
        var mod = makeModule();
        var t1 = commentTracker();
        mod.postOutcomeSummaryComment(t1, 'PROJ-100', 'https://jira.example.com', { created: [], skipped: [] });
        assert.equal(t1.calls.comment.length, 0, 'nothing done — no comment');

        var t2 = commentTracker();
        mod.postOutcomeSummaryComment(t2, 'PROJ-100', 'https://jira.example.com', {
            created: [{ repo: 'a', key: 'PROJ-201', summary: '[a] S' }],
            skipped: ['[b] S']
        });
        assert.equal(t2.calls.comment.length, 1, 'comment posted');
        assert.contains(t2.calls.comment[0].comment, '_Skipped (already exist): [b] S_');
    });
});

// ---------------------------------------------------------------------------
// flattenTasks edge paths (gh-1228 CRAP characterization)
// ---------------------------------------------------------------------------

suite('createRepoTasksMulti — flattenTasks edge paths', function() {

    test('string repo entries are normalised to name-only repos', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks(['repo-a', { name: 'repo-b', reason: 'R' }]);
        assert.equal(flat.length, 2, 'both entries flattened');
        assert.deepEqual(flat.map(function(t) { return t.repo; }), ['repo-a', 'repo-b'], 'repo names kept');
        assert.equal(flat[0].title, 'repo-a', 'string entry title falls back to the repo name');
        assert.equal(flat[0].reason, '', 'string entry has no reason');
    });

    test('repo with an EMPTY tasks array produces the implicit single task', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([{ name: 'repo-a', reason: 'Do it', tasks: [] }]);
        assert.equal(flat.length, 1, 'one implicit task');
        assert.equal(flat[0].key, 'repo-a:repo-a', 'implicit key shape');
        assert.equal(flat[0].title, 'Do it', 'repo reason used as title');
    });

    test('repo without a name is skipped entirely', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([{ reason: 'no name' }, { name: 'repo-a' }]);
        assert.equal(flat.length, 1, 'only the named repo produced a task');
        assert.equal(flat[0].repo, 'repo-a', 'named repo kept');
    });

    test('qualified reference to an unknown repo is dropped', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([{ name: 'repo-a', tasks: [{ id: 't1', title: 'T1', depends_on: ['ghost:task'] }] }]);
        assert.deepEqual(flat[0].depends_on, [], 'unknown-repo qualified ref dropped');
    });

    test('qualified reference to a known repo but unknown task id is dropped', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([
            { name: 'backend', tasks: [{ id: 't1', title: 'T1' }] },
            { name: 'repo-a', tasks: [{ id: 't2', title: 'T2', depends_on: ['backend:ghost'] }] }
        ]);
        assert.deepEqual(flat[1].depends_on, [], 'known repo, unknown task id dropped');
    });

    test('unknown bare repo-name reference is dropped', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([{ name: 'repo-a', tasks: [{ id: 't1', title: 'T1', depends_on: ['ghost-repo'] }] }]);
        assert.deepEqual(flat[0].depends_on, [], 'unknown bare ref dropped');
    });

    test('same-repo bare task id resolves to the qualified key', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([
            { name: 'repo-a', tasks: [
                { id: 't2', title: 'T2', depends_on: ['t1'] },
                { id: 't1', title: 'T1' }
            ] }
        ]);
        assert.deepEqual(flat[0].depends_on, ['repo-a:t1'], 'same-repo bare id qualified');
    });

    test('self-dependency is excluded from the resolved depends_on', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([{ name: 'repo-a', tasks: [{ id: 't1', title: 'T1', depends_on: ['repo-a:t1'] }] }]);
        assert.deepEqual(flat[0].depends_on, [], 'self-reference removed');
    });

    test('task-level and repo-level deps overlap is deduplicated', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([
            { name: 'backend', tasks: [{ id: 't1', title: 'T1' }, { id: 't2', title: 'T2' }] },
            { name: 'repo-a', depends_on: ['backend'], tasks: [{ id: 'x', title: 'X', depends_on: ['backend'] }] }
        ]);
        var repoATask = flat.filter(function(t) { return t.repo === 'repo-a'; })[0];
        assert.deepEqual(repoATask.depends_on.sort(), ['backend:t1', 'backend:t2'], 'union deduped to one entry per key');
    });

    test('repo-level deps on multi-task repos expand to every task (2+ repos, 2+ tasks)', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([
            { name: 'backend', tasks: [{ id: 'api', title: 'API' }, { id: 'db', title: 'DB' }] },
            { name: 'worker', tasks: [{ id: 'queue', title: 'Queue' }] },
            { name: 'frontend', depends_on: ['backend', 'worker'] }
        ]);
        var frontend = flat.filter(function(t) { return t.repo === 'frontend'; })[0];
        assert.deepEqual(frontend.depends_on.sort(), ['backend:api', 'backend:db', 'worker:queue'], 'every dependency task included');
        assert.equal(frontend.title, 'frontend', 'implicit task title');
    });

    test('task without depends_on gets an empty resolved array (never undefined)', function() {
        var mod = makeModule();
        var flat = mod.flattenTasks([{ name: 'repo-a', tasks: [{ id: 't1', title: 'T1' }] }]);
        assert.deepEqual(flat[0].depends_on, [], 'empty depends_on normalised');
        assert.equal(flat[0].reason, '', 'missing reason normalised');
        assert.equal(flat[0].title, 'T1', 'title falls back to id when title missing');
        assert.deepEqual(flat[0].rawDependsOn, [], 'rawDependsOn normalised');
        assert.deepEqual(flat[0].repoLevelDependsOn, [], 'repoLevelDependsOn normalised');
    });
});
