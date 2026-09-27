const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const { validateUsername, validateEmail } = require('./auth');
const { UPLOAD_DIR } = require('../middleware/upload');
const settings = require('../database/settings');

const router = express.Router();

// ============================================================================
// SECURITY MODEL
// Every handler below runs behind requireAuth and reads the caller's identity
// from req.user.id — which came from the server-side session, never from the
// request. There is deliberately NO /:userId segment anywhere in this file,
// so there is nothing to tamper with: user A physically cannot address
// user B's settings. password_hash is never selected and never returned.
// ============================================================================

function accountSummary(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    display_name: u.display_name || '',
    bio: u.bio || '',
    avatar_path: u.avatar_path || null,
    banner_path: u.banner_path || null,
    created_at: u.created_at,
    status: u.status || 'active'
  };
}

function loadSelf(req) {
  return db.prepare(
    'SELECT id, username, email, display_name, bio, avatar_path, banner_path, created_at, status, password_hash FROM users WHERE id = ?'
  ).get(req.user.id);
}

// Password policy: deliberately short to remember, long enough to matter.
const MIN_PASSWORD = 8;

/**
 * Strength score used by both the server and the settings UI, so the bar the
 * user sees is the bar the server actually applies.
 *   Weak = 0-2, Medium = 3-4, Strong = 5-6
 */
function passwordScore(pw) {
  const s = String(pw || '');
  let score = 0;
  if (s.length >= MIN_PASSWORD) score += 2;
  if (s.length >= 12) score += 1;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score += 1;
  if (/\d/.test(s)) score += 1;
  if (/[^\w\s]/.test(s)) score += 1;
  return score;
}

function passwordStrength(pw) {
  const s = passwordScore(pw);
  if (s <= 2) return 'Weak';
  if (s <= 4) return 'Medium';
  return 'Strong';
}

// ---------- GET /api/settings ----------
// Own account + own preferences in one round trip.
router.get('/', requireAuth, (req, res) => {
  const user = loadSelf(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  res.json({
    settings: settings.getSettings(req.user.id),
    account: accountSummary(user)
  });
});

// ---------- PATCH /api/settings ----------
// Privacy + notification + theme preferences. Only the columns that exist in
// user_settings are accepted; anything else is rejected by updateSettings().
router.patch('/', requireAuth, (req, res) => {
  const before = settings.peek(req.user.id);

  const result = settings.updateSettings(req.user.id, req.body);
  if (result.error) return res.status(400).json({ error: result.error });

  // Presence privacy has to reach connected clients right now — a user who
  // just hid their online status should vanish from everyone's dots without
  // waiting for a reload, and reappear when they turn it back on.
  if (before.show_online_status !== result.settings.show_online_status) {
    try {
      const initSocket = require('../socket/index');
      initSocket.announcePresenceChange(req.app.get('io'), req.user.id);
    } catch (e) { /* socket layer unavailable — setting is still saved */ }
  }

  res.json({ settings: result.settings });
});

// ---------- POST /api/settings/change-password ----------
router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};

  if (typeof currentPassword !== 'string' || !currentPassword) {
    return res.status(400).json({ error: 'Enter your current password.' });
  }
  const user = loadSelf(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated. Please log in.' });

  // Verify who they are before changing the one secret that protects the account.
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters long.` });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'New password must be different from your current password.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New password and confirmation do not match.' });
  }

  // Same hashing scheme as registration — bcrypt, cost 10, never plain text.
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);

  // The current session is kept: changing a password should not sign you out
  // of the device you are sitting at. Other devices are unaffected here —
  // that is the explicit "Log out of all other devices" control.
  res.json({
    success: true,
    message: 'Password changed successfully ✓',
    strength: passwordStrength(newPassword)
  });
});

// ---------- POST /api/settings/change-email ----------
// This project has no mail transport, so there is no verification link to
// send. The equivalent proof is the account password, which only the owner
// has — the same standard used for the other sensitive changes here.
router.post('/change-email', requireAuth, (req, res) => {
  const { email, password } = req.body || {};
  if (!validateEmail(email, res)) return;

  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Enter your password to confirm this change.' });
  }
  const user = loadSelf(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(400).json({ error: 'Your password is incorrect.' });
  }

  const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
  if (taken) return res.status(409).json({ error: 'That email address is already in use.' });

  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
  res.json({ success: true, message: 'Email updated ✓', email });
});

// ---------- POST /api/settings/change-username ----------
// Shares validation with registration. Relationships are keyed on the numeric
// users.id (posts, follows, likes, comments, friendships, messages), which a
// username change never touches — only login and search read username, and
// both simply pick up the new value.
router.post('/change-username', requireAuth, (req, res) => {
  const { username } = req.body || {};
  if (!validateUsername(username, res)) return;

  const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
  if (taken) return res.status(409).json({ error: 'That username is already taken.' });

  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.user.id);
  const user = loadSelf(req);
  res.json({ success: true, message: 'Username updated ✓', account: accountSummary(user) });
});

// ---------- Active sessions ----------
router.get('/sessions', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, session_id, user_agent, ip, created_at, last_seen_at
    FROM user_sessions
    WHERE user_id = ?
    ORDER BY last_seen_at DESC
  `).all(req.user.id);

  res.json({
    // The raw session id is never sent to the browser — it IS the credential.
    sessions: rows.map(r => ({
      id: r.id,
      current: r.session_id === req.sessionID,
      user_agent: r.user_agent,
      ip: r.ip,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at
    }))
  });
});

// Revoke one of MY sessions. user_id is taken from the session, so pointing
// this at someone else's row id simply finds nothing.
router.delete('/sessions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }
  const info = db.prepare('DELETE FROM user_sessions WHERE id = ? AND user_id = ?').run(id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Session not found.' });
  res.json({ success: true });
});

// ---------- Log out of all other devices ----------
// Deletes every session row except THIS one. requireAuth() refuses any
// session that is no longer in the table, so the other devices are cut off
// on their very next request while this one keeps working.
router.post('/logout-other-devices', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND session_id != ?')
    .run(req.user.id, req.sessionID);
  res.json({
    success: true,
    revoked: info.changes,
    message: info.changes
      ? `Logged out of ${info.changes} other device${info.changes === 1 ? '' : 's'}.`
      : 'No other devices were signed in.'
  });
});

// ---------- Deactivate ----------
// Hides the account and signs it out; nothing is deleted, so logging back in
// restores everything exactly as it was.
router.post('/deactivate', requireAuth, (req, res) => {
  db.prepare("UPDATE users SET status = 'deactivated' WHERE id = ?").run(req.user.id);
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(req.user.id);

  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Account deactivated.' });
  });
});

// ---------- Delete account ----------
// Requires the password AND an explicit confirmation string, so a stray click
// can never destroy an account.
router.delete('/account', requireAuth, (req, res) => {
  const { password, confirm } = req.body || {};

  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm you want to permanently delete this account.' });
  }
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Enter your password to confirm.' });
  }
  const user = loadSelf(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(400).json({ error: 'Your password is incorrect.' });
  }

  const userId = req.user.id;

  // Conversations this person was in, captured BEFORE the row disappears so
  // cleanup only ever touches rooms they were actually part of.
  const convIds = db.prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ?')
    .all(userId).map(r => r.conversation_id);

  // Files they owned (their own stored paths only).
  const ownedFiles = db.prepare('SELECT avatar_path, banner_path FROM users WHERE id = ?').get(userId);
  const mediaFiles = db.prepare('SELECT media_path FROM posts WHERE user_id = ? AND media_path IS NOT NULL')
    .all(userId).map(r => r.media_path);

  // Deletes the user. Every table that references users(id) declares
  // ON DELETE CASCADE, so posts, likes, comments, follows, friendships,
  // chat memberships, messages, settings and sessions all go with it —
  // no dangling foreign keys are left behind.
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  cleanupConversations(convIds, userId);

  for (const f of [ownedFiles && ownedFiles.avatar_path, ownedFiles && ownedFiles.banner_path, ...mediaFiles]) {
    deleteOwnedFile(f);
  }

  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Your account has been deleted.' });
  });
});

// After a member disappears, a conversation can become meaningless:
//   private -> only one person left, or nobody
//   group   -> nobody left, or no owner left
// Fixes both so nothing points at a room that can no longer work.
function cleanupConversations(convIds, deletedUserId) {
  for (const convId of convIds) {
    const exists = db.prepare('SELECT type FROM conversations WHERE id = ?').get(convId);
    if (!exists) continue; // it cascaded away already (this user created it)

    const members = db.prepare('SELECT COUNT(*) AS c FROM conversation_members WHERE conversation_id = ?')
      .get(convId).c;

    if (exists.type === 'private' && members < 2) {
      // A one-person private chat can never be used again.
      db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
      continue;
    }
    if (members === 0) {
      db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
      continue;
    }

    if (exists.type === 'group') {
      const hasOwner = db.prepare(
        'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND role = ?'
      ).get(convId, 'owner');
      if (!hasOwner) {
        // The owner was deleted: hand the group to whoever was there longest.
        const next = db.prepare(
          'SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at ASC, user_id ASC LIMIT 1'
        ).get(convId);
        if (next) {
          db.prepare("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?")
            .run(convId, next.user_id);
        }
      }
    }
  }
}

// Removes an uploaded file, but only ever from our own uploads directory and
// only for the exact path stored on this account.
function deleteOwnedFile(p) {
  if (!p || typeof p !== 'string' || !p.startsWith('/uploads/')) return;
  const base = path.basename(p);
  const full = path.join(UPLOAD_DIR, base);
  try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch (e) { /* ignore */ }
}

module.exports = router;
module.exports.passwordScore = passwordScore;
module.exports.passwordStrength = passwordStrength;
