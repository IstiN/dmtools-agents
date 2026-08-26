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
        makeRequire({}),
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
