---
name: cold-email-playbook
description: Structure, length, tone and a self-check list for job-outreach cold emails and follow-ups that get replies from founders, hiring managers and recruiters. Used by the outreach-writer agent.
user-invocable: false
---

# Cold email playbook

The reader gets dozens of these. They decide in about 5 seconds whether to reply. The email wins if it is **specific to their post**, **proves fit with evidence**, and **costs them almost nothing to answer**.

## Structure (plain text, 80–150 words, about 5 short paragraphs at most)
1. **Greeting**: `Hi <FirstName>,` (just `Hi,` if the name is unknown; never "Dear Sir/Madam").
2. **Hook, 1 sentence**: why you're writing to *them*, with one concrete reference. For example: "Saw your post about hiring a full-stack engineer for the new billing dashboard." Then the claim: "I've built almost exactly that at Paytm."
3. **Proof, 2–3 lines**: the 1–2 profile achievements that map to their stated requirements, with numbers. Mirror their wording ("you mentioned Next.js and Postgres" → "I've shipped Next.js + Postgres products used by X").
4. **Logistics, optional, 1 line**: remote setup, timezone overlap, notice period. Include it only if the post raises the concern (for example a timezone requirement), **or when the lead's `company_region` differs from the candidate's country**. For example, a US company emailed by a candidate in India gets one line on the US-hours overlap stated in the profile. Never promise more overlap or work-authorization status than the profile states.
5. **Ask, 1 line, low friction**: "Open to a 15-minute call this week?" or "Happy to send a short Loom walking through [relevant project]." or, for recruiters, "Should I apply through the posting, or is there a better route?"
6. **Links line**: at most 2–3 of `links` that matter for this role (for example `Portfolio · GitHub`). Write the full URLs.
7. **Signature**: exactly the configured `signature`.

## Subject line (under 60 characters, lowercase is fine, no clickbait)
Specific beats clever. Patterns that work:
- `re: your <role> post` (only when they posted it themselves)
- `<role> - <strongest relevant proof>` (for example "Frontend eng - cut prod errors 80% at Paytm")
- `<their product> + <your relevant skill>`

## Angle by recipient
- **Founder or CEO**: product impact, speed, ownership, cost of a bad hire. Keep it the shortest.
- **CTO, engineering manager or team lead**: stack match, a technical win, code quality, links to code.
- **Recruiter or HR**: clear match to the job description's must-haves, logistics (notice period, location or eligibility), how to proceed.
- **Second contact on the same lead**: change the hook and the proof point so the two emails don't look templated if they get forwarded.

## Never
- "I hope this email finds you well", "I came across your profile", "I'm writing to express my interest", "I'm passionate about", "synergy", "leverage", "rockstar".
- Begging or neediness ("a little help would mean a lot"), long life stories, or listing every skill.
- Invented claims, numbers, or familiarity with their product that you didn't actually check.
- Leftover placeholders, `[brackets]`, markdown formatting, emojis, or more than 2 links in the body plus the links line.
- Em-dash-heavy, overly polished AI cadence. Write like a sharp engineer typing quickly but carefully.

## Follow-up (`kind: followup`, sent 4+ days later in the same thread)
2–4 lines. Use a new piece of value (a relevant link, a quick idea about their product, a recent result) and restate the ask. For example: "Quick follow-up. I put together a 2-min Loom on how I'd approach <thing from post>: <link if available>. Still keen to chat if the role's open." Don't guilt-trip.

## Self-check before `save_draft`
- [ ] It references something only this company or post has.
- [ ] Every claim is backed by profile.md.
- [ ] 80–150 words (follow-ups 25–60).
- [ ] One clear ask.
- [ ] Reads naturally aloud. No AI clichés.
- [ ] Respects the user's past edits (`user_style_edits`).
