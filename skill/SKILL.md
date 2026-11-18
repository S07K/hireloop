---
name: hireloop
description: Agentic job-outreach pipeline. Finds fresh hiring posts on LinkedIn, X, HN, Reddit and remote boards that fit the user's resume, finds the decision-maker's verified work email (founder, hiring manager, recruiter), and drafts a short personal cold email for each one. Nothing is sent until the user approves it in a local dashboard. Use when the user wants to find jobs to apply to, reach hiring managers or founders directly, or run cold job outreach.
---

# hireloop

hireloop is a local app bundled with this skill in `app/`. It runs a pipeline of Claude Code subagents
backed by a local MCP server and a SQLite database:

`hunt` (find hiring posts) → `enrich` (find decision-makers and their emails) → `draft` (write emails)
→ **the user approves in the dashboard** → the dashboard's send queue sends.

## Hard rules (always apply)

1. **You never send email and never approve drafts for the user.** Sending happens only inside the
   dashboard process after the user clicks approve. Don't call SMTP, don't write to the database to
   change a draft's status, and don't script the dashboard's approve endpoint.
2. **Never read, print or edit `.env`.** It holds the user's SMTP password and API keys. You may create
   it by copying `.env.example` (`cp`, no reading), then tell the user to fill it in themselves.
3. **Never invent facts about the user.** Their achievements come only from what they tell you or paste
   (their resume), written into `profile.md`. Unknown means leave it out.
4. **Never fabricate leads, people or emails.** Guessed emails stay labelled as guesses.
5. Prefer free sources over paid API credits (Hunter, Apollo, verifiers). Tell the user before a run
   that will spend paid credits (for example Apify).

## Requirements

- Node.js **≥ 22.13** (uses the built-in `node:sqlite`).
- The **Claude Code CLI** (`claude`), logged in. The pipeline stages run as headless Claude Code
  sessions (`claude -p`) because they use Claude Code subagents. This works from any agent, but the
  CLI has to be installed. If it's missing: `npm i -g @anthropic-ai/claude-code`, then the user runs
  `claude` once to log in.

## Step 1: install into a workspace (first run only)

The workspace is `$HIRELOOP_HOME` if set, otherwise `~/hireloop`. Call it `$WS`.

- If `$WS/package.json` exists, it's already installed: skip to step 3. **Never overwrite** an existing
  `$WS/.env`, `$WS/profile.md`, `$WS/hireloop.config.json` or `$WS/data/`.
- Otherwise copy the bundled app and install dependencies:

```bash
SKILL_DIR="<the directory containing this SKILL.md>"
WS="${HIRELOOP_HOME:-$HOME/hireloop}"
mkdir -p "$WS" && cp -R "$SKILL_DIR/app/." "$WS/"
cd "$WS" && npm install
```

To update an existing install to a newer skill version, copy `app/` over it the same way but skip the
four user files/folders listed above (for example with `rsync -a --exclude .env --exclude profile.md --exclude hireloop.config.json --exclude data "$SKILL_DIR/app/" "$WS/"`), then `npm install`.

## Step 2: set up the user's profile and config (first run only)

Don't run `npm run setup`: it's interactive. Do it conversationally instead:

1. Ask the user for: name, the email address they'll send from, where they live, countries they can
   legally work in, target roles, key skills, years of experience, preferred work modes
   (remote/hybrid/onsite), preferred locations, and hybrid cities.
2. Copy `hireloop.config.example.json` to `hireloop.config.json` and fill in `candidate`, `targets` and
   `location` from the answers. Leave the rest at the defaults unless the user asks.
3. Ask the user to paste their resume or list concrete achievements (numbers, product names, links).
   Write `profile.md` following the structure of `profile.example.md`, using **only** what they gave
   you. This file drives email quality more than anything else.
4. Create `.env` with `cp .env.example .env` (if it doesn't exist) and tell the user to open it and set:
   - **Required to send:** `SMTP_USER`, `SMTP_PASS` (for Gmail, an App Password from
     https://myaccount.google.com/apppasswords), `SENDER_NAME`, `SENDER_EMAIL`.
   - **Strongly recommended:** `APIFY_TOKEN` (LinkedIn and X post search; without it those scouts fall
     back to web search and find little).
   - **Optional:** `HUNTER_API_KEY`, `APOLLO_API_KEY`, `GITHUB_TOKEN`, one email verifier
     (`MILLIONVERIFIER_API_KEY`, `ZEROBOUNCE_API_KEY` or Verifalia).
5. Run `npm run doctor` in `$WS` and fix anything marked ✗. Its output says which keys are set without
   printing them.

## Step 3: run the pipeline

Run from `$WS`. Each command runs a headless Claude Code session on the user's own Claude login and
prints a summary when done. A full run can take 10–30 minutes, so run it in the background if your
environment allows that.

| User wants to… | Command |
|---|---|
| Do everything (hunt → enrich → draft → follow-ups) | `npm run pipeline` |
| Only find new hiring posts | `npm run hunt` |
| Only find contacts for saved leads | `npm run enrich` |
| Only write drafts for enriched leads | `npm run draft` |
| Draft follow-ups for unanswered emails | `npx tsx src/cli.ts run followups` |

Extra instructions can go after the stage, for example `npx tsx src/cli.ts run hunt only fintech startups`.

If the user is already inside Claude Code with `$WS` as the working directory, they can instead type
`/pipeline`, `/hunt`, `/enrich`, `/draft` or `/followups` directly.

Report the run's summary to the user: new leads, contacts found, drafts waiting, and any error with
its fix (for example a missing API key).

## Step 4: hand off for approval

Start the dashboard (keep it running; it is also the send queue):

```bash
cd "$WS" && npm run dashboard
```

Then tell the user to open **http://localhost:4317** (or the `dashboard.port` from the config) to
review, edit and approve drafts. Approved emails go out spread across the day under the daily cap
(`outreach.daily_send_limit`). Stop there: approving and sending is the user's job.

## Scheduling (optional)

If the user wants it daily, suggest a cron entry and let them add it:

```cron
0 8 * * 1-5  cd ~/hireloop && npm run pipeline >> data/cron.log 2>&1
```

## Troubleshooting

- `claude CLI not found`: install Claude Code and log in (see Requirements).
- `node ... need >= 22.13`: upgrade Node.
- Very few LinkedIn/X leads: `APIFY_TOKEN` isn't set.
- Many emails unverified: no verifier key is set; guessed emails stay marked as guesses.
- `ANTHROPIC_API_KEY is set` warning: runs will bill that API key instead of the Claude subscription.
- Tune scoring, email-finding or writing rules by editing the playbooks in
  `$WS/.claude/skills/*-playbook/SKILL.md` (plain markdown).
