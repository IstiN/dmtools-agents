/**
 * Shared epic/story intake fetch helpers.
 *
 * fetchEpicsToInput.js and intakePreAction.js both fetch a project's existing
 * epics and stories into the input folder before the agent runs. The field
 * mapping, tracker construction and search-collect-write pipeline live here,
 * parameterized over the small per-action differences (diagrams field source,
 * optional story extras, which params object the project config loads from,
 * and how search hits become mapped issues).
 *
 * Dependencies (trackers module, config loader) are passed in by each action:
 * the config loader is optional in intakePreAction, and the doc generator
 * follows local requires for customParams discovery only.
 */

// ── pure field helpers ──────────────────────────────────────────────────────

function priorityNameOf(fields) {
    return fields.priority ? fields.priority.name : '';
}

function parentKeyOf(fields) {
    return fields.parent ? fields.parent.key : null;
}

function statusNameOf(fields) {
    return fields.status ? fields.status.name : '';
}

// customParams as seen by these actions: jobParams win, then the params body.
function customParamsOf(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

// Tracker for one intake run. configParams lets each action choose which
// params object the project config is loaded from (fetchEpicsToInput prefers
// jobParams); a missing loader or loadProjectConfig resolves to null config.
function createTrackerFor(trackersModule, configLoader, params, configParams) {
    var projectConfig = (configLoader && configLoader.loadProjectConfig)
        ? (configLoader.loadProjectConfig(configParams) || null)
        : null;
    return trackersModule.createTracker(projectConfig, customParamsOf(params));
}

// Epic summary shape written to existing_epics.json; diagramsOf extracts the
// diagrams value from the raw fields (provider-specific key per action).
function mapEpic(issue, diagramsOf) {
    var f = issue.fields || {};
    return {
        key: issue.key || '',
        summary: f.summary || '',
        description: f.description || '',
        priority: priorityNameOf(f),
        diagrams: diagramsOf(f),
        parent: parentKeyOf(f)
    };
}

// Story summary shape written to existing_stories.json. The description key
// and the optional extractors are added only when supplied, in their
// established positions (description after summary, extras between diagrams
// and parent) so each action's written JSON key order is unchanged.
function mapStory(issue, options) {
    var sf = issue.fields || {};
    var story = {
        key: issue.key || '',
        summary: sf.summary || ''
    };
    if (options.descriptionOf) {
        story.description = options.descriptionOf(sf);
    }
    story.status = statusNameOf(sf);
    story.priority = priorityNameOf(sf);
    story.diagrams = options.diagramsOf(sf);
    if (options.acceptanceCriteriaOf) {
        story.acceptanceCriteria = options.acceptanceCriteriaOf(sf);
    }
    if (options.solutionOf) {
        story.solution = options.solutionOf(sf);
    }
    story.parent = parentKeyOf(sf);
    return story;
}

// Search → collect (spec.collect decides how hits become mapped issues) →
// write one existing_*.json payload. A fetch failure is logged and the run
// continues without the file. The concrete file_write calls stay in each
// action so the doc generator keeps finding the artifact paths there.
function fetchAndWrite(tracker, folder, spec) {
    try {
        var issues = spec.collect(tracker, spec);
        console.log('Found ' + issues.length + ' ' + spec.plural);
        spec.writeFile(folder, '{"' + spec.listKey + '":' + JSON.stringify(issues, null, 2) + '}');
        console.log('Wrote ' + spec.fileName + ' to ' + folder);
    } catch (fetchError) {
        console.error('Failed to fetch ' + spec.plural + ', continuing without file:', fetchError);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        priorityNameOf: priorityNameOf,
        parentKeyOf: parentKeyOf,
        statusNameOf: statusNameOf,
        customParamsOf: customParamsOf,
        createTrackerFor: createTrackerFor,
        mapEpic: mapEpic,
        mapStory: mapStory,
        fetchAndWrite: fetchAndWrite
    };
}
