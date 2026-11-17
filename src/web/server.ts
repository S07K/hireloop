import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { loadConfig, ROOT } from "../lib/config.js";
import * as db from "../lib/db.js";
import { cancelRun, currentRun, runEvents, STAGES, startStage, type Stage } from "../lib/runner.js";
import { queueState, startQueue, verifySmtp } from "../mail/sender.js";

export function startDashboard() {
  const cfg = loadConfig();
  const app = new Hono();
  const api = new Hono();

  api.get("/stats", (c) => c.json({ ...db.stats(), daily_limit: loadConfig(true).outreach.daily_send_limit, queue: queueState(), run: currentRun() }));

  api.get("/leads", (c) => {
    const q = c.req.query();
    const list = (v?: string) => (v ? v.split(",").filter(Boolean) : undefined);
    return c.json(db.listLeads({
      status: list(q.status), work_mode: list(q.work_mode), location: q.location, source: q.source || undefined,
      min_score: q.min_score ? Number(q.min_score) : undefined, eligible_only: q.eligible === "1", q: q.q, max_tier: q.max_tier ? Number(q.max_tier) : undefined, limit: Number(q.limit ?? 300),
    }));
  });
  api.get("/leads/:id", (c) => {
    const id = Number(c.req.param("id"));
    const lead = db.getLead(id);
    if (!lead) return c.json({ error: "not found" }, 404);
    return c.json({ lead, contacts: db.listContacts(id), drafts: (db.listDrafts() as any[]).filter((d) => d.lead_id === id) });
  });
  api.patch("/leads/:id", async (c) => {
    const body = await c.req.json();
    db.updateLead(Number(c.req.param("id")), body);
    return c.json(db.getLead(Number(c.req.param("id"))));
  });

  api.get("/contacts", (c) => c.json(db.listContacts()));

  api.get("/drafts", (c) => c.json(db.listDrafts(c.req.query("status") || undefined)));
  api.patch("/drafts/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const d = db.getDraft(id) as any;
    if (!d) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ subject?: string; body?: string; status?: string }>();
    const patch: Parameters<typeof db.updateDraft>[1] = {};
    if (body.subject != null) patch.subject = body.subject;
    if (body.body != null) patch.body = body.body;
    if (body.status) {
      const allowed: Record<string, string[]> = { approved: ["pending", "failed"], rejected: ["pending", "approved", "failed"], pending: ["approved", "rejected", "failed"] };
      if (!allowed[body.status]?.includes(d.status)) return c.json({ error: `cannot move ${d.status} → ${body.status}` }, 400);
      patch.status = body.status as any;
      if (body.status === "approved") patch.error = null;
    }
    if ((patch.subject || patch.body) && !["pending", "approved", "failed"].includes(d.status)) return c.json({ error: "draft already sent" }, 400);
    db.updateDraft(id, patch);
    return c.json(db.getDraft(id));
  });
  api.post("/drafts/approve-all", async (c) => {
    const { ids } = await c.req.json<{ ids: number[] }>();
    let n = 0;
    for (const id of ids) { const d = db.getDraft(id) as any; if (d?.status === "pending") { db.updateDraft(id, { status: "approved" }); n++; } }
    return c.json({ approved: n });
  });

  api.get("/runs", (c) => c.json(db.listRuns()));
  api.get("/runs/:id", (c) => c.json(db.getRun(Number(c.req.param("id")))));
  api.post("/runs", async (c) => {
    const { stage, extra } = await c.req.json<{ stage: Stage; extra?: string }>();
    if (!STAGES.includes(stage)) return c.json({ error: "unknown stage" }, 400);
    try { return c.json({ run_id: startStage(stage, extra ?? "") }); } catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });
  api.post("/runs/cancel", (c) => c.json({ cancelled: cancelRun() }));
  api.get("/runs-stream", (c) => streamSSE(c, async (stream) => {
    const onLog = (e: unknown) => stream.writeSSE({ event: "log", data: JSON.stringify(e) });
    const onDone = (e: unknown) => stream.writeSSE({ event: "done", data: JSON.stringify(e) });
    runEvents.on("log", onLog); runEvents.on("done", onDone);
    stream.onAbort(() => { runEvents.off("log", onLog); runEvents.off("done", onDone); });
    while (!stream.aborted) await stream.sleep(15000).then(() => stream.writeSSE({ event: "ping", data: "" }));
  }));

  api.get("/config", (c) => {
    const k = (n: string) => !!process.env[n]?.trim();
    return c.json({
      config: loadConfig(true),
      integrations: {
        smtp: k("SMTP_USER") && (k("SMTP_PASS") || k("PASS")), hunter: k("HUNTER_API_KEY"), apollo: k("APOLLO_API_KEY"),
        github: k("GITHUB_TOKEN"), apify: k("APIFY_TOKEN"),
        verifier: ["MILLIONVERIFIER_API_KEY", "ZEROBOUNCE_API_KEY", "HUNTER_API_KEY", "VERIFALIA_USERNAME"].find(k) ?? null,
      },
    });
  });
  api.post("/smtp/verify", async (c) => { try { return c.json({ ok: await verifySmtp() }); } catch (e) { return c.json({ error: (e as Error).message }, 400); } });

  app.route("/api", api);
  const html = () => fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  app.get("/", (c) => c.html(html()));

  startQueue((m) => console.log(m));
  const port = Number(process.env.PORT ?? cfg.dashboard.port);
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  console.log(`\n  hireloop dashboard → http://localhost:${port}\n`);
}
