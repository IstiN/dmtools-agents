/**
 * Unit tests for js/common/releaseArtefacts.js
 *
 * Tests pure helper functions: buildTag, buildReleaseName, resolveTemplate,
 * resolveArtefactRepository. Integration functions (zip/upload/download)
 * require live MCP tools and are not covered here.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadReleaseArtefacts(mocks) {
    return loadModule(
        'js/common/releaseArtefacts.js',
        null,
        mocks || {}
    );
}

// ── buildTag ─────────────────────────────────────────────────────────────────

suite('releaseArtefacts.buildTag', function() {

    test('uses default template ai-{ticketKey} when no template given', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(m.buildTag('PROJ-123'), 'ai-proj-123');
    });

    test('resolves custom tagTemplate', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(m.buildTag('PROJ-123', 'artefacts-{ticketKey}'), 'artefacts-proj-123');
    });

    test('lowercases the result', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(m.buildTag('PRJ-1', 'AI-{ticketKey}'), 'ai-prj-1');
    });

    test('replaces invalid chars with hyphens', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(m.buildTag('PRJ-1', 'my artefacts {ticketKey}!'), 'my-artefacts-prj-1-');
    });

});

// ── buildReleaseName ─────────────────────────────────────────────────────────

suite('releaseArtefacts.buildReleaseName', function() {

    test('uses default template [AI] [{ticketKey}] Artefacts when no template given', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(m.buildReleaseName('PROJ-123'), '[AI] [PROJ-123] Artefacts');
    });

    test('resolves custom nameTemplate', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(m.buildReleaseName('PRJ-1', 'Session Cache [{ticketKey}]'), 'Session Cache [PRJ-1]');
    });

});

// ── resolveTemplate ──────────────────────────────────────────────────────────

suite('releaseArtefacts.resolveTemplate', function() {

    test('replaces {ticketKey} token', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(
            m.resolveTemplate('.copilot/session-state/{ticketKey}', 'PROJ-123'),
            '.copilot/session-state/PROJ-123'
        );
    });

    test('replaces multiple {ticketKey} occurrences', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(
            m.resolveTemplate('input/{ticketKey}/context/{ticketKey}.md', 'PRJ-42'),
            'input/PRJ-42/context/PRJ-42.md'
        );
    });

    test('returns template unchanged when no token', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(m.resolveTemplate('outputs/response.md', 'PRJ-1'), 'outputs/response.md');
    });

    test('handles null/undefined gracefully', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(m.resolveTemplate(null, 'PRJ-1'), null);
        assert.equal(m.resolveTemplate(undefined, 'PRJ-1'), undefined);
    });

});

// ── resolveArtefactRepository ─────────────────────────────────────────────────

suite('releaseArtefacts.resolveArtefactRepository', function() {

    test('returns artefactRepository when set', function() {
        var m = loadReleaseArtefacts({});
        var result = m.resolveArtefactRepository({
            artefactRepository: { owner: 'MyOrg', repo: 'my-repo' }
        });
        assert.equal(result.owner, 'MyOrg');
        assert.equal(result.repo, 'my-repo');
    });

    test('falls back to aiRepository when artefactRepository missing', function() {
        var m = loadReleaseArtefacts({});
        var result = m.resolveArtefactRepository({
            aiRepository: { owner: 'OrgAI', repo: 'ai-repo' }
        });
        assert.equal(result.owner, 'OrgAI');
        assert.equal(result.repo, 'ai-repo');
    });

    test('falls back to targetRepository when others missing', function() {
        var m = loadReleaseArtefacts({});
        var result = m.resolveArtefactRepository({
            targetRepository: { owner: 'OrgTarget', repo: 'target-repo' }
        });
        assert.equal(result.owner, 'OrgTarget');
        assert.equal(result.repo, 'target-repo');
    });

    test('returns null when no repository configured', function() {
        var m = loadReleaseArtefacts({});
        assert.equal(m.resolveArtefactRepository({}), null);
        assert.equal(m.resolveArtefactRepository(null), null);
    });

    test('returns null when owner or repo missing', function() {
        var m = loadReleaseArtefacts({});
    assert.equal(m.resolveArtefactRepository({ artefactRepository: { owner: 'Org' } }), null);
    assert.equal(m.resolveArtefactRepository({ artefactRepository: { repo: 'repo' } }), null);
    });

});

// ── zipFolder & unzipTo ──────────────────────────────────────────────────────

suite('releaseArtefacts.zipFolder and unzipTo', function() {

    test('zipFolder creates zip and verifies via ls', function() {
        var deleted = [];
        var commands = [];
        var m = loadReleaseArtefacts({
            file_delete: function(p) { deleted.push(p.path); },
            cli_execute_command: function(p) {
                commands.push(p.command);
                return 'adding: folder/ (stored 0%)';
            }
        });
        var zipPath = m.zipFolder('input/PROJ-1', 'My Asset!');
        assert.equal(zipPath, '/tmp/my-asset-.zip');
        assert.deepEqual(deleted, ['/tmp/my-asset-.zip']);
        assert.equal(commands.length, 2);
    });

    test('zipFolder returns null when verification ls throws', function() {
        var m = loadReleaseArtefacts({
            file_delete: function() { throw new Error('no file'); },
            cli_execute_command: function(p) {
                if (p.command.indexOf('ls ') === 0) throw new Error('missing');
                return '';
            }
        });
        assert.equal(m.zipFolder('input/PROJ-1', 'asset'), null);
    });

    test('zipFolder returns null when zip command throws', function() {
        var m = loadReleaseArtefacts({
            file_delete: function() {},
            cli_execute_command: function() { throw new Error('zip failed'); }
        });
        assert.equal(m.zipFolder('input/PROJ-1', 'asset'), null);
    });

    test('unzipTo returns true on success and false on error', function() {
        var okModule = loadReleaseArtefacts({
            cli_execute_command: function() { return ''; }
        });
        assert.equal(okModule.unzipTo('/tmp/a.zip', '/tmp/dest'), true);

        var failModule = loadReleaseArtefacts({
            cli_execute_command: function() { throw new Error('unzip error'); }
        });
        assert.equal(failModule.unzipTo('/tmp/a.zip', '/tmp/dest'), false);
    });

});

// ── uploadArtefact & uploadRawFile ───────────────────────────────────────────

suite('releaseArtefacts.uploadArtefact and uploadRawFile', function() {

    test('uploadArtefact uploads zip to github provider (string & object responses)', function() {
        var m = loadReleaseArtefacts({
            file_delete: function() {},
            cli_execute_command: function() { return 'ok'; },
            github_get_or_create_draft_release: function() {
                return JSON.stringify({
                    id: 42,
                    html_url: 'https://github.com/o/r/releases/tag/ai-proj-1',
                    assets: [{ name: 'old.zip' }]
                });
            },
            github_upload_release_asset: function() {
                return JSON.stringify({ browser_download_url: 'https://github.com/o/r/releases/download/ai-proj-1/session.zip' });
            }
        });
        var res = m.uploadArtefact('o', 'r', 'PROJ-1', {}, { fromFolder: 'f/{ticketKey}', name: 'session' });
        assert.equal(res.success, true);
        assert.equal(res.releaseUrl, 'https://github.com/o/r/releases/tag/ai-proj-1');
        assert.equal(res.assetUrl, 'https://github.com/o/r/releases/download/ai-proj-1/session.zip');
        assert.equal(res.error, null);
    });

    test('uploadArtefact handles missing source folder and zip failure', function() {
        var mMissing = loadReleaseArtefacts({
            cli_execute_command: function() { throw new Error('not found'); }
        });
        var r1 = mMissing.uploadArtefact('o', 'r', 'PROJ-1', {}, { fromFolder: 'missing', name: 's' });
        assert.equal(r1.success, false);
        assert.ok(r1.error.indexOf('Folder not found') !== -1);

        var callCount = 0;
        var mZipFail = loadReleaseArtefacts({
            file_delete: function() {},
            cli_execute_command: function() {
                callCount++;
                if (callCount === 1) return 'exists';
                throw new Error('zip failed');
            }
        });
        var r2 = mZipFail.uploadArtefact('o', 'r', 'PROJ-1', {}, { fromFolder: 'folder', name: 's' });
        assert.equal(r2.success, false);
        assert.ok(r2.error.indexOf('Failed to zip folder') !== -1);
    });

    test('uploadArtefact handles provider upload exception', function() {
        var m = loadReleaseArtefacts({
            file_delete: function() {},
            cli_execute_command: function() { return 'ok'; },
            github_get_or_create_draft_release: function() { throw new Error('api down'); }
        });
        var res = m.uploadArtefact('o', 'r', 'PROJ-1', {}, { fromFolder: 'f', name: 's' });
        assert.equal(res.success, false);
        assert.ok(res.error.indexOf('api down') !== -1);
    });

    test('uploadRawFile uploads to gitlab provider and handles failure', function() {
        var m = loadReleaseArtefacts({
            gitlab_get_or_create_release: function() {
                return {
                    tag_name: 'ai-proj-2',
                    _links: { self: 'https://gitlab.com/o/r/-/releases/ai-proj-2' },
                    assets: { links: [{ name: 'a.txt' }] }
                };
            },
            gitlab_upload_release_asset: function() {
                return { direct_asset_url: 'https://gitlab.com/o/r/-/releases/ai-proj-2/downloads/a.txt' };
            }
        });
        var res = m.uploadRawFile('o', 'r', 'PROJ-2', {}, '/tmp/a.txt', 'a.txt', 'gitlab');
        assert.equal(res.success, true);
        assert.equal(res.releaseUrl, 'https://gitlab.com/o/r/-/releases/ai-proj-2');
        assert.equal(res.assetUrl, 'https://gitlab.com/o/r/-/releases/ai-proj-2/downloads/a.txt');

        var mFail = loadReleaseArtefacts({
            gitlab_get_or_create_release: function() { throw new Error('gitlab error'); }
        });
        var resFail = mFail.uploadRawFile('o', 'r', 'PROJ-2', {}, '/tmp/a.txt', 'a.txt', 'gitlab');
        assert.equal(resFail.success, false);
        assert.ok(resFail.error.indexOf('gitlab error') !== -1);
    });

});

// ── downloadArtefact ─────────────────────────────────────────────────────────

suite('releaseArtefacts.downloadArtefact', function() {

    test('restores existing asset on github and gitlab', function() {
        var mGh = loadReleaseArtefacts({
            file_delete: function() {},
            cli_execute_command: function() { return 'ok'; },
            github_get_or_create_draft_release: function() {
                return { id: 1, assets: [{ name: 'cache.zip' }] };
            },
            github_upload_release_asset: function() { return {}; }
        });
        var rGh = mGh.downloadArtefact('o', 'r', 'PROJ-1', {}, { name: 'cache', toFolder: 'out/{ticketKey}' });
        assert.equal(rGh.success, true);
        assert.equal(rGh.restored, true);

        var glDownloaded = false;
        var mGl = loadReleaseArtefacts({
            file_delete: function() {},
            cli_execute_command: function() { return 'ok'; },
            gitlab_get_or_create_release: function() {
                return JSON.stringify({ assets: { links: [{ name: 'cache.zip' }] } });
            },
            gitlab_upload_release_asset: function() { return '{}'; },
            gitlab_download_release_asset: function() { glDownloaded = true; }
        });
        var rGl = mGl.downloadArtefact('o', 'r', 'PROJ-1', {}, { name: 'cache', toFolder: 'out' }, 'gitlab');
        assert.equal(rGl.success, true);
        assert.equal(rGl.restored, true);
        assert.equal(glDownloaded, true);
    });

    test('skips when asset is not in release', function() {
        var m = loadReleaseArtefacts({
            file_delete: function() {},
            github_get_or_create_draft_release: function() { return { id: 1 }; },
            gitlab_get_or_create_release: function() { return {}; },
            gitlab_upload_release_asset: function() { return {}; }
        });
        var res = m.downloadArtefact('o', 'r', 'PROJ-1', {}, { name: 'missing', toFolder: 'out' });
        assert.equal(res.success, true);
        assert.equal(res.restored, false);

        var resGl = m.downloadArtefact('o', 'r', 'PROJ-1', {}, { name: 'missing', toFolder: 'out' }, 'gitlab');
        assert.equal(resGl.success, true);
        assert.equal(resGl.restored, false);
        assert.deepEqual(m.uploadRawFile('o', 'r', 'PROJ-1', {}, 'f', 'a', 'gitlab').assetUrl, null);
    });

    test('returns error when downloaded file is missing or unzip fails', function() {
        var mMissingFile = loadReleaseArtefacts({
            file_delete: function() {},
            github_get_or_create_draft_release: function() {
                return { id: 1, assets: [{ name: 'cache.zip' }] };
            },
            cli_execute_command: function(p) {
                if (p.command.indexOf('ls ') === 0) throw new Error('missing');
                return '';
            }
        });
        var r1 = mMissingFile.downloadArtefact('o', 'r', 'PROJ-1', {}, { name: 'cache', toFolder: 'out' });
        assert.equal(r1.success, false);
        assert.ok(r1.error.indexOf('Download produced no file') !== -1);

        var mUnzipFail = loadReleaseArtefacts({
            file_delete: function() {},
            github_get_or_create_draft_release: function() {
                return { id: 1, assets: [{ name: 'cache.zip' }] };
            },
            cli_execute_command: function(p) {
                if (p.command.indexOf('unzip ') !== -1) throw new Error('corrupt zip');
                return '';
            }
        });
        var r2 = mUnzipFail.downloadArtefact('o', 'r', 'PROJ-1', {}, { name: 'cache', toFolder: 'out' });
        assert.equal(r2.success, false);
        assert.equal(r2.error, 'Unzip failed');
    });

    test('handles 404/Not Found/release not found as non-fatal skip and other errors as failure', function() {
        ['404', 'Not Found', 'release not found'].forEach(function(msg) {
            var m404 = loadReleaseArtefacts({
                file_delete: function() {},
                github_get_or_create_draft_release: function() { throw new Error(msg); }
            });
            var r = m404.downloadArtefact('o', 'r', 'PROJ-1', {}, { name: 'c', toFolder: 'out' });
            assert.equal(r.success, true);
            assert.equal(r.restored, false);
        });

        var mErr = loadReleaseArtefacts({
            file_delete: function() {},
            github_get_or_create_draft_release: function() { throw new Error('500 Server Error'); }
        });
        var rErr = mErr.downloadArtefact('o', 'r', 'PROJ-1', {}, { name: 'c', toFolder: 'out' });
        assert.equal(rErr.success, false);
        assert.ok(rErr.error.indexOf('500 Server Error') !== -1);
    });

});
