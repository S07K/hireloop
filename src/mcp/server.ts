#!/usr/bin/env node
/**
 * hireloop MCP server: the agents' hands. Exposes the pipeline database, job sources and email tooling
 * as MCP tools so Claude Code subagents can use them. Deliberately has NO "send email" tool:
 * sending only happens from the dashboard after a human approves a draft.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { env, loadConfig, loadProfile } from "../lib/config.js";
import * as db from "../lib/db.js";
import { enabledSources, fetchSource, prefilter, SOURCE_NAMES, type SourceName } from "../sources/index.js";
import { runApify } from "../sources/apify.js";
import * as em from "../enrich/emails.js";
import { buildScoutPlan } from "./queries.js";

/** Candidates returned to the agent this session, keyed by normalized URL, so save_leads can back-fill fields the agent omits. */
const seenCandidates = new Map<string, import("../sources/index.js").Candidate>();
const remember = (cs: import("../sources/index.js").Candidate[]) => { for (const c of cs) seenCandidates.set(db.normalizeUrl(c.url), c); };
const PROFILE_URL: Record<string, (a: string) => string> = {
  hn: (a) => `https://news.ycombinator.com/user?id=${a}`,
  reddit: (a) => `https://www.reddit.com/user/${a}`,
};

const server = new McpServer({ name: "hireloop", version: "0.1.0" });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] });
const safe = <A,>(fn: (a: A) => Promise<unknown> | unknown) => async (a: A) => { try { return ok(await fn(a)); } catch (e) { return fail(e); } };
const RO = { readOnlyHint: true, openWorldHint: true } as const;

// ======================================================================= brief
server.registerTool("get_search_brief", {
  description: "START HERE for the hunt stage. Returns the candidate's full profile (resume), targets, experience level, location/eligibility rules and the scout plan (one entry per parallel scout, with its route and queries). Pass `scout` to get only that scout's assignment.",
  inputSchema: { scout: z.string().optional().describe("Your scout name from the plan, e.g. 'x-founders'") },
  annotations: { readOnlyHint: true },
}, safe(({ scout }) => {
  const cfg = loadConfig(true);
  const plan = buildScoutPlan(cfg);
  const mine = scout ? plan.filter((p) => p.scout === scout) : plan;
  return {
    candidate: cfg.candidate,
    targets: cfg.targets,
    location: cfg.location,
    max_age_days: cfg.sources.max_age_days,
    leads_per_scout: Math.ceil(cfg.agents.max_leads_per_run / Math.max(1, plan.length)),
    scout_plan: mine.length ? mine : plan,
    profile: loadProfile(),
    pipeline: db.stats(),
  };
}));

// ======================================================================= hunt
server.registerTool("fetch_job_source", {
  description: "Fetch fresh posts from a structured source (HN Who-is-hiring, Reddit, RemoteOK, Remotive, WeWorkRemotely, Himalayas, Jobicy, ATS watchlist). Already-seen URLs are removed and a lenient keyword/remote/recency prefilter is applied. Returns compact candidates for you to judge.",
  inputSchema: {
    source: z.enum(SOURCE_NAMES as [SourceName, ...SourceName[]]),
    keywords: z.array(z.string()).optional().describe("Override keywords for the prefilter (defaults to config roles+keywords)"),
    limit: z.number().int().min(1).max(80).default(40),
    offset: z.number().int().min(0).default(0).describe("Paginate through prefiltered results"),
  },
  annotations: RO,
}, safe(async ({ source, keywords, limit, offset }) => {
  const cfg = loadConfig();
  const raw = await fetchSource(source, cfg);
  const filtered = prefilter(raw, cfg, { keywords });
  const unseen = db.filterUnseen(filtered.map((c) => c.url));
  const fresh = filtered.filter((c) => unseen.has(c.url));
  const page = fresh.slice(offset, offset + limit);
  remember(page);
  return {
    source, fetched: raw.length, after_prefilter: filtered.length, unseen: fresh.length, returned: page.length,
    next_offset: offset + limit < fresh.length ? offset + limit : null,
    candidates: page.map((c) => ({ ...c, text: c.text.slice(0, 1400) })),
  };
}));

server.registerTool("search_social_apify", {
  description: "Optional: search LinkedIn or X posts through the user's configured Apify actor (only if get_search_brief shows apify enabled). Returns unseen posts.",
  inputSchema: { platform: z.enum(["linkedin", "x"]), query: z.string(), max_items: z.number().int().min(5).max(100).default(40) },
  annotations: RO,
}, safe(async ({ platform, query, max_items }) => {
  const items = await runApify(platform, query, loadConfig(), max_items);
  const unseen = db.filterUnseen(items.map((i) => i.url));
  remember(items);
  return items.filter((i) => unseen.has(i.url)).map((i) => ({ ...i, text: i.text.slice(0, 1400) }));
}));

server.registerTool("filter_unseen_urls", {
  description: "Given post URLs (e.g. from web search results), return only those not already evaluated in earlier runs. Call this BEFORE fetching/reading web results to avoid repeat work.",
  inputSchema: { urls: z.array(z.string()).max(200) },
  annotations: { readOnlyHint: true },
}, safe(({ urls }) => [...db.filterUnseen(urls)]));

const LeadSchema = z.object({
  source: z.string().describe("linkedin | x | reddit | hn | remoteok | remotive | weworkremotely | himalayas | jobicy | ats | web"),
  source_url: z.string().describe("Canonical URL of the post/listing"),
  role: z.string(),
  company: z.string().nullish(),
  company_domain: z.string().nullish().describe("e.g. acme.com - critical for email finding; resolve it if you can"),
  company_url: z.string().nullish(),
  company_size: z.string().nullish().describe("e.g. '1-10', '11-50', '51-200', '200+'"),
  company_region: z.string().nullish().describe("Where the company is headquartered: 'US', 'India', 'EU', 'UK', 'Canada', ... (founder bios, 'SF'/'NYC', YC batch, .com site footer). Drives location priority ranking."),
  poster_name: z.string().nullish().describe("Person who wrote the post (often founder/hiring manager)"),
  poster_title: z.string().nullish(),
  poster_url: z.string().nullish().describe("LinkedIn/X/GitHub/HN profile URL of the poster"),
  post_text: z.string().nullish().describe("The post text (verbatim, can be trimmed)"),
  posted_at: z.string().nullish(),
  work_mode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  location: z.string().nullish().describe("Office city/country or 'Remote'"),
  eligible_regions: z.string().nullish().describe("Where hires may live, e.g. 'Worldwide', 'US only', 'EU', 'India', 'APAC', 'UTC±3'"),
  eligible_for_me: z.boolean().nullish().describe("Can the candidate (per their location/work authorization) actually be hired? false if region-locked elsewhere"),
  salary: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  fit_score: z.number().int().min(0).max(100),
  fit_reason: z.string().describe("One or two sentences: why this matches (or not)"),
  apply_url: z.string().nullish(),
});

server.registerTool("save_leads", {
  description: "Save qualified hiring posts as leads (batch). Posts with fit_score below the configured minimum or eligible_for_me=false are recorded as seen but not added. Duplicates are ignored.",
  inputSchema: { leads: z.array(LeadSchema).min(1).max(50) },
  annotations: { destructiveHint: false },
}, safe(({ leads }) => {
  const cfg = loadConfig();
  const res = { created: [] as number[], duplicates: 0, below_threshold: 0 };
  for (const l of leads) {
    if (l.fit_score < cfg.targets.min_fit_score || l.eligible_for_me === false) {
      db.markSeen(l.source_url, `low_fit:${l.fit_score}`);
      res.below_threshold++;
      continue;
    }
    const src = seenCandidates.get(db.normalizeUrl(l.source_url));
    const authorIsPoster = src?.author && ["hn", "reddit", "linkedin", "x"].includes(src.source);
    const r = db.upsertLead({
      ...l,
      work_mode: l.work_mode === "unknown" ? null : l.work_mode,
      post_text: l.post_text || src?.text || null,
      posted_at: l.posted_at || src?.posted_at || null,
      apply_url: l.apply_url || src?.apply_url || null,
      salary: l.salary || src?.salary || null,
      company: l.company || src?.company || null,
      poster_name: l.poster_name || (authorIsPoster ? src!.author! : null),
      poster_url: l.poster_url || src?.author_url || (authorIsPoster && PROFILE_URL[src!.source] ? PROFILE_URL[src!.source](src!.author!) : null),
    });
    r.created ? res.created.push(r.id) : res.duplicates++;
  }
  return res;
}));

server.registerTool("mark_rejected", {
  description: "Record post URLs you judged NOT relevant (not hiring, wrong role, onsite-only, region-locked, spam, job seeker post) so future runs skip them.",
  inputSchema: { items: z.array(z.object({ url: z.string(), reason: z.string() })).max(200) },
}, safe(({ items }) => { for (const i of items) db.markSeen(i.url, `rejected:${i.reason.slice(0, 80)}`); return { recorded: items.length }; }));

// ======================================================================= leads
server.registerTool("list_leads", {
  description: "List leads, ranked by the user's location priority tier (1 = most preferred) then fit score. Process them in this order. Use needs='contacts' to get leads without any email contact yet (enrich stage) or needs='drafts' for leads with contacts but no draft (draft stage).",
  inputSchema: {
    status: z.array(z.string()).optional(),
    needs: z.enum(["contacts", "drafts"]).optional(),
    min_score: z.number().optional(),
    limit: z.number().int().max(100).default(25),
  },
  annotations: { readOnlyHint: true },
}, safe(({ status, needs, min_score, limit }) => {
  let rows = db.listLeads({ status: status ?? ["qualified", "enriched", "drafted"], min_score, limit: 500 }) as any[];
  if (needs === "contacts") rows = rows.filter((r) => r.contact_count === 0 && !String(r.notes ?? "").includes("[no-contact-found]"));
  if (needs === "drafts") {
    const drafted = new Set((db.listDrafts() as any[]).map((d) => d.contact_id));
    rows = rows.filter((r) => r.contact_count > 0 && (db.listContacts(r.id) as any[]).some((c) => c.email && !drafted.has(c.id)));
  }
  return rows.slice(0, limit).map((r) => ({
    id: r.id, role: r.role, company: r.company, company_domain: r.company_domain, poster_name: r.poster_name, poster_title: r.poster_title,
    poster_url: r.poster_url, source: r.source, source_url: r.source_url, work_mode: r.work_mode, location: r.location,
    fit_score: r.fit_score, location_tier: r.location_tier, location_label: r.location_label, status: r.status, contacts: r.contact_count,
  }));
}));

server.registerTool("get_lead", {
  description: "Full lead details including the original post text, contacts and drafts.",
  inputSchema: { lead_id: z.number().int() },
  annotations: { readOnlyHint: true },
}, safe(({ lead_id }) => {
  const lead = db.getLead(lead_id);
  if (!lead) throw new Error(`lead ${lead_id} not found`);
  return { lead, contacts: db.listContacts(lead_id), drafts: (db.listDrafts() as any[]).filter((d) => d.lead_id === lead_id) };
}));

server.registerTool("update_lead", {
  description: "Patch lead fields (e.g. company_domain once resolved, poster details, status, notes). Append '[no-contact-found]' to notes when enrichment exhausted all options.",
  inputSchema: {
    lead_id: z.number().int(),
    patch: z.object({
      company: z.string(), company_domain: z.string(), company_url: z.string(), company_size: z.string(), company_region: z.string(), poster_name: z.string(), poster_title: z.string(),
      poster_url: z.string(), status: z.enum(["qualified", "rejected", "enriched", "drafted", "archived"]), notes: z.string(), fit_score: z.number(), fit_reason: z.string(),
    }).partial(),
  },
}, safe(({ lead_id, patch }) => { db.updateLead(lead_id, patch); return db.getLead(lead_id); }));

// ======================================================================= enrich
server.registerTool("scrape_company_site", {
  description: "Crawl a company's website (home/about/team/contact/careers/imprint). Returns emails found on the site and short page texts (useful for founder names and personalization). Free.",
  inputSchema: { domain: z.string() },
  annotations: RO,
}, safe(({ domain }) => em.scrapeCompanySite(db.cleanDomain(domain))));

server.registerTool("github_emails", {
  description: "Find a person's email from their GitHub profile and public commit metadata. Great for technical founders/engineers. Pass the GitHub username.",
  inputSchema: { username: z.string() },
  annotations: RO,
}, safe(({ username }) => em.githubEmail(username.replace(/^@|https?:\/\/github\.com\//g, "").split("/")[0])));

server.registerTool("hunter_domain_search", {
  description: "Hunter.io: list known emails/people at a domain plus the company's email pattern (e.g. '{first}'). Requires HUNTER_API_KEY (free tier: 25 searches/month - use for high-fit leads).",
  inputSchema: { domain: z.string() },
  annotations: RO,
}, safe(({ domain }) => em.hunterDomainSearch(db.cleanDomain(domain))));

server.registerTool("find_person_email", {
  description: "Find a specific person's work email via configured providers (Apollo match, then Hunter email-finder), falling back to pattern permutation + verification. Returns the best result with confidence 0-100.",
  inputSchema: {
    full_name: z.string(), domain: z.string(), company: z.string().optional(), linkedin_url: z.string().optional(),
    known_pattern: z.string().optional().describe("Pattern from hunter_domain_search or inferred from site emails, e.g. '{first}.{last}'"),
  },
  annotations: RO,
}, safe(async ({ full_name, domain, company, linkedin_url, known_pattern }) => {
  const d = db.cleanDomain(domain);
  const [first, ...rest] = full_name.trim().split(/\s+/);
  const last = rest[rest.length - 1] ?? "";
  const tried: string[] = [];
  if (process.env.APOLLO_API_KEY && last) {
    try { const r = await em.apolloMatch(first, last, d, company, linkedin_url); if (r) return { best: r, tried: [...tried, "apollo"] }; } catch (e) { tried.push(`apollo failed: ${(e as Error).message.slice(0, 80)}`); }
    tried.push("apollo");
  }
  if (process.env.HUNTER_API_KEY && last) {
    try { const r = await em.hunterFind(d, first, last); if (r && r.confidence >= 50) return { best: r, tried: [...tried, "hunter"] }; } catch (e) { tried.push(`hunter failed: ${(e as Error).message.slice(0, 80)}`); }
    tried.push("hunter");
  }
  const guess = await em.guessAndVerify(full_name, d, known_pattern);
  tried.push("pattern");
  return { best: guess, tried, verifier: em.verifierAvailable() ?? "none (guesses are unverified)" };
}));

server.registerTool("infer_email_pattern", {
  description: "Infer a company's email pattern from known name+email pairs (e.g. from the website or Hunter).",
  inputSchema: { known: z.array(z.object({ name: z.string(), email: z.string() })) },
  annotations: { readOnlyHint: true },
}, safe(({ known }) => ({ pattern: em.inferPattern(known) ?? null })));

server.registerTool("verify_email", {
  description: "Verify deliverability of an email (MX check + configured verifier API). Verdict: valid | invalid | catch_all | risky | unknown.",
  inputSchema: { email: z.string() },
  annotations: RO,
}, safe(({ email }) => em.verifyEmail(email.toLowerCase())));

server.registerTool("save_contact", {
  description: "Save a person at the hiring company (with or without email). kind priority: founder > hiring_manager > poster > recruiter > hr > employee.",
  inputSchema: {
    lead_id: z.number().int(),
    name: z.string().nullish(),
    title: z.string().nullish(),
    kind: z.enum(["founder", "hiring_manager", "poster", "recruiter", "hr", "employee"]),
    email: z.string().nullish(),
    email_confidence: z.number().int().min(0).max(100).default(0),
    email_source: z.string().nullish().describe("e.g. post, website:/team, github:commit, hunter:domain, apollo:match, pattern+verified"),
    verification: z.enum(["valid", "invalid", "catch_all", "risky", "unknown"]).default("unknown"),
    linkedin_url: z.string().nullish(), x_url: z.string().nullish(), github_url: z.string().nullish(),
  },
}, safe((c) => {
  if (c.email && c.verification === "invalid") throw new Error("Refusing to save an email verified as invalid; try another candidate address.");
  const id = db.upsertContact(c);
  const lead = db.getLead(c.lead_id) as any;
  if (c.email && lead?.status === "qualified") db.updateLead(c.lead_id, { status: "enriched" });
  return { contact_id: id, already_contacted_elsewhere: c.email ? db.emailAlreadyContacted(c.email) : false };
}));

// ======================================================================= draft
server.registerTool("get_writing_context", {
  description: "Everything needed to write outreach for a lead: candidate profile, links, signature, the lead + post, contacts lacking drafts, and the user's own edits to past drafts (follow their style).",
  inputSchema: { lead_id: z.number().int() },
  annotations: { readOnlyHint: true },
}, safe(({ lead_id }) => {
  const cfg = loadConfig();
  const lead = db.getLead(lead_id);
  if (!lead) throw new Error(`lead ${lead_id} not found`);
  const drafted = new Set((db.listDrafts() as any[]).filter((d) => d.lead_id === lead_id).map((d) => d.contact_id));
  const contacts = (db.listContacts(lead_id) as any[]).filter((c) => c.email && !drafted.has(c.id) && c.verification !== "invalid")
    .map((c) => ({ ...c, already_contacted_elsewhere: db.emailAlreadyContacted(c.email) }))
    .slice(0, cfg.outreach.max_contacts_per_lead);
  return {
    profile: loadProfile(),
    candidate: cfg.candidate,
    links: cfg.outreach.links,
    signature: cfg.outreach.signature,
    resume_attached: cfg.outreach.attach_resume,
    lead,
    contacts_to_write: contacts,
    user_style_edits: db.styleExamples(3),
    recent_sent: db.recentSentExamples(2),
  };
}));

server.registerTool("save_draft", {
  description: "Save an email draft for human approval in the dashboard. It is NOT sent. Plain text body, no signature placeholders left unfilled.",
  inputSchema: {
    lead_id: z.number().int(), contact_id: z.number().int(),
    subject: z.string().min(3).max(120), body: z.string().min(40).max(2500),
    rationale: z.string().describe("1-2 lines for the reviewer: the hook you used and why this person"),
    kind: z.enum(["initial", "followup"]).default("initial"),
    parent_draft_id: z.number().int().optional(),
  },
}, safe((d) => {
  if (/\{\{|\[(your|name|company|role)[^\]]*\]/i.test(d.body + d.subject)) throw new Error("Draft still contains placeholders like [Name] or {{...}}; fill them in.");
  return { draft_id: db.createDraft(d), status: "pending_approval" };
}));

server.registerTool("list_followup_candidates", {
  description: "Sent initial emails with no reply recorded after the configured number of days and fewer than max follow-ups.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, safe(() => { const c = loadConfig().outreach; return db.followupCandidates(c.followup_after_days, c.max_followups); }));

server.registerTool("pipeline_stats", { description: "Counts across the pipeline.", inputSchema: {}, annotations: { readOnlyHint: true } }, safe(() => db.stats()));

await server.connect(new StdioServerTransport());
