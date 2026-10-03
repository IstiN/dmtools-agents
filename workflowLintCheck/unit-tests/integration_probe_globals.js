function action() {
    var result = {
        hasGitlabListMrs: typeof gitlab_list_mrs !== 'undefined',
        hasGitlabGetMr: typeof gitlab_get_mr !== 'undefined',
        hasSourceCodeListPrs: typeof source_code_list_prs !== 'undefined',
        hasSourceCodeGetPr: typeof source_code_get_pr !== 'undefined',
        hasGithubListPrs: typeof github_list_prs !== 'undefined',
        hasAdoListPrs: typeof ado_list_prs !== 'undefined'
    };
    console.log('Global tool probe: ' + JSON.stringify(result, null, 2));
    return result;
}

