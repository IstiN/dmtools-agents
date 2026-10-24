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

// ─── gh-119 CRAP: uncovered branches + extracted pure helpers ────────────────

suite('restoreFromReleases — uncovered branches (gh-119 characterization)', function() {

    test('jobParams-shaped params (no ticket at top level) still resolve the ticket', function() {
        var mod = loadRestoreFromReleases({});
        var ok = mod.action({
            jobParams: {
                ticket: { key: 'TK-2' },
                customParams: {
                    artefactRepository: { owner: 'acme', repo: 'artefacts' },
                    restoreFromReleases: { assets: [{ name: 'copilot-session', toFolder: '.copilot/s/{ticketKey}' }] }
                }
            }
        });
        assert.equal(ok, true);
        assert.equal(mod._downloadArtefactCalls.length, 1);
    });

    test('skips when assets missing / not an array / empty (all three shapes)', function() {
        var shapes = [
            { artefactRepository: { owner: 'a', repo: 'b' }, restoreFromReleases: {} },
            { artefactRepository: { owner: 'a', repo: 'b' }, restoreFromReleases: { assets: 'nope' } },
            { artefactRepository: { owner: 'a', repo: 'b' }, restoreFromReleases: { assets: [] } }
        ];
        for (var i = 0; i < shapes.length; i++) {
            var mod = loadRestoreFromReleases({});
            assert.equal(mod.action({ ticket: { key: 'TK-3' }, customParams: shapes[i] }), true);
            assert.equal(mod._downloadArtefactCalls.length, 0, 'shape ' + i + ' must not download');
        }
    });

    test('skips when no artefact repository is configured', function() {
        var mod = loadRestoreFromReleases({});
        var ok = mod.action({
            ticket: { key: 'TK-4' },
            customParams: { restoreFromReleases: { assets: [{ name: 'n', toFolder: 'f' }] } }
        });
        assert.equal(ok, true);
        assert.equal(mod._downloadArtefactCalls.length, 0);
    });

    test('assets missing name or toFolder are skipped, valid ones still restore (2+ items)', function() {
        var mod = loadRestoreFromReleases({});
        var ok = mod.action({
            ticket: { key: 'TK-5' },
            customParams: {
                artefactRepository: { owner: 'a', repo: 'b' },
                restoreFromReleases: {
                    assets: [
                        { toFolder: 'no-name' },
                        { name: 'no-folder' },
                        { name: 'good-one', toFolder: 'f1' },
                        { name: 'good-two', toFolder: 'f2' }
                    ]
                }
            }
        });
        assert.equal(ok, true);
        assert.equal(mod._downloadArtefactCalls.length, 2);
        assert.equal(mod._downloadArtefactCalls[0].asset.name, 'good-one');
        assert.equal(mod._downloadArtefactCalls[1].asset.name, 'good-two');
    });

    test('a not-restored-but-successful download logs and continues (non-fatal)', function() {
        var mod = loadRestoreFromReleases({
            downloadArtefactImpl: function() { return { success: true, restored: false, error: null }; }
        });
        var ok = mod.action({
            ticket: { key: 'TK-6' },
            customParams: {
                artefactRepository: { owner: 'a', repo: 'b' },
                restoreFromReleases: { assets: [{ name: 'n', toFolder: 'f' }] }
            }
        });
        assert.equal(ok, true);
        assert.equal(mod._downloadArtefactCalls.length, 1);
    });
});

suite('restoreFromReleases — pure helpers (gh-119)', function() {
    var mod = loadRestoreFromReleases({});

    test('resolveActualParams: ticket params win, jobParams fallback, params fallback', function() {
        assert.deepEqual(mod.resolveActualParams({ ticket: { key: 'K' }, jobParams: {} }), { ticket: { key: 'K' }, jobParams: {} });
        assert.deepEqual(mod.resolveActualParams({ jobParams: { ticket: { key: 'J' } } }), { ticket: { key: 'J' } });
        assert.deepEqual(mod.resolveActualParams({}), {});
    });

    test('configuredAssets: null unless a non-empty array', function() {
        assert.equal(mod.configuredAssets(undefined), null);
        assert.equal(mod.configuredAssets({}), null);
        assert.equal(mod.configuredAssets({ assets: null }), null);
        assert.equal(mod.configuredAssets({ assets: 'x' }), null);
        assert.equal(mod.configuredAssets({ assets: [] }), null);
        assert.deepEqual(mod.configuredAssets({ assets: [{ name: 'n' }] }), [{ name: 'n' }]);
    });

    test('scmProviderOf: projectConfig.scm.provider with github default', function() {
        assert.equal(mod.scmProviderOf({ scm: { provider: 'gitlab' } }), 'gitlab');
        assert.equal(mod.scmProviderOf({ scm: {} }), 'github');
        assert.equal(mod.scmProviderOf({}), 'github');
    });
});
