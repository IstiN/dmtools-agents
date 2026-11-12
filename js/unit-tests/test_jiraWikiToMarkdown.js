/**
 * Unit tests for js/common/jiraWikiToMarkdown.js and the response-target
 * prompt conditions (isResponseToScm / isResponseToTracker).
 */

var san = loadModule('js/common/jiraWikiToMarkdown.js');
var toMd = san.jiraWikiToMarkdown;

suite('jiraWikiToMarkdown sanitizer', function () {
    test('converts h1.-h6. headings', function () {
        assert.equal(toMd('h1. A\nh3. B\nh6. C'), '# A\n### B\n###### C');
    });
    test('converts {code:lang} blocks to fenced code', function () {
        assert.equal(toMd('{code:java}\nint x = 1;\n{code}'), '```java\nint x = 1;\n```');
    });
    test('converts bare {code} and {noformat} blocks', function () {
        assert.equal(toMd('{code}\na\n{code}\n{noformat}\nb\n{noformat}'), '```\na\n```\n```\nb\n```');
    });
    test('converts {{x}} to inline code', function () {
        assert.equal(toMd('Run {{npm test}} now'), 'Run `npm test` now');
    });
    test('converts || header || rows to a GFM header with separator', function () {
        assert.equal(toMd('|| A || B ||\n| 1 | 2 |'), '| A | B |\n| --- | --- |\n| 1 | 2 |');
    });
    test('does not rewrite wiki-looking text inside code blocks', function () {
        assert.equal(toMd('h2. T\n{code}\nh1. keep {{x}}\n{code}'), '## T\n```\nh1. keep {{x}}\n```');
    });
    test('leaves plain markdown untouched (identity)', function () {
        var md = '## Title\n\n- item `x`\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nvar a = 1;\n```';
        assert.equal(toMd(md), md);
        assert.equal(san.hasJiraWikiMarkup(md), false);
    });
    test('is idempotent', function () {
        var once = toMd('h3. X\n{{a}}\n|| H ||');
        assert.equal(toMd(once), once);
    });
    test('wiki markers inside existing ``` fences do not trigger conversion', function () {
        var md = '## Doc\n```\nh3. literal {{x}}\n|| a ||\n```';
        assert.equal(toMd(md), md);
    });
    test('mixed content: converts outside fences, keeps fence content', function () {
        assert.equal(toMd('h2. T\n```\nh1. keep\n```'), '## T\n```\nh1. keep\n```');
    });
    test('null/empty input passes through', function () {
        assert.equal(toMd(''), '');
        assert.equal(toMd(null), null);
    });
});

suite('response target conditions', function () {
    var scm = loadModule('js/conditions/isResponseToScm.js');
    var trk = loadModule('js/conditions/isResponseToTracker.js');
    test('scm target selects markdown, not jira wiki', function () {
        var p = { customParams: { responseTarget: 'scm' } };
        assert.equal(scm.action(p), true);
        assert.equal(trk.action(p), false);
    });
    test('tracker target selects jira wiki, not markdown', function () {
        var p = { jobParams: { customParams: { responseTarget: 'Tracker' } } };
        assert.equal(scm.action(p), false);
        assert.equal(trk.action(p), true);
    });
    test('unset target selects neither', function () {
        assert.equal(scm.action({}), false);
        assert.equal(trk.action(null), false);
    });
});

suite('agent configs: response markup wiring', function () {
    var SCM = ['bug_development', 'bug_fix_batch_development', 'bug_test_automation',
        'bug_test_automation_rework', 'pr_bug_test_automation_review', 'pr_review', 'pr_rework',
        'pr_story_test_automation_review', 'pr_test_automation_review', 'pr_test_automation_rework',
        'story_development', 'story_test_automation', 'story_test_automation_rework', 'test_case_automation'];
    function readConfig(name) {
        var raw = file_read({ path: name + '.json' }) || file_read({ path: '../' + name + '.json' });
        return JSON.parse(raw).params;
    }
    function jiraWikiEntries(params) {
        return (params.cliPromptsByTracker.jira || []).filter(function (e) {
            var p = typeof e === 'string' ? e : e.prompt;
            return p.indexOf('jira_comment_format.md') !== -1;
        });
    }
    test('PR/SCM workflows never get jira_comment_format.md unconditionally', function () {
        SCM.forEach(function (name) {
            var params = readConfig(name);
            assert.equal(params.customParams.responseTarget, 'scm', name + ' responseTarget');
            jiraWikiEntries(params).forEach(function (e) {
                assert.equal(typeof e, 'object', name + ': jira_comment_format.md must be conditional');
                assert.equal(e.condition, 'agents/js/conditions/isResponseToTracker.js', name);
            });
        });
    });
});
