/**
 * A deal's forecast category from its probability. Creating a forecast and
 * the job that refreshes it both file deals by this rule.
 */
const categoryFor = probability => (probability >= 90 ? 'Commit' : probability >= 70 ? 'Best Case' : 'Pipeline');

module.exports = { categoryFor };
