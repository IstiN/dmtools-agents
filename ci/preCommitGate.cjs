/**
 * Pre-commit quality gate helper for IstiN/dmtools-agents.
 *
 * Pure classification and test-resolution functions so the pre-commit hook
 * logic is unit-tested under the standard dmtools unit-test runner.
 * Also acts as a CLI helper (`--extract-ref`, `--resolve-tests`).
 */
'use strict';

var DEFAULT_CRAP4JS_REF = '2d99360df25cec4c7e713801eb2c2da22731a6e';

function isTestJsPath(relPath) {
    if (!relPath || typeof relPath !== 'string') return false;
    return /(?:^|\/)(?:unit-tests|test|integration-tests)\//.test(relPath);
}

function isProdJsPath(relPath) {
    if (!relPath || typeof relPath !== 'string') return false;
    if (!/^js\/.+\.js$/.test(relPath)) return false;
    return !isTestJsPath(relPath);
}

function classifyStagedFiles(paths) {
    var list = Array.isArray(paths) ? paths : [];
    var prodJs = [];
    var testJs = [];
    for (var i = 0; i < list.length; i++) {
        var p = String(list[i] || '').trim().replace(/^\.\//, '');
        if (!p) continue;
        if (isProdJsPath(p)) {
            prodJs.push(p);
        } else if (/^js\/unit-tests\/test_[^/]+\.js$/.test(p)) {
            testJs.push(p);
        }
    }
    return { prodJs: prodJs, testJs: testJs };
}

function extractCrap4jsRef(qualityYmlText) {
    var text = String(qualityYmlText || '');
    var m = /CRAP4JS_REF:\s*['"]?([0-9a-fA-F]{7,40})['"]?/.exec(text);
    return m ? m[1] : DEFAULT_CRAP4JS_REF;
}

function fileStem(relPath) {
    var parts = String(relPath || '').split('/');
    var base = parts[parts.length - 1] || '';
    return base.replace(/\.js$/, '');
}

function fileBasename(relPath) {
    var parts = String(relPath || '').split('/');
    return parts[parts.length - 1] || '';
}

function addTestsFromRunJson(rawJson, seen, out) {
    if (!rawJson) return false;
    try {
        var parsed = JSON.parse(String(rawJson));
        var files = parsed && parsed.params && parsed.params.jobParams && parsed.params.jobParams.testFiles;
        if (!Array.isArray(files) || files.length === 0) return false;
        for (var i = 0; i < files.length; i++) {
            var tf = files[i];
            if (tf && !seen[tf]) {
                seen[tf] = true;
                out.push(tf);
            }
        }
        return true;
    } catch (e) {
        return false;
    }
}

function referencesProdFile(testContent, relFile, base) {
    var src = String(testContent || '');
    var noAgents = String(relFile || '').replace(/^agents\//, '');
    return (
        src.indexOf("'" + noAgents + "'") !== -1 ||
        src.indexOf('"' + noAgents + '"') !== -1 ||
        src.indexOf("'agents/" + noAgents + "'") !== -1 ||
        src.indexOf('"agents/' + noAgents + '"') !== -1 ||
        src.indexOf('/' + base + "'") !== -1 ||
        src.indexOf('/' + base + '"') !== -1 ||
        src.indexOf("'" + base + "'") !== -1 ||
        src.indexOf('"' + base + '"') !== -1
    );
}

function findFallbackTestsForFile(relFile, unitTestEntries, seen, out) {
    var base = fileBasename(relFile);
    var entries = Array.isArray(unitTestEntries) ? unitTestEntries : [];
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!entry || !entry.path) continue;
        if (referencesProdFile(entry.content, relFile, base) && !seen[entry.path]) {
            seen[entry.path] = true;
            out.push(entry.path);
        }
    }
}

/**
 * Resolves the unit-test files (`js/unit-tests/test_*.js`) to execute for a
 * staged change set.
 *
 * Options:
 *   - stagedProdFiles: string[] of staged production JS files (`js/.../*.js`)
 *   - stagedTestFiles: string[] of staged unit-test files (`js/unit-tests/test_*.js`)
 *   - readFile(relPath): returns file text or null if missing
 *   - unitTestEntries: optional [{ path, content }] for fallback reference scan
 */
function resolveMatchingTestFiles(opts) {
    var options = opts || {};
    var prodFiles = Array.isArray(options.stagedProdFiles) ? options.stagedProdFiles : [];
    var testFiles = Array.isArray(options.stagedTestFiles) ? options.stagedTestFiles : [];
    var readFile = typeof options.readFile === 'function' ? options.readFile : function() { return null; };
    var seen = {};
    var out = [];
    var unmatchedProd = [];

    for (var t = 0; t < testFiles.length; t++) {
        var tf = testFiles[t];
        if (tf && !seen[tf]) {
            seen[tf] = true;
            out.push(tf);
        }
    }

    for (var i = 0; i < prodFiles.length; i++) {
        var prod = prodFiles[i];
        var stem = fileStem(prod);
        var beforeCount = out.length;
        var directTest = 'js/unit-tests/test_' + stem + '.js';
        var runJsonPath = 'js/unit-tests/run_' + stem + '.json';

        var matchedDirect = addTestsFromRunJson(readFile(runJsonPath), seen, out);
        if (readFile(directTest) !== null) {
            matchedDirect = true;
            if (!seen[directTest]) {
                seen[directTest] = true;
                out.push(directTest);
            }
        }
        if (!matchedDirect) {
            findFallbackTestsForFile(prod, options.unitTestEntries, seen, out);
        }
        if (out.length === beforeCount && !matchedDirect) {
            unmatchedProd.push(prod);
        }
    }

    return {
        testFiles: out,
        unmatchedProd: unmatchedProd
    };
}

function loadUnitTestEntriesFromFs(fs, path, rootDir) {
    var utDir = path.join(rootDir, 'js', 'unit-tests');
    if (!fs.existsSync(utDir)) return [];
    var names = fs.readdirSync(utDir).sort();
    var entries = [];
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        if (name.indexOf('test_') === 0 && name.slice(-3) === '.js') {
            var rel = 'js/unit-tests/' + name;
            entries.push({
                path: rel,
                content: fs.readFileSync(path.join(rootDir, rel), 'utf8')
            });
        }
    }
    return entries;
}

function runCli(argv) {
    var fs = require('fs');
    var path = require('path');
    var cmd = argv[2] || '';
    var rootDir = process.cwd();
    if (cmd === '--extract-ref') {
        var ymlPath = argv[3] || path.join(rootDir, '.github', 'workflows', 'quality.yml');
        var yml = fs.existsSync(ymlPath) ? fs.readFileSync(ymlPath, 'utf8') : '';
        process.stdout.write(extractCrap4jsRef(yml) + '\n');
        return;
    }
    if (cmd === '--resolve-tests') {
        var staged = argv.slice(3);
        var classified = classifyStagedFiles(staged);
        var entries = null;
        var resolved = resolveMatchingTestFiles({
            stagedProdFiles: classified.prodJs,
            stagedTestFiles: classified.testJs,
            readFile: function(rel) {
                var full = path.join(rootDir, rel);
                return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
            },
            get unitTestEntries() {
                if (entries === null) entries = loadUnitTestEntriesFromFs(fs, path, rootDir);
                return entries;
            }
        });
        process.stdout.write(JSON.stringify({
            prodJs: classified.prodJs,
            testJs: classified.testJs,
            testFiles: resolved.testFiles,
            unmatchedProd: resolved.unmatchedProd
        }) + '\n');
    }
}

if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
    runCli(process.argv);
}

module.exports = {
    DEFAULT_CRAP4JS_REF: DEFAULT_CRAP4JS_REF,
    isTestJsPath: isTestJsPath,
    isProdJsPath: isProdJsPath,
    classifyStagedFiles: classifyStagedFiles,
    extractCrap4jsRef: extractCrap4jsRef,
    resolveMatchingTestFiles: resolveMatchingTestFiles
};
