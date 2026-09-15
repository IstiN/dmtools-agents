/**
 * Unit tests for common/commentMarkup.js.
 *
 * Uses: loadModule(), assert, test(), suite()
 */
/* global loadModule, assert, test, suite */

suite('commentMarkup', function () {

    var commentMarkup = loadModule('js/common/commentMarkup.js');

    test('flavorForTicket: Jira keys keep Jira wiki flavor', function () {
        assert.equal(commentMarkup.flavorForTicket('PROJ-74'), 'jira');
        assert.equal(commentMarkup.flavorForTicket('ABC-123'), 'jira');
        assert.equal(commentMarkup.flavorForTicket(null), 'jira');
    });

    test('flavorForTicket: GitHub key shapes select markdown', function () {
        assert.equal(commentMarkup.flavorForTicket('gh-122'), 'markdown');
        assert.equal(
            commentMarkup.flavorForTicket('epam/dmtools-dart#122'), 'markdown');
        assert.equal(commentMarkup.flavorForTicket('#122'), 'markdown');
        assert.equal(commentMarkup.flavorForTicket('122'), 'markdown');
    });

    test('flavorForTicket: customParams.commentMarkup overrides detection', function () {
        assert.equal(
            commentMarkup.flavorForTicket('PROJ-74', { commentMarkup: 'markdown' }),
            'markdown');
        assert.equal(
            commentMarkup.flavorForTicket('PROJ-74', { commentMarkup: 'github' }),
            'markdown');
        assert.equal(
            commentMarkup.flavorForTicket('gh-122', { commentMarkup: 'jira' }),
            'jira');
    });

    test('jira flavor renders the historical constructs byte-identically', function () {
        var m = commentMarkup.forTicket('PROJ-74');
        assert.equal(m.h(3, 'Development Completed'), 'h3. Development Completed');
        assert.equal(m.bold('Branch:'), '*Branch:*');
        assert.equal(m.code('ai/gh-122'), '{code}ai/gh-122{code}');
        assert.equal(m.code('x = 1', 'dart'), '{code:dart}x = 1{code}');
        assert.equal(
            m.link('PR #124', 'https://example.invalid/pull/124'),
            '[PR #124|https://example.invalid/pull/124]');
        assert.equal(
            m.panel('Note', 'body'),
            '{panel:title=Note}body\n{panel}');
    });

    test('markdown flavor renders GitHub-readable constructs', function () {
        var m = commentMarkup.forTicket('gh-122');
        assert.equal(m.h(3, 'Development Completed'), '### Development Completed');
        assert.equal(m.bold('Branch:'), '**Branch:**');
        assert.equal(m.code('ai/gh-122'), '```\nai/gh-122\n```');
        assert.equal(m.code('x = 1', 'dart'), '```dart\nx = 1\n```');
        assert.equal(
            m.link('PR #124', 'https://example.invalid/pull/124'),
            '[PR #124](https://example.invalid/pull/124)');
        assert.equal(
            m.panel('Note', 'body'),
            '> **Note**\n>\n> body');
    });

    test('forFlavor maps unknown values to jira (safe default)', function () {
        var m = commentMarkup.forFlavor('whatever');
        assert.equal(m.h(2, 'x'), 'h2. x');
    });
});
