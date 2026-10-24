/**
 * Unit tests for js/recoverStuckDevelopment.js (gh-1229 characterization)
 *
 * Pins the recovery contract before helper extraction: missing ticket key,
 * no-open-PR fallback, open-PR re-route, non-fatal tracker failures and the
 * param-resolution helper precedence.
 */

function trackersWithMocks(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

function loadRecoverStuckDevelopment(mocks, scm) {
    return loadModule('js/recoverStuckDevelopment.js', makeRequire({
        './configLoader.js': {
            loadProjectConfig: function() { return { jira: {} }; },
            createScm: function() { return scm || { listPrs: function() { return []; } }; }
        },
        './config.js': configModule,
        './common/trackers.js': trackersWithMocks(mocks)
    }), mocks || {});
}

suite('recoverStuckDevelopment', function() {

    test('missing ticket key: structured failure, no SCM call', function() {
        var listed = false;
        var mod = loadRecoverStuckDevelopment({
            jira_move_to_status: function() {},
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        }, { listPrs: function() { listed = true; return []; } });

        var result = mod.action({ jobParams: {} });

        assert.deepEqual(result, { success: false, error: 'missing ticket key' });
        assert.equal(listed, false, 'the PR search must not run without a ticket key');
    });

    test('no open PR: moves back to Ready For Development, strips all stale labels, comments once', function() {
        var calls = [];
        var mod = loadRecoverStuckDevelopment({
            jira_move_to_status: function(a) { calls.push(['move', a]); },
            jira_remove_label: function(a) { calls.push(['rm', a]); },
            jira_post_comment: function(a) { calls.push(['comment', a]); }
        });

        var result = mod.action({ ticket: { key: 'TS-9' }, jobParams: {} });

        assert.deepEqual(result, { success: true, action: 'moved_to_ready_for_development', ticketKey: 'TS-9' });
        assert.deepEqual(calls[0], ['move', { key: 'TS-9', statusName: 'Ready For Development' }]);
        var removed = calls.filter(function(c) { return c[0] === 'rm'; }).map(function(c) { return c[1].label; });
        assert.deepEqual(removed, [
            'sm_story_development_triggered',
            'sm_bug_development_triggered',
            'sm_story_rework_triggered'
        ]);
        assert.equal(calls[calls.length - 1][0], 'comment');
        assert.ok(calls[calls.length - 1][1].comment.indexOf('no open PR') !== -1);
    });

    test('open PR: moves to In Review, strips the stale labels, comments with the PR number', function() {
        var calls = [];
        var mod = loadRecoverStuckDevelopment({
            jira_move_to_status: function(a) { calls.push(['move', a]); },
            jira_remove_label: function(a) { calls.push(['rm', a]); },
            jira_post_comment: function(a) { calls.push(['comment', a]); }
        }, { listPrs: function() { return [{ number: 12, title: 'TS-9 fix', head: { ref: 'ai/TS-9' } }]; } });

        var result = mod.action({ ticket: { key: 'TS-9' }, jobParams: {} });

        assert.deepEqual(result, { success: true, action: 'moved_to_review', ticketKey: 'TS-9', prNumber: 12 });
        assert.deepEqual(calls[0], ['move', { key: 'TS-9', statusName: 'In Review' }]);
        assert.equal(calls.filter(function(c) { return c[0] === 'rm'; }).length, 3);
        assert.ok(calls[calls.length - 1][1].comment.indexOf('#12') !== -1);
    });

    test('a failing status move is non-fatal: labels still stripped and comment still posted', function() {
        var calls = [];
        var mod = loadRecoverStuckDevelopment({
            jira_move_to_status: function() { throw new Error('workflow locked'); },
            jira_remove_label: function(a) { calls.push(['rm', a]); },
            jira_post_comment: function(a) { calls.push(['comment', a]); }
        });

        var result = mod.action({ ticket: { key: 'TS-10' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ready_for_development');
        assert.equal(calls.filter(function(c) { return c[0] === 'rm'; }).length, 3);
        assert.equal(calls[calls.length - 1][0], 'comment');
    });

    test('customParamsOf keeps the jobParams-then-top-level precedence', function() {
        var mod = loadRecoverStuckDevelopment({});
        assert.deepEqual(mod.customParamsOf({ jobParams: { customParams: { a: 1 } } }), { a: 1 });
        assert.deepEqual(mod.customParamsOf({ customParams: { b: 2 } }), { b: 2 });
        assert.equal(mod.customParamsOf({}), undefined);
    });
});
