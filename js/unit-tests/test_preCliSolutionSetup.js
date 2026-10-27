/**
 * Unit tests for js/preCliSolutionSetup.js (gh-1279)
 *
 * Verifies:
 *   - invokes fetchQuestionsToInput → fetchParentContextToInput → fetchConfluenceOutputContext in order;
 *   - passes skipParentContext: true to fetchQuestionsToInput so fetchParentContextToInput is not executed twice;
 *   - non-fatal error isolation for fetchParentContextToInput, fetchConfluenceOutputContext, and outer catch;
 *   - params without inputFolderPath normalize to jobParams.
 */

function makeSolutionStep(name, behavior) {
    var calls = [];
    return {
        name: name,
        calls: calls,
        action: function(params) {
            calls.push(params || null);
            if (behavior && behavior.throws) {
                throw new Error(name + ' failed');
            }
            return { ok: true, step: name };
        }
    };
}

function makeSolutionSteps(opts) {
    opts = opts || {};
    return {
        questions: makeSolutionStep('questions', { throws: opts.throws === 'questions' }),
        parent: makeSolutionStep('parent', { throws: opts.throws === 'parent' }),
        confluence: makeSolutionStep('confluence', { throws: opts.throws === 'confluence' })
    };
}

function loadSolutionSetup(steps) {
    return loadModule('js/preCliSolutionSetup.js', makeRequire({
        './fetchQuestionsToInput.js': { action: steps.questions.action },
        './fetchParentContextToInput.js': { action: steps.parent.action },
        './fetchConfluenceOutputContext.js': { action: steps.confluence.action }
    }), {});
}

suite('preCliSolutionSetup — gh-1279 parent context dedup and fault isolation', function() {

    test('invokes questions → parent → confluence in order with skipParentContext: true on questions', function() {
        var steps = makeSolutionSteps();
        var mod = loadSolutionSetup(steps);
        mod.action({ inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1' } });
        assert.equal(steps.questions.calls.length, 1, 'questions step invoked once');
        assert.equal(steps.parent.calls.length, 1, 'parent step invoked once');
        assert.equal(steps.confluence.calls.length, 1, 'confluence step invoked once');
        assert.equal(steps.questions.calls[0].skipParentContext, true,
            'fetchQuestionsToInput receives skipParentContext: true to prevent duplicate parent context fetch');
        assert.ok(!steps.parent.calls[0].skipParentContext,
            'fetchParentContextToInput receives original params without skipParentContext');
    });

    test('falls back to jobParams when inputFolderPath is not at top level', function() {
        var steps = makeSolutionSteps();
        var mod = loadSolutionSetup(steps);
        var jobParams = { inputFolderPath: 'input/PROJ-2', ticket: { key: 'PROJ-2' } };
        mod.action({ jobParams: jobParams });
        assert.equal(steps.questions.calls.length, 1);
        assert.equal(steps.questions.calls[0].inputFolderPath, 'input/PROJ-2');
        assert.equal(steps.questions.calls[0].skipParentContext, true);
        assert.equal(steps.parent.calls[0], jobParams, 'parent step receives jobParams');
        assert.equal(steps.confluence.calls[0], jobParams, 'confluence step receives jobParams');
    });

    test('uses top-level params when neither inputFolderPath nor jobParams is present', function() {
        var steps = makeSolutionSteps();
        var mod = loadSolutionSetup(steps);
        var flatParams = { ticket: { key: 'PROJ-3' } };
        mod.action(flatParams);
        assert.equal(steps.questions.calls.length, 1);
        assert.equal(steps.questions.calls[0].skipParentContext, true);
        assert.equal(steps.parent.calls[0], flatParams);
        assert.equal(steps.confluence.calls[0], flatParams);
    });

    test('a throw in fetchParentContextToInput is caught and does not block fetchConfluenceOutputContext', function() {
        var steps = makeSolutionSteps({ throws: 'parent' });
        var mod = loadSolutionSetup(steps);
        mod.action({ inputFolderPath: 'input/PROJ-1' });
        assert.equal(steps.questions.calls.length, 1);
        assert.equal(steps.parent.calls.length, 1);
        assert.equal(steps.confluence.calls.length, 1, 'confluence still runs after parent throws');
    });

    test('a throw in fetchConfluenceOutputContext is caught and non-fatal', function() {
        var steps = makeSolutionSteps({ throws: 'confluence' });
        var mod = loadSolutionSetup(steps);
        mod.action({ inputFolderPath: 'input/PROJ-1' });
        assert.equal(steps.questions.calls.length, 1);
        assert.equal(steps.parent.calls.length, 1);
        assert.equal(steps.confluence.calls.length, 1);
    });

    test('outer catch handles errors thrown in fetchQuestionsToInput or bad params without propagating', function() {
        var steps = makeSolutionSteps({ throws: 'questions' });
        var mod = loadSolutionSetup(steps);
        var threw = false;
        try {
            mod.action({ inputFolderPath: 'input/PROJ-1' });
        } catch (e) {
            threw = true;
        }
        assert.equal(threw, false, 'outer catch swallows unexpected error');
    });
});
