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
