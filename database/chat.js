// Chat data access + the membership checks that every chat route and every
// chat socket event relies on. "Am I a member of this conversation?" is the
// single question that grants read/write access — nothing else.
const db = require('./init');

// ---------- Membership ----------

// The caller's membership row (role + read cursor). Undefined when they are
// NOT in the conversation — which is the normal way to reject an attempt to
// read someone else's chat by guessing an id.
function memberRow(conversationId, userId) {
  if (!conversationId || !userId) return undefined;
  return db.prepare(
    'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).get(conversationId, userId);
}

function isMember(conversationId, userId) {
  return !!memberRow(conversationId, userId);
}

// owner/admin may manage the group; plain members may not.
function canManage(role) {
  return role === 'owner' || role === 'admin';
}

function memberIdsOf(conversationId) {
  return db.prepare(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ?'
  ).all(conversationId).map(r => r.user_id);
}

// Members with their profile fields, for the members panel.
function membersWithUsers(conversationId) {
  return db.prepare(`
    SELECT m.user_id, m.role, m.joined_at, m.last_read_msg_id,
           u.username, u.bio, u.avatar_path, u.is_verified
    FROM conversation_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
             u.username COLLATE NOCASE
  `).all(conversationId);
}

function conversationRow(conversationId) {
  if (!conversationId) return undefined;
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

/**
 * The existing private conversation between two users, or undefined.
 * Requires BOTH users to be members AND the conversation to have exactly two
 * members and type='private', so a group can never match.
 */
function findPrivateConversation(a, b) {
  if (!a || !b || a === b) return undefined;
  return db.prepare(`
    SELECT c.id FROM conversations c
    WHERE c.type = 'private'
      AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
      AND EXISTS (SELECT 1 FROM conversation_members m
                  WHERE m.conversation_id = c.id AND m.user_id = ?)
      AND EXISTS (SELECT 1 FROM conversation_members m
                  WHERE m.conversation_id = c.id AND m.user_id = ?)
    LIMIT 1
  `).get(a, b);
}

// ---------- Unread / read state ----------

// Unread = messages from anyone else whose id is past my read cursor. Message
// ids rise monotonically, so this is exact (no second-granularity rounding).
function unreadCount(conversationId, userId) {
  if (!conversationId || !userId) return 0;
  return db.prepare(`
    SELECT COUNT(*) AS c
    FROM messages x
    JOIN conversation_members m
      ON m.conversation_id = x.conversation_id AND m.user_id = ?
    WHERE x.conversation_id = ? AND x.sender_id <> ? AND x.id > m.last_read_msg_id
  `).get(userId, conversationId, userId).c;
}

function unreadTotal(userId) {
  if (!userId) return 0;
  return db.prepare(`
    SELECT COUNT(*) AS c
    FROM messages x
    JOIN conversation_members m
      ON m.conversation_id = x.conversation_id AND m.user_id = ?
    WHERE x.sender_id <> ? AND x.id > m.last_read_msg_id
  `).get(userId, userId).c;
}

/**
 * The caller's conversation list: unread counts, last message preview and
 * their own role. Three queries total (list, member counts, other profiles),
 * never one query per conversation.
 */
function conversationListFor(userId, limit = 100, onlyId = null) {
  const rows = db.prepare(`
    SELECT c.id, c.type, c.name, c.avatar_path, c.created_by, c.created_at, c.updated_at,
           m.role, m.last_read_msg_id,
           (SELECT COUNT(*) FROM messages x
              WHERE x.conversation_id = c.id
                AND x.sender_id <> ?
                AND x.id > m.last_read_msg_id) AS unread,
           (SELECT x.id         FROM messages x WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1) AS last_msg_id,
           (SELECT x.content    FROM messages x WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1) AS last_msg,
           (SELECT x.created_at FROM messages x WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1) AS last_msg_at,
           (SELECT x.sender_id  FROM messages x WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1) AS last_msg_sender,
           (SELECT cm2.user_id  FROM conversation_members cm2
              WHERE cm2.conversation_id = c.id AND cm2.user_id <> ? LIMIT 1) AS other_id
    FROM conversations c
    JOIN conversation_members m
      ON m.conversation_id = c.id AND m.user_id = ?
    ${onlyId ? 'WHERE c.id = ?' : ''}
    ORDER BY COALESCE((SELECT x.created_at FROM messages x
                       WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1),
                      c.created_at) DESC,
             c.id DESC
    LIMIT ?
  `).all(...(onlyId
    ? [userId, userId, userId, onlyId, limit]
    : [userId, userId, userId, limit]));

  if (!rows.length) return [];

  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const counts = db.prepare(
    `SELECT conversation_id, COUNT(*) AS c FROM conversation_members
     WHERE conversation_id IN (${placeholders}) GROUP BY conversation_id`
  ).all(...ids);
  const countMap = new Map(counts.map(r => [r.conversation_id, r.c]));

  // For a private chat the other member's profile is the display identity.
  const otherIds = [...new Set(rows.map(r => r.other_id).filter(Boolean))];
  const otherMap = new Map();
  if (otherIds.length) {
    const ph = otherIds.map(() => '?').join(',');
    db.prepare(`SELECT id, username, bio, avatar_path, is_verified FROM users WHERE id IN (${ph})`)
      .all(...otherIds)
      .forEach(u => otherMap.set(u.id, u));
  }

  const senderIds = [...new Set(rows.map(r => r.last_msg_sender).filter(Boolean))];
  const senderMap = new Map();
  if (senderIds.length) {
    const ph = senderIds.map(() => '?').join(',');
    db.prepare(`SELECT id, username FROM users WHERE id IN (${ph})`)
      .all(...senderIds)
      .forEach(u => senderMap.set(u.id, u));
  }

  return rows.map(r => ({
    id: r.id,
    type: r.type,
    name: r.name,
    avatar_path: r.avatar_path,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    my_role: r.role,
    member_count: countMap.get(r.id) || 1,
    unread: r.unread,
    last_message: r.last_msg
      ? {
          id: r.last_msg_id,
          content: r.last_msg,
          created_at: r.last_msg_at,
          sender_id: r.last_msg_sender,
          sender_name: (senderMap.get(r.last_msg_sender) || {}).username || null
        }
      : null,
    // Only meaningful for type='private'.
    other_user: r.type === 'private' && r.other_id
      ? (otherMap.get(r.other_id) || null)
      : null
  }));
}

module.exports = {
  memberRow,
  isMember,
  canManage,
  memberIdsOf,
  membersWithUsers,
  conversationRow,
  findPrivateConversation,
  unreadCount,
  unreadTotal,
  conversationListFor
};
