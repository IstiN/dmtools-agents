function d4TrackersWith(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
                                                             'trackerHolder.js': loadModule('js/common/trackerHolder.js'),
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

/**
 * Unit tests for js/prepareTestPRForReview.js
 */

function loadPrepareTestPRForReview(mocks) {
    var defaults = {
        jira_get_ticket: function() { return { fields: { status: { name: 'In Testing' } } }; },
        jira_move_to_status: function() {},
        jira_post_comment: function() {},
        jira_add_label: function() {},
        cli_execute_command: function() { return ''; },
        file_read: function() { return null; },
        file_write: function() {}
    };

    var allMocks = Object.assign({}, defaults, mocks);

    var scmMock = Object.assign({
        getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'trackstate' }; },
        listPrs: function() { return []; }
    }, mocks && mocks.scmMock || {});

    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
                      'trackerHolder.js': loadModule('js/common/trackerHolder.js'),
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return scmMock; } }
        }),
        { file_read: function() { return null; } }
    );

    var prHelper = loadModule(
        'js/common/pullRequest.js',
        makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
                      'trackerHolder.js': loadModule('js/common/trackerHolder.js'),
            './config.js': configModule,
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './common/mergeState.js': loadModule('js/common/mergeState.js')
        }),
        // gh-965: delegate to the caller's cli mock so tests can script the
        // `gh pr create` path exercised when a branch exists without a PR.
        { cli_execute_command: allMocks.cli_execute_command, jira_search_by_jql: allMocks.jira_search_by_jql, file_write: allMocks.file_write }
    );

    var githubHelpers = Object.assign({
        getPRDetails: function() { return null; },
        fetchDiscussionsAndRawData: function() { return { markdown: '', rawThreads: {} }; }
    }, mocks && mocks.githubHelpers || {});

    var gitOpsMock = Object.assign({
        writePRContext: function() {},
        checkoutPRBranch: function() {},
        getPRDiff: function() { return ''; }
    }, mocks && mocks.gitOpsMock || {});

    return loadModule(
        'js/prepareTestPRForReview.js',
        makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
                      'trackerHolder.js': loadModule('js/common/trackerHolder.js'),
            './config.js': configModule,
            './configLoader.js': freshConfigLoader,
            './common/githubHelpers.js': githubHelpers,
            './common/gitOps.js': gitOpsMock,
            './common/scm.js': { createScm: function() { return scmMock; } },
            './common/pullRequest.js': prHelper,
            './common/trackers.js': d4TrackersWith(allMocks)
        }),
        allMocks
    );
}

suite('prepareTestPRForReview', function() {

    test('finalizes Story ticket when open test PR has zero changed files', function() {
        var statusMoves = [];
        var comments = [];
        var commands = [];
        var labelsAdded = [];

        var module = loadPrepareTestPRForReview({
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_add_label: function(args) { labelsAdded.push(args); },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command.indexOf('git push origin --delete') === 0) return '';
                if (opts.command.indexOf('rm -f') === 0) return '';
                return '';
            },
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') {
                        return [{ number: 55, head: { ref: 'test/TS-90' }, html_url: 'https://github.com/IstiN/trackstate/pull/55' }];
                    }
                    return [];
                }
            },
            githubHelpers: {
                getPRDetails: function(scm, prNumber) {
                    return {
                        number: 55,
                        changed_files: 0,
                        head: { ref: 'test/TS-90' },
                        base: { ref: 'main' },
                        html_url: 'https://github.com/IstiN/trackstate/pull/55'
                    };
                }
            }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-90',
            ticket: { key: 'TS-90', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result, false);
        assert.deepEqual(statusMoves, [{ key: 'TS-90', statusName: 'In Testing' }]);
        assert.ok(commands.some(function(c) { return c === 'git push origin --delete test/TS-90'; }));
        assert.ok(comments.some(function(c) { return c.indexOf('already in main') !== -1; }));
        assert.deepEqual(labelsAdded, [{ key: 'TS-90', label: 'test_pr_merged' }]);
    });

    test('adds test_pr_merged label when PR is already merged', function() {
        var labelsAdded = [];
        var statusMoves = [];

        var module = loadPrepareTestPRForReview({
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_add_label: function(args) { labelsAdded.push(args); },
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') return [];
                    return [{ number: 57, head: { ref: 'test/TS-92' }, html_url: 'https://github.com/IstiN/trackstate/pull/57', merged_at: '2026-06-21T14:00:00Z' }];
                }
            }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-92',
            ticket: { key: 'TS-92', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result, false);
        assert.deepEqual(labelsAdded, [{ key: 'TS-92', label: 'test_pr_merged' }]);
        assert.deepEqual(statusMoves, [{ key: 'TS-92', statusName: 'In Testing' }]);
    });

    test('proceeds with review when PR has changed files', function() {
        var contextWritten = false;

        var module = loadPrepareTestPRForReview({
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') {
                        return [{ number: 56, head: { ref: 'test/TS-91' }, html_url: 'https://github.com/IstiN/trackstate/pull/56' }];
                    }
                    return [];
                }
            },
            githubHelpers: {
                getPRDetails: function() {
                    return {
                        number: 56,
                        changed_files: 2,
                        head: { ref: 'test/TS-91' },
                        base: { ref: 'main' },
                        html_url: 'https://github.com/IstiN/trackstate/pull/56'
                    };
                }
            },
            gitOpsMock: {
                getPRDiff: function() { return 'diff --git a/testing/tests/TS-91/test.ts b/testing/tests/TS-91/test.ts\n+++ b/testing/tests/TS-91/test.ts\n@@ -1 +1 @@\n-old\n+new\n'; },
                writePRContext: function() { contextWritten = true; }
            }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-91',
            ticket: { key: 'TS-91', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(result.prNumber, 56);
        assert.equal(contextWritten, true);
    });

    test('ado: merged PR -> ado_add_work_item_label / ado_get_work_item / ado_move_to_state, no jira_*', function() {
        var calls = [];
        function forbid(n) { return function() { throw new Error(n + ' must not be called on ado'); }; }
        var module = loadPrepareTestPRForReview({
            ado_add_work_item_label: function(a) { calls.push({ tool: 'add', args: a }); },
            ado_get_work_item: function(a) { calls.push({ tool: 'get', args: a }); return { id: 92, fields: { 'System.Title': 't', 'System.State': 'In Review' } }; },
            ado_move_to_state: function(a) { calls.push({ tool: 'move', args: a }); },
            ado_add_work_item_comment: function(a) { calls.push({ tool: 'comment', args: a }); },
            jira_get_ticket: forbid('jira_get_ticket'),
            jira_move_to_status: forbid('jira_move_to_status'),
            jira_add_label: forbid('jira_add_label'),
            jira_post_comment: forbid('jira_post_comment'),
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') return [];
                    return [{ number: 57, head: { ref: 'test/92' }, html_url: 'https://github.com/IstiN/trackstate/pull/57', merged_at: '2026-06-21T14:00:00Z' }];
                }
            }
        });
        var result = module.action({
            inputFolderPath: 'input/92',
            ticket: { key: '92', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(result, false);
        assert.deepEqual(calls.filter(function(c) { return c.tool === 'add'; })[0].args, { id: '92', label: 'test_pr_merged' });
        assert.deepEqual(calls.filter(function(c) { return c.tool === 'move'; })[0].args, { id: '92', state: 'In Testing' });
    });

    // ── gh-965: no-PR / setup-failure characterization ─────────────────────
    test('no PR and no remote branch → In Rework + re-automation comment, returns false', function() {
        var statusMoves = [];
        var comments = [];

        var module = loadPrepareTestPRForReview({
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); },
            cli_execute_command: function() { return ''; }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-93',
            ticket: { key: 'TS-93', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result, false);
        assert.deepEqual(statusMoves, [{ key: 'TS-93', statusName: 'In Rework' }]);
        assert.ok(comments.some(function(c) { return c.indexOf('re-automation') !== -1; }));
    });

    test('branch exists without PR → creates PR via gh, refetches it and proceeds with review', function() {
        var commands = [];
        var comments = [];
        var contextWritten = false;
        var openCalls = 0;

        var module = loadPrepareTestPRForReview({
            jira_post_comment: function(args) { comments.push(args.comment); },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-94') === 0) {
                    return 'abc123\trefs/heads/test/TS-94';
                }
                if (opts.command.indexOf('gh pr list --head test/TS-94') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) return 'https://github.com/IstiN/trackstate/pull/61';
                return '';
            },
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') {
                        openCalls++;
                        if (openCalls >= 2) {
                            return [{ number: 61, head: { ref: 'test/TS-94' }, html_url: 'https://github.com/IstiN/trackstate/pull/61' }];
                        }
                        return [];
                    }
                    return [];
                }
            },
            githubHelpers: {
                getPRDetails: function() {
                    return {
                        number: 61,
                        changed_files: 3,
                        head: { ref: 'test/TS-94' },
                        base: { ref: 'main' },
                        html_url: 'https://github.com/IstiN/trackstate/pull/61'
                    };
                }
            },
            gitOpsMock: {
                writePRContext: function() { contextWritten = true; }
            }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-94',
            ticket: { key: 'TS-94', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(result.prNumber, 61);
        assert.equal(contextWritten, true);
        assert.ok(commands.some(function(c) { return c.indexOf('gh pr create') === 0; }), 'must create the missing PR');
        assert.ok(commands.some(function(c) { return c.indexOf('git ls-remote --heads origin test/TS-94') === 0; }));
        assert.ok(comments.some(function(c) { return c.indexOf('Review Started') !== -1; }));
    });

    test('branch without commits ahead of main (No commits between) → finalize as already merged, returns false', function() {
        var labelsAdded = [];
        var statusMoves = [];
        var commands = [];

        var module = loadPrepareTestPRForReview({
            jira_add_label: function(args) { labelsAdded.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-95') === 0) {
                    return 'abc123\trefs/heads/test/TS-95';
                }
                if (opts.command.indexOf('gh pr list --head test/TS-95') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) {
                    throw new Error('No commits between main and test/TS-95');
                }
                return '';
            }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-95',
            ticket: { key: 'TS-95', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result, false);
        assert.deepEqual(labelsAdded, [{ key: 'TS-95', label: 'test_pr_merged' }]);
        assert.deepEqual(statusMoves, [{ key: 'TS-95', statusName: 'In Testing' }]);
        assert.ok(commands.some(function(c) { return c === 'git push origin --delete test/TS-95'; }));
    });

    test('PR creation failure → setup-failed comment, returns false (no status move)', function() {
        var comments = [];
        var statusMoves = [];

        var module = loadPrepareTestPRForReview({
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            cli_execute_command: function(opts) {
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-96') === 0) {
                    return 'abc123\trefs/heads/test/TS-96';
                }
                if (opts.command.indexOf('gh pr list --head test/TS-96') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) throw new Error('HTTP 500 boom');
                return '';
            }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-96',
            ticket: { key: 'TS-96', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result, false);
        assert.deepEqual(statusMoves, [], 'no status move on setup failure');
        assert.ok(comments.some(function(c) { return c.indexOf('could not create PR') !== -1; }));
    });

    test('WIP/draft PR → skip comment, returns false', function() {
        var comments = [];

        var module = loadPrepareTestPRForReview({
            jira_post_comment: function(args) { comments.push(args.comment); },
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') {
                        return [{ number: 62, draft: true, head: { ref: 'test/TS-97' }, html_url: 'https://github.com/IstiN/trackstate/pull/62' }];
                    }
                    return [];
                }
            }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-97',
            ticket: { key: 'TS-97', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result, false);
        assert.ok(comments.some(function(c) { return c.indexOf('WIP/draft') !== -1; }));
    });

    test('unfetchable PR details → setup-failed comment, returns false', function() {
        var comments = [];

        var module = loadPrepareTestPRForReview({
            jira_post_comment: function(args) { comments.push(args.comment); },
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') {
                        return [{ number: 63, head: { ref: 'test/TS-98' }, html_url: 'https://github.com/IstiN/trackstate/pull/63' }];
                    }
                    return [];
                }
            },
            githubHelpers: {
                getPRDetails: function() { return null; }
            }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-98',
            ticket: { key: 'TS-98', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result, false);
        assert.ok(comments.some(function(c) { return c.indexOf('Could not fetch details') !== -1; }));
    });

    test('push failure while finalizing already-merged test code does not abort the finalization', function() {
        var labelsAdded = [];
        var statusMoves = [];

        var module = loadPrepareTestPRForReview({
            jira_add_label: function(args) { labelsAdded.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            cli_execute_command: function(opts) {
                if (opts.command.indexOf('git push origin --delete') === 0) throw new Error('remote refused');
                return '';
            },
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') {
                        return [{ number: 64, head: { ref: 'test/TS-99' }, html_url: 'https://github.com/IstiN/trackstate/pull/64' }];
                    }
                    return [];
                }
            },
            githubHelpers: {
                getPRDetails: function() {
                    return {
                        number: 64,
                        changed_files: 0,
                        head: { ref: 'test/TS-99' },
                        base: { ref: 'main' },
                        html_url: 'https://github.com/IstiN/trackstate/pull/64'
                    };
                }
            }
        });

        var result = module.action({
            inputFolderPath: 'input/TS-99',
            ticket: { key: 'TS-99', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });

        assert.equal(result, false);
        assert.deepEqual(labelsAdded, [{ key: 'TS-99', label: 'test_pr_merged' }]);
        assert.deepEqual(statusMoves, [{ key: 'TS-99', statusName: 'In Testing' }]);
    });
});

// ── gh-1077: isWip characterization through action() ─────────────────────────
suite('prepareTestPRForReview isWip — WIP/draft characterization (gh-1077)', function() {

    function wipAction(prExtra, ticketExtra, extraMocks) {
        var comments = [];
        var mocks = Object.assign({
            jira_post_comment: function(args) { comments.push(args.comment); },
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') {
                        return [Object.assign({
                            number: 70,
                            title: 'Test changes',
                            head: { ref: 'test/TS-70' },
                            html_url: 'https://github.com/IstiN/trackstate/pull/70'
                        }, prExtra || {})];
                    }
                    return [];
                }
            }
        }, extraMocks || {});
        var module = loadPrepareTestPRForReview(mocks);
        var ticket = Object.assign({ key: 'TS-70', fields: { issuetype: { name: 'Story' } } }, ticketExtra || {});
        var result = module.action({
            inputFolderPath: 'input/TS-70',
            ticket: ticket,
            jobParams: { customParams: {} }
        });
        return { result: result, comments: comments };
    }

    test('WIP title without a draft flag → skip comment, returns false', function() {
        var out = wipAction({ title: 'WIP: not ready' });
        assert.equal(out.result, false);
        assert.ok(out.comments.some(function(c) { return c.indexOf('WIP/draft') !== -1; }));
    });

    test('draft: title prefix is case-insensitive', function() {
        var out = wipAction({ title: 'draft: tweaks' });
        assert.equal(out.result, false);
        assert.ok(out.comments.some(function(c) { return c.indexOf('WIP/draft') !== -1; }));
    });

    test('title merely containing the letters (Swip) is not WIP', function() {
        var out = wipAction({ title: 'Swipeland fixes', draft: false }, {}, {
            githubHelpers: {
                getPRDetails: function() {
                    return { number: 70, changed_files: 1, head: { ref: 'test/TS-70' }, base: { ref: 'main' }, html_url: 'u' };
                }
            }
        });
        assert.equal(out.result.success, true);
    });

    test('leading whitespace before the WIP prefix still matches', function() {
        var out = wipAction({ title: '  WIP stuff' });
        assert.equal(out.result, false);
    });

    test('ADO-shaped ticket labels {value:[...]} with a _wip label → skip', function() {
        var out = wipAction({}, { labels: { value: ['team', 'pr_review_wip'] } });
        assert.equal(out.result, false);
        assert.ok(out.comments.some(function(c) { return c.indexOf('WIP/draft') !== -1; }));
    });

    test('array ticket labels with a _draft suffix → skip', function() {
        var out = wipAction({}, { labels: ['x', 'test_draft'] });
        assert.equal(out.result, false);
    });

    test('bare wip label → skip', function() {
        var out = wipAction({}, { labels: ['wip'] });
        assert.equal(out.result, false);
    });

    test('plain title and non-WIP labels → review proceeds past the WIP gate', function() {
        var out = wipAction({ title: 'Ready for review' }, { labels: ['other', 'more'] }, {
            githubHelpers: {
                getPRDetails: function() {
                    return { number: 70, changed_files: 2, head: { ref: 'test/TS-70' }, base: { ref: 'main' }, html_url: 'u' };
                }
            }
        });
        assert.equal(out.result.success, true);
    });
});

// ── gh-1077: extracted pure helpers ──────────────────────────────────────────
suite('prepareTestPRForReview isWip — extracted pure helpers (gh-1077)', function() {

    test('isWipPrTitle — WIP/DRAFT word prefix, whitespace tolerant, case insensitive', function() {
        var m = loadPrepareTestPRForReview({});
        assert.equal(m.isWipPrTitle('WIP: fix'), true);
        assert.equal(m.isWipPrTitle('wip fix'), true);
        assert.equal(m.isWipPrTitle('Draft: x'), true);
        assert.equal(m.isWipPrTitle('DRAFT add'), true);
        assert.equal(m.isWipPrTitle('   WIP late'), true);
        assert.equal(m.isWipPrTitle('Swipeland'), false);
        assert.equal(m.isWipPrTitle('WIPER valve'), false);
        assert.equal(m.isWipPrTitle('drafty room'), false);
        assert.equal(m.isWipPrTitle('Ready for review'), false);
        assert.equal(m.isWipPrTitle(''), false);
    });

    test('isWipPr — draft flag, WIP title, or neither', function() {
        var m = loadPrepareTestPRForReview({});
        assert.equal(m.isWipPr(null), false);
        assert.equal(m.isWipPr({}), false);
        assert.equal(m.isWipPr({ draft: true }), true);
        assert.equal(m.isWipPr({ draft: false, title: 'WIP: x' }), true);
        assert.equal(m.isWipPr({ draft: false, title: 'clean' }), false);
        assert.equal(m.isWipPr({ title: '' }), false);
        assert.equal(m.isWipPr({ draft: true, title: '' }), true);
    });

    test('ticketLabels — array, {value}, empty/missing shapes, null ticket', function() {
        var m = loadPrepareTestPRForReview({});
        assert.deepEqual(m.ticketLabels({ labels: ['a'] }), ['a']);
        assert.deepEqual(m.ticketLabels({ labels: { value: ['a', 'b'] } }), ['a', 'b']);
        assert.deepEqual(m.ticketLabels({ labels: { value: undefined } }), []);
        assert.deepEqual(m.ticketLabels({ labels: {} }), []);
        assert.equal(m.ticketLabels({}), null);
        assert.equal(m.ticketLabels({ labels: null }), null);
        assert.equal(m.ticketLabels(null), null);
    });

    test('isWipLabel — suffixed or bare wip/draft, case insensitive', function() {
        var m = loadPrepareTestPRForReview({});
        assert.equal(m.isWipLabel('pr_review_wip'), true);
        assert.equal(m.isWipLabel('X_DRAFT'), true);
        assert.equal(m.isWipLabel('wip'), true);
        assert.equal(m.isWipLabel('draft'), true);
        assert.equal(m.isWipLabel('wiper'), false);
        assert.equal(m.isWipLabel('a_wipx'), false);
        assert.equal(m.isWipLabel('other'), false);
    });

    test('hasWipTicketLabel — finds the WIP label among several, honors shapes', function() {
        var m = loadPrepareTestPRForReview({});
        assert.equal(m.hasWipTicketLabel({ labels: ['a', 'b_wip', 'c'] }), true);
        assert.equal(m.hasWipTicketLabel({ labels: { value: ['x', 'y_draft'] } }), true);
        assert.equal(m.hasWipTicketLabel({ labels: ['a', 'b', 'c'] }), false);
        assert.equal(m.hasWipTicketLabel({ labels: [] }), false);
        assert.equal(m.hasWipTicketLabel({}), false);
        assert.equal(m.hasWipTicketLabel(null), false);
    });

    test('isWip — PR branch, ticket-label branch, both, or neither', function() {
        var m = loadPrepareTestPRForReview({});
        assert.equal(m.isWip({ draft: true }, null), true);
        assert.equal(m.isWip(null, { labels: ['b_wip'] }), true);
        assert.equal(m.isWip({ draft: false, title: 'x' }, { labels: ['ok'] }), false);
        assert.equal(m.isWip(null, null), false);
        assert.equal(m.isWip(undefined, undefined), false);
    });
});

// ── gh-1186: CRAP-reduction — ticket-key resolution & review-step helpers ────

suite('prepareTestPRForReview: ticket key resolution (gh-1186)', function() {

    test('getTicketKey: ticket.key wins, then inputFolderPath, then jobParams.inputFolderPath', function() {
        var m = loadPrepareTestPRForReview({});
        assert.equal(m.getTicketKey({ ticket: { key: 'TS-1' }, inputFolderPath: 'input/TS-2' }), 'TS-1');
        assert.equal(m.getTicketKey({ inputFolderPath: 'input/TS-2' }), 'TS-2');
        assert.equal(m.getTicketKey({ inputFolderPath: 'a/b/TS-3' }), 'TS-3');
        assert.equal(m.getTicketKey({ jobParams: { inputFolderPath: 'input/TS-4' } }), 'TS-4');
        assert.throws(function() { m.getTicketKey({}); });
        assert.throws(function() { m.getTicketKey({ ticket: {} }); });
    });
});

suite('prepareTestPRForReview: review-step helpers (gh-1186)', function() {

    test('branchRefOf / staleBranchRef / diffHeadRef', function() {
        var m = loadPrepareTestPRForReview({});
        assert.equal(m.branchRefOf({ head: { ref: 'test/X' } }), 'test/X');
        assert.equal(m.branchRefOf({ head: null }), null);
        assert.equal(m.branchRefOf({}), null);
        assert.equal(m.staleBranchRef('test/X', 'TS-1'), 'test/X');
        assert.equal(m.staleBranchRef(null, 'TS-1'), 'test/TS-1');
        assert.equal(m.diffHeadRef('test/X', { head: { ref: 'y' } }), 'test/X');
        assert.equal(m.diffHeadRef(null, { head: { ref: 'y' } }), 'y');
        assert.equal(m.diffHeadRef(null, { head: null }), null);
    });

    test('reviewStartedComment renders PR number, branch fallback and changed-file count', function() {
        var m = loadPrepareTestPRForReview({});
        var c = m.reviewStartedComment({ number: 56, html_url: 'u', changed_files: 2 }, 'test/TS-91');
        assert.contains(c, '[PR #56|u]');
        assert.contains(c, '{code}test/TS-91{code}');
        assert.contains(c, '*Files Changed*: 2');
        var fallback = m.reviewStartedComment({ number: 57, html_url: 'u2' }, null);
        assert.contains(fallback, '{code}unknown{code}');
        assert.contains(fallback, '*Files Changed*: 0');
    });

    test('reviewOutcome builds the success payload', function() {
        var m = loadPrepareTestPRForReview({});
        assert.deepEqual(
            m.reviewOutcome({ owner: 'IstiN', repo: 'trackstate' }, { number: 56, html_url: 'u' }, 'test/TS-91'),
            { success: true, prNumber: 56, prUrl: 'u', branchName: 'test/TS-91', owner: 'IstiN', repo: 'trackstate' });
    });
});

suite('prepareTestPRForReview: action error paths (gh-1186)', function() {

    test('unresolvable remote → setup-failed comment, returns false', function() {
        var comments = [];
        var module = loadPrepareTestPRForReview({
            jira_post_comment: function(args) { comments.push(args.comment); },
            scmMock: {
                getRemoteRepoInfo: function() { return null; }
            }
        });
        var result = module.action({
            inputFolderPath: 'input/TS-100',
            ticket: { key: 'TS-100', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });
        assert.equal(result, false);
        assert.ok(comments.some(function(c) { return c.indexOf('Could not determine repository') !== -1; }));
    });

    test('unexpected failure mid-review → error comment with the cause, returns false', function() {
        var comments = [];
        var module = loadPrepareTestPRForReview({
            jira_post_comment: function(args) { comments.push(args.comment); },
            scmMock: {
                getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'trackstate' }; },
                listPrs: function() {
                    return [{ number: 66, head: { ref: 'test/TS-101' }, html_url: 'u' }];
                }
            },
            githubHelpers: {
                getPRDetails: function() { throw new Error('SCM exploded'); }
            }
        });
        var result = module.action({
            inputFolderPath: 'input/TS-101',
            ticket: { key: 'TS-101', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });
        assert.equal(result, false);
        assert.ok(comments.some(function(c) { return c.indexOf('Test PR Review Setup Error') !== -1; }));
        assert.ok(comments.some(function(c) { return c.indexOf('SCM exploded') !== -1; }));
    });

    test('params without ticket key or input folder abort through the catch guard', function() {
        var module = loadPrepareTestPRForReview({});
        assert.equal(module.action({ jobParams: {} }), false);
    });

    test('checkout failure is logged and the review continues', function() {
        var contextWritten = false;
        var module = loadPrepareTestPRForReview({
            gitOpsMock: {
                checkoutPRBranch: function() { throw new Error('cannot checkout'); },
                writePRContext: function() { contextWritten = true; }
            },
            githubHelpers: {
                getPRDetails: function() {
                    return { number: 65, changed_files: 1, head: { ref: 'test/TS-102' }, base: { ref: 'main' }, html_url: 'u' };
                }
            },
            scmMock: {
                listPrs: function(state) {
                    if (state === 'open') return [{ number: 65, head: { ref: 'test/TS-102' }, html_url: 'u' }];
                    return [];
                }
            }
        });
        var result = module.action({
            inputFolderPath: 'input/TS-102',
            ticket: { key: 'TS-102', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: {} }
        });
        assert.equal(result.success, true);
        assert.equal(contextWritten, true);
    });

    test('jobParams.inputFolderPath resolves the ticket key when ticket.key is absent', function() {
        var comments = [];
        var module = loadPrepareTestPRForReview({
            jira_post_comment: function(args) { comments.push(args.comment); },
            scmMock: {
                getRemoteRepoInfo: function() { return null; }
            }
        });
        var result = module.action({ jobParams: { inputFolderPath: 'input/TS-103', customParams: {} } });
        assert.equal(result, false);
        assert.ok(comments.some(function(c) { return c.indexOf('Could not determine repository') !== -1; }));
    });
});
