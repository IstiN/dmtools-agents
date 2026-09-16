/**
 * Configuration constants for agent scripts
 * Central location for all hardcoded values used across agent workflows
 */

// Jira Issue Types
const ISSUE_TYPES = {
    SUBTASK: 'Subtask',
    TASK: 'Task',
    STORY: 'Story',
    BUG: 'Bug',
    EPIC: 'Epic',
    TEST_CASE: 'Test Case'
};

// Jira Statuses
const STATUSES = {
    IN_REVIEW: 'In Review',                         // ticket handed off for code review
    PO_REVIEW: 'PO REVIEW',                         // transition name → reaches "PO Review" status
    SOLUTION_ARCHITECTURE: 'SOLUTION ARCHITECTURE', // transition name → reaches "Solution Architecture" status
    READY_FOR_DEVELOPMENT: 'Ready For Development',
    IN_DEVELOPMENT: 'In Development',               // transition name → reaches "In Development" status
    IN_PROGRESS: 'In Progress',                     // transition name → reaches "In Development" on Task/SD tickets
    BLOCKED: 'Blocked',
    TODO: 'To Do',
    DONE: 'Done',
    MERGED: 'Merged',                               // PR merged and ticket complete
    IN_REWORK: 'In Rework',                         // PR review failed, focused fixes needed
    READY_FOR_TESTING: 'Ready For Testing',          // Test cases generated, ready for QA
    FAILED: 'Failed',                                // Test automation passed review
    PASSED: 'Passed',                                // Test automation passed review
    IN_REVIEW_PASSED: 'In Review - Passed',          // Test ran and passed, awaiting code review
    IN_REVIEW_FAILED: 'In Review - Failed',          // Test ran and failed, awaiting code review
    IN_TESTING: 'In Testing',                        // Test cases generated, automation in progress
    BUG_TO_FIX: 'Bug To Fix',                        // Bug linked/created for this TC, waiting for fix
    BACKLOG: 'Backlog',                              // Ticket waiting to be picked up
    SKIPPED: 'Skipped',                              // Test intentionally skipped (infra/missing platform/etc.)
    IRRELEVANT: 'Irrelevant',                        // Test became legacy / no longer applicable
    BA_ANALYSIS: 'BA Analysis'                       // Story ready for BA analysis after PO Review
};

// Jira Priorities
const PRIORITIES = {
    LOW: 'Low',
    MEDIUM: 'Medium',
    HIGH: 'High',
    HIGHEST: 'Highest',
    LOWEST: 'Lowest'
};

// Labels
const LABELS = {
    AI_GENERATED: 'ai_generated',
    AI_QUESTIONS_ASKED: 'ai_questions_asked',
    AI_SOLUTION_DESIGN_CREATED: 'ai_solution_design_created',
    AI_DEVELOPED: 'ai_developed',
    AI_PR_REVIEWED: 'ai_pr_reviewed',
    AI_INTAKE: 'ai_intake',
    QUESTION: 'q',
    SD_CORE: 'sd_core',
    SD_API: 'sd_api',
    SD_UI: 'sd_ui',
    NEEDS_API_IMPLEMENTATION: 'needs_api_implementation',
    NEEDS_CORE_IMPLEMENTATION: 'needs_core_implementation',
    AI_TEST_AUTOMATION: 'ai_test_automation',
    PR_APPROVED: 'pr_approved',             // Added to PR and ticket when AI approves, removed after merge attempt
    TEST_PR_REWORK_NEEDED: 'test_pr_rework_needed', // Added when test-automation review requests changes; removed after rework
    TEST_PR_MERGED: 'test_pr_merged',       // Added when a test-automation PR is already merged but not yet finalized
    TEST_PR_FINALIZED: 'test_pr_finalized', // Added after merge finalization so review agents never re-enter the loop
    AI_TESTS_GENERATED: 'ai_tests_generated', // Added after TestCasesGenerator runs — guards against re-generation on re-approval
    BUG_FIX_BATCH: 'bug_fix_batch' // Bugs grouped into a bug-fix batch Epic; excluded from individual bug_development
};

// Git Configuration
const GIT_CONFIG = {
    AUTHOR_NAME: 'AI Teammate',
    AUTHOR_EMAIL: 'agent.ai.native@gmail.com',
    DEFAULT_BASE_BRANCH: 'main',
    DEFAULT_ISSUE_TYPE_PREFIX: 'feature'
};

// Solution Design Module Prefixes
const MODULE_PREFIXES = {
    CORE: '[SD CORE]',
    API: '[SD API]',
    UI: '[SD UI]'
};

// Module Configuration for Solution Design
const SOLUTION_DESIGN_MODULES = [
    { flag: 'core', prefix: MODULE_PREFIXES.CORE, label: LABELS.SD_CORE },
    { flag: 'api', prefix: MODULE_PREFIXES.API, label: LABELS.SD_API },
    { flag: 'ui', prefix: MODULE_PREFIXES.UI, label: LABELS.SD_UI }
];

// Diagram Defaults
const DIAGRAM_DEFAULTS = {
    API_SEQUENCE: 'sequenceDiagram\n    participant Client\n    participant API\n    Client->>API: Request\n    API-->>Client: Response',
    CORE_GRAPH: 'graph TD\n    A[SD CORE Enhancement] --> B[Technical Implementation]'
};

// Diagram Formatting
const DIAGRAM_FORMAT = {
    MERMAID_WRAPPER_START: '{code:mermaid}\n',
    MERMAID_WRAPPER_END: '\n{code}'
};

// Field Names
const JIRA_FIELDS = {
    DIAGRAMS: 'Diagrams',
    SOLUTION: 'Solution',
    FAILED_REASON: 'Failed Reason'
};

// Summary Length Constraints
const SUMMARY_MAX_LENGTH = 120;

// Jira's actual hard limit on the summary field — creating a ticket with a longer
// summary is rejected by the API ("Summary must be less than 255 characters").
// Distinct from SUMMARY_MAX_LENGTH above (a stricter style guideline for
// AI-authored summaries); this is the hard ceiling any summary must respect.
const JIRA_SUMMARY_MAX_LENGTH = 255;

/**
 * Truncate a ticket summary to fit within Jira's hard summary length limit,
 * appending an ellipsis when truncation actually occurs so the cut is visible.
 * Safe to call on any summary — a no-op when it's already short enough.
 *
 * @param {string} summary - full summary text (may include a "[repo] " prefix, etc.)
 * @param {number} [maxLength] - defaults to JIRA_SUMMARY_MAX_LENGTH
 * @returns {string} summary, truncated to maxLength characters if needed
 */
function truncateSummary(summary, maxLength) {
    var limit = maxLength || JIRA_SUMMARY_MAX_LENGTH;
    var text = (summary || '').toString();
    if (text.length <= limit) return text;
    var ellipsis = '...';
    return text.substring(0, Math.max(0, limit - ellipsis.length)) + ellipsis;
}

/**
 * Merge default STATUSES with project-specific overrides.
 * Allows each project to remap status names (e.g. use different Story/Bug workflow
 * status names than the generic defaults) without changing agent JS code.
 *
 * Two override channels are supported, applied in this precedence order (later wins):
 *   1. projectStatuses — from .dmtools/config.js's `jira.statuses` block, loaded via
 *      configLoader.loadProjectConfig(params).jira.statuses. This is the recommended
 *      channel: it applies project-wide to every agent invocation automatically.
 *   2. customParams.customStatuses — a legacy, per-agent-invocation override channel
 *      (set directly in an individual agent JSON's customParams). Still supported for
 *      backward compatibility / one-off overrides that shouldn't apply project-wide.
 *
 * Usage in JS actions:
 *   var config = configLoader.loadProjectConfig(params);
 *   const statuses = resolveStatuses(customParams, config.jira && config.jira.statuses);
 *   jira_move_to_status({ key, statusName: statuses.IN_REVIEW });
 *
 * .dmtools/config.js example (project-wide, recommended):
 *   jira: { statuses: { IN_REVIEW: 'Ready for Review', IN_DEVELOPMENT: 'Development in Progress' } }
 *
 * Config JSON example (customParams.customStatuses, legacy/per-invocation):
 *   "customStatuses": {
 *     "IN_DEVELOPMENT": "In Progress",
 *     "IN_REVIEW": "Ready For Review"
 *   }
 *
 * @param {Object} customParams - customParams from agent config
 * @param {Object} [projectStatuses] - project-wide status overrides (config.jira.statuses)
 * @returns {Object} STATUSES merged with project and customParams overrides
 */
function resolveStatuses(customParams, projectStatuses) {
    var merged = (projectStatuses && typeof projectStatuses === 'object')
        ? Object.assign({}, STATUSES, projectStatuses)
        : STATUSES;
    if (!customParams || !customParams.customStatuses) return merged;
    return Object.assign({}, merged, customParams.customStatuses);
}

// ── Default Confluence URLs ──────────────────────────────────────────────────
const DEFAULT_CONFLUENCE = {
    templateStory: 'https://dmtools.atlassian.net/wiki/spaces/AINA/pages/11665485/Template+Story',
    templateJiraMarkdown: 'https://dmtools.atlassian.net/wiki/spaces/AINA/pages/18186241/Template+Jira+Markdown',
    templateSolutionDesign: 'https://dmtools.atlassian.net/wiki/spaces/AINA/pages/56754177/Template+Solution+Design',
    templateQuestions: 'https://dmtools.atlassian.net/wiki/spaces/AINA/pages/11665581/Template+Q'
};

// ── Default format templates ─────────────────────────────────────────────────
const DEFAULT_FORMATS = {
    commitMessage: {
        development: '{ticketKey} {ticketSummary}',
        testAutomation: '{ticketKey} test: automate {ticketSummary}',
        testRework: '{ticketKey} test rework: {result} test after review',
        rework: '{ticketKey} Rework: address PR review comments',
        wip: '{ticketKey} WIP: partial analysis (agent interrupted)'
    },
    prTitle: {
        development: '{ticketKey} {ticketSummary}',
        testAutomation: '{ticketKey} {ticketSummary}',
        rework: '{ticketKey} {ticketSummary} (rework)'
    }
};

// Export all configuration
module.exports = {
    ISSUE_TYPES,
    STATUSES,
    PRIORITIES,
    LABELS,
    GIT_CONFIG,
    MODULE_PREFIXES,
    SOLUTION_DESIGN_MODULES,
    DIAGRAM_DEFAULTS,
    DIAGRAM_FORMAT,
    JIRA_FIELDS,
    SUMMARY_MAX_LENGTH,
    JIRA_SUMMARY_MAX_LENGTH,
    truncateSummary,
    DEFAULT_CONFLUENCE,
    DEFAULT_FORMATS,
    resolveStatuses
};

