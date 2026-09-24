/**
 * Background Job Queue & Scheduler (Production-Hardened)
 * 
 * Features:
 * - Bull queue with Redis (node-cron fallback)
 * - Retry logic with exponential backoff (3 attempts)
 * - Dead letter queue for permanently failed jobs
 * - Job execution metrics
 * - Failure alerting (creates notifications for admins)
 */

const { logger } = require('../services/logger');
const graphMailbox = require('../services/graphMailbox');

let Queue, cron;
try { Queue = require('bull'); } catch (e) { Queue = null; }
try { cron = require('node-cron'); } catch (e) { cron = null; }

let prisma;
const log = logger.child ? logger.child({ service: 'scheduler' }) : logger;

// ─── DEAD LETTER QUEUE (in-memory, stores permanently failed jobs) ───
const deadLetterQueue = [];
const MAX_DLQ_SIZE = 1000;

function addToDeadLetter(jobName, error, data = {}) {
  deadLetterQueue.push({
    job: jobName,
    error: error.message || String(error),
    data,
    failedAt: new Date().toISOString(),
  });
  if (deadLetterQueue.length > MAX_DLQ_SIZE) deadLetterQueue.shift();
  log.error({ job: jobName, error: error.message }, `Job moved to DLQ: ${jobName}`);
}

function getDeadLetterQueue() { return [...deadLetterQueue]; }
function clearDeadLetterQueue() { deadLetterQueue.length = 0; }

// ─── RETRY WRAPPER ───
async function withRetry(jobName, fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      log.info({ job: jobName, attempt }, `Job completed: ${jobName}`);
      return result;
    } catch (err) {
      lastError = err;
      log.warn({ job: jobName, attempt, maxRetries, error: err.message }, `Job attempt ${attempt}/${maxRetries} failed`);

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted
  addToDeadLetter(jobName, lastError);

  // Create admin notification
  try {
    const admins = await prisma.user.findMany({
      where: { role: { name: 'Admin' }, active: true },
      select: { id: true },
    });
    for (const admin of admins) {
      await prisma.notification.create({
        data: {
          title: `Background Job Failed: ${jobName}`,
          message: `Job "${jobName}" failed after 3 retries. Error: ${lastError.message}. Check the dead letter queue.`,
          userId: admin.id,
        },
      });
    }
  } catch (e) { /* notification failure shouldn't break anything */ }

  throw lastError;
}

// ─── JOB HANDLERS ───

/** A scheduled rule sweeps its whole module; do not let one run the table. */
const SCHEDULED_WORKFLOW_LIMIT = 500;

function modelHasDeletedAt(modelName) {
  const { modelHasField } = require('../utils/modelFields');
  return modelHasField(modelName, 'deletedAt');
}

const handlers = {
  /**
   * Deliver reminders that have come due.
   *
   * Reminder rows were created by the calendar and read by nothing: a CRM
   * whose reminders never remind. A snoozed reminder becomes due again when
   * its snooze expires.
   */
  async deliverReminders() {
    const now = new Date();
    const due = await prisma.reminder.findMany({
      where: {
        OR: [
          { status: 'Pending', triggerAt: { lte: now } },
          { status: 'Snoozed', snoozedUntil: { lte: now } },
        ],
      },
      orderBy: { triggerAt: 'asc' },
      take: 200,
    });

    let delivered = 0, failed = 0;

    for (const reminder of due) {
      try {
        // Fall back to whatever the reminder is about, so the notification
        // says something more useful than "Reminder".
        let message = reminder.message;
        if (!message && reminder.eventId) {
          const event = await prisma.calendarEvent.findUnique({
            where: { id: reminder.eventId }, select: { title: true },
          }).catch(() => null);
          message = event?.title ? `Starting soon: ${event.title}` : null;
        }
        if (!message && reminder.activityId) {
          const activity = await prisma.activity.findUnique({
            where: { id: reminder.activityId }, select: { subject: true },
          }).catch(() => null);
          message = activity?.subject ? `Due soon: ${activity.subject}` : null;
        }
        message = message || 'You asked to be reminded.';

        if (reminder.method === 'Email') {
          const user = await prisma.user.findUnique({
            where: { id: reminder.userId }, select: { email: true },
          });
          if (!user?.email) throw new Error('No address for this user');
          const { sendEmail } = require('../services/mailer');
          const result = await sendEmail(prisma, { to: user.email, subject: 'Reminder', body: message });
          if (result.status === 'failed') throw new Error(result.error || 'Send failed');
        } else {
          // Popup, Push and SMS all land in the notification feed for now;
          // SMS has no transport and silently dropping it would be worse.
          await prisma.notification.create({
            data: {
              title: 'Reminder',
              message,
              userId: reminder.userId,
              recordModule: reminder.eventId ? 'calendar' : 'activities',
              recordId: reminder.eventId || reminder.activityId || null,
            },
          });
        }

        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'Sent', sentAt: new Date() },
        });
        delivered++;
      } catch (err) {
        failed++;
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'Failed' },
        }).catch(() => {});
        log.warn({ reminderId: reminder.id, err: err.message }, 'reminder delivery failed');
      }
    }

    return { due: due.length, delivered, failed };
  },

  /**
   * Fetch new mail for every connected Microsoft mailbox that is due.
   *
   * This is the piece the inbound pipeline was always missing: the poll
   * endpoint expected an external worker to hand it messages, and no such
   * worker existed, so a configured mailbox was never actually read.
   *
   * Each account carries its own interval, so this runs often and mostly
   * decides there is nothing to do. One mailbox failing must not stop the
   * others, and throttling is left on the account rather than thrown.
   */
  async pollInboundMailboxes() {
    const accounts = await prisma.inboundEmailAccount.findMany({
      where: {
        provider: 'microsoft',
        active: true,
        deletedAt: null,
        oauthRefreshToken: { not: null },
      },
    });

    const now = Date.now();
    let polled = 0, processed = 0, casesCreated = 0, failed = 0, throttled = 0;

    for (const account of accounts) {
      const dueAt = account.lastPolledAt
        ? new Date(account.lastPolledAt).getTime() + (account.pollIntervalMinutes || 5) * 60_000
        : 0;
      if (dueAt > now) continue;

      try {
        const result = await graphMailbox.pollAccount(prisma, account);
        polled++;
        processed += result.processed;
        casesCreated += result.casesCreated;
      } catch (err) {
        if (err?.isThrottled) throttled++; else failed++;
        log.warn({ accountId: account.id, err: err.message }, 'mailbox poll failed');
      }
    }

    return { accounts: accounts.length, polled, processed, casesCreated, failed, throttled };
  },

  async checkOverdueInvoices() {
    const overdue = await prisma.invoice.updateMany({
      where: { status: 'Sent', dueDate: { lt: new Date() } },
      data: { status: 'Overdue' },
    });
    return { updated: overdue.count };
  },

  /**
   * Refresh Open forecasts' stored totals: from each one's items on live
   * deals, and from its owner's live deals closed won in its period, all in
   * the default currency, as the forecast routes count them. `closed` was the
   * whole org's closed won for the period, deleted deals included, in mixed
   * currencies, and an item took its deal's value unconverted. No request
   * here, so no row security: the forecast's owner decides.
   */
  async recalcForecasts() {
    const { currencyContext, sumInBase } = require('../utils/currency');
    const ctx = await currencyContext(prisma);
    const forecasts = await prisma.forecast.findMany({
      where: { status: 'Open' },
      include: { items: { where: { deal: { is: { deletedAt: null } } }, include: { deal: true } } },
    });

    for (const forecast of forecasts) {
      for (const item of forecast.items) {
        if (item.deal && item.overrideAmount == null) {
          await prisma.forecastItem.update({
            where: { id: item.id },
            data: { amount: ctx.toBase(item.deal.value, item.deal.currency), probability: item.deal.probability },
          });
        }
      }

      const items = await prisma.forecastItem.findMany({ where: { forecastId: forecast.id, deal: { is: { deletedAt: null } } } });
      const getAmt = (i) => i.overrideAmount != null ? i.overrideAmount : i.amount;
      const commit = items.filter(i => i.category === 'Commit').reduce((s, i) => s + getAmt(i), 0);
      const bestCase = items.filter(i => ['Commit', 'Best Case'].includes(i.category)).reduce((s, i) => s + getAmt(i), 0);
      const pipeline = items.filter(i => i.category !== 'Omitted').reduce((s, i) => s + getAmt(i), 0);

      const closedDeals = await prisma.deal.findMany({
        where: { ownerId: forecast.userId, stage: 'Closed Won', closeDate: { gte: forecast.periodStart, lte: forecast.periodEnd }, deletedAt: null },
        select: { value: true, currency: true },
      });

      await prisma.forecast.update({
        where: { id: forecast.id },
        data: { commit, bestCase, pipeline, closed: sumInBase(closedDeals, ctx) },
      });
    }
    return { recalculated: forecasts.length };
  },

  /**
   * Run scheduled workflows against the records that match them.
   *
   * This used to write a WorkflowLog saying "Scheduled execution" with
   * success: true and increment runCount, without evaluating a single
   * condition or running a single action — a green audit trail for work that
   * never happened, which is worse than no automation at all.
   */
  async runScheduledWorkflows() {
    const { resolveModel, evaluateConditions, runActions } = require('../services/workflowEngine');
    const workflows = await prisma.workflow.findMany({ where: { active: true, trigger: 'scheduled' } });

    let executed = 0, matched = 0, failed = 0;

    for (const wf of workflows) {
      const modelName = resolveModel(wf.module);
      if (!modelName) {
        await prisma.workflowLog.create({
          data: {
            workflowId: wf.id, workflowName: wf.name, module: wf.module,
            trigger: 'scheduled', recordId: 'system', actionsRun: [],
            success: false, error: `Unknown module: ${wf.module}`,
          },
        }).catch(() => {});
        failed++;
        continue;
      }

      try {
        // A scheduled rule sweeps its module, so cap the batch: a rule with no
        // conditions would otherwise act on the entire table every run.
        const where = modelHasDeletedAt(modelName) ? { deletedAt: null } : {};
        const records = await prisma[modelName].findMany({ where, take: SCHEDULED_WORKFLOW_LIMIT });

        for (const record of records) {
          if (!evaluateConditions(wf.conditions, record, null)) continue;
          matched++;
          const actionsRun = await runActions(prisma, wf, {
            moduleName: wf.module, modelName, record, userId: null,
          });
          await prisma.workflowLog.create({
            data: {
              workflowId: wf.id, workflowName: wf.name, module: wf.module,
              trigger: 'scheduled', recordId: record.id, actionsRun, success: true,
            },
          }).catch(() => {});
        }

        await prisma.workflow.update({
          where: { id: wf.id },
          data: { runCount: { increment: 1 }, lastRun: new Date() },
        });
        executed++;
      } catch (e) {
        failed++;
        await prisma.workflowLog.create({
          data: {
            workflowId: wf.id, workflowName: wf.name, module: wf.module,
            trigger: 'scheduled', recordId: 'system', actionsRun: [],
            success: false, error: String(e.message).slice(0, 400),
          },
        }).catch(() => {});
      }
    }

    return { workflows: workflows.length, executed, matched, failed };
  },

  async cleanupAuditLogs() {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const deleted = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return { deleted: deleted.count };
  },

  async cleanupNotifications() {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const deleted = await prisma.notification.deleteMany({ where: { read: true, createdAt: { lt: cutoff } } });
    return { deleted: deleted.count };
  },

  async checkStaleDeals() {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const staleDeals = await prisma.deal.findMany({
      where: { stage: { notIn: ['Closed Won', 'Closed Lost'] }, updatedAt: { lt: cutoff } },
      select: { id: true, name: true, ownerId: true },
    });

    for (const deal of staleDeals) {
      if (deal.ownerId) {
        await prisma.notification.create({
          data: {
            title: 'Stale Deal Alert',
            message: `"${deal.name}" has had no activity in 30+ days`,
            userId: deal.ownerId,
            recordModule: 'deals', recordId: deal.id,
          },
        });
      }
    }
    return { staleDeals: staleDeals.length };
  },

  async enforceSla() {
    const policies = await prisma.slaPolicy.findMany({ where: { active: true } });
    if (policies.length === 0) return { skipped: 'No active SLA policies' };

    let escalated = 0;
    for (const policy of policies) {
      const threshold = new Date(Date.now() - policy.firstResponseMinutes * 60 * 1000);
      const overdueCase = await prisma.case.findMany({
        where: {
          priority: policy.priority,
          status: { notIn: ['Resolved', 'Closed', 'Escalated'] },
          createdAt: { lt: threshold },
        },
        select: { id: true, caseNumber: true, assignedId: true },
      });

      for (const cs of overdueCase) {
        if (policy.escalateAfterMinutes) {
          const escThreshold = new Date(Date.now() - policy.escalateAfterMinutes * 60 * 1000);
          if (cs.createdAt < escThreshold) {
            await prisma.case.update({ where: { id: cs.id }, data: { status: 'Escalated' } });
            escalated++;
          }
        }
        if (cs.assignedId) {
          await prisma.notification.create({
            data: {
              title: 'SLA Breach Warning',
              message: `Case ${cs.caseNumber} has breached ${policy.priority} SLA (${policy.firstResponseMinutes}min response time)`,
              userId: cs.assignedId,
              recordModule: 'cases', recordId: cs.id,
            },
          });
        }
      }
    }
    return { policiesChecked: policies.length, escalated };
  },

  async cleanupRecycleBin() {
    const result = await prisma.recycleBinItem.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return { purged: result.count };
  },

  async processSequenceSteps() {
    const due = await prisma.emailSequenceEnrollment.findMany({
      where: { status: 'Active', nextSendAt: { lte: new Date() } },
      include: { sequence: true },
    });

    let sent = 0;
    for (const enrollment of due) {
      const steps = Array.isArray(enrollment.sequence.steps) ? enrollment.sequence.steps : [];
      const currentStep = steps[enrollment.currentStep];
      if (!currentStep) {
        await prisma.emailSequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'Completed', completedAt: new Date() },
        });
        continue;
      }

      // Create email from step
      try {
        const emailData = {
          subject: currentStep.subject || 'Sequence Email',
          body: currentStep.body || '',
          status: 'sent',
          sentAt: new Date(),
        };
        if (enrollment.contactId) emailData.contactId = enrollment.contactId;
        if (enrollment.leadId) emailData.leadId = enrollment.leadId;
        await prisma.email.create({ data: emailData });
        sent++;
      } catch (e) { /* Individual send failures don't stop sequence */ }

      const nextStep = enrollment.currentStep + 1;
      const nextStepDef = steps[nextStep];
      const nextSendAt = nextStepDef
        ? new Date(Date.now() + (nextStepDef.delayDays || 1) * 86400000)
        : null;

      await prisma.emailSequenceEnrollment.update({
        where: { id: enrollment.id },
        data: {
          currentStep: nextStep,
          nextSendAt,
          ...(nextStep >= steps.length ? { status: 'Completed', completedAt: new Date() } : {}),
        },
      });
    }
    return { processed: due.length, sent };
  },
};

// ─── QUEUE SETUP ───
let queues = {};

function initJobQueue(databaseClient) {
  prisma = databaseClient;
  if (!prisma) throw new Error('Job scheduler requires a database client');
  if (Queue && process.env.REDIS_URL) {
    const opts = {
      redis: process.env.REDIS_URL,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    };

    queues.maintenance = new Queue('maintenance', opts);
    queues.workflows = new Queue('workflows', opts);

    // Register processors with retry
    queues.maintenance.process('overdue-invoices', async () => withRetry('checkOverdueInvoices', handlers.checkOverdueInvoices));
    queues.maintenance.process('recalc-forecasts', async () => withRetry('recalcForecasts', handlers.recalcForecasts));
    queues.maintenance.process('cleanup-audit', async () => withRetry('cleanupAuditLogs', handlers.cleanupAuditLogs));
    queues.maintenance.process('cleanup-notifications', async () => withRetry('cleanupNotifications', handlers.cleanupNotifications));
    queues.maintenance.process('stale-deals', async () => withRetry('checkStaleDeals', handlers.checkStaleDeals));
    queues.workflows.process('scheduled', async () => withRetry('runScheduledWorkflows', handlers.runScheduledWorkflows));

    // Schedule recurring jobs
    queues.maintenance.add('overdue-invoices', {}, { repeat: { cron: '0 6 * * *' } });
    queues.maintenance.add('recalc-forecasts', {}, { repeat: { cron: '0 */4 * * *' } });
    queues.maintenance.add('cleanup-audit', {}, { repeat: { cron: '0 2 * * 0' } });
    queues.maintenance.add('cleanup-notifications', {}, { repeat: { cron: '0 3 * * 0' } });
    queues.maintenance.add('stale-deals', {}, { repeat: { cron: '0 8 * * 1' } });
    queues.workflows.add('scheduled', {}, { repeat: { cron: '*/15 * * * *' } });

    // Error handler
    Object.values(queues).forEach(q => {
      q.on('failed', (job, err) => {
        log.error({ job: job.name, error: err.message, attempts: job.attemptsMade }, 'Bull job failed');
      });
    });

    log.info('Jobs: Bull queue with Redis');
  } else if (cron) {
    // Wrap cron handlers with retry
    cron.schedule('0 6 * * *', () => withRetry('checkOverdueInvoices', handlers.checkOverdueInvoices).catch(() => {}));
    cron.schedule('0 */4 * * *', () => withRetry('recalcForecasts', handlers.recalcForecasts).catch(() => {}));
    cron.schedule('0 2 * * 0', () => withRetry('cleanupAuditLogs', handlers.cleanupAuditLogs).catch(() => {}));
    cron.schedule('0 3 * * 0', () => withRetry('cleanupNotifications', handlers.cleanupNotifications).catch(() => {}));
    cron.schedule('0 8 * * 1', () => withRetry('checkStaleDeals', handlers.checkStaleDeals).catch(() => {}));
    cron.schedule('*/15 * * * *', () => withRetry('runScheduledWorkflows', handlers.runScheduledWorkflows).catch(() => {}));
    cron.schedule('*/30 * * * *', () => withRetry('enforceSla', handlers.enforceSla).catch(() => {}));
    cron.schedule('0 4 * * *', () => withRetry('cleanupRecycleBin', handlers.cleanupRecycleBin).catch(() => {}));
    cron.schedule('*/10 * * * *', () => withRetry('processSequenceSteps', handlers.processSequenceSteps).catch(() => {}));
    // Runs every minute; each account's own pollIntervalMinutes decides whether
    // it is actually due, so a mailbox set to 5 minutes is polled every 5.
    cron.schedule('* * * * *', () => withRetry('pollInboundMailboxes', handlers.pollInboundMailboxes).catch(() => {}));
    cron.schedule('* * * * *', () => withRetry('deliverReminders', handlers.deliverReminders).catch(() => {}));
    log.info('Jobs: node-cron scheduler');
  } else {
    log.warn('Jobs: No scheduler available');
  }
}

// Manual trigger (for admin endpoint)
async function runJob(name) {
  if (handlers[name]) return withRetry(name, handlers[name]);
  throw new Error(`Unknown job: ${name}. Available: ${Object.keys(handlers).join(', ')}`);
}

/**
 * Give the handlers a database without starting the schedule.
 *
 * initJobQueue also registers the cron entries, which a test does not want
 * firing underneath it.
 */
function setDatabaseClient(databaseClient) {
  prisma = databaseClient;
}

module.exports = { initJobQueue, setDatabaseClient, runJob, handlers, getDeadLetterQueue, clearDeadLetterQueue };
