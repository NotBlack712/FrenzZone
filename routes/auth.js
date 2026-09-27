const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const { activeBan } = require('../database/admin');
const { upload } = require('../middleware/upload');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Shared with routes/settings.js so the rules can never diverge between
// "register" and "change my username/email in Settings".
function validateUsername(username, res) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore or period.' });
    return false;
  }
  return true;
}

function validateEmail(email, res) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'Please provide a valid email address.' });
    return false;
  }
  return true;
}

// No password_hash here, and never anyone else's fields.
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    bio: u.bio,
    display_name: u.display_name || '',
    avatar_path: u.avatar_path,
    created_at: u.created_at,
    // Staff role + verified badge are server state: the client only renders
    // what the server already decided (see database/admin.js).
    role: u.role || 'user',
    is_verified: u.is_verified ? 1 : 0
  };
}

// ---------- Session bookkeeping ----------
// express-session stores its data in memory, so it cannot tell us which
// devices are signed in or sign one out remotely. user_sessions mirrors what
// we issue; requireAuth() only accepts sessions listed there, which is what
// makes "Log out of all other devices" actually work.
function recordSession(req) {
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  const ip = String(req.ip || '').slice(0, 64);
  const boot = String((req.app.get('bootId') && String(req.app.get('bootId'))) || '').slice(0, 40);

  // Sessions from a previous server boot are dead (the in-memory store was
  // wiped), so drop them rather than listing them as phantom devices.
  db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND boot_id != ?')
    .run(req.session.userId, boot);

  db.prepare(`
    INSERT INTO user_sessions (user_id, session_id, boot_id, user_agent, ip, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      user_id     = excluded.user_id,
      boot_id     = excluded.boot_id,
      user_agent  = excluded.user_agent,
      ip          = excluded.ip,
      last_seen_at = datetime('now')
  `).run(req.session.userId, req.sessionID, boot, ua, ip);
}

function forgetSession(req) {
  if (!req.sessionID) return;
  try { db.prepare('DELETE FROM user_sessions WHERE session_id = ?').run(req.sessionID); }
  catch (e) { /* already gone */ }
}

// ---------- Register ----------
router.post('/register', (req, res) => {
  const { username, email, password } = req.body || {};

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are all required.' });
  }
  if (!validateUsername(username, res)) return;
  if (!validateEmail(email, res)) return;
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) {
    return res.status(409).json({ error: 'That username or email is already registered.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, email, password_hash, bio, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
  ).run(username, email, hash, '');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  req.session.userId = user.id;
  recordSession(req);
  res.status(201).json({ user: publicUser(user) });
});

// ---------- Login ----------
router.post('/login', (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(identifier, identifier);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  // Admin-disabled accounts are refused outright — logging in is only how a
  // user's OWN Settings deactivation is undone, never an admin's disable.
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'This account has been disabled by an administrator.', suspended: true });
  }

  // Logging in is how a deactivated account comes back.
  if (user.status === 'deactivated') {
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    user.status = 'active';
  }

  // A ban blocks login outright — checked AFTER the password so the response
  // never tells an attacker whether an account exists.
  const ban = activeBan(user.id);
  if (ban) {
    return res.status(403).json({
      error: ban.ban_type === 'permanent'
        ? 'This account has been banned.'
        : `This account is banned until ${ban.expires_at} UTC.`,
      banned: true,
      reason: ban.reason || '',
      expires_at: ban.expires_at || null
    });
  }

  req.session.userId = user.id;
  recordSession(req);
  res.json({ user: publicUser(user) });
});

// ---------- Logout ----------
router.post('/logout', (req, res) => {
  forgetSession(req);
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// ---------- Current user ----------
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ user: null });
  const user = db.prepare(
    'SELECT id, username, email, bio, display_name, avatar_path, created_at, status, role, is_verified FROM users WHERE id = ?'
  ).get(req.session.userId);
  // A dead/revoked cookie must read as logged-out, not as a half-session.
  if (!user || user.status !== 'active') return res.json({ user: null });
  // Banned accounts read as logged out too (the ban message is shown by the
  // login endpoint, which is the only place the account can get back in).
  if (activeBan(user.id)) return res.json({ user: null });
  const live = db.prepare('SELECT 1 FROM user_sessions WHERE session_id = ? AND user_id = ?')
    .get(req.sessionID, user.id);
  if (!live) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

// ---------- Edit profile ----------
// Reused verbatim by the Settings > Profile section (display name, username,
// bio, avatar) — there is no second profile-edit endpoint.
router.put('/profile', requireAuth, upload.single('avatar'), (req, res) => {
  const { bio, username, display_name } = req.body || {};
  const updates = [];
  const params = [];

  if (username && username !== req.user.username) {
    if (!validateUsername(username, res)) return;
    const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (taken) return res.status(409).json({ error: 'That username is already taken.' });
    updates.push('username = ?');
    params.push(username);
  }

  if (display_name !== undefined) {
    const name = String(display_name).trim().slice(0, 40);
    updates.push('display_name = ?');
    params.push(name);
  }

  if (typeof bio === 'string') {
    updates.push('bio = ?');
    params.push(bio.slice(0, 300));
  }

  if (req.file) {
    updates.push('avatar_path = ?');
    params.push(`/uploads/${req.file.filename}`);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(updated) });
});

module.exports = router;
module.exports.validateUsername = validateUsername;
module.exports.validateEmail = validateEmail;
module.exports.publicUser = publicUser;
