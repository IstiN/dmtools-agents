/**
 * Unit tests for js/postPRReviewComments.js.
 */

function loadPostPRReviewComments() {
    return loadModule(
        'js/postPRReviewComments.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './configLoader.js': configLoaderModule
        }),
        {
            file_read: function() { return null; }
        }
    );
}

suite('postPRReviewComments', function() {
    test('merges pr_review jobParamPatches into runtime customParams', function() {
        var mod = loadPostPRReviewComments();

        var customParams = mod.resolveCustomParams(
            {
                jobParams: {
                    customParams: {
                        removeLabel: 'sm_story_review_triggered',
                        targetRepository: { owner: 'IstiN', repo: 'trackstate' }
                    }
                }
            },
            {
                jobParamPatches: {
                    pr_review: {
                        customParams: {
                            autoStartRework: true,
                            autoStartReworkConfigFile: 'agents/pr_rework.json',
                            removeLabel: 'from_patch'
                        }
                    }
                }
            }
        );

        assert.equal(customParams.autoStartRework, true);
        assert.equal(customParams.autoStartReworkConfigFile, 'agents/pr_rework.json');
        assert.equal(customParams.removeLabel, 'sm_story_review_triggered');
        assert.deepEqual(customParams.targetRepository, { owner: 'IstiN', repo: 'trackstate' });
    });
});
