/**
 * Post Test Automation Results Action (postJSAction for test_case_automation)
 * 1. Reads outputs/test_automation_result.json
 * 2. Stages testing/ folder, commits, pushes, creates PR to main
 * 3. Posts Jira comment from outputs/response.md
 * 4. If passed:  moves ticket to Done
 * 5. If failed:  creates Bug ticket, links it, moves Test Case to Failed
 * 6. Removes WIP label
 */

const { GIT_CONFIG, STATUSES, ISSUE_TYPES, LABELS } = require('./config.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function readFile(path) {
    try {
        const content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        console.warn('Could not read file ' + path + ':', e);
        return null;
    }
}

function readResultJson() {
    try {
        const raw = readFile('outputs/test_automation_result.json');
        if (!raw) {
            console.warn('outputs/test_automation_result.json is empty or missing');
            return null;
        }
        const parsed = JSON.parse(raw);
        console.log('Test result status:', parsed.status);
        return parsed;
    } catch (e) {
        console.error('Failed to parse test_automation_result.json:', e);
        return null;
    }
}

function performGitOperations(branchName, commitMessage) {
    try {
        // Stage only testing/ folder
        console.log('Staging testing/ folder...');
        cli_execute_command({ command: 'git add testing/' });

        const statusOutput = cleanCommandOutput(
            cli_execute_command({ command: 'git status --porcelain' }) || ''
        );

        if (!statusOutput || !statusOutput.trim()) {
            console.warn('No changes to commit in testing/');
            return { success: false, error: 'No test files were written' };
        }

        console.log('Committing...');
        cli_execute_command({
            command: 'git commit -m "' + commitMessage.replace(/"/g, '\\"') + '"'
        });

        console.log('Pushing to remote...');
        try {
            cli_execute_command({ command: 'git push -u origin ' + branchName });
        } catch (e) {
            console.log('Normal push failed, force pushing...');
            cli_execute_command({ command: 'git push -u origin ' + branchName + ' --force' });
        }

        const remoteBranch = cleanCommandOutput(
            cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || ''
        );
        if (!remoteBranch.trim()) {
            throw new Error('Branch not found on remote after push');
        }

        console.log('✅ Git operations completed');
        return { success: true, branchName: branchName };

    } catch (error) {
        console.error('Git operations failed:', error);
        return { success: false, error: error.toString() };
    }
}

function createPullRequest(title, branchName) {
    try {
        console.log('Creating Pull Request...');
        const escapedTitle = title.replace(/"/g, '\\"').replace(/\n/g, ' ');

        // Use pr_body.md (GitHub MD) if present, fallback to response.md
        const prBodyFile = readFile('outputs/pr_body.md')
            ? 'outputs/pr_body.md'
            : 'outputs/response.md';
        console.log('Using PR body file:', prBodyFile);

        const output = cleanCommandOutput(
            cli_execute_command({
                command: 'gh pr create --title "' + escapedTitle + '" --body-file "' + prBodyFile + '" --base ' + GIT_CONFIG.DEFAULT_BASE_BRANCH + ' --head ' + branchName
            }) || ''
        );

        let prUrl = null;
        const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
        if (urlMatch) {
            prUrl = urlMatch[0];
        }

        if (!prUrl) {
            const prNumberMatch = output.match(/#(\d+)/);
            if (prNumberMatch) {
                try {
                    const remoteUrl = cleanCommandOutput(
                        cli_execute_command({ command: 'git config --get remote.origin.url' }) || ''
                    );
                    const repoMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
                    if (repoMatch) {
                        prUrl = 'https://github.com/' + repoMatch[1].replace('.git', '') + '/pull/' + prNumberMatch[1];
                    }
                } catch (e) {}
            }
        }

        if (!prUrl) {
            try {
                const listOutput = cleanCommandOutput(
                    cli_execute_command({ command: 'gh pr list --head ' + branchName + ' --json url --jq ".[0].url"' }) || ''
                );
                if (listOutput && listOutput.startsWith('https://')) prUrl = listOutput;
            } catch (e) {}
        }

        console.log('✅ PR created:', prUrl || '(URL not found)');
        return { success: true, prUrl: prUrl };

    } catch (error) {
        console.error('Failed to create PR:', error);
        return { success: false, error: error.toString() };
    }
}

function createBugTicket(projectKey, bug) {
    try {
        const description = bug.description ? (readFile(bug.description) || bug.summary) : bug.summary;

        const result = jira_create_ticket({
            project: projectKey,
            summary: bug.summary,
            description: description,
            issuetype: ISSUE_TYPES.BUG,
            priority: bug.priority || 'Medium'
        });

        const bugKey = result && result.key ? result.key : null;
        if (bugKey) console.log('✅ Created bug:', bugKey);
        return bugKey;
    } catch (e) {
        console.error('Failed to create bug ticket:', e);
        return null;
    }
}

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const ticketSummary = params.ticket.fields ? params.ticket.fields.summary : ticketKey;
        const projectKey = ticketKey.split('-')[0];
        const jiraComment = params.response || '';

        console.log('=== Processing test automation results for', ticketKey, '===');

        // Step 1: Read structured result
        const result = readResultJson();
        if (!result) {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ⚠️ Test Automation Error\n\nCould not read test result. Check workflow logs.'
            });
            return { success: false, error: 'No test result JSON found' };
        }

        const passed = result.status === 'passed';

        // Step 2: Configure git author
        try {
            cli_execute_command({ command: 'git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"' });
            cli_execute_command({ command: 'git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"' });
        } catch (e) {
            console.warn('Failed to configure git author:', e);
        }

        // Step 3: Read current branch (set by preCliTestAutomationSetup)
        const branchName = cleanCommandOutput(
            cli_execute_command({ command: 'git branch --show-current' }) || ''
        );
        if (!branchName) {
            console.warn('Could not determine current branch — skipping git operations');
        }

        // Step 4: Commit + push + create PR
        let prUrl = null;
        if (branchName) {
            const commitMessage = ticketKey + ' test: automate ' + ticketSummary;
            const gitResult = performGitOperations(branchName, commitMessage);

            if (gitResult.success) {
                const prTitle = ticketKey + ' ' + ticketSummary;
                const prResult = createPullRequest(prTitle, branchName);
                prUrl = prResult.prUrl;
            } else {
                console.warn('Git operations failed:', gitResult.error);
            }
        }

        // Step 5: Post Jira comment
        try {
            let comment = jiraComment || '';
            if (prUrl) {
                comment += '\n\n*Test Branch PR*: ' + prUrl;
            }
            if (comment) {
                jira_post_comment({ key: ticketKey, comment: comment });
                console.log('✅ Posted test result comment to Jira');
            }
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 6: Handle outcome
        if (passed) {
            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REVIEW_PASSED });
                console.log('✅ Passed — moved', ticketKey, 'to', STATUSES.IN_REVIEW_PASSED);
            } catch (e) {
                console.warn('Failed to move to In Review - Passed:', e);
            }
        } else {
            // Create bug ticket
            const bug = result.bug;
            if (bug && bug.summary) {
                const bugKey = createBugTicket(projectKey, bug);
                if (bugKey) {
                    try {
                        jira_link_issues({
                            from: ticketKey,
                            to: bugKey,
                            relationship: 'is blocked by'
                        });
                        console.log('✅ Linked', ticketKey, 'is blocked by', bugKey);
                    } catch (e) {
                        console.warn('Failed to link bug:', e);
                    }
                }
            } else {
                console.warn('Test failed but no bug details in result JSON');
            }

            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REVIEW_FAILED });
                console.log('✅ Failed — moved', ticketKey, 'to', STATUSES.IN_REVIEW_FAILED);
            } catch (e) {
                console.warn('Failed to move to In Review - Failed:', e);
            }
        }

        // Step 7: Add label
        try {
            jira_add_label({ key: ticketKey, label: LABELS.AI_TEST_AUTOMATION });
        } catch (e) {
            console.warn('Failed to add label:', e);
        }

        // Step 8: Remove WIP label
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'test_case_automation_wip';
        try {
            jira_remove_label({ key: ticketKey, label: wipLabel });
        } catch (e) {
            console.warn('Failed to remove WIP label:', e);
        }

        console.log('✅ Test automation workflow complete:', passed ? 'PASSED' : 'FAILED');

        return {
            success: true,
            status: result.status,
            ticketKey: ticketKey,
            prUrl: prUrl
        };

    } catch (error) {
        console.error('❌ Error in postTestAutomationResults:', error);
        try {
            jira_post_comment({
                key: params.ticket.key,
                comment: 'h3. ❌ Test Automation Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
