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

    test('deleted file lines are available on the LEFT side', function() {
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

        assert.equal(mod.isLinePresentInDiff(diff, '.codegraph/.gitignore', 1), true);
        assert.equal(mod.isLinePresentInDiff(diff, '.codegraph/.gitignore', 1, 'LEFT'), true);
        assert.equal(mod.isLinePresentInDiff(diff, '.codegraph/.gitignore', 1, 'RIGHT'), false);
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

    test('detects submodule pointer changes in PR diff', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/trackstate-setup b/trackstate-setup\n' +
            'index bab3e4453..20a4bc2a1 160000\n' +
            '--- a/trackstate-setup\n' +
            '+++ b/trackstate-setup\n' +
            '@@ -1 +1 @@\n' +
            '-Subproject commit bab3e445305c78295b72f1fa4fe5e85f12055546\n' +
            '+Subproject commit 20a4bc2a11e528d173e9fbe046b1ee31514e9259\n';

        assert.equal(mod.isSubmodulePathInDiff(diff, 'trackstate-setup'), true);
        assert.equal(mod.isSubmodulePathInDiff(diff, 'lib/example.dart'), false);
    });

    test('maps comments on submodule content to the submodule diff line as inline threads', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/trackstate-setup b/trackstate-setup\n' +
            'index bab3e4453..20a4bc2a1 160000\n' +
            '--- a/trackstate-setup\n' +
            '+++ b/trackstate-setup\n' +
            '@@ -1 +1 @@\n' +
            '-Subproject commit bab3e445305c78295b72f1fa4fe5e85f12055546\n' +
            '+Subproject commit 20a4bc2a11e528d173e9fbe046b1ee31514e9259\n';
        var calls = [];
        var scm = {
            getPrDiff: function() { return diff; },
            addInlineComment: function(prId, path, line, text, startLine, side) {
                calls.push({ prId: prId, path: path, line: line, text: text, startLine: startLine, side: side });
            }
        };

        mod.postInlineComment(scm, 1930, { path: 'trackstate-setup', line: 7, body: 'description issue' }, 'TS-1383', null);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].path, 'trackstate-setup');
        assert.equal(calls[0].line, 1);
        assert.equal(calls[0].side, 'RIGHT');
        assert.equal(calls[0].startLine, null);
        assert.ok(calls[0].text.indexOf('trackstate-setup:7') !== -1);
        assert.ok(calls[0].text.indexOf('description issue') !== -1);
    });

    test('maps comments on files inside a submodule to the submodule diff line', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/trackstate-setup b/trackstate-setup\n' +
            'index bab3e4453..20a4bc2a1 160000\n' +
            '--- a/trackstate-setup\n' +
            '+++ b/trackstate-setup\n' +
            '@@ -1 +1 @@\n' +
            '-Subproject commit bab3e445305c78295b72f1fa4fe5e85f12055546\n' +
            '+Subproject commit 20a4bc2a11e528d173e9fbe046b1ee31514e9259\n';
        var calls = [];
        var scm = {
            getPrDiff: function() { return diff; },
            addInlineComment: function(prId, path, line, text, startLine, side) {
                calls.push({ prId: prId, path: path, line: line, text: text, startLine: startLine, side: side });
            }
        };

        mod.postInlineComment(scm, 1930, { path: 'trackstate-setup/README.md', line: 12, body: 'readme issue' }, 'TS-1383', null);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].path, 'trackstate-setup');
        assert.equal(calls[0].line, 1);
        assert.ok(calls[0].text.indexOf('trackstate-setup/README.md:12') !== -1);
    });
});
