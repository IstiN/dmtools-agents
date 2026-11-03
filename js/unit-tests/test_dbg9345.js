var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}));
var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthor }));
var tcLedger = loadModule('js/common/tcMaintenanceLedger.js', makeRequire({ './reviewVerdicts.js': reviewVerdicts }));
var tcRunRegistry = loadModule('js/common/tcRunRegistry.js', makeRequire({ './reviewVerdicts.js': reviewVerdicts }));
var bugBookeeping = loadModule('js/common/bugBookkeeping.js', makeRequire({
    './tcRunRegistry.js': tcRunRegistry, './tcMaintenanceLedger.js': tcLedger, './machineAuthor.js': machineAuthor
}));
function trackersWith(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}
var marker = tcLedger.buildLedgerMarker(tcLedger.appendFinding(tcLedger.emptyLedger(), {
    tcKey: 'TS-7', role: 'regression-guard', verdict: 'differential-rerun',
    reason: 'rerun-requested-on-last-green-build', errorClass: 'assertion',
    testPath: 'testing/tests/TS-7/test.py', sha: 'sha-new', lastGreenSha: 'sha-green'
}));
var jira = {
    jira_get_ticket: function() { return { fields: { issuetype: { name: 'Bug' }, summary: 's',
        comment: { comments: [{ body: marker, user: { login: 'ai-teammate' } }] } } }; },
    jira_post_comment: function(args) { console.log('COMMENT POSTED'); },
    jira_move_to_status: function(args) { console.log('MOVED', JSON.stringify(args)); },
    jira_remove_label: function(args) { console.log('UNLABELED', JSON.stringify(args)); }
};
var mod = loadModule('js/tcDifferentialDispatcher.js', makeRequire({
    './configLoader.js': makeDefaultConfigLoaderMock({}),
    './config.js': configModule,
    './common/trackers.js': trackersWith(jira),
    './common/tcTriage.js': loadModule('js/common/tcTriage.js', makeRequire({})),
    './common/tcMaintenanceLedger.js': tcLedger,
    './common/tcRunRegistry.js': tcRunRegistry,
    './common/bugBookkeeping.js': bugBookeeping
}), Object.assign({}, { cli_execute_command: function(a) { return 'ok'; } }, jira));
try {
    var r = mod.action({ ticket: { key: 'BUG-1' }, jobParams: { machineAuthor: 'ai-teammate',
        customParams: { workingDir: '/repo', tcRunCommand: 'pytest {testPath}' } } });
    console.log('RESULT:', JSON.stringify(r));
} catch (e) {
    console.log('CAUGHT:', e && e.message);
    console.log('STACK:', e && e.stack ? String(e.stack).split('\n').slice(0, 6).join(' | ') : 'none');
}
