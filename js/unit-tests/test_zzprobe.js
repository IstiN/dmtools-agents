function makeTcX(key, status) {
    return { key: key, fields: { summary: 's', status: { name: status }, issuetype: { name: 'Test Case' } } };
}

suite('probe', function() {
    test('probe isBlockingTestCase', function() {
        var configLoaderMock = makeDefaultConfigLoaderMock({ jira: { issueTypes: { TEST_CASE: 'Test Case', BUG: 'Bug' } } });
        var mod = loadModule(
            'js/checkBugTestsPassed.js',
            makeRequire({
                './config.js': configModule,
                './configLoader.js': configLoaderMock,
                './checkBugTestsPassedHelpers.js': loadModule('js/checkBugTestsPassedHelpers.js', makeRequire({}), {}),
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
                './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
                './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {}),
                './common/scm.js': { createScm: function() { return { listPrs: function() { return []; } }; } }
            }),
            {}
        );
        var tracker = trackersModuleForProbe();
        function trackersModuleForProbe() {
            return loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {});
        }
        var t = trackersModuleForProbe().createTracker({ jira: { statuses: configModule.STATUSES } }, {});
        console.log('PROBE statuses.PASED =', JSON.stringify(configModule.STATUSES.PASED));
        console.log('PROBE hasStage passed-tc =', t.hasStage(makeTcX('TC-1', 'Passed'), 'PASED', configModule.STATUSES.PASED));
        console.log('PROBE isBlockingTestCase =', mod.isBlockingTestCase(t, makeTcX('TC-1', 'Passed'), 'TS-1', 'Bug', 'jira', { statuses: configModule.STATUSES }));
        assert.ok(true);
    });
});
