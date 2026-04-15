/**
 * Unit tests for the ai_tests_generated guard in postPRReviewComments.js
 *
 * Verifies that TestCasesGenerator is triggered only once per ticket:
 * - First approval (no label)  → triggered + label added
 * - Second approval (label present) → skipped
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTicket(labels) {
    return { key: 'MAPC-9999', fields: { labels: labels || [], summary: 'Test ticket' } };
}

function makeOnApprovedConfig(withTestCasesGenerator) {
    return {
        bitriseBuild: null,
        testCasesGenerator: withTestCasesGenerator ? {
            configFile: 'ai_teammate/mapc/TestCasesGenerator.json',
            workflow: 'ai-teammate.yml'
        } : null
    };
}

function makeCustomParams(onApproved) {
    return {
        onApproved: onApproved,
        aiRepository: { owner: 'PostNL-BitDigital', repo: 'PostNL-commercial-ai' },
        configPath: '.dmtools/configs/mapc.js'
    };
}

// Minimal stub for the guard logic extracted from postPRReviewComments.js step 13b
function runTestCasesGeneratorGuard(ticket, customParams, mocks) {
    var labels = (ticket && ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
    var triggered = false;
    var labelAdded = false;
    var skipped = false;

    if (customParams && customParams.onApproved && customParams.onApproved.testCasesGenerator) {
        var tcg = customParams.onApproved.testCasesGenerator;
        var aiRepoCfg = customParams.aiRepository;
        var aiOwner = aiRepoCfg && aiRepoCfg.owner;
        var aiRepo = aiRepoCfg && aiRepoCfg.repo;

        var alreadyGenerated = labels.indexOf('ai_tests_generated') !== -1;
        if (alreadyGenerated) {
            skipped = true;
        } else if (aiOwner && aiRepo) {
            mocks.github_trigger_workflow(aiOwner, aiRepo, tcg.workflow, '{}', 'main');
            triggered = true;
            mocks.jira_add_label({ key: ticket.key, label: 'ai_tests_generated' });
            labelAdded = true;
        }
    }

    return { triggered: triggered, labelAdded: labelAdded, skipped: skipped };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('ai_tests_generated guard', function () {

    test('first approval — no label — triggers TestCasesGenerator and adds label', function () {
        var ticket = makeTicket([]);
        var customParams = makeCustomParams(makeOnApprovedConfig(true));
        var workflowTriggered = false;
        var labelAdded = null;
        var mocks = {
            github_trigger_workflow: function () { workflowTriggered = true; },
            jira_add_label: function (args) { labelAdded = args.label; }
        };

        var result = runTestCasesGeneratorGuard(ticket, customParams, mocks);

        assert.equal(result.triggered, true, 'should trigger workflow');
        assert.equal(result.labelAdded, true, 'should add label');
        assert.equal(result.skipped, false, 'should NOT be skipped');
        assert.equal(workflowTriggered, true, 'github_trigger_workflow must be called');
        assert.equal(labelAdded, 'ai_tests_generated', 'must add ai_tests_generated label');
    });

    test('second approval — label present — skips TestCasesGenerator', function () {
        var ticket = makeTicket(['ai_tests_generated', 'ai_generated']);
        var customParams = makeCustomParams(makeOnApprovedConfig(true));
        var workflowTriggered = false;
        var mocks = {
            github_trigger_workflow: function () { workflowTriggered = true; },
            jira_add_label: function () {}
        };

        var result = runTestCasesGeneratorGuard(ticket, customParams, mocks);

        assert.equal(result.triggered, false, 'should NOT trigger workflow on re-approval');
        assert.equal(result.skipped, true, 'should be marked as skipped');
        assert.equal(workflowTriggered, false, 'github_trigger_workflow must NOT be called');
    });

    test('no testCasesGenerator in onApproved — nothing happens', function () {
        var ticket = makeTicket([]);
        var customParams = makeCustomParams(makeOnApprovedConfig(false));
        var workflowTriggered = false;
        var mocks = {
            github_trigger_workflow: function () { workflowTriggered = true; },
            jira_add_label: function () {}
        };

        var result = runTestCasesGeneratorGuard(ticket, customParams, mocks);

        assert.equal(result.triggered, false, 'should not trigger when not configured');
        assert.equal(result.skipped, false, 'not skipped — just not configured');
        assert.equal(workflowTriggered, false, 'github_trigger_workflow must NOT be called');
    });

    test('other labels present but not ai_tests_generated — triggers normally', function () {
        var ticket = makeTicket(['ai_generated', 'pr_approved', 'ai_pr_reviewed']);
        var customParams = makeCustomParams(makeOnApprovedConfig(true));
        var workflowTriggered = false;
        var mocks = {
            github_trigger_workflow: function () { workflowTriggered = true; },
            jira_add_label: function () {}
        };

        var result = runTestCasesGeneratorGuard(ticket, customParams, mocks);

        assert.equal(result.triggered, true, 'should trigger — ai_tests_generated not present');
        assert.equal(workflowTriggered, true, 'github_trigger_workflow must be called');
    });

    test('no aiRepository configured — skips workflow but does not crash', function () {
        var ticket = makeTicket([]);
        var customParams = {
            onApproved: makeOnApprovedConfig(true),
            aiRepository: null
        };
        var workflowTriggered = false;
        var mocks = {
            github_trigger_workflow: function () { workflowTriggered = true; },
            jira_add_label: function () {}
        };

        var result = runTestCasesGeneratorGuard(ticket, customParams, mocks);

        assert.equal(result.triggered, false, 'should not trigger without aiRepository');
        assert.equal(workflowTriggered, false, 'github_trigger_workflow must NOT be called');
    });
});
