# Golden leave-behind: Oculgen STAT Internal Brief (Aug 2026)

**For developers only — NOT loaded into Buddy as data.**

Source: Mike Watson's Claude session. HTML artifact + prompt = **layout / section recipe**.
Buddy must recompute every site and activation number from live Cosmos on each ask.
Never cite this HTML as a source; never list sites "from the Oculgen brief file."

SF MCP is **not required** for this class of brief — Veeva milestones + fact_site + CT.gov industry PSM are enough.

## Files
- `Oculgen_STAT_Internal_Brief_Aug2026.html` — finished internal HTML
- This prompt (below) — recreate / adapt for similar specialty CRO bids

## What Buddy must pull from Cosmos (not SF)
1. US retina filter only: nAMD, GA, DME, RVO (exclude dry eye / glaucoma / anterior)
2. `ora_veeva_milestones` — Selected→Contract→IRB→SIV→FSFV gaps; P10/P25/median/P75 for US retina; step medians at P25
3. `ora_fact_site` / `ora_fact_study` — site counts, multi-study sites, SIV velocity by study-month, enrolled/screened (no site-level PSM in top-40 table)
4. Industry naïve-nAMD PSM table — treat as curated CT.gov-derived pack (see prompt); not from SF

## Design
Teal `#0d9488` / Navy `#04003B`, Chart.js CDN, "Internal — Do Not Share", HTML_REPORT for Buddy.

---

## Prompt (verbatim from Mike's Claude)

Recreate the Oculgen STAT Internal Brief

Context
I'm Mike Watson, VP of Therapeutic Development (BD) at Ora Clinical, an ophthalmology-focused CRO. We've been invited to bid on Oculgen's OCUL101-002 (STAT Study) — a treatment-naïve nAMD specialty CRO engagement where Oculgen needs 30 US sites stood up rapidly (they asked for 30 days, which isn't realistic). Their global CRO is failing them, and they want us to rescue start-up as a second, specialty CRO focused on patient recruitment and retention.

I need an internal data package (HTML document) that arms our BD team (Trevor Leahy is the lead) with data-backed talking points and strategic framing for the proposal. This is NOT a document to send to Oculgen directly — it's internal, but the takeaways should be shareable.

The RFP Details (from Oculgen's RFP document)
Study: OCUL101-002 (STAT) — randomized, masked, non-inferiority study of OCUL101 (bispecific anti-VEGF × anti-C5 fusion protein) vs aflibercept in treatment-naïve nAMD
US target: 125 randomized patients across 30 non-overlapping US sites
PSM target: 0.52 randomized/site/month
Screen-fail target: ≤50% (currently ~86-90%)
Retention target: ≥90% through Week 36 primary database lock
Part B start: October 2026 — sites must be operational before this date
Key constraint: 30 sites must NOT overlap with the Global CRO's existing network
Engagement model: Specialty FSP reporting to sponsor, not subordinate to the Global CRO
Major competitor: A well-resourced global company is launching a trial in treatment-naïve nAMD screening ~3,000 for ~2,000 worldwide — this is both a risk (competes for naïve patients) and an asset (screen-fail capture opportunity)

What the Document Should Contain
Build a comprehensive internal HTML brief with the following sections, using teal (#0d9488) / navy (#04003B) color scheme, marked "Internal — Do Not Share":

1. Key Takeaways for Oculgen (teal callout box at top) — four messages (speed, known sites / skip-feasibility, PSM reality vs 0.52, site selection = enrollment strategy)
2. Historical SIV Velocity — Bar Chart (Chart.js, anonymized Study 1–6, Month 1–10)
3. Site Activation Timeline — Milestone Chain Analysis (US retina only; P10/P25/median/P75; step chain at P25)
4. Repeat Top-Quartile Retina Performers Table
5. Study-Level Activation Summary Table
6. PSM Reality Check — Industry Benchmarks (10 landmark naïve nAMD trials; recommend 0.32–0.35 expected)
7. Top 40 US Retina Sites — Ranked by Experience & Activation Speed (NO site-level PSM column)
8. Skip-Feasibility Differentiator
9. The 25th Percentile Argument for Oculgen
10. Strategy Notes — Accelerating Treatment-Naïve Recruitment

Data Sources
Ora Veeva CTM: fact_study / fact_site + Mike Watson Site Level milestones; ClinicalTrials.gov for industry PSM; Salesforce optional for BD ownership only (not required for activation/PSM math).

Design Notes
Teal/navy, Internal badge, Chart.js CDN, US RETINA only, speed badges ≤63d / ≤95d / ≤149d / >149d, experience badges 8+/5+/3+/<3.
