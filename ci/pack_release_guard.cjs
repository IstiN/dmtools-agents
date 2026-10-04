'use strict';
/**
 * Pack-release guard helpers (gh-690, live incident 2026-10-04).
 *
 * Pure classification used by ci/release_packs.mjs (the release builder is
 * an ESM script dmtools' GraalJS loader cannot import — this CommonJS twin
 * keeps the decisions unit-testable, same split as ci/pack_launch_contract.cjs).
 *
 * gh-690 findings this module encodes:
 *   1. versions.json is the version LEDGER — data, not an agent. The old
 *      inline filter in allAgents() swept it in as a phantom "versions"
 *      agent: a bogus "versions" key bumped in the ledger and a phantom
 *      versions-<v>.zip shipped in every release.
 *   2. A ledger churn never marks an agent affected: every merged ledger PR
 *      puts versions.json into the base...HEAD diff, so the affected-set
 *      computation must skip it explicitly.
 */

/** The version ledger at the repo root — data, not an agent. */
var LEDGER_FILE = 'versions.json';

/** True when [file] IS the repo-root version ledger. */
function isLedgerFile(file) {
  return file === LEDGER_FILE;
}

/**
 * True when [file] is a root-level agent entry config: `*.json` at the repo
 * root, minus npm metadata (`package*.json`) and the version ledger.
 */
function isAgentConfigFile(file) {
  if (file.indexOf('/') !== -1) return false; // entry configs live at the root only
  // Suffix check must not use lastIndexOf: for any name shorter than 5 chars
  // lastIndexOf('.json') is -1 AND file.length - 5 is -1, so -1 !== -1 was
  // false and short root entries (.git, .fah, docs, site) passed as agents —
  // phantom .fa/.gi/doc/sit packs and a crashed release build. slice(-n)
  // returns '' for short names and compares cleanly.
  if (file.slice(-'.json'.length) !== '.json') return false;
  if (file.indexOf('package') === 0) return false; // npm metadata
  if (isLedgerFile(file)) return false; // gh-690: the ledger is data, not an agent
  return true;
}

/** Agent name for a root entry config: `sm.json` → `sm`. */
function toAgentName(file) {
  return file.slice(0, file.length - '.json'.length);
}

/**
 * Agent names from a repo-root directory listing, sorted — the single
 * definition of "what is an agent" for discovery AND catalog building.
 */
function agentNamesFromFiles(files) {
  var names = [];
  for (var i = 0; i < files.length; i++) {
    if (isAgentConfigFile(files[i])) names.push(toAgentName(files[i]));
  }
  return names.sort();
}

module.exports = {
  LEDGER_FILE: LEDGER_FILE,
  isLedgerFile: isLedgerFile,
  isAgentConfigFile: isAgentConfigFile,
  toAgentName: toAgentName,
  agentNamesFromFiles: agentNamesFromFiles,
};
