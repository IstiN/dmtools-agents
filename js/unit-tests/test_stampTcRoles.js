/**
 * Unit tests for js/stampTcRoles.js — the gh-1345 mechanical TC role stamping
 * post-action on the bug TC-generator leg.
 *
 * The generator creates the bug's Test Cases; this post-action stamps the
 * role marker (`Verifies: <BUG-KEY>` / `Regression guard: <scope>`) onto each
 * created TC's description mechanically — the agent-memory dependency is gone.
 * The leg's existing behavior (moveToDone) is preserved: the stamping is
 * best-effort and never breaks the hand-off.
 */

function trackersWith(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

function tcRoleStampModule() {
    return loadModule('js/common/tcRoleStamp.js', makeRequire({}));
}

function loadStampTcRoles(mocks) {
    return loadModule('js/stampTcRoles.js', makeRequire(Object.assign({}, {
        './configLoader.js': makeDefaultConfigLoaderMock(),
        './config.js': configModule,
        './common/trackers.js': trackersWith(mocks || {}),
        './common/tcRoleStamp.js': tcRoleStampModule(),
        './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js', makeRequire({
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        })),
        './moveToDone.js': loadModule('js/moveToDone.js', makeRequire({
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {}, postTokenUsageCommentsSafely: function() {} },
            './common/actionTicketContext.js': loadModule('js/common/actionTicketContext.js', makeRequire({
                './config.js': configModule,
                './configLoader.js': makeDefaultConfigLoaderMock(),
                './trackers.js': trackersWith(mocks || {})
            }))
        }))
    }, { './common/trackers.js': trackersWith(mocks || {}) })), mocks || {});
}

/**
 * Jira mocks for a bug parent with the given linked TC descriptions.
 * tcDescriptions: { 'TS-5': 'h4. Objective ...', ... } — entries WITHOUT a
 * description exercise the getIssue fallback (null description in search).
 */
function stampMocks(tcDescriptions, opts) {
    opts = opts || {};
    var m = {
        updatedDescriptions: [],
        moves: [],
        comments: [],
        unlabels: [],
        getIssueCalls: [],
        jira_search_by_jql: function(args) {
            var issues = Object.keys(tcDescriptions).map(function(key) {
                var hideInSearch = opts.searchWithoutDescription && opts.searchWithoutDescription[key];
                return { key: key, fields: {
                    summary: key + ' summary',
                    description: hideInSearch ? null : (tcDescriptions[key] === undefined ? null : tcDescriptions[key])
                } };
            });
            return JSON.stringify({ issues: issues });
        },
        jira_update_description: function(args) { m.updatedDescriptions.push(args); },
        jira_move_to_status: function(args) { m.moves.push(args); },
        jira_post_comment: function(args) { m.comments.push(args); },
        jira_remove_label: function(args) { m.unlabels.push(args); },
        jira_get_ticket: function(args) {
            m.getIssueCalls.push(args.key);
            if (opts.parentType && String(args.key) === opts.parentKey) {
                return { fields: { issuetype: { name: opts.parentType }, summary: opts.parentSummary || 'Checkout total wrong' } };
            }
            var desc = tcDescriptions[args.key];
            return { fields: { description: desc === undefined ? null : desc, summary: args.key + ' summary' } };
        }
    };
    return m;
}

function bugParentParams() {
    return { ticket: { key: 'BUG-1', fields: { summary: 'Checkout total wrong' } } };
}

suite('stampTcRoles: the bug TC-generator leg stamps roles mechanically', function() {

    test('AC3: two unmarked created TCs get the oracle + guard stamps as FIRST line', function() {
        var m = stampMocks({
            'TS-6': 'h4. Objective\nroot cause prevention',
            'TS-5': 'h4. Objective\nthe exact bug scenario'
        }, { parentType: 'Bug', parentKey: 'BUG-1' });
        var mod = loadStampTcRoles(m);

        var result = mod.action(bugParentParams());

        assert.equal(result.success, true, 'the leg completes');
        assert.equal(m.updatedDescriptions.length, 2);
        assert.equal(m.updatedDescriptions[0].key, 'TS-5');
        assert.equal(String(m.updatedDescriptions[0].description).indexOf('Verifies: BUG-1\n'), 0,
            'the oracle marker is the FIRST description line');
        assert.equal(m.updatedDescriptions[1].key, 'TS-6');
        assert.contains(m.updatedDescriptions[1].description, 'Regression guard: Checkout total wrong');
    });

    test('the existing moveToDone leg behavior is preserved after stamping', function() {
        var m = stampMocks({ 'TS-5': 'body' }, { parentType: 'Bug', parentKey: 'BUG-1' });
        var mod = loadStampTcRoles(m);

        mod.action(bugParentParams());

        assert.deepEqual(m.moves, [{ key: 'BUG-1', statusName: 'Done' }]);
        assert.deepEqual(m.unlabels, [{ key: 'BUG-1', label: 'sm_bug_test_cases_triggered' }]);
        assert.equal(m.comments.length, 1, 'the generation comment is still posted');
    });

    test('already-marked TCs are never re-stamped (idempotent)', function() {
        var m = stampMocks({
            'TS-5': 'Verifies: BUG-1\n\nh4. Objective\nscenario',
            'TS-6': 'Regression guard: totals\n\nh4. Objective\nprevention'
        }, { parentType: 'Bug', parentKey: 'BUG-1' });
        var mod = loadStampTcRoles(m);

        var result = mod.action(bugParentParams());

        assert.equal(result.success, true);
        assert.equal(m.updatedDescriptions.length, 0, 'no description rewrite');
        assert.deepEqual(m.moves, [{ key: 'BUG-1', statusName: 'Done' }], 'the leg still completes');
    });

    test('an existing oracle leaves the unmarked TC a guard (never a second oracle)', function() {
        var m = stampMocks({
            'TS-5': 'Verifies: BUG-1\n\nbody',
            'TS-6': 'h4. Objective\nunmarked prevention'
        }, { parentType: 'Bug', parentKey: 'BUG-1' });
        var mod = loadStampTcRoles(m);

        mod.action(bugParentParams());

        assert.equal(m.updatedDescriptions.length, 1);
        assert.equal(m.updatedDescriptions[0].key, 'TS-6');
        assert.contains(m.updatedDescriptions[0].description, 'Regression guard: Checkout total wrong');
    });

    test('a linked TC without a description in the search result falls back to getIssue', function() {
        var m = stampMocks({ 'TS-5': 'h4. Objective\nfrom getIssue' },
            { parentType: 'Bug', parentKey: 'BUG-1', searchWithoutDescription: { 'TS-5': true } });
        var mod = loadStampTcRoles(m);

        mod.action(bugParentParams());

        assert.contains(m.getIssueCalls.join(','), 'TS-5', 'the description fallback fetched the TC');
        assert.equal(m.updatedDescriptions.length, 1);
        assert.equal(String(m.updatedDescriptions[0].description).indexOf('Verifies: BUG-1\n'), 0);
    });

    test('a failing stamp is non-fatal: the other TC stamps and the leg completes', function() {
        var m = stampMocks({
            'TS-5': 'body',
            'TS-6': 'body'
        }, { parentType: 'Bug', parentKey: 'BUG-1' });
        var firstUpdate = m.jira_update_description;
        m.jira_update_description = function(args) {
            if (args.key === 'TS-5') throw new Error('tracker down');
            return firstUpdate(args);
        };
        var mod = loadStampTcRoles(m);

        var result = mod.action(bugParentParams());

        assert.equal(result.success, true, 'the leg is NOT broken by a stamping failure');
        assert.equal(m.updatedDescriptions.length, 1);
        assert.equal(m.updatedDescriptions[0].key, 'TS-6');
        assert.deepEqual(m.moves, [{ key: 'BUG-1', statusName: 'Done' }]);
    });
});

suite('stampTcRoles: scoping — bugs only', function() {

    test('a Story parent TC set is never stamped (roles are a bug-TC concept)', function() {
        var m = stampMocks({ 'TS-5': 'body', 'TS-6': 'body' }, { parentType: 'Story', parentKey: 'ST-1' });
        var mod = loadStampTcRoles(m);

        var result = mod.action({ ticket: { key: 'ST-1', fields: { summary: 'A story' } } });

        assert.equal(result.success, true);
        assert.equal(m.updatedDescriptions.length, 0);
        assert.deepEqual(m.getIssueCalls.filter(function(k) { return k !== 'ST-1'; }), [],
            'no TC description fetches for stories');
    });

    test('an unreadable parent type degrades to no stamping, leg completes', function() {
        var m = stampMocks({ 'TS-5': 'body' }, {});
        m.jira_get_ticket = function(args) {
            if (args.key === 'BUG-1') throw new Error('tracker down');
            return { fields: { description: 'body' } };
        };
        var mod = loadStampTcRoles(m);

        var result = mod.action(bugParentParams());

        assert.equal(result.success, true);
        assert.equal(m.updatedDescriptions.length, 0);
        assert.deepEqual(m.moves, [{ key: 'BUG-1', statusName: 'Done' }]);
    });
});
