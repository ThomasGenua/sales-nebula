/**
 * WebSocket Service (Socket.io)
 * Real-time updates for: deal stage changes, new notifications, chatter posts,
 * record updates, approval requests, and workflow executions.
 */

const jwt = require('jsonwebtoken');
const { resolveJwtSecret } = require('../utils/secrets');

const JWT_SECRET = resolveJwtSecret();

let io = null;
const userSockets = new Map(); // userId -> Set<socketId>

function initWebSocket(server) {
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
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.userId;
      socket.userRole = decoded.role;
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

    // Join role-based rooms
    if (socket.userRole) socket.join(`role:${socket.userRole}`);

    console.log(`  WS: ${userId} connected (${userSockets.get(userId).size} sessions)`);

    // Client can join record-specific rooms for live updates
    socket.on('join:record', ({ module, recordId }) => {
      socket.join(`record:${module}:${recordId}`);
    });

    socket.on('leave:record', ({ module, recordId }) => {
      socket.leave(`record:${module}:${recordId}`);
    });

    // Client can join module rooms for list view updates
    socket.on('join:module', (module) => {
      socket.join(`module:${module}`);
    });

    socket.on('leave:module', (module) => {
      socket.leave(`module:${module}`);
    });

    // Chatter: real-time typing indicator
    socket.on('chatter:typing', ({ feedId }) => {
      socket.to(`feed:${feedId}`).emit('chatter:typing', { userId, feedId });
    });

    socket.on('join:feed', (feedId) => {
      socket.join(`feed:${feedId || 'global'}`);
    });

    socket.on('disconnect', () => {
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

  // Broadcast to all connected users
  toAll(event, data) {
    if (io) io.emit(event, data);
  },

  // Notify users in a role
  toRole(role, event, data) {
    if (io) io.to(`role:${role}`).emit(event, data);
  },

  // Chatter feed update
  toFeed(feedId, event, data) {
    if (io) io.to(`feed:${feedId || 'global'}`).emit(event, data);
  },

  // ─── CONVENIENCE METHODS ───

  recordCreated(module, record) {
    this.toModule(module, 'record:created', { module, record });
  },

  recordUpdated(module, record) {
    this.toModule(module, 'record:updated', { module, record });
    this.toRecord(module, record.id, 'record:updated', { module, record });
  },

  recordDeleted(module, recordId) {
    this.toModule(module, 'record:deleted', { module, recordId });
    this.toRecord(module, recordId, 'record:deleted', { module, recordId });
  },

  notification(userId, notification) {
    this.toUser(userId, 'notification', notification);
  },

  dealStageChanged(deal, oldStage, newStage) {
    this.toAll('deal:stageChanged', { deal, oldStage, newStage });
  },

  approvalRequired(userId, request) {
    this.toUser(userId, 'approval:required', request);
  },

  workflowExecuted(result) {
    this.toAll('workflow:executed', result);
  },

  chatterNewPost(post, feedId) {
    this.toFeed(feedId, 'chatter:newPost', post);
  },

  forecastUpdated(forecast) {
    this.toAll('forecast:updated', forecast);
  },
};

function getOnlineUsers() {
  return [...userSockets.keys()];
}

module.exports = { initWebSocket, emit, getOnlineUsers };
