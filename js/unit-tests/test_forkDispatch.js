/**
 * Unit tests: js/common/forkDispatch.js — gh-1075 fork-PR dispatch contract:
 * a cross-repo PR's legs dispatch on the BASE repo's standard machine ref
 * with the PR number + a refs/pull/<N>/head checkout plan in the run inputs
 * (the fork branch never exists in the base repo — dispatching on it 422s
 * forever, live fa pr-1591), and the fork head's no-ref liveness oracle is
 * the pull ref (AC2/AC3), never the branch name.
 */
/* global loadModule, assert, test, suite, makeRequire, file_read */

suite('forkDispatch (gh-1075)', function () {

    var validationLiveness = loadModule('js/common/validationLiveness.js', makeRequire({}), {});
    var mod = loadModule('js/common/forkDispatch.js', makeRequire({
        './validationLiveness.js': validationLiveness
    }), {});

    var BASE_OWNER = 'epam';
    var BASE_REPO = 'dmtools-dart';
    var BASE_FULL = BASE_OWNER + '/' + BASE_REPO;
    var FORK_FULL = 'yuryby/dmtools-dart';
    var BRANCH = 'fix/android-dap-home-sandbox';

    function forkItem(extra) {
        var it = { key: 'pr-1591', labels: ['agent:review'], issueNumber: null,
                   prNumber: 1591, draft: false, branch: BRANCH, headRepo: FORK_FULL };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
        return it;
    }

    suite('pullHeadRef', function () {
        test('builds the always-fetchable base-repo pull ref', function () {
            assert.equal(mod.pullHeadRef(1591), 'refs/pull/1591/head');
            assert.equal(mod.pullHeadRef('42'), 'refs/pull/42/head');
        });
    });

    suite('forkFullOf', function () {
        test('a headRepo different from the base (any casing) resolves to the fork', function () {
            assert.equal(mod.forkFullOf(forkItem(), BASE_OWNER, BASE_REPO), FORK_FULL);
            var drifted = forkItem({ headRepo: 'YURYBY/Dmtools-Dart' });
            assert.equal(mod.forkFullOf(drifted, 'EPAM', 'DMTools-Dart'), 'YURYBY/Dmtools-Dart',
                'the fork full name is preserved (push URLs build from it); only the SAME-repo compare is case-insensitive');
        });

        test('same-repo headRepo (incl. casing drift) is NOT a fork', function () {
            assert.equal(mod.forkFullOf(forkItem({ headRepo: BASE_FULL }), BASE_OWNER, BASE_REPO), null);
            assert.equal(mod.forkFullOf(forkItem({ headRepo: 'EPAM/DMTools-Dart' }), BASE_OWNER, BASE_REPO), null,
                'config casing vs API casing must not reclassify a same-repo PR as a fork');
        });

        test('missing headRepo (deleted fork, legacy payload) fails closed to same-repo', function () {
            assert.equal(mod.forkFullOf(forkItem({ headRepo: null }), BASE_OWNER, BASE_REPO), null);
            assert.equal(mod.forkFullOf(forkItem({ headRepo: '' }), BASE_OWNER, BASE_REPO), null);
            var noHead = forkItem(); delete noHead.headRepo;
            assert.equal(mod.forkFullOf(noHead, BASE_OWNER, BASE_REPO), null);
        });

        test('item.pr.headRepo is the fallback carrier', function () {
            var it = forkItem({ headRepo: null, pr: { headRepo: FORK_FULL } });
            assert.equal(mod.forkFullOf(it, BASE_OWNER, BASE_REPO), FORK_FULL);
        });
    });

    suite('dispatchPlan (UT-1)', function () {
        test('fork PR + head-targeted dispatch → base machine ref + pull-ref checkout plan (AC1)', function () {
            var plan = mod.dispatchPlan(BRANCH, forkItem(), BASE_OWNER, BASE_REPO);
            assert.equal(plan.ref, 'main',
                'the dispatch lands on the base repo\'s standard machine ref — the fork branch can never resolve there');
            assert.equal(plan.checkoutRef, 'refs/pull/1591/head',
                'the leg\'s checkout step resolves the always-fetchable pull ref');
        });

        test('same-repo PR keeps ref:<branch> with NO checkout plan (regression guard)', function () {
            var plan = mod.dispatchPlan(BRANCH, forkItem({ headRepo: BASE_FULL }), BASE_OWNER, BASE_REPO);
            assert.equal(plan.ref, BRANCH, 'byte-identical to today\'s same-repo dispatch');
            assert.equal(plan.checkoutRef, null, 'no new inputs for same-repo PRs');
        });

        test('a rule that does NOT target the head is untouched, even for a fork PR', function () {
            assert.deepEqual(mod.dispatchPlan('main', forkItem(), BASE_OWNER, BASE_REPO),
                { ref: 'main', checkoutRef: null }, 'a main-ref rule dispatches on main as before');
            assert.deepEqual(mod.dispatchPlan('pr-1591', forkItem(), BASE_OWNER, BASE_REPO),
                { ref: 'pr-1591', checkoutRef: null }, '{prNumber}-targeted refs are not head-targeted');
        });

        test('items without a head target (no branch / no PR number) pass through', function () {
            assert.deepEqual(mod.dispatchPlan('main', forkItem({ branch: '' }), BASE_OWNER, BASE_REPO),
                { ref: 'main', checkoutRef: null });
            assert.deepEqual(mod.dispatchPlan('main', forkItem({ prNumber: null }), BASE_OWNER, BASE_REPO),
                { ref: 'main', checkoutRef: null });
            assert.deepEqual(mod.dispatchPlan('main', null, BASE_OWNER, BASE_REPO),
                { ref: 'main', checkoutRef: null });
        });

        test('an expanded empty ref (no branch to expand) passes through — the caller falls back to main', function () {
            assert.deepEqual(mod.dispatchPlan('', forkItem(), BASE_OWNER, BASE_REPO),
                { ref: '', checkoutRef: null });
        });
    });

    suite('classifyForkNoRef (UT-2)', function () {
        test('a 422 naming a fork branch with a FETCHABLE pull ref is NOT head-dead (AC2)', function () {
            assert.equal(mod.classifyForkNoRef(true), 'live',
                'the head\'s liveness oracle for forks is refs/pull/<N>/head (#1057) — no markers, no park');
        });

        test('an UNFETCHABLE pull ref is a genuinely dead fork head (AC3)', function () {
            assert.equal(mod.classifyForkNoRef(false), 'dead',
                'fork deleted entirely — parks via the existing no-ref path, keyed on the pull ref');
        });
    });
});

// ── gh-1075 review (thread 1, BLOCKING): the leg workflow template must
// DECLARE every input the rerouted fork dispatch sends. GitHub's dispatches
// REST endpoint validates the inputs object against the target workflow
// file's declared inputs and 422s undeclared keys with "Unexpected inputs
// provided" (github/gh-aw#50027) — classified 'transient' by
// triggerFailures.classifyTriggerError, so an undeclared input would leave
// fork PRs permanently undispatchable with zero markers/park. This lint
// fails CI the moment the SM dispatches an input the template does not
// declare (declaration only — consumption is tracked in #1096; the review
// confirmed #1074 is observability-only and does not own checkout behavior).

suite('workflow template declares the dispatch inputs (gh-1075 lint)', function () {

    // Locate the workflow_dispatch `inputs:` block: returns the index of
    // the first line after `inputs:` plus the block's base indent, or
    // null when the template declares no dispatch inputs (the lint then
    // fails loudly on every required key).
    // gh-1075 review (CRAP ratchet): the state machine is split into this
    // finder and the key collector below — each loop carries one branch.
    function dispatchInputsBlock(lines) {
        var inDispatch = false;
        for (var i = 0; i < lines.length; i++) {
            var trimmed = lines[i].replace(/\s+$/, '');
            if (!inDispatch) {
                if (/^on:\s*$/.test(trimmed)) inDispatch = true;
                continue;
            }
            var mInput = /^\s+inputs:\s*$/.exec(lines[i]);
            if (mInput) {
                return { start: i + 1,
                    baseIndent: mInput[0].length - 'inputs:'.length - 1 };
            }
        }
        return null;
    }

    // Parse the workflow_dispatch input names out of the template by
    // indentation — no YAML dependency in the GraalJS runtime.
    function declaredDispatchInputs(templateText) {
        var lines = String(templateText).split(/\r?\n/);
        var inputs = {};
        var block = dispatchInputsBlock(lines);
        if (!block) return inputs;
        for (var i = block.start; i < lines.length; i++) {
            var line = lines[i];
            var trimmed = line.replace(/\s+$/, '');
            // inside inputs: entry keys are indented deeper than 'inputs:'
            var mKey = /^\s+([A-Za-z0-9_]+):\s*$/.exec(line);
            if (!mKey) {
                // any line at or above the inputs indent closes the block
                if (trimmed !== '' &&
                    (line.length - line.replace(/^\s+/, '').length) <= block.baseIndent) break;
                continue;
            }
            var indent = line.length - line.replace(/^\s+/, '').length;
            if (indent > block.baseIndent) inputs[mKey[1]] = true;
        }
        return inputs;
    }

    test('ai-teammate.yml.template declares issue/leg/reason/pr AND checkout_ref', function () {
        var tpl = file_read({ path: 'workflows/ai-teammate.yml.template' });
        var declared = declaredDispatchInputs(tpl);
        var required = ['issue', 'leg', 'reason', 'pr', 'checkout_ref'];
        required.forEach(function (k) {
            assert.ok(declared[k], 'workflow_dispatch must declare "' + k + '" — ' +
                'an undeclared dispatch input 422s "Unexpected inputs provided" on the ' +
                'dispatches endpoint (gh-aw#50027) and the fork fix can never fire');
        });
    });

    test('the fork-path input keys smAgent sends are exactly template-declared', function () {
        var tpl = file_read({ path: 'workflows/ai-teammate.yml.template' });
        var declared = declaredDispatchInputs(tpl);
        // The gh-1075 fork path adds these two to the rule-declared inputs
        // (js/smAgent.js triggerWorkflow: inputs.checkout_ref always,
        // inputs.pr backfilled when the rule carried no {prNumber}).
        ['checkout_ref', 'pr'].forEach(function (k) {
            assert.ok(declared[k], 'the gh-1075 fork dispatch sends inputs.' + k +
                ' — the template must declare it or every fork dispatch 422s');
        });
    });
});
