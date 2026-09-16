/**
 * Source resolver for the SM rule engine: picks the state source a rule
 * queries. The rule format stays sm.json-compatible — rules without a
 * `source` keep the classic Jira/JQL behavior; `source: 'github'` rules
 * read GitHub issue/PR state (see sources/githubSource.js).
 */
'use strict';

var jiraSource = require('./sources/jiraSource.js');
var githubSource = require('./sources/githubSource.js');

var SOURCES = {
    jira: jiraSource,
    github: githubSource
};

/**
 * Resolves the source module for a rule.
 * @param {Object} rule - SM rule (rule.source: 'jira' | 'github'; default jira)
 * @returns {Object} module with query(rule, ctx)
 */
function resolve(rule) {
    var name = (rule && rule.source) || 'jira';
    var mod = SOURCES[name];
    if (!mod) {
        throw new Error('sm source: unknown source "' + name +
            '" (available: ' + Object.keys(SOURCES).join(', ') + ')');
    }
    return mod;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { resolve: resolve, SOURCES: SOURCES };
}
