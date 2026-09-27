const express = require('express');
const db = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const { notifyUser } = require('../socket/index');

const router = express.Router();

// ---------- List comments for a post ----------
router.get('/posts/:postId/comments', (req, res) => {
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found.' });

  const comments = db.prepare(`
    SELECT c.*, u.username, u.avatar_path, u.is_verified, u.role
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `).all(post.id);

  res.json({ comments });
});

// ---------- Add comment ----------
router.post('/posts/:postId/comments', requireAuth, (req, res) => {
  const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found.' });

  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Comment text is required.' });
  if (text.length > 500) return res.status(400).json({ error: 'Comment is too long (max 500 characters).' });

  const info = db.prepare(
    'INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?, ?, ?, datetime(\'now\'))'
  ).run(post.id, req.user.id, text);

  const comment = db.prepare(`
    SELECT c.*, u.username, u.avatar_path, u.is_verified, u.role
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?
  `).get(info.lastInsertRowid);

  const io = req.app.get('io');
  // The comment row is UI state and always lands on screen.
  io.emit('new_comment', comment);

  // "Someone commented on YOUR post" is a ping at the post's owner only, and
  // only when they haven't switched Comments off in Settings.
  if (post.user_id !== req.user.id) {
    notifyUser(io, post.user_id, 'comment_notifications', {
      kind: 'comment',
      postId: post.id,
      excerpt: text.slice(0, 80),
      actor: { id: req.user.id, username: req.user.username, avatar_path: req.user.avatar_path, is_verified: req.user.is_verified ? 1 : 0 }
    });
  }

  res.status(201).json({ comment });
});

// ---------- Delete own comment ----------
router.delete('/comments/:id', requireAuth, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.user_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own comments.' });
  }

  db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);

  const io = req.app.get('io');
  io.emit('comment_deleted', { commentId: comment.id, postId: comment.post_id });

  res.json({ success: true });
});

module.exports = router;
