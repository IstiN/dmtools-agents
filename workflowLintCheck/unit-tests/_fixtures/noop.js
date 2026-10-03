// No-op agent action fixture: stub postJSAction/preJSAction for unit tests.
function action(params) {
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
