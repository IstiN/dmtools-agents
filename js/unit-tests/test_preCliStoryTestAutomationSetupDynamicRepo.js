/**
 * Unit tests for js/common/dynamicRepoSetup.js (the shared resolve+setup
 * chaining) exercised through js/preCliStoryTestAutomationSetupDynamicRepo.js.
 *
 * The git/Jira-touching preCliStoryTestAutomationSetup action is stubbed;
 * resolveRepoFromTicket is stubbed too so the chaining itself (abort, marker,
 * result propagation) is what gets asserted. The marker's dryRun gating uses
 * the real branchSetup.isDryRunParams.
 */

var branchSetup = loadModule('js/common/branchSetup.js', makeRequire({}));

/** Load the shared helper with the resolver stubbed and writes captured. */
function makeHelper(resolveResult, writes) {
    return loadModule('js/common/dynamicRepoSetup.js', makeRequire({
        '../resolveRepoFromTicket.js': {
            action: function(params) {
                if (resolveResult === false) return false;
                if (!params.customParams) params.customParams = {};
                params.customParams.targetRepository = {
                    repo: 'my-repo', baseBranch: 'develop', owner: 'org/dev',
                    workingDir: './dependencies/my-repo'
                };
                return true;
            }
        },
        './branchSetup.js': branchSetup
    }), {
        file_write: function(writeOpts) { writes.push(writeOpts); }
    });
}

/** The module under test with the shared helper injected. */
function makeModule(resolveResult, setupResult) {
    var writes = [];
    var setupCalls = [];
    var mod = loadModule(
        'js/preCliStoryTestAutomationSetupDynamicRepo.js',
        makeRequire({
            './common/dynamicRepoSetup.js': makeHelper(resolveResult, writes),
            './preCliStoryTestAutomationSetup.js': {
                action: function(params) {
                    setupCalls.push({
                        customParams: params.customParams,
                        jobParamsCustomParams: params.jobParams && params.jobParams.customParams
                    });
                    return setupResult !== undefined ? setupResult : { success: true };
                }
            }
        }),
        { file_write: function(writeOpts) { writes.push(writeOpts); } }
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
        var mod = makeModule();
        var params = { ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] Automate tests' } } };
        var result = mod.action(params);
        assert.deepEqual(result, { success: true }, 'returns the setup result');
        assert.equal(mod._setupCalls.length, 1, 'setup was called exactly once');
        assert.equal(mod._setupCalls[0].customParams.targetRepository.repo, 'my-repo');
        assert.equal(mod._setupCalls[0].customParams.targetRepository.baseBranch, 'develop');
        assert.equal(mod._setupCalls[0].customParams.targetRepository.owner, 'org/dev');
        assert.equal(mod._setupCalls[0].customParams.targetRepository.workingDir, './dependencies/my-repo');
    });

    test('writes the resolved workingDir to .dmtools-target-workingdir', function() {
        var mod = makeModule();
        mod.action({ ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] x' } } });
        var marker = findWrite(mod._writes, '.dmtools-target-workingdir');
        assert.ok(marker, 'marker file was written');
        assert.equal(marker.content, './dependencies/my-repo');
    });

    test('skips the marker in dryRun mode', function() {
        var mod = makeModule();
        mod.action({ ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] x' } }, dryRun: true });
        assert.equal(findWrite(mod._writes, '.dmtools-target-workingdir'), null);
        assert.equal(mod._setupCalls.length, 1);
    });

    test('aborts without running setup when resolveRepo returns false', function() {
        var mod = makeModule(false);
        assert.equal(mod.action({}), false);
        assert.equal(mod._setupCalls.length, 0, 'setup not called');
    });

    test('propagates the setup failure result unchanged', function() {
        var failure = { success: false, error: 'boom' };
        var mod = makeModule(true, failure);
        assert.equal(mod.action({ ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] x' } } }), failure);
    });
});
