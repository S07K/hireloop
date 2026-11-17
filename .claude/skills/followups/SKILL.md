---
name: followups
description: Writes follow-up drafts in the same thread for sent emails that haven't had a reply after the configured number of days.
---

# /followups

1. Call `mcp__hireloop__list_followup_candidates`.
2. If there are none, say so and stop.
3. Otherwise launch one `outreach-writer` subagent with the full candidate list (`parent_draft_id`, `lead_id`, `contact_id`, original subject and body). Tell it to write `kind: "followup"` drafts.
4. Report the number of follow-up drafts waiting for approval.
