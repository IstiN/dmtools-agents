/**
 * Characterization tests for js/fetchEpicsToInput.js.
 *
 * Pin the fetch-and-write contract: search JQLs + requested fields, per-issue
 * re-fetch via getIssue, exact field mapping (incl. findField partial keys),
 * file_write payloads and the continue-on-error behaviour of each block.
 */

function loadFetchEpicsToInput(opts) {
    opts = opts || {};
    var calls = {
        created: [],
        search: [],
        getIssue: [],
        writes: []
    };

    var tracker = {
        searchIssues: function (jql, searchOpts) {
            calls.search.push({ jql: jql, opts: searchOpts });
            var spec = opts.searchResults ? opts.searchResults[jql] : null;
            if (spec && spec.throwOnSearch) throw new Error('search down: ' + jql);
            return (spec && spec.results) || [];
        },
        getIssue: function (key) {
            calls.getIssue.push(key);
            var behavior = opts.getIssue ? opts.getIssue[key] : null;
            if (behavior === 'throw') throw new Error('issue fetch down: ' + key);
            if (behavior) return behavior;
            return { key: key, fields: {} };
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
        'js/fetchEpicsToInput.js',
        makeRequire({ './common/trackers.js': trackersMock }),
        globalMocks
    );

    return { mod: mod, calls: calls };
}

var EPIC_JQL = 'project = PROJ AND issuetype = Epic ORDER BY created DESC';
var STORY_JQL = 'project = PROJ AND issuetype = Story ORDER BY created DESC';

suite('fetchEpicsToInput.action', function () {

    test('happy path: two epics and two stories fetched, mapped and written', function () {
        var loaded = loadFetchEpicsToInput({
            searchResults: (function () {
                var m = {};
                m[EPIC_JQL] = { results: [{ key: 'PROJ-10' }, { key: 'PROJ-11' }] };
                m[STORY_JQL] = { results: [{ key: 'PROJ-20' }, { key: 'PROJ-21' }] };
                return m;
            })(),
            getIssue: (function () {
                var m = {};
                m['PROJ-10'] = {
                    key: 'PROJ-10',
                    fields: {
                        summary: 'Epic one',
                        description: 'Desc one',
                        priority: { name: 'High' },
                        'Diagrams (customfield_10296)': 'diag-url-1',
                        parent: { key: 'PROJ-1' }
                    }
                };
                m['PROJ-11'] = {
                    key: 'PROJ-11',
                    fields: {
                        summary: 'Epic two',
                        Diagrams: 'fallback-diag'
                    }
                };
                m['PROJ-20'] = {
                    key: 'PROJ-20',
                    fields: {
                        summary: 'Story one',
                        status: { name: 'In Progress' },
                        priority: { name: 'Low' },
                        'Acceptance Criteria (customfield_1)': 'Given when then',
                        'Solution (customfield_2)': 'Do it',
                        parent: { key: 'PROJ-10' }
                    }
                };
                m['PROJ-21'] = {
                    key: 'PROJ-21',
                    fields: {
                        summary: 'Story two',
                        status: { name: 'Done' },
                        'Acceptance Criterias (customfield_3)': 'Alt AC key'
                    }
                };
                return m;
            })()
        });

        var result = loaded.mod.action({ inputFolderPath: 'input/PROJ-3' });

        assert.equal(result, undefined, 'action returns nothing on success');
        assert.deepEqual(loaded.calls.search, [
            { jql: EPIC_JQL, opts: { fields: ['key', 'summary', 'description', 'priority', 'parent'] } },
            { jql: STORY_JQL, opts: { fields: ['key', 'summary', 'status', 'priority', 'parent'] } }
        ]);
        assert.deepEqual(loaded.calls.getIssue, ['PROJ-10', 'PROJ-11', 'PROJ-20', 'PROJ-21']);
        assert.deepEqual(loaded.calls.created, [{ config: null, customParams: {} }]);

        assert.equal(loaded.calls.writes.length, 2);

        assert.equal(loaded.calls.writes[0].path, 'input/PROJ-3/existing_epics.json');
        var epicsDoc = JSON.parse(loaded.calls.writes[0].content);
        assert.ok(epicsDoc.epics.length === 2, 'both epics written');
        assert.deepEqual(epicsDoc.epics[0], {
            key: 'PROJ-10',
            summary: 'Epic one',
            description: 'Desc one',
            priority: 'High',
            diagrams: 'diag-url-1',
            parent: 'PROJ-1'
        });
        assert.deepEqual(epicsDoc.epics[1], {
            key: 'PROJ-11',
            summary: 'Epic two',
            description: '',
            priority: '',
            diagrams: 'fallback-diag',
            parent: null
        });

        assert.equal(loaded.calls.writes[1].path, 'input/PROJ-3/existing_stories.json');
        var storiesDoc = JSON.parse(loaded.calls.writes[1].content);
        assert.ok(storiesDoc.stories.length === 2, 'both stories written');
        assert.deepEqual(storiesDoc.stories[0], {
            key: 'PROJ-20',
            summary: 'Story one',
            description: '',
            status: 'In Progress',
            priority: 'Low',
            diagrams: null,
            acceptanceCriteria: 'Given when then',
            solution: 'Do it',
            parent: 'PROJ-10'
        });
        assert.deepEqual(storiesDoc.stories[1], {
            key: 'PROJ-21',
            summary: 'Story two',
            description: '',
            status: 'Done',
            priority: '',
            diagrams: null,
            acceptanceCriteria: 'Alt AC key',
            solution: null,
            parent: null
        });
    });

    test('customParams reach the tracker factory via jobParams or params', function () {
        var viaJobParams = loadFetchEpicsToInput({});
        viaJobParams.mod.action({ inputFolderPath: 'input/PROJ-3', jobParams: { customParams: { a: 1 } } });
        assert.deepEqual(viaJobParams.calls.created, [{ config: null, customParams: { a: 1 } }]);

        var viaParams = loadFetchEpicsToInput({});
        viaParams.mod.action({ inputFolderPath: 'input/PROJ-3', customParams: { b: 2 } });
        assert.deepEqual(viaParams.calls.created, [{ config: null, customParams: { b: 2 } }]);
    });

    test('epic search failure: no epics file, story block still runs', function () {
        var loaded = loadFetchEpicsToInput({
            searchResults: (function () {
                var m = {};
                m[EPIC_JQL] = { throwOnSearch: true };
                m[STORY_JQL] = { results: [{ key: 'PROJ-20' }] };
                return m;
            })()
        });

        loaded.mod.action({ inputFolderPath: 'input/PROJ-3' });

        assert.deepEqual(loaded.calls.writes.map(function (w) { return w.path; }), [
            'input/PROJ-3/existing_stories.json'
        ]);
    });

    test('story search failure: no stories file and no throw', function () {
        var loaded = loadFetchEpicsToInput({
            searchResults: (function () {
                var m = {};
                m[EPIC_JQL] = { results: [{ key: 'PROJ-10' }] };
                m[STORY_JQL] = { throwOnSearch: true };
                return m;
            })()
        });

        loaded.mod.action({ inputFolderPath: 'input/PROJ-3' });

        assert.deepEqual(loaded.calls.writes.map(function (w) { return w.path; }), [
            'input/PROJ-3/existing_epics.json'
        ]);
    });

    test('one broken epic fetch is skipped, the rest still land in the file', function () {
        var loaded = loadFetchEpicsToInput({
            searchResults: (function () {
                var m = {};
                m[EPIC_JQL] = { results: [{ key: 'PROJ-10' }, { key: 'PROJ-11' }, { key: 'PROJ-12' }] };
                return m;
            })(),
            getIssue: { 'PROJ-11': 'throw' }
        });

        loaded.mod.action({ inputFolderPath: 'input/PROJ-3' });

        var doc = JSON.parse(loaded.calls.writes[0].content);
        assert.deepEqual(doc.epics.map(function (e) { return e.key; }), ['PROJ-10', 'PROJ-12']);
    });

    test('one broken story fetch is skipped, the rest still land in the file', function () {
        var loaded = loadFetchEpicsToInput({
            searchResults: (function () {
                var m = {};
                m[STORY_JQL] = { results: [{ key: 'PROJ-20' }, { key: 'PROJ-21' }] };
                return m;
            })(),
            getIssue: { 'PROJ-20': 'throw' }
        });

        loaded.mod.action({ inputFolderPath: 'input/PROJ-3' });

        var doc = JSON.parse(loaded.calls.writes[0].content);
        assert.deepEqual(doc.stories.map(function (s) { return s.key; }), ['PROJ-21']);
    });

    test('missing input folder: empty project in the JQL, run still completes', function () {
        var loaded = loadFetchEpicsToInput({});

        loaded.mod.action({});

        assert.deepEqual(loaded.calls.search.map(function (s) { return s.jql; }), [
            'project =  AND issuetype = Epic ORDER BY created DESC',
            'project =  AND issuetype = Story ORDER BY created DESC'
        ]);
        assert.equal(loaded.calls.writes.length, 2, 'both files still written');
    });

    test('findField matches partial key names case-sensitively by substring', function () {
        var loaded = loadFetchEpicsToInput({});
        assert.equal(loaded.mod.findField({ 'Diagrams (customfield_10296)': 'd1' }, 'Diagrams'), 'd1');
        assert.equal(loaded.mod.findField({ diagrams: 'd2' }, 'Diagrams'), null, 'substring is case-sensitive');
        assert.equal(loaded.mod.findField({ a: 1 }, 'Diagrams'), null, 'absent field is null');
        assert.equal(loaded.mod.findField({ Diagrams: 0 }, 'Diagrams'), 0, 'falsy-but-present value is returned as-is');
    });

});
