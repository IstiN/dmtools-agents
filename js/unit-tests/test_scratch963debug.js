suite('scratch debug gh-963', function() {
    test('creation failure path', function() {
        var rec = intakeRecorder();
        var n = 0;
        var mocks = rec.jiraMocks();
        var origCreate = mocks.jira_create_ticket_with_json;
        mocks.jira_create_ticket_with_json = function(a) { n++; if (n === 2) return null; return origCreate(a); };
        var mod2 = loadIntake(intakeFiles([
            { tempId: 'e1', type: 'Epic', summary: 'Epic one', description: 'x' },
            { type: 'Story', summary: 'Story one', parent: 'e1' }
        ], mocks));
        var r = mod2.action({ ticket: { key: 'P-3' }, initiator: 'acc1', metadata: {} });
        console.log('RESULTS: ' + JSON.stringify(r.results));
        console.log('CALLS: ' + JSON.stringify(rec.calls.map(function(c) { return c[0]; })));
        assert.equal(true, true);
    });
});
