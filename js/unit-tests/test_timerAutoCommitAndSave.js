/**
 * Unit tests for agents/js/timerAutoCommitAndSave.js
 *
 * Tests the timer action that auto-commits and saves session artefacts.
 * Mocks all MCP tools (cli_execute_command, file_write, file_delete,
 * github_get_or_create_draft_release, github_upload_release_asset).
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadTimer(mocks) {
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
        }
    };

    var requireFn = makeRequire({
        './common/releaseArtefacts.js': releaseArtefactsMock
    });

    return loadModule(
        'agents/js/timerAutoCommitAndSave.js',
        requireFn,
        mocks || {}
    );
}

// ── autoCommitAndPush ────────────────────────────────────────────────────────

suite('timerAutoCommitAndSave — autoCommitAndPush', function() {

    test('skips when targetRepository.workingDir is missing', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) { cliCalls.push(args.command); return ''; }
        });
        m.action({
            ticket: { key: 'MAPC-123' },
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
            ticket: { key: 'MAPC-123' },
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
            ticket: { key: 'MAPC-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });
        assert.ok(cliCalls.length >= 4, 'should call status, add, commit, push');
        assert.contains(cliCalls[1], 'git add -A');
        assert.contains(cliCalls[2], 'git commit');
        assert.contains(cliCalls[2], 'MAPC-123');
        assert.contains(cliCalls[3], 'git push');
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
            ticket: { key: 'MAPC-123' },
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
            ticket: { key: 'MAPC-123' },
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

    test('uploads .log directly via MCP tools (no CLI commands)', function() {
        var fileWriteCalls = [];
        var releaseCalls = [];
        var uploadCalls = [];
        var deleteCalls = [];
        var cliCalls = [];

        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git status') !== -1) return '';
                return '';
            },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function(args) { deleteCalls.push(args); },
            github_get_or_create_draft_release: function(args) {
                releaseCalls.push(args);
                return JSON.stringify({ id: 99999, html_url: 'https://github.com/test/releases/1' });
            },
            github_upload_release_asset: function(args) {
                uploadCalls.push(args);
                return JSON.stringify({ browser_download_url: 'https://dl.example.com/asset' });
            }
        });

        m.action({
            ticket: { key: 'MAPC-123' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'PostNL-BitDigital', repo: 'PostNL-commercial' },
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: 'Hello CLI output\nline 2'
        });

        // file_write should write the CLI output
        assert.equal(fileWriteCalls.length, 1);
        assert.equal(fileWriteCalls[0].path, '.dmtools-session-output.log');
        assert.equal(fileWriteCalls[0].content, 'Hello CLI output\nline 2');

        // Should call github_get_or_create_draft_release
        assert.equal(releaseCalls.length, 1);
        assert.equal(releaseCalls[0].workspace, 'PostNL-BitDigital');
        assert.equal(releaseCalls[0].repository, 'PostNL-commercial');
        assert.equal(releaseCalls[0].tagName, 'ai-mapc-123');

        // Should call github_upload_release_asset with overwrite
        assert.equal(uploadCalls.length, 1);
        assert.equal(uploadCalls[0].workspace, 'PostNL-BitDigital');
        assert.equal(uploadCalls[0].repository, 'PostNL-commercial');
        assert.equal(uploadCalls[0].releaseId, '99999');
        assert.equal(uploadCalls[0].filePath, '.dmtools-session-output.log');
        assert.equal(uploadCalls[0].assetName, 'sf_story_development-session.log');
        assert.equal(uploadCalls[0].overwrite, 'true');

        // Should NOT call zip or any other CLI command for session save
        var zipCalls = cliCalls.filter(function(c) { return c.indexOf('zip') !== -1; });
        assert.equal(zipCalls.length, 0, 'should not use zip CLI command');

        // Should cleanup
        assert.ok(deleteCalls.length >= 1, 'should cleanup temp file');
    });

    test('handles upload failure gracefully', function() {
        var m = loadTimer({
            cli_execute_command: function(args) { return ''; },
            file_write: function(args) {},
            file_delete: function(args) {},
            github_get_or_create_draft_release: function(args) {
                throw new Error('HTTP 401 Unauthorized');
            },
            github_upload_release_asset: function(args) {
                throw new Error('should not be called');
            }
        });

        // Should not throw — errors are caught
        m.action({
            ticket: { key: 'MAPC-123' },
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
