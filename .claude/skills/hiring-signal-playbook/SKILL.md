---
name: hiring-signal-playbook
description: Rubric for judging whether a post is a real, current, reachable hiring opportunity for this candidate, and how to score its fit from 0 to 100. Used by the job-scout agent.
user-invocable: false
---

# Hiring signal playbook

## What counts as a lead
A post or listing where **a company is hiring now** for a role the candidate targets, in a work mode they accept (remote, or hybrid in one of their cities), and where the candidate is **eligible to be hired**.

The best leads are **posts by people**: a founder, CTO, engineering manager or team lead writing "we're hiring" or "my team is looking for". Those posts name a human who can say yes. Listings on job boards are fine, but rank below them.

## Reject outright (use `mark_rejected` with the reason)
- `job-seeker`: "open to work", "[For Hire]", "looking for opportunities", people asking for referrals.
- `wrong-role`: a different discipline (sales, design-only, data entry), or a seniority far from the target (intern or VP when the target is mid/senior).
- `experience-gap`: the post requires at least `candidate.years_experience + 3` years (for example "8+ years" for someone with 4), or a hard skill that is central to the role and absent from the profile (for example "Staff Rust systems engineer" for a React/Node engineer).
- `bot-repost`: X or LinkedIn job-aggregator accounts and bots that repost listings ("🚨 New job:", "#hiring #jobs" spam, accounts with "jobs" in their handle). Reject them unless they name the company and a direct contact.
- `onsite-only`: onsite-only in a city that isn't in `hybrid_cities`, or relocation required when that isn't acceptable.
- `region-locked`: "US only", "must reside in EU", "UK right to work", "EST hours only, US-based" and similar, when the candidate's location and `work_authorization` don't satisfy it. Read this carefully: "remote (US)" usually means US residents only. "Remote, anywhere in UTC-3 to UTC+5" can include India; check the offset.
- `stale`: older than `max_age_days`, or the post says the position has been filled.
- `spam`: bootcamps, MLM, "earn $$$", pay-to-apply, crypto pump schemes, unpaid "equity-only" roles (unless the profile says that's acceptable).
- `no-company`: an agency or recruiter post that doesn't name the client and has no way to reach the company.

## Fit score (0–100). Add up these parts:
| Part | Points | Guidance |
|---|---|---|
| Role and skills match | 0–35 | **Compare against the full profile (resume), not just the keywords.** 30+ needs the title to match a target role AND most of the must-have skills to appear in the profile's stack or proof points. Subtract for each must-have the profile lacks. |
| Experience match | 0–10 | 10 when the required years ≤ `years_experience` + 1. 5 when it's +2. 0 when it's more. Founder-led or startup roles that ask for "ownership" or "0→1" also match any founder or 0→1 projects in the candidate's profile: give 10. |
| Location and eligibility | 0–15 | Follow the user's `location.priority` order in the brief. Rank 1 gets 15, each later rank 3 fewer, and no match gets 3. Eligibility still gates everything: a rule match doesn't help a post the candidate can't be hired for. |
| Reachability | 0–30 | **+18 when a founder, CTO or hiring manager at the company wrote the post themselves.** +7 for a startup of 50 people or fewer. +5 when the post invites email or DMs. |
| Freshness and quality | 0–10 | Posted within 7 days is worth up to 10. Funded, real product, clear salary range: +. |

Set `fit_reason` to one or two sentences. Name the resume evidence that matches (for example "React/Next + LLM agents, matches EnableX LlamaIndex agent and RAGChat") and any risk ("snippet only", "wants 6+ yrs", "4h US overlap").

## Field extraction
- `source`: linkedin | x | reddit | hn | remoteok | remotive | weworkremotely | himalayas | jobicy | ats | web
- `source_url`: the post's permalink. For LinkedIn use the `/posts/...` or `/feed/update/urn:li:activity:...` URL. For X use `x.com/<user>/status/<id>`.
- `poster_*`: for HN, the `author` is the poster (profile at `https://news.ycombinator.com/user?id=<author>`). HN posts often include an email or a "contact" line; keep it in `post_text`. For Reddit, the profile is `https://www.reddit.com/user/<author>`.
- `company_domain`: the bare domain (acme.com). Ignore link shorteners and ATS domains such as lever.co, greenhouse.io, ashbyhq.com, linkedin.com and x.com. The company's own domain is what you want.
- `company_size`: a rough band if it's known or visible.
- `company_region`: where the company is **headquartered** (US, India, EU, UK…). Clues: founder bio ("SF", "NYC", "Bay Area"), YC batch, the site's footer or address, "Delaware C-corp". This sets the lead's location priority, so set it whenever you can tell; otherwise leave it null.
- **US companies hiring remote:** these are eligible when the post says worldwide, anywhere or international, says nothing about region, or mentions contractors or EOR (Deel, Remote.com). They are *not* eligible when the post says "US-based", "US residents", "US work authorization" or "must be in PST/EST" with no exceptions.
- `eligible_regions`: copy the post's restriction wording when there is one. Otherwise "Worldwide" (only if the post says so) or null.
- `tags`: 3–6 short skill or stack tags from the post.
