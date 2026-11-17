import { env, type Config } from "../lib/config.js";
import { enabledSources } from "../sources/index.js";

/**
 * Search plan for the hunt stage. Founders and engineering managers post "we're hiring" on X/LinkedIn long before
 * (or instead of) a formal listing; those posts name a real person you can email, which is where replies come from.
 *
 * Returns one entry per scout so the orchestrator can fan out in parallel.
 */
export interface ScoutAssignment {
  scout: string;
  group: string;
  route: "apify" | "web_search" | "api";
  queries: string[];
  sources?: string[];
  note?: string;
}

const q = (s: string) => `"${s}"`;

export function buildScoutPlan(cfg: Config): ScoutAssignment[] {
  const roles = cfg.targets.roles.slice(0, 5);
  const kw = cfg.targets.keywords.slice(0, 4);
  const remote = cfg.location.work_modes.includes("remote");
  // Location priority drives query mix: US-remote searches if a US rule exists, hybrid searches per city rule (in order).
  const rules = cfg.location.priority;
  const usFirst = rules.some((r) => r.work_mode === "remote" && r.company_regions.some((x) => /^(us|usa|united states)$/i.test(x)));
  const hybridGroups = rules.filter((r) => r.work_mode === "hybrid" && r.cities.length).map((r) => r.cities.slice(0, 4));
  if (!hybridGroups.length && cfg.location.work_modes.includes("hybrid") && cfg.location.hybrid_cities.length) hybridGroups.push(cfg.location.hybrid_cities.slice(0, 4));
  const since = new Date(Date.now() - cfg.sources.max_age_days * 86400_000).toISOString().slice(0, 10);
  const apifyOn = !!env("APIFY_TOKEN");
  const plan: ScoutAssignment[] = [];

  // ---------------- LinkedIn (native LinkedIn search syntax for the Apify actor) ----------------
  if (cfg.sources.web_search.linkedin_posts) {
    const roleQ = roles.map((r) => `"hiring" AND ${q(r)}${remote ? ` AND "remote"` : ""}`);
    const founderQ = [
      `("founding engineer" OR "first engineer" OR "first hire") AND ("hiring" OR "looking for")${remote ? ` AND "remote"` : ""}`,
      `("we're hiring" OR "my team is hiring" OR "I'm hiring") AND (${kw.map(q).join(" OR ")})${remote ? ` AND "remote"` : ""}`,
      `"founder" AND "hiring" AND (${kw.slice(0, 3).map(q).join(" OR ")}) AND ("DM me" OR "send me" OR "email me")`,
      ...(usFirst ? [`("we're hiring" OR "hiring") AND "remote" AND ("San Francisco" OR "SF" OR "New York" OR "NYC" OR "YC" OR "Y Combinator") AND (${kw.slice(0, 3).map(q).join(" OR ")})`] : []),
      ...hybridGroups.map((cities) => `"hiring" AND (${roles.slice(0, 2).map(q).join(" OR ")}) AND "hybrid" AND (${cities.map(q).join(" OR ")})`),
    ];
    const webQ = roles.slice(0, 3).map((r) => `site:linkedin.com/posts ("hiring" OR "we're hiring") ${q(r)}${remote ? ` "remote"` : ""}`);
    const route = apifyOn && cfg.sources.apify.linkedin_actor ? "apify" : "web_search";
    plan.push(
      { scout: "linkedin-roles", group: "linkedin", route, queries: route === "apify" ? roleQ : webQ },
      { scout: "linkedin-founders", group: "linkedin", route, queries: route === "apify" ? founderQ : webQ.map((w) => w.replace('"hiring"', '"founder" "hiring"')) },
    );
  }

  // ---------------- X (Twitter advanced search syntax for the Apify actor) ----------------
  if (cfg.sources.web_search.x_posts) {
    // min_faves filters most job-bot spam; -filter:retweets avoids duplicates.
    const tail = ` -filter:retweets -filter:replies since:${since}`;
    const roleQ = roles.map((r) => `("hiring" OR "we're hiring" OR "I'm hiring") ${q(r)}${remote ? " (remote OR anywhere)" : ""} min_faves:2${tail}`);
    const founderQ = [
      `("founding engineer" OR "first engineer" OR "first hire" OR "founding team") (hiring OR "looking for" OR "DM me")${tail}`,
      `("we're hiring" OR "I'm hiring" OR "my team is hiring") (${kw.map((k) => k.replace(/\./g, "")).join(" OR ")})${remote ? " (remote OR anywhere)" : ""}${tail}`,
      `("YC" OR "seed" OR "pre-seed" OR "series A") ("we're hiring" OR "hiring our") (engineer OR "full stack" OR "full-stack")${remote ? " remote" : ""}${tail}`,
      `("hiring" OR "looking for") ("AI engineer" OR "LLM engineer" OR "agents") ("DM me" OR "reach out" OR "email me") min_faves:2${tail}`,
      ...(usFirst ? [`("we're hiring" OR "I'm hiring") (SF OR NYC OR "bay area" OR YC) remote (engineer OR "full stack") (anywhere OR global OR worldwide OR "any timezone") ${tail}`] : []),
      ...hybridGroups.slice(0, 1).map((cities) => `("hiring" OR "we're hiring") (${cities.slice(0, 2).join(" OR ")}) (engineer OR developer OR "full stack")${tail}`),
    ];
    const webQ = roles.slice(0, 3).map((r) => `(site:x.com OR site:twitter.com) ("we're hiring" OR "I'm hiring") ${q(r)}${remote ? ` "remote"` : ""}`);
    const route = apifyOn && cfg.sources.apify.x_actor ? "apify" : "web_search";
    plan.push(
      { scout: "x-roles", group: "x", route, queries: route === "apify" ? roleQ : webQ },
      { scout: "x-founders", group: "x", route, queries: route === "apify" ? founderQ : webQ.map((w) => w.replace('"we\'re hiring"', '"founder" "hiring"')) },
    );
  }

  // ---------------- optional: structured APIs and other web sources ----------------
  const apis = enabledSources(cfg);
  if (apis.length) plan.push({ scout: "boards", group: "api", route: "api", queries: [], sources: apis });
  const extra: string[] = [];
  if (cfg.sources.web_search.startup_boards) {
    for (const r of roles.slice(0, 2)) {
      extra.push(`site:workatastartup.com ${q(r)}${remote ? ` "remote"` : ""}`, `site:wellfound.com/jobs ${q(r)}${remote ? ` "remote"` : ""}`);
    }
  }
  if (cfg.sources.web_search.other_social) extra.push(`(site:threads.net OR site:bsky.app) "hiring" ${q(roles[0])}`);
  for (const s of cfg.sources.web_search.extra_sites) extra.push(`site:${s} "hiring" ${q(roles[0])}`);
  if (extra.length) plan.push({ scout: "web-extra", group: "web", route: "web_search", queries: extra });

  for (const p of plan) {
    if (p.route === "web_search" && (p.group === "linkedin" || p.group === "x")) {
      p.note = "APIFY_TOKEN not set: web search indexes very few LinkedIn/X posts and LinkedIn blocks fetching, so expect low yield. Add APIFY_TOKEN to .env for real coverage.";
    }
  }
  return plan;
}
