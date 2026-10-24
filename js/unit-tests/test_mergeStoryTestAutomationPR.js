function d4TrackersWith(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

/**
 * Unit tests for js/mergeStoryTestAutomationPR.js
 */

function loadMergeStoryTestAutomationPR(mocks) {
    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_remove_label: function() {},
        jira_search_by_jql: function() { return []; },
        jira_link_issues: function() {},
        jira_add_label: function() {},
        github_list_prs: function() { return []; },
        github_get_pr: function() { return {}; },
        github_merge_pr: function() {},
        github_remove_pr_label: function() {},
        cli_execute_command: function() { return ''; },
        file_read: function() { return null; }
    };

    var allMocks = Object.assign({}, defaults, mocks);

    var scmModule = loadModule(
        'js/common/scm.js',
        makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js'),
            './reviewThreadInventory.js': loadModule('js/common/reviewThreadInventory.js', makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') })) }),
        allMocks
    );

    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': scmModule
        }),
        { file_read: function() { return null; } }
    );

    return loadModule(
        'js/mergeStoryTestAutomationPR.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': freshConfigLoader,
            './common/scm.js': scmModule,
            './common/autoStart.js': {
                triggerSmIfIdle: function() { return { success: true }; }
            },
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function() {}
            },
            './common/trackers.js': d4TrackersWith(allMocks)
        }),
        allMocks
    );
}

suite('mergeStoryTestAutomationPR', function() {

    test('merges PR and moves linked Test Cases to Passed/Failed', function() {
        var merged = [];
        var statusMoves = [];
        var labelsRemoved = [];

        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') {
                    return 'https://github.com/IstiN/trackstate.git';
                }
                return '';
            },
            github_list_prs: function() {
                return [{ number: 55, head: { ref: 'test/TS-50' }, html_url: 'https://github.com/IstiN/trackstate/pull/55' }];
            },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            github_merge_pr: function(args) { merged.push(args); },
            github_remove_pr_label: function(num, label) { labelsRemoved.push({ num: num, label: label }); },
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'linkedIssues("TS-50")');
                assert.deepEqual(args.fields, ['key', 'status']);
                return [
                    { key: 'TS-51', fields: { status: { name: 'In Review - Passed' } } },
                    { key: 'TS-52', fields: { status: { name: 'In Review - Failed' } } }
                ];
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { labelsRemoved.push(args); },
            jira_post_comment: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-50' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.equal(result, true);
        assert.deepEqual(merged, [{ workspace: 'IstiN', repository: 'trackstate', pullRequestId: '55', mergeMethod: 'squash' }]);
        assert.deepEqual(statusMoves, [
            { key: 'TS-51', statusName: 'Passed' },
            { key: 'TS-52', statusName: 'Failed' }
        ]);
    });

    test('merges Bug PR and keeps Bug in In Testing for bug_done_check', function() {
        var merged = [];
        var statusMoves = [];

        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function() {
                return [{ number: 77, head: { ref: 'test/TS-80' }, html_url: 'https://github.com/IstiN/trackstate/pull/77' }];
            },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            github_merge_pr: function(args) { merged.push(args); },
            github_remove_pr_label: function() {},
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'linkedIssues("TS-80")');
                return [
                    { key: 'TS-81', fields: { status: { name: 'In Review - Passed' } } }
                ];
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-80', fields: { issuetype: { name: 'Bug' } } },
            jobParams: { customParams: { removeLabel: 'sm_bug_test_merge_triggered' } }
        });

        assert.equal(result, true);
        assert.deepEqual(statusMoves, [
            { key: 'TS-81', statusName: 'Passed' }
        ]);
    });

    test('returns false when no open PR found', function() {
        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function() { return []; }
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.equal(result, true);
    });

    test('moves ticket to In Rework on merge conflict', function() {
        var statusMoves = [];
        var comments = [];

        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function() {
                return [{ number: 66, head: { ref: 'test/TS-70' }, html_url: 'https://github.com/IstiN/trackstate/pull/66' }];
            },
            github_get_pr: function() { return { mergeable: false, mergeable_state: 'dirty' }; },
            github_remove_pr_label: function() {},
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-70' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.equal(result, true);
        assert.deepEqual(statusMoves, [{ key: 'TS-70', statusName: 'In Rework' }]);
        assert.ok(comments[0].indexOf('MERGE CONFLICT') !== -1);
    });

    test('finalizes already-merged Story PR without re-merging', function() {
        var merged = [];
        var statusMoves = [];
        var labelsRemoved = [];
        var comments = [];

        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function(state) {
                if (state === 'open') return [];
                return [{ number: 88, head: { ref: 'test/TS-90' }, html_url: 'https://github.com/IstiN/trackstate/pull/88', merged_at: '2026-06-21T14:00:00Z' }];
            },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            github_merge_pr: function(args) { merged.push(args); },
            github_remove_pr_label: function() {},
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'linkedIssues("TS-90")');
                return [
                    { key: 'TS-91', fields: { status: { name: 'In Review - Passed' } } },
                    { key: 'TS-92', fields: { status: { name: 'In Review - Failed' } } }
                ];
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { labelsRemoved.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); }
        });

        var result = module.action({
            ticket: { key: 'TS-90' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.equal(result, true);
        assert.deepEqual(merged, [], 'should not merge an already-merged PR');
        assert.deepEqual(statusMoves, [
            { key: 'TS-91', statusName: 'Passed' },
            { key: 'TS-92', statusName: 'Failed' }
        ]);
        assert.ok(comments[0].indexOf('Already Merged') !== -1);
    });

    test('finalizes already-merged Bug PR and keeps Bug in In Testing', function() {
        var statusMoves = [];
        var comments = [];

        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function(state) {
                if (state === 'open') return [];
                return [{ number: 99, head: { ref: 'test/TS-100' }, html_url: 'https://github.com/IstiN/trackstate/pull/99', merged_at: '2026-06-21T14:00:00Z' }];
            },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            github_remove_pr_label: function() {},
            jira_search_by_jql: function(args) {
                return [{ key: 'TS-101', fields: { status: { name: 'In Review - Passed' } } }];
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function() {},
            jira_post_comment: function(args) { comments.push(args.comment); }
        });

        var result = module.action({
            ticket: { key: 'TS-100', fields: { issuetype: { name: 'Bug' } } },
            jobParams: { customParams: { removeLabel: 'sm_bug_test_merge_triggered' } }
        });

        assert.equal(result, true);
        assert.deepEqual(statusMoves, [
            { key: 'TS-101', statusName: 'Passed' }
        ]);
    });

    test('ado: merges PR, moves linked TCs via ado_move_to_state, no jira_* tool', function() {
        var calls = [];
        function forbid(n) { return function() { throw new Error(n + ' must not be called on ado'); }; }
        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function() {
                return [{ number: 55, head: { ref: 'test/50' }, html_url: 'https://github.com/IstiN/trackstate/pull/55' }];
            },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            github_merge_pr: function() {},
            github_remove_pr_label: function() {},
            ado_search_by_wiql: function(a) {
                calls.push({ tool: 'wiql', args: a });
                return [
                    { id: 51, fields: { 'System.Title': 'a', 'System.State': 'In Review - Passed' } },
                    { id: 52, fields: { 'System.Title': 'b', 'System.State': 'In Review - Failed' } }
                ];
            },
            ado_move_to_state: function(a) { calls.push({ tool: 'move', args: a }); },
            ado_remove_work_item_label: function(a) { calls.push({ tool: 'rm', args: a }); },
            ado_add_work_item_label: function(a) { calls.push({ tool: 'add', args: a }); },
            ado_add_work_item_comment: function(a) { calls.push({ tool: 'comment', args: a }); },
            jira_search_by_jql: forbid('jira_search_by_jql'),
            jira_move_to_status: forbid('jira_move_to_status'),
            jira_remove_label: forbid('jira_remove_label'),
            jira_add_label: forbid('jira_add_label'),
            jira_post_comment: forbid('jira_post_comment')
        });
        var result = module.action({
            ticket: { key: '50' },
            jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_lock' } }
        });
        assert.equal(result, true);
        var moves = calls.filter(function(c) { return c.tool === 'move'; }).map(function(c) { return c.args; });
        assert.deepEqual(moves, [
            { id: '51', state: 'Passed' },
            { id: '52', state: 'Failed' }
        ]);
        assert.contains(calls[0].args.wiql, 'linkedIssues("50")');
        assert.ok(calls.some(function(c) { return c.tool === 'rm' && c.args.id === '50' && c.args.label === 'sm_lock'; }));
    });
});

// ── gh-916: stage-label fallback for the linked-TC final-status gates and moves ──

suite('mergeStoryTestAutomationPR: stage-label fallback (gh-916)', function() {
    function gh916MergeLoad(mocks) {
        return loadMergeStoryTestAutomationPR(Object.assign({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function() {
                return [{ number: 91, head: { ref: 'test/TS-90' }, html_url: 'https://github.com/IstiN/trackstate/pull/91' }];
            },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            github_merge_pr: function() {},
            github_remove_pr_label: function() {},
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        }, mocks));
    }

    test("'label' mode: a TC marked stage_in_review_passed resolves to Passed and marks stage_passed when rejected", function() {
        var added = [];
        var moves = [];
        var module = gh916MergeLoad({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status', 'labels'], 'labels requested in label mode');
                return [{ key: 'TS-91', fields: { status: { name: 'New' }, labels: ['stage_in_review_passed'] } }];
            },
            jira_move_to_status: function(args) {
                moves.push(args);
                throw new Error("The field 'State' contains the value 'Passed' that is not in the list of supported values");
            },
            jira_add_label: function(args) { added.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-90' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.equal(result, true, 'the merge completes even when the TC move is rejected');
        assert.deepEqual(moves, [{ key: 'TS-91', statusName: 'Passed' }]);
        var stageLabels = added.filter(function(a) { return a.label.indexOf('stage_') === 0; });
        assert.deepEqual(stageLabels, [{ key: 'TS-91', label: 'stage_passed' }]);
        assert.ok(added.some(function(a) { return a.key === 'TS-90' && a.label === 'test_pr_finalized'; }),
            'the story finalize label is still applied');
    });

    test("'none' mode: the marker is ignored — the TC is skipped with the old fields list", function() {
        var moves = [];
        var module = gh916MergeLoad({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status'], 'no labels requested in none mode');
                return [{ key: 'TS-92', fields: { status: { name: 'New' }, labels: ['stage_in_review_passed'] } }];
            },
            jira_move_to_status: function(args) { moves.push(args); }
        });

        module.action({
            ticket: { key: 'TS-90' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.deepEqual(moves, [], 'a marker-only TC has no resolvable final status in none mode');
    });
});

// ── gh-964: pure helpers extracted from checkCiStatus / attemptMerge ──

suite('mergeStoryTestAutomationPR: pure check-run classification (gh-964)', function() {

    function loadPureHelpers() {
        return loadMergeStoryTestAutomationPR({});
    }

    test('classifyCheckRuns: each pending status sets inProgress', function() {
        var m = loadPureHelpers();
        ['in_progress', 'queued', 'pending', 'waiting'].forEach(function(status) {
            var r = m.classifyCheckRuns([{ name: 'c1', status: status, conclusion: '' }]);
            assert.equal(r.inProgress, true, status + ' must set inProgress');
            assert.equal(r.failed, false);
            assert.equal(r.total, 1);
        });
    });

    test('classifyCheckRuns: each failing conclusion sets failed and records the name', function() {
        var m = loadPureHelpers();
        ['failure', 'timed_out', 'action_required'].forEach(function(conclusion) {
            var r = m.classifyCheckRuns([{ name: 'build-' + conclusion, status: 'completed', conclusion: conclusion }]);
            assert.equal(r.failed, true, conclusion + ' must set failed');
            assert.equal(r.inProgress, false);
            assert.deepEqual(r.failedNames, ['build-' + conclusion]);
        });
    });

    test('classifyCheckRuns: mixed runs combine pending and failed; total counts all', function() {
        var m = loadPureHelpers();
        var r = m.classifyCheckRuns([
            { name: 'unit', status: 'completed', conclusion: 'success' },
            { name: 'e2e', status: 'in_progress', conclusion: '' },
            { name: 'lint', status: 'completed', conclusion: 'failure' }
        ]);
        assert.equal(r.inProgress, true);
        assert.equal(r.failed, true);
        assert.deepEqual(r.failedNames, ['lint']);
        assert.equal(r.total, 3);
    });

    test('classifyCheckRuns: non-failing conclusions and missing names are ignored', function() {
        var m = loadPureHelpers();
        var r = m.classifyCheckRuns([
            { name: 'a', status: 'completed', conclusion: 'success' },
            { name: 'b', status: 'completed', conclusion: 'skipped' },
            { name: 'c', status: 'completed', conclusion: 'neutral' },
            { name: 'd', status: 'completed', conclusion: 'cancelled' },
            { name: null, status: 'completed', conclusion: 'failure' }
        ]);
        assert.equal(r.inProgress, false);
        assert.equal(r.failed, true, 'failure still flags even without a name');
        assert.deepEqual(r.failedNames, [], 'a nameless failing check adds no failedName');
        assert.equal(r.total, 5);
    });

    test('classifyCheckRuns: status and conclusion are matched case-insensitively', function() {
        var m = loadPureHelpers();
        var r = m.classifyCheckRuns([{ name: 'x', status: 'IN_PROGRESS', conclusion: 'FAILURE' }]);
        assert.equal(r.inProgress, true);
        assert.equal(r.failed, true);
        assert.deepEqual(r.failedNames, ['x']);
    });

    test('normalizeCheckRuns: accepts arrays, wrapped objects and JSON strings', function() {
        var m = loadPureHelpers();
        assert.deepEqual(m.normalizeCheckRuns([{ name: 'a' }]), [{ name: 'a' }]);
        assert.deepEqual(m.normalizeCheckRuns({ check_runs: [{ name: 'b' }] }), [{ name: 'b' }]);
        assert.deepEqual(m.normalizeCheckRuns(JSON.stringify([{ name: 'c' }])), [{ name: 'c' }]);
        assert.deepEqual(m.normalizeCheckRuns(JSON.stringify({ check_runs: [{ name: 'd' }] })), [{ name: 'd' }]);
    });

    test('normalizeCheckRuns: anything else yields an empty list', function() {
        var m = loadPureHelpers();
        assert.deepEqual(m.normalizeCheckRuns(null), []);
        assert.deepEqual(m.normalizeCheckRuns(undefined), []);
        assert.deepEqual(m.normalizeCheckRuns('not json'), []);
        assert.deepEqual(m.normalizeCheckRuns({ total_count: 1 }), []);
        assert.deepEqual(m.normalizeCheckRuns(42), []);
    });
});

suite('mergeStoryTestAutomationPR: pure merge-decision helpers (gh-964)', function() {

    function loadPureHelpers() {
        return loadMergeStoryTestAutomationPR({});
    }

    test('decideCiBlock: failed beats everything, empty/unknown means still running', function() {
        var m = loadPureHelpers();
        assert.equal(m.decideCiBlock({ inProgress: false, failed: true, failedNames: ['a'], total: 1 }), 'ci_failed');
        assert.equal(m.decideCiBlock({ inProgress: true, failed: true, failedNames: [], total: 2 }), 'ci_failed');
        assert.equal(m.decideCiBlock({ inProgress: true, failed: false, failedNames: [], total: 1 }), 'ci_running');
        assert.equal(m.decideCiBlock({ inProgress: false, failed: false, failedNames: [], total: 0 }), 'ci_running');
        assert.equal(m.decideCiBlock({ inProgress: false, failed: false, failedNames: [], total: 3 }), null);
    });

    test('classifyMergeError: conflict substring, CI-blocking codes and plain errors', function() {
        var m = loadPureHelpers();
        assert.deepEqual(m.classifyMergeError(new Error('Merge conflict detected')),
            { errMsg: 'Error: Merge conflict detected', isConflict: true, isCIBlocking: false });
        assert.equal(m.classifyMergeError('CONFLICT in file.js').isConflict, true, 'conflict match is case-insensitive');
        assert.deepEqual(m.classifyMergeError('Resource blocked by required checks'),
            { errMsg: 'Resource blocked by required checks', isConflict: false, isCIBlocking: true });
        assert.equal(m.classifyMergeError('HTTP 422').isCIBlocking, true);
        assert.equal(m.classifyMergeError('HTTP 405').isCIBlocking, true);
        assert.deepEqual(m.classifyMergeError('network timeout'),
            { errMsg: 'network timeout', isConflict: false, isCIBlocking: false });
        assert.deepEqual(m.classifyMergeError(null),
            { errMsg: '', isConflict: false, isCIBlocking: false });
    });

    test('isUndeterminedMergeState: null mergeable or any undetermined state triggers the CI gate', function() {
        var m = loadPureHelpers();
        assert.equal(m.isUndeterminedMergeState(null, 'clean'), true, 'mergeable null always gates');
        assert.equal(m.isUndeterminedMergeState(null, null), true);
        ['unknown', 'blocked', 'unstable', 'checking', 'unchecked', 'preparing', 'ci_must_pass', 'ci_still_running']
            .forEach(function(state) {
                assert.equal(m.isUndeterminedMergeState(true, state), true, state + ' must gate');
            });
        assert.equal(m.isUndeterminedMergeState(true, 'clean'), false);
        assert.equal(m.isUndeterminedMergeState(false, 'dirty'), false);
        assert.equal(m.isUndeterminedMergeState(true, 'behind'), false);
        assert.equal(m.isUndeterminedMergeState(true, undefined), false);
    });

    test('isConflictMergeState: dirty requires mergeable false; named conflict states always conflict', function() {
        var m = loadPureHelpers();
        assert.equal(m.isConflictMergeState(false, 'dirty'), true);
        assert.equal(m.isConflictMergeState(true, 'dirty'), false);
        assert.equal(m.isConflictMergeState(null, 'cannot_be_merged'), true);
        assert.equal(m.isConflictMergeState(true, 'conflict'), true);
        assert.equal(m.isConflictMergeState(false, 'clean'), false);
    });

    test('resolveCustomParams: jobParams win over params, defaulting to {}', function() {
        var m = loadPureHelpers();
        assert.deepEqual(m.resolveCustomParams({ jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } }), { a: 1 });
        assert.deepEqual(m.resolveCustomParams({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(m.resolveCustomParams({}), {});
        assert.deepEqual(m.resolveCustomParams({ jobParams: {} }), {});
    });
});

// ── gh-964: characterization tests for the CI gate and merge-decision paths ──

suite('mergeStoryTestAutomationPR: attemptMerge CI and merge-decision paths (gh-964)', function() {

    var PR = { number: 42, head: { ref: 'test/TS-40' }, html_url: 'https://github.com/IstiN/trackstate/pull/42' };

    function ciHarness(mocks) {
        return loadMergeStoryTestAutomationPR(Object.assign({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') {
                    return 'https://github.com/IstiN/trackstate.git';
                }
                return '';
            },
            github_list_prs: function() { return [PR]; },
            github_merge_pr: function() {},
            github_remove_pr_label: function() {},
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function() {},
            jira_remove_label: function() {},
            jira_add_label: function() {},
            jira_post_comment: function() {}
        }, mocks));
    }

    function attemptParams() {
        return { ticket: { key: 'TS-40' }, jobParams: { customParams: {} } };
    }

    test('undetermined state + failing check run → ci_failed with failedNames', function() {
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: null, mergeable_state: 'unknown', head: { sha: 'abc123' } }; },
            github_get_commit_check_runs: function() {
                return [{ name: 'build', status: 'completed', conclusion: 'failure' }];
            }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'ci_failed');
        assert.equal(r.prNumber, 42);
        assert.deepEqual(r.failedNames, ['build']);
    });

    test('undetermined state + in-progress check run → ci_running', function() {
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: null, mergeable_state: 'checking', head: { sha: 'abc123' } }; },
            github_get_commit_check_runs: function() {
                return [
                    { name: 'unit', status: 'completed', conclusion: 'success' },
                    { name: 'e2e', status: 'in_progress', conclusion: '' }
                ];
            }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'ci_running');
    });

    test('undetermined state + zero check runs → ci_running', function() {
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: null, mergeable_state: 'blocked', head: { sha: 'abc123' } }; },
            github_get_commit_check_runs: function() { return []; }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'ci_running');
    });

    test('undetermined state + all checks passed → not_ready', function() {
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: null, mergeable_state: 'ci_still_running', head: { sha: 'abc123' } }; },
            github_get_commit_check_runs: function() {
                return [{ name: 'unit', status: 'completed', conclusion: 'success' }];
            }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'not_ready');
    });

    test('check runs may arrive as a JSON string (wrapped or bare array)', function() {
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: null, mergeable_state: 'unstable', head: { sha: 'abc123' } }; },
            github_get_commit_check_runs: function() {
                return JSON.stringify({ check_runs: [{ name: 'lint', status: 'completed', conclusion: 'failure' }] });
            }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.reason, 'ci_failed');
        assert.deepEqual(r.failedNames, ['lint']);
    });

    test('undetermined state without a headSha still gates (no check-run call possible)', function() {
        var checkRunsCalled = false;
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: null, mergeable_state: 'preparing' }; },
            github_get_commit_check_runs: function() { checkRunsCalled = true; return []; }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'ci_running');
        assert.equal(checkRunsCalled, false, 'guard short-circuits before the SCM call without a sha');
    });

    test('behind state requests a branch update and reports behind', function() {
        var updates = [];
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'behind', head: { sha: 'abc123' } }; },
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') {
                    return 'https://github.com/IstiN/trackstate.git';
                }
                updates.push(opts.command);
                return '';
            }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'behind');
        assert.equal(updates.length, 1);
        assert.contains(updates[0], 'pulls/42/update-branch');
    });

    test('behind state on a provider without updateBranch still reports behind', function() {
        var m = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') {
                    return 'https://github.com/IstiN/trackstate.git';
                }
                return '';
            },
            github_list_prs: function() { return [PR]; },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'behind', head: { sha: 'abc123' } }; },
            ado_search_by_wiql: function() { return []; },
            ado_move_to_state: function() {},
            ado_remove_work_item_label: function() {},
            ado_add_work_item_label: function() {},
            ado_add_work_item_comment: function() {},
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function() {},
            jira_remove_label: function() {},
            jira_add_label: function() {},
            jira_post_comment: function() {}
        });

        var r = m.attemptMerge({
            ticket: { key: 'TS-40' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });

        assert.equal(r.success, false);
        assert.equal(r.reason, 'behind');
    });

    test('merge error containing "conflict" → conflict without re-checking CI', function() {
        var checkRunsCalled = false;
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean', head: { sha: 'abc123' } }; },
            github_merge_pr: function() { throw new Error('Merge conflict detected'); },
            github_get_commit_check_runs: function() { checkRunsCalled = true; return []; }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'conflict');
        assert.equal(checkRunsCalled, false, 'a conflict never triggers a CI re-check');
    });

    test('CI-blocking merge error + failing checks → ci_failed', function() {
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean', head: { sha: 'abc123' } }; },
            github_merge_pr: function() { throw new Error('Resource blocked by required checks'); },
            github_get_commit_check_runs: function() {
                return [{ name: 'e2e', status: 'completed', conclusion: 'timed_out' }];
            }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'ci_failed');
        assert.deepEqual(r.failedNames, ['e2e']);
    });

    test('CI-blocking merge error + in-progress checks → ci_running', function() {
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean', head: { sha: 'abc123' } }; },
            github_merge_pr: function() { throw new Error('HTTP 422'); },
            github_get_commit_check_runs: function() {
                return [{ name: 'unit', status: 'queued', conclusion: '' }];
            }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'ci_running');
    });

    test('CI-blocking merge error + all checks green → merge_failed', function() {
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean', head: { sha: 'abc123' } }; },
            github_merge_pr: function() { throw new Error('blocked'); },
            github_get_commit_check_runs: function() {
                return [{ name: 'unit', status: 'completed', conclusion: 'success' }];
            }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'merge_failed');
        assert.equal(r.error, 'Error: blocked');
    });

    test('plain merge error → merge_failed without a CI re-check', function() {
        var checkRunsCalled = false;
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean', head: { sha: 'abc123' } }; },
            github_merge_pr: function() { throw new Error('network timeout'); },
            github_get_commit_check_runs: function() { checkRunsCalled = true; return []; }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false);
        assert.equal(r.reason, 'merge_failed');
        assert.equal(checkRunsCalled, false);
    });

    test('getPr failure is tolerated — mergeable stays unknown and the CI gate decides', function() {
        var merges = [];
        var m = ciHarness({
            github_get_pr: function() { throw new Error('boom'); },
            github_merge_pr: function(args) { merges.push(args); }
        });

        var r = m.attemptMerge(attemptParams());

        assert.equal(r.success, false, 'an unread PR detail is treated as an undetermined merge state');
        assert.equal(r.reason, 'ci_running', 'no headSha and no check runs means still running');
        assert.deepEqual(merges, [], 'the merge is not attempted while the state is undetermined');
    });

    test('action: ci_failed moves the ticket to In Rework and lists the failed checks', function() {
        var statusMoves = [];
        var comments = [];
        var m = ciHarness({
            github_get_pr: function() { return { mergeable: null, mergeable_state: 'unknown', head: { sha: 'abc123' } }; },
            github_get_commit_check_runs: function() {
                return [{ name: 'unit', status: 'completed', conclusion: 'failure' }];
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); }
        });

        var r = m.action({
            ticket: { key: 'TS-40' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.equal(r, true);
        assert.deepEqual(statusMoves, [{ key: 'TS-40', statusName: 'In Rework' }]);
        assert.ok(comments[0].indexOf('MERGE FAILED') !== -1);
        assert.ok(comments[0].indexOf('required checks failed: unit') !== -1);
    });
});

// ── gh-1186: CRAP-reduction — merge-outcome helpers (characterization) ──────

suite('mergeStoryTestAutomationPR: merge-outcome helpers (gh-1186)', function() {

    var PR42 = { number: 42, html_url: 'https://github.com/IstiN/trackstate/pull/42' };

    function loadHelpers() {
        return loadMergeStoryTestAutomationPR({});
    }

    test('undeterminedMergeOutcome: failing checks → ci_failed with failedNames', function() {
        var m = loadHelpers();
        var scm = { getCommitCheckRuns: function() {
            return [{ name: 'build', status: 'completed', conclusion: 'failure' }];
        } };
        var r = m.undeterminedMergeOutcome(scm, PR42, { headSha: 'abc123', mergeableState: 'unknown' });
        assert.deepEqual(r, { success: false, reason: 'ci_failed', prNumber: 42, prUrl: PR42.html_url, failedNames: ['build'] });
    });

    test('undeterminedMergeOutcome: pending checks → ci_running', function() {
        var m = loadHelpers();
        var scm = { getCommitCheckRuns: function() {
            return [{ name: 'unit', status: 'queued', conclusion: '' }];
        } };
        var r = m.undeterminedMergeOutcome(scm, PR42, { headSha: 'abc123', mergeableState: 'checking' });
        assert.deepEqual(r, { success: false, reason: 'ci_running', prNumber: 42, prUrl: PR42.html_url });
    });

    test('undeterminedMergeOutcome: green checks → not_ready', function() {
        var m = loadHelpers();
        var scm = { getCommitCheckRuns: function() {
            return [{ name: 'unit', status: 'completed', conclusion: 'success' }];
        } };
        var r = m.undeterminedMergeOutcome(scm, PR42, { headSha: 'abc123', mergeableState: 'blocked' });
        assert.deepEqual(r, { success: false, reason: 'not_ready', prNumber: 42, prUrl: PR42.html_url });
    });

    test('staticMergeStateOutcome: behind requests a branch update and reports behind', function() {
        var m = loadHelpers();
        var updates = [];
        var scm = { updateBranch: function(prNumber, owner, repo) { updates.push([prNumber, owner, repo]); } };
        var r = m.staticMergeStateOutcome(scm, { owner: 'IstiN', repo: 'trackstate' }, PR42, { mergeableState: 'behind' });
        assert.deepEqual(r, { success: false, reason: 'behind', prNumber: 42, prUrl: PR42.html_url });
        assert.deepEqual(updates, [[42, 'IstiN', 'trackstate']]);
    });

    test('staticMergeStateOutcome: conflict states report conflict without side effects', function() {
        var m = loadHelpers();
        var r = m.staticMergeStateOutcome({}, { owner: 'o', repo: 'r' }, PR42, { mergeable: false, mergeableState: 'dirty' });
        assert.deepEqual(r, { success: false, reason: 'conflict', prNumber: 42, prUrl: PR42.html_url });
        var r2 = m.staticMergeStateOutcome({}, null, PR42, { mergeable: true, mergeableState: 'conflict' });
        assert.equal(r2.reason, 'conflict');
    });

    test('staticMergeStateOutcome: clean state returns null — merge proceeds', function() {
        var m = loadHelpers();
        assert.equal(m.staticMergeStateOutcome({}, null, PR42, { mergeable: true, mergeableState: 'clean' }), null);
    });

    test('ciRetryOutcome: a conflict never re-checks CI', function() {
        var m = loadHelpers();
        var called = false;
        var scm = { getCommitCheckRuns: function() { called = true; return []; } };
        var r = m.ciRetryOutcome(scm, 'abc', { isConflict: true, isCIBlocking: false, errMsg: 'Merge conflict' }, 42, 'u');
        assert.equal(r, null);
        assert.equal(called, false);
    });

    test('ciRetryOutcome: non-CI non-empty errors do not re-check CI', function() {
        var m = loadHelpers();
        var called = false;
        var scm = { getCommitCheckRuns: function() { called = true; return []; } };
        var r = m.ciRetryOutcome(scm, 'abc', { isConflict: false, isCIBlocking: false, errMsg: 'network timeout' }, 42, 'u');
        assert.equal(r, null);
        assert.equal(called, false);
    });

    test('ciRetryOutcome: CI-blocking error maps check results to ci_failed / ci_running', function() {
        var m = loadHelpers();
        var failing = { getCommitCheckRuns: function() {
            return [{ name: 'e2e', status: 'completed', conclusion: 'timed_out' }];
        } };
        assert.deepEqual(
            m.ciRetryOutcome(failing, 'abc', { isConflict: false, isCIBlocking: true, errMsg: '422' }, 42, 'u'),
            { success: false, reason: 'ci_failed', prNumber: 42, prUrl: 'u', failedNames: ['e2e'] });

        var running = { getCommitCheckRuns: function() {
            return [{ name: 'unit', status: 'queued', conclusion: '' }];
        } };
        assert.deepEqual(
            m.ciRetryOutcome(running, 'abc', { isConflict: false, isCIBlocking: true, errMsg: '422' }, 42, 'u'),
            { success: false, reason: 'ci_running', prNumber: 42, prUrl: 'u' });
    });

    test('ciRetryOutcome: green checks leave the decision to the caller (null); absent checks read as running', function() {
        var m = loadHelpers();
        var green = { getCommitCheckRuns: function() {
            return [{ name: 'unit', status: 'completed', conclusion: 'success' }];
        } };
        assert.equal(m.ciRetryOutcome(green, 'abc', { isConflict: false, isCIBlocking: true, errMsg: 'blocked' }, 42, 'u'), null);
        var none = { getCommitCheckRuns: function() { return []; } };
        assert.deepEqual(
            m.ciRetryOutcome(none, 'abc', { isConflict: false, isCIBlocking: true, errMsg: 'blocked' }, 42, 'u'),
            { success: false, reason: 'ci_running', prNumber: 42, prUrl: 'u' });
    });

    test('mergeFailureOutcome: conflict vs merge_failed, error text carried through', function() {
        var m = loadHelpers();
        assert.deepEqual(
            m.mergeFailureOutcome({ isConflict: true, errMsg: 'conflict!' }, 42, 'u'),
            { success: false, reason: 'conflict', prNumber: 42, prUrl: 'u', error: 'conflict!' });
        assert.deepEqual(
            m.mergeFailureOutcome({ isConflict: false, errMsg: 'boom' }, 42, 'u'),
            { success: false, reason: 'merge_failed', prNumber: 42, prUrl: 'u', error: 'boom' });
    });

    test('isRetryPendingReason / isMissingPrerequisiteReason truth tables', function() {
        var m = loadHelpers();
        assert.equal(m.isRetryPendingReason('ci_running'), true);
        assert.equal(m.isRetryPendingReason('behind'), true);
        assert.equal(m.isRetryPendingReason('not_ready'), true);
        assert.equal(m.isRetryPendingReason('conflict'), false);
        assert.equal(m.isRetryPendingReason('merge_failed'), false);
        assert.equal(m.isRetryPendingReason('ci_failed'), false);
        assert.equal(m.isRetryPendingReason(undefined), false);
        assert.equal(m.isMissingPrerequisiteReason('missing_key'), true);
        assert.equal(m.isMissingPrerequisiteReason('no_repo'), true);
        assert.equal(m.isMissingPrerequisiteReason('conflict'), false);
        assert.equal(m.isMissingPrerequisiteReason(undefined), false);
    });

    test('issueTypeNameOf: full chain, partial ticket, missing ticket', function() {
        var m = loadHelpers();
        assert.equal(m.issueTypeNameOf({ ticket: { fields: { issuetype: { name: 'Bug' } } } }), 'Bug');
        assert.equal(m.issueTypeNameOf({ ticket: { fields: { issuetype: {} } } }), undefined);
        assert.equal(m.issueTypeNameOf({ ticket: { fields: {} } }), undefined);
        assert.equal(m.issueTypeNameOf({ ticket: {} }), undefined);
        assert.equal(m.issueTypeNameOf({}), undefined);
    });

    test('reworkSkipLabelOf: Bug vs everything else', function() {
        var m = loadHelpers();
        var issueTypes = { BUG: 'Bug' };
        assert.equal(m.reworkSkipLabelOf('Bug', { issueTypes: issueTypes }), 'sm_bug_test_rework_triggered');
        assert.equal(m.reworkSkipLabelOf('Story', { issueTypes: issueTypes }), 'sm_story_test_rework_triggered');
        assert.equal(m.reworkSkipLabelOf(null, { issueTypes: issueTypes }), 'sm_story_test_rework_triggered');
    });

    test('reworkFailureComment: conflict panel, ci_failed panel with check names, unknown PR', function() {
        var m = loadHelpers();
        var conflict = m.reworkFailureComment({ reason: 'conflict', prNumber: 42, prUrl: 'u' });
        assert.contains(conflict, 'MERGE CONFLICT');
        assert.contains(conflict, 'Could not merge PR #42');
        assert.contains(conflict, '[View PR|u]');
        assert.contains(conflict, 'merge conflict');

        var ciFailed = m.reworkFailureComment({ reason: 'ci_failed', prNumber: 42, failedNames: ['unit', 'e2e'] });
        assert.contains(ciFailed, 'MERGE FAILED');
        assert.contains(ciFailed, 'required checks failed: unit, e2e');
        assert.notContains(ciFailed, '[View PR|', 'no PR link without prUrl');

        var bare = m.reworkFailureComment({ reason: 'merge_failed' });
        assert.contains(bare, 'PR #unknown');
        assert.contains(bare, 'CI checks failing or PR not mergeable');
    });

    test('removePrLabelSafe: removes when a PR number is present, no-op and error-safe otherwise', function() {
        var m = loadHelpers();
        var removed = [];
        m.removePrLabelSafe({ removeLabel: function(n, l) { removed.push([n, l]); } }, 42);
        assert.deepEqual(removed, [[42, 'pr_approved']]);

        removed.length = 0;
        m.removePrLabelSafe({ removeLabel: function() { removed.push('called'); } }, null);
        assert.deepEqual(removed, [], 'no PR number — no removal call');

        m.removePrLabelSafe({ removeLabel: function() { throw new Error('provider down'); } }, 42);
    });
});

// ── gh-1186: CRAP-reduction — action/attemptMerge outcome mapping ───────────

suite('mergeStoryTestAutomationPR: action/attemptMerge outcome mapping (gh-1186)', function() {

    function outcomeHarness(mocks) {
        return loadMergeStoryTestAutomationPR(Object.assign({
            cli_execute_command: function() { return ''; },
            github_list_prs: function() { return []; },
            github_get_pr: function() { return {}; },
            github_merge_pr: function() {},
            github_remove_pr_label: function() {},
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function() {},
            jira_remove_label: function() {},
            jira_add_label: function() {},
            jira_post_comment: function() {}
        }, mocks));
    }

    test('attemptMerge: missing ticket key → missing_key', function() {
        var m = outcomeHarness({});
        var r = m.attemptMerge({ ticket: {}, jobParams: {} });
        assert.deepEqual(r, { success: false, reason: 'missing_key' });
    });

    test('attemptMerge: unresolvable remote → no_repo', function() {
        var m = outcomeHarness({});
        var r = m.attemptMerge({ ticket: { key: 'TS-40' }, jobParams: {} });
        assert.deepEqual(r, { success: false, reason: 'no_repo' });
    });

    test('action: onlyAttemptMerge returns the raw merge outcome', function() {
        var m = outcomeHarness({});
        var r = m.action({ ticket: { key: 'TS-40' }, jobParams: { customParams: { onlyAttemptMerge: true } } });
        assert.deepEqual(r, { success: false, reason: 'no_repo' });
    });

    test('action: missing ticket key → false', function() {
        var m = outcomeHarness({});
        assert.equal(m.action({ ticket: {}, jobParams: {} }), false);
    });

    test('action: retry-pending outcomes keep the lock and return false without a rework comment', function() {
        var comments = [];
        var m = outcomeHarness({
            cli_execute_command: function(opts) {
                return opts.command === 'git config --get remote.origin.url' ? 'https://github.com/IstiN/trackstate.git' : '';
            },
            github_list_prs: function() { return [{ number: 42, head: { ref: 'test/TS-40' } }]; },
            github_get_pr: function() { return { mergeable: null, mergeable_state: 'unknown' }; },
            jira_post_comment: function(args) { comments.push(args.comment); }
        });
        assert.equal(m.action({ ticket: { key: 'TS-40' }, jobParams: { customParams: {} } }), false);
        assert.deepEqual(comments, [], 'no rework comment while the SM should simply retry');
    });

    test('action: no_repo releases the lock and returns false', function() {
        var removed = [];
        var m = outcomeHarness({
            jira_remove_label: function(args) { removed.push(args); }
        });
        assert.equal(m.action({ ticket: { key: 'TS-40' }, jobParams: { customParams: { removeLabel: 'sm_lock' } } }), false);
        assert.deepEqual(removed, [{ key: 'TS-40', label: 'sm_lock' }]);
    });

    test('action: missing_key releases the lock and returns false', function() {
        var removed = [];
        var m = outcomeHarness({
            jira_remove_label: function(args) { removed.push(args); }
        });
        assert.equal(m.action({ ticket: {}, jobParams: { customParams: { removeLabel: 'sm_lock' } } }), false);
        assert.deepEqual(removed, [], 'nothing to release without a story key');
    });

    test('action: merge_failed rework removes the PR label and both tracker labels in order', function() {
        var labelsRemoved = [];
        var labelsAdded = [];
        var prLabelsRemoved = [];
        var m = outcomeHarness({
            cli_execute_command: function(opts) {
                return opts.command === 'git config --get remote.origin.url' ? 'https://github.com/IstiN/trackstate.git' : '';
            },
            github_list_prs: function() { return [{ number: 42, head: { ref: 'test/TS-40' } }]; },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            github_merge_pr: function() { throw new Error('network timeout'); },
            github_remove_pr_label: function(opts) { prLabelsRemoved.push(opts); },
            jira_remove_label: function(args) { labelsRemoved.push(args.label); },
            jira_add_label: function(args) { labelsAdded.push(args.label); },
            jira_post_comment: function() {},
            jira_move_to_status: function() {}
        });
        assert.equal(m.action({
            ticket: { key: 'TS-40', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        }), true);
        assert.equal(prLabelsRemoved.length, 1);
        assert.equal(prLabelsRemoved[0].pullRequestId, '42');
        assert.equal(prLabelsRemoved[0].label, 'pr_approved');
        assert.deepEqual(labelsRemoved, ['pr_approved', 'sm_story_test_rework_triggered']);
        assert.deepEqual(labelsAdded, ['test_pr_rework_needed']);
    });
});
