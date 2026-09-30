const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (transporter !== undefined) return transporter;
  if (!process.env.SMTP_HOST) {
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
  });
  return transporter;
}

function appBaseUrl() {
  // FRONTEND_URL is a comma-separated list of allowed origins (app.js reads it
  // so); links go to the first. Used whole, a list broke every emailed link.
  const first = String(process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).find(Boolean);
  return (first || 'http://localhost:7544').replace(/\/+$/, '');
}

function appUrl(pathname) {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${appBaseUrl()}${path}`;
}

/** Text for an HTML body. Names are typed by people, so they are not markup. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wrapHtml(title, bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${title}</title></head>
<body style="margin:0;padding:0;background:#060B1A;font-family:Poppins,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#060B1A;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#0B1228;border:1px solid #182550;border-radius:12px;padding:32px;">
        <tr><td style="font-size:18px;font-weight:700;color:#F0EDE5;padding-bottom:8px;">Sales Nebula</td></tr>
        <tr><td style="font-size:22px;font-weight:700;color:#F5A623;padding-bottom:16px;">${title}</td></tr>
        <tr><td style="font-size:15px;line-height:1.6;color:#C8C2B4;">${bodyHtml}</td></tr>
        <tr><td style="padding-top:28px;font-size:12px;color:#4A5168;">© Sales Nebula · You received this because of an account action.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Send transactional mail. When SMTP is not configured, logs the message
 * and resolves successfully so local/dev flows still work.
 */
async function sendMail({ to, subject, text, html }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || 'Sales Nebula <noreply@salesnebula.com>';
  const transport = getTransporter();

  if (!transport) {
    console.info('[mail:console]', { to, subject, preview: String(text || '').slice(0, 280) });
    return { ok: true, mode: 'console', messageId: `console-${Date.now()}` };
  }

  try {
    const info = await transport.sendMail({ from, to, subject, text, html });
    return { ok: true, mode: 'smtp', messageId: info.messageId };
  } catch (err) {
    console.error('[mail:error]', err.message);
    // Fall back to console so signup/invite flows are not blocked when SMTP misbehaves in staging
    console.info('[mail:fallback]', { to, subject, preview: String(text || '').slice(0, 280) });
    return { ok: false, mode: 'fallback', error: err.message, messageId: `fallback-${Date.now()}` };
  }
}

async function sendVerificationEmail({ to, firstName, verifyUrl }) {
  const name = firstName || 'there';
  const subject = 'Confirm your email for Sales Nebula';
  const text = `Hi ${name},\n\nConfirm your email to continue your Sales Nebula access request:\n${verifyUrl}\n\nThis link expires in 48 hours.\n`;
  const html = wrapHtml(
    'Confirm your email',
    `<p>Hi ${escapeHtml(name)},</p>
     <p>Thanks for requesting access to <strong style="color:#F0EDE5">Sales Nebula</strong>. Confirm your email to continue:</p>
     <p style="padding:18px 0;"><a href="${verifyUrl}" style="display:inline-block;background:#F5A623;color:#060B1A;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px;">Verify email</a></p>
     <p style="font-size:13px;color:#7E8598;">Or paste this link:<br/><a href="${verifyUrl}" style="color:#F5A623;word-break:break-all;">${verifyUrl}</a></p>
     <p style="font-size:13px;color:#7E8598;">This link expires in 48 hours.</p>`
  );
  return sendMail({ to, subject, text, html });
}

async function sendInviteEmail({ to, firstName, inviteUrl, message }) {
  const name = firstName || 'there';
  const subject = 'You are invited to Sales Nebula';
  const note = message ? `\n\nNote from your admin:\n${message}\n` : '';
  const text = `Hi ${name},\n\nYou have been invited to Sales Nebula. Set your password here:\n${inviteUrl}\n${note}\nThis invite expires in 7 days.\n`;
  const html = wrapHtml(
    'You are invited',
    `<p>Hi ${escapeHtml(name)},</p>
     <p>You have been invited to join <strong style="color:#F0EDE5">Sales Nebula</strong>. Set your password to open your workspace:</p>
     ${message ? `<p style="background:#0E1630;border-radius:8px;padding:12px;color:#C8C2B4;">${String(message).replace(/</g, '&lt;')}</p>` : ''}
     <p style="padding:18px 0;"><a href="${inviteUrl}" style="display:inline-block;background:#F5A623;color:#060B1A;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px;">Accept invite</a></p>
     <p style="font-size:13px;color:#7E8598;">Or paste this link:<br/><a href="${inviteUrl}" style="color:#F5A623;word-break:break-all;">${inviteUrl}</a></p>
     <p style="font-size:13px;color:#7E8598;">This invite expires in 7 days.</p>`
  );
  return sendMail({ to, subject, text, html });
}

async function sendWelcomeEmail({ to, firstName }) {
  const name = firstName || 'there';
  const loginUrl = appUrl('/login');
  const subject = 'Welcome to Sales Nebula';
  const text = `Hi ${name},\n\nYour Sales Nebula account is ready. Sign in here:\n${loginUrl}\n\nWelcome aboard.\n`;
  const html = wrapHtml(
    'Welcome aboard',
    `<p>Hi ${escapeHtml(name)},</p>
     <p>Your <strong style="color:#F0EDE5">Sales Nebula</strong> account is ready. Sign in and start moving deals.</p>
     <p style="padding:18px 0;"><a href="${loginUrl}" style="display:inline-block;background:#F5A623;color:#060B1A;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px;">Open Sales Nebula</a></p>`
  );
  return sendMail({ to, subject, text, html });
}

async function sendPasswordResetEmail({ to, firstName, resetUrl }) {
  const name = firstName || 'there';
  const subject = 'Reset your Sales Nebula password';
  const text = `Hi ${name},\n\nReset your Sales Nebula password using this link (expires in 1 hour):\n${resetUrl}\n\nIf you did not request this, you can ignore this email.\n`;
  const html = wrapHtml(
    'Reset your password',
    `<p>Hi ${escapeHtml(name)},</p>
     <p>We received a request to reset your Sales Nebula password.</p>
     <p style="padding:18px 0;"><a href="${resetUrl}" style="display:inline-block;background:#F5A623;color:#060B1A;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px;">Reset password</a></p>
     <p style="font-size:13px;color:#7E8598;">Or paste this link:<br/><a href="${resetUrl}" style="color:#F5A623;word-break:break-all;">${resetUrl}</a></p>
     <p style="font-size:13px;color:#7E8598;">This link expires in 1 hour. If you did not ask for a reset, ignore this email.</p>`
  );
  return sendMail({ to, subject, text, html });
}

/**
 * A visitor's words as one short line, for a message an administrator reads.
 * Nobody has vetted them, so no line breaks to lay out a fake instruction, no
 * control characters, and links defused (the scheme's "://" is bracketed) so a
 * mail client will not turn them into something to click.
 */
function oneLine(value, max = 300) {
  const line = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/:\/\//g, '[://]');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const DEPLOY_LABELS = { cloud: 'Hosted for them', 'self-hosted': 'Self-hosted', both: 'Either' };

/** The one-line name an access request goes by: their name, else their address. */
function requesterName(request) {
  return oneLine([request.firstName, request.lastName].filter(Boolean).join(' ') || request.email, 80);
}

/**
 * Tell someone who can approve access that a visitor has confirmed their
 * address and is waiting. Everything the visitor typed is shown as plain text.
 */
async function sendAccessRequestAlert({ to, firstName, request }) {
  const name = firstName || 'there';
  const who = requesterName(request);
  const subject = `New access request: ${oneLine(request.company ? `${who}, ${request.company}` : who, 100)}`;
  const reviewUrl = appUrl('/app/accessRequests');
  const details = [
    ['Name', who],
    ['Email', oneLine(request.email, 120)],
    ['Company', request.company && oneLine(request.company, 120)],
    ['Company size', request.companySize && oneLine(request.companySize, 20)],
    ['Deploy preference', DEPLOY_LABELS[request.interestedIn] || (request.interestedIn && oneLine(request.interestedIn, 20))],
    ['Replacing', request.useCase && oneLine(request.useCase, 300)],
  ].filter(([, value]) => value);
  const text = `Hi ${name},\n\n${who} asked for access to Sales Nebula and has confirmed their email address. The request is waiting for your review.\n\n${details.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nReview it in Sales Nebula: ${reviewUrl}\n`;
  const rows = details
    .map(([label, value]) => `<tr><td style="padding:4px 14px 4px 0;color:#7E8598;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:4px 0;color:#F0EDE5;">${escapeHtml(value)}</td></tr>`)
    .join('');
  const html = wrapHtml(
    'New access request',
    `<p>Hi ${escapeHtml(name)},</p>
     <p><strong style="color:#F0EDE5">${escapeHtml(who)}</strong> asked for access to Sales Nebula and has confirmed their email address. The request is waiting for your review.</p>
     <table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 4px;font-size:14px;">${rows}</table>
     <p style="padding:18px 0;"><a href="${reviewUrl}" style="display:inline-block;background:#F5A623;color:#060B1A;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px;">Review the request</a></p>
     <p style="font-size:13px;color:#7E8598;">What they typed is shown as plain text, with links defused. You are told because you can approve access.</p>`
  );
  return sendMail({ to, subject, text, html });
}

/** Tell the old address that the account's email has changed. */
async function sendEmailChangedNotice({ to, firstName, newEmail }) {
  const name = firstName || 'there';
  const subject = 'Your Sales Nebula email address was changed';
  const text = `Hi ${name},\n\nThe email address on your Sales Nebula account was changed to ${newEmail}.\n\nIf you did not do this, contact your administrator straight away: whoever made the change can now reset the password from that address.\n`;
  const html = wrapHtml(
    'Your email address was changed',
    `<p>Hi ${escapeHtml(name)},</p>
     <p>The email address on your Sales Nebula account was changed to <strong style="color:#F0EDE5">${escapeHtml(newEmail)}</strong>.</p>
     <p style="font-size:13px;color:#7E8598;">If you did not do this, contact your administrator straight away: whoever made the change can now reset the password from that address.</p>`
  );
  return sendMail({ to, subject, text, html });
}

/**
 * Whether mail really leaves: an SMTP server is configured. Without one,
 * sendMail only writes the message to the log and reports success, so code
 * that means to send (a sequence step) asks first rather than record a send
 * that did not happen. Read from the environment each time, as getTransporter
 * decides it.
 */
function mailConfigured() {
  return !!process.env.SMTP_HOST;
}

module.exports = {
  sendMail,
  mailConfigured,
  sendEmailChangedNotice,
  sendVerificationEmail,
  sendInviteEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendAccessRequestAlert,
  requesterName,
  oneLine,
  appUrl,
  appBaseUrl,
};
