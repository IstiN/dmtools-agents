/**
 * Unit tests for js/common/submodules.js
 */

function loadSubmoduleHelper() {
    return loadModule('js/common/submodules.js');
}

suite('submodule helper', function() {

    test('normalizes and deduplicates managed submodule config', function() {
        var helper = loadSubmoduleHelper();
        var modules = helper.collectManagedSubmodules(
            { git: { managedSubmodules: [{ path: 123, branch: 456, commitMessage: 789, tagPrefix: 'stable' }] } },
            { managedSubmodules: ['trackstate-setup', { path: 'trackstate-setup', branch: 'main' }] }
        );

        assert.deepEqual(modules, [
            { path: 'trackstate-setup' },
            { path: '123', branch: '456', commitMessage: '789', tagPrefix: 'stable' }
        ]);
    });

    test('rejects dot and dot-prefixed managed submodule paths', function() {
        var helper = loadSubmoduleHelper();

        assert.equal(helper.isSafeRelativePath('trackstate-setup'), true);
        assert.equal(helper.isSafeRelativePath('.'), false);
        assert.equal(helper.isSafeRelativePath('.git'), false);
        assert.equal(helper.isSafeRelativePath('safe/.git'), false);
        assert.equal(helper.isSafeRelativePath('../outside'), false);
    });

    test('commits dirty submodule then pushes it', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            config: {
                git: {
                    authorName: 'AI Teammate',
                    authorEmail: 'agent@example.com'
                }
            },
            customParams: {
                managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }]
            },
            ticketKey: 'TS-23',
            cleanOutput: function(output) { return output || ''; },
            run: function(command) {
                commands.push(command);
                if (command.indexOf('git config --file .gitmodules --get-regexp') === 0) {
                    return 'submodule.trackstate-setup.path trackstate-setup';
                }
                if (command === 'git -C trackstate-setup status --porcelain') {
                    return ' M README.md';
                }
                if (command === 'git -C trackstate-setup rev-list --count origin/main..HEAD') {
                    return '0';
                }
                return '';
            }
        });

        assert.ok(commands.indexOf('git -C trackstate-setup stash push -u -m "dmtools managed submodule changes"') !== -1, 'dirty submodule changes should be stashed before branch alignment');
        assert.ok(commands.indexOf('git -C trackstate-setup checkout -B main origin/main') !== -1, 'dirty submodule should be moved onto the latest remote branch');
        assert.ok(commands.indexOf('git -C trackstate-setup rebase origin/main') === -1, 'dirty submodule should not rebase stale checked-out gitlink commits');
        assert.ok(commands.indexOf('git -C trackstate-setup stash pop') !== -1, 'dirty submodule changes should be restored after branch alignment');
        assert.ok(commands.indexOf('git -C trackstate-setup add .') !== -1, 'dirty submodule should be staged');
        assert.ok(commands.some(function(command) {
            return command.indexOf('git -C trackstate-setup commit -m "TS-23 Update trackstate-setup assets"') === 0;
        }), 'dirty submodule should be committed');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1, 'submodule should be pushed');
    });

    test('publishes stable tag when tag prefix is configured', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: {
                managedSubmodules: [{ path: 'trackstate-setup', branch: 'main', tagPrefix: 'stable' }]
            },
            ticketKey: 'TS-86',
            cleanOutput: function(output) { return output || ''; },
            run: function(command) {
                commands.push(command);
                if (command.indexOf('git config --file .gitmodules --get-regexp') === 0) {
                    return 'submodule.trackstate-setup.path trackstate-setup';
                }
                if (command === 'git -C trackstate-setup status --porcelain') {
                    return '';
                }
                if (command === 'git -C trackstate-setup rev-list --count origin/main..HEAD') {
                    return '2';
                }
                if (command === 'git -C trackstate-setup rev-parse HEAD') {
                    return 'head-sha';
                }
                if (command === 'git -C trackstate-setup rev-parse origin/main') {
                    return 'base-sha';
                }
                if (command === 'git -C trackstate-setup rev-list -1 head-sha --not base-sha') {
                    return 'head-sha';
                }
                if (command === 'git -C trackstate-setup rev-list -1 base-sha --not head-sha') {
                    return '';
                }
                if (command === 'git -C trackstate-setup rev-parse --short=12 HEAD') {
                    return '2b4b84712bfa';
                }
                return '';
            }
        });

        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1, 'submodule should be pushed');
        assert.ok(commands.indexOf('git -C trackstate-setup tag -f stable-2b4b84712bfa HEAD') !== -1, 'stable tag should be created at HEAD');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin refs/tags/stable-2b4b84712bfa:refs/tags/stable-2b4b84712bfa --force') !== -1, 'stable tag should be pushed');
    });

    test('pushes clean submodule when HEAD is ahead of remote', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: {
                managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }]
            },
            ticketKey: 'TS-23',
            cleanOutput: function(output) { return output || ''; },
            run: function(command) {
                commands.push(command);
                if (command.indexOf('git config --file .gitmodules --get-regexp') === 0) {
                    return 'submodule.trackstate-setup.path trackstate-setup';
                }
                if (command === 'git -C trackstate-setup status --porcelain') {
                    return '';
                }
                if (command === 'git -C trackstate-setup rev-list --count origin/main..HEAD') {
                    return '2';
                }
                if (command === 'git -C trackstate-setup rev-parse HEAD') {
                    return 'head-sha';
                }
                if (command === 'git -C trackstate-setup rev-parse origin/main') {
                    return 'base-sha';
                }
                if (command === 'git -C trackstate-setup rev-list -1 head-sha --not base-sha') {
                    return 'head-sha';
                }
                if (command === 'git -C trackstate-setup rev-list -1 base-sha --not head-sha') {
                    return '';
                }
                return '';
            }
        });

        assert.ok(commands.indexOf('git -C trackstate-setup checkout -B main HEAD') !== -1, 'clean ahead submodule should be moved onto a local branch');
        assert.ok(commands.indexOf('git -C trackstate-setup rebase origin/main') === -1, 'clean linear-ahead submodule should push without a conflict-prone rebase');
        assert.ok(commands.indexOf('git -C trackstate-setup add .') === -1, 'clean ahead submodule should not be staged');
        assert.ok(commands.every(function(command) {
            return command.indexOf('git -C trackstate-setup commit -m') === -1;
        }), 'clean ahead submodule should not create another commit');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1, 'ahead submodule should be pushed');
    });

    test('does not reuse stale dirty status after stash pop leaves tree clean', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        var statusCalls = 0;
        helper.pushManagedSubmodules({
            customParams: {
                managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }]
            },
            ticketKey: 'TS-23',
            cleanOutput: function(output) { return output || ''; },
            run: function(command) {
                commands.push(command);
                if (command.indexOf('git config --file .gitmodules --get-regexp') === 0) {
                    return 'submodule.trackstate-setup.path trackstate-setup';
                }
                if (command === 'git -C trackstate-setup status --porcelain') {
                    statusCalls++;
                    return statusCalls === 1 ? ' M README.md' : '';
                }
                if (command === 'git -C trackstate-setup rev-list --count origin/main..HEAD') {
                    return '0';
                }
                return '';
            }
        });

        assert.ok(commands.indexOf('git -C trackstate-setup add .') === -1, 'clean tree after stash pop should not be staged');
        assert.ok(commands.every(function(command) {
            return command.indexOf('git -C trackstate-setup commit -m') === -1;
        }), 'clean tree after stash pop should not be committed');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1, 'submodule should still be pushed');
    });

    test('skips clean divergent submodule instead of rebasing stale gitlink commits', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: {
                managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }]
            },
            ticketKey: 'TS-23',
            cleanOutput: function(output) { return output || ''; },
            run: function(command) {
                commands.push(command);
                if (command.indexOf('git config --file .gitmodules --get-regexp') === 0) {
                    return 'submodule.trackstate-setup.path trackstate-setup';
                }
                if (command === 'git -C trackstate-setup status --porcelain') {
                    return '';
                }
                if (command === 'git -C trackstate-setup rev-list --count origin/main..HEAD') {
                    return '1';
                }
                if (command === 'git -C trackstate-setup rev-parse HEAD') {
                    return 'head-sha';
                }
                if (command === 'git -C trackstate-setup rev-parse origin/main') {
                    return 'base-sha';
                }
                if (command === 'git -C trackstate-setup rev-list -1 head-sha --not base-sha') return 'head-sha';
                if (command === 'git -C trackstate-setup rev-list -1 base-sha --not head-sha') return 'base-sha';
                return '';
            }
        });

        assert.ok(commands.indexOf('git -C trackstate-setup rebase origin/main') === -1, 'divergent stale gitlink should not be rebased');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') === -1, 'divergent clean gitlink should not be pushed');
        assert.ok(commands.indexOf('git -C trackstate-setup checkout -B main HEAD') === -1, 'divergent clean gitlink should not rewrite branch');
        assert.ok(commands.indexOf('git -C trackstate-setup merge-base HEAD origin/main') === -1, 'expected non-ancestor checks must not call raw merge-base through error-logging command executor');
        assert.ok(commands.indexOf('git -C trackstate-setup rev-list -1 head-sha --not base-sha') !== -1, 'expected non-ancestor checks should use exit-zero rev-list containment check');
    });

    test('restores stashed dirty changes when branch alignment fails', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];

        assert.throws(function() {
            helper.pushManagedSubmodules({
                customParams: {
                    managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }]
                },
                ticketKey: 'TS-23',
                cleanOutput: function(output) { return output || ''; },
                run: function(command) {
                    commands.push(command);
                    if (command.indexOf('git config --file .gitmodules --get-regexp') === 0) {
                        return 'submodule.trackstate-setup.path trackstate-setup';
                    }
                    if (command === 'git -C trackstate-setup status --porcelain') {
                        return ' M README.md';
                    }
                    if (command === 'git -C trackstate-setup rev-list --count origin/main..HEAD') {
                        return '0';
                    }
                    if (command === 'git -C trackstate-setup checkout -B main origin/main') {
                        throw new Error('checkout failed');
                    }
                    return '';
                }
            });
        }, 'branch alignment failure should be propagated');

        assert.ok(commands.indexOf('git -C trackstate-setup stash push -u -m "dmtools managed submodule changes"') !== -1, 'dirty changes should be stashed before branch alignment');
        assert.ok(commands.indexOf('git -C trackstate-setup stash pop') !== -1, 'dirty changes should be restored after branch alignment failure');
    });

    test('accepts stashed agent changes when stash pop conflicts after branch alignment', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: {
                managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }]
            },
            ticketKey: 'TS-76',
            cleanOutput: function(output) { return output || ''; },
            run: function(command) {
                commands.push(command);
                if (command.indexOf('git config --file .gitmodules --get-regexp') === 0) {
                    return 'submodule.trackstate-setup.path trackstate-setup';
                }
                if (command === 'git -C trackstate-setup status --porcelain') {
                    return ' M README.md';
                }
                if (command === 'git -C trackstate-setup rev-list --count origin/main..HEAD') {
                    return '0';
                }
                if (command === 'git -C trackstate-setup stash pop') {
                    throw new Error('CONFLICT (content): Merge conflict in README.md');
                }
                if (command === 'git -C trackstate-setup diff --name-only --diff-filter=U') {
                    return 'README.md';
                }
                return '';
            }
        });

        assert.ok(commands.indexOf('git -C trackstate-setup checkout --theirs -- README.md') !== -1, 'stash conflict should accept stashed agent README changes');
        assert.ok(commands.indexOf('git -C trackstate-setup add README.md') !== -1, 'resolved stash conflict should be staged');
        assert.ok(commands.indexOf('git -C trackstate-setup stash drop') !== -1, 'resolved failed stash pop should drop the consumed stash');
        assert.ok(commands.some(function(command) {
            return command.indexOf('git -C trackstate-setup commit -m "TS-76 Update trackstate-setup assets"') === 0;
        }), 'resolved submodule changes should be committed');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1, 'resolved submodule should be pushed');
    });

    test('rejects unregistered managed submodule paths', function() {
        var helper = loadSubmoduleHelper();

        assert.throws(function() {
            helper.pushManagedSubmodules({
                customParams: { managedSubmodules: ['not-a-submodule'] },
                run: function(command) {
                    if (command.indexOf('git config --file .gitmodules --get-regexp') === 0) {
                        return 'submodule.trackstate-setup.path trackstate-setup';
                    }
                    return '';
                }
            });
        }, 'unregistered paths should be rejected');
    });

    // ── gh-1041: branch characterization for the publish decision paths ─────

    function makeRun(commands, responses) {
        return function(command) {
            commands.push(command);
            for (var i = 0; i < responses.length; i++) {
                if (responses[i].match instanceof RegExp ? responses[i].match.test(command) : command === responses[i].match) {
                    if (responses[i].throwError) throw new Error(responses[i].throwError);
                    return responses[i].returnValue;
                }
            }
            return '';
        };
    }

    function gitmodulesRegistered(path) {
        return { match: /^git config --file \.gitmodules/, returnValue: 'submodule.' + path + '.path ' + path };
    }

    test('rejects unsafe managed submodule paths', function() {
        var helper = loadSubmoduleHelper();

        assert.throws(function() {
            helper.pushManagedSubmodules({
                customParams: { managedSubmodules: ['../outside'] },
                run: function() { return ''; }
            });
        }, 'unsafe paths should be rejected');
    });

    test('rejects unsafe managed submodule branch names', function() {
        var helper = loadSubmoduleHelper();

        assert.throws(function() {
            helper.pushManagedSubmodules({
                customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: '-bad branch' }] },
                run: function() { return ''; }
            });
        }, 'unsafe branch names should be rejected');
    });

    test('rejects unsafe managed submodule tag prefixes', function() {
        var helper = loadSubmoduleHelper();

        assert.throws(function() {
            helper.pushManagedSubmodules({
                customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main', tagPrefix: '-bad' }] },
                run: function() { return ''; }
            });
        }, 'unsafe tag prefixes should be rejected');
    });

    test('tolerates a failing fetch of the managed submodule branch', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }] },
            cleanOutput: function(output) { return output || ''; },
            run: makeRun(commands, [
                gitmodulesRegistered('trackstate-setup'),
                { match: /^git -C trackstate-setup fetch origin main$/, throwError: 'network down' },
                { match: /^git -C trackstate-setup status --porcelain$/, returnValue: '' },
                { match: /^git -C trackstate-setup rev-list --count/, returnValue: '0' }
            ])
        });

        assert.ok(commands.indexOf('git -C trackstate-setup fetch origin main') !== -1, 'fetch attempted even though it fails');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') === -1, 'nothing to push when clean and not ahead');
    });

    test('tolerates a failing ahead-count probe and treats it as zero ahead', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }] },
            cleanOutput: function(output) { return output || ''; },
            run: makeRun(commands, [
                gitmodulesRegistered('trackstate-setup'),
                { match: /^git -C trackstate-setup status --porcelain$/, returnValue: ' M README.md' },
                { match: /^git -C trackstate-setup rev-list --count/, throwError: 'unknown revision' }
            ])
        });

        assert.ok(commands.some(function(command) {
            return command.indexOf('git -C trackstate-setup commit -m "Agent Update trackstate-setup assets"') === 0;
        }), 'default Agent ticket key is used when none is configured');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1, 'dirty submodule still published');
    });

    test('skips a clean submodule that is not ahead and has no dirty changes', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }] },
            cleanOutput: function(output) { return output || ''; },
            run: makeRun(commands, [
                gitmodulesRegistered('trackstate-setup'),
                { match: /^git -C trackstate-setup status --porcelain$/, returnValue: '' },
                { match: /^git -C trackstate-setup rev-list --count/, returnValue: '0' }
            ])
        });

        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') === -1, 'clean, non-ahead submodule is not pushed');
        assert.ok(commands.every(function(command) {
            return command.indexOf('rev-parse') === -1;
        }), 'ancestor probes are skipped entirely when nothing changed');
    });

    test('skips a clean submodule whose HEAD is already included in the remote branch', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }] },
            cleanOutput: function(output) { return output || ''; },
            run: makeRun(commands, [
                gitmodulesRegistered('trackstate-setup'),
                { match: /^git -C trackstate-setup status --porcelain$/, returnValue: '' },
                { match: /^git -C trackstate-setup rev-list --count/, returnValue: '3' },
                { match: /^git -C trackstate-setup rev-parse HEAD$/, returnValue: 'head-sha' },
                { match: /^git -C trackstate-setup rev-parse origin\/main$/, returnValue: 'base-sha' },
                { match: /^git -C trackstate-setup rev-list -1 head-sha --not base-sha$/, returnValue: '' },
                { match: /^git -C trackstate-setup rev-list -1 base-sha --not head-sha$/, returnValue: 'base-sha' }
            ])
        });

        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') === -1, 'HEAD already on the remote — nothing to publish');
        assert.ok(commands.indexOf('git -C trackstate-setup checkout -B main HEAD') === -1, 'branch is not rewritten when skipping');
    });

    test('skips publishing when staging produced no committable changes', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        var statusCalls = 0;
        helper.pushManagedSubmodules({
            customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }] },
            cleanOutput: function(output) { return output || ''; },
            run: function(command) {
                commands.push(command);
                if (command.indexOf('git config --file .gitmodules') === 0) {
                    return 'submodule.trackstate-setup.path trackstate-setup';
                }
                if (command === 'git -C trackstate-setup status --porcelain') {
                    statusCalls++;
                    // #1 initial read: dirty; #2 after stash pop: still dirty;
                    // #3 staged read after `add .`: clean (nothing committable)
                    return statusCalls === 3 ? '' : ' M README.md';
                }
                if (command.indexOf('rev-list --count') === 0) return '0';
                return '';
            }
        });

        assert.ok(commands.indexOf('git -C trackstate-setup add .') !== -1, 'dirty changes staged');
        assert.ok(commands.every(function(command) {
            return command.indexOf('commit -m') === -1;
        }), 'no commit when staging left nothing committable');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1, 'submodule still pushed');
    });

    test('uses the configured commit message when publishing dirty changes', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main', commitMessage: 'Release assets' }] },
            ticketKey: 'TS-99',
            cleanOutput: function(output) { return output || ''; },
            run: makeRun(commands, [
                gitmodulesRegistered('trackstate-setup'),
                { match: /^git -C trackstate-setup status --porcelain$/, returnValue: ' M README.md' },
                { match: /^git -C trackstate-setup rev-list --count/, returnValue: '0' }
            ])
        });

        assert.ok(commands.some(function(command) {
            return command.indexOf('git -C trackstate-setup commit -m "Release assets"') === 0;
        }), 'module commit message wins over the ticket-derived default');
    });

    test('throws when the submodule HEAD cannot be resolved for tag publishing', function() {
        var helper = loadSubmoduleHelper();

        assert.throws(function() {
            helper.pushManagedSubmodules({
                customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main', tagPrefix: 'stable' }] },
                cleanOutput: function(output) { return output || ''; },
                run: makeRun([], [
                    gitmodulesRegistered('trackstate-setup'),
                    { match: /^git -C trackstate-setup status --porcelain$/, returnValue: ' M README.md' },
                    { match: /^git -C trackstate-setup rev-list --count/, returnValue: '0' },
                    { match: /^git -C trackstate-setup rev-parse --short=12 HEAD$/, returnValue: '' }
                ])
            });
        }, 'unresolvable HEAD aborts tag publishing');
    });

    test('rejects an unsafe computed tag name', function() {
        var helper = loadSubmoduleHelper();

        assert.throws(function() {
            helper.pushManagedSubmodules({
                customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main', tagPrefix: 'stable' }] },
                cleanOutput: function(output) { return output || ''; },
                run: makeRun([], [
                    gitmodulesRegistered('trackstate-setup'),
                    { match: /^git -C trackstate-setup status --porcelain$/, returnValue: ' M README.md' },
                    { match: /^git -C trackstate-setup rev-list --count/, returnValue: '0' },
                    { match: /^git -C trackstate-setup rev-parse --short=12 HEAD$/, returnValue: 'bad sha with spaces' }
                ])
            });
        }, 'unsafe computed tag name is rejected before tagging');
    });

    test('processes every managed submodule in order', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: { managedSubmodules: ['mod-a', 'mod-b'] },
            cleanOutput: function(output) { return output || ''; },
            run: makeRun(commands, [
                { match: /^git config --file \.gitmodules/, returnValue: 'submodule.mod-a.path mod-a\nsubmodule.mod-b.path mod-b' },
                { match: /^git -C mod-a status --porcelain$/, returnValue: ' M a.txt' },
                { match: /^git -C mod-b status --porcelain$/, returnValue: ' M b.txt' },
                { match: /^git -C mod-a rev-list --count/, returnValue: '0' },
                { match: /^git -C mod-b rev-list --count/, returnValue: '0' }
            ])
        });

        var aPush = -1, bPush = -1;
        commands.forEach(function(command, index) {
            if (command === 'git -C mod-a push origin HEAD:main') aPush = index;
            if (command === 'git -C mod-b push origin HEAD:main') bPush = index;
        });
        assert.ok(aPush !== -1 && bPush !== -1, 'both submodules published');
        assert.ok(aPush < bPush, 'submodules processed in config order');
    });

    test('drops submodule config entries without a path', function() {
        var helper = loadSubmoduleHelper();
        var modules = helper.collectManagedSubmodules({}, {
            managedSubmodules: [{ noPath: true }, 'plain-path']
        });

        assert.deepEqual(modules, [{ path: 'plain-path' }], 'path-less entries are ignored, not coerced');
    });

    // ── gh-1226 characterization: resolveStashPopConflicts exit paths ────────

    // Conflicted stash-pop harness: the publish probe reads a dirty tree, the
    // pop itself conflicts, and every later `status --porcelain` is answered
    // from `statusSequence` in order (default: clean after the failed pop).
    function stashPopConflictRun(commands, responses, statusSequence) {
        var statusCalls = 0;
        var statuses = statusSequence || [' M README.md', ''];
        return function(command) {
            commands.push(command);
            if (/^git config --file \.gitmodules/.test(command)) {
                return 'submodule.trackstate-setup.path trackstate-setup';
            }
            if (/^git -C trackstate-setup status --porcelain$/.test(command)) {
                var value = statuses[Math.min(statusCalls, statuses.length - 1)];
                statusCalls++;
                return value;
            }
            if (/^git -C trackstate-setup rev-list --count/.test(command)) return '0';
            if (/^git -C trackstate-setup stash pop$/.test(command)) {
                throw new Error('CONFLICT (content): Merge conflict in README.md');
            }
            for (var i = 0; i < (responses || []).length; i++) {
                if (responses[i].match.test(command)) return responses[i].returnValue;
            }
            return '';
        };
    }

    test('copies targetBranch like branch onto the managed module spec', function() {
        var helper = loadSubmoduleHelper();
        var modules = helper.collectManagedSubmodules({}, {
            managedSubmodules: [{ path: 'trackstate-setup', targetBranch: 'release' }]
        });

        assert.deepEqual(modules, [{ path: 'trackstate-setup', targetBranch: 'release' }],
            'targetBranch is a first-class publish branch override');
    });

    test('a conflicted stash pop with a clean tree drops the stash and publishes nothing dirty', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        helper.pushManagedSubmodules({
            customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }] },
            ticketKey: 'TS-23',
            cleanOutput: function(output) { return output || ''; },
            run: stashPopConflictRun(commands, [
                // No unmerged paths and an EMPTY status after the failed pop.
                { match: /^git -C trackstate-setup diff --name-only --diff-filter=U$/, returnValue: '' },
                { match: /^git -C trackstate-setup stash drop$/, returnValue: '' }
            ])
        });

        var drops = commands.filter(function(command) {
            return command === 'git -C trackstate-setup stash drop';
        });
        assert.ok(drops.length >= 1, 'the consumed stash is dropped');
        assert.ok(commands.every(function(command) {
            return command.indexOf('checkout --theirs') === -1;
        }), 'no conflicted files → no --theirs checkout');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1,
            'the aligned branch is still published');
    });

    test('a conflicted stash pop without conflicts but a dirty status is a loud failure', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        var err = null;
        try {
            helper.pushManagedSubmodules({
                customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }] },
                ticketKey: 'TS-23',
                cleanOutput: function(output) { return output || ''; },
                run: stashPopConflictRun(commands, [
                    { match: /^git -C trackstate-setup diff --name-only --diff-filter=U$/, returnValue: '' }
                ], [' M README.md', ' M README.md'])
            });
        } catch (e) { err = e; }

        assert.ok(err, 'an unexplained dirty tree after a failed pop must throw');
        assert.contains(err.message, 'Managed submodule stash pop failed without merge conflicts');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') === -1,
            'nothing is pushed when the conflict resolution cannot explain the tree');
    });

    test('an unsafe conflicted file path is rejected before any checkout', function() {
        var helper = loadSubmoduleHelper();
        var commands = [];
        var err = null;
        try {
            helper.pushManagedSubmodules({
                customParams: { managedSubmodules: [{ path: 'trackstate-setup', branch: 'main' }] },
                ticketKey: 'TS-23',
                cleanOutput: function(output) { return output || ''; },
                run: stashPopConflictRun(commands, [
                    { match: /^git -C trackstate-setup diff --name-only --diff-filter=U$/, returnValue: '../outside' }
                ])
            });
        } catch (e) { err = e; }

        assert.ok(err, 'an unsafe conflicted path must throw');
        assert.contains(err.message, 'Unsafe conflicted managed submodule file path');
        assert.ok(commands.every(function(command) {
            return command.indexOf('checkout --theirs') === -1;
        }), 'the unsafe path is never handed to git checkout');
    });

});
