---
name: scm-abstraction
description: >
  Documentation for the SCM (Source Control Management) abstraction layer in dmtools-agents.
  Use when configuring GitHub vs Azure DevOps (ADO) as the SCM provider for agents,
  creating or modifying scm.js providers, setting global or per-agent SCM config,
  or understanding the provider interface (listPrs, addComment, resolveThread, mergePr, etc.).
---

# SCM Abstraction Layer

## Overview

`js/common/scm.js` provides a provider-based SCM abstraction so agents work with
**GitHub** or **Azure DevOps (ADO)** without hard-coding `github_*` tool calls.

```
agents/js/
  common/
    scm.js          — factory + GithubProvider + AdoProvider (17-method interface)
  configLoader.js   — loads scm config; re-exports createScm
```

---

## Configuration

### Global — `.dmtools/config.js`

```js
module.exports = {
  scm: { provider: 'ado' },        // 'github' (default) or 'ado'
  repository: {
    owner: 'MyOrg',                // GitHub org or ADO org
    repo:  'my-repo'
  }
};
```

### Per-agent — JSON `customParams`

```json
{
  "customParams": {
    "scmProvider": "ado"
  }
}
```

Per-agent `scmProvider` overrides the global config.

### Auto-detect from git remote

If `owner`/`repo` are not set in config, `createScm` parses `git remote.origin.url`
automatically (supports both GitHub and ADO URL formats).

---

## Usage in Agents

```javascript
var configLoader = require('./configLoader.js');

function action(params) {
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var scm    = configLoader.createScm(config);

    // List open pull requests
    var prs = JSON.parse(scm.listPrs('open'));
    if (!prs || prs.length === 0) {
        return { success: false, error: 'No open pull requests found' };
    }

    var pr   = prs[0];
    var prId = pr.id || pr.number || pr.pullRequestId;

    // Post a comment
    scm.addComment(prId, 'LGTM!');

    // Fetch review threads and reply/resolve
    var discussions = scm.fetchDiscussions(prId);
    var rawThreads  = (discussions.rawThreads && discussions.rawThreads.threads) || [];
    var openThread  = rawThreads.find(function(t) { return !t.resolved; });

    if (openThread) {
        scm.replyToThread(prId, openThread, 'Fixed, thank you!');
        scm.resolveThread(prId, openThread);
    }

    // Merge
    scm.mergePr(prId, 'squash', 'feat: my feature', '');

    return { success: true };
}
```

---

## Provider Interface

Both `GithubProvider` and `AdoProvider` implement 17 methods:

| Method | Description | ADO |
|--------|-------------|-----|
| `listPrs(state)` | List PRs (`'open'`/`'active'`/`'completed'`) | ✅ |
| `getPr(prId)` | Get PR details | ✅ |
| `getPrComments(prId)` | Get PR comments | ✅ |
| `addComment(prId, text)` | Post a PR comment | ✅ |
| `replyToThread(prId, thread, text)` | Reply to a review thread | ✅ |
| `resolveThread(prId, thread)` | Resolve/complete a thread | ✅ |
| `addInlineComment(prId, file, line, text)` | Add inline code comment | ✅ |
| `mergePr(prId, method, title, msg)` | Merge a PR | ✅ |
| `addLabel(prId, label)` | Add label/tag | ✅ |
| `removeLabel(prId, label)` | Remove label/tag | ✅ |
| `getPrDiff(prId)` | Get PR diff | ✅ |
| `fetchDiscussions(prId)` | Get review threads (normalised format) | ✅ |
| `getRemoteRepoInfo()` | Parse owner/repo from git remote URL | ✅ |
| `getCommitCheckRuns(sha)` | CI check results for a commit | ⚠️ GitHub only |
| `getJobLogs(jobId)` | CI job logs | ⚠️ GitHub only |
| `listWorkflowRuns(status, workflowId, limit)` | List workflow runs | ⚠️ GitHub only |
| `triggerWorkflow(owner, repo, workflow, inputs, ref)` | Trigger CI workflow | ⚠️ GitHub only |

> **CI methods** (`getCommitCheckRuns`, `getJobLogs`, `listWorkflowRuns`, `triggerWorkflow`)
> are currently GitHub-only. On ADO they log a warning and return `null`.
> Agents that call these require `scm.provider = 'github'`.

---

## Adding a New Provider

To add GitLab, Bitbucket, or another SCM:

1. Add `_createGitlabProvider(workspace, repo)` in `js/common/scm.js`
   returning the same 17-method interface object.
2. Register it in `createScm`:
   ```js
   if (provider === 'gitlab') return _createGitlabProvider(owner, repo);
   ```
3. Add the URL-parsing pattern in `_detectRepoFromGitRemote`:
   ```js
   var gitlabMatch = remoteUrl.match(/gitlab\.com[:/]([^/]+)\/([^/.]+)/);
   if (gitlabMatch) return { owner: gitlabMatch[1], repo: gitlabMatch[2].replace('.git', '') };
   ```

---

## Testing

The unit test framework in `js/unit-tests/` uses a mock scmModule pattern to avoid
real API calls. In tests that need SCM behaviour, provide a `mockScmModule`:

```javascript
var mockScmProvider = {
    triggerWorkflow: function(owner, repo, workflow, inputs, ref) {
        capturedTriggers.push({ owner: owner, repo: repo, workflow: workflow, inputs: inputs, ref: ref });
    },
    listPrs:          function() { return '[]'; },
    addComment:       function() {},
    replyToThread:    function() {},
    resolveThread:    function() {},
    mergePr:          function() {},
    fetchDiscussions: function() { return { markdown: '', rawThreads: [] }; }
};

var mockScmModule = { createScm: function() { return mockScmProvider; } };

var sm = loadModule(
    'agents/js/smAgent.js',
    makeRequire({ './configLoader.js': freshLoader, './common/scm.js': mockScmModule }),
    mocks
);
```

Run unit tests:
```bash
dmtools run agents/js/unit-tests/run_githubHelpers.json
dmtools run agents/js/unit-tests/run_smAgent.json
dmtools run agents/js/unit-tests/run_configLoader.json
```
