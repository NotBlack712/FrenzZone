// Admin Panel API.
//
// Authorisation model (enforced server-side on EVERY route below):
//   requireAuth          -> 401 when there is no live session
//   requirePermission()  -> 403 when the caller's DB role lacks the permission
//   canActOn()           -> 403 when a lower-ranked staff member targets
//                            a higher-ranked one (owner is untouchable)
//   validateRoleChange() -> only an owner may grant/revoke staff roles
// No endpoint accepts a role, a permission or an identity from the client:
// req.user.id comes from the session cookie and nothing else.
const express = require('express');
const db = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const {
  requirePermission, canActOn, requireOwner, validateRoleChange, forbidden
} = require('../middleware/admin');
const {
  roleOf, activeBan, clearBans, revokeAllSessions, audit,
  getSettings, setSettings, setVerified
} = require('../database/admin');

const router = express.Router();

const PAGE_MAX = 100;
const REASON_MAX = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

function str(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

// Public shape of a user for the panel — password_hash is never selected.
function adminUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    display_name: u.display_name || '',
    bio: u.bio || '',
    avatar_path: u.avatar_path || null,
    role: u.role || 'user',
    is_verified: u.is_verified ? 1 : 0,
    status: u.status || 'active',
    created_at: u.created_at,
    post_count: u.post_count != null ? u.post_count : undefined
  };
}

// Broadcast a live update to every staff socket (they join the `admins` room
// in socket/index.js) and target the affected user's own room.
function emit(req, room, event, payload) {
  try {
    const io = req.app.get('io');
    if (io) io.to(room).emit(event, payload);
  } catch (e) { /* a socket hiccup must never fail the API call */ }
}

// Loads a target account and applies the rank rules. Returns null after
// responding, so callers can simply `if (!guard(req, res, id)) return;`
function guardTarget(req, res, targetId) {
  const target = db.prepare(
    'SELECT id, username, email, role, status, is_verified FROM users WHERE id = ?'
  ).get(targetId);
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return null;
  }
  if (!canActOn(req.admin.role, target.role)) {
    forbidden(res, 'You cannot perform actions on this account.');
    return null;
  }
  return target;
}

// Ban length presets. 'custom' uses customMinutes; 'permanent' stores NULL.
const BAN_DURATIONS = {
  '1h': 60,
  '6h': 6 * 60,
  '1d': 24 * 60,
  '3d': 3 * 24 * 60,
  '7d': 7 * 24 * 60,
  '30d': 30 * 24 * 60
};

function banExpiry(body) {
  const duration = str(body.duration, 20);
  if (duration === 'permanent') return { ban_type: 'permanent', expires_at: null };
  if (BAN_DURATIONS[duration]) {
    return {
      ban_type: 'temporary',
      expires_at: new Date(Date.now() + BAN_DURATIONS[duration] * 60000).toISOString().replace('T', ' ').slice(0, 19)
    };
  }
  if (duration === 'custom') {
    const mins = parseInt(body.customMinutes, 10);
    if (!Number.isFinite(mins) || mins < 1 || mins > 60 * 24 * 365) return null;
    return {
      ban_type: 'temporary',
      expires_at: new Date(Date.now() + mins * 60000).toISOString().replace('T', ' ').slice(0, 19)
    };
  }
  return null;
}

// ===========================================================================
// Dashboard
// ===========================================================================
router.get('/dashboard', requirePermission('dashboard'), (req, res) => {
  const one = (sql) => { try { return db.prepare(sql).get() || {}; } catch (e) { return {}; } };
  res.json({
    users: one('SELECT COUNT(*) AS n FROM users').n,
    usersToday: one("SELECT COUNT(*) AS n FROM users WHERE date(created_at) = date('now')").n,
    posts: one('SELECT COUNT(*) AS n FROM posts').n,
    comments: one('SELECT COUNT(*) AS n FROM comments').n,
    openReports: one("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").n,
    totalReports: one('SELECT COUNT(*) AS n FROM reports').n,
    activeBans: one(`
      SELECT COUNT(*) AS n FROM user_bans
      WHERE active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).n,
    verified: one('SELECT COUNT(*) AS n FROM users WHERE is_verified = 1').n,
    staff: one("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','moderator','owner')").n,
    recentLogs: db.prepare(`
      SELECT id, admin_name, action, target_type, target_id, target_label, reason, created_at
      FROM admin_logs ORDER BY id DESC LIMIT 8
    `).all(),
    recentReports: db.prepare(`
      SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
             u.username AS reporter
      FROM reports r JOIN users u ON u.id = r.reporter_id
      ORDER BY r.id DESC LIMIT 8
    `).all(),
    me: { id: req.admin.id, username: req.admin.username, role: req.admin.role }
  });
});

// The panel's own bootstrap: who am I, what may I do.
// Same permission gate as the rest of the API — a normal user gets 403 here
// too, so opening /admin by hand reveals nothing at all.
router.get('/me', requirePermission('dashboard'), (req, res) => {
  const role = req.admin.role;
  const perms = require('../database/admin').can;
  res.json({
    id: req.admin.id,
    username: req.admin.username,
    role,
    permissions: {
      dashboard: perms(role, 'dashboard'),
      users: perms(role, 'users.read'),
      ban: perms(role, 'users.ban'),
      disable: perms(role, 'users.disable'),
      remove: perms(role, 'users.delete'),
      verify: perms(role, 'users.verify'),
      logout: perms(role, 'users.logout'),
      content: perms(role, 'content.read'),
      contentDelete: perms(role, 'content.delete'),
      reports: perms(role, 'reports.read'),
      staff: perms(role, 'staff.manage'),
      audit: perms(role, 'audit.read'),
      settings: perms(role, 'settings.manage')
    }
  });
});

// ===========================================================================
// User management
// ===========================================================================
router.get('/users', requirePermission('users.read'), (req, res) => {
  const { page, limit, offset } = pageParams(req);
  const q = str(req.query.q, 60).trim();
  const status = str(req.query.status, 20);
  const role = str(req.query.role, 20);
  const only = str(req.query.flag, 20); // verified | banned

  const where = [];
  const args = [];
  if (q) { where.push('(u.username LIKE ? OR u.email LIKE ? OR u.display_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status === 'active' || status === 'deactivated' || status === 'suspended') { where.push('u.status = ?'); args.push(status); }
  if (['user', 'moderator', 'admin', 'owner'].indexOf(role) !== -1) { where.push('u.role = ?'); args.push(role); }
  if (only === 'verified') where.push('u.is_verified = 1');
  if (only === 'banned') {
    where.push(`EXISTS (SELECT 1 FROM user_bans b WHERE b.user_id = u.id AND b.active = 1
      AND (b.expires_at IS NULL OR b.expires_at > datetime('now')))`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${clause}`).get(...args).n;
  const rows = db.prepare(`
    SELECT u.id, u.username, u.email, u.display_name, u.bio, u.avatar_path,
           u.role, u.is_verified, u.status, u.created_at,
           (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count,
           (SELECT b.reason FROM user_bans b WHERE b.user_id = u.id AND b.active = 1
              AND (b.expires_at IS NULL OR b.expires_at > datetime('now'))
            ORDER BY b.id DESC LIMIT 1) AS ban_reason,
           (SELECT b.expires_at FROM user_bans b WHERE b.user_id = u.id AND b.active = 1
              AND (b.expires_at IS NULL OR b.expires_at > datetime('now'))
            ORDER BY b.id DESC LIMIT 1) AS ban_expires_at,
           (SELECT b.ban_type FROM user_bans b WHERE b.user_id = u.id AND b.active = 1
              AND (b.expires_at IS NULL OR b.expires_at > datetime('now'))
            ORDER BY b.id DESC LIMIT 1) AS ban_type
    FROM users u ${clause}
    ORDER BY u.id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);

  res.json({
    users: rows.map((r) => ({
      ...adminUser(r),
      ban: r.ban_type ? { type: r.ban_type, reason: r.ban_reason || '', expires_at: r.ban_expires_at } : null
    })),
    total, page, limit
  });
});

router.get('/users/:id', requirePermission('users.read'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });

  const u = db.prepare(`
    SELECT id, username, email, display_name, bio, avatar_path, banner_path,
           role, is_verified, status, created_at, last_seen_at
    FROM users WHERE id = ?
  `).get(id);
  if (!u) return res.status(404).json({ error: 'User not found.' });

  res.json({
    user: adminUser(u),
    ban: activeBan(id),
    bans: db.prepare(`
      SELECT b.id, b.reason, b.ban_type, b.starts_at, b.expires_at, b.active, b.created_at,
             a.username AS admin_name
      FROM user_bans b LEFT JOIN users a ON a.id = b.admin_id
      WHERE b.user_id = ? ORDER BY b.id DESC LIMIT 20
    `).all(id),
    posts: db.prepare(`
      SELECT id, text, media_path, created_at FROM posts
      WHERE user_id = ? ORDER BY id DESC LIMIT 10
    `).all(id),
    reportsAgainst: db.prepare(`
      SELECT id, target_type, target_id, reason, status, created_at FROM reports
      WHERE (target_type = 'user' AND target_id = ?)
      ORDER BY id DESC LIMIT 10
    `).all(id),
    sessions: db.prepare(`
      SELECT id, user_agent, ip, created_at, last_seen_at FROM user_sessions
      WHERE user_id = ? ORDER BY id DESC LIMIT 10
    `).all(id)
  });
});

// ---------- Ban / unban ----------
router.post('/users/:id/ban', requirePermission('users.ban'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  if (id === req.admin.id) return res.status(400).json({ error: 'You cannot ban your own account.' });

  const target = guardTarget(req, res, id);
  if (!target) return;

  const reason = str(req.body && req.body.reason, REASON_MAX).trim();
  const expiry = banExpiry(req.body || {});
  if (!expiry) {
    return res.status(400).json({ error: 'Choose a valid duration: 1h, 6h, 1d, 3d, 7d, 30d, custom (1-525600 minutes) or permanent.' });
  }
  if (!reason) return res.status(400).json({ error: 'A reason is required for every ban.' });

  db.prepare('UPDATE user_bans SET active = 0 WHERE user_id = ? AND active = 1').run(id);
  db.prepare(`
    INSERT INTO user_bans (user_id, admin_id, reason, ban_type, starts_at, expires_at, active, created_at)
    VALUES (?, ?, ?, ?, datetime('now'), ?, 1, datetime('now'))
  `).run(id, req.admin.id, reason, expiry.ban_type, expiry.expires_at);

  const killed = revokeAllSessions(id);
  audit({
    adminId: req.admin.id, adminName: req.admin.username,
    action: expiry.ban_type === 'permanent' ? 'ban.permanent' : 'ban.temporary',
    targetType: 'user', targetId: id, targetLabel: target.username,
    reason, meta: JSON.stringify({ expires_at: expiry.expires_at, sessions_revoked: killed }),
    ip: req.ip
  });

  emit(req, `user:${id}`, 'force_logout', { reason: 'Your account has been banned.', banned: true });
  emit(req, 'admins', 'admin_event', { type: 'ban', targetId: id, target: target.username });

  res.json({ success: true, ban: activeBan(id), sessionsRevoked: killed });
});

router.post('/users/:id/unban', requirePermission('users.ban'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  const target = guardTarget(req, res, id);
  if (!target) return;

  const reason = str(req.body && req.body.reason, REASON_MAX).trim();
  const changed = clearBans(id);
  if (!changed) return res.status(400).json({ error: 'This account is not banned.' });

  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'ban.unban',
    targetType: 'user', targetId: id, targetLabel: target.username, reason, ip: req.ip
  });
  emit(req, 'admins', 'admin_event', { type: 'unban', targetId: id, target: target.username });
  res.json({ success: true });
});

// ---------- Force logout ----------
router.post('/users/:id/logout', requirePermission('users.logout'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  if (id === req.admin.id) return res.status(400).json({ error: 'Use Settings to sign out your own devices.' });
  const target = guardTarget(req, res, id);
  if (!target) return;

  const reason = str(req.body && req.body.reason, REASON_MAX).trim();
  const killed = revokeAllSessions(id);
  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'user.force_logout',
    targetType: 'user', targetId: id, targetLabel: target.username, reason,
    meta: JSON.stringify({ sessions_revoked: killed }), ip: req.ip
  });
  emit(req, `user:${id}`, 'force_logout', { reason: reason || 'You were signed out by an administrator.' });
  res.json({ success: true, sessionsRevoked: killed });
});

// ---------- Disable / enable ----------
router.post('/users/:id/disable', requirePermission('users.disable'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  if (id === req.admin.id) return res.status(400).json({ error: 'You cannot disable your own account.' });
  const target = guardTarget(req, res, id);
  if (!target) return;

  const reason = str(req.body && req.body.reason, REASON_MAX).trim();
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(id);
  const killed = revokeAllSessions(id);
  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'user.disable',
    targetType: 'user', targetId: id, targetLabel: target.username, reason,
    meta: JSON.stringify({ sessions_revoked: killed }), ip: req.ip
  });
  emit(req, `user:${id}`, 'force_logout', { reason: 'Your account was disabled by an administrator.' });
  res.json({ success: true, sessionsRevoked: killed });
});

router.post('/users/:id/enable', requirePermission('users.disable'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  const target = guardTarget(req, res, id);
  if (!target) return;
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(id);
  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'user.enable',
    targetType: 'user', targetId: id, targetLabel: target.username,
    reason: str(req.body && req.body.reason, REASON_MAX), ip: req.ip
  });
  res.json({ success: true });
});

// ---------- Hard delete (Owner only) ----------
router.delete('/users/:id', requirePermission('users.delete'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  if (id === req.admin.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  if (!requireOwner(req, res)) return;
  const target = guardTarget(req, res, id);
  if (!target) return;

  const confirm = str(req.body && req.body.confirm, 40);
  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: "Type DELETE to confirm a permanent account removal." });
  }

  const meta = JSON.stringify({ username: target.username, email: target.email });
  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'user.delete',
    targetType: 'user', targetId: id, targetLabel: target.username,
    reason: str(req.body && req.body.reason, REASON_MAX), meta, ip: req.ip
  });

  db.prepare('DELETE FROM users WHERE id = ?').run(id); // cascades to posts/comments/likes/etc.
  emit(req, `user:${id}`, 'force_logout', { reason: 'This account no longer exists.' });
  emit(req, 'admins', 'admin_event', { type: 'delete', targetId: id, target: target.username });
  res.json({ success: true });
});

// ---------- Verification badge ----------
router.post('/users/:id/verify', requirePermission('users.verify'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  const target = guardTarget(req, res, id);
  if (!target) return;

  const verified = !!(req.body && req.body.verified);
  const reason = str(req.body && req.body.reason, REASON_MAX).trim();

  // Settings rule: moderators may only verify when the Owner enabled it.
  if (req.admin.role === 'moderator' && getSettings().allow_moderator_verify !== '1') {
    return forbidden(res, 'Verification is restricted to admins.');
  }
  if (target.is_verified === (verified ? 1 : 0)) {
    return res.status(400).json({ error: verified ? 'Already verified.' : 'This account is not verified.' });
  }

  setVerified(id, verified);
  audit({
    adminId: req.admin.id, adminName: req.admin.username,
    action: verified ? 'verification.grant' : 'verification.revoke',
    targetType: 'user', targetId: id, targetLabel: target.username, reason, ip: req.ip
  });
  emit(req, `user:${id}`, 'profile_updated', { verified });
  emit(req, 'admins', 'admin_event', { type: verified ? 'verify' : 'unverify', targetId: id, target: target.username });
  res.json({ success: true, is_verified: verified ? 1 : 0 });
});

// ===========================================================================
// Reports (public creation + staff review)
// ===========================================================================
router.post('/reports', requireAuth, (req, res) => {
  const { target_type, target_id, reason, details } = req.body || {};
  const types = ['user', 'post', 'comment', 'message'];
  if (types.indexOf(target_type) === -1) {
    return res.status(400).json({ error: 'Choose what you are reporting.' });
  }
  const tid = parseInt(target_id, 10);
  if (!Number.isInteger(tid) || tid <= 0) return res.status(400).json({ error: 'Invalid target.' });
  if (target_type === 'user' && tid === req.user.id) {
    return res.status(400).json({ error: 'You cannot report yourself.' });
  }
  const why = str(reason, 120).trim();
  if (!why) return res.status(400).json({ error: 'A reason is required.' });

  // The target must exist, otherwise reports become an unbounded id oracle.
  const tableFor = { user: 'users', post: 'posts', comment: 'comments', message: 'messages' };
  const exists = db.prepare(`SELECT id FROM ${tableFor[target_type]} WHERE id = ?`).get(tid);
  if (!exists) return res.status(404).json({ error: 'That content no longer exists.' });

  // One open report per reporter/target keeps spam reports useless as a weapon.
  const dup = db.prepare(`
    SELECT id FROM reports
    WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'
  `).get(req.user.id, target_type, tid);
  if (dup) return res.status(409).json({ error: 'You already reported this. Our team will review it.' });

  const info = db.prepare(`
    INSERT INTO reports (reporter_id, target_type, target_id, reason, details, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
  `).run(req.user.id, target_type, tid, why, str(details, 1000));

  emit(req, 'admins', 'admin_event', { type: 'report', id: info.lastInsertRowid, target_type });
  res.status(201).json({ success: true, id: info.lastInsertRowid });
});

router.get('/reports', requirePermission('reports.read'), (req, res) => {
  const { page, limit, offset } = pageParams(req);
  const status = str(req.query.status, 20);
  const q = str(req.query.q, 60).trim();

  const where = [];
  const args = [];
  if (['open', 'resolved', 'rejected'].indexOf(status) !== -1) { where.push('r.status = ?'); args.push(status); }
  if (q) { where.push('(r.reason LIKE ? OR r.details LIKE ? OR r.target_id = ?)'); args.push(`%${q}%`, `%${q}%`, parseInt(q, 10) || 0); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM reports r ${clause}`).get(...args).n;
  const rows = db.prepare(`
    SELECT r.*, ru.username AS reporter, ru.avatar_path AS reporter_avatar,
           au.username AS admin_name
    FROM reports r
    JOIN users ru ON ru.id = r.reporter_id
    LEFT JOIN users au ON au.id = r.admin_id
    ${clause} ORDER BY r.status = 'open' DESC, r.id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);

  // Resolve each target to something showable (author + excerpt).
  const out = rows.map((r) => {
    let target = null;
    try {
      if (r.target_type === 'user') {
        const u = db.prepare('SELECT id, username, avatar_path, is_verified, status FROM users WHERE id = ?').get(r.target_id);
        target = u ? { id: u.id, label: '@' + u.username, sub: u.status, href: `/profile/${u.id}` } : null;
      } else if (r.target_type === 'post') {
        const p = db.prepare('SELECT p.id, p.text, p.user_id, u.username FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(r.target_id);
        target = p ? { id: p.id, label: (p.text || '(media post)').slice(0, 140), sub: '@' + p.username, href: `/post/${p.id}` } : null;
      } else if (r.target_type === 'comment') {
        const c = db.prepare('SELECT c.id, c.text, c.post_id, u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(r.target_id);
        target = c ? { id: c.id, label: c.text.slice(0, 140), sub: '@' + c.username, href: `/post/${c.post_id}` } : null;
      } else {
        const m = db.prepare('SELECT m.id, m.content, m.conversation_id, u.username FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(r.target_id);
        target = m ? { id: m.id, label: m.content.slice(0, 140), sub: '@' + m.username, href: `/chats/${m.conversation_id}` } : null;
      }
    } catch (e) { target = null; }
    return {
      id: r.id, target_type: r.target_type, target_id: r.target_id,
      reason: r.reason, details: r.details, status: r.status,
      admin_notes: r.admin_notes, resolution: r.resolution,
      reporter: r.reporter, admin_name: r.admin_name,
      created_at: r.created_at, updated_at: r.updated_at, target
    };
  });

  res.json({ reports: out, total, page, limit });
});

router.patch('/reports/:id', requirePermission('reports.update'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });

  const status = str(req.body && req.body.status, 20);
  if (['open', 'resolved', 'rejected'].indexOf(status) === -1) {
    return res.status(400).json({ error: 'Status must be open, resolved or rejected.' });
  }
  const notes = str(req.body && req.body.notes, 1000);

  db.prepare(`
    UPDATE reports SET status = ?, admin_notes = ?, admin_id = ?, resolution = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, notes, req.admin.id, str(req.body && req.body.resolution, 200), id);

  audit({
    adminId: req.admin.id, adminName: req.admin.username,
    action: status === 'resolved' ? 'report.resolve' : status === 'rejected' ? 'report.reject' : 'report.reopen',
    targetType: 'report', targetId: id, targetLabel: `${report.target_type}#${report.target_id}`,
    reason: notes, ip: req.ip
  });
  res.json({ success: true });
});

// Moderation action taken from a report (ban / remove content / warn).
router.post('/reports/:id/action', requirePermission('reports.update'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });

  const action = str(req.body && req.body.action, 30);
  const reason = str(req.body && req.body.reason, REASON_MAX).trim();
  const notes = str(req.body && req.body.notes, 1000);

  // Resolve the report's target to an account so the rank rules can apply.
  let ownerId = null;
  if (report.target_type === 'user') ownerId = report.target_id;
  else if (report.target_type === 'post') {
    const p = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(report.target_id); ownerId = p && p.user_id;
  } else if (report.target_type === 'comment') {
    const c = db.prepare('SELECT user_id FROM comments WHERE id = ?').get(report.target_id); ownerId = c && c.user_id;
  } else if (report.target_type === 'message') {
    const m = db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(report.target_id); ownerId = m && m.sender_id;
  }

  if (action === 'ban') {
    if (!req.admin || !require('../database/admin').can(req.admin.role, 'users.ban')) {
      return forbidden(res, 'Your account cannot issue bans.');
    }
    if (!ownerId) return res.status(400).json({ error: 'Nothing to ban.' });
    if (ownerId === req.admin.id) return res.status(400).json({ error: 'You cannot ban your own account.' });
    const targetRole = roleOf(ownerId);
    if (!canActOn(req.admin.role, targetRole)) return forbidden(res, 'You cannot ban this account.');

    const expiry = banExpiry(req.body || {});
    if (!expiry || !reason) return res.status(400).json({ error: 'A duration and a reason are required.' });

    db.prepare('UPDATE user_bans SET active = 0 WHERE user_id = ? AND active = 1').run(ownerId);
    db.prepare(`
      INSERT INTO user_bans (user_id, admin_id, reason, ban_type, starts_at, expires_at, active, created_at)
      VALUES (?, ?, ?, ?, datetime('now'), ?, 1, datetime('now'))
    `).run(ownerId, req.admin.id, reason, expiry.ban_type, expiry.expires_at);
    const killed = revokeAllSessions(ownerId);
    audit({
      adminId: req.admin.id, adminName: req.admin.username,
      action: expiry.ban_type === 'permanent' ? 'ban.permanent' : 'ban.temporary',
      targetType: 'user', targetId: ownerId, reason,
      meta: JSON.stringify({ via_report: id, sessions_revoked: killed }), ip: req.ip
    });
    emit(req, `user:${ownerId}`, 'force_logout', { reason: 'Your account has been banned.', banned: true });
  } else if (action === 'delete_content') {
    if (!req.admin || !require('../database/admin').can(req.admin.role, 'content.delete')) {
      return forbidden(res, 'Your account cannot remove content.');
    }
    const table = { post: 'posts', comment: 'comments', message: 'messages' }[report.target_type];
    if (!table) return res.status(400).json({ error: 'Only posts, comments and messages can be removed.' });
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(report.target_id);
    audit({
      adminId: req.admin.id, adminName: req.admin.username,
      action: `content.delete.${report.target_type}`,
      targetType: report.target_type, targetId: report.target_id, reason,
      meta: JSON.stringify({ via_report: id }), ip: req.ip
    });
    if (table === 'messages') emit(req, 'admins', 'admin_event', { type: 'content' });
  } else if (action === 'warn') {
    audit({
      adminId: req.admin.id, adminName: req.admin.username, action: 'user.warn',
      targetType: report.target_type, targetId: report.target_id, reason, ip: req.ip
    });
  } else {
    return res.status(400).json({ error: 'Unknown moderation action.' });
  }

  db.prepare(`
    UPDATE reports SET status = 'resolved', admin_id = ?, admin_notes = ?,
      resolution = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.admin.id, notes, action, id);

  res.json({ success: true, action });
});

// ===========================================================================
// Content moderation
// ===========================================================================
router.get('/content/posts', requirePermission('content.read'), (req, res) => {
  const { page, limit, offset } = pageParams(req);
  const q = str(req.query.q, 80).trim();
  const args = [];
  let clause = '';
  if (q) { clause = 'WHERE (p.text LIKE ? OR u.username LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM posts p JOIN users u ON u.id = p.user_id ${clause}`).get(...args).n;
  const rows = db.prepare(`
    SELECT p.id, p.text, p.media_path, p.media_type, p.created_at,
           p.user_id, u.username, u.role, u.is_verified
    FROM posts p JOIN users u ON u.id = p.user_id
    ${clause} ORDER BY p.id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  res.json({ posts: rows, total, page, limit });
});

router.get('/content/comments', requirePermission('content.read'), (req, res) => {
  const { page, limit, offset } = pageParams(req);
  const q = str(req.query.q, 80).trim();
  const args = [];
  let clause = '';
  if (q) { clause = 'WHERE (c.text LIKE ? OR u.username LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM comments c JOIN users u ON u.id = c.user_id ${clause}`).get(...args).n;
  const rows = db.prepare(`
    SELECT c.id, c.text, c.post_id, c.created_at, c.user_id,
           u.username, u.role, u.is_verified
    FROM comments c JOIN users u ON u.id = c.user_id
    ${clause} ORDER BY c.id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  res.json({ comments: rows, total, page, limit });
});

router.delete('/content/posts/:id', requirePermission('content.delete'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const post = db.prepare(`
    SELECT p.id, p.user_id, p.text, u.username, u.role FROM posts p
    JOIN users u ON u.id = p.user_id WHERE p.id = ?
  `).get(id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (!canActOn(req.admin.role, post.role)) return forbidden(res, 'You cannot remove this author\'s content.');

  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'content.delete.post',
    targetType: 'post', targetId: id, targetLabel: post.username,
    reason: str(req.body && req.body.reason, REASON_MAX),
    meta: JSON.stringify({ excerpt: (post.text || '').slice(0, 120) }), ip: req.ip
  });
  emit(req, 'admins', 'admin_event', { type: 'content' });
  res.json({ success: true });
});

router.delete('/content/comments/:id', requirePermission('content.delete'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare(`
    SELECT c.id, c.user_id, c.text, c.post_id, u.username, u.role FROM comments c
    JOIN users u ON u.id = c.user_id WHERE c.id = ?
  `).get(id);
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  if (!canActOn(req.admin.role, c.role)) return forbidden(res, 'You cannot remove this author\'s content.');

  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'content.delete.comment',
    targetType: 'comment', targetId: id, targetLabel: c.username,
    reason: str(req.body && req.body.reason, REASON_MAX),
    meta: JSON.stringify({ excerpt: (c.text || '').slice(0, 120), post_id: c.post_id }), ip: req.ip
  });
  res.json({ success: true });
});

// ===========================================================================
// Staff management (Owner only)
// ===========================================================================
router.get('/staff', requirePermission('staff.manage'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.email, u.avatar_path, u.role, u.is_verified, u.status, u.created_at,
           g.username AS granted_by_name, r.created_at AS since
    FROM users u
    LEFT JOIN user_roles r ON r.user_id = u.id
    LEFT JOIN users g ON g.id = r.granted_by
    WHERE u.role IN ('admin','moderator','owner')
    ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.username
  `).all();
  res.json({ staff: rows.map(adminUser).map((u, i) => ({ ...u, granted_by: rows[i].granted_by_name, since: rows[i].since })) });
});

router.post('/staff', requirePermission('staff.manage'), (req, res) => {
  if (!requireOwner(req, res)) return;
  const userId = parseInt(req.body && req.body.userId, 10);
  const role = str(req.body && req.body.role, 20);
  const err = validateRoleChange(req.admin.role, role);
  if (err) return res.status(400).json({ error: err });
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Choose a user.' });
  if (userId === req.admin.id) return res.status(400).json({ error: 'You cannot change your own role.' });

  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'owner') return res.status(400).json({ error: 'The Owner role cannot be reassigned.' });

  db.prepare(`
    INSERT INTO user_roles (user_id, role, granted_by, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      role = excluded.role, granted_by = excluded.granted_by, updated_at = datetime('now')
  `).run(userId, role, req.admin.id);
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);

  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'role.change',
    targetType: 'user', targetId: userId, targetLabel: target.username,
    reason: str(req.body && req.body.reason, REASON_MAX),
    meta: JSON.stringify({ from: target.role, to: role }), ip: req.ip
  });
  emit(req, 'admins', 'admin_event', { type: 'role', targetId: userId });
  res.json({ success: true, role });
});

router.delete('/staff/:userId', requirePermission('staff.manage'), (req, res) => {
  if (!requireOwner(req, res)) return;
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  if (userId === req.admin.id) return res.status(400).json({ error: 'You cannot change your own role.' });

  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'owner') return res.status(400).json({ error: 'The Owner role cannot be revoked.' });

  db.prepare("UPDATE user_roles SET role = 'user', granted_by = ?, updated_at = datetime('now') WHERE user_id = ?")
    .run(req.admin.id, userId);
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(userId);

  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'role.change',
    targetType: 'user', targetId: userId, targetLabel: target.username,
    reason: str(req.body && req.body.reason, REASON_MAX),
    meta: JSON.stringify({ from: target.role, to: 'user' }), ip: req.ip
  });
  res.json({ success: true });
});

// ===========================================================================
// Audit logs
// ===========================================================================
router.get('/audit', requirePermission('audit.read'), (req, res) => {
  const { page, limit, offset } = pageParams(req);
  const action = str(req.query.action, 40);
  const q = str(req.query.q, 60).trim();
  const where = [];
  const args = [];
  if (action) { where.push('action LIKE ?'); args.push(`${action}%`); }
  if (q) { where.push('(admin_name LIKE ? OR target_label LIKE ? OR reason LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM admin_logs ${clause}`).get(...args).n;
  const rows = db.prepare(`
    SELECT * FROM admin_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  res.json({ logs: rows, total, page, limit });
});

// ===========================================================================
// Admin settings (Owner only)
// ===========================================================================
router.get('/settings', requirePermission('settings.manage'), (req, res) => {
  res.json({ settings: getSettings() });
});

router.put('/settings', requirePermission('settings.manage'), (req, res) => {
  if (!requireOwner(req, res)) return;
  const before = getSettings();
  const next = setSettings(req.body || {});
  audit({
    adminId: req.admin.id, adminName: req.admin.username, action: 'settings.update',
    targetType: 'settings', targetId: 0,
    reason: str(req.body && req.body.reason, REASON_MAX),
    meta: JSON.stringify({ before, after: next }), ip: req.ip
  });
  res.json({ settings: next });
});

module.exports = router;
