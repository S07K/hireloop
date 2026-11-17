import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const ConfigSchema = z.object({
  candidate: z.object({
    name: z.string(),
    email: z.string(),
    location: z.string().describe("Where you live/work from, e.g. 'Bangalore, India'"),
    timezone: z.string().default(""),
    work_authorization: z.array(z.string()).default([]).describe("Countries/regions you can legally work in"),
    years_experience: z.number().min(0).max(50).default(3),
  }),
  targets: z.object({
    roles: z.array(z.string()).min(1),
    keywords: z.array(z.string()).default([]),
    seniority: z.array(z.string()).default([]),
    exclude_keywords: z.array(z.string()).default([]),
    min_fit_score: z.number().min(0).max(100).default(60),
  }),
  location: z.object({
    work_modes: z.array(z.enum(["remote", "hybrid", "onsite"])).default(["remote", "hybrid"]),
    preferred_locations: z.array(z.string()).default([]),
    hybrid_cities: z.array(z.string()).default([]),
    /** Ordered preference: leads matching an earlier rule rank higher (tier 1 = best). */
    priority: z.array(z.object({
      label: z.string(),
      work_mode: z.enum(["remote", "hybrid", "onsite"]),
      company_regions: z.array(z.string()).default([]).describe("Match company HQ region, e.g. ['US']"),
      cities: z.array(z.string()).default([]).describe("Match office city in the lead's location"),
    })).default([]),
  }),
  sources: z.object({
    hn: z.boolean().default(true),
    reddit: z.object({ enabled: z.boolean().default(true), subreddits: z.array(z.string()).default([]) }).default({ enabled: true, subreddits: [] }),
    remoteok: z.boolean().default(true),
    remotive: z.boolean().default(true),
    weworkremotely: z.boolean().default(true),
    himalayas: z.boolean().default(true),
    jobicy: z.boolean().default(true),
    web_search: z.object({
      linkedin_posts: z.boolean().default(true),
      x_posts: z.boolean().default(true),
      startup_boards: z.boolean().default(true),
      other_social: z.boolean().default(true),
      extra_sites: z.array(z.string()).default([]),
    }).default({ linkedin_posts: true, x_posts: true, startup_boards: true, other_social: true, extra_sites: [] }),
    ats_watchlist: z.array(z.object({ ats: z.enum(["greenhouse", "lever", "ashby"]), slug: z.string(), company: z.string().optional() })).default([]),
    apify: z.object({
      linkedin_actor: z.string().default(""),
      linkedin_input: z.record(z.string(), z.any()).default({}),
      x_actor: z.string().default(""),
      x_input: z.record(z.string(), z.any()).default({}),
    }).default({ linkedin_actor: "", linkedin_input: {}, x_actor: "", x_input: {} }),
    max_age_days: z.number().default(21),
  }),
  outreach: z.object({
    daily_send_limit: z.number().default(25),
    min_delay_sec: z.number().default(90),
    max_delay_sec: z.number().default(240),
    followup_after_days: z.number().default(4),
    max_followups: z.number().default(1),
    max_contacts_per_lead: z.number().default(2),
    attach_resume: z.boolean().default(false),
    resume_path: z.string().default(""),
    signature: z.string().default(""),
    links: z.record(z.string(), z.string()).default({}),
  }),
  agents: z.object({
    model: z.string().default("sonnet"),
    max_leads_per_run: z.number().default(40),
  }).default({ model: "sonnet", max_leads_per_run: 40 }),
  dashboard: z.object({ port: z.number().default(4317) }).default({ port: 4317 }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const paths = {
  config: path.join(ROOT, "hireloop.config.json"),
  configExample: path.join(ROOT, "hireloop.config.example.json"),
  profile: path.join(ROOT, "profile.md"),
  profileExample: path.join(ROOT, "profile.example.md"),
  dataDir: path.join(ROOT, "data"),
  db: process.env.HIRELOOP_DB ?? path.join(ROOT, "data", "hireloop.db"),
  env: path.join(ROOT, ".env"),
};

let cached: Config | null = null;
export function loadConfig(fresh = false): Config {
  if (cached && !fresh) return cached;
  const file = fs.existsSync(paths.config) ? paths.config : paths.configExample;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${path.basename(file)}:\n${z.prettifyError(parsed.error)}`);
  }
  cached = parsed.data;
  return cached;
}

export function loadProfile(): string {
  const file = fs.existsSync(paths.profile) ? paths.profile : paths.profileExample;
  return fs.readFileSync(file, "utf8");
}

export const env = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
};
