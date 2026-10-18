/**
 * Unit tests for js/postBugCreation.js
 */

function loadPostBugCreation(mocks) {
    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_remove_label: function() {},
        jira_link_issues: function() {},
        jira_create_ticket_basic: function() { return ''; },
        file_read: function() { return null; }
    };

    var allMocks = Object.assign({}, defaults, mocks);
    return loadModule(
        'js/postBugCreation.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), allMocks)
        }),
        allMocks
    );
}

suite('postBugCreation', function() {

    test('removes SM trigger label when bug_decision.json is missing', function() {
        var removedLabels = [];
        var comments = [];

        var module = loadPostBugCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bug_decision.json') return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args);
            },
            jira_remove_label: function(args) {
                removedLabels.push(args);
            }
        });

        var result = module.action({
            ticket: { key: 'TS-732' },
            metadata: { contextId: 'bug_creation' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered'
                }
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'No bug_decision.json');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Could not read bug_decision.json');
        // sm_bug_creation_triggered is intentionally kept to prevent SM re-triggering an infinite loop
        assert.deepEqual(removedLabels, [
            { key: 'TS-732', label: 'bug_creation_wip' }
        ]);
    });

    test('moves test-code issue decision to In Rework and clears trigger labels', function() {
        var statusMoves = [];
        var removedLabels = [];
        var comments = [];

        var module = loadPostBugCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bug_decision.json') {
                    return JSON.stringify({
                        action: 'none',
                        reason: 'Failure is caused by stale test automation.'
                    });
                }
                return null;
            },
            jira_post_comment: function(args) { comments.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-222' },
            metadata: { contextId: 'bug_creation' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'none');
        assert.deepEqual(statusMoves, [
            { key: 'TS-222', statusName: 'In Rework' }
        ]);
        assert.deepEqual(removedLabels, [
            { key: 'TS-222', label: 'sm_test_automation_triggered' },
            { key: 'TS-222', label: 'bug_creation_wip' },
            { key: 'TS-222', label: 'sm_bug_creation_triggered' }
        ]);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'In Rework');
    });

});

suite('postBugCreation: create/link decisions (gh-1010 characterization)', function() {

    function runCreateFlow(overrides) {
        var calls = { comments: [], links: [], moves: [], removedLabels: [], created: [] };
        var mocks = Object.assign({
            file_read: function(opts) {
                if (opts.path === 'outputs/bug_decision.json') {
                    return JSON.stringify(overrides.decision);
                }
                if (opts.path === 'outputs/bug_description.md') return 'Bug body text';
                return null;
            },
            jira_post_comment: function(args) { calls.comments.push(args); },
            jira_move_to_status: function(args) { calls.moves.push(args); return {}; },
            jira_remove_label: function(args) { calls.removedLabels.push(args); },
            jira_add_label: function() {},
            jira_link_issues: function(args) { calls.links.push(args); },
            jira_create_ticket_basic: function(args) {
                calls.created.push(args);
                return overrides.createResult !== undefined ? overrides.createResult : '{"key":"BUG-42"}';
            }
        }, overrides.mocks || {});
        if (overrides.omitCreateMock) delete mocks.jira_create_ticket_basic;

        var module = loadPostBugCreation(mocks);
        var result = module.action({
            ticket: { key: 'TS-101' },
            metadata: { contextId: 'bug_creation' },
            jobParams: { customParams: { removeLabel: 'sm_bug_creation_triggered' } }
        });
        return { result: result, calls: calls };
    }

    test('create decision creates bug, links it blocking the TC and moves both tickets', function() {
        var r = runCreateFlow({
            decision: {
                action: 'create',
                summary: 'Login button does nothing',
                description: 'outputs/bug_description.md',
                reason: 'Verified on staging'
            }
        });

        assert.equal(r.result.success, true);
        assert.equal(r.result.action, 'create');
        assert.equal(r.result.bugKey, 'BUG-42');
        assert.equal(r.calls.created.length, 1);
        assert.equal(r.calls.created[0].project, 'TS');
        assert.equal(r.calls.created[0].issueType, 'Bug');
        assert.contains(r.calls.created[0].description, 'Bug body text');
        assert.deepEqual(r.calls.links, [
            { sourceKey: 'TS-101', anotherKey: 'BUG-42', relationship: 'Blocks' }
        ]);
        assert.deepEqual(r.calls.moves, [
            { key: 'TS-101', statusName: 'Bug To Fix' },
            { key: 'BUG-42', statusName: 'Ready For Development' }
        ]);
        assert.deepEqual(r.calls.removedLabels, [
            { key: 'TS-101', label: 'bug_creation_wip' },
            { key: 'TS-101', label: 'sm_bug_creation_triggered' },
            { key: 'TS-101', label: 'sm_test_automation_triggered' }
        ]);
        assert.equal(r.calls.comments.length, 1);
        assert.contains(r.calls.comments[0].comment, 'New Bug Created');
        assert.contains(r.calls.comments[0].comment, 'BUG-42');
    });

    test('create decision falls back to descriptionText when no description file is given', function() {
        var r = runCreateFlow({
            decision: {
                action: 'create',
                summary: 'Crash on rotation',
                descriptionText: 'Stack trace in attachment'
            }
        });

        assert.equal(r.result.success, true);
        assert.contains(r.calls.created[0].description, 'Stack trace in attachment');
    });

    test('create decision without summary posts error and keeps SM trigger label', function() {
        var r = runCreateFlow({ decision: { action: 'create' } });

        assert.equal(r.result.success, false);
        assert.equal(r.result.error, 'No bug summary');
        assert.equal(r.calls.created.length, 0);
        assert.deepEqual(r.calls.removedLabels, [
            { key: 'TS-101', label: 'bug_creation_wip' }
        ]);
        assert.equal(r.calls.comments.length, 1);
        assert.contains(r.calls.comments[0].comment, 'No summary provided');
    });

    test('create decision surfaces tracker errors but still releases the SM lock', function() {
        var r = runCreateFlow({
            decision: { action: 'create', summary: 'Broken' },
            mocks: {
                jira_create_ticket_basic: function() { throw new Error('jira unreachable'); }
            }
        });

        assert.equal(r.result.success, true);
        assert.equal(r.result.bugKey, null);
        assert.equal(r.calls.links.length, 0);
        assert.deepEqual(r.calls.moves, []);
        assert.deepEqual(r.calls.removedLabels, [
            { key: 'TS-101', label: 'bug_creation_wip' },
            { key: 'TS-101', label: 'sm_bug_creation_triggered' },
            { key: 'TS-101', label: 'sm_test_automation_triggered' }
        ]);
        assert.equal(r.calls.comments.length, 1);
        assert.contains(r.calls.comments[0].comment, 'Bug Creation Failed');
    });

    test('create decision reports when the bug key cannot be extracted', function() {
        var r = runCreateFlow({
            decision: { action: 'create', summary: 'Odd payload' },
            createResult: '{"id":"123"}'
        });

        assert.equal(r.result.success, true);
        assert.equal(r.result.bugKey, null);
        assert.equal(r.calls.links.length, 0);
        assert.deepEqual(r.calls.moves, []);
        assert.contains(r.calls.comments[0].comment, 'key could not be parsed');
    });

    test('link decision links existing bug blocking the TC and moves both tickets', function() {
        var r = runCreateFlow({
            decision: { action: 'link', existingKey: 'BUG-7', reason: 'Same root cause' }
        });

        assert.equal(r.result.success, true);
        assert.equal(r.result.action, 'link');
        assert.equal(r.result.bugKey, 'BUG-7');
        assert.equal(r.calls.created.length, 0);
        assert.deepEqual(r.calls.links, [
            { sourceKey: 'TS-101', anotherKey: 'BUG-7', relationship: 'Blocks' }
        ]);
        assert.deepEqual(r.calls.moves, [
            { key: 'TS-101', statusName: 'Bug To Fix' },
            { key: 'BUG-7', statusName: 'Ready For Development' }
        ]);
        assert.deepEqual(r.calls.removedLabels, [
            { key: 'TS-101', label: 'bug_creation_wip' },
            { key: 'TS-101', label: 'sm_bug_creation_triggered' },
            { key: 'TS-101', label: 'sm_test_automation_triggered' }
        ]);
        assert.contains(r.calls.comments[0].comment, 'Existing Bug Linked');
        assert.contains(r.calls.comments[0].comment, '_Same root cause_');
    });

    test('create decision keeps the extracted bug key when linking the new bug fails', function() {
        var r = runCreateFlow({
            decision: { action: 'create', summary: 'Broken' },
            mocks: {
                jira_link_issues: function() { throw new Error('link forbidden'); }
            }
        });

        assert.equal(r.result.success, true);
        assert.equal(r.result.bugKey, 'BUG-42');
        assert.equal(r.result.action, 'create');
        assert.deepEqual(r.calls.moves, []);
        assert.contains(r.calls.comments[0].comment, 'Bug Creation Failed');
    });

    test('link decision reports link failure without moving any ticket', function() {
        var r = runCreateFlow({
            decision: { action: 'link', existingKey: 'BUG-9' },
            mocks: {
                jira_link_issues: function() { throw new Error('link forbidden'); }
            }
        });

        assert.equal(r.result.success, true);
        assert.equal(r.result.bugKey, 'BUG-9');
        assert.deepEqual(r.calls.moves, []);
        assert.deepEqual(r.calls.removedLabels, [
            { key: 'TS-101', label: 'bug_creation_wip' },
            { key: 'TS-101', label: 'sm_bug_creation_triggered' },
            { key: 'TS-101', label: 'sm_test_automation_triggered' }
        ]);
        assert.contains(r.calls.comments[0].comment, 'Bug Link Failed');
        assert.contains(r.calls.comments[0].comment, 'link forbidden');
    });

    test('outer error handler releases the SM lock when comment posting itself fails', function() {
        var removedLabels = [];

        var module = loadPostBugCreation({
            file_read: function() { return null; },
            jira_post_comment: function() { throw new Error('postComment boom'); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-313' },
            metadata: { contextId: 'bug_creation' },
            jobParams: { customParams: { removeLabel: 'sm_bug_creation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'postComment boom');
        assert.deepEqual(removedLabels, [
            { key: 'TS-313', label: 'sm_bug_creation_triggered' }
        ]);
    });

    test('outer error handler reports failure when context building throws', function() {
        var module = loadPostBugCreation({
            file_read: function() { return null; }
        });

        var result = module.action({
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, "'key'");
    });

});

suite('postBugCreation: stage-label fallback (gh-916)', function() {
    test("'label' mode: tests_pass decision marks stage_passed when Passed is rejected, no throw", function() {
        var added = [];
        var moves = [];
        var module = loadPostBugCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bug_decision.json') {
                    return JSON.stringify({ action: 'tests_pass', reason: 'green now' });
                }
                return null;
            },
            jira_move_to_status: function() { throw new Error("The field 'State' contains the value 'Passed' that is not in the list of supported values"); },
            jira_add_label: function(args) { added.push(args); },
            jira_post_comment: function(args) { moves.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-230' },
            metadata: { contextId: 'bug_creation' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_bug_creation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'tests_pass');
        assert.deepEqual(added, [{ key: 'TS-230', label: 'stage_passed' }]);
    });

    test("'label' mode: link decision marks stage_bug_to_fix when Bug To Fix is rejected, no throw", function() {
        var added = [];
        var module = loadPostBugCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bug_decision.json') {
                    return JSON.stringify({ action: 'link', existingKey: 'BUG-9' });
                }
                return null;
            },
            jira_move_to_status: function(args) {
                if (args.statusName === 'Bug To Fix') throw new Error('state rejected');
                return {};
            },
            jira_add_label: function(args) { added.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-231' },
            metadata: { contextId: 'bug_creation' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_bug_creation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'link');
        assert.deepEqual(added, [{ key: 'TS-231', label: 'stage_bug_to_fix' }], 'only the Bug To Fix stage is marked; Ready For Development exists everywhere');
    });
});
