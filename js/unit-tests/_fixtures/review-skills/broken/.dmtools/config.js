// Broken pool configuration (gh-1406 §8 checks 5–7).
module.exports = {
    reviewPolicy: {
        reviewers: {
            ghost: { isEnabled: true }
        },
        promptAppend: {
            legal: ['.dmtools/review/missing.append.md']
        }
    }
};
