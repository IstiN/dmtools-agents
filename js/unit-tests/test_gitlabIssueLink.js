/**
 * Unit tests: gitlabIssueLink.js — the GitLab MR↔issue linkage wait.
 *
 * GitLab extracts 'Closes #N' references from MR descriptions asynchronously
 * (Sidekiq), while the GitLab factory pipeline verifies
 * issues/:iid/related_merge_requests immediately after dmtools exits — the
 * wait closes that race. Functions are covered directly (not only through
 * injected deps) so the per-function CRAP ratchet sees real branch coverage.
 */
/* global loadModule, assert, test, suite, makeRequire, java */

suite('gitlabIssueLink', function () {

    function loadMod(mocks) {
        return loadModule('js/common/gitlabIssueLink.js', makeRequire({}), mocks || {});
    }

    function ciEnv(name) {
        return { CI_API_V4_URL: 'https://gl/api/v4', CI_PROJECT_ID: '42', GITLAB_TOKEN: 't' }[name] || '';
    }

    // ── env/sleep primitives ──────────────────────────────────────────────

    test('envValue prefers the Java host env and falls back to process.env', function () {
        var mod = loadMod();
        // The harness java mock getenv() returns null → falls through to process.env.
        var key = 'GITLAB_ISSUE_LINK_TEST_VAR';
        process.env[key] = 'from-node';
        try {
            assert.equal(mod.envValue(key), 'from-node');
        } finally {
            delete process.env[key];
        }
        assert.equal(mod.envValue('GITLAB_ISSUE_LINK_MISSING_VAR'), '', 'missing everywhere → empty string');
    });

    test('javaEnv returns the host value, null when absent, and survives a throwing bridge', function () {
        var mod = loadMod();
        var original = java.lang.System.getenv;
        try {
            java.lang.System.getenv = function () { return 'host-value'; };
            assert.equal(mod.javaEnv('ANY'), 'host-value');
            java.lang.System.getenv = function () { return null; };
            assert.equal(mod.javaEnv('ANY'), null);
            java.lang.System.getenv = function () { throw new Error('bridge down'); };
            assert.equal(mod.javaEnv('ANY'), null, 'a throwing host bridge is treated as absent');
        } finally {
            java.lang.System.getenv = original;
        }
    });

    test('nodeEnv reads process.env and defaults to an empty string', function () {
        var mod = loadMod();
        var key = 'GITLAB_ISSUE_LINK_NODE_VAR';
        process.env[key] = 'v';
        try {
            assert.equal(mod.nodeEnv(key), 'v');
        } finally {
            delete process.env[key];
        }
        assert.equal(mod.nodeEnv(key), '');
    });

    test('sleepMs uses the Java host sleep and swallows its absence', function () {
        var mod = loadMod();
        var slept = [];
        java.lang.Thread = { sleep: function (ms) { slept.push(ms); } };
        try {
            mod.sleepMs(5);
            assert.deepEqual(slept, [5]);
        } finally {
            delete java.lang.Thread;
        }
        mod.sleepMs(5); // java.lang.Thread gone → the TypeError is swallowed
    });

    // ── pure helpers ──────────────────────────────────────────────────────

    test('resolveDeps fills every missing dependency with the module defaults', function () {
        var mod = loadMod();
        var d = mod.resolveDeps();
        assert.equal(d.env, mod.envValue);
        assert.equal(d.sleep, mod.sleepMs);
        assert.equal(d.runCommand, mod.defaultRunCommand);
        assert.equal(d.maxAttempts, 24);
        var custom = { env: ciEnv, sleep: function () {}, runCommand: function () {}, maxAttempts: 2 };
        assert.deepEqual(mod.resolveDeps(custom), custom);
    });

    test('hasCiEnv requires all three GitLab CI variables', function () {
        var mod = loadMod();
        assert.equal(mod.hasCiEnv(ciEnv), true);
        assert.equal(mod.hasCiEnv(function () { return ''; }), false);
        assert.equal(mod.hasCiEnv(function (n) { return n === 'GITLAB_TOKEN' ? '' : ciEnv(n); }), false);
    });

    test('relatedMrsCommand builds the curl probe with shell-expanded token only', function () {
        var mod = loadMod();
        var cmd = mod.relatedMrsCommand('https://gl/api/v4', '42', '7');
        assert.contains(cmd, '/projects/42/issues/7/related_merge_requests?per_page=100');
        assert.contains(cmd, 'PRIVATE-TOKEN: $GITLAB_TOKEN');
        assert.ok(cmd.indexOf('bash -c') === 0, 'runs through bash (whitelisted on dev legs)');
    });

    test('parseRelated tolerates JSON strings, arrays, garbage and non-arrays', function () {
        var mod = loadMod();
        assert.deepEqual(mod.parseRelated('[{"iid":1}]'), [{ iid: 1 }]);
        assert.deepEqual(mod.parseRelated([{ iid: 2 }]), [{ iid: 2 }]);
        assert.deepEqual(mod.parseRelated('not json'), []);
        assert.deepEqual(mod.parseRelated('{"message":"403"}'), []);
        assert.deepEqual(mod.parseRelated(null), []);
    });

    test('containsLinkedMr matches iid AND project_id', function () {
        var mod = loadMod();
        assert.equal(mod.containsLinkedMr([{ iid: 31, project_id: 42 }], 31, '42'), true);
        assert.equal(mod.containsLinkedMr([{ iid: 31, project_id: 999 }], 31, '42'), false,
            'a same-iid MR from another project must not satisfy the wait');
        assert.equal(mod.containsLinkedMr([null, { iid: 1, project_id: 42 }], 31, '42'), false);
        assert.equal(mod.containsLinkedMr([], 31, '42'), false);
    });

    // ── pollOnce / pollUntilLinked ────────────────────────────────────────

    test('pollOnce classifies linked, retry, whitelist-abort and transient errors', function () {
        var mod = loadMod();
        var linked = function () { return '[{"iid":31,"project_id":42}]'; };
        var empty = function () { return '[]'; };
        var blocked = function () { throw new Error('Command not allowed. Whitelisted commands: git'); };
        var transient = function () { throw new Error('HTTP 502'); };
        assert.equal(mod.pollOnce('c', 31, '42', linked), 'linked');
        assert.equal(mod.pollOnce('c', 31, '42', empty), 'retry');
        assert.equal(mod.pollOnce('c', 31, '42', blocked), 'abort');
        assert.equal(mod.pollOnce('c', 31, '42', transient), 'retry');
    });

    test('pollUntilLinked polls until linked and sleeps only between attempts', function () {
        var mod = loadMod();
        var calls = 0;
        var slept = [];
        var d = {
            maxAttempts: 5,
            sleep: function (ms) { slept.push(ms); },
            runCommand: function () {
                calls++;
                return calls < 3 ? '[]' : '[{"iid":31,"project_id":42}]';
            }
        };
        assert.equal(mod.pollUntilLinked('c', 31, '42', d), true);
        assert.equal(calls, 3, 'stops polling once the link is visible');
        assert.deepEqual(slept, [5000, 5000]);
    });

    test('pollUntilLinked gives up after maxAttempts and aborts early on a whitelist rejection', function () {
        var mod = loadMod();
        var polls = 0;
        assert.equal(mod.pollUntilLinked('c', 31, '42', {
            maxAttempts: 3, sleep: function () {},
            runCommand: function () { polls++; return '[]'; }
        }), false);
        assert.equal(polls, 3);
        polls = 0;
        var slept = [];
        assert.equal(mod.pollUntilLinked('c', 31, '42', {
            maxAttempts: 5, sleep: function (ms) { slept.push(ms); },
            runCommand: function () { polls++; throw new Error('Command not allowed.'); }
        }), false);
        assert.equal(polls, 1, 'a blocked command never recovers — one attempt only');
        assert.equal(slept.length, 0);
    });

    // ── waitForIssueLink / afterMrCreated ─────────────────────────────────

    test('waitForIssueLink waits for the Closes #N issue to list the MR', function () {
        var mod = loadMod();
        var commands = [];
        var linked = mod.waitForIssueLink(31, 'Closes #7\n\nWhat changed…', {
            env: ciEnv,
            sleep: function () {},
            runCommand: function (args) {
                commands.push(args.command);
                return commands.length < 2 ? '[]' : '[{"iid":31,"project_id":42}]';
            }
        });
        assert.equal(linked, true);
        assert.equal(commands.length, 2);
        assert.contains(commands[0], '/projects/42/issues/7/related_merge_requests');
    });

    test('waitForIssueLink is a no-op without an MR iid, a Closes line, or the CI env', function () {
        var mod = loadMod();
        var mustNotRun = function () { throw new Error('must not be called'); };
        assert.equal(mod.waitForIssueLink(null, 'Closes #7', { env: ciEnv, runCommand: mustNotRun }), false);
        assert.equal(mod.waitForIssueLink(31, 'No closing keyword', { env: ciEnv, runCommand: mustNotRun }), false);
        assert.equal(mod.waitForIssueLink(31, 'Closes #7', { env: function () { return ''; }, runCommand: mustNotRun }), false);
    });

    test('afterMrCreated passes the MR through and waits only for a created MR', function () {
        var mod = loadMod();
        var commands = 0;
        var mr = { number: 31, html_url: 'http://gl/mr/31' };
        var deps = {
            env: ciEnv, sleep: function () {},
            runCommand: function () { commands++; return '[{"iid":31,"project_id":42}]'; }
        };
        assert.equal(mod.afterMrCreated(mr, 'Closes #7', deps), mr, 'passthrough keeps the createPr result shape');
        assert.equal(commands, 1);
        assert.equal(mod.afterMrCreated(null, 'Closes #7', deps), null, 'no MR → nothing to wait for');
        assert.equal(mod.afterMrCreated({ number: null }, 'Closes #7', deps).number, null);
        assert.equal(commands, 1);
    });
});
