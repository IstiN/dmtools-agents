/**
 * Unit tests for js/preCliDevelopmentSetupDynamicRepo.js
 */

var GROUPED_REPOS_JSON = JSON.stringify({
    repositories: {
        'test-group': [
            { provider: 'gitlab', repo: 'my-repo', gitlabGroup: 'org/dev', branch: 'develop' }
        ]
    }
});

// ── gh-1200 CRAP refactor: named parse/build/decide helpers ─────────────────
// The repo-resolution stub used to be one anonymous closure folded into
// makeModule's CRAP; the steps below are small named units with the exact
// same semantics (including the original loop's last-match-wins scan).

/** '[<repo>] rest of summary' → '<repo>', '' when absent (stub parity). */
function stubSummaryOf(params) {
    var summary = params.ticket && params.ticket.fields && params.ticket.fields.summary ? params.ticket.fields.summary : '';
    return summary;
}

/** Grouped-repositories scan: the entry whose repo matches the [repo] summary tag. */
function findGroupRepoEntry(allRepos, summary) {
    var entry = null;
    var groups = Object.keys(allRepos);
    for (var i = 0; i < groups.length; i++) {
        var arr = allRepos[groups[i]];
        if (Array.isArray(arr)) {
            for (var j = 0; j < arr.length; j++) {
                var match = summary.match(/^\[([^\]]+)\]/);
                if (match && arr[j].repo === match[1]) { entry = arr[j]; break; }
            }
        }
    }
    return entry;
}

/** The resolveRepoFromTicket.action stub body: lookup + targetRepository injection. */
function groupedRepoLookup(files, params) {
    var repos = JSON.parse(files['.dmtools/repositories.json'] || '{"repositories":{}}');
    var allRepos = repos.repositories || {};
    var entry = findGroupRepoEntry(allRepos, stubSummaryOf(params));
    if (entry) {
        if (!params.customParams) params.customParams = {};
        params.customParams.targetRepository = {
            repo: entry.repo,
            baseBranch: entry.branch,
            owner: entry.gitlabGroup,
            workingDir: './dependencies/' + entry.repo
        };
    }
    return true;
}

/** The preCliDevelopmentSetup.action stub body: record the captured params. */
function recordSetupCall(setupCalls, setupResult, params) {
    setupCalls.push({
        customParams: params.customParams,
        jobParamsCustomParams: params.jobParams && params.jobParams.customParams
    });
    return setupResult !== undefined ? setupResult : true;
}

/** Controlled file_read: fileMap first, .dmtools/config blocked, else null. */
function stubFileRead(files, readOpts) {
    var p = readOpts && (readOpts.path || readOpts);
    if (files[p] !== undefined) return files[p];
    if (p && p.indexOf('.dmtools/config') !== -1) return null;
    return null;
}

function makeModule(fileMap, setupResult) {
    var files = fileMap || {};
    var setupCalls = [];

    var mod = loadModule(
        'js/preCliDevelopmentSetupDynamicRepo.js',
        makeRequire({
            './resolveRepoFromTicket.js': {
                action: function(params) {
                    // simulate resolveRepoFromTicket: write targetRepository into params
                    return groupedRepoLookup(files, params);
                },
                STRATEGIES: {},
                findRepoEntry: function() { return null; }
            },
            './preCliDevelopmentSetup.js': {
                action: function(params) {
                    return recordSetupCall(setupCalls, setupResult, params);
                }
            }
        }),
        {
            file_read: function(readOpts) {
                return stubFileRead(files, readOpts);
            }
        }
    );

    mod._setupCalls = setupCalls;
    return mod;
}

suite('preCliDevelopmentSetupDynamicRepo — action', function() {
    test('calls resolveRepo then setupDev in sequence', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-1', fields: { summary: '[my-repo] Add feature' } }
        };
        var result = mod.action(params);
        assert.equal(result, true, 'returns true on success');
        assert.equal(mod._setupCalls.length, 1, 'setupDev was called');
    });

    test('setupDev receives params with targetRepository already set', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-2', fields: { summary: '[my-repo] Fix bug' } }
        };
        mod.action(params);
        var captured = mod._setupCalls[0];
        assert.equal(captured.customParams !== null && captured.customParams !== undefined, true, 'customParams present');
        assert.equal(captured.customParams.targetRepository.repo, 'my-repo', 'targetRepository.repo set');
        assert.equal(captured.customParams.targetRepository.workingDir, './dependencies/my-repo', 'workingDir set');
        assert.equal(captured.customParams.targetRepository.baseBranch, 'develop', 'baseBranch set');
    });

    test('returns false and skips setupDev when resolveRepo returns false', function() {
        var files = { '.dmtools/repositories.json': GROUPED_REPOS_JSON };
        var setupCalls = [];
        var mod = loadModule(
            'js/preCliDevelopmentSetupDynamicRepo.js',
            makeRequire({
                './resolveRepoFromTicket.js': { action: function() { return false; } },
                './preCliDevelopmentSetup.js': { action: function() { setupCalls.push(1); return true; } }
            }),
            { file_read: function() { return null; } }
        );
        var result = mod.action({ ticket: { key: 'PROJ-3', fields: { summary: '[x] y' } } });
        assert.equal(result, false, 'returns false');
        assert.equal(setupCalls.length, 0, 'setupDev not called');
    });

    test('module.exports is guarded for standalone require compatibility', function() {
        var mod = makeModule({});
        assert.equal(typeof mod.action, 'function', 'action exported');
    });
});
