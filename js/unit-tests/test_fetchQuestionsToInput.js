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
            ),
            './fetchParentContextToInput.js': { action: function() {} }
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
        action: options.parentAction || function (p) { parentCalls.push(p); }
    };
    var projectConfig = {
        jira: {
            questions: {
                fetchJql: options.fetchJql !== undefined ? options.fetchJql : QUESTIONS_JQL,
                answerField: options.answerField !== undefined ? options.answerField : 'Answer'
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

    test('ado provider with the shipped JQL default: skip for the same reason, and the reason says how to enable it', function() {
        var mod = loadFetchQuestionsWithMocks({}).mod;
        var plan = mod.questionsFetchPlan('ado', { fetchJql: QUESTIONS_JQL }, '42');
        assert.equal(plan.skip, true);
        assert.ok(plan.reason.indexOf('ado') !== -1);
        assert.ok(plan.reason.indexOf('WIQL') !== -1, 'tells the operator to configure a WIQL fetchJql');
    });

    test('ado provider with a WIQL fetchJql (agents#871): the configured query runs, ticket key interpolated', function() {
        var mod = loadFetchQuestionsWithMocks({}).mod;
        var wiql = "SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = {ticketKey} MODE (MustContain)";
        var plan = mod.questionsFetchPlan('ado', { fetchJql: wiql }, '1839749');
        assert.equal(plan.skip, false);
        assert.equal(plan.jql, "SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = 1839749 MODE (MustContain)");
    });

    test('ado WIQL detection is case-insensitive and tolerates leading whitespace; jira/github never take this branch', function() {
        var mod = loadFetchQuestionsWithMocks({}).mod;
        assert.equal(mod.questionsFetchPlan('ado', { fetchJql: '  select [System.Id] from WorkItems where [System.Parent] = {ticketKey}' }, '7').skip, false);
        assert.equal(mod.questionsFetchPlan('github', { fetchJql: 'SELECT [System.Id] FROM WorkItems' }, 'gh-1').skip, true);
        assert.equal(mod.questionsFetchPlan('jira', { fetchJql: 'parent = {ticketKey}' }, 'P-1').jql, 'parent = P-1');
    });

    test('provider defaults to jira when absent (unchanged)', function() {
        var mod = loadFetchQuestionsWithMocks({}).mod;
        assert.equal(mod.questionsFetchPlan(undefined, { fetchJql: 'parent = {ticketKey}' }, 'P-2').jql, 'parent = P-2');
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
        // The host console renders a raw Error object as "{}" (verified in the
        // dmtools GraalJS runtime: console.error('x', new Error('m')) → "x {}"),
        // so the ONLY way the cause stays visible is when the module passes a
        // STRING containing the content. Pin exactly that.
        var errorArgs = [];
        var origError = console.error;
        console.error = function () {
            errorArgs.push(Array.prototype.slice.call(arguments));
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
        assert.ok(errorArgs.length > 0, 'the failure is still announced');
        var hasContentString = errorArgs.some(function (args) {
            return args.some(function (a) {
                return typeof a === 'string' && a.indexOf('jira down: 503 from rest/api/2/search') !== -1;
            });
        });
        assert.ok(hasContentString,
            'a string carrying the error content must reach the log (was swallowed as {} before the fix), got: ' +
            JSON.stringify(errorArgs));
        var passesRawObject = errorArgs.some(function (args) {
            return args.some(function (a) { return a !== null && typeof a === 'object'; });
        });
        assert.ok(!passesRawObject,
            'the raw error object must NOT be passed through (renders as {} on the host console)');
    });

});

// ── gh-1112: skipParentContext — preCliContentOutputSetup owns the step ──────
// The pre-CLI chain runs fetchParentContextToInput explicitly (fault-isolated
// in its own step) and suppresses this module's built-in call so the
// parent-context JQL is not fired twice per run.

suite('fetchQuestionsToInput.action — skipParentContext (gh-1112)', function () {

    function githubLoader(parentAction) {
        return loadFetchQuestionsWithMocks({
            trackerProvider: 'github',
            parentAction: parentAction,
            globals: {
                jira_search_by_jql: function () { return []; },
                file_write: function () { return null; }
            }
        });
    }

    test('default: parent-context enrichment runs exactly once with the original params', function () {
        var loaded = githubLoader();
        var params = { inputFolderPath: 'input/PROJ-20', jobParams: {} };
        loaded.mod.action(params);
        assert.equal(loaded.parentCalls.length, 1, 'parent enrichment runs once by default');
        assert.equal(loaded.parentCalls[0], params, 'the original params object is forwarded');
    });

    test('skipParentContext: true — the built-in parent-context call is suppressed', function () {
        var loaded = githubLoader();
        loaded.mod.action({ inputFolderPath: 'input/PROJ-21', jobParams: {}, skipParentContext: true });
        assert.equal(loaded.parentCalls.length, 0,
            'preCliContentOutputSetup fires the parent-context step itself — no second JQL here');
    });

    test('skipParentContext: false behaves like the default (enrichment runs)', function () {
        var loaded = githubLoader();
        loaded.mod.action({ inputFolderPath: 'input/PROJ-22', jobParams: {}, skipParentContext: false });
        assert.equal(loaded.parentCalls.length, 1);
    });

    test('a parent-context throw stays non-fatal (warned, never propagated)', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function (m) { warns.push(String(m)); };
        try {
            var loaded = githubLoader(function () { throw new Error('parent jql exploded'); });
            loaded.mod.action({ inputFolderPath: 'input/PROJ-23', jobParams: {} });
        } finally {
            console.warn = origWarn;
        }
        assert.equal(warns.some(function (w) { return w.indexOf('fetchParentContextToInput') !== -1; }), true,
            'the failure is announced as a non-fatal warning');
    });

});

// ── gh-1126: ADO comment-thread sentinel and custom WIT field resolution ────

suite('fetchQuestionsToInput — gh-1126 ADO comment-thread sentinel & custom WIT field resolution', function () {

    var ADO_QUESTIONS_WIQL = "SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = {ticketKey}";

    test('UT-1126-2: isCommentAnswerSentinel, buildQuestionSearchFields, extractLatestCommentAnswer, resolveQuestionAnswer helpers', function () {
        var mod = loadFetchQuestionsWithMocks({}).mod;

        assert.equal(mod.isCommentAnswerSentinel('comment'), true);
        assert.equal(mod.isCommentAnswerSentinel('comments'), true);
        assert.equal(mod.isCommentAnswerSentinel('COMMENT'), true);
        assert.equal(mod.isCommentAnswerSentinel('  System.History  '), true);
        assert.equal(mod.isCommentAnswerSentinel('Custom.Answer'), false);
        assert.equal(mod.isCommentAnswerSentinel('Answer'), false);
        assert.equal(mod.isCommentAnswerSentinel(''), false);
        assert.equal(mod.isCommentAnswerSentinel(null), false);

        assert.deepEqual(
            mod.buildQuestionSearchFields('jira', 'Answer'),
            ['key', 'summary', 'description', 'status', 'priority', 'Answer']
        );
        assert.deepEqual(
            mod.buildQuestionSearchFields(undefined, 'comment'),
            ['key', 'summary', 'description', 'status', 'priority', 'comment']
        );
        assert.deepEqual(
            mod.buildQuestionSearchFields('ado', 'comment'),
            ['key', 'summary', 'description', 'status', 'priority']
        );
        assert.deepEqual(
            mod.buildQuestionSearchFields('ado', 'System.History'),
            ['key', 'summary', 'description', 'status', 'priority']
        );
        assert.deepEqual(
            mod.buildQuestionSearchFields('ado', ''),
            ['key', 'summary', 'description', 'status', 'priority']
        );
        assert.deepEqual(
            mod.buildQuestionSearchFields('ado', 'Custom.Answer'),
            ['key', 'summary', 'description', 'status', 'priority', 'Custom.Answer']
        );

        assert.equal(mod.extractLatestCommentAnswer([
            { author: 'A', body: 'first' },
            { author: 'B', body: 'second' }
        ]), 'second');
        assert.equal(mod.extractLatestCommentAnswer([]), null);
        assert.equal(mod.extractLatestCommentAnswer(null), null);
    });

    test('IT-1126-1: ADO + answerField="comment" searches without comment column and resolves latest comment answer', function () {
        var wiqlCalls = [];
        var commentCalls = [];
        var writes = [];
        var loaded = loadFetchQuestionsWithMocks({
            trackerProvider: 'ado',
            fetchJql: ADO_QUESTIONS_WIQL,
            answerField: 'comment',
            globals: {
                ado_search_by_wiql: function (args) {
                    wiqlCalls.push(args);
                    return JSON.stringify({
                        value: [
                            {
                                id: 501,
                                fields: {
                                    'System.Title': 'Q1: auth mode?',
                                    'System.Description': 'Details 1',
                                    'System.State': 'Active',
                                    'System.WorkItemType': 'Issue'
                                }
                            }
                        ]
                    });
                },
                ado_get_work_item_comments: function (args) {
                    commentCalls.push(args);
                    return JSON.stringify({
                        value: [
                            { createdBy: { displayName: 'BA' }, text: 'Initial question context' },
                            { createdBy: { displayName: 'PO' }, text: 'Use OAuth2 PKCE' }
                        ]
                    });
                },
                file_write: function (path, content) { writes.push({ path: path, content: content }); return null; }
            }
        });
        loaded.mod.action({ inputFolderPath: 'input/500', jobParams: {} });
        assert.equal(wiqlCalls.length, 1);
        assert.equal(wiqlCalls[0].fields.indexOf('comment'), -1, 'comment sentinel is not sent as a WIT field');
        assert.equal(commentCalls.length, 1);
        assert.deepEqual(commentCalls[0], { id: '501' });
        assert.equal('ticket' in commentCalls[0], false, 'gh-1174: must not pass ticket: {}');
        assert.equal(writes.length, 1);
        var payload = JSON.parse(writes[0].content);
        assert.equal(payload.questions.length, 1);
        assert.equal(payload.questions[0].key, '501');
        assert.equal(payload.questions[0].answer, 'Use OAuth2 PKCE');
    });

    test('IT-1126-2: ADO + answerField="comments" (and System.History) resolves comment thread answer', function () {
        ['comments', 'System.History'].forEach(function (sentinel) {
            var wiqlCalls = [];
            var writes = [];
            var loaded = loadFetchQuestionsWithMocks({
                trackerProvider: 'ado',
                fetchJql: ADO_QUESTIONS_WIQL,
                answerField: sentinel,
                globals: {
                    ado_search_by_wiql: function (args) {
                        wiqlCalls.push(args);
                        return JSON.stringify({
                            value: [
                                { id: 601, fields: { 'System.Title': 'Q?', 'System.State': 'Closed' } }
                            ]
                        });
                    },
                    ado_get_work_item_comments: function () {
                        return JSON.stringify({
                            value: [{ createdBy: { displayName: 'PO' }, text: 'Confirmed for ' + sentinel }]
                        });
                    },
                    file_write: function (path, content) { writes.push({ path: path, content: content }); return null; }
                }
            });
            loaded.mod.action({ inputFolderPath: 'input/600', jobParams: {} });
            assert.equal(wiqlCalls[0].fields.indexOf(sentinel), -1);
            var payload = JSON.parse(writes[0].content);
            assert.equal(payload.questions[0].answer, 'Confirmed for ' + sentinel);
        });
    });

    test('IT-1126-3: ADO + custom WIT field (Custom.Answer) requests the field in WIQL and reads it from issue.raw.fields', function () {
        var wiqlCalls = [];
        var commentCalls = [];
        var writes = [];
        var loaded = loadFetchQuestionsWithMocks({
            trackerProvider: 'ado',
            fetchJql: ADO_QUESTIONS_WIQL,
            answerField: 'Custom.Answer',
            globals: {
                ado_search_by_wiql: function (args) {
                    wiqlCalls.push(args);
                    return JSON.stringify({
                        value: [
                            {
                                id: 701,
                                fields: {
                                    'System.Title': 'Q: custom WIT field?',
                                    'System.State': 'Resolved',
                                    'Custom.Answer': 'Answered via Custom.Answer'
                                }
                            }
                        ]
                    });
                },
                ado_get_work_item_comments: function (args) {
                    commentCalls.push(args);
                    return JSON.stringify({ value: [] });
                },
                file_write: function (path, content) { writes.push({ path: path, content: content }); return null; }
            }
        });
        loaded.mod.action({ inputFolderPath: 'input/700', jobParams: {} });
        assert.equal(wiqlCalls.length, 1);
        assert.ok(wiqlCalls[0].fields.indexOf('Custom.Answer') !== -1, 'Custom.Answer is requested in WIQL fields');
        assert.equal(commentCalls.length, 0, 'getComments is not called when answerField is a WIT field');
        var payload = JSON.parse(writes[0].content);
        assert.equal(payload.questions[0].answer, 'Answered via Custom.Answer');
    });

    test('IT-1126-4 / E3: ADO + getComments throwing for one question logs warning, sets answer=null, and continues remaining questions', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () {
            warns.push(Array.prototype.slice.call(arguments).join(' '));
        };
        var writes = [];
        try {
            var loaded = loadFetchQuestionsWithMocks({
                trackerProvider: 'ado',
                fetchJql: ADO_QUESTIONS_WIQL,
                answerField: 'comment',
                globals: {
                    ado_search_by_wiql: function () {
                        return JSON.stringify({
                            value: [
                                { id: 801, fields: { 'System.Title': 'Q1', 'System.State': 'Active' } },
                                { id: 802, fields: { 'System.Title': 'Q2', 'System.State': 'Closed' } }
                            ]
                        });
                    },
                    ado_get_work_item_comments: function (args) {
                        if (args.id === '801') throw new Error('ADO 500 on 801');
                        return JSON.stringify({ value: [{ text: 'Answer for 802' }] });
                    },
                    file_write: function (path, content) { writes.push({ path: path, content: content }); return null; }
                }
            });
            loaded.mod.action({ inputFolderPath: 'input/800', jobParams: {} });
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warns.some(function (w) { return w.indexOf('801') !== -1 && w.indexOf('ADO 500 on 801') !== -1; }));
        assert.equal(writes.length, 1);
        var payload = JSON.parse(writes[0].content);
        assert.equal(payload.questions.length, 2);
        assert.equal(payload.questions[0].key, '801');
        assert.equal(payload.questions[0].answer, null);
        assert.equal(payload.questions[1].key, '802');
        assert.equal(payload.questions[1].answer, 'Answer for 802');
    });

    test('REG-1126-1: Jira provider forwards exact legacy fields array and never invokes getComments even when answerField="comment"', function () {
        var searchCalls = [];
        var commentCalls = [];
        var writes = [];
        var loaded = loadFetchQuestionsWithMocks({
            trackerProvider: 'jira',
            answerField: 'comment',
            globals: {
                jira_search_by_jql: function (args) {
                    searchCalls.push(args);
                    return [
                        {
                            key: 'PROJ-99',
                            fields: {
                                summary: 'Jira question',
                                description: 'desc',
                                status: { name: 'Done' },
                                priority: { name: 'Medium' },
                                comment: 'Jira field comment value'
                            }
                        }
                    ];
                },
                jira_get_comments: function (args) { commentCalls.push(args); return []; },
                file_write: function (path, content) { writes.push({ path: path, content: content }); return null; }
            }
        });
        loaded.mod.action({ inputFolderPath: 'input/PROJ-90', jobParams: {} });
        assert.equal(searchCalls.length, 1);
        assert.deepEqual(searchCalls[0].fields, ['key', 'summary', 'description', 'status', 'priority', 'comment']);
        assert.equal(commentCalls.length, 0);
        var payload = JSON.parse(writes[0].content);
        assert.equal(payload.questions[0].answer, 'Jira field comment value');
    });

    test('E1..E4 edge cases: empty comments (E1), whitespace-only trailing comments (E2), non-Error throw (E3), missing raw fields (E4)', function () {
        var mod = loadFetchQuestionsWithMocks({}).mod;

        // E1: Question work item has 0 comments -> null
        assert.equal(mod.extractLatestCommentAnswer([]), null);

        // E2: Latest comments have empty/whitespace body -> falls back to earlier non-empty comment
        assert.equal(mod.extractLatestCommentAnswer([
            { author: 'A', body: 'Real answer' },
            { author: 'B', body: '   \n\t  ' },
            { author: 'C', body: '' },
            { author: 'D', body: null }
        ]), 'Real answer');
        assert.equal(mod.extractLatestCommentAnswer([
            { author: 'A', body: '   ' },
            { author: 'B', body: '' }
        ]), null);

        // E3: Non-Error string thrown by getComments -> warns and returns null
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var fakeTracker = { getComments: function () { throw 'raw string failure'; } };
            assert.equal(mod.resolveQuestionAnswer(fakeTracker, 'ado', { key: '999' }, 'comment'), null);
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warns.some(function (w) { return w.indexOf('raw string failure') !== -1; }));

        // E4: Missing issue / fields / raw.fields -> returns null cleanly
        assert.equal(mod.resolveQuestionAnswer({}, 'ado', { key: '999', fields: {} }, 'Custom.Missing'), null);
        assert.equal(mod.resolveQuestionAnswer({}, 'ado', null, 'Custom.Missing'), null);
    });

});
