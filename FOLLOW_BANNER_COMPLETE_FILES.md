# Follow System + Profile Banner - Complete Updated Files

Generated: 2026-09-26 14:08:30
Project:   C:\Users\Abdullah\Desktop\Social Media\social-app

NOTE: These files are ALREADY written to the project. This document is a
read-only reference bundle. server.js, routes/posts.js, routes/likes.js,
routes/comments.js, routes/auth.js, middleware/auth.js, socket/index.js and
public/js/api.js are UNCHANGED.

---

## FILE: database\init.js  (83 lines)

```js
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

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
`);

// Migration for databases created before the banner feature existed.
// (CREATE TABLE IF NOT EXISTS users never alters an already-built table.)
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some((c) => c.name === 'banner_path')) {
  db.exec('ALTER TABLE users ADD COLUMN banner_path TEXT DEFAULT NULL');
}

if (isNewDb) {
  console.log('[database] New SQLite database created at', DB_PATH);
} else {
  console.log('[database] Using existing SQLite database at', DB_PATH);
}

module.exports = db;
```

---

## FILE: middleware\upload.js  (118 lines)

```js
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/jpg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' }
};

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB (covers video); images are typically far smaller

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const info = ALLOWED_TYPES[file.mimetype];
    const ext = info ? info.ext : path.extname(file.originalname).replace('.', '') || 'bin';
    const unique = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    cb(null, unique);
  }
});

function fileFilter(req, file, cb) {
  if (ALLOWED_TYPES[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Allowed: JPG, JPEG, PNG, GIF, MP4, WebM.'));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
});

function mediaKindFor(mimetype) {
  const info = ALLOWED_TYPES[mimetype];
  return info ? info.kind : null;
}

// ---------- Profile banners ----------
// Banners are a separate, much stricter upload path than post media:
//   - images only (JPG / JPEG / PNG / WEBP), never video or anything else,
//   - 8MB maximum instead of 100MB,
//   - the extension is derived from the MIME type (never from the client's
//     filename), so a "payload.jpg.exe" can never land on disk as an exe,
//   - the first bytes of the saved file are re-checked against the expected
//     magic numbers, so MIME/extension claims are not trusted on their own.
const BANNER_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: 'jpg' },
  'image/jpg': { ext: 'jpg', magic: 'jpg' },
  'image/png': { ext: 'png', magic: 'png' },
  'image/webp': { ext: 'webp', magic: 'webp' }
};
const BANNER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const BANNER_MAX_SIZE = 8 * 1024 * 1024; // 8MB (recommended range: 5-10MB)

const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = BANNER_TYPES[file.mimetype].ext;
    cb(null, `banner-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
  }
});

function bannerFileFilter(req, file, cb) {
  const info = BANNER_TYPES[file.mimetype];
  if (!info) {
    return cb(new Error('Banner must be a JPG, JPEG, PNG or WEBP image.'));
  }
  // Extension check as well: the original filename must look like an image.
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext && !BANNER_EXTS.has(ext)) {
    return cb(new Error('Banner file extension is not allowed. Use .jpg, .jpeg, .png or .webp.'));
  }
  cb(null, true);
}

const bannerUpload = multer({
  storage: bannerStorage,
  fileFilter: bannerFileFilter,
  limits: { fileSize: BANNER_MAX_SIZE }
});

// Verifies the saved file really is the image type it claims to be.
function verifyImageSignature(filePath, mimetype) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    if (read < 3) return false;

    const info = BANNER_TYPES[mimetype];
    if (!info) return false;

    if (info.magic === 'jpg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (info.magic === 'png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (info.magic === 'webp') {
      return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

module.exports = { upload, bannerUpload, verifyImageSignature, mediaKindFor, UPLOAD_DIR };
```

---

## FILE: routes\users.js  (336 lines)

```js
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../database/init');
const { attachUser, requireAuth } = require('../middleware/auth');
const { bannerUpload, verifyImageSignature, UPLOAD_DIR } = require('../middleware/upload');

const router = express.Router();

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    bio: u.bio,
    avatar_path: u.avatar_path,
    banner_path: u.banner_path || null,
    created_at: u.created_at
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
    `SELECT id, username, bio, avatar_path FROM users
     WHERE username LIKE ? ORDER BY username ASC LIMIT 20`
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

  // UNIQUE(follower_id, following_id) makes duplicates impossible even
  // if two requests race.
  try {
    db.prepare(
      'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, datetime(\'now\'))'
    ).run(req.user.id, profileId);
  } catch (err) {
    if (!/UNIQUE/i.test(err.message || '')) throw err;
    // Already following: fall through and report the current state.
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

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(profileId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const viewerId = req.user ? req.user.id : 0;
  const counts = followCounts(profileId, viewerId);
  res.json({ following: counts.isFollowing, followerCount: counts.followerCount, followingCount: counts.followingCount, isFollowing: counts.isFollowing });
});

// ---------- Followers list (people who follow this profile) ----------
router.get('/:userId/followers', attachUser, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(profileId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const viewerId = req.user ? req.user.id : 0;
  const users = db.prepare(`
    SELECT u.id, u.username, u.bio, u.avatar_path,
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

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(profileId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const viewerId = req.user ? req.user.id : 0;
  const users = db.prepare(`
    SELECT u.id, u.username, u.bio, u.avatar_path,
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

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(profileId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const viewerId = req.user ? req.user.id : 0;

  // One query for counts + follow state, one for the post count.
  const counts = followCounts(profileId, viewerId);
  const postCount = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE user_id = ?').get(profileId).c;

  res.json({
    user: publicUser(user),
    postCount,
    isSelf: viewerId === user.id,
    followerCount: counts.followerCount,
    followingCount: counts.followingCount,
    isFollowing: counts.isFollowing
  });
});

// ---------- Posts written by that profile's user ----------
// Identity separation:
//   profileId (from the URL)  -> selects WHICH posts are returned
//   viewerId  (from session)  -> only sets the liked_by_me flag
router.get('/:userId/posts', attachUser, (req, res) => {
  const profileId = profileIdParam(req, res);
  if (!profileId) return;

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(profileId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const viewerId = req.user ? req.user.id : 0;
  const posts = db.prepare(`
    SELECT p.*, u.username, u.avatar_path,
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
```

---

## FILE: public\index.html  (178 lines)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Local Social</title>
<!-- ?v= = asset version. Any HTML reload (which Cloudflare always serves
     fresh) references a brand-new URL, so no browser or edge cache can ever
     serve a stale copy of the frontend after a code change. -->
<link rel="stylesheet" href="/css/style.css?v=__ASSET_VERSION__">
</head>
<body>

<!-- ===================== AUTH VIEW ===================== -->
<div id="auth-view" class="auth-view">
  <div class="auth-card">
    <div class="brand">
      <span class="brand-dot"></span>
      <h1>Local Social</h1>
    </div>
    <p class="auth-sub">A tiny social network that lives entirely on your computer.</p>

    <div class="auth-tabs">
      <button class="auth-tab active" data-tab="login">Log In</button>
      <button class="auth-tab" data-tab="register">Register</button>
    </div>

    <form id="login-form" class="auth-form">
      <input type="text" id="login-identifier" placeholder="Username or email" autocomplete="username" required>
      <input type="password" id="login-password" placeholder="Password" autocomplete="current-password" required>
      <button type="submit" class="btn btn-primary">Log In</button>
      <p class="form-error" id="login-error"></p>
    </form>

    <form id="register-form" class="auth-form hidden">
      <input type="text" id="register-username" placeholder="Username" autocomplete="username" required>
      <input type="email" id="register-email" placeholder="Email" autocomplete="email" required>
      <input type="password" id="register-password" placeholder="Password (min 6 characters)" autocomplete="new-password" required>
      <button type="submit" class="btn btn-primary">Create Account</button>
      <p class="form-error" id="register-error"></p>
    </form>
  </div>
</div>

<!-- ===================== APP VIEW ===================== -->
<div id="app-view" class="app-view hidden">

  <!-- Desktop top nav -->
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand small" data-nav="feed">
        <span class="brand-dot"></span>
        <span>Local Social</span>
      </div>

      <div class="search-wrap">
        <input type="text" id="search-input" placeholder="Search users...">
        <div id="search-results" class="search-results hidden"></div>
      </div>

      <nav class="desktop-nav">
        <button class="nav-btn active" data-nav="feed">Home</button>
        <button class="nav-btn" data-nav="create">Create Post</button>
        <button class="nav-btn" data-nav="search">Search</button>
        <button class="nav-btn" data-nav="profile">Profile</button>
        <button class="nav-btn" id="logout-btn">Logout</button>
      </nav>
    </div>
  </header>

  <main class="content">

    <!-- ---- Feed view ---- -->
    <section id="view-feed" class="view">
      <div class="view-header">
        <h2>Home Feed</h2>
      </div>
      <div id="feed-list" class="feed-list">
        <div class="empty-state" id="feed-empty">Loading feed...</div>
      </div>
    </section>

    <!-- ---- Create post view ---- -->
    <section id="view-create" class="view hidden">
      <div class="view-header"><h2>Create Post</h2></div>
      <form id="create-post-form" class="card create-post-card">
        <textarea id="post-text" placeholder="What's on your mind?" maxlength="1000" rows="4"></textarea>
        <input type="file" id="post-media" accept=".jpg,.jpeg,.png,.gif,.mp4,.webm">
        <div id="media-preview" class="media-preview hidden"></div>
        <div class="create-post-actions">
          <span id="create-post-error" class="form-error"></span>
          <button type="submit" class="btn btn-primary">Post</button>
        </div>
      </form>
    </section>

    <!-- ---- Search view ---- -->
    <section id="view-search" class="view hidden">
      <div class="view-header"><h2>Search Users</h2></div>
      <input type="text" id="search-input-mobile" placeholder="Search users..." class="mobile-search-input">
      <div id="search-list" class="user-list">
        <div class="empty-state">Search for someone by username.</div>
      </div>
    </section>

    <!-- ---- Profile view ---- -->
    <section id="view-profile" class="view hidden">
      <div class="profile-card">
        <div id="profile-banner" class="profile-banner"></div>
        <div id="profile-header" class="profile-header"></div>
      </div>
      <div id="profile-edit" class="card profile-edit-card hidden"></div>
      <div class="view-header"><h3>Posts</h3></div>
      <div id="profile-posts" class="feed-list"></div>
    </section>

  </main>

  <!-- Followers / Following list modal -->
  <div id="follow-list-modal" class="modal-backdrop hidden">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3 id="follow-list-title">Followers</h3>
        <button class="modal-close" id="follow-list-close" aria-label="Close">✕</button>
      </div>
      <div id="follow-list-body" class="user-list"></div>
    </div>
  </div>

  <!-- Banner editor modal -->
  <div id="banner-modal" class="modal-backdrop hidden">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>Edit Banner</h3>
        <button class="modal-close" id="banner-modal-close" aria-label="Close">✕</button>
      </div>
      <div class="banner-preview-wrap hidden" id="banner-preview-wrap">
        <img id="banner-preview" alt="Banner preview">
      </div>
      <p class="banner-hint">JPG, PNG or WEBP &middot; max 8MB</p>
      <input type="file" id="banner-file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp">
      <p class="form-error" id="banner-error"></p>
      <div class="modal-actions">
        <button class="btn btn-danger" id="banner-remove-btn">Remove Banner</button>
        <div class="modal-actions-right">
          <button class="btn btn-secondary" id="banner-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="banner-save-btn" disabled>Upload</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Mobile bottom nav -->
  <nav class="mobile-nav">
    <button class="mnav-btn active" data-nav="feed">
      <span class="mnav-icon">🏠</span><span>Home</span>
    </button>
    <button class="mnav-btn" data-nav="create">
      <span class="mnav-icon">➕</span><span>Create</span>
    </button>
    <button class="mnav-btn" data-nav="search">
      <span class="mnav-icon">🔍</span><span>Search</span>
    </button>
    <button class="mnav-btn" data-nav="profile">
      <span class="mnav-icon">👤</span><span>Profile</span>
    </button>
  </nav>

</div>

<!-- Comment modal / panel template lives inline per-post; toast container -->
<div id="toast" class="toast hidden"></div>

<script src="/socket.io/socket.io.js"></script>
<script src="/js/api.js?v=__ASSET_VERSION__"></script>
<script src="/js/app.js?v=__ASSET_VERSION__"></script>
</body>
</html>
```

---

## FILE: public\css\style.css  (394 lines)

```css
:root {
  --bg: #f4f6fb;
  --surface: #ffffff;
  --border: #e5e8f0;
  --text: #1a1d29;
  --text-muted: #6b7180;
  --primary: #5b5ff0;
  --primary-dark: #4548d6;
  --danger: #e5484d;
  --like: #ef4f6f;
  --radius: 16px;
  --radius-sm: 10px;
  --shadow: 0 2px 10px rgba(20, 20, 50, 0.06);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
}

.hidden { display: none !important; }

button {
  font-family: inherit;
  cursor: pointer;
}

input, textarea {
  font-family: inherit;
  font-size: 15px;
}

/* ---------------- Buttons ---------------- */
.btn {
  border: none;
  border-radius: 999px;
  padding: 10px 20px;
  font-weight: 600;
  font-size: 14px;
  transition: transform 0.08s ease, opacity 0.15s ease;
}
.btn:active { transform: scale(0.97); }
.btn-primary { background: var(--primary); color: white; }
.btn-primary:hover { background: var(--primary-dark); }
.btn-secondary { background: var(--border); color: var(--text); }
.btn-danger { background: transparent; color: var(--danger); }
.btn-ghost { background: transparent; color: var(--text-muted); }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }

/* ---------------- Auth ---------------- */
.auth-view {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: linear-gradient(135deg, #eef0ff 0%, #f4f6fb 60%);
}
.auth-card {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 36px 32px;
  width: 100%;
  max-width: 380px;
  animation: fadeUp 0.35s ease;
}
.brand { display: flex; align-items: center; gap: 10px; }
.brand h1 { font-size: 22px; margin: 0; }
.brand.small span { font-weight: 700; font-size: 16px; }
.brand-dot {
  width: 14px; height: 14px; border-radius: 50%;
  background: linear-gradient(135deg, var(--primary), #8a8dff);
  display: inline-block;
}
.auth-sub { color: var(--text-muted); font-size: 14px; margin: 8px 0 24px; }
.auth-tabs { display: flex; gap: 6px; background: var(--bg); border-radius: 999px; padding: 4px; margin-bottom: 20px; }
.auth-tab {
  flex: 1; border: none; background: transparent; padding: 8px 0;
  border-radius: 999px; font-weight: 600; font-size: 13px; color: var(--text-muted);
}
.auth-tab.active { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.auth-form { display: flex; flex-direction: column; gap: 12px; }
.auth-form input {
  padding: 12px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); outline: none;
}
.auth-form input:focus { border-color: var(--primary); }
.form-error { color: var(--danger); font-size: 13px; min-height: 16px; margin: 0; }

@keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

/* ---------------- App shell ---------------- */
.app-view { min-height: 100vh; padding-bottom: 70px; }

.topbar {
  position: sticky; top: 0; z-index: 20;
  background: rgba(255,255,255,0.9); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.topbar-inner {
  max-width: 900px; margin: 0 auto; padding: 12px 20px;
  display: flex; align-items: center; gap: 20px;
}
.brand.small { cursor: pointer; flex-shrink: 0; display: flex; gap: 8px; align-items: center; }

.search-wrap { position: relative; flex: 1; max-width: 320px; }
.search-wrap input {
  width: 100%; padding: 9px 14px; border-radius: 999px; border: 1px solid var(--border);
  outline: none; background: var(--bg);
}
.search-wrap input:focus { border-color: var(--primary); background: var(--surface); }
.search-results {
  position: absolute; top: 44px; left: 0; right: 0; background: var(--surface);
  border-radius: var(--radius-sm); box-shadow: var(--shadow); border: 1px solid var(--border);
  max-height: 320px; overflow-y: auto; z-index: 30;
}

.desktop-nav { display: flex; gap: 6px; margin-left: auto; }
.nav-btn {
  border: none; background: transparent; padding: 8px 14px; border-radius: 999px;
  font-weight: 600; font-size: 13.5px; color: var(--text-muted);
}
.nav-btn:hover { background: var(--bg); color: var(--text); }
.nav-btn.active { background: var(--primary); color: white; }
#logout-btn { color: var(--danger); }

.content { max-width: 640px; margin: 0 auto; padding: 20px 16px 40px; }
.view-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.view-header h2 { font-size: 19px; margin: 0; }
.view-header h3 { font-size: 16px; margin: 24px 0 12px; color: var(--text-muted); }

/* ---------------- Cards / Feed ---------------- */
.card {
  background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow);
  padding: 18px; margin-bottom: 14px; animation: fadeUp 0.25s ease;
}

.post-card { display: flex; flex-direction: column; gap: 10px; }
.post-head { display: flex; align-items: center; gap: 10px; }
.avatar {
  width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: #dfe2f0;
  display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--primary); flex-shrink: 0;
}
.avatar.sm { width: 30px; height: 30px; font-size: 12px; }
.post-user { display: flex; flex-direction: column; }
.post-username { font-weight: 700; font-size: 14.5px; cursor: pointer; }
.post-username:hover { text-decoration: underline; }
.post-time { font-size: 12px; color: var(--text-muted); }
.post-delete { margin-left: auto; }

.post-text { font-size: 14.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.post-media { width: 100%; border-radius: var(--radius-sm); max-height: 480px; object-fit: cover; background: #000; }

.post-actions { display: flex; gap: 18px; border-top: 1px solid var(--border); padding-top: 10px; }
.action-btn {
  border: none; background: transparent; display: flex; align-items: center; gap: 6px;
  font-size: 13.5px; color: var(--text-muted); font-weight: 600; padding: 4px 2px;
}
.action-btn.liked { color: var(--like); }
.action-btn:hover { color: var(--text); }
.action-btn.liked:hover { color: var(--like); }

.comments-section { display: flex; flex-direction: column; gap: 10px; }
.comment-list { display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow-y: auto; }
.comment-row { display: flex; gap: 8px; align-items: flex-start; }
.comment-bubble { background: var(--bg); border-radius: var(--radius-sm); padding: 8px 12px; flex: 1; }
.comment-user { font-weight: 700; font-size: 13px; }
.comment-text { font-size: 13.5px; margin-top: 2px; word-break: break-word; }
.comment-time { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.comment-delete { color: var(--danger); font-size: 11px; background: none; border: none; margin-left: auto; }
.comment-form { display: flex; gap: 8px; }
.comment-form input {
  flex: 1; padding: 9px 12px; border-radius: 999px; border: 1px solid var(--border); outline: none;
}
.comment-form input:focus { border-color: var(--primary); }
.comment-form button { padding: 8px 16px; }

/* ---------------- Create post ---------------- */
.create-post-card { display: flex; flex-direction: column; gap: 12px; }
#post-text {
  width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 12px; resize: vertical; outline: none;
}
#post-text:focus { border-color: var(--primary); }
#post-media { font-size: 13px; }
.media-preview img, .media-preview video { max-width: 100%; border-radius: var(--radius-sm); max-height: 320px; }
.create-post-actions { display: flex; align-items: center; justify-content: space-between; }

/* ---------------- Search ---------------- */
.mobile-search-input {
  width: 100%; padding: 10px 14px; border-radius: 999px; border: 1px solid var(--border);
  outline: none; margin-bottom: 14px;
}
.user-list { display: flex; flex-direction: column; gap: 8px; }
.user-row {
  display: flex; align-items: center; gap: 12px; background: var(--surface);
  border-radius: var(--radius-sm); padding: 10px 14px; box-shadow: var(--shadow); cursor: pointer;
}
.user-row .user-meta { display: flex; flex-direction: column; overflow: hidden; }
.user-row .user-bio { font-size: 12.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---------------- Profile ---------------- */
/* Card = banner on top + header row underneath.
   NO overflow:hidden on the card: it also contains the avatar, which must
   never be clipped. Only the banner clips (see below). */
.profile-card {
  background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow);
  margin-bottom: 14px; animation: fadeUp 0.25s ease;
}

/* The banner is the only element allowed to clip — that keeps its own rounded
   top corners square-free while leaving everything below it untouched. */
.profile-banner {
  position: relative; z-index: 0; width: 100%;
  border-radius: var(--radius) var(--radius) 0 0;
  overflow: hidden;
}

/* Fixed banner area: never stretches the layout, crops instead (object-fit). */
.banner-img {
  display: block; width: 100%; height: 200px;
  object-fit: cover; background: var(--border);
}
/* Default banner for accounts that never uploaded one — always renders
   something clean, never a broken image. */
.banner-img.banner-default {
  background: linear-gradient(120deg, #5b5ff0 0%, #8a8dff 45%, #b9bbff 100%);
}
.banner-img.banner-default::after { content: none; }

.banner-edit-btn {
  position: absolute; top: 12px; right: 12px;
  border: none; border-radius: 999px; padding: 7px 14px;
  background: rgba(255,255,255,0.92); color: var(--text);
  font-size: 12.5px; font-weight: 600; box-shadow: var(--shadow);
}
.banner-edit-btn:hover { background: #fff; }

.profile-header {
  padding: 18px 24px 22px; display: flex; gap: 18px; align-items: flex-start;
  flex-wrap: wrap; border-radius: 0; box-shadow: none; margin-bottom: 0;
  background: transparent;
}
/* The banner is position:relative, so a static avatar is painted UNDERNEATH
   it (CSS 2.1 paint order: positioned elements paint above in-flow ones).
   position:relative + z-index:2 puts the avatar on top; the reduced negative
   margin drops it so the whole circle stays visible while still overlapping
   the banner's bottom edge. */
.profile-header .avatar {
  width: 72px; height: 72px; font-size: 24px;
  border: 4px solid var(--surface);
  margin-top: -38px;
  position: relative; z-index: 2;
}
.profile-info { flex: 1; min-width: 220px; }
.profile-info h2 { margin: 0 0 4px; font-size: 19px; }
.profile-info .bio { color: var(--text); font-size: 14px; margin: 4px 0; }
.profile-info .meta { font-size: 12.5px; color: var(--text-muted); margin-top: 6px; }

/* Followers / Following counters — clickable buttons, real DB numbers. */
.follow-stats { display: flex; gap: 18px; margin: 10px 0 4px; flex-wrap: wrap; }
.follow-stat {
  border: none; background: transparent; padding: 4px 0;
  font-size: 13.5px; color: var(--text-muted); font-weight: 600;
}
.follow-stat strong { color: var(--text); font-size: 15px; }
.follow-stat:hover strong { color: var(--primary); }
.follow-stat:hover { text-decoration: underline; }

.profile-actions { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.follow-btn { min-width: 110px; }

.profile-edit-card { display: flex; flex-direction: column; gap: 10px; }
.profile-edit-card input, .profile-edit-card textarea {
  border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; outline: none;
}
.online-dot { width: 9px; height: 9px; border-radius: 50%; background: #35c759; display: inline-block; margin-left: 6px; }

/* ---------------- Modals (followers / following / banner) ---------------- */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(15, 17, 30, 0.55);
  display: flex; align-items: center; justify-content: center;
  padding: 20px; z-index: 60; animation: fadeIn 0.15s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.modal-card {
  background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow);
  width: 100%; max-width: 440px; max-height: 80vh; display: flex; flex-direction: column;
  padding: 18px; animation: fadeUp 0.2s ease;
}
.modal-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px; flex-shrink: 0;
}
.modal-head h3 { margin: 0; font-size: 17px; }
.modal-close {
  border: none; background: var(--bg); width: 30px; height: 30px; border-radius: 50%;
  font-size: 14px; color: var(--text-muted);
}
.modal-close:hover { background: var(--border); color: var(--text); }
#follow-list-body { overflow-y: auto; }

/* User rows inside the followers/following modal */
.follow-user-row { position: relative; padding-right: 96px; }
.follow-user-row .user-meta { flex: 1; min-width: 0; }
.row-follow-btn {
  position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
  padding: 6px 16px; font-size: 12.5px;
}
.btn-xs { padding: 6px 16px; font-size: 12.5px; }

/* ---------------- Banner editor ---------------- */
.banner-preview-wrap {
  width: 100%; height: 130px; border-radius: var(--radius-sm);
  overflow: hidden; background: var(--bg); margin-bottom: 10px;
}
.banner-preview-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
.banner-hint { font-size: 12.5px; color: var(--text-muted); margin: 0 0 8px; }
#banner-file { font-size: 13px; margin-bottom: 6px; }
.modal-actions {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; margin-top: 10px; flex-wrap: wrap;
}
.modal-actions-right { display: flex; gap: 8px; margin-left: auto; }
#banner-error { min-height: 18px; margin-top: 6px; }

/* ---------------- Empty / loading ---------------- */
.empty-state { text-align: center; color: var(--text-muted); padding: 40px 20px; font-size: 14px; }
.spinner {
  width: 22px; height: 22px; border: 3px solid var(--border); border-top-color: var(--primary);
  border-radius: 50%; animation: spin 0.7s linear infinite; margin: 0 auto;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------------- Toast ---------------- */
.toast {
  position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
  background: #1a1d29; color: white; padding: 10px 18px; border-radius: 999px;
  font-size: 13.5px; z-index: 100; box-shadow: var(--shadow); animation: fadeUp 0.2s ease;
}

/* ---------------- Mobile nav ---------------- */
.mobile-nav {
  display: none; position: fixed; bottom: 0; left: 0; right: 0; background: var(--surface);
  border-top: 1px solid var(--border); justify-content: space-around; padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
  z-index: 30;
}
.mnav-btn {
  border: none; background: transparent; display: flex; flex-direction: column; align-items: center;
  gap: 2px; font-size: 11px; color: var(--text-muted); padding: 6px 10px; border-radius: 10px;
}
.mnav-btn.active { color: var(--primary); }
.mnav-icon { font-size: 19px; }

@media (max-width: 720px) {
  .desktop-nav { display: none; }
  .mobile-nav { display: flex; }
  .content { padding-bottom: 90px; }
  .topbar-inner { flex-wrap: wrap; }
  .search-wrap { display: none; }

  /* Profile: banner shrinks, header stacks, counters wrap cleanly. */
  .banner-img { height: 130px; }
  .profile-header { padding: 14px 16px 18px; gap: 12px; }
  .profile-header .avatar { width: 60px; height: 60px; font-size: 20px; margin-top: -32px; }
  .profile-info { min-width: 0; width: 100%; }
  .follow-stats { gap: 14px; }
  .banner-edit-btn { top: 8px; right: 8px; padding: 6px 12px; font-size: 12px; }

  /* Modals stay usable on small screens. */
  .modal-card { max-width: 100%; max-height: 85vh; }
  .modal-actions { flex-direction: column; align-items: stretch; }
  .modal-actions-right { margin-left: 0; justify-content: flex-end; }
  .follow-user-row { padding-right: 88px; }
}

@media (min-width: 721px) and (max-width: 960px) {
  /* Tablet: banner keeps its proportions without stretching the card. */
  .banner-img { height: 170px; }
}

/* ---------------- Profile links ---------------- */
/* Every clickable user element is a real <a href="/profile/<user id>">, so a
   link always carries the target author's id — never the viewer's. */
a[data-profile-id] { color: inherit; text-decoration: none; cursor: pointer; }
.post-avatar-link, .comment-avatar-link { display: block; flex-shrink: 0; }
a.post-avatar-link:hover, a.comment-avatar-link:hover, a.user-row:hover { text-decoration: none; }
.comment-user { display: block; }
.comment-user:hover { text-decoration: underline; }
```

---

## FILE: public\js\app.js  (1026 lines)

```js
// ===================== State =====================
// currentUser     = the LOGGED-IN viewer. Set ONLY by session/login/register
//                   responses. It never decides which profile is on screen.
// viewedProfileId = the profile CURRENTLY BEING VIEWED, taken from the URL
//                   (/profile/:userId). These two are independent values;
//                   they are only ever equal when you view your own profile.
let currentUser = null;
let viewedProfileId = null;

// Monotonic token: every loadProfile() bumps it, so a slow response for a
// previously clicked profile can never overwrite the one currently on screen.
let profileLoadToken = 0;

let socket = null;
let onlineUsers = new Set();
let searchDebounce = null;

// The profile currently on screen (whole user row), kept so the banner editor
// knows whether a custom banner exists. Always the user from the URL.
let viewedProfileUser = null;

// Followers/Following modal state: which list of WHICH profile is open.
let followListState = null; // { type: 'followers' | 'following', profileId }

// Pending banner selection in the banner editor.
let bannerFile = null;
let bannerObjectUrl = null;

const BANNER_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const BANNER_MAX_BYTES = 8 * 1024 * 1024; // 8MB

// ===================== Helpers =====================
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function initials(username) {
  return (username || '?').slice(0, 2).toUpperCase();
}

function avatarHtml(user, size = '') {
  const cls = size ? `avatar ${size}` : 'avatar';
  if (user.avatar_path) {
    return `<img class="${cls}" src="${escapeHtml(user.avatar_path)}" alt="${escapeHtml(user.username)}">`;
  }
  return `<div class="${cls}">${escapeHtml(initials(user.username))}</div>`;
}

function timeAgo(sqliteDate) {
  // SQLite datetime('now') gives "YYYY-MM-DD HH:MM:SS" in UTC.
  const then = new Date(sqliteDate.replace(' ', 'T') + 'Z').getTime();
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2500);
}

function mediaHtml(post) {
  if (!post.media_path) return '';
  if (post.media_type === 'video') {
    return `<video class="post-media" src="${escapeHtml(post.media_path)}" controls></video>`;
  }
  return `<img class="post-media" src="${escapeHtml(post.media_path)}" alt="post media">`;
}

// Author of a post = the post's own stored user_id. Falls back to the
// explicit authorId sent with real-time events. NEVER currentUser.
function postAuthorId(post) {
  const id = post.user_id != null ? Number(post.user_id) : Number(post.authorId);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

// ===================== Boot =====================
window.addEventListener('DOMContentLoaded', init);

async function init() {
  bindAuthForms();
  bindNav();
  bindCreatePost();
  bindSearch();
  bindFollowListModal();
  bindBannerModal();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeFollowList(); closeBannerModal(); }
  });
  window.addEventListener('popstate', renderRoute);

  try {
    const { user } = await api.get('/api/auth/me');
    if (user) {
      currentUser = user;
      showApp();
    } else {
      showAuth();
    }
  } catch (e) {
    showAuth();
  }
}

function showAuth() {
  $('#auth-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}

function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  connectSocket();
  renderRoute(); // honours deep links such as /profile/5
}

// ===================== Auth =====================
function bindAuthForms() {
  $all('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $all('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      $('#login-form').classList.toggle('hidden', which !== 'login');
      $('#register-form').classList.toggle('hidden', which !== 'register');
    });
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const identifier = $('#login-identifier').value.trim();
    const password = $('#login-password').value;
    $('#login-error').textContent = '';
    try {
      const { user } = await api.post('/api/auth/login', { identifier, password });
      currentUser = user;
      showApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#register-username').value.trim();
    const email = $('#register-email').value.trim();
    const password = $('#register-password').value;
    $('#register-error').textContent = '';
    try {
      const { user } = await api.post('/api/auth/register', { username, email, password });
      currentUser = user;
      showApp();
    } catch (err) {
      $('#register-error').textContent = err.message;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await api.post('/api/auth/logout'); } catch (e) {}
    currentUser = null;
    viewedProfileId = null;
    profileLoadToken++; // drop any profile request still in flight
    if (socket) { socket.disconnect(); socket = null; }
    onlineUsers.clear();
    $('#login-form').reset();
    if (window.location.pathname !== '/') history.replaceState(null, '', '/');
    showAuth();
  });
}

// ===================== Socket.IO =====================
function connectSocket() {
  if (socket) return;
  socket = io();

  socket.on('new_post', (post) => {
    // The author comes from the event's own payload (the post row), never
    // from currentUser.
    const authorId = postAuthorId(post);

    if (!$('#view-feed').classList.contains('hidden')) {
      $('#feed-empty')?.remove();
      prependPost(post, '#feed-list');
    }

    // An open profile only receives a new post when the post's author IS the
    // profile on screen. The viewed profile's header/posts are never
    // replaced by another user's data.
    if (!$('#view-profile').classList.contains('hidden') && authorId === viewedProfileId) {
      $('#profile-posts .empty-state')?.remove();
      prependPost(post, '#profile-posts');
    }
  });

  socket.on('post_deleted', ({ postId }) => {
    $all(`.post-card[data-post-id="${postId}"]`).forEach(el => el.remove());
  });

  socket.on('new_comment', (comment) => {
    $all(`.post-card[data-post-id="${comment.post_id}"]`).forEach(card => {
      const list = $('.comment-list', card);
      if (list) list.insertAdjacentHTML('beforeend', commentRowHtml(comment));
      const countEl = $('.comment-count', card);
      if (countEl) countEl.textContent = (parseInt(countEl.textContent) || 0) + 1;
    });
    // Bind profile links on any comment rows we just injected.
    $all(`.post-card[data-post-id="${comment.post_id}"]`).forEach(card => bindProfileLinks(card));
  });

  socket.on('comment_deleted', ({ commentId, postId }) => {
    $all(`.comment-row[data-comment-id="${commentId}"]`).forEach(el => el.remove());
    $all(`.post-card[data-post-id="${postId}"] .comment-count`).forEach(el => {
      el.textContent = Math.max(0, (parseInt(el.textContent) || 1) - 1);
    });
  });

  socket.on('like_update', ({ postId, likeCount }) => {
    $all(`.post-card[data-post-id="${postId}"] .like-count`).forEach(el => el.textContent = likeCount);
  });

  // Real-time follow/unfollow: counts on the open profile (and any open
  // followers/following list) update without a refresh. The event carries the
  // profile it belongs to — never assume it's the one on screen.
  socket.on('follow_update', (ev) => {
    if (!ev) return;

    if (followListState && followListState.profileId === ev.profileId && !$('#follow-list-modal').classList.contains('hidden')) {
      refreshFollowList();
    }

    // The event describes profile `ev.profileId`. Apply ITS counts only to a
    // screen actually showing that profile — and the actor's own counts only
    // to a screen showing the actor. Never mix the two.
    if (viewedProfileId === ev.profileId) {
      updateFollowCounts(ev.followerCount, ev.followingCount);
      if (currentUser && ev.followerId === currentUser.id) setFollowButton(!!ev.following);
    } else if (currentUser && viewedProfileId === currentUser.id && ev.followerId === currentUser.id) {
      updateFollowCounts(ev.myFollowerCount, ev.myFollowingCount);
    }
  });

  socket.on('online_users', (ids) => { onlineUsers = new Set(ids); refreshOnlineDots(); });
  socket.on('user_online', ({ userId }) => { onlineUsers.add(userId); refreshOnlineDots(); });
  socket.on('user_offline', ({ userId }) => { onlineUsers.delete(userId); refreshOnlineDots(); });
}

function refreshOnlineDots() {
  $all('[data-online-for]').forEach(el => {
    const uid = parseInt(el.dataset.onlineFor);
    el.classList.toggle('hidden', !onlineUsers.has(uid));
  });
}

// ===================== Navigation & URL routing =====================
// The URL is the single source of truth for which profile is displayed:
// /profile/5 always renders user 5 and user 5's posts — after a click, a
// refresh, a back button, or when the URL is opened directly.
function parseRoute(pathname = window.location.pathname) {
  const match = pathname.match(/^\/profile\/(\d+)\/?$/);
  if (match) return { view: 'profile', profileId: parseInt(match[1], 10) };
  if (pathname === '/create') return { view: 'create' };
  if (pathname === '/search') return { view: 'search' };
  return { view: 'feed' }; // '/', '/index.html' and anything unknown
}

function setUrl(path) {
  if (window.location.pathname !== path) history.pushState(null, '', path);
}

function showView(view) {
  $all('.view').forEach(v => v.classList.add('hidden'));
  $all('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  $all('.mnav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  const el = document.getElementById(`view-${view}`);
  if (el) el.classList.remove('hidden');

  // Navigating away never leaves a stale overlay behind.
  closeFollowList();
  closeBannerModal();

  // Nothing is being viewed when the profile view isn't on screen.
  if (view !== 'profile') viewedProfileId = null;
}

// Render whatever the current URL points at. Only the URL decides which
// profile loads here — currentUser is never used as a fallback.
function renderRoute() {
  if (!currentUser) return; // logged out: the auth view is showing

  const route = parseRoute();

  if (route.view === 'profile') {
    showView('profile');
    loadProfile(route.profileId);
  } else if (route.view === 'create') {
    showView('create');
  } else if (route.view === 'search') {
    showView('search');
  } else {
    showView('feed');
    loadFeed();
  }
}

// User-initiated navigation: record the destination in the URL, then render it.
function navigate(view, profileId) {
  if (view === 'profile') {
    const id = Number(profileId);
    if (!Number.isInteger(id) || id <= 0) {
      toast('That profile link is invalid.');
      return;
    }
    setUrl(`/profile/${id}`);
  } else if (view === 'feed') {
    setUrl('/');
  } else if (view === 'create') {
    setUrl('/create');
  } else if (view === 'search') {
    setUrl('/search');
  }
  renderRoute();
}

function bindNav() {
  $all('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.nav;
      // The nav bar's "Profile" button means *my own* profile, so it passes
      // my id explicitly here. navigate() itself never guesses an identity.
      if (view === 'profile') {
        if (!currentUser) return;
        navigate('profile', currentUser.id);
        return;
      }
      navigate(view);
    });
  });
}

// Every clickable user element links to /profile/<that user's id>.
function bindProfileLinks(root, afterNavigate) {
  $all('[data-profile-id]', root).forEach(el => {
    el.onclick = (e) => {
      e.preventDefault();
      navigate('profile', el.dataset.profileId);
      if (afterNavigate) afterNavigate();
    };
  });
}

// ===================== Feed =====================
async function loadFeed() {
  const list = $('#feed-list');
  list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  try {
    const { posts } = await api.get('/api/posts');
    if (posts.length === 0) {
      list.innerHTML = '<div class="empty-state" id="feed-empty">No posts yet. Be the first to share something!</div>';
      return;
    }
    list.innerHTML = posts.map(postCardHtml).join('');
    bindPostCards(list);
  } catch (e) {
    list.innerHTML = `<div class="empty-state">Couldn't load the feed: ${escapeHtml(e.message)}</div>`;
  }
}

function prependPost(post, containerSel) {
  const list = $(containerSel);
  if (!list) return;
  list.insertAdjacentHTML('afterbegin', postCardHtml(post));
  bindPostCards(list);
}

function postCardHtml(post) {
  const authorId = postAuthorId(post);
  const authorName = post.username || post.authorName || '';
  const canDelete = currentUser && currentUser.id === authorId;
  return `
  <article class="card post-card" data-post-id="${post.id}" data-user-id="${authorId}">
    <div class="post-head">
      <a class="post-avatar-link" href="/profile/${authorId}" data-profile-id="${authorId}" aria-label="Open ${escapeHtml(authorName)}'s profile">
        ${avatarHtml({ username: authorName, avatar_path: post.avatar_path })}
      </a>
      <div class="post-user">
        <a class="post-username" href="/profile/${authorId}" data-profile-id="${authorId}">${escapeHtml(authorName)}
          <span class="online-dot hidden" data-online-for="${authorId}"></span>
        </a>
        <span class="post-time">${timeAgo(post.created_at)}</span>
      </div>
      ${canDelete ? `<button class="action-btn post-delete" data-delete-post="${post.id}">🗑</button>` : ''}
    </div>
    ${post.text ? `<div class="post-text">${escapeHtml(post.text)}</div>` : ''}
    ${mediaHtml(post)}
    <div class="post-actions">
      <button class="action-btn like-btn ${post.liked_by_me ? 'liked' : ''}" data-like-post="${post.id}">
        ${post.liked_by_me ? '❤️' : '🤍'} <span class="like-count">${post.like_count}</span>
      </button>
      <button class="action-btn comment-toggle" data-toggle-comments="${post.id}">
        💬 <span class="comment-count">${post.comment_count}</span>
      </button>
    </div>
    <div class="comments-section hidden" data-comments-for="${post.id}">
      <div class="comment-list"></div>
      <form class="comment-form" data-comment-form="${post.id}">
        <input type="text" placeholder="Write a comment..." maxlength="500" required>
        <button type="submit" class="btn btn-secondary">Send</button>
      </form>
    </div>
  </article>`;
}

function commentRowHtml(c) {
  const canDelete = currentUser && currentUser.id === c.user_id;
  return `
  <div class="comment-row" data-comment-id="${c.id}">
    <a class="comment-avatar-link" href="/profile/${c.user_id}" data-profile-id="${c.user_id}" aria-label="Open ${escapeHtml(c.username)}'s profile">
      ${avatarHtml({ username: c.username, avatar_path: c.avatar_path }, 'sm')}
    </a>
    <div class="comment-bubble">
      <a class="comment-user" href="/profile/${c.user_id}" data-profile-id="${c.user_id}">${escapeHtml(c.username)}</a>
      <div class="comment-text">${escapeHtml(c.text)}</div>
      <div class="comment-time">${timeAgo(c.created_at)} ${canDelete ? `<button class="comment-delete" data-delete-comment="${c.id}">Delete</button>` : ''}</div>
    </div>
  </div>`;
}

function bindPostCards(root) {
  bindProfileLinks(root);

  $all('[data-delete-post]', root).forEach(el => {
    el.onclick = async () => {
      if (!confirm('Delete this post?')) return;
      try { await api.del(`/api/posts/${el.dataset.deletePost}`); }
      catch (e) { toast(e.message); }
    };
  });

  $all('[data-like-post]', root).forEach(el => {
    el.onclick = async () => {
      el.disabled = true;
      try {
        const { liked } = await api.post(`/api/posts/${el.dataset.likePost}/like`);
        el.classList.toggle('liked', liked);
        el.firstChild.textContent = liked ? '❤️ ' : '🤍 ';
      } catch (e) { toast(e.message); }
      el.disabled = false;
    };
  });

  $all('[data-toggle-comments]', root).forEach(el => {
    el.onclick = () => toggleComments(el.dataset.toggleComments, root);
  });

  $all('[data-comment-form]', root).forEach(form => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      try {
        await api.post(`/api/posts/${form.dataset.commentForm}/comments`, { text });
        input.value = '';
      } catch (err) { toast(err.message); }
    };
  });

  $all('[data-delete-comment]', root).forEach(el => {
    el.onclick = async () => {
      try { await api.del(`/api/comments/${el.dataset.deleteComment}`); }
      catch (e) { toast(e.message); }
    };
  });
}

async function toggleComments(postId, root) {
  const section = $(`[data-comments-for="${postId}"]`, root);
  if (!section) return;
  const willShow = section.classList.contains('hidden');
  section.classList.toggle('hidden');
  if (willShow && !section.dataset.loaded) {
    const list = $('.comment-list', section);
    list.innerHTML = '<div class="empty-state">Loading comments...</div>';
    try {
      const { comments } = await api.get(`/api/posts/${postId}/comments`);
      list.innerHTML = comments.length ? comments.map(commentRowHtml).join('') : '<div class="empty-state">No comments yet.</div>';
      section.dataset.loaded = '1';
      bindPostCards(section);
    } catch (e) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
    }
  }
}

// ===================== Create post =====================
function bindCreatePost() {
  const fileInput = $('#post-media');
  fileInput.addEventListener('change', () => {
    const preview = $('#media-preview');
    const file = fileInput.files[0];
    if (!file) { preview.classList.add('hidden'); preview.innerHTML = ''; return; }
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      preview.innerHTML = `<video src="${url}" controls></video>`;
    } else {
      preview.innerHTML = `<img src="${url}" alt="preview">`;
    }
    preview.classList.remove('hidden');
  });

  $('#create-post-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#post-text').value.trim();
    const file = fileInput.files[0];
    const errEl = $('#create-post-error');
    errEl.textContent = '';

    if (!text && !file) { errEl.textContent = 'Add some text or media first.'; return; }

    const fd = new FormData();
    fd.append('text', text);
    if (file) fd.append('media', file);

    const submitBtn = $('#create-post-form button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api.postForm('/api/posts', fd);
      $('#post-text').value = '';
      fileInput.value = '';
      $('#media-preview').classList.add('hidden');
      $('#media-preview').innerHTML = '';
      toast('Posted!');
      navigate('feed');
    } catch (err) {
      errEl.textContent = err.message;
    }
    submitBtn.disabled = false;
  });
}

// ===================== Search =====================
function bindSearch() {
  const inputs = [$('#search-input'), $('#search-input-mobile')];
  inputs.forEach(input => {
    if (!input) return;
    input.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      const q = input.value.trim();
      searchDebounce = setTimeout(() => runSearch(q, input), 250);
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) $('#search-results').classList.add('hidden');
  });
}

async function runSearch(q, sourceInput) {
  const isTopbar = sourceInput.id === 'search-input';
  const resultsEl = isTopbar ? $('#search-results') : $('#search-list');

  if (!q) {
    if (isTopbar) resultsEl.classList.add('hidden');
    else resultsEl.innerHTML = '<div class="empty-state">Search for someone by username.</div>';
    return;
  }

  try {
    const { users } = await api.get(`/api/users/search?q=${encodeURIComponent(q)}`);
    if (isTopbar) resultsEl.classList.remove('hidden');
    resultsEl.innerHTML = users.length
      ? users.map(userRowHtml).join('')
      : '<div class="empty-state">No users found.</div>';
    // Each result carries its own user id, so the profile opened is that user.
    bindProfileLinks(resultsEl, () => $('#search-results').classList.add('hidden'));
  } catch (e) {
    resultsEl.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
}

function userRowHtml(u) {
  return `
  <a class="user-row" href="/profile/${u.id}" data-profile-id="${u.id}">
    ${avatarHtml(u)}
    <div class="user-meta">
      <strong>${escapeHtml(u.username)}</strong>
      <span class="user-bio">${escapeHtml(u.bio || 'No bio yet.')}</span>
    </div>
  </a>`;
}

// ===================== Profile =====================
// Loads ONE profile, identified by its id from the URL. Two rules keep this
// correct under any click order or timing:
//   1. the id comes from the caller/URL — never from currentUser, and
//   2. every await is checked against profileLoadToken, so a slow response
//      for a previously clicked profile is discarded instead of rendered.
async function loadProfile(userId) {
  const profileId = Number(userId);
  const token = ++profileLoadToken;
  viewedProfileId = Number.isInteger(profileId) && profileId > 0 ? profileId : null;
  viewedProfileUser = null;

  const bannerEl = $('#profile-banner');
  const headerEl = $('#profile-header');
  const postsEl = $('#profile-posts');
  const editEl = $('#profile-edit');
  editEl.classList.add('hidden');
  editEl.innerHTML = '';
  bannerEl.innerHTML = '';
  headerEl.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  postsEl.innerHTML = '';

  if (!viewedProfileId) {
    headerEl.innerHTML = '<div class="empty-state">That profile link is invalid.</div>';
    return;
  }

  try {
    // ONE request returns everything the header needs: profile info, banner,
    // follower/following counts and whether *the viewer* follows this profile.
    const data = await api.get(`/api/users/${profileId}`);
    if (token !== profileLoadToken) return; // a newer profile load took over

    const { user, postCount, isSelf, followerCount, followingCount, isFollowing } = data;
    viewedProfileUser = user;

    bannerEl.innerHTML = `
      <div class="banner-media">${bannerMediaHtml(user)}</div>
      ${isSelf ? '<button class="banner-edit-btn" id="edit-banner-btn" title="Edit banner">🖼 Edit Banner</button>' : ''}`;

    headerEl.innerHTML = `
      ${avatarHtml(user)}
      <div class="profile-info">
        <h2>${escapeHtml(user.username)}</h2>
        <p class="bio">${escapeHtml(user.bio || 'No bio yet.')}</p>
        <p class="meta">Joined ${new Date(user.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()} &middot; ${postCount} post${postCount === 1 ? '' : 's'}</p>
        <div class="follow-stats">
          <button class="follow-stat" id="followers-stat" title="View followers">
            <strong id="followers-count">${followerCount}</strong> Followers
          </button>
          <button class="follow-stat" id="following-stat" title="View following">
            <strong id="following-count">${followingCount}</strong> Following
          </button>
        </div>
        <div class="profile-actions">
          ${isSelf
            ? '<button class="btn btn-secondary" id="edit-profile-btn">Edit Profile</button>'
            : `<button class="btn ${isFollowing ? 'btn-secondary' : 'btn-primary'} follow-btn" id="follow-btn" data-following="${isFollowing ? '1' : '0'}">${isFollowing ? 'Following' : 'Follow'}</button>`}
        </div>
      </div>`;

    if (isSelf) {
      $('#edit-profile-btn').onclick = () => renderProfileEdit(user);
      $('#edit-banner-btn').onclick = openBannerModal;
    } else {
      $('#follow-btn').onclick = toggleFollow;
    }
    $('#followers-stat').onclick = () => openFollowList('followers');
    $('#following-stat').onclick = () => openFollowList('following');

    const { posts } = await api.get(`/api/users/${profileId}/posts`);
    if (token !== profileLoadToken) return; // stale posts must not be rendered

    postsEl.innerHTML = posts.length ? posts.map(postCardHtml).join('') : '<div class="empty-state">No posts yet.</div>';
    bindPostCards(postsEl);
  } catch (e) {
    if (token !== profileLoadToken) return;
    headerEl.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
    bannerEl.innerHTML = '';
    postsEl.innerHTML = '';
  }
}

// ===================== Follow system =====================
// Applies freshly-returned counts to whatever the profile header currently
// shows, but ONLY if the event belongs to the profile still on screen.
function updateFollowCounts(followerCount, followingCount) {
  const fEl = $('#followers-count');
  const gEl = $('#following-count');
  if (fEl && Number.isFinite(followerCount)) fEl.textContent = followerCount;
  if (gEl && Number.isFinite(followingCount)) gEl.textContent = followingCount;
}

function setFollowButton(following) {
  const btn = $('#follow-btn');
  if (!btn) return;
  btn.dataset.following = following ? '1' : '0';
  btn.textContent = following ? 'Following' : 'Follow';
  btn.classList.toggle('btn-secondary', following);
  btn.classList.toggle('btn-primary', !following);
}

async function toggleFollow() {
  const btn = $('#follow-btn');
  const targetId = viewedProfileId;
  if (!btn || !targetId || !currentUser) return;

  const willFollow = btn.dataset.following !== '1';
  btn.disabled = true;
  try {
    const result = willFollow
      ? await api.post(`/api/users/${targetId}/follow`)
      : await api.del(`/api/users/${targetId}/follow`);

    // Immediate UI update from the server's authoritative counts —
    // no page refresh required.
    if (viewedProfileId === targetId) {
      setFollowButton(result.following);
      updateFollowCounts(result.followerCount, result.followingCount);
      toast(result.following ? 'Following!' : 'Unfollowed.');
    }
  } catch (e) {
    toast(e.message);
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

// ---------- Followers / Following modal ----------
function bindFollowListModal() {
  $('#follow-list-close').onclick = closeFollowList;
  $('#follow-list-modal').addEventListener('click', (e) => {
    if (e.target.id === 'follow-list-modal') closeFollowList();
  });
}

function closeFollowList() {
  $('#follow-list-modal').classList.add('hidden');
  followListState = null;
  $('#follow-list-body').innerHTML = '';
}

// The list is ALWAYS keyed by the profile id passed in (the profile being
// viewed), never by currentUser.
async function openFollowList(type) {
  const profileId = viewedProfileId;
  if (!profileId) return;

  closeBannerModal(); // never stack two modals

  followListState = { type, profileId };
  $('#follow-list-title').textContent = type === 'followers' ? 'Followers' : 'Following';
  $('#follow-list-body').innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  $('#follow-list-modal').classList.remove('hidden');

  await refreshFollowList();
}

async function refreshFollowList() {
  const state = followListState;
  if (!state) return;

  try {
    const data = await api.get(`/api/users/${state.profileId}/${state.type}`);
    if (!followListState || followListState.profileId !== state.profileId || followListState.type !== state.type) return;

    const body = $('#follow-list-body');
    body.innerHTML = data.users.length
      ? data.users.map(followUserRowHtml).join('')
      : '<div class="empty-state">No users yet.</div>';

    // Keep the counts behind the modal in sync too.
    if (viewedProfileId === state.profileId) updateFollowCounts(data.followerCount, data.followingCount);
    bindFollowUserRows(body);
  } catch (e) {
    if (!followListState) return;
    $('#follow-list-body').innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
}

// A row in the followers/following modal: avatar, username, display name and
// a working Follow/Following button. Clicking the row opens that profile.
function followUserRowHtml(u) {
  const isSelf = currentUser && Number(u.id) === Number(currentUser.id);
  const following = !!u.is_following;
  return `
  <div class="user-row follow-user-row" data-profile-id="${u.id}">
    ${avatarHtml(u)}
    <div class="user-meta">
      <strong>${escapeHtml(u.username)}</strong>
      <span class="user-bio">${escapeHtml(u.bio || 'No display name')}</span>
    </div>
    ${isSelf ? '' : `<button class="btn btn-xs ${following ? 'btn-secondary' : 'btn-primary'} row-follow-btn"
        data-row-follow="${u.id}" data-following="${following ? '1' : '0'}">${following ? 'Following' : 'Follow'}</button>`}
  </div>`;
}

function bindFollowUserRows(root) {
  bindProfileLinks(root, closeFollowList); // clicking a user opens their profile

  $all('[data-row-follow]', root).forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // don't also open the profile
      const targetId = Number(btn.dataset.rowFollow);
      if (!targetId || !currentUser) return;
      if (Number(targetId) === Number(currentUser.id)) return;

      const willFollow = btn.dataset.following !== '1';
      btn.disabled = true;
      try {
        const result = willFollow
          ? await api.post(`/api/users/${targetId}/follow`)
          : await api.del(`/api/users/${targetId}/follow`);

        // Update this row instantly.
        btn.dataset.following = result.following ? '1' : '0';
        btn.textContent = result.following ? 'Following' : 'Follow';
        btn.classList.toggle('btn-secondary', result.following);
        btn.classList.toggle('btn-primary', !result.following);

        // Update the header counts ONLY if they belong to the profile on
        // screen: either the row's target is that profile, or that profile is
        // me (whose counts the response carries as myFollower/myFollowing).
        if (viewedProfileId === targetId) {
          updateFollowCounts(result.followerCount, result.followingCount);
        } else if (currentUser && viewedProfileId === currentUser.id) {
          updateFollowCounts(result.myFollowerCount, result.myFollowingCount);
        }
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
      }
    };
  });
}

// ===================== Profile banner =====================
function bindBannerModal() {
  $('#banner-modal-close').onclick = closeBannerModal;
  $('#banner-cancel-btn').onclick = closeBannerModal;
  $('#banner-modal').addEventListener('click', (e) => {
    if (e.target.id === 'banner-modal') closeBannerModal();
  });

  $('#banner-file').addEventListener('change', () => {
    const input = $('#banner-file');
    const file = input.files[0];
    const errEl = $('#banner-error');
    errEl.textContent = '';
    clearBannerPreview();

    if (!file) {
      $('#banner-save-btn').disabled = true;
      return;
    }

    // Client-side validation (the server re-validates independently).
    if (!BANNER_MIME_TYPES.includes(file.type)) {
      errEl.textContent = 'Only JPG, PNG or WEBP images are allowed.';
      input.value = '';
      $('#banner-save-btn').disabled = true;
      return;
    }
    if (file.size > BANNER_MAX_BYTES) {
      errEl.textContent = 'Image is too large. Maximum size is 8MB.';
      input.value = '';
      $('#banner-save-btn').disabled = true;
      return;
    }

    bannerFile = file;
    bannerObjectUrl = URL.createObjectURL(file);
    const wrap = $('#banner-preview-wrap');
    $('#banner-preview').src = bannerObjectUrl;
    wrap.classList.remove('hidden');
    $('#banner-save-btn').disabled = false;
  });

  $('#banner-save-btn').onclick = saveBanner;
  $('#banner-remove-btn').onclick = removeBanner;
}

function clearBannerPreview() {
  if (bannerObjectUrl) {
    URL.revokeObjectURL(bannerObjectUrl);
    bannerObjectUrl = null;
  }
  bannerFile = null;
  $('#banner-preview').removeAttribute('src');
  $('#banner-preview-wrap').classList.add('hidden');
}

function openBannerModal() {
  if (!currentUser || !viewedProfileId || Number(viewedProfileId) !== Number(currentUser.id)) {
    toast('You can only change your own banner.');
    return;
  }
  closeFollowList(); // never stack two modals
  $('#banner-error').textContent = '';
  $('#banner-file').value = '';
  clearBannerPreview();
  $('#banner-save-btn').disabled = true;
  $('#banner-remove-btn').classList.toggle('hidden', !(viewedProfileUser && viewedProfileUser.banner_path));
  $('#banner-modal').classList.remove('hidden');
}

function closeBannerModal() {
  const modal = $('#banner-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  $('#banner-error').textContent = '';
  $('#banner-file').value = '';
  clearBannerPreview();
}

async function saveBanner() {
  if (!bannerFile || !viewedProfileId) return;
  if (Number(viewedProfileId) !== Number(currentUser.id)) {
    toast('You can only change your own banner.');
    return;
  }

  const targetId = viewedProfileId;
  const btn = $('#banner-save-btn');
  btn.disabled = true;
  btn.textContent = 'Uploading...';

  try {
    const fd = new FormData();
    fd.append('banner', bannerFile);
    const result = await api.postForm(`/api/users/${targetId}/banner`, fd);

    if (viewedProfileId === targetId && result.banner_path) {
      applyBanner(result.banner_path); // instant update, no refresh
      if (viewedProfileUser) viewedProfileUser.banner_path = result.banner_path;
      toast('Banner updated!');
    }
    closeBannerModal();
  } catch (e) {
    $('#banner-error').textContent = e.message;
    btn.disabled = false;
  }
  btn.textContent = 'Upload';
}

async function removeBanner() {
  if (!viewedProfileId) return;
  if (Number(viewedProfileId) !== Number(currentUser.id)) {
    toast('You can only change your own banner.');
    return;
  }

  const targetId = viewedProfileId;
  try {
    await api.del(`/api/users/${targetId}/banner`);
    if (viewedProfileId === targetId) {
      applyBanner(null); // back to the default banner
      if (viewedProfileUser) viewedProfileUser.banner_path = null;
      toast('Banner removed.');
    }
    closeBannerModal();
  } catch (e) {
    $('#banner-error').textContent = e.message;
  }
}

// Swaps the banner image in place without re-rendering the whole profile.
function applyBanner(bannerPath) {
  const media = $('#profile-banner .banner-media');
  if (media) media.innerHTML = bannerMediaHtml({ banner_path: bannerPath });
  if (viewedProfileUser) viewedProfileUser.banner_path = bannerPath || null;
  // Keep the "Remove Banner" button's visibility honest.
  const removeBtn = $('#banner-remove-btn');
  if (removeBtn) removeBtn.classList.toggle('hidden', !bannerPath);
}

// A real <img> when a banner exists, a clean default gradient otherwise —
// never a broken image.
function bannerMediaHtml(user) {
  if (user.banner_path) {
    return `<img class="banner-img" src="${escapeHtml(user.banner_path)}" alt="${escapeHtml(user.username || '')} banner">`;
  }
  return '<div class="banner-img banner-default"></div>';
}

function renderProfileEdit(user) {
  const editEl = $('#profile-edit');
  editEl.classList.remove('hidden');
  editEl.innerHTML = `
    <label>Username</label>
    <input type="text" id="edit-username" value="${escapeHtml(user.username)}">
    <label>Bio</label>
    <textarea id="edit-bio" maxlength="300" rows="3">${escapeHtml(user.bio || '')}</textarea>
    <label>Avatar</label>
    <input type="file" id="edit-avatar" accept=".jpg,.jpeg,.png,.gif">
    <div class="create-post-actions">
      <span class="form-error" id="edit-error"></span>
      <button class="btn btn-primary" id="save-profile-btn">Save Changes</button>
    </div>`;

  $('#save-profile-btn').onclick = async () => {
    const fd = new FormData();
    const newUsername = $('#edit-username').value.trim();
    if (newUsername && newUsername !== user.username) fd.append('username', newUsername);
    fd.append('bio', $('#edit-bio').value.trim());
    const avatarFile = $('#edit-avatar').files[0];
    if (avatarFile) fd.append('avatar', avatarFile);

    try {
      const { user: updated } = await api.put('/api/auth/profile', fd, true);
      currentUser = updated; // the logged-in viewer changed their own profile
      toast('Profile updated!');
      // Re-render whatever profile is on screen; its id survives a rename.
      loadProfile(viewedProfileId != null ? viewedProfileId : updated.id);
    } catch (e) {
      $('#edit-error').textContent = e.message;
    }
  };
}
```

---
