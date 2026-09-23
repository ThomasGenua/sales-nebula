/**
 * WebSocket Service (Socket.io)
 * Real-time updates for: record changes, deal stage changes, notifications,
 * chatter posts and approval requests.
 *
 * A socket only ever hears what its user could fetch. Record events carry
 * the module and id, never the record, so a client fetches it through the
 * API and its permission checks. A record room takes a record the user can
 * see. A module room, which hears about every record in the module, takes
 * read permission and a module none of whose records are hidden from the
 * user; anyone else follows records one by one. Every created or updated
 * record used to go out whole to anyone who asked to join its module's room,
 * and every deal stage change, deal included, to every connected user.
 *
 * A socket closes when the access token it opened with expires, so a
 * sign-out, a disabled account or a change of permissions reaches it within
 * that token's lifetime; the client reconnects with a fresh token, and its
 * rooms are checked again.
 *
 * Sessions only: connected-app tokens are not taken here, since an open
 * socket would outlive the app's revocation.
 */

const jwt = require('jsonwebtoken');
const { parseCookies, ACCESS_COOKIE } = require('../utils/sessionCookies');
const { resolveJwtSecret } = require('../utils/secrets');
const { isBlacklisted } = require('../middleware/auth');
const { buildAccessFilter, applyAccessFilter, isAdmin } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');

const JWT_SECRET = resolveJwtSecret();
const LEVELS = { none: 0, read: 1, edit: 2, full: 3 };

let io = null;
const userSockets = new Map(); // userId -> Set<socketId>

/** Whether the user's role may read a module, as requirePermission decides. */
function canReadModule(user, module) {
  if (isAdmin(user)) return true;
  const perm = user?.role?.permissions?.find(p => p.module === module);
  return (LEVELS[perm?.level] || 0) >= LEVELS.read;
}

/** Whether the user can see one record, by the same filter the API applies. */
async function canSeeRecord(prisma, user, module, recordId) {
  const modelName = crudModelFor(module);
  if (!modelName || !canReadModule(user, module)) return false;
  const filter = await buildAccessFilter(prisma, user, module, { modelName });
  const live = prisma[modelName]?.fields?.deletedAt ? { deletedAt: null } : {};
  const record = await prisma[modelName].findFirst({
    where: applyAccessFilter({ id: recordId, ...live }, filter),
    select: { id: true },
  });
  return !!record;
}

/**
 * Why the user may not follow a whole module, or null when they may: only
 * when no record in it is hidden from them, or its events would name
 * records they cannot open.
 */
async function moduleRoomRefusal(prisma, user, module) {
  const modelName = crudModelFor(module);
  if (!modelName) return 'No live updates for this module';
  if (!canReadModule(user, module)) return 'No read permission on this module';
  if (await buildAccessFilter(prisma, user, module, { modelName })) {
    return 'Some records in this module are hidden from you; follow records with join:record';
  }
  return null;
}

const reply = (ack, ok, reason) => { if (typeof ack === 'function') ack(reason ? { ok, reason } : { ok }); };
const isName = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

function initWebSocket(server, prisma) {
  let Server;
  try { Server = require('socket.io').Server; } catch (e) {
    console.log('  WebSocket: socket.io not installed, skipping');
    return;
  }

  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:7544',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Auth middleware
  io.use(async (socket, next) => {
    // A token handed over explicitly, or the browser's session cookie, which
    // the handshake carries on its own. The cookie is SameSite=Lax, so a
    // socket opened by a page on another site arrives without it.
    const given = socket.handshake.auth?.token;
    const token = typeof given === 'string' && given
      ? given
      : parseCookies(socket.handshake.headers?.cookie)[ACCESS_COOKIE];
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      // Only a live session access token, as in the HTTP middleware: not a
      // signed-out one, and not one whose account is gone or disabled.
      if (decoded.type !== 'access') return next(new Error('Invalid token'));
      if (decoded.jti && await isBlacklisted(decoded.jti)) return next(new Error('Invalid token'));
      const user = prisma && await prisma.user.findUnique({
        where: { id: decoded.userId },
        include: { role: { include: { permissions: true } } },
      });
      if (!user || !user.active) return next(new Error('Invalid token'));
      // Customer portal accounts have nothing to follow here (see auth.js).
      if (user.isPortalUser) return next(new Error('Not available to portal accounts'));
      socket.user = user;
      socket.userId = user.id;
      socket.tokenExpiresAt = decoded.exp ? decoded.exp * 1000 : null;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;

    // Track user connections
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    // Join user-specific room for targeted notifications
    socket.join(`user:${userId}`);

    // Closed when its token expires; the client reconnects with a new one.
    // (A longer delay than setTimeout's 32-bit limit would fire at once.)
    const expiry = socket.tokenExpiresAt && setTimeout(() => {
      socket.emit('session:expired');
      socket.disconnect(true);
    }, Math.min(Math.max(0, socket.tokenExpiresAt - Date.now()), 2147483647));

    console.log(`  WS: ${userId} connected (${userSockets.get(userId).size} sessions)`);

    // Live updates for one record the user can see. The ack, if the client
    // passes one, says whether it was let in.
    socket.on('join:record', async (payload, ack) => {
      const { module, recordId } = payload || {};
      if (!isName(module) || !isName(recordId)) return reply(ack, false);
      try {
        const ok = await canSeeRecord(prisma, socket.user, module, recordId);
        if (ok) socket.join(`record:${module}:${recordId}`);
        reply(ack, ok);
      } catch (err) {
        reply(ack, false);
      }
    });

    socket.on('leave:record', (payload) => {
      const { module, recordId } = payload || {};
      if (isName(module) && isName(recordId)) socket.leave(`record:${module}:${recordId}`);
    });

    // List view updates, for a module the user can see all of
    socket.on('join:module', async (module, ack) => {
      if (!isName(module)) return reply(ack, false);
      try {
        const refusal = await moduleRoomRefusal(prisma, socket.user, module);
        if (!refusal) socket.join(`module:${module}`);
        reply(ack, !refusal, refusal);
      } catch (err) {
        reply(ack, false);
      }
    });

    socket.on('leave:module', (module) => {
      if (isName(module)) socket.leave(`module:${module}`);
    });

    // Chatter: real-time typing indicator
    socket.on('chatter:typing', (payload) => {
      const { feedId } = payload || {};
      if (isName(feedId)) socket.to(`feed:${feedId}`).emit('chatter:typing', { userId, feedId });
    });

    socket.on('join:feed', (feedId) => {
      socket.join(`feed:${isName(feedId) ? feedId : 'global'}`);
    });

    socket.on('disconnect', () => {
      if (expiry) clearTimeout(expiry);
      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) userSockets.delete(userId);
      }
    });
  });

  console.log('  WebSocket: Socket.io initialized');
  return io;
}

// ─── EMIT HELPERS (called from routes/services) ───

const emit = {
  // Notify a specific user (e.g., approval request, @mention)
  toUser(userId, event, data) {
    if (io) io.to(`user:${userId}`).emit(event, data);
  },

  // Notify all users viewing a specific record
  toRecord(module, recordId, event, data) {
    if (io) io.to(`record:${module}:${recordId}`).emit(event, data);
  },

  // Notify all users viewing a module list
  toModule(module, event, data) {
    if (io) io.to(`module:${module}`).emit(event, data);
  },

  // Chatter feed update
  toFeed(feedId, event, data) {
    if (io) io.to(`feed:${feedId || 'global'}`).emit(event, data);
  },

  // ─── CONVENIENCE METHODS ───
  // Ids only: the recipient fetches the record, through its own permissions.

  recordCreated(module, record) {
    this.toModule(module, 'record:created', { module, recordId: record.id });
  },

  recordUpdated(module, record) {
    const event = { module, recordId: record.id };
    this.toModule(module, 'record:updated', event);
    this.toRecord(module, record.id, 'record:updated', event);
  },

  recordDeleted(module, recordId) {
    this.toModule(module, 'record:deleted', { module, recordId });
    this.toRecord(module, recordId, 'record:deleted', { module, recordId });
  },

  notification(userId, notification) {
    this.toUser(userId, 'notification', notification);
  },

  // To whoever is watching the deal, and its owner.
  dealStageChanged(deal, oldStage, newStage) {
    const event = { module: 'deals', recordId: deal.id, oldStage, newStage };
    this.toRecord('deals', deal.id, 'deal:stageChanged', event);
    if (deal.ownerId) this.toUser(deal.ownerId, 'deal:stageChanged', event);
  },

  approvalRequired(userId, request) {
    this.toUser(userId, 'approval:required', request);
  },

  chatterNewPost(post, feedId) {
    this.toFeed(feedId, 'chatter:newPost', { feedId: feedId || 'global', postId: post.id });
  },
};

function getOnlineUsers() {
  return [...userSockets.keys()];
}

module.exports = { initWebSocket, emit, getOnlineUsers };
