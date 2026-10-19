/**
 * Unit tests for gh-1087 — js/common/quotaCircuitBreaker.js (the pure half)
 * and js/quotaParkProbe.js (the bounded probe / un-park handler).
 */

var quotaBreaker = loadModule('js/common/quotaCircuitBreaker.js');
var qbShapes = loadModule('js/common/ticketKeyShapes.js');
var qbMarkup = loadModule('js/common/commentMarkup.js', makeRequire({ './ticketKeyShapes.js': qbShapes }));

function loadProbe(mocks) {
    return loadModule(
        'js/quotaParkProbe.js',
        makeRequire({
            './config.js': configModule,
            './common/quotaCircuitBreaker.js': quotaBreaker,
            './common/commentMarkup.js': qbMarkup,
            './configLoader.js': configLoaderModule,
            './common/trackers.js': loadModule(
                'js/common/trackers.js',
                makeRequire({
                    '../config.js': configModule,
                    './ticketKeyShapes.js': qbShapes
                }),
                mocks || {}
            )
        }),
        mocks || {}
    );
}

suite('quotaCircuitBreaker > classifyFailure (UT-1, AC1)', function () {

    test('403 weekly usage-limit body → quota_exhausted with provider and window', function () {
        var cls = quotaBreaker.classifyFailure(
            'z.ai glm-5.3-flash answered 403 "weekly (7-day) usage limit" after 9 retries');
        assert.ok(cls, 'expected a classification');
        assert.equal(cls.kind, 'quota_exhausted');
        assert.equal(cls.provider, 'z.ai');
        assert.equal(cls.window, 'weekly (7-day)');
    });

    test('HTTP 403 with quota vocabulary (no provider name) → quota_exhausted', function () {
        var cls = quotaBreaker.classifyFailure('Error: HTTP 403: quota exceeded for current plan');
        assert.ok(cls);
        assert.equal(cls.kind, 'quota_exhausted');
    });

    test('429 rate-limit → transient', function () {
        var cls = quotaBreaker.classifyFailure('HTTP 429: rate limit exceeded, retry in 30s');
        assert.ok(cls);
        assert.equal(cls.kind, 'transient');
    });

    test('timeout / network cut → transient', function () {
        assert.equal(quotaBreaker.classifyFailure('socket hang up: ETIMEDOUT').kind, 'transient');
        assert.equal(quotaBreaker.classifyFailure('the request timed out').kind, 'transient');
    });

    test('mixed chain: 429 retries then 403 usage-limit + "Provider chain exhausted" → quota_exhausted', function () {
        var text = 'attempt 1: HTTP 429 rate limited; attempt 2: HTTP 429; ' +
            'z.ai glm-5.3-flash answered 403 "weekly (7-day) usage limit"; ' +
            'Provider chain exhausted: 2 of 2';
        var cls = quotaBreaker.classifyFailure(text);
        assert.ok(cls);
        assert.equal(cls.kind, 'quota_exhausted',
            'quota evidence wins over the transient 429s in the same chain');
        assert.equal(cls.provider, 'z.ai');
    });

    test('"Provider chain exhausted" tail after quota responses → quota_exhausted', function () {
        var cls = quotaBreaker.classifyFailure(
            'provider glm-5.3-flash: 403 usage limit reached\nProvider chain exhausted: 2 of 2');
        assert.ok(cls);
        assert.equal(cls.kind, 'quota_exhausted');
    });

    test('bare "Provider chain exhausted" without 403/quota evidence → not quota (legacy reset path)', function () {
        var cls = quotaBreaker.classifyFailure('Provider chain exhausted: 2 of 2');
        assert.notOk(cls && cls.kind === 'quota_exhausted',
            'must not park on the exhausted-chain tail alone — keep the gh-742 reset (AC4)');
    });

    test('empty / unrelated text → null (legacy reset path)', function () {
        assert.equal(quotaBreaker.classifyFailure(''), null);
        assert.equal(quotaBreaker.classifyFailure('some generic crash'), null);
    });
});

suite('quotaCircuitBreaker > config readers + probe cadence (AC3)', function () {

    test('park label / probe cadence defaults and jobParams overrides', function () {
        assert.equal(quotaBreaker.parkLabelOf({}), 'provider_quota');
        assert.equal(quotaBreaker.parkLabelOf(null), 'provider_quota');
        assert.equal(quotaBreaker.parkLabelOf({ quotaParkLabel: 'my_quota' }), 'my_quota');
        assert.equal(quotaBreaker.probeEveryOf({}), 3);
        assert.equal(quotaBreaker.probeEveryOf({ quotaProbeEveryNTicks: 5 }), 5);
        assert.equal(quotaBreaker.probeEveryOf({ quotaProbeEveryNTicks: 'garbage' }), 3);
        assert.equal(quotaBreaker.probeEveryOf({ quotaProbeEveryNTicks: 0 }), 3);
    });

    test('probe command defaults to a fa-provider chat ping; jobParams override wins', function () {
        var dflt = quotaBreaker.probeCommandOf({});
        assert.contains(dflt, 'curl');
        assert.contains(dflt, 'FA_PROVIDER_BASE_URL');
        assert.contains(dflt, '--fail');
        assert.equal(quotaBreaker.probeCommandOf({ quotaProbeCommand: 'my-ping' }), 'my-ping');
    });

    test('probe cadence: probe when the completed park ticks are a multiple of N (first tick probes so a misclassification self-corrects)', function () {
        // probeDue(priorCompletedTicks, everyN) — tick-based, NOT attempts-based:
        // every tick records a `quota-park-tick: n` marker, so the completed
        // tick count advances even between probes (gh-1087 review thread 1 —
        // an attempts-only counter deadlocks after the first failed probe).
        assert.ok(quotaBreaker.probeDue(0, 3));
        assert.notOk(quotaBreaker.probeDue(1, 3));
        assert.notOk(quotaBreaker.probeDue(2, 3));
        assert.ok(quotaBreaker.probeDue(3, 3));
        assert.ok(quotaBreaker.probeDue(6, 3));
        assert.ok(quotaBreaker.probeDue(0, 1));
        assert.ok(quotaBreaker.probeDue(2, 1));
    });

    test('probe markers: count the highest marker across comment bodies', function () {
        assert.equal(quotaBreaker.countProbeMarkers([]), 0);
        assert.equal(quotaBreaker.countProbeMarkers(['quota-probe: 1']), 1);
        assert.equal(quotaBreaker.countProbeMarkers([
            'noise\nquota-probe: 2\nmore',
            { body: 'quota-probe: 5' },
            'quota-probe: 3'
        ]), 5);
        assert.equal(quotaBreaker.countProbeMarkers(['quota-probe: x']), 0);
    });

    test('tick markers: the durable per-tick cadence clock (gh-1087 review thread 1)', function () {
        assert.equal(quotaBreaker.tickMarkerLine(4), 'quota-park-tick: 4');
        assert.equal(quotaBreaker.countTickMarkers([]), 0);
        assert.equal(quotaBreaker.countTickMarkers(['quota-park-tick: 2']), 2);
        assert.equal(quotaBreaker.countTickMarkers([
            'quota-park-tick: 1',
            { body: 'quota-park-tick: 7' },
            'quota-park-tick: 3\nquota-park-tick: 5'
        ]), 7);
        // probe markers must NOT feed the tick counter and vice versa
        assert.equal(quotaBreaker.countTickMarkers(['quota-probe: 9']), 0);
        assert.equal(quotaBreaker.countProbeMarkers(['quota-park-tick: 9']), 0);
    });

    test('redactCommand: masks inline credentials, keeps env-var name references (review thread 2)', function () {
        // default command only references env-var NAMES — must pass through
        var dflt = quotaBreaker.probeCommandOf({});
        assert.equal(quotaBreaker.redactCommand(dflt), dflt);
        // an operator override with an inline credential must be masked
        var leaked = quotaBreaker.redactCommand(
            'curl -H "Authorization: Bearer sk-live-1234567890abcdef" https://api.example.com');
        assert.contains(leaked, 'Bearer ***');
        assert.notContains(leaked, 'sk-live-1234567890abcdef');
        // header-shaped and key=value secrets are masked too
        var keyed = quotaBreaker.redactCommand('my-ping --api-key=AKIAIOSFODNN7EXAMPLE');
        assert.notContains(keyed, 'AKIAIOSFODNN7EXAMPLE');
        assert.contains(keyed, '***');
    });
});

suite('quotaCircuitBreaker > SM dispatch-lane exclusion (AC2)', function () {

    test('parked ticket is skipped by normal rules', function () {
        var ticket = { key: 'TS-1', labels: ['provider_quota'] };
        assert.ok(quotaBreaker.shouldSkipForQuotaPark(ticket, { configFile: 'agents/story_development.json' }, {}));
    });

    test('parked ticket is skipped on the Jira fields.labels shape too', function () {
        var ticket = { key: 'TS-1', fields: { labels: ['provider_quota'] } };
        assert.ok(quotaBreaker.shouldSkipForQuotaPark(ticket, {}, {}));
    });

    test('the quota-probe rule keeps reaching parked tickets', function () {
        var ticket = { key: 'TS-1', labels: ['provider_quota'] };
        assert.notOk(quotaBreaker.shouldSkipForQuotaPark(ticket, { quotaParkProbe: true }, {}));
    });

    test('unparked tickets and custom labels', function () {
        assert.notOk(quotaBreaker.shouldSkipForQuotaPark({ key: 'TS-1', labels: ['sm_x'] }, {}, {}));
        var ticket = { key: 'TS-1', labels: ['my_quota'] };
        assert.ok(quotaBreaker.shouldSkipForQuotaPark(ticket, {}, { quotaParkLabel: 'my_quota' }));
        assert.notOk(quotaBreaker.shouldSkipForQuotaPark(ticket, {}, {}));
    });
});

suite('quotaCircuitBreaker > park/unpark comments (AC2/AC3)', function () {

    test('park comment names the provider, the quota window and the reset condition', function () {
        var body = quotaBreaker.parkComment(qbMarkup.forTicket('TS-1'), {
            kind: 'quota_exhausted', provider: 'z.ai', window: 'weekly (7-day)'
        }, 'provider_quota', 3);
        assert.contains(body, 'z.ai');
        assert.contains(body, 'weekly (7-day)');
        assert.contains(body, 'provider_quota');
        assert.contains(body, 'NOT');
    });

    test('park comment tolerates a missing provider/window', function () {
        var body = quotaBreaker.parkComment(qbMarkup.forTicket('TS-1'),
            { kind: 'quota_exhausted', provider: null, window: null }, 'provider_quota', 3);
        assert.contains(body, 'provider_quota');
    });

    test('unpark comment names the probe that succeeded', function () {
        var body = quotaBreaker.unparkComment(qbMarkup.forTicket('TS-1'), 'provider_quota', 4);
        assert.contains(body, 'provider_quota');
        assert.contains(body, '#4');
    });
});

suite('quotaParkProbe > bounded probe + un-park (UT-2, AC2/AC3)', function () {

    function probeMocks(overrides) {
        return Object.assign({
            cli_execute_command: function () { return ''; },
            jira_get_comments: function () { return '{"comments":[]}' },
            jira_add_label: function () { },
            jira_remove_label: function () { },
            jira_move_to_status: function () { }
        }, overrides || {});
    }

    function runProbe(mocks, jobParams) {
        var mod = loadProbe(mocks);
        return mod.action({
            ticket: { key: 'TS-77', fields: { summary: 's', labels: ['provider_quota'] } },
            jobParams: Object.assign({ customParams: {} }, jobParams || {})
        });
    }

    test('probe not due (tick cadence) → no CLI call, tick marker still recorded, park stays', function () {
        var cliCalls = 0;
        var comments = [];
        var mocks = probeMocks({
            cli_execute_command: function () { cliCalls++; return ''; },
            // two park ticks already recorded, cadence 3 → this tick (3rd) is off-cadence
            jira_get_comments: function () { return '{"comments":[{"body":"quota-park-tick: 1"},{"body":"quota-park-tick: 2"}]}' },
            jira_post_comment: function (args) { comments.push(args); }
        });
        var res = runProbe(mocks, { quotaProbeEveryNTicks: 3 });
        assert.equal(res.action, 'probe_not_due');
        assert.equal(res.tick, 3);
        assert.equal(cliCalls, 0, 'no provider ping off-cadence');
        assert.equal(comments.length, 1, 'every tick records its durable tick marker');
        assert.contains(comments[0].comment, 'quota-park-tick: 3');
    });

    test('probe failure → park stays, tick marker + probe marker recorded', function () {
        var comments = [];
        var moves = [];
        var removed = [];
        var mocks = probeMocks({
            cli_execute_command: function () { throw new Error('Command execution failed (exit code 22)'); },
            jira_get_comments: function () { return '{"comments":[]}' },
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { moves.push(args); },
            jira_remove_label: function (args) { removed.push(args); }
        });
        var res = runProbe(mocks, {});
        assert.equal(res.action, 'probe_failed');
        assert.equal(res.tick, 1);
        assert.equal(moves.length, 0, 'failed probe must not move the ticket (park stays — AC2)');
        assert.equal(removed.length, 0, 'failed probe must not remove the park label');
        assert.equal(comments.length, 2, 'tick marker + probe marker');
        assert.contains(comments[0].comment, 'quota-park-tick: 1');
        assert.contains(comments[1].comment, 'quota-probe: 1');
    });

    test('cadence keeps firing while quota-blocked: 2×everyN+1 failing ticks → probes on ticks 1, N+1, 2N+1 (review thread 1, AC3)', function () {
        var bodies = [];
        var comments = [];
        var probes = 0;
        var mocks = probeMocks({
            cli_execute_command: function () { probes++; throw new Error('HTTP 403: usage limit'); },
            jira_get_comments: function () { return JSON.stringify({ comments: bodies.map(function (b) { return { body: b }; }) }); },
            jira_post_comment: function (args) { bodies.push(args.comment); comments.push(args); }
        });
        var everyN = 3;
        var results = [];
        for (var tick = 1; tick <= 2 * everyN + 1; tick++) {
            results.push(runProbe(mocks, { quotaProbeEveryNTicks: everyN }));
        }
        assert.equal(probes, 3, 'probe #2 and #3 fire at ticks N+1 and 2N+1 — the cadence must not deadlock after the first failed probe');
        assert.equal(results[0].action, 'probe_failed');
        assert.equal(results[0].probes, 1);
        assert.equal(results[1].action, 'probe_not_due');
        assert.equal(results[2].action, 'probe_not_due');
        assert.equal(results[3].action, 'probe_failed', 'second probe fires on tick N+1');
        assert.equal(results[3].probes, 2);
        assert.equal(results[6].action, 'probe_failed', 'third probe fires on tick 2N+1');
        assert.equal(results[6].probes, 3);
        var tickMarkers = bodies.filter(function (b) { return b.indexOf('quota-park-tick:') !== -1; });
        assert.equal(tickMarkers.length, 2 * everyN + 1, 'every tick records its tick marker — the durable cadence clock');
        var probeMarkers = bodies.filter(function (b) { return b.indexOf('quota-probe:') !== -1; });
        assert.equal(probeMarkers.length, 3);
    });

    test('park self-lifts on the first successful probe after repeated failures (AC3)', function () {
        var comments = [];
        var moves = [];
        var removed = [];
        // post-fix ticket shape: 6 recorded ticks, 2 failed probes → due, probe #3
        var mocks = probeMocks({
            cli_execute_command: function () { return ''; },
            jira_get_comments: function () {
                return '{"comments":[' +
                    '{"body":"quota-probe: 1"},{"body":"quota-probe: 2"},' +
                    '{"body":"quota-park-tick: 1"},{"body":"quota-park-tick: 2"},{"body":"quota-park-tick: 3"},' +
                    '{"body":"quota-park-tick: 4"},{"body":"quota-park-tick: 5"},{"body":"quota-park-tick: 6"}]}';
            },
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { moves.push(args); },
            jira_remove_label: function (args) { removed.push(args); }
        });
        var res = runProbe(mocks, {});
        assert.equal(res.action, 'unparked');
        assert.equal(res.probes, 3, 'probe numbering follows the recorded probe markers, ticks only drive the cadence');
        var unpark = comments.filter(function (c) { return c.comment.indexOf('Un-Parked') !== -1; });
        assert.equal(unpark.length, 1);
        assert.contains(unpark[0].comment, '#3');
        assert.deepEqual(moves, [{ key: 'TS-77', statusName: 'Ready For Development' }]);
    });

    test('probe success → un-park: label removed, trigger labels cleared, ticket back to Ready For Development', function () {
        var comments = [];
        var moves = [];
        var removed = [];
        var probes = 0;
        var mocks = probeMocks({
            cli_execute_command: function () { probes++; return ''; },
            jira_get_comments: function () { return '{"comments":[{"body":"quota-probe: 3"}]}' },
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { moves.push(args); },
            jira_remove_label: function (args) { removed.push(args); }
        });
        var res = runProbe(mocks, {});
        assert.equal(res.action, 'unparked');
        assert.equal(probes, 1, 'exactly one cheap ping');
        assert.deepEqual(moves, [{ key: 'TS-77', statusName: 'Ready For Development' }]);
        var removedLabels = removed.map(function (r) { return r.label; });
        assert.ok(removedLabels.indexOf('provider_quota') !== -1, 'park label removed');
        assert.ok(removedLabels.indexOf('sm_story_development_triggered') !== -1, 'dev trigger label cleared so the lane re-fires');
        var unpark = comments.filter(function (c) { return c.comment.indexOf('Un-Parked') !== -1; });
        assert.equal(unpark.length, 1);
        assert.contains(unpark[0].comment, '#4');
        var tickMarkers = comments.filter(function (c) { return c.comment.indexOf('quota-park-tick:') !== -1; });
        assert.equal(tickMarkers.length, 1, 'the tick is recorded even on the un-park tick');
    });

    test('probe command is logged redacted — an inline override credential never reaches the logs (review thread 2)', function () {
        var logs = [];
        var origLog = console.log;
        console.log = function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var mocks = probeMocks({
                cli_execute_command: function () { throw new Error('boom'); },
                jira_get_comments: function () { return '{"comments":[]}' }
            });
            runProbe(mocks, { quotaProbeCommand: 'curl -H "Authorization: Bearer sk-live-1234567890abcdef" https://api.example.com' });
        } finally {
            console.log = origLog;
        }
        var joined = logs.join('\n');
        assert.notContains(joined, 'sk-live-1234567890abcdef', 'the raw credential must never be logged');
        assert.contains(joined, 'Bearer ***');
        assert.contains(joined, 'Running probe #1');
    });

    test('custom park label + custom probe command flow end to end', function () {
        var removed = [];
        var ran = [];
        var mocks = probeMocks({
            cli_execute_command: function (args) { ran.push(args.command); return ''; },
            jira_get_comments: function () { return '{"comments":[]}' },
            jira_remove_label: function (args) { removed.push(args); }
        });
        var res = runProbe(mocks, { quotaParkLabel: 'my_quota', quotaProbeCommand: 'my-ping --cheap' });
        assert.equal(res.action, 'unparked');
        assert.deepEqual(ran, ['my-ping --cheap']);
        assert.ok(removed.map(function (r) { return r.label; }).indexOf('my_quota') !== -1);
    });
});
