const graphMailbox = require('./graphMailbox');
const { sendMail: smtpSend } = require('../utils/mail');

/**
 * Outbound dispatch for CRM mail.
 *
 * /api/emails/send used to record status 'sent' and transmit nothing — the
 * route carried a TODO where the transport should have been. This picks one:
 * a named Microsoft mailbox goes out through Graph so the reply address is
 * the mailbox the customer knows, and everything else goes through SMTP.
 *
 * The outcome is reported honestly. When no SMTP server is configured the
 * mail utility logs to the console, which is useful in development but is not
 * delivery, so it comes back as 'queued' rather than 'sent'.
 */
async function sendEmail(prisma, { to, subject, body, html, mailboxId }) {
  if (!to) {
    const err = new Error('A recipient is required');
    err.status = 400;
    throw err;
  }

  if (mailboxId) {
    const account = await prisma.inboundEmailAccount.findFirst({ where: { id: mailboxId, deletedAt: null } });
    if (!account) {
      const err = new Error('Mailbox not found');
      err.status = 404;
      throw err;
    }
    if (account.provider !== 'microsoft') {
      const err = new Error('Sending from this mailbox is not implemented; only Microsoft mailboxes can send.');
      err.status = 501;
      throw err;
    }
    try {
      await graphMailbox.sendFrom(prisma, account, { to, subject, body: html || body, isHtml: !!html });
      return { status: 'sent', delivered: true, transport: 'graph', from: account.mailboxAddress };
    } catch (e) {
      return { status: 'failed', delivered: false, transport: 'graph', error: e.message };
    }
  }

  const result = await smtpSend({ to, subject, text: body, html });

  if (result.mode === 'smtp' && result.ok) {
    return { status: 'sent', delivered: true, transport: 'smtp' };
  }
  if (result.mode === 'console') {
    return {
      status: 'queued',
      delivered: false,
      transport: 'console',
      detail: 'No SMTP server is configured, so the message was logged rather than sent. Set SMTP_HOST, or send from a connected mailbox.',
    };
  }
  return { status: 'failed', delivered: false, transport: result.mode || 'smtp', error: result.error || 'Send failed' };
}

module.exports = { sendEmail };
