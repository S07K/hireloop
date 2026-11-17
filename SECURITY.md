# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through [GitHub Security Advisories](https://github.com/S07K/hireloop/security/advisories/new).

Include a description, steps to reproduce and the potential impact. You should get a response within a few days.

## Scope

Areas of particular interest:

- Any path that lets an agent send email without human approval
- Any path that lets an agent read `.env` or other secrets
- Prompt injection from scraped job posts or websites that leads to unintended tool use
- Leaking the candidate's personal data outside the intended outreach
