const db = require('../database/init');
const { isMember } = require('../database/chat');
const { broadcastsPresence, touchLastSeen, peek } = require('../database/settings');
const { activeBan } = require('../database/admin');

// Tracks how many active sockets each user currently has open, so we only
// broadcast "went offline" after their last tab/window disconnects.
const onlineCounts = new Map(); // userId -> count

// Is this session still an approved, active login?
// Mirrors requireAuth(): a session revoked from Settings (or an account that
// was deactivated) must not keep a live socket just because the cookie is old.
function socketSessionValid(request) {
  if (!request.session || !request.session.userId || !request.sessionID) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.status, u.role, u.is_verified
    FROM users u
    JOIN user_sessions s ON s.user_id = u.id AND s.session_id = ?
    WHERE u.id = ?
  `).get(request.sessionID, request.session.userId);
  if (!row || row.status !== 'active') return null; // deactivated OR admin-disabled
  // Banned accounts lose their live socket the moment the ban lands.
  if (activeBan(row.id)) return null;
  return row;
}

// Is this user allowed to be seen as online at all?
function mayBroadcast(userId) {
  return broadcastsPresence(userId);
}

// Every user joins the room `user:<id>` (used for friend events, group events
// and targeted deliveries) and `conv:<id>` for each conversation they belong
// to. Conversation rooms are what make a chat message O(members) instead of
// "broadcast to the whole site".
function initSocket(io, sessionMiddleware) {
  // Share the Express session with Socket.IO so we know who's connecting.
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });

  io.on('connection', (socket) => {
    const user = socketSessionValid(socket.request);

    if (user) {
      socket.data.userId = user.id;
      socket.data.username = user.username;

      const count = (onlineCounts.get(user.id) || 0) + 1;
      onlineCounts.set(user.id, count);
      touchLastSeen(user.id);

      // "Show my online status" is enforced HERE: a user who has it off is
      // simply never announced, so no client ever adds them to its online set.
      if (count === 1 && mayBroadcast(user.id)) {
        io.emit('user_online', { userId: user.id, username: user.username });
      }

      // Join the user's own room plus every conversation room they are in.
      socket.join(`user:${user.id}`);
      // Staff share a private room so admin events (new report, ban, ...)
      // reach every open panel without polling and without a public broadcast.
      if (user.role && user.role !== 'user') socket.join('admins');
      const convs = db.prepare(
        'SELECT conversation_id FROM conversation_members WHERE user_id = ?'
      ).all(user.id);
      convs.forEach(c => socket.join(`conv:${c.conversation_id}`));

      // Presence withheld from everyone, so their id is not handed out either.
      const visible = Array.from(onlineCounts.keys()).filter(mayBroadcast);
      socket.emit('online_users', visible);
    }

    // ---- Typing indicator ----
    // The server re-checks membership; a client cannot fake typing in a
    // conversation it does not belong to.
    socket.on('typing', (payload) => {
      const uid = socket.data.userId;
      if (!uid) return;
      const conversationId = Number(payload && payload.conversationId);
      if (!Number.isInteger(conversationId) || conversationId <= 0) return;
      if (!isMember(conversationId, uid)) return;

      socket.to(`conv:${conversationId}`).emit('typing', {
        conversationId,
        userId: uid,
        username: socket.data.username,
        typing: payload && payload.typing !== false
      });
    });

    socket.on('disconnect', () => {
      const uid = socket.data.userId;
      if (!uid) return;
      const count = (onlineCounts.get(uid) || 1) - 1;
      if (count <= 0) {
        onlineCounts.delete(uid);
        touchLastSeen(uid);
        // Only announce the departure if we announced the arrival — otherwise
        // we would leak that a presence-hidden user was just here.
        if (mayBroadcast(uid)) io.emit('user_offline', { userId: uid });
      } else {
        onlineCounts.set(uid, count);
      }
    });
  });
}

// Called when a user toggles "Show my online status" in Settings, so the
// change takes effect on every connected client immediately instead of
// waiting for them to reconnect.
function announcePresenceChange(io, userId) {
  if (!io || !userId) return;
  const online = onlineCounts.has(userId);
  const visible = mayBroadcast(userId);
  if (online && visible) {
    const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    io.emit('user_online', { userId, username: row ? row.username : '' });
  } else if (!visible) {
    io.emit('user_offline', { userId });
  }
}

// ============================================================================
// NOTIFICATIONS
// ----------------------------------------------------------------------------
// A notification and a UI update are two different things, and this project
// keeps them apart on purpose:
//
//   UI sync  — like_update, new_comment, message bubbles, follow counts.
//              These ALWAYS flow. Turning "likes" off must not freeze the
//              like counter on everyone else's screen.
//   Notify   — a ping aimed at ONE person ("someone liked YOUR post"). These
//              come through here, and are dropped unless the RECIPIENT's own
//              preference for that category is on.
//
// The preference is therefore enforced by the server against the stored
// value, not by hiding a control in the UI: an attacker who crafts the
// request by hand gets the same answer.
// ============================================================================
function notifyUser(io, userId, prefKey, payload) {
  if (!io || !userId || !prefKey || !payload) return false;
  if (!peek(userId)[prefKey]) return false; // recipient's choice wins
  io.to(`user:${userId}`).emit('notification', payload);
  return true;
}

initSocket.announcePresenceChange = announcePresenceChange;
initSocket.notifyUser = notifyUser;
initSocket.onlineCounts = onlineCounts;

module.exports = initSocket;
