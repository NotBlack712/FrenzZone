const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database/init');
const { requireAuth, attachUser } = require('../middleware/auth');
const { upload, mediaKindFor } = require('../middleware/upload');

const router = express.Router();

function feedQuery(viewerId) {
  return db.prepare(`
    SELECT p.*, u.username, u.avatar_path, u.is_verified, u.role,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me
    FROM posts p JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all(viewerId);
}

// ---------- Feed ----------
router.get('/', attachUser, (req, res) => {
  const viewerId = req.user ? req.user.id : 0;
  res.json({ posts: feedQuery(viewerId) });
});

// ---------- Single post (share links: /post/:id) ----------
// The id comes ONLY from the URL — the viewer's identity is used solely to
// decide whether *they* have liked it, never to choose which post is returned.
// attachUser (not requireAuth) so a shared link opens for a logged-out visitor
// too, exactly like the feed above.
router.get('/:id', attachUser, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid post id.' });
  }

  const viewerId = req.user ? req.user.id : 0;
  const post = db.prepare(`
    SELECT p.*, u.username, u.avatar_path, u.is_verified, u.role,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).get(viewerId, id);

  if (!post) return res.status(404).json({ error: 'Post not found.' });
  res.json({ post });
});

// ---------- Create post ----------
router.post('/', requireAuth, upload.single('media'), (req, res, next) => {
  const text = (req.body.text || '').trim();

  if (!text && !req.file) {
    return res.status(400).json({ error: 'A post needs text, media, or both.' });
  }

  let mediaPath = null;
  let mediaType = null;
  if (req.file) {
    mediaPath = `/uploads/${req.file.filename}`;
    mediaType = mediaKindFor(req.file.mimetype);
  }

  const info = db.prepare(
    'INSERT INTO posts (user_id, text, media_path, media_type, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
  ).run(req.user.id, text, mediaPath, mediaType);

  const post = db.prepare(`
    SELECT p.*, u.username, u.avatar_path, u.is_verified, u.role,
      0 AS like_count, 0 AS comment_count, 0 AS liked_by_me
    FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?
  `).get(info.lastInsertRowid);

  // The author is whatever user_id the row was saved with (req.user.id at
  // INSERT time) — never re-derived from whoever receives the event.
  const io = req.app.get('io');
  io.emit('new_post', { ...post, authorId: post.user_id, authorName: post.username });

  res.status(201).json({ post });
});

// ---------- Delete post ----------
router.delete('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.user_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own posts.' });
  }

  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);

  if (post.media_path) {
    const filePath = path.join(__dirname, '..', post.media_path);
    fs.unlink(filePath, () => {}); // best-effort cleanup, ignore errors
  }

  const io = req.app.get('io');
  io.emit('post_deleted', { postId: post.id });

  res.json({ success: true });
});

module.exports = router;
