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

/* ── live sync ─────────────────────────────────────────────────
   Every other workspace (Notion, Linear, Figma) keeps itself current and has
   no reload button. Same deal here, and it stays cheap:

   · a poll asks /api/revision, which is a handful of COUNTs + MAX(updated_at),
     not the workspace;
   · a full snapshot is only pulled when that token actually moves;
   · polling pauses while the tab is hidden, while you type, while a modal is
     open, while a dropdown is open, and for a moment after your own change
     (the change already returned a fresh snapshot);
   · if a refresh would interrupt something, it waits and retries — nothing
     you are looking at ever jumps.
   Cost at rest: one tiny request every 20s, and zero full snapshots. */
const SYNC = {
  token: null,        // last revision the screen is known to match
  seen: null,         // newest revision a poll has reported
  pollMs: 20000,      // at-rest poll interval (hidden tab: no polling at all)
  busyUntil: 0,       // quiet window after our own mutation
  pending: false,     // a change was found while we were busy
  inflight: false,
  timer: 0,
  lastSync: 0,
  lastError: null,
  capture: false,     // the poll below asked for the snapshot now in flight
  seq: 0,             // bumped on every mutation response, to spot stale pulls
};

function syncBusy() {
  const active = document.activeElement;
  const typing = !!(active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
  const modalOpen = $('#modal')?.classList.contains('open');
  const panelOpen = ['#notifPanel', '#accountMenu', '#aiPanel']
    .some((sel) => { const el = $(sel); return el && !el.hidden; });
  return typing || modalOpen || panelOpen || document.hidden || Date.now() < SYNC.busyUntil;
}

/** Record the token that came back with a mutation so we do not re-fetch it. */
function syncMark(revision) {
  if (revision) SYNC.token = SYNC.seen = String(revision);
  SYNC.busyUntil = Date.now() + 2500;
  SYNC.pending = false;
  syncPaint(true);
}

function syncAgoText() {
  if (!SYNC.lastSync) return 'live';
  const s = Math.round((Date.now() - SYNC.lastSync) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function syncPaint(freshlySynced = false) {
  const chip = $('#syncChip');
  const ago = $('#syncAgo');
  const dot = $('#syncDot');
  if (!chip || !ago) return;
  const delta = S.d && S.d.dashboard && S.d.dashboard.kpis
    ? (S.d.dashboard.kpis.red || 0) + (S.d.dashboard.kpis.sopAlerts || 0)
    : 0;
  chip.classList.toggle('has-alerts', delta > 0);
  // Two different problems, two different words: no connection at all versus
  // the worker answering with an error. Neither should ever read as "live".
  const trouble = !!SYNC.lastError;
  chip.dataset.state = SYNC.inflight ? 'syncing' : trouble ? 'offline' : 'ok';
  if (dot) dot.className = 'sync-dot ' + (SYNC.inflight ? 'sync-syncing' : trouble ? 'sync-off' : 'sync-ok');
  ago.textContent = SYNC.inflight ? 'syncing' : trouble ? 'not synced' : syncAgoText();
  ago.classList.toggle('sync-off-text', trouble && !SYNC.inflight);
  ago.classList.toggle('flash', freshlySynced && !SYNC.inflight && !trouble);
  if (freshlySynced) setTimeout(() => ago.classList.remove('flash'), 1400);
  chip.title = trouble
    ? 'Could not refresh — retrying on its own. ' + String(SYNC.lastError)
    : 'Live — changes from your team appear here on their own';
}

async function syncPull() {
  if (SYNC.inflight) return;
  SYNC.inflight = true;
  const seqAtStart = SYNC.seq;
  syncPaint();
  try {
    const snap = await api('/api/bootstrap');
    // You changed something while this was in flight: their response is newer
    // than this snapshot, so drop it and pick the change up on the next tick.
    if (SYNC.seq !== seqAtStart) { SYNC.pending = true; return; }
    S.d = snap;
    saveCache();
    SYNC.lastSync = Date.now();
    SYNC.lastError = null;
    SYNC.failures = 0;
    SYNC.pollMs = 20000;
    if (snap.revision && SYNC.capture) SYNC.token = SYNC.seen = String(snap.revision);
    SYNC.capture = false;
    // A render would fight the user if they are mid-edit; retry shortly.
    if (syncBusy()) { SYNC.pending = true; return; }
    render();
    SYNC.pending = false;
  } catch (e) {
    if (e.status === 401) { clearCache(); stopSync(); showGate(); return; }
    // A snapshot that fails is not "offline" — the screen simply could not keep
    // up. Say so, and retry on a slowing backoff rather than in a tight loop.
    SYNC.lastError = e.message || 'Could not refresh';
    SYNC.failures = (SYNC.failures || 0) + 1;
    SYNC.pollMs = Math.min(120000, 20000 * Math.pow(1.6, SYNC.failures));
  } finally {
    SYNC.inflight = false;
    syncPaint(true);
  }
}

async function syncTick() {
  clearTimeout(SYNC.timer);
  if (document.hidden) {                       // hidden tab: no traffic at all
    SYNC.timer = setTimeout(syncTick, SYNC.pollMs);
    return;
  }
  if (SYNC.inflight) { SYNC.timer = setTimeout(syncTick, SYNC.pollMs); return; }
  if (SYNC.pending) {
    // A change is already known and only waited for the screen to be free.
    if (syncBusy()) { SYNC.timer = setTimeout(syncTick, 1200); return; }
    await syncPull();
    SYNC.timer = setTimeout(syncTick, SYNC.pollMs);
    return;
  }
  SYNC.timer = setTimeout(syncTick, SYNC.pollMs);
  SYNC.inflight = true;
  syncPaint();
  try {
    const rev = await api('/api/revision');
    SYNC.inflight = false;
    // Remember that *this* poll is what asked for the next snapshot. If the user
    // changes something in the meantime, their response wins and this flag is
    // dropped (see apply), so a slow fetch can never roll the screen back.
    SYNC.capture = SYNC.token !== null && String(rev.token) !== SYNC.token;
    SYNC.seen = String(rev.token);
    SYNC.lastError = null;
    SYNC.failures = 0;
    SYNC.pollMs = 20000;
    if (SYNC.token === null) SYNC.token = SYNC.seen;
    // A new day moves every overdue counter and the RAG colour, and no row
    // changes when midnight passes — so the date is part of the change test.
    const dayMoved = !!rev.today && !!S.d && rev.today !== S.d.today;
    if (dayMoved || SYNC.seen !== SYNC.token) {
      if (syncBusy()) { SYNC.pending = true; syncPaint(); return; }
      await syncPull();
      // Pulling a snapshot must not end the loop: without this the screen
      // refreshed exactly once after any real change and then went quiet.
      SYNC.timer = setTimeout(syncTick, SYNC.pollMs);
      return;
    }
    syncPaint();
  } catch (e) {
    SYNC.inflight = false;
    if (e.status === 401) { clearCache(); stopSync(); showGate(); return; }
    SYNC.lastError = e.message || 'offline';
    syncPaint();
  }
}

function stopSync() {
  clearTimeout(SYNC.timer);
  SYNC.timer = 0;
}

function startSync() {
  stopSync();
  SYNC.lastSync = Date.now();
  syncPaint(true);
  SYNC.timer = setTimeout(syncTick, SYNC.pollMs);
}

/* Coming back to the tab is the moment people expect freshness. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.d) syncTick();
});

/* Cheap freshness while idle: repaint the "just now / 2m ago" label. */
setInterval(() => { if (S.d) syncPaint(); }, 15000);
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
  shield: '<path d="M12 3l7 3v6c0 4.4-3 8-7 9-4-1-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8 20.5h8"/><path d="M12 16.5v4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.4"/><path d="M11 18.5h2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  filter: '<path d="M3 5h18"/><path d="M6.5 12h11"/><path d="M10 19h4"/>',
  download: '<path d="M12 3v12"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 20h16"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/><path d="M10 21v-3h4v3"/>',
  tag: '<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z"/><circle cx="8" cy="8" r="1.4"/>',
  note: '<path d="M20 4H8L4 8v12h16z"/><path d="M8 4v4H4"/><path d="M9 13h7M9 17h5"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

/* ── state ─────────────────────────────────────────────────── */
const S = {
  d: null, view: 'dashboard', q: '', status: 'all', rag: 'all', stage: 'all', open: null,
  // The audit trail is fetched on demand because it is searchable/paged, and
  // the devices screen likewise: neither belongs in the 20s snapshot.
  activity: { rows: null, entities: [], entity: 'all', q: '', loading: false },
  sessions: { rows: null, scope: 'own', loading: false },
  customers: { rows: null, missing: [], q: '', loading: false },
  notes: { orderId: null, rows: null, loading: false },
  // Bulk selection on the orders table.
  picked: new Set(),
  analytics: { data: null, loading: false },
};

const FULL_ROLES = ['owner', 'admin', 'manager'];

const VIEWS = {
  dashboard: { title: 'Dashboard', sub: 'Live pipeline, overdue stages and plant load', icon: 'grid' },
  orders: { title: 'Orders', sub: 'Every order with its stage, forecast and buffer', icon: 'box' },
  dispatch: { title: 'Dispatch log', sub: 'Batches, vehicles, invoices and e-way bills', icon: 'truck' },
  capacity: { title: 'Capacity plan', sub: 'Working-day load against plant capacity', icon: 'chart' },
  users: { title: 'Users & roles', sub: 'Who can see what, and who can change it', icon: 'users' },
  settings: { title: 'Settings', sub: 'Advanced backend settings — planning, access control, alerts and teams', icon: 'gear' },
  activity: { title: 'Activity', sub: 'Every change, who made it and when', icon: 'clock' },
  sessions: { title: 'Sessions & devices', sub: 'Where this workspace is signed in, and how to sign it out', icon: 'shield' },
  customers: { title: 'Customers', sub: 'The customer master behind every order', icon: 'building' },
  analytics: { title: 'Analytics', sub: 'Throughput, department cycle times and delivery performance', icon: 'chart' },
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
  // Any full snapshot is newer than a poll that is still in flight.
  SYNC.capture = false;
  SYNC.seq += 1;
  // The mutation (or snapshot) just told us where the server is, so the next
  // poll does not see our own write as somebody else's change. Login and setup
  // carry the token inside the snapshot instead of beside it.
  const rev = (payload && payload.revision) || (snap && snap.revision);
  if (rev) syncMark(rev);
}

/* ── cached snapshot ───────────────────────────────────────────
   Keeps Worker request usage low: a reload within CACHE_TTL renders
   the last snapshot from sessionStorage without touching the API.
   The refresh button and every mutation always hit the server. */
const CACHE_KEY = 'ars-snapshot-v2';
const CACHE_TTL = 5 * 60_000;

function saveCache() {
  try {
    if (S.d) sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), snap: S.d, rev: SYNC.token || undefined }));
  } catch { /* storage full or blocked - not fatal */ }
}

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.snap || !parsed.snap.me) return null;
    return { at: Number(parsed.at) || 0, snap: parsed.snap, rev: parsed.rev || null };
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
    if (S.d.revision) syncMark(S.d.revision);
    render();
  } catch (e) {
    if (e.status === 401) { clearCache(); showGate(e.data && e.data.needsSetup ? 'setup' : 'login'); }
    else toast(e.message || 'Could not load data', 'err');
  }
}

function wireAuthForms() {
  wirePwMeters(document);
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
    sessions: viewSessions,
    customers: viewCustomers,
    analytics: viewAnalytics,
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
  const awaiting = cap('approve')
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

  const escalated = S.d.escalations || [];
  if (escalated.length) {
    parts.push(`<div class="pop-section">Escalations · ${escalated.length}</div>`);
    parts.push(escalated.slice(0, 6).map((e) => `<button class="notif-item red" data-act="open-order" data-id="${esc(e.id)}">
      <span class="n-dot"></span>
      <span><span class="n-title">${esc(e.customer)} · ${esc(e.level)}</span>
      <span class="n-sub">${esc(e.stage)} · ${e.days} day${e.days === 1 ? '' : 's'} late${e.assignee ? ' · ' + esc(e.assignee) : ''}</span></span>
    </button>`).join(''));
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
  const total = attention.length + (canDecide ? pending.length : 0) + mine.length + awaiting.length + escalated.length;
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
    { id: 'dashboard' }, { id: 'orders' }, { id: 'dispatch' }, { id: 'customers' }, { id: 'capacity' }, { id: 'analytics' },
    { sep: 'Administration' },
    { id: 'users', hide: !cap('users') && !cap('settings') },
    { id: 'settings', hide: !cap('settings') && !cap('users') },
    { id: 'activity' },
    { id: 'sessions' },
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

/* Department "Super Admin" (preset or typed by hand) opens advanced Settings. */
const SUPER_ADMIN_DEPT = /^super[\s_-]*admin$/i;
function isDeptSuper(u) {
  return !!(u && (u.dept_admin || SUPER_ADMIN_DEPT.test(String(u.dept || '').trim())));
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
    ${S.picked.size ? `<div class="bulk-bar">
      <b>${S.picked.size}</b> selected
      <select id="bulkAction">
        <option value="">Bulk action…</option>
        <option value="status:open">Reopen</option>
        <option value="status:closed">Mark closed</option>
        <option value="status:cancelled">Mark cancelled</option>
        <option value="priority:Urgent">Priority → Urgent</option>
        <option value="priority:High">Priority → High</option>
        <option value="tag:urgent">Tag → urgent</option>
        <option value="tag:hold">Tag → hold</option>
        ${cap('delete') ? '<option value="delete">Delete selected</option>' : ''}
      </select>
      <button class="btn ghost small" data-act="bulk-clear">Clear</button>
    </div>` : ''}
    <span style="flex:1"></span>
    <button class="btn ghost small" data-act="save-view" title="Save these filters">Save view</button>
    <button class="btn ghost small" data-act="print" title="Print this list">Print</button>
    <button class="btn ghost small" data-act="import">Import</button>
    <button class="btn ghost small" data-act="export">Export</button>
    <button class="btn primary small" data-act="new-order" ${cap('order') ? '' : 'disabled'}>+ New order</button>
    </div>

    ${viewChips()}
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
          <th class="pick"><input type="checkbox" id="pickAll" ${rows.length && rows.every((o) => S.picked.has(o.id)) ? 'checked' : ''} title="Select all shown" /></th>
          <th>Order</th><th>Customer / project</th><th class="num">MT</th><th>Confirmed</th><th>Due</th>
          <th>With whom</th><th>Forecast dispatch</th><th class="num">Buffer</th><th>Progress</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map(orderRow).join('') : `<tr><td colspan="11" class="empty">No orders match this filter.</td></tr>`}
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
  return `<tr class="clickable ${S.picked.has(o.id) ? 'picked' : ''}" data-act="open-order" data-id="${esc(o.id)}">
    <td class="pick"><input type="checkbox" data-pick="${esc(o.id)}" ${S.picked.has(o.id) ? 'checked' : ''} /></td>
    <td><div class="cell-id"><span class="mono">${esc(o.id)}</span>${stageDots(o)}</div>
      ${(o.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
      ${o.live.sopFlag ? '<small class="sub-line" style="color:#ffb47a">SOP flag</small>' : ''}</td>
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
      ${(o.tags || []).map((t) => `<span class="tag" data-act="untag-order" data-id="${esc(o.id)}" data-tag="${esc(t)}" title="Remove tag">${esc(t)}</span>`).join('')}
      <button class="btn ghost small" data-act="tag-order" data-id="${esc(o.id)}">${icon('tag')}<span>Tag</span></button>
    </div>

    <div class="card tight" style="margin-bottom:14px">
      <div class="card-head" style="margin-bottom:10px">
        <div class="lead"><span class="head-ico grey">${icon('note')}</span>
          <div><p class="h-eyebrow">Conversation</p><h3>Notes &amp; updates</h3></div></div>
        <span class="hint" data-notes-count="${esc(o.id)}">${S.notes.orderId === o.id && S.notes.rows ? S.notes.rows.length : ''}</span>
      </div>
      <div class="note-compose">
        <textarea data-note-input="${esc(o.id)}" rows="2" placeholder="Add a note for the team — a phone call, a delay reason, a decision…"></textarea>
        <button class="btn primary small" data-act="add-note" data-id="${esc(o.id)}">Post</button>
      </div>
      <div data-notes="${esc(o.id)}">${notesHtml(o.id)}</div>
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
               ${cap('approve')
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

function notesHtml(orderId) {
  if (S.notes.orderId !== orderId) {
    if (!S.notes.loading) loadNotes(orderId);
    return '<div class="empty" style="padding:14px">Loading notes…</div>';
  }
  const rows = S.notes.rows || [];
  if (!rows.length) return '<div class="empty" style="padding:14px">Nothing said yet. The first note starts the thread.</div>';
  return `<div class="note-list">${rows.map((n) => `
    <div class="note-row">
      <span class="team-ava small">${esc(initials(n.author_name, ''))}</span>
      <div class="note-body">
        <span class="note-meta"><b>${esc(n.author_name || 'Someone')}</b> · ${esc(String(n.created_at).slice(0, 16).replace('T', ' '))}
          ${n.kind === 'update' ? '<span class="tl-badge">update</span>' : ''}</span>
        <p>${esc(n.body)}</p>
      </div>
      ${cap('delete') ? `<button class="icon-btn" data-act="del-note" data-id="${esc(n.order_id)}" data-note="${esc(n.id)}" title="Delete note">×</button>` : ''}
    </div>`).join('')}</div>`;
}

async function loadNotes(orderId) {
  if (S.notes.loading) return;
  S.notes.loading = true;
  try {
    const res = await api('/api/orders/' + encodeURIComponent(orderId) + '/notes');
    S.notes.orderId = orderId;
    S.notes.rows = res.notes || [];
  } catch (e) {
    S.notes.orderId = orderId;
    S.notes.rows = [];
  } finally {
    S.notes.loading = false;
  }
  // redraw only the note block so the date pickers and scroll position survive
  const host = document.querySelector(`[data-notes="${orderId}"]`);
  if (host) host.innerHTML = notesHtml(orderId);
  const count = document.querySelector(`[data-notes-count="${orderId}"]`);
  if (count) count.textContent = S.notes.rows ? S.notes.rows.length || '' : '';
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

  const load = S.d.workload || { rows: [], unassigned: 0 };

  return `
  <div class="card flush" style="margin-bottom:14px">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('chart')}</span>
        <div><p class="h-eyebrow">Workload</p><h3>Who is carrying what</h3></div>
      </div>
      <span class="hint">${load.unassigned} current stage${load.unassigned === 1 ? '' : 's'} unassigned</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Person</th><th>Department</th><th class="num">Open</th><th class="num">Late</th><th class="num">Done · 30d</th></tr></thead>
        <tbody>
          ${load.rows.length ? load.rows.map((r) => `<tr>
            <td>
              <div class="who">
                <span class="team-ava">${esc(initials(r.name, r.email))}</span>
                <span><span class="cust">${esc(r.name)}</span><small class="sub-line">${esc(roleLabel(r.role))}</small></span>
              </div>
            </td>
            <td>${esc(r.dept || '—')}</td>
            <td class="num">${r.open}</td>
            <td class="num">${r.late ? `<span class="badge amber">${r.late}</span>` : '0'}</td>
            <td class="num">${r.done}</td>
          </tr>`).join('') : '<tr><td colspan="5"><div class="empty">No active accounts yet.</div></td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="sub-line" style="margin:8px 18px 14px">Counts come from stage assignments: open = still to do, late = past its planned date, done = finished in the last 30 days.</p>
  </div>

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
                    <span class="cust">${esc(u.name || 'Unnamed')}${u.sub === S.d.me.sub ? ' <span class="badge blue">you</span>' : ''}${isDeptSuper(u) ? ' <span class="badge amber">Dept super admin</span>' : ''}</span>
                    <small class="sub-line">${esc(u.email || 'no email on account')}${u.phone ? ' · ' + esc(u.phone) : ''}</small>
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
                ${`<select class="role-input" data-user-role="${esc(u.sub)}" data-current="${esc(u.role)}" ${canManage ? '' : 'disabled'}>
                       ${roleList(u.role)}
                     </select>`}
              </td>
              <td><span class="badge ${u.active ? 'green' : 'grey'}">${u.active ? 'Enabled' : 'Disabled'}</span></td>
              <td class="num">
                ${canManage
                  ? `<div class="inline" style="justify-content:flex-end">
                       ${u.dept_admin || !SUPER_ADMIN_DEPT.test(String(u.dept || '').trim())
                         ? `<button class="btn ghost small" data-act="toggle-dept-admin" data-id="${esc(u.sub)}" data-active="${u.dept_admin ? 1 : 0}" ${u.dept ? '' : 'disabled title="Set a department first"'}>${u.dept_admin ? 'Remove dept admin' : 'Dept super admin'}</button>`
                         : '<span class="sub-line" title="Advanced Settings is on because the department is Super Admin">Super Admin dept</span>'}
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
        A department super admin gets advanced Settings; Access control opens for the Super Admin department.
      </p>
    </div>
  </div>`;
}


/* ── sessions & devices ────────────────────────────────────── */
async function loadSessions() {
  if (S.sessions.loading) return;
  S.sessions.loading = true;
  try {
    const res = await api('/api/sessions');
    S.sessions.rows = res.sessions || [];
    S.sessions.scope = res.scope || 'own';
  } catch (e) {
    S.sessions.rows = [];
    toast(e.message || 'Could not load devices', 'err');
  } finally {
    S.sessions.loading = false;
  }
  if (S.view === 'sessions') render();
}

function relTime(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function viewSessions() {
  if (!S.sessions.rows && !S.sessions.loading) {
    loadSessions();
    return `<div class="empty">Loading devices…</div>`;
  }
  const rows = S.sessions.rows || [];
  const mine = rows.filter((r) => !r.current);
  const isAdmin = S.sessions.scope === 'all';

  return `
  <div class="grid cols-4">
    ${kpiTile('Signed-in devices', rows.length, isAdmin ? 'across every account' : 'on your account', 'accent')}
    ${kpiTile('This device', 'Active', 'the one you are using now', 'green')}
    ${kpiTile('Others', mine.length, mine.length ? 'sign out anything you do not recognise' : 'nothing else is signed in', mine.length ? 'amber' : 'green')}
    ${kpiTile('Session life', '30 days', 'idle sessions expire on their own', 'blue')}
  </div>

  <div class="card flush" style="margin-top:14px">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('shield')}</span>
        <div><p class="h-eyebrow">Security</p><h3>${isAdmin ? 'Every signed-in device' : 'Where you are signed in'}</h3></div>
      </div>
      <div class="inline">
        <button class="btn ghost small" data-act="sessions-refresh">Refresh</button>
        <button class="btn danger small" data-act="revoke-others" ${mine.length ? '' : 'disabled'}>Sign out other devices</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Device</th>${isAdmin ? '<th>Account</th>' : ''}<th>Address</th><th>Signed in</th><th>Last active</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map((r) => `<tr>
            <td>
              <div class="cell-id">
                <span class="dev-ico">${icon(/phone|android|ios/i.test(r.device) ? 'phone' : 'monitor')}</span>
                <div><span class="cust">${esc(r.device)}</span>${r.current ? '<small class="sub-line" style="color:var(--green,#4ade80)">this device</small>' : ''}</div>
              </div>
            </td>
            ${isAdmin ? `<td><span class="cust">${esc((r.user && (r.user.name || r.user.email)) || '—')}</span>${r.user ? `<small class="sub-line">${esc(r.user.email || '')}</small>` : ''}</td>` : ''}
            <td class="mono" style="font-size:11.5px">${esc(r.ip || '—')}</td>
            <td>${relTime(r.created_at)}</td>
            <td>${relTime(r.last_seen)}</td>
            <td class="num">
              ${r.current
                ? '<span class="badge green">Current</span>'
                : `<button class="btn ghost small" data-act="revoke-session" data-id="${esc(r.id)}">Sign out</button>`}
            </td>
          </tr>`).join('') : '<tr><td colspan="6" class="empty">No devices found.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div style="padding:13px 18px;border-top:1px solid var(--line);background:var(--surface-2)">
      <p class="sub-line" style="margin:0">
        If you see a device you do not recognise, sign it out and change your password — changing it signs out every other device automatically.
      </p>
    </div>
  </div>`;
}


/* ── customers ─────────────────────────────────────────────── */
async function loadCustomers() {
  if (S.customers.loading) return;
  S.customers.loading = true;
  try {
    const res = await api('/api/customers');
    S.customers.rows = res.customers || [];
    S.customers.missing = res.missing || [];
  } catch (e) {
    S.customers.rows = [];
    toast(e.message || 'Could not load customers', 'err');
  } finally {
    S.customers.loading = false;
  }
  if (S.view === 'customers') render();
}

function viewCustomers() {
  const C = S.customers;
  if (!C.rows && !C.loading) {
    loadCustomers();
    return `<div class="empty">Loading customers…</div>`;
  }
  const q = C.q.trim().toLowerCase();
  const rows = (C.rows || []).filter((c) => {
    if (!q) return true;
    return [c.name, c.contact, c.city, c.email, c.phone, c.gstin].filter(Boolean).join(' ').toLowerCase().includes(q);
  });
  const totalMt = rows.reduce((s, c) => s + (Number(c.total_mt) || 0), 0);
  const active = (C.rows || []).filter((c) => c.active).length;

  return `
  <div class="grid cols-4">
    ${kpiTile('Customers', (C.rows || []).length, `${active} active`, 'accent')}
    ${kpiTile('Order book', n1(totalMt) + ' MT', 'across the customers shown', 'blue')}
    ${kpiTile('Repeat', (C.rows || []).filter((c) => c.orders > 1).length, 'with more than one order', 'green')}
    ${kpiTile('Not in master', (C.missing || []).length, 'names found in the order book', (C.missing || []).length ? 'amber' : 'green')}
  </div>

  ${(C.missing || []).length ? `<div class="note" style="margin-top:14px">
    <strong>${C.missing.length} customer name${C.missing.length === 1 ? '' : 's'} from the order book are not in the master yet.</strong>
    They are already on orders — adding them here just lets you keep contacts, GSTIN and history in one place.
    <div style="flex:1"></div>
    <button class="btn primary small" data-act="customers-backfill">Add all ${C.missing.length} in one click</button>
  </div>` : ''}

  <div class="card flush" style="margin-top:14px">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('building')}</span>
        <div><p class="h-eyebrow">Customer master</p><h3>${rows.length} customer${rows.length === 1 ? '' : 's'}</h3></div>
      </div>
      <div class="inline">
        <label class="search-wrap">${icon('search')}
          <input class="search" id="custQ" placeholder="Search name, city, GSTIN…" value="${esc(C.q)}" />
        </label>
        ${cap('order') ? '<button class="btn primary small" data-act="new-customer">+ New customer</button>' : ''}
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Customer</th><th>Contact</th><th>Location</th><th>GSTIN</th>
          <th class="num">Orders</th><th class="num">MT</th><th>Last order</th><th></th></tr></thead>
        <tbody>
          ${rows.length ? rows.map((c) => `<tr class="${c.active ? '' : 'muted'}">
            <td><span class="cust">${esc(c.name)}</span>${c.active ? '' : '<small class="sub-line">inactive</small>'}</td>
            <td>${esc(c.contact || '—')}${c.phone ? `<small class="sub-line">${esc(c.phone)}</small>` : ''}</td>
            <td>${esc([c.city, c.state].filter(Boolean).join(', ') || '—')}</td>
            <td class="mono" style="font-size:11.5px">${esc(c.gstin || '—')}</td>
            <td class="num">${c.orders || 0}${c.open_orders ? `<small class="sub-line">${c.open_orders} open</small>` : ''}</td>
            <td class="num">${n1(c.total_mt)}</td>
            <td>${c.last_order_at ? fmt(String(c.last_order_at).slice(0, 10)) : '—'}</td>
            <td class="num inline" style="justify-content:flex-end">
              ${cap('order') ? `<button class="btn ghost small" data-act="edit-customer" data-id="${esc(c.id)}">Edit</button>` : ''}
              ${cap('delete') ? `<button class="icon-btn" data-act="del-customer" data-id="${esc(c.id)}" data-name="${esc(c.name)}" title="Delete">×</button>` : ''}
            </td>
          </tr>`).join('') : `<tr><td colspan="8" class="empty">${C.rows && C.rows.length ? 'Nothing matches that search.' : 'No customers yet. Add one, or import the names already on your orders.'}</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}



/* ── saved views ──────────────────────────────────────────���────
   Filters people rebuild every morning ("my late orders", "this month's
   dispatch") should be a click, not five dropdowns. Stored per browser, which
   keeps it private and needs no migration. */
const VIEW_KEY = 'ars-saved-views';

function savedViews() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function writeSavedViews(list) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* private mode */ }
}

function currentFilterState() {
  return { q: S.q, status: S.status, rag: S.rag, stage: S.stage };
}

function applyView(id) {
  const v = savedViews().find((x) => x.id === id);
  if (!v) return;
  S.q = v.f.q || '';
  S.status = v.f.status || 'all';
  S.rag = v.f.rag || 'all';
  S.stage = v.f.stage || 'all';
  if (S.view !== 'orders') location.hash = '#/orders';
  render();
  toast(`View “${v.name}” applied`, 'ok');
}

function deleteView(id) {
  writeSavedViews(savedViews().filter((x) => x.id !== id));
  render();
}

function saveViewModal() {
  modal({
    title: 'Save this view',
    sub: 'The filter you are looking at, available in one click next time.',
    body: field('Name *', 'name', '', 'text', 'required maxlength="40" placeholder="Late design work"'),
    submit: 'Save view',
    async onSubmit(data) {
      const name = String(data.name || '').trim();
      if (!name) throw new Error('Give the view a name');
      const list = savedViews().filter((v) => v.name.toLowerCase() !== name.toLowerCase());
      list.unshift({ id: 'v' + Date.now(), name, f: currentFilterState() });
      writeSavedViews(list);
      closeModal();
      render();
      toast('View saved', 'ok');
    },
  });
}

function viewChips() {
  const list = savedViews();
  if (!list.length) return '';
  return `<div class="view-chips">
    <span class="vc-label">Saved</span>
    ${list.map((v) => `<span class="view-chip" data-act="apply-view" data-view="${esc(v.id)}" title="${esc(describeFilters(v.f))}">
      ${esc(v.name)}
      <button class="vc-x" data-act="del-view" data-view="${esc(v.id)}" title="Remove this view">×</button>
    </span>`).join('')}
  </div>`;
}

function describeFilters(f) {
  const parts = [];
  if (f.q) parts.push(`search “${f.q}”`);
  if (f.status && f.status !== 'all') parts.push(f.status);
  if (f.rag && f.rag !== 'all') parts.push(f.rag.toLowerCase());
  if (f.stage && f.stage !== 'all') parts.push('stage ' + f.stage);
  return parts.length ? parts.join(' · ') : 'everything';
}

/* ── analytics ─────────────────────────────────────────────── */
async function loadAnalytics() {
  if (S.analytics.loading) return;
  S.analytics.loading = true;
  try {
    const res = await api('/api/analytics');
    S.analytics.data = res.analytics;
  } catch (e) {
    toast(e.message || 'Could not load analytics', 'err');
  } finally {
    S.analytics.loading = false;
  }
  if (S.view === 'analytics') render();
}

/** A tiny inline bar chart — no chart library, no build weight. */
function bars(rows, pick, opts = {}) {
  const max = Math.max(1, ...rows.map((r) => Number(pick.value(r)) || 0));
  const fmtv = opts.format || ((v) => n1(v));
  return `<div class="bars">${rows.map((r) => {
    const v = Number(pick.value(r)) || 0;
    const w = Math.max(v > 0 ? 3 : 0, Math.round((v / max) * 100));
    return `<div class="bar-row" title="${esc(pick.label(r))}: ${esc(fmtv(v))}">
      <span class="bar-lbl">${esc(pick.label(r))}</span>
      <span class="bar-track"><i class="${pick.tone ? pick.tone(r) : ''}" style="width:${w}%"></i></span>
      <b class="bar-val">${esc(fmtv(v))}</b>
    </div>`;
  }).join('')}</div>`;
}

function viewAnalytics() {
  const A = S.analytics;
  if (!A.data && !A.loading) {
    loadAnalytics();
    return `<div class="empty">Loading analytics…</div>`;
  }
  const d = A.data || { months: [], cycle: [], load: [], delivery: {} };
  const del = d.delivery || {};
  const peak = d.months.reduce((m, x) => (x.mt > (m.mt || 0) ? x : m), { mt: 0 });

  return `
  <div class="grid cols-4">
    ${kpiTile('On-time delivery', del.otif === null ? '—' : del.otif + '%', del.decided ? `${del.onTime} of ${del.decided} closed orders` : 'no closed orders yet', del.otif === null ? 'blue' : del.otif >= 90 ? 'green' : del.otif >= 75 ? 'amber' : 'red')}
    ${kpiTile('Lead time', del.leadTime === null ? '—' : del.leadTime + ' d', 'confirmation to dispatch', 'accent')}
    ${kpiTile('Book to ship', del.monthsOfBook === null ? '—' : del.monthsOfBook + ' mo', 'open MT at recent throughput', 'blue')}
    ${kpiTile('Peak month', n1(peak.mt) + ' MT', peak.label || '—', 'dispatched in the window', 'green')}
  </div>

  <div class="split-2" style="margin-top:14px">
    <div class="card">
      <div class="card-head">
        <div class="lead"><span class="head-ico grey">${icon('chart')}</span>
          <div><p class="h-eyebrow">Throughput</p><h3>Production completed per month</h3></div></div>
        <span class="hint">MT, by production-done date</span>
      </div>
      ${d.months.length ? bars(d.months, {
        label: (r) => r.label,
        value: (r) => r.mt,
        tone: (r) => (r.mt >= (peak.mt || 0) && r.mt > 0 ? 'good' : ''),
      }) : '<div class="empty">No completed production yet.</div>'}
    </div>

    <div class="card">
      <div class="card-head">
        <div class="lead"><span class="head-ico grey">${icon('clock')}</span>
          <div><p class="h-eyebrow">Departments</p><h3>Where the work is sitting</h3></div></div>
        <span class="hint">open orders by current department</span>
      </div>
      ${d.load.length ? bars(d.load, {
        label: (r) => r.dept,
        value: (r) => r.open,
        tone: (r) => (r.late > 0 ? 'bad' : ''),
      }, { format: (v) => String(v) }) : '<div class="empty">Nothing open right now.</div>'}
      ${d.load.some((l) => l.late) ? `<p class="sub-line" style="margin-top:10px">${d.load.filter((l) => l.late).map((l) => `${esc(l.dept)}: ${l.late} late`).join(' · ')}</p>` : ''}
    </div>
  </div>

  <div class="card flush" style="margin-top:14px">
    <div class="card-head">
      <div class="lead"><span class="head-ico grey">${icon('clock')}</span>
        <div><p class="h-eyebrow">Cycle time</p><h3>How long each stage really takes</h3></div></div>
      <span class="hint">committed date minus the previous stage</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Stage</th><th>Department</th><th class="num">Samples</th><th class="num">Average</th>
          <th class="num">Slowest</th><th class="num">Plan</th><th>Verdict</th></tr></thead>
        <tbody>
          ${d.cycle.length ? d.cycle.map((c) => {
            const over = c.target > 0 && c.avg > c.target;
            return `<tr>
              <td><span class="cust">${esc(c.label)}</span></td>
              <td>${esc(c.dept)}</td>
              <td class="num">${c.samples}</td>
              <td class="num"><b>${c.avg} d</b></td>
              <td class="num">${c.worst} d</td>
              <td class="num">${c.target ? c.target + ' d' : '—'}</td>
              <td>${!c.target ? '<span class="badge grey">no plan</span>'
                : over ? `<span class="badge amber">${Math.round((c.avg - c.target) * 10) / 10} d over</span>`
                : '<span class="badge green">within plan</span>'}</td>
            </tr>`;
          }).join('') : '<tr><td colspan="7" class="empty">Mark some stages done — the cycle times appear here.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div style="padding:13px 18px;border-top:1px solid var(--line);background:var(--surface-2)">
      <p class="sub-line" style="margin:0">
        Average is the arithmetic mean of every completed order; the slowest is the worst single case — that is the one to look at when a customer complains.
      </p>
    </div>
  </div>`;
}

/* ── settings ──────────────────────────────────────────────── */
function viewSettings() {
  const s = S.d.settings;
  const canEdit = cap('settings');
  // Access control is the admin-only part of Settings: it needs the account's
  // department to be Super Admin (the server refuses the matrix otherwise, and
  // says so). Planning, calendar, teams and alerts stay open to everyone with
  // the Settings power.
  const canAccess = isDeptSuper(S.d.me);
  const canPower = cap('users');
  const POWER_KEYS = ['users', 'settings', 'delete', 'approve'];
  const roster = S.d.deptPeople || [];
  const access = s.access || {};
  const accessCols = [
    ['order', 'New order'], ['des', 'Design'], ['apr', 'Drawing'], ['mat', 'Material'],
    ['ps', 'Prod start'], ['pf', 'Prod done'], ['qc', 'QC'], ['dsp', 'Dispatch ready'],
    ['disp', 'Dispatch log'], ['ovr', 'Overrides'], ['users', 'Users'], ['settings', 'Settings'],
    ['approve', 'Final approval'], ['delete', 'Delete'],
  ];
  const presetAccess = ['owner', 'admin', 'manager', 'editor', 'viewer'];
  const customAccess = Object.keys(access).filter((r) => !presetAccess.includes(r));
  const accessRoles = [
    ['owner', 'Owner · Admin'], ['admin', 'Admin'], ['manager', 'Manager'], ['editor', 'Editor'], ['viewer', 'Viewer'],
    ...customAccess.map((r) => [r, r]),
  ];
  const nfy = s.notify || { email: false, whatsapp: false, webhook: '', escalate: 2 };
  const channels = (S.d.meta && S.d.meta.channels) || {};
  const outbox = S.d.notifications || [];

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
                     <span class="member-main"><b>${esc(m.name || m.email || '—')}</b><small>${esc([m.email, m.phone].filter(Boolean).join(' · '))}${m.account ? '' : ' · contact'}</small></span>
                   </div>`).join('')}</div>`
                : '<p class="sub-line">No account in this department yet.</p>'}
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
  </div>

  ${canAccess ? '' : `<div class="note" style="margin-top:14px">
    <strong>Access control is locked.</strong>
    Only the <b>Super Admin</b> department can change who-may-do-what. Planning, calendar, teams and alerts below are yours to edit.
  </div>`}
  ${canAccess ? `<div class="card flush" style="margin-top:14px">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('gear')}</span>
        <div><p class="h-eyebrow">Access control</p><h3>Who can do what</h3></div>
      </div>
      <div class="inline">
        <span class="hint">Owner is always full · add your own role below</span>
        ${canEdit ? '<button class="btn ghost small" data-act="add-access-role">+ Custom role</button>' : ''}
        ${canEdit ? '<button class="btn primary small" data-act="save-access">Save access rules</button>' : ''}
      </div>
    </div>
    <div class="table-wrap">
      <table class="access-table">
        <thead><tr><th>Role</th>${accessCols.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead>
        <tbody>
          ${accessRoles.map(([role, label]) => `<tr>
            <td class="cust"><span>${esc(label)}</span>${customAccess.includes(role) ? ` <button class="btn ghost small" data-act="del-access-role" data-role="${esc(role)}" title="Remove this custom role">×</button>` : ''}</td>
            ${accessCols.map(([key]) => `<td><input type="checkbox" data-access="${role}" data-act-key="${key}" ${role === 'owner' || (access[role] || []).includes(key) ? 'checked' : ''} ${role === 'owner' || !canEdit || (!canPower && (role === 'admin' || role === 'manager' || POWER_KEYS.includes(key))) ? 'disabled' : ''} /></td>`).join('')}
          </tr>`).join('')}
          <tr class="access-add-row">
            <td class="cust">
              <div class="inline">
                <input id="newAccessRole" class="role-input" maxlength="40" placeholder="New role name" autocomplete="off" ${canEdit ? '' : 'disabled'} />
                <button class="btn ghost small" data-act="add-access-role-inline" ${canEdit ? '' : 'disabled'}>+ Add role</button>
              </div>
            </td>
            <td colspan="${accessCols.length}"><span class="sub-line">Type any role (e.g. Store Keeper) and add — it gets its own row right here, below Viewer.</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="sub-line" style="margin:6px 18px 16px">Access control belongs to the <strong>Super Admin</strong> department. Owner is locked at full control. Users, Settings, final approval and Delete ticks need the Users power, so only an Admin can hand those out.</p>
  </div>` : ''}

  <div class="card" style="margin-top:14px">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('clock')}</span>
        <div><p class="h-eyebrow">Alerts</p><h3>Email, WhatsApp &amp; escalation</h3></div>
      </div>
      <div class="inline">
        <span class="badge ${channels.email || channels.whatsapp || channels.webhook ? 'green' : 'grey'}">${channels.email || channels.whatsapp || channels.webhook ? 'Channel ready' : 'In-app only'}</span>
        ${canEdit ? '<button class="btn ghost small" data-act="test-alert">Send test alert</button>' : ''}
        ${canEdit ? '<button class="btn ghost small" data-act="run-escalations">Run escalation now</button>' : ''}
      </div>
    </div>
    <div class="form-grid">
      <label class="check"><input type="checkbox" data-notify="email" ${nfy.email ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /> Email to the account address</label>
      <label class="check"><input type="checkbox" data-notify="whatsapp" ${nfy.whatsapp ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /> WhatsApp to the account mobile</label>
      <label class="field"><span>Automation webhook (optional)</span>
        <input type="url" data-notify="webhook" value="${esc(nfy.webhook || '')}" placeholder="https://…" ${canEdit ? '' : 'disabled'} />
      </label>
      <label class="field"><span>Escalate after (days late)</span>
        <input type="number" min="1" max="60" step="1" data-notify="escalate" value="${esc(nfy.escalate || 2)}" ${canEdit ? '' : 'disabled'} />
      </label>
    </div>
    ${canEdit ? '<div class="form-actions" style="justify-content:flex-start"><button class="btn primary" data-act="save-alerts">Save alert settings</button></div>' : ''}
    <p class="sub-line" style="margin:0 18px 14px">The bell always works. Email needs RESEND_API_KEY on the Worker (optional NOTIFY_FROM); WhatsApp needs WHATSAPP_TOKEN and WHATSAPP_PHONE_ID; the webhook receives JSON <span class="mono">{to, title, text}</span> for any SMS/WhatsApp gateway. Missing keys are recorded as a failed send, never a lost alert.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Channel</th><th>To</th><th>Alert</th><th>Status</th></tr></thead>
        <tbody>
          ${outbox.length ? outbox.slice(0, 12).map((n) => `<tr>
            <td class="mono">${esc(String(n.at).slice(0, 16).replace('T', ' '))}</td>
            <td>${esc(n.channel)}</td>
            <td>${esc(n.target || '—')}</td>
            <td>${esc(n.title || '')}<small class="sub-line">${esc(n.body || '')}</small></td>
            <td><span class="badge ${n.status === 'sent' ? 'green' : n.status === 'failed' ? 'red' : 'grey'}" title="${esc(n.error || '')}">${esc(n.status)}</span></td>
          </tr>`).join('') : '<tr><td colspan="5"><div class="empty">No outbox entries yet. Assign a stage or run an escalation.</div></td></tr>'}
        </tbody>
      </table>
    </div>
  </div>`;
}

function numField(label, name, value, enabled, step) {
  return `<label class="field"><span>${esc(label)}</span>
    <input type="number" step="${step || 1}" min="0" data-set="${name}" value="${esc(value)}" ${enabled ? '' : 'disabled'} /></label>`;
}

/* ── activity ──────────────────────────────────────────────── */
async function loadActivity(append = false) {
  const A = S.activity;
  if (A.loading) return;
  A.loading = true;
  try {
    const before = append && A.rows && A.rows.length ? A.rows[A.rows.length - 1].id : '';
    const qs = new URLSearchParams({ limit: '150', entity: A.entity === 'all' ? '' : A.entity, q: A.q });
    if (before) qs.set('before', String(before));
    const res = await api('/api/activity?' + qs.toString());
    A.rows = append ? [...(A.rows || []), ...(res.activity || [])] : res.activity || [];
    A.entities = res.entities || A.entities;
  } catch (e) {
    toast(e.message || 'Could not load activity', 'err');
    if (!append) A.rows = [];
  } finally {
    A.loading = false;
  }
  if (S.view === 'activity') render();
}

const ENTITY_LABEL = {
  order: 'Orders', dispatch: 'Dispatches', user: 'Users', settings: 'Settings',
  session: 'Sessions', stakeholder: 'Teams', person: 'People', access: 'Access requests',
  notify: 'Alerts', import: 'Imports',
};

function viewActivity() {
  const A = S.activity;
  if (!A.rows && !A.loading) {
    loadActivity();
    return `<div class="empty">Loading activity…</div>`;
  }
  const rows = A.rows || [];
  return `<div class="card flush">
    <div class="card-head">
      <div class="lead">
        <span class="head-ico grey">${icon('clock')}</span>
        <div><p class="h-eyebrow">Audit trail</p><h3>Who changed what</h3></div>
      </div>
      <div class="inline">
        <label class="search-wrap">
          ${icon('search')}
          <input class="search" id="auditQ" placeholder="Search activity…" value="${esc(A.q)}" />
        </label>
        <select id="auditEntity">
          <option value="all">Everything</option>
          ${A.entities.map((e) => `<option value="${esc(e)}" ${A.entity === e ? 'selected' : ''}>${esc(ENTITY_LABEL[e] || e)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div style="padding:6px 18px 16px">
    ${rows.length ? `<div class="timeline">${rows.map((e) => `
      <div class="tl-row">
        <div class="tl-time">${esc(String(e.at).slice(0, 16).replace('T', ' '))}</div>
        <div class="tl-body">
          <span class="tl-badge">${esc(ENTITY_LABEL[e.entity] || e.entity)}</span>
          <strong>${esc(e.actor_name || 'System')}</strong> ${esc(e.detail || e.action)}
          ${e.entity_id ? `<span class="mono" style="color:var(--text-3)"> · ${esc(e.entity_id)}</span>` : ''}
        </div>
      </div>`).join('')}</div>
      <div class="inline" style="justify-content:center;margin-top:16px">
        <button class="btn ghost small" data-act="audit-more">Load older</button>
      </div>`
      : `<div class="empty">${A.q || A.entity !== 'all' ? 'Nothing matches that filter.' : 'No activity yet.'}</div>`}
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


/* ── command palette (Ctrl/⌘ K) ────────────────────────────────
   The fastest way through the app: jump to a screen, find an order or a
   customer, or run an action you already know you want. Same idea as Linear,
   Notion and GitHub. */
const PALETTE = { open: false, q: '', index: 0, items: [] };

function paletteItems(query) {
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  const screens = Object.entries(VIEWS).filter(([id]) => {
    if (id === 'users' || id === 'settings') return !!(cap('users') || cap('settings'));
    return true;
  });
  for (const [id, v] of screens) {
    out.push({ kind: 'Go to', label: v.title, hint: v.sub, run: () => { location.hash = '#/' + id; } });
  }
  if (cap('order')) out.push({ kind: 'Action', label: 'New order', hint: 'Create an order from a customer PO', run: () => orderModal(null) });
  if (cap('order')) out.push({ kind: 'Action', label: 'New customer', hint: 'Add to the customer master', run: () => customerModal(null) });
  if (cap('disp')) out.push({ kind: 'Action', label: 'Dispatch entry', hint: 'Record a batch, vehicle and invoice', run: () => dispatchModal(null) });
  out.push({ kind: 'Action', label: 'Export orders', hint: 'Download the order book as CSV', run: () => exportOrders() });
  out.push({ kind: 'Action', label: 'Toggle theme', hint: 'Light / dark', run: () => toggleTheme() });

  const orders = (S.d && S.d.orders) || [];
  const customers = S.customers.rows || [];
  const orderItem = (o) => ({
    kind: 'Order',
    label: `${o.id} · ${o.customer || 'No customer'}`,
    hint: `${o.live.stage} · ${n1(o.mt)} MT · ${o.live.rag}`,
    run: () => { location.hash = '#/orders'; openDrawer(o.id); },
  });
  const custItem = (c) => ({
    kind: 'Customer',
    label: c.name,
    hint: [c.city, c.contact, c.orders ? `${c.orders} orders` : ''].filter(Boolean).join(' · '),
    run: () => { S.customers.q = c.name; location.hash = '#/customers'; },
  });

  if (!q) return out.slice(0, 9).concat(orders.slice(0, 3).map(orderItem));
  const m = (text) => String(text || '').toLowerCase().includes(q);
  return [
    ...out.filter((i) => m(i.label) || m(i.hint)),
    ...orders.filter((o) => m(o.id) || m(o.customer) || m(o.project)).slice(0, 6).map(orderItem),
    ...customers.filter((c) => m(c.name) || m(c.city) || m(c.contact)).slice(0, 4).map(custItem),
  ].slice(0, 24);
}

function paletteRender() {
  const host = $('#palette');
  if (!host) return;
  const items = PALETTE.items;
  if (PALETTE.index >= items.length) PALETTE.index = Math.max(0, items.length - 1);
  host.innerHTML = `
    <div class="palette-backdrop" data-act="palette-close"></div>
    <div class="palette" role="dialog" aria-label="Command palette">
      <div class="palette-input">
        ${icon('search')}
        <input id="paletteQ" value="${esc(PALETTE.q)}" placeholder="Search orders, customers, screens, actions…" autocomplete="off" spellcheck="false" />
        <kbd>esc</kbd>
      </div>
      <div class="palette-list">
        ${items.length ? items.map((it, i) => `
          <button class="palette-item ${i === PALETTE.index ? 'sel' : ''}" data-palette-i="${i}">
            <span class="pi-kind">${esc(it.kind)}</span>
            <span class="pi-main"><b>${esc(it.label)}</b>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</span>
            ${i === PALETTE.index ? '<span class="pi-enter">↵</span>' : ''}
          </button>`).join('') : '<div class="empty" style="padding:22px">Nothing matches that.</div>'}
      </div>
      <div class="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span>
      </div>
    </div>`;
  host.hidden = false;
  const input = $('#paletteQ');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function paletteOpen() {
  if (!S.d) return;
  PALETTE.open = true;
  PALETTE.q = '';
  PALETTE.index = 0;
  PALETTE.items = paletteItems('');
  paletteRender();
  if (!S.customers.rows) api('/api/customers').then((r) => { S.customers.rows = r.customers || []; }).catch(() => {});
}

function paletteClose() {
  PALETTE.open = false;
  const host = $('#palette');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

function paletteMove(delta) {
  if (!PALETTE.items.length) return;
  PALETTE.index = (PALETTE.index + delta + PALETTE.items.length) % PALETTE.items.length;
  paletteRender();
}

function paletteRun(i) {
  const item = PALETTE.items[i];
  if (!item) return;
  paletteClose();
  try { item.run(); } catch (e) { toast(e.message || 'Could not run that', 'err'); }
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
  wirePwMeters(host);
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

/**
 * Same rules as the server (auth.ts passwordScore), so the meter never says
 * "strong" about something the API will reject.
 */
function pwScore(pw) {
  const s = String(pw || '');
  if (!s) return 0;
  const WEAK = new Set(['password', 'password1', 'password123', 'passw0rd', '12345678', '1234567890',
    'qwerty123', 'admin123', 'welcome1', 'letmein1', 'changeme', 'solar1234']);
  if (WEAK.has(s.toLowerCase().trim())) return 1;
  let score = 0;
  if (s.length >= 8) score += 1;
  if (s.length >= 12) score += 1;
  if (s.length >= 16) score += 1;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  if (classes >= 2) score += 1;
  return Math.min(4, score);
}

/** A password input with a live strength bar underneath. */
function pwField(label, name, extra = '') {
  return `<label class="field"><span>${esc(label)}</span>
    <input name="${name}" type="password" autocomplete="new-password" data-pw-meter="${name}" ${extra} />
    <div class="pw-meter" data-pw-bar="${name}" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <small class="pw-hint" data-pw-hint="${name}">At least 8 characters</small>
  </label>`;
}

function wirePwMeters(root = document) {
  const WORDS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  $$('[data-pw-meter]', root).forEach((input) => {
    const name = input.dataset.pwMeter;
    const bar = root.querySelector(`[data-pw-bar="${name}"]`);
    const hint = root.querySelector(`[data-pw-hint="${name}"]`);
    const paint = () => {
      const score = pwScore(input.value);
      if (bar) {
        bar.dataset.score = String(score);
        $$('i', bar).forEach((seg, i) => seg.classList.toggle('on', i < score && input.value.length > 0));
      }
      if (hint) {
        hint.textContent = input.value ? WORDS[score] || '' : 'At least 8 characters';
        hint.dataset.score = String(score);
      }
    };
    input.addEventListener('input', paint);
    paint();
  });
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
    ${field('Mobile', 'phone', '', 'tel', 'autocomplete="tel"')}
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
      <input name="dept_custom" autocomplete="off" placeholder="e.g. Super Admin" />
    </label>
    <p class="sub-line wide" style="margin:0">Department <strong>Super Admin</strong> (preset or custom) opens advanced Settings, including <strong>Access control</strong>. Planning, alerts and teams stay available to other settings users.</p>
    <label class="check wide"><input type="checkbox" name="dept_admin" value="1" /> Also mark as department super admin (optional)</label>
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
  <p class="sub-line" style="margin-top:10px">Type any department name — it is saved as written and appears in every department list. Name it <strong>Super Admin</strong> to open the advanced Settings page (Access control, planning, alerts and teams) for this account.</p>`;

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

async function addAccessRole(name) {
  const role = String(name || '').trim();
  if (!role) throw new Error('Type a role name');
  if (!/^[A-Za-z][A-Za-z0-9 &/._-]{0,39}$/.test(role)) throw new Error('Use letters, digits, spaces or & / . _ -');
  if (role.toLowerCase() === 'owner') throw new Error('Owner is reserved');
  const access = { ...(S.d.settings.access || {}) };
  if (access[role]) throw new Error(`"${role}" is already in the matrix`);
  access[role] = [];
  const res = await api('/api/settings', 'PUT', { ...S.d.settings, access });
  apply(res);
  toast(`Custom role ${role} added — tick its access, then save`, 'ok');
}

function accessRoleModal() {
  const body = `<div class="form-grid">
    <label class="field wide"><span>Role name *</span>
      <input name="role" autocomplete="off" placeholder="e.g. Store Keeper" required />
    </label>
  </div>
  <p class="sub-line" style="margin-top:10px">Adds a row below Viewer in the matrix. Give it any ticks you want — it then applies to every account with that role.</p>`;
  modal({
    title: 'Add custom role to the matrix',
    sub: 'Type any job title and tick what it may do.',
    body,
    submit: 'Add role',
    async onSubmit(data) {
      await addAccessRole(data.role);
      closeModal();
      render();
    },
  });
}

/* ── floating AI assistant ─────────────────────────────────── */
const AI = { log: [], busy: false };

function renderAi() {
  const log = $('#aiLog');
  if (!log) return;
  const me = (S.d && S.d.me) || {};
  if (!AI.log.length) {
    const person = String(me.name || me.email || 'there').trim();
    AI.log.push({
      role: 'assistant',
      content: `Hi ${person} — welcome to ARS Solartech CRM. Ask me about any order, a delay, the approval queue or who is overloaded.`,
    });
  }
  const off = !(S.d && S.d.meta && S.d.meta.aiConfigured);
  log.innerHTML = (off
    ? '<div class="ai-note">The assistant key is not set on the Worker yet. Everything else in the CRM works; add OPENAI_API_KEY to switch this on.</div>'
    : '') + AI.log.map((m) => `<div class="ai-msg ${m.role}${m.error ? ' err' : ''}">${esc(m.content).replace(/\n/g, '<br>')}</div>`).join('')
    + (AI.busy ? '<div class="ai-msg assistant typing">Thinking…</div>' : '');
  log.scrollTop = log.scrollHeight;
}

async function sendAi(text) {
  const msg = String(text || '').trim();
  if (!msg || AI.busy) return;
  AI.log.push({ role: 'user', content: msg });
  AI.busy = true;
  renderAi();
  const input = $('#aiInput');
  if (input) input.value = '';
  try {
    const res = await api('/api/ai/chat', 'POST', { message: msg, history: AI.log.slice(-9, -1) });
    AI.log.push({ role: 'assistant', content: res.reply || 'No answer returned.' });
  } catch (e) {
    AI.log.push({ role: 'assistant', content: e.message || 'The assistant is unavailable.', error: true });
  } finally {
    AI.busy = false;
    renderAi();
  }
}

function wireAi() {
  const form = $('#aiForm');
  if (!form) return;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('#aiInput');
    sendAi(input ? input.value : '');
  });
  renderAi();
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
    ${pwField('New password', 'password', 'required minlength="8" autocomplete="new-password"')}
  </div>`;
  modal({
    title: `Reset password — ${name}`,
    sub: 'Tell them the new password. Their other devices are signed out so the change actually takes effect.',
    body,
    submit: 'Set password',
    async onSubmit(data) {
      if (!data.password || data.password.length < 8) throw new Error('Password must be at least 8 characters');
      const res = await api('/api/users/' + encodeURIComponent(sub), 'PATCH', { password: data.password });
      apply(res);
      closeModal();
      render();
      toast('Password updated and old sessions signed out', 'ok');
    },
  });
}


function customerModal(existing) {
  const c = existing || {};
  const body = `
    <div class="form-grid">
      ${field('Customer name *', 'name', c.name || '', 'text', 'required maxlength="160"')}
      ${field('Contact person', 'contact', c.contact || '')}
      ${field('Phone', 'phone', c.phone || '', 'tel')}
      ${field('Email', 'email', c.email || '', 'email')}
      ${field('GSTIN', 'gstin', c.gstin || '', 'text', 'maxlength="20"')}
      ${field('City', 'city', c.city || '')}
      ${field('State', 'state', c.state || '')}
      ${field('PIN', 'pincode', c.pincode || '', 'text', 'maxlength="10"')}
    </div>
    <label class="field"><span>Address</span>
      <textarea name="address" rows="2">${esc(c.address || '')}</textarea></label>
    <label class="field"><span>Notes</span>
      <textarea name="notes" rows="2" placeholder="Payment terms, relationship history, anything the team should know">${esc(c.notes || '')}</textarea></label>
    ${existing ? `<label class="inline" style="margin-top:4px">
      <input type="checkbox" name="active" ${c.active ? 'checked' : ''} /> <span class="sub-line" style="margin:0">Active (unticked keeps the record but hides it from new orders)</span>
    </label>` : ''}`;
  modal({
    title: existing ? `Edit ${c.name}` : 'New customer',
    sub: existing ? 'Contact details, billing address and notes.' : 'The master record every order can draw its details from.',
    body,
    submit: existing ? 'Save customer' : 'Add customer',
    async onSubmit(data) {
      const payload = { ...data, active: existing ? (data.active ? 1 : 0) : 1 };
      const res = existing
        ? await api('/api/customers/' + encodeURIComponent(c.id), 'PATCH', payload)
        : await api('/api/customers', 'POST', payload);
      S.customers.rows = res.customers;
      if (res.missing) S.customers.missing = res.missing;
      closeModal();
      render();
      toast(existing ? 'Customer updated' : 'Customer added', 'ok');
    },
  });
}

function tagModal(orderId) {
  const o = S.d.orders.find((x) => x.id === orderId);
  if (!o) return;
  const current = (o.tags || []).join(', ');
  const known = (S.d.tags || []).map((t) => t.tag);
  const body = `
    ${field('Tags (comma separated)', 'tags', current, 'text', 'maxlength="160" placeholder="urgent, rework, hold"')}
    <p class="sub-line">Up to 8 tags, 24 characters each. Tags are filterable and appear on the order row.</p>
    ${known.length ? `<div class="inline" style="margin-top:10px">${known.map((t) => `<button type="button" class="tag" data-tag-pick="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}`;
  modal({
    title: `Tags — ${o.customer || o.id}`,
    sub: 'A fast way to group orders that need the same attention.',
    body,
    submit: 'Save tags',
    async onSubmit(data) {
      const tags = String(data.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      const res = await api('/api/orders/' + encodeURIComponent(o.id) + '/tags', 'PUT', { tags });
      apply(res);
      closeModal();
      render();
      toast('Tags saved', 'ok');
    },
  });
  $$('[data-tag-pick]', $('#modal')).forEach((b) => {
    b.addEventListener('click', () => {
      const input = $('[name=tags]', $('#modal'));
      const list = input.value.split(',').map((t) => t.trim()).filter(Boolean);
      if (!list.includes(b.dataset.tagPick)) list.push(b.dataset.tagPick);
      input.value = list.join(', ');
    });
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

/* A real calendar day as YYYY-MM-DD, or null. An import with "2026-13-45" in
   the date column used to send it straight to the server; a bad date in one row
   then broke every screen. Validation belongs here as well as on the server. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function realDay(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1)) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const max = m === 2 && leap ? 29 : MONTH_DAYS[m - 1];
  if (d > max) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return realDay(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return realDay(y, m[2], m[1]);
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
  'palette-open': () => paletteOpen(),
  'palette-close': () => paletteClose(),
  'print': () => window.print(),
  'save-view': () => saveViewModal(),
  'apply-view': (el) => applyView(el.dataset.view),
  'del-view': (el) => deleteView(el.dataset.view),
  'new-customer': () => customerModal(null),
  'edit-customer': (el) => {
    const c = (S.customers.rows || []).find((x) => x.id === el.dataset.id);
    if (c) customerModal(c);
  },
  'del-customer': async (el) => {
    if (!confirm(`Delete ${el.dataset.name} from the customer master? Orders stay as they are.`)) return;
    try {
      const res = await api('/api/customers/' + encodeURIComponent(el.dataset.id), 'DELETE');
      S.customers.rows = res.customers;
      S.customers.missing = res.missing;
      render();
      toast('Customer deleted', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'customers-backfill': async () => {
    try {
      const res = await api('/api/customers/backfill', 'POST', {});
      S.customers.rows = res.customers;
      S.customers.missing = res.missing;
      render();
      toast(`${res.added} customer(s) added from the order book`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'add-note': async (el) => {
    const id = el.dataset.id;
    const box = document.querySelector(`[data-note-input="${id}"]`);
    const body = box ? box.value.trim() : '';
    if (!body) { if (box) box.focus(); return; }
    el.disabled = true;
    try {
      const res = await api('/api/orders/' + encodeURIComponent(id) + '/notes', 'POST', { body });
      S.notes.orderId = id;
      S.notes.rows = res.notes || [];
      if (box) box.value = '';
      const host = document.querySelector(`[data-notes="${id}"]`);
      if (host) host.innerHTML = notesHtml(id);
      const count = document.querySelector(`[data-notes-count="${id}"]`);
      if (count) count.textContent = S.notes.rows.length || '';
      toast('Note posted', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    el.disabled = false;
  },
  'del-note': async (el) => {
    if (!confirm('Delete this note?')) return;
    const id = el.dataset.id;
    try {
      const res = await api(`/api/orders/${encodeURIComponent(id)}/notes/${encodeURIComponent(el.dataset.note)}`, 'DELETE');
      S.notes.orderId = id;
      S.notes.rows = res.notes || [];
      const host = document.querySelector(`[data-notes="${id}"]`);
      if (host) host.innerHTML = notesHtml(id);
    } catch (e) { toast(e.message, 'err'); }
  },
  'tag-order': (el) => tagModal(el.dataset.id),
  'untag-order': async (el) => {
    const o = S.d.orders.find((x) => x.id === el.dataset.id);
    if (!o) return;
    const tags = (o.tags || []).filter((t) => t !== el.dataset.tag);
    try {
      const res = await api('/api/orders/' + encodeURIComponent(o.id) + '/tags', 'PUT', { tags });
      apply(res);
      render();
    } catch (e) { toast(e.message, 'err'); }
  },
  'bulk-clear': () => { S.picked.clear(); render(); },
  'audit-more': () => loadActivity(true),
  'sessions-refresh': () => loadSessions(),
  'revoke-session': async (el) => {
    const id = el.dataset.id;
    if (!confirm('Sign that device out? It will have to sign in again.')) return;
    el.disabled = true;
    try {
      const res = await api('/api/sessions/revoke', 'POST', { id });
      await loadSessions();
      toast(res.revoked ? 'Device signed out' : 'That device was already gone', 'ok');
    } catch (e) { toast(e.message, 'err'); el.disabled = false; }
  },
  'revoke-others': async () => {
    if (!confirm('Sign out every other device? You stay signed in here.')) return;
    try {
      const res = await api('/api/sessions/revoke-others', 'POST');
      await loadSessions();
      toast(res.revoked ? `${res.revoked} device(s) signed out` : 'No other devices to sign out', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
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
  'toggle-dept-admin': async (el) => {
    const on = el.dataset.active === '1';
    try {
      const res = await api('/api/users/' + encodeURIComponent(el.dataset.id), 'PATCH', { dept_admin: on ? 0 : 1 });
      apply(res); render();
      toast(on ? 'Department super admin removed' : 'Department super admin set — advanced Settings is now open for them', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'add-access-role': () => accessRoleModal(),
  'add-access-role-inline': async () => {
    const input = $('#newAccessRole');
    try { await addAccessRole(input ? input.value : ''); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  'del-access-role': async (el) => {
    const role = el.dataset.role;
    if (!confirm(`Remove the custom role "${role}" from the access matrix?`)) return;
    const access = { ...(S.d.settings.access || {}) };
    delete access[role];
    try {
      const res = await api('/api/settings', 'PUT', { ...S.d.settings, access });
      apply(res); render(); toast('Custom role removed', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'save-alerts': async () => {
    const notify = {
      email: !!($('[data-notify="email"]') || {}).checked,
      whatsapp: !!($('[data-notify="whatsapp"]') || {}).checked,
      webhook: (($('[data-notify="webhook"]') || {}).value || '').trim(),
      escalate: Number((($('[data-notify="escalate"]') || {}).value)) || 2,
    };
    try {
      const res = await api('/api/settings', 'PUT', { ...S.d.settings, notify });
      apply(res); render(); toast('Alert settings saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'test-alert': async () => {
    try {
      const res = await api('/api/notifications/test', 'POST');
      apply(res); render();
      toast(res.channels ? `${res.channels} alert(s) queued to you` : 'No channel is enabled yet — turn one on and save first', res.channels ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
  },
  'run-escalations': async (el) => {
    el.disabled = true;
    try {
      const res = await api('/api/escalations/run', 'POST');
      apply(res); render();
      toast(`${res.orders} overdue order(s) · ${res.alerts} alert(s) queued`, res.alerts ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); el.disabled = false; }
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
      access: S.d.settings.access,
      notify: S.d.settings.notify,
    };
    try {
      const res = await api('/api/settings', 'PUT', body);
      apply(res); render(); toast('Planning settings saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'save-access': async () => {
    const access = { ...(S.d.settings.access || {}) };
    $$('[data-access]').forEach((box) => {
      const role = box.dataset.access;
      const key = box.dataset.actKey;
      const list = access[role] ? access[role].slice() : [];
      const has = list.includes(key);
      if (box.checked && !has) list.push(key);
      if (!box.checked && has) list.splice(list.indexOf(key), 1);
      access[role] = list;
    });
    try {
      const res = await api('/api/settings', 'PUT', { ...S.d.settings, access });
      apply(res); render(); toast('Access rules saved', 'ok');
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
    stopSync();
    try { await api('/api/auth/logout', 'POST'); } catch { /* ignore */ }
    clearCache();
    S.d = null;
    location.reload();
  },
  import: () => importModal(),
  export: () => { exportOrders(); exportDispatches(); },
  'ai-toggle': () => {
    const panel = $('#aiPanel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      renderAi();
      const input = $('#aiInput');
      if (input) input.focus();
    }
  },
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

// Audit search is debounced: it hits the server, so typing must not fire a
// request per keystroke.
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'custQ') {
    S.customers.q = ev.target.value;
    const pos = ev.target.selectionStart;
    render();
    const q = $('#custQ');
    if (q) { q.focus(); q.setSelectionRange(pos, pos); }
  }
});

let auditTimer = 0;
document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'auditQ') return;
  S.activity.q = ev.target.value;
  clearTimeout(auditTimer);
  auditTimer = setTimeout(() => { loadActivity(); }, 280);
});
document.addEventListener('change', async (ev) => {
  if (ev.target.id === 'auditEntity') {
    S.activity.entity = ev.target.value;
    loadActivity();
    return;
  }
  if (ev.target.id === 'pickAll') {
    const rows = filteredOrders();
    if (ev.target.checked) rows.forEach((o) => S.picked.add(o.id));
    else S.picked.clear();
    render();
    return;
  }
  if (ev.target.dataset && ev.target.dataset.pick) {
    const id = ev.target.dataset.pick;
    if (ev.target.checked) S.picked.add(id);
    else S.picked.delete(id);
    render();
    return;
  }
  if (ev.target.id === 'bulkAction' && ev.target.value) {
    const [action, ...rest] = ev.target.value.split(':');
    const value = rest.join(':');
    const ids = [...S.picked];
    if (!ids.length) return;
    const label = action === 'delete'
      ? `Delete ${ids.length} order(s) and everything on them?`
      : `Apply "${action}${value ? ' → ' + value : ''}" to ${ids.length} order(s)?`;
    if (!confirm(label)) { ev.target.value = ''; return; }
    ev.target.disabled = true;
    try {
      const res = await api('/api/orders/bulk', 'POST', { ids, action, value });
      S.picked.clear();
      apply(res);
      render();
      toast(`${res.changed} order(s) updated`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
      ev.target.disabled = false;
    }
  }
});

// The status chip is not a reload button — but tapping it forces a sync, which
// is what anyone instinctively tries. It just never looks like a control.
document.addEventListener('click', (ev) => {
  // A checkbox in a clickable row is a selection, not a navigation.
  if (ev.target.closest && ev.target.closest('.pick, .tag')) { ev.stopPropagation(); return; }
  if (!ev.target.closest || !ev.target.closest('[data-act="sync-check"]')) return;
  if (Date.now() < SYNC.busyUntil) return;
  syncPull();
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
  // ⌘K / Ctrl+K — the shortcut people already have in their fingers.
  if ((ev.metaKey || ev.ctrlKey) && String(ev.key).toLowerCase() === 'k') {
    ev.preventDefault();
    if (PALETTE.open) paletteClose(); else paletteOpen();
    return;
  }
  if (PALETTE.open) {
    if (ev.key === 'Escape') { ev.preventDefault(); paletteClose(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); paletteMove(1); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); paletteMove(-1); return; }
    if (ev.key === 'Enter') {
      // if focus is in the search box, Enter runs the highlighted row
      ev.preventDefault();
      paletteRun(PALETTE.index);
      return;
    }
  }
  if (ev.key === 'Escape') { closeModal(); closeDrawer(); }
  // A single "/" focuses the search box on the screen you are on.
  if (ev.key === '/' && !PLAINTEXT.includes(document.activeElement && document.activeElement.tagName)) {
    const box = $('#q') || $('#custQ');
    if (box) { ev.preventDefault(); box.focus(); }
  }
});

const PLAINTEXT = ['INPUT', 'TEXTAREA', 'SELECT'];

document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'paletteQ') return;
  PALETTE.q = ev.target.value;
  PALETTE.index = 0;
  PALETTE.items = paletteItems(PALETTE.q);
  paletteRender();
});

document.addEventListener('click', (ev) => {
  const item = ev.target.closest && ev.target.closest('[data-palette-i]');
  if (item) { paletteRun(Number(item.dataset.paletteI)); }
});

/* ── boot ──────────────────────────────────────────────────── */
(async function boot() {
  paintTheme();
  routeFromHash();
  wireAuthForms();
  wireAi();
  const cached = readCache();
  if (cached) {
    // Render the last snapshot instantly. Only ask the server when it is stale,
    // so repeat opens/reloads cost zero Worker requests.
    S.d = cached.snap;
    SYNC.token = cached.rev ? String(cached.rev) : null;
    render();
    startSync();
    if (Date.now() - cached.at < CACHE_TTL) return;
  }
  await loadApp();
  startSync();
})();
