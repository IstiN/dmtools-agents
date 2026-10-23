/**
 * Write Solution and Diagrams Post-Action
 * Reads AI-generated outputs/response.md and outputs/diagram.md,
 * writes them to the Solution and Diagrams fields of the story ticket,
 * then assigns for review.
 *
 * Supports customParams overrides (via agent JSON customParams):
 *   solutionField — Jira field name for solution content (default: JIRA_FIELDS.SOLUTION)
 *   diagramField  — Jira field name for diagram (default: JIRA_FIELDS.DIAGRAMS).
 *                   If empty string or not set, diagram is prepended to solution as {code:mermaid}.
 *   requireDiagram — when true, fail the post-action if outputs/diagram.md is missing.
 *   outputType    — "replace" (default): overwrite solutionField with generated content.
 *                   "append": read current value of solutionField, append generated content after a separator.
 *                   Useful for tickets (e.g. bugs) where the field already has content that must be preserved.
 *
 * Confluence publishing (customParams.contentOutput, see js/common/contentOutput.js):
 *   target: 'confluence' — publish solution (+ diagram section) to a Confluence
 *           page under contentOutput.parentPageId instead of the tracker field;
 *           the tracker field gets a link to the page (updateTrackerField).
 *   target: 'both' — tracker fields AND the Confluence page.
 *   Replies from outputs/confluence_replies.json are posted back to inline
 *   comments when the Confluence target is active.
 */

const { LABELS, DIAGRAM_FORMAT, JIRA_FIELDS } = require('./config.js');
const configLoader = require('./configLoader.js');
const scmModule = require('./common/scm.js');
const autoStart = require('./common/autoStart.js');
const outputFiles = require('./common/outputFiles.js');
const trackersModule = require('./common/trackers.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const contentOutput = require('./common/contentOutput.js');

// Sections appended by this module when publishing to Confluence (target
// 'confluence'/'both'). On reruns the model iterates over the previous page content
// (input/confluence_output_current.md) and may copy these sections into its fresh
// output — they are stripped here before the publish step re-adds the up-to-date
// variants, so the page never accumulates duplicates.
var MANAGED_CONFLUENCE_SECTIONS = ['## Diagram', '## Affected Repositories'];

function stripManagedConfluenceSections(markdown) {
    if (!markdown) return markdown;
    var result = markdown;
    MANAGED_CONFLUENCE_SECTIONS.forEach(function(heading) {
        // From the heading to the next same-or-higher-level heading (## or #) or EOF.
        var re = new RegExp('\\n?' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '\\n[\\s\\S]*?(?=\\n#{1,2} |$)');
        result = result.replace(re, '\n');
    });
    return result.replace(/\n{3,}/g, '\n\n').trim();
}

// Instructions tell the model to write plain Mermaid syntax to outputs/diagram.md
// with no fences (see instructions/common/diagram_output_contract.md), but models
// occasionally add their own ```mermaid fence anyway. Strip any such wrapping fence
// here before we add our own, so the diagram is never double-fenced (which breaks
// rendering, e.g. showing literal "```mermaid" text inside the Confluence macro).
function stripMermaidFence(diagram) {
    if (!diagram) return diagram;
    var trimmed = diagram.trim();
    var fenceMatch = trimmed.match(/^```(?:mermaid)?\s*\n([\s\S]*?)\n?```\s*$/);
    if (fenceMatch) {
        return fenceMatch[1].trim();
    }
    // Defensive: strip any stray/unbalanced ``` fence lines the model may have
    // left in (e.g. an opening fence with no matching closer, or an extra one
    // in the middle of the content).
    return trimmed
        .split('\n')
        .filter(function(line) { return line.trim() !== '```' && line.trim() !== '```mermaid'; })
        .join('\n')
        .trim();
}

// ── Pure option/decision builders ────────────────────────────────────────────

// Field names and mode switches from customParams, with the same defaults the
// monolithic action used to apply inline.
function resolveOutputOptions(customParams) {
    return {
        solutionField: customParams.solutionField || JIRA_FIELDS.SOLUTION,
        diagramField: (customParams.diagramField !== undefined) ? customParams.diagramField : JIRA_FIELDS.DIAGRAMS,
        outputType: customParams.outputType || 'replace', // 'replace' | 'append'
        requireDiagram: customParams.requireDiagram === true || customParams.requireDiagram === 'true'
    };
}

// Early confluence-only probe (target 'confluence', not 'both'): decides whether the
// diagram must stay out of the jira {code} block because the jira field will only
// receive a page link. Any config resolution error falls through with jira behavior.
function decideConfluenceOnlyTarget(params) {
    try {
        var earlyOutputCfg = contentOutput.resolveConfig(params, { target: 'jira_field' });
        return contentOutput.isConfluenceTarget(earlyOutputCfg) &&
            !contentOutput.isJiraFieldTarget(earlyOutputCfg);
    } catch (e) {
        return false;
    }
}

// Where does the diagram go when there is no dedicated diagram field?
//   - jira target          → prepend as a {code} block into the solution body
//   - confluence-only      → defer; the publish step appends a Markdown "## Diagram" section
//   - dedicated field      → no special handling (written to the field as-is)
//   - no diagram at all    → nothing
function decideDiagramPlacement(diagram, diagramField, confluenceOnlyTarget) {
    return {
        prependToSolution: !!diagram && !diagramField && !confluenceOnlyTarget,
        deferToConfluence: !!diagram && !diagramField && confluenceOnlyTarget
    };
}

// Merge an existing field value with the freshly generated solution for
// outputType 'append'. The separator mirrors the historical wiki-markup divider.
function buildAppendValue(existing, solution) {
    return existing
        ? existing + '\n\n----\n\n' + solution
        : solution;
}

// Assemble the Confluence page body: strip publish-managed sections the model may
// have copied from the previous page content, then append the diagram as a single
// Markdown mermaid fence (never the jira {code} block).
function buildConfluencePageContent(solution, diagram) {
    var pageContent = stripManagedConfluenceSections(solution);
    if (diagram) {
        pageContent = pageContent + '\n\n## Diagram\n\n```mermaid\n' + stripMermaidFence(diagram) + '\n```\n';
    }
    return pageContent;
}

// Append the human-readable Affected Repositories section built by
// writeSolutionAndLabels. Returns the input unchanged when there is nothing to add.
function appendAffectedRepositoriesSection(pageContent, reposJson, shared) {
    var reposRaw = JSON.parse(reposJson);
    if (!Array.isArray(reposRaw) || reposRaw.length === 0) {
        return pageContent;
    }
    var sortedRepos = shared.topologicalSort(reposRaw);
    console.log('Appended Affected Repositories section to Confluence page content (' + sortedRepos.length + ' repos)');
    return pageContent + '\n\n' + shared.buildConfluenceMarkdownSection(sortedRepos);
}

// Text written into the tracker field for the confluence-only target: a link when
// the page URL is known, otherwise a page-id reference.
function buildConfluenceLinkText(pageUrl, published) {
    return pageUrl
        ? 'Solution published to Confluence: ' + pageUrl
        : 'Solution published to Confluence page ' + (published.page && published.page.id);
}

// Tracker comment announcing the published Confluence page.
function buildConfluenceCommentText(pageUrl, published) {
    return 'h3. 📐 Solution published to Confluence\n\n' +
        (pageUrl ? 'Page: ' + pageUrl : 'Page id: ' + (published.page && published.page.id));
}

// ── Tracker-side-effect helpers (same calls, same order, same log lines) ─────

// Read the current value of the solution field for append mode. An ADF (Atlassian
// Document Format) value cannot be reliably converted to wiki markup — the caller
// falls back to replace behavior to avoid corrupting the field.
function readExistingSolutionValue(tracker, ticketKey, solutionField) {
    var freshTicket = tracker.getIssue(ticketKey, [solutionField]);
    var freshFields = (freshTicket && freshTicket.fields) ? freshTicket.fields : freshTicket;
    var rawValue = freshFields ? freshFields[solutionField] : null;
    if (rawValue && typeof rawValue === 'object') {
        console.warn('Existing value of "' + solutionField + '" is in ADF format (Jira v3). Cannot merge with wiki markup — falling back to replace mode for this run.');
        return '';
    }
    return (rawValue || '').toString().trim();
}

// Step 4/5: write the solution to the tracker field (replace or append) and then
// the diagram to the dedicated diagram field when configured. Returns a failure
// result for the solution-field write only; the diagram-field write stays non-fatal.
function writeSolutionToTrackerField(dependencies) {
    var tracker = dependencies.tracker;
    var ticketKey = dependencies.ticketKey;
    var solutionField = dependencies.solutionField;
    var outputType = dependencies.outputType;
    try {
        var valueToWrite = dependencies.solution;
        if (outputType === 'append') {
            var existing = '';
            try {
                existing = readExistingSolutionValue(tracker, ticketKey, solutionField);
            } catch (e) {
                console.warn('Could not read existing value of "' + solutionField + '", will append without prefix:', e);
            }
            valueToWrite = buildAppendValue(existing, dependencies.solution);
            console.log('Appending to "' + solutionField + '" (' + (existing ? existing.length : 0) + ' existing chars)');
        }
        tracker.updateField(ticketKey, solutionField, valueToWrite);
        console.log('Updated "' + solutionField + '" field for ' + ticketKey + ' (mode: ' + outputType + ')');
    } catch (e) {
        console.error('Failed to update solution field "' + solutionField + '":', e);
        return { success: false, error: 'Solution field update failed: ' + e.toString() };
    }

    // 5. Write to diagram field if configured and diagram exists
    writeDiagramFieldQuietly(tracker, ticketKey, dependencies.diagramField, dependencies.diagram);
    return null;
}

function writeDiagramFieldQuietly(tracker, ticketKey, diagramField, diagram) {
    if (!diagram || !diagramField) {
        return;
    }
    try {
        tracker.updateField(ticketKey, diagramField, diagram);
        console.log('Updated "' + diagramField + '" field for ' + ticketKey);
    } catch (e) {
        console.warn('Failed to update diagram field "' + diagramField + '":', e);
    }
}

// Post replies to inline comments BEFORE the page body is replaced — while the
// comment anchors are still alive on the old content.
function publishConfluenceCommentReplies() {
    var replyResult = contentOutput.publishCommentReplies(contentOutput.DEFAULT_REPLIES_FILE);
    if (replyResult.posted > 0 || replyResult.failed > 0) {
        console.log('Replied to ' + replyResult.posted + ' inline comment(s)' +
            (replyResult.failed > 0 ? ', ' + replyResult.failed + ' failed' : ''));
    }
    return replyResult;
}

// Confluence-only target: the tracker field gets just a link (+ the Affected
// Repositories section appended by writeSolutionAndLabels), so without this the
// page would be missing the human-readable summary. buildConfluenceMarkdownSection
// is loaded lazily to avoid a require cycle with writeSolutionAndLabels.js (which
// requires this module). It is a Confluence-specific formatter — NOT the ADO
// buildMarkdownSection, whose ```json anchor block is meaningless on a Confluence
// page and whose extra fences previously combined badly with the diagram fence,
// producing a single garbled code macro once converted to Confluence storage format.
function tryAppendAffectedRepositories(pageContent, readOutput) {
    try {
        var reposJson = readOutput('affected_repos.json');
        if (!reposJson) {
            return pageContent;
        }
        var shared = require('./writeSolutionAndLabels.js');
        return appendAffectedRepositoriesSection(pageContent, reposJson, shared);
    } catch (reposError) {
        console.warn('Failed to append affected repos section to Confluence content (non-fatal):', reposError);
        return pageContent;
    }
}

// Write the Confluence page link into the tracker field (confluence-only target).
// Non-fatal: a broken link write must not fail the publish.
function writeConfluenceLinkToField(tracker, ticketKey, solutionField, pageUrl, published) {
    var linkText = buildConfluenceLinkText(pageUrl, published);
    try {
        tracker.updateField(ticketKey, solutionField, linkText);
    } catch (linkError) {
        console.warn('Failed to write Confluence link to "' + solutionField + '":', linkError);
    }
}

// Announce the published page on the ticket. Non-fatal.
function postConfluenceLinkComment(tracker, ticketKey, pageUrl, published) {
    try {
        tracker.postComment(ticketKey, buildConfluenceCommentText(pageUrl, published));
    } catch (commentError) {
        console.warn('Failed to post Confluence link comment:', commentError);
    }
}

// 5b. Publish to Confluence — for confluence/both targets. Returns a failure result
// when the publish itself throws, null on success.
function publishSolutionToConfluence(dependencies) {
    try {
        var outputCfg = dependencies.outputCfg;
        var tracker = dependencies.tracker;
        var ticketKey = dependencies.ticketKey;
        var ticketSummary = (dependencies.ticketFields && dependencies.ticketFields.summary) || '';
        var pageContent = buildConfluencePageContent(dependencies.solution, dependencies.diagram);

        publishConfluenceCommentReplies();

        if (outputCfg.target === 'confluence') {
            pageContent = tryAppendAffectedRepositories(pageContent, dependencies.readOutput);
        }

        var published = publishConfluencePage(outputCfg, ticketKey, ticketSummary, pageContent);
        var pageUrl = published.url;

        if (shouldWriteConfluenceLink(outputCfg)) {
            writeConfluenceLinkToField(tracker, ticketKey, dependencies.solutionField, pageUrl, published);
        }

        postConfluenceLinkComment(tracker, ticketKey, pageUrl, published);
    } catch (confError) {
        console.error('Failed to publish solution to Confluence:', confError);
        return { success: false, error: 'Confluence publish failed: ' + confError.toString() };
    }
    return null;
}

function publishConfluencePage(outputCfg, ticketKey, ticketSummary, pageContent) {
    var published = contentOutput.publishPage(outputCfg, ticketKey, ticketSummary, pageContent);
    console.log('Published solution to Confluence page ' + (published.page && published.page.id) + ' (' + (published.url || 'url unknown') + ')');
    return published;
}

// The tracker field gets the page link for the confluence-only target unless the
// config explicitly disables it.
function shouldWriteConfluenceLink(outputCfg) {
    return outputCfg.target === 'confluence' && outputCfg.updateTrackerField !== false;
}

// ── Finalization steps 6–10 (assign, move, labels) — each failure is non-fatal ──

function assignToInitiator(tracker, ticketKey, initiatorId) {
    try {
        tracker.assignTo(ticketKey, initiatorId);
        console.log('Assigned ' + ticketKey + ' to initiator');
    } catch (e) {
        console.warn('Failed to assign ticket:', e);
    }
}

function moveToReadyForDevelopment(tracker, ticketKey, jiraConfig) {
    try {
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.READY_FOR_DEVELOPMENT);
        console.log('Moved ' + ticketKey + ' to Ready For Development');
    } catch (e) {
        console.warn('Failed to move to Ready For Development:', e);
    }
}

function addAiGeneratedLabel(tracker, ticketKey) {
    try {
        tracker.addLabel(ticketKey, LABELS.AI_GENERATED);
    } catch (e) {
        console.warn('Failed to add ai_generated label:', e);
    }
}

function removeLabelQuietly(tracker, ticketKey, label, kind) {
    try {
        tracker.removeLabel(ticketKey, label);
        console.log('Removed ' + kind + ' label "' + label + '" from ' + ticketKey);
    } catch (e) {
        console.warn('Failed to remove ' + kind + ' label:', e);
    }
}

// Steps 6–10: assign to initiator, move to Ready For Development, add the
// ai_generated label, drop the WIP label and the SM trigger label (the latter so a
// crash-recovered ticket can be re-triggered).
function finalizeTicketState(dependencies) {
    var tracker = dependencies.tracker;
    var ticketKey = dependencies.ticketKey;
    assignToInitiator(tracker, ticketKey, dependencies.initiatorId);
    moveToReadyForDevelopment(tracker, ticketKey, dependencies.jiraConfig);
    addAiGeneratedLabel(tracker, ticketKey);
    if (dependencies.wipLabel) {
        removeLabelQuietly(tracker, ticketKey, dependencies.wipLabel, 'WIP');
    }
    if (dependencies.smTriggerLabel) {
        removeLabelQuietly(tracker, ticketKey, dependencies.smTriggerLabel, 'SM trigger');
    }
}

// Auto-start the development workflow when configured; otherwise (or when the
// trigger failed) nudge the SM if it is idle. Non-fatal either way.
function triggerDevelopmentAutoStart(dependencies) {
    var customParams = dependencies.customParams;
    var autoStartDevelopment = customParams.autoStartDevelopment === true ||
        customParams.autoStartDevelopment === 'true';
    var developmentConfigFile = customParams.autoStartDevelopmentConfigFile;
    var devStarted = false;
    if (autoStartDevelopment && developmentConfigFile) {
        try {
            devStarted = autoStart.triggerConfiguredWorkflowForTicket({
                scm: scmModule.createScm(dependencies.projectConfig),
                config: dependencies.projectConfig,
                ticketKey: dependencies.ticketKey,
                customParams: customParams,
                configFile: developmentConfigFile,
                label: 'development',
                stripKeys: ['autoStartDevelopment', 'autoStartDevelopmentConfigFile']
            });
        } catch (e) {
            console.warn('⚠️ autoStartDevelopment trigger failed:', e.message || e);
        }
    }
    if (!devStarted) {
        autoStart.triggerSmIfIdle({ config: dependencies.projectConfig, customParams: customParams });
    }
    return devStarted;
}

// Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
// wrote outputs/*_usage.json during the agent run. Non-fatal.
function postTokenUsageSummary(tracker, ticketKey, initiatorId) {
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: initiatorId, tracker: tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

// ── Extracted step helpers (gh-1187 CRAP split): same calls, same order,
// same log lines. action() stays a thin sequencer over these.

// Ticket/initiator/config/tracker context of one action run (same resolution
// order as the original inline block: metadata → customParams → projectConfig
// → tracker → output options).
function loadActionContext(params) {
    var ticketKey = params.ticket.key;
    var initiatorId = params.initiator;
    var wipLabel = params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip'
        : null;
    var customParams = (params.customParams) || (params.jobParams && params.jobParams.customParams) || {};
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var jiraConfig = projectConfig.jira;
    var tracker = trackersModule.createTracker(projectConfig, customParams);
    return {
        ticketKey: ticketKey,
        initiatorId: initiatorId,
        wipLabel: wipLabel,
        customParams: customParams,
        projectConfig: projectConfig,
        jiraConfig: jiraConfig,
        tracker: tracker,
        ticketFields: params.ticket.fields,
        options: resolveOutputOptions(customParams)
    };
}

// outputs/response.md + outputs/diagram.md reader (root or ticket subdir), trimmed.
function makeReadOutput(ctx) {
    return function(filename) {
        var content = outputFiles.readOutputFile(filename, {
            ticketKey: ctx.ticketKey,
            workingDir: ctx.projectConfig.workingDir || null
        });
        return content ? content.trim() : '';
    };
}

// Steps 1–2: read the solution (required) and the diagram (optionally required).
// Returns { error } with the failure result, or { solution, diagram }.
function readSolutionOutputs(readOutput, options) {
    var solution = readOutput('response.md');
    if (!solution) {
        console.error('outputs/response.md not found at root or ticket subdir');
        return { error: { success: false, error: 'outputs/response.md is empty' } };
    }
    var diagram = readOutput('diagram.md');
    if (!diagram) {
        console.warn('No diagram.md found, skipping diagram update');
        if (options.requireDiagram) {
            return { error: { success: false, error: 'outputs/diagram.md is required but empty' } };
        }
    }
    return { solution: solution, diagram: diagram };
}

// Step 3: route the diagram — prepend as a jira {code} block, defer to the
// Confluence publish step, or leave it for the dedicated field. Returns the
// (possibly rewritten) solution and the (possibly consumed) diagram.
function placeDiagram(solution, diagram, diagramField, confluenceOnlyTarget) {
    var placement = decideDiagramPlacement(diagram, diagramField, confluenceOnlyTarget);
    if (placement.prependToSolution) {
        solution = '{code}\n' + diagram + '\n{code}\n\n' + solution;
        console.log('No diagram field configured — diagram prepended to solution as {code} block');
        diagram = ''; // mark as handled
    } else if (placement.deferToConfluence) {
        console.log('No diagram field configured, Confluence-only target — diagram will be appended as Markdown "## Diagram" section at publish');
    }
    return { solution: solution, diagram: diagram };
}

// Steps 4/5b: write the solution/diagram to the tracker field and/or publish to
// Confluence, per the resolved output config. Returns a failure result or null.
function writeToConfiguredOutputs(ctx, outputCfg, solution, diagram, readOutput) {
    if (contentOutput.isJiraFieldTarget(outputCfg)) {
        var fieldFailure = writeSolutionToTrackerField({
            tracker: ctx.tracker,
            ticketKey: ctx.ticketKey,
            solutionField: ctx.options.solutionField,
            diagramField: ctx.options.diagramField,
            diagram: diagram,
            solution: solution,
            outputType: ctx.options.outputType
        });
        if (fieldFailure) {
            return fieldFailure;
        }
    }

    if (contentOutput.isConfluenceTarget(outputCfg)) {
        var confFailure = publishSolutionToConfluence({
            outputCfg: outputCfg,
            tracker: ctx.tracker,
            ticketKey: ctx.ticketKey,
            ticketFields: ctx.ticketFields,
            solutionField: ctx.options.solutionField,
            solution: solution,
            diagram: diagram,
            readOutput: readOutput
        });
        if (confFailure) {
            return confFailure;
        }
    }
    return null;
}

function action(params) {
    try {
        var ctx = loadActionContext(params);

        console.log('Processing solution and diagrams for:', ctx.ticketKey);
        console.log('Solution field: ' + ctx.options.solutionField + ', Diagram field: ' + (ctx.options.diagramField || '(none — will prepend to solution)') + ', outputType: ' + ctx.options.outputType);

        var readOutput = makeReadOutput(ctx);

        var outputs = readSolutionOutputs(readOutput, ctx.options);
        if (outputs.error) {
            return outputs.error;
        }

        // 3. If no dedicated diagram field — prepend diagram to solution.
        //    Confluence-only targets get a Markdown "## Diagram" section appended at the
        //    publish step (below); the Jira wiki {code} block must not leak into
        //    Confluence-bound content.
        var placed = placeDiagram(outputs.solution, outputs.diagram, ctx.options.diagramField, decideConfluenceOnlyTarget(params));

        var outputCfg = contentOutput.resolveConfig(params, {
            target: 'jira_field',
            field: ctx.options.solutionField,
            operationType: ctx.options.outputType,
            pageTitleSuffix: 'Solution Design'
        });

        var writeFailure = writeToConfiguredOutputs(ctx, outputCfg, placed.solution, placed.diagram, readOutput);
        if (writeFailure) {
            return writeFailure;
        }

        // 6–10. Assign, move, labels
        finalizeTicketState({
            tracker: ctx.tracker,
            ticketKey: ctx.ticketKey,
            initiatorId: ctx.initiatorId,
            jiraConfig: ctx.jiraConfig,
            wipLabel: ctx.wipLabel,
            smTriggerLabel: ctx.customParams.removeLabel
        });

        triggerDevelopmentAutoStart({
            projectConfig: ctx.projectConfig,
            customParams: ctx.customParams,
            ticketKey: ctx.ticketKey
        });

        postTokenUsageSummary(ctx.tracker, ctx.ticketKey, ctx.initiatorId);

        return { success: true, message: ctx.ticketKey + ' solution written, moved to Ready For Development' };

    } catch (error) {
        console.error('Error in writeSolutionAndDiagrams:', error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        stripManagedConfluenceSections: stripManagedConfluenceSections,
        stripMermaidFence: stripMermaidFence,
        resolveOutputOptions: resolveOutputOptions,
        decideConfluenceOnlyTarget: decideConfluenceOnlyTarget,
        decideDiagramPlacement: decideDiagramPlacement,
        buildAppendValue: buildAppendValue,
        buildConfluencePageContent: buildConfluencePageContent,
        appendAffectedRepositoriesSection: appendAffectedRepositoriesSection,
        buildConfluenceLinkText: buildConfluenceLinkText,
        buildConfluenceCommentText: buildConfluenceCommentText,
        readExistingSolutionValue: readExistingSolutionValue,
        writeSolutionToTrackerField: writeSolutionToTrackerField,
        writeDiagramFieldQuietly: writeDiagramFieldQuietly,
        publishConfluenceCommentReplies: publishConfluenceCommentReplies,
        tryAppendAffectedRepositories: tryAppendAffectedRepositories,
        writeConfluenceLinkToField: writeConfluenceLinkToField,
        postConfluenceLinkComment: postConfluenceLinkComment,
        publishSolutionToConfluence: publishSolutionToConfluence,
        publishConfluencePage: publishConfluencePage,
        shouldWriteConfluenceLink: shouldWriteConfluenceLink,
        assignToInitiator: assignToInitiator,
        moveToReadyForDevelopment: moveToReadyForDevelopment,
        addAiGeneratedLabel: addAiGeneratedLabel,
        removeLabelQuietly: removeLabelQuietly,
        finalizeTicketState: finalizeTicketState,
        triggerDevelopmentAutoStart: triggerDevelopmentAutoStart,
        postTokenUsageSummary: postTokenUsageSummary,
        loadActionContext: loadActionContext,
        makeReadOutput: makeReadOutput,
        readSolutionOutputs: readSolutionOutputs,
        placeDiagram: placeDiagram,
        writeToConfiguredOutputs: writeToConfiguredOutputs
    };
}
