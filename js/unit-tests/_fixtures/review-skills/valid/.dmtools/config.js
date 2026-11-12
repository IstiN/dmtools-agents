// Valid pool configuration (gh-1406 §3).
module.exports = {
    reviewPolicy: {
        reviewers: {
            legal: { isEnabled: true }
        },
        promptAppend: {
            base: ['.dmtools/review/base.append.md']
        }
    }
};
