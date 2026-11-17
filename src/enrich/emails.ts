/**
 * Email discovery + verification toolbox. Ordered from free/high-signal to paid:
 *   1. emails written in the post itself (agent extracts these)
 *   2. company website crawl (/, /about, /team, /contact, /careers, /jobs, /imprint)
 *   3. GitHub commit metadata for founders/engineers with public repos
 *   4. Hunter / Apollo / Snov-style providers (if API keys are configured)
 *   5. pattern permutation + verification (MX + verifier API)
 */
import dns from "node:dns/promises";
import { env } from "../lib/config.js";
import { getJson, http, htmlToText, mapLimit } from "../lib/http.js";

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK = /(example|sentry|wixpress|domain\.com|email\.com|\.png|\.jpg|\.webp|\.svg|u003e|noreply|no-reply|donotreply|privacy|abuse|unsubscribe)/i;

export interface FoundEmail { email: string; source: string; confidence: number; name?: string; title?: string; linkedin?: string; verification?: string }

// ---------------------------------------------------------------- website
export async function scrapeCompanySite(domain: string): Promise<{ emails: FoundEmail[]; pages: { url: string; text: string }[] }> {
  const base = `https://${domain}`;
  const paths = ["", "/about", "/about-us", "/team", "/company", "/contact", "/careers", "/jobs", "/imprint", "/impressum"];
  const pages: { url: string; text: string }[] = [];
  const emails = new Map<string, FoundEmail>();
  await mapLimit(paths, 4, async (p) => {
    try {
      const res = await http(base + p, { browser: true, timeoutMs: 12000 });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return;
      const html = await res.text();
      const decoded = html.replace(/&#64;|\[at\]|\(at\)/gi, "@").replace(/\[dot\]|\(dot\)/gi, ".");
      for (const m of decoded.match(EMAIL_RE) ?? []) {
        const e = m.toLowerCase().replace(/^mailto:/, "");
        if (JUNK.test(e)) continue;
        const sameDomain = e.endsWith("@" + domain) || e.split("@")[1]?.endsWith("." + domain);
        if (!emails.has(e)) emails.set(e, { email: e, source: `website:${p || "/"}`, confidence: sameDomain ? 80 : 40 });
      }
      if (p === "" || /about|team|company/.test(p)) pages.push({ url: base + p, text: htmlToText(html).slice(0, 2500) });
    } catch { /* ignore unreachable pages */ }
  });
  return { emails: [...emails.values()], pages };
}

// ---------------------------------------------------------------- GitHub
/** Pull a person's commit email from their recent public commits. Works for many technical founders. */
export async function githubEmail(username: string): Promise<FoundEmail[]> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  const tok = env("GITHUB_TOKEN");
  if (tok) headers.authorization = `Bearer ${tok}`;
  const out = new Map<string, FoundEmail>();
  const user = await getJson<any>(`https://api.github.com/users/${username}`, { headers }).catch(() => null);
  if (user?.email) out.set(user.email.toLowerCase(), { email: user.email.toLowerCase(), source: "github:profile", confidence: 90, name: user.name });
  const repos = await getJson<any[]>(`https://api.github.com/users/${username}/repos?sort=pushed&per_page=6&type=owner`, { headers }).catch(() => []);
  await mapLimit(repos.filter((r) => !r.fork).slice(0, 4), 2, async (r) => {
    const commits = await getJson<any[]>(`https://api.github.com/repos/${r.full_name}/commits?author=${username}&per_page=5`, { headers }).catch(() => []);
    for (const c of commits) {
      const e: string | undefined = c.commit?.author?.email?.toLowerCase();
      if (e && !/noreply|users\.noreply\.github\.com|localhost|\.local$/.test(e) && !out.has(e)) {
        const webmail = /@(gmail|googlemail|yahoo|outlook|hotmail|proton(mail)?|icloud|me)\./.test(e);
        out.set(e, { email: e, source: `github:commit:${r.name}`, confidence: webmail ? 60 : 75, name: c.commit?.author?.name });
      }
    }
  });
  return [...out.values()];
}

// ---------------------------------------------------------------- Hunter.io
export async function hunterDomainSearch(domain: string): Promise<{ pattern?: string; organization?: string; emails: FoundEmail[] }> {
  const key = env("HUNTER_API_KEY");
  if (!key) throw new Error("HUNTER_API_KEY not set");
  const d = await getJson<any>(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=25&api_key=${key}`);
  return {
    pattern: d.data?.pattern ?? undefined,
    organization: d.data?.organization ?? undefined,
    emails: (d.data?.emails ?? []).map((e: any) => ({
      email: e.value, source: "hunter:domain", confidence: e.confidence ?? 50,
      name: [e.first_name, e.last_name].filter(Boolean).join(" ") || undefined, title: e.position ?? undefined, linkedin: e.linkedin ?? undefined,
      verification: e.verification?.status ?? undefined,
    })),
  };
}
export async function hunterFind(domain: string, first: string, last: string): Promise<FoundEmail | null> {
  const key = env("HUNTER_API_KEY");
  if (!key) throw new Error("HUNTER_API_KEY not set");
  const d = await getJson<any>(`https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${key}`);
  return d.data?.email ? { email: d.data.email, source: "hunter:finder", confidence: d.data.score ?? 50, title: d.data.position ?? undefined, verification: d.data.verification?.status } : null;
}

// ---------------------------------------------------------------- Apollo.io
export async function apolloMatch(first: string, last: string, domain?: string, organization?: string, linkedin?: string): Promise<FoundEmail | null> {
  const key = env("APOLLO_API_KEY");
  if (!key) throw new Error("APOLLO_API_KEY not set");
  const res = await http("https://api.apollo.io/api/v1/people/match", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "cache-control": "no-cache" },
    body: JSON.stringify({ first_name: first, last_name: last, domain, organization_name: organization, linkedin_url: linkedin, reveal_personal_emails: false }),
  });
  if (!res.ok) throw new Error(`Apollo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const p = (await res.json() as any).person;
  if (!p?.email || /email_not_unlocked/.test(p.email)) return null;
  return { email: p.email.toLowerCase(), source: "apollo:match", confidence: p.email_status === "verified" ? 90 : 60, name: p.name, title: p.title, linkedin: p.linkedin_url, verification: p.email_status };
}

// ---------------------------------------------------------------- patterns
const PATTERNS = ["{first}", "{first}.{last}", "{first}{last}", "{f}{last}", "{first}{l}", "{f}.{last}", "{last}", "{first}_{last}", "{last}.{first}"] as const;
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

export function permutations(fullName: string, domain: string, pattern?: string): string[] {
  const parts = fullName.trim().split(/\s+/).map(slug).filter(Boolean);
  if (!parts.length) return [];
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const fill = (p: string) => p.replaceAll("{first}", first).replaceAll("{last}", last).replaceAll("{f}", first[0]).replaceAll("{l}", last[0] ?? "");
  const list = (pattern ? [pattern, ...PATTERNS] : [...PATTERNS])
    .filter((p) => last || !p.includes("{l"))
    .map((p) => `${fill(p)}@${domain}`);
  return [...new Set(list)];
}

/** Infer a company's pattern from known (name, email) pairs. */
export function inferPattern(known: { name?: string; email: string }[]): string | undefined {
  const score = new Map<string, number>();
  for (const k of known) {
    if (!k.name) continue;
    const [local, domain] = k.email.split("@");
    for (const p of PATTERNS) {
      if (domain && fillOne(p, k.name) === local) score.set(p, (score.get(p) ?? 0) + 1);
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
function fillOne(p: string, fullName: string) {
  const parts = fullName.trim().split(/\s+/).map(slug).filter(Boolean);
  const first = parts[0] ?? "", last = parts.length > 1 ? parts[parts.length - 1] : "";
  return p.replaceAll("{first}", first).replaceAll("{last}", last).replaceAll("{f}", first[0] ?? "").replaceAll("{l}", last[0] ?? "");
}

// ---------------------------------------------------------------- verification
export async function hasMx(domain: string): Promise<boolean> {
  try { return (await dns.resolveMx(domain)).length > 0; } catch { return false; }
}

export type Verdict = "valid" | "invalid" | "catch_all" | "risky" | "unknown";

export function verifierAvailable(): string | null {
  if (env("MILLIONVERIFIER_API_KEY")) return "millionverifier";
  if (env("ZEROBOUNCE_API_KEY")) return "zerobounce";
  if (env("HUNTER_API_KEY")) return "hunter";
  if (env("VERIFALIA_USERNAME") && env("VERIFALIA_PASSWORD")) return "verifalia";
  return null;
}

export async function verifyEmail(email: string): Promise<{ verdict: Verdict; provider: string; detail?: string }> {
  const domain = email.split("@")[1];
  if (!domain || !(await hasMx(domain))) return { verdict: "invalid", provider: "mx", detail: "domain has no MX records" };
  const provider = verifierAvailable();
  try {
    if (provider === "millionverifier") {
      const d = await getJson<any>(`https://api.millionverifier.com/api/v3/?api=${env("MILLIONVERIFIER_API_KEY")}&email=${encodeURIComponent(email)}&timeout=20`);
      const map: Record<string, Verdict> = { ok: "valid", catch_all: "catch_all", invalid: "invalid", disposable: "invalid", unknown: "unknown" };
      return { verdict: map[d.result] ?? "unknown", provider, detail: d.subresult };
    }
    if (provider === "zerobounce") {
      const d = await getJson<any>(`https://api.zerobounce.net/v2/validate?api_key=${env("ZEROBOUNCE_API_KEY")}&email=${encodeURIComponent(email)}`);
      const map: Record<string, Verdict> = { valid: "valid", invalid: "invalid", "catch-all": "catch_all", spamtrap: "invalid", abuse: "risky", do_not_mail: "invalid", unknown: "unknown" };
      return { verdict: map[d.status] ?? "unknown", provider, detail: d.sub_status };
    }
    if (provider === "hunter") {
      const d = await getJson<any>(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${env("HUNTER_API_KEY")}`);
      const s = d.data?.status;
      const map: Record<string, Verdict> = { valid: "valid", invalid: "invalid", accept_all: "catch_all", webmail: "valid", disposable: "invalid", unknown: "unknown" };
      return { verdict: map[s] ?? "unknown", provider, detail: `score ${d.data?.score}` };
    }
    if (provider === "verifalia") {
      const auth = "Basic " + Buffer.from(`${env("VERIFALIA_USERNAME")}:${env("VERIFALIA_PASSWORD")}`).toString("base64");
      const res = await http("https://api.verifalia.com/v2.4/email-validations?waitTime=30000", {
        method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ entries: [{ inputData: email }], quality: "Standard" }), timeoutMs: 40000,
      });
      if (!res.ok) return { verdict: "unknown", provider, detail: `Verifalia HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
      const d: any = await res.json();
      const entry = d.entries?.data?.[0];
      if (!entry) return { verdict: "unknown", provider, detail: `job ${d.overview?.status ?? res.status}` };
      const c = entry.classification as string;
      const verdict: Verdict = c === "Deliverable" ? "valid" : c === "Undeliverable" ? "invalid" : /CatchAll/i.test(entry.status) ? "catch_all" : c === "Risky" ? "risky" : "unknown";
      return { verdict, provider, detail: entry.status };
    }
  } catch (e) {
    return { verdict: "unknown", provider: provider ?? "none", detail: (e as Error).message.slice(0, 200) };
  }
  return { verdict: "unknown", provider: "mx-only", detail: "MX ok; no verifier API key configured" };
}

/** Try pattern permutations until one verifies. Stops early; spends at most `budget` verifier calls. */
export async function guessAndVerify(fullName: string, domain: string, pattern?: string, budget = 4): Promise<FoundEmail | null> {
  const candidates = permutations(fullName, domain, pattern);
  if (!candidates.length || !(await hasMx(domain))) return null;
  if (!verifierAvailable()) {
    return { email: candidates[0], source: pattern ? "pattern:known" : "pattern:guess", confidence: pattern ? 55 : 30, verification: "unknown" };
  }
  let allUnknown = true;
  for (const email of candidates.slice(0, budget)) {
    const v = await verifyEmail(email);
    if (v.verdict !== "unknown") allUnknown = false;
    if (v.verdict === "valid") return { email, source: "pattern+verified", confidence: 90, verification: "valid" };
    if (v.verdict === "catch_all") {
      // Catch-all domains accept everything: fall back to the most likely pattern.
      return { email: candidates[0], source: "pattern:catch_all", confidence: pattern ? 60 : 45, verification: "catch_all" };
    }
  }
  // Verifier unreachable / inconclusive for every attempt: return the likeliest pattern, clearly marked unverified.
  if (allUnknown) return { email: candidates[0], source: pattern ? "pattern:known" : "pattern:guess", confidence: pattern ? 55 : 30, verification: "unknown" };
  return null;
}
