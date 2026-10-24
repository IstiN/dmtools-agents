/**
 * Unit tests for the shared test-runner mock helpers (gh-824 rework).
 *
 * The throwing './trackers.js' mock was copy-pasted across six suites that
 * load contentOutput-backed modules; trackersMock() in testRunner.js now
 * owns the "contentOutput tracker fallback must never fire here" contract
 * in exactly one place. These tests pin that contract so a change to the
 * fallback shape (different function, different message) turns red here
 * first.
 *
 * Uses: trackersMock(), suite(), test(), assert
 */

'use strict';

/* global trackersMock, suite, test, assert */

suite('unit-test mocks: trackersMock (the shared contentOutput tracker fallback)', function () {

    test('exposes createTracker as a function', function () {
        var mock = trackersMock();
        assert.ok(mock, 'trackersMock() must return a mock object');
        assert.equal(typeof mock.createTracker, 'function',
            'the mock must shape like the trackers module (createTracker)');
    });

    test('createTracker throws — the fallback must never fire in these suites', function () {
        var mock = trackersMock();
        var thrown = null;
        try {
            mock.createTracker(null, {});
        } catch (e) {
            thrown = e;
        }
        assert.ok(thrown, 'createTracker must throw when the fallback is reached');
        assert.contains(thrown.message, 'tracker fallback not expected',
            'the message must name the unexpected fallback');
    });

    test('a fresh mock per call — one suite throwing must not poison another', function () {
        var a = trackersMock();
        var b = trackersMock();
        assert.notEqual(a, b, 'each call returns a fresh object');
        assert.notEqual(a.createTracker, b.createTracker,
            'each mock carries its own throwing function');
    });
});

// ── gh-1230 CRAP characterization: makeDefaultConfigLoaderMock merge contract ─

suite('unit-test mocks: makeDefaultConfigLoaderMock (jira merge + patch contract)', function () {

    test('empty extraConfig returns only the default jira issue types and statuses', function () {
        var result = makeDefaultConfigLoaderMock({}).loadProjectConfig({});
        assert.ok(result.jira, 'jira block present');
        assert.deepEqual(result.jira.issueTypes, makeDefaultJiraConfig().issueTypes);
        assert.deepEqual(result.jira.statuses, makeDefaultJiraConfig().statuses);
        assert.equal(result.repository, undefined, 'no repository without a patch');
        assert.equal(result.jobParamPatches, undefined, 'no jobParamPatches without a patch');
    });

    test('repository and jobParamPatches patch straight through', function () {
        var patch = { owner: 'acme', repo: 'widgets' };
        var result = makeDefaultConfigLoaderMock({
            repository: patch,
            jobParamPatches: { instructions: 'patched' }
        }).loadProjectConfig({});
        assert.deepEqual(result.repository, patch);
        assert.deepEqual(result.jobParamPatches, { instructions: 'patched' });
    });

    test('jira overrides merge onto defaults (2+ keys, default values kept)', function () {
        var defaults = makeDefaultJiraConfig();
        var result = makeDefaultConfigLoaderMock({
            jira: {
                issueTypes: { story: 'Story X', bug: 'Defect' },
                statuses: { dev: 'In Development' }
            }
        }).loadProjectConfig({});
        assert.equal(result.jira.issueTypes.story, 'Story X', 'override wins');
        assert.equal(result.jira.issueTypes.bug, 'Defect', 'new key added');
        for (var k in defaults.issueTypes) {
            if (k !== 'story') {
                assert.ok(result.jira.issueTypes[k] !== undefined,
                    'default key kept after merge: ' + k);
                if (k !== 'bug') {
                    assert.equal(result.jira.issueTypes[k], defaults.issueTypes[k],
                        'default kept for ' + k);
                }
            }
        }
        assert.equal(result.jira.statuses.dev, 'In Development');
        for (var s in defaults.statuses) {
            if (s !== 'dev') {
                assert.equal(result.jira.statuses[s], defaults.statuses[s],
                    'default status kept for ' + s);
            }
        }
    });

    test('interpolateJql delegates to the real configLoader', function () {
        var mock = makeDefaultConfigLoaderMock({});
        var cfg = mock.loadProjectConfig({});
        assert.equal(mock.interpolateJql('key = {ticketKey}', { ticketKey: 'GH-1' }, 'github'),
            configLoaderModule.interpolateJql('key = {ticketKey}', { ticketKey: 'GH-1' }, 'github'));
        assert.ok(cfg, 'loadProjectConfig usable before interpolation');
    });
});
