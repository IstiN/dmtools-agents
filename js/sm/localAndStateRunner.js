/**
 * LocalExecution runner and factory-state publisher —
 * js/sm/localAndStateRunner.js (#1459).
 */
'use strict';

var buildEncodedConfigModule = require('../common/buildEncodedConfig.js');
var configLoader = require('../configLoader.js');
var factoryStateModule = require('../factoryState.js');
var guestValidationPathModule = require('../common/guestValidationPath.js');
var labelListModule = require('../common/labelList.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var mutexRegistryModule = require('../common/mutexRegistry.js');
var quotaBreakerModule = require('../common/quotaCircuitBreaker.js');
var reworkLatchModule = require('../common/reworkLatch.js');
var smProviderModule = require('../common/smProvider.js');
var validationProbesModule = require('./validationProbes.js');
var mcpParse = validationProbesModule.mcpParse;
var HELPER_SPECS = [
  { id: 'ticketKeyShapes.js', varName: '_tks', modKey: 'ticketKeyShapesModule' },
  { id: 'gitlabTracker.js', varName: '_glt', modKey: 'gitlabTrackerModule' },
  { id: 'trackers.js', varName: '_tr', modKey: 'trackersModule' },
  { id: 'linkedIssuesReport.js', varName: '_lir', modKey: 'linkedIssuesReportModule' },
  { id: 'tokenUsageComment.js', varName: '_tu', modKey: 'tokenUsageCommentModule' },
  { id: 'smDoneCheck.js', varName: '_sdc', modKey: 'smDoneCheckModule' },
  { id: 'aiChat.js', varName: '_ac', modKey: 'aiChatModule' },
  { id: 'validateInputJql.js', varName: '_vq', modKey: 'validateInputJqlModule' },
  { id: 'buildEncodedConfig.js', varName: '_bc', modKey: 'buildEncodedConfigModule' },
  { id: 'autoStart.js', varName: '_as', modKey: 'autoStartModule' },
  { id: 'commentMarkup.js', varName: '_qmk', modKey: 'commentMarkupModule' },
  { id: 'quotaCircuitBreaker.js', varName: '_qcb', modKey: 'quotaBreakerModule' },
  { id: 'machineAuthor.js', varName: '_mau', modKey: 'machineAuthorModule' },
  { id: 'reviewVerdicts.js', varName: '_rvd', modKey: 'reviewVerdictsModule' },
  { id: 'tcRunRegistry.js', varName: '_trr', modKey: 'tcRunRegistryModule' },
  { id: 'ledgerCore.js', varName: '_lgc', modKey: 'ledgerCoreModule' },
  { id: 'tcMaintenanceLedger.js', varName: '_tml', modKey: 'tcMaintenanceLedgerModule' },
  { id: 'tcAlternation.js', varName: '_tal', modKey: 'tcAlternationModule' },
  { id: 'tcTriage.js', varName: '_ttg', modKey: 'tcTriageModule' },
  { id: 'bugBookkeeping.js', varName: '_bbk', modKey: 'bugBookkeepingModule' },
  { id: 'jobTicketInputs.js', varName: '_jti', modKey: 'jobTicketInputsModule' }
];
var LOCAL_SHIM_FN = 'function(id) {\n' + '      if (id === "./configLoader.js" || id === "./configLoader" || id.indexOf("configLoader.js") !== -1) return _cl.exports;\n' + '      if (id.indexOf("scm.js") !== -1) return _scm.exports;\n' + HELPER_SPECS.map(function (h) {
  return '      if (id.indexOf("' + h.id + '") !== -1) return ' + h.varName + '.exports;\n';
}).join('') + '      return _cm.exports;\n' + '    }';
function readDualLayoutSource(readFile, relPath) {
  var code = readFile('agents/' + relPath);
  if (!code || !code.trim()) {
    code = readFile(relPath);
  }
  return code && code.trim() ? code : null;
}
function readLocalActionSource(readFile, jsPath) {
  var altPath = jsPath.indexOf('agents/') === 0 ? jsPath.substring('agents/'.length) : 'agents/' + jsPath;
  var code = readFile(jsPath);
  if (!code || !code.trim()) {
    code = readFile(altPath);
  }
  if (!code || !code.trim()) {
    throw new Error('Cannot read: ' + jsPath);
  }
  return code;
}
function buildLocalModuleBlock(readFile, varName, relPath, fallbackExpr, reqExpr, errLabel, wrapHelperErr) {
  var code = readDualLayoutSource(readFile, relPath);
  if (code) {
    var evalBody = '  (function(module, exports, require) {\n' + code + '\n  })(' + varName + ', ' + varName + '.exports, ' + reqExpr + ');\n';
    if (wrapHelperErr) {
      evalBody = '  try {\n' + evalBody + '  } catch (e) {\n' + '    throw new Error("Failed to load localExecution helper ' + wrapHelperErr + ': " + (e.message || e));\n  }\n';
    }
    return '  var ' + varName + ' = { exports: {} };\n' + evalBody;
  }
  if (fallbackExpr) {
    return '  var ' + varName + ' = { exports: ' + fallbackExpr + ' };\n';
  }
  throw new Error('Cannot read: ' + errLabel);
}
function usableRuntimeModuleExpr(mods, key, fallbackStr) {
  return mods[key] && !mods[key].__unreadable__ ? key : fallbackStr;
}
function buildBaseLocalBlocks(readFile, mods) {
  return buildLocalModuleBlock(readFile, '_cm', 'js/config.js', usableRuntimeModuleExpr(mods, 'configModule', null), 'function() { return {}; }', 'config.js', null) + buildLocalModuleBlock(readFile, '_scm', 'js/common/scm.js', usableRuntimeModuleExpr(mods, 'scmModule', null), 'function() { return _cm.exports; }', 'common/scm.js', null) + buildLocalModuleBlock(readFile, '_cl', 'js/configLoader.js', usableRuntimeModuleExpr(mods, 'configLoader', '({})'), 'function(id) { return id.indexOf("scm.js") !== -1 ? _scm.exports : _cm.exports; }', 'configLoader.js', null);
}
function buildHelperLocalBlocks(readFile, mods) {
  var helpers = '';
  for (var i = 0; i < HELPER_SPECS.length; i++) {
    var hm = HELPER_SPECS[i];
    var fb = usableRuntimeModuleExpr(mods, hm.modKey, null);
    helpers += buildLocalModuleBlock(readFile, hm.varName, 'js/common/' + hm.id, fb, '_shim', 'common/' + hm.id, hm.id);
  }
  return helpers;
}
function runLocalAction(deps, jsPath, ticket, agentParams) {
  var readFile = deps.fileRead;
  var mods = deps.runtimeModules;
  var actionCode = readLocalActionSource(readFile, jsPath);
  var base = buildBaseLocalBlocks(readFile, mods);
  var helpers = buildHelperLocalBlocks(readFile, mods);
  var script = '(function() {\n' + base + '  var _shim = ' + LOCAL_SHIM_FN + ';\n' + helpers + '  var _am = { exports: {} };\n' + '  (function(module, exports, require) {\n' + actionCode + '\n  })(\n' + '    _am, _am.exports,\n' + '    _shim\n' + '  );\n' + '  return _am.exports;\n' + '})()';
  var exported = deps.evalLocalScript(script);
  if (!exported || typeof exported.action !== 'function') {
    throw new Error('No action() exported from: ' + jsPath);
  }
  return exported.action({
    ticket: ticket,
    jobParams: agentParams
  });
}
function resolveAgentConfigFromCandidates(readFile, resolvedCf) {
  var cfCandidates = [resolvedCf];
  if (resolvedCf.indexOf('agents/') === 0) {
    cfCandidates.push(resolvedCf.substring('agents/'.length));
  } else {
    cfCandidates.push('agents/' + resolvedCf.replace(/^agents\//, ''));
  }
  for (var ci = 0; ci < cfCandidates.length; ci++) {
    try {
      var raw = readFile(cfCandidates[ci]);
      if (raw && raw.trim()) {
        return JSON.parse(raw);
      }
    } catch (e) {/* try next layout */}
  }
  return null;
}
function queryRuleTicketsOrThrow(deps, rule, effectiveConfig, effectiveRepoInfo, interpolatedJql) {
  try {
    return deps.queryRuleTickets(rule, effectiveConfig, effectiveRepoInfo, interpolatedJql);
  } catch (e) {
    deps.error('  ❌ state query failed: ' + (e.message || e));
    throw e;
  }
}
function logDryLocalTickets(deps, rule, effectiveConfig, effectiveRepoInfo, interpolatedJql) {
  var dryTickets = queryRuleTicketsOrThrow(deps, rule, effectiveConfig, effectiveRepoInfo, interpolatedJql);
  if (typeof rule.limit === 'number' && dryTickets.length > rule.limit) {
    deps.log('  Limiting from ' + dryTickets.length + ' to ' + rule.limit + ' ticket(s)');
    dryTickets = dryTickets.slice(0, rule.limit);
  }
  deps.log(dryTickets.length === 0 ? '  No tickets found.' : '  ' + dryTickets.length + ' tickets found.');
  deps.log('  [dry] local execution skipped');
  return {
    processedKeys: [],
    skippedKeys: []
  };
}
function resolveFullTicketForLocal(deps, effectiveConfig, ticket, key) {
  try {
    var fullTicket = deps.smTracker(effectiveConfig).getIssue(key);
    if (!fullTicket || !fullTicket.key) {
      throw new Error('Empty ticket returned');
    }
    return fullTicket;
  } catch (e) {
    deps.warn('  ⚠️  getIssue(' + key + ') failed (' + e + '), falling back to search-result data');
    return ticket;
  }
}
function recoverOrSkipLocalLabel(deps, rule, key, skipLabel, effectiveRepoInfo, skippedKeys) {
  if (deps.shouldRecoverStaleTriggerLabel(rule, skipLabel)) {
    deps.log('  ♻️  ' + key + ' has stale lock ' + skipLabel + ' (local run finished) — recovering');
    deps.removeRuleLabel(key, skipLabel, rule, effectiveRepoInfo);
    return false;
  }
  deps.log('  ⏭️  ' + key + ' skipped (label: ' + skipLabel + ')');
  skippedKeys.push(key);
  return true;
}
function checkLocalSkipGuards(deps, rule, ticket, key, effectiveRepoInfo, skippedKeys) {
  if (quotaBreakerModule.shouldSkipForQuotaPark(ticket, rule, deps.jobParams)) {
    deps.log('  🅿️  ' + key + ' skipped (provider-quota park)');
    skippedKeys.push(key);
    return true;
  }
  var skipLabel = deps.firstMatchingLabel(ticket, labelListModule.normalizeLabels(rule.skipIfLabel, rule.skipIfLabels));
  if (!skipLabel) {
    return false;
  }
  return recoverOrSkipLocalLabel(deps, rule, key, skipLabel, effectiveRepoInfo, skippedKeys);
}
function executeLocalTicketAction(deps, rule, effectiveRepoInfo, postJSActionPath, agentParams, fullTicket, key, processedKeys) {
  try {
    deps.log('  ▶️  ' + key + ' → ' + postJSActionPath);
    var result = runLocalAction(deps, postJSActionPath, fullTicket, agentParams);
    var actDesc = result && result.action || JSON.stringify(result).substring(0, 80);
    deps.log('  ✅ ' + key + ' done — action: ' + actDesc);
    processedKeys.push(key);
    deps.addRuleLabels(key, rule, effectiveRepoInfo);
  } catch (e) {
    deps.error('  ❌ Local execution failed for ' + key + ': ' + (e.message || e));
  }
}
function runSingleLocalTicket(deps, rule, effectiveConfig, effectiveRepoInfo, postJSActionPath, agentParams, ticket, processedKeys, skippedKeys) {
  var key = ticket.key;
  if (checkLocalSkipGuards(deps, rule, ticket, key, effectiveRepoInfo, skippedKeys)) {
    return;
  }
  if (rule.targetStatus) {
    deps.moveStatus(key, rule.targetStatus);
  }
  var fullTicket = resolveFullTicketForLocal(deps, effectiveConfig, ticket, key);
  executeLocalTicketAction(deps, rule, effectiveRepoInfo, postJSActionPath, agentParams, fullTicket, key, processedKeys);
}
function resolveLocalActionEntrypoint(deps, rule, effectiveConfig, effectiveRepoInfo) {
  var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
  var agentConfig = resolveAgentConfigFromCandidates(deps.fileRead, resolvedCf);
  if (!agentConfig) {
    deps.error('  ❌ Cannot read/parse configFile: ' + resolvedCf);
    return null;
  }
  var baseParams = agentConfig.params || {};
  var postJSActionPath = baseParams.postJSAction;
  if (!postJSActionPath) {
    deps.warn('  ⚠️  No postJSAction in ' + resolvedCf + ' — cannot run locally');
    return null;
  }
  var repo = effectiveConfig.repository && effectiveConfig.repository.owner ? effectiveConfig.repository : {
    owner: effectiveRepoInfo.owner,
    repo: effectiveRepoInfo.repo
  };
  return {
    postJSActionPath: postJSActionPath,
    agentParams: Object.assign({}, baseParams, {
      repository: repo
    })
  };
}
function hasRuleTarget(rule, allowInputsOrAction) {
  if (!allowInputsOrAction) {
    return !!rule.configFile;
  }
  return !!(rule.configFile || rule.inputs || rule.localAction);
}
function validateRuleShape(deps, rule, allowInputsOrAction) {
  if (rule.enabled === false) {
    deps.log('  ⏸️  Rule disabled — skipping');
    return false;
  }
  var qKey = !rule.source || rule.source === 'jira' ? 'jql' : 'query';
  if (!rule[qKey] || !hasRuleTarget(rule, allowInputsOrAction)) {
    var msg = allowInputsOrAction ? 'configFile (or inputs)' : 'configFile';
    deps.warn('  ⚠️  Skipping rule — ' + qKey + ' and ' + msg + ' are required');
    return false;
  }
  return true;
}
function validateRuleForLocal(deps, rule) {
  return validateRuleShape(deps, rule, false);
}
function applyRuleTicketLimit(deps, rule, tickets) {
  if (typeof rule.limit === 'number' && tickets.length > rule.limit) {
    deps.log('  Limiting from ' + tickets.length + ' to ' + rule.limit + ' ticket(s)');
    return tickets.slice(0, rule.limit);
  }
  return tickets;
}
function runLocalTicketBatch(deps, rule, effectiveConfig, effectiveRepoInfo, entry, interpolatedJql) {
  var tickets = applyRuleTicketLimit(deps, rule, queryRuleTicketsOrThrow(deps, rule, effectiveConfig, effectiveRepoInfo, interpolatedJql));
  if (tickets.length === 0) {
    deps.log('  No tickets found.');
    return { processedKeys: [], skippedKeys: [] };
  }
  deps.log('  Found ' + tickets.length + ' ticket(s) — running locally via ' + entry.postJSActionPath);
  var processedKeys = [];
  var skippedKeys = [];
  tickets.forEach(function (ticket) {
    runSingleLocalTicket(deps, rule, effectiveConfig, effectiveRepoInfo, entry.postJSActionPath, entry.agentParams, ticket, processedKeys, skippedKeys);
  });
  return { processedKeys: processedKeys, skippedKeys: skippedKeys };
}
function processRuleLocally(deps, rule, globalRepoInfo, ruleIndex, effectiveConfig, interpolatedJql) {
  var empty = { processedKeys: [], skippedKeys: [] };
  var effectiveRepoInfo = globalRepoInfo || {};
  var label = rule.description || 'Rule #' + (ruleIndex + 1);
  deps.log('\n══ [' + (deps.dry ? 'LOCAL·DRY' : 'LOCAL') + '] ' + label + ' ══');
  deps.logRuleQuery(rule, interpolatedJql);
  if (!validateRuleForLocal(deps, rule)) {
    return empty;
  }
  if (deps.dry) {
    return logDryLocalTickets(deps, rule, effectiveConfig, effectiveRepoInfo, interpolatedJql);
  }
  var entry = resolveLocalActionEntrypoint(deps, rule, effectiveConfig, effectiveRepoInfo);
  return entry ? runLocalTicketBatch(deps, rule, effectiveConfig, effectiveRepoInfo, entry, interpolatedJql) : empty;
}
function parseReleaseStatePublishConfig(jobParams) {
  var raw = mcpParse((jobParams || {}).statePublish);
  return raw && raw.channel === 'release' ? raw : null;
}
function resolveStatePublishTarget(jobParams, effectiveRepoInfo) {
  var spCfg = parseReleaseStatePublishConfig(jobParams);
  if (!spCfg) {
    return null;
  }
  var spRepo = effectiveRepoInfo;
  if (spCfg.repo) {
    var parts = String(spCfg.repo).split('/');
    spRepo = {
      owner: parts[0],
      repo: parts[1]
    };
  }
  return spRepo && spRepo.owner && spRepo.repo ? {
    cfg: spCfg,
    repo: spRepo
  } : null;
}
function fetchMergedAndOpenIssuesSafe(deps, spRepo, spFull) {
  var merged = [];
  var issues = [];
  try {
    var spM = mcpParse(deps.listPrs(spRepo, 'merged'));
    merged = Array.isArray(spM) ? spM : [];
  } catch (eMerged) {}
  try {
    var spD = mcpParse(deps.searchIssues('repo:' + spFull + ' is:issue is:open'));
    issues = Array.isArray(spD) ? spD : spD && (spD.items || spD.data) || [];
  } catch (eDevs) {}
  return {
    merged: merged,
    issues: issues
  };
}
function logAndUpdateHistory(deps, spState, spCfg, spUrl, spTokens, spTokensSrc, spPricing) {
  deps.log('  📡 factory state published → ' + spUrl);
  deps.log('  🪙 tokens: ' + factoryStateModule.tokensLegCount(spTokens) + ' legs (' + spTokensSrc + ')');
  deps.log('  💲 pricing: ' + (spState.costs ? spPricing.models + ' models · Σ$' + spState.costs.usd14d + ' (' + spState.costs.windowDays + 'd)' : 'off — tokens only'));
  try {
    var hUrl = factoryStateModule.updateHistory(spState, spCfg, deps.exec);
    deps.log('  🕘 factory state history updated → ' + hUrl);
  } catch (eHist) {
    deps.warn('  ⚠️  factory state history failed: ' + (eHist.message || eHist));
  }
}
function scanSingleRepoDeadZone(deps, repoKey, dzRepoInfo, machineAuthor, blocked) {
  if (!dzRepoInfo || !dzRepoInfo.owner || !dzRepoInfo.repo) {
    return;
  }
  var t0 = Date.now();
  try {
    var dzProvider = smProviderModule.createSmProvider({
      scm: {
        provider: deps.smForge
      },
      repository: dzRepoInfo
    });
    var stats = guestValidationPathModule.scanRepoGuestDeadZone(dzProvider, dzRepoInfo, machineAuthor, blocked);
    deps.log('  🔎 dead-zone scan (' + repoKey + '): ' + stats.totalOpen + ' open PR(s), ' + stats.probedCount + ' prStatus probe(s) in ' + (Date.now() - t0) + 'ms');
  } catch (eDzRepo) {
    deps.warn('  ⚠️ dead-zone scan failed for ' + repoKey + ' (fail-open visibility): ' + (eDzRepo.message || eDzRepo));
  }
}
function ensureDeadZoneScan(deps, machineAuthor) {
  var existing = deps.getTickDeadZone();
  if (existing) {
    return existing;
  }
  var blocked = [];
  var reposSeen = deps.tickReposSeen || {};
  Object.keys(reposSeen).forEach(function (repoKey) {
    scanSingleRepoDeadZone(deps, repoKey, reposSeen[repoKey], machineAuthor, blocked);
  });
  var dz = {
    blocked: blocked,
    scannedAt: new Date().toISOString()
  };
  deps.tickDeadZone = dz;
  deps.setTickDeadZone(dz);
  return dz;
}
function readTokensAndPricing(deps, spFull, spCfg) {
  var spTokens = factoryStateModule.readTokensFile(spCfg.tokensFile || factoryStateModule.DEFAULT_TOKENS_FILE, deps.fileRead);
  var src = 'local';
  if (!spTokens) {
    spTokens = factoryStateModule.fetchTokensFromBranch(spFull, spCfg, deps.exec);
    src = spTokens ? 'branch' : 'none';
  }
  var spPricingRead = factoryStateModule.readModelPricing(spCfg.pricingFile || factoryStateModule.DEFAULT_PRICING_FILE, deps.fileRead);
  if (spPricingRead && spPricingRead.error) {
    deps.warn('  ⚠️  model pricing ignored (' + spPricingRead.error + ') — cards render tokens only');
  }
  return {
    tokens: spTokens,
    src: src,
    pricing: spPricingRead ? spPricingRead.pricing : null
  };
}
function parseOpenPrListForSnapshot(raw) {
  var spPrs = mcpParse(raw);
  if (Array.isArray(spPrs)) {
    return spPrs;
  }
  return spPrs && (spPrs.pullRequests || spPrs.data || spPrs.items) || [];
}
function parseWorkflowRunListForSnapshot(raw) {
  var spRuns = mcpParse(raw);
  return spRuns ? spRuns.workflow_runs || spRuns.workflowRuns || [] : [];
}
function readSnapshotInputs(deps, spRepo, spFull, spCfg) {
  var tp = readTokensAndPricing(deps, spFull, spCfg);
  return {
    prList: parseOpenPrListForSnapshot(deps.listPrs(spRepo, 'open')),
    runList: parseWorkflowRunListForSnapshot(deps.listWorkflowRuns(spRepo)),
    tokens: tp.tokens,
    src: tp.src,
    pricing: tp.pricing
  };
}
function applyMergedMutexSnapshot(spState, spPrev, spMutex) {
  if (!spMutex && !(spPrev && spPrev.mutex)) {
    return;
  }
  spState.mutex = mutexRegistryModule.mergeSnapshot(spPrev && spPrev.mutex, spMutex);
  if (!spMutex || !spMutex.phantomHolderTicks) {
    spState.mutex.consecutivePhantomTicks = 0;
  }
}
function buildRuleFactoryStateSnapshot(deps, rule, effectiveConfig, spRepo, spCfg, processedKeys) {
  var spFull = spRepo.owner + '/' + spRepo.repo;
  var inp = readSnapshotInputs(deps, spRepo, spFull, spCfg);
  var spPrev = factoryStateModule.fetchPreviousState(spFull, spCfg, deps.exec);
  var spMutex = deps.takeMutexTickSnapshot();
  deps.setSpMutex(spMutex);
  var machineAuthor = machineAuthorModule.resolveMachineAuthor(deps.jobParams, effectiveConfig);
  var extraData = fetchMergedAndOpenIssuesSafe(deps, spRepo, spFull);
  var latch = deps.getTickReworkLatch();
  var spState = factoryStateModule.buildFactoryState({
    repoInfo: spRepo,
    prs: inp.prList,
    mergedPrs: extraData.merged,
    issues: extraData.issues,
    machineAuthor: machineAuthor,
    tokens: inp.tokens,
    pricing: inp.pricing,
    runs: inp.runList,
    checkNames: deps.validationCheckNames(),
    ciWorkflow: rule.ciWorkflow || deps.jobParams.ciWorkflow || 'quality.yml',
    prev: spPrev,
    dryRun: deps.dry,
    processed: processedKeys,
    reworkInFlight: latch && latch.map || {},
    zombiesSwept: deps.getTickZombiesSwept(),
    legWorkflow: reworkLatchModule.DEFAULT_LEG_WORKFLOW,
    mutex: spMutex,
    deadZone: guestValidationPathModule.mergeDeadZoneCary(spPrev && spPrev.deadZone, ensureDeadZoneScan(deps, machineAuthor))
  });
  applyMergedMutexSnapshot(spState, spPrev, spMutex);
  return {
    spState: spState,
    tokens: inp.tokens,
    tokensSrc: inp.src,
    pricing: inp.pricing
  };
}
function maybePublishFactoryState(deps, rule, effectiveConfig, effectiveRepoInfo, processedKeys) {
  if (deps.dry) {
    return;
  }
  var target = resolveStatePublishTarget(deps.jobParams, effectiveRepoInfo);
  if (!target) {
    return;
  }
  try {
    var built = buildRuleFactoryStateSnapshot(deps, rule, effectiveConfig, target.repo, target.cfg, processedKeys);
    var spUrl = factoryStateModule.publishFactoryState(built.spState, target.cfg, deps.exec);
    logAndUpdateHistory(deps, built.spState, target.cfg, spUrl, built.tokens, built.tokensSrc, built.pricing);
  } catch (ePub) {
    deps.warn('  ⚠️  factory state publish failed: ' + (ePub.message || ePub));
  }
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      readDualLayoutSource: readDualLayoutSource,
      readLocalActionSource: readLocalActionSource,
      buildLocalModuleBlock: buildLocalModuleBlock,
      runLocalAction: runLocalAction,
      queryRuleTicketsOrThrow: queryRuleTicketsOrThrow,
      validateRuleShape: validateRuleShape,
      processRuleLocally: processRuleLocally,
      ensureDeadZoneScan: ensureDeadZoneScan,
      maybePublishFactoryState: maybePublishFactoryState
    };
}
