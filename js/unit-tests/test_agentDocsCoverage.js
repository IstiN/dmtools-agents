/**
 * Agent docs coverage test — fails when a tracked agent config has no
 * up-to-date generated documentation.
 *
 * For every git-tracked root *.json agent config this checks that
 * docs/agents/generated/<name>.md exists and documents:
 *   - every referenced JS action (preJSAction / preCliJSAction /
 *     postCliJSAction / postJSAction / timerJSAction) by file basename;
 *   - every customParams key declared in the JSON;
 *   - every customParams path used by the referenced JS action sources.
 *
 * If this test fails after your change, regenerate the docs:
 *   node js/agentDocGenerator.js   (run from the parent repo root)
 * and commit the updated docs/agents/generated/*.md files.
 */

var AGENT_JSON_PATTERN = /^[a-zA-Z0-9_]+\.json$/;
var ACTION_PARAMS = ['preJSAction', 'preCliJSAction', 'postCliJSAction', 'postJSAction', 'timerJSAction'];
var EXCLUDED = { 'sm.json': true, 'sm_merge.json': true };

function listTrackedAgentConfigs() {
    var output = cli_execute_command({ command: 'git ls-files "*.json"' });
    return (output || '').split('\n').filter(function(f) {
        if (!f || !f.trim()) return false;
        var path = f.trim();
        if (path.indexOf('/') !== -1) return false; // root configs only
        var name = path.replace(/^.*\//, '');
        if (EXCLUDED[name]) return false;
        if (name.indexOf('run_') === 0) return false;
        if (name.indexOf('_lock') !== -1) return false;
        return AGENT_JSON_PATTERN.test(name);
    }).map(function(f) { return f.trim(); });
}

function readText(path) {
    try {
        return file_read({ path: path });
    } catch (e) {
        return null;
    }
}

function extractCustomParamsPaths(src) {
    var found = {};
    var re1 = /customParams\.([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/g;
    var re2 = /customParams\[['"]([\w.]+)['"]\]/g;
    var match;
    while ((match = re1.exec(src)) !== null) found[match[1]] = true;
    while ((match = re2.exec(src)) !== null) found[match[1]] = true;
    return Object.keys(found);
}

function actionBasename(actionPath) {
    return String(actionPath).replace(/^.*\//, '');
}

suite('agentDocsCoverage', function() {

    test('every tracked agent config has complete generated docs', function() {
        var configs = listTrackedAgentConfigs();
        if (configs.length === 0) {
            throw new Error('No agent configs found — git ls-files must work in the test environment');
        }

        var failures = [];

        configs.forEach(function(configPath) {
            var name = configPath.replace(/\.json$/, '');
            var docPath = 'docs/agents/generated/' + name + '.md';
            var doc = readText(docPath);

            if (!doc) {
                failures.push(name + ': missing ' + docPath + ' (run: node js/agentDocGenerator.js)');
                return;
            }

            var config;
            try {
                config = JSON.parse(readText(configPath));
            } catch (e) {
                failures.push(name + ': cannot parse ' + configPath);
                return;
            }
            var params = config.params || {};
            var metadata = params.metadata || {};

            // Human-readable doc is mandatory at the conventional location
            // docs/agents/<name>.md; metadata.descriptionPath may reference it
            // explicitly but must point at the same file when present.
            var humanDocPath = 'docs/agents/' + name + '.md';
            var humanDoc = readText(humanDocPath);
            if (!humanDoc || humanDoc.trim().length < 40) {
                failures.push(name + ': missing human doc ' + humanDocPath +
                    ' (add a 1-2 sentence summary plus a Parameters section)');
            } else {
                if (metadata.descriptionPath &&
                    metadata.descriptionPath !== 'agents/' + humanDocPath &&
                    metadata.descriptionPath !== humanDocPath) {
                    failures.push(name + ': metadata.descriptionPath "' + metadata.descriptionPath +
                        '" does not match the convention agents/' + humanDocPath);
                }
                // First meaningful paragraph must be rendered in the generated doc
                var firstParagraph = humanDoc.split('\n')
                    .filter(function(l) { return l.trim() && l.trim().charAt(0) !== '#'; })[0] || '';
                if (firstParagraph.trim().length >= 20 &&
                    doc.indexOf(firstParagraph.trim().substring(0, 40)) === -1) {
                    failures.push(name + ': generated doc does not embed the human doc (regenerate docs)');
                }
            }

            // Every referenced JS action must be mentioned by basename
            ACTION_PARAMS.forEach(function(paramName) {
                var actionPath = params[paramName];
                if (!actionPath) return;
                var base = actionBasename(actionPath);
                if (doc.indexOf(base) === -1) {
                    failures.push(name + ': doc does not mention action ' + base);
                }

                // customParams paths used by the JS action must be documented
                // in BOTH the generated reference and the human doc
                var src = readText(String(actionPath).replace(/^agents\//, ''));
                if (src) {
                    extractCustomParamsPaths(src).forEach(function(p) {
                        var rootKey = p.split('.')[0];
                        if (doc.indexOf('`' + p + '`') === -1) {
                            failures.push(name + ': generated doc does not document customParams.' + p + ' used by ' + base);
                        }
                        var rootMention = '`' + rootKey + '`';
                        var rootPrefix = '`' + rootKey + '.';
                        if (humanDoc && humanDoc.indexOf(rootMention) === -1 && humanDoc.indexOf(rootPrefix) === -1) {
                            failures.push(name + ': human doc does not describe customParams.' + rootKey + ' used by ' + base);
                        }
                    });
                }
            });

            // Every customParams key declared in the JSON must be documented
            var customParams = params.customParams || {};
            Object.keys(customParams).forEach(function(k) {
                if (doc.indexOf('`' + k + '`') === -1) {
                    failures.push(name + ': generated doc does not document customParams key ' + k);
                }
                var keyMention = '`' + k + '`';
                var keyPrefix = '`' + k + '.';
                if (humanDoc && humanDoc.indexOf(keyMention) === -1 && humanDoc.indexOf(keyPrefix) === -1) {
                    failures.push(name + ': human doc does not describe customParams key ' + k);
                }
            });
        });

        if (failures.length > 0) {
            throw new Error(
                'Agent docs coverage failed (' + failures.length + ' problem(s)). ' +
                'Regenerate with: node js/agentDocGenerator.js\n  - ' + failures.join('\n  - ')
            );
        }
    });

});
