// ARS Solartech - Order to Dispatch Management System
// Cloudflare Worker: email + password auth, role-based JSON API and the SPA.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

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
  describeAgent,
  hashPassword,
  newSessionToken,
  passwordProblem,
  passwordScore,
  readSessionToken,
  sameOrigin,
  sessionCookie,
  sessionExpiry,
  sha256,
  validEmail,
  verifyPassword,
} from './auth';
import {
  ACCESS_ACTIONS,
  DEFAULT_ACCESS,
  DEFAULT_SETTINGS,
  DEPTS,
  STAGE_META,
  STAGES,
  dayDiff,
  todayISO,
  validDate,
  type Settings,
  type StageKey,
} from './plan';
import {
  can,
  capabilities,
  createAccessRequest,
  finishNotification,
  listDeptAdmins,
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
  isDeptSuperAdmin,
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
  listCustomers,
  getCustomer,
  saveCustomer,
  deleteCustomer,
  missingCustomers,
  listOrderNotes,
  addOrderNote,
  deleteOrderNote,
  listOrderTags,
  setOrderTags,
  listAllTags,
  analytics,
  listAttachments,
  countAttachments,
  saveAttachment,
  getAttachment,
  deleteAttachment,
  listSavedViews,
  createSavedView,
  deleteSavedView,
  listEvents,
  listEventEntities,
  listNotifications,
  listOrderRows,
  listStageRows,
  listStakeholders,
  setOrderApproval,
  listUsers,
  getUser,
  logEvent,
  listUserSessions,
  listAllSessions,
  revokeSession,
  revokeOtherSessions,
  touchSession,
  queueNotification,
  saveDispatch,
  saveOrder,
  saveSettings,
  saveStakeholder,
  setStage,
  updateUser,
  workload,
  type Action,
  type EnrichedOrder,
  type Role,
  type User,
} from './db';

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
  APP_ORIGIN?: string;
  // Optional delivery channels. Without these the outbox still records every
  // alert and the in-app bell keeps working.
  RESEND_API_KEY?: string;
  NOTIFY_FROM?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_ID?: string;
  // Floating assistant (OpenAI-compatible endpoint).
  OPENAI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  // Optional: the account that always stays owner (see db.rootAdminEmail).
  ROOT_ADMIN_EMAIL?: string;
  // Optional: bind a bucket and attachments are stored there instead of D1.
  FILES?: R2Bucket;
}

type Ctx = { Bindings: Env; Variables: { user: User; caps: Record<string, boolean> } };

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

// Cheap hardening on every response. Headers coming back from the asset binding
// are immutable, so they are copied onto a fresh Response rather than edited.
app.use('*', async (c, next) => {
  await next();
  const h = new Headers(c.res.headers);
  if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'SAMEORIGIN');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!h.has('Permissions-Policy')) h.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (!h.has('Content-Security-Policy')) {
    h.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
  }
  if (new URL(c.req.url).protocol === 'https:' && !h.has('Strict-Transport-Security')) {
    h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: h });
});

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
/** The caller's address, best effort: Cloudflare sets CF-Connecting-IP. */
function clientIp(c: any): string | null {
  return (
    c.req.header('cf-connecting-ip') ||
    (c.req.header('x-forwarded-for') || '').split(',')[0].trim() ||
    null
  );
}

async function startSession(c: any, user: User) {
  const { token, tokenHash } = await newSessionToken();
  await createSession(c.env.DB, user.sub, tokenHash, sessionExpiry(), {
    userAgent: c.req.header('user-agent') || null,
    ip: clientIp(c),
  });
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
  const body = await jsonBody(c);
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

/**
 * Simple in-memory throttle for sign-in attempts: 10 wrong passwords for the
 * same email (or from the same address) inside 5 minutes and the next tries
 * are refused before the password hash is even computed. Per isolate, which is
 * enough to stop a scripted guessing loop without adding a table or a KV
 * namespace to every deployment.
 */
const LOGIN_FAILS = new Map<string, { n: number; until: number }>();
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_FAILS = 10;

function loginBlocked(keys: string[]): number {
  const now = Date.now();
  let wait = 0;
  for (const k of keys) {
    const rec = LOGIN_FAILS.get(k);
    if (!rec) continue;
    if (rec.until && rec.until <= now) { LOGIN_FAILS.delete(k); continue; }
    if (rec.n >= LOGIN_MAX_FAILS) wait = Math.max(wait, Math.ceil((rec.until - now) / 1000));
  }
  return wait;
}

function noteLoginFail(keys: string[]) {
  const now = Date.now();
  if (LOGIN_FAILS.size > 5000) LOGIN_FAILS.clear();       // keep memory bounded
  for (const k of keys) {
    const rec = LOGIN_FAILS.get(k);
    if (!rec || (rec.until && rec.until <= now)) LOGIN_FAILS.set(k, { n: 1, until: now + LOGIN_WINDOW_MS });
    else rec.n += 1;
  }
}

function clearLoginFails(keys: string[]) {
  for (const k of keys) LOGIN_FAILS.delete(k);
}

app.post('/api/auth/login', async (c) => {
  await ensureSchemaOnce(c.env.DB);
  if (!sameOrigin(c.req.raw, siteOrigin(c))) return c.json({ error: 'bad_origin' }, 403);
  const body = await jsonBody(c);
  const email = validEmail(body.email);
  const password = String(body.password ?? '');
  if (!email || !password) return c.json({ error: 'bad_credentials', message: 'Email and password are required' }, 400);

  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'local';
  const throttleKeys = ['email:' + email, 'ip:' + ip];
  const wait = loginBlocked(throttleKeys);
  if (wait > 0) {
    return c.json(
      { error: 'too_many_attempts', message: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` },
      429,
    );
  }

  const row = await findUserByEmail(c.env.DB, email);
  const ok = row ? await verifyPassword(password, row.pass_hash) : false;
  if (!row || !ok) {
    noteLoginFail(throttleKeys);
    return c.json({ error: 'bad_credentials', message: 'Wrong email or password' }, 401);
  }
  clearLoginFails(throttleKeys);
  if (!row.active) return c.json({ error: 'account_disabled', message: 'This account is disabled' }, 403);

  await purgeSessions(c.env.DB);
  const user: User = {
    sub: row.sub,
    email: row.email,
    name: row.name,
    dept: row.dept,
    phone: row.phone,
    role: row.role,
    active: row.active,
    dept_admin: row.dept_admin,
  };
  // The designated super admin always comes back as owner, even if a row in an
  // older database still points at another role.
  if (isRootAdmin(user, c.env) && user.role !== 'owner') {
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
  c.set('sessionHash', await sha256(token as string));
  // "Last active" on the devices screen, written at most once an hour per row.
  await touchSession(c.env.DB, await sha256(token as string), new Date().toISOString());
  // Permissions come from the matrix an admin edits in Settings, resolved once
  // per request so every guard below sees the same answer.
  const settings = await getSettings(c.env.DB);
  c.set('caps', capabilities(user, settings.access));
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
/** JSON body that is always a plain object, so `body.x` can never throw. */
/**
 * Request body as a plain object. A body that is not valid JSON is a client
 * error, not an empty object: silently treating "{oops" as {} let a create
 * request "succeed" while throwing away everything the caller sent.
 * An empty body still means {} (logout and a few PATCHes rely on that).
 */
async function jsonBody(c: any): Promise<Record<string, any>> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HTTPException(400, { res: c.json({ error: 'bad_json', message: 'The request body is not valid JSON' }, 400) });
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new HTTPException(400, { res: c.json({ error: 'bad_json', message: 'The request body must be a JSON object' }, 400) });
  }
  return v;
}

function guard(c: any, action: Action) {
  const caps: Record<string, boolean> = c.get('caps') || {};
  if (!caps[action]) {
    return c.json({ error: 'forbidden', message: `Your role/department cannot perform "${action}"` }, 403);
  }
  return null;
}

const nowISO = (): string => new Date().toISOString();

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

// Real calendar day only (2026-02-31 and 2026-13-01 are rejected here, not by
// a loose regex), so a mistyped stage date can never reach the planner.
const date = (v: unknown): string | null => {
  const s = str(v, 10);
  return s ? validDate(s) : null;
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
    out.push({ id: 'acct-' + u.sub, dept: u.dept, name: u.name, email: u.email, phone: u.phone || null, sub: u.sub, account: true });
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

// ---------------------------------------------------------------- alerts
export type Escalation = {
  id: string;
  customer: string;
  stage: string;
  dept: string;
  assignee: string;
  days: number;
  due: string | null;
  level: 'Escalated' | 'Critical';
};

/** Stages that stayed overdue past the escalation window, worst first. */
function escalations(orders: EnrichedOrder[], settings: Settings, today: string): Escalation[] {
  const limit = Math.max(1, settings.notify?.escalate || 2);
  const keys: StageKey[] = ['des', 'apr', 'mat', 'pf', 'qc', 'dsp'];
  const out: Escalation[] = [];
  for (const o of orders) {
    if (o.status !== 'open' || o.live.rag === 'CLOSED') continue;
    const key = keys.find((k) => !(o.a as any)[k]);
    if (!key) continue;
    const due = o.live.plan ? (o.live.plan as any)[key] : null;
    const days = due ? Math.max(0, dayDiff(today, due)) : 0;
    if (days < limit) continue;
    const meta = STAGE_META.find((m) => m.key === key);
    out.push({
      id: o.id,
      customer: o.customer || o.id,
      stage: meta?.label || key,
      dept: o.live.dept,
      assignee: o.asg?.[key]?.name || '',
      days,
      due,
      level: days >= limit * 2 ? 'Critical' : 'Escalated',
    });
  }
  return out.sort((a, b) => b.days - a.days).slice(0, 60);
}

/**
 * Delivers one alert through its channel. Missing secrets are recorded as a
 * failed row, never thrown, so the in-app notification is never lost.
 */
async function deliverOne(
  env: Env,
  settings: Settings,
  n: { id: string; channel: string; target: string | null; title: string; body: string },
): Promise<void> {
  let error: string | null = null;
  try {
    if (n.channel === 'email') {
      if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set on the Worker');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: env.NOTIFY_FROM || 'ARS Solartech <onboarding@resend.dev>',
          to: [n.target],
          subject: n.title,
          text: n.body,
        }),
      });
      if (!res.ok) throw new Error(`email provider returned ${res.status}`);
    } else if (n.channel === 'whatsapp') {
      if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) {
        throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_ID are not set on the Worker');
      }
      const to = String(n.target || '').replace(/[^0-9]/g, '');
      const res = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: `${n.title}\n${n.body}` },
        }),
      });
      if (!res.ok) throw new Error(`WhatsApp returned ${res.status}`);
    } else {
      if (!settings.notify.webhook) throw new Error('Webhook URL is not set');
      const res = await fetch(settings.notify.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: n.channel,
          to: n.target,
          title: n.title,
          text: n.body,
          at: new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
    }
  } catch (e) {
    error = String((e as Error)?.message || e);
  }
  await finishNotification(env.DB, n.id, error ? 'failed' : 'sent', error);
}

/** Queues an alert for one person on every channel enabled in Settings. */
async function notifyUser(c: any, target: User, title: string, body: string, orderId: string | null): Promise<number> {
  const settings = await getSettings(c.env.DB);
  const channels: { channel: string; target: string | null }[] = [];
  if (settings.notify.email && target.email) channels.push({ channel: 'email', target: target.email });
  if (settings.notify.whatsapp && target.phone) channels.push({ channel: 'whatsapp', target: target.phone });
  if (settings.notify.webhook) channels.push({ channel: 'webhook', target: target.phone || target.email || null });
  for (const ch of channels) {
    const id = crypto.randomUUID();
    await queueNotification(c.env.DB, {
      id,
      channel: ch.channel,
      target: ch.target,
      title,
      body,
      sub: target.sub,
      orderId,
    });
    const row = { id, channel: ch.channel, target: ch.target, title, body };
    try {
      c.executionCtx.waitUntil(deliverOne(c.env, settings, row));
    } catch {
      await deliverOne(c.env, settings, row);
    }
  }
  return channels.length;
}

// ---------------------------------------------------------------- live sync
/**
 * Change token for the live-sync poll: eight tiny metadata reads (counts plus
 * the newest updated_at per table) and nothing else. It costs a fraction of a
 * full snapshot, so the browser can afford to poll it while idle. Anything a
 * per-row read would notice — a stage turning overdue at midnight — is handled
 * by the client re-checking the date it already has.
 */
async function revisionToken(db: D1Database): Promise<string> {
  const q = async (sql: string) => {
    try {
      return await db.prepare(sql).first<any>();
    } catch {
      return null;
    }
  };
  const [settings, orders, stages, dispatches, users, people, requests, notifications, events, notes, tags] = await Promise.all([
    q('SELECT updated_at FROM settings WHERE id = 1'),
    q('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM orders'),
    q('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM order_stages'),
    q('SELECT COUNT(*) AS n, MAX(COALESCE(updated_at, created_at)) AS at FROM dispatches'),
    q('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM users'),
    q('SELECT COUNT(*) AS n, MAX(created_at) AS at FROM dept_people'),
    q("SELECT COUNT(*) AS n, MAX(COALESCE(decided_at, created_at)) AS at FROM access_requests"),
    // Alerts land in the bell (task assigned, escalation sent, test alert) and
    // no event row is written for some of them, so the outbox is its own line.
    q('SELECT COUNT(*) AS n, MAX(at) AS at FROM notifications'),
    q('SELECT COUNT(*) AS n, MAX(id) AS at FROM events'),
    q('SELECT COUNT(*) AS n, MAX(created_at) AS at FROM order_notes'),
    q('SELECT COUNT(*) AS n, MAX(added_at) AS at FROM order_tags'),
  ]);
  return [
    settings?.updated_at || '',
    orders?.n ?? 0, orders?.at || '',
    stages?.n ?? 0, stages?.at || '',
    dispatches?.n ?? 0, dispatches?.at || '',
    users?.n ?? 0, users?.at || '',
    people?.n ?? 0, people?.at || '',
    requests?.n ?? 0, requests?.at || '',
    notifications?.n ?? 0, notifications?.at || '',
    events?.n ?? 0, events?.at || '',
    // Comments and tags are conversation, not bookkeeping — but they still
    // change what the screen should show, so they belong in the token.
    notes?.n ?? 0, notes?.at || '',
    tags?.n ?? 0, tags?.at || '',
  ].join('|');
}

async function snapshot(c: any) {
  const env = c.env as Env;
  // Load the caller fresh: a PATCH may have just changed this account's own
  // department or role, and the middleware copy is from before that write.
  const user: User = (await getUser(env.DB, c.get('user').sub)) || c.get('user');
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
  const tags = await listOrderTags(db);
  const today = todayISO();
  const enriched = enrich(orders, stages, dispatches, settings, heads, today);
  const dash = dashboard(enriched, 16, settings);
  const caps = capabilities(user, settings.access);
  // Admins see every request; everyone else only sees their own.
  const accessRequests = await listAccessRequests(db, 60, caps.users ? undefined : user.sub);
  const loads = workload(enriched, users, today);
  const escalationList = escalations(enriched, settings, today);
  const outbox = await listNotifications(db, 40, caps.users ? undefined : user.sub);
  return {
    revision: await revisionToken(db),
    me: user,
    capabilities: caps,
    settings,
    orders: enriched.map((o) => ({ ...o, tags: tags[o.id] || [] })),
    tags: await listAllTags(db),
    dispatches,
    stakeholders,
    deptPeople: roster,
    users,
    activity: await listEvents(db, 120),
    dashboard: dash,
    accessRequests,
    workload: loads,
    escalations: escalationList,
    notifications: outbox,
    today,
    meta: {
      stages: STAGE_META,
      depts: [...new Set([...DEPTS, ...users.map((u) => u.dept).filter((d): d is string => !!d)])],
      roles: ROLES,
      accessRoles: Object.keys(settings.access),
      customRoles: [...new Set(users.map((u) => u.role))]
        .filter((r) => r && !ROLES.includes(r)),
      pendingRequests: accessRequests.filter((r) => r.status === 'pending').length,
      aiConfigured: !!c.env.OPENAI_API_KEY,
      channels: {
        email: !!c.env.RESEND_API_KEY,
        whatsapp: !!(c.env.WHATSAPP_TOKEN && c.env.WHATSAPP_PHONE_ID),
        webhook: !!settings.notify.webhook,
      },
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
  const body = await jsonBody(c);
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
  const body = await jsonBody(c);
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

  const body = await jsonBody(c);
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
  const body = await jsonBody(c);
  const sub = str(body.sub, 60);
  const full = me.role === 'owner' || me.role === 'admin' || me.role === 'manager';
  let name: string | null = null;
  let target: User | null = null;
  if (sub) {
    target = await getUser(c.env.DB, sub);
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
  if (target) {
    await notifyUser(c, target, `Task assigned: ${label}`, `${id} · ${label} is now on you. Open the CRM for the planned date.`, id);
  }
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// Final sign-off from Admin / Manager once every department is finished.
app.post('/api/orders/:id/approval', async (c) => {
  const denied = guard(c, 'approve');
  if (denied) return denied;
  const me: User = c.get('user');
  const id = c.req.param('id');
  const order = await c.env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
  if (!order) return c.json({ error: 'not_found' }, 404);
  const body = await jsonBody(c);
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
  const body = await jsonBody(c);
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
  const body = await jsonBody(c);
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
  const body = await jsonBody(c);
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
    access: sanitizeAccess(raw?.access),
    notify: {
      email: !!raw?.notify?.email,
      whatsapp: !!raw?.notify?.whatsapp,
      webhook: /^https?:\/\//i.test(String(raw?.notify?.webhook || ''))
        ? String(raw.notify.webhook).trim().slice(0, 400)
        : '',
      escalate: Math.round(clamp(raw?.notify?.escalate, 1, 60, DEFAULT_SETTINGS.notify.escalate)),
    },
  };
}

/**
 * Who may do what. Owner stays full; a role missing from the payload keeps its
 * default. Any extra key is a custom role added from the matrix.
 */
function sanitizeAccess(raw: any): Record<string, string[]> {
  const roles = new Set(['owner', 'admin', 'manager', 'editor', 'viewer']);
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      if (/^[A-Za-z][A-Za-z0-9 &/._-]{0,39}$/.test(key)) roles.add(key);
    }
  }
  const out: Record<string, string[]> = {};
  for (const role of roles) {
    if (role.toLowerCase() === 'owner') continue;
    const given = raw && Array.isArray(raw[role]) ? raw[role].map(String) : null;
    const list = given || (DEFAULT_SETTINGS.access as any)[role] || [];
    out[role] = (ACCESS_ACTIONS as readonly string[]).filter((a) => list.includes(a));
  }
  out.owner = [...ACCESS_ACTIONS];
  return out;
}

/** Same role -> same actions, ignoring the order the browser sent them in. */
function sameAccess(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const x = [...(a?.[k] || [])].sort().join(',');
    const y = [...(b?.[k] || [])].sort().join(',');
    if (x !== y) return false;
  }
  return true;
}

// Settings a department super admin may not hand out: only someone with the
// Users power can change the powerful roles or these actions.
const POWER_ACTIONS = ['users', 'settings', 'delete', 'approve'];

/**
 * A department super admin without the Users power may edit the matrix, but
 * cannot give power away or take it from the top roles. Their own weaker
 * entries are respected; anything that would *raise* a role is ignored.
 *
 * This used to reset admin/manager to whatever was stored before, so simply
 * saving the planning settings (the client posts the whole matrix) silently
 * demoted every admin. Now a no-op save is a no-op.
 */
function restrictAccess(before: Record<string, string[]>, next: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = { ...next };
  for (const role of ['admin', 'manager']) {
    const kept = before[role] || DEFAULT_ACCESS[role] || [];
    const asked = out[role] || kept;
    // Keep exactly what was stored unless the new list is a strict subset of it.
    out[role] = asked.every((a) => kept.includes(a)) ? asked : kept;
  }
  for (const [role, list] of Object.entries(out)) {
    if (role === 'owner') continue;
    const beforeList = before[role] || [];
    // Powerful actions only survive if they were already there.
    out[role] = list.filter((a) => !POWER_ACTIONS.includes(a) || beforeList.includes(a));
  }
  out.owner = [...ACCESS_ACTIONS];
  return out;
}

app.put('/api/settings', async (c) => {
  const denied = guard(c, 'settings');
  if (denied) return denied;
  const body = await jsonBody(c);
  const s = sanitizeSettings(body);
  const u: User = c.get('user');
  // Without the Users power (a department super admin on a lower role) the
  // access matrix cannot move Users/Settings/Delete/Approval or the top roles.
  const before = await getSettings(c.env.DB);
  // Access control belongs to the Super Admin department. Everyone else keeps
  // the rest of Settings but cannot change the matrix, even through the API.
  if (!isDeptSuperAdmin(u)) {
    s.access = before.access;
    // Say so, instead of saving the plan and quietly dropping the matrix — that
    // silent drop is what made the form look like it had worked.
    if (!sameAccess(before.access, sanitizeSettings(body).access)) {
      return c.json(
        {
          error: 'matrix_locked',
          message: 'Only the Super Admin department can change Access control. Your planning settings were not saved.',
        },
        403,
      );
    }
  } else if (!can(u, 'users', before.access)) {
    s.access = restrictAccess(before.access, s.access);
  }
  await saveSettings(c.env.DB, s, u.sub);
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'settings', '1', 'update',
    `Design ${s.dur.des}d, approval ${s.dur.apr}d, procurement ${s.dur.pro}d, capacity ${s.cap} MT/day`);
  return c.json({ ok: true, settings: s, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- stakeholders
app.put('/api/stakeholders', async (c) => {
  const denied = guard(c, 'settings');
  if (denied) return denied;
  const body = await jsonBody(c);
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
  const body = await jsonBody(c);
  const email = validEmail(body.email);
  if (!email) return c.json({ error: 'bad_email', message: 'Enter a valid email address' }, 400);
  const problem = passwordProblem(body.password);
  if (problem) return c.json({ error: 'weak_password', message: problem }, 400);
  if (await findUserByEmail(c.env.DB, email)) {
    return c.json({ error: 'email_taken', message: `${email} already has an account` }, 409);
  }
  const role: Role = roleValue(body.role) || 'viewer';
  const dept = deptName(body.dept);
  const phone = str(body.phone, 30);
  const name = str(body.name, 80) || email.split('@')[0];
  const deptAdmin = !!body.dept_admin;
  if (deptAdmin && !dept) {
    return c.json({ error: 'dept_required', message: 'Pick a department before making someone its super admin' }, 400);
  }
  const me: User = c.get('user');
  const user = await createUser(c.env.DB, {
    sub: crypto.randomUUID(),
    email,
    name,
    dept,
    phone,
    role,
    deptAdmin,
    passHash: await hashPassword(String(body.password)),
  });
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'user', user.sub, 'create',
    `${name} added as ${role}${dept ? ' · ' + dept : ''}${deptAdmin ? ' · department super admin' : ''}`);
  return c.json({ ok: true, user, snapshot: await snapshot(c) });
});

app.patch('/api/users/:sub', async (c) => {
  const denied = guard(c, 'users');
  if (denied) return denied;
  const sub = c.req.param('sub');
  const target = await getUser(c.env.DB, sub);
  if (!target) return c.json({ error: 'not_found' }, 404);
  const body = await jsonBody(c);
  const me: User = c.get('user');

  // Only the account itself may replace the designated super admin's password.
  if (isRootAdmin(target, c.env) && typeof body.password === 'string' && body.password && me.sub !== target.sub) {
    return c.json({ error: 'protected_account', message: 'Only that account can change its own password' }, 403);
  }
  const role = body.role === undefined ? undefined : (roleValue(body.role) ?? undefined);
  const dept = body.dept === undefined ? undefined : deptName(body.dept);
  const active = body.active === undefined ? undefined : body.active ? 1 : 0;
  const phone = body.phone === undefined ? undefined : str(body.phone, 30);
  const deptAdmin = body.dept_admin === undefined ? undefined : body.dept_admin ? 1 : 0;
  if (deptAdmin === 1 && !(dept === undefined ? target.dept : dept)) {
    return c.json({ error: 'dept_required', message: 'Pick a department before making someone its super admin' }, 400);
  }

  // The designated super admin keeps full control of the workspace for good.
  if (isRootAdmin(target, c.env)) {
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

  // Validate the password *before* writing anything: a rejected password used
  // to leave the role/department change behind, so a 400 still changed the user.
  const newPassword = typeof body.password === 'string' && body.password ? body.password : null;
  if (newPassword) {
    const problem = passwordProblem(newPassword);
    if (problem) return c.json({ error: 'weak_password', message: problem }, 400);
  }

  await updateUser(c.env.DB, sub, { role, dept, active, phone, deptAdmin });
  if (newPassword) {
    await setPassword(c.env.DB, sub, await hashPassword(newPassword));
    // A password reset must actually lock the old holder out. Keep the caller's
    // own session when they reset themselves, drop everything else.
    const keepSelf = me.sub === sub ? String(c.get('sessionHash') || '') : '';
    const n = keepSelf
      ? await revokeOtherSessions(c.env.DB, sub, keepSelf)
      : await revokeOtherSessions(c.env.DB, sub, '');
    await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'user', sub, 'password',
      `Password reset for ${target.name || target.email || sub}${n ? `, ${n} session(s) signed out` : ''}`);
  }
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'user', sub, 'update',
    `${target.name || target.email || sub}: role=${role ?? target.role}, dept=${dept ?? '-'}, active=${active ?? target.active}${deptAdmin !== undefined ? ', dept admin=' + (deptAdmin ? 'yes' : 'no') : ''}`);
  return c.json({ ok: true, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- access requests
app.post('/api/access-requests', async (c) => {
  const me: User = c.get('user');
  const body = await jsonBody(c);
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
  const body = await jsonBody(c);
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
  const body = await jsonBody(c);
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
  const body = await jsonBody(c);
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
  const u: User = c.get('user');
  const dryRun = body.dryRun === true;
  let created = 0;
  const skipped: string[] = [];
  const problems: { row: number; text: string; reason: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const customer = str(r.customer, 200);
    const label = String(r.customer || r.project || r.id || `row ${i + 1}`).slice(0, 80);
    if (!customer) {
      skipped.push(label);
      problems.push({ row: i + 1, text: label, reason: 'No customer name' });
      continue;
    }
    // Dates are the usual culprit in a sheet export: Excel gives serial numbers
    // and dd/mm/yyyy strings. Anything unreadable is imported as "no date" and
    // reported, rather than silently dropped or crashing the plan later.
    for (const k of ['po_date', 'conf_date', 'due_date']) {
      if (r[k] && !validDate(r[k])) problems.push({ row: i + 1, text: label, reason: `${k} "${String(r[k]).slice(0, 24)}" is not a date` });
    }
    if (r.mt !== undefined && r.mt !== '' && !Number.isFinite(Number(r.mt))) {
      problems.push({ row: i + 1, text: label, reason: `mt "${String(r.mt).slice(0, 24)}" is not a number` });
    }
    if (dryRun) continue;
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
  const summary = dryRun
    ? `${rows.length} rows checked, ${problems.length} problem(s)`
    : `${created} orders imported, ${skipped.length} skipped`;
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'order', null, dryRun ? 'import_check' : 'import', summary);
  return c.json({
    ok: true,
    dryRun,
    checked: rows.length,
    created,
    skipped,
    problems: problems.slice(0, 100),
    snapshot: dryRun ? undefined : await snapshot(c),
  });
});

// ---------------------------------------------------------------- escalations + alerts
// Raises alerts to the department super admins (or the management team when a
// department has none) for every stage that crossed the escalation window.
app.post('/api/escalations/run', async (c) => {
  const denied = guard(c, 'settings');
  if (denied) return denied;
  const me: User = c.get('user');
  const snap = await snapshot(c);
  const list = (snap.escalations || []) as Escalation[];
  const users = (snap.users || []) as User[];
  const seen = new Set<string>();
  let alerts = 0;
  for (const e of list) {
    let people = await listDeptAdmins(c.env.DB, e.dept);
    if (!people.length) {
      people = users.filter((u) => u.active && ['owner', 'admin', 'manager'].includes(u.role));
    }
    for (const p of people) {
      const key = p.sub + '|' + e.id;
      if (seen.has(key)) continue;
      seen.add(key);
      alerts += await notifyUser(
        c,
        p,
        `${e.level}: ${e.customer}`,
        `${e.stage} is ${e.days} day${e.days === 1 ? '' : 's'} overdue${e.assignee ? ' with ' + e.assignee : ''} on ${e.id}.`,
        e.id,
      );
    }
  }
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'order', null, 'escalation',
    `${list.length} overdue order(s) checked, ${alerts} alert(s) queued`);
  return c.json({ ok: true, orders: list.length, alerts, snapshot: await snapshot(c) });
});

// Light poll target for the live-sync client (see revisionToken above).
app.get('/api/revision', async (c) => {
  const me: User = c.get('user');
  return c.json({ token: await revisionToken(c.env.DB), today: todayISO(), sub: me.sub });
});

// Send one alert to yourself to prove the channels work.
app.post('/api/notifications/test', async (c) => {
  const denied = guard(c, 'settings');
  if (denied) return denied;
  const me: User = c.get('user');
  const channels = await notifyUser(c, me, 'ARS CRM test alert', 'If you received this, your notification channel is wired correctly.', null);
  return c.json({ ok: true, channels, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- AI assistant
// Floating assistant. Data goes to an OpenAI-compatible endpoint with the
// owner's own key (server-side only); the browser never sees the key.
app.post('/api/ai/chat', async (c) => {
  const key = c.env.OPENAI_API_KEY;
  if (!key) {
    return c.json(
      { error: 'ai_not_configured', message: 'The assistant is not switched on. Add OPENAI_API_KEY to the Worker secrets, then reload.' },
      400,
    );
  }
  const me: User = c.get('user');
  const body = await jsonBody(c);
  const message = str(body.message, 4000);
  if (!message) return c.json({ error: 'empty', message: 'Type a question first' }, 400);
  const history = Array.isArray(body.history)
    ? body.history.slice(-8).map((m: any) => ({
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: String((m && m.content) || '').slice(0, 2000),
    }))
    : [];

  const snap = await snapshot(c);
  const context = {
    today: snap.today,
    signedInAs: { name: me.name, role: me.role, dept: me.dept },
    kpis: snap.dashboard.kpis,
    orders: snap.orders.slice(0, 80).map((o) => ({
      id: o.id,
      customer: o.customer,
      project: o.project,
      stage: o.live.stage,
      dept: o.live.dept,
      due: o.due_date,
      forecast: o.live.forecastDispatch,
      daysLate: o.live.daysOverdue,
      status: o.live.ragLabel,
      approval: o.approval,
      mt: o.mt,
      assigned: o.asg,
    })),
    workload: snap.workload.rows,
    escalations: snap.escalations,
  };

  // Any OpenAI-compatible endpoint works; the default is OpenAI itself, so no
  // third-party host is baked into the deployment.
  const base = String(c.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = c.env.AI_MODEL || 'gpt-4o-mini';
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You are the ARS Solartech CRM assistant. Answer only from the CRM data supplied. ' +
              'Be short, factual and useful: name the order id, stage, department and dates. ' +
              'If the data does not contain the answer, say so plainly. Never invent orders, people or dates. ' +
              'You cannot change data; tell the user which screen to use for a change.',
          },
          { role: 'system', content: 'CRM snapshot JSON:\n' + JSON.stringify(context).slice(0, 60000) },
          ...history,
          { role: 'user', content: message },
        ],
      }),
    });
    if (!res.ok) {
      return c.json({ error: 'ai_failed', message: `Assistant provider returned ${res.status}` }, 502);
    }
    const data: any = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    return c.json({ ok: true, reply: String(reply || '').slice(0, 8000), meta: { model } });
  } catch (e) {
    return c.json({ error: 'ai_failed', message: String((e as Error)?.message || e) }, 502);
  }
});

// ---------------------------------------------------------------- activity
// ---------------------------------------------------------------- sessions
app.get('/api/sessions', async (c) => {
  const me: User = c.get('user');
  const caps = c.get('caps') as Record<string, boolean>;
  const rows = caps.users ? await listAllSessions(c.env.DB) : await listUserSessions(c.env.DB, me.sub);
  const current = String(c.get('sessionHash') || '');
  return c.json({
    sessions: rows.map((r) => ({
      id: r.id,
      device: describeAgent(r.user_agent),
      ip: r.ip,
      created_at: r.created_at,
      last_seen: r.last_seen,
      expires_at: r.expires_at,
      current: current.startsWith(r.id),
      user: caps.users && r.email ? { email: r.email, name: r.name } : undefined,
    })),
    scope: caps.users ? 'all' : 'own',
  });
});

app.post('/api/sessions/revoke', async (c) => {
  const me: User = c.get('user');
  const caps = c.get('caps') as Record<string, boolean>;
  const body = await jsonBody(c);
  const id = String(body.id || '');
  if (!id) return c.json({ error: 'bad_request', message: 'Which session?' }, 400);
  if (!caps.users && !(await listUserSessions(c.env.DB, me.sub)).some((r) => r.id.startsWith(id))) {
    return c.json({ error: 'forbidden', message: 'That session is not yours' }, 403);
  }
  const n = await revokeSession(c.env.DB, id, caps.users ? undefined : me.sub);
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'session', id, 'revoke',
    `${me.name || me.email} signed out a device`);
  return c.json({ ok: true, revoked: n });
});

app.post('/api/sessions/revoke-others', async (c) => {
  const me: User = c.get('user');
  const keep = String(c.get('sessionHash') || '');
  const n = await revokeOtherSessions(c.env.DB, me.sub, keep);
  await logEvent(c.env.DB, { sub: me.sub, name: me.name }, 'session', me.sub, 'revoke_others',
    `${me.name || me.email} signed out of ${n} other device${n === 1 ? '' : 's'}`);
  return c.json({ ok: true, revoked: n });
});

// ---------------------------------------------------------------- activity
app.get('/api/activity', async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 200));
  // The audit trail is the first place anyone looks after a mistake, so it can
  // be narrowed to one entity, one person, or a phrase — and paged backwards.
  const events = await listEvents(c.env.DB, {
    limit,
    entity: c.req.query('entity') || undefined,
    actor: c.req.query('actor') || undefined,
    q: c.req.query('q') || undefined,
    before: Number(c.req.query('before')) || undefined,
  });
  return c.json({
    activity: events,
    entities: await listEventEntities(c.env.DB),
    nextBefore: events.length ? (events[events.length - 1] as any).id : null,
  });
});


// ---------------------------------------------------------------- analytics
app.get('/api/analytics', async (c) => {
  // Computed from the same snapshot data everyone else sees, so the numbers can
  // never disagree with the order list on the next tab.
  const db = c.env.DB;
  const [orders, stages, dispatches, settings] = await Promise.all([
    listOrderRows(db), listStageRows(db), listDispatchRows(db), getSettings(db),
  ]);
  const roster = await deptRoster(db);
  const enriched = enrich(orders, stages, dispatches, settings, headsFrom(roster), todayISO());
  return c.json({ analytics: analytics(enriched, settings) });
});


// ---------------------------------------------------------------- attachments
const MAX_FILE = 8 * 1024 * 1024;          // 8 MB per file
const D1_FILE_LIMIT = 1024 * 1024;         // 1 MB when there is no bucket

function safeName(name: string): string {
  return String(name || 'file')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file';
}

/** Attachments for one order or one customer, without the blobs. */
app.get('/api/attachments', async (c) => {
  const orderId = c.req.query('order');
  const customerId = c.req.query('customer');
  if (!orderId && !customerId) return c.json({ error: 'bad_request', message: 'Which order or customer?' }, 400);
  return c.json({
    attachments: await listAttachments(c.env.DB, orderId ? { orderId } : { customerId }),
    storage: c.env.FILES ? 'r2' : 'd1',
    maxBytes: c.env.FILES ? MAX_FILE : D1_FILE_LIMIT,
  });
});

/**
 * Upload is multipart/form-data, because that is what a file input sends and
 * because JSON/base64 would inflate every PDF by a third.
 */
app.post('/api/attachments', async (c) => {
  const u: User = c.get('user');
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'bad_request', message: 'Expected a file upload' }, 400);

  const file = form.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'bad_request', message: 'No file was sent' }, 400);

  const orderId = String(form.get('order_id') || '') || null;
  const customerId = String(form.get('customer_id') || '') || null;
  if (!orderId && !customerId) return c.json({ error: 'bad_request', message: 'Which order or customer?' }, 400);

  const size = (file as File).size || 0;
  const limit = c.env.FILES ? MAX_FILE : D1_FILE_LIMIT;
  if (size > limit) {
    return c.json(
      {
        error: 'too_large',
        message: `Files up to ${Math.round(limit / 1048576)} MB are allowed${c.env.FILES ? '' : ' without a bucket bound'}`,
      },
      413,
    );
  }

  const filename = safeName((file as File).name);
  const mime = (file as File).type || 'application/octet-stream';
  const id = crypto.randomUUID();
  const kind = String(form.get('kind') || 'file').slice(0, 24);
  const note = String(form.get('note') || '').trim().slice(0, 300) || null;

  let storage = 'd1';
  let r2Key: string | null = null;
  let data: string | null = null;

  if (c.env.FILES) {
    r2Key = `attachments/${id}/${filename}`;
    await c.env.FILES.put(r2Key, await (file as File).arrayBuffer(), {
      httpMetadata: { contentType: mime },
      customMetadata: { order: orderId || '', customer: customerId || '', by: u.sub },
    });
    storage = 'r2';
  } else {
    // Base64 in D1, deliberately small: enough for a PO PDF or a drawing photo.
    const buf = await (file as File).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    data = btoa(bin);
  }

  await saveAttachment(c.env.DB, {
    id, orderId, customerId, filename, mime, size, kind, storage, r2Key, data, note,
    by: u.sub, byName: u.name || u.email || '',
  });
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'attachment', orderId || customerId, 'upload',
    `${filename} attached${orderId ? ' to ' + orderId : ''}`);
  return c.json({
    ok: true,
    id,
    attachments: await listAttachments(c.env.DB, orderId ? { orderId } : { customerId }),
    snapshot: await snapshot(c),
  });
});

/** Download: streams the blob back with the original filename. */
app.get('/api/attachments/:id/file', async (c) => {
  const row = await getAttachment(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  const headers = new Headers();
  headers.set('Content-Type', row.mime || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(row.filename)}"`);
  headers.set('Cache-Control', 'private, max-age=3600');
  if (row.storage === 'r2' && row.r2_key && c.env.FILES) {
    const obj = await c.env.FILES.get(row.r2_key);
    if (!obj) return c.json({ error: 'not_found', message: 'The stored file is missing' }, 404);
    return new Response(obj.body, { headers });
  }
  if (!row.data) return c.json({ error: 'not_found', message: 'The stored file is missing' }, 404);
  const bin = atob(row.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers });
});

app.delete('/api/attachments/:id', async (c) => {
  const u: User = c.get('user');
  const caps = c.get('caps') as Record<string, boolean>;
  const row = await getAttachment(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.uploaded_by !== u.sub && !caps.delete) {
    return c.json({ error: 'forbidden', message: 'Only the uploader or an admin can remove a file' }, 403);
  }
  if (row.storage === 'r2' && row.r2_key && c.env.FILES) {
    try { await c.env.FILES.delete(row.r2_key); } catch { /* the row still goes */ }
  }
  await deleteAttachment(c.env.DB, row.id);
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'attachment', row.order_id || row.customer_id, 'delete',
    `${row.filename} removed`);
  return c.json({
    ok: true,
    attachments: await listAttachments(c.env.DB, row.order_id ? { orderId: row.order_id } : { customerId: row.customer_id || '' }),
    snapshot: await snapshot(c),
  });
});

// ---------------------------------------------------------------- saved views (server)
app.get('/api/views', async (c) => {
  const me: User = c.get('user');
  const rows = await listSavedViews(c.env.DB, me.sub);
  return c.json({
    views: rows.map((v) => ({ id: v.id, name: v.name, scope: v.scope, filters: JSON.parse(v.filters || '{}') })),
  });
});

app.post('/api/views', async (c) => {
  const me: User = c.get('user');
  const body = await jsonBody(c);
  const name = str(body.name, 40);
  if (!name) return c.json({ error: 'bad_request', message: 'Give the view a name' }, 400);
  const filters = JSON.stringify(body.filters || {});
  const id = 'v' + crypto.randomUUID().slice(0, 8);
  await createSavedView(c.env.DB, { id, sub: me.sub, name, scope: str(body.scope, 20) || 'orders', filters });
  return c.json({ ok: true, id, views: (await listSavedViews(c.env.DB, me.sub)).map((v) => ({ id: v.id, name: v.name, scope: v.scope, filters: JSON.parse(v.filters || '{}') })) });
});

app.delete('/api/views/:id', async (c) => {
  const me: User = c.get('user');
  await deleteSavedView(c.env.DB, c.req.param('id'), me.sub);
  return c.json({ ok: true, views: (await listSavedViews(c.env.DB, me.sub)).map((v) => ({ id: v.id, name: v.name, scope: v.scope, filters: JSON.parse(v.filters || '{}') })) });
});

// ---------------------------------------------------------------- customers
app.get('/api/customers', async (c) => {
  const denied = guard(c, 'order');
  if (denied) return denied;
  return c.json({
    customers: await listCustomers(c.env.DB),
    missing: await missingCustomers(c.env.DB),
  });
});

app.post('/api/customers', async (c) => {
  const denied = guard(c, 'order');
  if (denied) return denied;
  const body = await jsonBody(c);
  const name = str(body.name, 160);
  if (!name) return c.json({ error: 'bad_request', message: 'A customer needs a name' }, 400);
  const dup = await c.env.DB
    .prepare('SELECT id FROM customers WHERE TRIM(LOWER(name)) = TRIM(LOWER(?))')
    .bind(name)
    .first<{ id: string }>();
  if (dup) return c.json({ error: 'duplicate', message: `${name} is already in the customer master` }, 409);
  const id = 'CUS-' + String(Date.now()).slice(-8);
  const u: User = c.get('user');
  await saveCustomer(c.env.DB, id, { ...body, name }, true);
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'customer', id, 'create', `${name} added to the customer master`);
  return c.json({ ok: true, id, customers: await listCustomers(c.env.DB), missing: await missingCustomers(c.env.DB), snapshot: await snapshot(c) });
});

app.patch('/api/customers/:id', async (c) => {
  const denied = guard(c, 'order');
  if (denied) return denied;
  const id = c.req.param('id');
  const existing = await getCustomer(c.env.DB, id);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  const body = await jsonBody(c);
  const u: User = c.get('user');
  await saveCustomer(c.env.DB, id, body, false);
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'customer', id, 'update', `${existing.name} updated`);
  return c.json({ ok: true, customer: await getCustomer(c.env.DB, id), customers: await listCustomers(c.env.DB), snapshot: await snapshot(c) });
});

app.delete('/api/customers/:id', async (c) => {
  const denied = guard(c, 'delete');
  if (denied) return denied;
  const id = c.req.param('id');
  const existing = await getCustomer(c.env.DB, id);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  // Orders keep their own customer name, so deleting the master entry is safe:
  // it never deletes the order book with it.
  const { n } = (await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM orders WHERE TRIM(LOWER(customer)) = TRIM(LOWER(?))')
    .bind(existing.name)
    .first<{ n: number }>()) || { n: 0 };
  if (n > 0) {
    return c.json(
      { error: 'has_orders', message: `${existing.name} has ${n} order(s). Deactivate the customer instead of deleting.` },
      409,
    );
  }
  const u: User = c.get('user');
  await deleteCustomer(c.env.DB, id);
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'customer', id, 'delete', `${existing.name} removed`);
  return c.json({ ok: true, customers: await listCustomers(c.env.DB), missing: await missingCustomers(c.env.DB), snapshot: await snapshot(c) });
});

/** One click: add every customer name that exists in the order book to the master. */
app.post('/api/customers/backfill', async (c) => {
  const denied = guard(c, 'order');
  if (denied) return denied;
  const u: User = c.get('user');
  const missing = await missingCustomers(c.env.DB);
  let added = 0;
  for (const m of missing.slice(0, 300)) {
    if (!m.name) continue;
    const id = 'CUS-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    try {
      await saveCustomer(c.env.DB, id, { name: m.name }, true);
      added++;
    } catch {
      /* a name that appeared twice meanwhile: skip it */
    }
  }
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'customer', null, 'backfill', `${added} customers added from the order book`);
  return c.json({ ok: true, added, customers: await listCustomers(c.env.DB), missing: await missingCustomers(c.env.DB), snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- order notes
app.get('/api/orders/:id/notes', async (c) => {
  const id = c.req.param('id');
  return c.json({ notes: await listOrderNotes(c.env.DB, id) });
});

app.post('/api/orders/:id/notes', async (c) => {
  const id = c.req.param('id');
  const order = await c.env.DB.prepare('SELECT id, customer FROM orders WHERE id = ?').bind(id).first<any>();
  if (!order) return c.json({ error: 'not_found' }, 404);
  const body = await jsonBody(c);
  const text = str(body.body, 4000);
  if (!text) return c.json({ error: 'bad_request', message: 'Write something first' }, 400);
  const u: User = c.get('user');
  const noteId = await addOrderNote(c.env.DB, {
    orderId: id,
    body: text,
    kind: body.kind === 'update' ? 'update' : 'note',
    authorSub: u.sub,
    authorName: u.name || u.email || 'Someone',
  });
  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'order', id, 'note', `Note added to ${order.customer || id}`);
  return c.json({ ok: true, id: noteId, notes: await listOrderNotes(c.env.DB, id), snapshot: await snapshot(c) });
});

app.delete('/api/orders/:id/notes/:noteId', async (c) => {
  const id = c.req.param('id');
  const noteId = c.req.param('noteId');
  const u: User = c.get('user');
  const caps = c.get('caps') as Record<string, boolean>;
  const note = await c.env.DB
    .prepare('SELECT author_sub FROM order_notes WHERE id = ? AND order_id = ?')
    .bind(noteId, id)
    .first<{ author_sub: string | null }>();
  if (!note) return c.json({ error: 'not_found' }, 404);
  if (note.author_sub !== u.sub && !caps.delete) {
    return c.json({ error: 'forbidden', message: 'Only the author or an admin can delete this note' }, 403);
  }
  await deleteOrderNote(c.env.DB, noteId, id);
  return c.json({ ok: true, notes: await listOrderNotes(c.env.DB, id) });
});

// ---------------------------------------------------------------- order tags
app.put('/api/orders/:id/tags', async (c) => {
  const id = c.req.param('id');
  const order = await c.env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
  if (!order) return c.json({ error: 'not_found' }, 404);
  const body = await jsonBody(c);
  const tags = Array.isArray(body.tags) ? body.tags : [];
  const u: User = c.get('user');
  const clean = await setOrderTags(c.env.DB, id, tags, u.sub);
  return c.json({ ok: true, tags: clean, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- bulk actions
app.post('/api/orders/bulk', async (c) => {
  const body = await jsonBody(c);
  const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 200) : [];
  const action = String(body.action || '');
  if (!ids.length) return c.json({ error: 'bad_request', message: 'Pick at least one order' }, 400);
  const u: User = c.get('user');
  const caps = c.get('caps') as Record<string, boolean>;
  const marks = ids.map(() => '?').join(', ');
  let changed = 0;

  if (action === 'status') {
    const denied = guard(c, 'order');
    if (denied) return denied;
    const status = String(body.value || '');
    if (!['open', 'closed', 'cancelled'].includes(status)) return c.json({ error: 'bad_value' }, 400);
    const res = await c.env.DB
      .prepare(`UPDATE orders SET status = ?, updated_at = ?, updated_by = ? WHERE id IN (${marks})`)
      .bind(status, nowISO(), u.sub, ...ids)
      .run();
    changed = Number((res as any)?.meta?.changes ?? 0);
  } else if (action === 'priority') {
    const denied = guard(c, 'order');
    if (denied) return denied;
    const priority = str(body.value, 20) || 'Medium';
    if (!['Low', 'Medium', 'High', 'Urgent'].includes(priority)) return c.json({ error: 'bad_value' }, 400);
    const res = await c.env.DB
      .prepare(`UPDATE orders SET priority = ?, updated_at = ?, updated_by = ? WHERE id IN (${marks})`)
      .bind(priority, nowISO(), u.sub, ...ids)
      .run();
    changed = Number((res as any)?.meta?.changes ?? 0);
  } else if (action === 'tag') {
    const tag = String(body.value || '').trim().toLowerCase().slice(0, 24);
    if (!tag) return c.json({ error: 'bad_value' }, 400);
    for (const id of ids) {
      await c.env.DB
        .prepare('INSERT OR IGNORE INTO order_tags (order_id, tag, added_by, added_at) VALUES (?, ?, ?, ?)')
        .bind(id, tag, u.sub, nowISO())
        .run();
      changed++;
    }
  } else if (action === 'untag') {
    const tag = String(body.value || '').trim().toLowerCase();
    const res = await c.env.DB
      .prepare(`DELETE FROM order_tags WHERE tag = ? AND order_id IN (${marks})`)
      .bind(tag, ...ids)
      .run();
    changed = Number((res as any)?.meta?.changes ?? 0);
  } else if (action === 'delete') {
    if (!caps.delete) return c.json({ error: 'forbidden', message: 'You cannot delete orders' }, 403);
    for (const id of ids) {
      await deleteOrder(c.env.DB, id);
      changed++;
    }
  } else {
    return c.json({ error: 'bad_action' }, 400);
  }

  await logEvent(c.env.DB, { sub: u.sub, name: u.name }, 'order', null, 'bulk',
    `${changed} order(s): ${action}${body.value ? ' = ' + String(body.value).slice(0, 30) : ''}`);
  return c.json({ ok: true, changed, snapshot: await snapshot(c) });
});

// ---------------------------------------------------------------- static SPA
// notFound(), not app.all('*'): a catch-all also swallows every route Hono would
// otherwise resolve, which silently skipped the headers middleware and the
// "API 404 must be JSON" behaviour for anything that is not an /api route.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
// Last-resort handler: an unexpected exception becomes a JSON error with the
// real reason, instead of an opaque "Internal Server Error" in the browser.
app.onError((err, c) => {
  console.error('UNCAUGHT', c.req.method, c.req.path, err && ((err as any).stack || err));
  const message = String((err as any)?.message || err || 'Unexpected error');
  return c.json({ error: 'internal', message }, 500);
});

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return app.fetch(request, env);
  },
};
