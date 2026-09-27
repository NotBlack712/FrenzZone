const db = require('../database/init');
// Ban state lives with the rest of the admin data; auth only asks one question.
const { activeBan: activeBanFor } = require('../database/admin');

// Everything a request handler is allowed to know about the caller.
// password_hash is deliberately NOT selected, so it cannot leak from here.
// `session_row_id` is the join proof that this specific cookie is still an
// approved session — it is stripped off before req.user is handed over.
const USER_SQL = `
  SELECT u.id, u.username, u.email, u.bio, u.avatar_path, u.banner_path,
         u.display_name, u.created_at, u.status, u.role, u.is_verified,
         s.id AS session_row_id, s.session_id AS active_session_id
  FROM users u
  LEFT JOIN user_sessions s
    ON s.user_id = u.id AND s.session_id = ?
  WHERE u.id = ?
`;

// Reads the caller's row for the session carried by this request.
// Returns null when there is no logged-in user, when the account was
// deactivated, or when this particular device has been signed out.
function currentUser(req) {
  if (!req.session || !req.session.userId || !req.sessionID) return null;
  const row = db.prepare(USER_SQL).get(req.sessionID, req.session.userId);
  if (!row || !row.session_row_id) return null;
  if (row.status === 'deactivated') return { deactivated: true };
  // Admin "disable" — a separate state on purpose: logging in must NOT bring
  // this one back (that is only for a user's own Settings deactivation).
  if (row.status === 'suspended') return { suspended: true };
  delete row.session_row_id;
  delete row.active_session_id;
  return row;
}

// Blocks access unless the request has a valid logged-in session.
// A banned account is refused HERE — every protected API in the app goes
// through this middleware, so a ban is enforced server-wide in one place.
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }
  if (user.deactivated) {
    return res.status(401).json({ error: 'This account is deactivated. Log in again to reactivate it.' });
  }
  if (user.suspended) {
    return res.status(403).json({ error: 'This account has been disabled by an administrator.', suspended: true });
  }
  const ban = activeBanFor(user.id);
  if (ban) {
    return res.status(403).json({
      error: ban.ban_type === 'permanent'
        ? 'This account has been banned.'
        : 'This account is temporarily banned.',
      banned: true,
      reason: ban.reason || '',
      expires_at: ban.expires_at || null
    });
  }
  req.user = user;
  next();
}

// Attaches req.user if logged in, but does not block the request either way.
function attachUser(req, res, next) {
  const user = currentUser(req);
  if (user && !user.deactivated && !user.suspended) req.user = user;
  next();
}

module.exports = { requireAuth, attachUser, currentUser };
