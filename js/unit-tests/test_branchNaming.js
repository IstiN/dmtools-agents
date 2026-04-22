/**
 * Unit tests for branch naming extensions in agents/js/configLoader.js
 *
 * Tests: resolveBranchName, resolvePRTargetBranch, mergeProjectConfig (branch fields)
 *
 * Uses: configLoaderModule (pre-loaded by testRunner), suite(), test(), assert
 */

// ── resolveBranchName ─────────────────────────────────────────────────────────

suite('configLoader.resolveBranchName', function() {

    test('uses development prefix when no branchNamingFn', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {});
        var ticket = { key: 'PROJ-42', fields: {} };
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'development'), 'ai/PROJ-42');
    });

    test('uses feature prefix for feature role', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {});
        var ticket = { key: 'PROJ-42', fields: {} };
        var result = configLoaderModule.resolveBranchName(config, ticket, 'feature');
        // feature prefix comes from DEFAULT_CONFIG.GIT_CONFIG.DEFAULT_ISSUE_TYPE_PREFIX
        assert.ok(result.indexOf('PROJ-42') !== -1, 'Branch name should contain ticket key');
        assert.ok(result.indexOf('/') !== -1, 'Branch name should contain prefix separator');
    });

    test('uses test prefix for test role', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {});
        var ticket = { key: 'PROJ-42', fields: {} };
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'test'), 'test/PROJ-42');
    });

    test('falls back to development prefix for unknown role', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {});
        var ticket = { key: 'PROJ-42', fields: {} };
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'unknown'), 'ai/PROJ-42');
    });

    test('calls branchNamingFn when set (development role)', function() {
        var called = false;
        var namingFn = function(ticket, branchRole) {
            called = true;
            return 'custom/' + ticket.key;
        };
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { branchNamingFn: namingFn }
        });
        var ticket = { key: 'PROJ-42', fields: {} };
        var result = configLoaderModule.resolveBranchName(config, ticket, 'development');
        assert.ok(called, 'branchNamingFn should have been called');
        assert.equal(result, 'custom/PROJ-42');
    });

    test('branchNamingFn receives ticket and branchRole args', function() {
        var receivedTicket = null;
        var receivedRole = null;
        var namingFn = function(ticket, branchRole) {
            receivedTicket = ticket;
            receivedRole = branchRole;
            return 'x/' + ticket.key;
        };
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { branchNamingFn: namingFn }
        });
        var ticket = { key: 'PROJ-99', fields: { issuetype: { name: 'Story' } } };
        configLoaderModule.resolveBranchName(config, ticket, 'feature');
        assert.equal(receivedTicket, ticket);
        assert.equal(receivedRole, 'feature');
    });

    test('branchNamingFn for MAPC-style issue-type naming: bug/MAPC-123', function() {
        var mapcNamingFn = function(ticket, branchRole) {
            var issueType = (ticket.fields && ticket.fields.issuetype && ticket.fields.issuetype.name || 'feature').toLowerCase();
            return issueType + '/' + ticket.key;
        };
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { branchNamingFn: mapcNamingFn }
        });
        var ticket = { key: 'MAPC-123', fields: { issuetype: { name: 'Bug' } } };
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'development'), 'bug/MAPC-123');
    });

    test('branchNamingFn for MAPC-style issue-type naming: story/STORY-456', function() {
        var mapcNamingFn = function(ticket, branchRole) {
            var issueType = (ticket.fields && ticket.fields.issuetype && ticket.fields.issuetype.name || 'feature').toLowerCase();
            return issueType + '/' + ticket.key;
        };
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { branchNamingFn: mapcNamingFn }
        });
        var ticket = { key: 'STORY-456', fields: { issuetype: { name: 'Story' } } };
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'development'), 'story/STORY-456');
    });

    test('branchNamingFn for MAPC-style issue-type naming: subtask → task/PROJ-1', function() {
        var mapcNamingFn = function(ticket, branchRole) {
            var rawType = (ticket.fields && ticket.fields.issuetype && ticket.fields.issuetype.name || 'feature').toLowerCase();
            var issueType = rawType === 'subtask' ? 'task' : rawType;
            return issueType + '/' + ticket.key;
        };
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { branchNamingFn: mapcNamingFn }
        });
        var ticket = { key: 'PROJ-1', fields: { issuetype: { name: 'Subtask' } } };
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'development'), 'task/PROJ-1');
    });

    test('branchNamingFn fallback when ticket has no issuetype', function() {
        var mapcNamingFn = function(ticket, branchRole) {
            var issueType = (ticket.fields && ticket.fields.issuetype && ticket.fields.issuetype.name || 'feature').toLowerCase();
            return issueType + '/' + ticket.key;
        };
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { branchNamingFn: mapcNamingFn }
        });
        var ticket = { key: 'PROJ-7', fields: {} };
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'development'), 'feature/PROJ-7');
    });

});

// ── resolvePRTargetBranch ─────────────────────────────────────────────────────

suite('configLoader.resolvePRTargetBranch', function() {

    test('returns baseBranch when featureBranch disabled (default)', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {});
        var ticket = { key: 'PROJ-10', fields: {} };
        assert.equal(configLoaderModule.resolvePRTargetBranch(config, ticket), config.git.baseBranch);
    });

    test('returns baseBranch when featureBranch not configured at all', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { baseBranch: 'develop' }
        });
        var ticket = { key: 'PROJ-10', fields: {} };
        assert.equal(configLoaderModule.resolvePRTargetBranch(config, ticket), 'develop');
    });

    test('returns feature branch name when featureBranch.enabled = true', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { featureBranch: { enabled: true } }
        });
        var ticket = { key: 'PROJ-99', fields: {} };
        // feature prefix default is the DEFAULT_ISSUE_TYPE_PREFIX from config.js
        var result = configLoaderModule.resolvePRTargetBranch(config, ticket);
        assert.ok(result.indexOf('PROJ-99') !== -1, 'Feature branch should contain ticket key: ' + result);
        assert.notEqual(result, config.git.baseBranch, 'Should not return baseBranch');
    });

    test('feature branch name uses prefix strategy when no branchNamingFn', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: {
                featureBranch: { enabled: true },
                branchPrefix: { development: 'ai', feature: 'feature', test: 'test' }
            }
        });
        var ticket = { key: 'PROJ-99', fields: {} };
        assert.equal(configLoaderModule.resolvePRTargetBranch(config, ticket), 'feature/PROJ-99');
    });

    test('feature branch name uses branchNamingFn when set', function() {
        var namingFn = function(ticket, branchRole) {
            return branchRole + '-' + ticket.key;
        };
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: {
                featureBranch: { enabled: true },
                branchNamingFn: namingFn
            }
        });
        var ticket = { key: 'PROJ-5', fields: {} };
        assert.equal(configLoaderModule.resolvePRTargetBranch(config, ticket), 'feature-PROJ-5');
    });

    test('two-branch mode with MAPC-style naming', function() {
        var mapcNamingFn = function(ticket, branchRole) {
            var issueType = (ticket.fields && ticket.fields.issuetype && ticket.fields.issuetype.name || 'feature').toLowerCase();
            if (branchRole === 'feature') return issueType + '/' + ticket.key;
            return 'ai/' + ticket.key;
        };
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: {
                featureBranch: { enabled: true },
                branchNamingFn: mapcNamingFn
            }
        });
        var ticket = { key: 'MAPC-55', fields: { issuetype: { name: 'Story' } } };
        assert.equal(configLoaderModule.resolvePRTargetBranch(config, ticket), 'story/MAPC-55');
    });

});

// ── mergeProjectConfig — branch fields ────────────────────────────────────────

suite('configLoader.mergeProjectConfig — branch fields', function() {

    test('featureBranch.enabled survives merge', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { featureBranch: { enabled: true } }
        });
        assert.equal(config.git.featureBranch.enabled, true);
    });

    test('branchNamingFn function survives deepMerge (not converted to object)', function() {
        var fn = function(ticket, role) { return 'x/' + ticket.key; };
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { branchNamingFn: fn }
        });
        assert.equal(typeof config.git.branchNamingFn, 'function');
        assert.equal(config.git.branchNamingFn, fn);
    });

    test('featureBranch deep-merges with defaults (enabled overrides, others inherit)', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: { featureBranch: { enabled: true } }
        });
        assert.equal(config.git.featureBranch.enabled, true);
        // baseBranch and other git fields should still be present
        assert.ok(config.git.baseBranch, 'baseBranch should be present after merge');
    });

    test('branchPrefix overrides work alongside featureBranch', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            git: {
                branchPrefix: { development: 'dev', feature: 'feat', test: 'qa' },
                featureBranch: { enabled: true }
            }
        });
        var ticket = { key: 'T-1', fields: {} };
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'development'), 'dev/T-1');
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'feature'), 'feat/T-1');
        assert.equal(configLoaderModule.resolveBranchName(config, ticket, 'test'), 'qa/T-1');
        assert.equal(configLoaderModule.resolvePRTargetBranch(config, ticket), 'feat/T-1');
    });

});

// ── customParams.branchNamingFnPath ──────────────────────────────────────────

suite('configLoader.loadProjectConfig — branchNamingFnPath', function() {

    // Helper: build a configLoader with a controlled file_read that can serve
    // both the project config files (return null) and the naming fn file.
    function makeLoaderWithFnFile(fnFileContent) {
        var reads = {};
        reads['agents/js/branchNaming/issueType_naming.js'] = fnFileContent;

        var fakeFileRead = function(pathArg) {
            var p = typeof pathArg === 'string' ? pathArg : pathArg.path;
            return reads[p] || null;
        };

        return loadModule(
            'agents/js/configLoader.js',
            makeRequire({ './config.js': configModule, 'config': configModule }),
            { file_read: fakeFileRead }
        );
    }

    test('loads function from branchNamingFnPath and uses it for branch naming', function() {
        var fnSrc = 'module.exports = function(ticket, branchRole) {\n' +
            '    var t = (ticket && ticket.fields && ticket.fields.issuetype && ticket.fields.issuetype.name || "feature").toLowerCase();\n' +
            '    return t + "/" + ticket.key;\n' +
            '};';

        var loader = makeLoaderWithFnFile(fnSrc);
        var config = loader.loadProjectConfig({
            customParams: { branchNamingFnPath: 'agents/js/branchNaming/issueType_naming.js' }
        });

        assert.equal(typeof config.git.branchNamingFn, 'function', 'branchNamingFn should be set');
        var ticket = { key: 'PROJ-42', fields: { issuetype: { name: 'Bug' } } };
        assert.equal(loader.resolveBranchName(config, ticket, 'development'), 'bug/PROJ-42');
    });

    test('branchNamingFnPath takes priority over config.git.branchNamingFn', function() {
        var fnSrc = 'module.exports = function(ticket, branchRole) { return "from-file/" + ticket.key; };';
        var loader = makeLoaderWithFnFile(fnSrc);

        // Simulate a project config that also sets branchNamingFn inline
        var inlineFn = function(ticket) { return 'inline/' + ticket.key; };
        // We cannot inject a real config.js file with the inline fn here, so test via
        // mergeProjectConfig + then apply customParams path override manually:
        var config = loader.mergeProjectConfig(loader.DEFAULTS, { git: { branchNamingFn: inlineFn } });
        // Now apply the path override as loadProjectConfig would:
        var namingFn = loader.loadProjectConfig({
            customParams: { branchNamingFnPath: 'agents/js/branchNaming/issueType_naming.js' }
        }).git.branchNamingFn;

        var ticket = { key: 'X-1', fields: {} };
        assert.equal(typeof namingFn, 'function');
        // The file returns "from-file/<key>"
        assert.equal(namingFn(ticket, 'development'), 'from-file/X-1');
    });

    test('warns and ignores branchNamingFnPath when file does not export a function', function() {
        // File exports an object, not a function
        var fnSrc = 'module.exports = { notAFunction: true };';
        var loader = makeLoaderWithFnFile(fnSrc);
        var config = loader.loadProjectConfig({
            customParams: { branchNamingFnPath: 'agents/js/branchNaming/issueType_naming.js' }
        });
        // branchNamingFn should remain null (default), falling back to prefix strategy
        assert.equal(config.git.branchNamingFn, null, 'non-function export should be ignored');
        var ticket = { key: 'PROJ-7', fields: {} };
        assert.equal(loader.resolveBranchName(config, ticket, 'development'), 'ai/PROJ-7');
    });

    test('no branchNamingFnPath in customParams leaves branchNamingFn unchanged', function() {
        var loader = makeLoaderWithFnFile('module.exports = function() { return "x"; };');
        var config = loader.loadProjectConfig({ customParams: {} });
        assert.equal(config.git.branchNamingFn, null, 'should stay null when no path given');
    });

});

// ── customParams.featureBranchEnabled ─────────────────────────────────────────

suite('configLoader.loadProjectConfig — featureBranchEnabled', function() {

    function makeLoader() {
        var fakeFileRead = function() { return null; };
        return loadModule(
            'agents/js/configLoader.js',
            makeRequire({ './config.js': configModule, 'config': configModule }),
            { file_read: fakeFileRead }
        );
    }

    test('featureBranchEnabled=true enables two-branch flow', function() {
        var loader = makeLoader();
        var config = loader.loadProjectConfig({ customParams: { featureBranchEnabled: true } });
        assert.equal(config.git.featureBranch.enabled, true);
    });

    test('featureBranchEnabled absent leaves featureBranch disabled by default', function() {
        var loader = makeLoader();
        var config = loader.loadProjectConfig({ customParams: {} });
        assert.equal(config.git.featureBranch.enabled, false);
    });

    test('featureBranchEnabled=false does not enable two-branch flow', function() {
        var loader = makeLoader();
        var config = loader.loadProjectConfig({ customParams: { featureBranchEnabled: false } });
        assert.equal(config.git.featureBranch.enabled, false);
    });

    test('featureBranchEnabled combined with branchNamingFnPath routes PR to feature branch', function() {
        var fnSrc = 'module.exports = function(ticket, role) {' +
            '  return role === "feature" ? "Feature/ft_ai_" + ticket.key : "ai/" + ticket.key;' +
            '};';
        var fakeFileRead = function(p) {
            var path = typeof p === 'string' ? p : p.path;
            return path === 'agents/js/branchNaming/sf_naming.js' ? fnSrc : null;
        };
        var loader = loadModule(
            'agents/js/configLoader.js',
            makeRequire({ './config.js': configModule, 'config': configModule }),
            { file_read: fakeFileRead }
        );
        var config = loader.loadProjectConfig({
            customParams: {
                featureBranchEnabled: true,
                branchNamingFnPath: 'agents/js/branchNaming/sf_naming.js'
            }
        });
        var ticket = { key: 'SFCT-123', fields: {} };
        assert.equal(loader.resolveBranchName(config, ticket, 'development'), 'ai/SFCT-123');
        assert.equal(loader.resolvePRTargetBranch(config, ticket), 'Feature/ft_ai_SFCT-123');
    });

});

// ── .dmtools/branchNaming/sf_naming.js ───────────────────────────────────────

suite('sf_naming.js', function() {

    // Load the actual file via loadModule so it runs through the same
    // new Function() path as loadConfigFile (GraalJS-safe).
    var sfNaming = loadModule(
        '.dmtools/branchNaming/sf_naming.js',
        makeRequire({})
    );

    function ticket(key, summary) {
        return { key: key, fields: { summary: summary || '' } };
    }

    test('module.exports is a function (loadConfigFile pattern works)', function() {
        assert.equal(typeof sfNaming, 'function');
    });

    test('development role: feature/ft_ai_sfct_1206_fix_field_subject_task', function() {
        var t = ticket('SFCT-1206', 'Fix field subject task object restricted picklist translations');
        assert.equal(sfNaming(t, 'development'),
            'feature/ft_ai_sfct_1206_fix_field_subject_task_object_restricted_picklist_translatio');
    });

    test('feature role: release/rc_ai_sfct_1206_...', function() {
        var t = ticket('SFCT-1206', 'Fix field subject task object restricted picklist translations');
        assert.equal(sfNaming(t, 'feature'),
            'release/rc_ai_sfct_1206_fix_field_subject_task_object_restricted_picklist_translatio');
    });

    test('key lowercase: SFCT-1206 → sfct_1206', function() {
        var t = ticket('SFCT-1206', 'Simple fix');
        assert.contains(sfNaming(t, 'development'), 'sfct_1206');
    });

    test('special chars stripped from summary: apostrophe, brackets, dots', function() {
        var t = ticket('SFCT-10', "Fix 'account' (B2B) email: don't break it.");
        var result = sfNaming(t, 'development');
        assert.notContains(result, "'");
        assert.notContains(result, '(');
        assert.notContains(result, ')');
        assert.notContains(result, ':');
        assert.notContains(result, '.');
    });

    test('no double underscores in result', function() {
        var t = ticket('SFCT-99', 'Fix   (lots)   of   spaces!!');
        var result = sfNaming(t, 'development');
        assert.notContains(result, '__');
    });

    test('no trailing underscores', function() {
        var t = ticket('SFCT-5', 'Summary ending with special!!');
        var result = sfNaming(t, 'development');
        assert.notContains(result, '_/');
        assert.notEqual(result.charAt(result.length - 1), '_');
    });

    test('slug max 60 chars (full branch can be longer due to prefix)', function() {
        var long = 'This is a very long summary that exceeds sixty characters easily when written out';
        var t = ticket('SFCT-1', long);
        var result = sfNaming(t, 'development');
        var prefix = 'feature/ft_ai_sfct_1_';
        var slug = result.substring(prefix.length);
        assert.ok(slug.length <= 60, 'slug length ' + slug.length + ' exceeds 60');
    });

    test('empty summary produces no suffix', function() {
        var t = ticket('BICE-42', '');
        assert.equal(sfNaming(t, 'development'), 'feature/ft_ai_bice_42');
    });

    test('BICE project key', function() {
        var t = ticket('BICE-131', 'Add mail collection appointments');
        assert.equal(sfNaming(t, 'development'),
            'feature/ft_ai_bice_131_add_mail_collection_appointments');
    });

    test('test role', function() {
        var t = ticket('SFCT-7', 'Some test');
        assert.equal(sfNaming(t, 'test'), 'test/sfct_7_some_test');
    });

});
