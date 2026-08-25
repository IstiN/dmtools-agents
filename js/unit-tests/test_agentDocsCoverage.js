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

            // Human-readable description is mandatory — it is what makes the
            // generated docs (and any future HTML rendering) readable.
            var description = metadata.description || params.description || '';
            if (!description || description.trim().length < 20) {
                failures.push(name + ': missing params.metadata.description ' +
                    '(add a 1-2 sentence human-readable summary of what the agent does)');
            } else if (doc.indexOf(description.trim().substring(0, 40)) === -1) {
                failures.push(name + ': doc does not render the description (regenerate docs)');
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
                var src = readText(String(actionPath).replace(/^agents\//, ''));
                if (src) {
                    extractCustomParamsPaths(src).forEach(function(p) {
                        if (doc.indexOf('`' + p + '`') === -1) {
                            failures.push(name + ': doc does not document customParams.' + p + ' used by ' + base);
                        }
                    });
                }
            });

            // Every customParams key declared in the JSON must be documented
            var customParams = params.customParams || {};
            Object.keys(customParams).forEach(function(k) {
                if (doc.indexOf('`' + k + '`') === -1) {
                    failures.push(name + ': doc does not document customParams key ' + k);
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
