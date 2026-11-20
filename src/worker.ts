// ARS Solartech - Order to Dispatch Management System
// Cloudflare Worker: Sign in with Freebuff + role-based API + static SPA.
import { Hono } from 'hono';

import { ensureSchema } from './schema';

// Schema setup is idempotent but still costs D1 queries, so it runs once per
// isolate instead of on every single API request.
let schemaReady = false;
async function ensureSchemaOnce(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await ensureSchema(db);
  schemaReady = true;
}
import {
  clearSessionCookie,
  hashPassword,
  newSessionToken,
  passwordProblem,
  readSessionToken,
  sameOrigin,
  sessionCookie,
  sessionExpiry,
  sha256,
  validEmail,
  verifyPassword,
} from './auth';
import {
  DEFAULT_SETTINGS,
  DEPTS,
  STAGE_META,
  STAGES,
  todayISO,
  type Settings,
  type StageKey,
} from './plan';
import {
  can,
  capabilities,
  createAccessRequest,
  dashboard,
  decideAccessRequest,
  deleteDispatch,
  deleteOrder,
  enrich,
  ensureUser,
  createSession,
  createUser,
  deleteSession,
  findUserByEmail,
  getAccessRequest,
  isRootAdmin,
  listAccessRequests,
  noUsersYet,
  purgeSessions,
  sessionUser,
  setPassword,
  getSettings,
  listDispatchRows,
  addDeptPerson,
  assignStage,
  deleteDeptPerson,
  listDeptPeople,
  listEvents,
  listOrderRows,
  listStageRows,
  listStakeholders,
  setOrderApproval,
  listUsers,
  getUser,
  logEvent,
  saveDispatch,
  saveOrder,
  saveSettings,
  saveStakeholder,
  setStage,
  updateUser,
  type Action,
  type Role,
  type User,
} from './db';

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
  APP_ORIGIN?: string;
}

type Ctx = { Bindings: Env; Variables: { user: User } };

const ROLES: Role[] = ['owner', 'admin', 'manager', 'editor', 'viewer'];

/**
 * Preset roles, or a custom job title an admin typed. "owner" is reserved for
 * the first account, and names that match a preset collapse to it.
 */
function roleValue(v: unknown): Role | null {
  const s = str(v, 40);
  if (!s) return null;
  const low = s.toLowerCase();
  // Owner is assignable too: an Admin can hand another account the same
  // full control, and the last owner can never be demoted.
  if (low === 'owner') return 'owner';
  if (low === 'admin' || low === 'manager' || low === 'editor' || low === 'viewer') return low;
  return /^[A-Za-z][A-Za-z0-9 &/._-]{0,39}$/.test(s) ? s : null;
}

const app = new Hono<Ctx>();

// APP_ORIGIN is set on managed hosting; a plain Cloudflare deploy derives it
// from the request so cookies and the origin guard still work out of the box.
const siteOrigin = (c: any): string => c.env.APP_ORIGIN || new URL(c.req.url).origin;

// Public readiness probe (registered before the auth guard on purpose).
// Also runs the idempotent schema bootstrap so a fresh deployment is usable.
app.get('/healthz', async (c) => {
  try {
    await ensureSchemaOnce(c.env.DB);
    return c.json({ ok: true, db: 'ready', at: new Date().toISOString() });
  } catch (err) {
    return c.json({ ok: false, db: 'error', error: String((err as Error)?.message || err) }, 500);
  }
});

// ---------------------------------------------------------------- auth (public)
async function startSession(c: any, user: User) {
  const { token, tokenHash } = await newSessionToken();
  await createSession(c.env.DB, user.sub, tokenHash, sessionExpiry());
  c.header('Set-Cookie', sessionCookie(token, siteOrigin(c)));
}

// Tells the login page whether it should show "create the admin account".
app.get('/api/auth/state', async (c) => {
  await ensureSchemaOnce(c.env.DB);
  return c.json({ needsSetup: await noUsersYet(c.env.DB) });
});

// First run: the very first account becomes the owner (shown as "Admin").
app.post('/api/auth/setup', async (c) => {
  await ensureSchemaOnce(c.env.DB);
  if (!sameOrigin(c.req.raw, siteOrigin(c))) return c.json({ error: 'bad_origin' }, 403);
  if (!(await noUsersYet(c.env.DB))) {
    return c.json({ error: 'setup_closed', message: 'An admin account already exists. Ask them for an account.' }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const email = validEmail(body.email);
  if (!email) return c.json({ error: 'bad_email', message: 'Enter a valid email address' }, 400);
  const problem = passwordProblem(body.password);
  if (problem) return c.json({ error: 'weak_password', message: problem }, 400);
  const name = str(body.name, 80) || email.split('@')[0];
  const user = await createUser(c.env.DB, {
    sub: crypto.randomUUID(),
    email,
    name,
    dept: null,
    role: 'owner',
    passHash: await hashPassword(String(body.password)),
  });
  await logEvent(c.env.DB, { sub: user.sub, name: user.name }, 'user', user.sub, 'create',
    `Admin account ${email} created`);
  await startSession(c, user);
  c.set('user', user);
  return c.json({ ok: true, me: user, snapshot: await snapshot(c) });
});

app.post('/api/auth/login', async (c) => {
  await ensureSchemaOnce(c.env.DB);
  if (!sameOrigin(c.req.raw, siteOrigin(c))) return c.json({ error: 'bad_origin' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const email = validEmail(body.email);
  const password = String(body.password ?? '');
  if (!email || !password) return c.json({ error: 'bad_credentials', message: 'Email and password are required' }, 400);

  const row = await findUserByEmail(c.env.DB, email);
  const ok = row ? await verifyPassword(password, row.pass_hash) : false;
  if (!row || !ok) return c.json({ error: 'bad_credentials', message: 'Wrong email or password' }, 401);
  if (!row.active) return c.json({ error: 'account_disabled', message: 'This account is disabled' }, 403);

  await purgeSessions(c.env.DB);
  const user: User = { sub: row.sub, email: row.email, name: row.name, dept: row.dept, role: row.role, active: row.active };
  // The designated super admin always comes back as owner, even if a row in an
  // older database still points at another role.
  if (isRootAdmin(user) && user.role !== 'owner') {
    await updateUser(c.env.DB, user.sub, { role: 'owner' });
    user.role = 'owner';
    await logEvent(c.env.DB, { sub: user.sub, name: user.name }, 'user', user.sub, 'role',
      'Super admin restored to owner');
  }
  await startSession(c, user);
  await logEvent(c.env.DB, { sub: user.sub, name: user.name }, 'user', user.sub, 'signin',
    `${user.name || email} signed in`);
  c.set('user', user);
  return c.json({ ok: true, me: user, snapshot: await snapshot(c) });
});

app.post('/api/auth/logout', async (c) => {
  const token = readSessionToken(c.req.raw);
  if (token) await deleteSession(c.env.DB, await sha256(token));
  c.header('Set-Cookie', clearSessionCookie(siteOrigin(c)));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- auth guard
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await ensureSchemaOnce(c.env.DB);

  const token = readSessionToken(c.req.raw);
  const user = token ? await sessionUser(c.env.DB, await sha256(token)) : null;
  if (!user) {
    // Save the client a second round trip: the 401 itself says whether the
    // very first admin account still has to be created.
    return c.json({ error: 'signin_required', message: 'Sign in required', needsSetup: await noUsersYet(c.env.DB) }, 401);
  }
  c.set('user', user);
  await next();
});

// Every state change must come from this site's own pages.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    if (!sameOrigin(c.req.raw, siteOrigin(c))) {
      return c.json({ error: 'bad_origin' }, 403);
    }
  }
  await next();
});

// ---------------------------------------------------------------- helpers
function guard(c: any, action: Action) {
  const u: User = c.get('user');
  if (!can(u, action)) {
    return c.json({ error: 'forbidden', message: `Your role/department cannot perform "${action}"` }, 403);
  }
  return null;
}

const str = (v: unknown, max = 500): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
};

// A department is either a preset or any name an admin typed by hand.
const deptName = (v: unknown): string | null => {
  const s = str(v, 60);
  if (!s) return null;
  return /^[A-Za-z0-9][A-Za-z0-9 &/._()+-]{0,59}$/.test(s) ? s : null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const date = (v: unknown): string | null => {
  const s = str(v, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

export type RosterPerson = {
  id: string;
  dept: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  sub: string | null;
  account: boolean;
};

/** Everyone in every department: accounts first, then names added by hand. */
async function deptRoster(db: D1Database): Promise<RosterPerson[]> {
  const [people, users] = await Promise.all([listDeptPeople(db), listUsers(db)]);
  const out: RosterPerson[] = [];
  for (const u of users) {
    if (!u.dept || !u.active) continue;
    out.push({ id: 'acct-' + u.sub, dept: u.dept, name: u.name, email: u.email, phone: null, sub: u.sub, account: true });
  }
  for (const p of people) {
    out.push({ id: p.id, dept: p.dept, name: p.name, email: p.email, phone: p.phone, sub: p.sub, account: false });
  }
  return out;
}

/** First couple of names per department, for the pipeline labels. */
function headsFrom(roster: RosterPerson[]): Record<string, string> {
  const out: Record<string, string> = {};
  const seen: Record<string, number> = {};
  for (const p of roster) {
    if (!p.name) continue;
    const n = seen[p.dept] || 0;
    seen[p.dept] = n + 1;
    if (n >= 2) continue;
    out[p.dept] = out[p.dept] ? out[p.dept] + ' · ' + p.name : p.name;
  }
  return out;
}

async function nextId(db: D1Database, prefix: string, table: 'orders' | 'dispatches'): Promise<string> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id LIKE ?`).bind(prefix + '%').first<{ n: number }>();
  let n = (row?.n || 0) + 1;
  let id = prefix + String(n).padStart(3, '0');
  let guardCount = 0;
  while (guardCount++ < 500) {
    const hit = await db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).bind(id).first();
    if (!hit) break;
    n++;
    id = prefix + String(n).padStart(3, '0');
  }
  return id;
}

function fyPrefix(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const fy = now.getUTCMonth() + 1 >= 4 ? y : y - 1;
  return `ARS-${String(fy).slice(2)}${String(fy + 1).slice(2)}-`;
}

async function snapshot(c: any) {
  const env = c.env as Env;
  const user: User = c.get('user');
  const db = env.DB;
  const [settings, orders, stages, dispatches, stakeholders, users] = await Promise.all([
    getSettings(db),
    listOrderRows(db),
    listStageRows(db),
    listDispatchRows(db),
    listStakeholders(db),
    listUsers(db),
  ]);
  const roster = await deptRoster(db);
  const heads = headsFrom(roster);
  const today = todayISO();
  const enriched = enrich(orders, stages, dispatches, settings, heads, today);
  const dash = dashboard(enriched, 16, settings);
  const caps = capabilities(user);
  // Admins see every request; everyone else only sees their own.
  const accessRequests = await listAccessRequests(db, 60, caps.users ? undefined : user.sub);
  return {
    me: user,
    capabilities: caps,
    settings,
    orders: enriched,
    dispatches,
    stakeholders,
    deptPeople: roster,
    users,
    activity: await listEvents(db, 120),
    dashboard: dash,
    accessRequests,
    today,
    meta: {
      stages: STAGE_META,
      depts: [...new Set([...DEPTS, ...users.map((u) => u.dept).filter((d): d is string => !!d)])],
      roles: ROLES,
      customRoles: [...new Set(users.map((u) => u.role))]
        .filter((r) => r && !ROLES.includes(r)),
      pendingRequests: accessRequests.filter((r) => r.status === 'pending').length,
    },
  };
}

// ---------------------------------------------------------------- session
app.get('/api/me', async (c) => {
  const s = await snapshot(c);
  return c.json({ me: s.me, capabilities: s.capabilities, meta: s.meta });
});

app.get('/api/bootstrap', async (c) => c.json(await snapshot(c)));

// ---------------------------------------------------------------- orders
app.post('/api/orders', async (c) => {
  const denied = guard(c, 'order');
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const id = str(body.id, 40) || (await nextId(c.env.DB, fyPrefix(), 'orders'));
  const exists = await c.env.DB.prepare('SELECT 1 AS x FROM orders WHERE id = ?').bind(id).first();
  if (exists) return c.json({ error: 'duplicate_id', message: `Order ${id} already exists` }, 409);

  await saveOrder(c.env.DB, id, { ...body, status: str(body.status) || 'open' }, c.get('user').sub, true);
  const u: User = c.get('user');
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'order', id, 'create',
    `${u.name || u.email || 'user'} created order ${id} for ${str(body.customer) || 'customer'}`);
  return c.json({ ok: true, id, snapshot: await snapshot(c) });
});

app.patch('/api/orders/:id', async (c) => {
  const denied = guard(c, 'order');
  if (denied) return denied;
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT 1 AS x FROM orders WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  await saveOrder(c.env.DB, id, body, c.get('user').sub, false);
  const u: User = c.get('user');
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'order', id, 'update', `${u.name || 'user'} updated order ${id}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

app.delete('/api/orders/:id', async (c) => {
  const denied = guard(c, 'delete');
  if (denied) return denied;
  const id = c.req.param('id');
  await deleteOrder(c.env.DB, id);
  const u: User = c.get('user');
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'order', id, 'delete', `${u.name || 'user'} deleted order ${id}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// Mark / clear a stage actual date.
app.post('/api/orders/:id/stages/:stage', async (c) => {
  const stage = c.req.param('stage') as StageKey;
  if (!(STAGES as readonly string[]).includes(stage)) return c.json({ error: 'bad_stage' }, 400);
  const denied = guard(c, stage as Action);
  if (denied) return denied;

  const id = c.req.param('id');
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<any>();
  if (!order) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const d = body.date === null || body.date === '' ? null : date(body.date) || todayISO();

  const settings = await getSettings(c.env.DB);
  const stageRows = await c.env.DB.prepare('SELECT stage, actual_date FROM order_stages WHERE order_id = ?').bind(id).all<any>();
  const actuals: any = {};
  for (const r of stageRows.results || []) if (r.actual_date) actuals[r.stage] = r.actual_date;
  const enriched = enrich([order], [{ order_id: id, stage, actual_date: d } as any], [], settings, {})[0];
  const plan: any = enriched.live.plan;
  const planned = plan ? plan[stage] : null;

  const u: User = c.get('user');
  const full = u.role === 'owner' || u.role === 'admin' || u.role === 'manager';
  const assigned = await c.env.DB
    .prepare('SELECT assigned_sub, assigned_name FROM order_stages WHERE order_id = ? AND stage = ?')
    .bind(id, stage)
    .first<{ assigned_sub: string | null; assigned_name: string | null }>();
  if (d && assigned?.assigned_sub && assigned.assigned_sub !== u.sub && !full) {
    return c.json({ error: 'not_assigned', message: `${assigned.assigned_name || 'Someone else'} is handling this stage` }, 403);
  }

  await setStage(c.env.DB, id, stage, d, planned ?? null, u.sub, u.name);
  const label = STAGE_META.find((m) => m.key === stage)?.actual || stage;
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'order', id, d ? 'stage_done' : 'stage_reopen',
    d ? `${label} - ${d}` : `${label} cleared`);

  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// Pick the person inside the department who works this stage.
app.post('/api/orders/:id/stages/:stage/assign', async (c) => {
  const stage = c.req.param('stage') as StageKey;
  if (!(STAGES as readonly string[]).includes(stage)) return c.json({ error: 'bad_stage' }, 400);
  const denied = guard(c, stage as Action);
  if (denied) return denied;
  const id = c.req.param('id');
  const order = await c.env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
  if (!order) return c.json({ error: 'not_found' }, 404);

  const me: User = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const sub = str(body.sub, 60);
  const full = me.role === 'owner' || me.role === 'admin' || me.role === 'manager';
  let name: string | null = null;
  if (sub) {
    const target = await getUser(c.env.DB, sub);
    if (!target || !target.active) return c.json({ error: 'bad_user', message: 'Pick an active account' }, 400);
    if (!full && target.dept !== me.dept) {
      return c.json({ error: 'wrong_dept', message: 'You can only assign people from your own department' }, 400);
    }
    name = target.name || target.email;
  }

  await assignStage(c.env.DB, id, stage, sub, name);
  const label = STAGE_META.find((m) => m.key === stage)?.label || stage;
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'order', id, 'assign',
    `${label}: ${name || 'unassigned'}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// Final sign-off from Admin / Manager once every department is finished.
app.post('/api/orders/:id/approval', async (c) => {
  const me: User = c.get('user');
  if (!['owner', 'admin', 'manager'].includes(me.role)) {
    return c.json({ error: 'forbidden', message: 'Only Admin or Manager gives the final approval' }, 403);
  }
  const id = c.req.param('id');
  const order = await c.env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
  if (!order) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const approve = body.decision !== 'reset';

  if (approve) {
    const { results } = await c.env.DB
      .prepare('SELECT stage FROM order_stages WHERE order_id = ? AND actual_date IS NOT NULL')
      .bind(id)
      .all<{ stage: string }>();
    const done = new Set((results || []).map((r) => r.stage));
    const missing = STAGE_META.filter((m) => !done.has(m.key));
    if (missing.length) {
      return c.json({ error: 'stages_open', message: `Still open: ${missing.map((m) => m.label).join(', ')}` }, 400);
    }
  }

  await setOrderApproval(c.env.DB, id, approve ? 'approved' : 'pending', me.sub);
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'order', id, approve ? 'approved' : 'approval_reset',
    approve ? 'Final approval given' : 'Final approval reopened');
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- department people
app.post('/api/dept-people', async (c) => {
  const denied = guard(c, 'settings');
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const dept = deptName(body.dept);
  if (!dept) return c.json({ error: 'dept_required', message: 'Pick a department first' }, 400);
  const name = str(body.name, 80);
  const email = str(body.email, 120);
  const phone = str(body.phone, 30);
  if (!name && !email && !phone) {
    return c.json({ error: 'name_required', message: 'Enter a name, email or mobile' }, 400);
  }
  const me: User = c.get('user');
  await addDeptPerson(c.env.DB, { id: crypto.randomUUID(), dept, name, email, phone });
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'dept', dept, 'person_add',
    `${name || email || phone} added to ${dept}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

app.delete('/api/dept-people/:id', async (c) => {
  const denied = guard(c, 'settings');
  if (denied) return denied;
  const id = c.req.param('id');
  const me: User = c.get('user');
  await deleteDeptPerson(c.env.DB, id);
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'dept', id, 'person_remove', 'Department contact removed');
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- dispatches
app.post('/api/dispatches', async (c) => {
  const denied = guard(c, 'disp');
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const orderId = str(body.order_id, 40);
  if (!orderId) return c.json({ error: 'order_required' }, 400);
  const order = await c.env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(orderId).first();
  if (!order) return c.json({ error: 'order_not_found' }, 404);
  const qty = num(body.qty);
  if (qty === null || qty <= 0) return c.json({ error: 'qty_required' }, 400);

  const id = str(body.id, 40) || (await nextId(c.env.DB, 'DSP-', 'dispatches'));
  await saveDispatch(c.env.DB, { ...body, id, order_id: orderId, qty }, c.get('user').sub, true);
  const u: User = c.get('user');
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'dispatch', id, 'create',
    `${qty} MT for ${orderId}${body.invoice ? ' (invoice ' + body.invoice + ')' : ''}`);
  return c.json({ ok: true, id, snapshot: await snapshot(c) });
});

app.patch('/api/dispatches/:id', async (c) => {
  const denied = guard(c, 'disp');
  if (denied) return denied;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  await saveDispatch(c.env.DB, { ...body, id }, c.get('user').sub, false);
  const u: User = c.get('user');
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'dispatch', id, 'update', `${u.name || 'user'} updated dispatch ${id}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

app.delete('/api/dispatches/:id', async (c) => {
  const denied = guard(c, 'delete');
  if (denied) return denied;
  const id = c.req.param('id');
  await deleteDispatch(c.env.DB, id);
  const u: User = c.get('user');
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'dispatch', id, 'delete', `${u.name || 'user'} deleted dispatch ${id}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- settings
function sanitizeSettings(raw: any): Settings {
  const d = raw?.dur || {};
  const off = Array.isArray(raw?.off) ? raw.off.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6) : DEFAULT_SETTINGS.off;
  const holidays = Array.isArray(raw?.holidays)
    ? raw.holidays.map((h: any) => date(h)).filter(Boolean).slice(0, 200)
    : [];
  const clamp = (v: any, lo: number, hi: number, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    dur: {
      des: Math.round(clamp(d.des, 0, 60, DEFAULT_SETTINGS.dur.des)),
      apr: Math.round(clamp(d.apr, 0, 60, DEFAULT_SETTINGS.dur.apr)),
      pro: Math.round(clamp(d.pro, 0, 120, DEFAULT_SETTINGS.dur.pro)),
      qc: Math.round(clamp(d.qc, 0, 30, DEFAULT_SETTINGS.dur.qc)),
      dsp: Math.round(clamp(d.dsp, 0, 30, DEFAULT_SETTINGS.dur.dsp)),
    },
    cap: clamp(raw?.cap, 0.5, 500, DEFAULT_SETTINGS.cap),
    tight: Math.round(clamp(raw?.tight, 0, 60, DEFAULT_SETTINGS.tight)),
    off: [...new Set(off as number[])].sort(),
    holidays: [...new Set(holidays as string[])].sort(),
  };
}

app.put('/api/settings', async (c) => {
  const denied = guard(c, 'settings');
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const s = sanitizeSettings(body);
  const u: User = c.get('user');
  await saveSettings(c.env.DB, s, u.sub);
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'settings', '1', 'update',
    `Design ${s.dur.des}d, approval ${s.dur.apr}d, procurement ${s.dur.pro}d, capacity ${s.cap} MT/day`);
  return c.json({ ok: true, settings: s, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- stakeholders
app.put('/api/stakeholders', async (c) => {
  const denied = guard(c, 'settings');
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const u: User = c.get('user');
  for (const [i, r] of rows.entries()) {
    const dept = str(r.dept, 60);
    if (!dept) continue;
    await saveStakeholder(c.env.DB, {
      dept,
      person: str(r.person, 80) || undefined,
      phone: str(r.phone, 30) || undefined,
      email: str(r.email, 120) || undefined,
      scope: str(r.scope, 200) || undefined,
      sort: i,
    });
  }
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'stakeholder', null, 'update',
    `${rows.length} department contacts saved`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- users
app.post('/api/users', async (c) => {
  const denied = guard(c, 'users');
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const email = validEmail(body.email);
  if (!email) return c.json({ error: 'bad_email', message: 'Enter a valid email address' }, 400);
  const problem = passwordProblem(body.password);
  if (problem) return c.json({ error: 'weak_password', message: problem }, 400);
  if (await findUserByEmail(c.env.DB, email)) {
    return c.json({ error: 'email_taken', message: `${email} already has an account` }, 409);
  }
  const role: Role = roleValue(body.role) || 'viewer';
  const dept = deptName(body.dept);
  const name = str(body.name, 80) || email.split('@')[0];
  const me: User = c.get('user');
  const user = await createUser(c.env.DB, {
    sub: crypto.randomUUID(),
    email,
    name,
    dept,
    role,
    passHash: await hashPassword(String(body.password)),
  });
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'user', user.sub, 'create',
    `${name} added as ${role}${dept ? ' · ' + dept : ''}`);
  return c.json({ ok: true, user, snapshot: await snapshot(c) });
});

app.patch('/api/users/:sub', async (c) => {
  const denied = guard(c, 'users');
  if (denied) return denied;
  const sub = c.req.param('sub');
  const target = await getUser(c.env.DB, sub);
  if (!target) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const me: User = c.get('user');

  const role = body.role === undefined ? undefined : (roleValue(body.role) ?? undefined);
  const dept = body.dept === undefined ? undefined : deptName(body.dept);
  const active = body.active === undefined ? undefined : body.active ? 1 : 0;

  // The designated super admin keeps full control of the workspace for good.
  if (isRootAdmin(target)) {
    if (role && role !== 'owner') {
      return c.json({ error: 'protected_account', message: 'The super admin account always stays Admin' }, 400);
    }
    if (active === 0) {
      return c.json({ error: 'protected_account', message: 'The super admin account cannot be disabled' }, 400);
    }
  }

  if (target.role === 'owner' && (role && role !== 'owner')) {
    const owners = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1").first<{ n: number }>();
    if ((owners?.n || 0) <= 1) return c.json({ error: 'last_owner', message: 'There must always be one active Admin account' }, 400);
  }
  if (target.sub === me.sub && active === 0) {
    return c.json({ error: 'self_disable', message: 'You cannot disable your own account' }, 400);
  }

  await updateUser(c.env.DB, sub, { role, dept, active });
  if (typeof body.password === 'string' && body.password) {
    const problem = passwordProblem(body.password);
    if (problem) return c.json({ error: 'weak_password', message: problem }, 400);
    await setPassword(c.env.DB, sub, await hashPassword(body.password));
    await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'user', sub, 'password',
      `Password reset for ${target.name || target.email || sub}`);
  }
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'user', sub, 'update',
    `${target.name || target.email || sub}: role=${role ?? target.role}, dept=${dept ?? '-'}, active=${active ?? target.active}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- access requests
app.post('/api/access-requests', async (c) => {
  const me: User = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const askRole = str(body.role, 40) ? roleValue(body.role) : null;
  if (str(body.role, 40) && !askRole) {
    return c.json({ error: 'bad_role', message: 'That role name is not allowed' }, 400);
  }
  const askDept = deptName(body.dept);
  if (!askRole && !askDept) {
    return c.json({ error: 'nothing_requested', message: 'Pick a role or a department to request' }, 400);
  }
  const open = await c.env.DB
    .prepare("SELECT 1 AS x FROM access_requests WHERE sub = ? AND status = 'pending'")
    .bind(me.sub)
    .first();
  if (open) {
    return c.json({ error: 'already_pending', message: 'You already have a request waiting for approval' }, 409);
  }
  const note = str(body.note, 300);
  await createAccessRequest(c.env.DB, {
    id: crypto.randomUUID(),
    sub: me.sub,
    email: me.email,
    name: me.name,
    ask_role: askRole,
    ask_dept: askDept,
    note,
  });
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'access', me.sub, 'request',
    `${me.name || me.email || 'user'} requested ${askRole || 'access'}${askDept ? ' · ' + askDept : ''}${note ? ' — ' + note : ''}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

app.post('/api/access-requests/:id/decision', async (c) => {
  const denied = guard(c, 'users');
  if (denied) return denied;
  const id = c.req.param('id');
  const req = await getAccessRequest(c.env.DB, id);
  if (!req || req.status !== 'pending') {
    return c.json({ error: 'not_pending', message: 'That request is no longer open' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const approve = body.decision === 'approve';
  const note = str(body.note, 300);
  const me: User = c.get('user');
  const who = req.name || req.email || req.sub;

  if (approve) {
    const target = await getUser(c.env.DB, req.sub);
    if (!target) return c.json({ error: 'user_gone', message: 'That account no longer exists' }, 404);
    const role = req.ask_role ? roleValue(req.ask_role) : null;
    await updateUser(c.env.DB, req.sub, {
      role: role || undefined,
      dept: req.ask_dept || undefined,
    });
  }
  await decideAccessRequest(c.env.DB, id, approve ? 'approved' : 'denied', me.sub, note);
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'access', req.sub,
    approve ? 'approved' : 'denied',
    `${who}: request ${approve ? 'approved' : 'denied'}${req.ask_role ? ' · role ' + req.ask_role : ''}${req.ask_dept ? ' · ' + req.ask_dept : ''}${note ? ' — ' + note : ''}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- self password
app.post('/api/auth/password', async (c) => {
  const me: User = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const row = await findUserByEmail(c.env.DB, me.email || '');
  if (!row || !(await verifyPassword(String(body.current ?? ''), row.pass_hash))) {
    return c.json({ error: 'bad_password', message: 'Current password is wrong' }, 400);
  }
  const problem = passwordProblem(body.next);
  if (problem) return c.json({ error: 'weak_password', message: problem }, 400);
  await setPassword(c.env.DB, me.sub, await hashPassword(String(body.next)));
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'user', me.sub, 'password', 'Password changed');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- bulk import
app.post('/api/import', async (c) => {
  const denied = guard(c, 'order');
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
  const u: User = c.get('user');
  let created = 0;
  const skipped: string[] = [];
  for (const r of rows) {
    const customer = str(r.customer, 200);
    if (!customer) {
      skipped.push(String(r.project || r.id || 'row without customer'));
      continue;
    }
    try {
      const id = await nextId(c.env.DB, fyPrefix(), 'orders');
      await saveOrder(
        c.env.DB,
        id,
        {
          customer,
          project: r.project,
          structure_type: r.structure_type,
          kwp: r.kwp,
          mt: r.mt,
          po_date: r.po_date,
          conf_date: r.conf_date,
          due_date: r.due_date,
          priority: r.priority || 'Medium',
          sales_owner: r.sales_owner,
          o_des: r.o_des,
          o_pro: r.o_pro,
          o_prd: r.o_prd,
          remarks: r.remarks,
          status: 'open',
        },
        u.sub,
        true,
      );
      created++;
    } catch {
      skipped.push(`${customer} (save failed)`);
    }
  }
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'order', null, 'import', `${created} orders imported`);
  return c.json({ ok: true, created, skipped, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- activity
app.get('/api/activity', async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 200));
  return c.json({ activity: await listEvents(c.env.DB, limit) });
});

// ---------------------------------------------------------------- static SPA
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return app.fetch(request, env);
  },
};
