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

    test('resolveTicketContext: options.statusKey prints the shared "Moving" opener after tracker creation', function() {
        var rec = makeRecordingDeps();
        var logs = [];
        var m = loadActionTicketContext(Object.assign({
            console: {
                log: function(msg) { logs.push(String(msg)); },
                warn: function() {},
                error: function() {}
            }
        }, rec.deps));

        var result = m.resolveTicketContext({ ticket: { key: 'TS-20' } }, { statusKey: 'DONE' });

        assert.equal(result.ok, true);
        assert.deepEqual(logs, ['Moving TS-20 to Done']);
    });

    test('resolveTicketContext: options.logNote is appended verbatim to the opener', function() {
        var rec = makeRecordingDeps();
        var logs = [];
        var m = loadActionTicketContext(Object.assign({
            console: {
                log: function(msg) { logs.push(String(msg)); },
                warn: function() {},
                error: function() {}
            }
        }, rec.deps));

        m.resolveTicketContext({ ticket: { key: 'TS-21' } }, { statusKey: 'DONE', logNote: ' (bug with test cases generated)' });

        assert.deepEqual(logs, ['Moving TS-21 to Done (bug with test cases generated)']);
    });

    test('resolveTicketContext: no options.statusKey -> silent, context still resolved', function() {
        var rec = makeRecordingDeps();
        var logs = [];
        var m = loadActionTicketContext(Object.assign({
            console: {
                log: function(msg) { logs.push(String(msg)); },
                warn: function() {},
                error: function() {}
            }
        }, rec.deps));

        var result = m.resolveTicketContext({ ticket: { key: 'TS-22' } });

        assert.equal(result.ok, true);
        assert.deepEqual(logs, []);
    });

    test('announceMove: direct call — no-op without options, opener with statusKey + logNote', function() {
        var rec = makeRecordingDeps();
        var logs = [];
        var m = loadActionTicketContext(Object.assign({
            console: {
                log: function(msg) { logs.push(String(msg)); },
                warn: function() {},
                error: function() {}
            }
        }, rec.deps));
        var jiraConfig = { statuses: { READY_FOR_TESTING: 'Ready For Testing' } };

        m.announceMove('TS-30', jiraConfig, null);
        assert.deepEqual(logs, []);

        m.announceMove('TS-30', jiraConfig, { statusKey: 'READY_FOR_TESTING', logNote: '!' });
        assert.deepEqual(logs, ['Moving TS-30 to Ready For Testing!']);
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
