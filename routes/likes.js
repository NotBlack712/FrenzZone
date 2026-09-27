const express = require('express');
const db = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const { notifyUser } = require('../socket/index');

const router = express.Router();

// ---------- Toggle like ----------
router.post('/:postId/like', requireAuth, (req, res) => {
  const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found.' });

  const existing = db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?')
    .get(post.id, req.user.id);

  let liked;
  let inserted = false; // true only when THIS request actually created the like
  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    liked = false;
  } else {
    // Prevent duplicate likes even under a race: UNIQUE(post_id, user_id) backs this up.
    try {
      db.prepare('INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, datetime(\'now\'))')
        .run(post.id, req.user.id);
      liked = true;
      inserted = true;
    } catch (err) {
      liked = true; // already liked concurrently; treat as liked
    }
  }

  const likeCount = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?').get(post.id).c;

  const io = req.app.get('io');
  // The count is UI state: everyone gets it, always.
  io.emit('like_update', { postId: post.id, likeCount });

  // Liking is only a notification for the OWNER of the post, and only on a
  // real new like (a re-toggled unlike never pings anyone). Dropped entirely
  // when the owner switched "Likes" off in Settings.
  if (inserted && post.user_id !== req.user.id) {
    notifyUser(io, post.user_id, 'like_notifications', {
      kind: 'like',
      postId: post.id,
      actor: { id: req.user.id, username: req.user.username, avatar_path: req.user.avatar_path, is_verified: req.user.is_verified ? 1 : 0 }
    });
  }

  res.json({ liked, likeCount });
});

module.exports = router;
