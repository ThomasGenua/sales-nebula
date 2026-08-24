/**
 * Webhook Service
 * Fires outbound HTTP events to registered webhook URLs.
 * Features: HMAC-SHA256 signing, retry with backoff, async delivery, logging.
 */

const crypto = require('crypto');
const { logger } = require('./logger');
const log = logger.child ? logger.child({ service: 'webhooks' }) : logger;

// In-memory queue for async delivery
const deliveryQueue = [];
let processing = false;

/**
 * Fire a webhook event. Queues delivery asynchronously.
 */
async function fireWebhookEvent(prisma, event, payload) {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: { active: true },
    });

    const matching = webhooks.filter(w => {
      const events = Array.isArray(w.events) ? w.events : [];
      return events.includes(event) || events.includes('*');
    });

    for (const webhook of matching) {
      deliveryQueue.push({ webhook, event, payload, attempt: 1 });
    }

    if (!processing) processQueue(prisma);
  } catch (err) {
    log.error({ err, event }, 'Failed to fire webhook event');
  }
}

async function processQueue(prisma) {
  processing = true;
  while (deliveryQueue.length > 0) {
    const item = deliveryQueue.shift();
    await deliverWebhook(prisma, item);
  }
  processing = false;
}

async function deliverWebhook(prisma, { webhook, event, payload, attempt }) {
  const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString(), attempt });

  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': event,
    'X-Webhook-Delivery': crypto.randomUUID(),
    ...(typeof webhook.headers === 'object' && webhook.headers ? webhook.headers : {}),
  };

  // HMAC signature
  if (webhook.secret) {
    const signature = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  let statusCode = null;
  let responseText = null;
  let success = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    statusCode = res.status;
    responseText = await res.text().catch(() => '');
    success = res.ok;
  } catch (err) {
    responseText = err.message || 'Connection failed';
  }

  // Log delivery
  try {
    await prisma.webhookLog.create({
      data: {
        webhookId: webhook.id,
        event,
        payload: payload,
        statusCode,
        response: (responseText || '').slice(0, 2000),
        success,
        attempts: attempt,
      },
    });
  } catch (e) { /* logging failure shouldn't break delivery */ }

  // Retry on failure
  if (!success && attempt < webhook.retries) {
    const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
    setTimeout(() => {
      deliveryQueue.push({ webhook, event, payload, attempt: attempt + 1 });
      if (!processing) processQueue(prisma);
    }, delay);
  }
}

/**
 * Standard CRM events to fire from routes/CRUD:
 * - {module}.created, {module}.updated, {module}.deleted
 * - deal.stage_changed, lead.converted, lead.scored
 * - invoice.paid, quote.accepted, case.escalated, case.resolved
 * - forecast.submitted, approval.requested, approval.completed
 */

module.exports = { fireWebhookEvent };
