var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}));
var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthor }));
var tcRunRegistry = loadModule('js/common/tcRunRegistry.js', makeRequire({ './reviewVerdicts.js': reviewVerdicts }));

suite('dbg', function() {
    test('marker parse', function() {
        var MARKER = '<!-- dmtools:tc-run-registry {"v":1,"at":"2026-01-01T00:00:00.000Z","tcs":{"TS-152":{"role":"regression-guard","validated":true,"lastGreenSha":"sha-green","lastGreenEnvFingerprint":"env-1","lastGreenAt":"2026-01-01T00:00:00.000Z","greens":1,"redRounds":0,"lastRedAt":null,"lastVerdict":null}}} -->\n\ud83d\udcd8 registry fixture';
        var logins = machineAuthor.machineAuthorLogins(machineAuthor.resolveMachineAuthor({ machineAuthor: 'ai-teammate' }, null));
        assert.deepEqual(logins, ['ai-teammate']);
        var rec = tcRunRegistry.latestRegistry([{ body: MARKER, user: { login: 'ai-teammate' } }], { authorLogins: logins });
        assert.ok(rec, 'record found');
        assert.equal(rec.registry.tcs['TS-152'].validated, true);
        var t = loadModule('js/common/tcTriage.js', makeRequire({}));
        var v = t.triageFailure({
            tcKey: 'TS-152', role: 'regression-guard', validated: true,
            current: { sha: 'sha-new', envFingerprint: 'env-1' },
            lastGreen: { sha: 'sha-green', envFingerprint: 'env-1' },
            differential: 'green', redRounds: 0, maxReworkRounds: 2
        });
        assert.equal(v.action, 'bounce');
    });
});

suite('dbg2', function() {
    test('trackers getIssue shape', function() {
        var configMod = loadModule('js/config.js', makeRequire({}));
        var trackers = loadModule('js/common/trackers.js', makeRequire({
            '../config.js': configMod,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js', makeRequire({}))
        }), {
            jira_get_ticket: function(args) {
                return JSON.stringify({ key: 'BUG-150', fields: { comment: { comments: [{ body: 'x', user: { login: 'ai-teammate' } }] } } });
            }
        });
        var holder = trackers.createTrackerHolder();
        holder.initTracker({ jira: {} }, {});
        var issue = holder.getTracker().getIssue('BUG-150');
        console.log('PROBE3 issue type:', typeof issue, 'keys:', issue ? Object.keys(issue).join(',') : 'null');
        console.log('PROBE3 fields:', issue && issue.fields ? Object.keys(issue.fields).join(',') : 'no fields');
        console.log('PROBE3 comments:', issue && issue.fields && issue.fields.comment ? JSON.stringify(issue.fields.comment).substring(0, 120) : 'none');
    });
});
