/**
 * Unit tests for js/developBugAndCreatePR.js.
 */

function loadDevelopBugAndCreatePR(mocks) {
    mocks = mocks || {};
    var comments = [];
    var moves = [];
    var removed = [];
    var commands = [];

    var allMocks = Object.assign({
        file_read: function(args) {
            if (args.path === 'outputs/response.md') throw new Error('missing response');
            throw new Error('missing ' + args.path);
        },
        cli_execute_command: function(args) {
            commands.push(args.command);
            if (args.command.indexOf('gh pr list --head ') === 0) return '';
            if (args.command === 'git status --porcelain') return 'A  outputs/rca.md\n';
            if (args.command === 'git branch --show-current') return 'main\n';
            return '';
        },
        jira_post_comment: function(args) { comments.push(args); },
        jira_move_to_status: function(args) { moves.push(args); },
        jira_remove_label: function(args) { removed.push(args); }
    }, mocks);
    var outputFiles = loadModule(
        'js/common/outputFiles.js',
        makeRequire({}),
        allMocks
    );

    var mod = loadModule(
        'js/developBugAndCreatePR.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/outputFiles.js': outputFiles,
            './developTicketAndCreatePR.js': { action: function() { return { success: true, path: 'delegated' }; } }
        }),
        allMocks
    );

    return {
        mod: mod,
        commands: commands,
        comments: comments,
        moves: moves,
        removed: removed
    };
}

suite('developBugAndCreatePR', function() {

    test('pushes interrupted partial work to development branch instead of main', function() {
        var loaded = loadDevelopBugAndCreatePR();

        var result = loaded.mod.action({
            ticket: {
                key: 'TS-1296',
                fields: { summary: 'Bug loop', description: '', labels: [] }
            },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: { removeLabel: 'sm_bug_development_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'interrupted');
        assert.ok(
            loaded.commands.indexOf('git checkout -B ai/TS-1296') !== -1,
            'expected partial work to switch away from main'
        );
        assert.ok(
            loaded.commands.indexOf('git push -u origin ai/TS-1296 --force-with-lease') !== -1,
            'expected partial work push to target ai branch'
        );
        assert.notOk(
            loaded.commands.indexOf('git push -u origin main') !== -1,
            'must never push partial work to main'
        );
        assert.deepEqual(loaded.moves, [
            { key: 'TS-1296', statusName: 'Ready For Development' }
        ]);
        assert.deepEqual(loaded.removed, [
            { key: 'TS-1296', label: 'bug_development_wip' },
            { key: 'TS-1296', label: 'sm_bug_development_triggered' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Development Interrupted');
    });

    test('does not clean CodeGraph runtime artifacts from JS post-action', function() {
        var loaded = loadDevelopBugAndCreatePR();

        var result = loaded.mod.action({
            ticket: {
                key: 'TS-1298',
                fields: { summary: 'Interrupted by rate limit', description: '', labels: [] }
            },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: { removeLabel: 'sm_bug_development_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'interrupted');
        assert.notOk(
            loaded.commands.some(function(c) {
                return c.indexOf('.agent-bin') !== -1 || c.indexOf('.codegraph') !== -1;
            }),
            'CodeGraph setup/cleanup belongs to setup scripts, not JS post-actions'
        );
    });

    test('accepts already_fixed output without CodeGraph and moves bug to Done', function() {
        var loaded = loadDevelopBugAndCreatePR({
            file_read: function(args) {
                if (args.path === 'outputs/already_fixed.json') {
                    return JSON.stringify({
                        rca: 'Current code already covers this behavior',
                        commit: 'abc123',
                        description: 'Verified without CodeGraph'
                    });
                }
                if (args.path === '.dmtools/codegraph-usage.log') {
                    throw new Error('missing codegraph usage log');
                }
                throw new Error('missing ' + args.path);
            }
        });

        var result = loaded.mod.action({
            ticket: {
                key: 'TS-1303',
                fields: { summary: 'Already fixed claim', description: '', labels: [] }
            },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: { removeLabel: 'sm_bug_development_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'already_fixed');
        assert.deepEqual(loaded.moves, [
            { key: 'TS-1303', statusName: 'Done' }
        ]);
        assert.contains(loaded.comments[0].comment, 'No CodeGraph usage was recorded');
        assert.deepEqual(loaded.removed, [
            { key: 'TS-1303', label: 'bug_development_wip' },
            { key: 'TS-1303', label: 'sm_bug_development_triggered' }
        ]);
    });

    test('rejects blocked output when CodeGraph was not used', function() {
        var loaded = loadDevelopBugAndCreatePR({
            file_read: function(args) {
                if (args.path === 'outputs/blocked.json') {
                    return JSON.stringify({
                        reason: 'Session tooling did not return repository file contents',
                        tried: ['Read input files'],
                        needs: 'A working session'
                    });
                }
                if (args.path === '.dmtools/codegraph-usage.log') {
                    throw new Error('missing codegraph usage log');
                }
                throw new Error('missing ' + args.path);
            }
        });

        var result = loaded.mod.action({
            ticket: {
                key: 'TS-1304',
                fields: { summary: 'Blocked claim', description: '', labels: [] }
            },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: { removeLabel: 'sm_bug_development_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'blocked_without_codegraph');
        assert.deepEqual(loaded.moves, [
            { key: 'TS-1304', statusName: 'Ready For Development' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Blocked Claim Needs CodeGraph Verification');
    });

    test('accepts already_fixed output when CodeGraph usage was recorded', function() {
        var loaded = loadDevelopBugAndCreatePR({
            file_read: function(args) {
                if (args.path === 'outputs/already_fixed.json') {
                    return JSON.stringify({
                        rca: 'Current code already covers this behavior',
                        commit: 'abc123',
                        description: 'Verified with CodeGraph'
                    });
                }
                if (args.path === '.dmtools/codegraph-usage.log') {
                    return '2026-05-31T00:00:00Z\tcodegraph search symbol\n';
                }
                throw new Error('missing ' + args.path);
            },
            jira_add_label: function() {}
        });

        var result = loaded.mod.action({
            ticket: {
                key: 'TS-1303',
                fields: { summary: 'Already fixed claim', description: '', labels: [] }
            },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: { removeLabel: 'sm_bug_development_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'already_fixed');
        assert.deepEqual(loaded.moves, [
            { key: 'TS-1303', statusName: 'Done' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Bug Already Fixed');
    });

});
