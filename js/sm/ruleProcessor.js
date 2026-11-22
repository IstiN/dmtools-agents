/**
 * Rule processor and SM tick orchestration — js/sm/ruleProcessor.js (#1459).
 *
 * Orchestrates per-rule evaluation (`processRule`) and tick-level setup /
 * layer boundaries (`action`).
 */
'use strict';

var branchRefreshModule = require('./branchRefresh.js');
var buildEncodedConfigModule = require('../common/buildEncodedConfig.js');
var checkRunStampModule = require('../common/checkRunStamp.js');
var configLoader = require('../configLoader.js');
var guestTransplantModule = require('../common/guestTransplant.js');
var labelListModule = require('../common/labelList.js');
var localAndStateRunnerModule = require('./localAndStateRunner.js');
var machineAuthorModule = require('../common/machineAuthor.js');
var prLifecycleActionsModule = require('./prLifecycleActions.js');
var prUpdateAndValidateActionsModule = require('./prUpdateAndValidateActions.js');
var prVerdictAndSweepActionsModule = require('./prVerdictAndSweepActions.js');
var quotaBreakerModule = require('../common/quotaCircuitBreaker.js');
var smRuleLayersModule = require('../common/smRuleLayers.js');
var validationLivenessModule = require('../common/validationLiveness.js');
function resolveEffectiveRepoInfo(deps, effectiveConfig, globalRepoInfo) {
  var repo = effectiveConfig.repository || {};
  var effectiveRepoInfo = {
    owner: repo.owner || globalRepoInfo.owner,
    repo: repo.repo || globalRepoInfo.repo
  };
  deps.recordRepoSeen(effectiveRepoInfo);
  return effectiveRepoInfo;
}
function maybeSyncRuleValidationChecks(deps, rule, effectiveRepoInfo) {
  if (rule.source !== 'github' || (rule.query || {}).type !== 'pr') {
    return;
  }
  try {
    deps.syncValidationChecks(effectiveRepoInfo, function (sha, st, co, url) {
      deps.stampValidationChecks(effectiveRepoInfo, sha, st, co, url);
    });
  } catch (e) {
    deps.warn('  ⚠️  validation-check sync failed: ' + (e.message || e));
  }
}
function resolveGuestTransplantSetup(deps, rule, effectiveConfig, effectiveRepoInfo) {
  if (rule.guestTransplant !== true) {
    return {
      inert: false,
      guestCfg: null
    };
  }
  var guestCfg = guestTransplantModule.resolveGuestTransplantConfig(deps.jobParams, effectiveConfig);
  if (!guestCfg) {
    deps.log('  ⏸️  guest-transplant inert — smGuestTransplant not configured (REG-guest113)');
    return {
      inert: true,
      guestCfg: null
    };
  }
  if (rule.query) {
    rule.query.labels = [guestCfg.label];
  }
  try {
    deps.sweepClosedGuestBranches(effectiveRepoInfo, guestCfg, deps.verdictMachineLogins(effectiveConfig));
  } catch (eGc) {
    deps.warn('  ⚠️  guest-transplant GC sweep failed: ' + (eGc.message || eGc));
  }
  return {
    inert: false,
    guestCfg: guestCfg
  };
}
function computeEffectiveRuleLimit(deps, rule, workflowBudget, budgetCapped) {
  var ruleLimit = typeof rule.limit === 'number' && rule.limit > 0 ? Math.floor(rule.limit) : null;
  var effectiveLimit = ruleLimit;
  if (workflowBudget && budgetCapped) {
    var ruleRemaining = deps.ruleBudgetRemaining(rule, workflowBudget);
    effectiveLimit = effectiveLimit === null ? ruleRemaining : Math.min(effectiveLimit, ruleRemaining);
  }
  return effectiveLimit;
}
function detectRuleSelfManagesLabel(deps, rule) {
  var selfManages = !!(rule.localTeammate && deps.ruleTargetSelfManagesLabel(rule));
  if (selfManages) {
    deps.log('  ℹ️  Target job self-manages "' + (rule.addLabel || rule.addLabels) + '" — smAgent will not re-add it after a local run');
  }
  return selfManages;
}
function queryAndPrepareRuleTickets(deps, rule, effectiveConfig, effectiveRepoInfo, interpolatedJql, workflowBudget, budgetCapped) {
  var gtSetup = resolveGuestTransplantSetup(deps, rule, effectiveConfig, effectiveRepoInfo);
  if (gtSetup.inert) {
    return {
      earlyExit: true
    };
  }
  var tickets = localAndStateRunnerModule.queryRuleTicketsOrThrow(deps, rule, effectiveConfig, effectiveRepoInfo, interpolatedJql);
  var ruleSelfManagesLabel = detectRuleSelfManagesLabel(deps, rule);
  var effectiveLimit = computeEffectiveRuleLimit(deps, rule, workflowBudget, budgetCapped);
  if (effectiveLimit !== null && tickets.length > effectiveLimit) {
    deps.log('  Will trigger up to ' + effectiveLimit + ' ticket(s) after skipping active/stale labels');
  }
  if (!tickets.length) {
    deps.log('  No tickets found.');
    return {
      earlyExit: true,
      publishEmpty: true
    };
  }
  deps.log('  Found ' + tickets.length + ' ticket(s)');
  return {
    earlyExit: false,
    guestCfg: gtSetup.guestCfg,
    tickets: tickets,
    ruleSelfManagesLabel: ruleSelfManagesLabel,
    effectiveLimit: effectiveLimit
  };
}
function handleTicketSkipLabel(deps, rule, effectiveConfig, effectiveRepoInfo, ticket, key, skippedKeys) {
  var skipLabel = deps.firstMatchingLabel(ticket, labelListModule.normalizeLabels(rule.skipIfLabel, rule.skipIfLabels));
  if (!skipLabel) {
    return false;
  }
  if (!rule.localTeammate && deps.shouldRecoverStaleTriggerLabel(rule, skipLabel)) {
    var workflowFile = rule.workflowFile || 'ai-teammate.yml';
    var resolvedCf = buildEncodedConfigModule.resolveConfigFile(rule, effectiveConfig);
    var scm = deps.createTargetScm(effectiveConfig, effectiveRepoInfo);
    var activeKey = rule.concurrencyKey || key;
    if (deps.hasActiveTargetWorkflowRun(scm, workflowFile, resolvedCf, activeKey)) {
      skippedKeys.push(key);
      return true;
    }
    deps.log('  ♻️  ' + key + ' has ' + skipLabel + ' but no active workflow — recovering stale trigger label');
    deps.removeRuleLabel(key, skipLabel, rule, effectiveRepoInfo);
    return false;
  }
  deps.log('  ⏭️  ' + key + ' skipped (label: ' + skipLabel + ')');
  skippedKeys.push(key);
  return true;
}
function checkTicketEntrySkips(deps, rule, effectiveConfig, effectiveRepoInfo, ticket, key, skippedKeys) {
  if (quotaBreakerModule.shouldSkipForQuotaPark(ticket, rule, deps.jobParams)) {
    deps.log('  🅿️  ' + key + ' skipped (provider-quota park)');
    skippedKeys.push(key);
    return true;
  }
  if (smRuleLayersModule.isVerdictAction(rule) && ticket.prNumber && deps.tickMovedPrs[ticket.prNumber]) {
    deps.log('  ⏭ pr-' + ticket.prNumber + ' head moved this tick — verdict deferred');
    skippedKeys.push(key);
    return true;
  }
  return handleTicketSkipLabel(deps, rule, effectiveConfig, effectiveRepoInfo, ticket, key, skippedKeys);
}
function dispatchCiWorkflowForTicket(deps, rule, effectiveRepoInfo, branchName) {
  var ciWorkflow = rule.ciWorkflow || (deps.jobParams || {}).ciWorkflow || 'quality.yml';
  if (deps.dry) {
    deps.log('  🧪 [dry] validation dispatch skipped (gh workflow run ' + ciWorkflow + ' @ ' + branchName + ')');
    return;
  }
  if (smRuleLayersModule.isMergePathRule(rule)) {
    deps.setTickMergeSlotSpent('dispatched');
  }
  deps.exec({
    command: 'gh workflow run ' + ciWorkflow + ' --repo ' + effectiveRepoInfo.owner + '/' + effectiveRepoInfo.repo + ' --ref ' + checkRunStampModule.shellQuote(branchName)
  });
}
function buildTicketBranchHelpers(deps, rule, effectiveRepoInfo, ticket, key) {
  var passState = {
    unparkedThisPass: false,
    parkedRedHeadThisPass: false
  };
  var brDeps = deps.buildBranchRefreshDeps(effectiveRepoInfo, ticket, key, passState);
  return {
    setUpdateBranchPassFlags: function (unparked, parkedRed) {
      passState.unparkedThisPass = !!unparked;
      passState.parkedRedHeadThisPass = !!parkedRed;
    },
    forkSilentUpdateGate: function () {
      return branchRefreshModule.forkSilentUpdateGate(brDeps, effectiveRepoInfo, ticket, key);
    },
    silentUpdateBranchTracked: function (branchName, forceFresh) {
      return branchRefreshModule.silentUpdateBranchTracked(brDeps, effectiveRepoInfo, ticket, key, branchName, forceFresh);
    },
    forkSilentUpdateBranchTracked: function (branchName, forkFull) {
      return branchRefreshModule.forkSilentUpdateBranchTracked(brDeps, effectiveRepoInfo, ticket, key, branchName, forkFull);
    },
    freshShaReset: function (branchName, oldHead) {
      return branchRefreshModule.freshShaReset(brDeps, effectiveRepoInfo, ticket, key, branchName, oldHead);
    },
    dispatchCiWorkflow: function (branchName) {
      dispatchCiWorkflowForTicket(deps, rule, effectiveRepoInfo, branchName);
    }
  };
}
var LOCAL_ACTION_DISPATCH_TABLE = {
  close_issue: function (c) {
    prLifecycleActionsModule.handleCloseIssueAction(c.actionDeps, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  advance_plan: function (c) {
    prLifecycleActionsModule.handleAdvancePlanAction(c.actionDeps, c.rule, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys, c.skippedKeys);
  },
  mark_developed: function (c) {
    prLifecycleActionsModule.handleMarkDevelopedAction(c.actionDeps, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  arm_review: function (c) {
    prLifecycleActionsModule.handleArmReviewAction(c.actionDeps, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  reconcile_verdicts: function (c) {
    prLifecycleActionsModule.handleReconcileVerdictsAction(c.actionDeps, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  arm_rework: function (c) {
    prLifecycleActionsModule.handleArmReworkAction(c.actionDeps, c.rule, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  restore_rework_arm: function (c) {
    prLifecycleActionsModule.handleRestoreReworkArmAction(c.actionDeps, c.rule, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  merge_pr: function (c) {
    prLifecycleActionsModule.handleMergePrAction(c.actionDeps, c.rule, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  complete_validation: function (c) {
    prLifecycleActionsModule.handleCompleteValidationAction(c.actionDeps, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  transplant_guest_pr: function (c) {
    prLifecycleActionsModule.handleTransplantGuestPrAction(c.actionDeps, c.guestCfg, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  update_branch: function (c) {
    prUpdateAndValidateActionsModule.handleUpdateBranchAction(c.actionDeps, c.rule, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  validate_pr: function (c) {
    prUpdateAndValidateActionsModule.handleValidatePrAction(c.actionDeps, c.rule, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys, c.skippedKeys);
  },
  unarm_validation: function (c) {
    prVerdictAndSweepActionsModule.handleUnarmValidationAction(c.actionDeps, c.rule, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  rerun_cancelled_checks: function (c) {
    prVerdictAndSweepActionsModule.handleRerunCancelledChecksAction(c.actionDeps, c.rule, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  },
  conflict_rework: function (c) {
    prVerdictAndSweepActionsModule.handleConflictReworkAction(c.actionDeps, c.effectiveConfig, c.effectiveRepoInfo, c.workflowBudget, c.ticket, c.key, c.processedKeys);
  },
  sweep_stale_validation: function (c) {
    if (prVerdictAndSweepActionsModule.handleSweepStaleValidationAction(c.actionDeps, c.rule, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys)) {
      prVerdictAndSweepActionsModule.handleFailValidationAction(c.actionDeps, c.rule, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
    }
  },
  fail_validation: function (c) {
    prVerdictAndSweepActionsModule.handleFailValidationAction(c.actionDeps, c.rule, c.effectiveConfig, c.effectiveRepoInfo, c.ticket, c.key, c.processedKeys);
  }
};
function consumeLabelsAfterTrigger(deps, rule, effectiveRepoInfo, ticket, key, triggered, skipInfo) {
  if (!rule.consumeLabels) {
    return;
  }
  var reason = triggered ? 'dispatch' : skipInfo.crossAnchorActive ? 'cross-anchor' : null;
  if (!reason) {
    return;
  }
  labelListModule.normalizeLabels(null, rule.consumeLabels).forEach(function (label) {
    deps.removeRuleLabel(key, label, rule, effectiveRepoInfo);
    deps.auditReworkConsumption(effectiveRepoInfo, ticket, label, reason);
  });
}
function transitionTicketBeforeTrigger(deps, rule, effectiveConfig, effectiveRepoInfo, workflowBudget, key) {
  if (!rule.targetStatus) {
    return true;
  }
  if (!rule.localTeammate && deps.isWorkflowBudgetExhausted(rule, effectiveConfig, workflowBudget, effectiveRepoInfo)) {
    deps.log('  ⏭️  ' + key + ' skipped before transition (global workflow cap reached: ' + workflowBudget.initial + ')');
    return false;
  }
  deps.moveStatus(key, rule.targetStatus);
  return true;
}
function handleStandardWorkflowTrigger(deps, rule, effectiveConfig, effectiveRepoInfo, workflowBudget, ruleSelfManagesLabel, ticket, key, processedKeys) {
  if (!transitionTicketBeforeTrigger(deps, rule, effectiveConfig, effectiveRepoInfo, workflowBudget, key)) {
    return false;
  }
  var skipInfo = {};
  var triggered = rule.localTeammate ? deps.runTeammateLocally(key, rule, effectiveConfig) : deps.triggerWorkflow(effectiveRepoInfo, key, rule, effectiveConfig, workflowBudget, ticket, skipInfo);
  if (triggered && !ruleSelfManagesLabel) {
    deps.addRuleLabels(key, rule, effectiveRepoInfo);
  }
  consumeLabelsAfterTrigger(deps, rule, effectiveRepoInfo, ticket, key, triggered, skipInfo);
  if (triggered) {
    processedKeys.push(key);
    if (!rule.localTeammate && workflowBudget) {
      workflowBudget.remaining -= 1;
    }
  }
  return true;
}
function canContinueTicketLoop(deps, rule, prep, workflowBudget, processedCount) {
  if (!rule.localTeammate && !rule.localAction && workflowBudget && deps.ruleBudgetRemaining(rule, workflowBudget) <= 0) {
    return false;
  }
  return prep.effectiveLimit === null || processedCount < prep.effectiveLimit;
}
function runTicketsLoop(deps, rule, prep, effectiveConfig, effectiveRepoInfo, workflowBudget) {
  var processedKeys = [];
  var skippedKeys = [];
  for (var idx = 0; idx < prep.tickets.length; idx++) {
    if (!canContinueTicketLoop(deps, rule, prep, workflowBudget, processedKeys.length)) {
      break;
    }
    var ticket = prep.tickets[idx];
    var key = ticket.key;
    if (checkTicketEntrySkips(deps, rule, effectiveConfig, effectiveRepoInfo, ticket, key, skippedKeys)) {
      continue;
    }
    var handler = LOCAL_ACTION_DISPATCH_TABLE[rule.localAction];
    if (handler) {
      var ticketHelpers = buildTicketBranchHelpers(deps, rule, effectiveRepoInfo, ticket, key);
      handler({
        actionDeps: deps.buildActionDeps(ticketHelpers),
        rule: rule,
        guestCfg: prep.guestCfg,
        effectiveConfig: effectiveConfig,
        effectiveRepoInfo: effectiveRepoInfo,
        workflowBudget: workflowBudget,
        ticket: ticket,
        key: key,
        processedKeys: processedKeys,
        skippedKeys: skippedKeys
      });
      continue;
    }
    if (!handleStandardWorkflowTrigger(deps, rule, effectiveConfig, effectiveRepoInfo, workflowBudget, prep.ruleSelfManagesLabel, ticket, key, processedKeys)) {
      break;
    }
  }
  return {
    processedKeys: processedKeys,
    skippedKeys: skippedKeys
  };
}
function logBudgetExhaustedSkip(deps, rule, ruleIndex, workflowBudget) {
  var skippedLabel = rule.description || 'Rule #' + (ruleIndex + 1);
  var workflowFile = rule.workflowFile || 'ai-teammate.yml';
  deps.log('\n══ ' + skippedLabel + ' ══');
  var reservedHeld = workflowBudget.remaining > 0 && !smRuleLayersModule.isMergePathRule(rule);
  deps.log('  ⏭️  Global workflow cap reached (' + workflowBudget.initial + ')' + (reservedHeld ? ' — merge reservation held (' + deps.getTickMergeReservedSlots() + ' slot(s) reserved for the approved merge path)' : '') + ' — skipping rule');
  deps.logBlockingWorkflowRuns(workflowBudget, workflowFile);
}
function checkProcessRuleEarlyExit(deps, rule, ruleIndex, workflowBudget, budgetCapped) {
  if (!budgetCapped || !workflowBudget || deps.ruleBudgetRemaining(rule, workflowBudget) > 0) {
    return null;
  }
  logBudgetExhaustedSkip(deps, rule, ruleIndex, workflowBudget);
  return {
    processedKeys: [],
    skippedKeys: []
  };
}
function validateProcessRuleShape(deps, rule) {
  return localAndStateRunnerModule.validateRuleShape(deps, rule, true);
}
function processRule(deps, rule, globalRepoInfo, ruleIndex, workflowBudget, effectiveConfig, interpolatedJql) {
  var budgetCapped = !rule.localTeammate && !rule.localAction;
  var effectiveRepoInfo = resolveEffectiveRepoInfo(deps, effectiveConfig, globalRepoInfo);
  maybeSyncRuleValidationChecks(deps, rule, effectiveRepoInfo);
  var label = rule.description || 'Rule #' + (ruleIndex + 1);
  deps.log('\n══ ' + label + ' ══');
  deps.logRuleQuery(rule, interpolatedJql);
  if (!validateProcessRuleShape(deps, rule)) {
    return {
      processedKeys: [],
      skippedKeys: []
    };
  }
  var prep = queryAndPrepareRuleTickets(deps, rule, effectiveConfig, effectiveRepoInfo, interpolatedJql, workflowBudget, budgetCapped);
  if (prep.earlyExit) {
    return {
      processedKeys: [],
      skippedKeys: []
    };
  }
  return runTicketsLoop(deps, rule, prep, effectiveConfig, effectiveRepoInfo, workflowBudget);
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      checkProcessRuleEarlyExit: checkProcessRuleEarlyExit,
      processRule: processRule
    };
}
