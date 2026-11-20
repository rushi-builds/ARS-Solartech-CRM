// ARS Solartech - Order to Dispatch Management System
// Idempotent D1 bootstrap. Mirrors schema.sql; every statement is IF NOT EXISTS
// so it is safe to run on every cold isolate (and on an already-populated DB).
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    sub TEXT PRIMARY KEY, email TEXT, name TEXT, dept TEXT,
    role TEXT NOT NULL DEFAULT 'viewer', active INTEGER NOT NULL DEFAULT 1,
    pass_hash TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, sub TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL,
    updated_at TEXT NOT NULL, updated_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS stakeholders (
    dept TEXT PRIMARY KEY, person TEXT, phone TEXT, email TEXT, scope TEXT,
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT, phone TEXT,
    email TEXT, gstin TEXT, address TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, customer TEXT, project TEXT, structure_type TEXT,
    kwp REAL, mt REAL, po_date TEXT, conf_date TEXT, due_date TEXT,
    priority TEXT DEFAULT 'Medium', sales_owner TEXT,
    o_des INTEGER, o_pro INTEGER, o_prd INTEGER, remarks TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS order_stages (
    order_id TEXT NOT NULL, stage TEXT NOT NULL, actual_date TEXT,
    planned_date TEXT, updated_by TEXT, updated_at TEXT,
    PRIMARY KEY (order_id, stage)
  )`,
  `CREATE TABLE IF NOT EXISTS dispatches (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, batch TEXT, qty REAL NOT NULL,
    pdate TEXT, adate TEXT, vehicle TEXT, transporter TEXT, invoice TEXT,
    eway TEXT, lr TEXT, qc_ref TEXT, remarks TEXT,
    created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS dept_people (
    id TEXT PRIMARY KEY, dept TEXT NOT NULL, name TEXT, email TEXT, phone TEXT,
    sub TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY, sub TEXT NOT NULL, email TEXT, name TEXT,
    ask_role TEXT, ask_dept TEXT, note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, decision_note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_sub TEXT,
    actor_name TEXT, entity TEXT NOT NULL, entity_id TEXT,
    action TEXT NOT NULL, detail TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_due ON orders(due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_stage_order ON order_stages(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_disp_order ON dispatches(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_dept_people_dept ON dept_people(dept, sort)`,
  // One-off copy of the old single-head rows so nobody disappears.
  `INSERT INTO dept_people (id, dept, name, email, phone, sub, sort, created_at)
   SELECT 'legacy-' || dept, dept, person, email, phone, NULL, sort, datetime('now')
   FROM stakeholders WHERE person IS NOT NULL AND person != ''
   AND NOT EXISTS (SELECT 1 FROM dept_people d WHERE d.id = 'legacy-' || stakeholders.dept)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_sub ON sessions(sub)`,
  `CREATE INDEX IF NOT EXISTS idx_access_status ON access_requests(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_access_sub ON access_requests(sub)`,
];

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS,
// so each one is applied on its own and treated as done when it already exists.
const ALTERS: string[] = [
  `ALTER TABLE users ADD COLUMN pass_hash TEXT`,
  `ALTER TABLE order_stages ADD COLUMN assigned_sub TEXT`,
  `ALTER TABLE order_stages ADD COLUMN assigned_name TEXT`,
  `ALTER TABLE order_stages ADD COLUMN done_sub TEXT`,
  `ALTER TABLE order_stages ADD COLUMN done_name TEXT`,
  `ALTER TABLE orders ADD COLUMN approval TEXT NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE orders ADD COLUMN approved_by TEXT`,
  `ALTER TABLE orders ADD COLUMN approved_at TEXT`,
];

let ready: Promise<void> | null = null;

/** Creates the schema once per isolate; resolves immediately afterwards. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.batch(DDL.map((sql) => db.prepare(sql)));
      for (const sql of ALTERS) {
        try {
          await db.prepare(sql).run();
        } catch {
          /* column already present on an older database */
        }
      }
    })().catch((err) => {
      ready = null; // let a later request retry instead of caching the failure
      throw err;
    });
  }
  return ready;
}
