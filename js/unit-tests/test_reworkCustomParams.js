/**
 * Unit tests for rework post-actions merging project jobParamPatches.
 */

function loadPushReworkChanges() {
    return loadModule(
        'agents/js/pushReworkChanges.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/submodules.js': {},
            './common/pullRequest.js': {},
            './common/feedbackLoop.js': {},
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } }
        }),
        {}
    );
}

function loadPostTestReworkResults() {
    return loadModule(
        'agents/js/postTestReworkResults.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/feedbackLoop.js': {},
            './common/pullRequest.js': {}
        }),
        {}
    );
}

suite('rework custom params', function() {
    test('merges pr_rework jobParamPatches into runtime customParams', function() {
        var mod = loadPushReworkChanges();

        var customParams = mod.resolveCustomParams(
            {
                jobParams: {
                    customParams: {
                        removeLabel: 'sm_story_rework_triggered',
                        targetRepository: { owner: 'IstiN', repo: 'trackstate' }
                    }
                }
            },
            { customParams: { ignored: true } },
            {
                jobParamPatches: {
                    pr_rework: {
                        customParams: {
                            autoStartReview: true,
                            autoStartReviewConfigFile: 'agents/pr_review.json',
                            removeLabel: 'from_patch'
                        }
                    }
                }
            }
        );

        assert.equal(customParams.autoStartReview, true);
        assert.equal(customParams.autoStartReviewConfigFile, 'agents/pr_review.json');
        assert.equal(customParams.removeLabel, 'sm_story_rework_triggered');
        assert.deepEqual(customParams.targetRepository, { owner: 'IstiN', repo: 'trackstate' });
    });

    test('merges pr_test_automation_rework jobParamPatches into runtime customParams', function() {
        var mod = loadPostTestReworkResults();

        var customParams = mod.resolveCustomParams(
            {
                jobParams: {
                    customParams: {
                        removeLabel: 'sm_tc_rework_triggered'
                    }
                }
            },
            {},
            {
                jobParamPatches: {
                    pr_test_automation_rework: {
                        customParams: {
                            autoStartReview: true,
                            autoStartReviewConfigFile: 'agents/pr_test_automation_review.json',
                            removeLabel: 'from_patch'
                        }
                    }
                }
            }
        );

        assert.equal(customParams.autoStartReview, true);
        assert.equal(customParams.autoStartReviewConfigFile, 'agents/pr_test_automation_review.json');
        assert.equal(customParams.removeLabel, 'sm_tc_rework_triggered');
    });
});
