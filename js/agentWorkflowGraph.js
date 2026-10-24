/**
 * Workflow graph generator
 *
 * Reads agents/sm.json and writes docs/agents/workflow.md with:
 *  - a human-readable rule table
 *  - a Mermaid flowchart of status -> agent -> target status edges
 *
 * Usage:
 *   dmtools run agents/js/unit-tests/run_agentDocs.json
 *   node agents/js/agentWorkflowGraph.js   (Node, not GraalJS)
 */

var fs = require('fs');
var path = require('path');

var SM_JSON = 'agents/sm.json';
var WORKFLOW_MD = 'agents/docs/agents/workflow.md';

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function statusNode(status) {
    var safe = status.replace(/[^a-zA-Z0-9]/g, '_');
    return 'S_' + safe + '["' + status + '"]';
}

function agentNode(configFile, idx) {
    var name = configFile.replace(/^agents\//, '').replace(/\.json$/, '');
    return 'A' + idx + '_["' + name + '"]';
}

function parseSourceStatuses(jql) {
    if (!jql) return [];
    var statuses = [];
    var m = jql.match(/status\s+in\s+\(([^)]+)\)/i);
    if (m) {
        statuses = m[1].split(',').map(function(s) {
            return s.trim().replace(/^['"]|['"]$/g, '');
        });
    } else {
        m = jql.match(/status\s*=\s*['"]([^'"]+)['"]/i);
        if (m) statuses.push(m[1]);
    }
    return statuses.filter(Boolean);
}

function parseIssueTypes(jql) {
    if (!jql) return [];
    var types = [];
    var m = jql.match(/issuetype\s+in\s+\(([^)]+)\)/i);
    if (m) {
        types = m[1].split(',').map(function(s) {
            return s.trim().replace(/^['"]|['"]$/g, '');
        });
    } else {
        m = jql.match(/issuetype\s*=\s*['"]([^'"]+)['"]/i);
        if (m) types.push(m[1]);
    }
    return types.filter(Boolean);
}

function escapeMdCell(text) {
    return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ── gh-1227 CRAP extraction — pure per-rule pieces of generate() ─────────────

// SM rules of a parsed sm config: jobParams.rules (canonical) or the flat
// legacy params.rules — [] when neither link exists.
function rulesOfSm(sm) {
    var params = (sm && sm.params) || {};
    return (params.jobParams && params.jobParams.rules) || params.rules || [];
}

// One rule's diagram edges: every source status feeds the agent, and the
// agent feeds the target status when the rule declares one.
function appendRuleEdges(diagramEdges, usedStatuses, rule, agent, sourceStatuses) {
    sourceStatuses.forEach(function(status) {
        usedStatuses[status] = true;
        diagramEdges.push('    ' + statusNode(status) + ' --> ' + agent);
    });

    if (rule.targetStatus) {
        usedStatuses[rule.targetStatus] = true;
        diagramEdges.push('    ' + agent + ' --> ' + statusNode(rule.targetStatus));
    }
}

// The Skip labels cell: single label first, then the list form.
function skipLabelsCell(rule) {
    if (rule.skipIfLabel) return '`' + rule.skipIfLabel + '`';
    if (rule.skipIfLabels && rule.skipIfLabels.length) {
        return rule.skipIfLabels.map(function(l) { return '`' + l + '`'; }).join(', ');
    }
    return '';
}

// One rule's markdown table row (the cells stay space-padded by the join).
function ruleTableRow(rule, idx, issueTypes, sourceStatuses) {
    return [
        idx + 1,
        escapeMdCell(rule.description),
        issueTypes.join(', '),
        sourceStatuses.join(', '),
        '`' + rule.configFile + '`',
        skipLabelsCell(rule),
        rule.addLabel ? '`' + rule.addLabel + '`' : '',
        rule.targetStatus || '—'
    ].join(' | ');
}

function generate() {
    var sm = readJson(SM_JSON);
    var rules = rulesOfSm(sm);

    var lines = [];
    lines.push('# dmtools-agents workflow (generated)');
    lines.push('');
    lines.push('Generated from `agents/sm.json`. Only enabled SM rules are shown.');
    lines.push('');

    // Rule table
    lines.push('## SM rules');
    lines.push('');
    lines.push('| # | Description | Types | Source statuses | Config file | Skip labels | Add label | Target status |');
    lines.push('|---:|---|---|---|---|---|---|---|');

    var usedStatuses = {};
    var usedAgents = {};
    var diagramEdges = [];

    rules.forEach(function(rule, idx) {
        if (rule.enabled === false) return;

        var sourceStatuses = parseSourceStatuses(rule.jql);
        var issueTypes = parseIssueTypes(rule.jql);
        var agent = agentNode(rule.configFile, idx);
        usedAgents[agent] = true;

        appendRuleEdges(diagramEdges, usedStatuses, rule, agent, sourceStatuses);
        lines.push(ruleTableRow(rule, idx, issueTypes, sourceStatuses));
    });

    lines.push('');

    // Mermaid flowchart
    lines.push('## Flow diagram');
    lines.push('');
    lines.push('```mermaid');
    lines.push('flowchart TD');

    Object.keys(usedStatuses).sort().forEach(function(status) {
        lines.push('    ' + statusNode(status));
    });

    diagramEdges.forEach(function(edge) {
        lines.push(edge);
    });

    lines.push('```');
    lines.push('');
    lines.push('---');
    lines.push('_Generated by js/agentWorkflowGraph.js_');

    fs.writeFileSync(WORKFLOW_MD, lines.join('\n'));
    console.log('✅ Generated', WORKFLOW_MD);
    return { success: true, rules: rules.length };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        generate: generate,
        rulesOfSm: rulesOfSm,
        appendRuleEdges: appendRuleEdges,
        skipLabelsCell: skipLabelsCell,
        ruleTableRow: ruleTableRow
    };
}

if (require.main === module) {
    generate();
}
