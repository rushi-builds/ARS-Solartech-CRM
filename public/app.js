'use strict';

/* ══════════════════════════════════════════════════════════════════
   ARS Solartech · Order to Dispatch — front end
   All authorisation is enforced by the Worker; this file only renders
   the capabilities the server hands it.
   ══════════════════════════════════════════════════════════════════ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const ESCMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESCMAP[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmt(d) {
  if (!d) return '—';
  const p = String(d).slice(0, 10).split('-');
  if (p.length !== 3) return esc(d);
  return `${p[2]} ${MON[+p[1] - 1]} ${p[0].slice(2)}`;
}
function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
function n1(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return '—';
  return String(Math.round(x * 10) / 10);
}
function initials(name, email) {
  const src = (name || email || '?').trim();
  const parts = src.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function clampPct(n) { return Math.max(0, Math.min(100, Math.round(n))); }

/* ── theme ─────────────────────────────────────────────────── */
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
function paintTheme() {
  const btn = $('#themeBtn');
  if (!btn) return;
  const light = currentTheme() === 'light';
  btn.innerHTML = light ? SUN : MOON;
  btn.title = light ? 'Switch to dark theme' : 'Switch to light theme';
}
function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('ars-theme', next); } catch { /* private mode */ }
  paintTheme();
}

/* ── top bar popovers ──────────────────────────────────────── */
function closePanels() {
  ['#notifPanel', '#accountMenu'].forEach((sel) => { const el = $(sel); if (el) el.hidden = true; });
}
function togglePanel(sel) {
  const el = $(sel);
  if (!el) return;
  const open = el.hidden;
  closePanels();
  el.hidden = !open;
}

/* ── icons ─────────────────────────────────────────────────── */
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  truck: '<rect x="1.5" y="6.5" width="12" height="9" rx="1.5"/><path d="M13.5 10h4l3 3v2.5h-7z"/><circle cx="6" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M17 5.2a3.2 3.2 0 0 1 0 6.1"/><path d="M18 14.6c2 .7 3 2.4 3 4.4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

/* ── state ─────────────────────────────────────────────────── */
const S = { d: null, view: 'dashboard', q: '', status: 'all', rag: 'all', stage: 'all', open: null };

/* The designated super admin account: always owner, never demotable. */
const SUPER_ADMIN_EMAIL = 'rushidhumal.04@gmail.com';
const FULL_ROLES = ['owner', 'admin', 'manager'];

const VIEWS = {
  dashboard: { title: 'Dashboard', sub: 'Live pipeline, overdue stages and plant load', icon: 'grid' },
  orders: { title: 'Orders', sub: 'Every order with its stage, forecast and buffer', icon: 'box' },
  dispatch: { title: 'Dispatch log', sub: 'Batches, vehicles, invoices and e-way bills', icon: 'truck' },
  capacity: { title: 'Capacity plan', sub: 'Working-day load against plant capacity', icon: 'chart' },
  users: { title: 'Users & roles', sub: 'Who can see what, and who can change it', icon: 'users' },
  settings: { title: 'Settings', sub: 'Durations, capacity, working days and department heads', icon: 'gear' },
  activity: { title: 'Activity', sub: 'Every change, who made it and when', icon: 'clock' },
};

/* ── API ───────────────────────────────────────────────────── */
async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.error;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}

function cap(action) {
  return !!(S.d && S.d.capabilities && S.d.capabilities[action]);
}

function apply(payload) {
  const snap = payload && payload.snapshot ? payload.snapshot : payload;
  if (snap && snap.me) { S.d = snap; saveCache(); }
}

/* ── cached snapshot ───────────────────────────────────────────
   Keeps Worker request usage low: a reload within CACHE_TTL renders
   the last snapshot from sessionStorage without touching the API.
   The refresh button and every mutation always hit the server. */
const CACHE_KEY = 'ars-snapshot-v1';
const CACHE_TTL = 5 * 60_000;

function saveCache() {
  try {
    if (S.d) sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), snap: S.d }));
  } catch { /* storage full or blocked - not fatal */ }
}

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.snap || !parsed.snap.me) return null;
    return { at: Number(parsed.at) || 0, snap: parsed.snap };
  } catch { return null; }
}

function clearCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}

function showGate(mode = 'login') {
  const setup = mode === 'setup';
  $('#gate').hidden = false;
  $('#shell').hidden = true;
  const loginForm = $('#loginForm');
  const setupForm = $('#setupForm');
  if (loginForm) loginForm.hidden = setup;
  if (setupForm) setupForm.hidden = !setup;
  closeModal();
  closeDrawer();
}

async function loadApp() {
  try {
    S.d = await api('/api/bootstrap');
    saveCache();
    render();
  } catch (e) {
    if (e.status === 401) { clearCache(); showGate(e.data && e.data.needsSetup ? 'setup' : 'login'); }
    else toast(e.message || 'Could not load data', 'err');
  }
}

function wireAuthForms() {
  const loginForm = $('#loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = loginForm.querySelector('button[type=submit]');
      const data = Object.fromEntries(new FormData(loginForm).entries());
      btn.disabled = true;
      try {
        const res = await api('/api/auth/login', 'POST', { email: data.email, password: data.password });
        loginForm.reset();
        apply(res);
        if (S.d && S.d.me) render(); else await loadApp();
        toast('Signed in', 'ok');
      } catch (e) {
        toast(e.message || 'Sign in failed', 'err');
      } finally {
        btn.disabled = false;
      }
    });
  }

  const setupForm = $('#setupForm');
  if (setupForm) {
    setupForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = setupForm.querySelector('button[type=submit]');
      const data = Object.fromEntries(new FormData(setupForm).entries());
      if (data.password !== data.password2) return toast('Passwords do not match', 'err');
      btn.disabled = true;
      try {
        const res = await api('/api/auth/setup', 'POST', { name: data.name, email: data.email, password: data.password });
        setupForm.reset();
        apply(res);
        render();
        toast('Admin account created', 'ok');
      } catch (e) {
        toast(e.message || 'Could not create the account', 'err');
      } finally {
        btn.disabled = false;
      }
    });
  }
}

/* ══════════════════════════════════════════════════════════════
   render
   ══════════════════════════════════════════════════════════════ */
function render() {
  if (!S.d) return;
  const me = S.d.me;
  const who = me.name || me.email || 'Signed in';
  const role = `${roleLabel(me.role)}${me.dept ? ' · ' + me.dept : ''}`;
  const abbr = initials(me.name, me.email);

  $('#gate').hidden = true;
  $('#shell').hidden = false;
  $('#whoName').textContent = who;
  $('#whoRole').textContent = role;
  $('#acctName').textContent = who;
  $('#acctRole').textContent = role;
  $('#acctEmail').textContent = me.email || '';
  $('#avatar').textContent = abbr;
  $('#acctAvatar').textContent = abbr;
  $('#todayPill').textContent = fmt(S.d.today);
  $('#todayPill').title = 'Data as of ' + fmt(S.d.today);
  const canUsers = cap('users') || cap('settings');
  $('#menuUsers').hidden = !canUsers;
  $('#menuSettings').hidden = !cap('settings') && !cap('users');
  const menuAccess = $('#menuAccess');
  if (menuAccess) menuAccess.hidden = cap('users');
  renderNotifs();

  renderNav();

  const meta = VIEWS[S.view] ? VIEWS[S.view] : VIEWS.dashboard;
  $('#pageTitle').textContent = meta.title;
  $('#pageSub').textContent = meta.sub;

  const html = ({
    dashboard: viewDashboard,
    orders: viewOrders,
    dispatch: viewDispatch,
    capacity: viewCapacity,
    users: viewUsers,
    settings: viewSettings,
    activity: viewActivity,
  })[S.view]();
  const viewEl = $('#view');
  viewEl.innerHTML = html;
  viewEl.classList.remove('enter');
  void viewEl.offsetWidth;
  viewEl.classList.add('enter');

  if (S.open) openDrawer(S.open, true);
}

function renderNotifs() {
  const list = $('#notifList');
  if (!list) return;
  const k = S.d.dashboard.kpis;
  const attention = (S.d.dashboard.attention || []).slice(0, 6);
  const reqs = S.d.accessRequests || [];
  const pending = reqs.filter((r) => r.status === 'pending');
  const canDecide = cap('users');
  const parts = [];

  if (pending.length && canDecide) {
    parts.push(`<div class="pop-section">Access requests · ${pending.length}</div>`);
    parts.push(pending.map((r) => `<div class="notif-item blue static">
      <span class="n-dot"></span>
      <span>
        <span class="n-title">${esc(r.name || r.email || 'User')}</span>
        <span class="n-sub">${esc(reqAsk(r))}${r.note ? ' · ' + esc(r.note) : ''}</span>
        <span class="req-actions">
          <button class="btn primary small" data-act="req-approve" data-id="${esc(r.id)}">Approve</button>
          <button class="btn ghost small" data-act="req-deny" data-id="${esc(r.id)}">Deny</button>
        </span>
      </span>
    </div>`).join(''));
  } else if (pending.length) {
    parts.push('<div class="pop-section">Your request</div>');
    parts.push(pending.map((r) => `<div class="notif-item amber static">
      <span class="n-dot"></span>
      <span><span class="n-title">Waiting for approval</span>
      <span class="n-sub">${esc(reqAsk(r))} · sent ${fmt(String(r.created_at).slice(0, 10))}</span></span>
    </div>`).join(''));
  }

  const me = S.d.me;
  const mine = [];
  for (const o of S.d.orders) {
    if (o.live.rag === 'CLOSED') continue;
    for (const key of Object.keys(o.asg || {})) {
      const who = o.asg[key];
      if (who && who.sub === me.sub && !(o.a || {})[key]) { mine.push({ o, key }); break; }
    }
  }
  if (mine.length) {
    parts.push(`<div class="pop-section">Your work · ${mine.length}</div>`);
    parts.push(mine.map(({ o, key }) => {
      const meta = (S.d.meta.stages || []).find((s) => s.key === key) || {};
      const due = o.live.plan ? o.live.plan[key] : null;
      const late = due ? Math.max(0, Math.round((Date.parse(S.d.today) - Date.parse(due)) / 86400000)) : 0;
      return `<button class="notif-item blue" data-act="open-order" data-id="${esc(o.id)}">
        <span class="n-dot"></span>
        <span><span class="n-title">${esc(o.customer || o.id)}</span>
        <span class="n-sub">${esc(meta.label || key)} · ${late > 0 ? late + ' day' + (late === 1 ? '' : 's') + ' late' : 'plan ' + fmt(due)}</span></span>
      </button>`;
    }).join(''));
  }
  const awaiting = FULL_ROLES.includes(me.role)
    ? S.d.orders.filter((o) => o.live.rag === 'CLOSED' && o.approval !== 'approved')
    : [];
  if (awaiting.length) {
    parts.push(`<div class="pop-section">Final approval · ${awaiting.length}</div>`);
    parts.push(awaiting.map((o) => `<div class="notif-item green static">
      <span class="n-dot"></span>
      <span><span class="n-title">${esc(o.customer || o.id)}</span>
      <span class="n-sub">Every department is done — sign off to close</span>
      <span class="req-actions">
        <button class="btn primary small" data-act="approve-order" data-id="${esc(o.id)}">Approve</button>
        <button class="btn ghost small" data-act="open-order" data-id="${esc(o.id)}">Open</button>
      </span></span>
    </div>`).join(''));
  }

  parts.push('<div class="pop-section">Pipeline alerts</div>');
  parts.push(attention.length
    ? attention.map((a) => {
      const tone = a.daysOverdue > 0 || a.rag === 'RED' ? 'red' : 'amber';
      const sub = a.daysOverdue > 0
        ? `${a.daysOverdue} day${a.daysOverdue === 1 ? '' : 's'} overdue · ${a.stage}`
        : `Waiting on ${a.withWhom || a.stage}`;
      return `<button class="notif-item ${tone}" data-act="open-order" data-id="${esc(a.id)}">
        <span class="n-dot"></span>
        <span><span class="n-title">${esc(a.customer || a.id)}</span><span class="n-sub">${esc(sub)}</span></span>
      </button>`;
    }).join('')
    : '<div class="pop-empty">You are all caught up. No stage is past its planned date.</div>');

  list.innerHTML = parts.join('');
  const badge = $('#notifCount');
  const total = attention.length + (canDecide ? pending.length : 0) + mine.length + awaiting.length;
  if (badge) { badge.textContent = total; badge.hidden = !total; }
  const sub = $('#notifSub');
  if (sub) {
    const bits = [];
    if (mine.length) bits.push(`${mine.length} task${mine.length === 1 ? '' : 's'} for you`);
    if (awaiting.length) bits.push(`${awaiting.length} to approve`);
    if (pending.length) bits.push(`${pending.length} request${pending.length === 1 ? '' : 's'}`);
    bits.push(`${k.overdue} stage${k.overdue === 1 ? '' : 's'} late`);
    sub.textContent = bits.join(' · ');
  }
}

function reqAsk(r) {
  const bits = [];
  if (r.ask_role) bits.push(roleLabel(r.ask_role));
  if (r.ask_dept) bits.push(r.ask_dept);
  return bits.length ? 'Wants ' + bits.join(' · ') : 'Requested access';
}

function renderNav() {
  const items = [
    { id: 'dashboard' }, { id: 'orders' }, { id: 'dispatch' }, { id: 'capacity' },
    { sep: 'Administration' },
    { id: 'users', hide: !cap('users') && !cap('settings') },
    { id: 'settings', hide: !cap('settings') && !cap('users') },
    { id: 'activity' },
  ];
  $('#nav').innerHTML = items.map((it) => {
    if (it.sep) return `<div class="nav-sep">${esc(it.sep)}</div>`;
    const v = VIEWS[it.id];
    return `<a href="#/${it.id}" class="${S.view === it.id ? 'active' : ''}" ${it.hide ? 'hidden' : ''}>
      ${icon(v.icon)}<span class="lbl">${esc(v.title)}</span></a>`;
  }).join('');
}

function roleLabel(role) {
  return ({ owner: 'Admin', admin: 'Admin', manager: 'Manager', editor: 'Editor', viewer: 'Viewer' })[role] || role || 'Viewer';
}

/* Owner and Admin are the same full control; the dropdown says "Owner · Admin"
   so the two rows stay distinguishable while every label still reads Admin. */
function roleOptionLabel(role) {
  return role === 'owner' ? 'Owner · Admin' : roleLabel(role);
}

function greeting() {
  const me = (S.d && S.d.me) || {};
  const first = String(me.name || me.email || '').split(/[\s@.]/).filter(Boolean)[0] || 'there';
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${esc(first)}`;
}

function ragBadge(rag) {
  const cls = rag === 'RED' ? 'red' : rag === 'AMBER' ? 'amber' : rag === 'GREEN' ? 'green' : 'grey';
  const label = ({ RED: 'Late', AMBER: 'At risk', GREEN: 'On track', CLOSED: 'Closed', 'NOT PLANNED': 'Not planned' })[rag] || rag;
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

/* ── dashboard ─────────────────────────────────────────────── */
function viewDashboard() {
  const d = S.d;
  const k = d.dashboard.kpis;
  const cap8 = d.dashboard.capacity.slice(0, 8);
  const stages = d.dashboard.byStage;
  const attention = d.dashboard.attention;

  const top = stages.reduce((a, b) => (b.count > a.count ? b : a), stages[0] || { count: 0, stage: '—' });
  const peak = Math.max(1, ...stages.map((s) => s.count));
  const heroStats = [
    ['Open orders', String(k.active)],
    ['Balance', `${n1(k.balanceMt)} MT`],
    ['Late stages', String(k.overdue)],
  ];

  return `
  <section class="hero">
    <div class="hero-copy">
      <p class="h-eyebrow">Operations control tower</p>
      <h2 class="h-title">${greeting()}</h2>
      <p class="h-sub">${k.active} live order${k.active === 1 ? '' : 's'} · bottleneck at <strong>${esc(top.stage || '—')}</strong> · ${n1(k.balanceMt)} MT still to dispatch</p>
    </div>
    <div class="h-stats">
      ${heroStats.map(([l, v]) => `<div class="h-stat"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join('')}
    </div>
  </section>

  <div class="grid cols-4">
    ${kpiTile('Active orders', k.active, `${n1(k.activeMt)} MT in the pipeline`, 'accent', 'open orders')}
    ${kpiTile('Late', k.red, 'forecast misses the due date', 'red', 'past due')}
    ${kpiTile('Delayed', k.overdue, 'stages past their planned date', 'amber', 'past plan')}
    ${kpiTile('On track', k.green, `${k.closed} dispatched / closed`, 'green', 'on schedule')}
  </div>

  <div class="card" style="margin-top:14px">
      <div class="card-head">
        <div class="lead">
          <span class="head-ico grey">${icon('chart')}</span>
          <div><p class="h-eyebrow">Flow</p><h3>Pipeline by department</h3></div>
        </div>
        <span class="hint">${k.active} active · bottleneck: ${esc(top.stage || '—')}</span>
      </div>
      <div class="flow">
        ${stages.map((s) => {
          const w = clampPct((s.count / peak) * 100);
          return `<button class="flow-node ${s.count ? 'active' : ''}" type="button" data-act="open-stage" data-stage="${s.no}" title="Show ${esc(s.stage)} orders">
            <span class="fn-top"><span class="fn-no">${s.no}</span><span class="fn-count">${s.count}</span></span>
            <span class="fn-name">${esc(s.stage)}</span>
            <span class="fn-dept">${esc(s.dept)}</span>
            <span class="fn-bar"><i style="width:${w}%"></i></span>
            <span class="fn-mt">${n1(s.mt)} MT${s.head ? ' · ' + esc(s.head) : ''}</span>
          </button>`;
        }).join('')}
      </div>
  </div>

  <div class="split" style="margin-top:14px">
    <div class="card">
      <div class="card-head">
        <div class="lead">
          <span class="head-ico grey">${icon('clock')}</span>
          <div><p class="h-eyebrow">Attention</p><h3>Needs attention</h3></div>
        </div>
        <span class="hint">${k.sopAlerts} SOP flag${k.sopAlerts === 1 ? '' : 's'}</span>
      </div>
      ${attention.length ? `
      <div class="risk-list">
        ${attention.map((a) => `
          <div class="risk-row ${a.daysOverdue > 0 || a.rag === 'RED' ? 'bad' : 'warn'}" data-act="open-order" data-id="${esc(a.id)}" title="${esc(a.id)} · ${esc(a.stage)}">
            <span class="rail"></span>
            <span class="risk-main">
              <span class="risk-name">${esc(a.customer || a.id)}</span>
              <span class="risk-meta">${esc(a.stage)}${a.withWhom ? ' · ' + esc(a.withWhom) : ''}</span>
            </span>
            <span class="risk-end">
              ${a.daysOverdue > 0 ? `<b class="risk-days">+${a.daysOverdue}d</b>` : ragBadge(a.rag)}
              <small>${fmt(a.forecast)}</small>
            </span>
          </div>`).join('')}
      </div>` : `<div class="empty">Nothing is late. Every stage is inside its planned date.</div>`}
    </div>
  </div>

    <div class="col-stack">
    <div class="card tight">
      <div class="card-head"><div class="lead"><span class="head-ico">${icon('box')}</span><div><p class="h-eyebrow">Shortcuts</p><h3>Quick actions</h3></div></div></div>
      <div class="action-grid">
        <button class="action-tile" data-act="new-order" ${cap('order') ? '' : 'disabled'}>
          <span class="ai">${icon('box')}</span><span><strong>New order</strong><small>From a customer PO</small></span>
        </button>
        <button class="action-tile" data-act="new-dispatch" ${cap('disp') ? '' : 'disabled'}>
          <span class="ai">${icon('truck')}</span><span><strong>Dispatch entry</strong><small>Batch, vehicle, invoice</small></span>
        </button>
        <button class="action-tile" data-act="import">
          <span class="ai">${icon('chart')}</span><span><strong>Import sheet</strong><small>Excel or CSV</small></span>
        </button>
        <button class="action-tile" data-act="export">
          <span class="ai">${icon('clock')}</span><span><strong>Export</strong><small>Orders + dispatches</small></span>
        </button>
      </div>
      <p class="sub-line" style="margin-top:12px">Balance to dispatch: <strong style="color:var(--text)">${n1(k.balanceMt)} MT</strong> across ${k.active} open orders.</p>
    </div>
    <div class="card tight">
      <div class="card-head"><div class="lead"><span class="head-ico grey">${icon('users')}</span><div><p class="h-eyebrow">Signed in as</p><h3>Your access</h3></div></div><span class="hint">${roleLabel(S.d.me.role)}</span></div>
      <div class="inline">
        ${Object.entries(S.d.capabilities).filter(([, v]) => v).map(([a]) => `<span class="badge blue">${esc(actionLabel(a))}</span>`).join('') || '<span class="sub-line">View only — ask an admin for a department.</span>'}
      </div>
      ${FULL_ROLES.includes(S.d.me.role)
        ? '<p class="sub-line" style="margin-top:11px">Full control · you can change anyone\'s role from Users &amp; roles.</p>'
        : '<button class="btn ghost small" data-act="request-access" style="margin-top:11px">Request more access</button>'}
    </div>
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('chart')}</span>
        <div><p class="h-eyebrow">Load</p><h3>Capacity · next 8 weeks</h3></div>
      </div>
      <a class="btn ghost small" href="#/capacity">Open plan</a>
    </div>
    <div class="week-grid">
      ${cap8.map((w) => capTile(w)).join('')}
    </div>
  </div>`;
}

function kpiTile(label, value, foot, tone, hint) {
  return `<div class="card kpi ${tone}">
    <div class="k-top"><span class="k-label">${esc(label)}</span><span class="k-dot"></span></div>
    <div class="k-value">${value}</div>
    <div class="k-foot">${esc(foot)}</div>
    ${hint ? `<span class="k-tag">${esc(hint)}</span>` : ''}
  </div>`;
}

function actionLabel(a) {
  return ({
    order: 'Orders', ovr: 'Overrides', settings: 'Settings', users: 'Users', delete: 'Delete',
    des: 'Design done', apr: 'Approval', mat: 'Materials', ps: 'Production start', pf: 'Production done',
    qc: 'QC', dsp: 'Dispatch ready', disp: 'Dispatch log',
  })[a] || a;
}

function capTile(w) {
  const pct = clampPct(w.utilisation * 100);
  const cls = w.status === 'OVERLOADED' ? 'over' : w.status === 'HIGH' ? 'warn' : '';
  return `<div class="week-tile ${cls}" title="${fmt(w.start)} – ${fmt(w.end)} · ${pct}% utilised">
    <span class="wk">${fmt(w.start).replace(/ \d{2}$/, '')}</span>
    <b>${pct}%</b>
    <div class="wt-bar"><i style="width:${pct}%"></i></div>
    <em>${n1(w.loadMt)}/${n1(w.capacityMt)} MT</em>
  </div>`;
}

/* ── orders ────────────────────────────────────────────────── */
function filteredOrders() {
  const q = S.q.trim().toLowerCase();
  return S.d.orders.filter((o) => {
    if (S.status !== 'all' && (o.status || 'open') !== S.status) return false;
    if (S.rag !== 'all' && o.live.rag !== S.rag) return false;
    if (S.stage !== 'all' && String(o.live.stageNo) !== S.stage) return false;
    if (!q) return true;
    return [o.id, o.customer, o.project, o.sales_owner, o.remarks].filter(Boolean).join(' ').toLowerCase().includes(q);
  });
}

function viewOrders() {
  const rows = filteredOrders();
  const open = rows.filter((o) => o.live.rag !== 'CLOSED');
  const mt = open.reduce((s, o) => s + (o.mt || 0), 0);

  return `
  <div class="card flush">
    <div class="toolbar">
    <input class="search" id="q" placeholder="Search customer, project, order no…" value="${esc(S.q)}" />
    <select id="fStatus">
      ${opt('all', 'All status', S.status)}${opt('open', 'Open', S.status)}${opt('closed', 'Closed', S.status)}${opt('cancelled', 'Cancelled', S.status)}
    </select>
    <select id="fRag">
      ${opt('all', 'Any timeline', S.rag)}${opt('RED', 'Late', S.rag)}${opt('AMBER', 'At risk', S.rag)}${opt('GREEN', 'On track', S.rag)}${opt('CLOSED', 'Closed', S.rag)}
    </select>
    <select id="fStage">
      ${opt('all', 'Any stage', S.stage)}
      ${S.d.meta.stages.filter((s, i, a) => s.no <= 6 && a.findIndex((x) => x.no === s.no) === i)
        .map((s) => opt(String(s.no), s.no + ' · ' + s.name, S.stage)).join('')}
    </select>
    <span class="pill">${rows.length} shown</span>
    <span style="flex:1"></span>
    <button class="btn ghost small" data-act="import">Import</button>
    <button class="btn ghost small" data-act="export">Export</button>
    <button class="btn primary small" data-act="new-order" ${cap('order') ? '' : 'disabled'}>+ New order</button>
    </div>

    <div class="card-head">
      <div class="lead">
        <span class="head-ico">${icon('box')}</span>
        <div>
          <p class="h-eyebrow">Order book</p>
          <h3>${rows.length} order${rows.length === 1 ? '' : 's'}</h3>
        </div>
      </div>
      <div class="strip">
        <span><b>${n1(mt)}</b> MT to dispatch</span>
        <span><b>${open.length}</b> open</span>
        <span><b>${rows.filter((o) => o.live.rag === 'RED').length}</b> late</span>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Order</th><th>Customer / project</th><th class="num">MT</th><th>Confirmed</th><th>Due</th>
          <th>With whom</th><th>Forecast dispatch</th><th class="num">Buffer</th><th>Progress</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map(orderRow).join('') : `<tr><td colspan="10" class="empty">No orders match this filter.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

function opt(value, label, current) {
  return `<option value="${esc(value)}" ${String(current) === String(value) ? 'selected' : ''}>${esc(label)}</option>`;
}

function bufferCell(o) {
  if (o.live.rag === 'CLOSED') return '<span class="badge green">Closed</span>';
  const b = o.live.bufferDays;
  if (b === null) return '<span class="sub-line">—</span>';
  if (b < 0) return `<span class="badge red">${b}d</span>`;
  if (b < (S.d.settings.tight || 3)) return `<span class="badge amber">${b}d</span>`;
  return `<span class="badge green">${b}d</span>`;
}

function stageDots(o) {
  const done = clampPct((o.live.progress / 100) * 7) / 100 * 7;
  const n = Math.round(done);
  return `<span class="dots" title="${n} of 7 milestones done">${
    Array.from({ length: 7 }, (_, i) => `<i class="${i < n ? 'on' : i === n && o.live.stageNo <= 6 ? 'now' : ''}"></i>`).join('')
  }</span>`;
}

function orderRow(o) {
  const pct = clampPct(o.live.progress);
  return `<tr class="clickable" data-act="open-order" data-id="${esc(o.id)}">
    <td><div class="cell-id"><span class="mono">${esc(o.id)}</span>${stageDots(o)}</div>${o.live.sopFlag ? '<small class="sub-line" style="color:#ffb47a">SOP flag</small>' : ''}</td>
    <td><span class="cust">${esc(o.customer || '—')}</span><small class="sub-line">${esc(o.project || '')}</small></td>
    <td class="num">${n1(o.mt)}<small class="sub-line" style="text-align:right">MT</small></td>
    <td>${fmt(o.conf_date)}</td>
    <td>${fmt(o.due_date)}</td>
    <td><span class="cust">${esc(o.live.stage)}</span><small class="sub-line">${esc(o.live.dept)}${o.live.head ? ' · ' + esc(o.live.head) : ''}</small></td>
    <td>${fmt(o.live.forecastDispatch)}</td>
    <td class="num">${bufferCell(o)}</td>
    <td><span class="prog"><span class="bar blue"><i style="width:${pct}%"></i></span><b>${pct}%</b></span></td>
    <td>${ragBadge(o.live.rag)}${o.live.rag === 'CLOSED' && o.approval !== 'approved' ? '<small class="sub-line">approval pending</small>' : ''}</td>
  </tr>`;
}

/* ── order drawer ──────────────────────────────────────────── */
function openDrawer(id, silent) {
  const o = S.d.orders.find((x) => x.id === id);
  if (!o) return;
  S.open = id;
  const host = $('#drawer');
  const plan = o.live.plan;
  const stages = S.d.meta.stages;
  const disp = S.d.dispatches.filter((x) => x.order_id === id);

  host.innerHTML = `
  <div class="drawer-backdrop" data-drawer-close></div>
  <div class="drawer-panel">
    <div class="drawer-head">
      <div>
        <h3>${esc(o.customer || o.id)}</h3>
        <p class="sub"><span class="mono">${esc(o.id)}</span> · ${esc(o.project || 'No project')} ${S.d.meta ? '' : ''}</p>
      </div>
      <button class="icon-btn" data-act="close-drawer" title="Close">×</button>
    </div>

    <div class="inline" style="margin-bottom:16px">
      ${ragBadge(o.live.rag)}
      <span class="badge grey">${esc(o.live.stage)}</span>
      ${o.live.sopFlag ? `<span class="badge amber">${esc(o.live.sopFlag)}</span>` : ''}
    </div>

    ${o.live.rag === 'CLOSED'
      ? (o.approval === 'approved'
        ? `<div class="card tight" style="margin-bottom:14px;border-color:rgba(74,222,128,.35)">
             <b>Final approval given</b>
             <p class="sub-line" style="margin-top:4px">All departments finished and an admin signed off${o.approved_at ? ' on ' + fmt(String(o.approved_at).slice(0, 10)) : ''}.</p>
           </div>`
        : `<div class="card tight" style="margin-bottom:14px;border-color:rgba(251,191,36,.4)">
             <b>Waiting for final approval</b>
             <p class="sub-line" style="margin-top:4px">Every department has finished. Owner / Admin / Manager signs off to close the order.</p>
             <div class="inline" style="margin-top:10px">
               ${FULL_ROLES.includes(S.d.me.role)
                 ? `<button class="btn primary small" data-act="approve-order" data-id="${esc(o.id)}">Give final approval</button>`
                 : '<span class="sub-line">Asked from the admin</span>'}
             </div>
           </div>`)
      : ''}

    <div class="card tight" style="margin-bottom:14px">
      <div class="kv">
        <div><div class="k">Quantity</div><div class="v">${n1(o.mt)} MT</div></div>
        <div><div class="k">Capacity</div><div class="v">${n1(o.kwp)} kWp</div></div>
        <div><div class="k">Structure</div><div class="v">${esc(o.structure_type || '—')}</div></div>
        <div><div class="k">PO date</div><div class="v">${fmt(o.po_date)}</div></div>
        <div><div class="k">Confirmed</div><div class="v">${fmt(o.conf_date)}</div></div>
        <div><div class="k">Customer due</div><div class="v">${fmt(o.due_date)}</div></div>
        <div><div class="k">Forecast dispatch</div><div class="v">${fmt(o.live.forecastDispatch)}</div></div>
        <div><div class="k">Dispatched</div><div class="v">${n1(o.live.dispatchedMt)} / ${n1(o.mt)} MT</div></div>
        <div><div class="k">Priority</div><div class="v">${esc(o.priority || '—')}</div></div>
      </div>
    </div>

    <div class="card-head" style="margin-bottom:10px">
      <h3>Stages</h3>
      <span class="hint">${o.live.daysOverdue > 0 ? `${o.live.daysOverdue} day(s) overdue at ${esc(o.live.stage)}` : 'On schedule'}</span>
    </div>
    <div class="stage-list">
      ${stages.map((m) => stageRowHtml(o, m, plan)).join('')}
    </div>

    <div class="card-head" style="margin:22px 0 10px">
      <h3>Dispatches</h3>
      <button class="btn small" data-act="new-dispatch" data-order="${esc(o.id)}" ${cap('disp') ? '' : 'disabled'}>+ Add</button>
    </div>
    ${disp.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Batch</th><th class="num">MT</th><th>Actual</th><th>Invoice</th><th>Vehicle</th><th></th></tr></thead>
        <tbody>${disp.map((x) => `
          <tr>
            <td>${esc(x.batch || '—')}</td>
            <td class="num">${n1(x.qty)}</td>
            <td>${fmt(x.adate)}</td>
            <td>${esc(x.invoice || '—')}</td>
            <td>${esc(x.vehicle || '—')}</td>
            <td class="num">${cap('delete') ? `<button class="icon-btn" data-act="del-dispatch" data-id="${esc(x.id)}" title="Delete">×</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty">No dispatch recorded yet.</div>`}

    ${o.remarks ? `<div class="card tight" style="margin-top:14px"><div class="k" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.9px;color:var(--dim);font-weight:700">Remarks</div><p style="margin-top:6px;font-size:13px;color:#c9d2e4;line-height:1.55">${esc(o.remarks)}</p></div>` : ''}

    <div class="card-head" style="margin:22px 0 10px"><h3>Overrides used</h3></div>
    <div class="kv" style="grid-template-columns:repeat(3,1fr)">
      <div><div class="k">Design days</div><div class="v">${o.o_des ?? S.d.settings.dur.des}</div></div>
      <div><div class="k">Procurement days</div><div class="v">${o.o_pro ?? S.d.settings.dur.pro}</div></div>
      <div><div class="k">Production days</div><div class="v">${o.o_prd ?? (plan ? plan.prodDays : '—')}</div></div>
    </div>

    <div class="form-actions" style="margin-top:22px">
      ${cap('delete') ? `<button class="btn danger small" data-act="delete-order" data-id="${esc(o.id)}">Delete order</button>` : ''}
      <span style="flex:1"></span>
      <button class="btn ghost small" data-act="close-drawer">Close</button>
      ${cap('order') ? `<button class="btn primary small" data-act="edit-order" data-id="${esc(o.id)}">Edit order</button>` : ''}
    </div>
  </div>`;

  requestAnimationFrame(() => host.classList.add('open'));
  $$('[data-drawer-close]', host).forEach((el) => el.addEventListener('click', closeDrawer));
  if (!silent) return;
}

function stageRowHtml(o, m, plan) {
  const actual = o.a ? o.a[m.key] : null;
  const planned = plan ? plan[m.key] : null;
  const allowed = cap(m.key);
  const team = (S.d.deptPeople || []).filter((p) => p.dept === m.dept && p.sub);
  const asg = (o.asg || {})[m.key] || {};
  const by = (o.verif || {})[m.key] || {};
  const mine = asg.sub && asg.sub === S.d.me.sub;
  const full = FULL_ROLES.includes(S.d.me.role);
  const canDo = !!allowed && (!asg.sub || mine || full);
  const current = !actual && o.live.stageNo === m.no;
  return `<div class="stage-row ${actual ? 'done' : ''} ${current ? 'current' : ''}">
    <div class="stage-no">${actual ? '✓' : m.no}</div>
    <div>
      <div class="stage-name">${esc(m.actual)}</div>
      <div class="stage-meta">${esc(m.label)} · ${esc(m.dept)}${planned ? ' · plan ' + fmt(planned) : ''}${asg.name ? ' · ' + esc(asg.name) : ''}</div>
    </div>
    <div class="stage-act">
      ${actual
        ? `<span class="badge green">${fmt(actual)}</span>${by.name ? `<small class="sub-line">by ${esc(by.name)}</small>` : ''}${allowed ? `<button class="btn ghost small" data-act="stage-clear" data-id="${esc(o.id)}" data-stage="${m.key}">Undo</button>` : ''}`
        : `<div class="stage-assign">
             ${allowed
               ? `<select class="role-input" data-assign-stage="${m.key}" data-order="${esc(o.id)}">
                    <option value="" ${asg.sub ? '' : 'selected'}>Who works this?</option>
                    ${team.map((p) => `<option value="${esc(p.sub)}" ${asg.sub === p.sub ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}
                  </select>`
               : (asg.name ? `<span class="sub-line">${esc(asg.name)}</span>` : `<span class="sub-line">${esc(m.dept)} only</span>`)}
             ${canDo
               ? `<input type="date" data-stage-input="${m.key}" value="${S.d.today}" />
                  <button class="btn small" data-act="stage-set" data-id="${esc(o.id)}" data-stage="${m.key}">Mark done</button>`
               : asg.name ? `<span class="sub-line">${esc(asg.name)} marks it</span>` : ''}
           </div>`}
    </div>
  </div>`;
}

function closeDrawer() {
  S.open = null;
  const host = $('#drawer');
  host.classList.remove('open');
  host.innerHTML = '';
}

/* ── dispatch log ──────────────────────────────────────────── */
function viewDispatch() {
  const rows = S.d.dispatches;
  const mt = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const pending = rows.filter((r) => !r.adate).length;
  const byOrder = new Map(S.d.orders.map((o) => [o.id, o]));

  return `
  <div class="grid cols-4">
    ${kpiTile('Dispatch entries', rows.length, 'batches recorded', 'accent')}
    ${kpiTile('Quantity', n1(mt), 'MT dispatched in total', 'green')}
    ${kpiTile('In transit', pending, 'without an actual date', 'amber')}
    ${kpiTile('Orders covered', new Set(rows.map((r) => r.order_id)).size, 'at least one dispatch', 'blue')}
  </div>

  <div class="card flush" style="margin-top:14px">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('truck')}</span>
        <div><p class="h-eyebrow">Logistics</p><h3>Dispatch log</h3></div>
      </div>
      <div class="inline">
        <div class="strip">
          <span><b>${rows.length}</b> entries</span>
          <span><b>${n1(mt)}</b> MT</span>
          <span><b>${pending}</b> pending</span>
        </div>
        <button class="btn ghost small" data-act="export">Export CSV</button>
        <button class="btn primary small" data-act="new-dispatch" ${cap('disp') ? '' : 'disabled'}>+ Dispatch entry</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Dispatch</th><th>Order</th><th>Customer</th><th class="num">MT</th><th>Planned</th><th>Actual</th>
          <th>Vehicle</th><th>Transporter</th><th>Invoice</th><th>E-way</th><th>LR</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map((r) => {
            const o = byOrder.get(r.order_id);
            return `<tr>
              <td><span class="mono">${esc(r.id)}</span>${r.batch ? `<small class="sub-line">${esc(r.batch)}</small>` : ''}</td>
              <td><span class="mono" style="color:var(--accent)">${esc(r.order_id)}</span></td>
              <td>${esc(o ? o.customer : '—')}</td>
              <td class="num">${n1(r.qty)}</td>
              <td>${fmt(r.pdate)}</td>
              <td>${r.adate ? fmt(r.adate) : '<span class="badge amber">pending</span>'}</td>
              <td>${esc(r.vehicle || '—')}</td>
              <td>${esc(r.transporter || '—')}</td>
              <td>${esc(r.invoice || '—')}</td>
              <td>${esc(r.eway || '—')}</td>
              <td>${esc(r.lr || '—')}</td>
              <td class="num">${cap('delete') ? `<button class="icon-btn" data-act="del-dispatch" data-id="${esc(r.id)}" title="Delete">×</button>` : ''}</td>
            </tr>`;
          }).join('') : `<tr><td colspan="12" class="empty">No dispatch entries yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ── capacity ──────────────────────────────────────────────── */
function viewCapacity() {
  const weeks = S.d.dashboard.capacity;
  const overload = weeks.filter((w) => w.status === 'OVERLOADED').length;
  const free = weeks.reduce((s, w) => s + Math.max(0, w.freeMt), 0);

  return `
  <div class="grid cols-4">
    ${kpiTile('Weeks shown', weeks.length, 'rolling 16-week window', 'accent')}
    ${kpiTile('Overloaded', overload, 'weeks above plant capacity', overload ? 'red' : 'green')}
    ${kpiTile('Free capacity', n1(free), 'MT available in the window', 'green')}
    ${kpiTile('Daily capacity', n1(S.d.settings.cap), 'MT per working day', 'blue')}
  </div>

  <div class="card flush" style="margin-top:14px">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('chart')}</span>
        <div><p class="h-eyebrow">Plant</p><h3>Weekly load vs capacity</h3></div>
      </div>
      <span class="hint">Working-day overlap only (weekends and holidays excluded)</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Week</th><th class="num">Working days</th><th class="num">Capacity MT</th>
          <th class="num">Planned load MT</th><th style="width:180px">Utilisation</th><th class="num">Free MT</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${weeks.map((w) => {
            const pct = clampPct(w.utilisation * 100);
            const cls = w.status === 'OVERLOADED' ? 'red' : w.status === 'HIGH' ? 'amber' : '';
            return `<tr>
              <td>${fmt(w.start)} – ${fmt(w.end)}</td>
              <td class="num">${w.workingDays}</td>
              <td class="num">${n1(w.capacityMt)}</td>
              <td class="num">${n1(w.loadMt)}</td>
              <td><span class="prog"><span class="bar ${cls}" style="width:110px"><i style="width:${pct}%"></i></span><b>${pct}%</b></span></td>
              <td class="num">${n1(w.freeMt)}</td>
              <td>${w.status === 'OVERLOADED' ? '<span class="badge red">Overloaded</span>' : w.status === 'HIGH' ? '<span class="badge amber">High</span>' : '<span class="badge green">OK</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ── users ─────────────────────────────────────────────────── */
function viewUsers() {
  const users = S.d.users;
  const canManage = cap('users');
  const depts = S.d.meta.depts;
  const owner = users.find((u) => u.role === 'owner');
  const presets = ['owner', 'admin', 'manager', 'editor', 'viewer'];
  const customs = [...new Set(users.map((u) => u.role))]
    .filter((r) => r && r !== 'owner' && !presets.includes(r));
  const reqs = S.d.accessRequests || [];
  const pending = reqs.filter((r) => r.status === 'pending');
  const decided = reqs.filter((r) => r.status !== 'pending').slice(0, 5);

  const reqRow = (r, withActions) => `<div class="req-row">
    <span class="team-ava">${esc(initials(r.name, r.email))}</span>
    <div class="req-main">
      <b>${esc(r.name || r.email || 'User')}</b>
      <span>${esc(reqAsk(r))}${r.note ? ' — ' + esc(r.note) : ''}</span>
      <em>${esc(String(r.created_at).slice(0, 16).replace('T', ' '))}</em>
    </div>
    ${withActions
      ? `<div class="req-actions">
           <button class="btn primary small" data-act="req-approve" data-id="${esc(r.id)}">Approve</button>
           <button class="btn ghost small" data-act="req-deny" data-id="${esc(r.id)}">Deny</button>
         </div>`
      : `<span class="badge ${r.status === 'approved' ? 'green' : 'grey'}">${esc(r.status)}</span>`}
  </div>`;

  const roleList = (current) => {
    const list = presets.slice();
    for (const r of customs) if (!list.includes(r)) list.push(r);
    if (current && !list.includes(current)) list.push(current);
    return list.map((r) => `<option value="${esc(r)}" ${r === current ? 'selected' : ''}>${esc(roleOptionLabel(r))}</option>`).join('')
      + '<option value="__custom__">+ Custom role…</option>';
  };

  return `
  <div class="card flush" style="margin-bottom:14px">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico">${icon('users')}</span>
        <div><p class="h-eyebrow">Access control</p><h3>Access requests</h3></div>
      </div>
      <div class="inline">
        <span class="badge ${pending.length ? 'amber' : 'grey'}">${pending.length} pending</span>
        ${canManage ? '<button class="btn ghost small" data-act="request-access">Request for someone</button>' : '<button class="btn primary small" data-act="request-access">Request access</button>'}
      </div>
    </div>
    ${pending.length
      ? `<div class="req-list">${pending.map((r) => reqRow(r, canManage)).join('')}</div>`
      : '<div class="empty">No open requests. A person who needs more access can ask for it themselves and it lands here.</div>'}
    ${decided.length ? `<div class="req-list decided">${decided.map((r) => reqRow(r, false)).join('')}</div>` : ''}
  </div>

  <div style="margin-bottom:14px">
    <div class="card">
      <div class="card-head">
        <div class="lead">
          <span class="head-ico grey">${icon('users')}</span>
          <div><p class="h-eyebrow">Access model</p><h3>How a person gets in</h3></div>
        </div>
        <span class="hint">${users.length} account${users.length === 1 ? '' : 's'}</span>
      </div>
      <ol class="steps">
        <li><b>Admin adds them</b><span>Email plus a temporary password — nothing is public.</span></li>
        <li><b>They sign in</b><span>Same URL, their own credentials.</span></li>
        <li><b>Department + role</b><span>Set on the row; applied on their next click.</span></li>
        <li><b>The server enforces it</b><span>Every action is re-checked on the Worker, not in the browser.</span></li>
        <li><b>They can ask for more</b><span>Request access from the account menu; an admin approves or denies it.</span></li>
      </ol>
    </div>
  </div>

  <div class="card flush">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico">${icon('users')}</span>
        <div><p class="h-eyebrow">Directory</p><h3>Accounts</h3></div>
      </div>
      <div class="inline">
        <span class="hint">${owner ? 'Admin: ' + esc(owner.name || owner.email || owner.sub) : 'No admin account'}</span>
        ${canManage ? '<button class="btn primary small" data-act="add-user">+ Add user</button>' : ''}
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Person</th><th>Department</th><th>Role</th><th>Status</th><th class="num">Actions</th></tr></thead>
        <tbody>
          ${users.map((u) => {
            return `<tr>
              <td>
                <div class="who">
                  <span class="team-ava">${esc(initials(u.name, u.email))}</span>
                  <span>
                    <span class="cust">${esc(u.name || 'Unnamed')}${u.sub === S.d.me.sub ? ' <span class="badge blue">you</span>' : ''}</span>
                    <small class="sub-line">${esc(u.email || 'no email on account')}</small>
                  </span>
                </div>
              </td>
              <td>
                <select class="role-input" data-user-dept="${esc(u.sub)}" data-current="${esc(u.dept || '')}" ${canManage ? '' : 'disabled'}>
                  <option value="">— none —</option>
                  ${[...new Set([...depts, ...(u.dept ? [u.dept] : [])])].map((d) => opt(d, d, u.dept)).join('')}
                  <option value="__custom__">+ Custom department…</option>
                </select>
              </td>
              <td>
                ${(u.email || '').toLowerCase() === SUPER_ADMIN_EMAIL
                  ? '<span class="badge amber">Admin</span>'
                  : `<select class="role-input" data-user-role="${esc(u.sub)}" data-current="${esc(u.role)}" ${canManage ? '' : 'disabled'}>
                       ${roleList(u.role)}
                     </select>`}
              </td>
              <td><span class="badge ${u.active ? 'green' : 'grey'}">${u.active ? 'Enabled' : 'Disabled'}</span></td>
              <td class="num">
                ${canManage
                  ? `<div class="inline" style="justify-content:flex-end">
                       <button class="btn ghost small" data-act="reset-password" data-id="${esc(u.sub)}" data-name="${esc(u.name || u.email || '')}">Password</button>
                       <button class="btn small ${u.active ? 'ghost' : 'danger'}" data-act="toggle-user" data-id="${esc(u.sub)}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>
                     </div>`
                  : '<span class="sub-line">—</span>'}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="padding:13px 18px;border-top:1px solid var(--line);background:var(--surface-2)">
      <p class="sub-line" style="margin:0">
        Department mapping: ${S.d.meta.depts.map((d) => esc(d)).join(' · ')}.
        A custom role keeps Editor-level access inside that department.
      </p>
    </div>
  </div>`;
}

/* ── settings ──────────────────────────────────────────────── */
function viewSettings() {
  const s = S.d.settings;
  const canEdit = cap('settings');
  const roster = S.d.deptPeople || [];

  return `
  <div class="split">
    <div style="display:grid;gap:14px">
      <div class="card">
        <div class="card-head"><div class="lead"><span class="head-ico">${icon('clock')}</span><div><p class="h-eyebrow">Planning</p><h3>Durations</h3></div></div><span class="hint">working days</span></div>
        <div class="form-grid">
          ${numField('Design & BOM', 'dur_des', s.dur.des, canEdit)}
          ${numField('Drawing approval', 'dur_apr', s.dur.apr, canEdit)}
          ${numField('Material procurement', 'dur_pro', s.dur.pro, canEdit)}
          ${numField('QC inspection', 'dur_qc', s.dur.qc, canEdit)}
          ${numField('Packing & dispatch', 'dur_dsp', s.dur.dsp, canEdit)}
          ${numField('Plant capacity (MT / working day)', 'cap', s.cap, canEdit, 0.1)}
          ${numField('Tight buffer alert (days)', 'tight', s.tight, canEdit)}
        </div>
        <p class="sub-line" style="margin-top:12px">Production days are calculated as ROUNDUP(MT ÷ capacity) unless an order overrides them.</p>
      </div>

      <div class="card">
        <div class="card-head"><div class="lead"><span class="head-ico grey">${icon('chart')}</span><div><p class="h-eyebrow">Calendar</p><h3>Working days</h3></div></div><span class="hint">excluded from every calculation</span></div>
        <div class="check-row">
          ${DAYS.map((d, i) => `<label class="check"><input type="checkbox" data-off="${i}" ${s.off.includes(i) ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /> ${d}</label>`).join('')}
        </div>
        <div class="section-title" style="margin:20px 0 10px">Holidays</div>
        <div class="inline">
          <input type="date" id="holidayDate" ${canEdit ? '' : 'disabled'} />
          <button class="btn small" data-act="add-holiday" ${canEdit ? '' : 'disabled'}>Add holiday</button>
        </div>
        <div class="holiday-tags" id="holidayTags" style="margin-top:12px">
          ${s.holidays.length ? s.holidays.map((h) => `<span class="tag">${fmt(h)}<button data-act="del-holiday" data-date="${esc(h)}">×</button></span>`).join('') : '<span class="sub-line">No holidays added.</span>'}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="lead"><span class="head-ico grey">${icon('users')}</span><div><p class="h-eyebrow">Teams</p><h3>Department team</h3></div></div><span class="hint">${roster.length} people · accounts sync automatically</span></div>
        <div class="dept-team">
          ${S.d.meta.depts.map((d) => {
            const members = roster.filter((p) => p.dept === d);
            return `<div class="dept-block">
              <div class="dept-block-head"><b>${esc(d)}</b><span class="badge grey">${members.length}</span></div>
              ${members.length
                ? `<div class="member-list">${members.map((m) => `<div class="member">
                     <span class="team-ava">${esc(initials(m.name, m.email))}</span>
                     <span class="member-main"><b>${esc(m.name || m.email || '—')}</b><small>${esc(m.email || m.phone || '')}${m.account ? ' · account' : ''}</small></span>
                     ${canEdit && !m.account ? `<button class="icon-btn" data-act="del-dept-person" data-id="${esc(m.id)}" title="Remove">×</button>` : ''}
                   </div>`).join('')}</div>`
                : '<p class="sub-line">Nobody yet.</p>'}
              ${canEdit ? `<div class="inline" style="margin-top:8px">
                <input data-person="name" data-dept="${esc(d)}" placeholder="Name" style="min-width:0" />
                <input data-person="email" data-dept="${esc(d)}" placeholder="Email or mobile" style="min-width:0" />
                <button class="btn ghost small" data-act="add-dept-person" data-dept="${esc(d)}">+ Add</button>
              </div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="lead"><span class="head-ico grey">${icon('box')}</span><div><p class="h-eyebrow">Data</p><h3>Backup &amp; import</h3></div></div></div>
        <div class="inline">
          <button class="btn small" data-act="export">Export orders CSV</button>
          <button class="btn ghost small" data-act="import" ${cap('order') ? '' : 'disabled'}>Import orders</button>
        </div>
        <p class="sub-line" style="margin-top:10px">Export before a bulk import — imports always create new orders.</p>
      </div>

      ${canEdit ? `<div class="form-actions" style="justify-content:flex-start">
        <button class="btn primary" data-act="save-settings">Save planning settings</button>
      </div>` : `<p class="sub-line">Only an admin can change settings.</p>`}
    </div>

    <div class="card">
      <div class="card-head"><div class="lead"><span class="head-ico grey">${icon('gear')}</span><div><p class="h-eyebrow">Reference</p><h3>The SOP</h3></div></div></div>
      <div class="stage-list">
        <div class="stage-row"><div class="stage-no">1</div><div><div class="stage-name">Design &amp; BOM</div><div class="stage-meta">${s.dur.des} working days after confirmation</div></div></div>
        <div class="stage-row"><div class="stage-no">2</div><div><div class="stage-name">Drawing approval + procurement</div><div class="stage-meta">parallel · approval ${s.dur.apr}d, materials ${s.dur.pro}d</div></div></div>
        <div class="stage-row"><div class="stage-no">3</div><div><div class="stage-name">Production</div><div class="stage-meta">starts next working day · ${n1(s.cap)} MT/day</div></div></div>
        <div class="stage-row"><div class="stage-no">4</div><div><div class="stage-name">QC inspection</div><div class="stage-meta">${s.dur.qc} working day</div></div></div>
        <div class="stage-row"><div class="stage-no">5</div><div><div class="stage-name">Packing &amp; dispatch</div><div class="stage-meta">${s.dur.dsp} working day</div></div></div>
      </div>
      <p class="sub-line" style="margin-top:14px">Forecast dispatch = latest of approval/material + production days + QC + dispatch. Buffer compares it with the customer due date.</p>
    </div>
  </div>`;
}

function numField(label, name, value, enabled, step) {
  return `<label class="field"><span>${esc(label)}</span>
    <input type="number" step="${step || 1}" min="0" data-set="${name}" value="${esc(value)}" ${enabled ? '' : 'disabled'} /></label>`;
}

/* ── activity ──────────────────────────────────────────────── */
function viewActivity() {
  const rows = S.d.activity || [];
  return `<div class="card flush">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('clock')}</span>
        <div><p class="h-eyebrow">Audit trail</p><h3>Recent activity</h3></div>
      </div>
      <span class="hint">last ${rows.length} events</span>
    </div>
    <div style="padding:6px 18px 16px">
    ${rows.length ? `<div class="timeline">${rows.map((e) => `
      <div class="tl-row">
        <div class="tl-time">${esc(String(e.at).slice(0, 16).replace('T', ' '))}</div>
        <div class="tl-body"><strong>${esc(e.actor_name || 'System')}</strong> ${esc(e.detail || e.action)}
          ${e.entity_id ? `<span class="mono" style="color:var(--text-3)"> · ${esc(e.entity_id)}</span>` : ''}</div>
      </div>`).join('')}</div>` : '<div class="empty">No activity yet.</div>'}
    </div>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════
   modals
   ══════════════════════════════════════════════════════════════ */
function closeModal() {
  const host = $('#modal');
  host.classList.remove('open');
  host.innerHTML = '';
}

function modal(opts) {
  const host = $('#modal');
  host.classList.add('open');
  host.innerHTML = `<div class="modal-backdrop">
    <form class="modal ${opts.wide ? 'wide' : ''}" id="modalForm" autocomplete="off">
      <h3>${esc(opts.title)}</h3>
      <p class="modal-sub">${esc(opts.sub || '')}</p>
      ${opts.body}
      <div class="form-actions">
        <button type="button" class="btn ghost" data-modal-close>Cancel</button>
        <button type="submit" class="btn primary">${esc(opts.submit || 'Save')}</button>
      </div>
    </form>
  </div>`;
  const form = $('#modalForm');
  $$('[data-modal-close]', host).forEach((b) => b.addEventListener('click', closeModal));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await opts.onSubmit(data, form);
    } catch (err) {
      toast(err.message || 'Something went wrong', 'err');
    }
  });
}

function field(label, name, value, type = 'text', extra = '') {
  return `<label class="field"><span>${esc(label)}</span>
    <input name="${name}" type="${type}" value="${esc(value)}" ${extra} /></label>`;
}

function selectField(label, name, value, options) {
  return `<label class="field"><span>${esc(label)}</span>
    <select name="${name}">${options.map(([v, l]) => opt(v, l, value)).join('')}</select></label>`;
}

function orderModal(existing) {
  const o = existing || {};
  const s = S.d.settings;
  const body = `<div class="form-grid">
    ${field('Customer *', 'customer', o.customer)}
    ${field('Project / site', 'project', o.project)}
    ${field('Structure type', 'structure_type', o.structure_type)}
    ${field('kWp', 'kwp', o.kwp, 'number', 'step="0.01" min="0"')}
    ${field('Quantity (MT) *', 'mt', o.mt, 'number', 'step="0.001" min="0"')}
    ${selectField('Priority', 'priority', o.priority || 'Medium', [['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']])}
    ${field('PO date', 'po_date', o.po_date, 'date')}
    ${field('ERP confirmation date', 'conf_date', o.conf_date, 'date')}
    ${field('Customer due date', 'due_date', o.due_date, 'date')}
    ${field('Sales owner', 'sales_owner', o.sales_owner)}
    ${field('Design days override', 'o_des', o.o_des, 'number', `step="1" min="0" placeholder="${s.dur.des}"`)}
    ${field('Procurement days override', 'o_pro', o.o_pro, 'number', `step="1" min="0" placeholder="${s.dur.pro}"`)}
    ${field('Production days override', 'o_prd', o.o_prd, 'number', 'step="1" min="0" placeholder="auto"')}
    <label class="field wide"><span>Remarks</span><textarea name="remarks">${esc(o.remarks)}</textarea></label>
  </div>`;

  modal({
    title: existing ? `Edit ${o.id}` : 'New order',
    sub: existing ? 'Changing any field re-plans every downstream date.' : 'The schedule is built from the confirmation date and the MT quantity.',
    body,
    submit: existing ? 'Save changes' : 'Create order',
    wide: true,
    async onSubmit(data) {
      if (!data.customer || !data.customer.trim()) throw new Error('Customer is required');
      if (!data.mt || Number(data.mt) <= 0) throw new Error('Quantity (MT) must be greater than zero');
      const res = existing
        ? await api('/api/orders/' + encodeURIComponent(o.id), 'PATCH', data)
        : await api('/api/orders', 'POST', data);
      apply(res);
      closeModal();
      render();
      toast(existing ? 'Order updated' : `Order ${res.id || ''} created`, 'ok');
    },
  });
}

function dispatchModal(orderId) {
  const open = S.d.orders.filter((o) => o.live.rag !== 'CLOSED' || o.status === 'open');
  const body = `<div class="form-grid">
    ${selectField('Order *', 'order_id', orderId || '', open.map((o) => [o.id, `${o.id} — ${o.customer || ''} (${n1(o.mt)} MT)`]))}
    ${field('Batch / lot', 'batch', '')}
    ${field('Quantity MT *', 'qty', '', 'number', 'step="0.001" min="0"')}
    ${field('Planned date', 'pdate', S.d.today, 'date')}
    ${field('Actual date', 'adate', S.d.today, 'date')}
    ${field('Vehicle number', 'vehicle', '')}
    ${field('Transporter', 'transporter', '')}
    ${field('Invoice number', 'invoice', '')}
    ${field('E-way bill', 'eway', '')}
    ${field('LR / docket', 'lr', '')}
    ${field('QC reference', 'qc_ref', '')}
    <label class="field wide"><span>Remarks</span><textarea name="remarks"></textarea></label>
  </div>`;
  modal({
    title: 'Dispatch entry',
    sub: 'Record one vehicle / batch. Quantity counts against the order balance.',
    body,
    submit: 'Save dispatch',
    wide: true,
    async onSubmit(data) {
      if (!data.order_id) throw new Error('Pick an order');
      if (!data.qty || Number(data.qty) <= 0) throw new Error('Quantity must be greater than zero');
      const res = await api('/api/dispatches', 'POST', data);
      apply(res);
      closeModal();
      render();
      toast('Dispatch saved', 'ok');
    },
  });
}

function roleChoices(current) {
  const list = ['owner', 'admin', 'manager', 'editor', 'viewer'];
  for (const r of S.d.meta.customRoles || []) if (!list.includes(r)) list.push(r);
  for (const u of S.d.users || []) if (u.role && !list.includes(u.role)) list.push(u.role);
  if (current && !list.includes(current)) list.push(current);
  return list;
}

function deptChoices(current) {
  const list = [...(S.d.meta.depts || [])];
  if (current && !list.includes(current)) list.push(current);
  return list;
}

function addUserModal() {
  const body = `<div class="form-grid">
    ${field('Full name', 'name', '')}
    ${field('Email *', 'email', '', 'email', 'required')}
    <label class="field"><span>Role</span>
      <select name="role" data-pick="role">
        ${roleChoices().map((r) => `<option value="${esc(r)}"${r === 'viewer' ? ' selected' : ''}>${esc(roleOptionLabel(r))}</option>`).join('')}
        <option value="__custom__">+ Custom role…</option>
      </select>
    </label>
    <label class="field" data-custom-for="role" hidden><span>Custom role title</span>
      <input name="role_custom" autocomplete="off" placeholder="e.g. Store Keeper" />
    </label>
    <label class="field"><span>Department</span>
      <select name="dept" data-pick="dept">
        <option value="">— none —</option>
        ${deptChoices().map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}
        <option value="__custom__">+ Custom department…</option>
      </select>
    </label>
    <label class="field" data-custom-for="dept" hidden><span>Custom department name</span>
      <input name="dept_custom" autocomplete="off" placeholder="e.g. Fabrication" />
    </label>
    ${field('Temporary password *', 'password', '', 'password', 'required minlength="8"')}
  </div>
  <p class="sub-line" style="margin-top:10px">Share this password with them directly. They can change it from <strong>Your access</strong> after signing in.</p>`;

  modal({
    title: 'Add user',
    sub: 'Only an admin can create accounts.',
    body,
    submit: 'Create account',
    wide: true,
    async onSubmit(data) {
      if (!data.email || !data.password) throw new Error('Email and password are required');
      const role = data.role === '__custom__' ? String(data.role_custom || '').trim() : data.role;
      const dept = data.dept === '__custom__' ? String(data.dept_custom || '').trim() : data.dept;
      if (!role) throw new Error('Type a role name');
      const res = await api('/api/users', 'POST', { ...data, role, dept });
      apply(res);
      closeModal();
      render();
      toast('Account created', 'ok');
    },
  });
}

function customRoleModal(sub, name, current) {
  const presetNames = ['admin', 'manager', 'editor', 'viewer', 'owner'];
  const seed = current && !presetNames.includes(current.toLowerCase()) ? current : '';
  const body = `<div class="form-grid">
    <label class="field wide"><span>Role name *</span>
      <input name="role" value="${esc(seed)}" list="roleIdeas" autocomplete="off" placeholder="e.g. Store Keeper" required />
      <datalist id="roleIdeas">
        <option value="Store Keeper"></option>
        <option value="Dispatch Lead"></option>
        <option value="QC Engineer"></option>
        <option value="Purchase Lead"></option>
        <option value="Project Coordinator"></option>
      </datalist>
    </label>
  </div>
  <p class="sub-line" style="margin-top:10px">Type any job title — it is saved exactly as written and shown across the app. Access is Editor-level inside the person's department.</p>`;

  modal({
    title: `Custom role — ${name || 'user'}`,
    sub: 'Free text. Admin and Viewer keep their own rules.',
    body,
    submit: 'Apply role',
    async onSubmit(data) {
      const role = String(data.role || '').trim();
      if (!role) throw new Error('Type a role name');
      if (role.toLowerCase() === 'owner') throw new Error('That name is reserved');
      const res = await api('/api/users/' + encodeURIComponent(sub), 'PATCH', { role });
      apply(res);
      closeModal();
      render();
      toast(`Role set to ${role}`, 'ok');
    },
  });
}

function customDeptModal(sub, name, current) {
  const body = `<div class="form-grid">
    <label class="field wide"><span>Department name *</span>
      <input name="dept" value="${esc(current)}" autocomplete="off" placeholder="e.g. Fabrication" required />
    </label>
  </div>
  <p class="sub-line" style="margin-top:10px">Type any department name — it is saved as written and appears in every department list. Access covers the department's stages and dispatch log.</p>`;

  modal({
    title: `Department — ${name || 'user'}`,
    sub: 'Free text. Pick a preset from the dropdown or type your own.',
    body,
    submit: 'Save department',
    async onSubmit(data) {
      const dept = String(data.dept || '').trim();
      if (!dept) throw new Error('Type a department name');
      const res = await api('/api/users/' + encodeURIComponent(sub), 'PATCH', { dept });
      apply(res);
      closeModal();
      render();
      toast(`Department set to ${dept}`, 'ok');
    },
  });
}

function requestAccessModal() {
  const me = S.d.me;
  const ideas = [...new Set([...FULL_ROLES.filter((r) => r !== 'owner'), 'editor', 'viewer', ...(S.d.meta.customRoles || [])])];
  const body = `<div class="form-grid">
    <label class="field"><span>Role you need</span>
      <select name="role" data-pick="role">
        <option value="">— keep current —</option>
        ${ideas.map((r) => `<option value="${esc(roleLabel(r))}">${esc(roleLabel(r))}</option>`).join('')}
        <option value="__custom__">+ Custom role…</option>
      </select>
    </label>
    <label class="field" data-custom-for="role" hidden><span>Custom role title</span>
      <input name="role_custom" autocomplete="off" placeholder="e.g. Store Keeper" />
    </label>
    <label class="field"><span>Department</span>
      <select name="dept" data-pick="dept">
        <option value="">— keep current —</option>
        ${deptChoices(me.dept).map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}
        <option value="__custom__">+ Custom department…</option>
      </select>
    </label>
    <label class="field" data-custom-for="dept" hidden><span>Custom department name</span>
      <input name="dept_custom" autocomplete="off" placeholder="e.g. Fabrication" />
    </label>
    <label class="field wide"><span>What do you need to do?</span>
      <textarea name="note" placeholder="e.g. I mark material receipts for Stores"></textarea>
    </label>
  </div>
  <p class="sub-line" style="margin-top:10px">Signed in as <strong>${esc(me.name || me.email || '')}</strong> · ${esc(roleLabel(me.role))}${me.dept ? ' · ' + esc(me.dept) : ''}. An Admin or Manager sees this in Notifications and Users &amp; roles; your access changes the moment they approve.</p>`;

  modal({
    title: 'Request access',
    sub: 'Ask for the role or department you are missing.',
    body,
    submit: 'Send request',
    wide: true,
    async onSubmit(data) {
      const role = data.role === '__custom__' ? String(data.role_custom || '').trim() : String(data.role || '').trim();
      const dept = data.dept === '__custom__' ? String(data.dept_custom || '').trim() : String(data.dept || '').trim();
      if (!role && !dept) throw new Error('Pick a role or a department');
      const res = await api('/api/access-requests', 'POST', { role, dept, note: data.note });
      apply(res);
      closeModal();
      render();
      toast('Request sent to the admins', 'ok');
    },
  });
}

function resetPasswordModal(sub, name) {
  const body = `<div class="form-grid">
    ${field('New password *', 'password', '', 'password', 'required minlength="8"')}
  </div>`;
  modal({
    title: `Reset password — ${name}`,
    sub: 'Tell them the new password; their existing sessions stay signed in.',
    body,
    submit: 'Set password',
    async onSubmit(data) {
      if (!data.password || data.password.length < 8) throw new Error('Password must be at least 8 characters');
      const res = await api('/api/users/' + encodeURIComponent(sub), 'PATCH', { password: data.password });
      apply(res);
      closeModal();
      render();
      toast('Password updated', 'ok');
    },
  });
}

function importModal() {
  const body = `
    <div class="inline" style="margin-bottom:12px">
      <input type="file" id="csvFile" accept=".csv,text/csv" />
      <a class="btn ghost small" href="#" id="tplLink">Download column template</a>
    </div>
    <label class="field"><span>Paste rows (CSV, first line = headers)</span>
      <textarea name="csv" style="min-height:190px" class="mono" placeholder="Customer,Project,kWp,MT,PO Date,Confirmation Date,Due Date,Priority,Sales Owner,Remarks"></textarea>
    </label>
    <p class="sub-line" style="margin-top:10px">Recognised columns: Customer, Project, Structure Type, kWp, MT, PO Date, Confirmation Date, Due Date, Priority, Sales Owner, Design days, Procurement days, Production days, Remarks. Excel: save the sheet as CSV first.</p>`;

  modal({
    title: 'Import orders',
    sub: 'Creates new orders only — existing orders are never overwritten.',
    body,
    submit: 'Import',
    wide: true,
    async onSubmit(data) {
      const text = String(data.csv || '').trim();
      if (!text) throw new Error('Paste CSV rows or choose a file first');
      const rows = parseOrderCsv(text);
      if (!rows.length) throw new Error('No rows with a customer name found');
      if (rows.length > 500) throw new Error('Import up to 500 rows at a time');
      const res = await api('/api/import', 'POST', { rows });
      apply(res);
      closeModal();
      render();
      toast(`Imported ${res.created} order(s)${res.skipped.length ? `, skipped ${res.skipped.length}` : ''}`, res.created ? 'ok' : 'err');
    },
  });

  const fileInput = $('#csvFile');
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const text = await f.text();
      const ta = $('textarea[name=csv]');
      if (ta) ta.value = text;
    });
  }
  const tpl = $('#tplLink');
  if (tpl) {
    tpl.addEventListener('click', (e) => {
      e.preventDefault();
      downloadCsv('ars-order-import-template.csv',
        'Customer,Project,Structure Type,kWp,MT,PO Date,Confirmation Date,Due Date,Priority,Sales Owner,Design days,Procurement days,Production days,Remarks\n' +
        'Example Solar Pvt Ltd,Rooftop 500kWp,MMS,500,12.5,2026-11-01,2026-11-05,2026-12-10,High,A. Sharma,,,,\n');
    });
  }
}

/* CSV parsing (also accepts Excel's "Save as CSV")
   Handles quoted fields, DD-MM-YYYY / DD/MM/YYYY and blank cells. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function parseDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

const COLUMN_ALIASES = {
  customer: ['customer', 'customername', 'client', 'clientname', 'party'],
  project: ['project', 'projectname', 'site', 'sitename'],
  structure_type: ['structuretype', 'structure'],
  kwp: ['kwp', 'capacity', 'capacitykwp'],
  mt: ['mt', 'materialmt', 'qty', 'quantity', 'tonnage'],
  po_date: ['podate', 'po', 'purchaseorderdate'],
  conf_date: ['confirmationdate', 'confdate', 'confirmed', 'erpconfirmationdate', 'confirmation'],
  due_date: ['duedate', 'deliverydate', 'requireddate', 'delivery'],
  priority: ['priority'],
  sales_owner: ['salesowner', 'sales', 'owner', 'salesperson'],
  o_des: ['designdays', 'designdaysoverride', 'designoverride'],
  o_pro: ['procurementdays', 'procurementdaysoverride', 'procurementoverride', 'prodays'],
  o_prd: ['productiondays', 'productiondaysoverride', 'productionoverride'],
  remarks: ['remarks', 'notes', 'comment', 'comments'],
};

function parseOrderCsv(text) {
  const table = parseCsv(text);
  if (table.length < 2) return [];
  const head = table[0].map(norm);
  const idx = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const i = head.findIndex((h) => aliases.includes(h));
    if (i >= 0) idx[field] = i;
  }
  const get = (r, f) => (idx[f] === undefined ? '' : String(r[idx[f]] ?? '').trim());
  const out = [];
  for (const r of table.slice(1)) {
    const customer = get(r, 'customer');
    if (!customer) continue;
    const mtRaw = get(r, 'mt');
    const kwpRaw = get(r, 'kwp');
    out.push({
      customer,
      project: get(r, 'project'),
      structure_type: get(r, 'structure_type'),
      kwp: kwpRaw ? Number(kwpRaw.replace(/[^0-9.]/g, '')) : null,
      mt: mtRaw ? Number(mtRaw.replace(/[^0-9.]/g, '')) : null,
      po_date: parseDate(get(r, 'po_date')),
      conf_date: parseDate(get(r, 'conf_date')),
      due_date: parseDate(get(r, 'due_date')),
      priority: get(r, 'priority') || 'Medium',
      sales_owner: get(r, 'sales_owner'),
      o_des: get(r, 'o_des') ? Number(get(r, 'o_des').replace(/[^0-9.]/g, '')) : null,
      o_pro: get(r, 'o_pro') ? Number(get(r, 'o_pro').replace(/[^0-9.]/g, '')) : null,
      o_prd: get(r, 'o_prd') ? Number(get(r, 'o_prd').replace(/[^0-9.]/g, '')) : null,
      remarks: get(r, 'remarks'),
    });
  }
  return out;
}

/* ── CSV export ────────────────────────────────────────────── */
function downloadCsv(name, text) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportOrders() {
  const head = ['Order', 'Customer', 'Project', 'Structure', 'kWp', 'MT', 'PO date', 'Confirmed', 'Due date',
    'Stage', 'Department', 'Head', 'Forecast dispatch', 'Planned dispatch', 'Buffer days', 'Status',
    'Progress %', 'Dispatched MT', 'Balance MT', 'Priority', 'Sales owner', 'Remarks'];
  const lines = [head.map(csvCell).join(',')];
  for (const o of S.d.orders) {
    lines.push([
      o.id, o.customer, o.project, o.structure_type, o.kwp, o.mt, o.po_date, o.conf_date, o.due_date,
      o.live.stage, o.live.dept, o.live.head, o.live.forecastDispatch, o.live.plannedDispatch,
      o.live.bufferDays, o.live.rag, o.live.progress, o.live.dispatchedMt, o.live.balanceMt,
      o.priority, o.sales_owner, o.remarks,
    ].map(csvCell).join(','));
  }
  downloadCsv(`ARS-orders-${S.d.today}.csv`, lines.join('\n'));
}

function exportDispatches() {
  const rows = S.d.dispatches;
  const byOrder = new Map(S.d.orders.map((o) => [o.id, o]));
  const head = ['Dispatch', 'Order', 'Customer', 'Batch', 'MT', 'Planned', 'Actual', 'Vehicle', 'Transporter', 'Invoice', 'E-way', 'LR', 'QC ref', 'Remarks'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of rows) {
    const o = byOrder.get(r.order_id);
    lines.push([r.id, r.order_id, o ? o.customer : '', r.batch, r.qty, r.pdate, r.adate, r.vehicle,
      r.transporter, r.invoice, r.eway, r.lr, r.qc_ref, r.remarks].map(csvCell).join(','));
  }
  downloadCsv(`ARS-dispatch-${S.d.today}.csv`, lines.join('\n'));
}

/* ══════════════════════════════════════════════════════════════
   actions
   ══════════════════════════════════════════════════════════════ */
const ACTIONS = {
  'open-order': (el) => openDrawer(el.dataset.id),
  'close-drawer': () => closeDrawer(),
  'new-order': () => orderModal(null),
  'edit-order': (el) => {
    const o = S.d.orders.find((x) => x.id === el.dataset.id);
    if (o) orderModal(o);
  },
  'delete-order': async (el) => {
    const o = S.d.orders.find((x) => x.id === el.dataset.id);
    if (!o) return;
    if (!confirm(`Delete order ${o.id} for ${o.customer || 'customer'}? Its stages and dispatches are removed too.`)) return;
    try {
      const res = await api('/api/orders/' + encodeURIComponent(o.id), 'DELETE');
      apply(res); closeDrawer(); render(); toast('Order deleted', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'stage-set': async (el) => {
    const id = el.dataset.id;
    const stage = el.dataset.stage;
    const input = $(`[data-stage-input="${stage}"]`, $('#drawer'));
    const date = input ? input.value : S.d.today;
    el.disabled = true;
    try {
      const res = await api(`/api/orders/${encodeURIComponent(id)}/stages/${stage}`, 'POST', { date });
      apply(res); render(); toast('Stage updated', 'ok');
    } catch (e) { toast(e.message, 'err'); el.disabled = false; }
  },
  'stage-clear': async (el) => {
    el.disabled = true;
    try {
      const res = await api(`/api/orders/${encodeURIComponent(el.dataset.id)}/stages/${el.dataset.stage}`, 'POST', { date: null });
      apply(res); render(); toast('Stage reopened', 'ok');
    } catch (e) { toast(e.message, 'err'); el.disabled = false; }
  },
  'new-dispatch': (el) => dispatchModal(el.dataset.order || ''),
  'del-dispatch': async (el) => {
    if (!confirm('Delete this dispatch entry?')) return;
    try {
      const res = await api('/api/dispatches/' + encodeURIComponent(el.dataset.id), 'DELETE');
      apply(res); render(); toast('Dispatch deleted', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'toggle-user': async (el) => {
    const active = el.dataset.active === '1';
    try {
      const res = await api('/api/users/' + encodeURIComponent(el.dataset.id), 'PATCH', { active: active ? 0 : 1 });
      apply(res); render(); toast(active ? 'Account disabled' : 'Account enabled', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'save-settings': async () => {
    const dur = {};
    $$('[data-set^="dur_"]').forEach((i) => { dur[i.dataset.set.slice(4)] = Number(i.value); });
    const capVal = $('[data-set="cap"]');
    const tight = $('[data-set="tight"]');
    const off = $$('[data-off]').filter((i) => i.checked).map((i) => Number(i.dataset.off));
    const body = {
      dur,
      cap: capVal ? Number(capVal.value) : S.d.settings.cap,
      tight: tight ? Number(tight.value) : S.d.settings.tight,
      off,
      holidays: S.d.settings.holidays,
    };
    try {
      const res = await api('/api/settings', 'PUT', body);
      apply(res); render(); toast('Planning settings saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'save-stakeholders': async () => {
    const map = new Map();
    $$('[data-stake]').forEach((i) => {
      const dept = i.dataset.dept;
      if (!map.has(dept)) map.set(dept, { dept });
      map.get(dept)[i.dataset.stake] = i.value;
    });
    try {
      const res = await api('/api/stakeholders', 'PUT', { rows: Array.from(map.values()) });
      apply(res); render(); toast('Department heads saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'add-holiday': async () => {
    const input = $('#holidayDate');
    if (!input || !input.value) return toast('Pick a date first', 'err');
    const holidays = [...new Set([...S.d.settings.holidays, input.value])].sort();
    try {
      const res = await api('/api/settings', 'PUT', { ...S.d.settings, holidays });
      apply(res); render(); toast('Holiday added', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'del-holiday': async (el) => {
    const holidays = S.d.settings.holidays.filter((h) => h !== el.dataset.date);
    try {
      const res = await api('/api/settings', 'PUT', { ...S.d.settings, holidays });
      apply(res); render(); toast('Holiday removed', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'open-stage': (el) => {
    S.stage = el.dataset.stage;
    S.status = 'open';
    location.hash = '#/orders';
    render();
  },
  'custom-role': (el) => customRoleModal(el.dataset.id, el.dataset.name || '', el.dataset.current || ''),
  'add-dept-person': async (el) => {
    const dept = el.dataset.dept;
    const box = $$('[data-person]').filter((i) => i.dataset.dept === dept);
    const nameEl = box.find((i) => i.dataset.person === 'name');
    const mailEl = box.find((i) => i.dataset.person === 'email');
    const name = (nameEl && nameEl.value.trim()) || '';
    const contact = (mailEl && mailEl.value.trim()) || '';
    if (!name && !contact) return toast('Enter a name or contact first', 'err');
    const isMail = contact.includes('@');
    el.disabled = true;
    try {
      const res = await api('/api/dept-people', 'POST', {
        dept, name, email: isMail ? contact : '', phone: isMail ? '' : contact,
      });
      apply(res); render(); toast(`${name || contact} added to ${dept}`, 'ok');
    } catch (e) { toast(e.message, 'err'); el.disabled = false; }
  },
  'del-dept-person': async (el) => {
    if (!confirm('Remove this person from the department?')) return;
    try {
      const res = await api('/api/dept-people/' + encodeURIComponent(el.dataset.id), 'DELETE');
      apply(res); render(); toast('Removed', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'approve-order': async (el) => {
    el.disabled = true;
    try {
      const res = await api('/api/orders/' + encodeURIComponent(el.dataset.id) + '/approval', 'POST', { decision: 'approve' });
      apply(res); render(); if (S.open === el.dataset.id) openDrawer(el.dataset.id, true);
      toast('Final approval given', 'ok');
    } catch (e) { toast(e.message, 'err'); el.disabled = false; }
  },
  'request-access': () => requestAccessModal(),
  'req-approve': async (el) => {
    el.disabled = true;
    try {
      const res = await api('/api/access-requests/' + encodeURIComponent(el.dataset.id) + '/decision', 'POST', { decision: 'approve' });
      apply(res); render(); toast('Access granted', 'ok');
    } catch (e) { toast(e.message, 'err'); el.disabled = false; }
  },
  'req-deny': async (el) => {
    if (!confirm('Deny this access request?')) return;
    el.disabled = true;
    try {
      const res = await api('/api/access-requests/' + encodeURIComponent(el.dataset.id) + '/decision', 'POST', { decision: 'deny' });
      apply(res); render(); toast('Request denied', 'ok');
    } catch (e) { toast(e.message, 'err'); el.disabled = false; }
  },
  notif: () => togglePanel('#notifPanel'),
  account: () => togglePanel('#accountMenu'),
  theme: () => toggleTheme(),
  'close-panels': () => closePanels(),
  'add-user': () => addUserModal(),
  'reset-password': (el) => resetPasswordModal(el.dataset.id, el.dataset.name || 'user'),
  signout: async () => {
    try { await api('/api/auth/logout', 'POST'); } catch { /* ignore */ }
    clearCache();
    S.d = null;
    location.reload();
  },
  import: () => importModal(),
  export: () => { exportOrders(); exportDispatches(); },
};

/* ── event wiring ──────────────────────────────────────────── */
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (!['notif', 'account', 'theme'].includes(el.dataset.act)) closePanels();
  await fn(el);
});

document.addEventListener('click', (ev) => {
  if (ev.target.closest('.popover') || ev.target.closest('[data-act="notif"]') || ev.target.closest('[data-act="account"]')) return;
  closePanels();
});

document.addEventListener('change', async (ev) => {
  const asgSel = ev.target.closest('[data-assign-stage]');
  if (asgSel) {
    try {
      const res = await api(
        `/api/orders/${encodeURIComponent(asgSel.dataset.order)}/stages/${encodeURIComponent(asgSel.dataset.assignStage)}/assign`,
        'POST',
        { sub: asgSel.value || null },
      );
      apply(res); render(); if (S.open === asgSel.dataset.order) openDrawer(asgSel.dataset.order, true);
      toast(asgSel.value ? 'Stage assigned' : 'Assignment cleared', 'ok');
    } catch (e) {
      toast(e.message, 'err');
      if (S.open) openDrawer(S.open, true);
    }
    return;
  }
  const pick = ev.target.closest('[data-pick]');
  if (!pick) return;
  const form = pick.closest('form');
  const box = form && form.querySelector(`[data-custom-for="${pick.dataset.pick}"]`);
  if (box) box.hidden = pick.value !== '__custom__';
});

document.addEventListener('change', async (ev) => {
  const roleSel = ev.target.closest('[data-user-role]');
  if (roleSel) {
    if (roleSel.value === '__custom__') {
      const current = roleSel.dataset.current || 'viewer';
      roleSel.value = current;
      const u = (S.d.users || []).find((x) => x.sub === roleSel.dataset.userRole) || {};
      customRoleModal(roleSel.dataset.userRole, u.name || u.email || '', current);
      return;
    }
    try {
      const res = await api('/api/users/' + encodeURIComponent(roleSel.dataset.userRole), 'PATCH', { role: roleSel.value });
      apply(res); render(); toast('Role updated', 'ok');
    } catch (e) { toast(e.message, 'err'); apply(await api('/api/bootstrap')); render(); }
    return;
  }
  const deptSel = ev.target.closest('[data-user-dept]');
  if (deptSel) {
    if (deptSel.value === '__custom__') {
      const current = deptSel.dataset.current || '';
      deptSel.value = current;
      const u = (S.d.users || []).find((x) => x.sub === deptSel.dataset.userDept) || {};
      customDeptModal(deptSel.dataset.userDept, u.name || u.email || '', current);
      return;
    }
    try {
      const res = await api('/api/users/' + encodeURIComponent(deptSel.dataset.userDept), 'PATCH', { dept: deptSel.value || null });
      apply(res); render(); toast('Department updated', 'ok');
    } catch (e) { toast(e.message, 'err'); apply(await api('/api/bootstrap')); render(); }
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'q') {
    S.q = ev.target.value;
    const pos = ev.target.selectionStart;
    render();
    const q = $('#q');
    if (q) { q.focus(); q.setSelectionRange(pos, pos); }
    return;
  }
  if (ev.target.id === 'fStatus') { S.status = ev.target.value; render(); }
  if (ev.target.id === 'fRag') { S.rag = ev.target.value; render(); }
  if (ev.target.id === 'fStage') { S.stage = ev.target.value; render(); }
});

$('#refreshBtn').addEventListener('click', async () => {
  try { apply(await api('/api/bootstrap')); render(); toast('Refreshed', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
});

function routeFromHash() {
  const h = (location.hash || '').replace(/^#\/?/, '').replace(/\/.*$/, '');
  S.view = VIEWS[h] ? h : 'dashboard';
}

window.addEventListener('hashchange', () => {
  closePanels();
  routeFromHash();
  if (S.view !== 'orders') { S.open = null; closeDrawer(); }
  render();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { closeModal(); closeDrawer(); }
});

/* ── boot ──────────────────────────────────────────────────── */
(async function boot() {
  paintTheme();
  routeFromHash();
  wireAuthForms();
  const cached = readCache();
  if (cached) {
    // Render the last snapshot instantly. Only ask the server when it is stale,
    // so repeat opens/reloads cost zero Worker requests.
    S.d = cached.snap;
    render();
    if (Date.now() - cached.at < CACHE_TTL) return;
  }
  await loadApp();
})();
