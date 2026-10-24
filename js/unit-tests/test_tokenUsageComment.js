/**
 * Unit tests for js/common/tokenUsageComment.js.
 */

function loadTokenUsageComment(mocks) {
    return loadModule('js/common/tokenUsageComment.js', makeRequire({
        './trackers.js': loadModule('js/common/trackers.js', makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }), mocks || {})
    }), mocks || {});
}

suite('tokenUsageComment', function() {
    test('findUsageFiles reads manifest and filters *_usage.json entries', function() {
        var mod = loadTokenUsageComment({
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') {
                    return JSON.stringify([
                        'outputs/story_solution_usage.json',
                        'outputs/other_report.json',
                        'outputs/kimi_usage.json'
                    ]);
                }
                return null;
            }
        });

        var files = mod.findUsageFiles('outputs');
        assert.equal(files.length, 2);
        assert.equal(files[0], 'outputs/story_solution_usage.json');
        assert.equal(files[1], 'outputs/kimi_usage.json');
    });

    test('findUsageFiles returns empty array when manifest is missing', function() {
        var mod = loadTokenUsageComment({
            file_read: function() { return null; }
        });

        var files = mod.findUsageFiles('outputs');
        assert.deepEqual(files, []);
    });

    test('formatUsageComment strips _usage suffix and includes initiator mention', function() {
        var mod = loadTokenUsageComment({});
        var comment = mod.formatUsageComment('outputs/story_solution_usage.json', { total_tokens: 42 }, 'user-123');
        assert.contains(comment, '[story_solution]: {"total_tokens":42}');
        assert.contains(comment, 'Initiator: [~accountid:user-123]');
    });

    test('formatUsageComment keeps raw id when it already contains ~', function() {
        var mod = loadTokenUsageComment({});
        var comment = mod.formatUsageComment('outputs/kimi_usage.json', { total_tokens: 1 }, '~accountid:abc');
        assert.contains(comment, 'Initiator: [~accountid:abc]');
    });

    // Regression test for IstiN/dmtools-agents#360: a comment that starts with
    // "[label]" and ends with "[~accountid:...]" is exactly the shape the
    // DMTools GraalJS bridge mis-parses as a JSON array, silently truncating
    // the whole comment. The trailing-period guard must break that shape.
    test('formatUsageComment appends a guard period when the comment would end with the mention bracket', function() {
        var mod = loadTokenUsageComment({});
        var comment = mod.formatUsageComment('outputs/claude-code_usage.json', { provider: 'claude-code' }, '712020:d28c649e-58fe-40e2-8d4f-ca1def1444a7');
        assert.ok(comment.charAt(0) === '[', 'comment should still start with the [label] prefix');
        assert.notOk(comment.charAt(comment.length - 1) === ']', 'comment must not end with "]" (would trigger the bridge bug)');
        assert.ok(comment.charAt(comment.length - 1) === '.', 'comment should end with the guard period');
        assert.contains(comment, 'Initiator: [~accountid:712020:d28c649e-58fe-40e2-8d4f-ca1def1444a7]');
    });

    test('formatUsageComment does not add a guard period when there is no initiator mention', function() {
        var mod = loadTokenUsageComment({});
        var comment = mod.formatUsageComment('outputs/claude-code_usage.json', { provider: 'claude-code' });
        assert.notContains(comment, 'Initiator:');
        assert.ok(comment.charAt(comment.length - 1) === '}', 'comment should end with the JSON payload unchanged');
    });

    test('avoidBridgeArrayMisparse appends a period only when the string starts with [ and ends with ]', function() {
        var mod = loadTokenUsageComment({});
        assert.equal(mod.avoidBridgeArrayMisparse('[claude-code]: {"a":1}\nInitiator: [~accountid:1]'), '[claude-code]: {"a":1}\nInitiator: [~accountid:1].');
        assert.equal(mod.avoidBridgeArrayMisparse('[claude-code]: {"a":1}'), '[claude-code]: {"a":1}');
        assert.equal(mod.avoidBridgeArrayMisparse('plain text'), 'plain text');
        assert.equal(mod.avoidBridgeArrayMisparse('[]'), '[]');
    });

    test('postTokenUsageComments posts a Jira comment for each usage file', function() {
        var posted = [];
        var mod = loadTokenUsageComment({
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') {
                    return JSON.stringify(['outputs/story_solution_usage.json']);
                }
                if (opts.path === 'outputs/story_solution_usage.json') {
                    return JSON.stringify({ provider: 'kimi', total_tokens: 123 });
                }
                return null;
            },
            jira_post_comment: function(args) {
                posted.push(args);
            }
        });

        var result = mod.postTokenUsageComments('TS-576', { initiator: 'user-123' });
        assert.equal(result.posted, 1);
        assert.equal(result.files.length, 1);
        assert.equal(posted.length, 1);
        assert.equal(posted[0].key, 'TS-576');
        assert.contains(posted[0].comment, '[story_solution]:');
        assert.contains(posted[0].comment, '"provider":"kimi"');
        assert.contains(posted[0].comment, 'Initiator:');
    });

    test('postTokenUsageComments skips unreadable files and reports errors', function() {
        var mod = loadTokenUsageComment({
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') {
                    return JSON.stringify(['outputs/bad_usage.json']);
                }
                return null;
            }
        });

        var result = mod.postTokenUsageComments('TS-1');
        assert.equal(result.posted, 0);
        assert.equal(result.errors.length, 1);
        assert.contains(result.errors[0], 'outputs/bad_usage.json');
    });
});

suite('tokenUsageComment — posts through the active tracker (agents#854)', function() {
    function usageMocks(extra) {
        var m = {
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') return JSON.stringify(['outputs/a_usage.json']);
                if (opts.path === 'outputs/a_usage.json') return JSON.stringify({ provider: 'copilot', total_tokens: 5 });
                return null;
            }
        };
        Object.keys(extra || {}).forEach(function(k) { m[k] = extra[k]; });
        return m;
    }

    test('customParams.trackerProvider=ado: the comment goes through the ADO tool, never jira_post_comment', function() {
        var ado = [], jira = [];
        var mod = loadTokenUsageComment(usageMocks({
            ado_add_work_item_comment: function(a) { ado.push(a); },
            jira_post_comment: function(a) { jira.push(a); }
        }));
        var r = mod.postTokenUsageComments('1839749', { customParams: { trackerProvider: 'ado' } });
        assert.equal(r.posted, 1, JSON.stringify(r));
        assert.equal(ado.length, 1);
        assert.equal(jira.length, 0, 'a Jira-only tool must not be called on an ADO run');
    });

    test('a tracker passed in explicitly is used as is (existing callers unchanged)', function() {
        var calls = [];
        var mod = loadTokenUsageComment(usageMocks());
        var r = mod.postTokenUsageComments('T-1', { tracker: { postComment: function(k, c) { calls.push([k, c]); } } });
        assert.equal(r.posted, 1);
        assert.equal(calls[0][0], 'T-1');
    });

    test('no context at all still posts through Jira (backward compatible default)', function() {
        var jira = [];
        var mod = loadTokenUsageComment(usageMocks({ jira_post_comment: function(a) { jira.push(a); } }));
        var r = mod.postTokenUsageComments('TS-9');
        assert.equal(r.posted, 1);
        assert.equal(jira.length, 1);
    });

    test('config.tracker.provider is honoured when passed as options.config', function() {
        var ado = [];
        var mod = loadTokenUsageComment(usageMocks({ ado_add_work_item_comment: function(a) { ado.push(a); } }));
        var r = mod.postTokenUsageComments('42', { config: { tracker: { provider: 'ado' } } });
        assert.equal(r.posted, 1, JSON.stringify(r));
        assert.equal(ado.length, 1);
    });
});

suite('tokenUsageComment.customParamsOf (agents#854)', function() {
    var mod = loadTokenUsageComment({ file_read: function() { return null; } });

    test('reads jobParams.customParams first, then params.customParams', function() {
        assert.equal(mod.customParamsOf({ jobParams: { customParams: { trackerProvider: 'ado' } } }).trackerProvider, 'ado');
        assert.equal(mod.customParamsOf({ customParams: { trackerProvider: 'github' } }).trackerProvider, 'github');
        assert.equal(mod.customParamsOf({
            jobParams: { customParams: { trackerProvider: 'ado' } },
            customParams: { trackerProvider: 'github' }
        }).trackerProvider, 'ado');
    });

    test('returns an empty object for missing/odd input — never throws', function() {
        assert.deepEqual(mod.customParamsOf(null), {});
        assert.deepEqual(mod.customParamsOf(undefined), {});
        assert.deepEqual(mod.customParamsOf({}), {});
        assert.deepEqual(mod.customParamsOf({ jobParams: {} }), {});
    });

    test('end to end: ADO params flow through customParamsOf into the ADO comment tool', function() {
        var ado = [], jira = [];
        var m = loadTokenUsageComment({
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') return JSON.stringify(['outputs/a_usage.json']);
                if (opts.path === 'outputs/a_usage.json') return JSON.stringify({ provider: 'copilot' });
                return null;
            },
            ado_add_work_item_comment: function(a) { ado.push(a); },
            jira_post_comment: function(a) { jira.push(a); }
        });
        var params = { jobParams: { customParams: { trackerProvider: 'ado' } } };
        var r = m.postTokenUsageComments('1839749', { initiator: 'u', customParams: m.customParamsOf(params) });
        assert.equal(r.posted, 1, JSON.stringify(r));
        assert.equal(ado.length, 1);
        assert.equal(jira.length, 0);
    });
});

suite('tokenUsageComment call sites pass the job context (agents#854)', function() {
    function jsFiles() {
        var entries = file_list('js');
        if (typeof entries === 'string') entries = JSON.parse(entries);
        return ((entries && entries.entries) || [])
            .map(String)
            .filter(function(e) { return e.slice(-3) === '.js'; })
            .map(function(e) { return 'js/' + e.substring(e.lastIndexOf('/') + 1); });
    }

    test('every action call passes a tracker or customParams, so ADO/GitHub runs never fall back to Jira', function() {
        var offenders = [];
        var seen = 0;
        jsFiles().forEach(function(path) {
            var src = file_read({ path: path });
            if (!src) return;
            var re = /tokenUsageComment\.postTokenUsageComments\(([^;]*?)\);/g;
            var m;
            while ((m = re.exec(src)) !== null) {
                seen++;
                if (m[1].indexOf('tracker') === -1 && m[1].indexOf('customParams') === -1) {
                    offenders.push(path + ': ' + m[0].substring(0, 100));
                }
            }
        });
        assert.ok(seen > 20, 'expected many call sites, saw ' + seen);
        assert.deepEqual(offenders, [], 'call sites without tracker/customParams:\n' + offenders.join('\n'));
    });
});

suite('tokenUsageComment — Azure DevOps rendering (agents#877, #878)', function() {
    var mod = loadTokenUsageComment({ file_read: function() { return null; } });
    var DATA = { total_tokens: 42, provider: 'copilot' };

    test('ADO: a bold label and a fenced json block, never the "[label]: {json}" link-reference form', function() {
        var c = mod.formatUsageComment('outputs/story_description_usage.json', DATA, undefined, 'ado');
        assert.equal(c, '**story_description**\n```json\n{"total_tokens":42,"provider":"copilot"}\n```');
        assert.equal(c.indexOf('[story_description]:'), -1, 'the unrendered link-reference definition is gone');
    });

    test('ADO: the initiator is plain text, not Jira mention markup', function() {
        var c = mod.formatUsageComment('outputs/x_usage.json', DATA, 'y.b@x.com', 'ado');
        assert.contains(c, '\nInitiator: y.b@x.com');
        assert.equal(c.indexOf('[~accountid'), -1);
        assert.ok(!/\.$/.test(c), 'no bridge-workaround trailing dot after the plain initiator');
    });

    test('ADO: an already formatted Jira mention is reduced to the plain id', function() {
        assert.contains(mod.formatUsageComment('outputs/x_usage.json', DATA, '[~accountid:abc]', 'ado'), 'Initiator: abc');
        assert.contains(mod.formatUsageComment('outputs/x_usage.json', DATA, '~accountid:abc', 'ado'), 'Initiator: ~accountid:abc');
    });

    test('ADO provider name is case-insensitive', function() {
        assert.contains(mod.formatUsageComment('outputs/x_usage.json', DATA, undefined, 'ADO'), '```json');
    });

    test('Jira, GitHub and no provider keep the exact previous format', function() {
        ['jira', 'github', undefined, null, ''].forEach(function(p) {
            var c = mod.formatUsageComment('outputs/story_solution_usage.json', { total_tokens: 42 }, 'user-123', p);
            // the trailing '.' is the pre-existing GraalJS-bridge guard (a comment ending in ']' is mis-parsed
            // as an array) — Jira keeps it exactly as before
            assert.equal(c, '[story_solution]: {"total_tokens":42}\nInitiator: [~accountid:user-123].', 'provider=' + p);
        });
    });

    test('end to end on an ADO run: the comment posted through the ADO tool is the fenced block', function() {
        var posted = [];
        var m = loadTokenUsageComment({
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') return JSON.stringify(['outputs/a_usage.json']);
                if (opts.path === 'outputs/a_usage.json') return JSON.stringify({ provider: 'copilot', total_tokens: 5 });
                return null;
            },
            ado_add_work_item_comment: function(a) { posted.push(a); },
            jira_post_comment: function() { throw new Error('jira_post_comment must not be called on an ADO run'); }
        });
        var r = m.postTokenUsageComments('2039670', { initiator: 'y.b@x.com', customParams: { trackerProvider: 'ado' } });
        assert.equal(r.posted, 1, JSON.stringify(r));
        assert.equal(posted.length, 1);
        assert.contains(posted[0].comment, '**a**\n```json\n');
        assert.contains(posted[0].comment, 'Initiator: y.b@x.com');
        assert.equal(posted[0].comment.indexOf('[a]:'), -1);
    });

    test('end to end on Jira: still the "[label]: {json}" comment with the mention', function() {
        var posted = [];
        var m = loadTokenUsageComment({
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') return JSON.stringify(['outputs/a_usage.json']);
                if (opts.path === 'outputs/a_usage.json') return JSON.stringify({ total_tokens: 5 });
                return null;
            },
            jira_post_comment: function(a) { posted.push(a); }
        });
        m.postTokenUsageComments('PS-1', { initiator: 'user-1' });
        assert.contains(posted[0].comment, '[a]: {"total_tokens":5}');
        assert.contains(posted[0].comment, 'Initiator: [~accountid:user-1]');
    });
});


suite('tokenUsageComment — provider from the project config (agents#942)', function() {
    function load(loader, mocks) {
        return loadModule('js/common/tokenUsageComment.js', makeRequire({
            './trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), mocks),
            '../configLoader.js': loader
        }), mocks);
    }
    function mocks(extra) {
        var m = {
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') return JSON.stringify(['outputs/a_usage.json']);
                if (opts.path === 'outputs/a_usage.json') return JSON.stringify({ provider: 'copilot', total_tokens: 5 });
                return null;
            }
        };
        Object.keys(extra).forEach(function(k) { m[k] = extra[k]; });
        return m;
    }

    test('config.tracker.provider=ado with no trackerProvider: posts through ADO, not jira_post_comment', function() {
        var ado = [], jira = [];
        var mod = load({ loadProjectConfig: function() { return { tracker: { provider: 'ado' } }; } },
            mocks({ ado_add_work_item_comment: function(a) { ado.push(a); }, jira_post_comment: function(a) { jira.push(a); } }));
        var r = mod.postTokenUsageComments('2010283', { customParams: {} });
        assert.equal(r.posted, 1, JSON.stringify(r));
        assert.equal(ado.length, 1);
        assert.equal(jira.length, 0);
    });

    test('customParams.trackerProvider wins and the project config is not consulted', function() {
        var loaded = 0, ado = [];
        var mod = load({ loadProjectConfig: function() { loaded++; return { tracker: { provider: 'jira' } }; } },
            mocks({ ado_add_work_item_comment: function(a) { ado.push(a); } }));
        var r = mod.postTokenUsageComments('1', { customParams: { trackerProvider: 'ado' } });
        assert.equal(r.posted, 1, JSON.stringify(r));
        assert.equal(loaded, 0);
        assert.equal(ado.length, 1);
    });

    test('a throwing config loader falls back to the Jira default (fail-open, as before)', function() {
        var jira = [];
        var mod = load({ loadProjectConfig: function() { throw new Error('boom'); } },
            mocks({ jira_post_comment: function(a) { jira.push(a); } }));
        var r = mod.postTokenUsageComments('PROJ-1', { customParams: {} });
        assert.equal(r.posted, 1, JSON.stringify(r));
        assert.equal(jira.length, 1);
    });
});

// ── gh-1225 — postTokenUsageComments edge branches: empty manifest,
// parse errors, a failing post, and trackers without a provider function.

suite('tokenUsageComment — postTokenUsageComments edge branches (gh-1225)', function() {

    function manifestMocks(manifest, files) {
        return {
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') {
                    return manifest === null ? null : JSON.stringify(manifest);
                }
                return files && files[opts.path] !== undefined ? files[opts.path] : null;
            }
        };
    }

    test('a manifest with no *_usage.json entry → early return, nothing posted', function() {
        var mod = loadTokenUsageComment(manifestMocks(['outputs/other_report.json', 'not-a-string', 42], {}));
        var r = mod.postTokenUsageComments('TS-1');
        assert.deepEqual(r, { posted: 0, files: [], errors: [] });
    });

    test('an empty manifest array → early return', function() {
        var mod = loadTokenUsageComment(manifestMocks([], {}));
        var r = mod.postTokenUsageComments('TS-1');
        assert.deepEqual(r, { posted: 0, files: [], errors: [] });
    });

    test('a missing manifest → early return', function() {
        var mod = loadTokenUsageComment(manifestMocks(null, {}));
        var r = mod.postTokenUsageComments('TS-1');
        assert.deepEqual(r, { posted: 0, files: [], errors: [] });
    });

    test('an unparseable usage file reports a parse error and keeps going', function() {
        var calls = [];
        var mod = loadTokenUsageComment({
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') {
                    return JSON.stringify(['outputs/bad_usage.json', 'outputs/good_usage.json']);
                }
                if (opts.path === 'outputs/bad_usage.json') return '{not json';
                if (opts.path === 'outputs/good_usage.json') return JSON.stringify({ total_tokens: 7 });
                return null;
            },
            jira_post_comment: function(a) { calls.push(a); }
        });
        var r = mod.postTokenUsageComments('TS-2');
        assert.equal(r.posted, 1);
        assert.equal(r.files[0], 'outputs/good_usage.json');
        assert.equal(r.errors.length, 1);
        assert.contains(r.errors[0], 'outputs/bad_usage.json (parse error)');
        assert.equal(calls.length, 1);
    });

    test('a failing postComment reports the error and continues with the next file', function() {
        var calls = [];
        var mod = loadTokenUsageComment({
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') {
                    return JSON.stringify(['outputs/first_usage.json', 'outputs/second_usage.json']);
                }
                return JSON.stringify({ total_tokens: 1 });
            },
            jira_post_comment: function(a) {
                if (String(a.comment || a).indexOf('[first]') !== -1) throw new Error('tracker down');
                calls.push(a);
            }
        });
        var r = mod.postTokenUsageComments('TS-3');
        assert.equal(r.posted, 1, JSON.stringify(r));
        assert.equal(r.errors.length, 1);
        assert.contains(r.errors[0], 'Failed to post comment from outputs/first_usage.json: tracker down');
        assert.equal(r.files[0], 'outputs/second_usage.json');
        assert.equal(calls.length, 1);
    });

    test('an explicit tracker without a provider function still posts (provider null)', function() {
        var calls = [];
        var mod = loadTokenUsageComment(manifestMocks(['outputs/a_usage.json'], {
            'outputs/a_usage.json': JSON.stringify({ total_tokens: 5 })
        }));
        var r = mod.postTokenUsageComments('TS-4', { tracker: { postComment: function(k, c) { calls.push([k, c]); } } });
        assert.equal(r.posted, 1);
        assert.equal(calls.length, 1);
        assert.contains(calls[0][1], '[a]: {"total_tokens":5}');
    });
});

suite('tokenUsageComment.postTokenUsageSafely (gh-124)', function() {

    function usageFileMocks(posted, commentImpl) {
        return {
            file_read: function(opts) {
                if (opts.path === 'outputs/token_usage_files.json') {
                    return JSON.stringify(['outputs/story_solution_usage.json']);
                }
                if (opts.path === 'outputs/story_solution_usage.json') {
                    return JSON.stringify({ provider: 'kimi', total_tokens: 123 });
                }
                return null;
            },
            jira_post_comment: function(args) {
                posted.push(args);
                if (commentImpl) return commentImpl(args);
            }
        };
    }

    test('params form posts with params.initiator and customParamsOf(params)', function() {
        var posted = [];
        var mod = loadTokenUsageComment(usageFileMocks(posted));

        mod.postTokenUsageSafely('TS-1', { initiator: 'user-1', jobParams: { customParams: { trackerProvider: 'jira' } } });

        assert.equal(posted.length, 1);
        assert.equal(posted[0].key, 'TS-1');
        assert.contains(posted[0].comment, '[story_solution]:');
        assert.contains(posted[0].comment, 'Initiator: [~accountid:user-1]');
    });

    test('overrides win: explicit initiator and tracker are used, params may be null', function() {
        var posted = [];
        var mod = loadTokenUsageComment(usageFileMocks(posted));
        var fakeTracker = {
            provider: function() { return 'jira'; },
            postComment: function(key, comment) {
                posted.push({ key: key, comment: comment });
            }
        };

        mod.postTokenUsageSafely('TS-2', { initiator: 'user-from-params' }, { initiator: 'user-override', tracker: fakeTracker });

        assert.equal(posted.length, 1);
        assert.equal(posted[0].key, 'TS-2');
        assert.contains(posted[0].comment, 'Initiator: [~accountid:user-override]');
        assert.notContains(posted[0].comment, 'user-from-params');
    });

    test('never throws: a posting failure is logged and swallowed', function() {
        var mod = loadTokenUsageComment(usageFileMocks([], function() {
            throw new Error('provider down');
        }));

        var threw = false;
        try {
            mod.postTokenUsageSafely('TS-3', { initiator: 'user-1' });
        } catch (e) {
            threw = true;
        }
        assert.notOk(threw, 'postTokenUsageSafely must not propagate provider failures');
    });

    test('tolerates null params and missing overrides (posting still works)', function() {
        var posted = [];
        var mod = loadTokenUsageComment(usageFileMocks(posted));

        mod.postTokenUsageSafely('TS-4', null);

        assert.equal(posted.length, 1);
        assert.equal(posted[0].key, 'TS-4');
    });
});
