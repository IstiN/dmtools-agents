/**
 * Unit tests for js/postTestAutomationResults.js
 */

function resolveAutoStartMock(mocks) {
    if (mocks._autoStart) return mocks._autoStart;
    return {
        triggerSmIfIdle: function() {
            return { success: true };
        },
        triggerConfiguredWorkflowForTicket: function() {
            return false;
        }
    };
}

function resolveTrackersMock(mocks, allMocks) {
    if (mocks._trackers) return mocks._trackers;
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), allMocks);
}

function loadPostTestAutomation(mocks) {
    var fileReadMock = mocks.file_read || function(opts) {
        if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
        try { return file_read(opts); } catch (e) { return null; }
    };

    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return {}; } }
        }),
        { file_read: fileReadMock }
    );

    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_add_label: function() {},
        jira_remove_label: function() {},
        cli_execute_command: function() { return ''; },
        file_read: fileReadMock,
        file_write: function() {}
    };

    var allMocks = Object.assign({}, defaults, mocks);
    var outputFiles = loadModule(
        'js/common/outputFiles.js',
        makeRequire({}),
        allMocks
    );
    var prHelper = loadModule(
        'js/common/pullRequest.js',
        makeRequire({
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './common/mergeState.js': loadModule('js/common/mergeState.js')
        }),
        allMocks
    );

    // Overridable via mocks._autoStart / mocks._trackers so characterization
    // tests can pin the autoStart-review and error-catch branches.
    var autoStartMock = resolveAutoStartMock(mocks);
    var trackersMockModule = resolveTrackersMock(mocks, allMocks);

    return loadModule(
        'js/postTestAutomationResults.js',
        makeRequire({
            './configLoader.js': freshConfigLoader,
            './config.js': configModule,
            './common/pullRequest.js': prHelper,
            './common/autoStart.js': autoStartMock,
            './common/trackers.js': trackersMockModule,
            './common/outputFiles.js': outputFiles,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {}, postTokenUsageSafely: function() {} },
            './postTestAutomationResultsHelpers.js': loadModule(
                'js/postTestAutomationResultsHelpers.js',
                makeRequire({}),
                {}
            ),
            './postStoryTestAutomationShared.js': loadModule(
                'js/postStoryTestAutomationShared.js',
                makeRequire({}),
                allMocks
            )
        }),
        allMocks
    );
}

suite('postTestAutomationResults: PR creation', function() {

    test('creates PR without calling non-whitelisted pwd command', function() {
        var commands = [];
        var writtenFiles = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'failed', summary: 'Regression captured' });
                }
                if (opts.path === 'outputs/pr_body.md') return 'PR body';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            file_write: function(path, content) {
                writtenFiles.push({ path: path, content: content });
            },
            cli_execute_command: function(opts) {
                var command = opts.command;
                commands.push(command);
                if (command === 'pwd') throw new Error('pwd must not be called');
                if (command === 'git branch --show-current') return 'test/DMC-898';
                if (command === 'git status --short -- testing') return '?? testing/tests/DMC-898/test_dmc_898.py';
                if (command === 'git diff --cached --stat') return ' testing/tests/DMC-898/test_dmc_898.py | 1 +';
                if (command.indexOf('git ls-remote --heads origin test/DMC-898') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/DMC-898';
                if (command.indexOf('gh pr list --head test/DMC-898') === 0) return '';
                if (command.indexOf('gh pr create') === 0) return 'https://github.com/example-org/example.repo/pull/898';
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-898', fields: { summary: 'Automate test case' } },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/example-org/example.repo/pull/898');
        assert.ok(writtenFiles.length > 0, 'PR body written to temp file');
        assert.ok(commands.some(function(command) { return command.indexOf('gh pr create') === 0; }), 'gh pr create called');
        assert.notOk(commands.some(function(command) { return command === 'pwd'; }), 'pwd command not used');
    });

    test('blocks conflicting PR when merge conflict guidance was present', function() {
        var commands = [];
        var statuses = [];
        var removedLabels = [];
        var comments = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'blocked_by_human', summary: 'Needs browser auth' });
                }
                if (opts.path === 'outputs/pr_body.md') return 'PR body';
                if (opts.path === 'input/DMC-909/merge_conflicts.md') return '# Branch Conflict Guidance';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            jira_remove_label: function(args) {
                removedLabels.push(args.label);
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            cli_execute_command: function(opts) {
                var command = opts.command;
                commands.push(command);
                if (command === 'git branch --show-current') return 'test/DMC-909';
                if (command === 'git status --short -- testing') return ' M testing/tests/DMC-909/test_dmc_909.py';
                if (command === 'git diff --cached --stat') return ' testing/tests/DMC-909/test_dmc_909.py | 1 +';
                if (command.indexOf('git ls-remote --heads origin test/DMC-909') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/DMC-909';
                if (command.indexOf('gh pr list --head test/DMC-909') === 0) return '';
                if (command.indexOf('gh pr create') === 0) return 'https://github.com/example-org/example.repo/pull/909';
                if (command.indexOf('gh pr view https://github.com/example-org/example.repo/pull/909 --json mergeable') === 0) {
                    return '{"mergeable":"CONFLICTING"}';
                }
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-909', fields: { summary: 'Conflicting test automation branch' } },
            metadata: { contextId: 'test_case_automation' },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.status, 'blocked_by_human');
        assert.equal(result.blockedReason, 'pr_conflicts_with_main');
        assert.equal(result.prUrl, 'https://github.com/example-org/example.repo/pull/909');
        assert.ok(statuses.indexOf('Blocked') !== -1, 'moved ticket to Blocked');
        assert.ok(removedLabels.indexOf('sm_test_automation_triggered') !== -1, 'removed SM trigger label');
        assert.ok(removedLabels.indexOf('test_case_automation_wip') !== -1, 'removed WIP label');
        assert.ok(commands.some(function(command) {
            return command.indexOf('gh pr view https://github.com/example-org/example.repo/pull/909 --json mergeable') === 0;
        }), 'checked PR mergeability');
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'PR Conflicts With Main');
    });

    test('pushes synced existing branch before moving directly to Passed when there are no new test changes', function() {
        var commands = [];
        var statuses = [];
        var comments = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'passed', summary: 'Test already covered' });
                }
                if (opts.path === 'outputs/jira_comment.md') return 'h3. Test Automation Result\n\n*Status:* ✅ PASSED';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            cli_execute_command: function(opts) {
                var command = opts.command;
                commands.push(command);
                if (command === 'git branch --show-current') return 'test/DMC-968';
                if (command === 'git status --short -- testing') return '?? testing/tests/DMC-968/test_dmc_968.py';
                if (command === 'git diff --cached --stat') return '';
                if (command.indexOf('git ls-remote --heads origin test/DMC-968') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/DMC-968';
                if (command.indexOf('gh pr create') === 0) throw new Error('gh pr create must not be called without branch diff');
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-968', fields: { summary: 'Already automated installer rerun' } },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, null);
        assert.ok(commands.some(function(command) { return command === 'git diff --cached --stat'; }), 'checked staged diff');
        assert.ok(commands.some(function(command) { return command === 'git push -u origin test/DMC-968'; }), 'pushed existing branch after setup sync');
        assert.notOk(commands.some(function(command) { return command.indexOf('gh pr create') === 0; }), 'PR creation skipped');
        assert.ok(statuses.indexOf('Passed') !== -1, 'moved directly to Passed');
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'Test code unchanged from previous run');
    });

});

suite('postTestAutomationResults: failure cleanup', function() {

    test('moves ticket back to Backlog and removes trigger label when result JSON is missing', function() {
        var comments = [];
        var statuses = [];
        var removedLabels = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            jira_remove_label: function(args) {
                removedLabels.push(args.label);
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-999', fields: { summary: 'Missing result should retry' } },
            metadata: { contextId: 'test_case_automation' },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'No test result JSON found');
        assert.ok(statuses.indexOf('Backlog') !== -1, 'moved to Backlog for retry');
        assert.ok(removedLabels.indexOf('sm_test_automation_triggered') !== -1, 'removed SM trigger label');
        assert.ok(removedLabels.indexOf('test_case_automation_wip') !== -1, 'removed WIP label');
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'Ticket moved back to *Backlog*');
    });

    test('reads result JSON from configured workingDir outputs fallback', function() {
        var reads = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                reads.push(opts.path);
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                if (opts.path === '/tmp/repo/outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'passed', summary: 'Read from working directory' });
                }
                if (opts.path === '/tmp/repo/outputs/jira_comment.md') {
                    return 'h3. Test Automation Result\n\n*Status:* ✅ PASSED';
                }
                return null;
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return '';
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-1000', fields: { summary: 'Working dir output' } },
            jobParams: { customParams: { targetRepository: { workingDir: '/tmp/repo' } } }
        });

        assert.equal(result.success, true);
        assert.ok(reads.indexOf('/tmp/repo/outputs/test_automation_result.json') !== -1, 'checked workingDir fallback path');
    });

});

suite('postTestAutomationResults: Jira comment formatting', function() {

    test('posts outputs/jira_comment.md instead of Markdown response', function() {
        var comments = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'passed' });
                }
                if (opts.path === 'outputs/jira_comment.md') {
                    return 'h3. Test Automation Result\n\n*Status:* ✅ PASSED';
                }
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return '';
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-895', fields: { summary: 'Automate test case' } },
            response: '## Issues/Notes\n\n- **Status:** `FAILED`',
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(comments.length, 1);
        assert.equal(comments[0], 'h3. Test Automation Result\n\n*Status:* ✅ PASSED');
    });

    test('converts Markdown response fallback to Jira wiki markup', function() {
        var comments = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'failed' });
                }
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return '';
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-895', fields: { summary: 'Automate test case' } },
            response: '## Issues/Notes\n\n- **Status:** `FAILED`\n\n```bash\nnode testing/tests/DMC-895/test.js\n```\n\n[PR](https://github.com/org/repo/pull/1)',
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'h2. Issues/Notes');
        assert.contains(comments[0], '* *Status:* {{FAILED}}');
        assert.contains(comments[0], '{code:bash}');
        assert.contains(comments[0], 'node testing/tests/DMC-895/test.js');
        assert.contains(comments[0], '[PR|https://github.com/org/repo/pull/1]');
        assert.notContains(comments[0], '## Issues/Notes');
        assert.notContains(comments[0], '```');
    });

});

suite('postTestAutomationResults: tracker layer (ADO)', function() {
    test('ado: no-result failure path uses ado_* tools and no jira_* tool', function() {
        var calls = [];
        var mocks = {
            file_read: function() { return null; },
            cli_execute_command: function() { return ''; }
        };
        ['jira_post_comment', 'jira_move_to_status', 'jira_add_label', 'jira_remove_label'].forEach(function(n) {
            mocks[n] = function(a) { calls.push({ tool: n, args: a }); };
        });
        mocks.ado_add_work_item_comment = function(a) { calls.push({ tool: 'ado_add_work_item_comment', args: a }); };
        mocks.ado_move_to_state = function(a) { calls.push({ tool: 'ado_move_to_state', args: a }); };
        mocks.ado_remove_work_item_label = function(a) { calls.push({ tool: 'ado_remove_work_item_label', args: a }); };
        mocks.ado_add_work_item_label = function(a) { calls.push({ tool: 'ado_add_work_item_label', args: a }); };
        var module = loadPostTestAutomation(mocks);
        module.action({
            ticket: { key: '42', fields: { summary: 'Automate' } },
            metadata: { contextId: 'ctx' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        var tools = calls.map(function(c) { return c.tool; });
        assert.equal(tools.filter(function(t) { return t.indexOf('jira_') === 0; }).length, 0);
        assert.ok(tools.length > 0, 'expected at least one ado_* call');
        assert.equal(tools.filter(function(t) { return t.indexOf('ado_') === 0; }).length, tools.length);
        assert.ok(calls.every(function(c) { return String(c.args.id) === '42'; }));
        assert.ok(tools.indexOf('ado_add_work_item_comment') >= 0);
    });
});

suite('postTestAutomationResults: PR creation failure', function() {

    test('resets ticket to Backlog when PR creation fails after a successful push', function() {
        var comments = [];
        var statuses = [];
        var removedLabels = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'passed', summary: 'Tests written' });
                }
                if (opts.path === 'outputs/pr_body.md') return 'PR body';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            jira_remove_label: function(args) {
                removedLabels.push(args.label);
            },
            cli_execute_command: function(opts) {
                var command = opts.command;
                if (command === 'git branch --show-current') return 'test/DMC-910';
                if (command === 'git status --short -- testing') return '?? testing/tests/DMC-910/test_dmc_910.py';
                if (command === 'git diff --cached --stat') return ' testing/tests/DMC-910/test_dmc_910.py | 1 +';
                if (command.indexOf('git ls-remote --heads origin test/DMC-910') === 0) {
                    return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/DMC-910';
                }
                if (command.indexOf('gh pr list --head test/DMC-910') === 0) return '';
                if (command.indexOf('gh pr create') === 0) throw new Error('gh: repository not found');
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-910', fields: { summary: 'Automate test case' } },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'PR creation failed');
        assert.ok(statuses.indexOf('Backlog') !== -1, 'moved back to Backlog for retry');
        assert.ok(removedLabels.indexOf('sm_test_automation_triggered') !== -1, 'removed SM trigger label');
        assert.equal(comments.length, 1);
        assert.contains(comments[0], '⚠️ PR Creation Failed');
        assert.contains(comments[0], '{code}test/DMC-910{code}');
        assert.contains(comments[0], 'Error: Error: gh: repository not found');
    });

});

suite('postTestAutomationResults: git operations failure', function() {

    test('resets ticket to Backlog and removes trigger label when git add fails', function() {
        var comments = [];
        var statuses = [];
        var removedLabels = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'passed', summary: 'Tests written' });
                }
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            jira_remove_label: function(args) {
                removedLabels.push(args.label);
            },
            cli_execute_command: function(opts) {
                var command = opts.command;
                if (command === 'git branch --show-current') return 'test/DMC-911';
                if (command === 'git status --short -- testing') return '?? testing/tests/DMC-911/test.py';
                if (command.indexOf('git add ') === 0) throw new Error('index.lock present');
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-911', fields: { summary: 'Automate test case' } },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'Git operations failed');
        assert.ok(statuses.indexOf('Backlog') !== -1, 'moved back to Backlog for retry');
        assert.ok(removedLabels.indexOf('sm_test_automation_triggered') !== -1, 'removed hardcoded SM trigger label');
        assert.equal(comments.length, 1);
        assert.contains(comments[0], '⚠️ Git Operations Failed');
        assert.contains(comments[0], 'index.lock present');
    });

});

suite('postTestAutomationResults: blocked_by_human outcome', function() {

    test('posts setup requirements, moves to Blocked and removes labels (no code changes)', function() {
        var comments = [];
        var statuses = [];
        var removedLabels = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({
                        status: 'blocked_by_human',
                        blocked_reason: 'BrowserStack credentials expired',
                        missing: [
                            { name: 'BROWSERSTACK_USER', description: 'Account user', how_to_add: 'echo export BROWSERSTACK_USER=...' },
                            { name: 'BROWSERSTACK_KEY' }
                        ]
                    });
                }
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            jira_remove_label: function(args) {
                removedLabels.push(args.label);
            },
            cli_execute_command: function(opts) {
                var command = opts.command;
                if (command === 'git branch --show-current') return 'test/DMC-912';
                if (command === 'git status --short -- testing') return '';
                if (command === 'git diff --cached --stat') return '';
                if (command.indexOf('git ls-remote --heads origin test/DMC-912') === 0) {
                    return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/DMC-912';
                }
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-912', fields: { summary: 'Automate test case' } },
            metadata: { contextId: 'test_case_automation' },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.status, 'blocked_by_human');
        assert.equal(result.prUrl, null);
        assert.ok(statuses.indexOf('Blocked') !== -1, 'moved to Blocked');
        assert.ok(removedLabels.indexOf('test_case_automation_wip') !== -1, 'removed WIP label');
        assert.ok(removedLabels.indexOf('sm_test_automation_triggered') !== -1, 'removed SM trigger label');
        assert.equal(comments.length, 2, 'step-5 status comment plus the blocked comment');
        assert.contains(comments[0], 'Test code unchanged from previous run');
        assert.contains(comments[1], '🚫 Test Automation Blocked — Awaiting Human Setup');
        assert.contains(comments[1], 'BrowserStack credentials expired');
        assert.contains(comments[1], 'h4. Required setup:');
        assert.contains(comments[1], '* *BROWSERSTACK_USER*: Account user');
        assert.contains(comments[1], '{code:bash}echo export BROWSERSTACK_USER=...{code}');
        assert.contains(comments[1], '* *BROWSERSTACK_KEY*');
        assert.contains(comments[1], 'move this ticket back to *Backlog* to trigger re-run');
        assert.notContains(comments[1], 'Test Branch PR');
    });

});

suite('postTestAutomationResults: passed first run with review autostart', function() {

    test('moves to In Review - Passed and triggers the configured review workflow', function() {
        var comments = [];
        var statuses = [];
        var addedLabels = [];
        var reviewTriggers = [];
        var smIdleTriggers = [];
        var module = loadPostTestAutomation({
            _autoStart: {
                triggerConfiguredWorkflowForTicket: function(options) {
                    reviewTriggers.push(options);
                    return true;
                },
                triggerSmIfIdle: function() {
                    smIdleTriggers.push(1);
                    return { success: true };
                }
            },
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'passed', summary: 'All green' });
                }
                if (opts.path === 'outputs/jira_comment.md') return 'h3. Result\n\n*Status:* PASSED';
                if (opts.path === 'outputs/pr_body.md') return 'PR body';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            jira_add_label: function(args) {
                addedLabels.push(args.label);
            },
            cli_execute_command: function(opts) {
                var command = opts.command;
                if (command === 'git branch --show-current') return 'test/DMC-913';
                if (command === 'git status --short -- testing') return '?? testing/tests/DMC-913/test.py';
                if (command === 'git diff --cached --stat') return ' testing/tests/DMC-913/test.py | 1 +';
                if (command.indexOf('git ls-remote --heads origin test/DMC-913') === 0) {
                    return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/DMC-913';
                }
                if (command.indexOf('gh pr list --head test/DMC-913') === 0) return '';
                if (command.indexOf('gh pr create') === 0) return 'https://github.com/example-org/example.repo/pull/913';
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-913', fields: { summary: 'Automate test case' } },
            metadata: { contextId: 'test_case_automation' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_test_automation_triggered',
                    autoStartReview: true,
                    autoStartReviewConfigFile: 'pr_test_automation_review.json'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/example-org/example.repo/pull/913');
        assert.ok(statuses.indexOf('In Review - Passed') !== -1, 'moved to In Review - Passed on first run');
        assert.equal(reviewTriggers.length, 1, 'review workflow triggered exactly once');
        assert.equal(reviewTriggers[0].label, 'pr_test_automation_review');
        assert.equal(reviewTriggers[0].configFile, 'pr_test_automation_review.json');
        assert.equal(reviewTriggers[0].ticketKey, 'DMC-913');
        assert.equal(smIdleTriggers.length, 0, 'SM idle trigger skipped when review started');
        assert.ok(addedLabels.indexOf('ai_test_automation') !== -1, 'added AI test automation label');
        assert.equal(comments.length, 1);
        assert.contains(comments[0], '*Test Branch PR*: https://github.com/example-org/example.repo/pull/913');
        assert.notContains(comments[0], 'Test code unchanged from previous run');
    });

});

suite('postTestAutomationResults: missing result edge cases', function() {

    test('pushes partial work when result JSON is missing but the branch has staged changes', function() {
        var comments = [];
        var statuses = [];
        var commands = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            cli_execute_command: function(opts) {
                var command = opts.command;
                commands.push(command);
                if (command === 'git branch --show-current') return 'test/DMC-914';
                if (command === 'git status --short -- testing') return '?? testing/tests/DMC-914/test.py';
                if (command === 'git diff --cached --stat') return ' testing/tests/DMC-914/test.py | 1 +';
                if (command.indexOf('git ls-remote --heads origin test/DMC-914') === 0) {
                    return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/DMC-914';
                }
                return '';
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-914', fields: { summary: 'CLI crashed mid-run' } },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'No test result JSON found');
        assert.equal(result.partialPushed, true, 'partial work was pushed');
        assert.ok(commands.some(function(command) { return command.indexOf('git commit') === 0; }), 'partial work committed');
        assert.ok(statuses.indexOf('Backlog') !== -1, 'moved to Backlog for retry');
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'Partial code was pushed to the branch');
    });

    test('treats a result JSON belonging to another ticket as stale and retries', function() {
        var comments = [];
        var statuses = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'passed', ticketKey: 'DMC-000' });
                }
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            cli_execute_command: function() { return ''; }
        });

        var result = module.action({
            ticket: { key: 'DMC-915', fields: { summary: 'Stale result file' } },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'No test result JSON found');
        assert.ok(statuses.indexOf('Backlog') !== -1, 'stale result treated as missing — moved to Backlog');
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'Ticket moved back to *Backlog*');
    });

    test('treats an unparseable result JSON as missing and retries', function() {
        var statuses = [];
        var module = loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return 'not-json{{{';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_move_to_status: function(args) {
                statuses.push(args.statusName);
            },
            cli_execute_command: function() { return ''; }
        });

        var result = module.action({
            ticket: { key: 'DMC-916', fields: { summary: 'Corrupt result file' } },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'No test result JSON found');
        assert.ok(statuses.indexOf('Backlog') !== -1, 'corrupt result treated as missing — moved to Backlog');
    });

});

suite('postTestAutomationResults: publishExistingBranch strategies (gh-1043)', function() {

    // Static command→response table for the performGitOperations
    // "no staged changes → remote branch exists → publishExistingBranch"
    // path; every response is fixed per scenario, so the cli mock stays CC-low.
    function scenarioResponses(opts) {
        var branch = opts.branch || 'test/DMC-920';
        var normalPush = 'git push -u origin ' + branch;
        var leasePush = normalPush + ' --force-with-lease';
        var responses = {};
        responses['git branch --show-current'] = branch;
        responses['git status --short -- testing'] = '?? testing/tests/DMC-920/test.py';
        responses['git diff --cached --stat'] = '';
        responses['git ls-remote --heads origin ' + branch] = '9a7e2aec\trefs/heads/' + branch;
        responses['git rev-parse HEAD'] = opts.localSha;
        responses['git rev-parse origin/' + branch] = opts.remoteSha;
        responses['git merge-base HEAD origin/' + branch] = opts.mergeBase;
        responses[normalPush] = opts.failNormalPush ? { throw: 'push rejected' } : '';
        responses[leasePush] = opts.failLeasePush ? { throw: 'lease stale' } : '';
        responses['git reset --hard origin/' + branch] = opts.failReset ? { throw: 'reset failed' } : '';
        return { branch: branch, responses: responses, commands: [] };
    }

    function scenarioCli(scenario) {
        return function(args) {
            var command = args.command;
            scenario.commands.push(command);
            var r = scenario.responses[command];
            if (r && r.throw) throw new Error(r.throw);
            return r === undefined ? '' : r;
        };
    }

    function loadPublishScenario(opts) {
        var scenario = scenarioResponses(opts);
        var module = loadPostTestAutomation({
            file_read: function(args) {
                if (args.path === 'outputs/test_automation_result.json') {
                    return JSON.stringify({ status: 'passed', summary: 'Already covered' });
                }
                if (args.path === 'outputs/jira_comment.md') return 'h3. Result';
                if (args.path && args.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: scenarioCli(scenario)
        });
        return {
            module: module,
            commands: scenario.commands,
            run: function() {
                return module.action({
                    ticket: { key: 'DMC-920', fields: { summary: 'Publish strategies' } },
                    metadata: { contextId: 'test_case_automation' },
                    jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
                });
            }
        };
    }

    function pushes(commands, branch) {
        return commands.filter(function(c) { return c.indexOf('git push') === 0; });
    }

    test('identical: no merge-base, no push — branch already matches origin', function() {
        var scenario = loadPublishScenario({ localSha: 'aaa', remoteSha: 'aaa' });
        var result = scenario.run();
        assert.equal(result.success, true);
        assert.equal(result.prUrl, null);
        assert.equal(scenario.commands.indexOf('git merge-base HEAD origin/test/DMC-920'), -1, 'no merge-base when already identical');
        assert.equal(pushes(scenario.commands, 'test/DMC-920').length, 0, 'no push when already identical');
    });

    test('behind: resets --hard to origin, no push', function() {
        var scenario = loadPublishScenario({ localSha: 'aaa', remoteSha: 'bbb', mergeBase: 'aaa' });
        var result = scenario.run();
        assert.equal(result.success, true);
        assert.ok(scenario.commands.indexOf('git reset --hard origin/test/DMC-920') !== -1, 'reset to origin');
        assert.equal(pushes(scenario.commands, 'test/DMC-920').length, 0, 'no push when adopting remote');
    });

    test('ahead: single fast-forward push', function() {
        var scenario = loadPublishScenario({ localSha: 'bbb', remoteSha: 'aaa', mergeBase: 'aaa' });
        var result = scenario.run();
        assert.equal(result.success, true);
        assert.deepEqual(pushes(scenario.commands, 'test/DMC-920'), ['git push -u origin test/DMC-920']);
    });

    test('ahead with failed fast-forward push falls through to the diverged escalation', function() {
        var scenario = loadPublishScenario({ localSha: 'bbb', remoteSha: 'aaa', mergeBase: 'aaa', failNormalPush: true });
        var result = scenario.run();
        assert.equal(result.success, true);
        // Original fall-through: the failed ff-push lands in the diverged
        // block, which pushes normally and then with --force-with-lease.
        assert.deepEqual(pushes(scenario.commands, 'test/DMC-920'), [
            'git push -u origin test/DMC-920',
            'git push -u origin test/DMC-920',
            'git push -u origin test/DMC-920 --force-with-lease'
        ]);
    });

    test('diverged: normal push succeeds without lease escalation', function() {
        var scenario = loadPublishScenario({ localSha: 'bbb', remoteSha: 'ccc', mergeBase: 'aaa' });
        var result = scenario.run();
        assert.equal(result.success, true);
        assert.deepEqual(pushes(scenario.commands, 'test/DMC-920'), ['git push -u origin test/DMC-920']);
    });

    test('diverged: normal push fails, --force-with-lease succeeds', function() {
        var scenario = loadPublishScenario({ localSha: 'bbb', remoteSha: 'ccc', mergeBase: 'aaa', failNormalPush: true });
        var result = scenario.run();
        assert.equal(result.success, true);
        assert.deepEqual(pushes(scenario.commands, 'test/DMC-920'), [
            'git push -u origin test/DMC-920',
            'git push -u origin test/DMC-920 --force-with-lease'
        ]);
    });

    test('diverged: both pushes fail — reports failure and resets ticket to Backlog', function() {
        var scenario = loadPublishScenario({ localSha: 'bbb', remoteSha: 'ccc', mergeBase: 'aaa', failNormalPush: true, failLeasePush: true });
        var result = scenario.run();
        assert.equal(result.success, false);
        assert.contains(result.error, 'Git operations failed');
        assert.contains(result.error, 'the synced branch could not be pushed');
    });

});

suite('postTestAutomationResults: error catch path', function() {

    test('returns failure and posts error comment when in-try tracker creation fails', function() {
        var postComments = [];
        var removedLabels = [];
        var createCalls = 0;
        var module = loadPostTestAutomation({
            _trackers: {
                createTracker: function() {
                    createCalls++;
                    if (createCalls === 1) {
                        return {
                            postComment: function(key, comment) {
                                postComments.push({ key: key, comment: comment });
                            },
                            removeLabel: function(key, label) {
                                removedLabels.push(label);
                            }
                        };
                    }
                    throw new Error('config tracker blew up');
                }
            },
            file_read: function() { return null; },
            cli_execute_command: function() { return ''; }
        });

        var result = module.action({
            ticket: { key: 'DMC-917', fields: { summary: 'Config broken' } },
            jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'config tracker blew up');
        assert.equal(postComments.length, 1, 'error comment posted via the early tracker');
        assert.equal(postComments[0].key, 'DMC-917');
        assert.contains(postComments[0].comment, '❌ Test Automation Error');
        assert.contains(postComments[0].comment, 'config tracker blew up');
    });

    test('lets the entry tracker creation error propagate (early tracker is outside the try)', function() {
        var module = loadPostTestAutomation({
            _trackers: {
                createTracker: function() {
                    throw new Error('no tracker provider configured');
                }
            },
            file_read: function() { return null; },
            cli_execute_command: function() { return ''; }
        });

        var threw = false;
        try {
            module.action({
                ticket: { key: 'DMC-917', fields: { summary: 'Config broken' } },
                jobParams: { customParams: {} }
            });
        } catch (e) {
            threw = true;
            assert.contains(String(e), 'no tracker provider configured');
        }
        assert.ok(threw, 'action propagates the entry tracker creation error');
    });

});
// ── gh-1190: performGitOperations seam split — cluster characterization ──────

suite('postTestAutomationResults: performGitOperations seam clusters (gh-1190)', function() {

    function loadGitOpsModule(cliMock) {
        return loadPostTestAutomation({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: cliMock
        });
    }

    function lsRemoteRefResponse(branch) {
        return '0123456789abcdef0123456789abcdef01234567\trefs/heads/' + branch + '\n';
    }

    test('performGitOperations: full commit+push path keeps the exact command sequence', function() {
        var calls = [];
        var mod = loadGitOpsModule(function(opts) {
            var command = opts.command;
            calls.push(command);
            if (command === 'git branch --show-current') return 'test/DMC-1';
            if (command === 'git diff --cached --stat') return ' testing/x.py | 1 +\n 1 file changed, 1 insertion(+)';
            if (command === 'git ls-remote --heads origin test/DMC-1') return lsRemoteRefResponse('test/DMC-1');
            return '';
        });
        var result = mod.performGitOperations('test/DMC-1', 'Test changes', null, 'testing/');

        assert.equal(result.success, true);
        assert.deepEqual(calls, [
            'git status --short -- testing',
            'git add testing/',
            'git diff --cached --stat',
            'git commit -m "Test changes"',
            'git fetch origin test/DMC-1',
            'git push -u origin test/DMC-1',
            'git ls-remote --heads origin test/DMC-1'
        ], 'diagnostics → add → staged check → commit → fetch → push → verify, in order');
    });

    test('performGitOperations: push retry chain escalates to force-with-lease, then plain force', function() {
        var calls = [];
        var mod = loadGitOpsModule(function(opts) {
            var command = opts.command;
            calls.push(command);
            if (command === 'git diff --cached --stat') return '1 file changed';
            if (command === 'git push -u origin test/DMC-1') { throw new Error('non-fast-forward'); }
            if (command === 'git push -u origin test/DMC-1 --force-with-lease') { throw new Error('stale lease'); }
            if (command === 'git ls-remote --heads origin test/DMC-1') return lsRemoteRefResponse('test/DMC-1');
            return '';
        });
        var result = mod.performGitOperations('test/DMC-1', 'Test changes', null, null);

        assert.equal(result.success, true, 'the plain-force retry still lands the branch');
        assert.ok(calls.indexOf('git push -u origin test/DMC-1 --force-with-lease') !== -1,
            'force-with-lease runs after the normal push fails');
        assert.ok(calls.indexOf('git push -u origin test/DMC-1 --force') !== -1,
            'plain force runs after force-with-lease fails');
    });

    test('performGitOperations: nothing staged + remote branch absent → push current state', function() {
        var calls = [];
        var mod = loadGitOpsModule(function(opts) {
            var command = opts.command;
            calls.push(command);
            if (command === 'git diff --cached --stat') return '';
            return '';
        });
        var result = mod.performGitOperations('test/DMC-2', 'Test changes', null, 'testing/');

        assert.deepEqual(result, { success: true, branchName: 'test/DMC-2', noNewCommit: true });
        assert.ok(calls.indexOf('git push -u origin test/DMC-2') !== -1,
            'pushes the current branch state when the remote branch is absent');
        assert.ok(calls.indexOf('git reset --hard origin/test/DMC-2') === -1,
            'must never reset on this path');
    });

    test('performGitOperations: nothing staged + remote branch present → publishExistingBranch sync', function() {
        var calls = [];
        var mod = loadGitOpsModule(function(opts) {
            var command = opts.command;
            calls.push(command);
            if (command === 'git diff --cached --stat') return '';
            if (command === 'git ls-remote --heads origin test/DMC-3') return lsRemoteRefResponse('test/DMC-3');
            if (command === 'git rev-parse HEAD') return 'local-sha';
            if (command === 'git rev-parse origin/test/DMC-3') return 'remote-sha';
            if (command === 'git merge-base HEAD origin/test/DMC-3') return 'base-sha';
            return '';
        });
        var result = mod.performGitOperations('test/DMC-3', 'Test changes', null, 'testing/');

        assert.equal(result.success, true);
        assert.equal(result.noNewCommit, true);
        assert.ok(calls.indexOf('git push -u origin test/DMC-3') !== -1, 'diverged branch falls back to push');
        assert.ok(calls.indexOf('git fetch origin test/DMC-3') !== -1, 'remote ref refreshed before the decision');
    });

    test('performGitOperations: nothing staged + push failure yields the no-test-files error', function() {
        var mod = loadGitOpsModule(function(opts) {
            var command = opts.command;
            if (command === 'git diff --cached --stat') return '';
            if (command.indexOf('git push -u origin test/DMC-4') === 0) { throw new Error('remote rejected'); }
            return '';
        });
        var result = mod.performGitOperations('test/DMC-4', 'Test changes', null, 'testing/');
        assert.deepEqual(result, {
            success: false,
            error: 'No test files were written and could not push branch'
        });
    });

    test('performGitOperations: post-push verify throws into the catch when the ref is absent', function() {
        var mod = loadGitOpsModule(function(opts) {
            var command = opts.command;
            if (command === 'git diff --cached --stat') return '1 file changed';
            return '';
        });
        var result = mod.performGitOperations('test/DMC-5', 'Test changes', null, 'testing/');
        assert.equal(result.success, false);
        assert.contains(result.error, 'Branch not found on remote after push');
    });

    test('commitAndPushTestChanges sanitizes the commit message and keeps the fetch before push', function() {
        var calls = [];
        var mod = loadGitOpsModule(function(opts) {
            calls.push(opts.command);
            return '';
        });
        mod.commitAndPushTestChanges('test/DMC-6', 'Fix "quoted" <angle> | pipe', 'repo');
        assert.deepEqual(calls, [
            'git commit -m "Fix \\"quoted\\" angle pipe"',
            'git fetch origin test/DMC-6',
            'git push -u origin test/DMC-6'
        ], 'commit → fetch → push, with the sanitized message (pipe → space, quotes escaped)');
    });

    test('logStagingDiagnostics warns (never throws) when the listing fails', function() {
        var mod = loadGitOpsModule(function() { throw new Error('git down'); });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            mod.logStagingDiagnostics('testing', null);
            assert.equal(warnings.length, 1);
            assert.contains(warnings[0], 'Could not list testing:');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('verifyBranchOnRemoteAfterPush throws exactly when the strict probe finds no real ref line', function() {
        var mod = loadGitOpsModule(function(opts) {
            if (opts.command === 'git ls-remote --heads origin test/DMC-7') {
                return 'warning: redirecting to https://example.com/\n';
            }
            return '';
        });
        assert.throws(function() { mod.verifyBranchOnRemoteAfterPush('test/DMC-7', null); },
            'a warning-only capture must throw the not-on-remote error (gh-912)');

        var okMod = loadGitOpsModule(function(opts) {
            if (opts.command === 'git ls-remote --heads origin test/DMC-7') return lsRemoteRefResponse('test/DMC-7');
            return '';
        });
        assert.doesNotThrow(function() { okMod.verifyBranchOnRemoteAfterPush('test/DMC-7', null); },
            'a real ref line verifies the push');
    });

    test('publishNoStagedChanges warns with the add path and returns the noNewCommit success', function() {
        var calls = [];
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        var mod = loadGitOpsModule(function(opts) {
            calls.push(opts.command);
            if (opts.command === 'git ls-remote --heads origin test/DMC-8') return lsRemoteRefResponse('test/DMC-8');
            if (opts.command === 'git rev-parse HEAD') return 'same-sha';
            if (opts.command === 'git rev-parse origin/test/DMC-8') return 'same-sha';
            return '';
        });
        try {
            var result = mod.publishNoStagedChanges('test/DMC-8', 'testing/', null);
            assert.deepEqual(result, { success: true, branchName: 'test/DMC-8', noNewCommit: true });
            assert.ok(warnings.join('\n').indexOf('No new staged changes in testing/') !== -1,
                'the warn names the staged path');
            assert.ok(calls.indexOf('git reset --hard origin/test/DMC-8') === -1,
                'identical shas must not trigger a reset (gh-1043 order)');
        } finally {
            console.warn = originalWarn;
        }
    });

});
