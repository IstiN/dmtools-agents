/**
 * Unit tests for js/postPRReviewComments.js.
 */

function loadPostPRReviewComments() {
    var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), {
        file_read: function() { return null; }
    });
    return loadModule(
        'js/postPRReviewComments.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './configLoader.js': configLoaderModule,
            './common/outputFiles.js': outputFiles,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
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

    test('detects line present in added side of PR diff', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/lib/example.dart b/lib/example.dart\n' +
            'index 1111111..2222222 100644\n' +
            '--- a/lib/example.dart\n' +
            '+++ b/lib/example.dart\n' +
            '@@ -10,2 +10,3 @@ class Example {\n' +
            ' context line\n' +
            '+new line\n' +
            ' another context\n';

        assert.equal(mod.isLinePresentInDiff(diff, 'lib/example.dart', 11), true);
        assert.equal(mod.isLinePresentInDiff(diff, 'lib/example.dart', 99), false);
    });

    test('treats deleted file lines as unavailable for inline comments', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/.codegraph/.gitignore b/.codegraph/.gitignore\n' +
            'deleted file mode 100644\n' +
            'index 1111111..0000000\n' +
            '--- a/.codegraph/.gitignore\n' +
            '+++ /dev/null\n' +
            '@@ -1,2 +0,0 @@\n' +
            '-index\n' +
            '-cache\n';

        assert.equal(mod.isLinePresentInDiff(diff, '.codegraph/.gitignore', 1), false);
    });

    test('countReviewThreads counts rawThreads from scm.fetchDiscussions', function() {
        var mod = loadPostPRReviewComments();
        var scm = {
            fetchDiscussions: function() {
                return { rawThreads: { threads: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
            }
        };
        assert.equal(mod.countReviewThreads(scm, 42), 3);
    });

    test('countReviewThreads returns 0 when fetchDiscussions throws', function() {
        var mod = loadPostPRReviewComments();
        var scm = {
            fetchDiscussions: function() {
                throw new Error('graphql failure');
            }
        };
        assert.equal(mod.countReviewThreads(scm, 42), 0);
    });

    test('countReviewThreads returns 0 when rawThreads are missing', function() {
        var mod = loadPostPRReviewComments();
        var scm = { fetchDiscussions: function() { return {}; } };
        assert.equal(mod.countReviewThreads(scm, 42), 0);
    });
});
