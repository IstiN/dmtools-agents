/**
 * Unit tests for common/commentMarkup.js.
 *
 * Uses: loadModule(), assert, test(), suite()
 */
/* global loadModule, assert, test, suite */

suite('commentMarkup', function () {

    var commentMarkup = loadModule('js/common/commentMarkup.js');

    test('flavorForTicket: Jira keys keep Jira wiki flavor', function () {
        assert.strictEqual(commentMarkup.flavorForTicket('PROJ-74'), 'jira');
        assert.strictEqual(commentMarkup.flavorForTicket('ABC-123'), 'jira');
        assert.strictEqual(commentMarkup.flavorForTicket(null), 'jira');
    });

    test('flavorForTicket: GitHub key shapes select markdown', function () {
        assert.strictEqual(commentMarkup.flavorForTicket('gh-122'), 'markdown');
        assert.strictEqual(
            commentMarkup.flavorForTicket('epam/dmtools-dart#122'), 'markdown');
        assert.strictEqual(commentMarkup.flavorForTicket('#122'), 'markdown');
        assert.strictEqual(commentMarkup.flavorForTicket('122'), 'markdown');
    });

    test('flavorForTicket: customParams.commentMarkup overrides detection', function () {
        assert.strictEqual(
            commentMarkup.flavorForTicket('PROJ-74', { commentMarkup: 'markdown' }),
            'markdown');
        assert.strictEqual(
            commentMarkup.flavorForTicket('PROJ-74', { commentMarkup: 'github' }),
            'markdown');
        assert.strictEqual(
            commentMarkup.flavorForTicket('gh-122', { commentMarkup: 'jira' }),
            'jira');
    });

    test('jira flavor renders the historical constructs byte-identically', function () {
        var m = commentMarkup.forTicket('PROJ-74');
        assert.strictEqual(m.h(3, 'Development Completed'), 'h3. Development Completed');
        assert.strictEqual(m.bold('Branch:'), '*Branch:*');
        assert.strictEqual(m.code('ai/gh-122'), '{code}ai/gh-122{code}');
        assert.strictEqual(m.code('x = 1', 'dart'), '{code:dart}x = 1{code}');
        assert.strictEqual(
            m.link('PR #124', 'https://example.invalid/pull/124'),
            '[PR #124|https://example.invalid/pull/124]');
        assert.strictEqual(
            m.panel('Note', 'body'),
            '{panel:title=Note}\nbody\n{panel}');
    });

    test('markdown flavor renders GitHub-readable constructs', function () {
        var m = commentMarkup.forTicket('gh-122');
        assert.strictEqual(m.h(3, 'Development Completed'), '### Development Completed');
        assert.strictEqual(m.bold('Branch:'), '**Branch:**');
        assert.strictEqual(m.code('ai/gh-122'), '```\nai/gh-122\n```');
        assert.strictEqual(m.code('x = 1', 'dart'), '```dart\nx = 1\n```');
        assert.strictEqual(
            m.link('PR #124', 'https://example.invalid/pull/124'),
            '[PR #124](https://example.invalid/pull/124)');
        assert.strictEqual(
            m.panel('Note', 'body'),
            '> **Note**\n>\n> body');
    });

    test('forFlavor maps unknown values to jira (safe default)', function () {
        var m = commentMarkup.forFlavor('whatever');
        assert.strictEqual(m.h(2, 'x'), 'h2. x');
    });
});
