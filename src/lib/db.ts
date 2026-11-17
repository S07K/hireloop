import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, paths } from "./config.js";

export type LeadStatus = "new" | "qualified" | "rejected" | "enriched" | "drafted" | "contacted" | "replied" | "interview" | "archived";
export type DraftStatus = "pending" | "approved" | "sending" | "sent" | "rejected" | "failed";
export type ContactKind = "founder" | "hiring_manager" | "poster" | "recruiter" | "hr" | "employee";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  role TEXT NOT NULL,
  company TEXT,
  company_domain TEXT,
  company_url TEXT,
  company_size TEXT,
  company_region TEXT,
  poster_name TEXT,
  poster_title TEXT,
  poster_url TEXT,
  post_text TEXT,
  posted_at TEXT,
  work_mode TEXT,
  location TEXT,
  eligible_regions TEXT,
  eligible_for_me INTEGER,
  salary TEXT,
  tags TEXT DEFAULT '[]',
  fit_score INTEGER,
  fit_reason TEXT,
  apply_url TEXT,
  status TEXT NOT NULL DEFAULT 'qualified',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE TABLE IF NOT EXISTS seen_urls (
  url_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  verdict TEXT,
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  name TEXT,
  title TEXT,
  kind TEXT NOT NULL,
  email TEXT,
  email_confidence INTEGER DEFAULT 0,
  email_source TEXT,
  verification TEXT DEFAULT 'unknown',
  linkedin_url TEXT,
  x_url TEXT,
  github_url TEXT,
  priority INTEGER DEFAULT 50,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lead_id, email)
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'initial',
  parent_draft_id INTEGER,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  original_body TEXT,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  message_id TEXT,
  scheduled_for TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  summary TEXT,
  log TEXT DEFAULT '',
  cost_usd REAL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
`;

let db: DatabaseSync | null = null;
export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(paths.db), { recursive: true });
  db = new DatabaseSync(paths.db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // lightweight migrations for databases created by older versions
  const cols = new Set((db.prepare("PRAGMA table_info(leads)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("company_region")) db.exec("ALTER TABLE leads ADD COLUMN company_region TEXT");
  return db;
}

export const hashUrl = (url: string) =>
  crypto.createHash("sha1").update(normalizeUrl(url)).digest("hex");

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref|trk|src|s$|t$|lipi|rcm)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.replace(/^(www\.|m\.|old\.|mobile\.)/, "");
    if (u.hostname === "twitter.com") u.hostname = "x.com";
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

type Row = Record<string, unknown>;
const all = <T = Row>(sql: string, ...params: unknown[]) => getDb().prepare(sql).all(...(params as never[])) as T[];
const one = <T = Row>(sql: string, ...params: unknown[]) => getDb().prepare(sql).get(...(params as never[])) as T | undefined;
const run = (sql: string, ...params: unknown[]) => getDb().prepare(sql).run(...(params as never[]));

// ---------- seen urls (dedupe across runs, including rejected posts) ----------
export function filterUnseen(urls: string[]): Set<string> {
  const unseen = new Set<string>();
  for (const url of urls) {
    const h = hashUrl(url);
    const hit = one("SELECT 1 AS x FROM seen_urls WHERE url_hash = ?", h) ?? one("SELECT 1 AS x FROM leads WHERE url_hash = ?", h);
    if (!hit) unseen.add(url);
  }
  return unseen;
}
export function markSeen(url: string, verdict: string) {
  run("INSERT OR REPLACE INTO seen_urls(url_hash, url, verdict) VALUES (?, ?, ?)", hashUrl(url), url, verdict);
}

// ---------- leads ----------
export interface LeadInput {
  source: string;
  source_url: string;
  role: string;
  company?: string | null;
  company_domain?: string | null;
  company_url?: string | null;
  company_size?: string | null;
  company_region?: string | null;
  poster_name?: string | null;
  poster_title?: string | null;
  poster_url?: string | null;
  post_text?: string | null;
  posted_at?: string | null;
  work_mode?: string | null;
  location?: string | null;
  eligible_regions?: string | null;
  eligible_for_me?: boolean | null;
  salary?: string | null;
  tags?: string[];
  fit_score?: number | null;
  fit_reason?: string | null;
  apply_url?: string | null;
}

export function upsertLead(l: LeadInput): { id: number; created: boolean } {
  for (const k of Object.keys(l) as (keyof LeadInput)[]) (l as any)[k] = clean(l[k]);
  const h = hashUrl(l.source_url);
  const existing = one<{ id: number }>("SELECT id FROM leads WHERE url_hash = ?", h);
  if (existing) return { id: existing.id, created: false };
  const domain = l.company_domain ? cleanDomain(l.company_domain) : null;
  const res = run(
    `INSERT INTO leads (url_hash, source, source_url, role, company, company_domain, company_url, company_size, company_region, poster_name, poster_title, poster_url,
      post_text, posted_at, work_mode, location, eligible_regions, eligible_for_me, salary, tags, fit_score, fit_reason, apply_url, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'qualified')`,
    h, l.source, l.source_url, l.role, l.company ?? null, domain, l.company_url ?? null, l.company_size ?? null, l.company_region ?? null,
    l.poster_name ?? null, l.poster_title ?? null, l.poster_url ?? null, (l.post_text ?? "").slice(0, 6000), l.posted_at ?? null,
    l.work_mode ?? null, l.location ?? null, l.eligible_regions ?? null,
    l.eligible_for_me == null ? null : l.eligible_for_me ? 1 : 0, l.salary ?? null, JSON.stringify(l.tags ?? []),
    l.fit_score ?? null, l.fit_reason ?? null, l.apply_url ?? null,
  );
  markSeen(l.source_url, "lead");
  return { id: Number(res.lastInsertRowid), created: true };
}

export const cleanDomain = (d: string) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];

const LEAD_UPDATABLE = new Set(["status", "notes", "company", "company_domain", "company_url", "company_size", "company_region", "poster_name", "poster_title", "poster_url", "work_mode", "location", "eligible_regions", "eligible_for_me", "fit_score", "fit_reason", "role", "apply_url", "salary"]);
export function updateLead(id: number, patch: Record<string, unknown>) {
  const keys = Object.keys(patch).filter((k) => LEAD_UPDATABLE.has(k));
  if (!keys.length) return;
  const vals = keys.map((k) => {
    const v = patch[k];
    if (k === "company_domain" && typeof v === "string") return cleanDomain(v);
    if (typeof v === "boolean") return v ? 1 : 0;
    return v ?? null;
  });
  run(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...vals, id);
}

/** 1 = most preferred per config.location.priority; priority.length + 1 = matches no rule. */
export function locationTier(l: { work_mode?: unknown; company_region?: unknown; location?: unknown; eligible_regions?: unknown }) {
  const rules = loadConfig().location.priority;
  if (!rules.length) return { tier: 1, label: null as string | null };
  const has = (hay: unknown, needles: string[]) => needles.some((n) => String(hay ?? "").toLowerCase().includes(n.toLowerCase()));
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (l.work_mode !== r.work_mode) continue;
    if (r.company_regions.length && !has(l.company_region, r.company_regions)) continue;
    if (r.cities.length && !has(`${l.location ?? ""} ${l.eligible_regions ?? ""}`, r.cities)) continue;
    return { tier: i + 1, label: r.label };
  }
  return { tier: rules.length + 1, label: null };
}

export interface LeadFilter {
  max_tier?: number;
  status?: string[];
  work_mode?: string[];
  location?: string;
  source?: string;
  min_score?: number;
  eligible_only?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}
export function listLeads(f: LeadFilter = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status?.length) { where.push(`l.status IN (${f.status.map(() => "?").join(",")})`); params.push(...f.status); }
  if (f.work_mode?.length) { where.push(`l.work_mode IN (${f.work_mode.map(() => "?").join(",")})`); params.push(...f.work_mode); }
  if (f.source) { where.push("l.source = ?"); params.push(f.source); }
  if (f.min_score != null) { where.push("COALESCE(l.fit_score,0) >= ?"); params.push(f.min_score); }
  if (f.eligible_only) where.push("COALESCE(l.eligible_for_me,1) = 1");
  if (f.location) {
    const terms = f.location.split(",").map((s) => s.trim()).filter(Boolean);
    if (terms.length) {
      where.push(`(${terms.map(() => "(l.location LIKE ? OR l.eligible_regions LIKE ?)").join(" OR ")})`);
      for (const t of terms) params.push(`%${t}%`, `%${t}%`);
    }
  }
  if (f.q) { where.push("(l.role LIKE ? OR l.company LIKE ? OR l.post_text LIKE ?)"); params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  const sql = `SELECT l.*,
      (SELECT COUNT(*) FROM contacts c WHERE c.lead_id = l.id AND c.email IS NOT NULL) AS contact_count,
      (SELECT COUNT(*) FROM drafts d WHERE d.lead_id = l.id AND d.status = 'pending') AS pending_drafts
    FROM leads l ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(l.fit_score,0) DESC, l.created_at DESC LIMIT ? OFFSET ?`;
  // Rank by location preference tier, then fit score. Tier is computed on read so config edits apply instantly.
  const rows: any[] = all(sql, ...params, 5000, 0).map(parseLead).map((r: any) => {
    const t = locationTier(r);
    return { ...r, location_tier: t.tier, location_label: t.label };
  }).filter((r) => f.max_tier == null || r.location_tier <= f.max_tier);
  rows.sort((a, b) => a.location_tier - b.location_tier || (Number(b.fit_score) || 0) - (Number(a.fit_score) || 0));
  return rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 200));
}
const parseLead = (r: Row): Row & { tags: string[] } => ({ ...r, tags: safeJson<string[]>(r.tags as string, []) });
const safeJson = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export const getLead = (id: number) => {
  const r = one("SELECT * FROM leads WHERE id = ?", id);
  return r ? parseLead(r) : undefined;
};

// ---------- contacts ----------
export interface ContactInput {
  lead_id: number;
  name?: string | null;
  title?: string | null;
  kind: ContactKind;
  email?: string | null;
  email_confidence?: number;
  email_source?: string | null;
  verification?: string;
  linkedin_url?: string | null;
  x_url?: string | null;
  github_url?: string | null;
}
const KIND_PRIORITY: Record<string, number> = { founder: 100, hiring_manager: 90, poster: 85, recruiter: 70, hr: 65, employee: 40 };
/** LLM tool calls sometimes send "null"/"none"/"" for unknown values. */
export const clean = <T,>(v: T): T | null =>
  typeof v === "string" && /^(null|none|n\/a|unknown|undefined|-)?$/i.test(v.trim()) ? null : v;

export function upsertContact(c: ContactInput): number {
  for (const k of ["name", "title", "email", "email_source", "linkedin_url", "x_url", "github_url"] as const) (c as any)[k] = clean(c[k]);
  const email = c.email && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(c.email.trim()) ? c.email.trim().toLowerCase() : null;
  const existing = email
    ? one<{ id: number }>("SELECT id FROM contacts WHERE lead_id = ? AND email = ?", c.lead_id, email)
    : c.name ? one<{ id: number }>("SELECT id FROM contacts WHERE lead_id = ? AND lower(name) = lower(?) AND email IS NULL", c.lead_id, c.name) : undefined;
  const priority = KIND_PRIORITY[c.kind] ?? 50;
  if (existing) {
    run(`UPDATE contacts SET name = COALESCE(?, name), title = COALESCE(?, title), kind = ?, email = COALESCE(?, email),
         email_confidence = MAX(COALESCE(email_confidence,0), ?), email_source = COALESCE(?, email_source), verification = COALESCE(?, verification),
         linkedin_url = COALESCE(?, linkedin_url), x_url = COALESCE(?, x_url), github_url = COALESCE(?, github_url), priority = ? WHERE id = ?`,
      c.name ?? null, c.title ?? null, c.kind, email, c.email_confidence ?? 0, c.email_source ?? null, c.verification ?? null,
      c.linkedin_url ?? null, c.x_url ?? null, c.github_url ?? null, priority, existing.id);
    return existing.id;
  }
  const res = run(`INSERT INTO contacts (lead_id, name, title, kind, email, email_confidence, email_source, verification, linkedin_url, x_url, github_url, priority)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.lead_id, c.name ?? null, c.title ?? null, c.kind, email, c.email_confidence ?? 0, c.email_source ?? null, c.verification ?? "unknown",
    c.linkedin_url ?? null, c.x_url ?? null, c.github_url ?? null, priority);
  return Number(res.lastInsertRowid);
}
export const listContacts = (leadId?: number) =>
  leadId
    ? all("SELECT * FROM contacts WHERE lead_id = ? ORDER BY priority DESC, email_confidence DESC", leadId)
    : all(`SELECT c.*, l.company, l.role FROM contacts c JOIN leads l ON l.id = c.lead_id ORDER BY c.created_at DESC LIMIT 500`);
export const getContact = (id: number) => one("SELECT * FROM contacts WHERE id = ?", id);
export const emailAlreadyContacted = (email: string) =>
  !!one(`SELECT 1 AS x FROM drafts d JOIN contacts c ON c.id = d.contact_id WHERE c.email = ? AND d.status IN ('sent','sending','approved')`, email.toLowerCase());

// ---------- drafts ----------
export function createDraft(d: { lead_id: number; contact_id: number; subject: string; body: string; rationale?: string; kind?: string; parent_draft_id?: number | null }) {
  const dup = one<{ id: number }>("SELECT id FROM drafts WHERE contact_id = ? AND kind = ? AND status IN ('pending','approved','sending','sent')", d.contact_id, d.kind ?? "initial");
  if (dup && (d.kind ?? "initial") === "initial") {
    run("UPDATE drafts SET subject = ?, body = ?, original_body = ?, rationale = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'", d.subject, d.body, d.body, d.rationale ?? null, dup.id);
    return dup.id;
  }
  const res = run("INSERT INTO drafts (lead_id, contact_id, kind, parent_draft_id, subject, body, original_body, rationale) VALUES (?,?,?,?,?,?,?,?)",
    d.lead_id, d.contact_id, d.kind ?? "initial", d.parent_draft_id ?? null, d.subject, d.body, d.body, d.rationale ?? null);
  run("UPDATE leads SET status = 'drafted', updated_at = datetime('now') WHERE id = ? AND status IN ('qualified','enriched')", d.lead_id);
  return Number(res.lastInsertRowid);
}
export function listDrafts(status?: string) {
  return all(`SELECT d.*, c.name AS contact_name, c.title AS contact_title, c.kind AS contact_kind, c.email AS contact_email,
      c.email_confidence, c.verification, l.role, l.company, l.source_url, l.fit_score, l.work_mode, l.location
    FROM drafts d JOIN contacts c ON c.id = d.contact_id JOIN leads l ON l.id = d.lead_id
    ${status ? "WHERE d.status = ?" : ""} ORDER BY d.updated_at DESC LIMIT 500`, ...(status ? [status] : []));
}
export const getDraft = (id: number) => one("SELECT * FROM drafts WHERE id = ?", id);
export function updateDraft(id: number, patch: { subject?: string; body?: string; status?: DraftStatus; error?: string | null; message_id?: string; sent_at?: string; scheduled_for?: string | null }) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  run(`UPDATE drafts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => patch[k] ?? null), id);
}
export const sentToday = () =>
  (one<{ n: number }>("SELECT COUNT(*) AS n FROM drafts WHERE status = 'sent' AND date(sent_at) = date('now')")?.n ?? 0);

export function followupCandidates(afterDays: number, maxFollowups: number) {
  return all(`SELECT d.id AS parent_draft_id, d.lead_id, d.contact_id, d.subject, d.body, d.sent_at, c.name AS contact_name, c.email, l.role, l.company
    FROM drafts d JOIN contacts c ON c.id = d.contact_id JOIN leads l ON l.id = d.lead_id
    WHERE d.kind = 'initial' AND d.status = 'sent' AND l.status NOT IN ('replied','interview','archived','rejected')
      AND julianday('now') - julianday(d.sent_at) >= ?
      AND (SELECT COUNT(*) FROM drafts f WHERE f.contact_id = d.contact_id AND f.kind = 'followup') < ?`, afterDays, maxFollowups);
}

// ---------- runs ----------
export const createRun = (stage: string) => Number(run("INSERT INTO runs (stage) VALUES (?)", stage).lastInsertRowid);
export const appendRunLog = (id: number, line: string) => run("UPDATE runs SET log = substr(log || ? || char(10), -200000) WHERE id = ?", line, id);
export const finishRun = (id: number, status: string, summary?: string, cost?: number) =>
  run("UPDATE runs SET status = ?, summary = ?, cost_usd = ?, finished_at = datetime('now') WHERE id = ?", status, summary ?? null, cost ?? null, id);
export const listRuns = () => all("SELECT id, stage, status, summary, cost_usd, started_at, finished_at FROM runs ORDER BY id DESC LIMIT 50");
export const getRun = (id: number) => one("SELECT * FROM runs WHERE id = ?", id);

export function stats() {
  const q = (sql: string) => (one<{ n: number }>(sql)?.n ?? 0);
  return {
    leads: q("SELECT COUNT(*) AS n FROM leads WHERE status != 'rejected'"),
    enriched: q("SELECT COUNT(DISTINCT lead_id) AS n FROM contacts WHERE email IS NOT NULL"),
    pending: q("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'"),
    sent: q("SELECT COUNT(*) AS n FROM drafts WHERE status = 'sent'"),
    sent_today: sentToday(),
    replied: q("SELECT COUNT(*) AS n FROM leads WHERE status IN ('replied','interview')"),
    interviews: q("SELECT COUNT(*) AS n FROM leads WHERE status = 'interview'"),
  };
}

/** Drafts the human edited before sending: the best possible style signal for the writer agent. */
export const styleExamples = (n = 3) =>
  all(`SELECT subject, original_body, body FROM drafts WHERE status = 'sent' AND original_body IS NOT NULL AND original_body != body ORDER BY sent_at DESC LIMIT ?`, n);
export const recentSentExamples = (n = 2) =>
  all(`SELECT subject, body FROM drafts WHERE status = 'sent' AND kind = 'initial' ORDER BY sent_at DESC LIMIT ?`, n);
