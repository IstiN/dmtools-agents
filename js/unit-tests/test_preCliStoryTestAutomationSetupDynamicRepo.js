/**
 * Unit tests for js/preCliStoryTestAutomationSetupDynamicRepo.js
 *
 * globalMock is bound per loadModule() call, so the real resolver is loaded
 * inside the same call as the module under test (sharing the file_read mock).
 */

var GROUPED_REPOS_JSON = JSON.stringify({
    repositories: {
        'test-group': [
            { provider: 'gitlab', repo: 'my-repo', gitlabGroup: 'org/dev', branch: 'develop' }
        ]
    }
});

function stubFileRead(files, readOpts) {
    var p = readOpts && (readOpts.path || readOpts);
    if (files[p] !== undefined) return files[p];
    if (p && p.indexOf('.dmtools/config') !== -1) return null;
    return null;
}

/** The real resolver, loaded within the module-under-test's require tree (same mocks). */
function resolverModule(mocks) {
    return loadModule('js/resolveRepoFromTicket.js', makeRequire({}), mocks);
}

function makeModule(fileMap, setupResult) {
    var files = fileMap || {};
    var setupCalls = [];
    var writes = [];
    var mocks = {
        file_read: function(readOpts) { return stubFileRead(files, readOpts); },
        file_write: function(writeOpts) { writes.push(writeOpts); }
    };

    var mod = loadModule(
        'js/preCliStoryTestAutomationSetupDynamicRepo.js',
        makeRequire({
            './resolveRepoFromTicket.js': resolverModule(mocks),
            './preCliStoryTestAutomationSetup.js': {
                action: function(params) {
                    setupCalls.push({
                        customParams: params.customParams,
                        jobParamsCustomParams: params.jobParams && params.jobParams.customParams
                    });
                    return setupResult !== undefined ? setupResult : { success: true };
                }
            },
            './common/branchSetup.js': loadModule('js/common/branchSetup.js', makeRequire({}))
        }),
        mocks
    );

    mod._setupCalls = setupCalls;
    mod._writes = writes;
    return mod;
}

function findWrite(writes, path) {
    for (var i = 0; i < writes.length; i++) {
        if (writes[i].path === path) return writes[i];
    }
    return null;
}

suite('preCliStoryTestAutomationSetupDynamicRepo — action', function() {

    test('calls resolveRepo then setup with targetRepository already set', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] Automate tests' } }
        };
        var result = mod.action(params);
        assert.deepEqual(result, { success: true }, 'returns the setup result');
        assert.equal(mod._setupCalls.length, 1, 'setup was called exactly once');
        assert.equal(mod._setupCalls[0].customParams.targetRepository.repo, 'my-repo');
        assert.equal(mod._setupCalls[0].customParams.targetRepository.baseBranch, 'develop');
        assert.equal(mod._setupCalls[0].customParams.targetRepository.owner, 'org/dev');
        assert.equal(mod._setupCalls[0].customParams.targetRepository.workingDir, './dependencies/my-repo');
    });

    test('publishes targetRepository to jobParams.customParams for the Teammate call path', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] x' } },
            jobParams: {}
        };
        mod.action(params);
        assert.equal(params.jobParams.customParams.targetRepository.repo, 'my-repo',
            'configLoader.loadProjectConfig(params.jobParams) sees the resolved repo');
    });

    test('writes the resolved workingDir to .dmtools-target-workingdir', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        mod.action({ ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] x' } } });
        var marker = findWrite(mod._writes, '.dmtools-target-workingdir');
        assert.ok(marker, 'marker file was written');
        assert.equal(marker.content, './dependencies/my-repo');
    });

    test('skips the marker when no repo was resolved (no [repo] tag)', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        mod.action({ ticket: { key: 'PROJ-1', fields: { summary: 'no tag here' } } });
        assert.equal(findWrite(mod._writes, '.dmtools-target-workingdir'), null);
        assert.equal(mod._setupCalls.length, 1, 'setup still runs with project defaults');
        assert.equal(mod._setupCalls[0].customParams, undefined);
    });

    test('skips the marker in dryRun mode', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        mod.action({
            ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] x' } },
            dryRun: true
        });
        assert.equal(findWrite(mod._writes, '.dmtools-target-workingdir'), null);
        assert.equal(mod._setupCalls.length, 1);
    });

    test('tolerates a failing marker write (non-fatal)', function() {
        var files = { '.dmtools/repositories.json': GROUPED_REPOS_JSON };
        var setupCalls = [];
        var mocks = {
            file_read: function(readOpts) { return stubFileRead(files, readOpts); },
            file_write: function() { throw new Error('disk full'); }
        };
        var mod = loadModule(
            'js/preCliStoryTestAutomationSetupDynamicRepo.js',
            makeRequire({
                './resolveRepoFromTicket.js': resolverModule(mocks),
                './preCliStoryTestAutomationSetup.js': {
                    action: function() { setupCalls.push(1); return { success: true }; }
                },
                './common/branchSetup.js': loadModule('js/common/branchSetup.js', makeRequire({}))
            }),
            mocks
        );
        var result = mod.action({ ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] x' } } });
        assert.deepEqual(result, { success: true });
        assert.equal(setupCalls.length, 1, 'setup still runs');
    });

    test('aborts without running setup when resolveRepo returns false', function() {
        var mod = loadModule(
            'js/preCliStoryTestAutomationSetupDynamicRepo.js',
            makeRequire({
                './resolveRepoFromTicket.js': { action: function() { return false; } },
                './preCliStoryTestAutomationSetup.js': { action: function() { throw new Error('must not run'); } }
            })
        );
        assert.equal(mod.action({}), false);
    });

    test('propagates the setup failure result unchanged', function() {
        var failure = { success: false, error: 'boom' };
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON }, failure);
        assert.equal(mod.action({ ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] x' } } }), failure);
    });
});
