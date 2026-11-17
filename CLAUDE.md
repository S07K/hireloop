# hireloop: project instructions for Claude

This repo is an agentic job-outreach pipeline. Claude Code runs it, using project subagents (`.claude/agents`), skills (`.claude/skills`) and the local `hireloop` MCP server (`src/mcp/server.ts`, configured in `.mcp.json`).

## Pipeline
`/hunt` (job-scout ×4 in parallel) → `/enrich` (contact-finder ×N) → `/draft` (outreach-writer ×N) → the human approves in the dashboard → the dashboard's send queue sends.
`/pipeline` runs every stage. `/followups` drafts same-thread follow-ups.

## Non-negotiables
- **Agents never send email.** There's deliberately no send tool. Sending happens only in `src/mail/sender.ts` after a human approves in the dashboard.
- Never read or print `.env`.
- Never fabricate leads, people, emails or claims about the candidate. Unknown means null. Guessed emails must be labelled as guesses.
- Prefer free sources before paid API credits (Hunter, Apollo, verifiers).
- The candidate's facts come only from `profile.md` and `hireloop.config.json`.

## Dev
- `npm run typecheck`, `npm run dashboard`, `npm run doctor`
- DB: SQLite at `data/hireloop.db` (`node:sqlite`, Node ≥ 22.13)
- Adding a job source: add a fetcher in `src/sources/index.ts` and register it in `SOURCE_NAMES` and `FETCHERS`.
