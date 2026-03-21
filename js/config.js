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
    IN_REVIEW: 'In Review',
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
    PR_APPROVED: 'pr_approved'              // Added to PR and ticket when AI approves, removed after merge attempt
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
    SOLUTION: 'Solution'
};

// Summary Length Constraints
const SUMMARY_MAX_LENGTH = 120;

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
    DEFAULT_CONFLUENCE,
    DEFAULT_FORMATS
};

