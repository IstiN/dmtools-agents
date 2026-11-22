/**
 * SM tick setup, rule-override resolution, and layer boundary runner —
 * js/sm/tickOrchestrator.js (#1459).
 */
'use strict';

var buildEncodedConfigModule = require('../common/buildEncodedConfig.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var smProviderModule = require('../common/smProvider.js');
var probeCacheModule = require('../common/probeCache.js');
var smRuleLayersModule = require('../common/smRuleLayers.js');
function normalizePositiveInt(value) {
  if (typeof value !== 'number' || !isFinite(value)) {
    return null;
  }
  var normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}
function resolveWorkflowCap(deps, jsonCap, projectCfg) {
  var cfgVal = projectCfg ? projectCfg.smMaxWorkflows : undefined;
  var n = normalizePositiveInt(cfgVal);
  if (n) {
    deps.log('  Workflow cap override (config.smMaxWorkflows): ' + n);
    return n;
  }
  return normalizePositiveInt(jsonCap);
}
function parseKnobCandidate(deps, rawVal, label) {
  var val = typeof rawVal === 'string' ? parseInt(rawVal, 10) : rawVal;
  var n = normalizePositiveInt(val);
  if (n) {
    return n;
  }
  if (typeof val !== 'undefined' && val !== null) {
    deps.warn('  ⚠️  ' + label + ' ignored — not a positive number: ' + JSON.stringify(val));
  }
  return null;
}
function pickPositiveKnob(deps, jsonVal, cfgVal, name) {
  return parseKnobCandidate(deps, cfgVal, 'config.' + name) || parseKnobCandidate(deps, jsonVal, 'jobParams.' + name);
}
function resolveValidationConcurrency(deps, jobParams, projectCfg) {
  var jp = jobParams || {};
  var pc = projectCfg || {};
  var rawMax = pickPositiveKnob(deps, jp.validationConcurrency, pc.smValidationConcurrency, 'smValidationConcurrency') || 1;
  var max = rawMax;
  if (max > 5) {
    deps.warn('  ⚠️  validationConcurrency ' + max + ' clamped to 5 (runner budget)');
    max = 5;
  }
  var watermark = pickPositiveKnob(deps, jp.validationConcurrencyQueueWatermark, pc.smValidationConcurrencyQueueWatermark, 'smValidationConcurrencyQueueWatermark') || 3;
  var minutes = pickPositiveKnob(deps, jp.validationMinutesEstimate, pc.smValidationMinutesEstimate, 'smValidationMinutesEstimate') || 35;
  return {
    max: max,
    watermark: watermark,
    minutesEstimate: minutes
  };
}
function prHasLabel(p, labelName) {
  return (p.labels || []).some(function (l) {
    return (l && l.name || l) === labelName;
  });
}
function approvedPrs(list) {
  return list.filter(function (p) {
    return p && !p.draft && !prHasLabel(p, 'blocked') && prHasLabel(p, 'pr_approved');
  });
}
function openPrListFromProvider(deps, repoInfo) {
  var provider = smProviderModule.createSmProvider({
    scm: {
      provider: deps.smForge || 'github'
    },
    repository: repoInfo
  });
  var raw = provider && typeof provider.listOpenPrs === 'function' ? provider.listOpenPrs() : [];
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { raw = []; }
  }
  return Array.isArray(raw) ? raw : [];
}
function approvedQueueDepth(deps, repoInfo) {
  try {
    return approvedPrs(openPrListFromProvider(deps, repoInfo)).length;
  } catch (eDepth) {
    deps.warn('  ⚠️  approved-queue depth probe failed: ' + (eDepth.message || eDepth));
    return 0;
  }
}
function effectiveValidationConcurrency(cfg, approvedDepth) {
  if (!cfg || cfg.max <= 1) {
    return 1;
  }
  return approvedDepth >= cfg.watermark ? cfg.max : 1;
}
function logValidationCostIfActive(deps, cfg, slotsInUse, mutexMax, depth, burn, capMin) {
  if (mutexMax <= 1 && slotsInUse <= 0) {
    return;
  }
  var wm = cfg && cfg.watermark || 3;
  deps.log('📊 gh-837 validation cost — merge-window slots ' + slotsInUse + '/' + mutexMax + ' in use, approved queue ' + depth + ' (watermark ' + wm + ') — ≈ ' + burn + ' validation-min per tick, hard-capped at ' + capMin + ' by the concurrency knob');
}
function reportValidationCost(deps, repoInfo, cfg, mutexMax) {
  try {
    var approved = approvedPrs(openPrListFromProvider(deps, repoInfo));
    var slotsInUse = approved.filter(function (p) {
      return prHasLabel(p, 'ai_validating');
    }).length;
    var depth = approved.length;
    var minEst = cfg && cfg.minutesEstimate || 35;
    var burn = slotsInUse * minEst;
    var capMin = mutexMax * minEst;
    logValidationCostIfActive(deps, cfg, slotsInUse, mutexMax, depth, burn, capMin);
    return {
      slotsInUse: slotsInUse,
      mutexMax: mutexMax,
      approvedQueueDepth: depth,
      validationMinutesPerTick: burn,
      capMinutesPerTick: capMin
    };
  } catch (eCost) {
    deps.warn('  ⚠️  validation cost report failed: ' + (eCost.message || eCost));
    return null;
  }
}
function resolvePriorityLabels(deps, projectCfg) {
  var out = {
    blocker: 'priority_blocker',
    medium: 'priority_medium',
    low: 'priority_low'
  };
  var cfg = projectCfg && projectCfg.smPriorityLabels;
  if (!cfg || typeof cfg !== 'object') {
    return out;
  }
  Object.keys(out).forEach(function (tier) {
    var v = cfg[tier];
    if (typeof v === 'string' && v.trim() !== '') {
      out[tier] = v;
    } else {
      if (typeof v !== 'undefined') {
        deps.warn('  ⚠️  config.smPriorityLabels.' + tier + ' ignored — not a non-empty string: ' + JSON.stringify(v));
      }
    }
  });
  return out;
}
function applyRuleOverrides(deps, rules, overrides) {
  if (!overrides || typeof overrides !== 'object') {
    return rules;
  }
  return rules.map(function (rule) {
    var patch = overrides[rule.id] || overrides[rule.configFile];
    if (!patch) {
      return rule;
    }
    deps.log('SM Agent: Patched rule "' + (rule.id || rule.description || rule.configFile) + '" with override:', JSON.stringify(patch));
    return Object.assign({}, rule, patch);
  });
}
function dispatchRaceGraceMs(jobParams) {
  var n = (jobParams || {}).dispatchRaceGraceMs;
  n = typeof n === 'string' ? parseInt(n, 10) : n;
  if (typeof n !== 'number' || isNaN(n) || n < 0) {
    return 60 * 1000;
  }
  return Math.floor(n);
}
function dropOpenPrsCache(repoInfo) {
  try {
    if (smProviderModule && typeof smProviderModule.ioCacheDrop === 'function') {
      smProviderModule.ioCacheDrop(repoInfo.owner, repoInfo.repo, 'openPrs', null);
    }
  } catch (eDrop) {}
}
function applyForceLocalTeammateOverride(deps, p, rules) {
  if (!p.forceLocalTeammate || !rules) {
    return rules;
  }
  var forcedCount = 0;
  var out = rules.map(function (rule) {
    if (rule.localExecution || rule.localTeammate !== undefined) {
      return rule;
    }
    forcedCount++;
    return Object.assign({}, rule, {
      localTeammate: true
    });
  });
  deps.log('SM Agent: forceLocalTeammate override active — ' + forcedCount + ' rule(s) switched from dispatch to local execution');
  return out;
}
function detectAgentLocalExecution(deps, targetAgent) {
  try {
    var agentRaw = deps.fileRead(targetAgent);
    if (!agentRaw) {
      return false;
    }
    var parsed = JSON.parse(agentRaw);
    return !!(parsed && parsed.params && parsed.params.localExecution === true);
  } catch (e) {
    deps.warn('  Could not read agent config to detect localExecution:', e);
    return false;
  }
}
function buildTargetedRule(deps, rules, targetTicket, targetAgent, projectConfig) {
  var normalizedTarget = String(targetAgent || '').replace(/^agents\//, '');
  var matchedRule = (rules || []).find(function (r) {
    return String(r.configFile || '').replace(/^agents\//, '') === normalizedTarget;
  }) || null;
  var inputJql = buildEncodedConfigModule.resolveTicketInputJql(targetTicket, projectConfig);
  var desc = 'Targeted: ' + targetAgent + ' for ' + targetTicket;
  if (matchedRule) {
    var targetedRule = Object.assign({}, matchedRule, {
      jql: inputJql,
      description: desc
    });
    delete targetedRule.skipIfLabel;
    delete targetedRule.skipIfLabels;
    deps.log('  Found matching rule — inheriting localExecution=' + !!targetedRule.localExecution + ', concurrencyKey=' + (targetedRule.concurrencyKey || targetTicket));
    return targetedRule;
  }
  deps.log('  No matching rule found for ' + targetAgent + ' — using minimal synthetic rule');
  var agentLocalExecution = detectAgentLocalExecution(deps, targetAgent);
  if (agentLocalExecution) {
    deps.log('  Agent config has localExecution:true — will run locally (no checkout pipeline)');
  }
  return {
    description: desc,
    jql: inputJql,
    configFile: targetAgent,
    enabled: true,
    localExecution: agentLocalExecution
  };
}
function resolveTickRulesAndBudget(deps, p, projectConfig, initialRules, initialBudget) {
  var rules = initialRules;
  var workflowBudget = initialBudget;
  if (projectConfig.smRules && Array.isArray(projectConfig.smRules) && projectConfig.smRules.length > 0) {
    deps.log('SM Agent: Using smRules override from project config (' + projectConfig.smRules.length + ' rules)');
    rules = projectConfig.smRules;
  }
  rules = deps.applyRuleOverrides(rules, projectConfig.smRuleOverrides);
  rules = applyForceLocalTeammateOverride(deps, p, rules);
  if (p.targetTicket && p.targetAgent) {
    deps.log('SM Agent: Targeted mode — ticket: ' + p.targetTicket + ', agent: ' + p.targetAgent);
    rules = [buildTargetedRule(deps, rules, p.targetTicket, p.targetAgent, projectConfig)];
    workflowBudget = null;
  }
  return {
    rules: rules,
    workflowBudget: workflowBudget
  };
}
function resolveGlobalOwnerRepo(p, projectConfig) {
  var repoCfg = projectConfig.repository || {};
  var owner = repoCfg.owner || p.owner;
  var repo = repoCfg.repo || p.repo;
  if (typeof repo === 'string' && repo.indexOf('/') !== -1) {
    var seg = repo.split('/');
    owner = seg[0];
    repo = seg[1];
  }
  return {
    owner: owner,
    repo: repo
  };
}
function patchRuleForParallelValidation(rule, validationMutexMax) {
  var q = rule && rule.query;
  if (!q || q.mutex !== 'ai_validating' || !Array.isArray(q.mutexAmong) || q.mutexAmong.indexOf('pr_approved') === -1) {
    return rule;
  }
  var patched = Object.assign({}, rule, {
    query: Object.assign({}, q, {
      mutexMax: validationMutexMax
    })
  });
  if (!q.mutexExcludeSelf && typeof rule.limit === 'number') {
    patched.limit = Math.max(rule.limit, validationMutexMax);
  }
  return patched;
}
function applyParallelValidationPatch(deps, rules, validationConcurrencyCfg, validationMutexMax) {
  if (validationConcurrencyCfg.max <= 1) {
    return rules;
  }
  if (validationMutexMax > 1) {
    var out = rules.map(function (rule) {
      return patchRuleForParallelValidation(rule, validationMutexMax);
    });
    deps.log('  🚈 gh-837 parallel validations: concurrency ' + validationMutexMax + ' (knob ' + validationConcurrencyCfg.max + ', approved queue at/above watermark ' + validationConcurrencyCfg.watermark + ') — merge-window mutex relaxed, arm limit ' + validationMutexMax);
    return out;
  }
  deps.log('  🚈 gh-837 parallel validations: knob ' + validationConcurrencyCfg.max + ' but approved queue below watermark ' + validationConcurrencyCfg.watermark + ' — serial mode this tick');
  return rules;
}
function applyMergeFirstCapacityHold(deps, p, rules, validationMutexMax, workflowBudget) {
  var layeredTick = rules && rules.some(function (r) {
    return smRuleLayersModule.layerIndex(r) >= 0;
  });
  var reserved = layeredTick ? smRuleLayersModule.reservationFor(smRuleLayersModule.mergeReservedSlots(p), validationMutexMax) : 0;
  deps.setTickMergeReservedSlots(reserved);
  if (reserved > 0) {
    if (workflowBudget) {
      workflowBudget.remaining = Math.max(0, workflowBudget.remaining - reserved);
    }
    deps.log('  🎯 merge-first capacity: ' + reserved + ' workflow slot(s) reserved for the approved merge path' + (validationMutexMax > 1 ? ' (gh-837 parallel mode — reservation = validationMutexMax)' : ' (jobParams.mergeReservedSlots)'));
  }
}
function isAfterL3Boundary(nextLayerIdx) {
  return nextLayerIdx === null || nextLayerIdx > smRuleLayersModule.L3_IDX;
}
function isRefundableSlotSpent(spent) {
  return !spent || spent === 'merged';
}
function maybeReleaseMergeReservation(deps, nextLayerIdx, workflowBudget) {
  if (deps.getTickMergeReservationReleased() || !isAfterL3Boundary(nextLayerIdx)) {
    return;
  }
  deps.setTickMergeReservationReleased(true);
  var reserved = deps.getTickMergeReservedSlots();
  var spent = deps.getTickMergeSlotSpent();
  if (reserved > 0 && workflowBudget && isRefundableSlotSpent(spent)) {
    workflowBudget.remaining = Math.min(workflowBudget.initial, workflowBudget.remaining + reserved);
    deps.log(spent === 'merged' ? '  🔓 gh-1114: merge resolved — the reservation is released to agent legs' : '  🔓 gh-1114: no merge-candidate validation this tick — the reserved slot is released to agent legs');
  }
}
function handleLayerTransitionsAfterRule(deps, rules, i, workflowBudget) {
  if (deps.getTickMergeSlotSpent() === 'dispatched' && !deps.getTickMergeSlotAccounted()) {
    deps.setTickMergeSlotAccounted(true);
    if (workflowBudget) {
      deps.log('  🎯 merge-path validation dispatched — reserved slot spent, ' + workflowBudget.remaining + ' dispatch slot(s) left');
    }
  }
  var nextLayerIdx = i + 1 < rules.length ? smRuleLayersModule.layerIndex(rules[i + 1]) : null;
  if (!deps.getTickL1CacheDropped() && nextLayerIdx !== null && nextLayerIdx > smRuleLayersModule.L1_IDX) {
    deps.setTickL1CacheDropped(true);
    deps.dropAllSeenReposCache();
    deps.log('  🔄 gh-1114 L1→L2: openPrs ioCache dropped — verdict queries read current heads');
  }
  maybeReleaseMergeReservation(deps, nextLayerIdx, workflowBudget);
}
function logCompletionBanner(deps, allProcessedKeys, allSkippedKeys, stampsFailed, dzScan) {
  if (stampsFailed > 0) {
    deps.warn('🚨 stamps_failed: ' + stampsFailed + ' — validation check-runs did not land on their PR heads; validation cannot conclude (gh-1118)');
  }
  var dzCount = dzScan.blocked.length;
  if (dzCount > 0) {
    deps.warn('🚨 guest_prs_blocked_no_validation_path: ' + dzCount + ' — ' + dzScan.blocked.map(function (b) {
      return 'pr-' + b.prNumber;
    }).join(', ') + ' (guest PRs approved/armed + CLEAN with no concluded checks — the dead zone gh-113 closes)');
  }
  var procText = allProcessedKeys.length ? '[' + allProcessedKeys.join(', ') + ']' : '';
  var skipText = allSkippedKeys.length ? ' [' + allSkippedKeys.join(', ') + ']' : '';
  var _ioc = (probeCacheModule && typeof probeCacheModule.ioCacheStats === 'function') ? probeCacheModule.ioCacheStats() : null;
  deps.log('\n══ SM Agent complete — processed: ' + allProcessedKeys.length + ' ' + procText + ', skipped: ' + allSkippedKeys.length + skipText + ', stamps_failed: ' + stampsFailed + ', guest_prs_blocked_no_validation_path: ' + dzCount + (_ioc ? ' | iocache[hit=' + _ioc.hit + ' miss=' + _ioc.miss + ' expired=' + _ioc.expired + ' puts=' + _ioc.puts + ' drops=' + _ioc.drops + ' entries=' + _ioc.entries + ' eval=' + _ioc.eval + ']' : '') + ' ══');
  return dzCount;
}
function runTickSetupAndRules(deps, p, projectConfig, rules, workflowBudget, globalRepoInfo) {
  deps.recordRepoSeen(globalRepoInfo);
  deps.log('SM Agent — ' + globalRepoInfo.owner + '/' + globalRepoInfo.repo + ' (' + rules.length + ' rules)');
  if (projectConfig.jira && projectConfig.jira.project && deps.smTracker().provider() === 'jira') {
    deps.log('  Jira project: ' + projectConfig.jira.project);
  }
  if (workflowBudget) {
    deps.log('  Workflow cap per run: ' + workflowBudget.initial);
  }
  var validationConcurrencyCfg = deps.resolveValidationConcurrency(p, projectConfig);
  var validationMutexMax = deps.effectiveValidationConcurrency(validationConcurrencyCfg, deps.approvedQueueDepth(globalRepoInfo));
  rules = applyParallelValidationPatch(deps, rules, validationConcurrencyCfg, validationMutexMax);
  applyMergeFirstCapacityHold(deps, p, rules, validationMutexMax, workflowBudget);
  var allProcessedKeys = [];
  var allSkippedKeys = [];
  rules.forEach(function (rule, i) {
    var result = deps.processRule(rule, globalRepoInfo, i, workflowBudget);
    allProcessedKeys = allProcessedKeys.concat(result.processedKeys);
    allSkippedKeys = allSkippedKeys.concat(result.skippedKeys);
    handleLayerTransitionsAfterRule(deps, rules, i, workflowBudget);
  });
  if (p.nakedPrSweep !== false && deps.getSmForge() === 'github') {
    deps.runNakedPrSweep(globalRepoInfo);
  }
  var validationCost = deps.reportValidationCost(globalRepoInfo, validationConcurrencyCfg, validationMutexMax);
  var stampsFailed = deps.getTickStampsFailed();
  var dzScan = deps.ensureDeadZoneScan(machineAuthorModule.resolveMachineAuthor(p, projectConfig));
  deps.publishFactoryStateOnce(rules[rules.length - 1], projectConfig, globalRepoInfo, allProcessedKeys);
  var dzCount = logCompletionBanner(deps, allProcessedKeys, allSkippedKeys, stampsFailed, dzScan);
  return {
    success: true,
    processed: allProcessedKeys.length,
    skipped: allSkippedKeys.length,
    processedKeys: allProcessedKeys,
    skippedKeys: allSkippedKeys,
    validationCost: validationCost,
    stampsFailed: stampsFailed,
    guestPrsBlocked: dzCount
  };
}
function extractJobParams(params) {
  var src = params || {};
  return src.jobParams || src;
}
function runAction(deps, params) {
  var p = extractJobParams(params);
  var init = deps.initTickState(p);
  var resolved = resolveTickRulesAndBudget(deps, p, init.projectConfig, p.rules, init.workflowBudget);
  if (!resolved.rules || resolved.rules.length === 0) {
    deps.error('❌ No rules defined in jobParams.rules or project config');
    return {
      success: false,
      error: 'No rules defined'
    };
  }
  var globalRepoInfo = resolveGlobalOwnerRepo(p, init.projectConfig);
  if (!globalRepoInfo.owner || !globalRepoInfo.repo) {
    deps.error('❌ Repository owner and repo are required (set in .dmtools/config.js or jobParams)');
    return {
      success: false,
      error: 'Missing owner or repo'
    };
  }
  return runTickSetupAndRules(deps, p, init.projectConfig, resolved.rules, resolved.workflowBudget, globalRepoInfo);
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizePositiveInt: normalizePositiveInt,
      resolveWorkflowCap: resolveWorkflowCap,
      resolveValidationConcurrency: resolveValidationConcurrency,
      approvedPrs: approvedPrs,
      approvedQueueDepth: approvedQueueDepth,
      effectiveValidationConcurrency: effectiveValidationConcurrency,
      reportValidationCost: reportValidationCost,
      resolvePriorityLabels: resolvePriorityLabels,
      applyRuleOverrides: applyRuleOverrides,
      dispatchRaceGraceMs: dispatchRaceGraceMs,
      dropOpenPrsCache: dropOpenPrsCache,
      runAction: runAction
    };
}
