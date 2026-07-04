/**
 * Unit tests for js/restoreFromReleases.js
 *
 * Mocks releaseArtefacts.js (downloadArtefact) and configLoader.js
 * (loadProjectConfig) so no real MCP tools or filesystem config discovery
 * are needed. Verifies the SCM provider is resolved from configLoader and
 * threaded into downloadArtefact.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadRestoreFromReleases(opts) {
    opts = opts || {};
    var downloadArtefactCalls = [];
    var releaseArtefactsMock = {
        buildTag: function(ticketKey, template) {
            var t = (template || 'ai-{ticketKey}').replace(/\{ticketKey\}/g, ticketKey);
            return t.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
        },
        buildReleaseName: function(ticketKey, template) {
            return (template || '[AI] [{ticketKey}] Artefacts').replace(/\{ticketKey\}/g, ticketKey);
        },
        resolveTemplate: function(template, ticketKey) {
            if (!template) return template;
            return template.replace(/\{ticketKey\}/g, ticketKey);
        },
        resolveArtefactRepository: function(customParams) {
            if (!customParams) return null;
            var repo = customParams.artefactRepository || customParams.aiRepository || customParams.targetRepository;
            if (!repo || !repo.owner || !repo.repo) return null;
            return { owner: repo.owner, repo: repo.repo };
        },
        downloadArtefact: function(owner, repo, ticketKey, releaseConfig, asset, providerName) {
            downloadArtefactCalls.push({ owner: owner, repo: repo, ticketKey: ticketKey, asset: asset, providerName: providerName });
            if (opts.downloadArtefactImpl) return opts.downloadArtefactImpl(asset);
            return { success: true, restored: true, error: null };
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

    var mod = loadModule('js/restoreFromReleases.js', requireFn, {});
    mod._downloadArtefactCalls = downloadArtefactCalls;
    return mod;
}

suite('restoreFromReleases', function() {

    test('returns true and skips when no ticketKey', function() {
        var m = loadRestoreFromReleases();
        var result = m.action({ jobParams: { customParams: {} } });
        assert.equal(result, true);
        assert.equal(m._downloadArtefactCalls.length, 0);
    });

    test('skips when restoreFromReleases not configured', function() {
        var m = loadRestoreFromReleases();
        var result = m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: { customParams: {} }
        });
        assert.equal(result, true);
        assert.equal(m._downloadArtefactCalls.length, 0);
    });

    test('downloads each asset via releaseArtefacts.downloadArtefact with the github provider (default)', function() {
        var m = loadRestoreFromReleases();
        m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'Org', repo: 'repo' },
                    restoreFromReleases: {
                        assets: [{ name: 'a', toFolder: 'a/{ticketKey}' }]
                    }
                }
            }
        });
        assert.equal(m._downloadArtefactCalls.length, 1);
        assert.equal(m._downloadArtefactCalls[0].providerName, 'github');
        assert.equal(m._downloadArtefactCalls[0].owner, 'Org');
    });

    test('resolves and threads the gitlab provider from configLoader', function() {
        var m = loadRestoreFromReleases({ scmProvider: 'gitlab' });
        m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'mygroup', repo: 'myrepo' },
                    restoreFromReleases: {
                        assets: [{ name: 'a', toFolder: 'a/{ticketKey}' }]
                    }
                }
            }
        });
        assert.equal(m._downloadArtefactCalls.length, 1);
        assert.equal(m._downloadArtefactCalls[0].providerName, 'gitlab');
    });

    test('never throws even when downloadArtefact fails (non-fatal preJSAction)', function() {
        var m = loadRestoreFromReleases({
            downloadArtefactImpl: function() {
                return { success: false, restored: false, error: 'boom' };
            }
        });
        var result = m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'Org', repo: 'repo' },
                    restoreFromReleases: {
                        assets: [{ name: 'a', toFolder: 'a/{ticketKey}' }]
                    }
                }
            }
        });
        assert.equal(result, true);
    });

});
