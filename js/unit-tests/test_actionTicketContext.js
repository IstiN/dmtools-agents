/**
 * Unit tests for js/common/actionTicketContext.js (gh-1250)
 *
 * The helper owns the shared opening block of the moveTo* postJSActions:
 * ticket-key resolution (structured failure when absent), project-config load
 * (jobParams || params), and tracker creation from the config + customParams
 * (jobParams.customParams wins, then top-level, then {}).
 */

function loadActionTicketContext(mocks) {
    mocks = mocks || {};
    return loadModule('js/common/actionTicketContext.js', makeRequire({
        '../configLoader.js': mocks.__configLoader || makeDefaultConfigLoaderMock(),
        './trackers.js': mocks.__trackers || { createTracker: function() { throw new Error('unexpected createTracker'); } }
    }), mocks);
}

function makeRecordingDeps(overrides) {
    var calls = { loadProjectConfig: [], createTracker: [] };
    var deps = {
        __configLoader: {
            loadProjectConfig: function(params) {
                calls.loadProjectConfig.push(params);
                return { jira: { statuses: { DONE: 'Done' }, trackerProvider: 'jira' } };
            }
        },
        __trackers: {
            createTracker: function(config, customParams) {
                calls.createTracker.push({ config: config, customParams: customParams });
                return { __fakeTracker: true };
            }
        }
    };
    if (overrides) {
        for (var k in overrides) {
            if (Object.prototype.hasOwnProperty.call(overrides, k)) deps[k] = overrides[k];
        }
    }
    return { deps: deps, calls: calls };
}

suite('actionTicketContext', function() {

    test('ticketKeyOf: the ticket key, or null when the action has no ticket', function() {
        var m = loadActionTicketContext({});
        assert.equal(m.ticketKeyOf({ ticket: { key: 'TS-1' } }), 'TS-1');
        assert.equal(m.ticketKeyOf({}), null);
        assert.equal(m.ticketKeyOf({ ticket: {} }), undefined);
    });

    test('customParamsOf: jobParams wins, then top-level, then {}', function() {
        var m = loadActionTicketContext({});
        assert.deepEqual(m.customParamsOf({ jobParams: { customParams: { a: 1 } } }), { a: 1 });
        assert.deepEqual(m.customParamsOf({ jobParams: {}, customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(m.customParamsOf({ customParams: { c: 3 } }), { c: 3 });
        assert.deepEqual(m.customParamsOf({}), {});
    });

    test('resolveTicketContext: no ticket key -> structured failure, no config load, no tracker', function() {
        var rec = makeRecordingDeps();
        var m = loadActionTicketContext(rec.deps);

        var result = m.resolveTicketContext({});

        assert.deepEqual(result, { ok: false, failure: { success: false, error: 'No ticket key found in params' } });
        assert.equal(rec.calls.loadProjectConfig.length, 0);
        assert.equal(rec.calls.createTracker.length, 0);
    });

    test('resolveTicketContext: happy path exposes ticketKey, projectConfig, jiraConfig and tracker', function() {
        var rec = makeRecordingDeps();
        var m = loadActionTicketContext(rec.deps);

        var result = m.resolveTicketContext({ ticket: { key: 'TS-10' } });

        assert.equal(result.ok, true);
        assert.equal(result.ticketKey, 'TS-10');
        assert.equal(result.jiraConfig.statuses.DONE, 'Done');
        assert.deepEqual(result.tracker, { __fakeTracker: true });
        assert.equal(rec.calls.loadProjectConfig.length, 1);
        assert.deepEqual(rec.calls.loadProjectConfig[0], { ticket: { key: 'TS-10' } }, 'params itself when no jobParams');
        assert.equal(rec.calls.createTracker.length, 1);
        assert.equal(rec.calls.createTracker[0].config.jira.statuses.DONE, 'Done');
        assert.deepEqual(rec.calls.createTracker[0].customParams, {});
    });

    test('resolveTicketContext: jobParams is what loadProjectConfig receives', function() {
        var rec = makeRecordingDeps();
        var m = loadActionTicketContext(rec.deps);
        var jobParams = { customParams: { stageFallback: 'label' } };

        m.resolveTicketContext({ ticket: { key: 'TS-11' }, jobParams: jobParams });

        assert.equal(rec.calls.loadProjectConfig.length, 1);
        assert.equal(rec.calls.loadProjectConfig[0], jobParams, 'jobParams wins over params');
        assert.deepEqual(rec.calls.createTracker[0].customParams, { stageFallback: 'label' });
    });

    test('resolveTicketContext: top-level customParams reach createTracker when jobParams has none', function() {
        var rec = makeRecordingDeps();
        var m = loadActionTicketContext(rec.deps);

        m.resolveTicketContext({ ticket: { key: 'TS-12' }, customParams: { stageFallback: 'none' } });

        assert.deepEqual(rec.calls.createTracker[0].customParams, { stageFallback: 'none' });
    });

    test('resolveTicketContext: a throwing configLoader propagates (caller catch keeps old behavior)', function() {
        var rec = makeRecordingDeps({
            __configLoader: {
                loadProjectConfig: function() { throw new Error('config exploded'); }
            }
        });
        var m = loadActionTicketContext(rec.deps);

        var threw = null;
        try {
            m.resolveTicketContext({ ticket: { key: 'TS-13' } });
        } catch (e) {
            threw = e;
        }

        assert.ok(threw, 'expected the loader error to propagate');
        assert.equal(String(threw.message).indexOf('config exploded') !== -1, true);
        assert.equal(rec.calls.createTracker.length, 0, 'no tracker when the config load failed');
    });

    test('resolveTicketContext: a throwing createTracker propagates', function() {
        var rec = makeRecordingDeps({
            __trackers: {
                createTracker: function() { throw new Error('tracker exploded'); }
            }
        });
        var m = loadActionTicketContext(rec.deps);

        var threw = null;
        try {
            m.resolveTicketContext({ ticket: { key: 'TS-14' } });
        } catch (e) {
            threw = e;
        }

        assert.ok(threw, 'expected the tracker error to propagate');
        assert.equal(String(threw.message).indexOf('tracker exploded') !== -1, true);
    });
});
