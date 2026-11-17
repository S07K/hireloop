import fs from "node:fs";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { env, loadConfig, paths, ROOT } from "./lib/config.js";
import { STAGES, runStageAndWait, type Stage } from "./lib/runner.js";

const [, , cmd, ...rest] = process.argv;
const c = { g: (s: string) => `\x1b[32m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m` };

async function setup() {
  console.log(c.b("\nhireloop setup\n"));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!fs.existsSync(paths.env)) { fs.copyFileSync(`${ROOT}/.env.example`, paths.env); console.log(c.g("✓ created .env")); }
  if (!fs.existsSync(paths.profile)) { fs.copyFileSync(paths.profileExample, paths.profile); console.log(c.g("✓ created profile.md")); }
  if (!fs.existsSync(paths.config)) {
    const cfg = JSON.parse(fs.readFileSync(paths.configExample, "utf8"));
    const ask = async (q: string, d: string) => (await rl.question(`${q} ${c.y(`[${d}]`)} `)).trim() || d;
    cfg.candidate.name = await ask("Your name?", cfg.candidate.name);
    cfg.candidate.email = await ask("Email you send from?", cfg.candidate.email);
    cfg.candidate.location = await ask("Where do you live/work from?", cfg.candidate.location);
    cfg.candidate.work_authorization = (await ask("Countries you can legally work in (comma)?", cfg.candidate.work_authorization.join(", "))).split(",").map((s: string) => s.trim());
    cfg.targets.roles = (await ask("Target roles (comma)?", cfg.targets.roles.join(", "))).split(",").map((s: string) => s.trim());
    cfg.targets.keywords = (await ask("Key skills (comma)?", cfg.targets.keywords.join(", "))).split(",").map((s: string) => s.trim());
    cfg.location.preferred_locations = (await ask("Preferred locations/regions (comma)?", cfg.location.preferred_locations.join(", "))).split(",").map((s: string) => s.trim());
    cfg.location.hybrid_cities = (await ask("Cities where hybrid works for you (comma)?", cfg.location.hybrid_cities.join(", "))).split(",").map((s: string) => s.trim());
    fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + "\n");
    console.log(c.g("✓ created hireloop.config.json"));
  }
  rl.close();
  console.log(`\nNext:\n  1. Fill ${c.b("profile.md")} with concrete achievements (this drives email quality)\n  2. Put your SMTP app password (and optional API keys) in ${c.b(".env")}\n  3. ${c.b("npm run doctor")} then ${c.b("npm run dashboard")}\n`);
}

async function doctor() {
  let bad = 0;
  const ok = (m: string) => console.log(c.g("✓ ") + m);
  const warn = (m: string) => console.log(c.y("! ") + m);
  const err = (m: string) => { bad++; console.log(c.r("✗ ") + m); };
  const [maj, min] = process.versions.node.split(".").map(Number);
  maj > 22 || (maj === 22 && min >= 13) ? ok(`node ${process.versions.node}`) : err(`node ${process.versions.node}: need >= 22.13 (node:sqlite)`);
  try { ok(`claude CLI ${execFileSync(process.env.CLAUDE_BIN ?? "claude", ["--version"]).toString().trim()}`); }
  catch { err("Claude Code CLI not found. Install: npm i -g @anthropic-ai/claude-code, then run `claude` once to log in with your Claude subscription"); }
  if (env("ANTHROPIC_API_KEY")) warn("ANTHROPIC_API_KEY is set: Claude Code will bill the API key instead of your subscription");
  try { const cfg = loadConfig(true); ok(`config valid (${fs.existsSync(paths.config) ? "hireloop.config.json" : "using EXAMPLE config - run npm run setup"})`); if (cfg.candidate.name === "Your Name") warn("config still has placeholder candidate name"); }
  catch (e) { err((e as Error).message); }
  fs.existsSync(paths.profile) ? ok("profile.md present") : warn("profile.md missing (using example) - the writer needs your real achievements");
  env("SMTP_USER") && (env("SMTP_PASS") || env("PASS")) ? ok("SMTP credentials set") : warn("SMTP not configured - you can review drafts but not send");
  for (const [k, what] of [["HUNTER_API_KEY", "Hunter"], ["APOLLO_API_KEY", "Apollo"], ["GITHUB_TOKEN", "GitHub token"], ["APIFY_TOKEN", "Apify"]] as const)
    env(k) ? ok(`${what} configured`) : console.log(`  · ${what} not configured (optional)`);
  const v = ["MILLIONVERIFIER_API_KEY", "ZEROBOUNCE_API_KEY", "HUNTER_API_KEY", "VERIFALIA_USERNAME"].find((k) => env(k));
  v ? ok(`email verifier: ${v.split("_")[0].toLowerCase()}`) : warn("no email verifier configured - guessed emails stay unverified (bounce risk)");
  console.log(bad ? c.r(`\n${bad} problem(s) to fix.`) : c.g("\nReady. Run: npm run dashboard"));
  process.exitCode = bad ? 1 : 0;
}

switch (cmd) {
  case "setup": await setup(); break;
  case "doctor": await doctor(); break;
  case "dashboard": { const { startDashboard } = await import("./web/server.js"); startDashboard(); break; }
  case "run": {
    const stage = (rest[0] ?? "pipeline") as Stage;
    if (!STAGES.includes(stage)) { console.error(`stage must be one of: ${STAGES.join(", ")}`); process.exit(1); }
    try { const summary = await runStageAndWait(stage, rest.slice(1).join(" ")); console.log(`\n${c.b("Summary")}\n${summary}`); }
    catch (e) { console.error(c.r((e as Error).message)); process.exitCode = 1; }
    break;
  }
  default:
    console.log(`usage: hireloop <setup|doctor|dashboard|run [${STAGES.join("|")}]>`);
}
