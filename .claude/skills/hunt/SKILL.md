---
name: hunt
description: Hunt stage. Fans out one job-scout subagent per entry in the scout plan (by default LinkedIn and X: role searches plus founder searches) to find fresh hiring posts that match the candidate's resume, and saves qualified leads.
---

# /hunt: find hiring posts

1. Call `mcp__hireloop__get_search_brief`. Read `scout_plan`: one entry per scout, with `scout`, `group`, `route` and `queries`.
2. If any plan entry has a `note` (for example, no Apify token), tell the user about it once at the end. Still run the scouts.
3. In a **single message**, launch one `job-scout` subagent per plan entry, **all in parallel**, with the Agent tool. Each prompt says: `You are scout "<scout>". Call get_search_brief with scout="<scout>" and cover only that assignment. Save at most <leads_per_scout> leads.`
4. When they've all returned, call `mcp__hireloop__pipeline_stats` and report:
   - leads saved per scout
   - how many were posted by a founder or hiring manager by name
   - the top 5 new leads (role · company · poster · mode · score)
   - the main rejection reasons

$ARGUMENTS
