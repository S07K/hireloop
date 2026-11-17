/**
 * Optional: run an Apify actor (e.g. a LinkedIn-posts or X-search scraper) for social posts.
 * The actor id and its input are user-configured because each actor has its own input schema.
 * Any string value in the input containing {{query}} is replaced by the search query.
 */
import { env, type Config } from "../lib/config.js";
import { getJson } from "../lib/http.js";
import type { Candidate } from "./index.js";

const fill = (v: unknown, query: string): unknown =>
  typeof v === "string" ? v.replaceAll("{{query}}", query)
  : Array.isArray(v) ? v.map((x) => fill(x, query))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, query)]))
  : v;

const pick = (o: any, keys: string[]): string | undefined => {
  for (const k of keys) {
    const val = k.split(".").reduce((a, p) => (a == null ? a : a[p]), o);
    if (typeof val === "string" && val.trim()) return val;
  }
  return undefined;
};

export async function runApify(platform: "linkedin" | "x", query: string, cfg: Config, maxItems = 50): Promise<Candidate[]> {
  const token = env("APIFY_TOKEN");
  const actor = platform === "linkedin" ? cfg.sources.apify.linkedin_actor : cfg.sources.apify.x_actor;
  if (!token || !actor) throw new Error(`Apify not configured: set APIFY_TOKEN in .env and sources.apify.${platform}_actor in hireloop.config.json`);
  const input = fill(platform === "linkedin" ? cfg.sources.apify.linkedin_input : cfg.sources.apify.x_input, query);
  const url = `https://api.apify.com/v2/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items?token=${token}&maxItems=${maxItems}&timeout=240`;
  const items = await getJson<any[]>(url, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" }, timeoutMs: 260_000 });
  return items.map((it) => {
    const body = pick(it, ["text", "content", "postText", "full_text", "fullText", "commentary"]) ?? JSON.stringify(it).slice(0, 2000);
    const handle = pick(it, ["author.userName", "author.publicIdentifier", "author.username"]);
    const bio = pick(it, ["author.description", "author.headline", "author.info", "author.position", "authorHeadline", "author.occupation"]);
    const followers = it?.author?.followers ?? it?.author?.followersCount;
    const authorName = pick(it, ["author.name", "authorName", "author.fullName", "user.name", "authorFullName"]);
    const header = `Author: ${authorName ?? "?"}${handle ? ` (@${handle})` : ""}${bio ? ` - ${bio}` : ""}${followers != null ? ` [${followers} followers]` : ""}`;
    const text = `${header}\n---\n${body}`;
    return {
      source: platform,
      url: pick(it, ["url", "postUrl", "linkedinUrl", "twitterUrl", "link"]) ?? "",
      title: body.split("\n")[0].slice(0, 160),
      author: authorName ?? handle,
      posted_at: pick(it, ["postedAt", "postedAtISO", "createdAt", "created_at", "date", "postedAt.date"]),
      text: text.slice(0, 4000),
      author_url: pick(it, ["author.linkedinUrl", "authorProfileUrl", "author.url", "user.url"]),
    } satisfies Candidate;
  }).filter((c) => c.url);
}
