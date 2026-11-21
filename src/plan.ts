// Planning engine - single source of truth for schedule + status.
// Mirrors the Excel workbook: working days, parallel approval/procurement,
// production days = ceil(MT / capacity), QC and dispatch prep at the end.

// Every permission a role can hold. The matrix in Settings edits these.
export const ACCESS_ACTIONS = [
  'order', 'ovr', 'settings', 'users', 'delete', 'approve',
  'des', 'apr', 'mat', 'ps', 'pf', 'qc', 'dsp', 'disp',
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];
export type AccessMap = Record<string, string[]>;

// Presets. Owner is never limited; custom roles follow their department.
export const DEFAULT_ACCESS: AccessMap = {
  owner: [...ACCESS_ACTIONS],
  admin: [...ACCESS_ACTIONS],
  manager: [...ACCESS_ACTIONS],
  editor: ['des', 'apr', 'mat', 'ps', 'pf', 'qc', 'dsp', 'disp'],
  viewer: [],
};

export type NotifySettings = {
  email: boolean;       // send to the account email (needs RESEND_API_KEY)
  whatsapp: boolean;    // send to the account mobile (needs WHATSAPP_TOKEN + WHATSAPP_PHONE_ID)
  webhook: string;      // any gateway: WhatsApp/SMS/n8n/Zapier receives JSON
  escalate: number;     // days overdue before a task is escalated
};

export type Settings = {
  dur: { des: number; apr: number; pro: number; qc: number; dsp: number };
  cap: number;          // MT per working day
  tight: number;        // tight-buffer alert (days)
  off: number[];        // 0=Sun .. 6=Sat
  holidays: string[];   // YYYY-MM-DD
  access: AccessMap;    // role -> allowed actions
  notify: NotifySettings;
};

export const DEFAULT_SETTINGS: Settings = {
  dur: { des: 5, apr: 2, pro: 7, qc: 1, dsp: 1 },
  cap: 8,
  tight: 3,
  off: [0],
  holidays: [],
  access: { ...DEFAULT_ACCESS },
  notify: { email: false, whatsapp: false, webhook: '', escalate: 2 },
};

export const STAGES = ['des', 'apr', 'mat', 'ps', 'pf', 'qc', 'dsp'] as const;
export type StageKey = (typeof STAGES)[number];

export const STAGE_META: { key: StageKey; no: number; label: string; actual: string; dept: string }[] = [
  { key: 'des', no: 1, label: 'Design & BOM',        actual: 'Design done',            dept: 'Design' },
  { key: 'apr', no: 2, label: 'Drawing approval',    actual: 'Drawing approved',       dept: 'Design' },
  { key: 'mat', no: 3, label: 'Material procurement', actual: 'Material received',      dept: 'Purchase' },
  { key: 'ps',  no: 4, label: 'Production',          actual: 'Production started',     dept: 'Production' },
  { key: 'pf',  no: 4, label: 'Production',          actual: 'Production done',        dept: 'Production' },
  { key: 'qc',  no: 5, label: 'QC inspection',       actual: 'QC cleared',             dept: 'QA/QC' },
  { key: 'dsp', no: 6, label: 'Packing & dispatch',  actual: 'Dispatch done',          dept: 'Dispatch' },
];

export const NUMBERED_STAGES = [
  { no: 1, name: 'Design & BOM', dept: 'Design' },
  { no: 2, name: 'Drawing Approval', dept: 'Design' },
  { no: 3, name: 'Material Procurement', dept: 'Purchase' },
  { no: 4, name: 'Production', dept: 'Production' },
  { no: 5, name: 'QC Inspection', dept: 'QA/QC' },
  { no: 6, name: 'Packing & Dispatch', dept: 'Dispatch' },
  { no: 7, name: 'Closed (Dispatched)', dept: '-' },
];

export const DEPTS = [
  'Super Admin',
  'Sales / Coordination',
  'Design',
  'Production Planning',
  'Purchase',
  'Stores',
  'Production',
  'QA/QC',
  'Dispatch',
  'Management',
];

// ---------- dates (all dates are plain YYYY-MM-DD, treated as UTC) ----------
export const iso = (d: Date): string => d.toISOString().slice(0, 10);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * A real calendar day as YYYY-MM-DD, or null. `2026-02-31` and `2026-13-01`
 * pass a naive regex, so the month and day are checked against the year's
 * actual calendar (leap years included) before the value is trusted.
 */
export function validDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!DATE_RE.test(s)) return null;
  const y = +s.slice(0, 4);
  const m = +s.slice(5, 7);
  const d = +s.slice(8, 10);
  if (m < 1 || m > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const max = m === 2 && leap ? 29 : MONTH_DAYS[m - 1];
  return d > max ? null : s;
}

/**
 * Parse a date for the planner. Never returns an Invalid Date: the planner
 * does arithmetic on whatever it is given, so one unparseable value in one row
 * used to throw inside toISOString() and take the whole snapshot down with it.
 * An unusable value is treated as "no date" instead.
 */
export const parse = (s: string): Date => {
  const ok = validDate(s);
  return ok ? new Date(ok + 'T00:00:00Z') : new Date(NaN);
};

export const todayISO = (now: Date = new Date()): string => iso(now);

export function addDays(s: string, n: number): string {
  const d = parse(s);
  if (Number.isNaN(d.getTime())) return s;
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** Days from b to a; NaN inputs would poison every comparison, so return 0. */
export function dayDiff(a: string, b: string): number {
  const diff = parse(a).getTime() - parse(b).getTime();
  return Number.isFinite(diff) ? Math.round(diff / 86400000) : 0;
}

function isWorking(d: Date, s: Settings, hol: Set<string>): boolean {
  return !s.off.includes(d.getUTCDay()) && !hol.has(iso(d));
}

/** Add n working days (n = 0 returns the same date if it is a working day, else next working day). */
export function addWorkingDays(start: string, n: number, s: Settings): string {
  const hol = new Set(s.holidays);
  const d = parse(start);
  if (Number.isNaN(d.getTime())) return start;
  let left = Math.max(0, Math.trunc(n));
  if (left === 0) {
    let guard = 0;
    while (!isWorking(d, s, hol) && guard++ < 400) d.setUTCDate(d.getUTCDate() + 1);
    return iso(d);
  }
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorking(d, s, hol)) left--;
  }
  return iso(d);
}

/** Count working days in the inclusive window [a, b]. */
export function workingDaysBetween(a: string, b: string, s: Settings): number {
  if (!a || !b || a > b) return 0;
  const hol = new Set(s.holidays);
  const d = parse(a);
  const end = parse(b);
  if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime())) return 0;
  let n = 0;
  while (d <= end) {
    if (isWorking(d, s, hol)) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

/** Monday of the week containing the given date. */
export function weekStart(s: string): string {
  const d = parse(s);
  if (Number.isNaN(d.getTime())) return s;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(d);
}

// ---------- plan ----------
export type PlanOrder = {
  id: string;
  mt: number | null;
  o_des: number | null;
  o_pro: number | null;
  o_prd: number | null;
  conf_date: string | null;
  due_date: string | null;
};

export type Plan = {
  des: string; apr: string; mat: string; ps: string; pf: string; qc: string; dsp: string;
  prodDays: number;
};

export function planOrder(o: PlanOrder, s: Settings): Plan | null {
  if (!validDate(o.conf_date)) return null;
  const des = addWorkingDays(o.conf_date, o.o_des ?? s.dur.des, s);
  const apr = addWorkingDays(des, s.dur.apr, s);
  const mat = addWorkingDays(des, o.o_pro ?? s.dur.pro, s);
  const ps = addWorkingDays(apr > mat ? apr : mat, 1, s);
  const prodDays = o.o_prd ?? Math.max(1, Math.ceil((o.mt || 0) / (s.cap || 1)));
  const pf = addWorkingDays(ps, prodDays - 1, s);
  const qc = addWorkingDays(pf, s.dur.qc, s);
  const dsp = addWorkingDays(qc, s.dur.dsp, s);
  return { des, apr, mat, ps, pf, qc, dsp, prodDays };
}

// ---------- live status ----------
export type Actuals = Partial<Record<StageKey, string | null>>;

export type Live = {
  stageNo: number;
  stage: string;
  dept: string;
  head: string;
  stageDue: string | null;
  daysOverdue: number;
  plannedDispatch: string | null;
  forecastDispatch: string | null;
  bufferDays: number | null;
  rag: 'RED' | 'AMBER' | 'GREEN' | 'CLOSED' | 'NOT PLANNED';
  ragLabel: string;
  progress: number;          // 0..100
  dispatchedMt: number;
  balanceMt: number;
  sopFlag: string | null;
  plan: Plan | null;
};

/** The stage whose action is pending: first missing actual in the SOP order. */
export function currentStageIndex(a: Actuals): number {
  if (!a.des) return 0;
  if (!a.apr) return 1;
  if (!a.mat) return 2;
  if (!a.pf) return 3;
  if (!a.qc) return 4;
  if (!a.dsp) return 5;
  return 6;
}

const STAGE_KEYS_FOR_INDEX: StageKey[] = ['des', 'apr', 'mat', 'pf', 'qc', 'dsp'];

export function liveStatus(
  o: PlanOrder,
  a: Actuals,
  dispatchedMt: number,
  s: Settings,
  heads: Record<string, string> = {},
  today: string = todayISO(),
): Live {
  const plan = planOrder(o, s);
  const idx = currentStageIndex(a);
  const stageNo = idx < 6 ? STAGE_META.filter((m) => STAGE_KEYS_FOR_INDEX[idx] === m.key)[0].no : 7;
  const stageName = NUMBERED_STAGES[Math.min(stageNo, 7) - 1].name;
  const dept = NUMBERED_STAGES[Math.min(stageNo, 7) - 1].dept;

  const dueKey = idx < 6 ? STAGE_KEYS_FOR_INDEX[idx] : null;
  const stageDue = plan && dueKey ? (plan as any)[dueKey] : null;
  const daysOverdue = stageDue ? Math.max(0, dayDiff(today, stageDue)) : 0;

  const plannedDispatch = plan ? plan.dsp : null;
  const forecastDispatch = plan ? (idx === 6 ? (a.dsp || plan.dsp) : addDays(plan.dsp, daysOverdue)) : null;
  // A due date that is not a calendar day is no due date; without this, a
  // hand-edited row would make bufferDays NaN and the RAG colour meaningless.
  const dueDate = validDate(o.due_date);
  const bufferDays = plannedDispatch && dueDate ? dayDiff(dueDate, plannedDispatch) : null;

  let rag: Live['rag'];
  if (idx === 6) rag = 'CLOSED';
  else if (!plan) rag = 'NOT PLANNED';
  else if (dueDate && forecastDispatch && forecastDispatch > dueDate) rag = 'RED';
  else if (daysOverdue > 0) rag = 'AMBER';
  else if (bufferDays != null && bufferDays < s.tight) rag = 'AMBER';
  else rag = 'GREEN';

  const ragLabel =
    rag === 'RED' ? 'RED - late'
    : rag === 'AMBER' ? (daysOverdue > 0 ? 'AMBER - delayed' : 'AMBER - tight')
    : rag === 'GREEN' ? 'GREEN - on track'
    : rag === 'CLOSED' ? 'Closed'
    : 'Not planned';

  const done = ['des', 'apr', 'mat', 'ps', 'pf', 'qc', 'dsp'].filter((k) => (a as any)[k]).length;
  const progress = idx === 6 ? 100 : Math.round((done / 7) * 100);

  const balanceMt = Math.max(0, (o.mt || 0) - dispatchedMt);

  let sopFlag: string | null = null;
  if (a.des && !o.conf_date) sopFlag = 'Design started without ERP confirmation';
  else if (a.ps && !a.apr) sopFlag = 'Production without approved drawing';
  else if (a.dsp && !a.qc) sopFlag = 'Dispatch without QC clearance';

  return {
    stageNo,
    stage: stageName,
    dept,
    head: heads[dept] || '',
    stageDue,
    daysOverdue,
    plannedDispatch,
    forecastDispatch,
    bufferDays,
    rag,
    ragLabel,
    progress,
    dispatchedMt: Math.round(dispatchedMt * 100) / 100,
    balanceMt: Math.round(balanceMt * 100) / 100,
    sopFlag,
    plan,
  };
}

// ---------- weekly capacity ----------
export type CapacityWeek = {
  start: string;
  end: string;
  workingDays: number;
  capacityMt: number;
  loadMt: number;
  utilisation: number;
  freeMt: number;
  status: 'OVERLOADED' | 'HIGH' | 'OK';
};

export function capacityPlan(
  orders: { o: PlanOrder; a: Actuals; mt: number }[],
  s: Settings,
  weeks = 16,
  today: string = todayISO(),
): CapacityWeek[] {
  const first = weekStart(validDate(today) || todayISO());
  const out: CapacityWeek[] = [];
  for (let w = 0; w < weeks; w++) {
    const start = addDays(first, w * 7);
    const end = addDays(start, 6);
    const workingDays = workingDaysBetween(start, end, s);
    const capacityMt = workingDays * (s.cap || 0);

    let loadMt = 0;
    for (const { o, a, mt } of orders) {
      if ((a as any).pf) continue;                 // production done -> no remaining load
      const p = planOrder(o, s);
      if (!p || !mt) continue;
      const lo = p.ps > start ? p.ps : start;
      const hi = p.pf < end ? p.pf : end;
      const wd = workingDaysBetween(lo, hi, s);     // working days of the window inside this week
      if (wd > 0) loadMt += (mt / Math.max(1, p.prodDays)) * wd;
    }

    const utilisation = capacityMt ? loadMt / capacityMt : 0;
    out.push({
      start,
      end,
      workingDays,
      capacityMt: Math.round(capacityMt * 10) / 10,
      loadMt: Math.round(loadMt * 10) / 10,
      utilisation: Math.round(utilisation * 1000) / 1000,
      freeMt: Math.round((capacityMt - loadMt) * 10) / 10,
      status: utilisation > 1 ? 'OVERLOADED' : utilisation > 0.85 ? 'HIGH' : 'OK',
    });
  }
  return out;
}
