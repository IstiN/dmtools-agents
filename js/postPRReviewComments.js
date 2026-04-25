/**
 * Post PR Review Comments Action
 * PostJSAction that:
 * 1. Reads outputs/pr_review.json with structured review data
 * 2. Posts general review comment to GitHub PR using github_add_pr_comment
 * 3. Posts inline code comments to GitHub PR using github_add_inline_comment
 * 4. Posts Jira-formatted review from outputs/response.md to Jira ticket
 * 5. Updates ticket status based on review outcome
 * 6. Adds labels to indicate review completion
 */

const { LABELS, STATUSES, resolveStatuses } = require('./config.js');
var scmModule = require('./common/scm.js');

/**
 * Derive project key from customParams.configPath or customParams.projectKey.
 * e.g. ".dmtools/configs/mapc.js" → "mapc"
 */
function deriveProjectKey(customParams) {
    if (!customParams) return '';
    if (customParams.projectKey) return customParams.projectKey;
    var cp = customParams.configPath || '';
    if (!cp) return '';
    var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
    return (base && base !== 'config') ? base : '';
}

/**
 * Build minimal encoded_config for an auto-started downstream workflow.
 * Passes inputJql (key = <ticket>) and configPath so the triggered agent
 * uses the correct project-specific config.
 */
function buildAutoStartEncodedConfig(ticketKey, customParams) {
    var p = { inputJql: 'key = ' + ticketKey };
    if (customParams) {
        var nextCustomParams = Object.assign({}, customParams);
        delete nextCustomParams.removeLabel;             // SM idempotency label — per-agent
        delete nextCustomParams.autoStartRework;         // review → rework trigger, not needed downstream
        delete nextCustomParams.autoStartReworkConfigFile;
        p.customParams = nextCustomParams;
    }
    return encodeURIComponent(JSON.stringify({ params: p }));
}

/**
 * Returns true if the Jira ticket has the pr_approved label.
 */
function hasPrApprovedLabel(ticket) {
    var labels = (ticket && ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
    return labels.indexOf(LABELS.PR_APPROVED) !== -1;
}

/**
 * Read and parse outputs/pr_review.json
 * @returns {Object|null} Parsed review data or null on error
 */
function readReviewJson() {
    try {
        const raw = file_read({ path: 'outputs/pr_review.json' });
        if (!raw || raw.trim() === '') {
            console.warn('outputs/pr_review.json is empty');
            return null;
        }
        const parsed = JSON.parse(raw);
        console.log('Parsed pr_review.json:', JSON.stringify(parsed, null, 2));
        return parsed;
    } catch (error) {
        console.error('Failed to read/parse outputs/pr_review.json:', error);
        return null;
    }
}

/**
 * Read markdown file content
 * @param {string} filePath - Path to markdown file
 * @returns {string} File content or empty string on error
 */
function readMarkdownFile(filePath) {
    if (!filePath) {
        return '';
    }
    try {
        const content = file_read({ path: filePath });
        if (content && content.trim() !== '') {
            return content;
        }
    } catch (error) {
        console.warn('Could not read file ' + filePath + ':', error);
    }
    return '';
}

/**
 * Extract owner and repo from git remote URL
 * @returns {Object|null} {owner, repo} or null on error
 */
function getGitHubRepoInfo() {
    try {
        const rawOutput = cli_execute_command({
            command: 'git config --get remote.origin.url'
        }) || '';

        // cli_execute_command may append shell wrapper lines (Script done, COMMAND_EXIT_CODE=...)
        // Take only the first non-empty line that looks like a URL
        const remoteUrl = rawOutput.split('\n')
            .map(function(l) { return l.trim(); })
            .filter(function(l) { return l.indexOf('github.com') !== -1; })[0] || '';

        // Parse GitHub URL (https://github.com/owner/repo.git or git@github.com:owner/repo.git)
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.?\s]+)/);
        if (!match) {
            console.error('Could not parse GitHub URL from:', remoteUrl);
            return null;
        }

        const owner = match[1];
        const repo = match[2].replace('.git', '');

        console.log('GitHub repo:', owner + '/' + repo);
        return { owner: owner, repo: repo };

    } catch (error) {
        console.error('Failed to get GitHub repo info:', error);
        return null;
    }
}

function findPRForTicket(scm, ticketKey) {
    try {
        console.log('Searching for PR related to', ticketKey);
        const openPRs = scm.listPrs('open');
        console.log('Found', openPRs.length, 'open PRs');
        const matchingPRs = openPRs.filter(function(pr) {
            const titleMatch = pr.title && pr.title.indexOf(ticketKey) !== -1;
            const branchMatch = pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1;
            return titleMatch || branchMatch;
        });
        if (matchingPRs.length === 0) {
            console.log('No open PRs found mentioning', ticketKey);
            return null;
        }
        console.log('Found matching PR:', matchingPRs[0].number);
        return matchingPRs[0];
    } catch (error) {
        console.error('Error finding PR:', error);
        return null;
    }
}

function postGeneralComment(scm, pullRequestId, commentPath) {
    try {
        const comment = readMarkdownFile(commentPath);
        if (!comment) {
            console.warn('No general comment content found at', commentPath);
            return false;
        }
        console.log('Posting general review comment to PR #' + pullRequestId);
        scm.addComment(pullRequestId, comment);
        console.log('✅ Posted general review comment');
        return true;
    } catch (error) {
        console.error('Failed to post general comment:', error);
        return false;
    }
}

function postInlineComment(scm, pullRequestId, inlineComment) {
    // Accept both spec formats:
    //   old spec: { file, comment: "path/to/file.md" }
    //   agent output: { path, body: "inline text" }
    const filePath = inlineComment.path || inlineComment.file;
    const commentText = inlineComment.body || readMarkdownFile(inlineComment.comment);

    try {
        if (!commentText) {
            console.warn('No comment content found for inline comment on', filePath);
            return false;
        }
        if (!filePath) {
            console.warn('No file path found for inline comment');
            return false;
        }

        console.log('Posting inline comment on ' + filePath + ':' + inlineComment.line);

        scm.addInlineComment(
            pullRequestId, filePath, inlineComment.line, commentText,
            inlineComment.startLine || null, inlineComment.side || null
        );

        console.log('✅ Posted inline comment on ' + filePath + ':' + inlineComment.line);
        return true;

    } catch (error) {
        // 422 = line not in diff hunk — fall back to a regular PR comment so nothing is lost
        console.warn('Inline comment failed (line not in diff?), falling back to PR comment on ' + filePath + ':' + inlineComment.line);
        try {
            var lineRef = filePath + (inlineComment.line ? ':' + inlineComment.line : '');
            scm.addComment(pullRequestId, '📍 **`' + lineRef + '`**\n\n' + commentText);
            console.log('✅ Posted fallback PR comment for ' + lineRef);
            return true;
        } catch (fallbackError) {
            console.error('Failed to post fallback PR comment for ' + filePath + ':', fallbackError);
            return false;
        }
    }
}

function resolveApprovedThreads(scm, pullRequestId, resolvedThreadIds) {
    if (!resolvedThreadIds || resolvedThreadIds.length === 0) return;
    console.log('Resolving ' + resolvedThreadIds.length + ' fixed review thread(s)...');
    resolvedThreadIds.forEach(function(threadId) {
        try {
            scm.resolveThread(pullRequestId, { threadId: threadId });
            console.log('✅ Resolved thread', threadId);
        } catch (e) {
            console.warn('Failed to resolve thread ' + threadId + ':', e.message || e);
        }
    });
}

/**
 * Post review results to Jira ticket
 * @param {string} ticketKey - Ticket key
 * @param {string} reviewContent - Review content (from outputs/response.md)
 * @param {Object} reviewData - Parsed pr_review.json data
 * @param {string} prUrl - PR URL
 * @param {boolean} merged - Whether PR was merged
 */
function postReviewToJira(ticketKey, reviewContent, reviewData, prUrl, merged) {
    try {
        let comment = 'h2. 🔍 Automated PR Review Completed\n\n';

        // Add outcome badge
        // Normalize: LLM sometimes returns "APPROVED" instead of "APPROVE"
        const recommendation = (reviewData.recommendation || reviewData.verdict || 'REQUEST_CHANGES').replace(/^APPROVED$/, 'APPROVE');
        if (merged) {
            comment += '{panel:bgColor=#E3FCEF|borderColor=#00875A}✅ *APPROVED & MERGED* - PR has been merged successfully{panel}\n\n';
        } else if (recommendation === 'APPROVE') {
            comment += '{panel:bgColor=#E3FCEF|borderColor=#00875A}✅ *APPROVED* - AI review passed. Awaiting required reviewer approval to merge.{panel}\n\n';
        } else if (recommendation === 'BLOCK') {
            comment += '{panel:bgColor=#FFEBE6|borderColor=#DE350B}🚨 *BLOCKED* - Critical issues must be fixed before merge{panel}\n\n';
        } else {
            comment += '{panel:bgColor=#FFF7E6|borderColor=#FF991F}⚠️ *CHANGES REQUESTED* - Issues found, ticket returned to In Rework{panel}\n\n';
        }

        // Add issue summary
        const issueCounts = reviewData.issueCounts || { blocking: 0, important: 0, suggestions: 0 };
        comment += 'h3. Issue Summary\n';
        comment += '* 🚨 Blocking Issues: *' + issueCounts.blocking + '*\n';
        comment += '* ⚠️ Important Issues: *' + issueCounts.important + '*\n';
        comment += '* 💡 Suggestions: *' + issueCounts.suggestions + '*\n\n';

        if (prUrl) {
            comment += 'h3. Pull Request\n';
            comment += '[View PR on GitHub|' + prUrl + ']\n\n';
        }

        comment += '----\n';
        comment += '_Generated by AI Code Reviewer with focus on security, code quality, and OOP principles_';

        jira_post_comment({
            key: ticketKey,
            comment: comment
        });

        console.log('✅ Posted review results to Jira ticket', ticketKey);

    } catch (error) {
        console.error('Failed to post review to Jira:', error);
    }
}

/**
 * Main action function
 * Posts review results to GitHub and Jira, updates ticket
 *
 * @param {Object} params - Parameters from Teammate job
 * @param {Object} params.ticket - Jira ticket object
 * @param {string} params.response - Jira-formatted review from outputs/response.md
 * @param {string} params.inputFolderPath - Path to input folder
 * @returns {Object} Result object
 */
function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const jiraReview = params.response || '';
        var configLoader = require('./configLoader.js');
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var scm = scmModule.createScm(config);
        var labels = (params.ticket && params.ticket.fields && params.ticket.fields.labels) ? params.ticket.fields.labels : [];

        console.log('=== Processing PR review results for', ticketKey, '===');

        // Step 1: Read structured review data
        const reviewData = readReviewJson();
        if (!reviewData) {
            console.error('Failed to read pr_review.json');
            return {
                success: false,
                error: 'No review data found in pr_review.json'
            };
        }

        console.log('Review recommendation:', reviewData.recommendation);
        console.log('Issue counts:', JSON.stringify(reviewData.issueCounts));

        // Resolve statuses and customParams
        const customParams = params.jobParams && params.jobParams.customParams;
        const statuses = resolveStatuses(customParams);

        // Step 2: Extract PR info from input folder or find PR using MCP
        let prNumber = null;
        let prUrl = null;
        let prBranch = null;

        // Try to get repo info — prefer targetRepository from config over git remote
        var repoInfo = null;
        if (config.repository && config.repository.owner && config.repository.repo) {
            repoInfo = { owner: config.repository.owner, repo: config.repository.repo };
            console.log('Using targetRepository from config:', repoInfo.owner + '/' + repoInfo.repo);
        } else {
            repoInfo = scm.getRemoteRepoInfo();
        }
        if (!repoInfo) {
            console.warn('Could not get GitHub repo info - skipping GitHub comments');
        }

        try {
            // First try to read from input/pr_info.md (if exists)
            const inputFolder = params.inputFolderPath || ('input/' + ticketKey);
            const prInfo = file_read({
                path: inputFolder + '/pr_info.md'
            });

            if (prInfo) {
                // Extract PR number and URL — format: - **PR #**: 13
                const numberMatch = prInfo.match(/\*\*PR #\*\*:\s*(\d+)/);
                const urlMatch = prInfo.match(/\*\*URL\*\*:\s*(https:\/\/[^\s]+)/);
                const branchMatch = prInfo.match(/\*\*Branch\*\*:\s*([^\s\n]+)/);

                if (numberMatch) {
                    prNumber = parseInt(numberMatch[1], 10);
                }
                if (urlMatch) {
                    prUrl = urlMatch[1];
                }
                if (branchMatch) {
                    prBranch = branchMatch[1];
                }
                console.log('Found PR info in input folder: #' + prNumber);
            }
        } catch (error) {
            console.warn('Could not read PR info from input folder:', error);
        }

        // Fallback: If no PR number found, search for PR using MCP tools
        if (!prNumber && repoInfo) {
            console.log('PR number not found in input folder, searching GitHub...');
            const pr = findPRForTicket(scm, ticketKey);
            if (pr) {
                prNumber = pr.number;
                prUrl = pr.html_url;
                prBranch = pr.head && pr.head.ref ? pr.head.ref : null;
                console.log('Found PR via GitHub search: #' + prNumber);
            } else {
                console.warn('Could not find PR for ticket', ticketKey);
            }
        } else if (!prNumber) {
             console.warn('PR number not found and cannot search without repo info');
        }

        // Step 3: Get GitHub repo info (already done above)

        // Normalize: LLM sometimes returns "APPROVED" instead of "APPROVE"
        const recommendation = (reviewData.recommendation || reviewData.verdict || 'REQUEST_CHANGES').replace(/^APPROVED$/, 'APPROVE');

        // Determine if truly approved — block approval when there are open issues/suggestions
        // unless customParams.allowApproveWithSuggestions = true is explicitly set.
        // Default behaviour: ANY non-zero issue count (blocking, important, or suggestions)
        // overrides the agent's APPROVE verdict and forces the ticket back to rework.
        const issueCounts = reviewData.issueCounts || { blocking: 0, important: 0, suggestions: 0 };
        const hasOpenIssues = (issueCounts.blocking || 0) > 0 ||
                              (issueCounts.important || 0) > 0 ||
                              (issueCounts.suggestions || 0) > 0;
        const allowApproveWithSuggestions = customParams && customParams.allowApproveWithSuggestions === true;
        const isApproved = recommendation === 'APPROVE' && (!hasOpenIssues || allowApproveWithSuggestions);

        if (recommendation === 'APPROVE' && hasOpenIssues && !allowApproveWithSuggestions) {
            console.warn(
                '⚠️ Agent returned APPROVE but there are open issues ' +
                '(blocking=' + issueCounts.blocking + ', important=' + issueCounts.important +
                ', suggestions=' + issueCounts.suggestions + '). ' +
                'Overriding to REQUEST_CHANGES. Set allowApproveWithSuggestions=true in customParams to allow.'
            );
        }

        // Step 4: Post all comments to GitHub PR (always, regardless of outcome)
        if (prNumber && repoInfo) {
            console.log('Posting review to GitHub PR #' + prNumber + ' (recommendation: ' + recommendation + ')');

            // Post general comment
            if (reviewData.generalComment) {
                postGeneralComment(scm, prNumber, reviewData.generalComment);
            }

            // Post inline comments
            if (reviewData.inlineComments && Array.isArray(reviewData.inlineComments) && reviewData.inlineComments.length > 0) {
                console.log('Posting ' + reviewData.inlineComments.length + ' inline comments');

                reviewData.inlineComments.forEach(function(inlineComment, index) {
                    console.log('Processing inline comment ' + (index + 1) + '/' + reviewData.inlineComments.length);
                    postInlineComment(scm, prNumber, inlineComment);
                });
            }

            // Resolve threads that were fully fixed in this rework
            resolveApprovedThreads(scm, prNumber, reviewData.resolvedThreadIds);

            console.log('✅ Posted all review comments to GitHub PR');

            // Step 5: Two-state outcome
            if (isApproved) {
                // STATE 1: APPROVE → label PR and Jira ticket; SM will retry merge when CI passes
                try {
                    scm.addLabel(prNumber, LABELS.PR_APPROVED);
                    console.log('✅ Added pr_approved label to GitHub PR #' + prNumber);
                } catch (labelErr) {
                    console.warn('Failed to add pr_approved label to GitHub PR:', labelErr);
                }
            } else {
                // STATE 2: REQUEST_CHANGES / BLOCK → do NOT merge
                console.log('PR has issues (' + recommendation + ') - will NOT merge, returning ticket to In Development');
            }

        } else {
            console.warn('No PR number or repo info - skipping GitHub comments and merge');
        }

        // Step 6: Post review to Jira ticket (merge is handled by SM/required reviewers, not by this agent)
        postReviewToJira(ticketKey, jiraReview, reviewData, prUrl, false);

        // Step 7: Update ticket status based on outcome
        try {
            if (isApproved) {
                // Approved → add pr_approved label to Jira and stay in In Review for SM retry-merge
                jira_add_label({
                    key: ticketKey,
                    label: LABELS.PR_APPROVED
                });
                console.log('✅ Added pr_approved label to Jira ticket — SM will retry merge');
            } else {
                // Has issues → move to In Rework for focused fixes
                jira_move_to_status({
                    key: ticketKey,
                    statusName: statuses.IN_REWORK
                });
                console.log('✅ Ticket moved to In Rework');
            }
        } catch (statusError) {
            console.warn('Could not update ticket status/label:', statusError);
        }

        // Step 8: Add review label
        try {
            jira_add_label({
                key: ticketKey,
                label: LABELS.AI_PR_REVIEWED
            });
        } catch (error) {
            console.warn('Failed to add ai_pr_reviewed label:', error);
        }

        // Step 9: Remove WIP label if present
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'pr_review_wip';

        try {
            jira_remove_label({
                key: ticketKey,
                label: wipLabel
            });
            console.log('Removed WIP label:', wipLabel);
        } catch (error) {
            console.warn('Failed to remove WIP label:', error);
        }

        // Step 10: Remove SM idempotency label (via customParams)
        const removeLabel = customParams && customParams.removeLabel;
        if (removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('✅ Removed SM label:', removeLabel);
            } catch (e) {}
        }

        // Step 11: Assign back to initiator
        try {
            if (params.initiator) {
                jira_assign_ticket_to({
                    key: ticketKey,
                    accountId: params.initiator
                });
                console.log('✅ Assigned ticket back to initiator');
            }
        } catch (error) {
            console.warn('Failed to assign ticket:', error);
        }

        // Step 12: Auto-start pr_rework when changes were requested (opt-in via customParams)
        if (!isApproved && !merged) {
            const autoStartRework = customParams && customParams.autoStartRework;
            const reworkConfigFile = customParams && customParams.autoStartReworkConfigFile;
            if (autoStartRework && reworkConfigFile) {
                // Skip if ticket already has pr_approved label (merge in progress)
                if (hasPrApprovedLabel(params.ticket)) {
                    console.log('ℹ️ autoStartRework: skipped — ticket has pr_approved label');
                } else {
                    try {
                        // Use customParams.aiRepository if set (avoids targetRepository override in configLoader)
                        const aiRepoCfg = customParams && customParams.aiRepository;
                        const aiOwner = (aiRepoCfg && aiRepoCfg.owner) || (config.repository && config.repository.owner);
                        const aiRepo  = (aiRepoCfg && aiRepoCfg.repo)  || (config.repository && config.repository.repo);
                        const projectKey = deriveProjectKey(customParams);
                        const encodedCfg = buildAutoStartEncodedConfig(ticketKey, customParams);
                        if (aiOwner && aiRepo) {
                            scm.triggerWorkflow(
                                aiOwner, aiRepo, 'ai-teammate.yml',
                                JSON.stringify({
                                    concurrency_key: ticketKey,
                                    config_file:     reworkConfigFile,
                                    encoded_config:  encodedCfg,
                                    project_key:     projectKey || ''
                                }),
                                'main'
                            );
                            console.log('✅ Auto-started pr_rework for', ticketKey,
                                '[config=' + reworkConfigFile + (projectKey ? ', project=' + projectKey : '') + ']');
                        } else {
                            console.warn('⚠️ autoStartRework: config.repository.owner/repo not set — skipping');
                        }
                    } catch (e) {
                        console.warn('⚠️ autoStartRework trigger failed:', e.message || e);
                    }
                }
            }
        }

        // Step 13: On-approved triggers (opt-in via customParams.onApproved)
        if (isApproved && customParams && customParams.onApproved) {
            var onApproved = customParams.onApproved;

            // 13a: Trigger Bitrise build (e.g. build_ios_simulator)
            if (onApproved.bitriseBuild) {
                try {
                    var bb = onApproved.bitriseBuild;
                    var envVars = (bb.envVars || []).slice();
                    // Always pass the ticket key so the build can reference it
                    envVars.push({ mapped_to: 'TICKET_KEY', value: ticketKey, is_expand: false });
                    if (prUrl) {
                        envVars.push({ mapped_to: 'PR_URL', value: prUrl, is_expand: false });
                    }
                    bitrise_trigger_build({
                        appSlug: bb.appSlug,
                        workflowId: bb.workflowId,
                        branch: prBranch || bb.branch || 'develop',
                        commitMessage: ticketKey + ' — triggered by AI PR review approval',
                        envVars: JSON.stringify(envVars)
                    });
                    console.log('✅ Triggered Bitrise build:', bb.workflowId, 'branch:', prBranch || bb.branch || 'develop', 'for', ticketKey);
                } catch (e) {
                    console.warn('⚠️ Bitrise build trigger failed:', e.message || e);
                }
            }

            // 13b: Trigger TestCasesGenerator via GitHub Actions (only once per ticket)
            if (onApproved.testCasesGenerator) {
                try {
                    var tcg = onApproved.testCasesGenerator;
                    var aiRepoCfg = customParams.aiRepository;
                    var aiOwner = (aiRepoCfg && aiRepoCfg.owner) || (config.repository && config.repository.owner);
                    var aiRepo  = (aiRepoCfg && aiRepoCfg.repo)  || (config.repository && config.repository.repo);
                    var projectKey = deriveProjectKey(customParams);

                    // Guard: skip if tests were already generated for this ticket
                    var alreadyGenerated = labels.indexOf(LABELS.AI_TESTS_GENERATED) !== -1;
                    if (alreadyGenerated) {
                        console.log('ℹ️ TestCasesGenerator skipped — label "' + LABELS.AI_TESTS_GENERATED + '" already present on ' + ticketKey + ' (tests generated in a previous cycle)');
                    } else if (aiOwner && aiRepo) {
                        var tcgEncodedCfg = encodeURIComponent(JSON.stringify({
                            params: { inputJql: 'key = ' + ticketKey }
                        }));
                        scm.triggerWorkflow(
                            aiOwner, aiRepo, tcg.workflow || 'ai-teammate.yml',
                            JSON.stringify({
                                concurrency_key: ticketKey,
                                config_file:     tcg.configFile,
                                encoded_config:  tcgEncodedCfg,
                                project_key:     projectKey || ''
                            }),
                            'main'
                        );
                        console.log('✅ Triggered TestCasesGenerator for', ticketKey,
                            '[config=' + tcg.configFile + ']');
                        // Mark ticket so subsequent approvals skip re-generation
                        try {
                            jira_add_label({ key: ticketKey, label: LABELS.AI_TESTS_GENERATED });
                            console.log('✅ Added label "' + LABELS.AI_TESTS_GENERATED + '" to ' + ticketKey);
                        } catch (labelErr) {
                            console.warn('⚠️ Could not add ai_tests_generated label:', labelErr.message || labelErr);
                        }
                    } else {
                        console.warn('⚠️ TestCasesGenerator: aiRepository owner/repo not set — skipping');
                    }
                } catch (e) {
                    console.warn('⚠️ TestCasesGenerator trigger failed:', e.message || e);
                }
            }
        }

        console.log('✅ PR review workflow completed:', isApproved ? 'MERGED' : 'CHANGES REQUESTED');

        return {
            success: true,
            message: isApproved ? 'PR approved and merged' : 'Changes requested, ticket returned to In Development',
            recommendation: recommendation,
            issueCounts: reviewData.issueCounts,
            githubCommentsPosted: !!(prNumber && repoInfo),
            merged: merged
        };

    } catch (error) {
        console.error('❌ Error in postPRReviewComments:', error);

        // Try to post error to Jira
        try {
            if (params && params.ticket && params.ticket.key) {
                jira_post_comment({
                    key: params.ticket.key,
                    comment: 'h3. ❌ PR Review Error\n\n' +
                        '{code}' + error.toString() + '{code}\n\n' +
                        'Please check the workflow logs for details.'
                });
            }
        } catch (commentError) {
            console.error('Failed to post error comment:', commentError);
        }

        return {
            success: false,
            error: error.toString()
        };
    }
}

// Export for dmtools standalone execution
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
