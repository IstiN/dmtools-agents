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
        makeRequire({ './config.js': configModule, './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), defaultGlobals) }),
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
        assert.equal(result.error.indexOf('no ticket key') !== -1, true, 'error mentions ticket key');
    });

    test('outer catch returns failure when the tracker call throws', function() {
        var mod = makeHappyModule({
            jira_get_ticket: function() { throw new Error('tracker down'); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, false, 'fails when tracker throws');
        assert.equal(result.error.indexOf('createRepoTasksMulti failed') !== -1, true, 'error is wrapped');
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
        assert.equal(result.created, 1, 'one created reported');
    });

    test('an empty create result is not counted as created', function() {
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function() { return ''; }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(result.created, 0, 'nothing counted as created');
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

    test('linkIssues failure still allows the move to Blocked', function() {
        var moved = [];
        var mod = makeHappyModule({
            jira_link_issues: function() { throw new Error('link failed'); },
            jira_move_to_status: function(opts) { moved.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(moved.length, 1, 'dependent still moved to Blocked');
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
                if (opts.summary.indexOf('schema') !== -1) { return '{"key":"PROJ-301"}'; }
                throw new Error('boom');
            },
            jira_post_comment: function(opts) { comments.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(comments.length, 1, 'one comment posted');
        assert.equal(comments[0].ticketKey, 'PROJ-100', 'comment goes to the SA ticket');
        var lines = comments[0].comment.split('\n');
        assert.equal(lines[0], 'h3. Sub-tasks status', 'Jira wiki header');
        assert.equal(lines[2], '* [PROJ-301|https://jira.example.com/browse/PROJ-301] — Implement processor', 'ok line uses title');
        assert.equal(lines[3].indexOf('ERROR') !== -1, true, 'error line for failed task');
        assert.equal(lines[3].indexOf('processor') !== -1, true, 'error line names the failed task');
    });
});

// ---------------------------------------------------------------------------
// extracted helpers (gh-1004)
// ---------------------------------------------------------------------------

suite('createRepoTasksMulti — extracted helpers', function() {
    function fakeTracker(behavior) {
        var calls = { create: [], link: [], move: [], comment: [] };
        return {
            calls: calls,
            extractProject: function() { return 'PROJ'; },
            createTicketWithParent: function(opts) {
                calls.create.push(opts);
                if (behavior && behavior.createError) { throw new Error('create failed'); }
                return behavior && typeof behavior.createResult !== 'undefined' ? behavior.createResult : '{"key":"PROJ-9"}';
            },
            linkIssues: function(opts) {
                calls.link.push(opts);
                if (behavior && behavior.linkError) { throw new Error('link failed'); }
            },
            moveToStatus: function(opts) {
                calls.move.push(opts);
                if (behavior && behavior.moveError) { throw new Error('move failed'); }
            },
            postComment: function(opts) { calls.comment.push(opts); },
            searchIssues: function(opts) {
                calls.search = opts;
                if (behavior && behavior.searchError) { throw new Error('search failed'); }
                return behavior && typeof behavior.searchResult !== 'undefined' ? behavior.searchResult : [];
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
        var withReason = mod.buildTaskDescription('repo-a', 'Do it', 'because', 'PROJ-100', 'PROJ-50', 'https://jira.example.com');
        assert.equal(withReason.indexOf('(task: Do it)') !== -1, true, 'task title present');
        assert.equal(withReason.indexOf('reason: because') !== -1, true, 'reason present');
        assert.equal(withReason.indexOf('[PROJ-100|https://jira.example.com/browse/PROJ-100]') !== -1, true, 'SA link');
        var noReason = mod.buildTaskDescription('repo-a', 'Do it', null, 'PROJ-100', 'PROJ-50', 'https://j');
        assert.equal(noReason.indexOf('reason:') === -1, true, 'no reason clause when absent');
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
    });

    test('buildSummaryComment lists ok and error lines plus skips', function() {
        var mod = makeModule();
        var comment = mod.buildSummaryComment(
            [{ title: 'Processor', key: 'PROJ-302', summary: '[backend-service] Implement processor' }],
            1,
            'https://jira.example.com',
            [{ title: 'Schema', summary: '[backend-service] Add schema migration', error: 'boom' }]
        );
        var lines = comment.split('\n');
        assert.equal(lines[0], 'h3. Sub-tasks status', 'header');
        assert.equal(lines[2], '* [PROJ-302|https://jira.example.com/browse/PROJ-302] — Processor', 'ok line with title');
        assert.equal(lines[3].indexOf('ERROR') !== -1, true, 'error line');
        assert.equal(lines[3].indexOf('Add schema migration') !== -1, true, 'error line uses summary');
        assert.equal(lines[5], 'Skipped (already exists): 1', 'skipped section');
        var none = mod.buildSummaryComment([], 0, 'https://j', []);
        assert.equal(none.split('\n')[2], '* none', 'explicit none when nothing created');
    });

    test('loadExistingSummaries maps issue summaries and tolerates failures', function() {
        var mod = makeModule();
        var t = fakeTracker({ searchResult: [{ fields: { summary: '[a] S' } }] });
        assert.deepEqual(mod.loadExistingSummaries(t, 'PROJ-50'), ['[a] S'], 'summaries mapped');
        var failing = fakeTracker({ searchError: true });
        assert.deepEqual(mod.loadExistingSummaries(failing, 'PROJ-50'), [], 'search failure yields empty list');
        var garbage = fakeTracker({ searchResult: {} });
        assert.deepEqual(mod.loadExistingSummaries(garbage, 'PROJ-50'), [], 'non-array yields empty list');
    });

    test('createSubTasks creates one ticket per flat task, skipping exact duplicates', function() {
        var mod = makeModule();
        var t = fakeTracker();
        var tasks = [
            { key: 'r:one', repo: 'r', title: 'One', depends_on: [] },
            { key: 'r:two', repo: 'r', title: 'Two', depends_on: ['r:one'] }
        ];
        var out = mod.createSubTasks(t, tasks, 'PROJ-50', 'PROJ-100', 'https://jira.example.com', ['development'], ['[r] Two']);
        assert.equal(t.calls.create.length, 1, 'duplicate skipped');
        assert.equal(out.created.length, 1, 'one created entry');
        assert.equal(out.skipped, 1, 'one skipped');
        assert.deepEqual(out.keyMap, { 'r:one': 'PROJ-9' }, 'key map by task key');
        assert.equal(out.created[0].depends_on.length, 1, 'deps kept for wiring');
        var failing = fakeTracker({ createError: true });
        var out2 = mod.createSubTasks(failing, tasks, 'PROJ-50', 'PROJ-100', 'https://j', ['development'], []);
        assert.equal(out2.created.length, 0, 'create failure not counted');
    });

    test('wireDependencies links blockers and moves dependents, tolerating per-dep failures', function() {
        var mod = makeModule();
        var t = fakeTracker();
        mod.wireDependencies(
            t,
            [{ task: 'r:two', key: 'PROJ-202', depends_on: ['r:one'] }],
            { 'r:one': 'PROJ-201' },
            'Blocks', 'Blocked'
        );
        assert.equal(t.calls.link.length, 1, 'one link for resolvable dep');
        assert.equal(t.calls.link[0].sourceKey, 'PROJ-201', 'blocker is the source');
        assert.equal(t.calls.link[0].anotherKey, 'PROJ-202', 'dependent is the target');
        assert.equal(t.calls.move.length, 1, 'one move');
        var t2 = fakeTracker();
        mod.wireDependencies(t2, [{ task: 'r:two', key: 'PROJ-202', depends_on: ['ghost'] }], {}, 'Blocks', 'Blocked');
        assert.equal(t2.calls.link.length, 0, 'missing blocker produces no link');
        var t3 = fakeTracker({ linkError: true });
        mod.wireDependencies(t3, [{ task: 'r:two', key: 'PROJ-202', depends_on: ['r:one'] }], { 'r:one': 'PROJ-201' }, 'Blocks', 'Blocked');
        assert.equal(t3.calls.move.length, 1, 'move still attempted when link fails');
        var t4 = fakeTracker({ moveError: true });
        mod.wireDependencies(t4, [{ task: 'r:two', key: 'PROJ-202', depends_on: ['r:one'] }], { 'r:one': 'PROJ-201' }, 'Blocks', 'Blocked');
        assert.equal(t4.calls.link.length, 1, 'link attempted when move fails');
    });
});
