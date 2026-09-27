// Admin Panel data layer: roles, bans, reports, audit logs, admin settings.
//
// Everything here is PARAMETERISED (db.prepare + ? placeholders) — no string
// concatenation ever reaches SQL, so no user input can become a query.
// Authorization itself never happens here: this module only stores and reads
// state. The role checks live in middleware/admin.js and are evaluated
// server-side on every single admin request.
const db = require('./init');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
-- Who the user IS on this site. 'user' is the default for every account;
-- 'owner' is seeded once by ensureOwner() and can only be granted by an owner.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id    INTEGER PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'user'
             CHECK (role IN ('user','moderator','admin','owner')),
  granted_by INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Temporary and permanent bans. expires_at = NULL means permanent.
-- active = 0 rows are history (kept for the audit trail / appeal lookups).
CREATE TABLE IF NOT EXISTS user_bans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  admin_id   INTEGER NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  ban_type   TEXT NOT NULL DEFAULT 'temporary'
             CHECK (ban_type IN ('temporary','permanent')),
  starts_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT DEFAULT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bans_user_active ON user_bans(user_id, active);
CREATE INDEX IF NOT EXISTS idx_bans_expiry ON user_bans(expires_at);

-- User reports against users / posts / comments / messages.
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','post','comment','message')),
  target_id   INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  details     TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','resolved','rejected')),
  admin_id    INTEGER DEFAULT NULL,
  admin_notes TEXT DEFAULT '',
  resolution  TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);

-- Append-only admin action log. Never updated, never deleted by the app.
CREATE TABLE IF NOT EXISTS admin_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id     INTEGER NOT NULL,
  admin_name   TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL,
  target_type  TEXT DEFAULT '',
  target_id    INTEGER DEFAULT 0,
  target_label TEXT DEFAULT '',
  reason       TEXT DEFAULT '',
  meta         TEXT DEFAULT '',
  ip           TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);

-- Key/value panel settings (rate limits, maintenance mode, ...).
CREATE TABLE IF NOT EXISTS admin_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// users.is_verified — the FrenzZone verified badge. Column-level so it rides
// along with every existing SELECT * and cannot be forged from the client:
// the only writers are the admin verify endpoints.
const userCols = db.prepare('PRAGMA table_info(users)').all();
if (!userCols.some((c) => c.name === 'is_verified')) {
  db.exec('ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.some((c) => c.name === 'role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}
// Keeps users.role and user_roles in sync (user_roles is the source of truth
// for grants; the denormalised column lets one cheap query authorise requests).
db.exec(`UPDATE users SET role = COALESCE(
           (SELECT r.role FROM user_roles r WHERE r.user_id = users.id), 'user')
         WHERE role IS NULL OR role = ''`);

// ---------------------------------------------------------------------------
// Owner seeding
// ---------------------------------------------------------------------------
// The Owner is a ROW IN THE DATABASE, never a hard-coded comparison in a
// route. The address below is only used ONCE, at boot, to write role='owner'
// into user_roles; after that every permission check reads the stored role.
// OWNER_EMAIL can override it without touching code.
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'blackitznot@gmail.com').trim().toLowerCase();

function ensureOwner() {
  const owner = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(OWNER_EMAIL);
  if (!owner) return null; // account not registered yet — nothing to seed
  const current = db.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(owner.id);
  if (!current || current.role !== 'owner') {
    db.prepare(`
      INSERT INTO user_roles (user_id, role, granted_by, created_at, updated_at)
      VALUES (?, 'owner', NULL, datetime('now'), datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET role = 'owner', updated_at = datetime('now')
    `).run(owner.id);
  }
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.id);
  return owner.id;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------
const RANK = { user: 0, moderator: 1, admin: 2, owner: 3 };

function rankOf(role) {
  return RANK[role] == null ? 0 : RANK[role];
}

// Stored role for a user (denormalised column, kept in sync by grants).
function roleOf(userId) {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return row && row.role ? row.role : 'user';
}

// Permission matrix. Moderator = reports + light content moderation;
// Admin = everything except managing staff and platform settings;
// Owner = everything.
const PERMISSIONS = {
  owner: [
    'dashboard', 'users.read', 'users.ban', 'users.disable', 'users.delete',
    'users.verify', 'users.logout', 'content.read', 'content.delete',
    'reports.read', 'reports.update', 'staff.manage', 'audit.read', 'settings.manage'
  ],
  admin: [
    'dashboard', 'users.read', 'users.ban', 'users.disable',
    'users.verify', 'users.logout', 'content.read', 'content.delete',
    'reports.read', 'reports.update', 'audit.read'
  ],
  moderator: ['dashboard', 'reports.read', 'reports.update'],
  user: []
};

function can(role, permission) {
  const list = PERMISSIONS[role] || [];
  return list.indexOf(permission) !== -1;
}

// ---------------------------------------------------------------------------
// Bans
// ---------------------------------------------------------------------------
// The single source of truth for "is this account blocked right now".
// Expired rows are deactivated on the way out so they stop matching forever.
function activeBan(userId) {
  const now = db.prepare(`
    SELECT id, reason, ban_type, starts_at, expires_at, admin_id
    FROM user_bans
    WHERE user_id = ? AND active = 1
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY id DESC LIMIT 1
  `).get(userId);

  if (!now) {
    // Opportunistic cleanup of rows whose clock ran out.
    db.prepare(`
      UPDATE user_bans SET active = 0
      WHERE user_id = ? AND active = 1 AND expires_at IS NOT NULL
        AND expires_at <= datetime('now')
    `).run(userId);
    return null;
  }
  return now;
}

function clearBans(userId) {
  const info = db.prepare('UPDATE user_bans SET active = 0 WHERE user_id = ? AND active = 1').run(userId);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Sessions (force logout / ban invalidation)
// ---------------------------------------------------------------------------
// Deleting the user_sessions rows is what actually kills access: requireAuth()
// refuses any cookie that is not listed there, so every device dies at once —
// including sockets, on their next authenticated action.
function revokeAllSessions(userId) {
  const info = db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
function audit(entry) {
  const {
    adminId, adminName, action, targetType = '', targetId = 0,
    targetLabel = '', reason = '', meta = '', ip = ''
  } = entry || {};
  if (!adminId || !action) return;
  db.prepare(`
    INSERT INTO admin_logs
      (admin_id, admin_name, action, target_type, target_id, target_label, reason, meta, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    adminId,
    String(adminName || '').slice(0, 40),
    String(action).slice(0, 60),
    String(targetType).slice(0, 20),
    Number(targetId) || 0,
    String(targetLabel).slice(0, 80),
    String(reason).slice(0, 500),
    typeof meta === 'string' ? meta.slice(0, 1000) : JSON.stringify(meta || {}).slice(0, 1000),
    String(ip || '').slice(0, 64)
  );
}

// ---------------------------------------------------------------------------
// Admin settings
// ---------------------------------------------------------------------------
const SETTINGS_DEFAULTS = {
  site_notice: '',
  require_reports_before_ban: '0',
  allow_moderator_verify: '0',
  maintenance_mode: '0'
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM admin_settings').all();
  const out = { ...SETTINGS_DEFAULTS };
  rows.forEach((r) => { out[r.key] = r.value; });
  return out;
}

function setSettings(patch) {
  const allowed = Object.keys(SETTINGS_DEFAULTS);
  Object.keys(patch || {}).forEach((k) => {
    if (allowed.indexOf(k) === -1) return;
    const v = String(patch[k]).slice(0, 1000);
    db.prepare(`
      INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(k, v);
  });
  return getSettings();
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
function setVerified(userId, verified) {
  db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(verified ? 1 : 0, userId);
}

module.exports = {
  db,
  ensureOwner,
  roleOf,
  rankOf,
  can,
  activeBan,
  clearBans,
  revokeAllSessions,
  audit,
  getSettings,
  setSettings,
  setVerified,
  OWNER_EMAIL
};
