-- ARS Solartech - Order to Dispatch Management System
-- D1 (SQLite) schema

CREATE TABLE IF NOT EXISTS users (
  sub         TEXT PRIMARY KEY,
  email       TEXT,
  name        TEXT,
  dept        TEXT,
  role        TEXT NOT NULL DEFAULT 'viewer',   -- admin | editor | viewer
  active      INTEGER NOT NULL DEFAULT 1,
  pass_hash   TEXT,                             -- pbkdf2$iterations$salt$hash
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  sub         TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  json        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS stakeholders (
  dept        TEXT PRIMARY KEY,
  person      TEXT,
  phone       TEXT,
  email       TEXT,
  scope       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  contact     TEXT,
  phone       TEXT,
  email       TEXT,
  gstin       TEXT,
  address     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  customer       TEXT,
  project        TEXT,
  structure_type TEXT,
  kwp            REAL,
  mt             REAL,
  po_date        TEXT,
  conf_date      TEXT,
  due_date       TEXT,
  priority       TEXT DEFAULT 'Medium',
  sales_owner    TEXT,
  o_des          INTEGER,
  o_pro          INTEGER,
  o_prd          INTEGER,
  remarks        TEXT,
  status         TEXT NOT NULL DEFAULT 'open',   -- open | closed | cancelled
  approval       TEXT NOT NULL DEFAULT 'pending',-- pending | approved
  approved_by    TEXT,
  approved_at    TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT
);

CREATE TABLE IF NOT EXISTS order_stages (
  order_id     TEXT NOT NULL,
  stage        TEXT NOT NULL,                    -- des apr mat ps pf qc dsp
  actual_date  TEXT,
  planned_date TEXT,
  assigned_sub TEXT,                             -- who inside the department owns it
  assigned_name TEXT,
  done_sub     TEXT,
  done_name    TEXT,
  updated_by   TEXT,
  updated_at   TEXT,
  PRIMARY KEY (order_id, stage)
);

CREATE TABLE IF NOT EXISTS dept_people (
  id          TEXT PRIMARY KEY,
  dept        TEXT NOT NULL,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  sub         TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dept_people_dept ON dept_people(dept, sort);

CREATE TABLE IF NOT EXISTS dispatches (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  batch       TEXT,
  qty         REAL NOT NULL,
  pdate       TEXT,
  adate       TEXT,
  vehicle     TEXT,
  transporter TEXT,
  invoice     TEXT,
  eway        TEXT,
  lr          TEXT,
  qc_ref      TEXT,
  remarks     TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS access_requests (
  id            TEXT PRIMARY KEY,
  sub           TEXT NOT NULL,
  email         TEXT,
  name          TEXT,
  ask_role      TEXT,
  ask_dept      TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  decided_by    TEXT,
  decision_note TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor_sub   TEXT,
  actor_name  TEXT,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_due      ON orders(due_date);
CREATE INDEX IF NOT EXISTS idx_stage_order     ON order_stages(order_id);
CREATE INDEX IF NOT EXISTS idx_disp_order      ON dispatches(order_id);
CREATE INDEX IF NOT EXISTS idx_events_at       ON events(at DESC);
