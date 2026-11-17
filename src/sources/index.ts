/**
 * Deterministic job sources. These do the cheap, high-volume work (fetch + keyword/remote prefilter + dedupe)
 * so the LLM agents only spend tokens on judging candidates that are plausibly relevant.
 *
 * Social posts on LinkedIn / X are NOT fetched here: those platforms block scraping, so the scout agent finds
 * them through web search (and optionally an Apify actor, see apify.ts).
 */
import { XMLParser } from "fast-xml-parser";
import { getJson, getText, htmlToText, mapLimit } from "../lib/http.js";
import type { Config } from "../lib/config.js";

export interface Candidate {
  source: string;
  url: string;
  title: string;
  company?: string;
  author?: string;
  author_url?: string;
  posted_at?: string;
  location?: string;
  text: string;
  apply_url?: string;
  company_url?: string;
  salary?: string;
}

export type SourceName = "hn" | "reddit" | "remoteok" | "remotive" | "weworkremotely" | "himalayas" | "jobicy" | "ats";
export const SOURCE_NAMES: SourceName[] = ["hn", "reddit", "remoteok", "remotive", "weworkremotely", "himalayas", "jobicy", "ats"];

const daysAgo = (d: number) => Date.now() - d * 86400_000;
/** Repair UTF-8 text that was decoded as Latin-1 upstream ("Ã©", "â€”"). */
const fixText = (s: string) => (/[ÃâÂ][\x80-\xBF]/.test(s) ? Buffer.from(s, "latin1").toString("utf8") : s);
const toIso = (v: string | number | undefined) => {
  if (v == null || v === "") return undefined;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return isNaN(+d) ? undefined : d.toISOString();
};

// ---------------- Hacker News "Who is hiring?" ----------------
async function hn(cfg: Config): Promise<Candidate[]> {
  const search = await getJson<any>("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6");
  const threads = (search.hits as any[]).filter((h) => /who is hiring/i.test(h.title)).slice(0, 1);
  const out: Candidate[] = [];
  for (const t of threads) {
    const item = await getJson<any>(`https://hn.algolia.com/api/v1/items/${t.objectID}`);
    for (const c of item.children ?? []) {
      if (!c.text || !c.author) continue;
      const text = htmlToText(c.text);
      const firstLine = text.split("\n")[0].slice(0, 200);
      out.push({
        source: "hn",
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        title: firstLine,
        company: firstLine.split("|")[0]?.trim(),
        author: c.author,
        posted_at: toIso(c.created_at),
        text,
      });
    }
  }
  return out;
}

// ---------------- Reddit ----------------
const DEFAULT_SUBS = ["forhire", "remotejs", "RemoteJobs", "hiring", "jobbit", "DeveloperJobs", "reactjs", "webdev", "startups", "cscareerquestions"];
async function reddit(cfg: Config): Promise<Candidate[]> {
  if (!cfg.sources.reddit.enabled) return [];
  const subs = cfg.sources.reddit.subreddits.length ? cfg.sources.reddit.subreddits : DEFAULT_SUBS;
  const lists = await mapLimit(subs, 3, async (sub) => {
    try {
      const data = await getJson<any>(`https://www.reddit.com/r/${sub}/new.json?limit=100&raw_json=1`, { browser: true });
      return (data.data?.children ?? []).map((ch: any) => ch.data) as any[];
    } catch {
      // Reddit sometimes blocks JSON for anonymous clients; fall back to the Atom feed.
      try {
        const xml = await getText(`https://www.reddit.com/r/${sub}/new/.rss?limit=100`, { browser: true });
        const feed = new XMLParser({ ignoreAttributes: false }).parse(xml);
        const entries = [].concat(feed.feed?.entry ?? []);
        return entries.map((e: any) => ({
          title: e.title, permalink: new URL(e.link?.["@_href"] ?? "").pathname, author: e.author?.name?.replace(/^\/u\//, ""),
          created_utc: Date.parse(e.updated) / 1000, selftext: htmlToText(e.content?.["#text"] ?? ""), subreddit: sub,
        }));
      } catch { return []; }
    }
  });
  const out: Candidate[] = [];
  for (const p of lists.flat()) {
    const title: string = p.title ?? "";
    const isHiring = /\[hiring\]|\bhiring\b|we('| a)re looking|looking for (a|an) |job opening|join (our|my) team|\bopening\b/i.test(title + " " + (p.link_flair_text ?? ""));
    if (!isHiring || /\[for hire\]/i.test(title)) continue;
    out.push({
      source: "reddit",
      url: `https://www.reddit.com${p.permalink}`,
      title,
      author: p.author,
      posted_at: toIso(p.created_utc),
      text: `${title}\n${p.selftext ?? ""}`.slice(0, 5000),
    });
  }
  return out;
}

// ---------------- RemoteOK ----------------
async function remoteok(): Promise<Candidate[]> {
  const data = await getJson<any[]>("https://remoteok.com/api", { browser: true });
  return data.filter((j) => j.id && j.position).map((j) => ({
    source: "remoteok",
    url: j.url ?? `https://remoteok.com/remote-jobs/${j.id}`,
    title: fixText(j.position),
    company: fixText(j.company ?? ""),
    posted_at: toIso(j.epoch ?? j.date),
    location: j.location || "Remote",
    text: `${j.position} at ${j.company}\nTags: ${(j.tags ?? []).join(", ")}\n${htmlToText(j.description ?? "")}`.slice(0, 4000),
    apply_url: j.apply_url,
    salary: j.salary_min ? `${j.salary_min}-${j.salary_max} USD` : undefined,
  }));
}

// ---------------- Remotive ----------------
async function remotive(cfg: Config): Promise<Candidate[]> {
  const terms = [...new Set([...cfg.targets.keywords.slice(0, 4), ...cfg.targets.roles.slice(0, 2)])];
  const lists = await mapLimit(terms.length ? terms : ["software"], 2, async (term) => {
    try {
      const data = await getJson<any>(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(term)}&limit=60`);
      return data.jobs ?? [];
    } catch { return []; }
  });
  return lists.flat().map((j: any) => ({
    source: "remotive",
    url: j.url,
    title: j.title,
    company: j.company_name,
    posted_at: toIso(j.publication_date),
    location: j.candidate_required_location,
    text: `${j.title} at ${j.company_name}\nRequired location: ${j.candidate_required_location}\n${htmlToText(j.description ?? "")}`.slice(0, 4000),
    salary: j.salary || undefined,
  }));
}

// ---------------- We Work Remotely (RSS) ----------------
const WWR_FEEDS = [
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
];
async function weworkremotely(): Promise<Candidate[]> {
  const parser = new XMLParser();
  const lists = await mapLimit(WWR_FEEDS, 2, async (feed) => {
    try {
      const rss = parser.parse(await getText(feed, { browser: true }));
      return [].concat(rss.rss?.channel?.item ?? []);
    } catch { return []; }
  });
  return lists.flat().map((i: any) => {
    const [company, ...rest] = String(i.title).split(":");
    return {
      source: "weworkremotely",
      url: i.link,
      title: rest.join(":").trim() || i.title,
      company: company?.trim(),
      posted_at: toIso(i.pubDate),
      location: i.region,
      text: `${i.title}\nRegion: ${i.region ?? ""}\n${htmlToText(i.description ?? "")}`.slice(0, 4000),
    };
  });
}

// ---------------- Himalayas ----------------
async function himalayas(cfg: Config): Promise<Candidate[]> {
  const terms = [...new Set([...cfg.targets.roles.slice(0, 3), ...cfg.targets.keywords.slice(0, 2)])];
  const reqs = terms.flatMap((t) => [1, 2].map((page) => `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(t)}&page=${page}`));
  const pages = await mapLimit(reqs, 3, async (url) => {
    try { return (await getJson<any>(url)).jobs ?? []; } catch { return []; }
  });
  return pages.flat().map((j: any) => ({
    source: "himalayas",
    url: j.applicationLink || j.guid,
    title: j.title,
    company: j.companyName,
    posted_at: toIso(j.pubDate),
    location: (j.locationRestrictions ?? []).join(", ") || "Worldwide",
    text: `${j.title} at ${j.companyName}\nLocation restrictions: ${(j.locationRestrictions ?? []).join(", ") || "none"}\nSeniority: ${(j.seniority ?? []).join(", ")}\n${htmlToText(j.excerpt ?? j.description ?? "")}`.slice(0, 4000),
    salary: j.minSalary ? `${j.minSalary}-${j.maxSalary} ${j.currency ?? ""}` : undefined,
  }));
}

// ---------------- Jobicy ----------------
async function jobicy(cfg: Config): Promise<Candidate[]> {
  const tags = cfg.targets.keywords.slice(0, 3);
  const lists = await mapLimit(tags.length ? tags : [""], 2, async (tag) => {
    try { return (await getJson<any>(`https://jobicy.com/api/v2/remote-jobs?count=50${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`)).jobs ?? []; } catch { return []; }
  });
  return lists.flat().map((j: any) => ({
    source: "jobicy",
    url: j.url,
    title: j.jobTitle,
    company: j.companyName,
    posted_at: toIso(j.pubDate),
    location: j.jobGeo,
    text: `${j.jobTitle} at ${j.companyName}\nGeo: ${j.jobGeo}\nLevel: ${j.jobLevel}\n${htmlToText(j.jobExcerpt ?? "")}`.slice(0, 3000),
  }));
}

// ---------------- ATS watchlist (Greenhouse / Lever / Ashby public boards) ----------------
async function ats(cfg: Config): Promise<Candidate[]> {
  const lists = await mapLimit(cfg.sources.ats_watchlist, 3, async (w) => {
    try {
      if (w.ats === "greenhouse") {
        const d = await getJson<any>(`https://boards-api.greenhouse.io/v1/boards/${w.slug}/jobs?content=true`);
        return (d.jobs ?? []).map((j: any) => ({ source: "ats", url: j.absolute_url, title: j.title, company: w.company ?? w.slug, posted_at: toIso(j.updated_at), location: j.location?.name, text: `${j.title}\nLocation: ${j.location?.name}\n${htmlToText(htmlToText(j.content ?? ""))}`.slice(0, 4000) }));
      }
      if (w.ats === "lever") {
        const d = await getJson<any[]>(`https://api.lever.co/v0/postings/${w.slug}?mode=json`);
        return d.map((j) => ({ source: "ats", url: j.hostedUrl, title: j.text, company: w.company ?? w.slug, posted_at: toIso(j.createdAt), location: `${j.categories?.location ?? ""} ${j.workplaceType ?? ""}`.trim(), text: `${j.text}\nLocation: ${j.categories?.location} (${j.workplaceType ?? ""})\n${j.descriptionPlain ?? ""}`.slice(0, 4000), apply_url: j.applyUrl }));
      }
      const d = await getJson<any>(`https://api.ashbyhq.com/posting-api/job-board/${w.slug}`);
      return (d.jobs ?? []).map((j: any) => ({ source: "ats", url: j.jobUrl, title: j.title, company: w.company ?? w.slug, posted_at: toIso(j.publishedAt), location: `${j.location ?? ""}${j.isRemote ? " (remote)" : ""}`, text: `${j.title}\nLocation: ${j.location} remote=${j.isRemote} workplace=${j.workplaceType ?? ""}\n${j.descriptionPlain ?? ""}`.slice(0, 4000), apply_url: j.applyUrl }));
    } catch { return []; }
  });
  return lists.flat() as Candidate[];
}

const FETCHERS: Record<SourceName, (cfg: Config) => Promise<Candidate[]>> = {
  hn, reddit, remoteok: () => remoteok(), remotive, weworkremotely: () => weworkremotely(), himalayas, jobicy, ats,
};

export function enabledSources(cfg: Config): SourceName[] {
  const s = cfg.sources;
  return SOURCE_NAMES.filter((n) =>
    n === "reddit" ? s.reddit.enabled : n === "ats" ? s.ats_watchlist.length > 0 : (s as any)[n] !== false);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Keyword + remote/hybrid + recency prefilter. Intentionally lenient: the agent makes the final call. */
export function prefilter(items: Candidate[], cfg: Config, opts: { keywords?: string[]; maxAgeDays?: number } = {}): Candidate[] {
  const kws = (opts.keywords?.length ? opts.keywords : [...cfg.targets.roles, ...cfg.targets.keywords]).map((k) => k.toLowerCase());
  const kwRe = new RegExp(`(^|[^a-z])(${[...new Set(kws)].map(esc).join("|")})`, "i");
  // The title (or HN/Reddit first line) must look like the target discipline; derive the vocabulary from target roles.
  const roleVocab = new Set(["engineer", "engineering", "developer", "programmer", "swe", "sde", "architect", "cto", "tech lead", "full[- ]?stack", "front[- ]?end", "back[- ]?end"]);
  for (const r of cfg.targets.roles) for (const w of r.toLowerCase().split(/\s+/)) if (w.length > 3 && !/^(senior|junior|lead|staff|principal|full|stack)$/.test(w)) roleVocab.add(esc(w));
  const titleRe = new RegExp(`\\b(${[...roleVocab].join("|")})`, "i");
  const excl = cfg.targets.exclude_keywords.length ? new RegExp(`\\b(${cfg.targets.exclude_keywords.map(esc).join("|")})\\b`, "i") : null;
  const modes = cfg.location.work_modes;
  const wantsOnsite = modes.includes("onsite");
  const cityRe = cfg.location.hybrid_cities.length ? new RegExp(cfg.location.hybrid_cities.map(esc).join("|"), "i") : null;
  const cutoff = daysAgo(opts.maxAgeDays ?? cfg.sources.max_age_days);
  const remoteBoards = new Set(["remoteok", "remotive", "weworkremotely", "himalayas", "jobicy"]);
  return items.filter((c) => {
    const blob = `${c.title}\n${c.location ?? ""}\n${c.text}`;
    if (c.posted_at && Date.parse(c.posted_at) < cutoff) return false;
    if (!titleRe.test(c.title) || !kwRe.test(blob)) return false;
    if (excl?.test(blob)) return false;
    if (wantsOnsite || remoteBoards.has(c.source)) return true;
    const remote = /\bremote\b|work from home|\bwfh\b|anywhere|distributed/i.test(blob);
    const hybrid = /\bhybrid\b/i.test(blob) && (!cityRe || cityRe.test(blob));
    return (modes.includes("remote") && remote) || (modes.includes("hybrid") && (hybrid || (!!cityRe && cityRe.test(blob))));
  });
}

export async function fetchSource(name: SourceName, cfg: Config): Promise<Candidate[]> {
  return FETCHERS[name](cfg);
}
