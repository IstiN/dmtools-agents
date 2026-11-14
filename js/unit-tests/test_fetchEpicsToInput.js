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
            return searchResultsFor(opts, jql);
        },
        getIssue: function (key) {
            calls.getIssue.push(key);
            return issueFor(opts, key);
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
        makeRequire({
            './common/epicIntakeFetch.js': loadEpicIntakeFetch(),
            './common/trackers.js': trackersMock,
            './configLoader.js': { loadProjectConfig: function () { return opts.projectConfig || null; } }
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

// Scripted getIssue outcome for one key: canned issue, a thrown error, or an
// empty default issue.
function issueFor(opts, key) {
    var behavior = (opts.getIssue || {})[key];
    if (behavior === 'throw') throw new Error('issue fetch down: ' + key);
    if (behavior) return behavior;
    return { key: key, fields: {} };
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

        var storiesWrite = loaded.calls.writes.filter(function (w) {
            return w.path === 'input/PROJ-3/existing_stories.json';
        })[0];
        var doc = JSON.parse(storiesWrite.content);
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

    test('unexpected error (no params object) is swallowed by the outer guard', function () {
        var loaded = loadFetchEpicsToInput({});

        loaded.mod.action(null);

        assert.deepEqual(loaded.calls.created, [], 'tracker never created');
        assert.deepEqual(loaded.calls.search, []);
        assert.deepEqual(loaded.calls.writes, []);
    });

    test('findField matches partial key names case-sensitively by substring', function () {
        var loaded = loadFetchEpicsToInput({});
        assert.equal(loaded.mod.findField({ 'Diagrams (customfield_10296)': 'd1' }, 'Diagrams'), 'd1');
        assert.equal(loaded.mod.findField({ diagrams: 'd2' }, 'Diagrams'), null, 'substring is case-sensitive');
        assert.equal(loaded.mod.findField({ a: 1 }, 'Diagrams'), null, 'absent field is null');
        assert.equal(loaded.mod.findField({ Diagrams: 0 }, 'Diagrams'), 0, 'falsy-but-present value is returned as-is');
    });

});

suite('epicIntakeFetch helper branches (via fetchEpicsToInput mapping)', function () {

    test('mapEpic keeps key order and applies the injected diagrams extractor', function () {
        var helper = loadEpicIntakeFetch();
        var mapped = helper.mapEpic({
            key: 'PROJ-10',
            fields: {
                summary: 'Epic one',
                description: 'Desc',
                priority: { name: 'High' },
                'Diagrams (customfield_10296)': 'diag-url',
                parent: { key: 'PROJ-1' }
            }
        }, function (fields) { return fields['Diagrams (customfield_10296)'] || fields.Diagrams || null; });
        assert.deepEqual(mapped, {
            key: 'PROJ-10',
            summary: 'Epic one',
            description: 'Desc',
            priority: 'High',
            diagrams: 'diag-url',
            parent: 'PROJ-1'
        });
        assert.deepEqual(Object.keys(mapped), ['key', 'summary', 'description', 'priority', 'diagrams', 'parent'],
            'JSON key order matches the established payload');
    });

    test('mapEpic defaults missing fields to empty string / null', function () {
        var helper = loadEpicIntakeFetch();
        var mapped = helper.mapEpic({ key: 'PROJ-11', fields: {} }, function () { return null; });
        assert.deepEqual(mapped, {
            key: 'PROJ-11',
            summary: '',
            description: '',
            priority: '',
            diagrams: null,
            parent: null
        });
    });

    test('mapStory adds optional extractors between diagrams and parent', function () {
        var helper = loadEpicIntakeFetch();
        var mapped = helper.mapStory({
            key: 'PROJ-20',
            fields: {
                summary: 'Story one',
                description: 'Desc',
                status: { name: 'In Progress' },
                priority: { name: 'Low' },
                parent: { key: 'PROJ-10' }
            }
        }, {
            descriptionOf: function (fields) { return fields.description || ''; },
            diagramsOf: function () { return null; },
            acceptanceCriteriaOf: function () { return 'AC text'; },
            solutionOf: function () { return 'Sol text'; }
        });
        assert.deepEqual(mapped, {
            key: 'PROJ-20',
            summary: 'Story one',
            description: 'Desc',
            status: 'In Progress',
            priority: 'Low',
            diagrams: null,
            acceptanceCriteria: 'AC text',
            solution: 'Sol text',
            parent: 'PROJ-10'
        });
        assert.deepEqual(Object.keys(mapped),
            ['key', 'summary', 'description', 'status', 'priority', 'diagrams', 'acceptanceCriteria', 'solution', 'parent'],
            'extras land between diagrams and parent');
    });

    test('mapStory without optional extractors omits those keys entirely', function () {
        var helper = loadEpicIntakeFetch();
        var mapped = helper.mapStory({ key: 'PROJ-21', fields: { diagrams: 'd' } }, {
            diagramsOf: function (fields) { return fields.diagrams || null; }
        });
        assert.deepEqual(mapped, {
            key: 'PROJ-21',
            summary: '',
            status: '',
            priority: '',
            diagrams: 'd',
            parent: null
        });
        assert.equal('description' in mapped, false, 'no description key without descriptionOf');
        assert.equal('acceptanceCriteria' in mapped, false, 'no acceptanceCriteria key');
        assert.equal('solution' in mapped, false, 'no solution key');
    });

    test('createTrackerFor: falsy loadProjectConfig result becomes null config', function () {
        var helper = loadEpicIntakeFetch();
        var created = [];
        var trackers = { createTracker: function (config, customParams) { created.push({ config: config, customParams: customParams }); return { t: 1 }; } };
        helper.createTrackerFor(trackers, { loadProjectConfig: function () { return undefined; } }, { customParams: { a: 1 } }, { customParams: { a: 1 } });
        assert.deepEqual(created, [{ config: null, customParams: { a: 1 } }]);
    });

    test('createTrackerFor: missing configLoader or loadProjectConfig yields null config', function () {
        var helper = loadEpicIntakeFetch();
        var created = [];
        var trackers = { createTracker: function (config, customParams) { created.push({ config: config, customParams: customParams }); return { t: 1 }; } };
        helper.createTrackerFor(trackers, null, {}, {});
        helper.createTrackerFor(trackers, {}, {}, {});
        assert.deepEqual(created, [{ config: null, customParams: {} }, { config: null, customParams: {} }]);
    });

    test('fetchAndWrite writes a 2+ item payload through the spec writeFile', function () {
        var helper = loadEpicIntakeFetch();
        var writes = [];
        var tracker = { searchIssues: function () { return [{ key: 'A-1' }, { key: 'A-2' }, { key: 'A-3' }] } };
        helper.fetchAndWrite(tracker, 'input/A-9', {
            jql: 'q',
            fields: ['key'],
            map: function (issue) { return { key: issue.key }; },
            listKey: 'epics',
            fileName: 'existing_epics.json',
            writeFile: function (folder, payload) { writes.push({ folder: folder, payload: payload }); },
            plural: 'epics',
            collect: function (t, spec) { return t.searchIssues(spec.jql, { fields: spec.fields }).map(spec.map); }
        });
        assert.equal(writes.length, 1);
        assert.equal(writes[0].folder, 'input/A-9');
        assert.deepEqual(JSON.parse(writes[0].payload).epics, [{ key: 'A-1' }, { key: 'A-2' }, { key: 'A-3' }]);
    });

    test('fetchAndWrite swallows a collect failure and writes nothing', function () {
        var helper = loadEpicIntakeFetch();
        var writes = [];
        var r = helper.fetchAndWrite({}, 'input/A-9', {
            listKey: 'epics',
            fileName: 'existing_epics.json',
            writeFile: function (folder, payload) { writes.push(payload); },
            plural: 'epics',
            collect: function () { throw new Error('search down'); }
        });
        assert.equal(r, false);
        assert.deepEqual(writes, [], 'no file written when the collect step fails');
    });

});

suite('epicIntakeFetch — ADO scoped WIQL, skipExistingFetch, and fetch failure handling (gh-1478, gh-1479)', function () {

    test('searchQueryFor builds Jira JQL by default and configured issueTypes', function () {
        var helper = loadEpicIntakeFetch();
        var jiraTracker = { provider: function () { return 'jira'; } };
        assert.equal(
            helper.searchQueryFor(jiraTracker, 'PROJ', 'epic', { EPIC: 'Initiative' }),
            'project = PROJ AND issuetype = Initiative ORDER BY created DESC'
        );
        assert.equal(
            helper.searchQueryFor(jiraTracker, 'PROJ', 'story', { STORY: 'Product Backlog Item' }),
            'project = PROJ AND issuetype = Product Backlog Item ORDER BY created DESC'
        );
        assert.equal(
            helper.searchQueryFor(null, 'PROJ', 'epic', null),
            'project = PROJ AND issuetype = Epic ORDER BY created DESC'
        );
    });

    test('searchQueryFor builds scoped ADO WIQL with area path, excluded states, and configured work item types', function () {
        var helper = loadEpicIntakeFetch();
        var adoTracker = { provider: function () { return 'ado'; } };
        var qEpics = helper.searchQueryFor(adoTracker, 'MyProj', 'epic', { EPIC: 'Feature' }, { areaPath: 'MyProj\\Team A' });
        assert.contains(qEpics, "[System.TeamProject] = 'MyProj'");
        assert.contains(qEpics, "[System.WorkItemType] = 'Feature'");
        assert.contains(qEpics, "[System.State] NOT IN ('Removed', 'Done')");
        assert.contains(qEpics, "[System.AreaPath] UNDER 'MyProj\\Team A'");
        assert.contains(qEpics, 'ORDER BY [System.CreatedDate] DESC');

        var qStories = helper.searchQueryFor(adoTracker, 'MyProj', 'story', null, {});
        assert.contains(qStories, "[System.WorkItemType] = 'Product Backlog Item'");
        assert.notContains(qStories, '[System.AreaPath] UNDER');
    });

    test('buildAdoChildrenWiql builds WorkItemLinks WIQL for source ID and escapes quotes', function () {
        var helper = loadEpicIntakeFetch();
        var q = helper.buildAdoChildrenWiql('1234', "O'Brien's Type");
        assert.contains(q, 'FROM WorkItemLinks');
        assert.contains(q, "[Source].[System.Id] = 1234");
        assert.contains(q, "[Target].[System.WorkItemType] = 'O''Brien''s Type'");
        assert.contains(q, 'MODE (MustContain)');
    });

    test('collectFromSearch on ADO merges source children and same-area items, deduplicates, and caps', function () {
        var helper = loadEpicIntakeFetch();
        var queries = [];
        var tracker = {
            provider: function () { return 'ado'; },
            searchIssues: function (q) {
                queries.push(q);
                if (q.indexOf('WorkItemLinks') !== -1) {
                    return [
                        { key: '10', fields: { summary: 'Child 10' } },
                        { key: '11', fields: { summary: 'Child 11' } }
                    ];
                }
                return [
                    { key: '11', fields: { summary: 'Duplicate 11' } },
                    { key: '12', fields: { summary: 'Area 12' } },
                    { key: '13', fields: { summary: 'Area 13' } }
                ];
            }
        };
        var items = helper.collectFromSearch(tracker, {
            jql: helper.searchQueryFor(tracker, 'MyProj', 'epic', { EPIC: 'Feature' }, { areaPath: 'MyProj\\Area' }),
            kind: 'epic',
            issueTypes: { EPIC: 'Feature' },
            scope: { ticketKey: '99', project: 'MyProj', areaPath: 'MyProj\\Area', cap: 3 },
            fields: ['key', 'summary'],
            map: function (i) { return { key: i.key, summary: i.fields.summary }; }
        });
        assert.equal(queries.length, 2);
        assert.deepEqual(items, [
            { key: '10', summary: 'Child 10' },
            { key: '11', summary: 'Child 11' },
            { key: '12', summary: 'Area 12' }
        ]);
    });

    test('resolveAdoScope extracts areaPath from ticket fields or fetches source issue on ADO', function () {
        var helper = loadEpicIntakeFetch();
        var adoTracker = { provider: function () { return 'ado'; } };
        var s1 = helper.resolveAdoScope(adoTracker, '100', { fields: { 'System.AreaPath': 'P\\A1' } }, { tracker: { adoProject: 'P' } });
        assert.deepEqual(s1, { ticketKey: '100', project: 'P', areaPath: 'P\\A1', cap: 100 });

        var s2 = helper.resolveAdoScope({
            provider: function () { return 'ado'; },
            getIssue: function (k) { return { key: k, fields: { areaPath: 'P\\A2' } }; }
        }, '200', null, {});
        assert.deepEqual(s2, { ticketKey: '200', project: '', areaPath: 'P\\A2', cap: 100 });

        var s3 = helper.resolveAdoScope({
            provider: function () { return 'ado'; },
            getIssue: function () { throw new Error('404'); }
        }, '300', null, {});
        assert.deepEqual(s3, { ticketKey: '300', project: '', areaPath: '', cap: 100 });
    });

    test('isSkipExistingFetch honours customParams and projectConfig flags', function () {
        var helper = loadEpicIntakeFetch();
        assert.equal(helper.isSkipExistingFetch({ skipExistingFetch: true }, {}), true);
        assert.equal(helper.isSkipExistingFetch({ fetchExisting: false }, {}), true);
        assert.equal(helper.isSkipExistingFetch({}, { jira: { skipExistingFetch: true } }), true);
        assert.equal(helper.isSkipExistingFetch({}, { tracker: { skipExistingFetch: true } }), true);
        assert.equal(helper.isSkipExistingFetch({}, {}), false);
    });

    test('skipExistingFetch writes empty existing_epics.json and existing_stories.json without searching', function () {
        var loaded = loadFetchEpicsToInput({});
        var r = loaded.mod.action({
            inputFolderPath: 'input/PROJ-9',
            jobParams: { customParams: { skipExistingFetch: true } }
        });
        assert.equal(r, undefined);
        assert.deepEqual(loaded.calls.search, []);
        assert.equal(loaded.calls.writes.length, 2);
        assert.deepEqual(JSON.parse(loaded.calls.writes[0].content), { epics: [] });
        assert.deepEqual(JSON.parse(loaded.calls.writes[1].content), { stories: [] });
    });

    test('fetchEpicsToInput returns false and posts comment when search fails (gh-1479)', function () {
        var loaded = loadFetchEpicsToInput({
            searchResults: (function () {
                var m = {};
                m[EPIC_JQL] = { throwOnSearch: true };
                return m;
            })()
        });
        var r = loaded.mod.action({ inputFolderPath: 'input/PROJ-3' });
        assert.equal(r, false);
        assert.equal(loaded.calls.writes.length, 1, 'only stories file written');
    });

    test('postFetchFailureComment posts comment when tracker.postComment is available', function () {
        var helper = loadEpicIntakeFetch();
        var posted = [];
        helper.postFetchFailureComment({
            postComment: function (k, b) { posted.push({ key: k, body: b }); }
        }, 'PROJ-7', 'existing_epics.json');
        assert.equal(posted.length, 1);
        assert.equal(posted[0].key, 'PROJ-7');
        assert.contains(posted[0].body, 'existing_epics.json');
        helper.postFetchFailureComment({}, '', 'x');
        assert.equal(posted.length, 1);
    });

});
