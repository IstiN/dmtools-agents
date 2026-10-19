/**
 * Characterization tests for js/redirectToRepoAgent.js.
 *
 * Pin the delegation contract: agent path + dmtools command shape, tracker
 * usage (lazy, folder-key fallback), abort semantics (always returns false)
 * and every early-abort branch. Same external calls in the same order.
 */

function loadRedirectToRepoAgent(opts) {
    opts = opts || {};
    var calls = {
        created: [],
        getIssue: [],
        cli: []
    };

    var tracker = {
        getIssue: function (key) {
            calls.getIssue.push(key);
            if (opts.getIssueThrows) throw new Error('tracker down');
            if (opts.fetchedTicket !== undefined) return opts.fetchedTicket;
            return { key: key, fields: { summary: opts.fetchedSummary || '' } };
        }
    };

    var trackersMock = {
        createTracker: function (config, customParams) {
            calls.created.push({ config: config, customParams: customParams });
            return tracker;
        }
    };

    var globalMocks = {
        cli_execute_command: function (args) {
            calls.cli.push(args);
            if (opts.cliThrows) throw new Error('cli exploded');
            return 'done';
        }
    };

    var mod = loadModule(
        'js/redirectToRepoAgent.js',
        makeRequire({ './common/trackers.js': trackersMock }),
        globalMocks
    );

    return { mod: mod, calls: calls };
}

suite('redirectToRepoAgent.action', function () {

    test('happy path: params.ticket drives the command, tracker never consulted', function () {
        var loaded = loadRedirectToRepoAgent({});
        var result = loaded.mod.action({
            ticket: { key: 'PROJ-7', fields: { summary: '[my-repo] Build the thing' } }
        });

        assert.equal(result, false, 'always aborts own processing');
        assert.deepEqual(loaded.calls.cli, [
            { command: 'dmtools --debug run "repo-agents/my-repo/story_development.json" --inputJql "key=PROJ-7"' }
        ]);
        assert.deepEqual(loaded.calls.getIssue, [], 'ticket present — no tracker fetch');
        assert.deepEqual(loaded.calls.created, [], 'tracker is created lazily — factory not called');
    });

    test('custom targetAgentName and repoAgentsDir are honoured', function () {
        var loaded = loadRedirectToRepoAgent({});
        loaded.mod.action({
            ticket: { key: 'PROJ-7', fields: { summary: '[web] Test it' } },
            jobParams: {
                customParams: { targetAgentName: 'story_development_test.json', repoAgentsDir: 'team-agents' }
            }
        });

        assert.deepEqual(loaded.calls.cli, [
            { command: 'dmtools --debug run "team-agents/web/story_development_test.json" --inputJql "key=PROJ-7"' }
        ]);
    });

    test('missing ticket is fetched with the folder-derived key; ciRunUrl from jobParams forwarded', function () {
        var loaded = loadRedirectToRepoAgent({ fetchedSummary: '[repo2] Do work' });
        var result = loaded.mod.action({
            jobParams: {
                inputFolderPath: 'input/PROJ-9',
                customParams: {},
                ciRunUrl: 'https://ci.example.com/run/42'
            }
        });

        assert.equal(result, false);
        assert.deepEqual(loaded.calls.getIssue, ['PROJ-9']);
        assert.deepEqual(loaded.calls.created, [
            { config: null, customParams: {} }
        ]);
        assert.deepEqual(loaded.calls.cli, [
            { command: 'dmtools --debug run "repo-agents/repo2/story_development.json" --inputJql "key=PROJ-9" --ciRunUrl "https://ci.example.com/run/42"' }
        ]);
    });

    test('ticket without fields is re-fetched from the tracker', function () {
        var loaded = loadRedirectToRepoAgent({ fetchedSummary: '[refetched] x' });
        loaded.mod.action({
            ticket: { key: 'PROJ-1' },
            jobParams: { inputFolderPath: 'input/PROJ-1', customParams: {} }
        });

        assert.deepEqual(loaded.calls.getIssue, ['PROJ-1']);
        assert.deepEqual(loaded.calls.cli, [
            { command: 'dmtools --debug run "repo-agents/refetched/story_development.json" --inputJql "key=PROJ-1"' }
        ]);
    });

    test('fetched ticket without key falls back to the folder-derived ticket key', function () {
        var loaded = loadRedirectToRepoAgent({
            fetchedTicket: { fields: { summary: '[k] s' } }
        });
        loaded.mod.action({
            jobParams: { inputFolderPath: 'input/PROJ-11', customParams: {} }
        });

        assert.deepEqual(loaded.calls.cli, [
            { command: 'dmtools --debug run "repo-agents/k/story_development.json" --inputJql "key=PROJ-11"' }
        ]);
    });

    test('repo name is trimmed inside the brackets; first ] closes the tag', function () {
        var loaded = loadRedirectToRepoAgent({});
        loaded.mod.action({
            ticket: { key: 'PROJ-2', fields: { summary: '[ spaced-repo ]x] rest' } }
        });

        assert.deepEqual(loaded.calls.cli, [
            { command: 'dmtools --debug run "repo-agents/spaced-repo/story_development.json" --inputJql "key=PROJ-2"' }
        ]);
    });

    test('summary not starting with [ aborts without running anything', function () {
        var loaded = loadRedirectToRepoAgent({});
        var result = loaded.mod.action({
            ticket: { key: 'PROJ-3', fields: { summary: 'repo] nope' } }
        });

        assert.equal(result, false);
        assert.deepEqual(loaded.calls.cli, []);
    });

    test('summary without a closing ] aborts without running anything', function () {
        var loaded = loadRedirectToRepoAgent({});
        var result = loaded.mod.action({
            ticket: { key: 'PROJ-3', fields: { summary: '[orphan-tag' } }
        });

        assert.equal(result, false);
        assert.deepEqual(loaded.calls.cli, []);
    });

    test('empty summary aborts without running anything', function () {
        var loaded = loadRedirectToRepoAgent({});
        var result = loaded.mod.action({
            ticket: { key: 'PROJ-3', fields: {} }
        });

        assert.equal(result, false);
        assert.deepEqual(loaded.calls.cli, []);
    });

    test('tracker fetch failure aborts without running anything', function () {
        var loaded = loadRedirectToRepoAgent({ getIssueThrows: true });
        var result = loaded.mod.action({
            jobParams: { inputFolderPath: 'input/PROJ-4', customParams: {} }
        });

        assert.equal(result, false);
        assert.deepEqual(loaded.calls.cli, []);
    });

    test('cli_execute_command failure aborts (returns false)', function () {
        var loaded = loadRedirectToRepoAgent({ cliThrows: true });
        var result = loaded.mod.action({
            ticket: { key: 'PROJ-5', fields: { summary: '[r] ok' } }
        });

        assert.equal(result, false);
        assert.equal(loaded.calls.cli.length, 1, 'the command was attempted');
    });

    test('ciRunUrl resolution order: params.ciRunUrl also accepted, absent means no flag', function () {
        var loaded = loadRedirectToRepoAgent({});
        loaded.mod.action({
            ticket: { key: 'PROJ-6', fields: { summary: '[a] b' } },
            ciRunUrl: 'https://ci.example.com/run/7'
        });

        assert.deepEqual(loaded.calls.cli, [
            { command: 'dmtools --debug run "repo-agents/a/story_development.json" --inputJql "key=PROJ-6" --ciRunUrl "https://ci.example.com/run/7"' }
        ]);

        var plain = loadRedirectToRepoAgent({});
        plain.mod.action({
            ticket: { key: 'PROJ-6', fields: { summary: '[a] b' } }
        });
        assert.deepEqual(plain.calls.cli, [
            { command: 'dmtools --debug run "repo-agents/a/story_development.json" --inputJql "key=PROJ-6"' }
        ]);
    });

});
