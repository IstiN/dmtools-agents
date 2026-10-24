/**
 * Characterization tests for js/triggerBitriseTestAutomation.js (gh-929).
 *
 * Pin the CURRENT behaviour of action() — call order, log-visible side
 * effects, return shapes and exact tracker/bitrise call arguments — before
 * the CRAP refactor extracts pure helpers from it.
 */

function makeTaRecorder() {
    return { calls: [] };
}

function makeTaTracker(rec, trackerApi) {
    var api = trackerApi || {};
    return {
        createTracker: function(config, customParams) {
            rec.calls.push({ op: 'createTracker', config: config, customParams: customParams });
            return {
                getIssue: function(key) {
                    rec.calls.push({ op: 'getIssue', key: key });
                    return api.getIssue ? api.getIssue(key) : null;
                },
                searchIssues: function(jql, opts) {
                    rec.calls.push({ op: 'searchIssues', jql: jql, opts: opts });
                    return api.searchIssues ? api.searchIssues(jql, opts) : [];
                },
                postComment: function(key, comment) {
                    rec.calls.push({ op: 'postComment', key: key, comment: comment });
                    if (api.postComment) return api.postComment(key, comment);
                },
                moveToStatusOrMark: function(key, status, stage) {
                    rec.calls.push({ op: 'moveToStatusOrMark', key: key, status: status, stage: stage });
                    return { moved: true, marked: false };
                },
                removeLabel: function(key, label) {
                    rec.calls.push({ op: 'removeLabel', key: key, label: label });
                    if (api.removeLabel) return api.removeLabel(key, label);
                }
            };
        }
    };
}

function makeTaConfigLoader(rec, mocks) {
    return {
        loadProjectConfig: function(params) {
            rec.calls.push({ op: 'loadProjectConfig' });
            if (mocks.loadProjectConfigThrows) throw mocks.loadProjectConfigThrows;
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
}

function makeTaGlobals(rec, mocks) {
    var globals = {};
    globals.bitrise_list_builds = function(args) {
        rec.calls.push({ op: 'bitrise_list_builds', args: args });
        if (mocks.bitriseListBuilds) return mocks.bitriseListBuilds(args);
        return { data: [] };
    };
    globals.bitrise_trigger_build = function(args) {
        rec.calls.push({ op: 'bitrise_trigger_build', args: args });
        if (mocks.bitriseTriggerBuild) return mocks.bitriseTriggerBuild(args);
        return { build_number: 3, build_url: 'http://bitrise/b3' };
    };
    globals.bitrise_abort_build = function(args) {
        rec.calls.push({ op: 'bitrise_abort_build', args: args });
        if (mocks.bitriseAbortBuild) return mocks.bitriseAbortBuild(args);
        return {};
    };
    return globals;
}

function loadTaModule(mocks) {
    // gh-1250: the action delegates JQL parsing and PR matching to
    // js/common/bitriseTrigger.js — load the real module (it has no requires).
    var bitriseTrigger = loadModule('js/common/bitriseTrigger.js', makeRequire({}));
    return loadModule('js/triggerBitriseTestAutomation.js', makeRequire({
        './configLoader.js': makeTaConfigLoader(mocks.rec, mocks),
        './config.js': configModule,
        './common/trackers.js': makeTaTracker(mocks.rec, mocks.trackerApi),
        './common/bitriseTrigger.js': bitriseTrigger
    }), makeTaGlobals(mocks.rec, mocks));
}

function taCalls(rec, op) {
    return rec.calls.filter(function(c) { return c.op === op; });
}

suite('triggerBitriseTestAutomation — characterization', function() {

    test('happy path: triggers bitrise, posts comment, moves status, removes labels, returns shape', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec });
        var r = mod.action({
            ticket: { key: 'TS-100', fields: { summary: 'do things' } },
            metadata: { contextId: 'ios' },
            jobParams: {
                customParams: {
                    bitriseBuild: { appSlug: 'app-1' },
                    featurePR: { owner: 'own', repo: 'mob' },
                    removeLabel: 'sm_trig'
                }
            }
        });

        assert.deepEqual(r, {
            success: true,
            message: 'Bitrise test automation triggered for TS-100',
            buildUrl: 'http://bitrise/b3',
            workflowId: 'ai_teammate_test_automation'
        });

        // tracker created twice: once bare, once with project config
        var creations = taCalls(rec, 'createTracker');
        assert.equal(creations.length, 2);
        assert.equal(creations[0].config, null);
        assert.equal(creations[1].customParams.bitriseBuild.appSlug, 'app-1');
        // config load sits between the two creations
        assert.deepEqual(rec.calls.map(function(c) { return c.op; }), [
            'createTracker', 'loadProjectConfig', 'createTracker',
            'createScm', 'listPrs',
            'bitrise_list_builds', 'bitrise_list_builds',
            'bitrise_trigger_build',
            'postComment', 'moveToStatusOrMark', 'removeLabel', 'removeLabel'
        ]);

        var trig = taCalls(rec, 'bitrise_trigger_build')[0].args;
        assert.equal(trig.appSlug, 'app-1');
        assert.equal(trig.workflowId, 'ai_teammate_test_automation');
        assert.equal(trig.branch, 'main');
        assert.equal(trig.commitMessage, 'TS-100 — AI test automation triggered by GitHub');
        assert.deepEqual(JSON.parse(trig.envVars), [
            { mapped_to: 'TICKET_KEY', value: 'TS-100', is_expand: false },
            { mapped_to: 'INPUT_JQL', value: 'key = TS-100', is_expand: false },
            { mapped_to: 'FEATURE_PR_URL', value: '', is_expand: false },
            { mapped_to: 'FEATURE_PR_NUMBER', value: '', is_expand: false },
            { mapped_to: 'FEATURE_REPO', value: 'own/mob', is_expand: false }
        ]);

        // dedup checks both statuses in order with the same app/workflow/branch
        var lists = taCalls(rec, 'bitrise_list_builds');
        assert.equal(lists.length, 2);
        assert.deepEqual(lists[0].args, { appSlug: 'app-1', workflowId: 'ai_teammate_test_automation', branch: 'main', status: 'not_started', limit: 50 });
        assert.deepEqual(lists[1].args, { appSlug: 'app-1', workflowId: 'ai_teammate_test_automation', branch: 'main', status: 'in_progress', limit: 50 });
        assert.equal(taCalls(rec, 'bitrise_abort_build').length, 0);

        var comment = taCalls(rec, 'postComment')[0];
        assert.equal(comment.key, 'TS-100');
        assert.equal(comment.comment,
            'h3. 🤖 iOS Test Automation Started\n\n' +
            'Maestro test automation for *TS-100* has been triggered on Bitrise.\n\n' +
            '| Field | Value |\n' +
            '|-------|-------|\n' +
            '| Workflow | ai_teammate_test_automation |\n' +
            '| Branch | main |\n' +
            '| Build | [Build #3|http://bitrise/b3] |\n' +
            '\nTest results will be posted here and on the feature PR once the build completes.');

        var move = taCalls(rec, 'moveToStatusOrMark')[0];
        assert.equal(move.key, 'TS-100');
        assert.equal(move.status, configModule.STATUSES.IN_TESTING);
        assert.equal(move.stage, 'IN_TESTING');

        var labels = taCalls(rec, 'removeLabel');
        assert.deepEqual(labels.map(function(c) { return c.key + ':' + c.label; }),
            ['TS-100:sm_trig', 'TS-100:ios_wip']);
    });

    test('build result as JSON string with build_slug fallback and results[0] fallbacks', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            bitriseTriggerBuild: function() {
                return JSON.stringify({ build_slug: 'slg', results: [{ build_url: 'http://r/0', build_number: 9 }] });
            }
        });
        var r = mod.action({ ticket: { key: 'TS-1' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, true);
        assert.equal(r.buildUrl, 'http://r/0');
        var comment = taCalls(rec, 'postComment')[0].comment;
        assert.contains(comment, '| Build | [Build #9|http://r/0] |');
    });

    test('build result slug-only fallback URL and default build label', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            bitriseTriggerBuild: function() { return { build_slug: 'slg2' }; }
        });
        var r = mod.action({ ticket: { key: 'TS-2' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.buildUrl, 'https://app.bitrise.io/build/slg2');
        assert.contains(taCalls(rec, 'postComment')[0].comment,
            '| Build | [View on Bitrise|https://app.bitrise.io/build/slg2] |');
    });

    test('unparseable build result still succeeds with empty buildUrl and no Build row', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            bitriseTriggerBuild: function() { return '{not json'; }
        });
        var r = mod.action({ ticket: { key: 'TS-3' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, true);
        assert.equal(r.buildUrl, '');
        var comment = taCalls(rec, 'postComment')[0].comment;
        assert.notContains(comment, '| Build |');
        assert.notContains(comment, '| Feature PR |');
    });

    test('missing appSlug: no bitrise calls, no comment, error return', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec });
        var r = mod.action({ ticket: { key: 'TS-4' }, jobParams: { customParams: {} } });
        assert.deepEqual(r, { success: false, error: 'Missing bitriseBuild.appSlug' });
        assert.equal(taCalls(rec, 'bitrise_trigger_build').length, 0);
        assert.equal(taCalls(rec, 'bitrise_list_builds').length, 0);
        assert.equal(taCalls(rec, 'createScm').length, 0);
        assert.equal(taCalls(rec, 'postComment').length, 0);
    });

    test('custom workflowId and branch override defaults', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec });
        var r = mod.action({
            ticket: { key: 'TS-5' },
            jobParams: { customParams: { bitriseBuild: { appSlug: 'a', workflowId: 'wf_x', branch: 'rel' } } }
        });
        assert.equal(r.workflowId, 'wf_x');
        assert.equal(taCalls(rec, 'bitrise_trigger_build')[0].args.workflowId, 'wf_x');
        assert.equal(taCalls(rec, 'bitrise_trigger_build')[0].args.branch, 'rel');
    });

    test('feature PR matched by title: url and number flow into env vars and comment', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            listPrs: function() {
                return [
                    { number: 11, title: 'unrelated work', head: { ref: 'feature/x' }, html_url: 'http://pr/11' },
                    { number: 12, title: 'TS-6 fix things', head: { ref: 'feature/y' }, html_url: 'http://pr/12' }
                ];
            }
        });
        var r = mod.action({
            ticket: { key: 'TS-6' },
            metadata: { contextId: 'cod' },
            jobParams: { customParams: { bitriseBuild: { appSlug: 'a' }, featurePR: { owner: 'o', repo: 'r' } } }
        });
        assert.equal(r.success, true);
        var trig = taCalls(rec, 'bitrise_trigger_build')[0].args;
        var env = JSON.parse(trig.envVars);
        assert.equal(env[2].value, 'http://pr/12');
        assert.equal(env[3].value, '12');
        assert.contains(taCalls(rec, 'postComment')[0].comment, '\n| Feature PR | http://pr/12 |');
    });

    test('feature PR matched by head branch ref when title does not match', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            listPrs: function() {
                return [{ number: 13, title: 'wip', head: { ref: 'ai/TS-7' }, url: 'http://pr/13-fallback' }];
            }
        });
        var r = mod.action({
            ticket: { key: 'TS-7' },
            jobParams: { customParams: { bitriseBuild: { appSlug: 'a' }, featurePR: { owner: 'o', repo: 'r' } } }
        });
        var trig = taCalls(rec, 'bitrise_trigger_build')[0].args;
        var env = JSON.parse(trig.envVars);
        assert.equal(env[2].value, 'http://pr/13-fallback');
        assert.equal(env[3].value, '13');
    });

    test('feature scm failure is non-fatal: build still triggers', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            listPrs: function() { throw new Error('scm down'); }
        });
        var r = mod.action({
            ticket: { key: 'TS-8' },
            jobParams: { customParams: { bitriseBuild: { appSlug: 'a' }, featurePR: { owner: 'o', repo: 'r' } } }
        });
        assert.equal(r.success, true);
        assert.equal(taCalls(rec, 'bitrise_trigger_build').length, 1);
    });

    test('in-flight builds with matching commit message are aborted per status, in order', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            bitriseListBuilds: function(args) {
                if (args.status === 'not_started') {
                    return { data: [
                        { slug: 'old1', build_number: 1, commit_message: 'fix TS-9 now' },
                        { slug: 'other', build_number: 2, commit_message: 'different ticket' },
                        { build_number: 3, commit_message: 'TS-9 again' }
                    ] };
                }
                return { data: [{ slug: 'old2', build_number: 5, commit_message: 'TS-9 retry' }] };
            }
        });
        var r = mod.action({ ticket: { key: 'TS-9' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, true);
        var aborts = taCalls(rec, 'bitrise_abort_build');
        assert.deepEqual(aborts.map(function(c) { return c.args; }), [
            { appSlug: 'a', buildSlug: 'old1', reason: 'Superseded by newer trigger for TS-9' },
            { appSlug: 'a', buildSlug: 'old2', reason: 'Superseded by newer trigger for TS-9' }
        ]);
        // interleaved: list(not_started), abort(old1), list(in_progress), abort(old2)
        assert.deepEqual(rec.calls.map(function(c) { return c.op; }).slice(3, 7),
            ['bitrise_list_builds', 'bitrise_abort_build', 'bitrise_list_builds', 'bitrise_abort_build']);
    });

    test('dedup list failure for one status does not stop the other status or the trigger', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            bitriseListBuilds: function(args) {
                if (args.status === 'not_started') throw new Error('list boom');
                return { data: [{ slug: 'keep', build_number: 2, commit_message: 'TS-10' }] };
            }
        });
        var r = mod.action({ ticket: { key: 'TS-10' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, true);
        var aborts = taCalls(rec, 'bitrise_abort_build');
        assert.equal(aborts.length, 1);
        assert.equal(aborts[0].args.buildSlug, 'keep');
        assert.equal(taCalls(rec, 'bitrise_trigger_build').length, 1);
    });

    test('builds array returned bare (not under data) is also deduped', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            bitriseListBuilds: function() {
                return [{ slug: 'bare1', build_number: 7, commit_message: 'TS-11 x' }];
            }
        });
        mod.action({ ticket: { key: 'TS-11' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        var aborts = taCalls(rec, 'bitrise_abort_build');
        assert.deepEqual(aborts.map(function(c) { return c.args.buildSlug; }), ['bare1', 'bare1']);
    });

    test('trigger failure: posts failure comment and returns error', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            bitriseTriggerBuild: function() { throw new Error('bitrise down'); }
        });
        var r = mod.action({ ticket: { key: 'TS-12' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.deepEqual(r, { success: false, error: 'Failed to trigger Bitrise: Error: bitrise down' });
        var comment = taCalls(rec, 'postComment')[0];
        assert.equal(comment.key, 'TS-12');
        assert.contains(comment.comment, 'h3. ❌ Test Automation Trigger Failed');
        assert.contains(comment.comment, 'Could not trigger Bitrise workflow *ai_teammate_test_automation*');
        assert.contains(comment.comment, '{code}bitrise down{code}');
        assert.equal(taCalls(rec, 'moveToStatusOrMark').length, 0);
    });

    test('trigger failure with failing comment post still returns the trigger error', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            bitriseTriggerBuild: function() { throw new Error('boom'); },
            trackerApi: { postComment: function() { throw new Error('comment endpoint down'); } }
        });
        var r = mod.action({ ticket: { key: 'TS-13' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, false);
        assert.contains(r.error, 'Failed to trigger Bitrise');
        assert.equal(taCalls(rec, 'postComment').length, 1);
    });

    test('comment post failure and status-move failure are non-fatal', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            trackerApi: { postComment: function() { throw new Error('no comments today'); } }
        });
        var r = mod.action({ ticket: { key: 'TS-14' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, true);
        assert.equal(taCalls(rec, 'moveToStatusOrMark').length, 1);
        assert.equal(taCalls(rec, 'removeLabel').length, 1); // contextId absent → default wip label only
    });

    test('no removeLabel customParam: only the wip label is removed', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec });
        mod.action({ ticket: { key: 'TS-15' }, metadata: { contextId: 'bug' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.deepEqual(taCalls(rec, 'removeLabel').map(function(c) { return c.label; }), ['bug_wip']);
    });

    test('default wip label when metadata has no contextId', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec });
        mod.action({ ticket: { key: 'TS-16' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' }, removeLabel: 'sm_x' } } });
        assert.deepEqual(taCalls(rec, 'removeLabel').map(function(c) { return c.label; }), ['sm_x', 'test_automation_wip']);
    });

    test('JSRunner mode: inputJql with key fetches the ticket and rebuilds params', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            trackerApi: { getIssue: function(key) { return { key: key, fields: { summary: 'fetched sum' } }; } }
        });
        var r = mod.action({
            inputJql: 'key = TS-17 AND status = Open',
            jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } }
        });
        assert.equal(r.success, true);
        assert.equal(taCalls(rec, 'getIssue')[0].key, 'TS-17');
        // comment landed on the fetched ticket and env vars carry its key
        assert.equal(taCalls(rec, 'postComment')[0].key, 'TS-17');
        var env = JSON.parse(taCalls(rec, 'bitrise_trigger_build')[0].args.envVars);
        assert.equal(env[0].value, 'TS-17');
        assert.equal(env[1].value, 'key = TS-17');
    });

    test('JSRunner mode: lowercase key in jql is uppercased before fetch', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            trackerApi: { getIssue: function(key) { return { key: key, fields: {} }; } }
        });
        var r = mod.action({ inputJql: 'key = ts-18', jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, true);
        assert.equal(taCalls(rec, 'getIssue')[0].key, 'TS-18');
    });

    test('JSRunner mode: fetched ticket without key → error, no config load, no trigger', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec, trackerApi: { getIssue: function() { return { fields: {} }; } } });
        var r = mod.action({ inputJql: 'key = TS-19', jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.deepEqual(r, { success: false, error: 'Could not fetch ticket: TS-19' });
        assert.equal(taCalls(rec, 'loadProjectConfig').length, 0);
        assert.equal(taCalls(rec, 'bitrise_trigger_build').length, 0);
    });

    test('JSRunner mode: getIssue throws → error return', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            trackerApi: { getIssue: function() { throw new Error('api 500'); } }
        });
        var r = mod.action({ inputJql: 'key = TS-20', jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.deepEqual(r, { success: false, error: 'Failed to fetch ticket TS-20: Error: api 500' });
    });

    test('JSRunner mode: jql without key falls back to searchIssues', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            trackerApi: { searchIssues: function() {
                return JSON.stringify({ issues: [{ key: 'TS-21', fields: { summary: 'found' } }] });
            } }
        });
        var r = mod.action({ inputJql: 'labels = sm_trig', jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, true);
        var search = taCalls(rec, 'searchIssues')[0];
        assert.equal(search.jql, 'labels = sm_trig');
        assert.deepEqual(search.opts, { maxResults: 1 });
        assert.equal(taCalls(rec, 'postComment')[0].key, 'TS-21');
    });

    test('JSRunner mode: search returning no issues → error', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec });
        var r = mod.action({ inputJql: 'labels = nothing', jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.deepEqual(r, { success: false, error: 'No tickets found for JQL: labels = nothing' });
    });

    test('JSRunner mode: search throwing → error', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            trackerApi: { searchIssues: function() { throw new Error('jql bad'); } }
        });
        var r = mod.action({ inputJql: 'garbage jql', jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.deepEqual(r, { success: false, error: 'jira_search_by_jql failed: Error: jql bad' });
    });

    test('missing ticket.key does not throw: flow continues with undefined key', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec });
        var r = mod.action({ ticket: { fields: {} }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, true);
        assert.equal(r.message, 'Bitrise test automation triggered for undefined');
        assert.equal(taCalls(rec, 'bitrise_trigger_build')[0].args.commitMessage,
            'undefined — AI test automation triggered by GitHub');
    });

    test('project config load throwing: outer catch posts proxy-error comment and returns error', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({
            rec: rec,
            loadProjectConfigThrows: new Error('config unreadable')
        });
        var r = mod.action({ ticket: { key: 'TS-24' }, jobParams: { customParams: { bitriseBuild: { appSlug: 'a' } } } });
        assert.equal(r.success, false);
        assert.contains(r.error, 'Error: config unreadable');
        var comment = taCalls(rec, 'postComment')[0];
        assert.equal(comment.key, 'TS-24');
        assert.contains(comment.comment, 'h3. ❌ Test Automation Proxy Error');
        assert.contains(comment.comment, '{code}Error: config unreadable{code}');
    });

    test('jobParams without customParams: jobParams itself acts as customParams', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec });
        var r = mod.action({ ticket: { key: 'TS-22' }, jobParams: { bitriseBuild: { appSlug: 'flat' } } });
        assert.equal(r.success, true);
        assert.equal(taCalls(rec, 'bitrise_trigger_build')[0].args.appSlug, 'flat');
    });

    test('featurePR owner set but repo empty: scm is never created', function() {
        var rec = makeTaRecorder();
        var mod = loadTaModule({ rec: rec });
        var r = mod.action({
            ticket: { key: 'TS-23' },
            jobParams: { customParams: { bitriseBuild: { appSlug: 'a' }, featurePR: { owner: 'o' } } }
        });
        assert.equal(r.success, true);
        assert.equal(taCalls(rec, 'createScm').length, 0);
    });
});

suite('triggerBitriseTestAutomation — extracted helpers', function() {

    test('resolveInitialTrackerCustomParams tier order', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.deepEqual(mod.resolveInitialTrackerCustomParams(
            { jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } }), { a: 1 });
        assert.deepEqual(mod.resolveInitialTrackerCustomParams(
            { jobParams: { inputJql: 'x' }, customParams: { b: 2 } }), { inputJql: 'x' });
        assert.deepEqual(mod.resolveInitialTrackerCustomParams(
            { customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(mod.resolveInitialTrackerCustomParams({}), {});
    });

    test('resolveJql precedence: params.inputJql beats jobParams', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.equal(mod.resolveJql({ inputJql: 'a', jobParams: { inputJql: 'b' } }), 'a');
        assert.equal(mod.resolveJql({ jobParams: { inputJql: 'b' } }), 'b');
        assert.equal(mod.resolveJql({}), '');
    });

    test('parseJqlTicketKey extracts and uppercases, or empty string', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.equal(mod.parseJqlTicketKey('key = ts-42 AND x'), 'TS-42');
        assert.equal(mod.parseJqlTicketKey('labels = nokey'), '');
    });

    test('parseIssueList: string/object with issues, bare array, junk, null', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.deepEqual(mod.parseIssueList('{"issues":[{"key":"A"}]}'), [{ key: 'A' }]);
        assert.deepEqual(mod.parseIssueList({ issues: [{ key: 'B' }] }), [{ key: 'B' }]);
        assert.deepEqual(mod.parseIssueList([{ key: 'C' }]), [{ key: 'C' }]);
        assert.deepEqual(mod.parseIssueList(null), []);
        assert.throws(function() { mod.parseIssueList('{bad json'); });
    });

    test('fetchTicketByKey: found, keyless, throwing tracker', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.deepEqual(mod.fetchTicketByKey({ getIssue: function() { return { key: 'K1' }; } }, 'K1'),
            { ticket: { key: 'K1' } });
        assert.deepEqual(mod.fetchTicketByKey({ getIssue: function() { return {}; } }, 'K2'),
            { error: 'Could not fetch ticket: K2' });
        assert.deepEqual(mod.fetchTicketByKey({ getIssue: function() { throw new Error('x'); } }, 'K3'),
            { error: 'Failed to fetch ticket K3: Error: x' });
    });

    test('searchFirstTicket: found, empty, junk payload', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.deepEqual(
            mod.searchFirstTicket({ searchIssues: function() { return [{ key: 'S1' }]; } }, 'j'),
            { ticket: { key: 'S1' } });
        assert.deepEqual(
            mod.searchFirstTicket({ searchIssues: function() { return []; } }, 'j'),
            { error: 'No tickets found for JQL: j' });
        var junk = mod.searchFirstTicket({ searchIssues: function() { return '{oops'; } }, 'j');
        assert.contains(junk.error, 'jira_search_by_jql failed: SyntaxError');
    });

    test('resolveTicketParams: passthrough, by key, errors, by search', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        var withTicket = { ticket: { key: 'T' }, jobParams: { j: 1 } };
        assert.equal(mod.resolveTicketParams(withTicket, null).params, withTicket);
        var byKey = mod.resolveTicketParams({ inputJql: 'key = X-1', jobParams: { j: 1 } },
            { getIssue: function() { return { key: 'X-1' }; } });
        assert.deepEqual(byKey.params, { ticket: { key: 'X-1' }, jobParams: { j: 1 } });
        assert.deepEqual(
            mod.resolveTicketParams({ inputJql: 'key = X-2' }, { getIssue: function() { return null; } }),
            { error: 'Could not fetch ticket: X-2' });
        var bySearch = mod.resolveTicketParams({ inputJql: 'label = y' },
            { searchIssues: function() { return [{ key: 'X-3' }]; } });
        assert.deepEqual(bySearch.params.ticket, { key: 'X-3' });
        assert.deepEqual(
            mod.resolveTicketParams({ inputJql: 'label = z' }, { searchIssues: function() { return []; } }),
            { error: 'No tickets found for JQL: label = z' });
    });

    test('pickActualParams and resolveCustomParams tier order', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        var p = { ticket: { key: 'T' }, jobParams: {} };
        assert.equal(mod.pickActualParams(p), p);
        assert.equal(mod.pickActualParams({ jobParams: { a: 1 } }).a, 1);
        assert.equal(mod.pickActualParams({ b: 2 }).b, 2);
        assert.deepEqual(mod.resolveCustomParams(
            { jobParams: { customParams: { a: 1 } } }, {}), { a: 1 });
        assert.deepEqual(mod.resolveCustomParams(
            { jobParams: { flat: true } }, { customParams: { c: 3 } }), { flat: true });
        assert.deepEqual(mod.resolveCustomParams(
            {}, { customParams: { c: 3 } }), { c: 3 });
        assert.deepEqual(mod.resolveCustomParams({}, {}), {});
    });

    test('resolveTicketSummary falls back to key', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.equal(mod.resolveTicketSummary({ ticket: { key: 'K', fields: { summary: 'S' } } }), 'S');
        assert.equal(mod.resolveTicketSummary({ ticket: { key: 'K', fields: {} } }), 'K');
        assert.equal(mod.resolveTicketSummary({ ticket: { key: 'K' } }), 'K');
    });

    test('resolveBitriseConfig defaults', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.deepEqual(mod.resolveBitriseConfig({ bitriseBuild: { appSlug: 'a', workflowId: 'w', branch: 'b' } }),
            { appSlug: 'a', workflowId: 'w', branch: 'b' });
        assert.deepEqual(mod.resolveBitriseConfig({}),
            { appSlug: undefined, workflowId: 'ai_teammate_test_automation', branch: 'main' });
    });

    test('pr matching helpers', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.equal(mod.prHeadRef({ head: { ref: 'r' } }), 'r');
        assert.equal(mod.prHeadRef({}), '');
        assert.equal(mod.prViewUrl({ html_url: 'h', url: 'u' }), 'h');
        assert.equal(mod.prViewUrl({ url: 'u' }), 'u');
        assert.equal(mod.prViewUrl({}), '');
        assert.equal(mod.prMatchesTicket({ title: 'fix TS-1' }, 'TS-1'), true);
        assert.equal(mod.prMatchesTicket({ head: { ref: 'ai/TS-1' } }, 'TS-1'), true);
        assert.equal(mod.prMatchesTicket({ title: 'x', head: { ref: 'y' } }, 'TS-1'), false);
    });

    test('findFeaturePr scans past non-matching PRs and tolerates null list', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        var prs = [
            { number: 1, title: 'nope', head: { ref: 'x' }, html_url: 'h1' },
            { number: 2, title: 'TS-9 yes', head: { ref: 'y' }, url: 'h2' }
        ];
        assert.deepEqual(mod.findFeaturePr(prs, 'TS-9'), { url: 'h2', number: '2' });
        assert.deepEqual(mod.findFeaturePr(prs, 'TS-99'), { url: '', number: '' });
        assert.deepEqual(mod.findFeaturePr(null, 'TS-9'), { url: '', number: '' });
    });

    test('resolveFeaturePrConfig partial config', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.deepEqual(mod.resolveFeaturePrConfig({ featurePR: { owner: 'o', repo: 'r' } }), { owner: 'o', repo: 'r' });
        assert.deepEqual(mod.resolveFeaturePrConfig({ featurePR: { owner: 'o' } }), { owner: 'o', repo: '' });
        assert.deepEqual(mod.resolveFeaturePrConfig({}), { owner: '', repo: '' });
    });

    test('parseBuildList mirrors bitrise payload shapes', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.deepEqual(mod.parseBuildList('{"data":[{"slug":"s"}]}'), [{ slug: 's' }]);
        assert.deepEqual(mod.parseBuildList({ data: [{ slug: 's' }] }), [{ slug: 's' }]);
        assert.deepEqual(mod.parseBuildList([{ slug: 's' }]), [{ slug: 's' }]);
        assert.deepEqual(mod.parseBuildList(null), []);
        assert.throws(function() { mod.parseBuildList('{bad'); });
    });

    test('matchesTicketBuild requires commit message match AND slug', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.equal(mod.matchesTicketBuild({ commit_message: 'x TS-1 y', slug: 's' }, 'TS-1'), true);
        assert.equal(mod.matchesTicketBuild({ commit_message: 'x TS-1 y' }, 'TS-1'), false);
        assert.equal(mod.matchesTicketBuild({ commit_message: 'nope', slug: 's' }, 'TS-1'), false);
        assert.equal(mod.matchesTicketBuild({}, 'TS-1'), false);
    });

    test('abortOneBuild and abortBuildsForTicket count successes only', function() {
        var mod = loadTaModule({
            rec: makeTaRecorder(),
            bitriseAbortBuild: function() { throw new Error('nope'); }
        });
        assert.equal(mod.abortOneBuild('app', { slug: 's' }, 'TS-1'), false);
        assert.deepEqual(mod.abortBuildsForTicket('app', [
            { commit_message: 'TS-1 a', slug: 's1' },
            { commit_message: 'TS-1 b' }
        ], 'TS-1'), 0);

        var ok = loadTaModule({ rec: makeTaRecorder() });
        assert.equal(ok.abortBuildsForTicket('app', [
            { commit_message: 'TS-1 a', slug: 's1', build_number: 1 },
            { commit_message: 'other', slug: 's2' },
            { commit_message: 'TS-1 b', slug: 's3', build_number: 3 }
        ], 'TS-1'), 2);
    });

    test('abortInFlightBuilds survives unparseable list payloads', function() {
        var mod = loadTaModule({
            rec: makeTaRecorder(),
            bitriseListBuilds: function() { return '{bad'; }
        });
        assert.equal(mod.abortInFlightBuilds({ appSlug: 'a', workflowId: 'w', branch: 'b' }, 'TS-1'), 0);
    });

    test('buildTriggerEnvVars matrix', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.deepEqual(mod.buildTriggerEnvVars('TS-1', { url: 'u', number: '2', owner: 'o', repo: 'r' }), [
            { mapped_to: 'TICKET_KEY', value: 'TS-1', is_expand: false },
            { mapped_to: 'INPUT_JQL', value: 'key = TS-1', is_expand: false },
            { mapped_to: 'FEATURE_PR_URL', value: 'u', is_expand: false },
            { mapped_to: 'FEATURE_PR_NUMBER', value: '2', is_expand: false },
            { mapped_to: 'FEATURE_REPO', value: 'o/r', is_expand: false }
        ]);
    });

    test('resolveBuildUrl / resolveBuildNumber priority chain', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.equal(mod.resolveBuildUrl({ build_url: 'a' }, null), 'a');
        assert.equal(mod.resolveBuildUrl({}, { build_url: 'b' }), 'b');
        assert.equal(mod.resolveBuildUrl({ build_slug: 's' }, null), 'https://app.bitrise.io/build/s');
        assert.equal(mod.resolveBuildUrl({}, null), '');
        assert.equal(mod.resolveBuildNumber({ build_number: 1 }, null), '1');
        assert.equal(mod.resolveBuildNumber({}, { build_number: 2 }), '2');
        assert.equal(mod.resolveBuildNumber({}, null), '');
    });

    test('moveToInTesting tolerates no-move results and tracker errors', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        mod.moveToInTesting({ moveToStatusOrMark: function() { return { moved: true, marked: false }; } }, 'K', { IN_TESTING: 'S' });
        mod.moveToInTesting({ moveToStatusOrMark: function() { return { moved: false, marked: true }; } }, 'K', { IN_TESTING: 'S' });
        mod.moveToInTesting({ moveToStatusOrMark: function() { return { moved: false, marked: false }; } }, 'K', { IN_TESTING: 'S' });
        mod.moveToInTesting({ moveToStatusOrMark: function() { throw new Error('nope'); } }, 'K', { IN_TESTING: 'S' });
    });

    test('safeRemoveLabel announce flag, empty label, silent failure', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        var removed = [];
        var okTracker = { removeLabel: function(key, label) { removed.push(key + ':' + label); } };
        mod.safeRemoveLabel(okTracker, 'K', '', true);
        mod.safeRemoveLabel(okTracker, 'K', 'L', true);
        mod.safeRemoveLabel(okTracker, 'K', 'L2', false);
        var failTracker = { removeLabel: function() { throw new Error('x'); } };
        mod.safeRemoveLabel(failTracker, 'K', 'L', true);
        assert.deepEqual(removed, ['K:L', 'K:L2']);
    });

    test('resolveWipLabel from contextId with default fallback', function() {
        var mod = loadTaModule({ rec: makeTaRecorder() });
        assert.equal(mod.resolveWipLabel({ metadata: { contextId: 'ios' } }), 'ios_wip');
        assert.equal(mod.resolveWipLabel({ metadata: {} }), 'test_automation_wip');
        assert.equal(mod.resolveWipLabel({}), 'test_automation_wip');
    });

    test('reportFatalError posts only when ticket key exists, survives tracker absence', function() {
        var posted = [];
        var tracker = { postComment: function(key, comment) { posted.push({ key: key, comment: comment }); } };
        var mod = loadTaModule({ rec: makeTaRecorder() });
        mod.reportFatalError(tracker, { ticket: { key: 'K' } }, new Error('e1'));
        assert.equal(posted[0].key, 'K');
        assert.contains(posted[0].comment, '{code}Error: e1{code}');
        mod.reportFatalError(tracker, {}, new Error('e2'));
        mod.reportFatalError(undefined, { ticket: { key: 'K' } }, new Error('e3'));
        assert.equal(posted.length, 1);
    });
});
