/**
 * Unit tests for js/timerAutoCommitAndSave.js
 *
 * Tests the timer action that auto-commits and saves session artefacts.
 * Mocks releaseArtefacts.js (uploadRawFile) and configLoader.js
 * (loadProjectConfig, for scm.provider resolution) so no real MCP tools
 * or filesystem config discovery are needed.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadTimer(mocks, opts) {
    opts = opts || {};
    var uploadRawFileCalls = [];
    var releaseArtefactsMock = {
        buildTag: function(ticketKey, template) {
            var t = (template || 'ai-{ticketKey}').replace(/\{ticketKey\}/g, ticketKey);
            return t.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
        },
        buildReleaseName: function(ticketKey, template) {
            return (template || '[AI] [{ticketKey}] Artefacts').replace(/\{ticketKey\}/g, ticketKey);
        },
        resolveArtefactRepository: function(customParams) {
            if (!customParams) return null;
            var repo = customParams.artefactRepository || customParams.aiRepository || customParams.targetRepository;
            if (!repo || !repo.owner || !repo.repo) return null;
            return { owner: repo.owner, repo: repo.repo };
        },
        uploadRawFile: function(owner, repo, ticketKey, releaseConfig, filePath, assetName, providerName) {
            uploadRawFileCalls.push({
                owner: owner, repo: repo, ticketKey: ticketKey, releaseConfig: releaseConfig,
                filePath: filePath, assetName: assetName, providerName: providerName
            });
            if (opts.uploadRawFileImpl) return opts.uploadRawFileImpl(arguments);
            return { success: true, releaseUrl: 'https://example.com/releases/1', assetUrl: 'https://example.com/asset', error: null };
        }
    };

    var configLoaderMock = {
        loadProjectConfig: function(params) {
            return { scm: { provider: opts.scmProvider || 'github' } };
        }
    };

    var requireFn = makeRequire({
        './common/releaseArtefacts.js': releaseArtefactsMock,
        './configLoader.js': configLoaderMock
    });

    var mod = loadModule(
        'js/timerAutoCommitAndSave.js',
        requireFn,
        mocks || {}
    );
    mod._uploadRawFileCalls = uploadRawFileCalls;
    return mod;
}

// ── autoCommitAndPush ────────────────────────────────────────────────────────

suite('timerAutoCommitAndSave — autoCommitAndPush', function() {

    test('skips when targetRepository.workingDir is missing', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) { cliCalls.push(args.command); return ''; }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: { customParams: {}, metadata: { contextId: 'sf_story_development' } },
            currentCliOutput: ''
        });
        assert.equal(cliCalls.length, 0);
    });

    test('does not commit when git status is clean', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git status') !== -1) return '';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });
        assert.equal(cliCalls.length, 1);
        assert.contains(cliCalls[0], 'git status');
    });

    test('commits and pushes when there are changes', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git status') !== -1) return 'M file.txt\n';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });
        assert.ok(cliCalls.length >= 4, 'should call status, add, commit, push');
        assert.contains(cliCalls[1], 'git rm -r --ignore-unmatch .dmtools/copilot-sessions');
        assert.contains(cliCalls[2], 'git add -A');
        assert.contains(cliCalls[3], 'git commit');
        assert.contains(cliCalls[3], 'PROJ-123');
        assert.contains(cliCalls[4], 'git push');
    });
});

// ── saveSessionArtefact ──────────────────────────────────────────────────────

suite('timerAutoCommitAndSave — saveSessionArtefact', function() {

    test('skips when artefactRepository is not configured', function() {
        var fileWriteCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) { return ''; },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function() {}
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: { customParams: {}, metadata: { contextId: 'test' } },
            currentCliOutput: 'some output'
        });
        assert.equal(fileWriteCalls.length, 0);
    });

    test('skips when currentCliOutput is empty', function() {
        var fileWriteCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) { return ''; },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function() {}
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'TestOrg', repo: 'test-repo' }
                },
                metadata: { contextId: 'test' }
            },
            currentCliOutput: ''
        });
        assert.equal(fileWriteCalls.length, 0);
    });

    test('uploads .log via releaseArtefacts.uploadRawFile (no CLI commands, no zip)', function() {
        var fileWriteCalls = [];
        var deleteCalls = [];
        var cliCalls = [];

        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git status') !== -1) return '';
                return '';
            },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function(args) { deleteCalls.push(args); }
        });

        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'ExampleOrg', repo: 'example-app' },
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: 'Hello CLI output\nline 2'
        });

        // file_write should write the CLI output wrapped in a snapshot
        assert.equal(fileWriteCalls.length, 1);
        assert.equal(fileWriteCalls[0].path, '.dmtools-session-output.log');
        assert.contains(fileWriteCalls[0].content, 'Hello CLI output\nline 2', 'raw CLI output preserved');
        assert.contains(fileWriteCalls[0].content, 'TIMER SESSION SNAPSHOT START', 'snapshot header present');
        assert.contains(fileWriteCalls[0].content, 'TIMER SESSION SNAPSHOT END', 'snapshot footer present');

        // Should delegate to releaseArtefacts.uploadRawFile with the 'github' provider (default)
        assert.equal(m._uploadRawFileCalls.length, 1);
        assert.equal(m._uploadRawFileCalls[0].owner, 'ExampleOrg');
        assert.equal(m._uploadRawFileCalls[0].repo, 'example-app');
        assert.equal(m._uploadRawFileCalls[0].ticketKey, 'PROJ-123');
        assert.equal(m._uploadRawFileCalls[0].filePath, '.dmtools-session-output.log');
        assert.equal(m._uploadRawFileCalls[0].assetName, 'sf_story_development-session.log');
        assert.equal(m._uploadRawFileCalls[0].providerName, 'github');

        // Should NOT call zip or any other CLI command for session save
        var zipCalls = cliCalls.filter(function(c) { return c.indexOf('zip') !== -1; });
        assert.equal(zipCalls.length, 0, 'should not use zip CLI command');

        // Should cleanup
        assert.ok(deleteCalls.length >= 1, 'should cleanup temp file');
    });

    test('resolves the gitlab provider from configLoader and passes it through', function() {
        var m = loadTimer({
            cli_execute_command: function() { return ''; },
            file_write: function() {},
            file_delete: function() {}
        }, { scmProvider: 'gitlab' });

        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'mygroup', repo: 'myrepo' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: 'some output'
        });

        assert.equal(m._uploadRawFileCalls.length, 1);
        assert.equal(m._uploadRawFileCalls[0].providerName, 'gitlab');
    });

    test('handles upload failure gracefully', function() {
        var m = loadTimer({
            cli_execute_command: function(args) { return ''; },
            file_write: function(args) {},
            file_delete: function(args) {}
        }, {
            uploadRawFileImpl: function() {
                return { success: false, releaseUrl: null, assetUrl: null, error: 'HTTP 401 Unauthorized' };
            }
        });

        // Should not throw — errors are caught
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'Org', repo: 'repo' }
                },
                metadata: { contextId: 'test' }
            },
            currentCliOutput: 'some output'
        });
        // If we get here, the error was handled gracefully
        assert.ok(true);
    });

    test('no ticketKey — skips entirely', function() {
        var fileWriteCalls = [];
        var m = loadTimer({
            cli_execute_command: function() { return ''; },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function() {}
        });
        m.action({
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'Org', repo: 'repo' }
                },
                metadata: { contextId: 'test' }
            },
            currentCliOutput: 'output'
        });
        assert.equal(fileWriteCalls.length, 0);
    });
});
