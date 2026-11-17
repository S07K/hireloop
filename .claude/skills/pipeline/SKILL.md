---
name: pipeline
description: Runs the whole hireloop pipeline end to end - hunt for hiring posts, enrich them with decision-maker emails, draft personalized emails, and draft follow-ups - leaving everything in the dashboard for approval.
---

# /pipeline: hunt → enrich → draft → follow-ups

Run each stage in order by following its skill's instructions. Each stage depends on the one before it.

1. **Hunt**: follow `.claude/skills/hunt/SKILL.md`.
2. **Enrich**: follow `.claude/skills/enrich/SKILL.md`.
3. **Draft**: follow `.claude/skills/draft/SKILL.md`.
4. **Follow-ups**: follow `.claude/skills/followups/SKILL.md`.

Finish with a summary of at most 10 lines: new leads, new contacts with emails, drafts waiting for approval, follow-ups drafted, and any errors (for example a failing source or a missing API key) together with the exact fix.

$ARGUMENTS
