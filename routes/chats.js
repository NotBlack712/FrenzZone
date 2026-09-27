const express = require('express');
const db = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const { areFriends, friendIdsOf } = require('../database/friends');
const { canMessage, peek } = require('../database/settings');
const { notifyUser } = require('../socket/index');
const {
  memberRow,
  isMember,
  canManage,
  memberIdsOf,
  membersWithUsers,
  conversationRow,
  conversationListFor,
  findPrivateConversation,
  unreadCount,
  unreadTotal
} = require('../database/chat');
const { groupAvatarUpload, verifyImageSignature, deleteUploadFile } = require('../middleware/upload');

const router = express.Router();

const MAX_MESSAGE_LEN = 2000;
const MAX_GROUP_SIZE = 60; // members including the creator

// SQLite has no transaction() helper in node:sqlite, and BEGIN/COMMIT is what
// keeps "create conversation + insert members" from ever being half-applied.
function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) { /* already rolled back */ }
    throw err;
  }
}

function pub(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, bio: u.bio || '', avatar_path: u.avatar_path || null, is_verified: u.is_verified ? 1 : 0 };
}

function loadUser(id) {
  return db.prepare('SELECT id, username, bio, avatar_path, is_verified FROM users WHERE id = ?').get(id);
}

// Only accounts that are actually on the site may be ADDRESSED by a new
// action (start a chat, add to a group). loadUser() above stays available for
// rows that already reference someone, so existing conversations with a
// deactivated account remain readable.
function loadActiveUser(id) {
  return db.prepare(
    "SELECT id, username, bio, avatar_path, is_verified FROM users WHERE id = ? AND status = 'active'"
  ).get(id);
}

function intId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Message row -> API/socket payload (with the sender's public profile).
function messagePayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    content: row.content,
    created_at: row.created_at,
    sender: { id: row.sender_id, username: row.username, avatar_path: row.avatar_path || null, is_verified: row.is_verified ? 1 : 0 }
  };
}

// Reads :id and writes the error response itself, so callers just return.
function conversationParam(req, res) {
  const id = intId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid conversation id.' });
    return null;
  }
  if (!conversationRow(id)) {
    res.status(404).json({ error: 'Conversation not found.' });
    return null;
  }
  return id;
}

// The membership check. Every read/write path calls this — a guessed URL or
// request body id is useless without a matching row in conversation_members.
function requireMember(req, res) {
  const id = conversationParam(req, res);
  if (!id) return null;
  const me = memberRow(id, req.user.id);
  if (!me) {
    res.status(403).json({ error: 'You are not a member of this conversation.' });
    return null;
  }
  return { id, me };
}

// ---------- My conversation list ----------
router.get('/', requireAuth, (req, res) => {
  res.json({
    conversations: conversationListFor(req.user.id),
    unreadTotal: unreadTotal(req.user.id)
  });
});

// ---------- Open (or create) a private chat with a FRIEND ----------
router.post('/private', requireAuth, (req, res) => {
  const otherId = intId(req.body && req.body.userId);
  if (!otherId) return res.status(400).json({ error: 'Invalid user id.' });
  if (otherId === req.user.id) {
    return res.status(400).json({ error: 'You cannot start a chat with yourself.' });
  }
  if (!loadActiveUser(otherId)) return res.status(404).json({ error: 'User not found.' });

  // Rule #8/#21: only friends may start a private chat — unless the receiver
  // has widened it to "Everyone" or closed it with "Nobody" in Settings.
  // Defaults come from user_settings, so a user with no row behaves exactly
  // as before (friends only).
  if (!canMessage(req.user.id, otherId)) {
    const privacy = peek(otherId).message_privacy;
    return res.status(403).json({
      error: privacy === 'nobody'
        ? 'This person is not accepting messages.'
        : 'You can only message people on your friends list.'
    });
  }

  const existing = findPrivateConversation(req.user.id, otherId);
  if (existing) {
    const summary = conversationListFor(req.user.id, 1, existing.id)[0];
    return res.json({ conversation: summary, created: false });
  }

  const convId = inTransaction(() => {
    const info = db.prepare(
      `INSERT INTO conversations (type, created_by, created_at, updated_at)
       VALUES ('private', ?, datetime('now'), datetime('now'))`
    ).run(req.user.id);
    const id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_msg_id, last_read_at, joined_at)
       VALUES (?, ?, 'member', 0, datetime('now'), datetime('now'))`
    );
    ins.run(id, req.user.id);
    ins.run(id, otherId);
    return id;
  });

  const io = req.app.get('io');
  if (io) {
    // Both sockets start listening on the conversation room immediately, so a
    // message sent a second later reaches them with no page reload.
    io.in(`user:${req.user.id}`).socketsJoin(`conv:${convId}`);
    io.in(`user:${otherId}`).socketsJoin(`conv:${convId}`);
    io.to(`user:${otherId}`).emit('conversation_created', {
      conversation: conversationListFor(otherId, 1, convId)[0]
    });
    // Sidebar entry (above) always lands; the "someone started a chat with you"
    // ping respects the recipient's "Other notifications" preference.
    notifyUser(io, otherId, 'other_notifications', {
      kind: 'chat_started',
      conversationId: convId,
      actor: { id: req.user.id, username: req.user.username, avatar_path: req.user.avatar_path, is_verified: req.user.is_verified ? 1 : 0 }
    });
  }

  res.status(201).json({
    conversation: conversationListFor(req.user.id, 1, convId)[0],
    created: true
  });
});

// ---------- Create a group (friends only) ----------
router.post('/groups', requireAuth, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Group name is required.' });

  const raw = Array.isArray(req.body && req.body.memberIds) ? req.body.memberIds : [];
  const ids = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && n > 0))]
    .filter(id => id !== req.user.id)
    .slice(0, MAX_GROUP_SIZE);

  if (!ids.length) return res.status(400).json({ error: 'Select at least one friend.' });

  // Only friends can be pulled into a group — never arbitrary user ids.
  const myFriends = new Set(friendIdsOf(req.user.id));
  const notFriends = ids.filter(id => !myFriends.has(id));
  if (notFriends.length) {
    return res.status(403).json({ error: 'You can only add your friends to a group.' });
  }

  const convId = inTransaction(() => {
    const info = db.prepare(
      `INSERT INTO conversations (type, name, created_by, created_at, updated_at)
       VALUES ('group', ?, ?, datetime('now'), datetime('now'))`
    ).run(name, req.user.id);
    const id = Number(info.lastInsertRowid);
    const owner = db.prepare(
      `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_msg_id, last_read_at, joined_at)
       VALUES (?, ?, 'owner', 0, datetime('now'), datetime('now'))`
    );
    const member = db.prepare(
      `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_msg_id, last_read_at, joined_at)
       VALUES (?, ?, 'member', 0, datetime('now'), datetime('now'))`
    );
    owner.run(id, req.user.id);
    for (const mid of ids) member.run(id, mid);
    return id;
  });

  const io = req.app.get('io');
  if (io) {
    io.in(`user:${req.user.id}`).socketsJoin(`conv:${convId}`);
    ids.forEach(mid => io.in(`user:${mid}`).socketsJoin(`conv:${convId}`));
    const summary = conversationListFor(req.user.id, 1, convId)[0];
    ids.forEach(mid => io.to(`user:${mid}`).emit('group_created', { conversation: summary }));
    // Being added to a group is an "Other notifications" ping, not a UI update.
    ids.forEach(mid => notifyUser(io, mid, 'other_notifications', {
      kind: 'group_invite',
      conversationId: convId,
      groupName: name,
      actor: { id: req.user.id, username: req.user.username, avatar_path: req.user.avatar_path, is_verified: req.user.is_verified ? 1 : 0 }
    }));
  }

  res.status(201).json({ conversation: conversationListFor(req.user.id, 1, convId)[0] });
});

// ---------- Conversation detail (members, roles, my permissions) ----------
router.get('/:id', requireAuth, (req, res) => {
  const auth = requireMember(req, res);
  if (!auth) return;
  const { id, me } = auth;

  const conv = conversationListFor(req.user.id, 1, id)[0];
  res.json({
    conversation: conv,
    members: membersWithUsers(id),
    my_role: me.role,
    permissions: {
      canManage: canManage(me.role),
      canChangeRoles: me.role === 'owner',
      canAdd: canManage(me.role) && conv.type === 'group',
      canLeave: true
    }
  });
});

// ---------- Message history (keyset pagination, newest page first) ----------
// GET /api/chats/:id/messages            -> latest `limit` messages
// GET /api/chats/:id/messages?before=ID  -> the page older than that message
router.get('/:id/messages', requireAuth, (req, res) => {
  const auth = requireMember(req, res);
  if (!auth) return;
  const { id } = auth;

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const before = intId(req.query.before); // null on the first page

  const rows = db.prepare(`
    SELECT * FROM (
      SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
             u.username, u.avatar_path, u.is_verified
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ? AND (? IS NULL OR m.id < ?)
      ORDER BY m.id DESC
      LIMIT ?
    )
    ORDER BY id ASC
  `).all(id, before, before, limit);

  res.json({
    messages: rows.map(messagePayload),
    // A full page means there may be more history to fetch on scroll-up.
    hasMore: rows.length === limit
  });
});

// ---------- Send a message ----------
// REST is the write path (one auth path, a real error/ack for the sender);
// Socket.IO is the delivery path — the server emits to the conversation room.
router.post('/:id/messages', requireAuth, (req, res) => {
  const auth = requireMember(req, res);
  if (!auth) return;
  const { id } = auth;

  const content = String((req.body && req.body.content) || '').trim();
  if (!content) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (content.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({ error: `Messages are limited to ${MAX_MESSAGE_LEN} characters.` });
  }

  const info = db.prepare(
    `INSERT INTO messages (conversation_id, sender_id, content, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  ).run(id, req.user.id, content);
  db.prepare('UPDATE conversations SET updated_at = datetime(\'now\') WHERE id = ?').run(id);

  const row = db.prepare(`
    SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
           u.username, u.avatar_path, u.is_verified
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(Number(info.lastInsertRowid));

  const message = messagePayload(row);
  const io = req.app.get('io');
  if (io) {
    // Emitted to the whole room, sender included; the client de-duplicates by
    // message id, so a slow echo can never show the message twice.
    const conv = conversationRow(id);
    const evt = conv.type === 'group' ? 'new_group_message' : 'new_private_message';
    io.to(`conv:${id}`).emit(evt, {
      conversationId: id,
      conversation: conversationListFor(req.user.id, 1, id)[0],
      message
    });

    // The room emit above IS the live UI — thread bubbles, sidebar preview and
    // unread count, for everyone, always. This second pass is the *ping*, sent
    // to each OTHER member individually so their own preference decides:
    // "Messages" for a private chat, "Group messages" for a group.
    const prefKey = conv.type === 'group' ? 'group_notifications' : 'message_notifications';
    const kind = conv.type === 'group' ? 'group_message' : 'message';
    const others = db.prepare(
      'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?'
    ).all(id, req.user.id);
    others.forEach(r => notifyUser(io, r.user_id, prefKey, {
      kind,
      conversationId: id,
      preview: content.slice(0, 80),
      actor: { id: req.user.id, username: req.user.username, avatar_path: req.user.avatar_path, is_verified: req.user.is_verified ? 1 : 0 }
    }));
  }

  res.status(201).json({ message, unread: 0 });
});

// ---------- Mark read ----------
router.post('/:id/read', requireAuth, (req, res) => {
  const auth = requireMember(req, res);
  if (!auth) return;
  const { id } = auth;

  const max = db.prepare('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?').get(id).m || 0;
  db.prepare(`
    UPDATE conversation_members
    SET last_read_msg_id = MAX(last_read_msg_id, ?),
        last_read_at = datetime('now')
    WHERE conversation_id = ? AND user_id = ?
  `).run(max, id, req.user.id);

  const io = req.app.get('io');
  if (io) {
    io.to(`conv:${id}`).emit('message_read', {
      conversationId: id,
      userId: req.user.id,
      username: req.user.username,
      last_read_msg_id: max
    });
  }

  res.json({ unread: 0, last_read_msg_id: max, unreadTotal: unreadTotal(req.user.id) });
});

// ---------- Group: rename / change image (owner or admin) ----------
function requireManagedGroup(req, res) {
  const auth = requireMember(req, res);
  if (!auth) return null;
  const conv = conversationRow(auth.id);
  if (conv.type !== 'group') {
    res.status(400).json({ error: 'This is a private conversation.' });
    return null;
  }
  if (!canManage(auth.me.role)) {
    res.status(403).json({ error: 'Only group owners and admins can do that.' });
    return null;
  }
  return { ...auth, conv };
}

router.patch('/:id', requireAuth, (req, res) => {
  const ctx = requireManagedGroup(req, res);
  if (!ctx) return;

  const patch = {};
  if (req.body && req.body.name !== undefined) {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Group name cannot be empty.' });
    patch.name = name;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

  db.prepare('UPDATE conversations SET name = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(patch.name, ctx.id);

  const io = req.app.get('io');
  const conversation = conversationListFor(req.user.id, 1, ctx.id)[0];
  if (io) {
    io.to(`conv:${ctx.id}`).emit('group_updated', {
      conversationId: ctx.id,
      conversation,
      changedBy: req.user.id
    });
  }
  res.json({ conversation });
});

router.post('/:id/avatar', requireAuth, (req, res) => {
  const ctx = requireManagedGroup(req, res);
  if (!ctx) return;

  groupAvatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      const msg = /File too large|LIMIT_FILE_SIZE/i.test(err.message || '')
        ? 'Group image is too large (max 8MB).'
        : (err.message || 'Group image upload failed.');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose an image first.' });

    // Re-check the saved bytes really are that image type.
    if (!verifyImageSignature(req.file.path, req.file.mimetype)) {
      deleteUploadFile(req.file.filename, 'group-');
      return res.status(400).json({ error: 'That file is not a valid image.' });
    }

    const prev = ctx.conv.avatar_path;
    db.prepare('UPDATE conversations SET avatar_path = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(req.file.filename, ctx.id);
    if (prev) deleteUploadFile(prev, 'group-'); // only ever removes group-* files

    const io = req.app.get('io');
    const conversation = conversationListFor(req.user.id, 1, ctx.id)[0];
    if (io) {
      io.to(`conv:${ctx.id}`).emit('group_updated', {
        conversationId: ctx.id,
        conversation,
        changedBy: req.user.id
      });
    }
    res.json({ conversation });
  });
});

// ---------- Add a member (owner/admin, friends only, no duplicates) ----------
router.post('/:id/members', requireAuth, (req, res) => {
  const ctx = requireManagedGroup(req, res);
  if (!ctx) return;

  const userId = intId(req.body && req.body.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid user id.' });
  if (isMember(ctx.id, userId)) return res.status(409).json({ error: 'They are already in this group.' });

  const target = loadActiveUser(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!areFriends(req.user.id, userId)) {
    return res.status(403).json({ error: 'You can only invite your own friends.' });
  }

  db.prepare(
    `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_msg_id, last_read_at, joined_at)
     VALUES (?, ?, 'member', 0, datetime('now'), datetime('now'))`
  ).run(ctx.id, userId);

  const io = req.app.get('io');
  if (io) {
    io.in(`user:${userId}`).socketsJoin(`conv:${ctx.id}`);
    const payload = { conversationId: ctx.id, userId, user: pub(target), addedBy: req.user.id };
    io.to(`conv:${ctx.id}`).emit('group_member_added', payload);
    io.to(`user:${userId}`).emit('group_created', {
      conversation: conversationListFor(userId, 1, ctx.id)[0]
    });
  }

  res.status(201).json({ members: membersWithUsers(ctx.id) });
});

// ---------- Promote / demote admins (owner only) ----------
router.patch('/:id/members/:userId', requireAuth, (req, res) => {
  const ctx = conversationParam(req, res) && requireMember(req, res);
  if (!ctx) return;

  const conv = conversationRow(ctx.id);
  if (conv.type !== 'group') return res.status(400).json({ error: 'This is a private conversation.' });
  if (ctx.me.role !== 'owner') {
    return res.status(403).json({ error: 'Only the group owner can manage roles.' });
  }

  const targetId = intId(req.params.userId);
  if (!targetId) return res.status(400).json({ error: 'Invalid user id.' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'You cannot change your own role.' });

  const role = String((req.body && req.body.role) || '');
  if (role !== 'admin' && role !== 'member') {
    return res.status(400).json({ error: 'Role must be "admin" or "member".' });
  }

  const target = memberRow(ctx.id, targetId);
  if (!target) return res.status(404).json({ error: 'That user is not in this group.' });
  if (target.role === 'owner') return res.status(403).json({ error: 'The owner\'s role cannot be changed.' });

  db.prepare('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?')
    .run(role, ctx.id, targetId);

  const io = req.app.get('io');
  if (io) {
    io.to(`conv:${ctx.id}`).emit('group_role_changed', {
      conversationId: ctx.id,
      userId: targetId,
      role,
      changedBy: req.user.id
    });
  }

  res.json({ members: membersWithUsers(ctx.id) });
});

// ---------- Remove a member, or leave via DELETE self ----------
router.delete('/:id/members/:userId', requireAuth, (req, res) => {
  const auth = requireMember(req, res);
  if (!auth) return;
  const { id, me } = auth;

  const conv = conversationRow(id);
  if (conv.type !== 'group') return res.status(400).json({ error: 'This is a private conversation.' });

  const targetId = intId(req.params.userId);
  if (!targetId) return res.status(400).json({ error: 'Invalid user id.' });

  if (targetId !== req.user.id) {
    // Removing someone ELSE always needs manage rights.
    if (!canManage(me.role)) {
      return res.status(403).json({ error: 'Only group owners and admins can remove members.' });
    }
    const target = memberRow(id, targetId);
    if (!target) return res.status(404).json({ error: 'That user is not in this group.' });
    if (target.role === 'owner') {
      return res.status(403).json({ error: 'The owner cannot be removed. They must leave the group.' });
    }
    if (target.role === 'admin' && me.role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can remove an admin.' });
    }
  }

  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .run(id, targetId);

  const io = req.app.get('io');
  if (io) io.in(`user:${targetId}`).socketsLeave(`conv:${id}`);

  const payload = { conversationId: id, userId: targetId, removedBy: req.user.id };
  if (io) {
    io.to(`conv:${id}`).emit('group_member_removed', payload);
    io.to(`user:${targetId}`).emit('group_member_removed', payload);
  }

  // An empty group serves nobody — tidy it up.
  const left = memberIdsOf(id);
  if (!left.length) {
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    if (io) io.to(`user:${req.user.id}`).emit('group_deleted', { conversationId: id });
  }

  res.json({ members: left.length ? membersWithUsers(id) : [] });
});

// ---------- Leave group (with safe ownership transfer) ----------
router.post('/:id/leave', requireAuth, (req, res) => {
  const auth = requireMember(req, res);
  if (!auth) return;
  const { id, me } = auth;

  const conv = conversationRow(id);
  if (conv.type !== 'group') return res.status(400).json({ error: 'This is a private conversation.' });

  const wasOwner = me.role === 'owner';

  inTransaction(() => {
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .run(id, req.user.id);

    if (wasOwner) {
      // Never leave a group ownerless: hand it to an admin, else to whoever
      // has been in the group longest.
      const next = db.prepare(`
        SELECT user_id FROM conversation_members
        WHERE conversation_id = ?
        ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END,
                 joined_at ASC, user_id ASC
        LIMIT 1
      `).get(id);
      if (next) {
        db.prepare('UPDATE conversation_members SET role = \'owner\' WHERE conversation_id = ? AND user_id = ?')
          .run(id, next.user_id);
      }
    }
  });

  const io = req.app.get('io');
  if (io) io.in(`user:${req.user.id}`).socketsLeave(`conv:${id}`);

  const left = memberIdsOf(id);
  if (!left.length) {
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    if (io) io.to(`user:${req.user.id}`).emit('group_deleted', { conversationId: id });
    return res.json({ left: true, members: [], group_deleted: true });
  }

  const payload = { conversationId: id, userId: req.user.id, removedBy: req.user.id };
  if (io) {
    io.to(`conv:${id}`).emit('group_member_removed', payload);
    io.to(`user:${req.user.id}`).emit('group_member_removed', payload);
    // The remaining members' lists should reflect the new owner/name state.
    left.forEach(uid => io.to(`user:${uid}`).emit('group_updated', {
      conversationId: id,
      conversation: conversationListFor(uid, 1, id)[0],
      changedBy: req.user.id
    }));
  }

  res.json({ left: true, members: [] });
});

module.exports = router;
