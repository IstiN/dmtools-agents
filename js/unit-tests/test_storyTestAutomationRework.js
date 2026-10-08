/**
 * Unit tests for js/storyTestAutomationRework.js — mergeMain guard (gh-761)
 *
 * The rework post-action runs `git merge origin/main` after the CLI agent
 * finishes. When a merge is ALREADY in progress (MERGE_HEAD present — the
 * agent left a conflicted base-branch merge unconcluded), the old flow
 * finalized that foreign merge: `git merge` failed with "You have not
 * concluded your merge", the fallback then auto-resolved the leftover
 * unmerged paths (--ours/--theirs) and committed them — baking conflict
 * markers into a merge nobody deliberately resolved.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadTrackersSr(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

function loadRework(mocks) {
    var requireMap = {
        './configLoader.js': {
            formatTemplate: function (template, values) {
                return template.replace(/\{ticketKey\}/g, values.ticketKey);
            }
        },
        './common/autoStart.js': {
            triggerConfiguredWorkflowForTicket: function () { return true; },
            triggerSmIfIdle: function () {}
        },
        './common/pullRequest.js': {},
        './common/mergeState.js': loadModule('js/common/mergeState.js'),
        './config.js': { LABELS: {} },
        './common/tokenUsageComment.js': {
            postTokenUsageComments: function () {}
        }
    };
    var allMocks = Object.assign({
        cli_execute_command: function () { return ''; },
        file_read: function () { return null; },
        file_write: function () {}
    }, mocks || {});
    requireMap['./common/trackers.js'] = loadTrackersSr(allMocks);
    return loadModule(
        'js/storyTestAutomationRework.js',
        makeRequire(requireMap),
        allMocks
    );
}

var TEST_CONFIG = {
    workingDir: 'repo',
    git: { authorName: 'AI Teammate', authorEmail: 'ai@example.com' }
};

suite('storyTestAutomationRework — mergeMain mid-merge guard (gh-761)', function() {

    test('refuses to start while MERGE_HEAD exists — must not auto-resolve or finalize a foreign merge', function() {
        var commands = [];
        var m = loadRework({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                    return '9a7e2aecommitsha'; // merge in progress
                }
                return '';
            }
        });

        var threw = null;
        try {
            m.mergeMain('PROJ-123', TEST_CONFIG);
        } catch (e) {
            threw = e;
        }

        assert.ok(threw, 'mergeMain must refuse (throw) when a merge is in progress');
        assert.contains(threw.toString(), 'MERGE_HEAD');
        assert.equal(commands.length, 1, 'only the MERGE_HEAD probe may run before the refusal');
        assert.equal(commands.filter(function(c) { return c.indexOf('git merge') === 0; }).length, 0,
            'must not start a merge on top of an unconcluded one');
        assert.equal(commands.filter(function(c) { return c.indexOf('git checkout --') !== -1; }).length, 0,
            'must not auto-resolve the leftover unmerged paths');
        assert.equal(commands.filter(function(c) { return c.indexOf('git commit') === 0; }).length, 0,
            'must not finalize a merge this step did not start');
    });

    test('proceeds with the origin/main merge when no merge is in progress', function() {
        var commands = [];
        var m = loadRework({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                    throw new Error('Command execution failed (exit code 1)'); // no MERGE_HEAD
                }
                return '';
            }
        });

        m.mergeMain('PROJ-123', TEST_CONFIG);

        assert.ok(commands.some(function(c) { return c === 'git merge origin/main --no-edit'; }),
            'the origin/main merge must still run on a clean (non-merge) state');
    });

    test('refusal error names the ticket context so the job failure is actionable', function() {
        var m = loadRework({
            cli_execute_command: function(args) {
                if (args.command === 'git rev-parse --quiet --verify MERGE_HEAD') {
                    return '9a7e2aecommitsha';
                }
                return '';
            }
        });

        var threw = null;
        try {
            m.mergeMain('PROJ-999', { workingDir: null, git: TEST_CONFIG.git });
        } catch (e) {
            threw = e;
        }

        assert.ok(threw, 'must refuse');
        assert.contains(threw.toString(), 'conclude', 'error must tell the operator what to do');
    });

    test('ado provider: push-failure comment + wip cleanup use ado_* tools, no jira_* (wave1c)', function() {
        var tools = [];
        var mocks = {
            cli_execute_command: function () { throw new Error('git boom'); },
            file_read: function () { return null; },
            file_write: function () {}
        };
        ['jira_post_comment', 'jira_remove_label', 'ado_add_work_item_comment', 'ado_remove_work_item_label'].forEach(function (n) {
            mocks[n] = function () { tools.push(n); };
        });
        var m = loadRework(mocks);
        // loadRework's configLoader stub only formats templates; patch in the pieces action() needs.
        var req = {
            './configLoader.js': {
                loadProjectConfig: function () { return Object.assign({}, TEST_CONFIG, { jira: { statuses: {} } }); },
                createScm: function () { return {}; },
                formatTemplate: function (t) { return t; }
            },
            './common/autoStart.js': { triggerSmIfIdle: function () {} },
            './common/pullRequest.js': {},
            './common/mergeState.js': loadModule('js/common/mergeState.js'),
            './config.js': { LABELS: {} },
            './common/tokenUsageComment.js': { postTokenUsageComments: function () {} },
            './common/trackers.js': loadTrackersSr(mocks)
        };
        var mod = loadModule('js/storyTestAutomationRework.js', makeRequire(req), mocks);
        var result = mod.action({
            ticket: { key: '88' },
            metadata: { contextId: 'story_test_automation_rework' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(result.success, false);
        assert.equal(tools.filter(function (t) { return t.indexOf('jira_') === 0; }).length, 0);
        assert.ok(tools.indexOf('ado_add_work_item_comment') !== -1);
        assert.ok(tools.indexOf('ado_remove_work_item_label') !== -1);
    });
});
