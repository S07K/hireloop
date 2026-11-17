---
name: draft
description: Draft stage. Writes personalized outreach emails for enriched leads with parallel outreach-writer subagents and saves them as drafts waiting for the user's approval in the dashboard. Never sends.
---

# /draft: write emails for approval

1. Call `mcp__hireloop__list_leads` with `needs: "drafts"` and `limit: 30`.
2. If there are none, say so and stop.
3. Split them into batches of 4 leads. Launch one `outreach-writer` subagent per batch **in parallel**, in a single message with up to 5 Agent calls.
4. Report how many drafts are waiting for approval, and remind the user to review them in the dashboard (`npm run dashboard` → Approvals). Nothing is sent without their click.

$ARGUMENTS
