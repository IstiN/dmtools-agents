/**
 * Characterization tests for js/intakePreAction.js.
 *
 * Pin the intake contract: WIP-label skip (comment + abort), tracker queries
 * straight off the search results (no per-issue getIssue), file payloads and
 * the never-blocks-on-error behaviour.
 */

function loadIntakePreAction(opts) {
    opts = opts || {};
    var calls = {
        created: [],
        search: [],
        comments: [],
        writes: []
    };

    var tracker = {
        searchIssues: function (jql, searchOpts) {
            calls.search.push({ jql: jql, opts: searchOpts });
            return searchResultsFor(opts, jql);
        },
        postComment: function (key, body) {
            calls.comments.push({ key: key, body: body });
            if (opts.commentThrows) throw new Error('comment down');
            return null;
        }
    };

    var trackersMock = {
        createTracker: function (config, customParams) {
            calls.created.push({ config: config, customParams: customParams });
            return tracker;
        }
    };

    var globalMocks = {
        file_write: function (path, content) {
            calls.writes.push({ path: path, content: content });
            if (opts.writeThrows) throw new Error('disk full');
            return null;
        }
    };

    var mod = loadModule(
        'js/intakePreAction.js',
        makeRequire({
            './common/epicIntakeFetch.js': loadEpicIntakeFetch(),
            './common/trackers.js': trackersMock
        }),
        globalMocks
    );

    return { mod: mod, calls: calls };
}

// The real shared helper (it has no requires of its own).
function loadEpicIntakeFetch() {
    return loadModule('js/common/epicIntakeFetch.js', makeRequire({}));
}

// Scripted searchIssues outcome for one JQL: results list, or a thrown error.
function searchResultsFor(opts, jql) {
    var spec = (opts.searchResults || {})[jql];
    if (spec && spec.throwOnSearch) throw new Error('search down: ' + jql);
    return (spec && spec.results) || [];
}

var EPIC_JQL = 'project = PROJ AND issuetype = Epic ORDER BY created DESC';
var STORY_JQL = 'project = PROJ AND issuetype = Story ORDER BY created DESC';

function intakeParams(overrides) {
    return Object.assign({
        ticket: { key: 'PROJ-5', fields: { labels: ['other'] } },
        metadata: { contextId: 'story_development' }
    }, overrides || {});
}

suite('intakePreAction.action', function () {

    test('happy path: epics and stories fetched from raw search results and written', function () {
        var loaded = loadIntakePreAction({
            searchResults: (function () {
                var m = {};
                m[EPIC_JQL] = {
                    results: [
                        {
                            key: 'PROJ-10',
                            fields: {
                                summary: 'Epic one',
                                description: 'Desc',
                                priority: { name: 'High' },
                                diagrams: 'diag-1',
                                parent: { key: 'PROJ-1' }
                            }
                        },
                        { key: 'PROJ-11', fields: { summary: 'Epic two' } }
                    ]
                };
                m[STORY_JQL] = {
                    results: [
                        {
                            key: 'PROJ-20',
                            fields: {
                                summary: 'Story one',
                                status: { name: 'To Do' },
                                priority: { name: 'Low' },
                                diagrams: 'diag-2',
                                parent: { key: 'PROJ-10' }
                            }
                        }
                    ]
                };
                return m;
            })()
        });

        var result = loaded.mod.action(intakeParams());

        assert.equal(result, true, 'processing continues after the pre-action');
        assert.deepEqual(loaded.calls.search, [
            {
                jql: EPIC_JQL,
                opts: { fields: ['key', 'summary', 'description', 'priority', 'diagrams', 'parent'] }
            },
            {
                jql: STORY_JQL,
                opts: { fields: ['key', 'summary', 'status', 'priority', 'diagrams', 'parent'] }
            }
        ]);
        assert.deepEqual(loaded.calls.comments, [], 'no comments on the happy path');

        assert.equal(loaded.calls.writes.length, 2);

        assert.equal(loaded.calls.writes[0].path, 'input/PROJ-5/existing_epics.json');
        var epicsDoc = JSON.parse(loaded.calls.writes[0].content);
        assert.deepEqual(epicsDoc.epics, [
            {
                key: 'PROJ-10',
                summary: 'Epic one',
                description: 'Desc',
                priority: 'High',
                diagrams: 'diag-1',
                parent: 'PROJ-1'
            },
            {
                key: 'PROJ-11',
                summary: 'Epic two',
                description: '',
                priority: '',
                diagrams: null,
                parent: null
            }
        ]);

        assert.equal(loaded.calls.writes[1].path, 'input/PROJ-5/existing_stories.json');
        var storiesDoc = JSON.parse(loaded.calls.writes[1].content);
        assert.deepEqual(storiesDoc.stories, [
            {
                key: 'PROJ-20',
                summary: 'Story one',
                status: 'To Do',
                priority: 'Low',
                diagrams: 'diag-2',
                parent: 'PROJ-10'
            }
        ]);
    });

    test('WIP label aborts: skip comment posted, nothing fetched or written', function () {
        var loaded = loadIntakePreAction({});

        var result = loaded.mod.action(intakeParams({
            ticket: { key: 'PROJ-5', fields: { labels: ['story_development_wip'] } }
        }));

        assert.equal(result, false, 'WIP label stops processing');
        assert.equal(loaded.calls.comments.length, 1);
        assert.equal(loaded.calls.comments[0].key, 'PROJ-5');
        assert.ok(loaded.calls.comments[0].body.indexOf('story_development_wip') !== -1,
            'comment names the WIP label');
        assert.ok(loaded.calls.comments[0].body.indexOf('Processing Skipped') !== -1);
        assert.deepEqual(loaded.calls.search, [], 'no fetches after the WIP abort');
        assert.deepEqual(loaded.calls.writes, [], 'no writes after the WIP abort');
    });

    test('skip-comment failure still aborts the run', function () {
        var loaded = loadIntakePreAction({ commentThrows: true });

        var result = loaded.mod.action(intakeParams({
            ticket: { key: 'PROJ-5', fields: { labels: ['story_development_wip'] } }
        }));

        assert.equal(result, false);
        assert.deepEqual(loaded.calls.search, []);
    });

    test('WIP check is skipped when metadata has no contextId', function () {
        var loaded = loadIntakePreAction({});

        var result = loaded.mod.action(intakeParams({
            ticket: { key: 'PROJ-5', fields: { labels: ['story_development_wip'] } },
            metadata: {}
        }));

        assert.equal(result, true, 'no contextId — no WIP abort');
        assert.deepEqual(loaded.calls.comments, []);
        assert.equal(loaded.calls.writes.length, 2);
    });

    test('WIP check is skipped when metadata is missing entirely', function () {
        var loaded = loadIntakePreAction({});

        var result = loaded.mod.action({ ticket: { key: 'PROJ-5', fields: { labels: ['story_development_wip'] } } });

        assert.equal(result, true);
        assert.deepEqual(loaded.calls.comments, []);
        assert.equal(loaded.calls.writes.length, 2);
    });

    test('tickets without a labels field are processed normally', function () {
        var loaded = loadIntakePreAction({});

        var result = loaded.mod.action({
            ticket: { key: 'PROJ-5' },
            metadata: { contextId: 'story_development' }
        });

        assert.equal(result, true);
        assert.deepEqual(loaded.calls.comments, []);
        assert.equal(loaded.calls.writes.length, 2);
    });

    test('epic search failure: no epics file, story block still runs', function () {
        var loaded = loadIntakePreAction({
            searchResults: (function () {
                var m = {};
                m[EPIC_JQL] = { throwOnSearch: true };
                m[STORY_JQL] = { results: [{ key: 'PROJ-20', fields: { summary: 'S' } }] };
                return m;
            })()
        });

        var result = loaded.mod.action(intakeParams());

        assert.equal(result, true);
        assert.deepEqual(loaded.calls.writes.map(function (w) { return w.path; }), [
            'input/PROJ-5/existing_stories.json'
        ]);
    });

    test('story search failure: no stories file and still true', function () {
        var loaded = loadIntakePreAction({
            searchResults: (function () {
                var m = {};
                m[EPIC_JQL] = { results: [{ key: 'PROJ-10', fields: { summary: 'E' } }] };
                m[STORY_JQL] = { throwOnSearch: true };
                return m;
            })()
        });

        var result = loaded.mod.action(intakeParams());

        assert.equal(result, true);
        assert.deepEqual(loaded.calls.writes.map(function (w) { return w.path; }), [
            'input/PROJ-5/existing_epics.json'
        ]);
    });

    test('file_write failure inside a block does not abort the run', function () {
        var loaded = loadIntakePreAction({ writeThrows: true });

        var result = loaded.mod.action(intakeParams());

        assert.equal(result, true, 'unexpected errors never block intake');
        assert.deepEqual(loaded.calls.search.length, 2, 'both searches still attempted');
    });

    test('unexpected error (no ticket) is swallowed and never blocks', function () {
        var loaded = loadIntakePreAction({});

        var result = loaded.mod.action({});

        assert.equal(result, true);
        assert.deepEqual(loaded.calls.search, []);
        assert.deepEqual(loaded.calls.writes, []);
    });

    test('customParams reach the tracker factory via jobParams or params', function () {
        var viaJobParams = loadIntakePreAction({});
        viaJobParams.mod.action(intakeParams({ jobParams: { customParams: { a: 1 } } }));
        assert.deepEqual(viaJobParams.calls.created, [{ config: null, customParams: { a: 1 } }]);

        var viaParams = loadIntakePreAction({});
        viaParams.mod.action({
            ticket: { key: 'PROJ-5', fields: { labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: { b: 2 }
        });
        assert.deepEqual(viaParams.calls.created, [{ config: null, customParams: { b: 2 } }]);
    });

});
