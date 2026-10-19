/**
 * Unit tests for js/commitAndPushToBaseBranch.js — the direct-to-base-branch
 * postJSAction (no branch, no PR).
 *
 * gh-1082 characterization: pins the exact git command sequence, the commit
 * message format (default template, {ticketKey} substitution, quote
 * escaping, --no-verify), the pre-push gate contract, the tracker comment
 * texts, and the customParams resolution order — BEFORE the CRAP
 * decomposition of action() into parse/build/decide helpers. Every test must
 * keep passing byte-identically through any refactor.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadCommitAndPush(mocks, moduleMocks) {
    return loadModule('js/commitAndPushToBaseBranch.js', makeRequire(Object.assign({
        './common/jiraHelpers.js': {
            extractTicketKey: function(p) {
                return (p && p.ticket && p.ticket.key) ? p.ticket.key : null;
            }
        },
        './configLoader.js': { loadProjectConfig: function() { return {}; } },
        './common/pullRequest.js': loadModule('js/common/pullRequest.js',
            makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') })),
        './common/gitStaging.js': {
            buildExclusionPathspecs: function(paths) { return paths.map(function(p) { return ':!' + p; }).join(' '); }
        },
        './common/trackers.js': {
            createTracker: function(config, customParams) {
                return {
                    createdWith: customParams,
                    postComment: function(key, comment) {
                        mocks.comments.push({ key: key, comment: comment });
                    }
                };
            }
        }
    }, moduleMocks || {})), Object.assign({
        cli_execute_command: function(args) { return ''; }
    }, mocks.cli || {}, mocks.globals || {}));
}

/**
 * Standard fixture: a config with all directPush options and a dirty tree.
 */
function standardMocks(statusOutput, gateOutput) {
    var comments = [];
    var commands = [];
    return {
        comments: comments,
        commands: commands,
        cli: {
            cli_execute_command: function(args) {
                commands.push(args);
                if (args.command === 'git status --porcelain') return statusOutput || '';
                if (gateOutput !== undefined && args.command.indexOf('bash scripts/gate.sh') === 0) return gateOutput;
                return '';
            }
        }
    };
}

function directPushConfig(overrides) {
    return {
        git: { baseBranch: 'main' },
        customParams: {
            directPush: Object.assign({
                commitMessage: 'Update {ticketKey} artifacts',
                noChangesComment: 'Nothing to do for {ticketKey}',
                successComment: 'Published {ticketKey} at {url}',
                resultUrlTemplate: 'https://example.com/site/{ticketKey}/'
            }, overrides || {})
        }
    };
}

function configLoaderReturns(cfg) {
    return {
        './configLoader.js': { loadProjectConfig: function() { return cfg; } }
    };
}

// ── action: guard and branch decisions ───────────────────────────────────────

suite('commitAndPushToBaseBranch.action — characterization (gh-1082)', function() {

    test('a missing ticket key fails fast: false, no tracker comment, no git commands', function() {
        var m = standardMocks(' M a.txt');
        var ok = loadCommitAndPush(m, configLoaderReturns(directPushConfig())).action({ ticket: {} });
        assert.equal(ok, false);
        assert.equal(m.commands.length, 0, 'no git command runs without a ticket key');
        assert.equal(m.comments.length, 0, 'no tracker comment without a ticket key');
    });

    test('a clean working tree posts the no-changes comment and runs nothing else', function() {
        var m = standardMocks('');
        var ok = loadCommitAndPush(m, configLoaderReturns(directPushConfig())).action({ ticket: { key: 'TS-1' } });
        assert.equal(ok, true);
        var cmds = m.commands.map(function(c) { return c.command; });
        assert.deepEqual(cmds, ['git status --porcelain'], 'no add/commit/pull/push on a clean tree');
        assert.equal(m.comments.length, 1);
        assert.equal(m.comments[0].key, 'TS-1');
        assert.equal(m.comments[0].comment, 'Nothing to do for TS-1');
    });

    test('a clean tree without noChangesComment posts nothing', function() {
        var m = standardMocks('');
        var cfg = directPushConfig();
        delete cfg.customParams.directPush.noChangesComment;
        var ok = loadCommitAndPush(m, configLoaderReturns(cfg)).action({ ticket: { key: 'TS-1' } });
        assert.equal(ok, true);
        assert.equal(m.comments.length, 0);
    });

    test('the gate command substitutes {ticketKey} and its output is logged, then the push proceeds', function() {
        var m = standardMocks(' M a.txt', 'all good');
        var cfg = directPushConfig({ gateCommand: 'bash scripts/gate.sh {ticketKey} --ref {ticketKey}' });
        var ok = loadCommitAndPush(m, configLoaderReturns(cfg)).action({ ticket: { key: 'TS-2' } });
        assert.equal(ok, true);
        var cmds = m.commands.map(function(c) { return c.command; });
        assert.contains(cmds[1], 'bash scripts/gate.sh TS-2 --ref TS-2', 'gate runs between status and add');
        assert.ok(cmds.indexOf('git commit -m "Update TS-2 artifacts" --no-verify') !== -1);
        assert.ok(m.commands[1].command.indexOf('bash scripts/gate.sh') === 0, 'gate ran with no workingDirectory shim change');
    });

    test('a failing gate comments the fenced error tail and never commits or pushes', function() {
        var comments = [];
        var commands = [];
        var m = {
            comments: comments,
            commands: commands,
            cli: {
                cli_execute_command: function(args) {
                    commands.push(args.command);
                    if (args.command === 'git status --porcelain') return ' M a.txt';
                    if (args.command.indexOf('bash scripts/gate.sh') === 0) {
                        throw new Error('gate boom');
                    }
                    return '';
                }
            }
        };
        var cfg = directPushConfig({ gateCommand: 'bash scripts/gate.sh {ticketKey}' });
        var ok = loadCommitAndPush(m, configLoaderReturns(cfg)).action({ ticket: { key: 'TS-3' } });
        assert.equal(ok, false);
        assert.equal(m.comments.length, 1);
        assert.contains(m.comments[0].comment, 'Pre-push gate failed, changes NOT pushed:');
        assert.contains(m.comments[0].comment, 'Error: gate boom');
        assert.equal(
            m.comments[0].comment,
            'Pre-push gate failed, changes NOT pushed:\n\n```\nError: gate boom\n```'
        );
        assert.ok(commands.every(function(c) { return c.indexOf('git commit') !== 0; }), 'no commit after a failed gate');
        assert.ok(commands.every(function(c) { return c.indexOf('git push') !== 0; }), 'no push after a failed gate');
    });

    test('a long gate error is fenced as its LAST 1500 characters', function() {
        var comments = [];
        var longErr = 'gate boom: ' + 'x'.repeat(2000);
        var m = {
            comments: comments,
            commands: [],
            cli: {
                cli_execute_command: function(args) {
                    if (args.command === 'git status --porcelain') return ' M a.txt';
                    if (args.command.indexOf('bash scripts/gate.sh') === 0) throw new Error(longErr);
                    return '';
                }
            }
        };
        var cfg = directPushConfig({ gateCommand: 'bash scripts/gate.sh {ticketKey}' });
        var ok = loadCommitAndPush(m, configLoaderReturns(cfg)).action({ ticket: { key: 'TS-3b' } });
        assert.equal(ok, false);
        var fenced = m.comments[0].comment.split('```\n')[1].split('\n```')[0];
        assert.ok(fenced.length <= 1500, 'error tail is sliced to 1500 chars, got ' + fenced.length);
        assert.ok(fenced.indexOf('gate boom') === -1, 'the prefix fell off the 1500-char tail slice');
        assert.ok(longErr.endsWith(fenced.replace(/^Error: /, '')), 'the tail is the END of the error text');
    });
});

// ── action: the exact push sequence and message formats ──────────────────────

suite('commitAndPushToBaseBranch.action — command sequence and formats (gh-1082)', function() {

    test('the push sequence is exactly: add, commit --no-verify, pull --rebase, push HEAD:baseBranch', function() {
        var m = standardMocks(' M a.txt\n?? b.txt');
        var ok = loadCommitAndPush(m, configLoaderReturns(directPushConfig())).action({ ticket: { key: 'TS-4' } });
        assert.equal(ok, true);
        var cmds = m.commands.map(function(c) { return c.command; });
        assert.deepEqual(cmds.slice(1), [
            'git add -A -- :!factory-kit',
            'git commit -m "Update TS-4 artifacts" --no-verify',
            'git pull --rebase origin main',
            'git push origin HEAD:main'
        ], JSON.stringify(cmds));
        // The success comment renders {ticketKey} and the {url} built from resultUrlTemplate.
        assert.equal(m.comments.length, 1);
        assert.equal(m.comments[0].comment, 'Published TS-4 at https://example.com/site/TS-4/');
    });

    test('the default commit message is "Update {ticketKey} artifacts" and quotes are escaped', function() {
        var m = standardMocks(' M a.txt');
        var cfg = directPushConfig();
        delete cfg.customParams.directPush.commitMessage;
        var ok = loadCommitAndPush(m, configLoaderReturns(cfg)).action({ ticket: { key: 'TS-5' } });
        assert.equal(ok, true);
        var commit = m.commands.map(function(c) { return c.command; }).filter(function(c) {
            return c.indexOf('git commit') === 0;
        })[0];
        assert.equal(commit, 'git commit -m "Update TS-5 artifacts" --no-verify');
    });

    test('double quotes inside the configured message are backslash-escaped for the shell', function() {
        var m = standardMocks(' M a.txt');
        var cfg = directPushConfig({ commitMessage: 'Say {ticketKey} "hello"' });
        var ok = loadCommitAndPush(m, configLoaderReturns(cfg)).action({ ticket: { key: 'TS-6' } });
        assert.equal(ok, true);
        var commit = m.commands.map(function(c) { return c.command; }).filter(function(c) {
            return c.indexOf('git commit') === 0;
        })[0];
        assert.equal(commit, 'git commit -m "Say TS-6 \\"hello\\"" --no-verify');
    });

    test('baseBranch falls back to main and is honored in pull and push', function() {
        var m = standardMocks(' M a.txt');
        var cfg = directPushConfig();
        delete cfg.git;
        var ok = loadCommitAndPush(m, configLoaderReturns(cfg)).action({ ticket: { key: 'TS-7' } });
        assert.equal(ok, true);
        var cmds = m.commands.map(function(c) { return c.command; });
        assert.ok(cmds.indexOf('git pull --rebase origin main') !== -1);
        assert.ok(cmds.indexOf('git push origin HEAD:main') !== -1);
    });

    test('a failed push comments "Push to <base> failed: ..." with the first 1000 chars and returns false', function() {
        var comments = [];
        var m = {
            comments: comments,
            commands: [],
            cli: {
                cli_execute_command: function(args) {
                    m.commands.push(args.command);
                    if (args.command === 'git status --porcelain') return ' M a.txt';
                    if (args.command.indexOf('git push') === 0) {
                        throw new Error('push boom: ' + 'y'.repeat(1500));
                    }
                    return '';
                }
            }
        };
        var ok = loadCommitAndPush(m, configLoaderReturns(directPushConfig())).action({ ticket: { key: 'TS-8' } });
        assert.equal(ok, false);
        assert.equal(m.comments.length, 1);
        assert.equal(m.comments[0].key, 'TS-8');
        assert.contains(m.comments[0].comment, 'Push to main failed: Error: push boom');
        var tail = m.comments[0].comment.split('failed: ')[1];
        assert.ok(tail.length <= 1000, 'error head is sliced to 1000 chars, got ' + tail.length);
    });

    test('a failed push without a success comment posts only the failure comment', function() {
        var comments = [];
        var m = {
            comments: comments,
            commands: [],
            cli: {
                cli_execute_command: function(args) {
                    m.commands.push(args.command);
                    if (args.command === 'git status --porcelain') return ' M a.txt';
                    if (args.command.indexOf('git push') === 0) throw new Error('denied');
                    return '';
                }
            }
        };
        var cfg = directPushConfig();
        delete cfg.customParams.directPush.successComment;
        var ok = loadCommitAndPush(m, configLoaderReturns(cfg)).action({ ticket: { key: 'TS-9' } });
        assert.equal(ok, false);
        assert.equal(m.comments.length, 1, 'only the failure comment');
        assert.contains(m.comments[0].comment, 'Push to main failed: Error: denied');
    });
});

// ── action: config resolution ────────────────────────────────────────────────

suite('commitAndPushToBaseBranch.action — config resolution (gh-1082)', function() {

    test('tracker customParams resolution: config.customParams wins over jobParams and params', function() {
        var created = [];
        var m = standardMocks(' M a.txt');
        var moduleMocks = configLoaderReturns(directPushConfig());
        moduleMocks['./common/trackers.js'] = {
            createTracker: function(config, customParams) {
                created.push(customParams);
                return { postComment: function() {} };
            }
        };
        var mod = loadCommitAndPush(m, moduleMocks);
        mod.action({
            ticket: { key: 'TS-10' },
            jobParams: { customParams: { from: 'jobParams' } },
            customParams: { from: 'params' }
        });
        assert.equal(created.length, 1);
        assert.equal(created[0].from, undefined, 'config.customParams (an object) wins the || chain');
        assert.ok(created[0].directPush, 'the directPush block rides along');
    });

    test('tracker customParams fall back to jobParams.customParams, then params.customParams', function() {
        var created = [];
        var m = standardMocks(' M a.txt');
        // No customParams key on the config at all — the || chain moves on.
        var moduleMocks = configLoaderReturns({ git: { baseBranch: 'main' } });
        moduleMocks['./common/trackers.js'] = {
            createTracker: function(config, customParams) { created.push(customParams); return { postComment: function() {} }; }
        };
        var mod = loadCommitAndPush(m, moduleMocks);
        mod.action({ ticket: { key: 'TS-11' }, jobParams: { customParams: { from: 'jobParams' } } });
        assert.equal(created[0].from, 'jobParams');

        created.length = 0;
        mod.action({ ticket: { key: 'TS-11' }, customParams: { from: 'params' } });
        assert.equal(created[0].from, 'params');
    });

    test('config.workingDir is forwarded as workingDirectory on every git command', function() {
        var m = standardMocks(' M a.txt');
        var cfg = directPushConfig({ gateCommand: 'bash scripts/gate.sh {ticketKey}' });
        cfg.workingDir = '/repo/work';
        var ok = loadCommitAndPush(m, configLoaderReturns(cfg)).action({ ticket: { key: 'TS-12' } });
        assert.equal(ok, true);
        assert.ok(m.commands.length >= 5);
        m.commands.forEach(function(c) {
            assert.equal(c.workingDirectory, '/repo/work', 'workingDirectory on: ' + c.command);
        });
    });

    test('no config.workingDir — commands run without a workingDirectory field', function() {
        var m = standardMocks(' M a.txt');
        var ok = loadCommitAndPush(m, configLoaderReturns(directPushConfig())).action({ ticket: { key: 'TS-13' } });
        assert.equal(ok, true);
        m.commands.forEach(function(c) {
            assert.equal('workingDirectory' in c, false, 'no workingDirectory on: ' + c.command);
        });
    });

    test('pure helpers: message, gate command, and comment builders (gh-1082 extraction surface)', function() {
        var mod = loadCommitAndPush(standardMocks(''), configLoaderReturns(directPushConfig()));
        var opts = directPushConfig().customParams.directPush;
        assert.equal(mod.buildCommitMessage(opts, 'TS-14'), 'Update TS-14 artifacts');
        assert.equal(mod.buildCommitMessage({}, 'TS-14'), 'Update TS-14 artifacts');
        assert.equal(mod.buildGateCommand('gate {ticketKey}', 'TS-15'), 'gate TS-15');
        assert.equal(
            mod.gateFailureComment(new Error('boom')),
            'Pre-push gate failed, changes NOT pushed:\n\n```\nError: boom\n```'
        );
        assert.equal(mod.pushFailureComment('main', new Error('bad')), 'Push to main failed: Error: bad');
        assert.deepEqual(
            mod.buildDirectPushContext(directPushConfig(), {}),
            {
                workingDir: null,
                trackerParams: directPushConfig().customParams,
                baseBranch: 'main',
                opts: opts
            }
        );
        assert.equal(mod.resolveTicketKey({ ticket: { key: 'TS-16' } }), 'TS-16');
        assert.ok(!mod.resolveTicketKey({}), 'no ticket anywhere → falsy (null or undefined)');
        assert.deepEqual(mod.buildCmdOpts(null), {});
        assert.deepEqual(mod.buildCmdOpts('/w'), { workingDirectory: '/w' });
    });
});
