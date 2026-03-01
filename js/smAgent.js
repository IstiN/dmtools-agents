/**
 * SM Agent — Scrum Master automation (JSRunner)
 *
 * Reads an array of rules from params.rules (defined in agents/sm.json)
 * and for each rule:
 *   1. Queries Jira by rule.jql
 *   2. Optionally transitions each ticket to rule.targetStatus
 *   3. Triggers an ai-teammate GitHub Actions workflow for each ticket
 *
 * Rule fields:
 *   jql          (required) — JQL to find tickets
 *   configFile   (required) — agents/*.json to pass as config_file workflow input
 *   description  (optional) — human-readable label shown in logs
 *   targetStatus (optional) — Jira status to transition tickets to before triggering
 *   workflowFile (optional) — GitHub Actions workflow file  (default: ai-teammate.yml)
 *   workflowRef  (optional) — git ref for dispatch           (default: main)
 *   skipIfLabel  (optional) — skip ticket if it already has this label (idempotency)
 *   addLabel     (optional) — add this label after triggering (idempotency marker)
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildEncodedConfig(ticketKey) {
    return encodeURIComponent(JSON.stringify({
        params: { inputJql: 'key = ' + ticketKey }
    }));
}

function triggerWorkflow(repoInfo, ticketKey, rule) {
    var workflowFile = rule.workflowFile || 'ai-teammate.yml';
    var workflowRef  = rule.workflowRef  || 'main';
    try {
        github_trigger_workflow(
            repoInfo.owner,
            repoInfo.repo,
            workflowFile,
            JSON.stringify({
                concurrency_key: ticketKey,
                config_file:     rule.configFile,
                encoded_config:  buildEncodedConfig(ticketKey)
            }),
            workflowRef
        );
        console.log('  ✅ Triggered ' + workflowFile + '@' + workflowRef + ' for ' + ticketKey);
        return true;
    } catch (e) {
        console.warn('  ⚠️  Workflow trigger failed for ' + ticketKey + ': ' + (e.message || e));
        return false;
    }
}

function moveStatus(ticketKey, targetStatus) {
    try {
        jira_move_to_status({ key: ticketKey, statusName: targetStatus });
        console.log('  ✅ ' + ticketKey + ' → ' + targetStatus);
    } catch (e) {
        console.warn('  ⚠️  Status transition failed for ' + ticketKey + ': ' + (e.message || e));
    }
}

function hasLabel(ticket, label) {
    if (!label) return false;
    var labels = (ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
    return labels.indexOf(label) !== -1;
}

// ─── Rule processor ───────────────────────────────────────────────────────────

function processRule(rule, repoInfo, ruleIndex) {
    var label = rule.description || ('Rule #' + (ruleIndex + 1));
    console.log('\n══ ' + label + ' ══');
    console.log('   JQL: ' + rule.jql);

    if (!rule.jql || !rule.configFile) {
        console.warn('  ⚠️  Skipping rule — jql and configFile are required');
        return { processed: 0, skipped: 0 };
    }

    var tickets = [];
    try {
        tickets = jira_search_by_jql({ jql: rule.jql, limit: 50, fields: ['key', 'labels'] }) || [];
    } catch (e) {
        console.error('  ❌ Jira query failed: ' + (e.message || e));
        return { processed: 0, skipped: 0 };
    }

    if (tickets.length === 0) {
        console.log('  No tickets found.');
        return { processed: 0, skipped: 0 };
    }

    console.log('  Found ' + tickets.length + ' ticket(s)');

    var processed = 0;
    var skipped   = 0;

    tickets.forEach(function(ticket) {
        var key = ticket.key;

        if (rule.skipIfLabel && hasLabel(ticket, rule.skipIfLabel)) {
            console.log('  ⏭️  ' + key + ' skipped (label: ' + rule.skipIfLabel + ')');
            skipped++;
            return;
        }

        if (rule.targetStatus) {
            moveStatus(key, rule.targetStatus);
        }

        var triggered = triggerWorkflow(repoInfo, key, rule);

        if (triggered && rule.addLabel) {
            try { jira_add_label({ key: key, label: rule.addLabel }); } catch (e) {}
        }

        if (triggered) processed++;
    });

    return { processed: processed, skipped: skipped };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function action(params) {
    var p     = params.jobParams || params;
    var rules = p.rules;

    if (!rules || rules.length === 0) {
        console.error('❌ No rules defined in jobParams.rules');
        return { success: false, error: 'No rules defined' };
    }

    if (!p.owner || !p.repo) {
        console.error('❌ jobParams.owner and jobParams.repo are required');
        return { success: false, error: 'Missing owner or repo' };
    }

    var repoInfo = { owner: p.owner, repo: p.repo };
    console.log('SM Agent — ' + repoInfo.owner + '/' + repoInfo.repo + ' (' + rules.length + ' rules)');

    var totalProcessed = 0;
    var totalSkipped   = 0;

    rules.forEach(function(rule, i) {
        var result = processRule(rule, repoInfo, i);
        totalProcessed += result.processed;
        totalSkipped   += result.skipped;
    });

    console.log('\n══ SM Agent complete — processed: ' + totalProcessed + ', skipped: ' + totalSkipped + ' ══');
    return { success: true, processed: totalProcessed, skipped: totalSkipped };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
