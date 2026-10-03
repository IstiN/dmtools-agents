/**
 * Unit tests for js/pushKnowledgeUpdate.js
 *
 * Scope: the knowledgeDir no-op gate, the "no changes to push" no-op path, and
 * the branch/commit naming — which is derived from customParams.prNumber (or a
 * timestamp fallback when no PR number is available, e.g. a direct-content-only
 * run) since this action is not tracker-bound.
 */

function loadPushKnowledgeUpdate(cliCalls) {
    return loadModule(
        'js/pushKnowledgeUpdate.js',
        makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return {}; } },
            './config.js': configModule,
            'config': configModule
        }),
        {
            cli_execute_command: function(opts) {
                cliCalls.push(opts.command);
                if (opts.command.indexOf('git status --porcelain') === 0) {
                    return cliCalls.__statusOutput || '';
                }
                return '';
            }
        }
    );
}

suite('pushKnowledgeUpdate — knowledgeDir no-op gate', function() {

    test('no-ops when customParams.knowledgeDir is not configured', function() {
        var cliCalls = [];
        var mod = loadPushKnowledgeUpdate(cliCalls);

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { prNumber: '42' }
        });

        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
        assert.equal(cliCalls.length, 0, 'must not run any git command when knowledgeDir is unset');
    });
});

suite('pushKnowledgeUpdate — no changes to push', function() {

    test('no-ops when git status reports no changes under knowledgeDir', function() {
        var cliCalls = [];
        var mod = loadModule(
            'js/pushKnowledgeUpdate.js',
            makeRequire({
                './configLoader.js': { loadProjectConfig: function() { return {}; } },
                './config.js': configModule,
                'config': configModule
            }),
            {
                cli_execute_command: function(opts) {
                    cliCalls.push(opts.command);
                    return ''; // empty status → nothing changed
                }
            }
        );

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge', prNumber: '42' }
        });

        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
        assert.equal(cliCalls.length, 1, 'should only check git status, nothing else');
        assert.contains(cliCalls[0], 'git status --porcelain');
    });
});

suite('pushKnowledgeUpdate — commits and pushes changes', function() {

    function loadWithStatus(statusOutput) {
        var cliCalls = [];
        var mod = loadModule(
            'js/pushKnowledgeUpdate.js',
            makeRequire({
                './configLoader.js': { loadProjectConfig: function() { return {}; } },
                './config.js': configModule,
                'config': configModule
            }),
            {
                cli_execute_command: function(opts) {
                    cliCalls.push(opts.command);
                    if (opts.command.indexOf('git status --porcelain') === 0) return statusOutput;
                    return '';
                }
            }
        );
        return { mod: mod, cliCalls: cliCalls };
    }

    test('branch/commit names are derived from customParams.prNumber when present', function() {
        var loaded = loadWithStatus(' M knowledge/heuristics/foo.md\n');

        var result = loaded.mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge', prNumber: '42' }
        });

        assert.equal(result.success, true);
        assert.ok(!result.skipped);
        assert.equal(result.branchName, 'knowledge/pr-42-review-lessons');

        var checkoutCall = loaded.cliCalls.filter(function(c) { return c.indexOf('git checkout -b') === 0; })[0];
        assert.contains(checkoutCall, 'knowledge/pr-42-review-lessons');

        var commitCall = loaded.cliCalls.filter(function(c) { return c.indexOf('git commit') === 0; })[0];
        assert.contains(commitCall, 'pr-42');

        var addCall = loaded.cliCalls.filter(function(c) { return c.indexOf('git add') === 0; })[0];
        assert.contains(addCall, 'knowledge');

        var pushCall = loaded.cliCalls.filter(function(c) { return c.indexOf('git push') === 0; })[0];
        assert.contains(pushCall, 'knowledge/pr-42-review-lessons');
    });

    test('falls back to a timestamp-based branch name when no prNumber is available (direct-content-only run)', function() {
        var loaded = loadWithStatus(' M knowledge/heuristics/foo.md\n');

        var result = loaded.mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge', diffText: 'diff --git a/x b/x' }
        });

        assert.equal(result.success, true);
        assert.ok(!result.skipped);
        assert.ok(/^knowledge\/update-\d{14}-review-lessons$/.test(result.branchName),
            'expected a timestamp-based branch name, got: ' + result.branchName);
    });

    test('only stages the knowledgeDir path, not the whole working tree', function() {
        var loaded = loadWithStatus(' M knowledge/heuristics/foo.md\n');

        loaded.mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge', prNumber: '7' }
        });

        var addCalls = loaded.cliCalls.filter(function(c) { return c.indexOf('git add') === 0; });
        assert.equal(addCalls.length, 1);
        assert.equal(addCalls[0], 'git add -- "knowledge"');
    });
});
