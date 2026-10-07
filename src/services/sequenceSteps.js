/**
 * Sending the due steps of email sequences, for the scheduled job
 * (jobs/scheduler processSequenceSteps) and for POST /api/sequences/process.
 * Each had its own copy of this loop, with the same two faults:
 *
 *  - A step counted as sent when the mail was only logged. With no SMTP server
 *    the mailer answers "queued" (it writes the message to the console), and
 *    the loop counted that as sent and moved every enrollment on, so a
 *    sequence ran to its end, in the CRM's own records, without one email
 *    leaving.
 *  - A send that failed moved the enrollment on anyway, so that step was lost
 *    for good.
 *
 * Now, with no mail configured nothing happens and the result says why. A step
 * is claimed before it is sent, by pushing its due time an hour ahead: two runs
 * at once cannot both send it, and a run that dies mid-send retries it in an
 * hour. A step that went out moves the enrollment on. One that failed stays
 * where it is and is tried again in an hour, and after three failures the
 * enrollment is marked Bounced (one of its documented statuses) so it stops.
 */
const { sendEmail } = require('./mailer');
const { logger } = require('./logger');
const { mailConfigured } = require('../utils/mail');
const { acquireLease, releaseLease } = require('../utils/lease');

const RETRY_AFTER_MS = 60 * 60 * 1000;
const MAX_FAILURES = 3;
const LEASE_NAME = 'sequence-steps';
const LEASE_TTL_MS = 15 * 60 * 1000;

/** A sequence's steps as a list, however they were stored. */
function stepsOf(sequence) {
  let steps = sequence.steps;
  if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch (err) { steps = []; } }
  return Array.isArray(steps) ? steps : [];
}

/** The enrollment's contact or lead, if still there, and their address. */
async function addressOf(prisma, enrollment) {
  const person = enrollment.contactId
    ? await prisma.contact.findFirst({ where: { id: enrollment.contactId, deletedAt: null }, select: { email: true } })
    : await prisma.lead.findFirst({ where: { id: enrollment.leadId || '', deletedAt: null }, select: { email: true } });
  return person?.email ? String(person.email).trim() : null;
}

/** Move an enrollment past the step just done: to the next, or to Completed. */
async function advance(prisma, enrollment, steps, tally) {
  const next = enrollment.currentStep + 1;
  if (next >= steps.length) {
    await prisma.emailSequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { currentStep: next, status: 'Completed', completedAt: new Date(), nextSendAt: null },
    });
    tally.completed++;
  } else {
    await prisma.emailSequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { currentStep: next, nextSendAt: new Date(Date.now() + (steps[next].delayDays ?? 1) * 86400000) },
    });
  }
}

async function processEnrollment(prisma, enrollment, isSuppressed, tally) {
  const steps = stepsOf(enrollment.sequence);
  const step = steps[enrollment.currentStep];
  if (!step) { // it ran past its last step
    await prisma.emailSequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'Completed', completedAt: new Date(), nextSendAt: null },
    });
    tally.completed++;
    return;
  }

  // Claim the step: only whoever moves its due time gets to send it.
  const claim = await prisma.emailSequenceEnrollment.updateMany({
    where: { id: enrollment.id, status: 'Active', currentStep: enrollment.currentStep, nextSendAt: enrollment.nextSendAt },
    data: { nextSendAt: new Date(Date.now() + RETRY_AFTER_MS) },
  });
  if (claim.count !== 1) return;

  // To the live contact's or lead's address, unless it or its domain is
  // suppressed, with the step's template when it carries no text itself. An
  // address that is missing or suppressed skips the step, as it always did.
  const to = await addressOf(prisma, enrollment);
  if (to && !(await isSuppressed(to))) {
    const template = step.templateId && !(step.subject && step.body)
      ? await prisma.emailTemplate.findUnique({ where: { id: String(step.templateId) } }).catch(() => null)
      : null;
    const subject = step.subject || template?.subject || `Sequence step ${enrollment.currentStep + 1}`;
    const body = step.body || template?.body || '';

    const delivery = await sendEmail(prisma, { to, subject, body });
    // Email has no lead column, so only a contact's is filed on them.
    await prisma.email.create({
      data: {
        subject, body, toEmail: to, status: delivery.status,
        sentAt: delivery.delivered ? new Date() : null,
        ...(enrollment.contactId && { contactId: enrollment.contactId }),
      },
    });

    if (!delivery.delivered) {
      await prisma.emailSequenceEnrollment.update({ where: { id: enrollment.id }, data: { lastError: delivery.error || 'Email delivery failed; retrying in one hour.' } });
      // Stay on this step: the claim already put its retry an hour ahead. Stop after three.
      const failures = await prisma.email.count({
        where: { toEmail: to, subject, status: 'failed', createdAt: { gte: enrollment.enrolledAt } },
      });
      if (failures >= MAX_FAILURES) {
        await prisma.emailSequenceEnrollment.update({ where: { id: enrollment.id }, data: { status: 'Bounced', nextSendAt: null } });
        tally.bounced++;
      } else {
        tally.retrying++;
      }
      return;
    }
    tally.sent++;
    await prisma.emailSequenceEnrollment.update({ where: { id: enrollment.id }, data: { lastError: null, lastSentAt: new Date() } });
  }

  await advance(prisma, enrollment, steps, tally);
}

async function processAll(prisma, isSuppressed) {
  // Only for sequences that are running: pausing one holds its steps back.
  const due = await prisma.emailSequenceEnrollment.findMany({
    where: { status: 'Active', nextSendAt: { lte: new Date() }, sequence: { status: 'Active' } },
    include: { sequence: true },
  });
  const tally = { processed: due.length, sent: 0, completed: 0, retrying: 0, bounced: 0, errors: 0 };
  for (const enrollment of due) {
    try {
      await processEnrollment(prisma, enrollment, isSuppressed, tally);
    } catch (err) {
      // One enrollment's trouble does not stop the batch; it is claimed, so it comes round again in an hour.
      tally.errors++;
      logger.warn({ err: err.message, enrollmentId: enrollment.id }, 'Sequence step failed');
    }
  }
  return tally;
}

/**
 * Send every due step. `isSuppressed(address)` says whether mail to an address,
 * or its @domain, is on the suppression list. Resolves to counts, or to
 * `{ skipped }` and why when it did nothing.
 */
async function processDueSteps(prisma, { isSuppressed }) {
  if (!mailConfigured()) {
    return {
      processed: 0, sent: 0, completed: 0,
      skipped: 'No SMTP server is configured (SMTP_HOST), so sequence email is not sent and no enrollment moves on',
    };
  }
  // One run at a time, across processes and across the job and the route.
  const token = await acquireLease(prisma, LEASE_NAME, LEASE_TTL_MS);
  if (!token) return { processed: 0, sent: 0, completed: 0, skipped: 'Sequence steps are already being processed' };
  try {
    return await processAll(prisma, isSuppressed);
  } finally {
    await releaseLease(prisma, LEASE_NAME, token);
  }
}

module.exports = { processDueSteps, stepsOf, RETRY_AFTER_MS, MAX_FAILURES };
