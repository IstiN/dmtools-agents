/* Unit tests for js/mergeTrigger.js — the pr_approved merge sweep ported
 * from awf factory-merge-trigger.yml (bash → structured github_* bridge). */
/* global loadModule, assert, test, suite, makeRequire */

function fixture(opts) {
    opts = opts || {};
    var calls = { merges: [], removes: [], comments: [], gets: [], issueGets: [] };
    var labeledIssues = opts.labeledIssues || [];      // numbers returned by the label search
    var issueStates = opts.issueStates || {};          // number -> 'OPEN' | 'CLOSED' | null (404 body)
    var prs = (opts.prs || []).map(function (p) {
        return {
            number: p.number,
            labels: (p.labels || []).map(function (n) { return { name: n }; }),
            body: p.body || '',
            headRefName: p.headRefName || ''
        };
    });
    var prStates = opts.prStates || {};                // number -> {mergeable, state}
    var mods = {
        github_search_issues: function (a) {
            return JSON.stringify({
                items: labeledIssues.map(function (n) { return { number: n }; })
            });
        },
        github_list_prs: function () { return JSON.stringify(prs); },
        github_get_issue: function (a) {
            calls.issueGets.push(a);
            if (opts.getIssueThrows === a.number) throw new Error('boom issue ' + a.number);
            var state = issueStates.hasOwnProperty(a.number) ? issueStates[a.number] : 'OPEN';
            if (state === null) {
                // Sync-bridge 404 reality: the error BODY comes back, no throw.
                return JSON.stringify({ message: 'Not Found', status: '404' });
            }
            return JSON.stringify({ number: a.number, state: state });
        },
        github_get_pr: function (a) {
            calls.gets.push(a);
            if (opts.getPrThrows === a.pullRequestId) {
                throw new Error('boom pr ' + a.pullRequestId);
            }
            var st = prStates[a.pullRequestId] || { mergeable: true, state: 'CLEAN' };
            return JSON.stringify({
                number: a.pullRequestId,
                mergeable: st.mergeable,
                mergeStateStatus: st.state
            });
        },
        github_merge_pr: function (m) {
            calls.merges.push(m);
            if (opts.mergeRefusals && opts.mergeRefusals[m.pullRequestId]) {
                return JSON.stringify({ message: opts.mergeRefusals[m.pullRequestId] });
            }
            return JSON.stringify({ merged: true });
        },
        github_remove_label: function (r) { calls.removes.push(r); return '{}'; },
        github_create_comment: function (c) { calls.comments.push(c); return '{}'; }
    };
    var mod = loadModule('js/mergeTrigger.js', makeRequire({}), mods);
    return { mod: mod, calls: calls };
}

function run(fx, jobParams) {
    jobParams = jobParams || {};
    if (!jobParams.repo) jobParams.repo = 'a/b';
    return fx.mod.action({ jobParams: jobParams });
}

suite('mergeTrigger', function () {
    test('clean path: labeled issue + Closes #N PR + CLEAN -> squash-merge, labels off, comment', function () {
        var fx = fixture({
            labeledIssues: [5],
            prs: [{ number: 12, labels: [], body: 'What it does\n\nCloses #5\n', headRefName: 'feature/x' }]
        });
        var result = run(fx);
        assert.equal(result.success, true);
        assert.equal(result.merged, 1);
        assert.equal(result.skipped, 0);
        assert.equal(result.failed, 0);
        assert.equal(fx.calls.merges.length, 1, 'exactly one merge');
        assert.equal(fx.calls.merges[0].pullRequestId, 12);
        assert.equal(fx.calls.merges[0].mergeMethod, 'squash');
        assert.equal(fx.calls.merges[0].workspace, 'a');
        assert.equal(fx.calls.merges[0].repository, 'b');
        var removedOn = fx.calls.removes.map(function (r) { return r.number; })
            .sort(function (x, y) { return x - y; });
        assert.deepEqual(removedOn, [5, 12],
            'label removed from BOTH the issue and (removePrLabel default true) the PR');
        assert.equal(fx.calls.comments.length, 1);
        assert.equal(fx.calls.comments[0].number, 5, 'the comment lands on the issue');
        assert.ok(fx.calls.comments[0].body.indexOf('🔀 Merged #12') !== -1);
    });

    test('BEHIND -> skip, no merge, SM refresh note logged', function () {
        var fx = fixture({
            labeledIssues: [3],
            prs: [{ number: 10, body: 'Fixes #3', headRefName: 'x' }],
            prStates: { 10: { mergeable: true, state: 'BEHIND' } }
        });
        var result = run(fx);
        assert.equal(result.merged, 0);
        assert.equal(result.skipped, 1);
        assert.equal(fx.calls.merges.length, 0);
        assert.ok(result.log.some(function (l) { return l.indexOf('behind main') !== -1; }));
    });

    test('BLOCKED -> skip (required checks not green)', function () {
        var fx = fixture({
            labeledIssues: [3],
            prs: [{ number: 10, body: 'Resolves #3', headRefName: 'x' }],
            prStates: { 10: { mergeable: true, state: 'BLOCKED' } }
        });
        var result = run(fx);
        assert.equal(result.merged, 0);
        assert.equal(result.skipped, 1);
        assert.equal(fx.calls.merges.length, 0);
    });

    test('not mergeable (CONFLICTING/DIRTY) -> flagged skip', function () {
        var fx = fixture({
            labeledIssues: [3],
            prs: [{ number: 10, body: 'Closes #3', headRefName: 'x' }],
            prStates: { 10: { mergeable: false, state: 'DIRTY' } }
        });
        var result = run(fx);
        assert.equal(result.skipped, 1);
        assert.ok(result.log.some(function (l) { return l.indexOf('not mergeable') !== -1; }));
    });

    test('Part of #N links the PR WITHOUT closing semantics (awf#20)', function () {
        var fx = fixture({
            labeledIssues: [7],
            prs: [{ number: 21, body: 'Slice one.\n\nPart of #7', headRefName: 'feat/slice' }]
        });
        var result = run(fx);
        assert.equal(result.merged, 1, 'Part-of linked PR merges for the labeled issue');
        assert.equal(fx.calls.merges[0].pullRequestId, 21);
    });

    test('orphan carrier: labeled PR whose issue is CLOSED -> merges directly (awf#20)', function () {
        var fx = fixture({
            labeledIssues: [],
            issueStates: { 99: 'CLOSED' },
            prs: [{ number: 7, labels: ['pr_approved'], body: 'Part of #99', headRefName: 'fix/x' }]
        });
        var result = run(fx);
        assert.equal(result.merged, 1, 'closed issue -> PR-carrier path still merges');
        assert.equal(fx.calls.merges[0].pullRequestId, 7);
        assert.equal(fx.calls.comments.length, 1);
        assert.equal(fx.calls.comments[0].number, 7, 'the comment lands on the PR (no issue)');
        assert.deepEqual(fx.calls.removes.map(function (r) { return r.number; }), [7],
            'only the PR is un-labeled on the carrier path');
        assert.ok(result.log.some(function (l) { return l.indexOf('no linked open issue') !== -1; }));
    });

    test('orphan carrier: linked issue ABSENT (404 body, no throw) -> PR-carrier path', function () {
        var fx = fixture({
            labeledIssues: [],
            issueStates: { 55: null },
            prs: [{ number: 8, labels: ['pr_approved'], body: 'Closes #55', headRefName: 'fix/y' }]
        });
        var result = run(fx);
        assert.equal(result.merged, 1, 'an unverifiable (deleted) issue must not block the carrier');
        assert.equal(fx.calls.merges[0].pullRequestId, 8);
    });

    test('labeled PR with NO resolvable issue -> orphan carrier (machine PRs)', function () {
        var fx = fixture({
            labeledIssues: [],
            prs: [{ number: 9, labels: ['pr_approved'], body: 'chore: bump deps', headRefName: 'chore/deps' }]
        });
        var result = run(fx);
        assert.equal(result.merged, 1);
        assert.equal(fx.calls.merges[0].pullRequestId, 9);
    });

    test('mapPrLabels=false: labeled PRs are invisible (issue-label scan only)', function () {
        var fx = fixture({
            labeledIssues: [],
            prs: [{ number: 9, labels: ['pr_approved'], body: '', headRefName: 'chore/deps' }]
        });
        var result = run(fx, { mapPrLabels: false });
        assert.equal(result.merged, 0);
        assert.equal(fx.calls.merges.length, 0);
        assert.ok(result.log.some(function (l) { return l.indexOf('nothing to merge') !== -1; }));
    });

    test('PR label maps back to its OPEN linked issue (deduped with the issue scan)', function () {
        var fx = fixture({
            labeledIssues: [5],
            issueStates: { 5: 'OPEN' },
            prs: [{ number: 12, labels: ['pr_approved'], body: 'Closes #5', headRefName: 'feature/x' }]
        });
        var result = run(fx);
        assert.equal(result.merged, 1, 'the issue appears once, the PR is not double-processed');
        assert.equal(fx.calls.merges.length, 1);
    });

    test('multi-line body with ### markdown lines links and merges (awf#21 regression)', function () {
        // Live crash (fa 2026-10-05): the bash flattened bodies through jq
        // and a '###' line became prn='###', failing the whole job under
        // set -e. As a JSON fixture the body is just a string — assert the
        // link scan never confuses markdown for a number.
        var body = '### Context\n\nSome prose\n\n### Changes\n\nCloses #5\n\n- one\n- two\n';
        var fx = fixture({
            labeledIssues: [5],
            prs: [{ number: 12, labels: [], body: body, headRefName: 'feature/x' }]
        });
        var result = run(fx);
        assert.equal(result.merged, 1);
        assert.equal(fx.calls.merges[0].pullRequestId, 12);
        fx.calls.merges.forEach(function (m) {
            assert.equal(typeof m.pullRequestId, 'number', 'PR ids stay numeric end-to-end');
        });
    });

    test('branch N-* linking without any body ref', function () {
        var fx = fixture({
            labeledIssues: [42],
            prs: [{ number: 30, labels: [], body: '', headRefName: '42-fix-foo' }]
        });
        var result = run(fx);
        assert.equal(result.merged, 1);
        assert.equal(fx.calls.merges[0].pullRequestId, 30);
    });

    test('gh-0*NN branch linking honored; ghBranchPattern=false disables the issue→PR leg', function () {
        var fx = fixture({
            labeledIssues: [754],
            prs: [{ number: 31, labels: [], body: '', headRefName: 'ai/gh-754' }]
        });
        var result = run(fx);
        assert.equal(result.merged, 1, 'gh-NN branch links by default');

        var fx2 = fixture({
            labeledIssues: [754],
            prs: [{ number: 31, labels: [], body: '', headRefName: 'ai/gh-754' }]
        });
        var result2 = run(fx2, { ghBranchPattern: false });
        assert.equal(result2.merged, 0, 'no body ref + gated branch pattern -> no link');
        assert.equal(result2.skipped, 1, 'issue skipped as unlinked');
        assert.equal(fx2.calls.merges.length, 0);

        // ...but the PR→issue map-back keeps the gh- pattern (bash parity:
        // the map-back ignores GH_BRANCH_PATTERN). Observable: the labeled
        // PR maps back to OPEN issue 754 instead of taking the orphan
        // carrier — and the gated issue→PR leg then finds no link, so the
        // item SKIPS (exactly what the bash does: map-back extracts gh-NN
        // unconditionally, link_sel stays gated).
        var fx3 = fixture({
            labeledIssues: [],
            issueStates: { 754: 'OPEN' },
            prs: [{ number: 31, labels: ['pr_approved'], body: '', headRefName: 'ai/gh-754' }]
        });
        var result3 = run(fx3, { ghBranchPattern: false });
        assert.equal(result3.merged, 0, 'mapped-back issue with a gated link leg skips');
        assert.equal(result3.skipped, 1);
        assert.ok(result3.log.some(function (l) { return l.indexOf('no linked open PR') !== -1; }),
            'took the ISSUE path (map-back extracted gh-754), not the orphan carrier');
        assert.ok(!result3.log.some(function (l) { return l.indexOf('no linked open issue') !== -1; }));
    });

    test('per-item error isolation: one get_pr failure -> failed++, loop continues, then throws', function () {
        var fx = fixture({
            labeledIssues: [1, 2],
            prs: [
                { number: 10, labels: [], body: 'Closes #1', headRefName: 'x' },
                { number: 20, labels: [], body: 'Closes #2', headRefName: 'y' }
            ],
            getPrThrows: 10
        });
        var threw = false;
        try { run(fx); } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('1 item(s) failed') !== -1,
                'the aggregate failure surfaces after the loop: ' + e.message);
        }
        assert.equal(threw, true, 'failed>0 throws AFTER the loop (JSRunner job failure)');
        assert.deepEqual(fx.calls.merges.map(function (m) { return m.pullRequestId; }), [20],
            'the second issue still merged — errors never kill the run mid-loop');
    });

    test('refused merge is skipped, not failed (bash parity: exit 0)', function () {
        var fx = fixture({
            labeledIssues: [5],
            prs: [{ number: 12, body: 'Closes #5', headRefName: 'x' }],
            mergeRefusals: { 12: 'Head branch is out of date' }
        });
        var result = run(fx);
        assert.equal(result.merged, 0);
        assert.equal(result.skipped, 1);
        assert.equal(result.failed, 0);
        assert.ok(result.log.some(function (l) { return l.indexOf('Head branch is out of date') !== -1; }),
            'the GitHub refusal is surfaced verbatim');
    });

    test('removePrLabel=true removes from the PR; false leaves it', function () {
        var fx = fixture({
            labeledIssues: [5],
            prs: [{ number: 12, body: 'Closes #5', headRefName: 'x' }]
        });
        run(fx, { removePrLabel: true });
        assert.ok(fx.calls.removes.some(function (r) { return r.number === 12; }),
            'PR un-labeled when removePrLabel=true');

        var fx2 = fixture({
            labeledIssues: [5],
            prs: [{ number: 12, body: 'Closes #5', headRefName: 'x' }]
        });
        var result2 = run(fx2, { removePrLabel: false });
        assert.equal(result2.merged, 1);
        assert.deepEqual(fx2.calls.removes.map(function (r) { return r.number; }), [5],
            'only the issue is un-labeled when removePrLabel=false');
    });

    test('string booleans from workflow inputs are honored', function () {
        var fx = fixture({
            labeledIssues: [5],
            prs: [{ number: 12, body: 'Closes #5', headRefName: 'x' }]
        });
        var result = run(fx, { removePrLabel: 'false' });
        assert.equal(result.merged, 1);
        assert.deepEqual(fx.calls.removes.map(function (r) { return r.number; }), [5]);
    });

    test('nothing labeled -> quiet success', function () {
        var fx = fixture({ labeledIssues: [], prs: [] });
        var result = run(fx);
        assert.equal(result.success, true);
        assert.equal(result.merged + result.skipped + result.failed, 0);
        assert.ok(result.log.some(function (l) { return l.indexOf("no issues labeled 'pr_approved'") !== -1; }));
    });

    test('custom label + ciRunUrl flow into the sweep and comments', function () {
        var fx = fixture({
            labeledIssues: [5],
            prs: [{ number: 12, body: 'Closes #5', headRefName: 'x' }]
        });
        run(fx, { label: 'ship_it', ciRunUrl: 'https://ci/run/1' });
        assert.equal(fx.calls.removes[0].label, 'ship_it');
        assert.ok(fx.calls.comments[0].body.indexOf('https://ci/run/1') !== -1);
    });
});

suite('mergeTrigger: pure link helpers', function () {
    var mod = loadModule('js/mergeTrigger.js', makeRequire({}), {});

    test('extractLinkedIssueNumber: body keyword wins over branch digits', function () {
        assert.equal(mod.extractLinkedIssueNumber({ body: 'Fixes #9', headRefName: '12-x' }), 9);
        assert.equal(mod.extractLinkedIssueNumber({ body: '', headRefName: '12-fix' }), 12);
        assert.equal(mod.extractLinkedIssueNumber({ body: '', headRefName: 'ai/gh-754-x' }), 754);
        assert.equal(mod.extractLinkedIssueNumber({ body: 'part OF #3', headRefName: '' }), 3);
        assert.equal(mod.extractLinkedIssueNumber({ body: 'see #5', headRefName: 'x' }), null,
            'a bare #N mention never links');
    });

    test('prLinksToIssue: gh-0*NN must anchor at the branch END (issue→PR selector)', function () {
        assert.equal(mod.prLinksToIssue({ body: '', headRefName: 'ai/gh-754' }, 754, true), true);
        assert.equal(mod.prLinksToIssue({ body: '', headRefName: 'ai/gh-0754' }, 754, true), true);
        assert.equal(mod.prLinksToIssue({ body: '', headRefName: 'ai/gh-754-x' }, 754, true), false,
            'a gh-NN prefix mid-branch does not link on the issue→PR leg');
        assert.equal(mod.prLinksToIssue({ body: '', headRefName: '42-fix' }, 42, false), true,
            'N-* branch linking is not gated by ghBranchPattern');
    });

    test('mergeStateOf: REST lowercase + boolean mergeable normalized', function () {
        var ms = mod.mergeStateOf({ mergeable: true, mergeable_state: 'clean' });
        assert.equal(ms.mergeable, true);
        assert.equal(ms.state, 'CLEAN');
    });
});
