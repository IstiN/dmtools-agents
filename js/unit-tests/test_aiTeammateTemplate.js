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

/**
 * gh-1073: mirror of the gh-1065 event-path dedup gate from
 * .github/workflows/ai-teammate.yml (PR #1071) into the consumer-repo
 * template. Every consumer repo burned duplicate teammate runs on
 * assign-while-labels-change (live 2026-10-18: #1040–#1043 two runs each,
 * #1061 three runs) because the template still carried the un-deduped
 * event path. The pure module (js/common/teammateEventDedup.js) ships in
 * the agents pack consumers mount (DMTOOLS_AGENTS_REF checkout), so the
 * template's probe requires it from the pack checkout instead of the
 * repo tree (the stub requires ./js/common/... — it IS the engine repo).
 */
suite('ai-teammate.yml.template — gh-1073: the event-path dedup gate is mirrored', function () {

    var tpl = file_read({ path: 'workflows/ai-teammate.yml.template' });

    // Same collector as test_teammateEventDedup.js: every folded job-level
    // `if: >-` scalar (the template carries two since gh-1073: the dedup
    // probe gate and the teammate call gate).
    function foldedJobIfs(content) {
        var lines = content.split('\n');
        var ifs = [];
        for (var i = 0; i < lines.length; i++) {
            if (/^ {4}if: >-\s*$/.test(lines[i])) {
                var parts = [];
                for (var j = i + 1; j < lines.length; j++) {
                    if (/^\s*$/.test(lines[j])) continue;
                    if (/^ {5,}/.test(lines[j])) parts.push(lines[j].replace(/^\s+/, ''));
                    else break;
                }
                ifs.push(parts.join(' '));
            }
        }
        return ifs;
    }

    test('run-name resolves the strongest arming label on issues events (completed owners stay title-precise)', function () {
        // The strict completed-owner leg rule (gh-1065 rework) only works
        // when event-path run titles carry the leg: an assigned event must
        // title by the strongest arming label on the issue (rework >
        // review > pr_approved → review > dev), not by the written label —
        // assign-while-labels-change emits a bare `assigned` event whose
        // github.event.label.name is empty. The module's emojiLegOf parses
        // exactly this emoji title family.
        var reworkAt = tpl.indexOf("contains(github.event.issue.labels.*.name, 'agent:rework')");
        var reviewAt = tpl.indexOf("contains(github.event.issue.labels.*.name, 'agent:review')");
        var prApprovedAt = tpl.indexOf("contains(github.event.issue.labels.*.name, 'pr_approved')");
        var devFallbackAt = tpl.indexOf("'⚒️ dev'");
        assert.ok(reworkAt !== -1 && tpl.indexOf("'🔧 rework'", reworkAt) !== -1,
            'run-name maps the agent:rework label to the 🔧 rework title leg');
        assert.ok(reviewAt !== -1 && tpl.indexOf("'🔍 review'", reviewAt) !== -1,
            'run-name maps the agent:review label to the 🔍 review title leg');
        assert.ok(prApprovedAt !== -1 && tpl.indexOf("'🔍 review'", prApprovedAt) !== -1,
            'run-name maps pr_approved to the 🔍 review title leg (arming set parity)');
        assert.ok(reworkAt !== -1 && reviewAt !== -1 && prApprovedAt !== -1 && devFallbackAt !== -1 &&
            reworkAt < reviewAt && reviewAt < devFallbackAt && prApprovedAt < devFallbackAt,
            'priority order: strongest arming label wins, ⚒️ dev is the last-resort fallback');
    });

    test('the dedup probe job exists and consults the pack-shipped decision module', function () {
        assert.ok(tpl.indexOf('dedup:') !== -1, 'a dedup job is declared in the template');
        assert.ok(tpl.indexOf('proceed: ${{ steps.probe.outputs.proceed }}') !== -1,
            'the job exposes the proceed output');
        assert.ok(tpl.indexOf("require('./dmtools-agents/js/common/teammateEventDedup.js')") !== -1,
            'the probe consults the unit-tested decision module from the mounted agents pack');
    });

    test('the dedup job mounts the agents pack (dmtools-agents checkout at DMTOOLS_AGENTS_REF)', function () {
        assert.ok(tpl.indexOf('repository: IstiN/dmtools-agents') !== -1,
            'the pack checkout names the dmtools-agents repo');
        assert.ok(tpl.indexOf('ref: ${{ env.DMTOOLS_AGENTS_REF }}') !== -1,
            'the pack ref rides the template env (same pin as the runner leg)');
        assert.ok(tpl.indexOf('path: dmtools-agents') !== -1,
            'the pack mounts at dmtools-agents/ — the require path prefix');
    });

    test('the teammate call gates on needs.dedup (event path AND dispatch path)', function () {
        assert.ok(tpl.indexOf('needs: [guard, dedup]') !== -1,
            'the teammate job needs both the guard and the probe');
        assert.ok(tpl.indexOf("needs.dedup.outputs.proceed == 'true'") !== -1,
            'the call fires only when the probe proceeded');
        assert.ok(tpl.indexOf("needs.guard.outputs.run == 'true'") !== -1,
            'the guard decision still gates the call');
    });

    test('the probe fails open on probe errors (AC3)', function () {
        assert.ok(tpl.indexOf('probe degraded — fail-open') !== -1,
            'a probe crash still proceeds (catch-all fail-open, never wedges needs:)');
        assert.ok(tpl.indexOf('status skipped, fail-open') !== -1,
            'a per-status API error is skipped fail-open');
    });

    test('the dedup job is gated (gh-1029 zero-burn parity): non-arming events execute ZERO jobs', function () {
        var ifs = foldedJobIfs(tpl);
        assert.ok(ifs.length >= 2, 'both the dedup and the teammate job carry a folded if gate');
        var dedupIf = null;
        for (var i = 0; i < ifs.length; i++) {
            if (ifs[i].indexOf('needs.dedup') === -1 && ifs[i].indexOf("github.event.action == 'labeled'") !== -1) {
                dedupIf = ifs[i];
            }
        }
        assert.ok(dedupIf, 'the dedup job has its own arming gate (not just the teammate call gate)');
        ['agent:dev', 'agent:develop', 'agent:review', 'agent:rework', 'pr_approved'].forEach(function (l) {
            assert.ok(dedupIf.indexOf("github.event.label.name == '" + l + "'") !== -1,
                'the dedup gate admits the arming label ' + l);
        });
        assert.ok(dedupIf.indexOf("github.event.action == 'assigned'") !== -1,
            'the dedup gate keys the assignee check to the assigned action');
        assert.ok(dedupIf.indexOf("github.event_name == 'workflow_dispatch'") !== -1,
            'the dedup gate preserves the dispatch path (probe outputs proceed=true there)');
    });

    test('label and assignee lists ride as JSON — names with spaces never fracture', function () {
        assert.ok(tpl.indexOf('${{ toJson(github.event.issue.labels.*.name) }}') !== -1,
            'ISSUE_LABELS is JSON-encoded');
        assert.ok(tpl.indexOf('${{ toJson(github.event.issue.assignees.*.login) }}') !== -1,
            'ASSIGNEES is JSON-encoded');
        assert.ok(tpl.indexOf('parseEventList') !== -1, 'the probe parses the JSON lists');
    });

    test('the transport supplies the clock — without nowMs the freshness window is inert', function () {
        assert.ok(tpl.indexOf('nowMs: Date.now()') !== -1,
            'the probe passes the wall clock into the decision');
    });

    test('UT-wf-1 (template): probe passes INPUT_PR + INPUT_LEG and runs decideEventDedup on workflow_dispatch', function () {
        assert.ok(tpl.indexOf("INPUT_PR: ${{ github.event.inputs.pr || '' }}") !== -1,
            'template dedup probe step receives INPUT_PR');
        assert.ok(tpl.indexOf("INPUT_LEG: ${{ github.event.inputs.leg || '' }}") !== -1,
            'template dedup probe step receives INPUT_LEG');
        assert.ok(tpl.indexOf('pr: parseInt(env.INPUT_PR, 10)') !== -1,
            'template decideEventDedup receives pr anchor');
        assert.ok(tpl.indexOf('leg: env.INPUT_LEG') !== -1,
            'template decideEventDedup receives explicit leg');
        assert.ok(tpl.indexOf("if (env.EVENT_NAME === 'workflow_dispatch')") === -1,
            'template workflow_dispatch early bypass is removed');
    });
});
