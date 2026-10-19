// gh-1101: invisible required checks — pure helpers.
var m = loadModule('js/common/invisibleRequiredChecks.js', makeRequire({}), {});

suite('invisibleRequiredChecks (gh-1101)', function () {
  var green = [
    { name: 'static', status: 'completed', conclusion: 'success', started_at: '2026-10-12T14:00:00Z' },
    { name: 'gate', status: 'completed', conclusion: 'success', started_at: '2026-10-12T14:00:00Z' }
  ];
  test('isInvisible: all required green, PR sees none ⇒ true', function () {
    assert.equal(m.isInvisible(['static', 'gate'], green, []), true);
  });
  test('isInvisible: any required visible ⇒ false', function () {
    assert.equal(m.isInvisible(['static', 'gate'], green, ['gate']), false);
  });
  test('isInvisible: a required context missing/red on the commit ⇒ false', function () {
    assert.equal(m.isInvisible(['static', 'x'], green, []), false);
    var red = green.concat([{ name: 'gate', status: 'completed', conclusion: 'failure', started_at: '2026-10-12T15:00:00Z' }]);
    assert.equal(m.isInvisible(['static', 'gate'], red, []), false, 'newest per context wins');
  });
  test('isInvisible: probe gaps fail closed', function () {
    assert.equal(m.isInvisible(null, green, []), false);
    assert.equal(m.isInvisible([], green, []), false);
    assert.equal(m.isInvisible(['static'], null, []), false);
    assert.equal(m.isInvisible(['static'], green, null), false);
    assert.equal(m.isInvisible(['static'], [null, {}], []), false);
  });
  test('blockedApprovedShape', function () {
    var t = { labels: ['pr_approved'], pr: { mergeState: 'BLOCKED', mergeable: true } };
    assert.equal(m.blockedApprovedShape(t), true);
    assert.equal(m.blockedApprovedShape({ labels: ['pr_approved'], pr: { mergeState: 'BEHIND' } }), false);
    assert.equal(m.blockedApprovedShape({ labels: [], pr: { mergeState: 'BLOCKED' } }), false);
    assert.equal(m.blockedApprovedShape({ labels: ['pr_approved'], pr: { mergeState: 'BLOCKED', mergeable: false } }), false);
    assert.equal(m.blockedApprovedShape(null), false);
    assert.equal(m.blockedApprovedShape({}), false);
  });
  test('markerLine / lastResetAtMs round-trip', function () {
    var l1 = m.markerLine('aaa', '2026-10-12T14:00:00.000Z');
    var l2 = m.markerLine('bbb', '2026-10-12T15:00:00.000Z');
    assert.equal(m.lastResetAtMs(['x', l1, l2 + '\nbody', null]), Date.parse('2026-10-12T15:00:00.000Z'));
    assert.equal(m.lastResetAtMs([]), null);
    assert.equal(m.lastResetAtMs(undefined), null);
    assert.equal(m.lastResetAtMs([m.markerLine('c', 'garbage')]), null);
  });
  test('shouldHoldDispatch', function () {
    var now = 1000000000;
    assert.equal(m.shouldHoldDispatch(null, [], now), false, 'no reset ⇒ no hold');
    assert.equal(m.shouldHoldDispatch(now - 1000, [], now), true, 'no push suite ⇒ hold');
    assert.equal(m.shouldHoldDispatch(now - 1000, null, now), true, 'probe failed ⇒ hold (bounded)');
    assert.equal(m.shouldHoldDispatch(now - 1000, [{ event: 'push' }], now), false, 'push suite ⇒ go');
    assert.equal(m.shouldHoldDispatch(now - 1000, [null, { event: 'workflow_dispatch' }], now), true);
    assert.equal(m.shouldHoldDispatch(now - m.DEFAULT_PUSH_SUITE_WAIT_MS, [], now), false, 'bounded wait');
    assert.equal(m.shouldHoldDispatch(now - 5000, [], now, 1000), false, 'custom wait');
  });
});
