/**
 * Prepare Agent Docs Update — pre-CLI action for agent_docs_writer.json.
 *
 * Collects the agent configs whose human docs need a refresh and writes one
 * context bundle per agent into the input folder:
 *
 *   input/agent_docs/<name>.md — current human doc (if any) or a placeholder
 *   input/agent_docs/<name>.config.json — the agent's JSON config
 *   input/agent_docs/<name>.actions.md — first-comment descriptions of the
 *       referenced JS actions plus the customParams paths they use
 *   input/agent_docs/README.txt — what the CLI agent must do
 *
 * Which agents are collected:
 *   - customParams.agents: explicit list of config names (without .json)
 *   - customParams.baseBranch: agents whose JSON changed vs that git ref
 *   - default: all tracked root agent configs
 *
 * All errors are non-fatal; with nothing to do the action reports 'no_changes'.
 */

var EXCLUDED = { 'sm.json': true, 'sm_merge.json': true };
var ACTION_PARAMS = ['preJSAction', 'preCliJSAction', 'postCliJSAction', 'postJSAction', 'timerJSAction'];

function readText(path) {
    try {
        return file_read({ path: path });
    } catch (e) {
        return null;
    }
}

function listAllAgents() {
    var output = cli_execute_command({ command: 'git ls-files "*.json"' });
    return (output || '').split('\n').filter(function(f) {
        if (!f || !f.trim()) return false;
        var p = f.trim();
        if (p.indexOf('/') !== -1) return false;
        var name = p.replace(/^.*\//, '');
        if (EXCLUDED[name]) return false;
        if (name.indexOf('run_') === 0) return false;
        if (name.indexOf('_lock') !== -1) return false;
        return /^[a-zA-Z0-9_]+\.json$/.test(name);
    }).map(function(f) { return f.trim().replace(/\.json$/, ''); });
}

function listChangedAgents(baseBranch) {
    var output = cli_execute_command({
        command: 'git diff --name-only ' + baseBranch + '...HEAD -- "*.json"'
    });
    return (output || '').split('\n').filter(function(f) {
        if (!f || !f.trim()) return false;
        var p = f.trim();
        if (p.indexOf('/') !== -1) return false;
        var name = p.replace(/^.*\//, '');
        return !EXCLUDED[name] && name.indexOf('run_') !== 0 && name.indexOf('_lock') === -1 &&
            /^[a-zA-Z0-9_]+\.json$/.test(name);
    }).map(function(f) { return f.trim().replace(/\.json$/, ''); });
}

function firstComment(src) {
    if (!src) return '';
    var m = src.match(/^\/\*\*([\s\S]*?)\*\//);
    if (!m) return '';
    return m[1].split('\n').map(function(l) {
        return l.replace(/^\s*\*\s?/, '').trim();
    }).filter(function(l) { return l.length > 0; }).slice(0, 6).join(' ');
}

function extractCustomParamsPaths(src) {
    var found = {};
    var re1 = /customParams\.([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/g;
    var re2 = /customParams\[['"]([\w.]+)['"]\]/g;
    var match;
    while ((match = re1.exec(src)) !== null) found[match[1]] = true;
    while ((match = re2.exec(src)) !== null) found[match[1]] = true;
    return Object.keys(found).sort();
}

function action(params) {
    var folder = params.inputFolderPath || 'input/agent_docs';
    var customParams = (params.customParams) ||
        (params.jobParams && params.jobParams.customParams) || {};

    var agents;
    if (Array.isArray(customParams.agents) && customParams.agents.length > 0) {
        agents = customParams.agents;
    } else if (customParams.baseBranch) {
        agents = listChangedAgents(customParams.baseBranch);
    } else {
        agents = listAllAgents();
    }

    if (agents.length === 0) {
        console.log('prepareAgentDocsUpdate: no agents to document');
        return { success: true, action: 'no_changes' };
    }

    var outDir = folder + '/agent_docs';
    var written = 0;

    agents.forEach(function(name) {
        var configPath = name + '.json';
        var configRaw = readText(configPath);
        if (!configRaw) {
            console.warn('prepareAgentDocsUpdate: cannot read ' + configPath + ', skipped');
            return;
        }

        var config;
        try { config = JSON.parse(configRaw); } catch (e) {
            console.warn('prepareAgentDocsUpdate: cannot parse ' + configPath + ', skipped');
            return;
        }
        var params = config.params || {};

        var humanDoc = readText('docs/agents/' + name + '.md');
        file_write(outDir + '/' + name + '.md',
            humanDoc || '# ' + name.replace(/_/g, ' ') + '\n\n_(no human doc yet — write it)_\n');
        file_write(outDir + '/' + name + '.config.json', configRaw);

        var actionsMd = ['# JS actions used by ' + name, ''];
        ACTION_PARAMS.forEach(function(paramName) {
            var actionPath = params[paramName];
            if (!actionPath) return;
            var src = readText(String(actionPath).replace(/^agents\//, ''));
            actionsMd.push('## ' + paramName + ': ' + actionPath);
            actionsMd.push('');
            var desc = firstComment(src);
            if (desc) {
                actionsMd.push(desc);
                actionsMd.push('');
            }
            var used = src ? extractCustomParamsPaths(src) : [];
            if (used.length > 0) {
                actionsMd.push('Uses customParams: ' + used.map(function(p) { return '`' + p + '`'; }).join(', '));
                actionsMd.push('');
            }
        });
        file_write(outDir + '/' + name + '.actions.md', actionsMd.join('\n'));
        written++;
    });

    file_write(outDir + '/README.txt',
        'For every <name> in this folder, rewrite docs/agents/<name>.md:\n' +
        'a 1-2 sentence human summary of what the agent does, plus a Parameters\n' +
        'section describing every customParams key mentioned in <name>.config.json\n' +
        'and <name>.actions.md in human-readable terms (what it does, default,\n' +
        'allowed values). Keep the title "# ' + '<name with spaces>" and the\n' +
        'backticked parameter names unchanged.\n');

    console.log('prepareAgentDocsUpdate: prepared context for ' + written + ' agent(s) in ' + outDir);
    return { success: true, action: 'prepared', agents: written };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, listAllAgents: listAllAgents, listChangedAgents: listChangedAgents };
}
