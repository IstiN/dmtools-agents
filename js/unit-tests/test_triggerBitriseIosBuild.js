/**
 * Characterization tests for js/triggerBitriseIosBuild.js (gh-929).
 *
 * Pin the CURRENT behaviour of action() — bitrise trigger arguments, env
 * var matrix, comment text, branch resolution and return shapes — before
 * the CRAP refactor extracts pure helpers from it.
 */

function makeIosRecorder() {
    return { calls: [] };
}

function loadIosModule(mocks) {
    var rec = mocks.rec;
    var trackerApi = mocks.trackerApi || {};
    var trackers = {
        createTracker: function(config, customParams) {
            rec.calls.push({ op: 'createTracker', config: config, customParams: customParams });
            return {
                getIssue: function(key) {
                    rec.calls.push({ op: 'getIssue', key: key });
                    return trackerApi.getIssue ? trackerApi.getIssue(key) : null;
                },
                searchIssues: function(jql, opts) {
                    rec.calls.push({ op: 'searchIssues', jql: jql, opts: opts });
                    return trackerApi.searchIssues ? trackerApi.searchIssues(jql, opts) : [];
                },
                postComment: function(key, comment) {
                    rec.calls.push({ op: 'postComment', key: key, comment: comment });
                    if (trackerApi.postComment) return trackerApi.postComment(key, comment);
                },
                moveToStatusOrMark: function() { throw new Error('moveToStatusOrMark not expected here'); },
                removeLabel: function() { throw new Error('removeLabel not expected here'); }
            };
        }
    };
    var configLoader = {
        loadProjectConfig: function(params) {
            rec.calls.push({ op: 'loadProjectConfig' });
            return mocks.projectConfig || {};
        },
        createScm: function(config) {
            rec.calls.push({ op: 'createScm', scm: config.scm, repository: config.repository });
            return {
                listPrs: function(state) {
                    rec.calls.push({ op: 'listPrs', state: state });
                    return mocks.listPrs ? mocks.listPrs(state) : [];
                }
            };
        }
    };
    var globals = {};
    globals.bitrise_trigger_build = function(args) {
        rec.calls.push({ op: 'bitrise_trigger_build', args: args });
        if (mocks.bitriseTriggerBuild) return mocks.bitriseTriggerBuild(args);
        return { build_number: 4, build_url: 'http://bitrise/b4' };
    };
    return loadModule('js/triggerBitriseIosBuild.js', makeRequire({
        './configLoader.js': configLoader,
        './common/trackers.js': trackers
    }), globals);
}

function iosCalls(rec, op) {
    return rec.calls.filter(function(c) { return c.op === op; });
}

suite('triggerBitriseIosBuild — characterization', function() {

    test('happy path: key jql, no featurePR config → develop branch, comment, return shape', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(key) { return { key: key, fields: { summary: 'sum x' } }; } }
        });
        var r = mod.action({
            jobParams: {
                inputJql: 'key = IOS-1',
                bitriseBuild: { appSlug: 'app-9' },
                customParams: {}
            }
        });

        assert.deepEqual(r, { success: true, buildUrl: 'http://bitrise/b4', branch: 'develop', workflowId: 'build_ios_simulator' });

        assert.deepEqual(rec.calls.map(function(c) { return c.op; }), [
            'loadProjectConfig', 'createTracker', 'getIssue',
            'bitrise_trigger_build', 'postComment'
        ]);

        var trig = iosCalls(rec, 'bitrise_trigger_build')[0].args;
        assert.equal(trig.appSlug, 'app-9');
        assert.equal(trig.workflowId, 'build_ios_simulator');
        assert.equal(trig.branch, 'develop');
        assert.equal(trig.commitMessage, 'IOS-1 — iOS build for develop');
        assert.deepEqual(JSON.parse(trig.envVars), [
            { mapped_to: 'TICKET_KEY', value: 'IOS-1', is_expand: false },
            { mapped_to: 'MOBILE_BRANCH', value: 'develop', is_expand: false }
        ]);

        var comment = iosCalls(rec, 'postComment')[0];
        assert.equal(comment.key, 'IOS-1');
        assert.equal(comment.comment,
            'h3. 🏗️ iOS Build Triggered\n\n' +
            'Bitrise *build_ios_simulator* triggered manually for *IOS-1*.\n\n' +
            '| Field | Value |\n|-------|-------|\n' +
            '| Workflow | build_ios_simulator |\n' +
            '| Branch | develop |\n' +
            '| Build | [View on Bitrise|http://bitrise/b4] |');
    });

    test('missing appSlug: error before any ticket fetch or trigger', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function() { throw new Error('must not be called'); } }
        });
        var r = mod.action({ jobParams: { inputJql: 'key = IOS-2', bitriseBuild: {}, customParams: {} } });
        assert.deepEqual(r, { success: false, error: 'Missing bitriseBuild.appSlug' });
        assert.equal(iosCalls(rec, 'getIssue').length, 0);
        assert.equal(iosCalls(rec, 'bitrise_trigger_build').length, 0);
        assert.equal(iosCalls(rec, 'postComment').length, 0);
    });

    test('jql without a key: ticket resolved via searchIssues', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { searchIssues: function() {
                return [{ key: 'IOS-3', fields: { summary: 'searched' } }];
            } }
        });
        var r = mod.action({ jobParams: { inputJql: 'labels = iosbuild', bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.equal(r.success, true);
        var search = iosCalls(rec, 'searchIssues')[0];
        assert.equal(search.jql, 'labels = iosbuild');
        assert.deepEqual(search.opts, { maxResults: 1 });
        assert.equal(iosCalls(rec, 'postComment')[0].key, 'IOS-3');
    });

    test('jql without a key and empty search result: no ticket error', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({ rec: rec });
        var r = mod.action({ jobParams: { inputJql: 'labels = nothing', bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.deepEqual(r, { success: false, error: 'No ticket found for: labels = nothing' });
        assert.equal(iosCalls(rec, 'bitrise_trigger_build').length, 0);
    });

    test('search throwing: same no-ticket error, still no trigger', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { searchIssues: function() { throw new Error('wiql bad'); } }
        });
        var r = mod.action({ jobParams: { inputJql: 'broken', bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.deepEqual(r, { success: false, error: 'No ticket found for: broken' });
    });

    test('getIssue failure is non-fatal: key from jql is used anyway', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function() { throw new Error('api down'); } }
        });
        var r = mod.action({ jobParams: { inputJql: 'key = IOS-4', bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.equal(r.success, true);
        assert.equal(iosCalls(rec, 'bitrise_trigger_build')[0].args.commitMessage, 'IOS-4 — iOS build for develop');
        assert.equal(iosCalls(rec, 'postComment')[0].key, 'IOS-4');
    });

    test('empty inputJql: no ticket error mentions the empty jql', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({ rec: rec });
        var r = mod.action({ jobParams: { bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.deepEqual(r, { success: false, error: 'No ticket found for: ' });
    });

    test('feature PR found: branch, env FEATURE_PR_URL and comment row all set', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(k) { return { key: k, fields: {} }; } },
            listPrs: function() {
                return [
                    { number: 21, title: 'nope', head: { ref: 'misc' }, html_url: 'http://pr/21' },
                    { number: 22, title: 'IOS-5 work', head: { ref: 'ai/IOS-5' }, html_url: 'http://pr/22' }
                ];
            }
        });
        var r = mod.action({
            jobParams: {
                inputJql: 'key = IOS-5',
                bitriseBuild: { appSlug: 'a' },
                featurePR: { owner: 'o', repo: 'r' },
                customParams: {}
            }
        });
        assert.equal(r.branch, 'ai/IOS-5');
        var trig = iosCalls(rec, 'bitrise_trigger_build')[0].args;
        assert.equal(trig.branch, 'ai/IOS-5');
        assert.equal(trig.commitMessage, 'IOS-5 — iOS build for ai/IOS-5');
        assert.deepEqual(JSON.parse(trig.envVars), [
            { mapped_to: 'TICKET_KEY', value: 'IOS-5', is_expand: false },
            { mapped_to: 'MOBILE_BRANCH', value: 'ai/IOS-5', is_expand: false },
            { mapped_to: 'FEATURE_PR_URL', value: 'http://pr/22', is_expand: false }
        ]);
        assert.contains(iosCalls(rec, 'postComment')[0].comment, '\n| Feature PR | http://pr/22 |');
    });

    test('PR without head.ref falls back to develop branch and pr.url fallback for the comment', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(k) { return { key: k, fields: {} }; } },
            listPrs: function() { return [{ number: 23, title: 'IOS-6', url: 'http://pr/23' }]; }
        });
        var r = mod.action({
            jobParams: {
                inputJql: 'key = IOS-6',
                bitriseBuild: { appSlug: 'a' },
                featurePR: { owner: 'o', repo: 'r' },
                customParams: {}
            }
        });
        assert.equal(r.branch, 'develop');
        var env = JSON.parse(iosCalls(rec, 'bitrise_trigger_build')[0].args.envVars);
        assert.equal(env.length, 3);
        assert.deepEqual(env[1], { mapped_to: 'MOBILE_BRANCH', value: 'develop', is_expand: false });
        assert.deepEqual(env[2], { mapped_to: 'FEATURE_PR_URL', value: 'http://pr/23', is_expand: false });
    });

    test('feature scm failure is non-fatal: triggers on develop without PR env', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(k) { return { key: k, fields: {} }; } },
            listPrs: function() { throw new Error('scm down'); }
        });
        var r = mod.action({
            jobParams: {
                inputJql: 'key = IOS-7',
                bitriseBuild: { appSlug: 'a' },
                featurePR: { owner: 'o', repo: 'r' },
                customParams: {}
            }
        });
        assert.equal(r.success, true);
        assert.equal(r.branch, 'develop');
        var env = JSON.parse(iosCalls(rec, 'bitrise_trigger_build')[0].args.envVars);
        assert.equal(env.length, 2);
    });

    test('triggerBranch override: bitrise fetches YAML from triggerBranch, MOBILE_BRANCH stays PR branch', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(k) { return { key: k, fields: {} }; } },
            listPrs: function() { return [{ number: 24, title: 'IOS-8', head: { ref: 'ai/IOS-8' }, html_url: 'http://pr/24' }]; }
        });
        var r = mod.action({
            jobParams: {
                inputJql: 'key = IOS-8',
                bitriseBuild: { appSlug: 'a', triggerBranch: 'main', workflowId: 'wf_ios' },
                featurePR: { owner: 'o', repo: 'r' },
                customParams: {}
            }
        });
        var trig = iosCalls(rec, 'bitrise_trigger_build')[0].args;
        assert.equal(trig.branch, 'main');
        var env = JSON.parse(trig.envVars);
        assert.equal(env[1].value, 'ai/IOS-8');
        assert.equal(r.workflowId, 'wf_ios');
        assert.equal(r.branch, 'ai/IOS-8');
        assert.contains(iosCalls(rec, 'postComment')[0].comment, '| Workflow | wf_ios |');
    });

    test('build result variants: JSON string, build_slug fallback, results[0] fallback', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(k) { return { key: k, fields: {} }; } },
            bitriseTriggerBuild: function() {
                return JSON.stringify({ results: [{ build_url: 'http://res/0' }] });
            }
        });
        var r = mod.action({ jobParams: { inputJql: 'key = IOS-9', bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.equal(r.buildUrl, 'http://res/0');

        rec = makeIosRecorder();
        mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(k) { return { key: k, fields: {} }; } },
            bitriseTriggerBuild: function() { return { build_slug: 'slg9' }; }
        });
        r = mod.action({ jobParams: { inputJql: 'key = IOS-9', bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.equal(r.buildUrl, 'https://app.bitrise.io/build/slg9');
    });

    test('build result with no recognizable url: success with empty buildUrl and no Build row', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(k) { return { key: k, fields: {} }; } },
            bitriseTriggerBuild: function() { return {}; }
        });
        var r = mod.action({ jobParams: { inputJql: 'key = IOS-10', bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.deepEqual(r, { success: true, buildUrl: '', branch: 'develop', workflowId: 'build_ios_simulator' });
        assert.notContains(iosCalls(rec, 'postComment')[0].comment, '| Build |');
    });

    test('postComment failure is non-fatal', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: {
                getIssue: function(k) { return { key: k, fields: {} }; },
                postComment: function() { throw new Error('comment down'); }
            }
        });
        var r = mod.action({ jobParams: { inputJql: 'key = IOS-11', bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.equal(r.success, true);
        assert.equal(iosCalls(rec, 'postComment').length, 1);
    });

    test('trigger throwing: outer catch returns error, no comment', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(k) { return { key: k, fields: {} }; } },
            bitriseTriggerBuild: function() { throw new Error('trigger exploded'); }
        });
        var r = mod.action({ jobParams: { inputJql: 'key = IOS-12', bitriseBuild: { appSlug: 'a' }, customParams: {} } });
        assert.deepEqual(r, { success: false, error: 'Error: trigger exploded' });
        assert.equal(iosCalls(rec, 'postComment').length, 0);
    });

    test('inputJql from params wins over jobParams.inputJql', function() {
        var rec = makeIosRecorder();
        var mod = loadIosModule({
            rec: rec,
            trackerApi: { getIssue: function(k) { return { key: k, fields: {} }; } }
        });
        var r = mod.action({
            inputJql: 'key = IOS-13',
            jobParams: { inputJql: 'key = WRONG', bitriseBuild: { appSlug: 'a' }, customParams: {} }
        });
        assert.equal(r.success, true);
        assert.equal(iosCalls(rec, 'getIssue')[0].key, 'IOS-13');
    });
});
