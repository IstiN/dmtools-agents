/**
 * Unit tests for js/createBugFixBatchEpic.js
 */

function loadCreateBugFixBatchEpic(mocks) {
    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_remove_label: function() {},
        jira_add_label: function() {},
        jira_link_issues: function() {},
        jira_search_by_jql: function() { return []; },
        jira_create_ticket_with_json: function() { return ''; },
        file_read: function() { return null; }
    };

    var allMocks = Object.assign({}, defaults, mocks);
    return loadModule(
        'js/createBugFixBatchEpic.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/jiraHelpers.js': loadModule('js/common/jiraHelpers.js', makeRequire({
                '../config.js': configModule,
                './trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), allMocks)
            }), allMocks),
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), allMocks)
        }),
        allMocks
    );
}

function makeJqlDispatch(routes) {
    return function(args) {
        for (var i = 0; i < routes.length; i++) {
            var route = routes[i];
            var matches = route.contains.every(function(fragment) {
                return args.jql.indexOf(fragment) !== -1;
            });
            if (matches) return route.result;
        }
        return [];
    };
}

var CANDIDATES = [
    { key: 'BUG-1', fields: { summary: 'Bug one' } },
    { key: 'BUG-2', fields: { summary: 'Bug two' } }
];

function defaultSearchRoutes(overrides) {
    var routes = [
        { contains: ['issuetype = Bug'], result: CANDIDATES },
        { contains: ['Test Case', 'BUG-1'], result: [{ key: 'TC-7' }] },
        { contains: ['Test Case', 'BUG-2'], result: [] }
    ];
    return makeJqlDispatch((overrides || []).concat(routes).concat([
        { contains: ['issuetype = Epic'], result: [] }
    ]));
}

suite('createBugFixBatchEpic', function() {

    test('creates a batch Epic for relevant bugs, labels them and releases the SM lock', function() {
        var created = [];
        var links = [];
        var labels = [];
        var moves = [];
        var comments = [];
        var removed = [];

        var module = loadCreateBugFixBatchEpic({
            jira_search_by_jql: defaultSearchRoutes(),
            jira_create_ticket_with_json: function(args) {
                created.push(args);
                return '{"key":"EPIC-9","id":"1"}';
            },
            jira_link_issues: function(args) { links.push(args); },
            jira_add_label: function(args) { labels.push(args); },
            jira_move_to_status: function(args) { moves.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removed.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-50' },
            jobParams: { customParams: { removeLabel: 'sm_trigger', batchSize: 5 } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'batch_created');
        assert.equal(result.storyKey, 'TS-50');
        assert.equal(result.epicKey, 'EPIC-9');
        assert.deepEqual(result.batchedBugs, ['BUG-1']);
        assert.equal(created.length, 1);
        assert.equal(created[0].project, 'TS');
        assert.contains(created[0].fieldsJson.summary, 'Bug-fix batch for TS-50');
        assert.contains(created[0].fieldsJson.description, 'BUG-1 — Bug one');
        assert.deepEqual(links, [
            { sourceKey: 'EPIC-9', anotherKey: 'TS-50', relationship: 'Relates' },
            { sourceKey: 'EPIC-9', anotherKey: 'BUG-1', relationship: 'Relates' }
        ]);
        assert.deepEqual(labels, [
            { key: 'BUG-1', label: 'bug_fix_batch' }
        ]);
        assert.deepEqual(moves, [
            { key: 'EPIC-9', statusName: 'Ready For Development' }
        ]);
        assert.deepEqual(removed, [
            { key: 'TS-50', label: 'sm_trigger' }
        ]);
        assert.equal(comments.length, 2);
        assert.contains(comments[0].comment, 'New Bug-fix Batch Created');
        assert.contains(comments[1].comment, 'The Epic has been moved to *Ready For Development*');
    });

    test('adds relevant bugs to an existing open batch Epic instead of creating one', function() {
        var created = [];
        var links = [];
        var labels = [];
        var moves = [];

        var module = loadCreateBugFixBatchEpic({
            jira_search_by_jql: defaultSearchRoutes([
                { contains: ['issuetype = Epic'], result: [{ key: 'EPIC-1', fields: { summary: 'Old batch' } }] }
            ]),
            jira_create_ticket_with_json: function(args) { created.push(args); return '{"key":"EPIC-NEW"}'; },
            jira_link_issues: function(args) { links.push(args); },
            jira_add_label: function(args) { labels.push(args); },
            jira_move_to_status: function(args) { moves.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-51' },
            jobParams: { customParams: { removeLabel: 'sm_trigger' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'batch_updated');
        assert.equal(result.epicKey, 'EPIC-1');
        assert.equal(created.length, 0);
        assert.deepEqual(links, [
            { sourceKey: 'EPIC-1', anotherKey: 'BUG-1', relationship: 'Relates' }
        ]);
        assert.deepEqual(labels, [
            { key: 'BUG-1', label: 'bug_fix_batch' }
        ]);
        assert.deepEqual(moves, [
            { key: 'EPIC-1', statusName: 'Ready For Development' }
        ]);
    });

    test('limits the batch to batchSize relevant bugs', function() {
        var searchRoutes = makeJqlDispatch([
            { contains: ['issuetype = Bug'], result: CANDIDATES },
            { contains: ['Test Case'], result: [{ key: 'TC-7' }] },
            { contains: ['issuetype = Epic'], result: [] }
        ]);
        var labels = [];

        var module = loadCreateBugFixBatchEpic({
            jira_search_by_jql: searchRoutes,
            jira_create_ticket_with_json: function() { return '{"key":"EPIC-10"}'; },
            jira_add_label: function(args) { labels.push(args); },
            jira_link_issues: function() {},
            jira_move_to_status: function() {},
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-52' },
            jobParams: { customParams: { removeLabel: 'sm_trigger', batchSize: 1 } }
        });

        assert.equal(result.success, true);
        assert.deepEqual(result.batchedBugs, ['BUG-1']);
        assert.equal(labels.length, 1);
    });

    test('returns no_candidates and releases the lock when there is nothing to batch', function() {
        var created = [];
        var removed = [];

        var module = loadCreateBugFixBatchEpic({
            jira_search_by_jql: makeJqlDispatch([
                { contains: ['issuetype = Bug'], result: [] }
            ]),
            jira_create_ticket_with_json: function(args) { created.push(args); return '{"key":"EPIC-11"}'; },
            jira_remove_label: function(args) { removed.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-53' },
            jobParams: { customParams: { removeLabel: 'sm_trigger' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'no_candidates');
        assert.equal(created.length, 0);
        assert.deepEqual(removed, [
            { key: 'TS-53', label: 'sm_trigger' }
        ]);
    });

    test('returns no_relevant_bugs when candidates have no failing linked Test Case', function() {
        var created = [];
        var removed = [];

        var module = loadCreateBugFixBatchEpic({
            jira_search_by_jql: makeJqlDispatch([
                { contains: ['issuetype = Bug'], result: CANDIDATES },
                { contains: ['Test Case'], result: [] }
            ]),
            jira_create_ticket_with_json: function(args) { created.push(args); return '{"key":"EPIC-12"}'; },
            jira_remove_label: function(args) { removed.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-54' },
            jobParams: { customParams: { removeLabel: 'sm_trigger' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'no_relevant_bugs');
        assert.equal(created.length, 0);
        assert.deepEqual(removed, [
            { key: 'TS-54', label: 'sm_trigger' }
        ]);
    });

    test('reports failure when ticket key is missing and still releases the lock', function() {
        var removed = [];

        var module = loadCreateBugFixBatchEpic({
            jira_remove_label: function(args) { removed.push(args); }
        });

        var result = module.action({
            ticket: {},
            jobParams: { customParams: { removeLabel: 'sm_trigger' } }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'params.ticket.key is missing');
        assert.deepEqual(removed, []);
    });

});
