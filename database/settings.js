// Settings data access + the privacy rules themselves.
//
// Just like database/friends.js holds the friendship rules, THIS file is the
// single place where a privacy setting is turned into a yes/no decision.
// routes/users.js, routes/friends.js and routes/chats.js all ask here instead
// of re-deriving the logic, so the rule can never drift between endpoints.
const db = require('./init');
const { areFriends } = require('./friends');

// ---------- Value domains (mirrored by the CHECK constraints in the schema) ----------
const ENUMS = {
  profile_visibility: ['public', 'friends'],
  friend_request_privacy: ['everyone', 'friends_of_friends', 'nobody'],
  message_privacy: ['friends', 'everyone', 'nobody'],
  theme: ['light', 'dark', 'system']
};

// Stored as 0/1 integers, never as strings like "true"/"on".
const FLAGS = [
  'show_online_status',
  'show_last_seen',
  'friend_request_notifications',
  'message_notifications',
  'group_notifications',
  'like_notifications',
  'comment_notifications',
  'follower_notifications',
  'other_notifications'
];

const ALL_KEYS = [...Object.keys(ENUMS), ...FLAGS];

const DEFAULTS = Object.freeze({
  profile_visibility: 'public',
  friend_request_privacy: 'everyone',
  message_privacy: 'friends',
  show_online_status: 1,
  show_last_seen: 1,
  friend_request_notifications: 1,
  message_notifications: 1,
  group_notifications: 1,
  like_notifications: 1,
  comment_notifications: 1,
  follower_notifications: 1,
  other_notifications: 1,
  theme: 'system'
});

function pick(row) {
  const out = {};
  for (const k of ALL_KEYS) out[k] = row && row[k] !== undefined && row[k] !== null ? row[k] : DEFAULTS[k];
  return out;
}

/**
 * A user's settings, without INSERTing anything. Used by the enforcement
 * paths (every profile view / friend request / message attempt), which run
 * constantly and must never write to the database as a side effect.
 * A missing row simply means "all defaults".
 */
function peek(userId) {
  if (!userId) return { ...DEFAULTS };
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  return pick(row);
}

/** The settings row for the Settings page — created on first visit. */
function getSettings(userId) {
  const existing = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  if (existing) return pick(existing);
  db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(userId);
  return { ...DEFAULTS };
}

/**
 * Validates a partial update and writes it. Unknown keys and malformed values
 * are rejected rather than silently dropped, so a typo can never quietly
 * leave a setting in a state the caller believes it changed.
 * Returns { settings } on success or { error } on failure.
 */
function updateSettings(userId, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'Nothing to update.' };
  }

  const sets = [];
  const params = [];
  let sawUnknown = null;

  for (const [key, raw] of Object.entries(patch)) {
    if (!ALL_KEYS.includes(key)) { sawUnknown = key; continue; }

    if (Object.prototype.hasOwnProperty.call(ENUMS, key)) {
      if (!ENUMS[key].includes(raw)) {
        return { error: `"${raw}" is not a valid value for ${key}.` };
      }
      sets.push(`${key} = ?`);
      params.push(raw);
    } else {
      // Flags: accept true/false, 1/0, "1"/"0" — nothing else.
      const v = typeof raw === 'boolean' ? (raw ? 1 : 0)
        : (raw === 1 || raw === 0) ? raw
        : (raw === '1' || raw === '0') ? Number(raw)
        : null;
      if (v === null) return { error: `${key} must be on or off.` };
      sets.push(`${key} = ?`);
      params.push(v);
    }
  }

  if (sawUnknown) return { error: `Unknown setting: ${sawUnknown}.` };
  if (sets.length === 0) return { error: 'Nothing to update.' };

  sets.push("updated_at = datetime('now')");
  params.push(userId);

  // user_id comes from the session (req.user.id) — never from the request body.
  const existing = db.prepare('SELECT user_id FROM user_settings WHERE user_id = ?').get(userId);
  if (existing) {
    db.prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE user_id = ?`).run(...params);
  } else {
    // No row yet: insert defaults, then apply the patch on top.
    db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(userId);
    db.prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE user_id = ?`).run(...params);
  }

  return { settings: getSettings(userId) };
}

// ============================================================================
// PRIVACY ENFORCEMENT
// These are the answers the SERVER gives — the UI never decides any of this.
// ============================================================================

/**
 * May `viewerId` see `ownerId`'s profile (and their posts)?
 * - always: the owner themself, and anyone, when the profile is public
 * - 'friends': only confirmed friends
 * - signed-out viewers count as strangers (viewerId 0 / null)
 */
function canViewProfile(ownerId, viewerId) {
  if (!ownerId) return false;
  if (viewerId && viewerId === ownerId) return true;
  const s = peek(ownerId);
  if (s.profile_visibility === 'public') return true;
  return !!(viewerId && areFriends(ownerId, viewerId));
}

/**
 * May `senderId` send a friend request to `receiverId`?
 * Evaluated against the RECEIVER's setting — you don't get to opt out of
 * being bothered by setting your own preference.
 */
function canSendFriendRequest(senderId, receiverId) {
  if (!senderId || !receiverId || senderId === receiverId) return false;
  const s = peek(receiverId);
  if (s.friend_request_privacy === 'nobody') return false;
  if (s.friend_request_privacy === 'everyone') return true;

  // 'friends_of_friends': exists a row a (one of MY friendships) and a row b
  // (one of THEIR friendships) that share a participant — that shared person
  // is our mutual friend. Sharing happens only in the three ways below:
  //   - a real mutual friend M is in both rows, or
  //   - the two rows ARE the S<->R friendship (we're already friends).
  const row = db.prepare(`
    SELECT 1
    FROM friend_requests a
    JOIN friend_requests b
      ON (b.sender_id = a.sender_id OR b.sender_id = a.receiver_id
          OR b.receiver_id = a.sender_id OR b.receiver_id = a.receiver_id)
    WHERE a.status = 'accepted' AND b.status = 'accepted'
      AND (a.sender_id = ? OR a.receiver_id = ?)
      AND (b.sender_id = ? OR b.receiver_id = ?)
    LIMIT 1
  `).get(senderId, senderId, receiverId, receiverId);
  return !!row;
}

/**
 * May `fromId` start a NEW private conversation with `toId`?
 * Chat history is never revoked — this only gates opening a new one.
 */
function canMessage(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return false;
  const s = peek(toId);
  if (s.message_privacy === 'nobody') return false;
  if (s.message_privacy === 'everyone') return true;
  return areFriends(fromId, toId);
}

/**
 * May `viewerId` see `targetId`'s real last-seen timestamp?
 * Returns the timestamp when allowed and null when it must be withheld, so a
 * caller can never accidentally serialise a hidden value.
 */
function lastSeenFor(targetId, viewerId) {
  if (!targetId) return null;
  const s = peek(targetId);
  if (!s.show_last_seen) return null;
  if (viewerId && viewerId === targetId) return lastSeenOf(targetId);
  // 'friends'-only profiles also hide presence from strangers.
  if (s.profile_visibility === 'friends' && !(viewerId && areFriends(targetId, viewerId))) return null;
  return lastSeenOf(targetId);
}

function lastSeenOf(userId) {
  const row = db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId);
  return row ? row.last_seen_at || null : null;
}

/** Should `targetId`'s online/offline events be broadcast to anyone at all? */
function broadcastsPresence(targetId) {
  if (!targetId) return false;
  return peek(targetId).show_online_status === 1;
}

/** Records "this user was just here" — throttled to once a minute per user. */
function touchLastSeen(userId) {
  if (!userId) return;
  db.prepare(`
    UPDATE users SET last_seen_at = datetime('now')
    WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-60 seconds'))
  `).run(userId);
}

module.exports = {
  ENUMS,
  FLAGS,
  ALL_KEYS,
  DEFAULTS,
  peek,
  getSettings,
  updateSettings,
  canViewProfile,
  canSendFriendRequest,
  canMessage,
  lastSeenFor,
  lastSeenOf,
  broadcastsPresence,
  touchLastSeen
};
