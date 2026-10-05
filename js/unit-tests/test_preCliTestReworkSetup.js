/**
 * Unit tests for js/preCliTestReworkSetup.js
 *
 * Scope: the PR auto-creation leg of action() — gh-738 review thread 2
 * ("this caller bypasses the createPullRequest choke point"). The rework-setup
 * action must route PR creation through prHelper.createPullRequest (the single
 * gh-737 choke point that guarantees the canonical 'Closes #N' line) instead of
 * calling scm.createPr directly and hand-applying prHelper.ensureClosesLine.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helper ─────────────────────────────────────────────────────────────

function loadPreCliTestReworkSetup(mocks, spies) {
    var realPrHelper = loadModule(
        'js/common/pullRequest.js',
        null,
        {
            cli_execute_command: function() { return ''; },
            file_read: function() { return null; },
            file_write: function() {},
            file_delete: function() {}
        }
    );

    // Spy wrapper around the real helper: records every entry point the module
    // uses so tests can prove the single-choke-point contract (createPullRequest
    // called WITH ticketKey; ensureClosesLine never hand-applied by the module).
    var prHelperSpy = Object.assign({}, realPrHelper, {
        createPullRequest: function(options) {
            spies.createPullRequestCalls.push(options);
            return realPrHelper.createPullRequest(options);
        },
        ensureClosesLine: function(body, ticketKey) {
            spies.ensureClosesLineCalls.push({ body: body, ticketKey: ticketKey });
            return realPrHelper.ensureClosesLine(body, ticketKey);
        }
    });

    var scmStub = {
        getRemoteRepoInfo: function() { return { owner: 'ExampleOrg', repo: 'example-repo' }; },
        listPrs: function() { return []; },
        createPr: function(options) {
            spies.scmCreatePrCalls.push(options);
            return { success: true, prUrl: 'https://github.com/ExampleOrg/example-repo/pull/55', number: 55 };
        }
    };

    var configStub = {
        git: { baseBranch: 'main' },
        workingDir: 'repo',
        jira: { statuses: { BACKLOG: 'Backlog' } },
        formats: { prTitle: { rework: '{ticketKey} {ticketSummary}' } }
    };

    var configLoaderStub = {
        loadProjectConfig: function() { return configStub; },
        createScm: function() { return scmStub; },
        formatTemplate: function(template, vars) {
            return String(template || '').replace(/\{(\w+)\}/g, function(_, name) {
                return vars && vars[name] !== undefined ? vars[name] : '';
            });
        }
    };

    var ghStub = {
        buildOriginFetchCommand: function() { return 'git fetch origin'; },
        getPRDetails: function() {
            return {
                number: 55,
                html_url: 'https://github.com/ExampleOrg/example-repo/pull/55',
                head: { ref: 'test/gh-737' },
                base: { ref: 'main' }
            };
        },
        fetchDiscussionsAndRawData: function() { return { markdown: '', rawThreads: [] }; }
    };

    var gitOpsStub = {
        checkoutPRBranch: function() {},
        detectMergeConflicts: function() { return []; },
        getPRDiff: function() { return ''; },
        writePRContext: function() {}
    };

    var moduleMap = {
        './configLoader.js': configLoaderStub,
        './common/githubHelpers.js': ghStub,
        './common/gitOps.js': gitOpsStub,
        './common/pullRequest.js': prHelperSpy,
        './fetchQuestionsToInput.js': { action: function() {} },
        './fetchLinkedBugsToInput.js': { action: function() {} }
    };

    var allMocks = Object.assign({
        cli_execute_command: function(args) {
            var cmd = args && args.command ? args.command : String(args || '');
            if (cmd.indexOf('git ls-remote --heads origin test/gh-737') !== -1) {
                return 'a1b2c3\trefs/heads/test/gh-737';
            }
            return '';
        },
        jira_get_ticket: function(opts) {
            return { key: opts.key || opts, fields: { summary: 'Example summary' } };
        },
        jira_post_comment: function() {},
        jira_move_to_status: function() {}
    }, mocks || {});

    return loadModule('js/preCliTestReworkSetup.js', makeRequire(moduleMap), allMocks);
}

function makeSpies() {
    return {
        createPullRequestCalls: [],
        ensureClosesLineCalls: [],
        scmCreatePrCalls: []
    };
}

function makeParams(ticketKey) {
    return {
        inputFolderPath: 'input/' + ticketKey,
        jobParams: {}
    };
}

// ── Suite: PR auto-creation routes through the createPullRequest choke point ──

suite('preCliTestReworkSetup — PR creation goes through the single choke point', function() {

    test('routes PR creation through prHelper.createPullRequest with the ticketKey', function() {
        var spies = makeSpies();
        var mod = loadPreCliTestReworkSetup(null, spies);

        var result = mod.action(makeParams('gh-737'));

        assert.equal(result.success, true);
        assert.equal(spies.createPullRequestCalls.length, 1,
            'PR creation must go through prHelper.createPullRequest (the gh-737 choke point), got ' +
            spies.createPullRequestCalls.length + ' call(s)');

        var options = spies.createPullRequestCalls[0];
        assert.equal(options.ticketKey, 'gh-737',
            'the ticketKey must be threaded so the helper can inject the canonical Closes line');
        assert.equal(options.branchName, 'test/gh-737');
        assert.equal(options.baseBranch, 'main');
    });

    test('the PR body created via the choke point carries Closes #N by construction', function() {
        var spies = makeSpies();
        var mod = loadPreCliTestReworkSetup(null, spies);

        mod.action(makeParams('gh-737'));

        assert.equal(spies.scmCreatePrCalls.length, 1, 'exactly one PR must be created');
        assert.contains(spies.scmCreatePrCalls[0].body, 'Closes #737',
            'the merge bot links approved issues only via Closes #N in the body');
        assert.contains(spies.scmCreatePrCalls[0].body, 'Auto-created PR for rework of test automation',
            'the auto-created body text is preserved');
    });

    test('does not hand-apply ensureClosesLine on a raw scm.createPr call (no bypass)', function() {
        var spies = makeSpies();
        var mod = loadPreCliTestReworkSetup(null, spies);

        mod.action(makeParams('gh-737'));

        assert.equal(spies.ensureClosesLineCalls.length, 0,
            'the module must not apply ensureClosesLine itself — that is the helper\'s job; ' +
            'a second place remembering the guarantee is exactly the drift gh-737 set out to eliminate');
    });

});
