/**
 * Telling reviewers that an access request is waiting.
 *
 * A request becomes reviewable when the visitor confirms their address, and
 * nothing said so: it sat in the queue until somebody happened to ask the API
 * for it. The people told are those who can approve it (users: full), with a
 * notification in the app and an email each.
 *
 * Anyone can make a request, so the emails are capped. Past MAX_EMAILED_PER_HOUR
 * requests in an hour (per process) reviewers are told in the app only, which
 * keeps a flood of sign-ups from becoming a flood of mail. The screen lists
 * every request whatever was sent.
 */
const { notify } = require('./notify');
const { sendAccessRequestAlert, requesterName, oneLine } = require('../utils/mail');

const KIND = 'accessRequests';
const MAX_EMAILED_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

let budget = { start: 0, emailed: 0 };

/** Whether this request may be emailed about, counting it if so. */
function takeEmailSlot(now = Date.now()) {
  if (now - budget.start >= HOUR_MS) budget = { start: now, emailed: 0 };
  if (budget.emailed >= MAX_EMAILED_PER_HOUR) return false;
  budget.emailed += 1;
  return true;
}

/** For tests: forget what has been counted. */
function resetEmailBudget() {
  budget = { start: 0, emailed: 0 };
}

/** The active users whose role can approve access. */
function findReviewers(prisma) {
  return prisma.user.findMany({
    where: { active: true, role: { permissions: { some: { module: 'users', level: 'full' } } } },
    select: { id: true, email: true, firstName: true },
  });
}

/**
 * Notify and email every reviewer about `request`. Each reviewer's failure is
 * their own: one bad address does not stop the others being told. Resolves to
 * what was done, and rejects only if the reviewers cannot be looked up.
 */
async function alertReviewers(prisma, request) {
  const reviewers = await findReviewers(prisma);
  if (!reviewers.length) return { reviewers: 0, notified: 0, emailed: 0 };

  const who = requesterName(request);
  const message = `${who}${request.company ? ` (${oneLine(request.company, 80)})` : ''} confirmed their email address and is waiting for review.`;

  const notified = await Promise.allSettled(reviewers.map(reviewer => notify(prisma, KIND, {
    userId: reviewer.id,
    title: 'New access request',
    message,
    recordModule: 'accessRequests',
    recordId: request.id,
  })));

  let emailed = 0;
  if (takeEmailSlot()) {
    const sent = await Promise.allSettled(reviewers.map(reviewer => sendAccessRequestAlert({
      to: reviewer.email, firstName: reviewer.firstName, request,
    })));
    emailed = sent.filter(result => result.status === 'fulfilled').length;
    sent.filter(result => result.status === 'rejected').forEach(result => console.error('[access-request-alert]', result.reason?.message));
  } else {
    console.warn(`[access-request-alert] more than ${MAX_EMAILED_PER_HOUR} requests in an hour: reviewers are told in the app only until the hour is up`);
  }
  notified.filter(result => result.status === 'rejected').forEach(result => console.error('[access-request-alert]', result.reason?.message));

  return { reviewers: reviewers.length, notified: notified.filter(result => result.status === 'fulfilled').length, emailed };
}

module.exports = { alertReviewers, findReviewers, resetEmailBudget, MAX_EMAILED_PER_HOUR, KIND };
