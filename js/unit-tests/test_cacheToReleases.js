/**
 * Unit tests for js/cacheToReleases.js
 *
 * Mocks releaseArtefacts.js (uploadArtefact) and configLoader.js
 * (loadProjectConfig, createScm) so no real MCP tools or filesystem
 * config discovery are needed. Verifies the SCM provider is resolved
 * from configLoader and threaded into uploadArtefact, and that the
 * postToPRComment flow uses the scm abstraction (not hardcoded github_*).
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadCacheToReleases(opts) {
    opts = opts || {};
    var uploadArtefactCalls = [];
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
        uploadArtefact: function(owner, repo, ticketKey, releaseConfig, asset, providerName) {
            uploadArtefactCalls.push({ owner: owner, repo: repo, ticketKey: ticketKey, asset: asset, providerName: providerName });
            if (opts.uploadArtefactImpl) return opts.uploadArtefactImpl(asset);
            return { success: true, releaseUrl: 'https://example.com/releases/ai-' + ticketKey.toLowerCase(), assetUrl: 'https://example.com/asset', error: null };
        }
    };

    var scmCalls = { listPrs: [], addComment: [] };
    var scmMock = {
        listPrs: function(state) {
            scmCalls.listPrs.push(state);
            return opts.prs || [];
        },
        addComment: function(prId, text) {
            scmCalls.addComment.push({ prId: prId, text: text });
            return '{}';
        }
    };

    var configLoaderMock = {
        loadProjectConfig: function(params) {
            return { scm: { provider: opts.scmProvider || 'github' } };
        },
        createScm: function(config) {
            return scmMock;
        }
    };

    var requireFn = makeRequire({
        './common/releaseArtefacts.js': releaseArtefactsMock,
        './configLoader.js': configLoaderMock
    });

    var mod = loadModule('js/cacheToReleases.js', requireFn, {});
    mod._uploadArtefactCalls = uploadArtefactCalls;
    mod._scmCalls = scmCalls;
    return mod;
}

suite('cacheToReleases', function() {

    test('skips when no ticketKey', function() {
        var m = loadCacheToReleases();
        var result = m.action({ jobParams: { customParams: {} } });
        assert.ok(result.skipped);
        assert.equal(m._uploadArtefactCalls.length, 0);
    });

    test('skips when cacheToReleases not configured', function() {
        var m = loadCacheToReleases();
        var result = m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: { customParams: {} }
        });
        assert.ok(result.skipped);
    });

    test('skips when artefactRepository not resolvable', function() {
        var m = loadCacheToReleases();
        var result = m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: {
                customParams: {
                    cacheToReleases: { assets: [{ fromFolder: 'a/{ticketKey}', name: 'a' }] }
                }
            }
        });
        assert.ok(result.skipped);
    });

    test('uploads each asset via releaseArtefacts.uploadArtefact with the github provider (default)', function() {
        var m = loadCacheToReleases();
        var result = m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'Org', repo: 'repo' },
                    cacheToReleases: {
                        assets: [
                            { fromFolder: 'a/{ticketKey}', name: 'a' },
                            { fromFolder: 'b/{ticketKey}', name: 'b' }
                        ]
                    }
                }
            }
        });
        assert.equal(m._uploadArtefactCalls.length, 2);
        assert.equal(m._uploadArtefactCalls[0].providerName, 'github');
        assert.equal(m._uploadArtefactCalls[0].owner, 'Org');
        assert.equal(m._uploadArtefactCalls[0].repo, 'repo');
        assert.equal(result.success, true);
    });

    test('resolves and threads the gitlab provider from configLoader', function() {
        var m = loadCacheToReleases({ scmProvider: 'gitlab' });
        m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'mygroup', repo: 'myrepo' },
                    cacheToReleases: { assets: [{ fromFolder: 'a/{ticketKey}', name: 'a' }] }
                }
            }
        });
        assert.equal(m._uploadArtefactCalls.length, 1);
        assert.equal(m._uploadArtefactCalls[0].providerName, 'gitlab');
    });

    test('postToPRComment uses the scm abstraction (not hardcoded github_* calls)', function() {
        var m = loadCacheToReleases({
            scmProvider: 'gitlab',
            prs: [
                { number: 42, title: 'PROJ-1 fix', head: { ref: 'feature/proj-1' } }
            ]
        });
        m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'mygroup', repo: 'myrepo' },
                    targetRepository: { owner: 'mygroup', repo: 'myrepo' },
                    cacheToReleases: {
                        assets: [{ fromFolder: 'a/{ticketKey}', name: 'a', postToPRComment: true }]
                    }
                }
            }
        });
        assert.equal(m._scmCalls.listPrs.length, 1);
        assert.equal(m._scmCalls.listPrs[0], 'open');
        assert.equal(m._scmCalls.addComment.length, 1);
        assert.equal(m._scmCalls.addComment[0].prId, 42);
        assert.contains(m._scmCalls.addComment[0].text, 'Artefact: a');
    });

    test('postToPRComment skipped when no matching PR found', function() {
        var m = loadCacheToReleases({ prs: [] });
        m.action({
            ticket: { key: 'PROJ-1' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'Org', repo: 'repo' },
                    targetRepository: { owner: 'Org', repo: 'repo' },
                    cacheToReleases: {
                        assets: [{ fromFolder: 'a/{ticketKey}', name: 'a', postToPRComment: true }]
                    }
                }
            }
        });
        assert.equal(m._scmCalls.addComment.length, 0);
    });

});
