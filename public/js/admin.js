/* =========================================================================
   FrenzZone Admin Panel — public/js/admin.js
   -------------------------------------------------------------------------
   The panel is a VIEW only. Every piece of data it draws comes from
   /api/admin/*, which checks the caller's role in the database on every
   single request (middleware/admin.js). Nothing here grants permission:
   hiding a button is a usability detail, never the security boundary.
   A non-staff account that opens /admin by hand is refused by the server
   with 403 on its first request and this file simply renders that refusal.
   ========================================================================= */
window.AdminPanel = (function () {
  'use strict';

  // ---------- tiny helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const av = (u, size) => (window.avatarHtml
    ? window.avatarHtml({ username: u.username, avatar_path: u.avatar_path }, size || '')
    : '');
  const say = (msg, kind) => { if (window.toast) window.toast(msg, kind); };
  const badge = (v) => (window.verifiedBadge ? window.verifiedBadge(v) : '');

  const PAGE_SIZE = 20;

  // Sidebar — order is the panel's navigation model, each entry carries the
  // permission key it needs (server-checked, mirrored here for the menu only).
  const TABS = [
    { id: 'dashboard', label: 'Dashboard', ico: '📊', perm: 'dashboard' },
    { id: 'users', label: 'Users', ico: '👥', perm: 'users' },
    { id: 'bans', label: 'Bans', ico: '🚫', perm: 'ban' },
    { id: 'reports', label: 'Reports', ico: '🚩', perm: 'reports' },
    { id: 'verification', label: 'Verification', ico: '✔', perm: 'verify' },
    { id: 'content', label: 'Content', ico: '📝', perm: 'content' },
    { id: 'admins', label: 'Admins', ico: '🛡', perm: 'staff' },
    { id: 'audit', label: 'Audit Logs', ico: '📜', perm: 'audit' },
    { id: 'settings', label: 'Settings', ico: '⚙️', perm: 'settings' }
  ];

  const state = {
    mounted: false,
    me: null,
    perms: {},
    tab: 'dashboard',
    query: {},   // tab -> search string
    page: {},    // tab -> page number
    filter: {},  // tab -> dropdown value
    contentKind: 'posts',
    openReports: 0,
    busy: false
  };

  // =======================================================================
  // Mount / unmount (called by app.js from the route)
  // =======================================================================
  async function mount() {
    const view = document.getElementById('view-admin');
    if (!view) return;
    if (state.mounted) { refresh(); return; }
    state.mounted = true;

    view.innerHTML = `
      <div class="admin-layout">
        <aside class="admin-side" id="admin-side">
          <div class="admin-side-head">
            <span class="brand-dot"></span>
            <strong>Admin</strong>
          </div>
          <div id="admin-nav"></div>
        </aside>
        <div class="admin-main" id="admin-main">
          <div class="admin-loading"><div class="admin-spinner"></div>Loading panel…</div>
        </div>
      </div>`;

    try {
      // The server answers with the caller's REAL role + permission set.
      state.me = await api.get('/api/admin/me');
      state.perms = state.me.permissions || {};
      renderNav();
      // One delegated listener per lifecycle event on the (persistent) main
      // container — re-rendering a tab replaces only its innerHTML, so no
      // handler is ever lost or bound twice.
      bindActions($('#admin-main'));
      await renderTab();
      loadOpenReportsCount();
    } catch (e) {
      renderDenied(e);
    }
  }

  function unmount() {
    state.mounted = false;
    closeDialog();
    const view = document.getElementById('view-admin');
    if (view) view.innerHTML = '';
  }

  function renderDenied(e) {
    const main = $('#admin-main');
    if (!main) return;
    const status = (e && e.status) || 0;
    if (status === 401) {
      main.innerHTML = `
        <div class="admin-card"><div class="admin-denied">
          <h3>Please sign in</h3>
          <p>Your session ended. Log in again to continue.</p>
          <button class="admin-btn primary" data-act="gologin">Go to login</button>
        </div></div>`;
    } else {
      main.innerHTML = `
        <div class="admin-card"><div class="admin-denied">
          <h3>Access denied</h3>
          <p>${esc((e && e.message) || 'Your account does not have access to the admin panel.')}</p>
          <p>The panel and every one of its APIs are protected server-side —
             changing this page in the browser cannot grant access.</p>
          <code>HTTP ${status || 403} · /api/admin/*</code>
        </div></div>`;
    }
    const nav = $('#admin-nav');
    if (nav) nav.innerHTML = '';
  }

  // =======================================================================
  // Sidebar
  // =======================================================================
  function renderNav() {
    const nav = $('#admin-nav');
    if (!nav) return;
    const role = state.me.role;
    nav.innerHTML = `
      <div class="admin-side-head" style="display:block;border:0;padding:4px 10px 10px;margin:0">
        <span class="role-pill ${esc(role)}">${esc(role)}</span>
        <div style="font-size:12px;color:var(--text-muted);margin-top:6px">${esc(state.me.username)}</div>
      </div>` +
      TABS.filter(t => state.perms[t.perm]).map(t => `
        <button type="button" class="admin-side-btn ${t.id === state.tab ? 'active' : ''}" data-tab="${t.id}">
          <span class="ico">${t.ico}</span>${t.label}
          ${t.id === 'reports' && state.openReports ? `<span class="pill">${state.openReports}</span>` : ''}
        </button>`).join('');

    $$('.admin-side-btn', nav).forEach(btn => {
      btn.onclick = () => {
        state.tab = btn.dataset.tab;
        state.page[state.tab] = 1;
        renderNav();
        renderTab();
      };
    });
  }

  async function loadOpenReportsCount() {
    if (!state.perms.reports) return;
    try {
      const d = await api.get('/api/admin/reports?status=open&limit=1');
      state.openReports = d.total || 0;
      renderNav();
    } catch (e) { /* non-fatal */ }
  }

  // =======================================================================
  // Tab dispatch
  // =======================================================================
  function allowed(tabId) {
    const t = TABS.find(x => x.id === tabId);
    return !!(t && state.perms[t.perm]);
  }

  async function renderTab() {
    const main = $('#admin-main');
    if (!main || !state.me) return;
    if (!allowed(state.tab)) {
      main.innerHTML = `
        <div class="admin-card"><div class="admin-denied">
          <h3>403 — Not allowed</h3>
          <p>The ${esc(state.tab)} section is not part of your role (${esc(state.me.role)}).</p>
          <code>GET /api/admin/${esc(state.tab)}</code>
        </div></div>`;
      return;
    }
    main.innerHTML = '<div class="admin-loading"><div class="admin-spinner"></div>Loading…</div>';
    try {
      if (state.tab === 'dashboard') await renderDashboard(main);
      else if (state.tab === 'users') await renderUsers(main);
      else if (state.tab === 'bans') await renderBans(main);
      else if (state.tab === 'reports') await renderReports(main);
      else if (state.tab === 'verification') await renderVerification(main);
      else if (state.tab === 'content') await renderContent(main);
      else if (state.tab === 'admins') await renderStaff(main);
      else if (state.tab === 'audit') await renderAudit(main);
      else if (state.tab === 'settings') await renderSettings(main);
    } catch (e) {
      main.innerHTML = `
        <div class="admin-card"><div class="admin-empty">
          <strong>Could not load this section.</strong><br>${esc(e.message)}
          <div style="margin-top:12px"><button class="admin-btn" data-act="retry">Try again</button></div>
        </div></div>`;
    }
  }

  // =======================================================================
  // Shared fragments
  // =======================================================================
  function head(title, sub, right) {
    return `
      <div class="admin-head">
        <div>
          <h2>${esc(title)}</h2>
          ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
        </div>
        ${right || ''}
      </div>`;
  }

  function searchBox(placeholder, tab) {
    return `
      <div class="admin-toolbar">
        <input type="search" id="admin-search" placeholder="${esc(placeholder)}"
               value="${esc(state.query[tab] || '')}" autocomplete="off">
        <button class="admin-btn primary" data-act="search">Search</button>
        ${state.query[tab] ? '<button class="admin-btn ghost" data-act="clear-search">Clear</button>' : ''}
      </div>`;
  }

  function pager(total, tab, limit) {
    const page = state.page[tab] || 1;
    const size = limit || PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(total / size));
    return `
      <div class="admin-pager">
        <span>${total} result${total === 1 ? '' : 's'} · page ${page} of ${pages}</span>
        <span class="grow"></span>
        <button class="admin-btn sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
        <button class="admin-btn sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next ›</button>
      </div>`;
  }

  function roleChip(role) {
    return `<span class="admin-chip ${esc(role)}">${esc(role)}</span>`;
  }

  function timeCell(t) {
    if (!t) return '—';
    const d = new Date(String(t).indexOf('T') > -1 ? t : t.replace(' ', 'T') + 'Z');
    return isNaN(d) ? esc(t) : esc(d.toLocaleString());
  }

  // =======================================================================
  // Dashboard
  // =======================================================================
  async function renderDashboard(main) {
    const d = await api.get('/api/admin/dashboard');
    const tiles = [
      ['Users', d.users, 'accent'],
      ['New today', d.usersToday, ''],
      ['Posts', d.posts, ''],
      ['Comments', d.comments, ''],
      ['Open reports', d.openReports, 'warn'],
      ['Active bans', d.activeBans, 'warn'],
      ['Verified', d.verified, 'accent'],
      ['Staff', d.staff, '']
    ];

    main.innerHTML = `
      ${head('Dashboard', `Signed in as ${d.me.username} · ${d.me.role}`)}
      <div class="admin-tiles">
        ${tiles.map(([label, n, cls]) => `
          <div class="admin-tile ${cls}"><div class="n">${Number(n) || 0}</div><div class="l">${label}</div></div>`).join('')}
      </div>

      <div class="admin-card">
        <div class="admin-card-head"><span>Latest reports</span>
          ${state.perms.reports ? '<button class="admin-btn sm" data-goto="reports">Open</button>' : ''}
        </div>
        <div class="admin-card-body tight">
          ${d.recentReports.length ? `
          <table class="admin-table">
            <thead><tr><th>#</th><th>Type</th><th>Reporter</th><th>Reason</th><th>Status</th><th>When</th></tr></thead>
            <tbody>${d.recentReports.map(r => `
              <tr>
                <td>${r.id}</td>
                <td><span class="admin-chip">${esc(r.target_type)}</span></td>
                <td>${esc(r.reporter)}</td>
                <td class="excerpt">${esc(r.reason)}</td>
                <td><span class="admin-chip ${esc(r.status)}">${esc(r.status)}</span></td>
                <td class="nowrap">${timeCell(r.created_at)}</td>
              </tr>`).join('')}</tbody>
          </table>` : '<div class="admin-empty">No reports yet.</div>'}
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-head"><span>Recent admin activity</span>
          ${state.perms.audit ? '<button class="admin-btn sm" data-goto="audit">All logs</button>' : ''}
        </div>
        <div class="admin-card-body tight">
          ${d.recentLogs.length ? `
          <table class="admin-table">
            <thead><tr><th>Admin</th><th>Action</th><th>Target</th><th>Reason</th><th>When</th></tr></thead>
            <tbody>${d.recentLogs.map(l => `
              <tr>
                <td>${esc(l.admin_name)}</td>
                <td><span class="admin-chip">${esc(l.action)}</span></td>
                <td>${esc(l.target_label || (l.target_type ? `${l.target_type}#${l.target_id}` : '—'))}</td>
                <td class="excerpt">${esc(l.reason || '—')}</td>
                <td class="nowrap">${timeCell(l.created_at)}</td>
              </tr>`).join('')}</tbody>
          </table>` : '<div class="admin-empty">No admin actions recorded yet.</div>'}
        </div>
      </div>`;
  }

  // =======================================================================
  // Users
  // =======================================================================
  async function renderUsers(main) {
    const tab = 'users';
    const page = state.page[tab] || 1;
    const q = state.query[tab] || '';
    const f = state.filter[tab] || {};
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (f.status) params.set('status', f.status);
    if (f.role) params.set('role', f.role);
    if (f.flag) params.set('flag', f.flag);

    const d = await api.get('/api/admin/users?' + params.toString());
    state.page[tab] = d.page;

    main.innerHTML = `
      ${head('User management', 'Search, ban, verify, sign out or remove accounts.')}
      <div class="admin-toolbar">
        <input type="search" id="admin-search" placeholder="Search username, email or name…"
               value="${esc(q)}" autocomplete="off">
        <select data-filter="status">
          <option value="">Any status</option>
          <option value="active" ${f.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="deactivated" ${f.status === 'deactivated' ? 'selected' : ''}>Self-deactivated</option>
          <option value="suspended" ${f.status === 'suspended' ? 'selected' : ''}>Disabled by admin</option>
        </select>
        <select data-filter="role">
          <option value="">Any role</option>
          ${['user', 'moderator', 'admin', 'owner'].map(r =>
            `<option value="${r}" ${f.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
        <select data-filter="flag">
          <option value="">Any flag</option>
          <option value="verified" ${f.flag === 'verified' ? 'selected' : ''}>Verified</option>
          <option value="banned" ${f.flag === 'banned' ? 'selected' : ''}>Banned</option>
        </select>
        <button class="admin-btn primary" data-act="search">Search</button>
      </div>

      <div class="admin-card">
        <div class="admin-card-body tight">
          ${d.users.length ? `
          <table class="admin-table">
            <thead><tr>
              <th>User</th><th>Role</th><th>Status</th><th>Joined</th><th>Posts</th><th>Actions</th>
            </tr></thead>
            <tbody>${d.users.map(u => userRow(u)).join('')}</tbody>
          </table>` : '<div class="admin-empty">No users match this filter.</div>'}
        </div>
        ${d.total ? pager(d.total, tab, d.limit) : ''}
      </div>`;
  }

  function userRow(u) {
    const banned = u.ban;
    return `
      <tr data-row-user="${u.id}">
        <td>
          <div class="who">
            ${av(u, 'sm')}
            <div>
              <div class="name">${esc(u.username)}${badge(u.is_verified)}</div>
              <div class="mail">${esc(u.email)}</div>
            </div>
          </div>
        </td>
        <td>${roleChip(u.role)}</td>
        <td>
          ${banned
            ? `<span class="admin-chip banned">banned</span>`
            : `<span class="admin-chip ${u.status === 'active' ? 'resolved' : 'deactivated'}">${esc(u.status)}</span>`}
          ${banned ? `<div class="mail" style="font-size:11.5px;color:var(--text-muted);margin-top:4px">${esc(banned.type)}${banned.expires_at ? ' · until ' + esc(banned.expires_at) : ''}</div>` : ''}
        </td>
        <td class="nowrap">${timeCell(u.created_at)}</td>
        <td>${u.post_count == null ? '—' : u.post_count}</td>
        <td class="actions-cell">
          <div class="admin-actions">
            ${state.perms.ban ? (banned
              ? `<button class="admin-btn sm" data-act="unban" data-id="${u.id}" data-name="${esc(u.username)}">Unban</button>`
              : `<button class="admin-btn sm danger" data-act="ban" data-id="${u.id}" data-name="${esc(u.username)}">Ban</button>`) : ''}
            ${state.perms.verify ? `<button class="admin-btn sm" data-act="${u.is_verified ? 'unverify' : 'verify'}" data-id="${u.id}" data-name="${esc(u.username)}">${u.is_verified ? 'Unverify' : 'Verify'}</button>` : ''}
            ${state.perms.logout ? `<button class="admin-btn sm" data-act="force-logout" data-id="${u.id}" data-name="${esc(u.username)}">Sign out</button>` : ''}
            ${state.perms.disable ? (u.status === 'active'
              ? `<button class="admin-btn sm" data-act="disable" data-id="${u.id}" data-name="${esc(u.username)}">Disable</button>`
              : `<button class="admin-btn sm" data-act="enable" data-id="${u.id}" data-name="${esc(u.username)}">Enable</button>`) : ''}
            ${state.perms.remove ? `<button class="admin-btn sm danger" data-act="delete-user" data-id="${u.id}" data-name="${esc(u.username)}">Delete</button>` : ''}
            <button class="admin-btn sm ghost" data-act="open-profile" data-id="${u.id}">Profile</button>
          </div>
        </td>
      </tr>`;
  }

  // =======================================================================
  // Bans
  // =======================================================================
  async function renderBans(main) {
    const tab = 'bans';
    const page = state.page[tab] || 1;
    const q = state.query[tab] || '';
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), flag: 'banned' });
    if (q) params.set('q', q);

    const d = await api.get('/api/admin/users?' + params.toString());
    state.page[tab] = d.page;

    main.innerHTML = `
      ${head('Bans', 'Every duration stores user, reason, admin, start, expiry and type.')}
      <div class="admin-toolbar">
        <input type="search" id="admin-search" placeholder="Search banned users…"
               value="${esc(q)}" autocomplete="off">
        <button class="admin-btn primary" data-act="search">Search</button>
        ${q ? '<button class="admin-btn ghost" data-act="clear-search">Clear</button>' : ''}
      </div>
      <div class="admin-card">
        <div class="admin-card-body tight">
          ${d.users.length ? `
          <table class="admin-table">
            <thead><tr><th>User</th><th>Type</th><th>Reason</th><th>Expires</th><th>Actions</th></tr></thead>
            <tbody>${d.users.map(u => `
              <tr>
                <td><div class="who">${av(u, 'sm')}
                  <div><div class="name">${esc(u.username)}${badge(u.is_verified)}</div>
                  <div class="mail">${esc(u.email)}</div></div></div></td>
                <td><span class="admin-chip ${u.ban && u.ban.type === 'permanent' ? 'permanent' : 'banned'}">${esc(u.ban ? u.ban.type : '')}</span></td>
                <td class="excerpt">${esc(u.ban ? u.ban.reason : '')}</td>
                <td class="nowrap">${u.ban && u.ban.expires_at ? timeCell(u.ban.expires_at) : 'Never'}</td>
                <td><div class="admin-actions">
                  <button class="admin-btn sm" data-act="unban" data-id="${u.id}" data-name="${esc(u.username)}">Unban</button>
                  <button class="admin-btn sm ghost" data-act="open-profile" data-id="${u.id}">Profile</button>
                </div></td>
              </tr>`).join('')}</tbody>
          </table>` : '<div class="admin-empty">No active bans.</div>'}
        </div>
        ${d.total ? pager(d.total, tab, d.limit) : ''}
      </div>`;
  }

  // =======================================================================
  // Reports
  // =======================================================================
  async function renderReports(main) {
    const tab = 'reports';
    const page = state.page[tab] || 1;
    const q = state.query[tab] || '';
    const status = state.filter[tab] && state.filter[tab].status;
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (status) params.set('status', status);

    const d = await api.get('/api/admin/reports?' + params.toString());
    state.page[tab] = d.page;
    state.reportsById = {};
    d.reports.forEach(r => { state.reportsById[r.id] = r; });

    main.innerHTML = `
      ${head('Reports', 'Users can report people, posts, comments and messages.')}
      <div class="admin-toolbar">
        <input type="search" id="admin-search" placeholder="Search reasons…" value="${esc(q)}" autocomplete="off">
        <select data-filter="status">
          <option value="">All</option>
          <option value="open" ${status === 'open' ? 'selected' : ''}>Open</option>
          <option value="resolved" ${status === 'resolved' ? 'selected' : ''}>Resolved</option>
          <option value="rejected" ${status === 'rejected' ? 'selected' : ''}>Rejected</option>
        </select>
        <button class="admin-btn primary" data-act="search">Filter</button>
      </div>
      <div class="admin-card">
        <div class="admin-card-body tight">
          ${d.reports.length ? `
          <table class="admin-table">
            <thead><tr><th>#</th><th>Target</th><th>Reporter</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${d.reports.map(r => `
              <tr>
                <td>${r.id}</td>
                <td>
                  <span class="admin-chip">${esc(r.target_type)}#${r.target_id}</span>
                  <div class="excerpt" style="margin-top:4px">${esc(r.target ? r.target.label : 'content removed')}</div>
                  ${r.target && r.target.sub ? `<div class="mail" style="font-size:11.5px;color:var(--text-muted)">${esc(r.target.sub)}</div>` : ''}
                </td>
                <td>${esc(r.reporter)}</td>
                <td class="excerpt">${esc(r.reason)}${r.details ? `<div style="margin-top:4px">${esc(r.details)}</div>` : ''}</td>
                <td><span class="admin-chip ${esc(r.status)}">${esc(r.status)}</span>
                    ${r.admin_name ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:4px">by ${esc(r.admin_name)}</div>` : ''}</td>
                <td><div class="admin-actions">
                  <button class="admin-btn sm" data-act="report-view" data-id="${r.id}">Review</button>
                  ${r.status === 'open' ? `
                    <button class="admin-btn sm" data-act="report-resolve" data-id="${r.id}">Resolve</button>
                    <button class="admin-btn sm" data-act="report-reject" data-id="${r.id}">Reject</button>` : ''}
                </div></td>
              </tr>`).join('')}</tbody>
          </table>` : '<div class="admin-empty">No reports here.</div>'}
        </div>
        ${d.total ? pager(d.total, tab, d.limit) : ''}
      </div>`;
  }

  // =======================================================================
  // Verification
  // =======================================================================
  async function renderVerification(main) {
    const tab = 'verification';
    const page = state.page[tab] || 1;
    const q = state.query[tab] || '';
    const f = (state.filter[tab] && state.filter[tab].flag) || '';
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (f) params.set('flag', f);

    const d = await api.get('/api/admin/users?' + params.toString());
    state.page[tab] = d.page;

    main.innerHTML = `
      ${head('Verification', 'The badge lives in the database — clients can only display it.')}
      <div class="admin-toolbar">
        <input type="search" id="admin-search" placeholder="Search users to verify…"
               value="${esc(q)}" autocomplete="off">
        <select data-filter="flag">
          <option value="">Everyone</option>
          <option value="verified" ${f === 'verified' ? 'selected' : ''}>Verified only</option>
        </select>
        <button class="admin-btn primary" data-act="search">Search</button>
      </div>
      <div class="admin-card">
        <div class="admin-card-body tight">
          ${d.users.length ? `
          <table class="admin-table">
            <thead><tr><th>User</th><th>Badge</th><th>Role</th><th>Actions</th></tr></thead>
            <tbody>${d.users.map(u => `
              <tr>
                <td><div class="who">${av(u, 'sm')}
                  <div><div class="name">${esc(u.username)}${badge(u.is_verified)}</div>
                  <div class="mail">${esc(u.email)}</div></div></div></td>
                <td>${u.is_verified
                  ? '<span class="admin-chip verified">verified</span>'
                  : '<span class="admin-chip">not verified</span>'}</td>
                <td>${roleChip(u.role)}</td>
                <td><div class="admin-actions">
                  <button class="admin-btn sm ${u.is_verified ? '' : 'primary'}"
                    data-act="${u.is_verified ? 'unverify' : 'verify'}" data-id="${u.id}" data-name="${esc(u.username)}">
                    ${u.is_verified ? 'Remove badge' : 'Grant badge'}
                  </button>
                </div></td>
              </tr>`).join('')}</tbody>
          </table>` : '<div class="admin-empty">No users match this filter.</div>'}
        </div>
        ${d.total ? pager(d.total, tab, d.limit) : ''}
      </div>`;
  }

  // =======================================================================
  // Content
  // =======================================================================
  async function renderContent(main) {
    const tab = 'content';
    const kind = state.contentKind;
    const page = state.page[tab] || 1;
    const q = state.query[tab] || '';
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (q) params.set('q', q);

    const d = await api.get(`/api/admin/content/${kind}?` + params.toString());
    state.page[tab] = d.page;
    const rows = kind === 'posts' ? d.posts : d.comments;
    const total = d.total;

    main.innerHTML = `
      ${head('Content moderation', 'Remove posts or comments that break the rules.')}
      <div class="admin-toolbar">
        <button class="admin-btn ${kind === 'posts' ? 'primary' : ''}" data-kind="posts">Posts</button>
        <button class="admin-btn ${kind === 'comments' ? 'primary' : ''}" data-kind="comments">Comments</button>
        <input type="search" id="admin-search" placeholder="Search content or author…"
               value="${esc(q)}" autocomplete="off">
        <button class="admin-btn primary" data-act="search">Search</button>
      </div>
      <div class="admin-card">
        <div class="admin-card-body tight">
          ${rows.length ? `
          <table class="admin-table">
            <thead><tr><th>Author</th><th>Text</th><th>When</th><th>Actions</th></tr></thead>
            <tbody>${rows.map(r => `
              <tr>
                <td><div class="who">
                  <div><div class="name">${esc(r.username)}${badge(r.is_verified)}</div>
                  <div class="mail">${esc(r.role || 'user')}</div></div>
                </div></td>
                <td class="excerpt">${esc((r.text || '(media post)').slice(0, 160))}</td>
                <td class="nowrap">${timeCell(r.created_at)}</td>
                <td><div class="admin-actions">
                  ${state.perms.contentDelete ? `
                    <button class="admin-btn sm danger" data-act="delete-${kind === 'posts' ? 'post' : 'comment'}"
                      data-id="${r.id}" data-name="${esc(r.username)}">Delete</button>` : ''}
                  ${r.post_id ? `<button class="admin-btn sm ghost" data-act="open-post" data-id="${r.post_id}">Open</button>` : ''}
                </div></td>
              </tr>`).join('')}</tbody>
          </table>` : '<div class="admin-empty">Nothing here.</div>'}
        </div>
        ${total ? pager(total, tab, d.limit) : ''}
      </div>`;

    $$('[data-kind]', main).forEach(b => {
      b.onclick = () => { state.contentKind = b.dataset.kind; state.page[tab] = 1; renderTab(); };
    });
  }

  // =======================================================================
  // Staff (Owner only — the route enforces this a second time)
  // =======================================================================
  async function renderStaff(main) {
    const d = await api.get('/api/admin/staff');
    const isOwner = state.me.role === 'owner';

    main.innerHTML = `
      ${head('Admins & Moderators', isOwner
        ? 'Only the Owner can grant or revoke staff roles.'
        : 'Read-only: role management belongs to the Owner.')}
      <div class="admin-card">
        <div class="admin-card-head">
          <span>Staff accounts</span>
          ${isOwner ? '<button class="admin-btn primary sm" data-act="add-staff">Add staff</button>' : ''}
        </div>
        <div class="admin-card-body tight">
          ${d.staff.length ? `
          <table class="admin-table">
            <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Since</th><th>Actions</th></tr></thead>
            <tbody>${d.staff.map(u => `
              <tr>
                <td><div class="who">${av(u, 'sm')}
                  <div><div class="name">${esc(u.username)}${badge(u.is_verified)}</div>
                  <div class="mail">${esc(u.email)}</div></div></div></td>
                <td>${roleChip(u.role)}</td>
                <td><span class="admin-chip ${u.status === 'active' ? 'resolved' : 'deactivated'}">${esc(u.status)}</span></td>
                <td class="nowrap">${u.since ? timeCell(u.since) : '—'}</td>
                <td><div class="admin-actions">
                  <button class="admin-btn sm ghost" data-act="open-profile" data-id="${u.id}">Profile</button>
                  ${isOwner && u.role !== 'owner' ? `
                    <button class="admin-btn sm danger" data-act="remove-staff" data-id="${u.id}" data-name="${esc(u.username)}">Revoke</button>` : ''}
                </div></td>
              </tr>`).join('')}</tbody>
          </table>` : '<div class="admin-empty">No staff accounts yet.</div>'}
        </div>
      </div>`;
  }

  // =======================================================================
  // Audit logs
  // =======================================================================
  async function renderAudit(main) {
    const tab = 'audit';
    const page = state.page[tab] || 1;
    const q = state.query[tab] || '';
    const action = (state.filter[tab] && state.filter[tab].action) || '';
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (action) params.set('action', action);

    const d = await api.get('/api/admin/audit?' + params.toString());
    state.page[tab] = d.page;

    const ACTIONS = ['', 'ban', 'verification', 'role', 'user', 'content', 'report', 'settings'];

    main.innerHTML = `
      ${head('Audit logs', 'Ban, verification, role, deletion, logout and settings changes.')}
      <div class="admin-toolbar">
        <input type="search" id="admin-search" placeholder="Search admin, target or reason…"
               value="${esc(q)}" autocomplete="off">
        <select data-filter="action">
          ${ACTIONS.map(a => `<option value="${a}" ${action === a ? 'selected' : ''}>${a || 'All actions'}</option>`).join('')}
        </select>
        <button class="admin-btn primary" data-act="search">Filter</button>
      </div>
      <div class="admin-card">
        <div class="admin-card-body tight">
          ${d.logs.length ? `
          <table class="admin-table">
            <thead><tr><th>Admin</th><th>Action</th><th>Target</th><th>Reason</th><th>IP</th><th>When</th></tr></thead>
            <tbody>${d.logs.map(l => `
              <tr>
                <td>${esc(l.admin_name)}</td>
                <td><span class="admin-chip">${esc(l.action)}</span></td>
                <td>${esc(l.target_label || (l.target_type ? `${l.target_type}#${l.target_id}` : '—'))}</td>
                <td class="excerpt">${esc(l.reason || '—')}</td>
                <td class="nowrap">${esc(l.ip || '—')}</td>
                <td class="nowrap">${timeCell(l.created_at)}</td>
              </tr>`).join('')}</tbody>
          </table>` : '<div class="admin-empty">No log entries match.</div>'}
        </div>
        ${d.total ? pager(d.total, tab, d.limit) : ''}
      </div>`;
  }

  // =======================================================================
  // Settings
  // =======================================================================
  async function renderSettings(main) {
    const d = await api.get('/api/admin/settings');
    const s = d.settings || {};
    const isOwner = state.me.role === 'owner';

    main.innerHTML = `
      ${head('Admin settings', isOwner ? 'Owner-only platform switches.' : 'Read-only for your role.')}
      <div class="admin-card">
        <div class="admin-card-body">
          <div class="admin-setting">
            <label for="set-notice">Site notice</label>
            <textarea id="set-notice" ${isOwner ? '' : 'disabled'}>${esc(s.site_notice || '')}</textarea>
            <div class="hint">Shown to moderators in the panel. Leave empty for none.</div>
          </div>

          <div class="admin-setting">
            <label>Verification</label>
            <label class="admin-toggle">
              <input type="checkbox" data-set="allow_moderator_verify" ${s.allow_moderator_verify === '1' ? 'checked' : ''} ${isOwner ? '' : 'disabled'}>
              Let moderators grant the verified badge
            </label>
          </div>

          <div class="admin-setting">
            <label>Reports</label>
            <label class="admin-toggle">
              <input type="checkbox" data-set="require_reports_before_ban" ${s.require_reports_before_ban === '1' ? 'checked' : ''} ${isOwner ? '' : 'disabled'}>
              Require an open report before banning (soft workflow rule)
            </label>
          </div>

          <div class="admin-setting">
            <label>Platform</label>
            <label class="admin-toggle">
              <input type="checkbox" data-set="maintenance_mode" ${s.maintenance_mode === '1' ? 'checked' : ''} ${isOwner ? '' : 'disabled'}>
              Maintenance mode flag (stored for the panel)
            </label>
          </div>

          ${isOwner ? '<button class="admin-btn primary" data-act="save-settings">Save settings</button>' : ''}
        </div>
      </div>`;
  }

  // =======================================================================
  // Dialog (confirmation + form) — the only modal this panel needs
  // =======================================================================
  let dialogState = null;

  function dialog(opts) {
    closeDialog();
    return new Promise((resolve) => {
      const fields = (opts.fields || []).map((f) => {
        if (f.type === 'select') {
          return `
            <div class="d-field">
              <label for="df-${f.name}">${esc(f.label)}</label>
              <select id="df-${f.name}" name="${f.name}">
                ${f.options.map(o => `<option value="${esc(o.v)}" ${o.v === f.value ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}
              </select>
            </div>`;
        }
        if (f.type === 'textarea') {
          return `
            <div class="d-field">
              <label for="df-${f.name}">${esc(f.label)}${f.required ? ' *' : ''}</label>
              <textarea id="df-${f.name}" name="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>
            </div>`;
        }
        return `
          <div class="d-field">
            <label for="df-${f.name}">${esc(f.label)}${f.required ? ' *' : ''}</label>
            <input id="df-${f.name}" name="${f.name}" type="${f.type || 'text'}"
                   value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"
                   autocomplete="off">
          </div>`;
      }).join('');

      const wrap = document.createElement('div');
      wrap.className = 'admin-dialog-wrap';
      wrap.innerHTML = `
        <div class="admin-dialog" role="dialog" aria-modal="true">
          <h3>${esc(opts.title)}</h3>
          <div class="d-body">
            ${opts.bodyHtml ? opts.bodyHtml : (opts.body ? `<p>${esc(opts.body)}</p>` : '')}
            ${fields}
          </div>
          <div class="d-error" id="d-error"></div>
          <div class="d-actions">
            <button class="admin-btn" data-d="cancel">Cancel</button>
            <button class="admin-btn ${opts.danger ? 'danger' : 'primary'}" data-d="ok">${esc(opts.submitLabel || 'Confirm')}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);

      const done = (value) => {
        closeDialog();
        resolve(value);
      };

      const readFields = () => {
        const out = {};
        $$('[name]', wrap).forEach(el => { out[el.name] = el.value; });
        return out;
      };

      $('[data-d="cancel"]', wrap).onclick = () => done(null);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
      const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done(null); } };
      document.addEventListener('keydown', onKey);

      $('[data-d="ok"]', wrap).onclick = () => {
        const values = readFields();
        for (const f of (opts.fields || [])) {
          if (f.required && !String(values[f.name] || '').trim()) {
            $('#d-error', wrap).textContent = `${f.label} is required.`;
            return;
          }
        }
        if (opts.confirmText && String(values[opts.confirmField] || '').trim() !== opts.confirmText) {
          $('#d-error', wrap).innerHTML = `Type <b>${esc(opts.confirmText)}</b> to continue.`;
          return;
        }
        document.removeEventListener('keydown', onKey);
        done(values);
      };

      dialogState = wrap;
      const first = $('input, select, textarea', wrap);
      if (first) first.focus();
    });
  }

  function closeDialog() {
    if (dialogState && dialogState.parentNode) dialogState.parentNode.removeChild(dialogState);
    dialogState = null;
  }

  // =======================================================================
  // Actions (delegated click handling on the panel)
  // =======================================================================
  const BAN_OPTIONS = [
    { v: '1h', l: '1 hour' },
    { v: '6h', l: '6 hours' },
    { v: '1d', l: '1 day' },
    { v: '3d', l: '3 days' },
    { v: '7d', l: '7 days' },
    { v: '30d', l: '30 days' },
    { v: 'custom', l: 'Custom…' },
    { v: 'permanent', l: 'Permanent' }
  ];

  function bindActions(root) {
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';

    const runSearch = () => {
      const el = $('#admin-search', root);
      state.query[state.tab] = el ? el.value.trim() : '';
      state.page[state.tab] = 1;
      renderTab();
    };

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.id === 'admin-search') {
        e.preventDefault();
        runSearch();
      }
    });

    root.addEventListener('change', (e) => {
      const sel = e.target.closest && e.target.closest('[data-filter]');
      if (!sel) return;
      state.filter[state.tab] = state.filter[state.tab] || {};
      state.filter[state.tab][sel.dataset.filter] = sel.value;
      state.page[state.tab] = 1;
      renderTab();
    });

    root.addEventListener('click', async (e) => {
      const pageBtn = e.target.closest('[data-page]');
      if (pageBtn && !pageBtn.disabled) {
        state.page[state.tab] = Math.max(1, parseInt(pageBtn.dataset.page, 10) || 1);
        renderTab();
        return;
      }
      const goto = e.target.closest('[data-goto]');
      if (goto) {
        state.tab = goto.dataset.goto;
        state.page[state.tab] = 1;
        renderNav();
        renderTab();
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;

      // Toolbar controls (not server actions)
      if (act === 'search') { runSearch(); return; }
      if (act === 'clear-search') {
        state.query[state.tab] = '';
        state.page[state.tab] = 1;
        renderTab();
        return;
      }

      if (state.busy) return;
      try {
        await runAction(act, { id: btn.dataset.id, name: btn.dataset.name || '', btn });
      } catch (err) {
        say(err.message || 'Action failed.', 'error');
      }
    });
  }

  async function runAction(act, ctx) {
    const { id, name, btn } = ctx;
    const where = name ? `"${name}"` : 'this item';
    state.busy = true;
    if (btn) btn.disabled = true;

    try {
      if (act === 'retry') { await renderTab(); return; }
      if (act === 'gologin') { window.location.href = '/'; return; }
      if (act === 'open-profile') {
        if (window.navigate) window.navigate('profile', id);
        return;
      }
      if (act === 'open-post') {
        if (window.navigate) window.navigate('post', id);
        return;
      }

      if (act === 'ban') {
        const v = await dialog({
          title: `Ban ${name}`,
          body: 'The account is signed out everywhere and blocked from login until the ban expires.',
          fields: [
            { name: 'duration', label: 'Duration', type: 'select', options: BAN_OPTIONS, value: '7d' },
            { name: 'customMinutes', label: 'Custom duration in minutes (used when "Custom" is picked)', type: 'text', placeholder: 'e.g. 120' },
            { name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Shown in the audit log' }
          ],
          submitLabel: 'Ban account',
          danger: true
        });
        if (!v) return;
        const body = { duration: v.duration, reason: v.reason.trim() };
        if (v.duration === 'custom') body.customMinutes = v.customMinutes;
        const r = await api.post(`/api/admin/users/${id}/ban`, body);
        say(`Banned ${name} · ${r.sessionsRevoked} session(s) revoked ✓`, 'success');
        await refresh(true);
        return;
      }

      if (act === 'unban') {
        const v = await dialog({
          title: `Unban ${name}`,
          body: 'The ban record stays in history; only the active restriction is lifted.',
          fields: [{ name: 'reason', label: 'Reason', type: 'textarea', placeholder: 'Optional' }],
          submitLabel: 'Unban'
        });
        if (!v) return;
        await api.post(`/api/admin/users/${id}/unban`, { reason: v.reason.trim() });
        say(`Unbanned ${name} ✓`, 'success');
        await refresh(true);
        return;
      }

      if (act === 'verify' || act === 'unverify') {
        const giving = act === 'verify';
        const v = await dialog({
          title: `${giving ? 'Grant' : 'Remove'} verified badge — ${name}`,
          body: 'Stored in users.is_verified; every page renders it automatically.',
          fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Why' }],
          submitLabel: giving ? 'Grant badge' : 'Remove badge'
        });
        if (!v) return;
        await api.post(`/api/admin/users/${id}/verify`, { verified: giving, reason: v.reason.trim() });
        say(`${giving ? 'Verified' : 'Unverified'} ${name} ✓`, 'success');
        await refresh(true);
        return;
      }

      if (act === 'force-logout') {
        const v = await dialog({
          title: `Sign ${name} out of every device`,
          body: 'Deletes all of their sessions; they must log in again.',
          fields: [{ name: 'reason', label: 'Reason', type: 'textarea', placeholder: 'Optional' }],
          submitLabel: 'Sign out devices'
        });
        if (!v) return;
        const r = await api.post(`/api/admin/users/${id}/logout`, { reason: v.reason.trim() });
        say(`Signed out ${r.sessionsRevoked} session(s) ✓`, 'success');
        return;
      }

      if (act === 'disable' || act === 'enable') {
        const disabling = act === 'disable';
        const v = await dialog({
          title: `${disabling ? 'Disable' : 'Enable'} ${name}`,
          body: disabling
            ? 'The account cannot log in until it is enabled again.'
            : 'The account becomes active and can log in again.',
          fields: [{ name: 'reason', label: 'Reason', type: 'textarea', placeholder: 'Optional' }],
          submitLabel: disabling ? 'Disable account' : 'Enable account',
          danger: disabling
        });
        if (!v) return;
        await api.post(`/api/admin/users/${id}/${disabling ? 'disable' : 'enable'}`, { reason: v.reason.trim() });
        say(`${disabling ? 'Disabled' : 'Enabled'} ${name} ✓`, 'success');
        await refresh(true);
        return;
      }

      if (act === 'delete-user') {
        const v = await dialog({
          title: `Delete ${name} permanently`,
          body: 'Posts, comments, likes and follows are removed with the account. This cannot be undone.',
          fields: [
            { name: 'reason', label: 'Reason', type: 'textarea', required: true },
            { name: 'confirm', label: 'Type DELETE to confirm', type: 'text', required: true }
          ],
          confirmText: 'DELETE',
          confirmField: 'confirm',
          submitLabel: 'Delete account',
          danger: true
        });
        if (!v) return;
        await api.del(`/api/admin/users/${id}`, { confirm: v.confirm, reason: v.reason.trim() });
        say(`Deleted ${name} ✓`, 'success');
        await refresh(true);
        return;
      }

      if (act === 'report-view') {
        const r = (state.reportsById || {})[id];
        const detail = r
          ? `<div class="d-field">
               <label>Target</label>
               <div>${esc(r.target_type)} #${r.target_id} · by ${esc(r.reporter)} · ${esc(r.status)}</div>
             </div>
             <div class="d-field"><label>Reason</label><div>${esc(r.reason)}</div></div>
             ${r.details ? `<div class="d-field"><label>Details</label><div>${esc(r.details)}</div></div>` : ''}
             ${r.target ? `<div class="d-field"><label>Content</label><div>${esc(r.target.label)}</div></div>` : ''}
             ${r.admin_notes ? `<div class="d-field"><label>Existing notes</label><div>${esc(r.admin_notes)}</div></div>` : ''}`
          : '<p>Report #' + esc(id) + '</p>';
        const v = await dialog({
          title: `Review report #${id}`,
          bodyHtml: detail,
          fields: [{ name: 'notes', label: 'Moderator notes', type: 'textarea', placeholder: 'Internal notes' }],
          submitLabel: r && r.status === 'open' ? 'Resolve' : 'Save notes'
        });
        if (!v) return;
        await api.patch(`/api/admin/reports/${id}`, {
          status: (r && r.status) || 'open',
          notes: v.notes ? v.notes.trim() : ''
        });
        say('Notes saved ✓', 'success');
        await refresh(true);
        return;
      }

      if (act === 'report-resolve' || act === 'report-reject') {
        const status = act === 'report-resolve' ? 'resolved' : act === 'report-reject' ? 'rejected' : null;
        const v = await dialog({
          title: `Report #${id}`,
          body: status ? 'Record your decision and any notes for the audit trail.' : 'Closing this review keeps the report as is.',
          fields: [
            { name: 'notes', label: 'Moderator notes', type: 'textarea', placeholder: 'Internal notes' },
            ...(status ? [{ name: 'resolution', label: 'Resolution summary', type: 'text', placeholder: 'What happened' }] : [])
          ],
          submitLabel: status ? (status === 'resolved' ? 'Mark resolved' : 'Reject report') : 'Close'
        });
        if (!v) return;
        await api.patch(`/api/admin/reports/${id}`, {
          status: status || 'open',
          notes: v.notes ? v.notes.trim() : '',
          resolution: v.resolution ? v.resolution.trim() : ''
        });
        say(status === 'resolved' ? 'Report resolved ✓' : status === 'rejected' ? 'Report rejected ✓' : 'Report kept open ✓', 'success');
        state.openReports = Math.max(0, state.openReports - (status ? 1 : 0));
        renderNav();
        await refresh(true);
        return;
      }

      if (act === 'delete-post' || act === 'delete-comment') {
        const isPost = act === 'delete-post';
        const v = await dialog({
          title: `Delete ${isPost ? 'post' : 'comment'} by ${name}`,
          body: 'It disappears for everyone immediately.',
          fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }],
          submitLabel: 'Delete',
          danger: true
        });
        if (!v) return;
        await api.del(`/api/admin/content/${isPost ? 'posts' : 'comments'}/${id}`, { reason: v.reason.trim() });
        say('Content removed ✓', 'success');
        await refresh(true);
        return;
      }

      if (act === 'add-staff') {
        const v = await dialog({
          title: 'Add staff member',
          body: 'Only Owner can do this. Search by username or paste a profile id.',
          fields: [
            { name: 'user', label: 'Username or user id', type: 'text', required: true },
            { name: 'role', label: 'Role', type: 'select', options: [
              { v: 'moderator', l: 'Moderator (reports + basic moderation)' },
              { v: 'admin', l: 'Admin (users, bans, content, verification)' }
            ], value: 'moderator' },
            { name: 'reason', label: 'Reason', type: 'textarea', placeholder: 'Optional' }
          ],
          submitLabel: 'Grant role'
        });
        if (!v) return;
        let userId = parseInt(v.user.trim(), 10);
        if (!Number.isInteger(userId)) {
          const found = await api.get('/api/admin/users?q=' + encodeURIComponent(v.user.trim()) + '&limit=1');
          const exact = (found.users || []).find(u => u.username.toLowerCase() === v.user.trim().toLowerCase()) || (found.users || [])[0];
          if (!exact) throw new Error('No user found for that search.');
          userId = exact.id;
        }
        await api.post('/api/admin/staff', { userId, role: v.role, reason: v.reason ? v.reason.trim() : '' });
        say('Role granted ✓', 'success');
        await refresh(true);
        return;
      }

      if (act === 'remove-staff') {
        const v = await dialog({
          title: `Revoke staff role from ${name}`,
          body: 'The account goes back to a normal user immediately.',
          fields: [{ name: 'reason', label: 'Reason', type: 'textarea', placeholder: 'Optional' }],
          submitLabel: 'Revoke role',
          danger: true
        });
        if (!v) return;
        await api.del(`/api/admin/staff/${id}`, { reason: v.reason ? v.reason.trim() : '' });
        say('Role revoked ✓', 'success');
        await refresh(true);
        return;
      }

      if (act === 'save-settings') {
        const mainEl = $('#admin-main');
        const noticeEl = $('#set-notice', mainEl || document);
        const patch = { site_notice: noticeEl ? noticeEl.value : '' };
        $$('[data-set]', mainEl || document).forEach(el => { patch[el.dataset.set] = el.checked ? '1' : '0'; });
        await api.put('/api/admin/settings', patch);
        say('Settings saved ✓', 'success');
        return;
      }
    } finally {
      state.busy = false;
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  // =======================================================================
  // Review dialog needs the report payload (fetch on demand)
  // =======================================================================
  // "report-review" is handled through the generic flow above; the panel
  // refreshes after every mutation so the table always shows server truth.

  async function refresh(reloadNav) {
    if (!state.mounted) return;
    if (reloadNav) loadOpenReportsCount();
    await renderTab();
  }

  // =======================================================================
  // Real-time admin updates (staff room, pushed by Socket.IO)
  // =======================================================================
  function onAdminEvent(ev) {
    if (!state.mounted) return;
    const label = {
      report: 'New report received',
      ban: `${ev.target || 'A user'} was banned`,
      unban: `${ev.target || 'A user'} was unbanned`,
      verify: `${ev.target || 'A user'} verified`,
      unverify: `Verification removed from ${ev.target || 'a user'}`,
      delete: `${ev.target || 'A user'} deleted`,
      role: 'A staff role changed',
      content: 'Content was removed'
    }[ev.type] || 'Admin data changed';

    if (window.sfx) window.sfx.play('notify');
    say(label, 'notify');
    refresh(true);
  }

  // Public surface used by app.js
  return { mount, unmount, onAdminEvent, _state: state, bindActions };
})();
