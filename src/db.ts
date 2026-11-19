import {
  DEFAULT_SETTINGS, STAGES, type Actuals, type Settings, type StageKey,
  liveStatus, planOrder, capacityPlan, type PlanOrder, NUMBERED_STAGES,
} from './plan';

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

export type User = {
  sub: string;
  email: string | null;
  name: string | null;
  dept: string | null;
  role: Role;
  active: number;
};

// Department -> what they are allowed to touch.
const DEPT_ACTIONS: Record<string, string[]> = {
  'Sales / Coordination': ['order'],
  'Design': ['des', 'apr'],
  'Production Planning': ['ovr', 'settings'],
  'Purchase': ['mat'],
  'Stores': ['mat'],
  'Production': ['ps', 'pf'],
  'QA/QC': ['qc'],
  'Dispatch': ['dsp', 'disp'],
  'Management': [],
};

export type Action =
  | 'order' | 'ovr' | 'settings' | 'users' | 'delete'
  | 'des' | 'apr' | 'mat' | 'ps' | 'pf' | 'qc' | 'dsp' | 'disp';

export function can(u: User | null, action: Action): boolean {
  if (!u || !u.active) return false;
  if (u.role === 'owner' || u.role === 'admin') return true;
  if (u.role === 'viewer') return false;
  if (action === 'users' || action === 'settings') return false;
  if (!u.dept) return false;
  return (DEPT_ACTIONS[u.dept] || []).includes(action);
}

/** Everything this user may do, for the UI to enable/disable controls. */
export function capabilities(u: User | null): Record<string, boolean> {
  const all: Action[] = ['order', 'ovr', 'settings', 'users', 'delete', 'des', 'apr', 'mat', 'ps', 'pf', 'qc', 'dsp', 'disp'];
  const out: Record<string, boolean> = {};
  for (const a of all) out[a] = can(u, a);
  return out;
}

const nowISO = () => new Date().toISOString();

// ---------------- settings ----------------
export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db.prepare('SELECT json FROM settings WHERE id = 1').first<{ json: string }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.json);
    return { ...DEFAULT_SETTINGS, ...parsed, dur: { ...DEFAULT_SETTINGS.dur, ...(parsed.dur || {}) } };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(db: D1Database, s: Settings, by: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (id, json, updated_at, updated_by) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(JSON.stringify(s), nowISO(), by)
    .run();
}

// ---------------- users ----------------
export async function listUsers(db: D1Database): Promise<User[]> {
  const { results } = await db
    .prepare('SELECT sub, email, name, dept, role, active FROM users ORDER BY (role = \'owner\') DESC, name')
    .all<User>();
  return results || [];
}

export async function getUser(db: D1Database, sub: string): Promise<User | null> {
  return await db.prepare('SELECT sub, email, name, dept, role, active FROM users WHERE sub = ?').bind(sub).first<User>();
}

export type AuthRow = User & { pass_hash: string | null };

/** Looks up a login row by email (case-insensitive). */
export async function findUserByEmail(db: D1Database, email: string): Promise<AuthRow | null> {
  return await db
    .prepare('SELECT sub, email, name, dept, role, active, pass_hash FROM users WHERE lower(email) = lower(?)')
    .bind(email)
    .first<AuthRow>();
}

/** True when nobody has been created yet, i.e. the first-run setup screen. */
export async function noUsersYet(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return (row?.n || 0) === 0;
}

export async function createUser(
  db: D1Database,
  u: { sub: string; email: string; name: string | null; dept: string | null; role: Role; passHash: string },
): Promise<User> {
  const at = nowISO();
  await db
    .prepare(
      `INSERT INTO users (sub, email, name, dept, role, active, pass_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(u.sub, u.email, u.name, u.dept, u.role, u.passHash, at, at)
    .run();
  return { sub: u.sub, email: u.email, name: u.name, dept: u.dept, role: u.role, active: 1 };
}

export async function setPassword(db: D1Database, sub: string, passHash: string): Promise<void> {
  await db.prepare('UPDATE users SET pass_hash = ?, updated_at = ? WHERE sub = ?').bind(passHash, nowISO(), sub).run();
}

// ---------------- sessions ----------------
export async function createSession(db: D1Database, sub: string, tokenHash: string, expiresAt: string) {
  await db
    .prepare('INSERT INTO sessions (token_hash, sub, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, sub, nowISO(), expiresAt)
    .run();
}

/** Session user, or null when the token is unknown/expired/disabled. */
export async function sessionUser(db: D1Database, tokenHash: string): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT u.sub, u.email, u.name, u.dept, u.role, u.active
         FROM sessions s JOIN users u ON u.sub = s.sub
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, nowISO())
    .first<User>();
  if (!row || !row.active) return null;
  return row;
}

export async function deleteSession(db: D1Database, tokenHash: string) {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function purgeSessions(db: D1Database) {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowISO()).run();
}

/**
 * Legacy Freebuff sign-in helper, kept for the old rows: the very first account
 * becomes owner, everyone else starts as viewer until an admin assigns a role.
 */
export async function ensureUser(
  db: D1Database,
  sub: string,
  email: string | null,
  name: string | null,
): Promise<User> {
  const existing = await getUser(db, sub);
  if (existing) {
    if ((existing.email || null) !== (email || null) || (existing.name || null) !== (name || null)) {
      await db.prepare('UPDATE users SET email = ?, name = ?, updated_at = ? WHERE sub = ?')
        .bind(email, name, nowISO(), sub).run();
      return { ...existing, email, name };
    }
    return existing;
  }
  const count = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  const role: Role = (count?.n || 0) === 0 ? 'owner' : 'viewer';
  const at = nowISO();
  await db
    .prepare('INSERT INTO users (sub, email, name, dept, role, active, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 1, ?, ?)')
    .bind(sub, email, name, role, at, at)
    .run();
  await logEvent(db, { sub, name }, 'user', sub, 'first_signin', `${name || email || sub} signed in (role ${role})`);
  return { sub, email, name, dept: null, role, active: 1 };
}

export async function updateUser(
  db: D1Database,
  sub: string,
  patch: { dept?: string | null; role?: Role; active?: number },
): Promise<void> {
  const u = await getUser(db, sub);
  if (!u) throw new Error('User not found');
  const dept = patch.dept === undefined ? u.dept : patch.dept;
  const role = patch.role === undefined ? u.role : patch.role;
  const active = patch.active === undefined ? u.active : patch.active;
  await db.prepare('UPDATE users SET dept = ?, role = ?, active = ?, updated_at = ? WHERE sub = ?')
    .bind(dept, role, active, nowISO(), sub).run();
}

// ---------------- stakeholders ----------------
export async function listStakeholders(db: D1Database) {
  const { results } = await db
    .prepare('SELECT dept, person, phone, email, scope, sort FROM stakeholders ORDER BY sort, dept')
    .all();
  return results || [];
}

export async function saveStakeholder(
  db: D1Database,
  s: { dept: string; person?: string; phone?: string; email?: string; scope?: string; sort?: number },
) {
  await db
    .prepare(
      `INSERT INTO stakeholders (dept, person, phone, email, scope, sort) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(dept) DO UPDATE SET person = excluded.person, phone = excluded.phone,
         email = excluded.email, scope = excluded.scope, sort = excluded.sort`,
    )
    .bind(s.dept, s.person || null, s.phone || null, s.email || null, s.scope || null, s.sort ?? 0)
    .run();
}

// ---------------- orders ----------------
export type OrderRow = {
  id: string;
  customer: string | null;
  project: string | null;
  structure_type: string | null;
  kwp: number | null;
  mt: number | null;
  po_date: string | null;
  conf_date: string | null;
  due_date: string | null;
  priority: string | null;
  sales_owner: string | null;
  o_des: number | null;
  o_pro: number | null;
  o_prd: number | null;
  remarks: string | null;
  status: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

export type DispatchRow = {
  id: string;
  order_id: string;
  batch: string | null;
  qty: number;
  pdate: string | null;
  adate: string | null;
  vehicle: string | null;
  transporter: string | null;
  invoice: string | null;
  eway: string | null;
  lr: string | null;
  qc_ref: string | null;
  remarks: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
};

export async function listOrderRows(db: D1Database): Promise<OrderRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM orders ORDER BY (status = \'open\') DESC, due_date IS NULL, due_date, id')
    .all<OrderRow>();
  return results || [];
}

export async function listStageRows(db: D1Database): Promise<{ order_id: string; stage: string; actual_date: string | null }[]> {
  const { results } = await db
    .prepare('SELECT order_id, stage, actual_date FROM order_stages WHERE actual_date IS NOT NULL')
    .all<{ order_id: string; stage: string; actual_date: string }>();
  return results || [];
}

export async function listDispatchRows(db: D1Database): Promise<DispatchRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM dispatches ORDER BY COALESCE(adate, pdate, created_at) DESC')
    .all<DispatchRow>();
  return results || [];
}

export type EnrichedOrder = OrderRow & {
  a: Actuals;
  live: ReturnType<typeof liveStatus>;
};

export function enrich(
  orders: OrderRow[],
  stageRows: { order_id: string; stage: string; actual_date: string | null }[],
  dispatches: DispatchRow[],
  settings: Settings,
  heads: Record<string, string>,
  today?: string,
): EnrichedOrder[] {
  const actuals: Record<string, Actuals> = {};
  for (const r of stageRows) {
    if (!r.actual_date) continue;
    if (!actuals[r.order_id]) actuals[r.order_id] = {};
    if ((STAGES as readonly string[]).includes(r.stage)) actuals[r.order_id][r.stage as StageKey] = r.actual_date;
  }
  const dispatched: Record<string, number> = {};
  for (const d of dispatches) {
    if (!d.adate) continue;
    dispatched[d.order_id] = (dispatched[d.order_id] || 0) + (Number(d.qty) || 0);
  }
  return orders.map((o) => {
    const a = actuals[o.id] || {};
    return {
      ...o,
      a,
      live: liveStatus(o as PlanOrder, a, dispatched[o.id] || 0, settings, heads, today),
    };
  });
}

export async function saveOrder(db: D1Database, id: string, body: Record<string, any>, by: string, isNew: boolean) {
  const at = nowISO();
  const f = (k: string) => {
    const v = body[k];
    if (v === undefined) return undefined;
    if (v === '' || v === null) return null;
    if (k === 'kwp' || k === 'mt') return Number(v);
    if (k === 'o_des' || k === 'o_pro' || k === 'o_prd') return Number(v) || null;
    return String(v);
  };
  const cols = ['customer', 'project', 'structure_type', 'kwp', 'mt', 'po_date', 'conf_date', 'due_date', 'priority', 'sales_owner', 'o_des', 'o_pro', 'o_prd', 'remarks', 'status'];
  if (isNew) {
    const vals = cols.map((c) => (f(c) === undefined ? null : f(c)));
    await db
      .prepare(
        `INSERT INTO orders (id, ${cols.join(', ')}, created_at, created_by, updated_at, updated_by)
         VALUES (?${', ?'.repeat(cols.length)}, ?, ?, ?, ?)`,
      )
      .bind(id, ...vals, at, by, at, by)
      .run();
  } else {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const c of cols) {
      const v = f(c);
      if (v === undefined) continue;
      sets.push(`${c} = ?`);
      vals.push(v);
    }
    sets.push('updated_at = ?', 'updated_by = ?');
    vals.push(at, by, id);
    await db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  }
}

export async function setStage(
  db: D1Database,
  orderId: string,
  stage: StageKey,
  actualDate: string | null,
  plannedDate: string | null,
  by: string,
) {
  await db
    .prepare(
      `INSERT INTO order_stages (order_id, stage, actual_date, planned_date, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id, stage) DO UPDATE SET actual_date = excluded.actual_date,
         planned_date = excluded.planned_date, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(orderId, stage, actualDate, plannedDate, by, nowISO())
    .run();
}

export async function deleteOrder(db: D1Database, id: string) {
  await db.batch([
    db.prepare('DELETE FROM order_stages WHERE order_id = ?').bind(id),
    db.prepare('DELETE FROM dispatches WHERE order_id = ?').bind(id),
    db.prepare('DELETE FROM orders WHERE id = ?').bind(id),
  ]);
}

// ---------------- dispatches ----------------
export async function saveDispatch(
  db: D1Database,
  d: Record<string, any>,
  by: string,
  isNew: boolean,
) {
  const at = nowISO();
  if (isNew) {
    await db
      .prepare(
        `INSERT INTO dispatches (id, order_id, batch, qty, pdate, adate, vehicle, transporter, invoice, eway, lr, qc_ref, remarks, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        d.id, d.order_id, d.batch || null, Number(d.qty) || 0, d.pdate || null, d.adate || null,
        d.vehicle || null, d.transporter || null, d.invoice || null, d.eway || null, d.lr || null,
        d.qc_ref || null, d.remarks || null, at, by,
      )
      .run();
  } else {
    const cols = ['order_id', 'batch', 'qty', 'pdate', 'adate', 'vehicle', 'transporter', 'invoice', 'eway', 'lr', 'qc_ref', 'remarks'];
    const sets: string[] = [];
    const vals: any[] = [];
    for (const c of cols) {
      if (d[c] === undefined) continue;
      sets.push(`${c} = ?`);
      vals.push(c === 'qty' ? Number(d[c]) || 0 : d[c] === '' ? null : d[c]);
    }
    sets.push('updated_at = ?');
    vals.push(at, d.id);
    await db.prepare(`UPDATE dispatches SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  }
}

export async function deleteDispatch(db: D1Database, id: string) {
  await db.prepare('DELETE FROM dispatches WHERE id = ?').bind(id).run();
}

// ---------------- events / audit ----------------
export async function logEvent(
  db: D1Database,
  actor: { sub: string | null; name: string | null },
  entity: string,
  entityId: string | null,
  action: string,
  detail: string,
) {
  await db
    .prepare('INSERT INTO events (at, actor_sub, actor_name, entity, entity_id, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(nowISO(), actor.sub, actor.name, entity, entityId, action, detail)
    .run();
}

export async function listEvents(db: D1Database, limit = 200) {
  const { results } = await db
    .prepare('SELECT id, at, actor_name, entity, entity_id, action, detail FROM events ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all();
  return results || [];
}

// ---------------- dashboard + capacity payloads ----------------
export function dashboard(orders: EnrichedOrder[], weeks = 16, settings: Settings) {
  const active = orders.filter((o) => o.live.rag !== 'CLOSED' && o.status === 'open');
  const closed = orders.filter((o) => o.live.rag === 'CLOSED' || o.status === 'closed');
  const count = (rag: string) => active.filter((o) => o.live.rag === rag).length;
  const mtActive = active.reduce((s, o) => s + (o.mt || 0), 0);
  const balance = active.reduce((s, o) => s + o.live.balanceMt, 0);

  const byStage = NUMBERED_STAGES.slice(0, 6).map((s) => {
    const list = active.filter((o) => o.live.stageNo === s.no);
    return {
      no: s.no,
      stage: s.name,
      dept: s.dept,
      head: list[0]?.live.head || '',
      count: list.length,
      mt: Math.round(list.reduce((x, o) => x + (o.mt || 0), 0) * 10) / 10,
    };
  });

  const attention = active
    .filter((o) => o.live.rag === 'RED' || o.live.daysOverdue > 0)
    .sort((a, b) => b.live.daysOverdue - a.live.daysOverdue)
    .slice(0, 10)
    .map((o) => ({
      id: o.id,
      customer: o.customer,
      stage: o.live.stage,
      withWhom: o.live.dept + (o.live.head ? ' - ' + o.live.head : ''),
      daysOverdue: o.live.daysOverdue,
      dueDate: o.due_date,
      forecast: o.live.forecastDispatch,
      rag: o.live.rag,
      ragLabel: o.live.ragLabel,
    }));

  return {
    kpis: {
      active: active.length,
      closed: closed.length,
      red: count('RED'),
      amber: count('AMBER'),
      green: count('GREEN'),
      activeMt: Math.round(mtActive * 10) / 10,
      balanceMt: Math.round(balance * 10) / 10,
      sopAlerts: active.filter((o) => o.live.sopFlag).length,
      overdue: active.filter((o) => o.live.daysOverdue > 0).length,
    },
    byStage,
    attention,
    capacity: capacityPlan(active.map((o) => ({ o, a: o.a, mt: o.mt || 0 })), settings, weeks),
  };
}
