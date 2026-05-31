/**
 * DF Manager — deterministic Dark Factory watchdog.
 *
 * Audits Jira labels, GitHub PRs, and workflow runs for stuck automation states.
 * By default it is read-only and writes outputs/df_manager_report.json.
 * Set customParams.autoRecover=true to execute safe recovery actions.
 */

var configLoader = require('./configLoader.js');
var scmModule = require('./common/scm.js');

var DEFAULT_SM_LABELS = [
    'sm_story_ba_check_triggered',
    'sm_story_acceptance_criteria_triggered',
    'sm_story_acceptance_criterias_triggered',
    'sm_story_solution_triggered',
    'sm_po_refinement_triggered',
    'sm_story_questions_triggered',
    'sm_task_intake_triggered',
    'sm_story_development_triggered',
    'sm_bug_development_triggered',
    'sm_bug_creation_triggered',
    'sm_story_review_triggered',
    'sm_pr_review_triggered',
    'sm_story_rework_triggered',
    'sm_pr_rework_triggered',
    'sm_pr_merge_triggered',
    'sm_test_cases_triggered',
    'sm_bug_merged_triggered',
    'sm_bug_test_cases_triggered',
    'sm_story_done_check_triggered',
    'sm_bug_done_check_triggered',
    'sm_task_done_check_triggered',
    'sm_test_automation_triggered',
    'sm_test_review_triggered',
    'sm_test_rework_triggered'
];

function parseJsonMaybe(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (e) { return fallback; }
}

function asArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value.values && Array.isArray(value.values)) return value.values;
    if (value.items && Array.isArray(value.items)) return value.items;
    if (value.workflow_runs && Array.isArray(value.workflow_runs)) return value.workflow_runs;
    if (value.result && Array.isArray(value.result)) return value.result;
    return [];
}

function uniq(values) {
    var seen = {};
    return (values || []).filter(function(value) {
        if (!value || seen[value]) return false;
        seen[value] = true;
        return true;
    });
}

function normalizeLabelNames(labels) {
    return (labels || []).map(function(label) {
        return typeof label === 'string' ? label : (label && label.name);
    }).filter(function(label) { return !!label; });
}

function ticketStatus(ticket) {
    return ticket && ticket.fields && ticket.fields.status && ticket.fields.status.name || '';
}

function ticketLabels(ticket) {
    return normalizeLabelNames(ticket && ticket.fields && ticket.fields.labels || []);
}

function ticketUpdatedAt(ticket) {
    return ticket && ticket.fields && ticket.fields.updated || ticket && ticket.updated || null;
}

function ticketAgeMinutes(ticket, nowMs) {
    var updated = ticketUpdatedAt(ticket);
    if (!updated) return null;
    var parsed = Date.parse(updated);
    if (isNaN(parsed)) return null;
    return Math.floor((nowMs - parsed) / 60000);
}

function prLabels(pr) {
    return normalizeLabelNames(pr && pr.labels || []);
}

function prHeadRef(pr) {
    return pr && pr.head && pr.head.ref || pr && pr.headRefName || pr && pr.sourceBranch || '';
}

function prTitle(pr) {
    return pr && pr.title || '';
}

function prMergeState(pr) {
    return pr && (pr.mergeable_state || pr.mergeStateStatus || pr.merge_state_status || '').toString().toLowerCase();
}

function prUrl(pr) {
    return pr && (pr.html_url || pr.url || pr.web_url) || '';
}

function extractTicketKey(text) {
    var match = String(text || '').match(/[A-Z][A-Z0-9]+-\d+/);
    return match ? match[0] : null;
}

function runText(run) {
    return [
        run && run.name,
        run && run.display_title,
        run && run.displayTitle,
        run && run.head_branch,
        run && run.headBranch,
        run && run.workflowName,
        run && run.event
    ].filter(function(part) { return !!part; }).join(' ');
}

function runStatus(run) {
    return (run && run.status || '').toString().toLowerCase();
}

function runConclusion(run) {
    return (run && run.conclusion || '').toString().toLowerCase();
}

function runUrl(run) {
    return run && (run.html_url || run.url) || '';
}

function isActiveRun(run) {
    var status = runStatus(run);
    return status === 'queued' || status === 'pending' || status === 'requested' ||
        status === 'waiting' || status === 'in_progress';
}

function isFailedRun(run) {
    return runStatus(run) === 'completed' && runConclusion(run) === 'failure';
}

function activeRunMatchesTicket(activeRuns, ticketKey) {
    return activeRuns.some(function(run) {
        return runText(run).indexOf(ticketKey) !== -1;
    });
}

function collectLabelsFromRules(rules) {
    var labels = [];
    (rules || []).forEach(function(rule) {
        if (!rule || rule.enabled === false) return;
        if (rule.addLabel) labels.push(rule.addLabel);
        if (rule.skipIfLabel) labels.push(rule.skipIfLabel);
        (rule.addLabels || []).forEach(function(label) { labels.push(label); });
        (rule.skipIfLabels || []).forEach(function(label) { labels.push(label); });
    });
    return labels;
}

function extractStatusesFromJql(jql) {
    var text = String(jql || '');
    var statuses = [];
    var inMatch = text.match(/status\s+in\s*\(([^)]+)\)/i);
    if (inMatch) {
        statuses = inMatch[1].split(',').map(function(item) {
            return item.replace(/^['"\s]+|['"\s]+$/g, '');
        }).filter(function(item) { return !!item; });
    }
    var eqMatch = text.match(/status\s*=\s*['"]?([^'")\s]+(?:\s+[^'")]+)*)['"]?/i);
    if (!statuses.length && eqMatch) {
        statuses = [eqMatch[1].trim()];
    }
    return statuses;
}

function extractExcludedStatusesFromJql(jql) {
    var text = String(jql || '');
    var statuses = [];
    var notInMatch = text.match(/status\s+not\s+in\s*\(([^)]+)\)/i);
    if (notInMatch) {
        statuses = notInMatch[1].split(',').map(function(item) {
            return item.replace(/^['"\s]+|['"\s]+$/g, '');
        }).filter(function(item) { return !!item; });
    }
    return statuses;
}

function buildLabelStatusMap(rules) {
    var map = {};
    (rules || []).forEach(function(rule) {
        if (!rule || rule.enabled === false) return;
        var labels = [];
        if (rule.addLabel) labels.push(rule.addLabel);
            if (rule.skipIfLabel) labels.push(rule.skipIfLabel);
            (rule.addLabels || []).forEach(function(label) { labels.push(label); });
            (rule.skipIfLabels || []).forEach(function(label) { labels.push(label); });
        var includeStatuses = extractStatusesFromJql(rule.jql);
        var excludeStatuses = extractExcludedStatusesFromJql(rule.jql);
        labels.forEach(function(label) {
            if (!map[label]) map[label] = { include: [], exclude: [] };
            map[label].include = uniq(map[label].include.concat(includeStatuses));
            map[label].exclude = uniq(map[label].exclude.concat(excludeStatuses));
        });
    });
    return map;
}

function isLabelActiveForStatus(labelStatusRule, status) {
    if (!labelStatusRule) return true;
    var include = labelStatusRule.include || [];
    var exclude = labelStatusRule.exclude || [];
    if (exclude.indexOf(status) !== -1) return false;
    if (include.length > 0) return include.indexOf(status) !== -1;
    return true;
}

function loadSmRules(params) {
    if (params.rules && Array.isArray(params.rules)) return params.rules;
    if (params.smRules && Array.isArray(params.smRules)) return params.smRules;
    try {
        var raw = file_read({ path: params.smConfigPath || 'agents/sm.json' });
        var parsed = JSON.parse(raw);
        return parsed && parsed.params && parsed.params.jobParams && parsed.params.jobParams.rules || [];
    } catch (e) {
        console.warn('DF Manager: could not read sm rules:', e.message || e);
        return [];
    }
}

function resolveSmLabels(params, rules) {
    return uniq([].concat(
        DEFAULT_SM_LABELS,
        collectLabelsFromRules(rules),
        params.smLabels || []
    ));
}

function buildSmLabelJql(projectKey, labels) {
    var quoted = labels.map(function(label) { return '"' + String(label).replace(/"/g, '\\"') + '"'; });
    return 'project = ' + projectKey + ' AND labels in (' + quoted.join(', ') + ') ORDER BY updated ASC';
}

function searchJiraTickets(projectKey, labels, limit) {
    if (!labels.length) return [];
    var jql = buildSmLabelJql(projectKey, labels);
    var result = jira_search_by_jql({
        jql: jql,
        fields: ['summary', 'status', 'labels', 'updated', 'issuetype'],
        maxResults: limit || 100
    });
    return asArray(parseJsonMaybe(result, result));
}

function listWorkflowRuns(scm, status, limit) {
    try {
        return asArray(parseJsonMaybe(scm.listWorkflowRuns(status, null, limit || 100), []));
    } catch (e) {
        console.warn('DF Manager: could not list workflow runs for status ' + status + ':', e.message || e);
        return [];
    }
}

function listOpenPrs(scm) {
    try {
        return asArray(parseJsonMaybe(scm.listPrs('open'), []));
    } catch (e) {
        console.warn('DF Manager: could not list open PRs:', e.message || e);
        return [];
    }
}

function appendAnomaly(anomalies, item) {
    anomalies.push(item);
    console.log('DF anomaly [' + item.severity + '] ' + item.type + (item.ticketKey ? ' ' + item.ticketKey : '') +
        (item.prNumber ? ' PR #' + item.prNumber : '') + ': ' + item.message);
}

function detectStaleSmLabels(context) {
    var staleMinutes = context.staleMinutes;
    context.tickets.forEach(function(ticket) {
        var key = ticket.key;
        if (!key) return;
        var status = ticketStatus(ticket);
        var labels = ticketLabels(ticket).filter(function(label) {
            return context.smLabelSet[label] === true;
        });
        if (!labels.length) return;
        if (activeRunMatchesTicket(context.activeRuns, key)) return;

        var age = ticketAgeMinutes(ticket, context.nowMs);
        var isOldEnough = age === null || age >= staleMinutes;
        if (!isOldEnough) return;

        var sourceStateLabels = labels.filter(function(label) {
            return isLabelActiveForStatus(context.labelStatusMap[label], status);
        });
        if (!sourceStateLabels.length) {
            appendAnomaly(context.anomalies, {
                type: 'obsolete-sm-label',
                severity: 'info',
                ticketKey: key,
                status: status,
                labels: labels,
                ageMinutes: age,
                safeAction: 'remove-sm-labels',
                message: 'SM trigger label remains after the ticket moved out of the rule source status.'
            });
            return;
        }

        appendAnomaly(context.anomalies, {
            type: 'stale-sm-label',
            severity: 'blocking',
            ticketKey: key,
            status: status,
            labels: sourceStateLabels,
            ageMinutes: age,
            safeAction: 'remove-sm-labels-and-trigger-sm',
            message: 'SM trigger label exists but no active workflow run contains the ticket key.'
        });
    });
}

function detectPrMergeGaps(context) {
    context.prs.forEach(function(pr) {
        var key = extractTicketKey(prTitle(pr) + ' ' + prHeadRef(pr));
        var labels = prLabels(pr);
        var state = prMergeState(pr);
        var number = pr.number || pr.pullRequestId || pr.id;
        if (!key || !number) return;

        var ticket = context.ticketByKey[key];
        var jiraLabels = ticket ? ticketLabels(ticket) : [];
        var hasApproval = labels.indexOf('pr_approved') !== -1 || jiraLabels.indexOf('pr_approved') !== -1;

        if (hasApproval && (state === 'clean' || state === 'mergeable')) {
            appendAnomaly(context.anomalies, {
                type: 'approved-pr-not-merged',
                severity: 'blocking',
                ticketKey: key,
                prNumber: number,
                prUrl: prUrl(pr),
                mergeState: state,
                safeAction: 'trigger-sm-retry-merge',
                message: 'PR is approved and clean but still open.'
            });
        } else if (hasApproval && (state === 'dirty' || state === 'behind')) {
            appendAnomaly(context.anomalies, {
                type: 'approved-pr-not-mergeable',
                severity: 'warning',
                ticketKey: key,
                prNumber: number,
                prUrl: prUrl(pr),
                mergeState: state,
                safeAction: state === 'behind' ? 'request-branch-update' : null,
                message: 'PR is approved but not currently mergeable.'
            });
        }
    });
}

function detectFailedRuns(context) {
    context.failedRuns.forEach(function(run) {
        var key = extractTicketKey(runText(run));
        appendAnomaly(context.anomalies, {
            type: 'failed-workflow-run',
            severity: 'warning',
            ticketKey: key,
            runUrl: runUrl(run),
            workflow: run.workflowName || run.name || '',
            message: 'Recent workflow run failed.'
        });
    });
}

function detectDuplicateRuns(context) {
    var grouped = {};
    context.activeRuns.forEach(function(run) {
        var key = extractTicketKey(runText(run));
        if (!key) return;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(run);
    });
    Object.keys(grouped).forEach(function(key) {
        if (grouped[key].length <= 1) return;
        appendAnomaly(context.anomalies, {
            type: 'duplicate-active-runs',
            severity: 'warning',
            ticketKey: key,
            runUrls: grouped[key].map(runUrl).filter(function(url) { return !!url; }),
            message: 'Multiple active workflow runs reference the same ticket.'
        });
    });
}

function detectRepeatedFailureLoops(context) {
    var grouped = {};

    context.failedRuns.forEach(function(run) {
        var key = extractTicketKey(runText(run));
        if (!key) return;
        if (!grouped[key]) {
            grouped[key] = {
                total: 0,
                workflows: {},
                urls: []
            };
        }

        var bucket = grouped[key];
        var workflow = run.workflowName || run.name || 'unknown-workflow';
        bucket.total += 1;
        bucket.workflows[workflow] = (bucket.workflows[workflow] || 0) + 1;
        var url = runUrl(run);
        if (url) bucket.urls.push(url);
    });

    Object.keys(grouped).forEach(function(key) {
        var bucket = grouped[key];
        if (bucket.total < 3) return;

        var ticket = context.ticketByKey[key];
        var status = ticketStatus(ticket);
        var labelCount = ticketLabels(ticket).filter(function(label) {
            return context.smLabelSet[label] === true;
        }).length;
        var workflows = Object.keys(bucket.workflows).map(function(name) {
            return name + '×' + bucket.workflows[name];
        }).join(', ');

        appendAnomaly(context.anomalies, {
            type: 'repeated-failure-loop',
            severity: (status === 'Failed' || labelCount > 0 || bucket.total >= 5) ? 'blocking' : 'warning',
            ticketKey: key,
            workflowRuns: bucket.total,
            workflows: bucket.workflows,
            runUrls: uniq(bucket.urls),
            status: status,
            message: 'Ticket has ' + bucket.total + ' failed workflow runs' +
                (workflows ? ' (' + workflows + ')' : '') +
                (status ? ' while still in ' + status + '.' : '.')
        });
    });
}

function triggerSmWorkflow(context, reason) {
    if (context.recoveryState.smTriggered) return;
    context.scm.triggerWorkflow(
        context.repoInfo.owner,
        context.repoInfo.repo,
        context.params.smWorkflowFile || 'sm.yml',
        '{}',
        context.params.workflowRef || 'main'
    );
    context.recoveryState.smTriggered = true;
    context.actions.push({ action: 'trigger-sm', reason: reason || 'df-manager' });
}

function applySafeRecovery(context) {
    if (!context.autoRecover) return;
    context.anomalies.forEach(function(anomaly) {
        if (anomaly.type === 'stale-sm-label' || anomaly.type === 'obsolete-sm-label') {
            (anomaly.labels || []).forEach(function(label) {
                jira_remove_label({ key: anomaly.ticketKey, label: label });
                context.actions.push({ action: 'remove-label', ticketKey: anomaly.ticketKey, label: label });
            });
            if (anomaly.type === 'obsolete-sm-label') return;
            triggerSmWorkflow(context, 'released stale SM label for ' + anomaly.ticketKey);
        } else if (anomaly.type === 'approved-pr-not-merged') {
            triggerSmWorkflow(context, 'retry merge for approved PR #' + anomaly.prNumber);
        } else if (anomaly.type === 'approved-pr-not-mergeable' && anomaly.safeAction === 'request-branch-update') {
            try {
                cli_execute_command({
                    command: 'gh api repos/' + context.repoInfo.owner + '/' + context.repoInfo.repo +
                        '/pulls/' + anomaly.prNumber + '/update-branch -X PUT'
                });
                context.actions.push({ action: 'request-branch-update', prNumber: anomaly.prNumber });
            } catch (e) {
                context.actions.push({
                    action: 'request-branch-update-failed',
                    prNumber: anomaly.prNumber,
                    error: e.message || String(e)
                });
            }
        }
    });
}

function writeReport(path, report) {
    var content = JSON.stringify(report, null, 2);
    try {
        file_write({ path: path, content: content });
    } catch (e) {
        file_write(path, content);
    }
}

function buildContext(params, config, scm) {
    var rules = loadSmRules(params);
    var labels = resolveSmLabels(params, rules);
    var labelSet = {};
    labels.forEach(function(label) { labelSet[label] = true; });
    var projectKey = params.jiraProject || config.jira && config.jira.project;
    if (!projectKey) throw new Error('DF Manager requires jira.project in config or customParams.jiraProject');

    var activeRuns = []
        .concat(listWorkflowRuns(scm, 'queued', params.workflowRunLimit))
        .concat(listWorkflowRuns(scm, 'in_progress', params.workflowRunLimit))
        .concat(listWorkflowRuns(scm, 'waiting', params.workflowRunLimit));
    var failedRuns = listWorkflowRuns(scm, 'completed', params.workflowRunLimit)
        .filter(isFailedRun)
        .slice(0, params.failedRunLimit || 20);
    var tickets = searchJiraTickets(projectKey, labels, params.jiraLimit || 100);
    var ticketByKey = {};
    tickets.forEach(function(ticket) { if (ticket && ticket.key) ticketByKey[ticket.key] = ticket; });

    return {
        params: params,
        config: config,
        scm: scm,
        repoInfo: (config.repository || scm.getRemoteRepoInfo() || {}),
        nowMs: params.nowMs || Date.now(),
        staleMinutes: params.staleMinutes || 45,
        smLabels: labels,
        smLabelSet: labelSet,
        labelStatusMap: buildLabelStatusMap(rules),
        tickets: tickets,
        ticketByKey: ticketByKey,
        prs: listOpenPrs(scm),
        activeRuns: activeRuns,
        failedRuns: failedRuns,
        anomalies: [],
        actions: [],
        autoRecover: params.autoRecover === true,
        recoveryState: {}
    };
}

function action(params) {
    var p = (params.jobParams && params.jobParams.customParams) || params.customParams || params.jobParams || params || {};
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var scm = scmModule.createScm(config);
    var context = buildContext(p, config, scm);

    if (!context.repoInfo.owner || !context.repoInfo.repo) {
        throw new Error('DF Manager requires repository.owner/repo in config or an SCM remote.');
    }

    detectStaleSmLabels(context);
    detectPrMergeGaps(context);
    detectFailedRuns(context);
    detectDuplicateRuns(context);
    detectRepeatedFailureLoops(context);
    applySafeRecovery(context);

    var report = {
        success: true,
        mode: context.autoRecover ? 'safe-recover' : 'audit',
        repository: context.repoInfo,
        jiraProject: p.jiraProject || config.jira && config.jira.project,
        counts: {
            smLabels: context.smLabels.length,
            ticketsWithSmLabels: context.tickets.length,
            openPrs: context.prs.length,
            activeRuns: context.activeRuns.length,
            failedRuns: context.failedRuns.length,
            anomalies: context.anomalies.length,
            actions: context.actions.length
        },
        anomalies: context.anomalies,
        actions: context.actions
    };
    writeReport(p.outputPath || 'outputs/df_manager_report.json', report);
    return report;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        buildSmLabelJql: buildSmLabelJql,
        collectLabelsFromRules: collectLabelsFromRules,
        extractTicketKey: extractTicketKey,
        detectStaleSmLabels: detectStaleSmLabels,
        detectPrMergeGaps: detectPrMergeGaps,
        detectDuplicateRuns: detectDuplicateRuns,
        buildLabelStatusMap: buildLabelStatusMap,
        extractStatusesFromJql: extractStatusesFromJql,
        extractExcludedStatusesFromJql: extractExcludedStatusesFromJql
    };
}
