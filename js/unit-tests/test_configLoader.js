/**
 * Unit tests for js/configLoader.js
 *
 * Uses: configModule, configLoaderModule (pre-loaded by testRunner)
 *       loadModule(), makeRequire(), assert, test(), suite()
 */

// ── formatTemplate ────────────────────────────────────────────────────────────

suite('configLoader.formatTemplate', function() {

    test('replaces a single placeholder', function() {
        var result = configLoaderModule.formatTemplate('{key} world', { key: 'hello' });
        assert.equal(result, 'hello world');
    });

    test('replaces multiple different placeholders', function() {
        var result = configLoaderModule.formatTemplate(
            '{ticketKey} {ticketSummary}',
            { ticketKey: 'PROJ-42', ticketSummary: 'Add login page' }
        );
        assert.equal(result, 'PROJ-42 Add login page');
    });

    test('replaces the same placeholder multiple times', function() {
        var result = configLoaderModule.formatTemplate('{k} and {k}', { k: 'X' });
        assert.equal(result, 'X and X');
    });

    test('returns empty string for null template', function() {
        var result = configLoaderModule.formatTemplate(null, { k: 'v' });
        assert.equal(result, '');
    });

    test('leaves unknown placeholders as-is', function() {
        var result = configLoaderModule.formatTemplate('{unknown}', { other: 'v' });
        assert.equal(result, '{unknown}');
    });

    test('handles empty vars object', function() {
        var result = configLoaderModule.formatTemplate('no placeholders', {});
        assert.equal(result, 'no placeholders');
    });

});

// ── interpolateJql ────────────────────────────────────────────────────────────

suite('configLoader.interpolateJql', function() {

    var mockConfig = {
        jira: { project: 'PROJ', parentTicket: 'PROJ-1' }
    };

    test('replaces {jiraProject}', function() {
        var result = configLoaderModule.interpolateJql(
            "project = {jiraProject} AND issuetype = 'Story'",
            mockConfig
        );
        assert.equal(result, "project = PROJ AND issuetype = 'Story'");
    });

    test('replaces {parentTicket}', function() {
        var result = configLoaderModule.interpolateJql(
            "project = {jiraProject} AND parent = {parentTicket}",
            mockConfig
        );
        assert.equal(result, "project = PROJ AND parent = PROJ-1");
    });

    test('returns null for null JQL', function() {
        var result = configLoaderModule.interpolateJql(null, mockConfig);
        assert.equal(result, null);
    });

    test('leaves JQL unchanged when no placeholders', function() {
        var jql = "project = FIXED AND status = 'Done'";
        var result = configLoaderModule.interpolateJql(jql, mockConfig);
        assert.equal(result, jql);
    });

});

// ── formatBranchName ──────────────────────────────────────────────────────────

suite('configLoader.formatBranchName', function() {

    test('builds prefix/ticketKey', function() {
        var result = configLoaderModule.formatBranchName('ai', 'PROJ-42');
        assert.equal(result, 'ai/PROJ-42');
    });

    test('works with feature prefix', function() {
        var result = configLoaderModule.formatBranchName('feature', 'PROJ-100');
        assert.equal(result, 'feature/PROJ-100');
    });

    test('works with test prefix', function() {
        var result = configLoaderModule.formatBranchName('test', 'PROJ-7');
        assert.equal(result, 'test/PROJ-7');
    });

});

// ── mergeProjectConfig ────────────────────────────────────────────────────────

suite('configLoader.mergeProjectConfig', function() {

    var defaults = configLoaderModule.DEFAULTS;

    test('deep merges git section', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            git: { baseBranch: 'master' }
        });
        assert.equal(result.git.baseBranch, 'master');
        assert.equal(result.git.authorName, defaults.git.authorName, 'other git fields preserved');
    });

    test('merges jira.statuses over defaults when provided', function() {
        var customStatuses = { DONE: 'Closed', IN_REVIEW: 'Under Review' };
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            jira: { statuses: customStatuses }
        });
        assert.equal(result.jira.statuses.DONE, 'Closed', 'override applied');
        assert.equal(result.jira.statuses.IN_REVIEW, 'Under Review', 'override applied');
        assert.equal(result.jira.statuses.BACKLOG, 'Backlog', 'unspecified keys keep defaults');
    });

    test('merges jira.issueTypes over defaults when provided', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            jira: { issueTypes: { TEST_CASE: 'XRay Test' } }
        });
        assert.equal(result.jira.issueTypes.TEST_CASE, 'XRay Test', 'override applied');
        assert.equal(result.jira.issueTypes.BUG, 'Bug', 'unspecified keys keep defaults');
        assert.equal(result.jira.issueTypes.STORY, 'Story', 'unspecified keys keep defaults');
    });

    test('explicit null jira.statuses/issueTypes falls back to defaults', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            jira: { statuses: null, issueTypes: null }
        });
        assert.equal(result.jira.statuses.DONE, 'Done', 'default statuses restored');
        assert.equal(result.jira.issueTypes.BUG, 'Bug', 'default issueTypes restored');
    });

    test('preserves default statuses when not overridden', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            jira: { project: 'TEST' }
        });
        assert.equal(result.jira.project, 'TEST');
        assert.ok(result.jira.statuses.DONE, 'default statuses preserved');
    });

    test('deep merges jira fields for acceptance criteria friendly field name', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            jira: { fields: { acceptanceCriteria: 'Definition of Done' } }
        });
        assert.equal(result.jira.fields.acceptanceCriteria, 'Definition of Done');
        assert.equal(defaults.jira.fields.acceptanceCriteria, 'Acceptance Criteria');
    });

    test('fully replaces labels when provided', function() {
        var customLabels = { MY_LABEL: 'my_label' };
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            labels: customLabels
        });
        assert.deepEqual(result.labels, customLabels);
        assert.notOk(result.labels.PR_APPROVED, 'old labels removed');
    });

    test('fully replaces smRules when provided', function() {
        var customRules = [{ jql: 'custom', configFile: 'custom.json' }];
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            smRules: customRules
        });
        assert.deepEqual(result.smRules, customRules);
    });

    test('smRules null when not overridden', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, { jira: { project: 'X' } });
        assert.equal(result.smRules, null);
    });

    test('deep merges confluence URLs', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            confluence: {
                templateStory: 'https://my-confluence/story'
            }
        });
        assert.equal(result.confluence.templateStory, 'https://my-confluence/story');
        assert.equal(
            result.confluence.templateJiraMarkdown,
            defaults.confluence.templateJiraMarkdown,
            'other confluence URLs preserved'
        );
    });

    test('handles null override gracefully', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, null);
        assert.equal(result.git.baseBranch, 'main');
    });

});

// ── loadProjectConfig ─────────────────────────────────────────────────────────

suite('configLoader.loadProjectConfig', function() {

    /**
     * Create a fresh configLoader instance with a controlled file_read mock.
     * fileMap: { 'path': 'file content' | null }
     */
    function makeLoader(fileMap) {
        return loadModule(
            'js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            {
                file_read: function(opts) {
                    if (fileMap.hasOwnProperty(opts.path)) return fileMap[opts.path];
                    return null;
                }
            }
        );
    }

    test('returns defaults when no config file found', function() {
        var cl = makeLoader({});
        var config = cl.loadProjectConfig({});
        assert.equal(config.git.baseBranch, 'main');
        assert.equal(config.git.branchPrefix.development, 'ai');
        assert.equal(config.jira.project, '');
        assert.equal(config.repository.owner, '');
    });

    test('loads config from .dmtools/config.js before relative fallback', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { jira: { project: "PROJ", parentTicket: "PROJ-1" }, repository: { owner: "my-org", repo: "my-repo" } };',
            '../.dmtools/config.js':
                'module.exports = { jira: { project: "REL" } };'
        });
        var config = cl.loadProjectConfig({});
        assert.equal(config.jira.project, 'PROJ');
        assert.equal(config.jira.parentTicket, 'PROJ-1');
        assert.equal(config.repository.owner, 'my-org');
        assert.equal(config.repository.repo, 'my-repo');
        assert.equal(config.git.baseBranch, 'main', 'defaults preserved');
        assert.equal(config._configPath, '.dmtools/config.js');
    });

    test('falls back to ../.dmtools/config.js when root config not found', function() {
        var cl = makeLoader({
            '.dmtools/config.js': null,
            '../.dmtools/config.js':
                'module.exports = { jira: { project: "REL", parentTicket: "REL-1" }, repository: { owner: "rel-org", repo: "rel-repo" } };'
        });
        var config = cl.loadProjectConfig({});
        assert.equal(config.jira.project, 'REL');
        assert.equal(config.jira.parentTicket, 'REL-1');
        assert.equal(config.repository.owner, 'rel-org');
        assert.equal(config.repository.repo, 'rel-repo');
        assert.equal(config.git.baseBranch, 'main', 'defaults preserved');
        assert.equal(config._configPath, '../.dmtools/config.js');
    });

    test('does not probe relative config when root config is present', function() {
        var paths = [];
        var loader = loadModule(
            'js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            {
                file_read: function(opts) {
                    paths.push(opts.path);
                    if (opts.path === '.dmtools/config.js') {
                        return 'module.exports = { jira: { project: "ROOT" } };';
                    }
                    if (opts.path === '../.dmtools/config.js') {
                        throw new Error('relative path should not be read');
                    }
                    return null;
                }
            }
        );
        var config = loader.loadProjectConfig({});
        assert.equal(config.jira.project, 'ROOT');
        assert.equal(paths.indexOf('../.dmtools/config.js'), -1, 'relative fallback skipped');
    });

    test('falls back to defaults if both discovered configs are missing', function() {
        var cl = makeLoader({
            '.dmtools/config.js': null,
            '../.dmtools/config.js': null
        });
        var config = cl.loadProjectConfig({});
        assert.equal(config.jira.project, '');
    });

    test('uses customParams.configPath when provided', function() {
        var cl = makeLoader({
            '/custom/path/config.js':
                'module.exports = { repository: { owner: "custom-org", repo: "custom-repo" } };'
        });
        var config = cl.loadProjectConfig({
            customParams: { configPath: '/custom/path/config.js' }
        });
        assert.equal(config.repository.owner, 'custom-org');
    });

    test('applies targetRepository override from customParams', function() {
        var cl = makeLoader({});
        var config = cl.loadProjectConfig({
            customParams: {
                targetRepository: {
                    owner: 'other-org',
                    repo: 'other-repo',
                    baseBranch: 'master',
                    workingDir: 'other-repo'
                }
            }
        });
        assert.equal(config.repository.owner, 'other-org');
        assert.equal(config.repository.repo, 'other-repo');
        assert.equal(config.git.baseBranch, 'master');
        assert.equal(config.workingDir, 'other-repo');
    });

    test('applies baseBranchResolverFnPath using ticket fixVersion', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { baseBranchResolverFnPath: "./.dmtools/resolver.js", baseBranchByFixVersionPattern: "develop/{version}" } };',
            './.dmtools/resolver.js':
                'module.exports = function(ticket, candidateBaseBranch, config) { ' +
                '  var targetRepo = config.customParams && config.customParams.targetRepository; ' +
                '  if (!targetRepo || targetRepo.repo !== "example-repo") return candidateBaseBranch; ' +
                '  var pattern = config.git && config.git.baseBranchByFixVersionPattern || "develop/{version}"; ' +
                '  var versions = ticket && ticket.fields && ticket.fields.fixVersions; ' +
                '  if (versions && versions.length > 0) { ' +
                '    var v = versions[0]; var name = v && v.name ? v.name : v; ' +
                '    if (name) return pattern.replace("{version}", name); ' +
                '  } ' +
                '  return candidateBaseBranch; ' +
                '};'
        });
        var config = cl.loadProjectConfig({
            ticket: { key: 'PROJ-1', fields: { fixVersions: [{ name: '3.9.0' }] } },
            customParams: {
                targetRepository: { owner: 'acme-corp', repo: 'example-repo', baseBranch: 'master' }
            }
        });
        assert.equal(config.git.baseBranch, 'develop/3.9.0');
    });

    test('baseBranchResolverFnPath falls back to candidate baseBranch when no fixVersion', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { baseBranchResolverFnPath: "./.dmtools/resolver.js" } };',
            './.dmtools/resolver.js':
                'module.exports = function(ticket, candidateBaseBranch) { ' +
                '  var versions = ticket && ticket.fields && ticket.fields.fixVersions; ' +
                '  if (versions && versions.length > 0) return "develop/" + versions[0].name; ' +
                '  return candidateBaseBranch; ' +
                '};'
        });
        var config = cl.loadProjectConfig({
            ticket: { key: 'PROJ-1', fields: {} },
            customParams: {
                targetRepository: { owner: 'acme-corp', repo: 'example-repo', baseBranch: 'master' }
            }
        });
        assert.equal(config.git.baseBranch, 'master');
    });

    test('baseBranchResolverFnPath ignored when no ticket provided', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { baseBranchResolverFnPath: "./.dmtools/resolver.js" } };',
            './.dmtools/resolver.js':
                'module.exports = function(ticket, candidateBaseBranch) { return "develop/forced"; };'
        });
        var config = cl.loadProjectConfig({
            customParams: {
                targetRepository: { owner: 'acme-corp', repo: 'example-repo', baseBranch: 'master' }
            }
        });
        assert.equal(config.git.baseBranch, 'master');
    });

    test('snapshotBranchResolverFnPath resolves snapshotBranch from ticket', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { snapshotBranchResolverFnPath: "./.dmtools/snapshot-resolver.js" } };',
            './.dmtools/snapshot-resolver.js':
                'module.exports = function(ticket, candidateBranch) { ' +
                '  var versions = ticket && ticket.fields && ticket.fields.fixVersions; ' +
                '  if (versions && versions.length > 0) return "develop/" + versions[0].name; ' +
                '  return candidateBranch; ' +
                '};'
        });
        var config = cl.loadProjectConfig({
            ticket: { key: 'PROJ-1', fields: { fixVersions: [{ name: '3.9.0' }] } },
            customParams: {
                targetRepository: { owner: 'acme-corp', repo: 'example-repo', baseBranch: 'master' }
            }
        });
        assert.equal(config.git.snapshotBranch, 'develop/3.9.0');
        assert.equal(config.git.baseBranch, 'master', 'baseBranch unchanged');
    });

    test('snapshotBranchResolverFnPath falls back to candidate branch', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { snapshotBranchResolverFnPath: "./.dmtools/snapshot-resolver.js" } };',
            './.dmtools/snapshot-resolver.js':
                'module.exports = function(ticket, candidateBranch) { return candidateBranch; };'
        });
        var config = cl.loadProjectConfig({
            ticket: { key: 'PROJ-1', fields: {} },
            customParams: {
                targetRepository: { owner: 'acme-corp', repo: 'example-repo', baseBranch: 'master' }
            }
        });
        assert.equal(config.git.snapshotBranch, 'master');
    });

    test('partial config — only overridden fields change', function() {
        var cl = makeLoader({
            '../.dmtools/config.js':
                'module.exports = { git: { baseBranch: "develop" } };'
        });
        var config = cl.loadProjectConfig({});
        assert.equal(config.git.baseBranch, 'develop');
        assert.equal(config.git.authorName, 'AI Teammate', 'other git fields preserved');
        assert.equal(config.git.branchPrefix.development, 'ai', 'branchPrefix preserved');
    });

    test('invalid JS in config file falls back to defaults', function() {
        var cl = makeLoader({
            '../.dmtools/config.js': 'this is not valid js }{{'
        });
        var config = cl.loadProjectConfig({});
        assert.equal(config.git.baseBranch, 'main', 'falls back to defaults on parse error');
    });

    // ── paramsForConfigLoad ─────────────────────────────────────────────────
    // Regression coverage for the bug where baseBranchResolverFnPath/
    // snapshotBranchResolverFnPath silently never fired in production: real
    // Teammate execution passes preJSAction/postJSAction params as sibling
    // top-level keys { jobParams, ticket, response } (see JavaScriptExecutor.
    // withJobContext in the tracker), but every call site read `params.jobParams ||
    // params` to reach customParams/configPath, which discarded the sibling
    // `params.ticket`.

    test('paramsForConfigLoad re-attaches sibling params.ticket onto jobParams (real Teammate shape)', function() {
        var cl = makeLoader({});
        var ticket = { key: 'PROJ-1', fields: { fixVersions: [{ name: '3.9.0' }] } };
        var result = cl.paramsForConfigLoad({
            jobParams: { customParams: { targetRepository: { repo: 'example-repo' } } },
            ticket: ticket,
            response: 'some response'
        });
        assert.equal(result.ticket, ticket, 'ticket carried over onto the jobParams-derived object');
        assert.equal(result.customParams.targetRepository.repo, 'example-repo', 'jobParams.customParams preserved');
    });

    test('paramsForConfigLoad does not mutate the original jobParams object', function() {
        var cl = makeLoader({});
        var jobParams = { customParams: {} };
        var ticket = { key: 'PROJ-1' };
        cl.paramsForConfigLoad({ jobParams: jobParams, ticket: ticket });
        assert.equal(jobParams.ticket, undefined, 'original jobParams left untouched');
    });

    test('paramsForConfigLoad leaves jobParams.ticket alone when already present (standalone/JSRunner shape)', function() {
        var cl = makeLoader({});
        var innerTicket = { key: 'PROJ-2' };
        var outerTicket = { key: 'PROJ-3' };
        var result = cl.paramsForConfigLoad({
            jobParams: { ticket: innerTicket, customParams: {} },
            ticket: outerTicket
        });
        assert.equal(result.ticket, innerTicket, 'jobParams.ticket wins when already set');
    });

    test('paramsForConfigLoad falls back to params itself when no jobParams present', function() {
        var cl = makeLoader({});
        var ticket = { key: 'PROJ-4' };
        var result = cl.paramsForConfigLoad({ ticket: ticket, customParams: {} });
        assert.equal(result.ticket, ticket);
    });

    test('end-to-end: baseBranchResolverFnPath now fires from the real Teammate params shape', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { baseBranchResolverFnPath: "./.dmtools/resolver.js", baseBranchByFixVersionPattern: "develop/{version}" } };',
            './.dmtools/resolver.js':
                'module.exports = function(ticket, candidateBaseBranch, config) { ' +
                '  var targetRepo = config.customParams && config.customParams.targetRepository; ' +
                '  if (!targetRepo || targetRepo.repo !== "example-repo") return candidateBaseBranch; ' +
                '  var versions = ticket && ticket.fields && ticket.fields.fixVersions; ' +
                '  if (versions && versions.length > 0) return "develop/" + versions[0].name; ' +
                '  return candidateBaseBranch; ' +
                '};'
        });
        // Simulate the real Teammate shape: jobParams and ticket as siblings —
        // this is exactly what preCliDevelopmentSetup/developTicketAndCreatePR/
        // preCliReworkSetup/preCliSnapshotSetup receive in production.
        var realShapeParams = {
            jobParams: {
                customParams: {
                    targetRepository: { owner: 'acme-corp', repo: 'example-repo', baseBranch: 'main' }
                }
            },
            ticket: { key: 'PROJ-5', fields: { fixVersions: [{ name: '3.9.0' }] } }
        };
        var config = cl.loadProjectConfig(cl.paramsForConfigLoad(realShapeParams));
        assert.equal(config.git.baseBranch, 'develop/3.9.0',
            'resolver must fire even though ticket only exists as a sibling of jobParams');
    });

    test('applies explicit params.repository from the SM rule over the config file repository', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { repository: { owner: "cfg-org", repo: "cfg-repo" } };'
        });
        var config = cl.loadProjectConfig({ repository: { owner: 'rule-org', repo: 'rule-repo' } });
        assert.equal(config.repository.owner, 'rule-org');
        assert.equal(config.repository.repo, 'rule-repo');
    });

    test('ignores params.repository when owner or repo is missing', function() {
        var cl = makeLoader({});
        var config = cl.loadProjectConfig({ repository: { owner: 'only-owner' } });
        assert.equal(config.repository.owner, '');
        var config2 = cl.loadProjectConfig({ repository: { repo: 'only-repo' } });
        assert.equal(config2.repository.repo, '');
    });

    test('loads config from the agentConfigsDir convention {dir}/.dmtools/config.js', function() {
        var cl = makeLoader({
            'projects/demo/.dmtools/config.js':
                'module.exports = { jira: { project: "DEMO" } };'
        });
        var config = cl.loadProjectConfig({ agentConfigsDir: 'projects/demo' });
        assert.equal(config.jira.project, 'DEMO');
        assert.equal(config._configPath, 'projects/demo/.dmtools/config.js');
    });

    test('agentConfigsDir convention is skipped when an earlier source already loaded config', function() {
        var paths = [];
        var loader = loadModule(
            'js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            {
                file_read: function(opts) {
                    paths.push(opts.path);
                    if (opts.path === 'top.js') {
                        return 'module.exports = { jira: { project: "TOP" } };';
                    }
                    return null;
                }
            }
        );
        var config = loader.loadProjectConfig({ configPath: 'top.js', agentConfigsDir: 'projects/demo' });
        assert.equal(config.jira.project, 'TOP');
        assert.equal(paths.indexOf('projects/demo/.dmtools/config.js'), -1, 'agentConfigsDir probe skipped');
    });

    test('baseBranchResolverFnPath with an unreadable hook file keeps the candidate baseBranch', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { baseBranchResolverFnPath: "./.dmtools/missing.js" } };'
        });
        var config = cl.loadProjectConfig({ ticket: { key: 'PROJ-1' } });
        assert.equal(config.git.baseBranch, 'main');
    });

    test('baseBranchResolverFnPath resolver returning a falsy value keeps the candidate baseBranch', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { baseBranchResolverFnPath: "./.dmtools/resolver.js" } };',
            './.dmtools/resolver.js':
                'module.exports = function() { return null; };'
        });
        var config = cl.loadProjectConfig({ ticket: { key: 'PROJ-1' } });
        assert.equal(config.git.baseBranch, 'main');
    });

    test('baseBranchResolverFnPath throwing resolver keeps the candidate baseBranch and warns', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { baseBranchResolverFnPath: "./.dmtools/resolver.js" } };',
            './.dmtools/resolver.js':
                'module.exports = function() { throw new Error("boom"); };'
        });
        var config = cl.loadProjectConfig({ ticket: { key: 'PROJ-1' } });
        assert.equal(config.git.baseBranch, 'main');
    });

    test('snapshotBranchResolverFnPath throwing resolver keeps the candidate snapshotBranch and warns', function() {
        var cl = makeLoader({
            '.dmtools/config.js':
                'module.exports = { git: { snapshotBranchResolverFnPath: "./.dmtools/resolver.js" } };',
            './.dmtools/resolver.js':
                'module.exports = function() { throw new Error("boom"); };'
        });
        var config = cl.loadProjectConfig({ ticket: { key: 'PROJ-1' } });
        assert.equal(config.git.snapshotBranch, '', 'snapshotBranch left at its default');
        assert.equal(config.git.baseBranch, 'main', 'baseBranch untouched');
    });

    test('targetRepository with only some fields applies only the provided ones', function() {
        var cl = makeLoader({});
        var config = cl.loadProjectConfig({
            customParams: { targetRepository: { owner: 'partial-org' } }
        });
        assert.equal(config.repository.owner, 'partial-org');
        assert.equal(config.repository.repo, '');
        assert.equal(config.git.baseBranch, 'main', 'baseBranch untouched');
        assert.equal(config.workingDir, undefined, 'workingDir untouched');
    });

    test('scmProvider customParam overrides config.scm.provider', function() {
        var cl = makeLoader({});
        var config = cl.loadProjectConfig({ customParams: { scmProvider: 'gitlab' } });
        assert.equal(config.scm.provider, 'gitlab');
    });

    test('loads prSearchFn from customParams.prSearchFnPath', function() {
        var cl = makeLoader({
            '.dmtools/prSearch/custom.js':
                'module.exports = function(candidates, ticketKey, options) { return candidates[0]; };'
        });
        var config = cl.loadProjectConfig({
            customParams: { prSearchFnPath: '.dmtools/prSearch/custom.js' }
        });
        assert.equal(typeof config.prSearchFn, 'function');
    });

    test('ignores prSearchFnPath that does not export a function', function() {
        var cl = makeLoader({
            '.dmtools/prSearch/bad.js': 'module.exports = { foo: 1 };'
        });
        var config = cl.loadProjectConfig({
            customParams: { prSearchFnPath: '.dmtools/prSearch/bad.js' }
        });
        assert.ok(!config.prSearchFn, 'prSearchFn must not be set when file does not export a function');
    });

});

// ── resolveConfluenceUrls ─────────────────────────────────────────────────────

suite('configLoader.resolveConfluenceUrls', function() {

    var defaults = configLoaderModule.DEFAULTS;

    test('replaces a known default URL with project override', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            confluence: {
                templateStory: 'https://my-confluence/pages/999/My+Story+Template'
            }
        });
        var result = configLoaderModule.resolveConfluenceUrls(
            [defaults.confluence.templateStory, 'some other instruction'],
            config
        );
        assert.equal(result[0], 'https://my-confluence/pages/999/My+Story+Template');
        assert.equal(result[1], 'some other instruction', 'non-URL items unchanged');
    });

    test('does not replace URLs when no override provided', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {});
        var original = [defaults.confluence.templateJiraMarkdown, './local-file.md'];
        var result = configLoaderModule.resolveConfluenceUrls(original, config);
        assert.equal(result[0], defaults.confluence.templateJiraMarkdown);
        assert.equal(result[1], './local-file.md');
    });

    test('handles null array gracefully', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {});
        var result = configLoaderModule.resolveConfluenceUrls(null, config);
        assert.equal(result, null);
    });

    test('leaves unknown URLs unchanged', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {});
        var unknown = 'https://other-wiki/pages/123/SomePage';
        var result = configLoaderModule.resolveConfluenceUrls([unknown], config);
        assert.equal(result[0], unknown);
    });

});

// ── resolveInstructions ───────────────────────────────────────────────────────

suite('configLoader.resolveInstructions', function() {

    var defaults = configLoaderModule.DEFAULTS;

    test('returns defaults when no overrides configured', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {});
        var defaultInstructions = ['./agents/instructions/default.md', 'some text'];
        var result = configLoaderModule.resolveInstructions('story_development', defaultInstructions, config);
        assert.deepEqual(result.instructions, defaultInstructions);
        assert.equal(result.instructionsOverridden, false);
        assert.deepEqual(result.additionalInstructions, []);
    });

    test('applies instructionOverrides — full replacement', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            instructionOverrides: {
                story_development: ['./custom/dev-instructions.md']
            }
        });
        var result = configLoaderModule.resolveInstructions(
            'story_development',
            ['./original/instructions.md'],
            config
        );
        assert.deepEqual(result.instructions, ['./custom/dev-instructions.md']);
        assert.equal(result.instructionsOverridden, true);
    });

    test('applies additionalInstructions — appended separately', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            additionalInstructions: {
                bug_development: ['https://my-confluence/pages/42/Bug+Guidelines']
            }
        });
        var result = configLoaderModule.resolveInstructions(
            'bug_development',
            ['./base.md'],
            config
        );
        assert.deepEqual(result.instructions, ['./base.md']);
        assert.deepEqual(result.additionalInstructions, ['https://my-confluence/pages/42/Bug+Guidelines']);
    });

    test('instructionOverrides does not affect additionalInstructions', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            instructionOverrides: { story_development: ['./override.md'] },
            additionalInstructions: { story_development: ['./extra.md'] }
        });
        var result = configLoaderModule.resolveInstructions('story_development', ['./base.md'], config);
        assert.deepEqual(result.instructions, ['./override.md']);
        assert.deepEqual(result.additionalInstructions, ['./extra.md']);
    });

    test('resolves cliPrompts and cliPromptOverrides separately', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            cliPrompts: {
                story_development: ['./.dmtools/prompts/role.md', './.dmtools/prompts/focus.md']
            },
            cliPromptOverrides: {
                story_development: './.dmtools/prompts/main.md'
            }
        });
        var result = configLoaderModule.resolveInstructions('story_development', ['./base.md'], config);
        assert.deepEqual(result.instructions, ['./base.md']);
        assert.deepEqual(result.cliPrompts, ['./.dmtools/prompts/role.md', './.dmtools/prompts/focus.md']);
        assert.equal(result.cliPrompt, './.dmtools/prompts/main.md');
    });

    test('resolves agentParamPatches per agent', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            agentParamPatches: {
                story_development: {
                    aiRole: 'Senior Engineer',
                    instructions: ['./custom.md']
                }
            }
        });
        var result = configLoaderModule.resolveInstructions('story_development', ['./base.md'], config);
        assert.deepEqual(result.agentParamPatch, {
            aiRole: 'Senior Engineer',
            instructions: ['./custom.md']
        });
    });

    test('resolves jobParamPatches per agent', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            jobParamPatches: {
                test_cases_generator: {
                    confluencePages: ['./.dmtools/instructions/test_cases/project_rules.md'],
                    isGenerateNew: true
                }
            }
        });
        var result = configLoaderModule.resolveInstructions('test_cases_generator', [], config);
        assert.deepEqual(result.jobParamPatch, {
            confluencePages: ['./.dmtools/instructions/test_cases/project_rules.md'],
            isGenerateNew: true
        });
    });

    test('agent not in overrides returns default + empty additional', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            instructionOverrides: { other_agent: ['./other.md'] }
        });
        var base = ['./base.md'];
        var result = configLoaderModule.resolveInstructions('story_development', base, config);
        assert.deepEqual(result.instructions, base);
        assert.equal(result.instructionsOverridden, false);
        assert.deepEqual(result.additionalInstructions, []);
    });

    test('applies cliPromptsByTracker for matching tracker type', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            cliPrompts: {
                story_questions: ['./base.md']
            },
            cliPromptsByTracker: {
                jira: {
                    story_questions: ['./jira-specific.md']
                }
            }
        });
        // Mock DEFAULT_TRACKER env var by temporarily overriding java.lang.System.getenv
        var originalGetenv = java.lang.System.getenv;
        java.lang.System.getenv = function(key) {
            if (key === 'DEFAULT_TRACKER') return 'jira';
            return originalGetenv(key);
        };
        try {
            var result = configLoaderModule.resolveInstructions('story_questions', [], config);
            assert.deepEqual(result.cliPrompts, ['./base.md', './jira-specific.md']);
        } finally {
            java.lang.System.getenv = originalGetenv;
        }
    });

    test('applies cliPromptsByTracker flat array structure (agent JSON style)', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            cliPrompts: {
                story_questions: ['./base.md']
            },
            cliPromptsByTracker: {
                jira: ['./jira-flat.md']
            }
        });
        var originalGetenv = java.lang.System.getenv;
        java.lang.System.getenv = function(key) {
            if (key === 'DEFAULT_TRACKER') return 'jira';
            return originalGetenv(key);
        };
        try {
            var result = configLoaderModule.resolveInstructions('story_questions', [], config);
            assert.deepEqual(result.cliPrompts, ['./base.md', './jira-flat.md']);
        } finally {
            java.lang.System.getenv = originalGetenv;
        }
    });

    test('ignores cliPromptsByTracker when tracker type does not match', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            cliPrompts: {
                story_questions: ['./base.md']
            },
            cliPromptsByTracker: {
                ado: {
                    story_questions: ['./ado-specific.md']
                }
            }
        });
        var originalGetenv = java.lang.System.getenv;
        java.lang.System.getenv = function(key) {
            if (key === 'DEFAULT_TRACKER') return 'jira';
            return originalGetenv(key);
        };
        try {
            var result = configLoaderModule.resolveInstructions('story_questions', [], config);
            assert.deepEqual(result.cliPrompts, ['./base.md']);
        } finally {
            java.lang.System.getenv = originalGetenv;
        }
    });

    test('cliPrompts array format returns merge strategy by default', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            cliPrompts: { my_agent: ['./a.md', './b.md'] }
        });
        var result = configLoaderModule.resolveInstructions('my_agent', [], config);
        assert.deepEqual(result.cliPrompts, ['./a.md', './b.md']);
        assert.equal(result.cliPromptsStrategy, 'merge');
    });

    test('cliPrompts object format with strategy:merge is treated same as array', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            cliPrompts: {
                my_agent: { strategy: 'merge', prompts: ['./a.md', './b.md'] }
            }
        });
        var result = configLoaderModule.resolveInstructions('my_agent', [], config);
        assert.deepEqual(result.cliPrompts, ['./a.md', './b.md']);
        assert.equal(result.cliPromptsStrategy, 'merge');
    });

    test('cliPrompts object format with strategy:replace returns replace strategy', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            cliPrompts: {
                my_agent: { strategy: 'replace', prompts: ['./override.md'] }
            }
        });
        var result = configLoaderModule.resolveInstructions('my_agent', [], config);
        assert.deepEqual(result.cliPrompts, ['./override.md']);
        assert.equal(result.cliPromptsStrategy, 'replace');
    });

    test('trackerOverride switches cliPromptsByTracker selection regardless of DEFAULT_TRACKER', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            cliPrompts: {
                story_solution: ['./base.md']
            }
        });
        var agentByTracker = {
            jira: ['./jira-markup.md'],
            confluence: ['./confluence-markup.md']
        };
        var originalGetenv = java.lang.System.getenv;
        java.lang.System.getenv = function(key) {
            if (key === 'DEFAULT_TRACKER') return 'jira';
            return originalGetenv(key);
        };
        try {
            var result = configLoaderModule.resolveInstructions('story_solution', [], config, agentByTracker,
                { trackerOverride: 'confluence' });
            assert.deepEqual(result.cliPrompts, ['./base.md', './confluence-markup.md']);
        } finally {
            java.lang.System.getenv = originalGetenv;
        }
    });

    test('trackerOverride picks confluence prompts from project config when agent JSON lacks them', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            cliPromptsByTracker: {
                confluence: ['./config-confluence.md']
            }
        });
        var agentByTracker = {
            jira: ['./jira-markup.md']
        };
        var originalGetenv = java.lang.System.getenv;
        java.lang.System.getenv = function(key) {
            if (key === 'DEFAULT_TRACKER') return 'jira';
            return originalGetenv(key);
        };
        try {
            var result = configLoaderModule.resolveInstructions('story_solution', [], config, agentByTracker,
                { trackerOverride: 'confluence' });
            assert.deepEqual(result.cliPrompts, ['./config-confluence.md']);
        } finally {
            java.lang.System.getenv = originalGetenv;
        }
    });

    test('without trackerOverride the configured tracker is used (unchanged behavior)', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {});
        var agentByTracker = {
            jira: ['./jira-markup.md'],
            confluence: ['./confluence-markup.md']
        };
        var originalGetenv = java.lang.System.getenv;
        java.lang.System.getenv = function(key) {
            if (key === 'DEFAULT_TRACKER') return 'jira';
            return originalGetenv(key);
        };
        try {
            var result = configLoaderModule.resolveInstructions('story_solution', [], config, agentByTracker);
            assert.deepEqual(result.cliPrompts, ['./jira-markup.md']);
        } finally {
            java.lang.System.getenv = originalGetenv;
        }
    });

});



suite('configLoader.loadProjectConfig top-level configPath', function() {

    test('loads config from params.configPath (top-level, no customParams wrapper)', function() {
        var mockRead = function(opts) {
            if (opts.path === 'custom/path/my-config.js') {
                return 'module.exports = { jira: { project: "TOPLEVEL" }, repository: { owner: "top-org", repo: "top-repo" } };';
            }
            return null;
        };
        var loader = loadModule('js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            { file_read: mockRead }
        );

        var config = loader.loadProjectConfig({ configPath: 'custom/path/my-config.js' });
        assert.equal(config.jira.project, 'TOPLEVEL', 'project loaded from top-level configPath');
        assert.equal(config.repository.owner, 'top-org', 'owner loaded');
        assert.equal(config._configPath, 'custom/path/my-config.js', '_configPath stored');
    });

    test('top-level configPath takes priority over customParams.configPath', function() {
        var mockRead = function(opts) {
            if (opts.path === 'top.js') {
                return 'module.exports = { jira: { project: "TOP" } };';
            }
            if (opts.path === 'custom.js') {
                return 'module.exports = { jira: { project: "CUSTOM" } };';
            }
            return null;
        };
        var loader = loadModule('js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            { file_read: mockRead }
        );

        var config = loader.loadProjectConfig({
            configPath: 'top.js',
            customParams: { configPath: 'custom.js' }
        });
        assert.equal(config.jira.project, 'TOP', 'top-level configPath wins');
    });

    test('_configPath is stored for discovered paths (not just explicit)', function() {
        var mockRead = function(opts) {
            if (opts.path === '.dmtools/config.js') {
                return 'module.exports = { jira: { project: "DISC" } };';
            }
            return null;
        };
        var loader = loadModule('js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            { file_read: mockRead }
        );

        var config = loader.loadProjectConfig({});
        assert.equal(config.jira.project, 'DISC', 'discovered config loaded');
        assert.equal(config._configPath, '.dmtools/config.js', '_configPath set for discovered path');
    });

    test('_configPath is undefined when using defaults (no config file found)', function() {
        var loader = loadModule('js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            { file_read: function() { return null; } }
        );

        var config = loader.loadProjectConfig({});
        assert.notOk(config._configPath, '_configPath absent when no config file');
    });

});

// ── testCaseIssueType in config ───────────────────────────────────────────────

suite('configLoader: testCaseIssueType', function() {

    test('defaults include TEST_CASE issue type', function() {
        assert.equal(configLoaderModule.DEFAULTS.jira.issueTypes.TEST_CASE, 'Test Case');
    });

    test('config.js ISSUE_TYPES includes TEST_CASE', function() {
        assert.equal(configModule.ISSUE_TYPES.TEST_CASE, 'Test Case');
    });

    test('custom testCaseIssueType survives mergeProjectConfig merge', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            jira: {
                issueTypes: {
                    TEST_CASE: 'XRay Test',
                    BUG: 'Bug',
                    STORY: 'Story'
                }
            }
        });
        assert.equal(config.jira.issueTypes.TEST_CASE, 'XRay Test', 'custom TEST_CASE applied');
        assert.equal(config.jira.issueTypes.BUG, 'Bug', 'BUG preserved');
    });

    test('merged config issueTypes used in JQL interpolation pattern', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            jira: {
                issueTypes: { TEST_CASE: 'XRay Test', BUG: 'Bug', STORY: 'Story', TASK: 'Task', SUBTASK: 'Subtask', EPIC: 'Epic' }
            }
        });
        var jql = 'issuetype = "' + config.jira.issueTypes.TEST_CASE + '" AND project = "PROJ"';
        assert.contains(jql, 'XRay Test', 'custom issueType used in JQL string');
    });

});

// ── jira.questions config ─────────────────────────────────────────────────────

suite('configLoader: jira.questions', function() {

    test('DEFAULTS include jira.questions with fetchJql and answerField', function() {
        var q = configLoaderModule.DEFAULTS.jira.questions;
        assert.ok(q, 'jira.questions exists in DEFAULTS');
        assert.ok(q.fetchJql, 'fetchJql is set');
        assert.ok(q.fetchJql.indexOf('{ticketKey}') !== -1, 'fetchJql contains {ticketKey} placeholder');
        assert.equal(q.answerField, 'Answer', 'default answerField is Answer');
    });

    test('default fetchJql targets Subtask issuetype', function() {
        assert.ok(
            configLoaderModule.DEFAULTS.jira.questions.fetchJql.indexOf('Subtask') !== -1,
            'default JQL uses Subtask'
        );
    });

    test('jira.questions is fully replaced when overridden', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            jira: {
                questions: {
                    fetchJql: 'parent = {ticketKey} AND issuetype = "Question"',
                    answerField: 'CustomAnswer'
                }
            }
        });
        assert.equal(config.jira.questions.fetchJql, 'parent = {ticketKey} AND issuetype = "Question"', 'fetchJql replaced');
        assert.equal(config.jira.questions.answerField, 'CustomAnswer', 'answerField replaced');
    });

    test('jira.questions stays as defaults when not overridden', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            jira: { project: 'PROJ' }
        });
        assert.equal(config.jira.questions.answerField, 'Answer', 'answerField unchanged');
        assert.ok(config.jira.questions.fetchJql.indexOf('{ticketKey}') !== -1, 'fetchJql unchanged');
    });

    test('BA_ANALYSIS is in default statuses', function() {
        assert.equal(configLoaderModule.DEFAULTS.jira.statuses.BA_ANALYSIS, 'BA Analysis');
    });

    test('BA_ANALYSIS can be overridden via statuses replacement', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            jira: {
                statuses: { BA_ANALYSIS: 'Analysis', PO_REVIEW: 'PO Review', DONE: 'Done' }
            }
        });
        assert.equal(config.jira.statuses.BA_ANALYSIS, 'Analysis', 'custom BA_ANALYSIS applied');
    });

    test('{ticketKey} placeholder in fetchJql is replaced at call site', function() {
        var jql = configLoaderModule.DEFAULTS.jira.questions.fetchJql.replace('{ticketKey}', 'PROJ-42');
        assert.ok(jql.indexOf('PROJ-42') !== -1, 'ticketKey injected');
        assert.ok(jql.indexOf('{ticketKey}') === -1, 'placeholder removed');
    });

});

// ── loadHookFn ─────────────────────────────────────────────────────────────

function makeIsolatedConfigLoaderForHooks(fileMap) {
    var fr = function(opts) {
        var p = opts && (opts.path || opts);
        if (fileMap && fileMap[p] !== undefined) return fileMap[p];
        // Block all config discovery to prevent loading a real parent .dmtools/config.js
        if (p && p.indexOf('.dmtools/config') !== -1) return null;
        return null;
    };
    return loadModule('js/configLoader.js', makeRequire({ './config.js': configModule }), { file_read: fr });
}

suite('configLoader.loadHookFn', function() {

    test('returns null without reading anything when path is falsy', function() {
        var cl = makeIsolatedConfigLoaderForHooks({});
        assert.equal(cl.loadHookFn(null, 'branchCreateFnPath'), null);
        assert.equal(cl.loadHookFn('', 'branchCreateFnPath'), null);
    });

    test('returns null when the file does not exist', function() {
        var cl = makeIsolatedConfigLoaderForHooks({});
        var result = cl.loadHookFn('.dmtools/branchNaming/missing.js', 'branchCreateFnPath');
        assert.equal(result, null);
    });

    test('returns null when the file does not export a function', function() {
        var cl = makeIsolatedConfigLoaderForHooks({
            '.dmtools/branchNaming/not_a_fn.js': 'module.exports = { foo: 1 };'
        });
        var result = cl.loadHookFn('.dmtools/branchNaming/not_a_fn.js', 'branchCreateFnPath');
        assert.equal(result, null);
    });

    test('returns the exported function and it is callable', function() {
        var cl = makeIsolatedConfigLoaderForHooks({
            '.dmtools/branchNaming/create.js': 'module.exports = function(ctx) { return "created:" + ctx.branchName; };'
        });
        var fn = cl.loadHookFn('.dmtools/branchNaming/create.js', 'branchCreateFnPath');
        assert.equal(typeof fn, 'function');
        assert.equal(fn({ branchName: 'release/rc_mobile_proj-1' }), 'created:release/rc_mobile_proj-1');
    });

});

// ── loadCustomParamFnHook ────────────────────────────────────────────────────

suite('configLoader.loadCustomParamFnHook', function() {

    test('installs the exported function on the target under exportKey', function() {
        var cl = makeIsolatedConfigLoaderForHooks({
            '.dmtools/branchNaming/naming.js': 'module.exports = function(ticket, role, config) { return "ai/" + ticket; };'
        });
        var target = {};
        cl.loadCustomParamFnHook(target, '.dmtools/branchNaming/naming.js', 'branchNamingFnPath', 'branchNamingFn');
        assert.equal(typeof target.branchNamingFn, 'function');
        assert.equal(target.branchNamingFn('gh-1'), 'ai/gh-1');
    });

    test('returns without loading when the path is falsy', function() {
        var cl = makeIsolatedConfigLoaderForHooks({});
        var target = {};
        cl.loadCustomParamFnHook(target, undefined, 'branchNamingFnPath', 'branchNamingFn');
        cl.loadCustomParamFnHook(target, '', 'prSearchFnPath', 'prSearchFn');
        assert.deepEqual(target, {});
    });

    test('warns and ignores when the file does not export a function', function() {
        var cl = makeIsolatedConfigLoaderForHooks({
            '.dmtools/prSearch/not_a_fn.js': 'module.exports = 42;'
        });
        var target = {};
        cl.loadCustomParamFnHook(target, '.dmtools/prSearch/not_a_fn.js', 'prSearchFnPath', 'prSearchFn');
        assert.equal(target.prSearchFn, undefined);
    });

});

// ── agentDocGenerator static-analysis contract (docs-freshness) ──────────────

suite('configLoader customParams visibility for agentDocGenerator', function() {

    // js/agentDocGenerator.js discovers supported customParams keys with two
    // literal-access regexes; a dynamic customParams[key] read is invisible to
    // them and silently drops keys from every generated agent doc (red
    // docs-freshness CI). Pin the two hook keys as literal member reads here.
    function discoverCustomParamsKeys(src) {
        var found = [];
        var seen = {};
        var patterns = [
            /customParams\.([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/g,
            /customParams\[['"]([\w.]+)['"]\]/g
        ];
        patterns.forEach(function(re) {
            var match;
            while ((match = re.exec(src)) !== null) {
                if (!seen[match[1]]) {
                    seen[match[1]] = true;
                    found.push(match[1]);
                }
            }
        });
        return found.sort();
    }

    test('configLoader.js keeps branchNamingFnPath and prSearchFnPath statically visible', function() {
        var src = file_read({ path: 'js/configLoader.js' });
        var keys = discoverCustomParamsKeys(src);
        assert.ok(keys.indexOf('branchNamingFnPath') !== -1,
            'branchNamingFnPath must be discoverable by agentDocGenerator literal regexes, got: ' + keys.join(', '));
        assert.ok(keys.indexOf('prSearchFnPath') !== -1,
            'prSearchFnPath must be discoverable by agentDocGenerator literal regexes, got: ' + keys.join(', '));
    });
});

// ── {status.KEY[:Literal]} placeholders (agents#855) ──────────────────────────

suite('configLoader.interpolateJql — status placeholders (agents#855)', function() {

    function cfg(statuses, useConfigured) {
        return { jira: { project: 'PRJ', parentTicket: 'PRJ-1', statuses: statuses || {}, useConfiguredStatusesInQueries: useConfigured } };
    }

    test('{status.KEY:Literal} resolves to the Literal by default — existing deployments send the same JQL', function() {
        var jql = "project = {jiraProject} AND status in ('{status.PO_REVIEW:PO Review}')";
        assert.equal(configLoaderModule.interpolateJql(jql, cfg({ PO_REVIEW: 'PO REVIEW' })),
            "project = PRJ AND status in ('PO Review')");
    });

    test('even with jira.statuses overridden, the Literal wins unless the project opted in', function() {
        var jql = "status in ('{status.PO_REVIEW:PO Review}')";
        assert.equal(configLoaderModule.interpolateJql(jql, cfg({ PO_REVIEW: 'Active' })), "status in ('PO Review')");
    });

    test('opt-in (useConfiguredStatusesInQueries): the configured status replaces the Literal', function() {
        var jql = "status in ('{status.PO_REVIEW:PO Review}')";
        assert.equal(configLoaderModule.interpolateJql(jql, cfg({ PO_REVIEW: 'Active' }, true)), "status in ('Active')");
    });

    test('opt-in with no configured value for the key still falls back to the Literal', function() {
        assert.equal(configLoaderModule.interpolateJql("status = '{status.NOPE:Fallback}'", cfg({}, true)), "status = 'Fallback'");
    });

    test('{status.KEY} without a Literal always uses the configured value; unknown key is left as is', function() {
        assert.equal(configLoaderModule.interpolateJql("status = '{status.DONE}'", cfg({ DONE: 'Closed' })), "status = 'Closed'");
        assert.equal(configLoaderModule.interpolateJql("status = '{status.UNKNOWN}'", cfg({})), "status = '{status.UNKNOWN}'");
    });

    test('single quotes inside a configured value are escaped for the quoted position', function() {
        assert.equal(configLoaderModule.interpolateJql("status = '{status.X:a}'", cfg({ X: "Won't Fix" }, true)), "status = 'Won\\'t Fix'");
    });

    test('several placeholders and {jiraProject} resolve together; JQL without placeholders is untouched', function() {
        var jql = "project = {jiraProject} AND status in ('{status.IN_REVIEW_PASSED:In Review - Passed}', '{status.IN_REVIEW_FAILED:In Review - Failed}')";
        assert.equal(configLoaderModule.interpolateJql(jql, cfg({})),
            "project = PRJ AND status in ('In Review - Passed', 'In Review - Failed')");
        assert.equal(configLoaderModule.interpolateJql("status = 'Done'", cfg({ DONE: 'X' }, true)), "status = 'Done'");
    });
});

suite('shipped SM rules: placeholder JQL resolves to the previous literal JQL (agents#855)', function() {

    var defaults = { jira: { project: 'PRJ', parentTicket: 'PRJ-1', statuses: configModule.STATUSES } };

    ['sm.json', 'sm_merge.json'].forEach(function(file) {
        test(file + ': with default configuration every rule queries exactly what it queried before', function() {
            var rules = JSON.parse(file_read({ path: file })).params.jobParams.rules;
            var literalCount = 0;
            rules.forEach(function(r) {
                if (!r.jql) return;
                var resolved = configLoaderModule.interpolateJql(r.jql, defaults);
                assert.equal(resolved.indexOf('{status.'), -1, 'unresolved placeholder in: ' + resolved);
                if (r.jql.indexOf('{status.') !== -1) literalCount++;
            });
            assert.ok(literalCount > 0, 'expected rules to use status placeholders');
        });

        test(file + ': overriding jira.statuses + opting in changes the queries, nothing stays on the old literal', function() {
            var rules = JSON.parse(file_read({ path: file })).params.jobParams.rules;
            var statuses = {};
            Object.keys(configModule.STATUSES).forEach(function(k) { statuses[k] = 'X_' + k; });
            var cfg = { jira: { project: 'PRJ', parentTicket: '', statuses: statuses, useConfiguredStatusesInQueries: true } };
            rules.forEach(function(r) {
                if (!r.jql || r.jql.indexOf('{status.') === -1) return;
                var resolved = configLoaderModule.interpolateJql(r.jql, cfg);
                assert.ok(resolved.indexOf('X_') !== -1, 'override not applied: ' + resolved);
            });
        });
    });
});

// ── {stage.KEY[:Literal]} status-or-label clause, jqlByTracker, quoting (agents#855/#856) ─────────

suite('configLoader — stage placeholders, per-tracker queries and quoting (agents#855)', function() {

    function cfg(extra) {
        var jira = { project: 'PRJ', parentTicket: '', statuses: configModule.STATUSES };
        Object.keys(extra || {}).forEach(function(k) { jira[k] = extra[k]; });
        return { jira: jira };
    }
    var STAGE = "project = {jiraProject} AND issuetype in ('Story') AND {stage.PO_REVIEW:PO Review}";

    test('default (stageFallback off): the stage clause is the plain status clause the rule always had', function() {
        assert.equal(configLoaderModule.interpolateJql(STAGE, cfg()),
            "project = PRJ AND issuetype in ('Story') AND status in ('PO Review')");
    });

    test('stageFallback=label on Jira: status OR the stage label', function() {
        assert.equal(configLoaderModule.interpolateJql(STAGE, cfg({ stageFallback: 'label' }), 'jira'),
            "project = PRJ AND issuetype in ('Story') AND (status in ('PO Review') OR labels = 'stage_po_review')");
    });

    test('stageFallback=label on Azure DevOps: native WIQL System.State / System.Tags', function() {
        assert.equal(configLoaderModule.interpolateJql("{stage.PO_REVIEW:PO Review}", cfg({ stageFallback: 'label' }), 'ado'),
            "([System.State] IN ('PO Review') OR [System.Tags] CONTAINS 'stage_po_review')");
        assert.equal(configLoaderModule.interpolateJql("{stage.PO_REVIEW:PO Review}", cfg(), 'ado'),
            "[System.State] IN ('PO Review')");
    });

    test('the stage clause follows an opted-in jira.statuses override', function() {
        var c = cfg({ stageFallback: 'label', useConfiguredStatusesInQueries: true });
        c.jira.statuses = Object.assign({}, configModule.STATUSES, { PO_REVIEW: 'Active' });
        assert.equal(configLoaderModule.interpolateJql("{stage.PO_REVIEW:PO Review}", c, 'jira'),
            "(status in ('Active') OR labels = 'stage_po_review')");
    });

    test('the label name is the same one the tracker writes (shared stageLabel)', function() {
        assert.equal(configModule.stageLabel('PO_REVIEW'), 'stage_po_review');
        assert.equal(configModule.stageLabel('In Review - Passed'), 'stage_in_review_passed');
        assert.ok(configLoaderModule.interpolateJql("{stage.IN_REVIEW_PASSED:In Review - Passed}", cfg({ stageFallback: 'label' }), 'jira')
            .indexOf("labels = 'stage_in_review_passed'") !== -1);
    });

    test('unknown stage key with no literal is left untouched', function() {
        assert.equal(configLoaderModule.interpolateJql("x {stage.NOPE} y", cfg()), "x {stage.NOPE} y");
    });

    test('selectRuleQuery: jqlByTracker[provider] wins, everything else uses rule.jql', function() {
        var rule = { jql: 'JQL', jqlByTracker: { ado: 'SELECT [System.Id] FROM WorkItems' } };
        assert.equal(configLoaderModule.selectRuleQuery(rule, 'ado'), 'SELECT [System.Id] FROM WorkItems');
        assert.equal(configLoaderModule.selectRuleQuery(rule, 'ADO'), 'SELECT [System.Id] FROM WorkItems');
        assert.equal(configLoaderModule.selectRuleQuery(rule, 'jira'), 'JQL');
        assert.equal(configLoaderModule.selectRuleQuery(rule, null), 'JQL');
        assert.equal(configLoaderModule.selectRuleQuery({ jql: 'JQL' }, 'ado'), 'JQL');
        assert.equal(configLoaderModule.selectRuleQuery({ jql: 'JQL', jqlByTracker: { ado: '' } }, 'ado'), 'JQL');
        assert.equal(configLoaderModule.selectRuleQuery(null, 'ado'), null);
    });

    test('unquoted position: a plain word stays bare (default identical to the old literal), anything else is quoted', function() {
        assert.equal(configLoaderModule.interpolateJql("status not in ({status.DONE:Done})", cfg()), "status not in (Done)");
        assert.equal(configLoaderModule.interpolateJql("status not in ({status.DONE:Done})",
            cfg({ useConfiguredStatusesInQueries: true, statuses: { DONE: 'Won Fix' } })), 'status not in ("Won Fix")');
        assert.equal(configLoaderModule.interpolateJql("status = {status.FAILED:Failed}", cfg()), "status = Failed");
    });

    test('quoted position: a double-quoted template escapes double quotes only', function() {
        assert.equal(configLoaderModule.interpolateJql('status = "{status.X:a}"', cfg({ useConfiguredStatusesInQueries: true, statuses: { X: 'say "hi"' } })),
            'status = "say \\"hi\\""');
    });

    test('SM rules: every tag-only-status gate uses the stage clause (gh-916); dev-flow gates keep {status.*}', function() {
        var rules = JSON.parse(file_read({ path: 'sm.json' })).params.jobParams.rules;
        var withStage = rules.filter(function(r) { return (r.jql || '').indexOf('{stage.') !== -1; });
        var withPlainStatus = rules.filter(function(r) {
            return (r.jql || '').indexOf('{status.') !== -1;
        });
        // gh-916: the test-automation gates (FAILED, IN_REVIEW_PASSED/FAILED, IN_TESTING,
        // MERGED, READY_FOR_TESTING, BUG_TO_FIX) are stage clauses; PO Review was already one.
        assert.equal(withStage.length, 17);
        var stageKeys = {};
        withStage.forEach(function(r) {
            (r.jql.match(/\{stage\.([A-Z0-9_]+)/g) || []).forEach(function(m) {
                stageKeys[m.replace('{stage.', '')] = true;
            });
        });
        assert.deepEqual(Object.keys(stageKeys).sort(), [
            'BUG_TO_FIX', 'FAILED', 'IN_REVIEW_FAILED', 'IN_REVIEW_PASSED',
            'IN_TESTING', 'MERGED', 'PO_REVIEW', 'READY_FOR_TESTING'
        ]);
        // dev-flow statuses exist in every supported workflow — plain {status.*} clauses
        withPlainStatus.forEach(function(r) {
            assert.equal((r.jql.match(/\{status\.(FAILED|MERGED|IN_TESTING|READY_FOR_TESTING|BUG_TO_FIX|IN_REVIEW_PASSED|IN_REVIEW_FAILED)[:}]/g) || []).length, 0,
                'rule with a tag-only status must use {stage.*}: ' + r.configFile);
        });
        // default ('none') config: byte-identical to the previous status clause
        var poReview = withStage.filter(function(r) { return r.configFile === 'agents/story_ba_check.json'; })[0];
        assert.equal(configLoaderModule.interpolateJql(poReview.jql, cfg()),
            "project = PRJ AND issuetype in ('Story') AND status in ('PO Review')");
        var mergedStory = withStage.filter(function(r) { return r.configFile === 'agents/test_cases_generator.json'; })[0];
        assert.equal(configLoaderModule.interpolateJql(mergedStory.jql, cfg()),
            "project = PRJ AND issuetype in ('Story') AND status in ('Merged')");
    });
});

suite('smAgent builds every rule query through selectRuleQuery (agents#855)', function() {
    test('both rule processors pick the per-tracker query and pass the provider to interpolateJql', function() {
        var src = file_read({ path: 'js/smAgent.js' });
        var uses = src.split('configLoader.selectRuleQuery(rule, ruleTrackerProvider)').length - 1;
        assert.equal(uses, 2, 'expected the local and the dispatch rule processor to use selectRuleQuery');
        assert.equal(src.indexOf('configLoader.interpolateJql(rule.jql, effectiveConfig)'), -1,
            'a rule processor still interpolates rule.jql directly and would ignore jqlByTracker/{stage.*}');
    });
});

