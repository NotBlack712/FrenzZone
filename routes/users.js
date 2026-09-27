const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../database/init');
const { attachUser, requireAuth } = require('../middleware/auth');
const { bannerUpload, verifyImageSignature, UPLOAD_DIR } = require('../middleware/upload');
const { friendRequestBetween } = require('../database/friends');
const settings = require('../database/settings');
const { notifyUser } = require('../socket/index');

const router = express.Router();

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name || '',
    bio: u.bio,
    avatar_path: u.avatar_path,
    banner_path: u.banner_path || null,
    created_at: u.created_at,
    is_verified: u.is_verified ? 1 : 0,
    role: u.role || 'user'
  };
}

// The /:userId route parameter must be the target profile's numeric id.
// Returns null when it isn't a positive integer.
function parseUserId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Reads the :userId param as the profile being viewed. On failure it writes
// the error response and returns null, so callers can simply bail out.
function profileIdParam(req, res) {
  const profileId = parseUserId(req.params.userId);
  if (!profileId) {
    res.status(400).json({ error: 'Invalid profile id.' });
    return null;
  }
  return profileId;
}

// Profile visibility is decided ONLY on the server. 'friends' hides the whole
// profile — and every endpoint beneath it — from anyone who is not a confirmed
// friend. Returns true when access is allowed; otherwise it has already sent
// the error response.
function profileVisible(req, res, profileId) {
  const user = db.prepare('SELECT id, status FROM users WHERE id = ?').get(profileId);
  if (!user) {
    res.status(404).json({ error: 'User not found.' });
    return false;
  }
  // A deactivated account is off the site until its owner logs back in:
  // profile, posts, follower lists and presence all go dark for everyone,
  // signed in or not — not merely hidden by the UI.
  if (user.status !== 'active') {
    res.status(403).json({ error: user.status === 'suspended'
      ? 'This account has been disabled by an administrator.'
      : 'This account is deactivated.' });
    return false;
  }
  const viewerId = req.user ? req.user.id : 0;
  if (!settings.canViewProfile(profileId, viewerId)) {
    res.status(403).json({ error: 'This profile is private.' });
    return false;
  }
  return true;
}

// Counts are always computed from the follows table — never hardcoded.
function followCounts(profileId, viewerId) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM follows WHERE following_id = ?) AS follower_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = ?)  AS following_count,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?) AS is_following
  `).get(profileId, profileId, viewerId || 0, profileId);
  return {
    followerCount: row.follower_count,
    followingCount: row.following_count,
    isFollowing: !!row.is_following
  };
}

// The logged-in viewer's own counts, so a client that is currently showing
// the viewer's own profile can update it without guessing.
function ownCounts(userId) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM follows WHERE following_id = ?) AS follower_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = ?)  AS following_count
  `).get(userId, userId);
  return { myFollowerCount: row.follower_count, myFollowingCount: row.following_count };
}

// ---------- Search users ----------
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [] });

  const rows = db.prepare(
    `SELECT id, username, bio, avatar_path, is_verified FROM users
     WHERE username LIKE ? AND status = 'active' ORDER BY username ASC LIMIT 20`
  ).all(`%${q}%`);

  res.json({ users: rows });
});

// ---------- Follow a user ----------
// Identity separation:
//   req.params.userId = profile being followed (from the URL)
//   req.user.id       = the follower (the logged-in viewer)
router.post('/:userId/follow', requireAuth, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  if (profileId === req.user.id) {
    return res.status(400).json({ error: 'You cannot follow yourself.' });
  }

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(profileId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!profileVisible(req, res, profileId)) return;

  // UNIQUE(follower_id, following_id) makes duplicates impossible even
  // if two requests race.
  let isNewFollow = true;
  try {
    db.prepare(
      'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, datetime(\'now\'))'
    ).run(req.user.id, profileId);
  } catch (err) {
    if (!/UNIQUE/i.test(err.message || '')) throw err;
    // Already following: fall through and report the current state.
    isNewFollow = false;
  }

  const counts = followCounts(profileId, req.user.id);
  const mine = ownCounts(req.user.id);

  // Real-time: anyone watching this profile updates instantly.
  const io = req.app.get('io');
  if (io) {
    io.emit('follow_update', {
      profileId,
      followerId: req.user.id,
      followerName: req.user.username,
      followerCount: counts.followerCount,
      followingCount: counts.followingCount,
      following: true,
      // The ACTOR's own counts, so the actor's own profile can update too.
      myFollowerCount: mine.myFollowerCount,
      myFollowingCount: mine.myFollowingCount
    });

    // "X started following you" only ever goes to the profile being followed,
    // only on a genuinely new follow, and only if their "New followers"
    // preference is on.
    if (isNewFollow) {
      notifyUser(io, profileId, 'follower_notifications', {
        kind: 'follow',
        actor: { id: req.user.id, username: req.user.username, avatar_path: req.user.avatar_path, is_verified: req.user.is_verified ? 1 : 0 }
      });
    }
  }

  res.json({ following: true, ...counts, ...mine });
});

// ---------- Unfollow a user ----------
router.delete('/:userId/follow', requireAuth, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  if (profileId === req.user.id) {
    return res.status(400).json({ error: 'You cannot unfollow yourself.' });
  }

  db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
    .run(req.user.id, profileId);

  const counts = followCounts(profileId, req.user.id);
  const mine = ownCounts(req.user.id);

  const io = req.app.get('io');
  if (io) {
    io.emit('follow_update', {
      profileId,
      followerId: req.user.id,
      followerName: req.user.username,
      followerCount: counts.followerCount,
      followingCount: counts.followingCount,
      following: false
    });
  }

  res.json({ following: false, ...counts, ...mine });
});

// ---------- Follow status ----------
router.get('/:userId/follow-status', attachUser, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  if (!profileVisible(req, res, profileId)) return;

  const viewerId = req.user ? req.user.id : 0;
  const counts = followCounts(profileId, viewerId);
  res.json({ following: counts.isFollowing, followerCount: counts.followerCount, followingCount: counts.followingCount, isFollowing: counts.isFollowing });
});

// ---------- Followers list (people who follow this profile) ----------
router.get('/:userId/followers', attachUser, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  if (!profileVisible(req, res, profileId)) return;

  const viewerId = req.user ? req.user.id : 0;
  const users = db.prepare(`
    SELECT u.id, u.username, u.bio, u.avatar_path, u.is_verified,
      (u.id != ?) AS can_follow,
      EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id) AS is_following
    FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.following_id = ?
    ORDER BY f.created_at DESC
    LIMIT 200
  `).all(viewerId, viewerId, profileId);

  res.json({ users, ...followCounts(profileId, viewerId) });
});

// ---------- Following list (people this profile follows) ----------
router.get('/:userId/following', attachUser, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  if (!profileVisible(req, res, profileId)) return;

  const viewerId = req.user ? req.user.id : 0;
  const users = db.prepare(`
    SELECT u.id, u.username, u.bio, u.avatar_path, u.is_verified,
      (u.id != ?) AS can_follow,
      EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id) AS is_following
    FROM follows f JOIN users u ON u.id = f.following_id
    WHERE f.follower_id = ?
    ORDER BY f.created_at DESC
    LIMIT 200
  `).all(viewerId, viewerId, profileId);

  res.json({ users, ...followCounts(profileId, viewerId) });
});

// ---------- Upload / change banner (owner only) ----------
router.post('/:userId/banner', requireAuth, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  // Authorization happens on the server, not just in the UI.
  if (profileId !== req.user.id) {
    return res.status(403).json({ error: 'You can only change your own banner.' });
  }

  bannerUpload.single('banner')(req, res, (err) => {
    if (err) {
      const msg = /File too large|LIMIT_FILE_SIZE/i.test(err.message || '')
        ? 'Banner is too large. Maximum size is 8MB.'
        : (err.message || 'Banner upload failed.');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Choose an image to upload (JPG, PNG or WEBP).' });
    }

    // Don't trust MIME/extension alone — verify the actual file bytes.
    const filePath = path.join(UPLOAD_DIR, req.file.filename);
    if (!verifyImageSignature(filePath, req.file.mimetype)) {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
      return res.status(400).json({ error: 'That file is not a valid image.' });
    }

    const old = db.prepare('SELECT banner_path FROM users WHERE id = ?').get(profileId).banner_path;
    const bannerPath = `/uploads/${req.file.filename}`;

    db.prepare('UPDATE users SET banner_path = ? WHERE id = ?').run(bannerPath, profileId);

    // Remove the previous banner file so uploads don't accumulate.
    if (old && old !== bannerPath) deleteBannerFile(old);

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(profileId);
    res.json({ user: publicUser(updated), banner_path: bannerPath });
  });
});

// ---------- Remove banner (owner only) -> back to the default banner ----------
router.delete('/:userId/banner', requireAuth, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  if (profileId !== req.user.id) {
    return res.status(403).json({ error: 'You can only change your own banner.' });
  }

  const row = db.prepare('SELECT banner_path FROM users WHERE id = ?').get(profileId);
  if (!row || !row.banner_path) {
    return res.status(404).json({ error: 'No banner to remove.' });
  }

  db.prepare('UPDATE users SET banner_path = NULL WHERE id = ?').run(profileId);
  deleteBannerFile(row.banner_path);

  res.json({ banner_path: null });
});

// Deletes a banner file from disk, but only ever files we created
// (uploads/banner-*), never avatars or post media.
function deleteBannerFile(bannerPath) {
  if (!bannerPath || !bannerPath.startsWith('/uploads/')) return;
  const name = path.basename(bannerPath);
  if (!name.startsWith('banner-')) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch (e) { /* ignore */ }
}

// ---------- Public profile ----------
// Identity separation:
//   req.params.userId = profile being viewed
//   req.user.id       = the logged-in viewer (used ONLY for isSelf/is_following)
router.get('/:userId', attachUser, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  // Gate first: a friends-only profile reveals nothing at all — not the
  // banner, not the counts, not the post list underneath it.
  if (!profileVisible(req, res, profileId)) return;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(profileId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const viewerId = req.user ? req.user.id : 0;

  // One query for counts + follow state, one for the post count.
  const counts = followCounts(profileId, viewerId);
  const postCount = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE user_id = ?').get(profileId).c;

  // Friendship state rides along on the SAME request, so the profile page
  // never needs a second round-trip just to label the button.
  const friendRow = viewerId ? friendRequestBetween(viewerId, profileId) : null;
  const friendState = friendRow
    ? (friendRow.status === 'accepted' ? 'friends'
      : (friendRow.sender_id === viewerId ? 'sent' : 'received'))
    : 'none';

  res.json({
    user: publicUser(user),
    postCount,
    isSelf: viewerId === user.id,
    followerCount: counts.followerCount,
    followingCount: counts.followingCount,
    isFollowing: counts.isFollowing,
    friendStatus: viewerId === user.id ? 'none' : friendState,
    friendRequestId: friendRow ? friendRow.id : null,
    // Null when the owner has "Show my last seen" off, or when this viewer
    // isn't entitled to it — the timestamp is never even selected in that case.
    lastSeen: settings.lastSeenFor(profileId, viewerId)
  });
});

// ---------- Posts written by that profile's user ----------
// Identity separation:
//   profileId (from the URL)  -> selects WHICH posts are returned
//   viewerId  (from session)  -> only sets the liked_by_me flag
router.get('/:userId/posts', attachUser, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  if (!profileVisible(req, res, profileId)) return;

  const viewerId = req.user ? req.user.id : 0;
  const posts = db.prepare(`
    SELECT p.*, u.username, u.avatar_path, u.is_verified, u.role,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC
  `).all(viewerId, profileId);

  res.json({ posts });
});

module.exports = router;
