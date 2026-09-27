/**
 * Unit tests for workflows/ai-teammate.yml.template (the per-repo AI
 * Teammate stub the target repos copy).
 *
 * Owner 2026-09-27 (live: dmd run 36333172145): a PR-anchored SM dispatch
 * (#544/#687 — inputs.pr set, inputs.issue empty) titled the run
 * '▶ rework (SM) · gh-\n· gh-: ' — the template rendered the 'gh-' prefix
 * with an empty scraped number. The run-name must carry the EFFECTIVE
 * anchor: pr-<N> after the fallback, gh-<N> when the issue anchor is real.
 */
'use strict';

suite('ai-teammate.yml.template — run-name carries the effective anchor', function () {

    var tpl = file_read({ path: 'workflows/ai-teammate.yml.template' });

    test('run-name renders pr-<N> when inputs.pr is set (PR-anchored fallback, #544/#687)', function () {
        assert.ok(tpl.indexOf("format('pr-{0}', github.event.inputs.pr)") !== -1,
            "run-name must format the PR anchor as pr-<N>");
        assert.ok(tpl.indexOf("(github.event.inputs.pr || '') != ''") !== -1,
            'null-safe pr guard — on label events inputs are null and null != \'\' would be TRUE');
        assert.ok(tpl.indexOf("format('▶ {0} (SM) · {1}'") !== -1,
            'the SM-dispatch title line takes the effective anchor as its second format arg');
    });

    test('run-name no longer renders a bare gh- prefix off the empty issue input', function () {
        assert.ok(tpl.indexOf("format('▶ {0} (SM) · gh-{1}', github.event.inputs.leg, github.event.inputs.issue)") === -1,
            'the malformed legacy template is gone — no gh- prefix off inputs.issue');
        assert.ok(tpl.indexOf("github.event.issue.number || github.event.inputs.issue") !== -1,
            'issue events keep the gh-<issue.number> anchor');
        assert.ok(tpl.indexOf("github.event.issue.title && format(': {0}', github.event.issue.title)") !== -1,
            "': <title>' renders only when an issue title exists (no trailing ': ' on PR-anchored runs)");
    });

    test('the dispatch contract declares the pr input (optional string, #687)', function () {
        var prDecl = tpl.indexOf('pr:');
        assert.ok(prDecl !== -1, 'pr input declared');
        assert.ok(tpl.indexOf("description: 'PR number for PR-anchored runs") !== -1,
            'pr input documented');
        assert.ok(tpl.indexOf("required: true,\n        type: number") === -1,
            'issue is no longer a required number — PR-anchored dispatches send an empty issue');
    });

    test('concurrency group keeps PR-anchored runs per-PR', function () {
        assert.ok(tpl.indexOf("format('pr-{0}', github.event.inputs.pr) }}") !== -1,
            'empty issue falls back to pr-<N> in the concurrency group — PR-anchored runs must not share one global group');
    });
});
