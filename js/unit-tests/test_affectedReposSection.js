/**
 * Unit tests for js/common/affectedReposSection.js (gh-1250 dedup helpers).
 *
 * The per-format callers (buildJiraSection / buildMarkdownSection /
 * buildConfluenceMarkdownSection in writeSolutionAndLabels.js) are pinned
 * byte-identical by the golden tests in test_writeSolutionAndLabels.js; this
 * suite covers the parameterized helper branches directly.
 */

function loadSectionHelpers() {
    return loadModule('js/common/affectedReposSection.js', makeRequire({}), {});
}

var SECTION_REPOS = [
    { name: 'core-db', reason: 'DB migration' },
    { name: 'service-api', reason: 'API', depends_on: ['core-db'] }
];

suite('affectedReposSection — module shape', function() {
    test('exports the builders and the per-format fence sets behind the guard', function() {
        var mod = loadSectionHelpers();
        assert.equal(typeof mod.formatRepoDeps, 'function');
        assert.equal(typeof mod.buildRepoTableRows, 'function');
        assert.equal(typeof mod.buildDependencyEdges, 'function');
        assert.equal(typeof mod.appendSectionBody, 'function');
        assert.equal(mod.JIRA_FENCES.mermaidOpen, '{code}');
        assert.equal(mod.JIRA_FENCES.jsonOpen, '{code:json|title=affected_repos}');
        assert.equal(mod.MARKDOWN_FENCES.mermaidOpen, '```mermaid');
        assert.equal(mod.MARKDOWN_FENCES.jsonOpen, '```json');
        assert.equal(mod.CONFLUENCE_FENCES.mermaidOpen, '```mermaid');
        assert.equal(mod.CONFLUENCE_FENCES.jsonOpen, undefined, 'Confluence carries no JSON anchor');
        var code = file_read({ path: 'js/common/affectedReposSection.js' });
        assert.equal(code.indexOf('typeof module') !== -1, true, 'module.exports guarded');
    });
});

suite('affectedReposSection — appendSectionBody', function() {
    test('jira fences: table rows, {code} mermaid graph and json anchor', function() {
        var mod = loadSectionHelpers();
        var lines = [];
        mod.appendSectionBody(lines, SECTION_REPOS, mod.JIRA_FENCES);
        assert.deepEqual(lines, [
            '| 1 | core-db | DB migration | — |',
            '| 2 | service-api | API | core-db |',
            '',
            '{code}',
            'graph LR',
            '    core-db --> service-api',
            '{code}',
            '',
            '{code:json|title=affected_repos}',
            JSON.stringify(SECTION_REPOS, null, 2),
            '{code}'
        ]);
    });

    test('markdown fences: ```mermaid graph and ```json anchor', function() {
        var mod = loadSectionHelpers();
        var lines = [];
        mod.appendSectionBody(lines, SECTION_REPOS, mod.MARKDOWN_FENCES);
        assert.deepEqual(lines, [
            '| 1 | core-db | DB migration | — |',
            '| 2 | service-api | API | core-db |',
            '',
            '```mermaid',
            'graph LR',
            '    core-db --> service-api',
            '```',
            '',
            '```json',
            JSON.stringify(SECTION_REPOS, null, 2),
            '```'
        ]);
    });

    test('confluence fences: no json anchor block when fences.jsonOpen is absent', function() {
        var mod = loadSectionHelpers();
        var lines = [];
        mod.appendSectionBody(lines, SECTION_REPOS, mod.CONFLUENCE_FENCES);
        assert.deepEqual(lines, [
            '| 1 | core-db | DB migration | — |',
            '| 2 | service-api | API | core-db |',
            '',
            '```mermaid',
            'graph LR',
            '    core-db --> service-api',
            '```'
        ]);
    });

    test('no depends_on edges: mermaid graph omitted, table and anchor kept', function() {
        var mod = loadSectionHelpers();
        var lines = [];
        mod.appendSectionBody(lines, [{ name: 'solo', reason: 'r' }], mod.MARKDOWN_FENCES);
        assert.equal(lines.indexOf('```mermaid'), -1, 'mermaid block skipped without edges');
        assert.equal(lines.indexOf('| 1 | solo | r | — |') !== -1, true, 'table rows kept');
        assert.equal(lines.indexOf('```json') !== -1, true, 'json anchor kept');
    });
});
