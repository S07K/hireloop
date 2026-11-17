---
name: enrich
description: Enrich stage. Finds decision-makers (founders first, then hiring managers, then recruiters) and their verified emails for leads that don't have contacts yet, using parallel contact-finder subagents.
---

# /enrich: find the people and their emails

1. Call `mcp__hireloop__list_leads` with `needs: "contacts"` and `limit: 30`. The results are sorted by fit score, best first.
2. If there are none, say so and stop.
3. Split the lead IDs into batches of about 5. Launch one `contact-finder` subagent per batch **in parallel**, in a single message with up to 5 Agent calls. Process the highest-fit batches first. Each prompt gives the batch's lead IDs (and their company names, for readability).
4. When they've returned, report: leads enriched, emails found by source (post, website, github, hunter, apollo, pattern), the verification mix, and leads with no contact.

$ARGUMENTS
