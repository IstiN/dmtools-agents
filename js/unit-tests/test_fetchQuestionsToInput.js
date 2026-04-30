/**
 * Unit tests for fetchQuestionsToInput.js answer field extraction.
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

function loadFetchQuestionsToInput() {
    return loadModule(
        'agents/js/fetchQuestionsToInput.js',
        makeRequire({
            './configLoader.js': {
                loadProjectConfig: function() {
                    return {
                        jira: {
                            questions: {
                                fetchJql: 'parent = {ticketKey}',
                                answerField: 'Answer'
                            }
                        }
                    };
                }
            }
        }),
        {}
    );
}

suite('fetchQuestionsToInput.getAnswerValue', function() {

    test('reads direct custom field id key', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(
            mod.getAnswerValue({ customfield_10330: 'Direct answer' }, 'customfield_10330'),
            'Direct answer'
        );
    });

    test('reads transformed Jira key for a friendly field name', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(
            mod.getAnswerValue({ 'Answer (customfield_10330)': 'Mapped answer' }, 'Answer'),
            'Mapped answer'
        );
    });

    test('uses the same null and undefined rule for exact and transformed keys', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(mod.getAnswerValue({ Answer: null }, 'Answer'), null);
        assert.equal(mod.getAnswerValue({ Answer: undefined }, 'Answer'), null);
        assert.equal(mod.getAnswerValue({ 'Answer (customfield_10330)': null }, 'Answer'), null);
        assert.equal(mod.getAnswerValue({ 'Answer (customfield_10330)': undefined }, 'Answer'), null);
    });

    test('preserves falsy but present answer values consistently', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(mod.getAnswerValue({ Answer: '' }, 'Answer'), '');
        assert.equal(mod.getAnswerValue({ 'Answer (customfield_10330)': '' }, 'Answer'), '');
        assert.equal(mod.getAnswerValue({ Answer: 0 }, 'Answer'), 0);
        assert.equal(mod.getAnswerValue({ 'Answer (customfield_10330)': false }, 'Answer'), false);
    });

    test('returns null when answer field is absent', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(mod.getAnswerValue({ summary: 'Question' }, 'Answer'), null);
    });

});
