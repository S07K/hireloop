<div align="center">

# hireloop

**An agentic job-outreach pipeline that runs on your Claude subscription.**

It finds people who are hiring, finds the decision-maker's email, and writes a specific, human email for each one.<br/>
**Nothing is sent until you approve it.**

[![CI](https://github.com/S07K/hireloop/actions/workflows/ci.yml/badge.svg)](https://github.com/S07K/hireloop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Claude Code](https://img.shields.io/badge/built%20for-Claude%20Code-D97757?logo=anthropic&logoColor=white)](https://docs.claude.com/claude-code)
[![MCP](https://img.shields.io/badge/MCP-20%20tools-6E56CF)](src/mcp/server.ts)
[![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white)](src/lib/db.ts)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Quick start](#-quick-start) · [How it works](#-how-it-works) · [Configuration](#%EF%B8%8F-configuration) · [Integrations](#-integrations) · [Safety](#%EF%B8%8F-safety) · [Contributing](CONTRIBUTING.md)

</div>

---

## ✨ Why it gets replies

| | |
|---|---|
| 🎯 **Targets people, not job boards** | Founders and engineering managers post "we're hiring" on LinkedIn, X, HN and Reddit. Those posts name a human who can say yes. Scouts score that reachability explicitly. |
| 🧭 **Decision-makers first** | Founder or CTO at small companies, then the hiring manager or the post's author, then the recruiter. Generic `jobs@` inboxes are a last resort. |
| ✅ **Only jobs you're eligible for** | "Remote (US only)" is filtered out if you're in India. Filter by work mode and preferred location in the dashboard. |
| ✍️ **Every email is specific** | References the actual post, maps your 1–2 most relevant achievements to their requirements, and makes one low-friction ask. It learns from how you edited past drafts. |
| 📬 **Protects your inbox** | Emails are verified to avoid bounces, sends are spread out under a daily cap, and follow-ups go in the same thread. |

## 🔁 How it works

```
 ┌──────────── /hunt ────────────┐   ┌──── /enrich ────┐   ┌──── /draft ────┐   ┌─ dashboard ─┐
 │ job-scout ×4 (parallel)       │   │ contact-finder  │   │ outreach-writer│   │ you review, │
 │  · HN Who's Hiring, Reddit    │ → │ founder > HM >  │ → │ 1 email per    │ → │ edit,       │ → send queue
 │  · RemoteOK, Remotive, WWR,   │   │ poster > recr.  │   │ person, tied to│   │ approve     │   (daily cap,
 │    Himalayas, Jobicy, ATS     │   │ free → paid     │   │ their post     │   └─────────────┘    random gaps,
 │  · LinkedIn & X posts         │   │ waterfall +     │   │                │                      threaded
 │  · YC/Wellfound/Threads/Bsky  │   │ verification    │   │                │                      follow-ups)
 └───────────────────────────────┘   └─────────────────┘   └────────────────┘
```

| Stage | Command | What happens |
|---|---|---|
| **Hunt** | `/hunt` | Parallel `job-scout` subagents fetch fresh hiring posts, dedupe them, score fit 0–100 and save qualified leads. |
| **Enrich** | `/enrich` | `contact-finder` subagents pick the best people to email and find their addresses: free sources first, paid APIs only if needed. |
| **Draft** | `/draft` | `outreach-writer` subagents write one short email per contact and save it as a draft. |
| **Approve** | dashboard | You review, edit and approve. Only then does the send queue pick it up. |
| **Follow up** | `/followups` | Same-thread follow-up drafts for sent emails with no reply after N days. |

`/pipeline` runs every stage end to end.

### Architecture (Claude Code native)

| Piece | Where | What |
|---|---|---|
| **Subagents** | [`.claude/agents/`](.claude/agents) | `job-scout`, `contact-finder`, `outreach-writer`. Each has least-privilege tools and runs in parallel. |
| **Skills** | [`.claude/skills/`](.claude/skills) | Entry points `/pipeline`, `/hunt`, `/enrich`, `/draft`, `/followups`, plus the playbooks the agents follow (scoring rubric, email waterfall, cold-email rules). |
| **MCP server** | [`src/mcp/server.ts`](src/mcp/server.ts) | 20 tools: job sources, dedupe, lead/contact/draft store, site crawl, GitHub commit emails, Hunter, Apollo, pattern inference and verification. **It has no send tool.** |
| **Runner** | [`src/lib/runner.ts`](src/lib/runner.ts) | Runs `claude -p "/<stage>"` headless with `--permission-mode dontAsk` and an explicit tool allowlist, and streams progress to the dashboard. |
| **Dashboard** | [`src/web`](src/web) + [`public/`](public) | Leads with filters, an approval queue with inline editing, contacts, runs with a live log, and settings. |
| **Sender** | [`src/mail/sender.ts`](src/mail/sender.ts) | The only code path that sends email, and only for approved drafts. |
| **Store** | `data/hireloop.db` | SQLite through the built-in `node:sqlite`. No native deps, no Docker. |

## 🚀 Quick start

**Requirements:** Node **≥ 22.13** and [Claude Code](https://docs.claude.com/claude-code) logged in with a Claude Pro or Max subscription (`claude`, then `/login`).

```bash
git clone https://github.com/S07K/hireloop.git && cd hireloop
npm install
npm run setup      # asks a few questions → hireloop.config.json, profile.md, .env
npm run doctor     # checks everything
npm run dashboard  # http://localhost:4317 → "Run full pipeline"
```

Before your first run:

1. **Put your real achievements in `profile.md`.** This is the biggest lever on email quality.
2. **Put SMTP credentials in `.env`.** For Gmail, create an [App Password](https://myaccount.google.com/apppasswords).

Prefer the terminal? Use `npm run pipeline` (or `hunt`, `enrich`, `draft`), or open `claude` in this folder and type `/pipeline`.

<details>
<summary><b>Running it daily</b></summary>

Sending happens from the dashboard process, so keep it running. Schedule the agents with cron:

```cron
0 8 * * 1-5  cd /path/to/hireloop && npm run pipeline >> data/cron.log 2>&1
```
</details>

### Scripts

| Command | Description |
|---|---|
| `npm run setup` | Interactive setup: writes `hireloop.config.json`, `profile.md` and `.env` |
| `npm run doctor` | Checks Node, Claude Code, config, SMTP and API keys |
| `npm run dashboard` | Starts the dashboard and send queue on `localhost:4317` |
| `npm run pipeline` | Runs hunt → enrich → draft headless |
| `npm run hunt` / `enrich` / `draft` | Runs a single stage |
| `npm run mcp` | Starts the hireloop MCP server on stdio |
| `npm run typecheck` | Type-checks the project |
| `npm run test:sources` | Live fetch from every job source |
| `npm run test:mcp` | End-to-end MCP tool smoke test on a temp DB |

## ⚙️ Configuration

| File | Purpose |
|---|---|
| `hireloop.config.json` | Roles, keywords, exclusions, work modes, preferred locations, hybrid cities, work authorization, sources, ATS watchlist (Greenhouse, Lever and Ashby slugs of dream companies), send limits, model. Start from [`hireloop.config.example.json`](hireloop.config.example.json). |
| `profile.md` | Your proof points. The writer uses nothing else, so nothing gets invented. Start from [`profile.example.md`](profile.example.md). |
| `.env` | SMTP credentials and optional API keys. Start from [`.env.example`](.env.example). |

All three are git-ignored, so your personal data stays local.

## 🔌 Integrations

All optional except SMTP.

| Purpose | Options | Notes |
|---|---|---|
| **Sending** | Any SMTP (Gmail or Workspace app password) | Required to send |
| **LinkedIn and X posts** | [Apify](https://apify.com): `harvestapi/linkedin-post-search`, `apidojo/tweet-scraper` | **Strongly recommended.** Search engines index few social posts and LinkedIn blocks fetching. About $2 per 1k LinkedIn posts and $0.40 per 1k tweets (the tweet actor needs a paid Apify plan). Set `APIFY_TOKEN`. |
| **Email finding** | Hunter, Apollo | Free sources always run first: the post, the company site, GitHub commits, pattern inference |
| **Verification** | MillionVerifier, ZeroBounce, Hunter, Verifalia | Without one, guessed emails are marked unverified |
| **GitHub** | `GITHUB_TOKEN` | Raises the GitHub API rate limit |

Without Apify, the LinkedIn and X scouts fall back to web search. It works, but yields little.

## 🛡️ Safety

- **Agents can't send email.** There is deliberately no send tool. Sending only happens in `src/mail/sender.ts` after you approve a draft in the dashboard.
- **Secrets stay out of reach.** Agents are denied `.env` reads. Headless runs use `dontAsk` mode with an explicit tool allowlist and only the hireloop MCP server (`--strict-mcp-config`).
- **No fabrication.** Unknown values stay null, guessed emails are labelled as guesses, and claims about you come only from `profile.md` and your config.
- **Be a good citizen.** Personal data is only used to send one relevant email to people who publicly posted that they're hiring. Respect the platforms' terms and local email laws, and keep volume low.

## 🧩 Extending

- **New job source:** add a fetcher in [`src/sources/index.ts`](src/sources/index.ts) and register it in `SOURCE_NAMES` and `FETCHERS`.
- **New email provider:** add it in [`src/enrich/emails.ts`](src/enrich/emails.ts) and expose it as an MCP tool.
- **Tune behavior:** edit the playbooks in `.claude/skills/*-playbook/SKILL.md`. They're plain markdown.

## 🤝 Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, and report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## 📄 License

[MIT](LICENSE)
