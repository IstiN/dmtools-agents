/**
 * Unit tests for agents/js/common/submodules.js
 */

function loadSubmoduleHelper() {
    return loadModule('agents/js/common/submodules.js');
}

suite('submodule helper', function() {

    test('normalizes and deduplicates managed submodule config', function() {
        var helper = loadSubmoduleHelper();
        var modules = helper.collectManagedSubmodules(
            { git: { managedSubmodules: [{ path: 123, branch: 456, commitMessage: 789 }] } },
            { managedSubmodules: ['trackstate-setup', { path: 'trackstate-setup', branch: 'main' }] }
        );

        assert.deepEqual(modules, [
            { path: 'trackstate-setup' },
            { path: '123', branch: '456', commitMessage: '789' }
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

        assert.ok(commands.indexOf('git -C trackstate-setup add .') !== -1, 'dirty submodule should be staged');
        assert.ok(commands.some(function(command) {
            return command.indexOf('git -C trackstate-setup commit -m "TS-23 Update trackstate-setup assets"') === 0;
        }), 'dirty submodule should be committed');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1, 'submodule should be pushed');
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
                return '';
            }
        });

        assert.ok(commands.indexOf('git -C trackstate-setup add .') === -1, 'clean ahead submodule should not be staged');
        assert.ok(commands.every(function(command) {
            return command.indexOf('git -C trackstate-setup commit -m') === -1;
        }), 'clean ahead submodule should not create another commit');
        assert.ok(commands.indexOf('git -C trackstate-setup push origin HEAD:main') !== -1, 'ahead submodule should be pushed');
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
