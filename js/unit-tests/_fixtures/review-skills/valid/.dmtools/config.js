// Valid pool configuration (gh-1406 §3).
module.exports = {
    reviewPolicy: {
        required: ['base'],
        reviewers: {
            legal: { isEnabled: true }
        },
        promptAppend: {
            base: ['.dmtools/review/base.append.md']
        }
    }
};
