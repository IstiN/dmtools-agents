/**
 * Develop Bug and Create PR Post-Action
 * postJSAction for bug_development agent.
 *
 * Four possible outcomes determined by outputs written by the CLI agent:
 *
 *   outputs/blocked.json      → Bug cannot be fixed (needs human / credentials / etc.)
 *                               → Post Jira comment, move to Blocked, remove labels
 *
 *   outputs/already_fixed.json → Bug was fixed in a prior commit, no new code changes
 *                               → Post Jira comment with commit ref, move to Merged
 *                                 (SM then runs bug_merged → RCA/Solution field → Ready For Testing)
 *
 *   (neither file, but response.md missing) → CLI agent was interrupted (rate limit / crash)
 *                               → Push partial work (e.g. outputs/rca.md) if any
 *                               → Post informational comment, move to Ready For Development for retry
 *
 *   (neither file, response.md present) → Normal fix — code changes made
 *                               → Delegate to developTicketAndCreatePR: commit, push, create PR, move to In Review
 */

var configLoader = require('./configLoader.js');
const { STATUSES, LABELS, resolveStatuses } = require('./config.js');
const developTicket = require('./developTicketAndCreatePR.js');

function readJson(path) {
    try {
        const raw = file_read({ path: path });
        return (raw && raw.trim()) ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function removeLabels(ticketKey, params) {
    const wipLabel = params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip' : null;
    if (wipLabel) {
        try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
    }

    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;
    if (removeLabel) {
        try {
            jira_remove_label({ key: ticketKey, label: removeLabel });
            console.log('✅ Removed SM label:', removeLabel);
        } catch (e) {}
    }
}

function action(params) {
    try {
        const actualParams = params.ticket ? params : (params.jobParams || params);
        const ticketKey = actualParams.ticket.key;
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        const _customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
        const statuses = resolveStatuses(_customParams);

        console.log('=== Bug development post-action for', ticketKey, '===');

        // ── Path 0: PR already open — skip re-development ───────────────────
        // If a PR already exists for this ticket's branch, the previous run created
        // it but failed to move the ticket to In Review (e.g. was interrupted).
        // Move to In Review now and skip development entirely.
        const expectedBranch = configLoader.resolveBranchName(config, actualParams.ticket, 'development');
        try {
            const existingPrJson = cli_execute_command({
                command: 'gh pr list --head ' + expectedBranch + ' --state open --json url,number --jq ".[0]"'
            }) || '';
            const cleanedPrJson = existingPrJson.split('\n').filter(function(l) {
                return l.trim() && l.indexOf('Script started') === -1 && l.indexOf('Script done') === -1;
            }).join('').trim();
            if (cleanedPrJson && cleanedPrJson !== 'null') {
                let existingPr = null;
                try { existingPr = JSON.parse(cleanedPrJson); } catch (e) {}
                if (existingPr && existingPr.url) {
                    console.log('⚠️  PR already open for', ticketKey, ':', existingPr.url, '— skipping re-development');
                    try {
                        jira_post_comment({
                            key: ticketKey,
                            comment: 'h3. ℹ️ PR Already Open\n\n' +
                                'A pull request already exists for this ticket: ' + existingPr.url + '\n\n' +
                                'Moved ticket to *In Review* for review.'
                        });
                    } catch (e) {}
                    try {
                        jira_move_to_status({ key: ticketKey, statusName: statuses.IN_REVIEW });
                        console.log('✅ Moved', ticketKey, 'to In Review');
                    } catch (e) { console.warn('Failed to move to In Review:', e); }
                    removeLabels(ticketKey, params);
                    return { success: true, path: 'pr_already_open', ticketKey };
                }
            }
        } catch (prCheckErr) {
            console.warn('Could not check existing PRs (non-fatal):', prCheckErr);
        }

        // ── Path 1: Blocked ──────────────────────────────────────────────────
        const blocked = readJson('outputs/blocked.json');
        if (blocked) {
            console.log('outputs/blocked.json found — bug cannot be fixed automatically');

            let comment = 'h3. 🚫 Bug Cannot Be Fixed Automatically\n\n';
            comment += '*Reason*: ' + (blocked.reason || '(see details below)') + '\n\n';
            if (blocked.tried && blocked.tried.length > 0) {
                comment += '*Attempted*:\n';
                blocked.tried.forEach(function(t) { comment += '- ' + t + '\n'; });
                comment += '\n';
            }
            if (blocked.needs) {
                comment += '*Needs from human*: ' + blocked.needs + '\n';
            }

            try { jira_post_comment({ key: ticketKey, comment: comment }); } catch (e) {}

            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.BLOCKED });
                console.log('✅ Moved', ticketKey, 'to Blocked');
            } catch (e) {
                console.warn('Failed to move to Blocked:', e);
            }

            removeLabels(ticketKey, params);
            return { success: true, path: 'blocked', ticketKey };
        }

        // ── Path 2: Already Fixed ────────────────────────────────────────────
        const alreadyFixed = readJson('outputs/already_fixed.json');
        if (alreadyFixed) {
            console.log('outputs/already_fixed.json found — bug already resolved in codebase');

            let comment = 'h3. ✅ Bug Already Fixed\n\n';
            if (alreadyFixed.rca) {
                comment += '*Root Cause*: ' + alreadyFixed.rca + '\n\n';
            }
            if (alreadyFixed.commit) {
                comment += '*Fixed in commit*: {code}' + alreadyFixed.commit + '{code}\n\n';
            }
            if (alreadyFixed.description) {
                comment += alreadyFixed.description + '\n\n';
            }
            comment += 'No new PR required — fix is already in the codebase. Moved to *Merged* so the Solution field and RCA are generated before test cases.';

            try { jira_post_comment({ key: ticketKey, comment: comment }); } catch (e) {}

            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.MERGED });
                console.log('✅ Moved', ticketKey, 'to Merged');
            } catch (e) {
                console.warn('Failed to move to Merged:', e);
            }

            try { jira_add_label({ key: ticketKey, label: LABELS.AI_DEVELOPED }); } catch (e) {}

            removeLabels(ticketKey, params);
            return { success: true, path: 'already_fixed', ticketKey };
        }

        // ── Path 3: Normal Fix — code changes present ────────────────────────
        console.log('No special outputs found — proceeding with normal PR creation');

        // Before delegating, check if the CLI agent was interrupted (no response.md, no code changes).
        // If there ARE git changes (e.g. outputs/rca.md written) but no response.md, the agent
        // was interrupted mid-way. Push partial work and reset ticket for retry.
        const actualParamsForCheck = params.ticket ? params : (params.jobParams || params);
        const ticketKeyForCheck = actualParamsForCheck.ticket.key;

        let hasGitChanges = false;
        try {
            cli_execute_command({ command: 'git add .' });
            const rawStatus = cli_execute_command({ command: 'git status --porcelain' }) || '';
            const statusLines = rawStatus.split('\n').filter(function(l) {
                return l.trim() &&
                       l.indexOf('Script started') === -1 &&
                       l.indexOf('Script done') === -1;
            });
            hasGitChanges = statusLines.length > 0;
        } catch (e) {
            console.warn('Could not check git status:', e);
        }

        let hasResponseMd = false;
        try {
            const r = file_read({ path: 'outputs/response.md' });
            hasResponseMd = !!(r && r.trim());
        } catch (e) {}

        if (!hasResponseMd) {
            // CLI agent did not finish (rate limit / crash). Push whatever partial work exists
            // (e.g. outputs/rca.md) and reset the ticket so SM can retry.
            console.log('outputs/response.md missing — CLI agent was interrupted. Resetting ticket for retry.');

            if (hasGitChanges) {
                console.log('Partial git changes found — pushing to preserve analysis work...');
                try {
                    const rawBranch = cli_execute_command({ command: 'git branch --show-current' }) || '';
                    const partialBranch = rawBranch.split('\n').filter(function(l) {
                        return l.trim() &&
                               l.indexOf('Script started') === -1 &&
                               l.indexOf('Script done') === -1;
                    }).join('').trim();
                    if (partialBranch) {
                        cli_execute_command({ command: 'git config user.name "' + config.git.authorName + '"' });
                        cli_execute_command({ command: 'git config user.email "' + config.git.authorEmail + '"' });
                        cli_execute_command({ command: 'git commit -m "' + configLoader.formatTemplate(config.formats.commitMessage.wip, {ticketKey: ticketKeyForCheck}) + '"' });
                        cli_execute_command({ command: 'git push -u origin ' + partialBranch });
                        console.log('✅ Pushed partial analysis to branch:', partialBranch);
                    }
                } catch (pushErr) {
                    console.warn('Could not push partial work:', pushErr);
                }
            } else {
                console.log('No git changes — nothing to push.');
            }

            // Post informational comment
            try {
                jira_post_comment({
                    key: ticketKeyForCheck,
                    comment: 'h3. ⏸️ Development Interrupted\n\nThe AI agent was interrupted (likely hit a rate limit) before completing the implementation. The ticket has been reset to *Ready For Development* and will be automatically retried.\n\n' +
                        (hasGitChanges ? 'Partial analysis work was saved to the branch.' : 'No partial work was produced.')
                });
            } catch (e) {}

            // Move ticket back to Ready For Development for retry
            try {
                jira_move_to_status({ key: ticketKeyForCheck, statusName: statuses.READY_FOR_DEVELOPMENT });
                console.log('✅ Moved', ticketKeyForCheck, 'to Ready For Development for retry');
            } catch (e) {
                console.warn('Failed to move ticket to Ready For Development:', e);
            }

            removeLabels(ticketKeyForCheck, params);
            return { success: true, path: 'interrupted', ticketKey: ticketKeyForCheck };
        }

        const result = developTicket.action(params);

        // Always remove SM idempotency label — even on failure — to avoid permanent lock
        // (developTicketAndCreatePR doesn't know about SM labels)
        removeLabels(ticketKey, params);

        return result;

    } catch (error) {
        console.error('❌ Error in developBugAndCreatePR:', error);
        try {
            const key = (params.ticket || (params.jobParams && params.jobParams.ticket) || {}).key;
            if (key) {
                jira_post_comment({
                    key: key,
                    comment: 'h3. ❌ Bug Development Error\n\n{code}' + error.toString() + '{code}'
                });
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
