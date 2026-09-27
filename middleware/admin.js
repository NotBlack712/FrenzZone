// Server-side authorization for the Admin Panel.
//
// EVERY admin route must pass through requirePermission(). The check reads the
// caller's role FROM THE DATABASE on every request — nothing about a role is
// ever taken from the client, from the request body, from a query string or
// from an email comparison. Escalation is impossible because no endpoint
// accepts a role from the caller; roles only change through staff.manage,
// which only the Owner holds.
const { roleOf, rankOf, can } = require('../database/admin');
const { requireAuth } = require('./auth');

// 401 = not logged in, 403 = logged in but not allowed. They are never mixed:
// a normal user hitting an admin endpoint gets 403 with a generic message and
// no detail about what exists behind it.
function forbidden(res, message) {
  return res.status(403).json({ error: message || 'You do not have permission to do that.' });
}

// role   -> the permission string from database/admin.js
// Array of [requireAuth, gate]: the 401 (not logged in) is decided first,
// then the 403 (logged in but wrong role) — the two are never mixed.
function requirePermission(permission) {
  return [
    requireAuth,
    function adminGate(req, res, next) {
      const role = roleOf(req.user.id);
      req.admin = { id: req.user.id, username: req.user.username, role };

      if (!can(role, permission)) {
        return forbidden(res, 'Your account does not have access to this action.');
      }
      next();
    }
  ];
}

// Rank rules that apply to TARGETS rather than to endpoints:
//   - nobody may act on an owner except an owner,
//   - an admin may not act on another admin,
//   - a moderator may not act on staff at all.
// Used before every destructive action against another account.
function canActOn(actorRole, targetRole) {
  const a = rankOf(actorRole);
  const t = rankOf(targetRole);
  if (t === 0) return a > 0;                 // target is a normal user: staff ok
  if (t >= rankOf('owner')) return a >= rankOf('owner'); // owner is untouchable
  if (t === rankOf('admin')) return a >= rankOf('owner'); // admins: owner only
  return a >= rankOf('admin');               // moderator: admin+ only
}

// Owner-only guard used for role management and destructive platform actions.
function requireOwner(req, res) {
  const role = req.admin ? req.admin.role : 'user';
  if (role !== 'owner') {
    forbidden(res, 'Only the Owner can manage staff accounts.');
    return false;
  }
  return true;
}

// Role changes: only an owner may grant or revoke a staff role, the target
// must exist, and no role may ever be assigned above the actor's own rank
// (an owner is the ceiling, so only an owner can create an owner — and the
// Owner seat itself is never handed out through this API).
const ASSIGNABLE_ROLES = ['user', 'moderator', 'admin'];

function validateRoleChange(actorRole, newRole) {
  if (ASSIGNABLE_ROLES.indexOf(newRole) === -1) {
    return 'Invalid role.';
  }
  if (rankOf(actorRole) < rankOf('owner')) {
    return 'Only the Owner can manage staff roles.';
  }
  return null;
}

module.exports = { requirePermission, canActOn, requireOwner, validateRoleChange, forbidden };
