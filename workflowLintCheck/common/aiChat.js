/**
 * Provider-agnostic AI chat helper for JavaScript actions.
 *
 * DMTools exposes every AI provider's chat tool as a separate global:
 *   gemini_ai_chat, openai_ai_chat, anthropic_ai_chat, ollama_ai_chat,
 *   dial_ai_chat, bedrock_ai_chat, etc.
 *
 * This module picks the first one that is actually available at runtime,
 * so agent JS never hardcodes a specific provider.
 */

var PROVIDERS = [
    'gemini',
    'openai',
    'anthropic',
    'ollama',
    'dial',
    'bedrock'
];

function _tryCall(fnName, message) {
    try {
        var fn = typeof globalThis !== 'undefined' ? globalThis[fnName] : undefined;
        if (!fn && typeof window !== 'undefined') fn = window[fnName];
        if (typeof fn === 'function') {
            return fn(message);
        }
    } catch (e) {
        // Provider present but call failed — re-throw so caller can fall back
        throw e;
    }
    return undefined;
}

/**
 * Send a text message to the configured AI and return the response.
 * Tries providers in order until one succeeds.
 *
 * @param {string} message  — prompt text
 * @returns {string}        — AI response
 * @throws {Error}          — if no AI provider is available or all fail
 */
function aiChat(message) {
    if (!message || typeof message !== 'string') {
        throw new Error('aiChat: message must be a non-empty string');
    }

    var lastError = null;
    for (var i = 0; i < PROVIDERS.length; i++) {
        var fnName = PROVIDERS[i] + '_ai_chat';
        try {
            var result = _tryCall(fnName, message);
            if (result !== undefined) {
                return result;
            }
        } catch (e) {
            lastError = e;
            console.warn('aiChat: ' + fnName + ' failed — trying next provider', e.message || e);
        }
    }

    if (lastError) {
        throw new Error('aiChat: no AI provider succeeded. Last error: ' + (lastError.message || lastError));
    }
    throw new Error('aiChat: no AI provider available (tried ' + PROVIDERS.join(', ') + ')');
}

module.exports = { aiChat: aiChat };
