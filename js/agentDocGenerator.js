/**
 * Agent documentation generator
 *
 * Reads every agent JSON file in agents/ and writes a per-agent Markdown page
 * to docs/agents/generated/<agent>.md. Pages are generated from the JSON
 * metadata and from a lightweight static analysis of the referenced JS action
 * files, so they stay in sync when actions change.
 *
 * Usage:
 *   dmtools run agents/js/unit-tests/run_agentDocs.json
 *   node agents/js/agentDocGenerator.js   (Node, not GraalJS)
 */

var fs = require('fs');
var path = require('path');

var AGENTS_DIR = 'agents';
var DOCS_DIR = path.join(AGENTS_DIR, 'docs', 'agents', 'generated');
var SNAPSHOTS_DIR = path.join(AGENTS_DIR, 'snapshots');

function ensureDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        // ignore
    }
}

function listAgentConfigs() {
    var files = fs.readdirSync(AGENTS_DIR);
    return files.filter(function(f) {
        return f.endsWith('.json') &&
            f !== 'sm.json' &&
            f !== 'sm_merge.json' &&
            !f.startsWith('run_') &&
            f.indexOf('_lock') === -1;
    }).sort();
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.warn('Could not parse', filePath, ':', e.message);
        return null;
    }
}

function readSource(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return '';
    }
}

function escapeMd(text) {
    if (!text) return '';
    return String(text).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function unique(arr) {
    var seen = {};
    return arr.filter(function(item) {
        if (seen[item]) return false;
        seen[item] = true;
        return true;
    });
}

function basename(p) {
    return p.replace(/^.*[\\/]/, '');
}

function firstJsDescription(src) {
    var m = src.match(/^\s*\/\*\*\s*\n?\s*\*\s*([^\n]+)/);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function statementContext(src, index) {
    var start = src.lastIndexOf('\n', Math.max(0, index - 200));
    var end = src.indexOf('\n', index + 200);
    if (end === -1) end = src.length;
    return src.substring(start + 1, end);
}

function isWriteContext(ctx) {
    return /file_write\s*\(|writeFileSync\s*\(|fs\.writeFile\s*\(/.test(ctx);
}

function isReadContext(ctx) {
    return /file_read\s*\(|readFileSync\s*\(|fs\.readFile\s*\(|jira_attach_file_to_ticket\s*\(/.test(ctx);
}

function normalizeArtifactPath(p) {
    return p.replace(/^\.\//, '').replace(/\/+/g, '/');
}

function collectArtifacts(src, phase) {
    var reads = [];
    var writes = [];

    function add(list, p) {
        p = normalizeArtifactPath(p);
        if (p === 'input/' || p === 'outputs/') return;
        list.push(p);
    }

    function withPrefix(prefix, file) {
        return prefix + file;
    }

    // Targeted patterns for file path arguments. Each pattern is run globally.
    // dir: 'read' or 'write'; prefix: optional string prepended to capture group 1.
    // concat: combine capture groups 1 and 2 (e.g. 'input/' + key + '/file.md').
    var patterns = [
        // file_write/read first positional argument
        { re: /file_write\s*\(\s*['"`]([^'"`\n]*(?:input\/|outputs\/)[^'"`\n]*)['"`]/g, dir: 'write' },
        { re: /file_read\s*\(\s*['"`]([^'"`\n]*(?:input\/|outputs\/)[^'"`\n]*)['"`]/g, dir: 'read' },
        // file_write({ path: '...' })
        { re: /file_write\s*\(\s*\{[^}]*path\s*:\s*['"`]([^'"`\n]*(?:input\/|outputs\/)[^'"`\n]*)['"`]/g, dir: 'write' },
        // file_write('input/' + key + '/file')
        { re: /file_write\s*\(\s*['"`]([^'"`\n]*(?:input\/|outputs\/)[^'"`\n]*)['"`]\s*\+\s*[A-Za-z0-9_$.]+\s*\+\s*['"`]([^'"`\n]*)['"`]/g, dir: 'write', concat: true },
        // file_write({ path: 'input/' + key + '/file' })
        { re: /file_write\s*\(\s*\{[^}]*path\s*:\s*['"`]([^'"`\n]*(?:input\/|outputs\/)[^'"`\n]*)['"`]\s*\+\s*[A-Za-z0-9_$.]+\s*\+\s*['"`]([^'"`\n]*)['"`]/g, dir: 'write', concat: true },
        // file_write(inputFolder + '/file')
        { re: /file_write\s*\(\s*(?:inputFolder|inputFolderPath|folder)\s*\+\s*['"`]([^'"`\n]+)['"`]/g, dir: 'write', prefix: 'input/<KEY>' },
        // file_read(inputFolder + '/file')
        { re: /file_read\s*\(\s*(?:inputFolder|inputFolderPath|folder)\s*\+\s*['"`]([^'"`\n]+)['"`]/g, dir: 'read', prefix: 'input/<KEY>' },
        // fs.writeFileSync(path.join(inputFolder, 'file'))
        { re: /writeFileSync\s*\(\s*path\.join\s*\(\s*(?:inputFolder|inputFolderPath|folder)\s*,\s*['"`]([^'"`\n]+)['"`]/g, dir: 'write', prefix: 'input/<KEY>' },
        // fs.readFileSync(path.join(inputFolder, 'file'))
        { re: /readFileSync\s*\(\s*path\.join\s*\(\s*(?:inputFolder|inputFolderPath|folder)\s*,\s*['"`]([^'"`\n]+)['"`]/g, dir: 'read', prefix: 'input/<KEY>' },
        // file_write(path.join(inputFolder, 'file'))
        { re: /file_write\s*\(\s*path\.join\s*\(\s*(?:inputFolder|inputFolderPath|folder)\s*,\s*['"`]([^'"`\n]+)['"`]/g, dir: 'write', prefix: 'input/<KEY>' },
        // file_read(path.join(inputFolder, 'file'))
        { re: /file_read\s*\(\s*path\.join\s*\(\s*(?:inputFolder|inputFolderPath|folder)\s*,\s*['"`]([^'"`\n]+)['"`]/g, dir: 'read', prefix: 'input/<KEY>' },
        // jira_attach_file_to_ticket({ filePath: '...' })
        { re: /jira_attach_file_to_ticket\s*\(\s*\{[^}]*filePath\s*:\s*['"`]([^'"`\n]*(?:input\/|outputs\/)[^'"`\n]*)['"`]/g, dir: 'read' }
    ];

    patterns.forEach(function(pattern) {
        var m;
        while ((m = pattern.re.exec(src)) !== null) {
            var file;
            if (pattern.concat) {
                // Insert a placeholder for the variable between the two string literals.
                var left = m[1];
                var right = m[2] || '';
                if (left.slice(-1) === '/' && right.charAt(0) === '/') {
                    file = left + '<KEY>' + right;
                } else {
                    file = left + '<KEY>' + right;
                }
            } else {
                file = m[1];
            }
            if (pattern.prefix) file = withPrefix(pattern.prefix, file);
            if (pattern.dir === 'write') add(writes, file);
            else add(reads, file);
        }
    });

    return { reads: unique(reads).sort(), writes: unique(writes).sort() };
}

function renderSideEffect(label, captures) {
    var out = label;
    captures.forEach(function(c, i) {
        // captures start at regex group 2 (group 1 is the quote character)
        out = out.replace(new RegExp('\\$' + (i + 2), 'g'), c);
    });
    return out;
}

function collectSideEffects(src) {
    var effects = [];
    var seen = {};

    var patterns = [
        { re: /jira_move_to_status\s*\(\s*\{[^}]*statusName:\s*(['"`])([^'"`]+)\1/g, label: 'move ticket to status "$2"' },
        { re: /jira_transition_to_status\s*\(\s*\{[^}]*statusName:\s*(['"`])([^'"`]+)\1/g, label: 'transition ticket to status "$2"' },
        { re: /jira_add_label\s*\(\s*\{[^}]*label:\s*(['"`])([^'"`]+)\1/g, label: 'add label "$2"' },
        { re: /jira_remove_label\s*\(\s*\{[^}]*label:\s*(['"`])([^'"`]+)\1/g, label: 'remove label "$2"' },
        { re: /jira_update_field\s*\(\s*\{[^}]*field:\s*(['"`])([^'"`]+)\1/g, label: 'update field "$2"' },
        { re: /jira_post_comment\s*\(/g, label: 'post Jira comment' },
        { re: /jira_create_ticket_with_json\s*\(/g, label: 'create Jira ticket' },
        { re: /jira_create_issue\s*\(/g, label: 'create Jira issue' },
        { re: /jira_link_issues\s*\(/g, label: 'link Jira issues' },
        { re: /jira_assign_ticket_to\s*\(/g, label: 'assign ticket' },
        { re: /jira_attach_file_to_ticket\s*\(/g, label: 'attach file to ticket' },
        { re: /github_create_pr\s*\(/g, label: 'create GitHub PR' },
        { re: /github_create_pull_request\s*\(/g, label: 'create GitHub PR' },
        { re: /github_merge_pr\s*\(/g, label: 'merge GitHub PR' },
        { re: /github_merge_pull_request\s*\(/g, label: 'merge GitHub PR' },
        { re: /github_post_review_comment\s*\(/g, label: 'post PR review comment' },
        { re: /github_create_review_comment\s*\(/g, label: 'post PR review comment' },
        { re: /github_update_pr\s*\(/g, label: 'update PR' },
        { re: /github_close_pr\s*\(/g, label: 'close PR' },
        { re: /git push/g, label: 'git push' },
        { re: /git checkout/g, label: 'git checkout' },
        { re: /git merge/g, label: 'git merge' },
        { re: /git rebase/g, label: 'git rebase' }
    ];

    patterns.forEach(function(pattern) {
        var match;
        while ((match = pattern.re.exec(src)) !== null) {
            var captures = [];
            for (var i = 2; i < match.length; i++) {
                if (match[i] !== undefined) captures.push(match[i]);
            }
            var label = renderSideEffect(pattern.label, captures);
            if (!seen[label]) {
                seen[label] = true;
                effects.push(label);
            }
        }
    });

    return effects;
}

function analyzeActionFile(filePath, phase) {
    var src = readSource(filePath);
    if (!src) {
        return {
            description: '',
            artifacts: { reads: [], writes: [] },
            effects: []
        };
    }

    return {
        description: firstJsDescription(src),
        artifacts: collectArtifacts(src, phase),
        effects: collectSideEffects(src)
    };
}

function renderActionSection(label, filePath, phase) {
    if (!filePath) return '';

    var analysis = analyzeActionFile(filePath, phase);
    var lines = [];
    lines.push('### ' + label + ': `' + basename(filePath) + '`');
    lines.push('');
    if (analysis.description) {
        lines.push('_' + escapeMd(analysis.description) + '_');
        lines.push('');
    }
    lines.push('- Source: `' + filePath + '`');

    if (analysis.artifacts.reads.length > 0) {
        lines.push('- Reads:');
        analysis.artifacts.reads.forEach(function(p) {
            lines.push('  - `' + p + '`');
        });
    }

    if (analysis.artifacts.writes.length > 0) {
        lines.push('- Writes:');
        analysis.artifacts.writes.forEach(function(p) {
            lines.push('  - `' + p + '`');
        });
    }

    if (analysis.effects.length > 0) {
        lines.push('- Side effects:');
        analysis.effects.forEach(function(effect) {
            lines.push('  - ' + effect);
        });
    }

    if (analysis.artifacts.reads.length === 0 &&
        analysis.artifacts.writes.length === 0 &&
        analysis.effects.length === 0) {
        lines.push('- No detected file I/O or side effects.');
    }

    lines.push('');
    return lines.join('\n');
}

function renderOutputSchemas(outputSchemas) {
    if (!outputSchemas || typeof outputSchemas !== 'object') return '';
    var keys = Object.keys(outputSchemas);
    if (keys.length === 0) return '';
    var out = '### Output schemas\n\n';
    keys.forEach(function(fileName) {
        var schema = outputSchemas[fileName];
        out += '- `' + fileName + '`\n';
        if (schema.required && schema.required.length) {
            out += '  - required: `' + schema.required.join('`, `') + '`\n';
        }
    });
    return out + '\n';
}

function snapshotPath(fileName) {
    var base = fileName.replace(/\.json$/, '.md');
    var p = path.join(SNAPSHOTS_DIR, base);
    try {
        fs.accessSync(p, fs.constants.F_OK);
        return p;
    } catch (e) {
        return null;
    }
}

function renderAgentDoc(fileName, config) {
    var params = config.params || {};
    var metadata = params.metadata || {};
    var customParams = params.customParams || {};
    var outputSchemas = params.outputSchemas || null;

    var name = config.name || metadata.contextId || fileName.replace(/\.json$/, '');
    var contextId = metadata.contextId || '—';

    var lines = [];
    lines.push('# ' + name + ' (`' + fileName + '`)');
    lines.push('');

    lines.push('## Attributes');
    lines.push('');
    lines.push('| Attribute | Value |');
    lines.push('|---|---|');
    lines.push('| ContextId | `' + contextId + '` |');
    lines.push('| outputType | `' + (params.outputType || '—') + '` |');
    lines.push('| skipAIProcessing | `' + (params.skipAIProcessing || false) + '` |');
    lines.push('');

    var snap = snapshotPath(fileName);
    if (snap) {
        lines.push('## Prompt snapshot');
        lines.push('');
        lines.push('Full prompt / instruction set: [`' + snap + '`](' + snap + ')');
        lines.push('');
    }

    lines.push('## Actions');
    lines.push('');
    lines.push(renderActionSection('preJSAction', params.preJSAction, 'pre'));
    lines.push(renderActionSection('preCliJSAction', params.preCliJSAction, 'pre'));
    lines.push(renderActionSection('postCliJSAction', params.postCliJSAction, 'post'));
    lines.push(renderActionSection('postJSAction', params.postJSAction, 'post'));

    lines.push('## LLM step');
    lines.push('');
    lines.push('- outputType: `' + (params.outputType || 'none') + '`');
    if (snap) {
        lines.push('- Prompt snapshot: `' + snap + '`');
    }
    lines.push('');

    var schemasMd = renderOutputSchemas(outputSchemas);
    if (schemasMd) {
        lines.push(schemasMd);
    }

    if (Object.keys(customParams).length > 0) {
        lines.push('## Custom params');
        lines.push('');
        Object.keys(customParams).forEach(function(k) {
            lines.push('- `' + k + '`: `' + escapeMd(JSON.stringify(customParams[k])) + '`');
        });
        lines.push('');
    }

    lines.push('---');
    lines.push('_Generated by js/agentDocGenerator.js_');
    return lines.join('\n');
}

function generate() {
    ensureDir(DOCS_DIR);
    var files = listAgentConfigs();
    console.log('Generating docs for', files.length, 'agent(s)');

    files.forEach(function(fileName) {
        var filePath = path.join(AGENTS_DIR, fileName);
        var config = readJson(filePath);
        if (!config) return;

        var doc = renderAgentDoc(fileName, config);
        var outPath = path.join(DOCS_DIR, fileName.replace(/\.json$/, '.md'));
        fs.writeFileSync(outPath, doc);
        console.log('✅', outPath);
    });

    return { success: true, generated: files.length };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { generate };
}

if (require.main === module) {
    generate();
}
