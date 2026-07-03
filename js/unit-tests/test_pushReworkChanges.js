/**
 * Unit tests for js/pushReworkChanges.js — postThreadReplies()
 *
 * Regression test: the AI agent commonly writes outputs/review_replies.json
 * using the INPUT schema field names (rootCommentId/body, mirrored from
 * input/<TICKET>/pr_discussions_raw.json) instead of the documented OUTPUT
 * schema (inReplyToId/reply). Left unhandled, this causes every reply to
 * silently fall back to a generic "✅ Addressed." top-level PR comment instead
 * of a threaded reply with the agent's actual explanation, even though the
 * thread is still correctly resolved (since "threadId" is spelled the same in
 * both schemas).
 *
 * postThreadReplies() must accept both field-name conventions.
 */

function makeOutputFiles(fileMap) {
    return loadModule('js/common/outputFiles.js', makeRequire({}), {
        file_read: function(opts) {
            var path = opts && (opts.path || opts);
            return fileMap[path] !== undefined ? fileMap[path] : null;
        }
    });
}

function loadPushReworkChangesModule(fileMap) {
    var outputFiles = makeOutputFiles(fileMap);
    var replyCalls = [];
    var resolveCalls = [];

    var scm = {
        replyToThread: function(prId, thread, text) {
            replyCalls.push({ prId: prId, thread: thread, text: text });
        },
        resolveThread: function(prId, thread) {
            resolveCalls.push({ prId: prId, thread: thread });
        }
    };

    var noop = function() {};
    var mod = loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return {}; } },
            './common/scm.js': { createScm: function() { return scm; } },
            './common/submodules.js': {},
            './common/pullRequest.js': {},
            './common/feedbackLoop.js': {},
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: noop },
            './common/outputFiles.js': outputFiles,
            './config.js': configModule,
            './cacheToReleases.js': { cacheSessionLog: noop },
            './common/tokenUsageComment.js': { postTokenUsageComments: noop }
        }),
        {
            file_read: function(opts) {
                var path = opts && (opts.path || opts);
                return fileMap[path] !== undefined ? fileMap[path] : null;
            }
        }
    );

    return { mod: mod, scm: scm, replyCalls: replyCalls, resolveCalls: resolveCalls };
}

suite('pushReworkChanges — postThreadReplies field-name fallback', function() {

    test('uses documented inReplyToId/reply fields when present', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    { inReplyToId: 111, threadId: 'PRRT_a', reply: 'Fixed via documented schema.' }
                ]
            })
        });

        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(posted, 1);
        assert.equal(loaded.replyCalls.length, 1);
        assert.equal(loaded.replyCalls[0].thread.rootCommentId, 111);
        assert.equal(loaded.replyCalls[0].thread.threadId, 'PRRT_a');
        assert.equal(loaded.replyCalls[0].text, 'Fixed via documented schema.');
        assert.equal(loaded.resolveCalls.length, 1, 'thread should be resolved');
    });

    test('falls back to rootCommentId/body when agent mirrors input schema', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    { rootCommentId: 555000001, threadId: 'PRRT_generic1', body: 'Fixed by extracting the shared helper.' }
                ]
            })
        });

        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(posted, 1);
        assert.equal(loaded.replyCalls.length, 1, 'reply should still be posted');
        assert.equal(loaded.replyCalls[0].thread.rootCommentId, 555000001, 'rootCommentId used as inReplyToId fallback');
        assert.equal(loaded.replyCalls[0].text, 'Fixed by extracting the shared helper.', 'body used as reply text fallback — NOT the generic Addressed fallback');
        assert.notEqual(loaded.replyCalls[0].text, '✅ Addressed.', 'must not silently fall back to generic text when body is present');
        assert.equal(loaded.resolveCalls.length, 1, 'thread should still be resolved');
    });

    test('prefers inReplyToId/reply over rootCommentId/body when both are present', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    {
                        inReplyToId: 222, rootCommentId: 333,
                        threadId: 'PRRT_b',
                        reply: 'Documented field wins.', body: 'Should not be used.'
                    }
                ]
            })
        });

        loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(loaded.replyCalls[0].thread.rootCommentId, 222);
        assert.equal(loaded.replyCalls[0].text, 'Documented field wins.');
    });

    test('reads reply text from a referenced .md file path', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    { inReplyToId: 444, threadId: 'PRRT_c', reply: 'outputs/review_replies/thread_1.md' }
                ]
            }),
            'outputs/review_replies/thread_1.md': 'Detailed explanation from file.'
        });

        loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(loaded.replyCalls[0].text, 'Detailed explanation from file.');
    });

    test('returns 0 and warns when review_replies.json is missing', function() {
        var loaded = loadPushReworkChangesModule({});
        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', {});
        assert.equal(posted, 0);
        assert.equal(loaded.replyCalls.length, 0);
    });
});
