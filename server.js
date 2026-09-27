const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');

require('./database/init'); // ensures tables exist before anything else runs

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');
const likeRoutes = require('./routes/likes');
const commentRoutes = require('./routes/comments');
const friendRoutes = require('./routes/friends');
const chatRoutes = require('./routes/chats');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');
const initSocket = require('./socket/index');

// Writes the Owner role into the database once (role is then read from the
// DB on every request — there is no email comparison anywhere in the API).
const { ensureOwner } = require('./database/admin');
ensureOwner();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// The app is reached through Cloudflare Tunnel: cloudflared connects to this
// server from 127.0.0.1 and passes the visitor's real IP in X-Forwarded-For.
// Trusting ONLY loopback proxies means:
//   - req.ip is the real visitor (each tunnel visitor gets their own
//     rate-limit bucket instead of everyone sharing one localhost bucket),
//   - express-rate-limit's X-Forwarded-For validation no longer errors,
//   - requests that reach us directly cannot spoof X-Forwarded-For.
app.set('trust proxy', 'loopback');

// ---------- Session (shared between Express and Socket.IO) ----------
const sessionMiddleware = session({
  secret: 'local-social-app-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
});
app.use(sessionMiddleware);

// ---------- Core middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Cloudflare's zone rewrites .js/.css responses to a 4-hour browser cache
// (localhost has no Cloudflare, which is why the site "worked locally but not
// on the tunnel" after frontend changes). HTML, however, is never cached
// (cf-cache-status: DYNAMIC). We exploit that: every HTML response is stamped
// with the CURRENT modification times of the frontend files, so the very next
// page load references asset URLs no cache has ever seen. A code change can
// therefore never be masked by a stale cache — no manual refresh or cache
// purge required.
function renderIndexHtml() {
  const pub = path.join(__dirname, 'public');
  const version = ['js/app.js', 'js/api.js', 'css/style.css']
    .map((f) => {
      try { return Math.floor(fs.statSync(path.join(pub, f)).mtimeMs / 1000); }
      catch (e) { return 0; }
    })
    .join('.');
  return fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
    .replace(/__ASSET_VERSION__/g, version);
}

// Frontend assets must never be served from a stale cache:
//   HTML          -> never stored (served only by the SPA fallback below)
//   JS / CSS      -> must revalidate (ETag/304) before reuse
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // HTML always goes through renderIndexHtml() below
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// Basic rate limiting on auth endpoints to slow down brute-force attempts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
// These verify the account password, so they get the same brute-force
// protection as login rather than the looser general API allowance.
app.use('/api/settings/change-password', authLimiter);
app.use('/api/settings/change-email', authLimiter);
app.use('/api/settings/account', authLimiter);

// General light rate limit for the rest of the API.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// The admin API is read/written in bursts by the panel (dashboard tiles,
// paged tables), so it gets its own bucket: generous enough for normal use,
// but a scripted sweep of the admin endpoints trips a tighter limit first.
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests. Please slow down.' }
});
app.use('/api/admin', adminLimiter);

// Make io available to route handlers via req.app.get('io')
app.set('io', io);

// Identifies THIS server process. express-session's store is in-memory and is
// wiped on restart, so any user_sessions row carrying a different boot id is
// provably dead and can be purged on the next login.
app.set('bootId', require('crypto').randomBytes(8).toString('hex'));

// ---------- Routes ----------
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/posts', likeRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/settings', settingsRoutes);
// Mounted before /api (commentRoutes) so no generic :id route can shadow it.
app.use('/api/admin', adminRoutes);
app.use('/api', commentRoutes);

// ---------- Multer / generic error handler ----------
app.use((err, req, res, next) => {
  if (err && err.message) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ---------- Frontend fallback (SPA) ----------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.setHeader('Cache-Control', 'no-store'); // deep links like /profile/25 always get fresh HTML
  res.type('html').send(renderIndexHtml());
});

// ---------- Socket.IO ----------
initSocket(io, sessionMiddleware);

server.listen(PORT, () => {
  console.log(`\nFrenza running at http://localhost:${PORT}\n`);
});
