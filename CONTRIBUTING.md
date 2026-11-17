# Contributing to hireloop

Thanks for your interest in improving hireloop.

## Development setup

```bash
git clone https://github.com/S07K/hireloop.git && cd hireloop
npm install
npm run setup     # creates your local, git-ignored config, profile and .env
npm run doctor
```

Requires Node ≥ 22.13 (for `node:sqlite`) and [Claude Code](https://docs.claude.com/claude-code).

## Workflow

`main` is protected, so all changes go through pull requests.

1. Fork the repo and create a branch: `git checkout -b feat/my-change`.
2. Make your change and keep it focused.
3. Run the checks:
   ```bash
   npm run typecheck
   npm run test:mcp       # end-to-end MCP tools on a temp DB
   npm run test:sources   # optional: live fetch from job sources
   ```
4. Open a PR describing what changed and why. CI must pass before it can merge.

## Ground rules

These are the project's non-negotiables. PRs that break them won't be merged.

- **Agents never send email.** Don't add a send tool to the MCP server. Sending happens only in `src/mail/sender.ts` after a human approves.
- **No fabrication.** Unknown values are `null`. Guessed emails must be labelled as guesses.
- **Free before paid.** Prefer free sources before spending API credits (Hunter, Apollo, verifiers).
- **Never commit personal data or secrets.** `.env`, `profile.md`, `hireloop.config.json` and `data/` are git-ignored. Keep it that way.

## Common contributions

- **New job source:** add a fetcher in `src/sources/index.ts` and register it in `SOURCE_NAMES` and `FETCHERS`.
- **New email provider:** add it in `src/enrich/emails.ts` and expose it as an MCP tool in `src/mcp/server.ts`.
- **Better prompts:** the playbooks in `.claude/skills/*-playbook/SKILL.md` are plain markdown.

## Reporting bugs

Open an issue with steps to reproduce, the output of `npm run doctor` (check it for anything private first), and your Node version.
