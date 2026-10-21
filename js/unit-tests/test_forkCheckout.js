/**
 * Unit tests: js/common/forkCheckout.js + its gitOps/pushRework consumers
 * (gh-1096) — a fork PR's rework leg checks out refs/pull/<N>/head and pushes
 * back to the fork token URL; same-repo PRs stay byte-identical (REG).
 */
/* global loadModule, assert, test, suite, makeRequire, configModule */

suite('forkCheckout (gh-1096)', function () {

    var vl = loadModule('js/common/validationLiveness.js', makeRequire({}), {});
    var mod = loadModule('js/common/forkCheckout.js', makeRequire({ './validationLiveness.js': vl }), {});
    var FORK_PR = { number: 1591, head: { ref: 'fix/x', repo: { full_name: 'YuryBY/fa' } },
                    base: { ref: 'main', repo: { full_name: 'IstiN/fa' } } };
    var SAME_PR = { number: 7, head: { ref: 'ai/gh-7', repo: { full_name: 'istin/FA' } },
                    base: { ref: 'main', repo: { full_name: 'IstiN/fa' } } };

    function withJava(envValue) {
        var java = { lang: { System: { getenv: function () { return envValue; } } } };
        return loadModule('js/common/forkCheckout.js', makeRequire({ './validationLiveness.js': vl }), { java: java });
    }

    test('fork PR → pull ref + fork full; same-repo / missing → null', function () {
        assert.equal(mod.prPullRef(FORK_PR), 'refs/pull/1591/head');
        assert.equal(mod.prForkFull(FORK_PR), 'YuryBY/fa');
        assert.equal(mod.prPullRef(SAME_PR), null);
        assert.equal(mod.prForkFull(null), null);
        assert.equal(mod.prForkFull({ head: {}, base: {} }), null);
    });

    test('resolvePullRef: explicit wins, else well-formed env ref, else null', function () {
        assert.equal(mod.resolvePullRef('refs/pull/1/head', 'refs/pull/2/head'), 'refs/pull/1/head');
        assert.equal(mod.resolvePullRef(null, 'refs/pull/2/head'), 'refs/pull/2/head');
        assert.equal(mod.resolvePullRef(null, 'main'), null);
        assert.equal(mod.resolvePullRef(null, ''), null);
    });

    test('envCheckoutRef: GraalJS env, empty under node / unset', function () {
        assert.equal(mod.envCheckoutRef(), '');
        assert.equal(withJava('refs/pull/9/head').envCheckoutRef(), 'refs/pull/9/head');
        assert.equal(withJava(null).envCheckoutRef(), '');
    });

    test('pr_info fork-head line round-trips; same-repo writes nothing', function () {
        var line = mod.forkHeadInfoLine(FORK_PR);
        assert.equal(mod.readForkHead('- **Branch**: `fix/x` → `main`\n' + line), 'YuryBY/fa');
        assert.equal(mod.forkHeadInfoLine(SAME_PR), '');
        assert.equal(mod.readForkHead('- **Branch**: `a` → `main`\n'), null);
        assert.equal(mod.readForkHead(null), null);
    });

    test('REG: same-repo push plan is byte-identical to the origin commands', function () {
        var p = mod.reworkPushPlan(null, 'ai/gh-7', false);
        assert.equal(p.fork, false);
        assert.equal(p.push, 'git push -u origin ai/gh-7');
        assert.equal(p.fetch, 'git -c fetch.recurseSubmodules=no fetch origin ai/gh-7:refs/remotes/origin/ai/gh-7');
        assert.equal(p.merge, 'git merge --no-edit origin/ai/gh-7');
        assert.equal(p.retry, 'git push -u origin ai/gh-7');
        assert.equal(mod.reworkPushPlan(null, 'b', true).push, 'git push -u --force-with-lease origin b');
    });

    test('fork push plan targets the fork token URL HEAD:<branch>, never origin', function () {
        var url = vl.forkPushTokenUrl('YuryBY/fa');
        var p = mod.reworkPushPlan('YuryBY/fa', 'fix/x', false);
        assert.equal(p.fork, true);
        assert.equal(p.push, 'git push ' + url + ' HEAD:fix/x');
        assert.equal(p.retry, 'git push ' + url + ' HEAD:fix/x');
        assert.equal(p.fetch, 'git -c fetch.recurseSubmodules=no fetch ' + url + ' fix/x');
        assert.equal(p.merge, 'git merge --no-edit FETCH_HEAD');
        assert.equal(mod.reworkPushPlan('YuryBY/fa', 'fix/x', true).push, 'git push --force ' + url + ' HEAD:fix/x');
    });

    test('UT-2: gitOps.checkoutPRBranch with a pull ref fetches refs/pull/<N>/head (branch absent on origin)', function () {
        var commands = [];
        var gitOps = loadModule('js/common/gitOps.js', makeRequire({
            '../config.js': configModule,
            './gitStaging.js': loadModule('js/common/gitStaging.js'),
            './forkCheckout.js': mod,
            './pullRequest.js': loadModule('js/common/pullRequest.js',
                makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }))
        }), {
            cli_execute_command: function (args) { commands.push(args.command); return ''; }
        });
        gitOps.checkoutPRBranch('fix/x', null, null, 'refs/pull/1591/head');
        assert.ok(commands.indexOf('git -c fetch.recurseSubmodules=no fetch origin refs/pull/1591/head') !== -1, JSON.stringify(commands));
        assert.ok(commands.indexOf('git checkout -B fix/x FETCH_HEAD') !== -1, JSON.stringify(commands));
        assert.equal(commands.filter(function (c) { return c.indexOf('ls-remote') !== -1; }).length, 0);
    });
});
