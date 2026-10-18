/**
 * Unit tests for js/common/aiChat.js — provider-dispatch chat helper.
 *
 * The module resolves AI provider chat tools from the global scope
 * (globalThis/window) and tries them in priority order: gemini, openai,
 * anthropic, ollama, dial, bedrock. These tests pin the validation guard,
 * the dispatch order, the per-provider fallback (with the warn line), the
 * last-error propagation and the "no provider" failure shapes by injecting
 * provider functions onto the real globalThis (the module reads them at
 * call time).
 *
 * Uses: loadModule(), assert, test(), suite()
 */

var aiChatModule = loadModule('js/common/aiChat.js');

var PROVIDER_NAMES = [
    'gemini_ai_chat',
    'openai_ai_chat',
    'anthropic_ai_chat',
    'ollama_ai_chat',
    'dial_ai_chat',
    'bedrock_ai_chat'
];

function clearProviders() {
    PROVIDER_NAMES.forEach(function(name) {
        try { delete globalThis[name]; } catch (e) { globalThis[name] = undefined; }
    });
}

function setProvider(name, fn) {
    globalThis[name] = fn;
}

suite('aiChat.aiChat', function() {
    test('rejects a missing or non-string message', function() {
        assert.throws(function() { aiChatModule.aiChat(null); }, 'null message must throw');
        assert.throws(function() { aiChatModule.aiChat(42); }, 'numeric message must throw');
        assert.throws(function() { aiChatModule.aiChat({}); }, 'object message must throw');
    });

    test('rejects an empty message', function() {
        assert.throws(function() { aiChatModule.aiChat(''); }, 'empty message must throw');
    });

    test('whitespace-only message is accepted and dispatched (no trim guard)', function() {
        clearProviders();
        var seen = null;
        setProvider('gemini_ai_chat', function(message) { seen = message; return 'ok'; });

        var result = aiChatModule.aiChat('   ');

        assert.equal(result, 'ok');
        assert.equal(seen, '   ', 'the message is passed through verbatim');
        clearProviders();
    });

    test('uses the first available provider and returns its result', function() {
        clearProviders();
        var calls = [];
        setProvider('gemini_ai_chat', function(message) { calls.push(['gemini_ai_chat', message]); return 'gemini-result'; });
        setProvider('openai_ai_chat', function(message) { calls.push(['openai_ai_chat', message]); return 'openai-result'; });

        var result = aiChatModule.aiChat('hello');

        assert.equal(result, 'gemini-result');
        assert.deepEqual(calls, [['gemini_ai_chat', 'hello']], 'higher-priority provider wins, later providers are not tried');
        clearProviders();
    });

    test('falls through to the next provider when an earlier one is absent', function() {
        clearProviders();
        var calls = [];
        setProvider('anthropic_ai_chat', function(message) { calls.push('anthropic_ai_chat'); return 'anthropic-result'; });
        setProvider('bedrock_ai_chat', function(message) { calls.push('bedrock_ai_chat'); return 'bedrock-result'; });

        var result = aiChatModule.aiChat('hi');

        assert.equal(result, 'anthropic-result', 'the earliest present provider wins');
        assert.deepEqual(calls, ['anthropic_ai_chat'], 'only the chosen provider is invoked');
        clearProviders();
    });

    test('falls through when a provider throws, warning and surfacing the next provider result', function() {
        clearProviders();
        var calls = [];
        var warns = [];
        var origWarn = console.warn;
        console.warn = function() { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            setProvider('gemini_ai_chat', function(message) { calls.push('gemini_ai_chat'); throw new Error('gemini boom'); });
            setProvider('openai_ai_chat', function(message) { calls.push('openai_ai_chat'); return 'openai-result'; });

            var result = aiChatModule.aiChat('hi');

            assert.equal(result, 'openai-result');
            assert.deepEqual(calls, ['gemini_ai_chat', 'openai_ai_chat'], 'a throwing provider is skipped, the next one is tried');
            assert.equal(warns.length, 1, 'exactly one warn per failing provider');
            assert.contains(warns[0], 'gemini_ai_chat failed', 'the warn names the failing provider');
            assert.contains(warns[0], 'gemini boom', 'the warn carries the provider error');
        } finally {
            console.warn = origWarn;
        }
        clearProviders();
    });

    test('falls through when a provider resolves undefined', function() {
        clearProviders();
        var calls = [];
        setProvider('gemini_ai_chat', function(message) { calls.push('gemini_ai_chat'); return undefined; });
        setProvider('ollama_ai_chat', function(message) { calls.push('ollama_ai_chat'); return 'ollama-result'; });

        var result = aiChatModule.aiChat('hi');

        assert.equal(result, 'ollama-result');
        assert.deepEqual(calls, ['gemini_ai_chat', 'ollama_ai_chat']);
        clearProviders();
    });

    test('throws the "no provider succeeded" error with the LAST provider error', function() {
        clearProviders();
        var warns = [];
        var origWarn = console.warn;
        console.warn = function() { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            setProvider('gemini_ai_chat', function(message) { throw new Error('gemini boom'); });
            setProvider('openai_ai_chat', function(message) { throw new Error('openai kaput'); });

            var caught = null;
            try {
                aiChatModule.aiChat('hi');
            } catch (e) {
                caught = e;
            }

            assert.ok(caught, 'must throw when all providers fail');
            assert.contains(caught.message, 'no AI provider succeeded', 'pins the failure headline');
            assert.contains(caught.message, 'openai kaput', 'the LAST provider error is propagated');
            assert.notContains(caught.message, 'gemini boom', 'earlier provider errors are not leaked into the final message');
            assert.equal(warns.length, 2, 'one warn per failing provider');
        } finally {
            console.warn = origWarn;
        }
        clearProviders();
    });

    test('throws the "no provider available" error naming every provider family when none exist', function() {
        clearProviders();

        var caught = null;
        try {
            aiChatModule.aiChat('hi');
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'must throw when no provider is available');
        assert.contains(caught.message, 'no AI provider available', 'pins the failure headline');
        ['gemini', 'openai', 'anthropic', 'ollama', 'dial', 'bedrock'].forEach(function(name) {
            assert.contains(caught.message, name, 'error lists ' + name);
        });
        clearProviders();
    });

    test('throws the "no provider available" error when providers exist but all return undefined', function() {
        clearProviders();
        setProvider('gemini_ai_chat', function(message) { return undefined; });
        setProvider('openai_ai_chat', function(message) { return undefined; });

        var caught = null;
        try {
            aiChatModule.aiChat('hi');
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'must throw when no provider produced a result');
        assert.contains(caught.message, 'no AI provider available', 'pins the current fallback error shape');
        clearProviders();
    });

    test('passes a multi-line message through verbatim', function() {
        clearProviders();
        var seen = null;
        setProvider('gemini_ai_chat', function(message) { seen = message; return 'ok'; });

        aiChatModule.aiChat('multi\nline\nprompt');

        assert.equal(seen, 'multi\nline\nprompt');
        clearProviders();
    });
});
