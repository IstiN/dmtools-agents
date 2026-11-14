/**
 * Shared epic/story intake fetch helpers.
 *
 * fetchEpicsToInput.js and intakePreAction.js both fetch a project's existing
 * epics and stories into the input folder before the agent runs. The field
 * mapping, tracker construction, provider-aware search query generation and
 * search-collect-write pipeline live here, parameterized over the small
 * per-action differences (diagrams field source, optional story extras, which
 * params object the project config loads from, and how search hits become
 * mapped issues).
 *
 * Dependencies (trackers module, config loader) are passed in by each action:
 * the config loader is optional in intakePreAction, and the doc generator
 * follows local requires for customParams discovery only.
 */

var DEFAULT_ADO_FETCH_CAP = 100;

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
    var p = params || {};
    return (p.jobParams && p.jobParams.customParams) || p.customParams || {};
}

// Load project config safely via optional configLoader.
function loadProjectConfigFor(configLoader, configParams) {
    return (configLoader && configLoader.loadProjectConfig)
        ? (configLoader.loadProjectConfig(configParams) || null)
        : null;
}

// Tracker for one intake run. configParams lets each action choose which
// params object the project config is loaded from (fetchEpicsToInput prefers
// jobParams); a missing loader or loadProjectConfig resolves to null config.
function createTrackerFor(trackersModule, configLoader, params, configParams) {
    var projectConfig = loadProjectConfigFor(configLoader, configParams);
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

// ── query & ADO scope helpers (gh-1478) ─────────────────────────────────────

function isAdoTracker(tracker) {
    return Boolean(tracker && typeof tracker.provider === 'function' && tracker.provider() === 'ado');
}

function wiqlQuote(val) {
    return "'" + String(val == null ? '' : val).replace(/'/g, "''") + "'";
}

function wiqlIdExpr(key) {
    var trimmed = String(key == null ? '' : key).trim();
    return /^\d+$/.test(trimmed) ? trimmed : wiqlQuote(trimmed);
}

function sectionIssueTypes(section) {
    return (section && section.issueTypes) || {};
}

function resolveIssueTypes(projectConfig, customParams) {
    var cfg = projectConfig || {};
    return Object.assign(
        { EPIC: 'Epic', STORY: 'Story', BUG: 'Bug' },
        sectionIssueTypes(cfg.jira),
        sectionIssueTypes(cfg.tracker),
        sectionIssueTypes(customParams)
    );
}

function defaultTypeForKind(isEpic, isAdo) {
    if (isEpic) return isAdo ? 'Feature' : 'Epic';
    return isAdo ? 'Product Backlog Item' : 'Story';
}

function isUnoverriddenJiraDefault(configured, isEpic, isAdo) {
    if (!configured) return true;
    if (!isAdo) return false;
    return isEpic ? configured === 'Epic' : configured === 'Story';
}

function issueTypeForKind(kind, issueTypes, isAdo) {
    var types = issueTypes || {};
    var isEpic = String(kind || '').toLowerCase() === 'epic';
    var configured = isEpic ? (types.EPIC || types.FEATURE) : types.STORY;
    return isUnoverriddenJiraDefault(configured, isEpic, isAdo)
        ? defaultTypeForKind(isEpic, isAdo)
        : configured;
}

function adoProjectClause(project) {
    var p = String(project == null ? '' : project).trim();
    if (!p || /^\d+$/.test(p)) return '';
    return '[System.TeamProject] = ' + wiqlQuote(p) + ' AND ';
}

function adoAreaClause(areaPath) {
    var area = String(areaPath == null ? '' : areaPath).trim();
    return area ? ' AND [System.AreaPath] UNDER ' + wiqlQuote(area) : '';
}

function buildAdoScopedWiql(project, typeName, scope) {
    var s = scope || {};
    return 'SELECT [System.Id] FROM WorkItems WHERE ' +
        adoProjectClause(project) +
        '[System.WorkItemType] = ' + wiqlQuote(typeName) +
        adoAreaClause(s.areaPath) +
        " AND [System.State] NOT IN ('Removed', 'Done') ORDER BY [System.CreatedDate] DESC";
}

function buildAdoChildrenWiql(ticketKey, typeName) {
    var idExpr = wiqlIdExpr(ticketKey);
    return 'SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = ' + idExpr +
        ' AND [Target].[System.Id] <> ' + idExpr +
        ' AND [Target].[System.WorkItemType] = ' + wiqlQuote(typeName) +
        ' MODE (MustContain)';
}

/**
 * Build provider-specific search query: JQL for Jira (unchanged) and scoped
 * WIQL for ADO (same-area Features/PBIs excluding Removed and Done, ordered
 * by [System.CreatedDate] DESC).
 */
function searchQueryFor(tracker, project, kind, issueTypes, scope) {
    var ado = isAdoTracker(tracker);
    var typeName = issueTypeForKind(kind, issueTypes, ado);
    if (ado) {
        return buildAdoScopedWiql(project, typeName, scope);
    }
    return 'project = ' + (project || '') + ' AND issuetype = ' + typeName + ' ORDER BY created DESC';
}

function fieldsOfIssue(issue) {
    return (issue && issue.fields) || {};
}

function rawFieldsOfIssue(issue) {
    return (issue && issue.raw && issue.raw.fields) || {};
}

function areaPathFromIssue(issue) {
    var f = fieldsOfIssue(issue);
    var rf = rawFieldsOfIssue(issue);
    return f['System.AreaPath'] || rf['System.AreaPath'] || f.areaPath || '';
}

function configuredProjectOf(projectConfig) {
    var cfg = projectConfig || {};
    var trk = cfg.tracker || {};
    var jra = cfg.jira || {};
    return trk.adoProject || jra.project || '';
}

function fetchSourceAreaPath(tracker, ticketKey) {
    if (!ticketKey || !tracker || typeof tracker.getIssue !== 'function') return '';
    try {
        return areaPathFromIssue(tracker.getIssue(ticketKey, ['System.AreaPath']));
    } catch (e) {
        return '';
    }
}

function resolveAdoScope(tracker, ticketKey, ticketObj, projectConfig) {
    var areaPath = areaPathFromIssue(ticketObj) || fetchSourceAreaPath(tracker, ticketKey);
    return {
        ticketKey: ticketKey || '',
        project: configuredProjectOf(projectConfig),
        areaPath: areaPath,
        cap: DEFAULT_ADO_FETCH_CAP
    };
}

function searchAdoChildren(tracker, spec) {
    var scope = spec.scope || {};
    if (!scope.ticketKey) return [];
    var typeName = issueTypeForKind(spec.kind, spec.issueTypes, true);
    var childWiql = buildAdoChildrenWiql(scope.ticketKey, typeName);
    try {
        return tracker.searchIssues(childWiql, { fields: spec.fields }) || [];
    } catch (e) {
        return [];
    }
}

function appendUniqueHit(hit, seen, out) {
    var k = hit && hit.key;
    if (k && !seen[k]) {
        seen[k] = true;
        out.push(hit);
    }
}

function mergeAndCapAdoHits(childHits, areaHits, cap) {
    var max = cap > 0 ? cap : DEFAULT_ADO_FETCH_CAP;
    var seen = {};
    var out = [];
    var all = (childHits || []).concat(areaHits || []);
    for (var i = 0; i < all.length && out.length < max; i++) {
        appendUniqueHit(all[i], seen, out);
    }
    return out;
}

/**
 * Collect and map search results directly without per-item getIssue refetch.
 * On ADO, merges children of the source ticket with capped same-area items.
 */
function collectFromSearch(tracker, spec) {
    var areaHits = tracker.searchIssues(spec.jql, { fields: spec.fields }) || [];
    if (!isAdoTracker(tracker)) {
        return areaHits.map(spec.map);
    }
    var scope = spec.scope || {};
    var childHits = searchAdoChildren(tracker, spec);
    return mergeAndCapAdoHits(childHits, areaHits, scope.cap).map(spec.map);
}

// ── skipExistingFetch & failure handling (gh-1478, gh-1479) ─────────────────

function sectionSkipFlag(section) {
    if (!section) return false;
    return section.skipExistingFetch === true || section.fetchExisting === false;
}

function isSkipExistingFetch(customParams, projectConfig) {
    var cfg = projectConfig || {};
    return sectionSkipFlag(customParams) || sectionSkipFlag(cfg.jira) || sectionSkipFlag(cfg.tracker);
}

function writeEmptyExistingFiles(folder, writeEpicsFile, writeStoriesFile) {
    writeEpicsFile(folder, '{"epics":[]}');
    writeStoriesFile(folder, '{"stories":[]}');
    console.log('Skipped fetching existing epics/stories by configuration; wrote empty files to ' + folder);
}

function postFetchFailureComment(tracker, ticketKey, failedPlural) {
    if (!ticketKey || !tracker || typeof tracker.postComment !== 'function') return;
    try {
        tracker.postComment(ticketKey, 'h3. *Intake Pre-Action Failed*\n\n' +
            'Could not fetch existing ' + (failedPlural || 'epics/stories') + ' from the tracker. ' +
            'Aborting intake before the agent runs so it does not decompose without duplicate context.');
    } catch (e) {
        console.warn('Failed to post intake fetch failure comment:', e);
    }
}

// Search → collect (spec.collect decides how hits become mapped issues) →
// write one existing_*.json payload. Returns true when written, false when
// fetch/write failed (gh-1479).
function fetchAndWrite(tracker, folder, spec) {
    try {
        var issues = spec.collect(tracker, spec);
        console.log('Found ' + issues.length + ' ' + spec.plural);
        spec.writeFile(folder, '{"' + spec.listKey + '":' + JSON.stringify(issues, null, 2) + '}');
        console.log('Wrote ' + spec.fileName + ' to ' + folder);
        return true;
    } catch (fetchError) {
        console.error('Failed to fetch ' + spec.plural + ', continuing without file:', fetchError);
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_ADO_FETCH_CAP: DEFAULT_ADO_FETCH_CAP,
        priorityNameOf: priorityNameOf,
        parentKeyOf: parentKeyOf,
        statusNameOf: statusNameOf,
        customParamsOf: customParamsOf,
        loadProjectConfigFor: loadProjectConfigFor,
        createTrackerFor: createTrackerFor,
        mapEpic: mapEpic,
        mapStory: mapStory,
        isAdoTracker: isAdoTracker,
        wiqlQuote: wiqlQuote,
        wiqlIdExpr: wiqlIdExpr,
        resolveIssueTypes: resolveIssueTypes,
        issueTypeForKind: issueTypeForKind,
        buildAdoScopedWiql: buildAdoScopedWiql,
        buildAdoChildrenWiql: buildAdoChildrenWiql,
        searchQueryFor: searchQueryFor,
        resolveAdoScope: resolveAdoScope,
        collectFromSearch: collectFromSearch,
        isSkipExistingFetch: isSkipExistingFetch,
        writeEmptyExistingFiles: writeEmptyExistingFiles,
        postFetchFailureComment: postFetchFailureComment,
        fetchAndWrite: fetchAndWrite
    };
}
