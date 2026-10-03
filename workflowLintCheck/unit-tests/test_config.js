/**
 * Unit tests for js/config.js — resolveStatuses().
 *
 * Covers the two supported status-override channels and their precedence:
 *   1. projectStatuses (from .dmtools/config.js's `jira.statuses`, project-wide)
 *   2. customParams.customStatuses (legacy, per-agent-invocation)
 * Neither channel should require changing the shared STATUSES defaults — a
 * project with a different Story/Bug workflow (e.g. renamed/added statuses,
 * or a rework bounce-back target other than IN_REWORK) configures this via
 * .dmtools/config.js only, leaving the generic defaults untouched for every
 * other consumer of this repo.
 */

var config = loadModule('js/config.js');

suite('config.resolveStatuses', function() {
    test('returns the generic STATUSES defaults unchanged when no overrides are given', function() {
        var statuses = config.resolveStatuses();
        assert.equal(statuses.IN_REVIEW, 'In Review');
        assert.equal(statuses.IN_REWORK, 'In Rework');
        assert.equal(statuses.READY_FOR_DEVELOPMENT, 'Ready For Development');
    });

    test('projectStatuses overrides only the keys it specifies, keeping other defaults', function() {
        var statuses = config.resolveStatuses(null, {
            IN_REVIEW: 'Ready for Review',
            IN_REWORK: 'Ready For Development'
        });
        assert.equal(statuses.IN_REVIEW, 'Ready for Review');
        assert.equal(statuses.IN_REWORK, 'Ready For Development');
        // Unrelated defaults are untouched
        assert.equal(statuses.READY_FOR_DEVELOPMENT, 'Ready For Development');
        assert.equal(statuses.IN_DEVELOPMENT, 'In Development');
    });

    test('customParams.customStatuses wins over projectStatuses for the same key', function() {
        var statuses = config.resolveStatuses(
            { customStatuses: { IN_REVIEW: 'Per-Run Review Override' } },
            { IN_REVIEW: 'Ready for Review' }
        );
        assert.equal(statuses.IN_REVIEW, 'Per-Run Review Override');
    });

    test('a project can remap the rework bounce-back target without changing the generic default', function() {
        // Simulates a project (like GENSGENP) whose Jira instance has no "In Rework"
        // status: the caller keeps using statuses.IN_REWORK generically, and the
        // project's jira.statuses override makes it resolve to its real status name.
        var genericStatuses = config.resolveStatuses();
        assert.equal(genericStatuses.IN_REWORK, 'In Rework');

        var projectStatuses = config.resolveStatuses(null, { IN_REWORK: 'Ready For Development' });
        assert.equal(projectStatuses.IN_REWORK, 'Ready For Development');
    });

    test('is tolerant of a non-object projectStatuses (e.g. missing config.jira.statuses)', function() {
        var statuses = config.resolveStatuses(null, undefined);
        assert.equal(statuses.IN_REVIEW, 'In Review');
    });
});

suite('config.truncateSummary', function() {
    test('returns the summary unchanged when at or under the limit', function() {
        var summary = 'a'.repeat(255);
        assert.equal(config.truncateSummary(summary, 255), summary);
        assert.equal(config.truncateSummary('short summary', 255), 'short summary');
    });

    test('truncates and appends ellipsis when over the limit', function() {
        var summary = 'a'.repeat(300);
        var result = config.truncateSummary(summary, 255);
        assert.equal(result.length, 255);
        assert.equal(result.slice(-3), '...');
        assert.equal(result.slice(0, 252), 'a'.repeat(252));
    });

    test('defaults maxLength to JIRA_SUMMARY_MAX_LENGTH (255) when not provided', function() {
        var summary = 'a'.repeat(300);
        var result = config.truncateSummary(summary);
        assert.equal(result.length, config.JIRA_SUMMARY_MAX_LENGTH);
    });

    test('handles null/undefined summary safely', function() {
        assert.equal(config.truncateSummary(null, 255), '');
        assert.equal(config.truncateSummary(undefined, 255), '');
    });

    test('JIRA_SUMMARY_MAX_LENGTH is 255 (Jira API hard limit)', function() {
        assert.equal(config.JIRA_SUMMARY_MAX_LENGTH, 255);
    });
});
