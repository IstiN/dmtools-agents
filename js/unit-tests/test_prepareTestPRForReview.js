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
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return scmMock; } }
        }),
        { file_read: function() { return null; } }
    );

    var prHelper = loadModule(
        'js/common/pullRequest.js',
        makeRequire({ './config.js': configModule }),
        { cli_execute_command: function() { return ''; }, jira_search_by_jql: function() { return []; }, file_write: function() {} }
    );

    var githubHelpers = Object.assign({
        getPRDetails: function() { return null; },
        fetchDiscussionsAndRawData: function() { return { markdown: '', rawThreads: {} }; },
        writePRContext: function() {},
        checkoutPRBranch: function() {},
        getPRDiff: function() { return ''; }
    }, mocks && mocks.githubHelpers || {});

    return loadModule(
        'js/prepareTestPRForReview.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': freshConfigLoader,
            './common/githubHelpers.js': githubHelpers,
            './common/scm.js': { createScm: function() { return scmMock; } },
            './common/pullRequest.js': prHelper
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
                },
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

});
