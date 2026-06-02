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
                if (command === 'bash -lc "git -C trackstate-setup merge-base HEAD origin/main 2>/dev/null || true"') {
                    return 'old-sha';
                }
                if (command === 'bash -lc "git -C trackstate-setup merge-base origin/main HEAD 2>/dev/null || true"') {
                    return 'base-sha';
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
                if (command === 'bash -lc "git -C trackstate-setup merge-base HEAD origin/main 2>/dev/null || true"') {
                    return 'old-sha';
                }
                if (command === 'bash -lc "git -C trackstate-setup merge-base origin/main HEAD 2>/dev/null || true"') {
                    return 'base-sha';
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
                if (command === 'bash -lc "git -C trackstate-setup merge-base HEAD origin/main 2>/dev/null || true"') return '';
                return '';
            }
        });

        assert.ok(commands.indexOf('git -C trackstate-setup rebase origin/main') === -1, 'divergent stale gitlink should not be rebased');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') === -1, 'divergent clean gitlink should not be pushed');
        assert.ok(commands.indexOf('git -C trackstate-setup checkout -B main HEAD') === -1, 'divergent clean gitlink should not rewrite branch');
        assert.ok(commands.indexOf('git -C trackstate-setup merge-base HEAD origin/main') === -1, 'expected non-ancestor checks must not call raw merge-base through error-logging command executor');
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

});
