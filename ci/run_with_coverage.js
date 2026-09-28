// Coverage runner for the crap4js quality gate (dmtools-agents).
//
// Executes the node test harness (js/unit-tests/node_testRunner.js) against
// the nyc-INSTRUMENTED copy of the repo and dumps global.__coverage__ in
// Istanbul coverage-final.json format for crap4js.
//
// Why the dance: the harness loads every module through its own
// loadModule()/eval() (mock injection), which bypasses nyc's require hook —
// a plain `nyc node node_testRunner.js` instruments nothing. Pre-instrumenting
// the tree with `nyc instrument` bakes the Istanbul counters into the sources
// themselves, so eval'd code reports coverage through the global.
//
// Usage:
//   node ci/run_with_coverage.js <runner.js> <coverage-out.json> [testFiles...]
//
// Exit code = the harness's exit code (0 = all tests passed). Coverage is
// written regardless of test failures — the canonical suite green-gate is
// the pack-release test job (`dmtools run js/unit-tests/run_all.json`);
// this node harness is a coverage vehicle, and its known mock gaps
// (see the quality workflow) must not block coverage collection.

const fs = require('fs');
const path = require('path');

const runner = process.argv[2];
const outFile = process.argv[3];
const testFiles = process.argv.slice(4);

const origExit = process.exit;
let exitCode = 0;
process.exit = (c) => { exitCode = c || 0; throw { __coverage_exit__: true }; };
process.argv = [process.argv[0], runner].concat(testFiles);

try {
  require(runner);
} catch (e) {
  if (!e || !e.__coverage_exit__) {
    console.error(e);
    origExit(2);
  }
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(global.__coverage__ || {}));
console.log('coverage written: ' + outFile + ' (' +
  Object.keys(global.__coverage__ || {}).length + ' files)');
origExit(exitCode);
