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

const crypto = require('crypto');
const { logger } = require('../services/logger');
const graphMailbox = require('../services/graphMailbox');
const { notify } = require('../services/notify');
const { acquireLease, releaseLease } = require('../utils/lease');

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

// ─── ONE RUN AT A TIME ───

// Long enough for the slowest job and its retries; short enough that a process
// that died holding the lease does not silence the job for long.
const JOB_LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * Run a job, retried, unless another run of it is going on: from another
 * process (every process with node-cron runs the same schedule, and README
 * suggests `pm2 -i max`), from the admin "run now" button, or from the last
 * tick if it is still busy. Two runs at once sent a sequence step twice and
 * raised a stale-deal alert twice. The lease is in the database (utils/lease),
 * so it holds across processes; with Redis, Bull already runs each tick once.
 */
async function withRetry(jobName, fn, maxRetries = 3) {
  const leaseName = `job:${jobName}`;
  let token = null;
  try {
    token = await acquireLease(prisma, leaseName, JOB_LEASE_TTL_MS);
    if (!token) {
      log.info({ job: jobName }, `Job skipped, already running: ${jobName}`);
      return { skipped: 'already running' };
    }
  } catch (err) {
    // No lease table (or no database yet): run as the job did before leases.
    log.warn({ job: jobName, error: err.message }, 'Could not take the job lease; running without it');
  }
  try {
    return await runWithRetries(jobName, fn, maxRetries);
  } finally {
    if (token) await releaseLease(prisma, leaseName, token);
  }
}

// ─── RETRY WRAPPER ───
async function runWithRetries(jobName, fn, maxRetries = 3) {
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

/**
 * A scheduled rule sweeps its whole module, a page at a time: it acts on at
 * most SCHEDULED_WORKFLOW_LIMIT records a run and looks at no more than
 * SCHEDULED_WORKFLOW_SCAN rows, so no one rule runs the table. Each run starts
 * at a random id and wraps round, so a module larger than one run's scan is
 * still covered, over several runs, rather than only ever its first rows.
 */
const SCHEDULED_WORKFLOW_LIMIT = 500;
const SCHEDULED_WORKFLOW_SCAN = 10000;
const SCHEDULED_WORKFLOW_PAGE = 500;

// A scheduled rule's log for a record: it acted ('scheduled'), or the record
// stopped matching after it had ('scheduled-unmatched'), which lets the rule
// act on it again the next time it matches.
const SCHEDULED_ACTED = 'scheduled';
const SCHEDULED_UNMATCHED = 'scheduled-unmatched';

/** Which of the two a scheduled rule last logged for each of these records. */
async function scheduledStates(workflowId, recordIds) {
  if (!recordIds.length) return new Map();
  const rows = await prisma.workflowLog.findMany({
    where: { workflowId, trigger: { in: [SCHEDULED_ACTED, SCHEDULED_UNMATCHED] }, recordId: { in: recordIds } },
    orderBy: [{ recordId: 'asc' }, { createdAt: 'desc' }],
    distinct: ['recordId'],
    select: { recordId: true, trigger: true },
  });
  return new Map(rows.map(row => [row.recordId, row.trigger]));
}

/**
 * Whether a reminder's user may still see its event, by the rule of
 * visibleEventWhere in routes/calendar: its owner or an invitee (an edited
 * occurrence through its series), or an admin for an event not marked
 * private. Taken off the event, or with it deleted, they were still sent its
 * title, which is also a reminder's default message.
 */
async function eventStillVisible(reminder) {
  const { isAdmin } = require('../middleware/rowSecurity');
  const user = await prisma.user.findUnique({ where: { id: reminder.userId }, include: { role: true } });
  if (!user?.active) return false;
  const participant = {
    OR: [
      { ownerId: user.id },
      { invitees: { some: { userId: user.id } } },
      { parentEvent: { is: { invitees: { some: { userId: user.id } } } } },
    ],
  };
  const scope = isAdmin(user) ? { OR: [participant, { visibility: { notIn: ['Private', 'Confidential'] } }] } : participant;
  const event = await prisma.calendarEvent.findFirst({ where: { AND: [{ id: reminder.eventId, deletedAt: null }, scope] }, select: { id: true } });
  return !!event;
}

function modelHasDeletedAt(modelName) {
  const { modelHasField } = require('../utils/modelFields');
  return modelHasField(modelName, 'deletedAt');
}

/** Whether outbound mail to this address, or to its @domain, is suppressed. */
async function addressSuppressed(address) {
  const email = String(address).trim().toLowerCase();
  const hit = await prisma.emailSuppression.findFirst({
    where: { email: { in: [email, `@${email.split('@')[1]}`] } }, select: { id: true },
  });
  return !!hit;
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

    let delivered = 0, failed = 0, dismissed = 0;

    for (const reminder of due) {
      try {
        // Not sent once its user can no longer see the event (eventStillVisible),
        // nor for an activity that has since been deleted.
        const gone = reminder.eventId
          ? !(await eventStillVisible(reminder))
          : !!reminder.activityId && !(await prisma.activity.findFirst({ where: { id: reminder.activityId, deletedAt: null }, select: { id: true } }));
        if (gone) {
          await prisma.reminder.update({ where: { id: reminder.id }, data: { status: 'Dismissed', dismissedAt: new Date() } });
          dismissed++;
          continue;
        }

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
          await notify(prisma, 'reminders', {
            title: 'Reminder',
            message,
            userId: reminder.userId,
            recordModule: reminder.eventId ? 'calendar' : 'activities',
            recordId: reminder.eventId || reminder.activityId || null,
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

    return { due: due.length, delivered, failed, dismissed };
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
      where: { status: 'Sent', dueDate: { lt: new Date() }, deletedAt: null },
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
   *
   * A rule acts on a record once while it matches, and again only after it
   * has stopped matching and matches again (a deal that leaves Negotiation
   * and comes back gets a second follow-up). It acted on every matching
   * record on every run, every 15 minutes: a rule that emails, creates a task
   * or notifies did so 96 times a day for each record, for as long as the
   * record matched. And it only ever looked at the same first 500 rows.
   */
  async runScheduledWorkflows() {
    const { resolveModel, evaluateConditions, runActions, triggersFor } = require('../services/workflowEngine');
    // Every spelling the engine takes for a scheduled rule ('Scheduled',
    // 'schedule', 'cron'); only the exact 'scheduled' was ever picked up.
    const scheduled = triggersFor('scheduled');
    const workflows = (await prisma.workflow.findMany({ where: { active: true } }))
      .filter(w => scheduled.includes(String(w.trigger || '').toLowerCase()));

    // matched: records acted on this run; alreadyActed: matching records the
    // rule acted on before and that have matched ever since; actionErrors:
    // records whose actions threw (logged, and not retried while they match).
    let executed = 0, matched = 0, failed = 0, alreadyActed = 0, actionErrors = 0;

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
        const where = modelHasDeletedAt(modelName) ? { deletedAt: null } : {};
        let scanned = 0, acted = 0;
        // From a random id to the end, then from the start up to it.
        const start = crypto.randomUUID();
        for (const idRange of [{ gt: start }, { lte: start }]) {
          let cursor = null;
          while (acted < SCHEDULED_WORKFLOW_LIMIT && scanned < SCHEDULED_WORKFLOW_SCAN) {
            const page = await prisma[modelName].findMany({
              where: { ...where, id: idRange }, orderBy: { id: 'asc' }, take: SCHEDULED_WORKFLOW_PAGE,
              ...(cursor && { cursor: { id: cursor }, skip: 1 }),
            });
            if (!page.length) break;
            scanned += page.length;
            cursor = page[page.length - 1].id;

            const states = await scheduledStates(wf.id, page.map(record => record.id));
            const leftSince = [];
            for (const record of page) {
              const actedBefore = states.get(record.id) === SCHEDULED_ACTED;
              if (!evaluateConditions(wf.conditions, record, null)) {
                // It has left the rule's records: matching again is a new occasion.
                if (actedBefore) leftSince.push(record.id);
                continue;
              }
              if (actedBefore) { alreadyActed++; continue; }
              if (acted >= SCHEDULED_WORKFLOW_LIMIT) continue;   // the next run takes it
              acted++; matched++;

              // One record's failure is its own: it is logged, the rest of the
              // module still runs, and it is not retried while the record
              // matches, so a broken action does not log an error every 15
              // minutes. (A throw used to stop the rule for the whole run.)
              let actionsRun = [], error = null;
              try {
                actionsRun = await runActions(prisma, wf, {
                  moduleName: wf.module, modelName, record, userId: null,
                });
              } catch (e) {
                error = String(e.message).slice(0, 400);
                actionErrors++;
              }
              await prisma.workflowLog.create({
                data: {
                  workflowId: wf.id, workflowName: wf.name, module: wf.module,
                  trigger: SCHEDULED_ACTED, recordId: record.id, actionsRun, success: !error, error,
                },
              }).catch(() => {});
            }
            if (leftSince.length) {
              await prisma.workflowLog.createMany({
                data: leftSince.map(recordId => ({
                  workflowId: wf.id, workflowName: wf.name, module: wf.module,
                  trigger: SCHEDULED_UNMATCHED, recordId, actionsRun: [], success: true,
                })),
              }).catch(() => {});
            }
            if (page.length < SCHEDULED_WORKFLOW_PAGE) break;
          }
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

    return { workflows: workflows.length, executed, matched, failed, alreadyActed, actionErrors };
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

  /**
   * Alert owners to open deals with no change and no activity in 30 days.
   * Deleted deals were alerted on, a deal with a call logged yesterday was
   * "stale", and each run added another alert beside the unread one.
   */
  async checkStaleDeals() {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const staleDeals = await prisma.deal.findMany({
      where: {
        stage: { notIn: ['Closed Won', 'Closed Lost'] }, updatedAt: { lt: cutoff }, deletedAt: null,
        activities: { none: { deletedAt: null, OR: [{ createdAt: { gte: cutoff } }, { date: { gte: cutoff } }] } },
      },
      select: { id: true, name: true, ownerId: true },
    });

    // Not again while the owner's last alert for the deal is still unread.
    const unread = await prisma.notification.findMany({
      where: { title: 'Stale Deal Alert', read: false, recordModule: 'deals', recordId: { in: staleDeals.map(d => d.id) } },
      select: { userId: true, recordId: true },
    });
    const pending = new Set(unread.map(n => `${n.userId}:${n.recordId}`));

    let alerted = 0;
    for (const deal of staleDeals) {
      if (deal.ownerId && !pending.has(`${deal.ownerId}:${deal.id}`)) {
        const sent = await notify(prisma, 'dealAlerts', {
          title: 'Stale Deal Alert',
          message: `"${deal.name}" has had no activity in 30+ days`,
          userId: deal.ownerId,
          recordModule: 'deals', recordId: deal.id,
        });
        if (sent) alerted++;
      }
    }
    return { staleDeals: staleDeals.length, alerted };
  },

  /**
   * Warn on, then escalate, open cases older than their priority's policy.
   *
   * Nothing was ever escalated: createdAt was not selected, so every case's
   * age compared as undefined. Deleted cases were swept too, and the same
   * warning went to the assignee every half hour; slaBreached now marks it
   * sent, and a case with no assignee warns its owner. An escalation is
   * stamped and recorded as the escalate route does it.
   */
  async enforceSla() {
    const policies = await prisma.slaPolicy.findMany({ where: { active: true } });
    if (policies.length === 0) return { skipped: 'No active SLA policies' };

    let escalated = 0, warned = 0;
    for (const policy of policies) {
      const threshold = new Date(Date.now() - policy.firstResponseMinutes * 60 * 1000);
      const overdueCase = await prisma.case.findMany({
        where: {
          priority: policy.priority,
          // Not while it waits on the customer, which pauses the SLA board's clock too.
          status: { notIn: ['Resolved', 'Closed', 'Rejected', 'Escalated', ...require('../utils/integrity').SLA_PAUSED_STATUSES] },
          // Once. Excluding only the status "Escalated" meant that an agent who
          // picked an escalated case up (In Progress) had it escalated again
          // on every run, half-hourly: another history row and another
          // case.escalated webhook each time. The flag stays set when the
          // status moves on; the escalate route sets it too.
          isEscalated: false,
          createdAt: { lt: threshold },
          deletedAt: null,
        },
        select: { id: true, caseNumber: true, status: true, assignedId: true, ownerId: true, createdAt: true, slaBreached: true },
      });

      for (const cs of overdueCase) {
        const escalate = !!policy.escalateAfterMinutes
          && cs.createdAt < new Date(Date.now() - policy.escalateAfterMinutes * 60 * 1000);
        if (escalate) {
          await prisma.case.update({
            where: { id: cs.id },
            data: {
              status: 'Escalated', isEscalated: true, escalatedAt: new Date(), slaBreached: true,
              escalationReason: `Open past the ${policy.priority} SLA (${policy.escalateAfterMinutes} min)`,
            },
          });
          await prisma.caseStatusHistory.create({
            data: { caseId: cs.id, fromStatus: cs.status, toStatus: 'Escalated', note: 'Escalated by SLA policy' },
          }).catch(() => {});
          await require('../services/webhooks').fireWebhookEvent(prisma, 'case.escalated', { id: cs.id, caseNumber: cs.caseNumber, by: 'sla' });
          escalated++;
        }
        if (cs.slaBreached) continue;
        if (!escalate) await prisma.case.update({ where: { id: cs.id }, data: { slaBreached: true } });
        // ownerId is a plain column, so a stale one must not fail the run.
        const recipient = cs.assignedId || cs.ownerId;
        const sent = recipient && await notify(prisma, 'caseAlerts', {
          title: 'SLA Breach Warning',
          message: `Case ${cs.caseNumber} has breached ${policy.priority} SLA (${policy.firstResponseMinutes}min response time)`,
          userId: recipient,
          recordModule: 'cases', recordId: cs.id,
        }).catch(() => null);
        if (sent) warned++;
      }
    }
    return { policiesChecked: policies.length, escalated, warned };
  },

  async cleanupRecycleBin() {
    const result = await prisma.recycleBinItem.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return { purged: result.count };
  },

  /**
   * Send each due step to the enrolled contact or lead (services/sequenceSteps,
   * which POST /api/sequences/process shares).
   *
   * A step was recorded as 'sent' and handed to no transport, a lead's step
   * failed outright (Email has no leadId), a deleted person was still
   * "emailed", and pausing the sequence stopped nothing. It goes through the
   * mailer to the live person's address, unless that address or its domain is
   * suppressed. With no SMTP server it does nothing and says so, and a step
   * moves on only once its mail has gone out.
   */
  async processSequenceSteps() {
    const { processDueSteps } = require('../services/sequenceSteps');
    return processDueSteps(prisma, { isSuppressed: addressSuppressed });
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
    queues.messaging = new Queue('messaging', opts);

    // Register processors with retry
    queues.maintenance.process('overdue-invoices', async () => withRetry('checkOverdueInvoices', handlers.checkOverdueInvoices));
    queues.maintenance.process('recalc-forecasts', async () => withRetry('recalcForecasts', handlers.recalcForecasts));
    queues.maintenance.process('cleanup-audit', async () => withRetry('cleanupAuditLogs', handlers.cleanupAuditLogs));
    queues.maintenance.process('cleanup-notifications', async () => withRetry('cleanupNotifications', handlers.cleanupNotifications));
    queues.maintenance.process('stale-deals', async () => withRetry('checkStaleDeals', handlers.checkStaleDeals));
    queues.workflows.process('scheduled', async () => withRetry('runScheduledWorkflows', handlers.runScheduledWorkflows));
    // These five ran only under node-cron: with Redis configured, SLAs were
    // never enforced, reminders and sequence mail never went out, mailboxes
    // were never read and the recycle bin never emptied.
    queues.maintenance.process('enforce-sla', async () => withRetry('enforceSla', handlers.enforceSla));
    queues.maintenance.process('cleanup-recycle-bin', async () => withRetry('cleanupRecycleBin', handlers.cleanupRecycleBin));
    queues.messaging.process('sequence-steps', async () => withRetry('processSequenceSteps', handlers.processSequenceSteps));
    queues.messaging.process('poll-mailboxes', async () => withRetry('pollInboundMailboxes', handlers.pollInboundMailboxes));
    queues.messaging.process('deliver-reminders', async () => withRetry('deliverReminders', handlers.deliverReminders));

    // Schedule recurring jobs
    queues.maintenance.add('overdue-invoices', {}, { repeat: { cron: '0 6 * * *' } });
    queues.maintenance.add('recalc-forecasts', {}, { repeat: { cron: '0 */4 * * *' } });
    queues.maintenance.add('cleanup-audit', {}, { repeat: { cron: '0 2 * * 0' } });
    queues.maintenance.add('cleanup-notifications', {}, { repeat: { cron: '0 3 * * 0' } });
    queues.maintenance.add('stale-deals', {}, { repeat: { cron: '0 8 * * 1' } });
    queues.workflows.add('scheduled', {}, { repeat: { cron: '*/15 * * * *' } });
    queues.maintenance.add('enforce-sla', {}, { repeat: { cron: '*/30 * * * *' } });
    queues.maintenance.add('cleanup-recycle-bin', {}, { repeat: { cron: '0 4 * * *' } });
    queues.messaging.add('sequence-steps', {}, { repeat: { cron: '*/10 * * * *' } });
    queues.messaging.add('poll-mailboxes', {}, { repeat: { cron: '* * * * *' } });
    queues.messaging.add('deliver-reminders', {}, { repeat: { cron: '* * * * *' } });

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
