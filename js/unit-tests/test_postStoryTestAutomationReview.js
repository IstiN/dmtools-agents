/**
 * Unit tests for js/postStoryTestAutomationReview.js
 */

function loadPostStoryTestAutomationReview(mocks) {
    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_add_label: function() {},
        jira_remove_label: function() {},
        github_add_pr_label: function() {},
        github_add_pr_comment: function() {},
        file_read: function() { return null; },
        file_write: function() {}
    };

    var allMocks = Object.assign({}, defaults, mocks);

    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return {}; } }
        }),
        { file_read: function() { return null; } }
    );

    var prHelper = loadModule('js/common/pullRequest.js', makeRequire({ './config.js': configModule }), allMocks);
    var ghHelpers = loadModule(
        'js/common/githubHelpers.js',
        makeRequire({ '../config.js': configModule, './config.js': configModule, './pullRequest.js': prHelper }),
        allMocks
    );

    var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), allMocks);

    return loadModule(
        'js/postStoryTestAutomationReview.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': freshConfigLoader,
            './common/githubHelpers.js': ghHelpers,
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function(opts) {
                    return (mocks && mocks.triggerConfiguredWorkflowForTicket)
                        ? mocks.triggerConfiguredWorkflowForTicket(opts)
                        : false;
                },
                triggerSmIfIdle: function() { return { success: true }; }
            },
            './common/outputFiles.js': outputFiles,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        allMocks
    );
}

suite('postStoryTestAutomationReview', function() {

    test('APPROVE adds pr_approved and triggers merge', function() {
        var mergeTriggered = false;
        var statusMoves = [];
        var labelsAdded = [];

        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({ recommendation: 'APPROVE', summary: 'LGTM' });
                }
                if (opts.path === 'input/TS-300/pr_info.md') {
                    return '**PR #**: 30\n**URL**: https://github.com/IstiN/trackstate/pull/30';
                }
                return null;
            },
            github_add_pr_label: function(args) {
                labelsAdded.push(args);
            },
            jira_add_label: function(args) {
                labelsAdded.push(args);
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            triggerConfiguredWorkflowForTicket: function(opts) {
                if (opts.configFile === 'agents/story_test_automation_merge.json') {
                    mergeTriggered = true;
                    return true;
                }
                return false;
            }
        });

        var result = module.action({
            ticket: { key: 'TS-300' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_story_test_review_triggered',
                    autoStartMerge: true,
                    autoStartMergeConfigFile: 'agents/story_test_automation_merge.json'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'APPROVE');
        assert.equal(mergeTriggered, true);
        assert.equal(statusMoves.length, 0, 'should not move story on approve');
        assert.ok(labelsAdded.some(function(a) { return a.label === 'pr_approved'; }));
    });

    test('REQUEST_CHANGES moves Story to In Rework and triggers rework', function() {
        var reworkTriggered = false;
        var statusMoves = [];

        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({ recommendation: 'REQUEST_CHANGES', summary: 'Fix locators' });
                }
                return null;
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            triggerConfiguredWorkflowForTicket: function(opts) {
                if (opts.configFile === 'agents/story_test_automation_rework.json') {
                    reworkTriggered = true;
                    return true;
                }
                return false;
            }
        });

        var result = module.action({
            ticket: { key: 'TS-301' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_story_test_review_triggered',
                    autoStartRework: true,
                    autoStartReworkConfigFile: 'agents/story_test_automation_rework.json'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'REQUEST_CHANGES');
        assert.equal(reworkTriggered, true);
        assert.deepEqual(statusMoves, [{ key: 'TS-301', statusName: 'In Rework' }]);
    });

});
