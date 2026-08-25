/**
 * Apply Agent Docs Update — post-action for agent_docs_writer.json.
 *
 * Copies the rewritten human docs from outputs/agent_docs/*.md to
 * docs/agents/<name>.md, then regenerates docs/agents/generated/* via
 * js/agentDocGenerator.js (Node) so the commit carries both layers.
 *
 * The calling workflow is responsible for committing/pushing the result.
 */

var EXCLUDED = { 'sm.json': true, 'sm_merge.json': true };

function action(params) {
    try {
        var listing = cli_execute_command({ command: 'ls outputs/agent_docs 2>/dev/null || true' });
        var files = (listing || '').split('\n').filter(function(f) {
            return f && f.trim().match(/^[a-zA-Z0-9_]+\.md$/);
        });

        if (files.length === 0) {
            console.log('applyAgentDocsUpdate: nothing to apply');
            return { success: true, action: 'no_changes' };
        }

        var applied = 0;
        files.forEach(function(f) {
            var name = f.trim().replace(/\.md$/, '');
            var content;
            try {
                content = file_read('outputs/agent_docs/' + f.trim());
            } catch (e) {
                console.warn('applyAgentDocsUpdate: cannot read outputs/agent_docs/' + f + ':', e);
                return;
            }
            if (!content || !content.trim()) return;
            file_write('docs/agents/' + name + '.md', content);
            applied++;
        });

        console.log('applyAgentDocsUpdate: wrote ' + applied + ' human doc(s), regenerating generated docs...');
        try {
            cli_execute_command({ command: 'node js/agentDocGenerator.js' });
        } catch (e) {
            console.warn('applyAgentDocsUpdate: doc regeneration failed (non-fatal, CI freshness check will catch it):', e);
        }

        return { success: true, action: 'applied', applied: applied };
    } catch (error) {
        console.error('Error in applyAgentDocsUpdate:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
