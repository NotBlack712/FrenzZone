const express = require('express');
const db = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const { friendRequestBetween, friendCountOf, friendRows } = require('../database/friends');
const settings = require('../database/settings');

const router = express.Router();

// Public-safe projection of a user — never leaks email/password fields.
function pub(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, bio: u.bio || '', avatar_path: u.avatar_path || null, is_verified: u.is_verified ? 1 : 0 };
}

function loadUser(id) {
  return db.prepare('SELECT id, username, bio, avatar_path, is_verified FROM users WHERE id = ?').get(id);
}

// Only accounts that are actually on the site may be ADDRESSED by a new
// action (friend request, chat, group invite). loadUser() above is still used
// for rows that already reference someone, so an existing friendship with a
// deactivated account can be viewed and removed as normal.
function loadActiveUser(id) {
  return db.prepare(
    "SELECT id, username, bio, avatar_path, is_verified FROM users WHERE id = ? AND status = 'active'"
  ).get(id);
}

// Reads a numeric id from the body/params, writes the error and returns null.
function intId(raw, res, label) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: `Invalid ${label}.` });
    return null;
  }
  return id;
}

// Emits a friend event to exactly one user's sockets (their tabs).
function emitTo(io, userId, event, payload) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}

// ---------- List my friends (optional ?q= search) ----------
// Matches ONLY accepted friends — this endpoint can never enumerate users.
router.get('/', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const friends = friendRows(req.user.id, q, 200);
  res.json({ friends, total: friendCountOf(req.user.id) });
});

// ---------- Pending requests (drives the notification panel) ----------
router.get('/requests', requireAuth, (req, res) => {
  const incoming = db.prepare(`
    SELECT fr.id, fr.created_at, u.id AS user_id, u.username, u.bio, u.avatar_path, u.is_verified
    FROM friend_requests fr JOIN users u ON u.id = fr.sender_id
    WHERE fr.receiver_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
    LIMIT 100
  `).all(req.user.id);

  const outgoing = db.prepare(`
    SELECT fr.id, fr.created_at, u.id AS user_id, u.username, u.bio, u.avatar_path, u.is_verified
    FROM friend_requests fr JOIN users u ON u.id = fr.receiver_id
    WHERE fr.sender_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
    LIMIT 100
  `).all(req.user.id);

  res.json({
    incoming: incoming.map(r => ({ id: r.id, sent_at: r.created_at, user: pub(r) })),
    outgoing: outgoing.map(r => ({ id: r.id, sent_at: r.created_at, user: pub(r) })),
    friendCount: friendCountOf(req.user.id)
  });
});

// ---------- Relationship with one specific user ----------
router.get('/status/:userId', requireAuth, (req, res) => {
  const otherId = intId(req.params.userId, res, 'user id');
  if (!otherId) return;
  if (!loadActiveUser(otherId)) return res.status(404).json({ error: 'User not found.' });
  const row = friendRequestBetween(req.user.id, otherId);
  const status = !row ? 'none'
    : row.status === 'accepted' ? 'friends'
    : (row.sender_id === req.user.id ? 'sent' : 'received');
  // requestId lets the UI Accept/Reject/Cancel without a second lookup.
  res.json({ status, requestId: row ? row.id : null });
});

// ---------- Send a friend request ----------
router.post('/requests', requireAuth, (req, res) => {
  const receiverId = intId(req.body && req.body.receiverId, res, 'user id');
  if (!receiverId) return;

  // 1. Never to yourself.
  if (receiverId === req.user.id) {
    return res.status(400).json({ error: 'You cannot send yourself a friend request.' });
  }

  // 2. The target must exist AND be on the site right now.
  const target = loadActiveUser(receiverId);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  // 2b. THEIR privacy setting decides whether they accept requests at all.
  //     Evaluated against the receiver's preference — changing your own
  //     setting can never force your way into someone else's inbox.
  if (!settings.canSendFriendRequest(req.user.id, receiverId)) {
    return res.status(403).json({ error: 'This person is not accepting friend requests right now.' });
  }

  const existing = db.prepare(`
    SELECT id, sender_id, receiver_id, status FROM friend_requests
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
  `).get(req.user.id, receiverId, receiverId, req.user.id);

  // 3. Already friends.
  if (existing && existing.status === 'accepted') {
    return res.status(409).json({ error: 'You are already friends.', status: 'friends' });
  }

  // 4. They already asked me -> tell the client so it can offer Accept/Reject.
  if (existing && existing.status === 'pending' && existing.sender_id !== req.user.id) {
    return res.status(409).json({ error: 'They already sent you a request.', status: 'received' });
  }

  // 5. My own request is already pending -> idempotent, no duplicate row.
  if (existing && existing.status === 'pending') {
    return res.json({ status: 'sent', request: { id: existing.id }, user: pub(target) });
  }

  // 6. Otherwise create. The unique pair index makes a race here impossible:
  //    if the other direction got inserted first, this throws UNIQUE and we
  //    report the conflict instead of creating a second row.
  let requestId;
  try {
    const info = db.prepare(
      `INSERT INTO friend_requests (sender_id, receiver_id, status, created_at, updated_at)
       VALUES (?, ?, 'pending', datetime('now'), datetime('now'))`
    ).run(req.user.id, receiverId);
    requestId = Number(info.lastInsertRowid);
  } catch (err) {
    if (!/UNIQUE/i.test(err.message || '')) throw err;
    return res.status(409).json({ error: 'A friend request already exists.', status: 'received' });
  }

  const io = req.app.get('io');
  // "Friend requests" notification preference gates the LIVE push — the toast
  // and the bell badge. The request row still exists and still appears on the
  // Friends page, so switching notifications off hides the noise without
  // silently rejecting people who asked.
  if (settings.peek(receiverId).friend_request_notifications) {
    emitTo(io, receiverId, 'friend_request', {
      request: { id: requestId, status: 'pending', sent_at: new Date().toISOString() },
      from: pub(req.user)
    });
  }

  res.status(201).json({ status: 'sent', request: { id: requestId }, user: pub(target) });
});

// ---------- Accept (receiver only) ----------
router.post('/requests/:id/accept', requireAuth, (req, res) => {
  const requestId = intId(req.params.id, res, 'request id');
  if (!requestId) return;

  const row = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(requestId);
  if (!row) return res.status(404).json({ error: 'Friend request not found.' });

  // Authorization: only the RECEIVER may accept. Never trust the client.
  if (row.receiver_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only accept requests sent to you.' });
  }
  if (row.status !== 'pending') {
    return res.status(409).json({ error: 'That request is no longer pending.', status: row.status });
  }

  db.prepare(
    `UPDATE friend_requests SET status = 'accepted', updated_at = datetime('now') WHERE id = ?`
  ).run(requestId);

  const other = loadUser(row.sender_id);
  const io = req.app.get('io');

  // Tell BOTH sides so their UIs update without a refresh.
  emitTo(io, row.sender_id, 'friend_request_accepted', {
    request: { id: requestId, status: 'accepted' },
    by: pub(req.user)
  });
  emitTo(io, req.user.id, 'friend_request_accepted', {
    request: { id: requestId, status: 'accepted' },
    by: pub(other)
  });

  res.json({ status: 'friends', user: pub(other) });
});

// ---------- Reject (receiver only) ----------
router.post('/requests/:id/reject', requireAuth, (req, res) => {
  const requestId = intId(req.params.id, res, 'request id');
  if (!requestId) return;

  const row = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(requestId);
  if (!row) return res.status(404).json({ error: 'Friend request not found.' });
  if (row.receiver_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only reject requests sent to you.' });
  }
  if (row.status !== 'pending') {
    return res.status(409).json({ error: 'That request is no longer pending.', status: row.status });
  }

  // Deleting (rather than marking) is what allows a later re-request.
  db.prepare('DELETE FROM friend_requests WHERE id = ?').run(requestId);

  const io = req.app.get('io');
  emitTo(io, row.sender_id, 'friend_request_rejected', {
    request: { id: requestId },
    by: pub(req.user)
  });

  res.json({ status: 'none' });
});

// ---------- Cancel (sender only) ----------
router.delete('/requests/:id', requireAuth, (req, res) => {
  const requestId = intId(req.params.id, res, 'request id');
  if (!requestId) return;

  const row = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(requestId);
  if (!row) return res.status(404).json({ error: 'Friend request not found.' });
  if (row.sender_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only cancel requests you sent.' });
  }
  if (row.status !== 'pending') {
    return res.status(409).json({ error: 'That request is no longer pending.', status: row.status });
  }

  db.prepare('DELETE FROM friend_requests WHERE id = ?').run(requestId);

  const io = req.app.get('io');
  emitTo(io, row.receiver_id, 'friend_request_cancelled', {
    request: { id: requestId },
    by: pub(req.user)
  });

  res.json({ status: 'none' });
});

// ---------- Unfriend ----------
// Deletes the ONE accepted pair row. `WHERE` requires req.user to be one of
// the two members, so an id swap in the client can never remove someone
// else's friendship. Conversations and messages are never touched here.
router.delete('/:userId', requireAuth, (req, res) => {
  const otherId = intId(req.params.userId, res, 'user id');
  if (!otherId) return;
  if (otherId === req.user.id) return res.status(400).json({ error: 'You are not friends with yourself.' });

  // The target must actually exist — an orphaned row for a deleted account
  // is not a successful unfriend.
  const other = loadUser(otherId);
  if (!other) return res.status(404).json({ error: 'User not found.' });

  const info = db.prepare(`
    DELETE FROM friend_requests
    WHERE status = 'accepted'
      AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
  `).run(req.user.id, otherId, otherId, req.user.id);

  if (info.changes === 0) return res.status(404).json({ error: 'You are not friends.' });

  const io = req.app.get('io');
  // Both sides hear about it: the other user, and any extra tab of the person
  // who clicked. `actorId` lets a client recognise its own action and skip
  // the "X removed you" toast it already gave itself.
  emitTo(io, otherId, 'friend_removed', { user: pub(req.user), actorId: req.user.id });
  emitTo(io, req.user.id, 'friend_removed', { user: pub(other), actorId: req.user.id });

  res.json({ status: 'none' });
});

module.exports = router;
