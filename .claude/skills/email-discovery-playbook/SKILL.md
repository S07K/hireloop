---
name: email-discovery-playbook
description: The waterfall for finding and verifying the work email of founders, hiring managers and recruiters, from free sources to paid ones, with honest confidence scores. Used by the contact-finder agent.
user-invocable: false
---

# Email discovery playbook

## Who to target (priority order)
1. **The post's author**, when they're a human at the hiring company. They asked for applicants, so they expect email.
2. **Founder, CEO or CTO**, for companies of 50 people or fewer. They read their own inbox and decide fast.
3. **Hiring manager**: engineering manager, head or VP of engineering, or the team lead for that function.
4. **Technical recruiter or talent partner**, at larger companies.
5. **HR or generic careers inbox**: last resort only.

Save at most `max_contacts_per_lead` people with emails (default 2): the strongest decision-maker plus one recruiter or hiring manager.

## Waterfall (stop for each person once confidence is ≥ 80, or verification is `valid`)
| Step | Tool | Cost | Confidence to record |
|---|---|---|---|
| 0 | An email written in the post itself | free | 95 (`email_source: post`) |
| 0.5 | **X and LinkedIn posters:** the `Author:` line in `post_text` has their bio or headline. X bios often link a personal site, the company site or a GitHub. Personal sites often list an email. A GitHub handle goes to step 3 | free | 90 when the address is self-published |
| 1 | `scrape_company_site(domain)`: a person's email on the team, about or contact page | free | 85 when the name matches the person |
| 2 | Find names: the site's team page, or WebSearch `"<company>" founder OR CEO OR CTO site:linkedin.com/in` and `"<company>" "head of engineering"` | free | (names, not emails) |
| 3 | `github_emails(username)`: look for the person's GitHub via WebSearch `"<name>" github <company>` or links on their site | free | 75 when the commit email is on the company domain; 60 for a personal address |
| 4 | Infer the pattern: emails from steps 1 and 3 plus `infer_email_pattern` | free | (feeds step 6) |
| 5 | `hunter_domain_search(domain)`, only for leads with fit ≥ 70 or when free steps failed | paid credits | Hunter's own confidence |
| 6 | `find_person_email(full_name, domain, known_pattern)`. It tries Apollo, then Hunter, then pattern + verifier | paid / free | as returned |
| 7 | `verify_email` for every email that isn't already verified | verifier credits | valid → keep; catch_all → keep, confidence ≤ 65; invalid → drop |

## Notes
- **Startups usually use `{first}@domain`.** Above about 50 people, `{first}.{last}@domain` is most common. Use this as the guess order when no pattern is known.
- If `verify_email` says the domain has no MX records, the domain is probably wrong. Recheck it before trying more patterns.
- Save `linkedin_url`, `x_url` and `github_url` whenever you see them. The dashboard shows them so the user can also DM.
- Check `already_contacted_elsewhere` in the `save_contact` response. If it's true, say so in your summary.
- Never use scraped personal data for anything except this one outreach email.
