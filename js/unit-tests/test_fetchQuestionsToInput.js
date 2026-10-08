/**
 * Unit tests for fetchQuestionsToInput.js answer field extraction.
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

function loadFetchQuestionsToInput() {
    return loadModule(
        'js/fetchQuestionsToInput.js',
        makeRequire({
            './configLoader.js': {
                loadProjectConfig: function() {
                    return {
                        jira: {
                            questions: {
                                fetchJql: 'parent = {ticketKey}',
                                answerField: 'Answer'
                            }
                        }
                    };
                }
            },
            './common/trackers.js': loadModule(
                'js/common/trackers.js',
                makeRequire({
                    '../config.js': configModule,
                    './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
                }),
                {}
            )
        }),
        {}
    );
}

suite('fetchQuestionsToInput.getAnswerValue', function() {

    test('reads direct custom field id key', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(
            mod.getAnswerValue({ customfield_10330: 'Direct answer' }, 'customfield_10330'),
            'Direct answer'
        );
    });

    test('reads transformed Jira key for a friendly field name', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(
            mod.getAnswerValue({ 'Answer (customfield_10330)': 'Mapped answer' }, 'Answer'),
            'Mapped answer'
        );
    });

    test('uses the same null and undefined rule for exact and transformed keys', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(mod.getAnswerValue({ Answer: null }, 'Answer'), null);
        assert.equal(mod.getAnswerValue({ Answer: undefined }, 'Answer'), null);
        assert.equal(mod.getAnswerValue({ 'Answer (customfield_10330)': null }, 'Answer'), null);
        assert.equal(mod.getAnswerValue({ 'Answer (customfield_10330)': undefined }, 'Answer'), null);
    });

    test('preserves falsy but present answer values consistently', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(mod.getAnswerValue({ Answer: '' }, 'Answer'), '');
        assert.equal(mod.getAnswerValue({ 'Answer (customfield_10330)': '' }, 'Answer'), '');
        assert.equal(mod.getAnswerValue({ Answer: 0 }, 'Answer'), 0);
        assert.equal(mod.getAnswerValue({ 'Answer (customfield_10330)': false }, 'Answer'), false);
    });

    test('returns null when answer field is absent', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(mod.getAnswerValue({ summary: 'Question' }, 'Answer'), null);
    });

});

// ── gh-770: tracker-aware query layer ────────────────────────────────────────
// The questions query is Jira-speak ("parent = X AND issuetype = Subtask");
// fired against a GitHub-tracker deployment it routes but silently returns
// empty ("Failed to fetch questions, continuing without file"). The provider
// must be probed first and the JQL only fired where it has meaning.

var QUESTIONS_JQL = 'parent = {ticketKey} AND issuetype = Subtask ORDER BY created ASC';

function loadFetchQuestionsWithMocks(options) {
    options = options || {};
    var parentCalls = [];
    var parentContextMock = {
        action: function (p) { parentCalls.push(p); }
    };
    var projectConfig = {
        jira: {
            questions: {
                fetchJql: QUESTIONS_JQL,
                answerField: 'Answer'
            }
        }
    };
    if (options.trackerProvider) {
        projectConfig.tracker = { provider: options.trackerProvider };
    }
    var trackersModule = loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        options.globals || {}
    );
    var mod = loadModule(
        'js/fetchQuestionsToInput.js',
        makeRequire({
            './configLoader.js': {
                loadProjectConfig: function () { return projectConfig; }
            },
            './common/trackers.js': trackersModule,
            './fetchParentContextToInput.js': parentContextMock
        }),
        options.globals || {}
    );
    return { mod: mod, parentCalls: parentCalls };
}

suite('fetchQuestionsToInput.questionsFetchPlan', function() {

    test('jira provider: search with the configured JQL and the ticket key interpolated', function() {
        var mod = loadFetchQuestionsWithMocks({}).mod;
        var plan = mod.questionsFetchPlan('jira', { fetchJql: QUESTIONS_JQL }, 'PROJ-7');
        assert.equal(plan.skip, false);
        assert.equal(plan.jql, 'parent = PROJ-7 AND issuetype = Subtask ORDER BY created ASC');
    });

    test('github provider: skip — the JQL is Jira-speak and silently returns nothing there', function() {
        var mod = loadFetchQuestionsWithMocks({}).mod;
        var plan = mod.questionsFetchPlan('github', { fetchJql: QUESTIONS_JQL }, 'gh-1308');
        assert.equal(plan.skip, true);
        assert.ok(plan.reason.indexOf('github') !== -1, 'reason names the provider');
        assert.ok(plan.reason.indexOf('parent = {ticketKey}') !== -1, 'reason names the skipped query');
    });

    test('ado provider: skip for the same reason', function() {
        var mod = loadFetchQuestionsWithMocks({}).mod;
        var plan = mod.questionsFetchPlan('ado', { fetchJql: QUESTIONS_JQL }, '42');
        assert.equal(plan.skip, true);
        assert.ok(plan.reason.indexOf('ado') !== -1);
    });

});

suite('fetchQuestionsToInput.action — tracker-aware query layer (gh-770)', function() {

    test('github tracker: never fires jira_search_by_jql and still fetches parent context', function() {
        var searchCalls = [];
        var writes = [];
        var loaded = loadFetchQuestionsWithMocks({
            trackerProvider: 'github',
            globals: {
                jira_search_by_jql: function (args) { searchCalls.push(args); return []; },
                file_write: function (path, content) { writes.push({ path: path, content: content }); return null; }
            }
        });
        loaded.mod.action({ inputFolderPath: 'input/gh-1308', jobParams: {} });
        assert.equal(searchCalls.length, 0, 'the Jira-speak JQL must not be fired on the github tracker');
        assert.equal(writes.length, 0, 'no existing_questions.json without a meaningful query');
        assert.equal(loaded.parentCalls.length, 1, 'parent-context enrichment still runs');
    });

    test('jira tracker: searches once with the interpolated JQL and writes every question found', function() {
        var searchCalls = [];
        var writes = [];
        var loaded = loadFetchQuestionsWithMocks({
            globals: {
                jira_search_by_jql: function (args) {
                    searchCalls.push(args);
                    return [
                        {
                            key: 'PROJ-11',
                            fields: {
                                summary: 'Q: how?', description: 'd1',
                                status: { name: 'Open' }, priority: { name: 'High' },
                                'Answer': 'answer one'
                            }
                        },
                        {
                            key: 'PROJ-12',
                            fields: {
                                summary: 'Q: why?', description: 'd2',
                                status: { name: 'Open' }, priority: { name: 'Low' }
                            }
                        }
                    ];
                },
                file_write: function (path, content) { writes.push({ path: path, content: content }); return null; }
            }
        });
        loaded.mod.action({ inputFolderPath: 'input/PROJ-10', jobParams: {} });
        assert.equal(searchCalls.length, 1);
        assert.equal(searchCalls[0].jql, 'parent = PROJ-10 AND issuetype = Subtask ORDER BY created ASC');
        assert.equal(writes.length, 1);
        assert.equal(writes[0].path, 'input/PROJ-10/existing_questions.json');
        var payload = JSON.parse(writes[0].content);
        assert.equal(payload.questions.length, 2, 'multi-question case: every row lands in the file');
        assert.equal(payload.questions[0].key, 'PROJ-11');
        assert.equal(payload.questions[0].answer, 'answer one');
        assert.equal(payload.questions[1].answer, null);
        assert.equal(loaded.parentCalls.length, 1);
    });

    test('jira tracker: a failing search stays non-fatal (no file, parent context still runs)', function() {
        var writes = [];
        var loaded = loadFetchQuestionsWithMocks({
            globals: {
                jira_search_by_jql: function () { throw new Error('jira down'); },
                file_write: function (path, content) { writes.push({ path: path, content: content }); return null; }
            }
        });
        loaded.mod.action({ inputFolderPath: 'input/PROJ-10', jobParams: {} });
        assert.equal(writes.length, 0);
        assert.equal(loaded.parentCalls.length, 1);
    });

    test('gh-802 AC3c: the fetch error is logged WITH its content, not swallowed as {}', function() {
        var errors = [];
        var origError = console.error;
        console.error = function () {
            errors.push(Array.prototype.slice.call(arguments).join(' '));
        };
        try {
            var loaded = loadFetchQuestionsWithMocks({
                globals: {
                    jira_search_by_jql: function () {
                        throw new Error('jira down: 503 from rest/api/2/search');
                    }
                }
            });
            loaded.mod.action({ inputFolderPath: 'input/PROJ-10', jobParams: {} });
        } finally {
            console.error = origError;
        }
        var joined = errors.join('\n');
        assert.ok(joined.indexOf('Failed to fetch questions') !== -1,
            'the failure is still announced, got: ' + JSON.stringify(joined));
        assert.ok(joined.indexOf('jira down: 503 from rest/api/2/search') !== -1,
            'the error CONTENT must reach the log (was swallowed as {} before the fix), got: ' + JSON.stringify(joined));
        assert.ok(joined.indexOf('{}') === -1, 'no bare {} rendering of the error object');
    });

});
