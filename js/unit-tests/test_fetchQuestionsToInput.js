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

    test('returns null when answer field is absent', function() {
        var mod = loadFetchQuestionsToInput();
        assert.equal(mod.getAnswerValue({ summary: 'Question' }, 'Answer'), null);
    });

});
