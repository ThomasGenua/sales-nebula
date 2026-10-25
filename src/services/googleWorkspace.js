const crypto = require('crypto');
const {
  encrypt,
  decrypt
} = require('../utils/secretBox');
const {
  acquireLease,
  releaseLease
} = require('../utils/lease');
const {
  permits
} = require('../middleware/auth');
const {
  reachableWhere
} = require('../middleware/access');
const fail = (message, status = 400) => Object.assign(new Error(message), {
  status
});
const MAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const scopes = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';
const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const verifier = state => crypto.createHmac('sha256', process.env.GOOGLE_CLIENT_SECRET).update(state).digest('base64url');
function authorize(state, redirectUri, calendar) {
  if (!configured()) throw fail('Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET', 503);
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes + (calendar ? ' https://www.googleapis.com/auth/calendar.events' : ''),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge_method: 'S256',
    code_challenge: crypto.createHash('sha256').update(verifier(state)).digest('base64url')
  });
}
async function token(body) {
  if (!configured()) throw fail('Google OAuth is not configured', 503);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      ...body,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET
    }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await r.json();
  if (!r.ok) throw fail('Google authorization failed; reconnect the account', 502);
  return data;
}
async function request(db, account, url, options = {}) {
  if (!url.startsWith(MAIL + '/') && !url.startsWith(CAL)) throw fail('Invalid Google API destination');
  let a = await db.inboundEmailAccount.findUnique({
    where: {
      id: account.id
    }
  });
  if (!a?.oauthRefreshToken || !a.active) throw fail('Reconnect this Google account', 409);
  if (!a.oauthExpiresAt || a.oauthExpiresAt < Date.now() + 60000) {
    const t = await token({
      grant_type: 'refresh_token',
      refresh_token: decrypt(a.oauthRefreshToken)
    });
    a = await db.inboundEmailAccount.update({
      where: {
        id: a.id
      },
      data: {
        oauthAccessToken: encrypt(t.access_token),
        oauthExpiresAt: new Date(Date.now() + t.expires_in * 1000),
        ...(t.refresh_token && {
          oauthRefreshToken: encrypt(t.refresh_token)
        })
      }
    });
  }
  const r = await fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + decrypt(a.oauthAccessToken),
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...(options.body && {
      body: JSON.stringify(options.body)
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw fail('Google request failed (' + r.status + '); retry or reconnect', r.status);
  return r.status === 204 ? null : r.json();
}
async function connect(db, account, {
  code,
  redirectUri,
  codeVerifier,
  calendar
}) {
  const t = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });
  const granted = new Set(String(t.scope || '').split(' '));
  if (!scopes.split(' ').every(s => granted.has(s)) || calendar && !granted.has('https://www.googleapis.com/auth/calendar.events')) throw fail('Grant the requested mail and calendar permissions');
  if (!t.refresh_token) throw fail('Google did not grant offline access; reconnect with consent');
  const r = await fetch(MAIL + '/profile', {
    headers: {
      Authorization: 'Bearer ' + t.access_token
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw fail('Cannot read Google mailbox profile', 502);
  const profile = await r.json();
  if (account.mailboxAddress && account.mailboxAddress.toLowerCase() !== profile.emailAddress.toLowerCase()) throw fail('Reconnect the same mailbox or create a new connection');
  await db.inboundEmailAccount.update({
    where: {
      id: account.id
    },
    data: {
      mailboxAddress: profile.emailAddress,
      username: profile.emailAddress,
      oauthAccessToken: encrypt(t.access_token),
      oauthRefreshToken: encrypt(t.refresh_token),
      oauthExpiresAt: new Date(Date.now() + t.expires_in * 1000),
      oauthScopes: t.scope,
      calendarEnabled: calendar,
      active: true,
      status: 'Idle',
      lastError: null
    }
  });
}
async function owner(db, account, calendar = false) {
  const user = await db.user.findFirst({
    where: {
      id: account.ownerId,
      active: true,
      isPortalUser: false
    },
    include: {
      role: {
        include: {
          permissions: true
        }
      }
    }
  });
  const req = {
    user,
    userId: user?.id,
    app: {
      locals: {
        prisma: db
      }
    }
  };
  if (!user || !permits(req, 'emails', 'edit') || calendar && !permits(req, 'activities', 'edit')) throw fail('Google account owner no longer has access', 403);
  return req;
}
function messageData(message) {
  const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  const bodies = [];
  function visit(p) {
    if (p.mimeType === 'text/plain' && p.body?.data) bodies.push(Buffer.from(p.body.data, 'base64url').toString('utf8'));
    for (const child of p.parts || []) visit(child);
  }
  visit(message.payload || {});
  const from = require('./inboundIngest').parseAddress(headers.from || '');
  return {
    externalId: message.id,
    messageId: headers['message-id'] || null,
    threadKey: message.threadId,
    fromEmail: from.email || '',
    fromName: from.name,
    toEmails: headers.to || '',
    subject: headers.subject || '',
    textBody: bodies.join('\n').slice(0, 200000) || message.snippet || '',
    snippet: (message.snippet || '').slice(0, 200),
    direction: message.labelIds?.includes('SENT') ? 'outbound' : 'inbound',
    receivedAt: new Date(Number(message.internalDate)),
    deletedAt: message.labelIds?.includes('TRASH') ? new Date() : null
  };
}
async function importMessage(db, account, id, req) {
  let remote;
  try {
    remote = await request(db, account, MAIL + '/messages/' + encodeURIComponent(id) + '?format=full');
  } catch (e) {
    if (e.status !== 404) throw e;
    await db.inboundEmailMessage.updateMany({
      where: {
        accountId: account.id,
        externalId: id
      },
      data: {
        deletedAt: new Date()
      }
    });
    return;
  }
  if (remote.labelIds?.some(l => ['DRAFT', 'SPAM'].includes(l))) return;
  const data = messageData(remote);
  const email = data.direction === 'inbound' ? data.fromEmail : require('./inboundIngest').parseAddress(data.toEmails).email;
  const people = email && permits(req, 'contacts', 'read') ? await db.contact.findMany({
    where: await reachableWhere(req, 'contacts', 'contact', {
      email: {
        equals: email,
        mode: 'insensitive'
      }
    }),
    take: 2,
    select: {
      id: true
    }
  }) : [];
  data.contactId = people.length === 1 ? people[0].id : null;
  const deals = data.contactId && permits(req, 'deals', 'read') ? await db.deal.findMany({
    where: await reachableWhere(req, 'deals', 'deal', {
      contactId: data.contactId,
      stage: {
        notIn: ['Closed Won', 'Closed Lost']
      }
    }),
    take: 2,
    select: {
      id: true
    }
  }) : [];
  data.dealId = deals.length === 1 ? deals[0].id : null;
  let existing = await db.inboundEmailMessage.findFirst({
    where: {
      accountId: account.id,
      externalId: id
    }
  });
  if (!existing && data.direction === 'outbound') existing = await db.inboundEmailMessage.findFirst({
    where: {
      accountId: account.id,
      externalId: null,
      threadKey: data.threadKey,
      direction: 'outbound',
      textBody: data.textBody,
      receivedAt: {
        gte: new Date(+data.receivedAt - 300000),
        lte: new Date(+data.receivedAt + 300000)
      }
    }
  });
  if (existing) await db.inboundEmailMessage.update({
    where: {
      id: existing.id
    },
    data
  });else await db.inboundEmailMessage.create({
    data: {
      accountId: account.id,
      ...data,
      status: data.direction === 'outbound' ? 'Sent' : 'New'
    }
  });
  if (data.direction === 'inbound') {
    const answer = await db.inboundEmailMessage.findFirst({
      where: {
        accountId: account.id,
        threadKey: data.threadKey,
        direction: 'outbound',
        receivedAt: {
          gte: data.receivedAt
        }
      },
      orderBy: {
        receivedAt: 'desc'
      }
    });
    if (answer) await db.inboundEmailMessage.updateMany({
      where: {
        accountId: account.id,
        externalId: id
      },
      data: {
        repliedAt: answer.receivedAt,
        status: 'Replied'
      }
    });
  }
  if (data.direction === 'outbound') await db.inboundEmailMessage.updateMany({
    where: {
      accountId: account.id,
      threadKey: data.threadKey,
      direction: 'inbound',
      receivedAt: {
        lte: data.receivedAt
      }
    },
    data: {
      repliedAt: data.receivedAt,
      status: 'Replied'
    }
  });
}
async function pollAccount(db, account) {
  const req = await owner(db, account),
    key = 'sales-mail:' + account.id,
    lease = await acquireLease(db, key, 300000);
  if (!lease) return {
    busy: true
  };
  try {
    let cursor = account.syncCursor ? JSON.parse(account.syncCursor) : {};
    if (!cursor.history && !cursor.initialHistory) cursor.initialHistory = (await request(db, account, MAIL + '/profile')).historyId;
    const params = new URLSearchParams({
      maxResults: '100',
      ...(cursor.page && {
        pageToken: cursor.page
      }),
      ...(cursor.history ? {
        startHistoryId: cursor.history
      } : {
        q: 'in:inbox OR in:sent'
      })
    });
    let page;
    try {
      page = await request(db, account, MAIL + (cursor.history ? '/history?' : '/messages?') + params);
    } catch (e) {
      if (e.status === 404 && cursor.history) {
        await db.inboundEmailAccount.update({
          where: {
            id: account.id
          },
          data: {
            syncCursor: null
          }
        });
        throw fail('Gmail history expired; sync again to refresh', 409);
      }
      throw e;
    }
    const ids = new Set(cursor.history ? (page.history || []).flatMap(h => [...(h.messagesAdded || []), ...(h.messagesDeleted || []), ...(h.labelsAdded || []), ...(h.labelsRemoved || [])].map(v => v.message.id)) : (page.messages || []).map(m => m.id));
    for (const id of ids) await importMessage(db, account, id, req);
    cursor = page.nextPageToken ? {
      ...cursor,
      page: page.nextPageToken
    } : {
      history: cursor.history ? page.historyId : cursor.initialHistory
    };
    await db.inboundEmailAccount.update({
      where: {
        id: account.id
      },
      data: {
        syncCursor: JSON.stringify(cursor),
        lastPolledAt: new Date(),
        lastError: null,
        status: 'Idle'
      }
    });
    return {
      imported: ids.size,
      moreMayBeAvailable: !!page.nextPageToken
    };
  } catch (e) {
    await db.inboundEmailAccount.update({
      where: {
        id: account.id
      },
      data: {
        lastError: String(e.message).slice(0, 300),
        status: 'Error'
      }
    });
    throw e;
  } finally {
    await releaseLease(db, key, lease);
  }
}
async function reply(db, account, message, body) {
  await owner(db, account);
  const clean = s => String(s || '').replace(/[\r\n]/g, '');
  const subject = 'Re: ' + String(message.subject || '').replace(/^Re:\s*/i, '');
  const mime = ['From: ' + clean(account.mailboxAddress), 'To: ' + clean(message.fromEmail), 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=', ...(message.messageId ? ['In-Reply-To: ' + clean(message.messageId), 'References: ' + clean(message.messageId)] : []), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64')].join('\r\n');
  return request(db, account, MAIL + '/messages/send', {
    method: 'POST',
    body: {
      raw: Buffer.from(mime).toString('base64url'),
      threadId: message.threadKey
    }
  });
}
function eventData(e, account) {
  if (e.status === 'cancelled') return {
    id: e.id,
    deleted: true,
    '@odata.etag': e.etag
  };
  const time = t => ({
    dateTime: new Date(t.dateTime || t.date + 'T00:00:00Z').toISOString(),
    timeZone: 'UTC'
  });
  return {
    id: e.id,
    '@odata.etag': e.etag,
    subject: e.summary,
    body: {
      content: e.description || ''
    },
    location: {
      displayName: e.location || ''
    },
    start: time(e.start),
    end: time(e.end),
    isAllDay: !!e.start.date,
    isOrganizer: !!e.organizer?.self,
    type: e.recurringEventId || e.recurrence ? 'occurrence' : 'singleInstance',
    attendees: (e.attendees || []).map(a => ({
      emailAddress: {
        address: a.email,
        name: a.displayName
      },
      type: a.optional ? 'optional' : 'required',
      status: {
        response: {
          accepted: 'accepted',
          declined: 'declined',
          tentative: 'tentativelyAccepted'
        }[a.responseStatus]
      }
    })),
    isReminderOn: !!e.reminders?.overrides?.length,
    reminderMinutesBeforeStart: e.reminders?.overrides?.[0]?.minutes || 0,
    onlineMeeting: {
      joinUrl: e.hangoutLink
    }
  };
}
async function remoteEvent(db, account, id) {
  return eventData(await request(db, account, CAL + '/' + encodeURIComponent(id)), account);
}
async function syncCalendar(db, account) {
  await owner(db, account, true);
  if (!account.calendarEnabled) throw fail('Enable calendar access first', 409);
  const key = 'outlook-calendar:' + account.id,
    lease = await acquireLease(db, key, 300000);
  if (!lease) return {
    busy: true
  };
  try {
    const cursor = account.calendarCursor ? JSON.parse(account.calendarCursor) : {};
    const params = new URLSearchParams({
      maxResults: '100',
      showDeleted: 'true',
      ...(cursor.sync && {
        syncToken: cursor.sync
      }),
      ...(cursor.page && {
        pageToken: cursor.page
      })
    });
    let page;
    try {
      page = await request(db, account, CAL + '?' + params);
    } catch (e) {
      if (e.status === 410) await db.inboundEmailAccount.update({
        where: {
          id: account.id
        },
        data: {
          calendarCursor: null
        }
      });
      throw e;
    }
    let conflicts = 0;
    for (const item of page.items || []) {
      const outcome = await require('./outlookCalendar').importEvent(db, account, eventData(item, account));
      if (outcome === 'conflict') conflicts++;
    }
    await db.inboundEmailAccount.update({
      where: {
        id: account.id
      },
      data: {
        calendarCursor: JSON.stringify(page.nextPageToken ? {
          ...cursor,
          page: page.nextPageToken
        } : {
          sync: page.nextSyncToken
        }),
        calendarLastSyncedAt: new Date(),
        calendarError: null
      }
    });
    return {
      synced: page.items?.length || 0,
      conflicts,
      more: !!page.nextPageToken
    };
  } catch (e) {
    await db.inboundEmailAccount.update({
      where: {
        id: account.id
      },
      data: {
        calendarError: String(e.message).slice(0, 300)
      }
    });
    throw e;
  } finally {
    await releaseLease(db, key, lease);
  }
}
async function publishCalendar(db, account, event) {
  await owner(db, account, true);
  if (!account.calendarEnabled) throw fail('Enable calendar access first', 409);
  const link = await db.outlookEventLink.findUnique({
    where: {
      eventId: event.id
    }
  });
  if (event.isRecurring || link && (link.accountId !== account.id || link.conflict || !link.remoteOrganizer || link.remoteRecurring)) throw fail('Resolve conflicts or manage this meeting in Google Calendar', 409);
  const key = 'outlook-calendar:' + account.id,
    lease = await acquireLease(db, key, 300000);
  if (!lease) throw fail('Calendar is busy', 409);
  try {
    const cancelled = event.isCancelled || event.status === 'Cancelled';
    if (cancelled && !link) throw fail('Meeting has not been published');
    const attendees = [];
    for (const a of event.invitees || []) {
      let email = a.email;
      if (!email && a.userId) email = (await db.user.findUnique({
        where: {
          id: a.userId
        }
      }))?.email;
      if (!email && a.contactId) email = (await db.contact.findUnique({
        where: {
          id: a.contactId
        }
      }))?.email;
      if (!email) throw fail('Each attendee needs an email');
      attendees.push({
        email
      });
    }
    const id = link?.remoteId || crypto.createHash('sha256').update(event.id).digest('hex');
    const time = d => event.allDay ? {
      date: d.toISOString().slice(0, 10)
    } : {
      dateTime: d.toISOString()
    };
    const body = {
      ...(!link && {
        id
      }),
      summary: event.title,
      description: event.description || '',
      location: event.location || '',
      start: time(event.startAt),
      end: time(event.endAt),
      attendees,
      visibility: 'private',
      reminders: {
        useDefault: false,
        overrides: (event.reminders || []).filter(r => r.method === 'Popup').slice(0, 5).map(r => ({
          method: 'popup',
          minutes: r.minutesBefore
        }))
      }
    };
    const remote = await request(db, account, CAL + (link ? '/' + encodeURIComponent(id) : '') + '?sendUpdates=all', {
      method: cancelled ? 'DELETE' : link ? 'PUT' : 'POST',
      headers: link?.remoteVersion ? {
        'If-Match': link.remoteVersion
      } : {},
      ...(!cancelled && {
        body
      })
    });
    const data = {
      remoteVersion: remote?.etag || null,
      localHash: require('./outlookCalendar').fingerprint(event),
      conflict: false,
      remoteOrganizer: true,
      remoteRecurring: false,
      syncedAt: new Date()
    };
    if (link) await db.outlookEventLink.update({
      where: {
        id: link.id
      },
      data
    });else await db.outlookEventLink.create({
      data: {
        ...data,
        eventId: event.id,
        accountId: account.id,
        remoteId: id
      }
    });
    return {
      published: true,
      cancelled
    };
  } catch (e) {
    if (e.status === 412 && link) await db.outlookEventLink.update({
      where: {
        id: link.id
      },
      data: {
        conflict: true
      }
    });
    throw e;
  } finally {
    await releaseLease(db, key, lease);
  }
}
async function sendFrom(db, account, {
  to,
  subject,
  body,
  isHtml = false
}) {
  await owner(db, account);
  const clean = s => String(s || '').replace(/[\r\n]/g, '');
  const mime = ['From: ' + clean(account.mailboxAddress), 'To: ' + clean(to), 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=', 'MIME-Version: 1.0', 'Content-Type: ' + (isHtml ? 'text/html' : 'text/plain') + '; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64')].join('\r\n');
  await request(db, account, MAIL + '/messages/send', {
    method: 'POST',
    body: {
      raw: Buffer.from(mime).toString('base64url')
    }
  });
  return {
    delivered: true,
    transport: 'gmail',
    from: account.mailboxAddress
  };
}
const owned = fn => (raw, account, ...args) => require('./revenueActor').asActor(raw, account.ownerId, 'emails', db => fn(db, account, ...args));
module.exports = {
  configured,
  verifier,
  authorize,
  connect,
  pollAccount: owned(pollAccount),
  reply: owned(reply),
  sendFrom: owned(sendFrom),
  syncCalendar: owned(syncCalendar),
  publishCalendar: owned(publishCalendar),
  remoteEvent: owned(remoteEvent),
  messageData,
  eventData
};
