/**
 * Defensive Jira-wiki → GitHub-Flavored Markdown sanitizer for text that is
 * posted to a pull request (PR body / PR comment). Pure functions only.
 *
 * Converts only when Jira wiki markers are detected; valid Markdown (and any
 * content inside existing ``` fences) is left untouched.
 */

var WIKI_MARKERS = [
    /^h[1-6]\.\s/m,
    /\{code(:[^}]*)?\}/,
    /\{noformat\}/,
    /\{\{[^}\n]+\}\}/,
    /^\s*\|\|.*\|\|\s*$/m
];

function hasJiraWikiMarkup(text) {
    var stripped = String(text || '').replace(/```[\s\S]*?(```|$)/g, '');
    return WIKI_MARKERS.some(function (re) { return re.test(stripped); });
}

function convertHeading(line) {
    var m = /^h([1-6])\.\s+(.*)$/.exec(line);
    return m ? '#'.repeat(Number(m[1])) + ' ' + m[2] : line;
}

function convertTableHeader(line) {
    var m = /^(\s*)\|\|(.*)\|\|\s*$/.exec(line);
    if (!m) return null;
    var cells = m[2].split('||').map(function (c) { return c.trim(); });
    return m[1] + '| ' + cells.join(' | ') + ' |\n' +
        m[1] + '|' + cells.map(function () { return ' --- '; }).join('|') + '|';
}

function convertInline(line) {
    var header = convertTableHeader(line);
    if (header !== null) return header;
    return convertHeading(line).replace(/\{\{([^}\n]+)\}\}/g, '`$1`');
}

function blockOpen(line) {
    var m = /^\s*\{code(?::([^}|]*))?[^}]*\}\s*$/.exec(line);
    if (m) return { fence: '```' + (m[1] || '').trim(), close: /^\s*\{code\}\s*$/ };
    if (/^\s*\{noformat\}\s*$/.test(line)) return { fence: '```', close: /^\s*\{noformat\}\s*$/ };
    return null;
}

/** Inline `{code}x{code}` on a single line → `x`. */
function convertInlineCode(line) {
    return line.replace(/\{code(?::[^}]*)?\}(.*?)\{code\}/g, '`$1`')
        .replace(/\{noformat\}(.*?)\{noformat\}/g, '`$1`');
}

function step(state, line) {
    if (state.close) {
        if (state.close.test(line)) { state.close = null; state.out.push('```'); return; }
        state.out.push(line); return;
    }
    if (state.fenced || /^\s*```/.test(line)) {
        if (/^\s*```/.test(line)) state.fenced = !state.fenced;
        state.out.push(line); return;
    }
    var open = blockOpen(line);
    if (open) { state.close = open.close; state.out.push(open.fence); return; }
    state.out.push(convertInline(convertInlineCode(line)));
}

function jiraWikiToMarkdown(text) {
    if (!hasJiraWikiMarkup(text)) return text;
    var state = { out: [], close: null, fenced: false };
    String(text).split('\n').forEach(function (line) { step(state, line); });
    if (state.close) state.out.push('```');
    return state.out.join('\n');
}

module.exports = {
    jiraWikiToMarkdown: jiraWikiToMarkdown,
    hasJiraWikiMarkup: hasJiraWikiMarkup
};
