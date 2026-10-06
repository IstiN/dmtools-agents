/**
 * Tracker-aware comment markup helpers.
 *
 * Post-action templates historically hard-code Jira wiki markup
 * (`h3.`, `{code}`, `*bold*`, `[text|url]`). When the ticket lives on
 * GitHub Issues (key shapes `gh-12`, `owner/repo#12`, `#12`, bare `12` —
 * owned by common/ticketKeyShapes.js) those comments render as noise. These helpers render each construct in
 * the flavor of the ticket's tracker: Jira wiki for Jira keys, Markdown
 * for GitHub keys — with an explicit override via
 * `customParams.commentMarkup` (`'jira' | 'markdown'`, `'github'` is
 * accepted as an alias for `'markdown'`).
 *
 * Usage:
 *   var commentMarkup = require('./common/commentMarkup.js');
 *   var m = commentMarkup.forTicket(ticketKey, customParams);
 *   var comment = m.h(3, 'Development Completed') + '\n\n' +
 *       m.bold('Branch:') + ' ' + m.code(branchName) + '\n';
 *
 * The Jira flavor output is byte-identical to the historical templates,
 * so Jira-facing behavior is unchanged.
 */
'use strict';

var ticketKeyShapes = require('./ticketKeyShapes.js');

function flavorForTicket(ticketKey, customParams) {
    var explicit = customParams && customParams.commentMarkup;
    if (typeof explicit === 'string' && explicit) {
        var norm = explicit.toLowerCase();
        if (norm === 'markdown' || norm === 'github') return 'markdown';
        if (norm === 'jira') return 'jira';
    }
    // Key shapes come from the single owner (gh-770): common/ticketKeyShapes.js.
    if (ticketKeyShapes.isGitHubKeyShape(ticketKey)) return 'markdown';
    return 'jira';
}

function markdownFlavor() {
    return {
        h: function (level, text) {
            var prefix = '';
            for (var i = 0; i < level; i++) prefix += '#';
            return prefix + ' ' + text;
        },
        bold: function (text) { return '**' + text + '**'; },
        italic: function (text) { return '_' + text + '_'; },
        code: function (text, lang) {
            return '```' + (lang || '') + '\n' + text + '\n```';
        },
        link: function (text, url) { return '[' + text + '](' + url + ')'; },
        panel: function (title, body, jiraOpts) {
            var header = title ? '> **' + title + '**\n>\n' : '';
            var quoted = String(body).split('\n').map(function (line) {
                return '> ' + line;
            }).join('\n');
            return header + quoted;
        }
    };
}

function jiraFlavor() {
    return {
        h: function (level, text) { return 'h' + level + '. ' + text; },
        bold: function (text) { return '*' + text + '*'; },
        italic: function (text) { return '_' + text + '_'; },
        code: function (text, lang) {
            return '{code' + (lang ? ':' + lang : '') + '}' + text + '{code}';
        },
        link: function (text, url) { return '[' + text + '|' + url + ']'; },
        panel: function (title, body, jiraOpts) {
            var open = '{panel' +
                (title ? ':title=' + title : '') +
                (jiraOpts ? (title ? '|' : ':') + jiraOpts : '') +
                '}';
            return open + body + '\n{panel}';
        }
    };
}

function forFlavor(flavor) {
    return flavor === 'markdown' ? markdownFlavor() : jiraFlavor();
}

function forTicket(ticketKey, customParams) {
    return forFlavor(flavorForTicket(ticketKey, customParams));
}

module.exports = {
    flavorForTicket: flavorForTicket,
    forFlavor: forFlavor,
    forTicket: forTicket
};
