const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite'); // built into Node (v22.5+) — no native compile step needed

const DB_PATH = path.join(__dirname, '..', 'database.sqlite');
const isNewDb = !fs.existsSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  bio           TEXT DEFAULT '',
  avatar_path   TEXT DEFAULT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  text        TEXT DEFAULT '',
  media_path  TEXT DEFAULT NULL,
  media_type  TEXT DEFAULT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS follows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id  INTEGER NOT NULL,
  following_id INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(follower_id, following_id),
  FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------- Friendship (separate from follows) ----------
-- ONE row per unordered pair. The min()/max() expression index is what makes
-- "A -> B" and "B -> A" impossible to coexist, and it also blocks asking
-- someone you are already friends with. Rejecting/cancelling deletes the row,
-- so a later re-request is allowed again.
CREATE TABLE IF NOT EXISTS friend_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','accepted','rejected')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (sender_id <> receiver_id),
  FOREIGN KEY (sender_id)   REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pair
  ON friend_requests(min(sender_id, receiver_id), max(sender_id, receiver_id));
CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver
  ON friend_requests(receiver_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_sender
  ON friend_requests(sender_id, status);

-- ---------- Chat ----------
-- conversations + conversation_members + messages. A private chat is a
-- conversation with exactly two members and type='private'; a group has
-- type='group'. Membership in conversation_members is the ONLY thing that
-- grants read/write access — every query and every socket event checks it.
CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('private','group')),
  name        TEXT DEFAULT NULL,
  avatar_path TEXT DEFAULT NULL,
  created_by  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id  INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,
  role             TEXT NOT NULL DEFAULT 'member'
                   CHECK (role IN ('owner','admin','member')),
  -- last_read_msg_id is what unread counts are computed from: message ids
  -- rise monotonically, so it is exact and immune to clock/second rounding.
  last_read_msg_id INTEGER NOT NULL DEFAULT 0,
  last_read_at     TEXT NOT NULL DEFAULT (datetime('now')),
  joined_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_id       INTEGER NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id)       REFERENCES users(id)         ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
-- Keyset pagination: (conversation_id, id) is exactly the ORDER BY used when
-- paging a thread backwards through history.
CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);

-- ---------- Settings ----------
-- One row per user, created lazily on first read. Keeping it 1:1 (user_id as
-- the PRIMARY KEY) means a settings read is a single indexed lookup and a user
-- can never end up with two conflicting preference rows.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id                   INTEGER PRIMARY KEY,
  profile_visibility        TEXT NOT NULL DEFAULT 'public'
                            CHECK (profile_visibility IN ('public','friends')),
  friend_request_privacy    TEXT NOT NULL DEFAULT 'everyone'
                            CHECK (friend_request_privacy IN ('everyone','friends_of_friends','nobody')),
  message_privacy           TEXT NOT NULL DEFAULT 'friends'
                            CHECK (message_privacy IN ('friends','everyone','nobody')),
  show_online_status        INTEGER NOT NULL DEFAULT 1,
  show_last_seen            INTEGER NOT NULL DEFAULT 1,
  friend_request_notifications INTEGER NOT NULL DEFAULT 1,
  message_notifications     INTEGER NOT NULL DEFAULT 1,
  group_notifications       INTEGER NOT NULL DEFAULT 1,
  like_notifications        INTEGER NOT NULL DEFAULT 1,
  comment_notifications     INTEGER NOT NULL DEFAULT 1,
  follower_notifications    INTEGER NOT NULL DEFAULT 1,
  other_notifications       INTEGER NOT NULL DEFAULT 1,
  theme                      TEXT NOT NULL DEFAULT 'system'
                            CHECK (theme IN ('light','dark','system')),
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------- Active sessions ----------
-- express-session keeps its data in memory, so its store cannot be enumerated
-- (you cannot ask it "list my sessions" or "kill everything but this one").
-- This table mirrors the sessions we issue so Settings can SHOW active devices
-- and revoke them. requireAuth() refuses any session id that is not listed
-- here, which is what actually enforces "log out of other devices".
CREATE TABLE IF NOT EXISTS user_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  -- Random id for the server process that issued the session. express-session's
  -- in-memory store is emptied on restart, so ANY row from an earlier boot is
  -- dead by definition; login uses this to purge those ghosts instead of
  -- showing them as phantom devices in Settings.
  boot_id      TEXT NOT NULL DEFAULT '',
  user_agent   TEXT DEFAULT '',
  ip           TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
`);

// Migration for databases created before the banner feature existed.
// (CREATE TABLE IF NOT EXISTS users never alters an already-built table.)
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some((c) => c.name === 'banner_path')) {
  db.exec('ALTER TABLE users ADD COLUMN banner_path TEXT DEFAULT NULL');
}

// ---------- Settings migrations ----------
// display_name: optional handle shown on the profile. Empty means "use the
// username", so no existing row and no existing render path has to change.
// last_seen_at: the value show_last_seen gates.
  // status:      'active' | 'deactivated' | 'suspended'
//                deactivated = the user turned their own account off in
//                Settings (logging in brings it back);
//                suspended   = an ADMIN disabled it (login is refused).
//              without deleting anything.
const ensured = new Set(userColumns.map((c) => c.name));
function ensureColumn(name, ddl) {
  if (ensured.has(name)) return;
  db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  ensured.add(name);
}
ensureColumn('display_name', "display_name TEXT NOT NULL DEFAULT ''");
ensureColumn('last_seen_at', 'last_seen_at TEXT DEFAULT NULL');
ensureColumn('status', "status TEXT NOT NULL DEFAULT 'active'");

// user_sessions.boot_id (added after the table already existed somewhere).
const sessionCols = db.prepare('PRAGMA table_info(user_sessions)').all();
if (!sessionCols.some((c) => c.name === 'boot_id')) {
  db.exec("ALTER TABLE user_sessions ADD COLUMN boot_id TEXT NOT NULL DEFAULT ''");
}

if (isNewDb) {
  console.log('[database] New SQLite database created at', DB_PATH);
} else {
  console.log('[database] Using existing SQLite database at', DB_PATH);
}

module.exports = db;
