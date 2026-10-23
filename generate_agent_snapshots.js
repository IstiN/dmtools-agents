#!/usr/bin/env node
/**
 * Generate aggregated prompt snapshots for all agent JSON configs.
 *
 * Reads every *.json file in the repo root, resolves cliPrompts + cliPromptsByTracker
 * (entries ending with .md are inlined, plain text is kept as-is),
 * and writes a single Markdown file per agent into snapshots/.
 *
 * Usage (from dmtools-agents repo root):
 *    node generate_agent_snapshots.js
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const AGENTS_DIR = REPO_ROOT;
const SNAPSHOTS_DIR = path.join(REPO_ROOT, 'snapshots');

const LEDGER_FILE = 'versions.json';
const NON_AGENT_ROOT_JSON = {
    'versions.json': true,
    '.crap-baseline.json': true
};

function resolvePromptEntry(entry) {
    const trimmed = entry.trim();
    if (trimmed.endsWith('.md')) {
        // JSON references may use ./agents/... prefix, but in dmtools-agents
        // the files live directly under instructions/, prompts/, etc.
        const normalized = trimmed
            .replace(/^\.\/agents\//, '')
            .replace(/^\/agents\//, '')
            .replace(/^agents\//, '');
        const filePath = path.join(REPO_ROOT, normalized);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf-8');
        }
        return `<!-- MISSING FILE: ${trimmed} (tried ${normalized}) -->\n`;
    }
    return trimmed;
}

function generateSnapshot(agentJsonPath) {
    const raw = fs.readFileSync(agentJsonPath, 'utf-8');
    const data = JSON.parse(raw);
    const params = data.params || {};
    const agentName = path.basename(agentJsonPath, '.json');
    const contextId = (params.metadata && params.metadata.contextId) || agentName;

    const lines = [];
    lines.push(`# Agent Snapshot: \`${agentName}\``);
    lines.push('');
    lines.push(`- **Context ID**: \`${contextId}\``);
    lines.push('');

    // Base cliPrompts
    const basePrompts = params.cliPrompts || [];
    if (basePrompts.length > 0) {
        lines.push('## Base cliPrompts');
        lines.push('');
        let promptIdx = 0;
        basePrompts.forEach((entry) => {
            const items = [];
            let sectionMeta = null;
            if (typeof entry === 'string') {
                items.push(entry);
            } else if (entry && typeof entry === 'object') {
                sectionMeta = {
                    id: entry.id || null,
                    condition: entry.condition || null
                };
                if (typeof entry.prompt === 'string') {
                    items.push(entry.prompt);
                }
                if (Array.isArray(entry.prompts)) {
                    entry.prompts.forEach((p) => {
                        if (typeof p === 'string') items.push(p);
                    });
                }
            }
            items.forEach((promptStr) => {
                promptIdx += 1;
                const resolved = resolvePromptEntry(promptStr);
                const condSuffix = sectionMeta && sectionMeta.condition
                    ? ` _(conditional: \`${sectionMeta.condition}\`)_`
                    : '';
                if (promptStr.endsWith('.md')) {
                    lines.push(`### [${promptIdx}] \`${promptStr}\`${condSuffix}`);
                    lines.push('');
                    lines.push(resolved);
                } else {
                    lines.push(`### [${promptIdx}] Role / Plain Text${condSuffix}`);
                    lines.push('');
                    lines.push(resolved);
                }
                lines.push('');
                lines.push('---');
                lines.push('');
            });
        });
    }

    // cliPromptsByTracker
    const trackerPrompts = params.cliPromptsByTracker || {};
    const trackerKeys = Object.keys(trackerPrompts);
    if (trackerKeys.length > 0) {
        lines.push('## cliPromptsByTracker');
        lines.push('');
        trackerKeys.forEach((trackerType) => {
            lines.push(`### Tracker: \`${trackerType}\``);
            lines.push('');
            trackerPrompts[trackerType].forEach((entry, idx) => {
                const resolved = resolvePromptEntry(entry);
                if (entry.endsWith('.md')) {
                    lines.push(`#### [${idx + 1}] \`${entry}\``);
                    lines.push('');
                    lines.push(resolved);
                } else {
                    lines.push(`#### [${idx + 1}] Plain Text`);
                    lines.push('');
                    lines.push(resolved);
                }
                lines.push('');
                lines.push('---');
                lines.push('');
            });
        });
    }

    // Legacy cliPrompt (scalar)
    const legacyCliPrompt = params.cliPrompt;
    if (legacyCliPrompt) {
        lines.push('## Legacy cliPrompt (scalar)');
        lines.push('');
        const resolved = resolvePromptEntry(legacyCliPrompt);
        if (legacyCliPrompt.endsWith('.md')) {
            lines.push(`### \`${legacyCliPrompt}\``);
            lines.push('');
        }
        lines.push(resolved);
        lines.push('');
        lines.push('---');
        lines.push('');
    }

    // Legacy agentParams
    const agentParams = params.agentParams;
    if (agentParams) {
        lines.push('## Legacy agentParams');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(agentParams, null, 2));
        lines.push('```');
        lines.push('');
        lines.push('---');
        lines.push('');
    }

    return lines.join('\n');
}

function main() {
    const files = fs.readdirSync(AGENTS_DIR)
        .filter((f) => f.endsWith('.json') && !NON_AGENT_ROOT_JSON[f] && !f.startsWith('.'))
        .sort();

    if (files.length === 0) {
        console.warn(`WARNING: No JSON files found in ${AGENTS_DIR}`);
        process.exit(0);
    }

    if (!fs.existsSync(SNAPSHOTS_DIR)) {
        fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }

    files.forEach((filename) => {
        const agentJsonPath = path.join(AGENTS_DIR, filename);
        const snapshotMd = generateSnapshot(agentJsonPath);
        const outPath = path.join(SNAPSHOTS_DIR, `${path.basename(filename, '.json')}.md`);
        fs.writeFileSync(outPath, snapshotMd, 'utf-8');
        console.log(`✅ Written ${outPath}`);
    });

    console.log(`\nDone. ${files.length} agent snapshots generated in ${SNAPSHOTS_DIR}/`);
}

main();
