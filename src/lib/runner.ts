/**
 * Runs pipeline stages through Claude Code in headless mode (`claude -p`), so the agents run on the user's own
 * Claude subscription (or API key, if that's how their Claude Code is logged in). Streams progress to the DB + SSE.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { loadConfig, ROOT } from "./config.js";
import { appendRunLog, createRun, finishRun } from "./db.js";

export const STAGES = ["pipeline", "hunt", "enrich", "draft", "followups"] as const;
export type Stage = (typeof STAGES)[number];

export const runEvents = new EventEmitter();
let current: { id: number; stage: Stage; child: ChildProcess } | null = null;
export const currentRun = () => (current ? { id: current.id, stage: current.stage } : null);

const ALLOWED_TOOLS = ["mcp__hireloop", "WebSearch", "WebFetch", "Agent", "Task", "Read", "Skill"];

function describe(block: any): string | null {
  if (block.type === "text" && block.text?.trim()) return block.text.trim();
  if (block.type === "tool_use") {
    const name = String(block.name).replace("mcp__hireloop__", "⚙ ");
    const input = block.input ?? {};
    const hint = input.description ?? input.query ?? input.source ?? input.domain ?? input.username ?? input.full_name ?? input.lead_id ?? input.url ?? input.subagent_type ?? "";
    return `${name}${hint ? ` · ${String(hint).slice(0, 140)}` : ""}`;
  }
  return null;
}

export function startStage(stage: Stage, extra = ""): number {
  if (current) throw new Error(`A ${current.stage} run (#${current.id}) is already in progress`);
  const cfg = loadConfig(true);
  const id = createRun(stage);
  const prompt = `/${stage} ${extra}`.trim();
  const args = [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "dontAsk",
    "--mcp-config", ".mcp.json", "--strict-mcp-config",
    "--allowedTools", ...ALLOWED_TOOLS,
    "--model", cfg.agents.model,
  ];
  const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { cwd: ROOT, env: { ...process.env, HIRELOOP_RUN_ID: String(id) }, stdio: ["ignore", "pipe", "pipe"] });
  current = { id, stage, child };

  const log = (line: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
    appendRunLog(id, stamped);
    runEvents.emit("log", { run_id: id, line: stamped });
  };
  log(`▶ claude ${args.slice(0, 2).join(" ")} (model: ${cfg.agents.model})`);

  let buf = "";
  let summary = "";
  let cost: number | undefined;
  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      try {
        const ev = JSON.parse(raw);
        const sub = ev.parent_tool_use_id ? "  ↳ " : "";
        if (ev.type === "assistant") {
          for (const b of ev.message?.content ?? []) { const d = describe(b); if (d) log(sub + d); }
        } else if (ev.type === "user") {
          for (const b of ev.message?.content ?? []) {
            if (b.type === "tool_result" && b.is_error) log(`${sub}✗ ${JSON.stringify(b.content).slice(0, 240)}`);
          }
        } else if (ev.type === "result") {
          summary = ev.result ?? "";
          cost = ev.total_cost_usd;
          if (ev.is_error) log(`✗ ${ev.subtype}: ${summary}`);
        } else if (ev.type === "system" && ev.subtype === "init") {
          const mcp = (ev.mcp_servers ?? []).map((s: any) => `${s.name}:${s.status}`).join(", ");
          log(`session started · mcp: ${mcp || "none"}`);
        }
      } catch {
        log(raw.slice(0, 300));
      }
    }
  });
  child.stderr!.on("data", (c: Buffer) => log(`stderr: ${c.toString().trim().slice(0, 500)}`));
  child.on("error", (e) => {
    log(`✗ could not start Claude Code: ${e.message}. Is the 'claude' CLI installed and logged in? Run: npm run doctor`);
  });
  child.on("close", (code) => {
    const status = code === 0 ? "done" : "failed";
    log(`■ ${status} (exit ${code})`);
    finishRun(id, status, summary.slice(0, 4000), cost);
    runEvents.emit("done", { run_id: id, status, summary });
    current = null;
  });
  return id;
}

export function cancelRun(): boolean {
  if (!current) return false;
  current.child.kill("SIGTERM");
  return true;
}

/** Foreground run for the CLI / cron: resolves when the stage finishes. */
export function runStageAndWait(stage: Stage, extra = "", print = true): Promise<string> {
  return new Promise((resolve, reject) => {
    const onLog = (e: { line: string }) => print && console.log(e.line);
    runEvents.on("log", onLog);
    try {
      startStage(stage, extra);
    } catch (e) {
      runEvents.off("log", onLog);
      return reject(e);
    }
    runEvents.once("done", (e: { status: string; summary: string }) => {
      runEvents.off("log", onLog);
      e.status === "done" ? resolve(e.summary) : reject(new Error(e.summary || "run failed"));
    });
  });
}
