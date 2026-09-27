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

// Share menu: whose link is on offer right now (null = closed).
let sharePostId = null;

// Load guard for /post/:id. Same idea as profileLoadToken: a slow response for
// a post we already navigated away from can never overwrite the current URL.
let postLoadToken = 0;

// Pending composer selection (not uploaded yet) and its object URL.
let composerFile = null;
let composerObjectUrl = null;
let composerBusy = false;

// ---------- Friend + chat state ----------
// Pending requests, cached so the bell badge and the profile button can be
// updated from a socket event without re-fetching the whole list.
let friendRequests = { incoming: [], outgoing: [] };

// My conversation list (chat sidebar) and what is open right now.
let chatList = [];
let activeChatId = null;   // null = no thread open
let chatMessages = [];     // messages currently in the thread
let chatLoadToken = 0;     // discards stale thread loads
let chatHasMore = false;
let chatSending = false;
let chatSearchQuery = '';
let chatTyping = new Map();   // conversationId -> Map(userId -> timeout)

// Which profile's friendship buttons are on screen right now.
let profileFriendStatus = 'none';
let profileRequestId = null;   // request row id for Accept/Reject/Cancel

// Pending group image (create modal) and which group the members modal shows.
let groupFile = null;
let groupObjectUrl = null;
let membersConvId = null;

// The conversation open in the thread, its members, my read cursor (drives
// the ✓✓ ticks) and whether the sidebar has been fetched at least once.
let activeConv = null;
let activeConvMembers = null;
let privateReadCursor = 0;
let chatListLoaded = false;

// Unread message total shown on the Chats nav item (desktop + mobile). The
// SERVER owns this number (GET /api/chats and the mark-read response both
// return it, computed from my own read cursor); it is only nudged locally
// between those syncs so the badge reacts instantly without a page reload.
let unreadMsgTotal = 0;

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

// kind: 'notify' | 'message' | 'social' | 'success' | 'error' | 'info'.
// Every toast IS a notification, so every toast plays a short ping through
// the Web Audio module (public/js/sfx.js) — pass a kind only to colour it.
// Confirmations marked with a tick get the success tone automatically, so
// call sites do not have to know anything about sounds.
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2500);
  if (window.sfx) {
    const tone = kind || (typeof msg === 'string' && msg.indexOf('✓') >= 0 ? 'success' : 'info');
    sfx.play(tone);
  }
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

// ---------- FrenzZone verified badge ----------
// The badge is a database column (users.is_verified) written only by the
// admin verify endpoint. This helper merely RENDERS what the API returned —
// there is no client-side flag, no editable badge image and no way for a user
// to grant it to themselves from the browser. Every place that shows a name
// calls it, so a verified account looks verified everywhere at once.
//
// Drawn as an INLINE SVG (the classic scalloped seal with a white check),
// never as a bitmap file: nothing can be downloaded and re-uploaded, and it
// carries no background rectangle, so it sits cleanly on light and dark UI.
function verifiedBadge(v) {
  if (!Number(v)) return '';
  return '<span class="verified-badge" title="Verified" aria-label="Verified">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"/>' +
    '<path d="M7.9 12.3l2.8 2.8 5.5-6" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg></span>';
}

// Staff accounts get an "Admin" entry in both navs (desktop + mobile).
// Role comes from the server session payload; nothing is derived locally.
function syncAdminNav() {
  const staff = !!(currentUser && currentUser.role && currentUser.role !== 'user');
  $all('.admin-nav').forEach(el => el.classList.toggle('hidden', !staff));
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
  bindShareModal();
  bindPublicPost();
  bindNotifPanel();
  bindFriendsPage();
  bindChatPage();
  bindGroupModal();
  bindMembersModal();
  bindConfirmModal();
  bindSettingsPage();

  // Theme before anything renders: the inline <head> script already applied
  // the stored value to avoid a flash, this just brings JS state in line and
  // makes "System" follow the OS live from here on.
  applyTheme(storedThemePref());
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => { if (themePref === 'system') applyTheme('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onSchemeChange);
    else if (mq.addListener) mq.addListener(onSchemeChange); // older Safari
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeFollowList(); closeBannerModal(); closeShare(); closeEmojiPicker();
      closeNotifPanel(); closeGroupModal(); closeMembersModal();
      if (isDeleteOpen()) closeDeleteModal();
      else closeConfirm(false);
    }
  });
  window.addEventListener('popstate', renderRoute);

  try {
    const { user } = await api.get('/api/auth/me');
    if (user) {
      currentUser = user;
      showApp();
    } else {
      // A shared /post/:id link still opens for someone who isn't signed in.
      renderLoggedOut();
    }
  } catch (e) {
    renderLoggedOut();
  }
}

// Logged out: normal visitors get the auth screen, but a share link should
// still show the post it points at.
function renderLoggedOut() {
  if (parseRoute().view === 'post') showPublicPost();
  else showAuth();
}

function showAuth() {
  $('#app-view').classList.add('hidden');
  $('#public-post-view')?.classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}

function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#public-post-view')?.classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  connectSocket();
  syncAdminNav();     // shows the Admin entry only for accounts with a role
  loadFriendRequests(); // fills the notification badge before anything is clicked
  syncUnreadBadge();    // ...and the unread message count on the Chats item
  renderRoute(); // honours deep links such as /profile/5 and /post/12
}

// ---- Logged-out single post (/post/:id) ----
function bindPublicPost() {
  $('#public-login-btn').onclick = () => {
    $('#public-post-view').classList.add('hidden');
    showAuth(); // after logging in, showApp() re-renders the same /post/:id URL
  };
}

async function showPublicPost() {
  const route = parseRoute();
  if (route.view !== 'post') { showAuth(); return; }

  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.add('hidden');
  $('#public-post-view').classList.remove('hidden');

  const list = $('#public-post');
  list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  try {
    const { post } = await api.get(`/api/posts/${route.postId}`);
    if (parseRoute().view !== 'post') return; // URL moved on
    list.innerHTML = postCardHtml(post);
    bindPostCards(list);
    // Interactions need an account; the bar above offers one.
    $all('.post-actions, .comments-section', list).forEach(el => el.classList.add('hidden'));
  } catch (e) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
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
    unreadMsgTotal = 0;
    renderUnreadBadge();
    if (window.AdminPanel) AdminPanel.unmount();
    syncAdminNav();
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

  socket.on('online_users', (ids) => { onlineUsers = new Set(ids); refreshOnlineDots(); refreshPresenceUI(); });
  socket.on('user_online', ({ userId }) => { onlineUsers.add(userId); refreshOnlineDots(); refreshPresenceUI(); });
  socket.on('user_offline', ({ userId }) => { onlineUsers.delete(userId); refreshOnlineDots(); refreshPresenceUI(); });

  // ================= Friends + chat (real time) =================
  // Every handler lives in one place and only touches the part of the UI that
  // the event actually describes — no full page reload anywhere.
  const friendEvents = ['friend_request', 'friend_request_accepted',
    'friend_request_rejected', 'friend_request_cancelled', 'friend_removed'];
  friendEvents.forEach(ev => socket.on(ev, (payload) => handleFriendEvent(ev, payload)));

  const chatEvents = ['new_private_message', 'new_group_message', 'conversation_created',
    'group_created', 'group_updated', 'group_member_added', 'group_member_removed',
    'group_role_changed', 'group_deleted'];
  chatEvents.forEach(ev => socket.on(ev, (payload) => handleChatEvent(ev, payload)));

  socket.on('typing', handleTypingEvent);
  socket.on('message_read', handleReadEvent);

  // ============== Notifications (Settings > Notifications) ================
  // The SERVER decides whether this arrives at all — notifyUser() reads the
  // recipient's stored preference before emitting — so this handler only has
  // to format and show it. The live UI sync events above are unaffected by
  // those preferences and still run normally.
  socket.on('notification', (n) => {
    if (!n || !n.kind) return;
    const name = (n.actor && n.actor.username) || 'Someone';

    // A message for the thread already open on screen needs no ping: its
    // bubble and unread count were handled by the room event moments ago.
    if (n.kind === 'message' || n.kind === 'group_message') {
      const chatsVisible = $('#view-chats') && !$('#view-chats').classList.contains('hidden');
      if (chatsVisible && Number(n.conversationId) === activeChatId) return;
      toast(`${name}: ${n.preview || 'sent you a message.'}`, 'message');
      return;
    }

    if (n.kind === 'like') toast(`${name} liked your post.`, 'notify');
    else if (n.kind === 'comment') toast(`${name} commented on your post.`, 'notify');
    else if (n.kind === 'follow') toast(`${name} started following you.`, 'notify');
    else if (n.kind === 'chat_started') toast(`${name} started a chat with you.`, 'notify');
    else if (n.kind === 'group_invite') toast(`${name} added you to "${n.groupName || 'a group'}".`, 'notify');
    else toast(`${name} sent you a notification.`, 'notify');
  });

  // ============ Admin Panel (server -> client, no polling) ===============
  // The server deletes my user_sessions row when an admin bans, disables or
  // force-logs-out this account. That is already enough to block every API
  // call; this event only makes the tab react immediately instead of showing
  // a confusing half-logged-in UI.
  socket.on('force_logout', (payload) => {
    currentUser = null;
    viewedProfileId = null;
    profileLoadToken++;
    unreadMsgTotal = 0;
    renderUnreadBadge();
    if (window.AdminPanel) AdminPanel.unmount();
    const s = socket; socket = null;
    if (s) s.disconnect();
    onlineUsers.clear();
    if (window.location.pathname !== '/') history.replaceState(null, '', '/');
    showAuth();
    toast((payload && payload.reason) || 'You have been signed out.', 'error');
  });

  // Staff room: a new report, a ban, a verification change, ... The panel
  // re-fetches only what it is currently showing — never the whole page.
  socket.on('admin_event', (ev) => {
    if (window.AdminPanel && ev) AdminPanel.onAdminEvent(ev);
  });
}

function refreshOnlineDots() {
  $all('[data-online-for]').forEach(el => {
    const uid = parseInt(el.dataset.onlineFor);
    el.classList.toggle('hidden', !onlineUsers.has(uid));
  });
}

// Flips every "Online / Last seen recently" indicator that depends only on
// presence — friends cards, chat sidebar dots and the open thread header.
// Updates in place: no refetch, no re-render, no scroll jump.
function refreshPresenceUI() {
  $all('#friends-list .friend-card').forEach(card => {
    const box = $('.friend-status', card);
    if (!box) return;
    const on = onlineUsers.has(Number(card.dataset.userId));
    box.innerHTML = `<span class="dot ${on ? 'on' : ''}"></span>${on ? 'Online' : 'Last seen recently'}`;
  });

  $all('.chat-item[data-conv-id]').forEach(item => {
    const c = chatList.find(x => x.id === Number(item.dataset.convId));
    if (!c || c.type !== 'private' || !c.other_user) return;
    const dot = $('.chat-item-top .dot', item);
    if (dot) dot.classList.toggle('on', onlineUsers.has(c.other_user.id));
  });

  const sub = $('#thread-sub');
  if (sub && activeConv && activeConv.type === 'private' && activeConv.other_user) {
    const on = onlineUsers.has(activeConv.other_user.id);
    sub.innerHTML = `<span class="dot ${on ? 'on' : ''}"></span>${on ? 'Online' : 'Last seen recently'}`;
  }
}

// ===================== Navigation & URL routing =====================
// The URL is the single source of truth for which profile is displayed:
// /profile/5 always renders user 5 and user 5's posts — after a click, a
// refresh, a back button, or when the URL is opened directly.
function parseRoute(pathname = window.location.pathname) {
  const match = pathname.match(/^\/profile\/(\d+)\/?$/);
  if (match) return { view: 'profile', profileId: parseInt(match[1], 10) };
  // Share links: /post/123 -> view THAT post. The id is read from the URL
  // only; currentUser is never consulted to decide which post to load.
  const postMatch = pathname.match(/^\/post\/(\d+)\/?$/);
  if (postMatch) return { view: 'post', postId: parseInt(postMatch[1], 10) };
  if (pathname === '/friends') return { view: 'friends' };
  // Chat deep link: /chats/7 opens conversation 7 — never "whatever happens to
  // be first in my list".
  const chatMatch = pathname.match(/^\/chats\/(\d+)\/?$/);
  if (chatMatch) return { view: 'chats', conversationId: parseInt(chatMatch[1], 10) };
  if (pathname === '/chats') return { view: 'chats', conversationId: null };
  if (pathname === '/create') return { view: 'create' };
  if (pathname === '/search') return { view: 'search' };
  if (pathname === '/settings') return { view: 'settings' };
  // Admin Panel. The URL only picks the VIEW — the server still refuses the
  // data (and the whole panel) for any account without a staff role.
  if (pathname === '/admin') return { view: 'admin' };
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

  // The chat two-pane layout — and the settings two-column layout — need
  // more room than the usual 640px column.
  const content = $('.content');
  if (content) content.classList.toggle('content-wide', view === 'chats' || view === 'settings' || view === 'admin');

  // Leaving /admin stops its live refresh (admin_event socket listeners,
  // any in-flight page request) so nothing keeps running in the background.
  if (view !== 'admin' && window.AdminPanel) AdminPanel.unmount();

  // Navigating away never leaves a stale overlay behind.
  closeFollowList();
  closeBannerModal();
  closeShare();
  closeEmojiPicker();
  closeNotifPanel();

  // Nothing is being viewed when the profile view isn't on screen.
  if (view !== 'profile') viewedProfileId = null;
}

// Render whatever the current URL points at. Only the URL decides which
// profile loads here — currentUser is never used as a fallback.
function renderRoute() {
  // Logged out: auth screen — unless the URL is a share link, which still
  // renders its post (back/forward while signed out lands here too).
  if (!currentUser) { renderLoggedOut(); return; }

  const route = parseRoute();

  if (route.view === 'profile') {
    showView('profile');
    loadProfile(route.profileId);
  } else if (route.view === 'post') {
    showView('post');
    loadSinglePost(route.postId); // URL id is the ONLY thing that decides this
  } else if (route.view === 'friends') {
    showView('friends');
    loadFriendsPage();
  } else if (route.view === 'chats') {
    showView('chats');
    loadChatsPage(route.conversationId);
  } else if (route.view === 'create') {
    showView('create');
  } else if (route.view === 'search') {
    showView('search');
  } else if (route.view === 'settings') {
    showView('settings');
    loadSettingsPage();
  } else if (route.view === 'admin') {
    showView('admin');
    // A normal user still gets the view shell, but AdminPanel.mount() is
    // rejected server-side on the first call (403) and renders the refusal.
    if (window.AdminPanel) AdminPanel.mount();
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
  } else if (view === 'post') {
    const id = Number(profileId);
    if (!Number.isInteger(id) || id <= 0) {
      toast('That post link is invalid.');
      return;
    }
    setUrl(`/post/${id}`);
  } else if (view === 'feed') {
    setUrl('/');
  } else if (view === 'create') {
    setUrl('/create');
  } else if (view === 'search') {
    setUrl('/search');
  } else if (view === 'friends') {
    setUrl('/friends');
  } else if (view === 'chats') {
    setUrl('/chats');
  } else if (view === 'settings') {
    setUrl('/settings');
  } else if (view === 'admin') {
    setUrl('/admin');
  }
  renderRoute();
}

// Opens ONE conversation. Its id goes into the URL, so a refresh, the back
// button or a deep link always reopens the same conversation.
function navigateChat(conversationId) {
  const id = Number(conversationId);
  if (!Number.isInteger(id) || id <= 0) {
    toast('That conversation link is invalid.');
    return;
  }
  setUrl(`/chats/${id}`);
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
      list.dataset.loaded = '1'; // loaded — just empty
      list.innerHTML = '<div class="empty-state" id="feed-empty">No posts yet. Be the first to share something!</div>';
      return;
    }
    list.dataset.loaded = '1';
    list.innerHTML = posts.map(postCardHtml).join('');
    bindPostCards(list);
  } catch (e) {
    delete list.dataset.loaded;
    list.innerHTML = `<div class="empty-state">Couldn't load the feed: ${escapeHtml(e.message)}</div>`;
  }
}

function prependPost(post, containerSel) {
  const list = $(containerSel);
  if (!list) return;
  // Idempotent: the author receives their own post back over Socket.IO too,
  // so never insert the same id twice into the same container.
  if (list.querySelector(`.post-card[data-post-id="${post.id}"]`)) return;
  list.insertAdjacentHTML('afterbegin', postCardHtml(post));
  bindPostCards(list);
}

// Publish path: switch to the feed and show the new post WITHOUT refetching
// the whole list. Only falls back to one fetch if the feed was never loaded.
function showFeedWithPost(post) {
  setUrl('/');
  showView('feed');
  const list = $('#feed-list');
  if (list.dataset.loaded !== '1') { loadFeed(); return; }
  list.querySelector('.empty-state')?.remove();
  prependPost(post, '#feed-list');
}

// ===================== Single post (/post/:id) =====================
// The URL's id decides the request, and the response is checked against it —
// the logged-in user is never used as a fallback for "which post".
async function loadSinglePost(postId) {
  const token = ++postLoadToken;
  const list = $('#single-post');
  list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

  try {
    const { post } = await api.get(`/api/posts/${postId}`);
    if (token !== postLoadToken) return;        // the URL changed meanwhile
    if (!post || Number(post.id) !== Number(postId)) {
      list.innerHTML = '<div class="empty-state">That post doesn\'t exist.</div>';
      return;
    }
    list.innerHTML = postCardHtml(post);
    bindPostCards(list);
  } catch (e) {
    if (token !== postLoadToken) return;
    list.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
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
        <a class="post-username" href="/profile/${authorId}" data-profile-id="${authorId}">${escapeHtml(authorName)}${verifiedBadge(post.is_verified)}
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
      <button class="action-btn share-btn" data-share-post="${post.id}" aria-label="Share post">
        ↗ <span>Share</span>
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
      <a class="comment-user" href="/profile/${c.user_id}" data-profile-id="${c.user_id}">${escapeHtml(c.username)}${verifiedBadge(c.is_verified)}</a>
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
      catch (e) { toast(e.message, 'error'); }
    };
  });

  $all('[data-like-post]', root).forEach(el => {
    el.onclick = async () => {
      el.disabled = true;
      try {
        const { liked } = await api.post(`/api/posts/${el.dataset.likePost}/like`);
        el.classList.toggle('liked', liked);
        el.firstChild.textContent = liked ? '❤️ ' : '🤍 ';
      } catch (e) { toast(e.message, 'error'); }
      el.disabled = false;
    };
  });

  $all('[data-toggle-comments]', root).forEach(el => {
    el.onclick = () => toggleComments(el.dataset.toggleComments, root);
  });

  $all('[data-share-post]', root).forEach(el => {
    el.onclick = () => openShare(Number(el.dataset.sharePost));
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
      } catch (err) { toast(err.message, 'error'); }
    };
  });

  $all('[data-delete-comment]', root).forEach(el => {
    el.onclick = async () => {
      try { await api.del(`/api/comments/${el.dataset.deleteComment}`); }
      catch (e) { toast(e.message, 'error'); }
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

// ===================== Share =====================
// Built from window.origin, never a hardcoded domain, so the same build
// produces http://localhost:3000/post/9 and https://social.flaresnode.com/post/9.
function postUrl(postId) {
  return `${window.location.origin}/post/${postId}`;
}

function openShare(postId) {
  if (!postId) return;
  closeFollowList(); // never stack two modals
  closeBannerModal();
  closeEmojiPicker();

  sharePostId = postId;
  $('#share-link').textContent = postUrl(postId);
  $('#share-note').textContent = '';
  // Only offer the native sheet where the Web Share API actually exists —
  // no dead button in browsers that don't have it.
  $('#share-native').classList.toggle('hidden', typeof navigator.share !== 'function');
  $('#share-modal').classList.remove('hidden');
  $('#share-copy').focus();
}

function closeShare() {
  sharePostId = null;
  $('#share-modal')?.classList.add('hidden');
}

function bindShareModal() {
  $('#share-close').onclick = closeShare;
  $('#share-modal').addEventListener('click', (e) => {
    if (e.target.id === 'share-modal') closeShare();
  });

  $('#share-copy').onclick = async () => {
    if (!sharePostId) return;
    const url = postUrl(sharePostId);
    let copied = false;

    // execCommand fallback — the async Clipboard API rejects in plain http,
    // in some embedded browsers, and whenever permission isn't granted.
    const legacyCopy = () => {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, url.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    };

    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch (e) {
        copied = legacyCopy(); // permission denied / no user activation
      }
    } else {
      copied = legacyCopy();
    }

    if (!copied) {
      $('#share-note').textContent = "Couldn't copy — select the link above.";
      return;
    }

    toast('Link copied! ✓');
    $('#share-note').textContent = 'Link copied! ✓';
    // Close on its own shortly after. Nothing is refetched or reloaded.
    setTimeout(() => { if (sharePostId) closeShare(); }, 1200);
  };

  $('#share-native').onclick = async () => {
    if (!sharePostId || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({ title: 'Frenza', text: 'Check out this post on Frenza', url: postUrl(sharePostId) });
      closeShare();
    } catch (e) {
      if (e && e.name === 'AbortError') closeShare();      // user dismissed it
      else $('#share-note').textContent = "Sharing isn't available right now.";
    }
  };
}

// ===================== Create post =====================
const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif';
const VIDEO_ACCEPT = '.mp4,.webm,video/mp4,video/webm';
const MEDIA_ACCEPT = '.jpg,.jpeg,.png,.gif,.mp4,.webm,image/jpeg,image/png,image/gif,video/mp4,video/webm';
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;   // matches the server's image expectations
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;  // server limit for post media
const COMPRESS_EDGE = 1920;
const EMOJIS = ['😀', '😂', '😍', '😎', '🤔', '😅', '😢', '😡', '😉', '🥰',
  '👍', '👎', '🙏', '👏', '🙌', '❤️', '🔥', '🎉', '⭐', '💯', '✅', '✨', '😴', '🤯'];

function bindCreatePost() {
  const form = $('#create-post-form');
  const text = $('#post-text');
  const fileInput = $('#post-media');
  const errEl = $('#create-post-error');

  // Keep the composer compact: it grows with the text, capped at 200px.
  const autogrow = () => {
    text.style.height = 'auto';
    text.style.height = Math.min(text.scrollHeight, 200) + 'px';
  };
  text.addEventListener('input', autogrow);

  // ---- Tool row: Photo / Video / Emoji / Media ----
  $all('.tool-btn', form).forEach(btn => {
    btn.onclick = () => {
      if (composerBusy) return;
      const tool = btn.dataset.tool;
      if (tool === 'emoji') { toggleEmojiPicker(); return; }
      // One hidden input, retargeted so each button offers the right files.
      fileInput.accept = tool === 'photo' ? IMAGE_ACCEPT
        : tool === 'video' ? VIDEO_ACCEPT
        : MEDIA_ACCEPT;
      fileInput.click();
    };
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // so picking the same file again still fires change
    if (file) selectComposerFile(file);
  });

  $('#preview-remove').onclick = () => {
    clearComposerMedia();
    errEl.textContent = '';
  };

  // ---- Drag & drop (desktop); mobile keeps the file picker ----
  const dragDepth = { n: 0 };
  ['dragenter', 'dragover'].forEach(type => {
    form.addEventListener(type, (e) => {
      e.preventDefault();
      if (type === 'dragenter') dragDepth.n++;
      form.classList.add('is-dragging');
    });
  });
  form.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth.n = Math.max(0, dragDepth.n - 1);
    if (dragDepth.n === 0) form.classList.remove('is-dragging');
  });
  form.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth.n = 0;
    form.classList.remove('is-dragging');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) selectComposerFile(file);
  });

  // ---- Submit ----
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (composerBusy) return; // hard guard against duplicate posts
    const postText = text.value.trim();
    errEl.textContent = '';

    if (!postText && !composerFile) {
      errEl.textContent = 'Add some text or media first.';
      return;
    }

    setComposerBusy(true);
    const progress = $('#upload-progress');
    const bar = $('#upload-progress-bar');
    progress.classList.remove('hidden');
    bar.style.width = '0%';

    try {
      let file = composerFile;
      if (file && file.type.startsWith('image/')) {
        const smaller = await optimizeImage(file);
        if (smaller) file = smaller;
      }

      const fd = new FormData();
      fd.append('text', postText);
      if (file) fd.append('media', file);

      const post = await uploadPost(fd, (pct) => { bar.style.width = `${pct}%`; });
      if (!post) throw new Error('The server did not return the new post.');

      // Reset the composer, then show the post — no full feed reload.
      text.value = '';
      text.style.height = 'auto';
      clearComposerMedia();
      closeEmojiPicker();
      toast('Posted!');
      showFeedWithPost(post);
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      progress.classList.add('hidden');
      bar.style.width = '0%';
      setComposerBusy(false);
    }
  });
}

function setComposerBusy(busy) {
  composerBusy = busy;
  const btn = $('#post-submit');
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy ? '<span class="btn-spin"></span> Posting…' : 'Post';
  $all('.tool-btn').forEach(b => { b.disabled = busy; });
}

function selectComposerFile(file) {
  const errEl = $('#create-post-error');
  errEl.textContent = '';

  const isImage = (file.type || '').startsWith('image/');
  const isVideo = (file.type || '').startsWith('video/');
  if (!isImage && !isVideo) { errEl.textContent = 'Choose an image or video.'; return; }
  if (isImage && file.size > IMAGE_MAX_BYTES) { errEl.textContent = 'Images must be under 10MB.'; return; }
  if (isVideo && file.size > VIDEO_MAX_BYTES) { errEl.textContent = 'Videos must be under 100MB.'; return; }

  clearComposerMedia();
  composerFile = file;
  composerObjectUrl = URL.createObjectURL(file); // preview appears immediately

  $('#preview-inner').innerHTML = isVideo
    ? `<video src="${composerObjectUrl}" controls playsinline preload="metadata"></video>`
    : `<img src="${composerObjectUrl}" alt="Selected image preview">`;
  $('#media-preview').classList.remove('hidden');
}

function clearComposerMedia() {
  if (composerObjectUrl) URL.revokeObjectURL(composerObjectUrl);
  composerObjectUrl = null;
  composerFile = null;
  const inner = $('#preview-inner');
  if (inner) inner.innerHTML = '';
  $('#media-preview')?.classList.add('hidden');
}

// Real upload progress (fetch() can't report request progress).
function uploadPost(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/posts');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* no body */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data && data.post);
      else reject(new Error((data && data.error) || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading.'));
    xhr.send(formData);
  });
}

// Does the rendered canvas actually use transparency? Guards the JPEG
// fallback so PNGs that rely on alpha are never flattened.
function hasAlpha(ctx, w, h) {
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
  } catch (e) {
    return true; // can't read pixels — assume alpha, keep the safe path
  }
  return false;
}

// Downscale + re-encode oversized images client side so we never push a file
// the server doesn't need. Returns null when the original is already fine, and
// never replaces the file with something bigger.
async function optimizeImage(file) {
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') return null;
  if (typeof window.createImageBitmap !== 'function') return null;
  if (file.size <= 1024 * 1024) return null;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    return null; // undecodable image — let the server decide
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, COMPRESS_EDGE / longest);
    if (scale === 1 && file.size <= 4 * 1024 * 1024) return null;

    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);

    const toBlob = (type) => new Promise(res => {
      try { canvas.toBlob(b => res(b), type, 0.85); } catch (e) { res(null); }
    });

    const candidates = [];
    const native = await toBlob(file.type); // keep the original type when it wins
    if (native) candidates.push(native);

    // A big PNG frequently re-encodes far better as JPEG — but only try it when
    // the native encoding is still large, and never when the image uses alpha.
    if (file.type !== 'image/jpeg' && (!native || native.size > 1024 * 1024)) {
      if (!hasAlpha(ctx, w, h)) {
        const jpeg = await toBlob('image/jpeg');
        if (jpeg) candidates.push(jpeg);
      }
    }

    if (!candidates.length) return null;
    let best = candidates[0];
    for (const b of candidates) if (b.size < best.size) best = b;
    if (best.size >= file.size) return null; // never upload something bigger
    return new File([best], file.name || 'image', { type: best.type, lastModified: Date.now() });
  } catch (e) {
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

// ---- Emoji ----
function toggleEmojiPicker() {
  const picker = $('#emoji-picker');
  if (!picker) return;
  if (!picker.classList.contains('hidden')) { closeEmojiPicker(); return; }
  picker.innerHTML = EMOJIS.map(ch => `<button type="button" class="emoji-item">${ch}</button>`).join('');
  $all('.emoji-item', picker).forEach(btn => {
    btn.onclick = () => insertEmoji(btn.textContent);
  });
  picker.classList.remove('hidden');
}

function closeEmojiPicker() {
  $('#emoji-picker')?.classList.add('hidden');
}

function insertEmoji(ch) {
  const ta = $('#post-text');
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + ch + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + ch.length;
  ta.dispatchEvent(new Event('input')); // keeps the autogrow in sync
}

// Close the emoji picker when clicking anywhere outside it.
document.addEventListener('click', (e) => {
  const picker = $('#emoji-picker');
  if (!picker || picker.classList.contains('hidden')) return;
  if (e.target.closest('#emoji-picker') || e.target.closest('[data-tool="emoji"]')) return;
  closeEmojiPicker();
});

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
      <strong>${escapeHtml(u.username)}${verifiedBadge(u.is_verified)}</strong>
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
    // Friendship state arrives on the SAME request as the profile, so opening
    // someone's page never costs a second round-trip.
    profileFriendStatus = isSelf ? 'none' : (data.friendStatus || 'none');
    profileRequestId = data.friendRequestId || null;

    bannerEl.innerHTML = `
      <div class="banner-media">${bannerMediaHtml(user)}</div>
      ${isSelf ? '<button class="banner-edit-btn" id="edit-banner-btn" title="Edit banner">🖼 Edit Banner</button>' : ''}`;

    headerEl.innerHTML = `
      ${avatarHtml(user)}
      <div class="profile-info">
        <h2>${escapeHtml(user.username)}${verifiedBadge(user.is_verified)}</h2>
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
            : `<button class="btn ${isFollowing ? 'btn-secondary' : 'btn-primary'} follow-btn" id="follow-btn" data-following="${isFollowing ? '1' : '0'}">${isFollowing ? 'Following' : 'Follow'}</button>
               <span class="friend-slot" id="profile-friend-slot">${friendSlotHtml(data.friendStatus || 'none')}</span>`}
        </div>
      </div>`;

    if (isSelf) {
      $('#edit-profile-btn').onclick = () => renderProfileEdit(user);
      $('#edit-banner-btn').onclick = openBannerModal;
    } else {
      $('#follow-btn').onclick = toggleFollow;
      bindProfileFriendSlot();
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
    toast(e.message, 'error');
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
      <strong>${escapeHtml(u.username)}${verifiedBadge(u.is_verified)}</strong>
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
        toast(err.message, 'error');
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

// ===================== Confirmation dialog =====================
// One reusable "are you sure?" box, promise-based. Resolves true only when
// the user actually presses the confirm button.
let confirmResolve = null;

function showConfirm({ title, body, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    // A prompt raised while another is open just replaces it.
    if (confirmResolve) confirmResolve(false);
    confirmResolve = resolve;

    $('#confirm-title').textContent = title;      // textContent: no HTML parsing
    $('#confirm-body').innerHTML = body;          // caller supplies escaped text
    const ok = $('#confirm-ok');
    ok.textContent = confirmLabel;
    ok.disabled = false;
    $('#confirm-modal').classList.remove('hidden');
    ok.focus();
  });
}

function closeConfirm(result) {
  const modal = $('#confirm-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(!!result);
}

function isConfirmOpen() {
  const m = $('#confirm-modal');
  return !!m && !m.classList.contains('hidden');
}

function bindConfirmModal() {
  $('#confirm-ok').addEventListener('click', () => closeConfirm(true));
  $('#confirm-cancel').addEventListener('click', () => closeConfirm(false));
  $('#confirm-close').addEventListener('click', () => closeConfirm(false));
  // Clicking the dimmed backdrop dismisses, same as the other Frenza modals.
  $('#confirm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'confirm-modal') closeConfirm(false);
  });
}

// ===================== Settings (/settings) =====================
// The page is data-driven: every preference control declares data-setting (a
// column in user_settings) or data-flag (a boolean column), so one generic
// handler reads and writes all of them. Adding a new preference later is a
// new row of markup plus a new column — no new JS wiring.

let settingsData = null;   // { settings, account } from GET /api/settings
let settingsBound = false; // bindSettingsPage() may only ever run once
let settingsAvatarUrl = null; // object URL of a picked, not-yet-saved avatar
let themePref = 'system';  // 'light' | 'dark' | 'system'

const THEME_KEY = 'frenza.theme';

// ---------- Theme ----------
function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function storedThemePref() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch (e) { /* storage blocked (private mode) — fall back to system */ }
  return 'system';
}

// 'system' is RESOLVED here, so the DOM only ever carries "dark" or "light".
// CSS therefore needs exactly one extra rule instead of media queries, and
// the same call works for the pre-login value and the saved server value.
function applyTheme(pref) {
  themePref = pref;
  const dark = pref === 'dark' || (pref === 'system' && systemPrefersDark());
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function rememberTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* ignore */ }
  applyTheme(pref);
}

// ---------- Rendering ----------
function fillSettingsAvatar(el, account) {
  if (!el) return;
  const u = account || {};
  if (u.avatar_path) {
    el.innerHTML = `<img src="${escapeHtml(u.avatar_path)}" alt=""
      style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    el.textContent = initials(u.username);
  }
}

function clearSettingsAvatarPreview() {
  if (settingsAvatarUrl) { URL.revokeObjectURL(settingsAvatarUrl); settingsAvatarUrl = null; }
}

// Only touches the preference controls — never the text inputs — so a
// background refresh can't stomp on something the user is typing.
function syncSettingsControls(settings) {
  $all('#view-settings .segmented[data-setting]').forEach(seg => {
    const val = settings[seg.dataset.setting];
    $all('button', seg).forEach(b => b.classList.toggle('on', b.dataset.value === val));
  });
  $all('#view-settings input[data-flag]').forEach(inp => {
    inp.checked = !!settings[inp.dataset.flag];
  });
}

function renderSettings(data) {
  settingsData = data;
  const { settings, account } = data;

  // ----- Account -----
  $('#set-acc-username').textContent = '@' + account.username;
  $('#set-acc-display').textContent = account.display_name || account.username;
  $('#set-acc-email').textContent = account.email;
  try {
    $('#set-acc-since').textContent =
      new Date(String(account.created_at).replace(' ', 'T') + 'Z').toLocaleDateString();
  } catch (e) {
    $('#set-acc-since').textContent = account.created_at || '—';
  }

  // ----- Profile (form + live preview) -----
  $('#pf-display').value = account.display_name || '';
  $('#pf-username').value = account.username;
  $('#pf-bio').value = account.bio || '';
  $('#pv-name').textContent = account.display_name || account.username;
  $('#pv-handle').textContent = '@' + account.username;
  $('#pv-bio-line').textContent = account.bio || '';
  fillSettingsAvatar($('#pv-avatar'), account);
  if (!$('#pf-avatar-file').files.length) fillSettingsAvatar($('#pf-avatar-preview'), account);
  $('#pf-banner-remove').classList.toggle('hidden', !account.banner_path);

  syncSettingsControls(settings);

  // The server value wins while signed in, and is mirrored into localStorage
  // so the same appearance is waiting after a logout and back in.
  if (settings.theme) rememberTheme(settings.theme);
}

async function loadSettingsPage() {
  try {
    const data = await api.get('/api/settings');
    if (parseRoute().view !== 'settings') return; // navigated away already
    renderSettings(data);
    loadSettingsSessions();
  } catch (e) {
    if (parseRoute().view !== 'settings') return;
    toast(e.message, 'error');
  }
}

// ---------- Saving a preference ----------
// Optimistic in the UI, authoritative on the server. If the PATCH fails the
// controls are re-read from the server, so a rejected change can never be
// left displayed as if it had worked.
async function saveSettings(patch) {
  try {
    const { settings } = await api.patch('/api/settings', patch);
    if (settingsData) settingsData.settings = settings;
    syncSettingsControls(settings);
    if (patch.theme) rememberTheme(settings.theme);
    toast('Settings saved ✓');
    return settings;
  } catch (e) {
    toast(e.message, 'error');
    try {
      const fresh = await api.get('/api/settings');
      settingsData = fresh;
      syncSettingsControls(fresh.settings);
    } catch (e2) { /* keep what we had rather than blank the page */ }
    return null;
  }
}

// ---------- Sections ----------
function showSettingsSection(section) {
  $all('#settings-nav .settings-nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.section === section));
  $all('#settings-panels .settings-panel').forEach(p =>
    p.classList.toggle('active', p.dataset.panel === section));
  // Below 760px this turns the section list into a drill-down with a back
  // button; on desktop the rule is inside a media query and does nothing.
  $('#settings-layout').classList.add('drill');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- Active sessions ----------
function deviceLabel(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\//.test(s) ? 'Opera'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari'
    : /curl|node|python|axios|okhttp/i.test(s) ? 'API client'
    : 'Browser';
  const os = /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod|iOS/.test(s) ? 'iOS'
    : /Linux/.test(s) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}

async function loadSettingsSessions() {
  const box = $('#set-sessions');
  if (!box) return;
  if (!box.innerHTML.trim()) box.innerHTML = '<div class="empty-state small">Loading…</div>';
  try {
    const { sessions } = await api.get('/api/settings/sessions');
    if (!box.isConnected) return;
    if (!sessions.length) {
      box.innerHTML = '<div class="empty-state small">No active sessions.</div>';
      return;
    }
    // The raw session id is never returned by the API, so there is nothing
    // here that could be replayed as a credential.
    box.innerHTML = sessions.map(s => `
      <div class="session-row">
        <div>
          <div class="session-title">${escapeHtml(deviceLabel(s.user_agent))}
            ${s.current ? '<span class="pill-current">This device</span>' : ''}
          </div>
          <div class="session-meta">${escapeHtml(s.ip || 'unknown IP')}
            &middot; signed in ${escapeHtml(timeAgo(s.created_at))}
            &middot; last active ${escapeHtml(timeAgo(s.last_seen_at))}</div>
        </div>
        ${s.current ? '' : `<button type="button" class="btn btn-danger btn-xs" data-revoke-session="${s.id}">Revoke</button>`}
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty-state small">${escapeHtml(e.message)}</div>`;
  }
}

// ---------- Password strength ----------
// Mirrors passwordScore() in routes/settings.js, so the bar the user sees is
// the rule the server actually applies.
function settingsPasswordScore(pw) {
  const s = String(pw || '');
  if (!s) return 0;
  let score = 0;
  if (s.length >= 8) score += 2;
  if (s.length >= 12) score += 1;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score += 1;
  if (/\d/.test(s)) score += 1;
  if (/[^\w\s]/.test(s)) score += 1;
  return score;
}

function updatePasswordMeter() {
  const pw = $('#set-new-pw').value;
  const score = settingsPasswordScore(pw);
  const level = !pw ? '' : score <= 2 ? 'weak' : score <= 4 ? 'mid' : 'strong';
  const bars = level === 'strong' ? 3 : level === 'mid' ? 2 : level === 'weak' ? 1 : 0;
  ['#pw-b1', '#pw-b2', '#pw-b3'].forEach((sel, i) => {
    const el = $(sel);
    if (el) el.className = 'pw-bar' + (i < bars ? ` on ${level}` : '');
  });
  const w = $('#pw-word');
  const word = level === 'strong' ? 'Strong' : level === 'mid' ? 'Medium' : level === 'weak' ? 'Weak' : 'Password strength';
  w.className = 'pw-word' + (level ? ` ${level}` : '');
  w.textContent = word;
}

// ---------- Ending a session locally (deactivate / delete) ----------
// Same clean-up as the Logout button, minus the server call: those endpoints
// have already destroyed the session by the time we get here.
function endSessionLocally() {
  currentUser = null;
  viewedProfileId = null;
  profileLoadToken++;  // drop any profile request still in flight
  chatLoadToken++;     // ...and any chat thread request
  if (socket) { socket.disconnect(); socket = null; }
  onlineUsers.clear();
  unreadMsgTotal = 0;
  renderUnreadBadge();
  settingsData = null;
  clearSettingsAvatarPreview();
  $('#login-form').reset();
  if (window.location.pathname !== '/') history.replaceState(null, '', '/');
  showAuth();
}

// ---------- Delete-account dialog ----------
function openDeleteModal() {
  $('#delete-form').reset();
  $('#delete-error').textContent = '';
  const ok = $('#delete-ok');
  ok.disabled = true;
  ok.textContent = 'Delete Account';
  $('#delete-modal').classList.remove('hidden');
  $('#delete-pw').focus();
}

function closeDeleteModal() {
  const m = $('#delete-modal');
  if (m) m.classList.add('hidden');
}

function isDeleteOpen() {
  const m = $('#delete-modal');
  return !!m && !m.classList.contains('hidden');
}

// The button stays disabled until BOTH proofs are present, so the endpoint
// can never be reached by a single careless click.
function syncDeleteButton() {
  const pw = $('#delete-pw').value;
  const typed = $('#delete-confirm').value.trim();
  $('#delete-ok').disabled = !(pw && typed === 'DELETE');
}

// ---------- Bindings (run exactly once, from init) ----------
function bindSettingsPage() {
  if (settingsBound) return;
  settingsBound = true;

  // ----- Section navigation -----
  $all('#settings-nav .settings-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showSettingsSection(btn.dataset.section));
  });
  $('#settings-back').addEventListener('click', () => {
    $('#settings-layout').classList.remove('drill');
  });
  // There is ONE username editor (Profile) and ONE password form (Account);
  // the other sections link to them instead of duplicating the fields.
  $('#set-goto-profile').addEventListener('click', () => {
    showSettingsSection('profile');
    $('#pf-username').focus();
  });
  $('#set-goto-pw').addEventListener('click', () => {
    showSettingsSection('account');
    $('#set-current-pw').focus();
  });

  // ----- Generic preference controls: segmented + switches -----
  $all('#view-settings .segmented[data-setting]').forEach(seg => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      // Apply the theme immediately so the tap feels instant; the PATCH
      // response re-syncs it and the error path rolls it back.
      if (seg.dataset.setting === 'theme') rememberTheme(btn.dataset.value);
      saveSettings({ [seg.dataset.setting]: btn.dataset.value });
    });
  });
  $all('#view-settings input[data-flag]').forEach(inp => {
    inp.addEventListener('change', () => {
      saveSettings({ [inp.dataset.flag]: inp.checked });
    });
  });

  // ----- Notification sounds -----
  // Deliberately NOT a data-flag: sounds are a device preference (this machine
  // has speakers, the phone doesn't), so they live in localStorage and are
  // never sent to the server. Turning it on pings immediately so the switch
  // proves itself; turning it off is silent.
  const soundToggle = $('#sound-toggle');
  if (soundToggle) {
    soundToggle.checked = window.sfx ? sfx.enabled : false;
    soundToggle.addEventListener('change', () => {
      if (window.sfx) sfx.setEnabled(soundToggle.checked);
      toast(soundToggle.checked ? 'Notification sounds on.' : 'Notification sounds off.');
    });
  }

  // ----- Change password -----
  $('#set-new-pw').addEventListener('input', updatePasswordMeter);
  $('#set-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#set-pw-error');
    err.textContent = '';

    const current = $('#set-current-pw').value;
    const next = $('#set-new-pw').value;
    const confirmPw = $('#set-confirm-pw').value;

    // Client-side checks mirror the server exactly — they exist to save a
    // round trip, never to be the only thing standing in the way.
    if (!current) { err.textContent = 'Enter your current password.'; return; }
    if (next.length < 8) { err.textContent = 'New password must be at least 8 characters long.'; return; }
    if (next === current) { err.textContent = 'New password must be different from your current password.'; return; }
    if (next !== confirmPw) { err.textContent = 'New password and confirmation do not match.'; return; }

    const btn = $('#set-pw-submit');
    btn.disabled = true;
    btn.textContent = 'Changing…';
    try {
      const data = await api.post('/api/settings/change-password', {
        currentPassword: current, newPassword: next, confirmPassword: confirmPw
      });
      $('#set-pw-form').reset();
      updatePasswordMeter();
      toast(data.message || 'Password changed successfully ✓');
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Change Password';
    }
  });

  // ----- Change email -----
  $('#set-email-open').addEventListener('click', () => {
    const form = $('#set-email-form');
    form.classList.remove('hidden');
    $('#set-email-error').textContent = '';
    $('#set-email-input').value = (settingsData && settingsData.account && settingsData.account.email) || '';
    $('#set-email-pw').value = '';
    $('#set-email-input').focus();
  });
  $('#set-email-cancel').addEventListener('click', () => {
    $('#set-email-form').classList.add('hidden');
  });
  $('#set-email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#set-email-error');
    err.textContent = '';
    const email = $('#set-email-input').value.trim();
    const password = $('#set-email-pw').value;
    if (!email) { err.textContent = 'Enter your new email address.'; return; }
    if (!password) { err.textContent = 'Enter your password to confirm this change.'; return; }
    try {
      const data = await api.post('/api/settings/change-email', { email, password });
      $('#set-email-form').classList.add('hidden');
      toast(data.message || 'Email updated ✓');
      await loadSettingsPage();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  // ----- Profile (display name, username, bio, avatar, banner) -----
  // Reuses PUT /api/auth/profile and the existing banner endpoints — there
  // is no second profile-editing path to keep in sync.
  $('#pf-avatar-file').addEventListener('change', () => {
    const f = $('#pf-avatar-file').files[0];
    clearSettingsAvatarPreview();
    const el = $('#pf-avatar-preview');
    if (!f) { fillSettingsAvatar(el, (settingsData && settingsData.account) || currentUser); return; }
    settingsAvatarUrl = URL.createObjectURL(f);
    el.innerHTML = `<img src="${settingsAvatarUrl}" alt=""
      style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  });

  $('#pf-banner-file').addEventListener('change', async () => {
    const f = $('#pf-banner-file').files[0];
    if (!f) return;
    const err = $('#set-profile-error');
    err.textContent = '';
    if (!BANNER_MIME_TYPES.includes(f.type)) {
      err.textContent = 'Banner must be a JPG, PNG or WEBP image.';
      $('#pf-banner-file').value = '';
      return;
    }
    if (f.size > BANNER_MAX_BYTES) {
      err.textContent = 'Banner is too large. Maximum size is 8MB.';
      $('#pf-banner-file').value = '';
      return;
    }
    const fd = new FormData();
    fd.append('banner', f);
    try {
      await api.postForm(`/api/users/${currentUser.id}/banner`, fd);
      $('#pf-banner-file').value = '';
      toast('Settings saved ✓');
      await loadSettingsPage();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  $('#pf-banner-remove').addEventListener('click', async () => {
    const err = $('#set-profile-error');
    err.textContent = '';
    try {
      await api.del(`/api/users/${currentUser.id}/banner`);
      toast('Banner removed.');
      await loadSettingsPage();
    } catch (ex) {
      // Already gone on the server: treat as success rather than an error.
      if (ex.status === 404) { await loadSettingsPage(); return; }
      err.textContent = ex.message;
    }
  });

  $('#set-profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#set-profile-error');
    err.textContent = '';

    const username = $('#pf-username').value.trim();
    if (!/^[A-Za-z0-9._]{3,20}$/.test(username)) {
      err.textContent = 'Username must be 3–20 characters using letters, numbers, underscore or period.';
      return;
    }

    const fd = new FormData();
    fd.append('username', username);
    fd.append('display_name', $('#pf-display').value.trim());
    fd.append('bio', $('#pf-bio').value);
    const file = $('#pf-avatar-file').files[0];
    if (file) fd.append('avatar', file);

    const btn = $('#pf-submit');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const { user } = await api.put('/api/auth/profile', fd, true);
      currentUser = user;            // the viewer's own row changed
      $('#pf-avatar-file').value = ''; // already uploaded — never resend it
      clearSettingsAvatarPreview();
      toast('Settings saved ✓');
      await loadSettingsPage();       // refresh previews + account summary
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  });

  // ----- Sessions -----
  $('#set-sessions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revoke-session]');
    if (!btn) return;
    const id = btn.dataset.revokeSession;
    btn.disabled = true;
    try {
      await api.del(`/api/settings/sessions/${id}`);
      toast('Device signed out.');
      loadSettingsSessions();
    } catch (ex) {
      btn.disabled = false;
      toast(ex.message, 'error');
    }
  });

  $('#set-logout-others').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Log out of all other devices?',
      body: 'Every other signed-in device will be signed out immediately. This device stays signed in.',
      confirmLabel: 'Log out of all other devices'
    });
    if (!ok) return;
    try {
      const data = await api.post('/api/settings/logout-other-devices', {});
      toast(data.message || 'Done.');
      loadSettingsSessions();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // ----- Deactivate (reversible) -----
  $('#set-deactivate').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Deactivate your account?',
      body: 'Your profile is hidden and you are signed out. Nothing is deleted — log back in at any time to reactivate everything exactly as it was.',
      confirmLabel: 'Deactivate'
    });
    if (!ok) return;
    try {
      const data = await api.post('/api/settings/deactivate', {});
      toast(data.message || 'Account deactivated.');
      endSessionLocally();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // ----- Delete (permanent, never one click) -----
  $('#set-delete').addEventListener('click', openDeleteModal);
  $('#delete-close').addEventListener('click', closeDeleteModal);
  $('#delete-cancel').addEventListener('click', closeDeleteModal);
  $('#delete-modal').addEventListener('click', (e) => {
    if (e.target.id === 'delete-modal') closeDeleteModal();
  });
  $('#delete-pw').addEventListener('input', syncDeleteButton);
  $('#delete-confirm').addEventListener('input', syncDeleteButton);

  $('#delete-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#delete-error');
    err.textContent = '';
    const password = $('#delete-pw').value;
    const confirmText = $('#delete-confirm').value.trim();

    if (confirmText !== 'DELETE') {
      err.textContent = 'Type DELETE to confirm you want to permanently delete this account.';
      return;
    }
    if (!password) { err.textContent = 'Enter your password to confirm.'; return; }

    const btn = $('#delete-ok');
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const data = await api.del('/api/settings/account', { password, confirm: confirmText });
      closeDeleteModal();
      toast(data.message || 'Your account has been deleted.');
      endSessionLocally();
    } catch (ex) {
      err.textContent = ex.message;
      syncDeleteButton();
    }
  });
}


// ===================== Friend system =====================
// Friendship state. Separate from followers: this is a mutual, two-sided
// relationship with its own request lifecycle.
function friendSlotHtml(status) {
  switch (status) {
    case 'friends':
      return '<button class="btn btn-secondary btn-xs" data-friend-action="unfriend" title="Remove friend">Friends ✓</button>'
           + '<button class="btn btn-ghost btn-xs" data-friend-action="message">Message</button>';
    case 'sent':
      return '<span class="req-sent">Request Sent</span>'
           + '<button class="btn btn-ghost btn-xs" data-friend-action="cancel">Cancel</button>';
    case 'received':
      return '<button class="btn btn-primary btn-xs" data-friend-action="accept">Accept Request</button>'
           + '<button class="btn btn-ghost btn-xs" data-friend-action="reject">Reject</button>';
    default:
      return '<button class="btn btn-primary btn-xs" data-friend-action="send">Add Friend</button>';
  }
}

// Re-renders the profile's friendship controls. Delegation lives on the slot
// itself, so re-rendering the buttons never needs a re-bind.
// `requestId` is optional: 'none' always means "no pending request row", so a
// stale id is cleared rather than left behind to produce "/requests/null".
function setProfileFriendButton(status, requestId) {
  profileFriendStatus = status;
  profileRequestId = (status === 'none') ? null
    : (requestId !== undefined ? requestId : profileRequestId);
  const slot = $('#profile-friend-slot');
  if (slot) slot.innerHTML = friendSlotHtml(status);
}

// Re-reads the real relationship from the server and repaints the button.
// Used after ANY failed action so the UI can never stay stuck on "Friends ✓"
// when the database says otherwise.
async function syncProfileFriendState(userId) {
  try {
    const st = await api.get(`/api/friends/status/${userId}`);
    profileRequestId = st.requestId || null;
    if (viewedProfileId === userId) setProfileFriendButton(st.status, st.requestId);
    return st;
  } catch (e) {
    return null; // profile gone / offline — caller already toasted the error
  }
}

// accept/reject/cancel need the request ROW id. If we somehow don't have one,
// ask the server instead of firing a request at "/requests/null".
async function resolveRequestId(userId) {
  if (profileRequestId) return profileRequestId;
  const st = await syncProfileFriendState(userId);
  return (st && st.requestId) || null;
}

let profileFriendBusy = false;

// Timestamp of an unfriend WE started, so the server's own echo doesn't
// immediately re-fetch a list we just updated by hand.
let lastSelfUnfriendAt = 0;

function bindProfileFriendSlot() {
  const slot = $('#profile-friend-slot');
  if (!slot) return;
  slot.onclick = async (e) => {
    const btn = e.target.closest('[data-friend-action]');
    if (!btn || profileFriendBusy) return;
    // The target ALWAYS comes from the profile being viewed (URL /profile/:id),
    // never from the logged-in user's id.
    const targetId = viewedProfileId;
    if (!targetId || !currentUser || targetId === currentUser.id) return;

    const action = btn.dataset.friendAction;
    if (action === 'message') {
      profileFriendBusy = true;
      try { await openPrivateChat(targetId); }
      catch (err) { toast(err.message, 'error'); }
      finally { profileFriendBusy = false; }
      return;
    }

    // Destructive action: confirm BEFORE touching any state.
    if (action === 'unfriend') {
      const name = (viewedProfileUser && viewedProfileUser.username) || 'this user';
      const ok = await showConfirm({
        title: `Unfriend ${name}?`,
        body: 'You will need to send a new friend request if you want to become friends again.',
        confirmLabel: 'Unfriend'
      });
      if (!ok) return;
      // Profile may have changed while the dialog was open.
      if (viewedProfileId !== targetId) return;
    }

    profileFriendBusy = true;
    btn.disabled = true;
    try {
      let requestId = profileRequestId;
      if ((action === 'accept' || action === 'reject' || action === 'cancel')) {
        requestId = await resolveRequestId(targetId);
        if (!requestId) {
          // Server says there is no request — show the truth, not an error.
          await syncProfileFriendState(targetId);
          toast('That friend request no longer exists.');
          loadFriendRequests();
          return;
        }
      }

      if (action === 'unfriend') lastSelfUnfriendAt = Date.now();
      const status = await friendAction(action, targetId, requestId);
      if (viewedProfileId === targetId) setProfileFriendButton(status);
      if (action === 'send') toast('Friend request sent ✓');
      else if (action === 'cancel') toast('Friend request cancelled.');
      else if (action === 'accept') toast('You are now friends!');
      else if (action === 'reject') toast('Request rejected.');
      else if (action === 'unfriend') toast('Friend removed.');
      // Keep the bell/list in step with what just happened.
      loadFriendRequests();
      if (parseRoute().view === 'friends') loadFriendsPage();
    } catch (err) {
      toast(err.message, 'error');
      // Restore the true state from the server — a 404 "not friends" or a
      // network failure must never leave a stale button behind.
      await syncProfileFriendState(targetId);
      loadFriendRequests();
      if (parseRoute().view === 'friends') loadFriendsPage();
    } finally {
      profileFriendBusy = false;
      const cur = $('#profile-friend-slot [data-friend-action]');
      if (cur) cur.disabled = false;
    }
  };
}

// Runs ONE friendship action and resolves to the resulting status.
// accept/reject/cancel address the request ROW, so they need its id.
async function friendAction(action, userId, requestId) {
  switch (action) {
    case 'send':   return (await api.post('/api/friends/requests', { receiverId: userId })).status;
    case 'accept': return (await api.post(`/api/friends/requests/${requestId}/accept`, {})).status;
    case 'reject': return (await api.post(`/api/friends/requests/${requestId}/reject`, {})).status;
    case 'cancel': return (await api.del(`/api/friends/requests/${requestId}`)).status;
    case 'unfriend': return (await api.del(`/api/friends/${userId}`)).status;
    default: throw new Error('Unknown friend action.');
  }
}

// ===================== Notifications =====================
function renderNotifBadge() {
  const badge = $('#notif-badge');
  if (!badge) return;
  const n = friendRequests.incoming.length;
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.classList.toggle('hidden', n === 0);
}

function renderNotifPanel() {
  const list = $('#notif-list');
  if (!list) return;
  if (!friendRequests.incoming.length) {
    list.innerHTML = '<div class="empty-state small">No new notifications.</div>';
    return;
  }
  list.innerHTML = friendRequests.incoming.map(r => `
    <div class="notif-item" data-request-id="${r.id}">
      <div class="notif-top">
        <a class="post-avatar-link" href="/profile/${r.user.id}" data-profile-id="${r.user.id}">${avatarHtml(r.user, 'sm')}</a>
        <div class="notif-text"><b>${escapeHtml(r.user.username)}${verifiedBadge(r.user.is_verified)}</b> sent you a friend request.</div>
      </div>
      <div class="notif-actions">
        <button class="btn btn-primary" data-notif-action="accept">Accept</button>
        <button class="btn btn-secondary" data-notif-action="reject">Reject</button>
      </div>
    </div>`).join('');
  bindProfileLinks(list);
}

function openNotifPanel() {
  $('#notif-panel').classList.remove('hidden');
  $('#notif-btn').setAttribute('aria-expanded', 'true');
}
function closeNotifPanel() {
  const p = $('#notif-panel');
  if (p) p.classList.add('hidden');
  const b = $('#notif-btn');
  if (b) b.setAttribute('aria-expanded', 'false');
}

function bindNotifPanel() {
  $('#notif-btn').onclick = (e) => {
    e.stopPropagation();
    const panel = $('#notif-panel');
    if (panel.classList.contains('hidden')) { renderNotifPanel(); openNotifPanel(); }
    else closeNotifPanel();
  };

  // Accept / Reject directly from the notification — no page reload.
  $('#notif-list').onclick = async (e) => {
    e.stopPropagation();
    const btn = e.target.closest('[data-notif-action]');
    if (!btn) return;
    const wrap = btn.closest('[data-request-id]');
    const reqId = Number(wrap && wrap.dataset.requestId);
    if (!reqId) return;
    const action = btn.dataset.notifAction;
    btn.disabled = true;
    try {
      await api.post(`/api/friends/requests/${reqId}/${action}`, {});
      friendRequests.incoming = friendRequests.incoming.filter(r => r.id !== reqId);
      renderNotifBadge();
      renderNotifPanel();
      toast(action === 'accept' ? 'You are now friends!' : 'Request rejected.');
      if (parseRoute().view === 'friends') loadFriendsPage();
      if (action === 'accept' && viewedProfileId) {
        // If that person's profile is open, its button flips to Friends ✓.
        api.get(`/api/friends/status/${viewedProfileId}`)
          .then(d => setProfileFriendButton(d.status))
          .catch(() => {});
      }
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      loadFriendRequests();
    }
  };

  // Clicking anywhere else closes the panel.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#notif-panel') && !e.target.closest('#notif-btn')) closeNotifPanel();
  });
}

// One request refreshes the badge, the panel and (if open) the friends page.
async function loadFriendRequests() {
  if (!currentUser) return;
  try {
    const data = await api.get('/api/friends/requests');
    friendRequests = { incoming: data.incoming || [], outgoing: data.outgoing || [] };
    renderNotifBadge();
    renderNotifPanel();
    if (parseRoute().view === 'friends') renderFriendRequests();
  } catch (e) { /* session expired or offline — nothing to show */ }
}

function dropIncomingByUser(uid) {
  friendRequests.incoming = friendRequests.incoming.filter(r => r.user.id !== uid);
}
function dropIncomingById(id) {
  friendRequests.incoming = friendRequests.incoming.filter(r => r.id !== id);
}
function dropOutgoingByUser(uid) {
  friendRequests.outgoing = friendRequests.outgoing.filter(r => r.user.id !== uid);
}

// All friend socket events funnel through here. Each one only touches the
// piece of UI it describes.
function handleFriendEvent(kind, payload) {
  const p = payload || {};
  const other = p.from || p.by || p.user || null;
  const otherId = other ? other.id : null;

  if (kind === 'friend_request' && p.from && p.request) {
    dropIncomingByUser(p.from.id);
    friendRequests.incoming.unshift({ id: p.request.id, sent_at: p.request.sent_at, user: p.from });
    renderNotifBadge();
    renderNotifPanel();
    toast(`${p.from.username} sent you a friend request.`, 'social');
  }

  if (kind === 'friend_request_accepted') {
    dropIncomingByUser(otherId);
    dropOutgoingByUser(otherId);
    renderNotifBadge();
    renderNotifPanel();
    toast(other ? `${other.username} accepted your friend request!` : 'You are now friends!', 'social');
    if (otherId && viewedProfileId === otherId) setProfileFriendButton('friends');
  }

  if (kind === 'friend_request_rejected') {
    dropOutgoingByUser(otherId);
    renderNotifBadge();
    renderNotifPanel();
    if (otherId && viewedProfileId === otherId) setProfileFriendButton('none');
  }

  if (kind === 'friend_request_cancelled') {
    dropIncomingById(p.request && p.request.id);
    dropIncomingByUser(otherId);
    renderNotifBadge();
    renderNotifPanel();
    toast(other ? `${other.username} cancelled their friend request.` : 'A friend request was cancelled.', 'social');
    if (otherId && viewedProfileId === otherId) setProfileFriendButton('none');
  }

  if (kind === 'friend_removed') {
    dropIncomingByUser(otherId);
    dropOutgoingByUser(otherId);
    renderNotifBadge();
    renderNotifPanel();
    // actorId = whoever performed the unfriend. If that's us (or another of
    // our tabs) we already toasted from the click — don't double up.
    const byMe = p.actorId != null && currentUser && p.actorId === currentUser.id;
    if (!byMe) toast(other ? `${other.username} removed you from their friends.` : 'Friend removed.', 'social');
    // 'none' clears profileRequestId too, so a later click can't send a
    // stale id to /requests/:id.
    if (otherId && viewedProfileId === otherId) setProfileFriendButton('none');
  }

  // Refreshing the friends page is how a removal made by the OTHER user gets
  // reflected. If we just made it ourselves the card is already gone, so the
  // echo would only produce a pointless spinner.
  const justDidIt = kind === 'friend_removed' && Date.now() - lastSelfUnfriendAt < 2500;
  if (parseRoute().view === 'friends' && !justDidIt) loadFriendsPage();
}

// ===================== Friends page =====================
let friendsCache = [];
let friendsTotal = 0;   // total friends, independent of any active search

async function loadFriendsPage() {
  const listEl = $('#friends-list');
  if (!listEl) return;
  const q = friendSearchQuery.trim();
  listEl.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

  try {
    // Two small requests, run together. The friend list can only ever return
    // MY friends — it is not a way to enumerate users.
    const [reqs, data] = await Promise.all([
      api.get('/api/friends/requests'),
      api.get(`/api/friends${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    ]);
    friendRequests = { incoming: reqs.incoming || [], outgoing: reqs.outgoing || [] };
    renderNotifBadge();
    renderNotifPanel();
    renderFriendRequests();

    friendsTotal = data.total || 0;
    renderFriendsCount();

    friendsCache = data.friends || [];
    renderFriendsList(friendsCache, q);
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
}

// The pill always shows the TOTAL friend count, never the filtered one.
function renderFriendsCount() {
  const pill = $('#friends-count');
  if (pill) pill.textContent = `${friendsTotal} friend${friendsTotal === 1 ? '' : 's'}`;
}

function renderFriendRequests() {
  const inc = $('#incoming-list');
  const out = $('#outgoing-list');
  if (!inc || !out) return;

  const incoming = friendRequests.incoming;
  const outgoing = friendRequests.outgoing;

  $('#incoming-block').classList.toggle('hidden', !incoming.length);
  $('#outgoing-block').classList.toggle('hidden', !outgoing.length);
  $('#friend-requests').classList.toggle('hidden', !incoming.length && !outgoing.length);

  inc.innerHTML = incoming.map(r => `
    <div class="user-row req-user-row" data-request-id="${r.id}">
      <a class="post-avatar-link" href="/profile/${r.user.id}" data-profile-id="${r.user.id}">${avatarHtml(r.user, 'sm')}</a>
      <div class="user-meta">
        <a href="/profile/${r.user.id}" data-profile-id="${r.user.id}"><strong>${escapeHtml(r.user.username)}</strong></a>
        <span class="user-bio">${escapeHtml(r.user.bio || '')}</span>
      </div>
      <div class="friend-row-actions">
        <button class="btn btn-primary" data-req-action="accept">Accept</button>
        <button class="btn btn-secondary" data-req-action="reject">Reject</button>
      </div>
    </div>`).join('');

  out.innerHTML = outgoing.map(r => `
    <div class="user-row req-user-row" data-request-id="${r.id}">
      <a class="post-avatar-link" href="/profile/${r.user.id}" data-profile-id="${r.user.id}">${avatarHtml(r.user, 'sm')}</a>
      <div class="user-meta">
        <a href="/profile/${r.user.id}" data-profile-id="${r.user.id}"><strong>${escapeHtml(r.user.username)}</strong></a>
        <span class="user-bio">${escapeHtml(r.user.bio || '')}</span>
      </div>
      <div class="friend-row-actions">
        <span class="req-sent">Request Sent</span>
        <button class="btn btn-secondary" data-req-action="cancel">Cancel</button>
      </div>
    </div>`).join('');

  bindProfileLinks(inc);
  bindProfileLinks(out);
}

function friendCardHtml(f) {
  const online = onlineUsers.has(f.id);
  return `
    <div class="friend-card" data-user-id="${f.id}">
      <a class="post-avatar-link" href="/profile/${f.id}" data-profile-id="${f.id}">${avatarHtml(f)}</a>
      <div class="friend-name">${escapeHtml(f.username)}${verifiedBadge(f.is_verified)}</div>
      <div class="friend-handle">${escapeHtml(f.bio || `@${f.username}`)}</div>
      <div class="friend-status"><span class="dot ${online ? 'on' : ''}"></span>${online ? 'Online' : 'Last seen recently'}</div>
      <div class="friend-actions">
        <button class="btn btn-primary btn-xs" data-chat-with="${f.id}">Message</button>
        <a class="btn btn-secondary btn-xs" href="/profile/${f.id}" data-profile-id="${f.id}">Profile</a>
        <button class="btn btn-danger btn-xs" data-unfriend="${f.id}">Unfriend</button>
      </div>
    </div>`;
}

function renderFriendsList(list, q) {
  const el = $('#friends-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">${
      q ? `No friends match &ldquo;${escapeHtml(q)}&rdquo;.`
        : 'You have not added any friends yet. Open someone\'s profile and hit Add Friend.'
    }</div>`;
    return;
  }
  el.innerHTML = list.map(friendCardHtml).join('');
  bindProfileLinks(el);
}

function bindFriendsPage() {
  // Search: filter as you type, debounced, against the server.
  const box = $('#friend-search');
  if (box) {
    box.addEventListener('input', () => {
      clearTimeout(friendSearchDebounce);
      friendSearchDebounce = setTimeout(() => {
        friendSearchQuery = box.value.slice(0, 60);
        loadFriendsPage();
      }, 250);
    });
  }

  // Accept / Reject / Cancel from the request blocks.
  const reqRoot = $('#friend-requests');
  if (reqRoot) {
    reqRoot.onclick = async (e) => {
      const btn = e.target.closest('[data-req-action]');
      if (!btn) return;
      const wrap = btn.closest('[data-request-id]');
      const reqId = Number(wrap && wrap.dataset.requestId);
      if (!reqId) return;
      const action = btn.dataset.reqAction;
      btn.disabled = true;
      try {
        if (action === 'cancel') await api.del(`/api/friends/requests/${reqId}`);
        else await api.post(`/api/friends/requests/${reqId}/${action}`, {});

        friendRequests.incoming = friendRequests.incoming.filter(r => r.id !== reqId);
        friendRequests.outgoing = friendRequests.outgoing.filter(r => r.id !== reqId);

        toast(action === 'accept' ? 'You are now friends!'
            : action === 'reject' ? 'Request rejected.'
            : 'Friend request cancelled.');
        renderNotifBadge();
        renderNotifPanel();
        loadFriendsPage();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        loadFriendRequests();
      }
    };
  }

  // Message / Unfriend buttons on a friend card.
  const grid = $('#friends-list');
  if (grid) {
    grid.onclick = async (e) => {
      const msgBtn = e.target.closest('[data-chat-with]');
      if (msgBtn) {
        msgBtn.disabled = true;
        try { await openPrivateChat(Number(msgBtn.dataset.chatWith)); }
        catch (err) { toast(err.message, 'error'); }
        finally { msgBtn.disabled = false; }
        return;
      }

      const ufBtn = e.target.closest('[data-unfriend]');
      if (!ufBtn || ufBtn.disabled) return;
      const uid = Number(ufBtn.dataset.unfriend);
      if (!uid) return;
      const friend = friendsCache.find(x => x.id === uid);
      const name = (friend && friend.username) || 'this friend';

      const ok = await showConfirm({
        title: `Unfriend ${name}?`,
        body: 'You will need to send a new friend request if you want to become friends again.',
        confirmLabel: 'Unfriend'
      });
      if (!ok) return;

      ufBtn.disabled = true;
      try {
        lastSelfUnfriendAt = Date.now();
        await api.del(`/api/friends/${uid}`);
        // Drop the card immediately — no reload, no round-trip needed.
        const card = grid.querySelector(`.friend-card[data-user-id="${uid}"]`);
        if (card) card.remove();
        friendsCache = friendsCache.filter(x => x.id !== uid);
        friendsTotal = Math.max(0, friendsTotal - 1);
        renderFriendsCount();
        // Last card gone while a search is active → show the empty message.
        if (!grid.querySelector('.friend-card')) renderFriendsList(friendsCache, friendSearchQuery.trim());
        // If that person's profile happens to be open, flip it too.
        if (viewedProfileId === uid) setProfileFriendButton('none');
        toast('Friend removed.');
        loadFriendRequests();
      } catch (err) {
        toast(err.message, 'error');
        // Server is the source of truth — re-pull the list.
        loadFriendsPage();
      }
    };
  }
}

let friendSearchDebounce = null;
let friendSearchQuery = '';

// ===================== Chats =====================
function chatTitle(conv) {
  if (!conv) return 'Conversation';
  if (conv.type === 'group') return conv.name || 'Group chat';
  if (conv.other_user) return conv.other_user.username;
  return 'Conversation';
}

function chatAvatarUser(conv) {
  if (!conv) return { username: '?' };
  if (conv.type === 'group') return { username: conv.name || 'Group', avatar_path: conv.avatar_path };
  return conv.other_user || { username: '?' };
}

function isNearBottom(el, threshold = 140) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function scrollThreadToBottom() {
  const box = $('#thread-msgs');
  if (box) box.scrollTop = box.scrollHeight;
}

function msgStamp(sqliteDate) {
  const d = new Date(String(sqliteDate).replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isSameDay(a, b) {
  return String(a).slice(0, 10) === String(b).slice(0, 10);
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// One message row. Consecutive messages from the same sender within 5 minutes
// are grouped so a conversation reads like a conversation, not a list.
function messageHtml(msg, prev, showSender) {
  const mine = !!(currentUser && msg.sender_id === currentUser.id);
  const prevOk = prev && prev.sender_id === msg.sender_id && isSameDay(prev.created_at, msg.created_at);
  const t1 = new Date(String(msg.created_at).replace(' ', 'T') + 'Z').getTime();
  const t0 = prevOk ? new Date(String(prev.created_at).replace(' ', 'T') + 'Z').getTime() : 0;
  const grouped = prevOk && (t1 - t0) < 5 * 60 * 1000;
  const showDay = !prev || !isSameDay(prev.created_at, msg.created_at);

  const sender = msg.sender || { id: msg.sender_id, username: '' };
  // Already-known-read messages carry the tick AND the marker, so the
  // message_read handler never appends a second one.
  const alreadyRead = mine && msg.id <= privateReadCursor;
  const readMark = alreadyRead ? ' \u2713\u2713' : '';

  return `${showDay ? `<div class="msg-divider">${escapeHtml(String(msg.created_at).slice(0, 10))}</div>` : ''}
    <div class="msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}"
         data-msg-id="${msg.id}" data-mine="${mine ? 1 : 0}">
      ${mine ? '' : `<a class="post-avatar-link" href="/profile/${sender.id}" data-profile-id="${sender.id}">${avatarHtml(sender)}</a>`}
      <div class="msg-body">
        ${!mine && showSender && !grouped ? `<div class="msg-sender">${escapeHtml(sender.username)}</div>` : ''}
        <div class="msg-bubble">${escapeHtml(msg.content)}</div>
        <div class="msg-time"${alreadyRead ? ' data-read="1"' : ''}>${msgStamp(msg.created_at)}${readMark}</div>
      </div>
    </div>`;
}

function renderThreadMessages() {
  const box = $('#thread-msgs');
  if (!box) return;
  const isGroup = activeConv && activeConv.type === 'group';
  const html = (chatHasMore ? '<button type="button" class="load-older" id="load-older-btn">Load earlier messages</button>' : '')
    + chatMessages.map((m, i) => messageHtml(m, chatMessages[i - 1], isGroup)).join('');
  box.innerHTML = html || '<div class="empty-state">Say hello 👋</div>';
}

function appendMessageToThread(msg) {
  const box = $('#thread-msgs');
  if (!box) return;
  const near = isNearBottom(box);
  const empty = $('.empty-state', box);
  if (empty) empty.remove();
  box.insertAdjacentHTML('beforeend',
    messageHtml(msg, chatMessages[chatMessages.length - 2], activeConv && activeConv.type === 'group'));
  if (near) scrollThreadToBottom();
}

// Updates my own conversation list entry after a send (or an incoming echo).
function upsertChatPreview(convId, message) {
  const idx = chatList.findIndex(c => c.id === convId);
  if (idx < 0) return;
  const [conv] = chatList.splice(idx, 1);
  conv.last_message = message;
  conv.updated_at = message.created_at;
  chatList.unshift(conv);
}

function renderChatList() {
  const el = $('#chat-list');
  if (!el) return;
  const q = chatSearchQuery.trim().toLowerCase();
  const items = q
    ? chatList.filter(c => chatTitle(c).toLowerCase().includes(q))
    : chatList;

  if (!items.length) {
    el.innerHTML = `<div class="empty-state small">${
      chatList.length ? 'No chats match your search.'
        : 'No chats yet. Open a friend and press Message, or create a group.'
    }</div>`;
    return;
  }

  el.innerHTML = items.map(c => {
    const av = chatAvatarUser(c);
    const online = c.type === 'private' && c.other_user && onlineUsers.has(c.other_user.id);
    const last = c.last_message;
    const preview = last
      ? `${last.sender_id === (currentUser && currentUser.id) ? 'You: ' : (c.type === 'group' && last.sender_name ? last.sender_name + ': ' : '')}${last.content}`
      : 'No messages yet';
    return `
      <button type="button" class="chat-item ${c.id === activeChatId ? 'active' : ''}" data-conv-id="${c.id}">
        ${avatarHtml(av)}
        <span class="chat-item-body">
          <span class="chat-item-top">
            <span class="chat-item-name">${escapeHtml(chatTitle(c))}${c.type === 'private' && c.other_user ? verifiedBadge(c.other_user.is_verified) : ''}</span>
            ${c.type === 'private' ? `<span class="dot ${online ? 'on' : ''}" title="${online ? 'Online' : 'Offline'}"></span>` : ''}
            <span class="chat-item-time">${last ? timeAgo(last.created_at) : ''}</span>
          </span>
          <span class="chat-item-last">${escapeHtml(preview)}</span>
        </span>
        ${c.unread ? `<span class="chat-item-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
      </button>`;
  }).join('');
}

// ---------- Unread badge (Chats/Messages nav item) ----------
// One number, two places: the desktop top bar and the mobile bottom bar both
// carry <span data-unread-badge>, so a single render updates them together.
// Hidden at zero, capped at 99+.
function renderUnreadBadge() {
  const n = Math.max(0, unreadMsgTotal);
  $all('[data-unread-badge]').forEach(el => {
    el.classList.toggle('hidden', n === 0);
    el.textContent = n > 99 ? '99+' : String(n);
  });
}

// Server-authoritative sync: page load, login, or anything we cannot compute
// locally. GET /api/chats already returns `unreadTotal` for MY account only.
async function syncUnreadBadge() {
  if (!currentUser) { unreadMsgTotal = 0; renderUnreadBadge(); return; }
  try {
    const data = await api.get('/api/chats');
    unreadMsgTotal = Number(data.unreadTotal) || 0;
    if (chatListLoaded) { // the same response refreshes the sidebar
      chatList = data.conversations || [];
      renderChatList();
    }
    renderUnreadBadge();
  } catch (e) { /* keep the last known count instead of flashing 0 */ }
}

// Another tab of mine marked a conversation read (socket echo of POST /read).
// This tab never counted it twice — markConversationRead() already zeroed it —
// so subtracting only what the sidebar still shows is safe.
function dropConversationUnread(convId) {
  const c = chatList.find(x => x.id === convId);
  if (!c) { syncUnreadBadge(); return; } // sidebar not fetched yet: ask the server
  const prev = Number(c.unread) || 0;
  if (!prev) { renderUnreadBadge(); return; }
  c.unread = 0;
  unreadMsgTotal = Math.max(0, unreadMsgTotal - prev);
  renderChatList();
  renderUnreadBadge();
}

async function refreshChatList(force) {
  if (!force && chatListLoaded) return chatList;
  try {
    const data = await api.get('/api/chats');
    chatList = data.conversations || [];
    chatListLoaded = true;
    unreadMsgTotal = Number(data.unreadTotal) || 0;
    renderUnreadBadge();
    renderChatList();
  } catch (e) {
    const el = $('#chat-list');
    if (el) el.innerHTML = `<div class="empty-state small">${escapeHtml(e.message)}</div>`;
  }
  return chatList;
}

// Entry point for /chats and /chats/:id.
async function loadChatsPage(conversationId) {
  await refreshChatList(false);
  if (conversationId) await openChat(conversationId);
  else closeThread();
}

function closeThread() {
  chatLoadToken++;
  activeChatId = null;
  activeConv = null;
  chatMessages = [];
  chatHasMore = false;
  privateReadCursor = 0;
  chatTyping.clear();
  const layout = $('#chat-layout');
  if (layout) layout.classList.remove('thread-open');
  $('#chat-thread')?.classList.add('hidden');
  const empty = $('#chat-empty');
  if (empty) { empty.classList.remove('hidden'); empty.textContent = 'Select a conversation to start chatting.'; }
  renderChatList();
}

// Opens ONE conversation. The id always comes from the URL / caller.
async function openChat(convId) {
  const token = ++chatLoadToken;
  activeChatId = convId;
  activeConv = null;
  chatMessages = [];
  chatHasMore = false;
  privateReadCursor = 0;
  chatTyping.clear();

  $('#chat-layout').classList.add('thread-open');
  $('#chat-empty').classList.add('hidden');
  $('#chat-thread').classList.remove('hidden');
  $('#thread-msgs').innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  $('#thread-name').textContent = 'Loading…';
  $('#thread-sub').textContent = '';
  $('#typing-line').textContent = '';
  renderChatList();

  try {
    const [detail, page] = await Promise.all([
      api.get(`/api/chats/${convId}`),
      api.get(`/api/chats/${convId}/messages?limit=30`)
    ]);
    if (token !== chatLoadToken) return; // a newer open() took over

    activeConv = detail.conversation;
    activeConvMembers = detail.members;
    chatMessages = page.messages || [];
    chatHasMore = !!page.hasMore;

    // Read cursor of the other side — drives the ✓✓ on my messages.
    const otherMember = (detail.members || []).find(m => m.user_id !== currentUser.id);
    privateReadCursor = otherMember ? Number(otherMember.last_read_msg_id) || 0 : 0;

    renderThreadHeader(detail);
    renderThreadMessages();
    scrollThreadToBottom();
    renderChatList();

    $('#thread-input').focus();
    markConversationRead(convId, true);
  } catch (e) {
    if (token !== chatLoadToken) return;
    // Not a member (403) or gone (404): never render someone else's chat.
    activeChatId = null;
    $('#chat-thread').classList.add('hidden');
    $('#chat-layout').classList.remove('thread-open');
    const empty = $('#chat-empty');
    empty.classList.remove('hidden');
    empty.textContent = e.message;
    if (window.location.pathname !== '/chats') history.replaceState(null, '', '/chats');
    renderChatList();
  }
}

function renderThreadHeader(detail) {
  const conv = detail.conversation;
  const av = chatAvatarUser(conv);

  // The avatar links to a profile ONLY for a private chat, where there is a
  // single clear target — a group has no one profile to open.
  const link = $('#thread-avatar-link');
  link.innerHTML = avatarHtml(av);
  if (conv.type === 'private' && conv.other_user) {
    link.setAttribute('href', `/profile/${conv.other_user.id}`);
    link.setAttribute('data-profile-id', conv.other_user.id);
  } else {
    link.removeAttribute('href');
    link.removeAttribute('data-profile-id');
  }
  bindProfileLinks(link);

  $('#thread-name').textContent = chatTitle(conv);

  const sub = $('#thread-sub');
  if (conv.type === 'group') {
    sub.textContent = `${detail.members.length} member${detail.members.length === 1 ? '' : 's'}`;
  } else {
    const other = conv.other_user;
    const online = other && onlineUsers.has(other.id);
    sub.innerHTML = `<span class="dot ${online ? 'on' : ''}"></span>${online ? 'Online' : 'Last seen recently'}`;
  }
  $('#thread-info').classList.remove('hidden');
  updateTypingLine();
}

// Marks everything currently in the conversation as read for me.
async function markConversationRead(convId, silent) {
  const idx = chatList.findIndex(c => c.id === convId);
  if (idx >= 0 && chatList[idx].unread) {
    // Opening the thread must move the nav badge right away — the POST below
    // then confirms the exact total straight from the server.
    unreadMsgTotal = Math.max(0, unreadMsgTotal - chatList[idx].unread);
    chatList[idx].unread = 0;
    renderChatList();
    renderUnreadBadge();
  }
  try {
    const res = await api.post(`/api/chats/${convId}/read`, {});
    if (res && typeof res.unreadTotal === 'number') {
      unreadMsgTotal = res.unreadTotal;
      renderUnreadBadge();
    }
  }
  catch (e) { if (!silent) toast(e.message, 'error'); }
}

async function sendChatMessage() {
  const input = $('#thread-input');
  if (!input || !activeChatId || chatSending) return;
  const convId = activeChatId;
  const content = input.value.trim();
  if (!content) return;

  input.value = '';
  chatSending = true;
  $('#thread-send').disabled = true;
  $('#thread-send').textContent = '…';

  // Optimistic render: the message appears immediately, marked as pending.
  const temp = {
    id: -Date.now(),
    conversation_id: convId,
    sender_id: currentUser.id,
    content,
    created_at: nowSql(),
    sender: { id: currentUser.id, username: currentUser.username, avatar_path: currentUser.avatar_path }
  };
  const prev = chatMessages[chatMessages.length - 1] || null;
  chatMessages.push(temp);
  appendMessageToThread(temp);
  scrollThreadToBottom();

  try {
    const { message } = await api.post(`/api/chats/${convId}/messages`, { content });
    // The socket echo may already have installed the real message — in that
    // case there is nothing left to replace and no second bubble is added.
    const i = chatMessages.findIndex(m => m.id === temp.id);
    if (i >= 0) {
      chatMessages[i] = message;
      const el = $(`#thread-msgs .msg[data-msg-id="${temp.id}"]`);
      if (el) {
        const isGroup = activeConv && activeConv.type === 'group';
        el.outerHTML = messageHtml(message, i > 0 ? chatMessages[i - 1] : null, isGroup);
      }
    } else if (!chatMessages.some(m => m.id === message.id)) {
      chatMessages.push(message);
      appendMessageToThread(message);
      scrollThreadToBottom();
    }
    upsertChatPreview(convId, message);
    renderChatList();
  } catch (e) {
    // Roll back so a failed send never looks like a delivered message.
    const stillPending = chatMessages.some(m => m.id === temp.id);
    if (stillPending) {
      chatMessages = chatMessages.filter(m => m.id !== temp.id);
      $(`#thread-msgs .msg[data-msg-id="${temp.id}"]`)?.remove();
      if (!chatMessages.length) renderThreadMessages();
      input.value = content;
    }
    toast(e.message, 'error');
  } finally {
    chatSending = false;
    $('#thread-send').disabled = false;
    $('#thread-send').textContent = 'Send';
    input.focus();
  }
}

let chatLoadingOlder = false;

// Keyset pagination: fetch the page BEFORE my oldest loaded message and keep
// the scroll position pinned where the user was reading.
async function loadOlderMessages() {
  if (!activeChatId || !chatHasMore || chatLoadingOlder || !chatMessages.length) return;
  const convId = activeChatId;
  const before = chatMessages[0].id;
  chatLoadingOlder = true;
  const btn = $('#load-older-btn');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }

  try {
    const page = await api.get(`/api/chats/${convId}/messages?limit=30&before=${before}`);
    if (convId !== activeChatId) return;
    const box = $('#thread-msgs');
    const keep = box.scrollHeight - box.scrollTop;
    chatMessages = [...(page.messages || []), ...chatMessages];
    chatHasMore = !!page.hasMore;
    renderThreadMessages();
    box.scrollTop = box.scrollHeight - keep;
  } catch (e) {
    toast(e.message, 'error');
    const b = $('#load-older-btn');
    if (b) { b.textContent = 'Load earlier messages'; b.disabled = false; }
  } finally {
    chatLoadingOlder = false;
  }
}

// Opens (or reuses) the private chat with a FRIEND.
async function openPrivateChat(userId) {
  const { conversation } = await api.post('/api/chats/private', { userId });
  chatListLoaded = false;      // a conversation may have just been created
  await refreshChatList(true);
  navigateChat(conversation.id);
}

function bindChatPage() {
  $('#chat-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-conv-id]');
    if (item) navigateChat(Number(item.dataset.convId));
  });

  $('#thread-msgs')?.addEventListener('click', (e) => {
    if (e.target.closest('#load-older-btn')) loadOlderMessages();
  });

  $('#thread-back')?.addEventListener('click', () => navigate('chats'));

  $('#thread-info')?.addEventListener('click', () => {
    if (activeChatId) openMembersModal(activeChatId);
  });

  $('#thread-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChatMessage();
  });

  // Typing indicator — throttled, fire-and-forget, auto-expires on the reader.
  $('#thread-input')?.addEventListener('input', () => {
    if (!socket || !activeChatId) return;
    const now = Date.now();
    if (now - lastTypingEmit < 1500) return;
    lastTypingEmit = now;
    socket.emit('typing', { conversationId: activeChatId, typing: true });
  });

  const search = $('#chat-search');
  search?.addEventListener('input', () => {
    chatSearchQuery = search.value.slice(0, 60);
    renderChatList();
  });

  $('#create-group-btn')?.addEventListener('click', openGroupModal);
}

let lastTypingEmit = 0;

// ---------- Real-time chat events ----------
function handleChatEvent(kind, p) {
  p = p || {};
  const convId = Number(p.conversationId || (p.conversation && p.conversation.id)) || 0;

  if (kind === 'new_private_message' || kind === 'new_group_message') {
    const msg = p.message;
    if (!msg) return;
    const convId2 = msg.conversation_id;

    // Update my sidebar entry (move to top, refresh the preview).
    const known = chatList.some(c => c.id === convId2);
    if (known) upsertChatPreview(convId2, msg);
    else if (p.conversation && p.conversation.id === convId2) {
      // The server built this summary for the SENDER, so its `unread` is not
      // necessarily mine — only a message from someone else is unread for me.
      if (!(currentUser && msg.sender_id === currentUser.id)) p.conversation.unread = 1;
      chatList.unshift(p.conversation);
    }

    // "Active" means the chats view is on screen AND this is the open
    // thread. Navigating to Home must not swallow unread counts.
    const chatsVisible = $('#view-chats') && !$('#view-chats').classList.contains('hidden');
    const showing = !!chatsVisible && convId2 === activeChatId;

    if (showing) {
      const isGroup = activeConv && activeConv.type === 'group';

      // The echo can beat the REST response, land after it, or arrive in a
      // second tab — so reconcile by id AND by the pending optimistic copy.
      if (currentUser && msg.sender_id === currentUser.id) {
        if (chatMessages.some(m => m.id === msg.id)) {          // REST already installed it
          renderChatList();
          return;
        }
        const pending = chatMessages.findIndex(m => m.id < 0 && m.content === msg.content);
        if (pending >= 0) {                                     // swap in place, no second bubble
          const temp = chatMessages[pending];
          chatMessages[pending] = msg;
          const el = $(`#thread-msgs .msg[data-msg-id="${temp.id}"]`);
          if (el) el.outerHTML = messageHtml(msg, chatMessages[pending - 1], isGroup);
          upsertChatPreview(convId2, msg);
          renderChatList();
          return;
        }
      }

      if (!chatMessages.some(m => m.id === msg.id)) {           // someone else's message
        const box = $('#thread-msgs');
        const near = box ? isNearBottom(box) : true;
        chatMessages.push(msg);
        const empty = box && $('.empty-state', box);
        if (empty) empty.remove();
        appendMessageToThread(msg);
        if (near) scrollThreadToBottom();
      }
      if (!(currentUser && msg.sender_id === currentUser.id)) markConversationRead(convId2, true);
    } else {
      const mine = currentUser && msg.sender_id === currentUser.id;
      if (!mine) {
        // Thread not on screen + sent by someone else = unread: the sidebar
        // count and the nav badge both go up. My own message (another tab of
        // mine, or the echo) never counts.
        unreadMsgTotal += 1;
        const c = chatList.find(x => x.id === convId2);
        if (c) c.unread = (Number(c.unread) || 0) + 1;
        renderUnreadBadge();
      }
    }
    renderChatList();
    return;
  }

  if (kind === 'conversation_created' || kind === 'group_created') {
    if (p.conversation && !chatList.some(c => c.id === p.conversation.id)) {
      chatList.unshift(p.conversation);
      renderChatList();
    }
    return;
  }

  if (kind === 'group_updated') {
    const i = chatList.findIndex(c => c.id === convId);
    if (i >= 0 && p.conversation) {
      p.conversation.unread = chatList[i].unread;
      chatList[i] = p.conversation;
      chatList.sort((a, b) => (b.id === activeChatId) - (a.id === activeChatId));
      renderChatList();
    }
    if (convId === activeChatId && activeConv && p.conversation) {
      activeConv = p.conversation;
      $('#thread-name').textContent = chatTitle(activeConv);
      $('#thread-avatar-link').innerHTML = avatarHtml(chatAvatarUser(activeConv));
    }
    if (membersConvId === convId && !$('#members-modal').classList.contains('hidden')) {
      if (p.conversation) $('#members-title').textContent = chatTitle(p.conversation);
    }
    return;
  }

  if (kind === 'group_member_added') {
    if (convId === activeChatId) refreshThreadHeader();
    refreshMembersModal(convId);
    return;
  }

  if (kind === 'group_member_removed') {
    if (p.userId === (currentUser && currentUser.id)) {
      // I was removed (or removed myself): drop it from my list entirely and
      // never leave a now-unreadable member list on screen.
      chatList = chatList.filter(c => c.id !== convId);
      renderChatList();
      closeMembersModal();
      if (convId === activeChatId) navigate('chats');
    } else {
      if (convId === activeChatId) refreshThreadHeader();
      // Someone else left/removed while the member list is on screen.
      refreshMembersModal(convId);
    }
    return;
  }

  if (kind === 'group_role_changed') {
    refreshMembersModal(convId);
    if (convId === activeChatId) refreshThreadHeader();
    return;
  }

  if (kind === 'group_deleted') {
    chatList = chatList.filter(c => c.id !== convId);
    renderChatList();
    if (membersConvId === convId) closeMembersModal();
    if (convId === activeChatId) navigate('chats');
    return;
  }
}

// Re-fetches the member list only if that group's modal is on screen — a
// membership change must never leave a stale role/roster visible.
function refreshMembersModal(convId) {
  if (membersConvId === convId && !$('#members-modal').classList.contains('hidden')) {
    openMembersModal(convId, true);
  }
}

async function refreshThreadHeader() {
  if (!activeChatId) return;
  const token = chatLoadToken;
  try {
    const detail = await api.get(`/api/chats/${activeChatId}`);
    if (token !== chatLoadToken) return;
    activeConv = detail.conversation;
    renderThreadHeader(detail);
    const i = chatList.findIndex(c => c.id === detail.conversation.id);
    if (i >= 0) { detail.conversation.unread = chatList[i].unread; chatList[i] = detail.conversation; renderChatList(); }
  } catch (e) { /* the thread will surface it on the next open */ }
}

function handleTypingEvent({ conversationId, userId, username, typing }) {
  if (!currentUser || userId === currentUser.id) return;
  let m = chatTyping.get(conversationId);
  if (!m) { m = new Map(); chatTyping.set(conversationId, m); }
  clearTimeout(m.get(userId));
  if (typing) {
    m.set(userId, setTimeout(() => { m.delete(userId); updateTypingLine(); }, 3500));
  } else {
    m.delete(userId);
  }
  updateTypingLine();
}

function updateTypingLine() {
  const el = $('#typing-line');
  if (!el) return;
  const m = chatTyping.get(activeChatId);
  if (!m || !m.size) { el.textContent = ''; return; }

  // Resolve display names from what we already have — no extra request.
  const conv = chatList.find(c => c.id === activeChatId);
  const names = [];
  m.forEach((timer, uid) => {
    let name = null;
    if (conv && conv.type === 'private' && conv.other_user && conv.other_user.id === uid) name = conv.other_user.username;
    else if (activeConvMembers) {
      const mem = activeConvMembers.find(x => x.user_id === uid);
      if (mem) name = mem.username;
    }
    names.push(name || 'Someone');
  });

  el.textContent = names.length
    ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…`
    : '';
}

function handleReadEvent({ conversationId, userId, last_read_msg_id }) {
  // My own account marked this conversation read — most likely a second tab.
  // This tab's count for it is dropped too (markConversationRead() already
  // zeroed it here, so nothing is ever subtracted twice).
  if (currentUser && userId === currentUser.id) {
    dropConversationUnread(conversationId);
    return;
  }
  if (conversationId !== activeChatId) return;
  const cursor = Number(last_read_msg_id) || 0;
  if (cursor <= privateReadCursor) return;
  privateReadCursor = cursor;
  $all('#thread-msgs .msg[data-mine="1"]').forEach(el => {
    if (Number(el.dataset.msgId) <= privateReadCursor) {
      const t = $('.msg-time', el);
      if (t && !t.dataset.read) { t.dataset.read = '1'; t.textContent += ' ✓✓'; }
    }
  });
}

// ===================== Group creation =====================
function openGroupModal() {
  groupFile = null;
  if (groupObjectUrl) { URL.revokeObjectURL(groupObjectUrl); groupObjectUrl = null; }
  $('#group-name').value = '';
  $('#group-error').textContent = '';
  $('#group-avatar-file').value = '';
  $('#group-avatar-preview').innerHTML = '';
  $('#group-friends').innerHTML = '<div class="empty-state small">Loading friends...</div>';
  $('#group-submit').disabled = false;
  $('#group-submit').textContent = 'Create Group';
  $('#group-modal').classList.remove('hidden');
  loadGroupFriendOptions();
}

function closeGroupModal() {
  $('#group-modal').classList.add('hidden');
  if (groupObjectUrl) { URL.revokeObjectURL(groupObjectUrl); groupObjectUrl = null; }
  groupFile = null;
}

async function loadGroupFriendOptions() {
  const box = $('#group-friends');
  try {
    const { friends } = await api.get('/api/friends');
    if (!friends.length) {
      box.innerHTML = '<div class="empty-state small">Add some friends first — only friends can be added to a group.</div>';
      return;
    }
    box.innerHTML = friends.map(f => `
      <label class="check-row">
        <input type="checkbox" value="${f.id}">
        ${avatarHtml(f)}
        <span class="label">${escapeHtml(f.username)}</span>
      </label>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty-state small">${escapeHtml(e.message)}</div>`;
  }
}

function bindGroupModal() {
  $('#group-close').onclick = closeGroupModal;
  $('#group-cancel').onclick = closeGroupModal;
  $('#group-modal').addEventListener('click', (e) => {
    if (e.target.id === 'group-modal') closeGroupModal();
  });

  $('#group-avatar-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (groupObjectUrl) { URL.revokeObjectURL(groupObjectUrl); groupObjectUrl = null; }
    groupFile = file || null;
    groupObjectUrl = file ? URL.createObjectURL(file) : null;
    $('#group-avatar-preview').innerHTML = groupObjectUrl
      ? `<img src="${groupObjectUrl}" alt="Group image">` : '';
  });

  $('#group-submit').onclick = async () => {
    const name = $('#group-name').value.trim();
    const errEl = $('#group-error');
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Give your group a name.'; return; }

    const ids = $all('#group-friends input:checked').map(i => Number(i.value));
    if (!ids.length) { errEl.textContent = 'Select at least one friend.'; return; }

    const btn = $('#group-submit');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const { conversation } = await api.post('/api/chats/groups', { name, memberIds: ids });
      if (groupFile) {
        const fd = new FormData();
        fd.append('avatar', groupFile);
        await api.postForm(`/api/chats/${conversation.id}/avatar`, fd);
      }
      chatListLoaded = false;
      await refreshChatList(true);
      closeGroupModal();
      toast('Group created ✓');
      navigateChat(conversation.id);
    } catch (e) {
      errEl.textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Create Group';
    }
  };
}

// ===================== Group members =====================
async function openMembersModal(convId, keepOpen) {
  membersConvId = convId;
  $('#members-error').textContent = '';
  $('#rename-row').classList.add('hidden');
  $('#add-friend-list').classList.add('hidden');
  if (!keepOpen) $('#members-modal').classList.remove('hidden');
  $('#members-list').innerHTML = '<div class="empty-state small"><div class="spinner"></div></div>';

  try {
    const detail = await api.get(`/api/chats/${convId}`);
    if (membersConvId !== convId) return;
    activeConvMembers = detail.members;
    const conv = detail.conversation;
    const isGroup = conv.type === 'group';
    const canManage = !!detail.permissions.canManage;

    $('#members-title').textContent = isGroup ? (conv.name || 'Members') : 'Conversation members';
    $('#member-toolbar').classList.toggle('hidden', !(isGroup && canManage));
    $('#members-leave-btn').classList.toggle('hidden', !isGroup);
    $('#group-rename-btn').textContent = conv.name ? 'Rename group' : 'Set group name';

    $('#members-list').innerHTML = detail.members.map(m => {
      const online = onlineUsers.has(m.user_id);
      const isMe = currentUser && m.user_id === currentUser.id;
      const canDemote = detail.permissions.canChangeRoles && m.role !== 'owner' && !isMe;
      const canRemove = isMe || (canManage && m.role !== 'owner' && !(m.role === 'admin' && detail.my_role !== 'owner'));
      return `
        <div class="member-row" data-user-id="${m.user_id}">
          <a class="post-avatar-link" href="/profile/${m.user_id}" data-profile-id="${m.user_id}">${avatarHtml(m)}</a>
          <div class="member-info">
            <div class="member-name">${escapeHtml(m.username)}${isMe ? ' <span class="muted">(you)</span>' : ''}</div>
            <div class="member-sub"><span class="dot ${online ? 'on' : ''}"></span> ${online ? 'Online' : 'Last seen recently'}</div>
          </div>
          <span class="role-chip ${m.role}">${m.role}</span>
          <span class="member-tools">
            ${canDemote ? `<button class="btn btn-secondary" data-role-toggle="${m.user_id}" data-role="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? 'Demote' : 'Make admin'}</button>` : ''}
            ${canRemove && !isMe ? `<button class="btn btn-danger" data-remove-member="${m.user_id}">Remove</button>` : ''}
          </span>
        </div>`;
    }).join('');
    bindProfileLinks($('#members-list'));
  } catch (e) {
    $('#members-list').innerHTML = `<div class="empty-state small">${escapeHtml(e.message)}</div>`;
  }
}

function closeMembersModal() {
  $('#members-modal').classList.add('hidden');
  membersConvId = null;
  activeConvMembers = null;
}

async function loadAddFriendOptions() {
  const box = $('#add-friend-list');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="empty-state small">Loading friends...</div>';
  try {
    const [{ friends }, detail] = await Promise.all([
      api.get('/api/friends'),
      api.get(`/api/chats/${membersConvId}`)
    ]);
    const inGroup = new Set(detail.members.map(m => m.user_id));
    const options = friends.filter(f => !inGroup.has(f.id));
    if (!options.length) {
      box.innerHTML = '<div class="empty-state small">All of your friends are already here.</div>';
      return;
    }
    box.innerHTML = options.map(f => `
      <label class="check-row">
        <input type="checkbox" value="${f.id}">
        ${avatarHtml(f)}
        <span class="label">${escapeHtml(f.username)}</span>
      </label>`).join('') +
      `<div class="member-tools" style="padding:10px">
         <button type="button" class="btn btn-primary btn-xs" id="confirm-add-members">Add to group</button>
       </div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state small">${escapeHtml(e.message)}</div>`;
  }
}

function bindMembersModal() {
  $('#members-close').onclick = closeMembersModal;
  $('#members-modal').addEventListener('click', (e) => {
    if (e.target.id === 'members-modal') closeMembersModal();
  });

  $('#group-rename-btn').onclick = () => {
    const row = $('#rename-row');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) {
      $('#rename-input').value = activeConv && activeConv.type === 'group' ? (activeConv.name || '') : '';
      $('#rename-input').focus();
    }
  };

  $('#rename-save').onclick = async () => {
    const name = $('#rename-input').value.trim();
    if (!name) { $('#members-error').textContent = 'Name cannot be empty.'; return; }
    try {
      const { conversation } = await api.patch(`/api/chats/${membersConvId}`, { name });
      activeConv = conversation;
      $('#members-title').textContent = conversation.name;
      $('#rename-row').classList.add('hidden');
      const i = chatList.findIndex(c => c.id === conversation.id);
      if (i >= 0) { chatList[i] = conversation; renderChatList(); }
      toast('Group renamed.');
    } catch (e) { $('#members-error').textContent = e.message; }
  };

  $('#group-image-btn').onclick = () => $('#group-image-file').click();
  $('#group-image-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !membersConvId) return;
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      const { conversation } = await api.postForm(`/api/chats/${membersConvId}/avatar`, fd);
      const i = chatList.findIndex(c => c.id === conversation.id);
      if (i >= 0) { chatList[i] = conversation; renderChatList(); }
      toast('Group image updated.');
    } catch (err) { $('#members-error').textContent = err.message; }
  });

  $('#group-add-btn').onclick = loadAddFriendOptions;

  $('#members-leave-btn').onclick = async () => {
    if (!membersConvId) return;
    try {
      await api.post(`/api/chats/${membersConvId}/leave`, {});
      chatList = chatList.filter(c => c.id !== membersConvId);
      renderChatList();
      closeMembersModal();
      toast('You left the group.');
      if (activeChatId && activeConv && activeConv.id === membersConvId) navigate('chats');
    } catch (e) { $('#members-error').textContent = e.message; }
  };

  $('#members-list').addEventListener('click', async (e) => {
    const roleBtn = e.target.closest('[data-role-toggle]');
    if (roleBtn) {
      const uid = Number(roleBtn.dataset.roleToggle);
      roleBtn.disabled = true;
      try {
        await api.patch(`/api/chats/${membersConvId}/members/${uid}`, { role: roleBtn.dataset.role });
        openMembersModal(membersConvId, true);
      } catch (err) { toast(err.message, 'error'); roleBtn.disabled = false; }
      return;
    }
    const rmBtn = e.target.closest('[data-remove-member]');
    if (rmBtn) {
      const uid = Number(rmBtn.dataset.removeMember);
      rmBtn.disabled = true;
      try {
        await api.del(`/api/chats/${membersConvId}/members/${uid}`);
        openMembersModal(membersConvId, true);
        toast('Member removed.');
      } catch (err) { toast(err.message, 'error'); rmBtn.disabled = false; }
    }
  });

  // Add selected friends to the group (only friends are ever offered).
  $('#add-friend-list').addEventListener('click', async (e) => {
    if (!e.target.closest('#confirm-add-members')) return;
    const ids = $all('#add-friend-list input:checked').map(i => Number(i.value));
    if (!ids.length) { $('#members-error').textContent = 'Select at least one friend.'; return; }
    // openMembersModal() clears the error box, so keep the message until
    // after the refresh instead of writing it first.
    let addError = '';
    for (const id of ids) {
      try { await api.post(`/api/chats/${membersConvId}/members`, { userId: id }); }
      catch (err) { addError = err.message; break; }
    }
    await openMembersModal(membersConvId, true);
    if (addError) $('#members-error').textContent = addError;
    else toast('Members added.');
  });
}
