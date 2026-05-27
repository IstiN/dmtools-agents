/**
 * Unit tests for agents/js/common/releaseArtefacts.js
 *
 * Tests pure helper functions: buildTag, buildReleaseName, resolveTemplate,
 * resolveArtefactRepository. Integration functions (zip/upload/download)
 * require live MCP tools and are not covered here.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadReleaseArtefacts(mocks) {
    return loadModule(
        'agents/js/common/releaseArtefacts.js',
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
