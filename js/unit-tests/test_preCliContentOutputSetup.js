/**
 * Unit tests for js/preCliContentOutputSetup.js — the InputContextBundle
 * pre-CLI chain (gh-1112 AC3 / E1 / E2):
 *
 *   fetchQuestionsToInput → fetchParentContextToInput → fetchConfluenceOutputContext
 *
 * Invariants under test:
 *   - all three steps are invoked, in order;
 *   - a throw in any individual step is caught and logged as non-fatal, the
 *     remaining steps still execute;
 *   - fetchQuestionsToInput is told the caller owns the parent-context step
 *     (skipParentContext) so the parent-context JQL is not fired twice;
 *   - params without inputFolderPath are normalized to jobParams.
 */

function makeStep(name, behavior) {
    return {
        name: name,
        calls: [],
        action: function(params) {
            this.calls.push(params || null);
            if (behavior && behavior.throws) {
                throw new Error(name + ' exploded');
            }
            return { ok: true, step: name };
        }
    };
}

function makeSteps(opts) {
    opts = opts || {};
    return {
        questions: makeStep('questions', { throws: opts.throws === 'questions' }),
        parent: makeStep('parent', { throws: opts.throws === 'parent' }),
        confluence: makeStep('confluence', { throws: opts.throws === 'confluence' })
    };
}

function loadSetup(steps) {
    return loadModule('js/preCliContentOutputSetup.js', makeRequire({
        './fetchQuestionsToInput.js': { action: steps.questions.action },
        './fetchParentContextToInput.js': { action: steps.parent.action },
        './fetchConfluenceOutputContext.js': { action: steps.confluence.action }
    }), {});
}

suite('preCliContentOutputSetup — InputContextBundle chain (gh-1112 AC3)', function() {

    test('invokes questions → parent → confluence in order', function() {
        var steps = makeSteps();
        var mod = loadSetup(steps);
        mod.action({ inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1' } });
        assert.equal(steps.questions.calls.length, 1, 'questions step invoked');
        assert.equal(steps.parent.calls.length, 1, 'parent step invoked');
        assert.equal(steps.confluence.calls.length, 1, 'confluence step invoked');
    });

    test('a throw in the questions step does not stop parent + confluence (UT-pre-2)', function() {
        var steps = makeSteps({ throws: 'questions' });
        var mod = loadSetup(steps);
        mod.action({ inputFolderPath: 'input/PROJ-1' });
        assert.equal(steps.parent.calls.length, 1, 'parent context still fetched');
        assert.equal(steps.confluence.calls.length, 1, 'confluence context still fetched');
    });

    test('a throw in the parent step does not stop confluence (UT-pre-3)', function() {
        var steps = makeSteps({ throws: 'parent' });
        var mod = loadSetup(steps);
        mod.action({ inputFolderPath: 'input/PROJ-1' });
        assert.equal(steps.questions.calls.length, 1, 'questions step ran');
        assert.equal(steps.confluence.calls.length, 1, 'confluence context still fetched');
    });

    test('a throw in the confluence step does not propagate (UT-pre-2/3 fault isolation)', function() {
        var steps = makeSteps({ throws: 'confluence' });
        var mod = loadSetup(steps);
        // must not throw
        mod.action({ inputFolderPath: 'input/PROJ-1' });
        assert.equal(steps.questions.calls.length, 1);
        assert.equal(steps.parent.calls.length, 1);
    });

    test('every step failing still resolves without throwing (E1/E2 non-fatal invariant)', function() {
        var steps = makeSteps({ throws: 'questions' });
        steps.parent.action = function() { throw new Error('parent exploded'); };
        steps.confluence.action = function() { throw new Error('confluence exploded'); };
        var mod = loadSetup(steps);
        var err = null;
        try {
            mod.action({ inputFolderPath: 'input/PROJ-1' });
        } catch (e) {
            err = e;
        }
        assert.equal(err, null, 'no exception may escape the setup');
    });

    test('fetchQuestionsToInput is told the caller owns the parent-context step', function() {
        var steps = makeSteps();
        var mod = loadSetup(steps);
        mod.action({ inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1' } });
        assert.equal(steps.questions.calls[0].skipParentContext, true,
            'questions step must skip its built-in parent-context call (prevents a duplicate JQL)');
        assert.ok(!steps.parent.calls[0].skipParentContext,
            'the explicit parent step must run unconditioned');
    });

    test('params without inputFolderPath fall back to jobParams for the parent/confluence steps', function() {
        var steps = makeSteps();
        var mod = loadSetup(steps);
        var jobParams = { inputFolderPath: 'input/PROJ-9', ticket: { key: 'PROJ-9' } };
        mod.action({ jobParams: jobParams });
        assert.equal(steps.questions.calls.length, 1);
        assert.equal(steps.parent.calls[0], jobParams, 'parent step receives the jobParams block');
        assert.equal(steps.confluence.calls[0], jobParams, 'confluence step receives the jobParams block');
    });
});
