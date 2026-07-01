/**
 * Unit tests for js/resolveRepoFromTicket.js
 */

var GROUPED_REPOS_JSON = JSON.stringify({
    git: { userName: 'AI', userEmail: 'ai@test.com' },
    repositories: {
        'gens-sup': [
            { provider: 'gitlab', repo: 'gens-igt-db', gitlabGroup: 'gens-sup/develop', branch: 'develop' },
            { provider: 'gitlab', repo: 'gens-igt',    gitlabGroup: 'gens-sup/develop', branch: 'develop' },
            { provider: 'gitlab', repo: 'lims-ui',     gitlabGroup: 'gens-sup/develop', branch: 'develop' },
            { provider: 'gitlab', repo: 'ultraqc',     gitlabGroup: 'gens-sup/develop', branch: 'master'  }
        ]
    }
});

var FLAT_REPOS_JSON = JSON.stringify({
    repositories: [
        { repo: 'my-service', branch: 'main', gitlabGroup: 'org/backend' },
        { repo: 'my-ui',      branch: 'dev',  gitlabGroup: 'org/frontend' }
    ]
});

var BARE_ARRAY_REPOS_JSON = JSON.stringify([
    { repo: 'bare-repo', branch: 'trunk', gitlabGroup: 'org/bare' }
]);

function makeModule(fileMap) {
    var files = fileMap || {};
    return loadModule(
        'js/resolveRepoFromTicket.js',
        makeRequire({}),
        {
            file_read: function(opts) {
                var p = opts && (opts.path || opts);
                if (files[p] !== undefined) return files[p];
                if (p && p.indexOf('.dmtools/config') !== -1) return null;
                return null;
            }
        }
    );
}

// ─── STRATEGIES.fromSummary ──────────────────────────────────────────────────

suite('resolveRepoFromTicket — STRATEGIES.fromSummary', function() {

    test('extracts repo name from [bracket] at start of summary', function() {
        var mod = makeModule();
        var ticket = { key: 'X-1', fields: { summary: '[gens-igt] Create PacBio WF' } };
        var name = mod.STRATEGIES.fromSummary(ticket);
        assert.equal(name, 'gens-igt', 'repo name extracted');
    });

    test('handles hyphenated and dotted repo names', function() {
        var mod = makeModule();
        var ticket = { key: 'X-2', fields: { summary: '[gens-igt-db] Migrate schema' } };
        assert.equal(mod.STRATEGIES.fromSummary(ticket), 'gens-igt-db', 'hyphenated name');
    });

    test('returns null when summary has no leading bracket', function() {
        var mod = makeModule();
        var ticket = { key: 'X-3', fields: { summary: 'No bracket prefix here' } };
        assert.equal(mod.STRATEGIES.fromSummary(ticket), null, 'null when no bracket');
    });

    test('returns null for empty summary', function() {
        var mod = makeModule();
        var ticket = { key: 'X-4', fields: { summary: '' } };
        assert.equal(mod.STRATEGIES.fromSummary(ticket), null, 'null for empty summary');
    });

    test('returns null when ticket has no fields', function() {
        var mod = makeModule();
        assert.equal(mod.STRATEGIES.fromSummary({}), null, 'null without fields');
        assert.equal(mod.STRATEGIES.fromSummary(null), null, 'null for null ticket');
    });
});

// ─── findRepoEntry ───────────────────────────────────────────────────────────

suite('resolveRepoFromTicket — findRepoEntry', function() {

    test('finds repo in grouped repositories structure', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var entry = mod.findRepoEntry('gens-igt');
        assert.equal(entry !== null, true, 'entry found');
        assert.equal(entry.branch, 'develop', 'correct branch');
        assert.equal(entry.gitlabGroup, 'gens-sup/develop', 'correct group');
    });

    test('finds repo with non-default branch in grouped structure', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var entry = mod.findRepoEntry('ultraqc');
        assert.equal(entry.branch, 'master', 'master branch resolved');
    });

    test('finds repo in flat repositories array', function() {
        var mod = makeModule({ '.dmtools/repositories.json': FLAT_REPOS_JSON });
        var entry = mod.findRepoEntry('my-service');
        assert.equal(entry !== null, true, 'entry found');
        assert.equal(entry.branch, 'main', 'correct branch');
    });

    test('finds repo in bare array at root', function() {
        var mod = makeModule({ '.dmtools/repositories.json': BARE_ARRAY_REPOS_JSON });
        var entry = mod.findRepoEntry('bare-repo');
        assert.equal(entry !== null, true, 'entry found');
        assert.equal(entry.branch, 'trunk', 'correct branch');
    });

    test('returns null when repo not in file', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        assert.equal(mod.findRepoEntry('unknown-repo'), null, 'null for missing repo');
    });

    test('returns null when repositories file is missing', function() {
        var mod = makeModule({});
        assert.equal(mod.findRepoEntry('any-repo'), null, 'null when file absent');
    });

    test('uses custom repositoriesFile path', function() {
        var mod = makeModule({ 'custom/repos.json': FLAT_REPOS_JSON });
        var entry = mod.findRepoEntry('my-ui', 'custom/repos.json');
        assert.equal(entry !== null, true, 'found via custom path');
        assert.equal(entry.branch, 'dev', 'correct branch from custom file');
    });
});

// ─── action ──────────────────────────────────────────────────────────────────

suite('resolveRepoFromTicket — action', function() {

    test('writes targetRepository to params.customParams when repo found in file', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-1', fields: { summary: '[gens-igt] Create feature' } }
        };
        var result = mod.action(params);
        assert.equal(result, true, 'returns true (continue)');
        assert.equal(params.customParams !== null && params.customParams !== undefined, true, 'customParams created');
        assert.equal(params.customParams.targetRepository.repo, 'gens-igt', 'repo name set');
        assert.equal(params.customParams.targetRepository.baseBranch, 'develop', 'baseBranch from file');
        assert.equal(params.customParams.targetRepository.owner, 'gens-sup/develop', 'owner from file');
    });

    test('writes only repoName when repo not found in repositories file', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-2', fields: { summary: '[unknown-repo] Do stuff' } }
        };
        var result = mod.action(params);
        assert.equal(result, true, 'still returns true');
        assert.equal(params.customParams.targetRepository.repo, 'unknown-repo', 'repoName forwarded');
        assert.equal(params.customParams.targetRepository.baseBranch, undefined, 'no baseBranch when not in file');
    });

    test('returns true and skips when ticket has no summary bracket', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-3', fields: { summary: 'Plain summary without bracket' } }
        };
        var result = mod.action(params);
        assert.equal(result, true, 'returns true (continue)');
        assert.equal(params.customParams, undefined, 'customParams not mutated');
    });

    test('returns true and skips when no ticket in params', function() {
        var mod = makeModule({});
        var params = {};
        assert.equal(mod.action(params), true, 'returns true without ticket');
    });

    test('uses fromSummary strategy by default', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-5', fields: { summary: '[lims-ui] Add filter' } },
            customParams: {}
        };
        mod.action(params);
        assert.equal(params.customParams.targetRepository.repo, 'lims-ui', 'default strategy resolves from summary');
    });

    test('uses custom repositoriesFile from customParams', function() {
        var mod = makeModule({ 'custom/repos.json': FLAT_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-6', fields: { summary: '[my-service] Refactor' } },
            customParams: { repositoriesFile: 'custom/repos.json' }
        };
        mod.action(params);
        assert.equal(params.customParams.targetRepository.baseBranch, 'main', 'branch from custom file');
    });

    test('returns true for unknown strategy (graceful skip)', function() {
        var mod = makeModule({});
        var params = {
            ticket: { key: 'PROJ-7', fields: { summary: '[any-repo] Task' } },
            customParams: { repoNameStrategy: 'nonExistentStrategy' }
        };
        assert.equal(mod.action(params), true, 'returns true for unknown strategy');
        assert.equal(params.customParams.targetRepository, undefined, 'no targetRepository written');
    });

    test('also writes targetRepository into params.jobParams.customParams for postJSAction path', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-9', fields: { summary: '[gens-igt] Feature' } },
            jobParams: { customParams: { existingKey: 'value' } }
        };
        mod.action(params);
        assert.equal(params.jobParams.customParams.targetRepository.repo, 'gens-igt', 'jobParams.customParams.targetRepository set');
        assert.equal(params.jobParams.customParams.existingKey, 'value', 'existing jobParams.customParams fields preserved');
    });

    test('creates params.jobParams.customParams if absent', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-10', fields: { summary: '[lims-ui] Fix' } },
            jobParams: {}
        };
        mod.action(params);
        assert.equal(params.jobParams.customParams.targetRepository.repo, 'lims-ui', 'targetRepository created in jobParams.customParams');
    });

    test('preserves existing customParams fields while adding targetRepository', function() {
        var mod = makeModule({ '.dmtools/repositories.json': GROUPED_REPOS_JSON });
        var params = {
            ticket: { key: 'PROJ-8', fields: { summary: '[gens-igt-db] Schema' } },
            customParams: { blocksRelationship: 'Blocks', labels: ['development'] }
        };
        mod.action(params);
        assert.equal(params.customParams.blocksRelationship, 'Blocks', 'existing fields preserved');
        assert.deepEqual(params.customParams.labels, ['development'], 'labels preserved');
        assert.equal(params.customParams.targetRepository.repo, 'gens-igt-db', 'targetRepository added');
    });
});

// ─── module.exports guard ────────────────────────────────────────────────────

suite('resolveRepoFromTicket — module.exports guard', function() {
    test('module.exports is guarded with typeof for postJSAction compatibility', function() {
        var mod = makeModule({});
        assert.equal(typeof mod.action, 'function', 'action exported');
        assert.equal(typeof mod.STRATEGIES, 'object', 'STRATEGIES exported');
        assert.equal(typeof mod.findRepoEntry, 'function', 'findRepoEntry exported');
    });
});
