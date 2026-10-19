/**
 * Unit tests for js/postTestAutomationResultsHelpers.js — pure helpers
 * extracted from js/postTestAutomationResults.js (gh-961 CRAP split).
 */

function loadHelpers() {
    return loadModule(
        'js/postTestAutomationResultsHelpers.js',
        makeRequire({}),
        {}
    );
}

suite('postTestAutomationResultsHelpers: parseOutcome', function() {

    test('parses passed status', function() {
        var helpers = loadHelpers();
        var outcome = helpers.parseOutcome({ status: 'passed' });
        assert.equal(outcome.status, 'passed');
        assert.equal(outcome.passed, true);
        assert.equal(outcome.blockedByHuman, false);
    });

    test('parses failed status', function() {
        var helpers = loadHelpers();
        var outcome = helpers.parseOutcome({ status: 'FAILED' });
        assert.equal(outcome.status, 'failed');
        assert.equal(outcome.passed, false);
        assert.equal(outcome.blockedByHuman, false);
    });

    test('parses blocked_by_human status case-insensitively', function() {
        var helpers = loadHelpers();
        var outcome = helpers.parseOutcome({ status: 'Blocked_By_Human' });
        assert.equal(outcome.status, 'blocked_by_human');
        assert.equal(outcome.passed, false);
        assert.equal(outcome.blockedByHuman, true);
    });

    test('treats missing or malformed result as failed, not blocked', function() {
        var helpers = loadHelpers();
        var outcome = helpers.parseOutcome(null);
        assert.equal(outcome.status, '');
        assert.equal(outcome.passed, false);
        assert.equal(outcome.blockedByHuman, false);

        outcome = helpers.parseOutcome({});
        assert.equal(outcome.status, '');
        assert.equal(outcome.passed, false);
        assert.equal(outcome.blockedByHuman, false);
    });

});

suite('postTestAutomationResultsHelpers: label decisions', function() {

    test('decideWipLabel prefers metadata contextId', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decideWipLabel({ contextId: 'ctx' }), 'ctx_wip');
        assert.equal(helpers.decideWipLabel({}), 'test_case_automation_wip');
        assert.equal(helpers.decideWipLabel(null), 'test_case_automation_wip');
        assert.equal(helpers.decideWipLabel(undefined), 'test_case_automation_wip');
    });

    test('decideSmTriggerLabel reads jobParams.customParams.removeLabel', function() {
        var helpers = loadHelpers();
        assert.equal(
            helpers.decideSmTriggerLabel({ jobParams: { customParams: { removeLabel: 'sm_test_automation_triggered' } } }),
            'sm_test_automation_triggered'
        );
        assert.equal(helpers.decideSmTriggerLabel({ jobParams: { customParams: {} } }), null);
        assert.equal(helpers.decideSmTriggerLabel({ jobParams: {} }), null);
        assert.equal(helpers.decideSmTriggerLabel({}), null);
    });

});

suite('postTestAutomationResultsHelpers: buildMissingResultComment', function() {

    test('without partial push mentions Backlog retry only', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildMissingResultComment(false);
        assert.contains(comment, 'h3. ⚠️ Test Automation Error');
        assert.contains(comment, 'CLI exited without producing result JSON');
        assert.contains(comment, 'Ticket moved back to *Backlog* so SM can retry.');
        assert.notContains(comment, 'Partial code was pushed');
    });

    test('with partial push mentions the pushed branch', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildMissingResultComment(true);
        assert.contains(comment, 'h3. ⚠️ Test Automation Error');
        assert.contains(comment, 'Partial code was pushed to the branch');
        assert.contains(comment, 'Ticket moved back to *Backlog* so SM can retry.');
    });

});

suite('postTestAutomationResultsHelpers: buildMissingSetupItem', function() {

    test('renders name-only item', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.buildMissingSetupItem({}), '* *?*\n');
        assert.equal(helpers.buildMissingSetupItem({ name: 'API key' }), '* *API key*\n');
    });

    test('renders item with description', function() {
        var helpers = loadHelpers();
        assert.equal(
            helpers.buildMissingSetupItem({ name: 'API key', description: 'For staging' }),
            '* *API key*: For staging\n'
        );
    });

    test('renders item with how_to_add code block', function() {
        var helpers = loadHelpers();
        assert.equal(
            helpers.buildMissingSetupItem({ name: 'API key', how_to_add: 'echo KEY' }),
            '* *API key*\n{code:bash}echo KEY{code}\n'
        );
    });

    test('renders fully populated item', function() {
        var helpers = loadHelpers();
        assert.equal(
            helpers.buildMissingSetupItem({ name: 'API key', description: 'For staging', how_to_add: 'echo KEY' }),
            '* *API key*: For staging\n{code:bash}echo KEY{code}\n'
        );
    });

});

suite('postTestAutomationResultsHelpers: buildBlockedComment', function() {

    test('renders comment with reason and multiple missing items', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildBlockedComment({
            blocked_reason: 'Credentials missing',
            missing: [
                { name: 'API key', description: 'For staging', how_to_add: 'echo KEY' },
                { name: 'Device farm token' }
            ]
        }, null);

        assert.contains(comment, 'h3. 🚫 Test Automation Blocked — Awaiting Human Setup\n\n');
        assert.contains(comment, 'Credentials missing\n\n');
        assert.contains(comment, 'h4. Required setup:\n\n');
        assert.contains(comment, '* *API key*: For staging\n');
        assert.contains(comment, '{code:bash}echo KEY{code}\n');
        assert.contains(comment, '* *Device farm token*\n');
        assert.notContains(comment, 'Test Branch PR');
        assert.contains(comment, '\n\nOnce setup is complete, move this ticket back to *Backlog* to trigger re-run.');
    });

    test('appends PR link when prUrl is present', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildBlockedComment({
            blocked_reason: 'No creds',
            missing: []
        }, 'https://github.com/org/repo/pull/5');

        assert.contains(comment, 'No creds\n\n');
        assert.contains(comment, '*Test Branch PR* (test code is ready, skips without credentials): https://github.com/org/repo/pull/5');
        assert.notContains(comment, 'h4. Required setup:');
    });

    test('renders header and footer when result has neither reason nor missing items', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildBlockedComment({}, null);
        assert.contains(comment, 'h3. 🚫 Test Automation Blocked — Awaiting Human Setup\n\n');
        assert.notContains(comment, 'h4. Required setup:');
        assert.contains(comment, 'Once setup is complete, move this ticket back to *Backlog* to trigger re-run.');
    });

});

suite('postTestAutomationResultsHelpers: buildFinalComment', function() {

    test('returns plain comment when no PR and code changed', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.buildFinalComment('body', null, false), 'body');
    });

    test('returns empty string when nothing to post', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.buildFinalComment(null, null, false), '');
        assert.equal(helpers.buildFinalComment('', null, false), '');
    });

    test('appends PR link when prUrl present', function() {
        var helpers = loadHelpers();
        assert.equal(
            helpers.buildFinalComment('body', 'https://pr/1', false),
            'body\n\n*Test Branch PR*: https://pr/1'
        );
    });

    test('appends no-code-changes note when prUrl is absent', function() {
        var helpers = loadHelpers();
        assert.equal(
            helpers.buildFinalComment('body', null, true),
            'body\n\nℹ️ _Test code unchanged from previous run — PR review step skipped._'
        );
    });

    test('appends both PR link and no-code-changes note', function() {
        var helpers = loadHelpers();
        assert.equal(
            helpers.buildFinalComment('body', 'https://pr/1', true),
            'body\n\n*Test Branch PR*: https://pr/1' +
            '\n\nℹ️ _Test code unchanged from previous run — PR review step skipped._'
        );
    });

});

suite('postTestAutomationResultsHelpers: failure comments', function() {

    test('buildPrFailureComment names branch and error', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildPrFailureComment('test/DMC-1', 'boom');
        assert.contains(comment, 'h3. ⚠️ PR Creation Failed');
        assert.contains(comment, '{code}test/DMC-1{code}');
        assert.contains(comment, 'Ticket moved back to *Backlog*');
        assert.contains(comment, 'Error: boom');
    });

    test('buildPrFailureComment tolerates missing error', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildPrFailureComment('test/DMC-1', null);
        assert.contains(comment, 'Error: unknown');
    });

    test('buildGitFailureComment includes the git error', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildGitFailureComment('push rejected');
        assert.contains(comment, 'h3. ⚠️ Git Operations Failed');
        assert.contains(comment, 'Failed to commit/push test code: push rejected');
        assert.contains(comment, 'Ticket moved back to *Backlog*');
    });

    test('buildErrorComment wraps the error in a code block', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildErrorComment(new Error('config blew up'));
        assert.contains(comment, 'h3. ❌ Test Automation Error');
        assert.contains(comment, '{code}');
        assert.contains(comment, 'config blew up');
        assert.contains(comment, '{code}');
    });

});

suite('postTestAutomationResultsHelpers: buildConflictComment', function() {

    test('renders conflicting-PR comment with branch, base and PR link', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildConflictComment('test/DMC-2', 'main', 'https://pr/2');
        assert.contains(comment, 'h3. 🚫 Test Automation Blocked — PR Conflicts With Main');
        assert.contains(comment, '{code}test/DMC-2{code}');
        assert.contains(comment, '{code}main{code}');
        assert.contains(comment, '*Pull Request:* https://pr/2');
        assert.contains(comment, 'Ticket moved to *Blocked* for human conflict resolution.');
    });

});

suite('postTestAutomationResultsHelpers: buildPartialCommitMessage', function() {

    test('appends the partial marker', function() {
        var helpers = loadHelpers();
        assert.equal(
            helpers.buildPartialCommitMessage('test: DMC-1 automate'),
            'test: DMC-1 automate (partial — CLI interrupted)'
        );
    });

});

suite('postTestAutomationResultsHelpers: decidePublishStrategy', function() {

    test('identical when both shas exist and match', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decidePublishStrategy('aaa', 'aaa', 'aaa'), 'identical');
        assert.equal(helpers.decidePublishStrategy('aaa', 'aaa', ''), 'identical');
    });

    test('not identical when either sha is missing', function() {
        var helpers = loadHelpers();
        assert.notEqual(helpers.decidePublishStrategy('', 'aaa', 'aaa'), 'identical');
        assert.notEqual(helpers.decidePublishStrategy('aaa', '', 'aaa'), 'identical');
        assert.notEqual(helpers.decidePublishStrategy('', '', ''), 'identical');
    });

    test('ahead when merge-base equals remote but differs from local', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decidePublishStrategy('bbb', 'aaa', 'aaa'), 'ahead');
    });

    test('ahead matches even with empty strings (failed rev-parse edge)', function() {
        var helpers = loadHelpers();
        // Original condition mergeBase === remoteSha && mergeBase !== localSha
        // with mergeBase '' and remoteSha '': falls into the fast-forward push
        // branch, NOT straight to the diverged escalation.
        assert.equal(helpers.decidePublishStrategy('', '', ''), 'diverged');
        assert.equal(helpers.decidePublishStrategy('bbb', '', ''), 'ahead');
        assert.equal(helpers.decidePublishStrategy('', 'ccc', ''), 'behind');
    });

    test('behind when merge-base equals local but differs from remote', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decidePublishStrategy('aaa', 'bbb', 'aaa'), 'behind');
    });

    test('diverged when branches have no common merge-base relation', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decidePublishStrategy('aaa', 'bbb', 'ccc'), 'diverged');
        assert.equal(helpers.decidePublishStrategy('aaa', 'bbb', ''), 'diverged');
    });

});

suite('postTestAutomationResultsHelpers: decideTargetStatus', function() {

    test('first-run passed goes to In Review - Passed', function() {
        var helpers = loadHelpers();
        var target = helpers.decideTargetStatus(true, false, {
            PASSED: 'Passed',
            IN_REVIEW_PASSED: 'In Review - Passed',
            FAILED: 'Failed',
            IN_REVIEW_FAILED: 'In Review - Failed'
        });
        assert.equal(target.stage, 'IN_REVIEW_PASSED');
        assert.equal(target.statusName, 'In Review - Passed');
    });

    test('no-code-changes passed goes directly to Passed', function() {
        var helpers = loadHelpers();
        var target = helpers.decideTargetStatus(true, true, {
            PASSED: 'Passed',
            IN_REVIEW_PASSED: 'In Review - Passed',
            FAILED: 'Failed',
            IN_REVIEW_FAILED: 'In Review - Failed'
        });
        assert.equal(target.stage, 'PASSED');
        assert.equal(target.statusName, 'Passed');
    });

    test('first-run failed goes to In Review - Failed', function() {
        var helpers = loadHelpers();
        var target = helpers.decideTargetStatus(false, false, {
            PASSED: 'Passed',
            IN_REVIEW_PASSED: 'In Review - Passed',
            FAILED: 'Failed',
            IN_REVIEW_FAILED: 'In Review - Failed'
        });
        assert.equal(target.stage, 'IN_REVIEW_FAILED');
        assert.equal(target.statusName, 'In Review - Failed');
    });

    test('no-code-changes failed goes directly to Failed', function() {
        var helpers = loadHelpers();
        var target = helpers.decideTargetStatus(false, true, {
            PASSED: 'Passed',
            IN_REVIEW_PASSED: 'In Review - Passed',
            FAILED: 'Failed',
            IN_REVIEW_FAILED: 'In Review - Failed'
        });
        assert.equal(target.stage, 'FAILED');
        assert.equal(target.statusName, 'Failed');
    });

});

// ── gh-1083: action() split — pure identity + git-stage routing ──────────────

suite('postTestAutomationResultsHelpers: resolveTicketIdentity (gh-1083)', function() {

    test('summary comes from ticket.fields when present', function() {
        var helpers = loadHelpers();
        var identity = helpers.resolveTicketIdentity({
            ticket: { key: 'PROJ-12', fields: { summary: 'Fix the login flow' } }
        });
        assert.deepEqual(identity, {
            ticketKey: 'PROJ-12',
            ticketSummary: 'Fix the login flow',
            projectKey: 'PROJ'
        });
    });

    test('missing fields degrade the summary to the ticket key', function() {
        var helpers = loadHelpers();
        var identity = helpers.resolveTicketIdentity({ ticket: { key: 'PROJ-13' } });
        assert.equal(identity.ticketSummary, 'PROJ-13');
        assert.equal(identity.projectKey, 'PROJ');
    });

    test('null fields degrade the summary to the ticket key', function() {
        var helpers = loadHelpers();
        var identity = helpers.resolveTicketIdentity({ ticket: { key: 'AB-9', fields: null } });
        assert.equal(identity.ticketSummary, 'AB-9');
        assert.equal(identity.projectKey, 'AB');
    });

    test('projectKey is the part before the first dash', function() {
        var helpers = loadHelpers();
        var identity = helpers.resolveTicketIdentity({
            ticket: { key: 'LONGPROJ-TC-44', fields: { summary: 's' } }
        });
        assert.equal(identity.projectKey, 'LONGPROJ');
    });

});

suite('postTestAutomationResultsHelpers: decideGitStageRoute (gh-1083)', function() {

    test('success with a new commit routes to create-pr', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decideGitStageRoute({ success: true }), 'create-pr');
        assert.equal(helpers.decideGitStageRoute({ success: true, noNewCommit: false }), 'create-pr');
    });

    test('success without a new commit routes to no-new-commit', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decideGitStageRoute({ success: true, noNewCommit: true }), 'no-new-commit');
    });

    test('failed git result routes to git-failure', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decideGitStageRoute({ success: false, error: 'boom' }), 'git-failure');
        assert.equal(helpers.decideGitStageRoute({}), 'git-failure');
    });

    test('noNewCommit is honoured even without success (original else-if ignores success)', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decideGitStageRoute({ noNewCommit: true }), 'no-new-commit');
    });

    test('null gitResult throws like the original field access did', function() {
        var helpers = loadHelpers();
        var threw = null;
        try { helpers.decideGitStageRoute(null); } catch (e) { threw = e; }
        assert.ok(threw, 'null gitResult must throw, not silently route');
    });

});
