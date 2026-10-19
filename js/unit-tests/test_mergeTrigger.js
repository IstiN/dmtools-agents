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
            if (st.rest) {
                // REST shape: lowercase mergeable_state, no mergeStateStatus.
                return JSON.stringify({
                    number: a.pullRequestId,
                    mergeable: st.mergeable,
                    mergeable_state: String(st.state).toLowerCase()
                });
            }
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
    if (opts.ghRepo) mods.GH_REPO = opts.ghRepo;
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

// ── gh-1081: characterization of the action wiring (pinned before the CRAP
// refactor — the decisions mergeTrigger gates squash-merge on must not move).
suite('mergeTrigger: action wiring characterization (gh-1081)', function () {

    test('missing repo throws a helpful error', function () {
        var fx = fixture({});
        var threw = false;
        try { fx.mod.action({ jobParams: {} }); } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('no repo') !== -1, e.message);
        }
        assert.equal(threw, true);
    });

    test('repo without owner/name throws', function () {
        var fx = fixture({});
        var threw = false;
        try { fx.mod.action({ jobParams: { repo: 'justname' } }); } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('owner/name') !== -1, e.message);
        }
        assert.equal(threw, true);
    });

    test('GH_REPO fallback supplies the repo when jobParams.repo is absent', function () {
        var fx = fixture({ ghRepo: 'gho/gr', labeledIssues: [5],
            prs: [{ number: 12, body: 'Closes #5', headRefName: 'x' }] });
        var result = fx.mod.action({ jobParams: {} });
        assert.equal(result.merged, 1);
        assert.equal(fx.calls.merges[0].workspace, 'gho');
        assert.equal(fx.calls.merges[0].repository, 'gr');
    });

    test('malformed label-search records are dropped and duplicates deduped', function () {
        var fx = fixture({
            labeledIssues: [5, 'x', -3, 0, 5],
            prs: [{ number: 12, body: 'Closes #5', headRefName: 'x' }]
        });
        var result = run(fx);
        assert.equal(result.merged, 1);
        assert.equal(fx.calls.merges.length, 1);
        var issueMarks = result.log.filter(function (l) { return l.indexOf('::issue #') === 0; });
        assert.equal(issueMarks.length, 1, 'issue #5 processed exactly once: ' + JSON.stringify(issueMarks));
    });

    test('malformed PR records never reach the merge calls (awf#21 numeric guard)', function () {
        var fx = fixture({
            labeledIssues: [5],
            prs: [
                { number: 12, body: 'Closes #5', headRefName: 'x' },
                { number: '###' },
                { number: 0 },
                {}
            ]
        });
        var result = run(fx);
        assert.equal(result.merged, 1);
        assert.deepEqual(fx.calls.merges.map(function (m) { return m.pullRequestId; }), [12]);
        assert.equal(result.failed, 0);
    });

    test('UNSTABLE state skips like BLOCKED (required checks not green)', function () {
        var fx = fixture({
            labeledIssues: [3],
            prs: [{ number: 10, body: 'Closes #3', headRefName: 'x' }],
            prStates: { 10: { mergeable: true, state: 'UNSTABLE' } }
        });
        var result = run(fx);
        assert.equal(result.skipped, 1);
        assert.equal(fx.calls.merges.length, 0);
        assert.ok(result.log.some(function (l) { return l.indexOf('required checks not green') !== -1; }));
    });

    test('REST mergeable_state (lowercase, no mergeStateStatus) drives the decision', function () {
        var fx = fixture({
            labeledIssues: [3],
            prs: [{ number: 10, body: 'Closes #3', headRefName: 'x' }],
            prStates: { 10: { mergeable: true, state: 'BEHIND', rest: true } }
        });
        var result = run(fx);
        assert.equal(result.skipped, 1);
        assert.equal(fx.calls.merges.length, 0);
        assert.ok(result.log.some(function (l) { return l.indexOf('behind main') !== -1; }));
    });

    test('orphan PR whose get_pr fails counts failed and throws after the loop', function () {
        var fx = fixture({
            labeledIssues: [],
            prs: [{ number: 9, labels: ['pr_approved'], body: 'chore', headRefName: 'chore/x' }],
            getPrThrows: 9
        });
        var threw = false;
        try { run(fx); } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('1 item(s) failed') !== -1, e.message);
        }
        assert.equal(threw, true);
        assert.equal(fx.calls.merges.length, 0);
    });

    test('refused merge on the orphan path is skipped, not failed', function () {
        var fx = fixture({
            labeledIssues: [],
            prs: [{ number: 9, labels: ['pr_approved'], body: 'chore', headRefName: 'chore/x' }],
            mergeRefusals: { 9: 'not authorized' }
        });
        var result = run(fx);
        assert.equal(result.merged, 0);
        assert.equal(result.skipped, 1);
        assert.equal(result.failed, 0);
        assert.ok(result.log.some(function (l) { return l.indexOf('not authorized') !== -1; }));
    });

    test("default ciRunUrl 'run' is stamped into the merge comment", function () {
        var fx = fixture({
            labeledIssues: [5],
            prs: [{ number: 12, body: 'Closes #5', headRefName: 'x' }]
        });
        run(fx);
        assert.ok(fx.calls.comments[0].body.indexOf('(CI: run)') !== -1,
            fx.calls.comments[0].body);
    });
});

// ── gh-1081: direct tests of the extracted pure parse/build/decide helpers.
suite('mergeTrigger: extracted helpers (gh-1081)', function () {
    var mod = loadModule('js/mergeTrigger.js', makeRequire({}), {});

    test('resolveRepo: owner/name split, GH_REPO fallback, errors', function () {
        assert.deepEqual(mod.resolveRepo({ repo: 'a/b' }), { owner: 'a', name: 'b' });
        assert.deepEqual(mod.resolveRepo({ repo: 'a/b/c' }), { owner: 'a', name: 'b/c' });
        var withGh = loadModule('js/mergeTrigger.js', makeRequire({}), { GH_REPO: 'g/h' });
        assert.deepEqual(withGh.resolveRepo({}), { owner: 'g', name: 'h' },
            'GH_REPO wins when jobParams.repo is absent');
        assert.deepEqual(mod.resolveRepo({ repo: 'job/r' }), { owner: 'job', name: 'r' },
            'jobParams.repo wins over GH_REPO');
        var noRepo = false;
        try { mod.resolveRepo({}); } catch (e) { noRepo = e.message.indexOf('no repo') !== -1; }
        assert.equal(noRepo, true, 'missing repo throws "no repo"');
        var badShape = false;
        try { mod.resolveRepo({ repo: 'x' }); } catch (e) {
            badShape = e.message.indexOf('owner/name') !== -1;
        }
        assert.equal(badShape, true, 'non owner/name repo throws');
    });

    test('parseFlags: defaults and string-boolean coercion', function () {
        var d = mod.parseFlags({});
        assert.equal(d.label, 'pr_approved');
        assert.equal(d.mapPrLabels, true);
        assert.equal(d.ghBranchPattern, true);
        assert.equal(d.removePrLabel, true);
        assert.equal(d.ciRunUrl, 'run');
        var o = mod.parseFlags({
            label: 'ship_it', mapPrLabels: 'false', ghBranchPattern: false,
            removePrLabel: 'false', ciRunUrl: 'https://ci/9'
        });
        assert.equal(o.label, 'ship_it');
        assert.equal(o.mapPrLabels, false);
        assert.equal(o.ghBranchPattern, false);
        assert.equal(o.removePrLabel, false);
        assert.equal(o.ciRunUrl, 'https://ci/9');
    });

    test('asBool: every accepted spelling', function () {
        assert.equal(mod.asBool(undefined, 'D'), 'D');
        assert.equal(mod.asBool(null, 'D'), 'D');
        assert.equal(mod.asBool('', 'D'), 'D');
        assert.equal(mod.asBool(true, 'D'), true);
        assert.equal(mod.asBool(false, 'D'), false);
        assert.equal(mod.asBool('false', true), false);
        assert.equal(mod.asBool('FALSE', true), false);
        assert.equal(mod.asBool('true', false), true);
        assert.equal(mod.asBool('yes', false), true);
    });

    test('parseMcp: null/undefined/object/string/invalid', function () {
        var obj = { a: 1 };
        assert.deepEqual(mod.parseMcp(null), {});
        assert.deepEqual(mod.parseMcp(undefined), {});
        assert.equal(mod.parseMcp(obj), obj, 'objects pass through by reference');
        assert.deepEqual(mod.parseMcp('{"b":2}'), { b: 2 });
        assert.deepEqual(mod.parseMcp('not json'), {});
    });

    test('asList: array/items/pullRequests/fallback', function () {
        assert.deepEqual(mod.asList([1, 2]), [1, 2]);
        assert.deepEqual(mod.asList({ items: [3] }), [3]);
        assert.deepEqual(mod.asList({ pullRequests: [4] }), [4]);
        assert.deepEqual(mod.asList({}), []);
        assert.deepEqual(mod.asList(null), []);
    });

    test('labelNames/hasLabel/branchOf/bodyOf normalize messy PR records', function () {
        assert.deepEqual(mod.labelNames({ labels: [{ name: 'x' }, 'y'] }), ['x', 'y']);
        assert.deepEqual(mod.labelNames({}), []);
        assert.equal(mod.hasLabel({ labels: [{ name: 'pr_approved' }] }, 'pr_approved'), true);
        assert.equal(mod.hasLabel({ labels: ['other'] }, 'pr_approved'), false);
        assert.equal(mod.hasLabel({}, 'pr_approved'), false);
        assert.equal(mod.branchOf({ headRefName: 'hr' }), 'hr');
        assert.equal(mod.branchOf({ head: { ref: 'gr' } }), 'gr');
        assert.equal(mod.branchOf({}), '');
        assert.equal(mod.bodyOf('text'), 'text');
        assert.equal(mod.bodyOf(null), '');
        assert.equal(mod.bodyOf(5), '');
    });

    test('mergeDecisionOf: every mergeStateStatus lands in exactly one bucket', function () {
        assert.equal(mod.mergeDecisionOf({ mergeable: false, state: 'CLEAN' }), 'manual');
        assert.equal(mod.mergeDecisionOf({ mergeable: true, state: 'CLEAN' }), 'merge');
        assert.equal(mod.mergeDecisionOf({ mergeable: true, state: 'BEHIND' }), 'behind');
        assert.equal(mod.mergeDecisionOf({ mergeable: true, state: 'BLOCKED' }), 'blocked');
        assert.equal(mod.mergeDecisionOf({ mergeable: true, state: 'UNSTABLE' }), 'blocked');
        assert.equal(mod.mergeDecisionOf({ mergeable: true, state: 'DIRTY' }), 'manual');
        assert.equal(mod.mergeDecisionOf({ mergeable: true, state: 'HAS_HOOKS' }), 'manual');
        assert.equal(mod.mergeDecisionOf({ mergeable: true, state: '' }), 'manual');
    });

    test('findLinkedPr: first matching PR wins; none returns null', function () {
        var openPrs = [
            { number: 1, body: 'Closes #5', headRefName: 'a' },
            { number: 2, body: 'Fixes #5', headRefName: 'b' },
            { number: 3, body: '', headRefName: 'c' }
        ];
        assert.equal(mod.findLinkedPr(openPrs, 5, true).number, 1);
        assert.equal(mod.findLinkedPr(openPrs, 9, true), null);
    });

    test('squashMerge: merged/ok/refusal/throw outcomes', function () {
        function loadWith(mergeImpl) {
            return loadModule('js/mergeTrigger.js', makeRequire({}), {
                github_merge_pr: mergeImpl
            });
        }
        assert.deepEqual(
            loadWith(function () { return JSON.stringify({ merged: true }); }).squashMerge('o', 'n', 1),
            { merged: true });
        assert.deepEqual(
            loadWith(function () { return JSON.stringify({ ok: true }); }).squashMerge('o', 'n', 1),
            { merged: true });
        var refused = loadWith(function () { return JSON.stringify({ message: 'nope' }); })
            .squashMerge('o', 'n', 1);
        assert.equal(refused.merged, false);
        assert.equal(refused.error, 'nope');
        var threw = loadWith(function () { throw new Error('kaboom'); }).squashMerge('o', 'n', 1);
        assert.equal(threw.merged, false);
        assert.ok(threw.error.indexOf('kaboom') !== -1, threw.error);
        var weird = loadWith(function () { return JSON.stringify({ http: 'weird' }); })
            .squashMerge('o', 'n', 1);
        assert.equal(weird.merged, false);
        assert.ok(weird.error.indexOf('weird') !== -1, weird.error);
    });

    test('tryRemoveLabel/tryComment: failures land in the log as non-fatal', function () {
        var log = [];
        var mod2 = loadModule('js/mergeTrigger.js', makeRequire({}), {
            github_remove_label: function (a) {
                if (a.number === 13) throw new Error('label boom');
                return '{}';
            },
            github_create_comment: function (a) {
                if (a.number === 13) throw new Error('comment boom');
                return '{}';
            }
        });
        mod2.tryRemoveLabel('o', 'n', 12, 'L', log);
        assert.equal(log.length, 0);
        mod2.tryRemoveLabel('o', 'n', 13, 'L', log);
        assert.equal(log.length, 1);
        assert.ok(log[0].indexOf('⚠️ label removal failed on #13') === 0, log[0]);
        assert.ok(log[0].indexOf('label boom') !== -1, log[0]);
        mod2.tryComment('o', 'n', 12, 'body', log);
        assert.equal(log.length, 1);
        mod2.tryComment('o', 'n', 13, 'body', log);
        assert.equal(log.length, 2);
        assert.ok(log[1].indexOf('⚠️ comment failed on #13') === 0, log[1]);
    });

    test('collectIssueNumbers: numeric guard, dedupe, insertion order kept', function () {
        var out = mod.collectIssueNumbers({ items: [
            { number: 5 }, { number: 'x' }, { number: -3 }, { number: 0 },
            { number: 5 }, { number: 7 }
        ] });
        assert.deepEqual(out.issueNumbers, [5, 7]);
        assert.deepEqual(Object.keys(out.seenIssues), ['5', '7']);
    });

    test('numericPrs: malformed records are filtered, order kept', function () {
        var prs = [{ number: 3 }, { number: '###' }, { number: 0 }, {}, { number: 1 }];
        assert.deepEqual(mod.numericPrs(prs).map(function (p) { return p.number; }), [3, 1]);
    });

    test('scanLabeledPrs: open issue maps back, closed/absent/unresolvable are orphans', function () {
        function scanWith(issueStates, prs, opts) {
            opts = opts || {};
            var m = loadModule('js/mergeTrigger.js', makeRequire({}), {
                github_get_issue: function (a) {
                    if (opts.throwOn === a.number) throw new Error('boom issue');
                    var st = issueStates.hasOwnProperty(a.number) ? issueStates[a.number] : 'OPEN';
                    if (st === null) return JSON.stringify({ message: 'Not Found' });
                    return JSON.stringify({ state: st });
                }
            });
            var ctx = { log: [], say: function () {} };
            var issueNumbers = opts.issueNumbers || [];
            var seen = {};
            (opts.issueNumbers || []).forEach(function (n) { seen[n] = true; });
            var orphans = m.scanLabeledPrs(prs, 'pr_approved', 'o', 'n', issueNumbers, seen, ctx);
            return { issueNumbers: issueNumbers, orphans: orphans };
        }

        var open = scanWith({}, [
            { number: 1, labels: [{ name: 'pr_approved' }], body: 'Closes #5', headRefName: '' }
        ]);
        assert.deepEqual(open.issueNumbers, [5], 'open linked issue joins the issue loop');
        assert.deepEqual(open.orphans, []);

        var closed = scanWith({ 5: 'CLOSED' }, [
            { number: 1, labels: [{ name: 'pr_approved' }], body: 'Closes #5', headRefName: '' }
        ]);
        assert.deepEqual(closed.issueNumbers, []);
        assert.deepEqual(closed.orphans, [1], 'closed issue → the PR is the carrier');

        var absent = scanWith({ 5: null }, [
            { number: 1, labels: ['pr_approved'], body: 'Closes #5', headRefName: '' }
        ]);
        assert.deepEqual(absent.orphans, [1], '404 body → the PR is the carrier');

        var unresolvable = scanWith({}, [
            { number: 1, labels: ['pr_approved'], body: '', headRefName: '' }
        ]);
        assert.deepEqual(unresolvable.orphans, [1], 'no extractable issue → orphan');

        var throwing = scanWith({}, [
            { number: 1, labels: ['pr_approved'], body: 'Closes #5', headRefName: '' }
        ], { throwOn: 5 });
        assert.deepEqual(throwing.orphans, [1],
            'a throwing get_issue is absorbed by isIssueOpen → orphan');

        var dedup = scanWith({}, [
            { number: 1, labels: ['pr_approved'], body: 'Closes #5', headRefName: '' }
        ], { issueNumbers: [5] });
        assert.deepEqual(dedup.issueNumbers, [5], 'already-seen issues are not re-added');
        assert.deepEqual(dedup.orphans, []);

        var unlabeled = scanWith({}, [
            { number: 1, labels: [], body: 'Closes #5', headRefName: '' }
        ]);
        assert.deepEqual(unlabeled.issueNumbers, []);
        assert.deepEqual(unlabeled.orphans, [], 'unlabeled PRs are ignored entirely');
    });

    test('isIssueOpen: OPEN true, CLOSED/404-body/throw false', function () {
        function loadWith(getIssue) {
            return loadModule('js/mergeTrigger.js', makeRequire({}), { github_get_issue: getIssue });
        }
        assert.equal(loadWith(function () { return JSON.stringify({ state: 'OPEN' }); })
            .isIssueOpen('o', 'n', 1), true);
        assert.equal(loadWith(function () { return JSON.stringify({ state: 'closed' }); })
            .isIssueOpen('o', 'n', 1), false, 'state comparison is case-insensitive on OPEN only');
        assert.equal(loadWith(function () { return JSON.stringify({ message: 'Not Found' }); })
            .isIssueOpen('o', 'n', 1), false);
        assert.equal(loadWith(function () { throw new Error('boom'); })
            .isIssueOpen('o', 'n', 1), false);
    });
});
