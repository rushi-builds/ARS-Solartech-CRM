// ARS Solartech - Order to Dispatch Management System
// Cloudflare Worker: Sign in with Freebuff + role-based API + static SPA.
import { Hono } from 'hono';
import {
  createFreebuffAuth,
  isSameOriginRequest,
  type FreebuffAuth,
} from '@freebuff/auth';

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
  dashboard,
  deleteDispatch,
  deleteOrder,
  enrich,
  ensureUser,
  getSettings,
  listDispatchRows,
  listEvents,
  listOrderRows,
  listStageRows,
  listStakeholders,
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
  FREEBUFF_CLIENT_ID: string;
  FREEBUFF_ISSUER?: string;
  APP_ORIGIN: string;
}

type Ctx = { Bindings: Env; Variables: { user: User } };

const ROLES: Role[] = ['owner', 'admin', 'editor', 'viewer'];

// One auth instance per isolate (per client/origin pair), so discovery and the
// signing keys are cached instead of fetched on every request.
const authCache = new Map<string, FreebuffAuth>();
function authFor(env: Env): FreebuffAuth {
  const key = `${env.FREEBUFF_CLIENT_ID}|${env.APP_ORIGIN}|${env.FREEBUFF_ISSUER || ''}`;
  let a = authCache.get(key);
  if (!a) {
    const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(env.APP_ORIGIN);
    a = createFreebuffAuth({
      clientId: env.FREEBUFF_CLIENT_ID,
      baseUrl: env.APP_ORIGIN,
      issuer: env.FREEBUFF_ISSUER,
      allowInsecureLocalhost: local,
    });
    authCache.set(key, a);
  }
  return a;
}

const app = new Hono<Ctx>();

// Public readiness probe (registered before the auth guard on purpose).
app.get('/healthz', (c) => c.json({ ok: true, at: new Date().toISOString() }));

// ---------------------------------------------------------------- auth guard
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  const fb = await authFor(c.env).getUser(c.req.raw);
  if (!fb) return c.json({ error: 'signin_required', message: 'Sign in required' }, 401);

  const user = await ensureUser(c.env.DB, fb.sub, fb.email ?? null, fb.name ?? null);
  if (!user.active) return c.json({ error: 'account_disabled', message: 'This account is disabled' }, 403);
  c.set('user', user);
  await next();
});

// Every state change must come from this site's own pages.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    if (!isSameOriginRequest(c.req.raw, c.env.APP_ORIGIN)) {
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

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const date = (v: unknown): string | null => {
  const s = str(v, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

async function headsMap(db: D1Database): Promise<Record<string, string>> {
  const rows = (await listStakeholders(db)) as any[];
  const out: Record<string, string> = {};
  for (const r of rows) if (r.dept && r.person) out[r.dept] = r.person;
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
  const heads = await headsMap(db);
  const today = todayISO();
  const enriched = enrich(orders, stages, dispatches, settings, heads, today);
  const dash = dashboard(enriched, 16, settings);
  return {
    me: user,
    capabilities: capabilities(user),
    settings,
    orders: enriched,
    dispatches,
    stakeholders,
    users,
    activity: await listEvents(db, 120),
    dashboard: dash,
    today,
    meta: { stages: STAGE_META, depts: DEPTS, roles: ROLES },
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

  await setStage(c.env.DB, id, stage, d, planned ?? null, c.get('user').sub);
  const u: User = c.get('user');
  const label = STAGE_META.find((m) => m.key === stage)?.actual || stage;
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'order', id, d ? 'stage_done' : 'stage_reopen',
    d ? `${label} - ${d}` : `${label} cleared`);

  // Production finished with nothing dispatched yet: flag it for the dispatch desk.
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
app.patch('/api/users/:sub', async (c) => {
  const denied = guard(c, 'users');
  if (denied) return denied;
  const sub = c.req.param('sub');
  const target = await getUser(c.env.DB, sub);
  if (!target) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const me: User = c.get('user');

  const role = body.role === undefined ? undefined : (ROLES.includes(body.role) ? body.role : undefined);
  const dept = body.dept === undefined ? undefined : (body.dept && DEPTS.includes(body.dept) ? body.dept : null);
  const active = body.active === undefined ? undefined : body.active ? 1 : 0;

  if (target.role === 'owner' && (role && role !== 'owner')) {
    const owners = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1").first<{ n: number }>();
    if ((owners?.n || 0) <= 1) return c.json({ error: 'last_owner', message: 'There must always be one active owner' }, 400);
  }
  if (target.sub === me.sub && active === 0) {
    return c.json({ error: 'self_disable', message: 'You cannot disable your own account' }, 400);
  }

  await updateUser(c.env.DB, sub, { role, dept, active });
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'user', sub, 'update',
    `${target.name || target.email || sub}: role=${role ?? target.role}, dept=${dept ?? '-'}, active=${active ?? target.active}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
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
    // wrap() serves /auth/freebuff/* and keeps the session cookie fresh.
    return authFor(env).wrap((req: Request, e: Env) => app.fetch(req, e))(request, env);
  },
};
