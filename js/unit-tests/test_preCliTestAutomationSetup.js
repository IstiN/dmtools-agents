/**
 * Unit tests for js/preCliTestAutomationSetup.js (gh-1223 characterization)
 *
 * Pins the action() step sequence — ticket move, branch checkout, stale-output
 * cleanup, linked-bug fetch — and its failure tolerance (every step is
 * non-fatal) ahead of the gh-1223 helper extraction. These tests must keep
 * passing unchanged through the refactor.
 */

function loadTestAutomationSetup(mocks) {
    var cfg = {
        git: { baseBranch: 'main', branchPrefix: { test: 'test' }, authorName: 'Test Agent', authorEmail: 'agent@example.com' },
        jira: {},
        workingDir: mocks.workingDir || null
    };

    var allMocks = Object.assign({
        jira_move_to_status: function() {},
        jira_search_by_jql: function() { return []; },
        jira_get_ticket: function(opts) { return { key: opts.key || opts, fields: {} }; },
        file_write: function() {},
        file_read: function() { return null; },
        cli_execute_command: function() { return ''; }
    }, mocks);

    var fetchLinkedBugs = mocks.fetchLinkedBugsModule || { action: function() {} };

    return loadModule(
        'js/preCliTestAutomationSetup.js',
        makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return cfg; } },
            './config.js': configModule,
            './fetchLinkedBugsToInput.js': fetchLinkedBugs,
            './common/trackers.js': loadModule(
                'js/common/trackers.js',
                makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }),
                allMocks
            ),
            './common/pullRequest.js': loadModule(
                'js/common/pullRequest.js',
                makeRequire({
                    './config.js': configModule,
                    './mergeState.js': loadModule('js/common/mergeState.js'),
                    './common/mergeState.js': loadModule('js/common/mergeState.js')
                }),
                allMocks
            )
        }),
        allMocks
    );
}

suite('preCliTestAutomationSetup — gh-1223 characterization: action steps', function() {

    test('happy path moves the ticket, clears stale outputs and fetches linked bugs', function() {
        var moves = [];
        var commands = [];
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            jira_move_to_status: function(opts) { moves.push(opts); },
            cli_execute_command: function(opts) { commands.push(opts.command); return ''; },
            fetchLinkedBugsModule: { action: function(params) { bugFetches.push(params); } }
        });

        mod.action({ inputFolderPath: 'input/TS-9' });

        assert.deepEqual(moves, [{ key: 'TS-9', statusName: 'In Development' }],
            'ticket must move to In Development');
        assert.ok(commands.some(function(c) { return c.indexOf('rm -f outputs/test_automation_result.json') !== -1; }),
            'stale output files must be cleared');
        assert.equal(bugFetches.length, 1, 'linked bugs fetched once');
        assert.equal(bugFetches[0].inputFolderPath, 'input/TS-9', 'bug fetch receives the action params');
    });

    test('a failing ticket move is non-fatal — the remaining steps still run', function() {
        var commands = [];
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            jira_move_to_status: function() { throw new Error('jira down'); },
            cli_execute_command: function(opts) { commands.push(opts.command); return ''; },
            fetchLinkedBugsModule: { action: function() { bugFetches.push(true); } }
        });

        mod.action({ inputFolderPath: 'input/TS-10' });

        assert.ok(commands.some(function(c) { return c.indexOf('rm -f outputs/test_automation_result.json') !== -1; }),
            'stale output cleanup still runs after a failed move');
        assert.equal(bugFetches.length, 1, 'linked bugs still fetched after a failed move');
    });

    test('a failing branch checkout is non-fatal — cleanup and bug fetch still run', function() {
        var commands = [];
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command.indexOf('git') === 0 || opts.command.indexOf('git ') !== -1) {
                    throw new Error('git fatal');
                }
                return '';
            },
            fetchLinkedBugsModule: { action: function() { bugFetches.push(true); } }
        });

        mod.action({ inputFolderPath: 'input/TS-11' });

        assert.ok(commands.some(function(c) { return c.indexOf('rm -f outputs/test_automation_result.json') !== -1; }),
            'stale output cleanup still runs after a failed checkout');
        assert.equal(bugFetches.length, 1, 'linked bugs still fetched after a failed checkout');
    });

    test('a failing stale-output cleanup is non-fatal — linked bugs still fetched', function() {
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            cli_execute_command: function(opts) {
                if (opts.command.indexOf('rm -f outputs/') !== -1) throw new Error('rm refused');
                return '';
            },
            fetchLinkedBugsModule: { action: function() { bugFetches.push(true); } }
        });

        mod.action({ inputFolderPath: 'input/TS-12' });

        assert.equal(bugFetches.length, 1, 'linked bugs still fetched after cleanup failure');
    });

    test('a failing linked-bugs fetch is non-fatal — action completes', function() {
        var moves = [];

        var mod = loadTestAutomationSetup({
            jira_move_to_status: function(opts) { moves.push(opts); },
            fetchLinkedBugsModule: { action: function() { throw new Error('bug fetch exploded'); } }
        });

        mod.action({ inputFolderPath: 'input/TS-13' });

        assert.deepEqual(moves, [{ key: 'TS-13', statusName: 'In Development' }],
            'the action still ran to completion for the ticket');
    });

    test('jobParams-only params (no top-level inputFolderPath) are resolved', function() {
        var moves = [];
        var bugFetches = [];

        var mod = loadTestAutomationSetup({
            jira_move_to_status: function(opts) { moves.push(opts); },
            cli_execute_command: function() { return ''; },
            fetchLinkedBugsModule: { action: function(params) { bugFetches.push(params); } }
        });

        mod.action({ jobParams: { inputFolderPath: 'input/TS-14', customParams: {} } });

        assert.deepEqual(moves, [{ key: 'TS-14', statusName: 'In Development' }],
            'ticket key must resolve from jobParams.inputFolderPath');
        assert.equal(bugFetches[0].inputFolderPath, 'input/TS-14',
            'bug fetch receives the resolved actual params');
    });

});

// ---------------------------------------------------------------------------
// gh-1242: alignBranchWithBase / checkoutBranch — every branch path
// ---------------------------------------------------------------------------

suite('preCliTestAutomationSetup — alignBranchWithBase (gh-1242)', function() {

    function gitResponder(rules, calls) {
        return function(opts) {
            var c = opts.command;
            calls.push(c);
            for (var i = 0; i < rules.length; i++) {
                var hit = rules[i].re ? rules[i].re.test(c) : c.indexOf(rules[i].match) !== -1;
                if (hit) {
                    if (rules[i].fail) throw new Error(rules[i].fail);
                    return rules[i].out || '';
                }
            }
            return '';
        };
    }

    function loadAlign(mocks) {
        var cfg = {
            git: { baseBranch: 'main', branchPrefix: { test: 'test' }, authorName: 'Test Agent', authorEmail: 'agent@example.com' },
            jira: {},
            workingDir: null
        };
        var allMocks = Object.assign({
            jira_move_to_status: function() {},
            jira_search_by_jql: function() { return []; },
            jira_get_ticket: function(opts) { return { key: opts.key || opts, fields: {} }; },
            file_write: function() {},
            file_read: function() { return null; },
            cli_execute_command: function() { return ''; }
        }, mocks);
        return loadModule(
            'js/preCliTestAutomationSetup.js',
            makeRequire({
                './configLoader.js': {
                    loadProjectConfig: function() { return cfg; },
                    formatBranchName: function(prefix, key) { return prefix + '/' + key; }
                },
                './config.js': configModule,
                './fetchLinkedBugsToInput.js': { action: function() {} },
                './common/trackers.js': loadModule(
                    'js/common/trackers.js',
                    makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }),
                    allMocks
                ),
                './common/pullRequest.js': loadModule(
                    'js/common/pullRequest.js',
                    makeRequire({
                        './config.js': configModule,
                        './mergeState.js': loadModule('js/common/mergeState.js'),
                        './common/mergeState.js': loadModule('js/common/mergeState.js')
                    }),
                    allMocks
                )
            }),
            allMocks
        );
    }

    test('HEAD already contained in origin/base → hard reset to base, no guidance', function() {
        var calls = [];
        var writes = [];
        var mod = loadAlign({
            cli_execute_command: gitResponder([
                { match: 'git rev-list -1 HEAD --not origin/main', out: '' }
            ], calls),
            file_write: function(opts) { writes.push(opts); }
        });
        mod.alignBranchWithBase('TS-30', 'test/TS-30', 'main', null);
        assert.ok(calls.some(function(c) { return c.indexOf('git reset --hard origin/main') !== -1; }),
            'branch resets to the base');
        assert.ok(!calls.some(function(c) { return c.indexOf('git cherry') !== -1; }),
            'no cherry inspection once the reset decision is made');
        assert.equal(writes.length, 0, 'no conflict guidance on the clean path');
    });

    test('no unique patches on the test branch → hard reset to base', function() {
        var calls = [];
        var writes = [];
        var mod = loadAlign({
            cli_execute_command: gitResponder([
                { match: 'git rev-list -1 HEAD --not origin/main', out: 'abc1234' },
                { match: 'git cherry origin/main HEAD', out: '- deadbeef\n- ca11ab1\n' }
            ], calls),
            file_write: function(opts) { writes.push(opts); }
        });
        mod.alignBranchWithBase('TS-31', 'test/TS-31', 'main', null);
        assert.ok(calls.some(function(c) { return c.indexOf('git reset --hard origin/main') !== -1; }),
            'equivalence-only commits reset to the base');
        assert.equal(writes.length, 0, 'no conflict guidance');
    });

    test('divergent branch with a merge base → merge-tree details land in conflict guidance', function() {
        var calls = [];
        var writes = [];
        var mod = loadAlign({
            cli_execute_command: gitResponder([
                { match: 'git rev-list -1 HEAD --not origin/main', out: 'abc1234' },
                { match: 'git cherry origin/main HEAD', out: '+ ca11ab1\n' },
                { match: 'git rev-list -1 origin/main --not HEAD', out: 'def5678' },
                { match: 'git-merge-base-or-empty.sh', out: 'base9999' },
                { match: 'git merge-tree', out: 'CONFLICT (content): merge conflict in src/a.js' }
            ], calls),
            file_write: function(opts) { writes.push(opts); }
        });
        mod.alignBranchWithBase('TS-32', 'test/TS-32', 'main', null);
        assert.equal(writes.length, 1, 'conflict guidance written for the divergent branch');
        assert.equal(writes[0].path, 'input/TS-32/merge_conflicts.md');
        assert.ok(writes[0].content.indexOf('CONFLICT (content)') !== -1, 'merge-tree output embedded');
        assert.ok(!calls.some(function(c) { return c.indexOf('git reset --hard') !== -1; }),
            'a divergent branch with unique patches is kept');
    });

    test('divergent branch with NO merge base → guidance explains the unrelated history', function() {
        var writes = [];
        var calls = [];
        var mod = loadAlign({
            cli_execute_command: gitResponder([
                { match: 'git rev-list -1 HEAD --not origin/main', out: 'abc1234' },
                { match: 'git cherry origin/main HEAD', out: '+ ca11ab1\n' },
                { match: 'git rev-list -1 origin/main --not HEAD', out: 'def5678' },
                { match: 'git-merge-base-or-empty.sh', out: '' }
            ], calls),
            file_write: function(opts) { writes.push(opts); }
        });
        mod.alignBranchWithBase('TS-33', 'test/TS-33', 'main', null);
        assert.equal(writes.length, 1, 'guidance written even without a merge base');
        assert.ok(writes[0].content.indexOf('No merge base found') !== -1,
            'the no-merge-base explanation is embedded');
    });

    test('divergent branch whose merge-tree fails → the error text lands in the guidance', function() {
        var writes = [];
        var mod = loadAlign({
            cli_execute_command: gitResponder([
                { match: 'git rev-list -1 HEAD --not origin/main', out: 'abc1234' },
                { match: 'git cherry origin/main HEAD', out: '+ ca11ab1\n' },
                { match: 'git rev-list -1 origin/main --not HEAD', out: 'def5678' },
                { match: 'git-merge-base-or-empty.sh', out: 'base9999' },
                { match: 'git merge-tree', fail: 'merge-tree exploded' }
            ], []),
            file_write: function(opts) { writes.push(opts); }
        });
        mod.alignBranchWithBase('TS-34', 'test/TS-34', 'main', null);
        assert.equal(writes.length, 1, 'guidance written even when merge-tree fails');
        assert.ok(writes[0].content.indexOf('merge-tree exploded') !== -1,
            'the merge-tree error text is embedded');
    });

    test('a failing cherry inspection is pessimistic → branch treated as having unique patches', function() {
        var writes = [];
        var calls = [];
        var mod = loadAlign({
            cli_execute_command: gitResponder([
                { match: 'git rev-list -1 HEAD --not origin/main', out: 'abc1234' },
                { match: 'git cherry origin/main HEAD', fail: 'cherry refused' },
                { match: 'git rev-list -1 origin/main --not HEAD', out: '' }
            ], calls),
            file_write: function(opts) { writes.push(opts); }
        });
        mod.alignBranchWithBase('TS-35', 'test/TS-35', 'main', null);
        assert.equal(writes.length, 0, 'base contained in HEAD — kept as-is');
        assert.ok(calls.some(function(c) { return c.indexOf('git rev-list -1 origin/main --not HEAD') !== -1; }),
            'the ancestry check proceeds after the cherry failure');
    });

});

suite('preCliTestAutomationSetup — checkoutBranch (gh-1242)', function() {

    function loadCheckout(mocks) {
        var cfg = {
            git: { baseBranch: 'main', branchPrefix: { test: 'test' }, authorName: 'Test Agent', authorEmail: 'agent@example.com' },
            jira: {},
            workingDir: null
        };
        var allMocks = Object.assign({
            jira_move_to_status: function() {},
            jira_search_by_jql: function() { return []; },
            jira_get_ticket: function(opts) { return { key: opts.key || opts, fields: {} }; },
            file_write: function() {},
            file_read: function() { return null; },
            cli_execute_command: function() { return ''; }
        }, mocks);
        return loadModule(
            'js/preCliTestAutomationSetup.js',
            makeRequire({
                './configLoader.js': {
                    loadProjectConfig: function() { return cfg; },
                    formatBranchName: function(prefix, key) { return prefix + '/' + key; }
                },
                './config.js': configModule,
                './fetchLinkedBugsToInput.js': { action: function() {} },
                './common/trackers.js': loadModule(
                    'js/common/trackers.js',
                    makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }),
                    allMocks
                ),
                './common/pullRequest.js': loadModule(
                    'js/common/pullRequest.js',
                    makeRequire({
                        './config.js': configModule,
                        './mergeState.js': loadModule('js/common/mergeState.js'),
                        './common/mergeState.js': loadModule('js/common/mergeState.js')
                    }),
                    allMocks
                )
            }),
            allMocks
        );
    }

    function responder(rules, calls) {
        return function(opts) {
            var c = opts.command;
            calls.push(c);
            for (var i = 0; i < rules.length; i++) {
                if (c.indexOf(rules[i].match) !== -1) {
                    if (rules[i].fail) throw new Error(rules[i].fail);
                    return rules[i].out || '';
                }
            }
            return '';
        };
    }

    var CONFIG = {
        git: { baseBranch: 'main', branchPrefix: { test: 'test' }, authorName: 'Test Agent', authorEmail: 'agent@example.com' },
        workingDir: null
    };

    test('local branch exists → checkout + align (reset when already contained in base)', function() {
        var calls = [];
        var mod = loadCheckout({
            cli_execute_command: responder([
                { match: 'git branch --list "test/TS-40"', out: '  test/TS-40\n' },
                { match: 'git rev-list -1 HEAD --not origin/main', out: '' }
            ], calls)
        });
        mod.checkoutBranch('TS-40', CONFIG);
        assert.ok(calls.some(function(c) { return c === 'git checkout test/TS-40'; }), 'local branch checked out');
        assert.ok(calls.some(function(c) { return c.indexOf('git reset --hard origin/main') !== -1; }),
            'aligned with the base after checkout');
        assert.ok(!calls.some(function(c) { return c.indexOf('git checkout -b') !== -1; }), 'no branch creation');
    });

    test('remote-only branch → checkout -b from origin + align', function() {
        var calls = [];
        var mod = loadCheckout({
            cli_execute_command: responder([
                { match: 'git branch --list "test/TS-41"', out: '' },
                { match: 'git ls-remote --heads origin test/TS-41', out: 'abc1234\trefs/heads/test/TS-41\n' },
                { match: 'git rev-list -1 HEAD --not origin/main', out: '' }
            ], calls)
        });
        mod.checkoutBranch('TS-41', CONFIG);
        assert.ok(calls.some(function(c) { return c === 'git checkout -b test/TS-41 origin/test/TS-41'; }),
            'tracking branch created from origin');
        assert.ok(calls.some(function(c) { return c.indexOf('git reset --hard origin/main') !== -1; }),
            'aligned with the base');
    });

    test('missing everywhere → new branch created from the base (author config failure non-fatal)', function() {
        var calls = [];
        var mod = loadCheckout({
            cli_execute_command: responder([
                { match: 'git config user.name', fail: 'no config' },
                { match: 'git config user.email', fail: 'no config' },
                { match: 'git branch --list "test/TS-42"', out: '' },
                { match: 'git ls-remote --heads origin test/TS-42', out: '' }
            ], calls)
        });
        mod.checkoutBranch('TS-42', CONFIG);
        assert.ok(calls.some(function(c) { return c === 'git checkout main'; }), 'base checked out first');
        assert.ok(calls.some(function(c) { return c === 'git pull origin main'; }), 'base pulled');
        assert.ok(calls.some(function(c) { return c === 'git checkout -b test/TS-42'; }), 'new branch from the base');
    });

});

function loadCheckoutFallback(mocks) {
    var allMocks = Object.assign({
        jira_move_to_status: function() {},
        jira_search_by_jql: function() { return []; },
        jira_get_ticket: function(opts) { return { key: opts.key || opts, fields: {} }; },
        file_write: function() {},
        file_read: function() { return null; },
        cli_execute_command: function() { return ''; }
    }, mocks);
    return loadModule(
        'js/preCliTestAutomationSetup.js',
        makeRequire({
            './configLoader.js': {
                loadProjectConfig: function() { return {}; },
                formatBranchName: function(prefix, key) { return prefix + '/' + key; }
            },
            './config.js': configModule,
            './fetchLinkedBugsToInput.js': { action: function() {} },
            './common/trackers.js': loadModule(
                'js/common/trackers.js',
                makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }),
                allMocks
            ),
            './common/pullRequest.js': loadModule(
                'js/common/pullRequest.js',
                makeRequire({
                    './config.js': configModule,
                    './mergeState.js': loadModule('js/common/mergeState.js'),
                    './common/mergeState.js': loadModule('js/common/mergeState.js')
                }),
                allMocks
            )
        }),
        allMocks
    );
}

suite('preCliTestAutomationSetup — checkoutBranch baseBranch fallback (gh-1242)', function() {

        test('config without git.baseBranch falls back to main for fetch + alignment', function() {
        var calls = [];
        var mod = loadCheckoutFallback({
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command.indexOf('git branch --list') !== -1) return '  test/TS-43\n';
                if (opts.command.indexOf('git rev-list -1 HEAD --not origin/main') !== -1) return '';
                return '';
            }
        });
        mod.checkoutBranch('TS-43', {
            git: { branchPrefix: { test: 'test' }, authorName: 'Test Agent', authorEmail: 'agent@example.com' },
            workingDir: null
        });
        assert.ok(calls.some(function(c) {
            return c.indexOf('fetch origin') !== -1 && c.indexOf('refs/heads/main') !== -1;
        }), 'the fetch refspec targets the main fallback');
        assert.ok(calls.some(function(c) { return c.indexOf('git reset --hard origin/') !== -1; }),
            'alignment still runs after the fallback fetch');
    });

});

suite('preCliTestAutomationSetup — checkoutBranch unsafe ref (gh-1242)', function() {

    test('an unsafe branch name AND unsafe base skip the targeted fetch entirely', function() {
        var calls = [];
        var mod = loadCheckoutFallback({
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command.indexOf('git branch --list') !== -1) return '';
                return '';
            }
        });
        mod.checkoutBranch('TS 45', {
            git: { baseBranch: 'bad..branch', branchPrefix: { test: 'test' }, authorName: 'Test Agent', authorEmail: 'agent@example.com' },
            workingDir: null
        });
        assert.ok(!calls.some(function(c) { return c.indexOf('fetch origin') !== -1; }),
            'no targeted fetch when every ref name is unsafe');
        assert.ok(calls.some(function(c) { return c === 'git checkout -b test/TS 45'; }),
            'the branch is still created from the base');
    });

});

suite('preCliTestAutomationSetup — checkoutBranch failure tolerance (gh-1242)', function() {

    test('a throwing targeted fetch and a throwing remote probe are both non-fatal', function() {
        var calls = [];
        var mod = loadCheckoutFallback({
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command.indexOf('fetch origin') !== -1) throw new Error('fetch exploded');
                if (opts.command.indexOf('git ls-remote') !== -1) throw new Error('ls-remote exploded');
                if (opts.command.indexOf('git branch --list') !== -1) return '';
                return '';
            }
        });
        mod.checkoutBranch('TS-46', {
            git: { baseBranch: 'main', branchPrefix: { test: 'test' }, authorName: 'Test Agent', authorEmail: 'agent@example.com' },
            workingDir: null
        });
        assert.ok(calls.some(function(c) { return c.indexOf('fetch origin') !== -1; }),
            'the targeted fetch was attempted');
        assert.ok(calls.some(function(c) { return c.indexOf('git ls-remote') !== -1; }),
            'the remote probe was attempted');
        assert.ok(calls.some(function(c) { return c === 'git checkout -b test/TS-46'; }),
            'the branch is still created from the base after both failures');
    });

});
