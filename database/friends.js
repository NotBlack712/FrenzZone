// Friendship data access, shared by routes/friends.js, routes/users.js and
// the socket layer. Keeping it here means the friendship rules live in ONE
// place instead of being re-derived per endpoint.
const db = require('./init');

// A -> %search% must not let "%" or "_" act as wildcards.
function likeEscape(q) {
  return String(q).replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * The relationship between `viewerId` and `otherId`, from the viewer's side:
 *   'none'     no request in either direction
 *   'sent'     viewer sent a request that is still pending
 *   'received' the other user sent a request the viewer has not answered
 *   'friends'  an accepted request exists (either direction)
 *
 * The unordered-pair unique index guarantees there can never be two rows for
 * the same pair, so this cannot be ambiguous.
 */
function friendStatus(viewerId, otherId) {
  const row = friendRequestBetween(viewerId, otherId);
  if (!row) return 'none';
  if (row.status === 'accepted') return 'friends';
  return row.sender_id === viewerId ? 'sent' : 'received';
}

// The raw row for a pair, or null. Carries the request id the UI needs in
// order to Accept / Reject / Cancel without a second lookup.
function friendRequestBetween(viewerId, otherId) {
  if (!viewerId || !otherId || viewerId === otherId) return null;
  return db.prepare(`
    SELECT id, sender_id, receiver_id, status, created_at, updated_at
    FROM friend_requests
    WHERE (sender_id = ? AND receiver_id = ?)
       OR (sender_id = ? AND receiver_id = ?)
  `).get(viewerId, otherId, otherId, viewerId) || null;
}

function areFriends(a, b) {
  if (!a || !b || a === b) return false;
  const row = db.prepare(`
    SELECT 1 FROM friend_requests
    WHERE status = 'accepted'
      AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
    LIMIT 1
  `).get(a, b, b, a);
  return !!row;
}

// Every user id this user is friends with (used to seed chat rooms / filters).
function friendIdsOf(userId) {
  if (!userId) return [];
  return db.prepare(`
    SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS id
    FROM friend_requests
    WHERE status = 'accepted' AND (sender_id = ? OR receiver_id = ?)
  `).all(userId, userId, userId).map(r => r.id);
}

function friendCountOf(userId) {
  if (!userId) return 0;
  return db.prepare(`
    SELECT COUNT(*) AS c FROM friend_requests
    WHERE status = 'accepted' AND (sender_id = ? OR receiver_id = ?)
  `).get(userId, userId).c;
}

/**
 * Accepted friends of `userId`, optionally filtered by username or bio.
 * Matches only friends — it can never be used to enumerate all users.
 */
function friendRows(userId, q, limit = 200) {
  if (!userId) return [];
  const query = String(q || '').trim();
  const like = `%${likeEscape(query)}%`;
  return db.prepare(`
    SELECT u.id, u.username, u.bio, u.avatar_path, u.is_verified,
           fr.created_at AS friends_since
    FROM friend_requests fr
    JOIN users u
      ON u.id = CASE WHEN fr.sender_id = ? THEN fr.receiver_id ELSE fr.sender_id END
    WHERE fr.status = 'accepted'
      AND (fr.sender_id = ? OR fr.receiver_id = ?)
      AND (? = '' OR u.username LIKE ? ESCAPE '\\' OR u.bio LIKE ? ESCAPE '\\')
    ORDER BY u.username COLLATE NOCASE ASC
    LIMIT ?
  `).all(userId, userId, userId, query, like, like, limit);
}

module.exports = {
  likeEscape,
  friendStatus,
  friendRequestBetween,
  areFriends,
  friendIdsOf,
  friendCountOf,
  friendRows
};
