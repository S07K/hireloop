/**
 * The ONLY place email leaves the machine. Agents cannot reach this: the MCP server exposes no send tool.
 * Drafts move pending -> approved (human click in the dashboard) -> sending -> sent, one at a time,
 * with randomised gaps and a daily cap so a personal Gmail/Workspace account stays healthy.
 */
import fs from "node:fs";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { env, loadConfig, ROOT } from "../lib/config.js";
import { getContact, getDb, getDraft, getLead, sentToday, updateDraft, updateLead } from "../lib/db.js";

let transporter: Transporter | null = null;
function getTransport(): Transporter {
  if (transporter) return transporter;
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS") ?? env("PASS");
  if (!user || !pass) throw new Error("SMTP_USER and SMTP_PASS must be set in .env (Gmail: use an App Password)");
  const port = Number(env("SMTP_PORT") ?? 465);
  transporter = nodemailer.createTransport({
    host: env("SMTP_HOST") ?? "smtp.gmail.com",
    port,
    secure: (env("SMTP_SECURE") ?? String(port === 465)) !== "false",
    auth: { user, pass },
  });
  return transporter;
}

export async function verifySmtp(): Promise<string> {
  await getTransport().verify();
  return "ok";
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const linkify = (s: string) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
const toHtml = (body: string) =>
  body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`).join("");

export async function sendDraft(id: number): Promise<void> {
  const cfg = loadConfig();
  const draft = getDraft(id) as any;
  if (!draft) throw new Error(`draft ${id} not found`);
  if (draft.status !== "approved") throw new Error(`draft ${id} is ${draft.status}, not approved`);
  const contact = getContact(draft.contact_id) as any;
  if (!contact?.email) throw new Error("contact has no email");
  if (contact.verification === "invalid") throw new Error("email failed verification; refusing to send");

  updateDraft(id, { status: "sending" });
  try {
    const fromName = env("SENDER_NAME") ?? cfg.candidate.name;
    const fromEmail = env("SENDER_EMAIL") ?? env("SMTP_USER")!;
    const attachments = [];
    if (cfg.outreach.attach_resume && draft.kind === "initial" && cfg.outreach.resume_path) {
      const p = path.resolve(ROOT, cfg.outreach.resume_path);
      if (fs.existsSync(p)) attachments.push({ filename: path.basename(p), path: p });
    }
    let threading: Record<string, string> = {};
    if (draft.parent_draft_id) {
      const parent = getDraft(draft.parent_draft_id) as any;
      if (parent?.message_id) threading = { inReplyTo: parent.message_id, references: parent.message_id };
    }
    const info = await getTransport().sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: contact.name ? `${contact.name} <${contact.email}>` : contact.email,
      subject: draft.subject,
      text: draft.body,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${toHtml(draft.body)}</div>`,
      attachments,
      ...threading,
    });
    updateDraft(id, { status: "sent", sent_at: new Date().toISOString().replace("T", " ").slice(0, 19), message_id: info.messageId, error: null });
    const lead = getLead(draft.lead_id) as any;
    if (lead && ["qualified", "enriched", "drafted"].includes(lead.status)) updateLead(draft.lead_id, { status: "contacted" });
  } catch (e) {
    updateDraft(id, { status: "failed", error: (e as Error).message.slice(0, 500) });
    throw e;
  }
}

// ---------------- queue worker (runs inside the dashboard process) ----------------
let timer: NodeJS.Timeout | null = null;
let nextAt = 0;
export const queueState = () => ({ next_send_at: nextAt ? new Date(nextAt).toISOString() : null, running: !!timer });

export function startQueue(log: (m: string) => void = console.log) {
  if (timer) return;
  const tick = async () => {
    try {
      const cfg = loadConfig(true);
      if (Date.now() >= nextAt) {
        const row = getDb().prepare("SELECT id FROM drafts WHERE status = 'approved' ORDER BY updated_at ASC LIMIT 1").get() as { id: number } | undefined;
        if (row) {
          if (sentToday() >= cfg.outreach.daily_send_limit) {
            nextAt = Date.now() + 30 * 60_000;
            log(`[queue] daily limit ${cfg.outreach.daily_send_limit} reached; approved drafts wait until tomorrow`);
          } else {
            try {
              await sendDraft(row.id);
              log(`[queue] sent draft ${row.id}`);
            } catch (e) {
              log(`[queue] draft ${row.id} failed: ${(e as Error).message}`);
            }
            const { min_delay_sec: a, max_delay_sec: b } = cfg.outreach;
            nextAt = Date.now() + (a + Math.random() * Math.max(0, b - a)) * 1000;
          }
        }
      }
    } catch (e) {
      log(`[queue] ${(e as Error).message}`);
    }
  };
  // A draft stuck in "sending" after a crash may or may not have gone out: never auto-resend it.
  getDb().prepare("UPDATE drafts SET status = 'failed', error = 'interrupted while sending - check your Sent folder before retrying' WHERE status = 'sending'").run();
  timer = setInterval(tick, 5000);
}
