# Ora Clinical — Feasibility Report Generation Instructions

> **Workbench / Monet:** This playbook drives Monet site-feasibility HTML leave-behinds.
> Runtime condensed copy: `api/src/oraFeasibilityReportContext.txt` (loaded into every Monet ask).
> Foundry paste file: `docs/foundry-agent-instructions-Monet.txt`.
>
> **Data mapping (Excel labels → live Context):** Prefer Context JSON / Cosmos over opening workbooks.
> - Veeva `fact_site` → `ora_veeva_study` / `ora_veeva_site` / `ora_veeva_milestone` + `intelligence.indicationBenchmark` / sites packs
> - TrialHub Actual P/S/M → `psm_common` / `th_actual_psm` on TrialHub packs (never Planned as Actual)
> - Salesforce → `intelligence.salesforceData` + `sponsorCrosswalk`
> - CT.gov → live gap-fill / recruiting samples / NCT packs (Node attaches; do not invent NCT rows)
> Column-level TrialHub extraction steps below still apply when reading an uploaded TrialHub export.

## PURPOSE

A feasibility report is Ora's primary BD intelligence deliverable. It is NOT a data dump. It is a strategic document that equips Ora's Subject Matter Experts (SMEs) with the information they need to:

1. Decide whether to pursue an opportunity
2. Build win themes for the proposal
3. Set realistic enrollment projections
4. Select the right sites
5. Position Ora's experience against competitors

Every data point in the report must serve one of these goals. If a piece of data doesn't help the SME make a decision, it doesn't belong in the report.

---

## BEFORE YOU START — DOCUMENT VERIFICATION

**CRITICAL:** Before using any uploaded protocol, RFP, or synopsis, confirm the sponsor/client name matches the active workstream. Never assume a document belongs to a specific sponsor based on indication alone. A prior error confusing two unrelated protocols led to incorrect competitive positioning in a deliverable. Read the document, extract the sponsor name, and confirm it matches what the user told you.

---

## REPORT STRUCTURE

A feasibility report should contain these sections in order:

### 1. PROTOCOL SUMMARY
Extract from the uploaded protocol/synopsis. Include:
- Sponsor name
- Study number / protocol ID
- Phase
- Indication (be specific — "non-infectious anterior uveitis" not "uveitis")
- Drug name, mechanism of action, route of administration
- Study design (randomized? masked? controlled? comparator?)
- Number of patients (target enrollment)
- Number of sites (planned)
- Primary endpoint and timeframe
- Key inclusion/exclusion criteria that affect site selection or enrollment
- Study duration
- Geographic scope (US only? Global? Which countries?)

### 2. ORA EXPERIENCE — INDICATION-SPECIFIC
This is the most important section for win theme construction. Pull from Veeva via live Context (`ora_veeva_*` / indicationBenchmark / sites packs — not Excel when Cosmos is populated):

**What to pull:**
- All Ora studies in the EXACT indication (e.g., "wet AMD" not "AMD broadly")
- For each study: study name, phase, number of Ora sites, total enrolled, median site PSM
- Aggregate: total Ora studies in indication, total sites, total enrolled
- Top-performing sites by enrollment in this indication

**Rules:**
- Apply the zero-enrollment exclusion rule: exclude studies where ALL sites globally enrolled zero patients. These are study-level failures, not site-level data.
- Apply the nonconforming site exclusion: permanently exclude these 7 sites from ALL recommendations: Almeida/Erie Retina Research, Duss/Pediatric Eye Consultants of N Florida, Glaser/Kids Eyecare of Maryland, Gupta/Specialty Retina Center (Coral Springs), Jackson/Jackson Eye S.C., Schecter/Pinnacle Research Institute, Sibia/Specialty Retina Center (Boynton Beach).
- PI selection rule: Lead PI is derived from the most recent First Subject In (FSI) date within the specific target indication at that site — not most studies, not alphabetical, not full Ora history.

### 3. ORA EXPERIENCE — ADJACENT INDICATIONS
If Ora has limited experience in the exact indication, identify adjacent indications that demonstrate relevant capability. The adjacency must be defensible:

- Same route of administration (e.g., IVT experience for an IVT study)
- Same patient population (e.g., DME for a nAMD study — same retina patients, same sites)
- Same assessment type (e.g., ACC grading experience for a uveitis study, even from post-op inflammation)
- Same therapeutic area (e.g., corneal experience for a NK study)

**Be explicit about what is adjacent and why.** Never present adjacent experience as direct experience.

**CRITICAL — Uveitis subtype rule:** Anterior, intermediate, posterior, and panuveitis have distinct sites, investigators, and enrollment profiles. Anterior uveitis trials must never be used as benchmarks for posterior/panuveitis studies, and vice versa. Always confirm subtype before pulling comparator data.

### 4. ENROLLMENT BENCHMARKS
This section provides the data foundation for the enrollment model. Pull from TrialHub in Context (`psm_common` / `th_actual_psm`, SFR, recruitment days) or from an uploaded Trials Search Data xlsx ("Trials (Detailed)" tab):

**How to pull PSM data:**
- Filter to the SAME indication as the study
- Filter to the SAME phase (Phase 2 benchmarks for a Phase 2 study, Phase 3 for Phase 3)
- Use the `Actual P/S/M` column — this is the real achieved enrollment rate. NOT `Planned P/S/M`, which is the sponsor's projection
- If `Actual P/S/M` is blank or shows "-", skip that study for the PSM calculation
- Exclude extreme outliers (PSM > 50 is usually a data error or a tiny single-site study)
- Report: median, mean, P25, P75, and the number of studies the benchmark is based on (n=)
- Always state the data source and sample size so the reader knows how much data backs the benchmark

**How to pull Screen Failure Rate (SFR):**
- Same filtering as PSM (indication + phase)
- Use `Screen Failure Rate (%)` column when available
- Report median SFR for the indication/phase combination
- SFR is critical for enrollment modeling — a study with 80% SFR needs 5x more screened patients than one with 50% SFR

**How to pull enrollment duration:**
- Use `Recruitment Days` column
- Convert to months (divide by 30.44)
- Report median enrollment duration for the indication/phase

**How to pull site counts:**
- Use `Actual Number Of Sites` (not Planned)
- Report median site count for the indication/phase

**What to do when TrialHub data is thin:**
If fewer than 3 studies match the exact indication + phase filter, broaden the search:
1. First, try same indication across all phases
2. Then try adjacent indications at same phase
3. Then try same therapeutic area
4. Always state when you've broadened and why

**Presenting benchmarks:**
Frame benchmarks as ranges, not single numbers. Example:
"Industry Phase 3 treatment-naive nAMD studies have achieved median PSM of 0.35 p/s/m (P25: 0.21, P75: 0.55, n=8 studies). Ora's own nAMD Phase 1 experience shows a median of 0.13 p/s/m, but Phase 1 studies are structurally different from Phase 3 pivotals in terms of site count, recruitment support, and enrollment dynamics."

Never present an assumption as a benchmark. Never round up data to make Ora look better. Always state the source.

### 5. COMPETITIVE LANDSCAPE
Search ClinicalTrials.gov for studies recruiting the same patient population. Prefer live CT.gov packs / gap-fill already in Context; use web/API only to fill gaps.

**How to search:**
- Use the CT.gov API: `https://clinicaltrials.gov/api/v2/studies?query.term=SEARCH&pageSize=50&format=json`
- Search by indication keywords (e.g., "non-infectious anterior uveitis recruiting")
- Search by drug class if relevant (e.g., "anti-VEGF wet AMD recruiting")
- Search broadly, then filter results to the specific indication

**What to capture for each competitor:**
- NCT ID
- Sponsor
- Drug name and mechanism
- Phase
- Enrollment target
- Status (Recruiting, Active Not Recruiting, Not Yet Recruiting)
- Number of US sites
- Number of sites in each relevant country
- Primary endpoint

**How to determine if a study is truly competing:**
- Same indication (with subtype specificity — anterior uveitis ≠ posterior uveitis)
- Overlapping patient population (treatment-naive vs previously treated matters enormously)
- Overlapping geographies (a China-only study doesn't compete with a US study)
- Currently recruiting or about to recruit (completed studies aren't competitors)

**Treatment-naive specific rule:** Screen-failed patients from competing treatment-naive studies receive immediate standard-of-care treatment and are permanently lost to all treatment-naive programs. Speed to consent is the only lever — not screen-fail capture. A patient who screen-fails at a competing study and receives SOC is not recruitable.

**Presenting the competitive landscape:**
- Frame as opportunity, not just risk
- Count the number of competing studies and total competing enrollment
- Count competing US sites
- Identify markets/geographies with no competition (these are the fastest enrollment path)
- Note if any competitors are at the same sites Ora would propose

### 6. SITE RECOMMENDATIONS

**Ranking methodology:**
Sites should be ranked using a blended score that weighs:
1. Indication-specific study count (highest weight)
2. Indication-specific enrollment volume
3. Site-level PSM in relevant studies
4. Total Ora relationship depth (number of Ora studies across all indications)
5. Startup velocity (time from SIV to first patient)
6. Absence of competing study at the site

**Ora site tag format:**
Use the tag "⭐ Ora · N" where N = total number of Ora studies at that site across all indications. This shows relationship depth at a glance.

**Industry sites:**
When Ora doesn't have enough sites in-network for the target indication, supplement with industry sites from CT.gov. Identify sites that have participated in the same or adjacent indication studies. Cross-reference these against Veeva to see if Ora has any relationship with them, even in different indications.

**For each site, show:**
- Site name (facility name, not PI name — the site is the entity)
- Location (city, state/country)
- Ora relationship indicator (⭐ Ora · N or dash if no relationship)
- Competing study flag (if the site is on a competing recruiting study, flag it)

**DO NOT show in sponsor-facing documents:**
- PI names (unless specifically asked)
- Enrolled patient counts (unless specifically asked)
- Ora internal study names or NCT numbers
- CT.gov as a named source — use "industry-available data" instead

### 7. SALESFORCE INTELLIGENCE
Pull from Salesforce Context (`salesforceData` / `sponsorCrosswalk` / `ora_sf_*`) to contextualize the sponsor relationship:

**Account-level:**
- Does the sponsor have an SF account? If yes: Name, Owner, Tier
- Has Ora won studies from this sponsor before? How many?
- What is the total revenue from this sponsor?
- Who owns the account (which BD rep)?

**Opportunity-level:**
- Has Ora bid on a study from this sponsor in this indication before?
- If yes: what was the outcome (Won/Lost/In Progress)?
- If lost: what was the loss reason?

**Activity-level:**
- How many outreach activities (calls, emails, meetings) in the last 12 months?
- Most recent activity date and subject

**Crosswalk matching:**
The crosswalk handles name matching only — sponsor names in TrialHub and CT.gov don't always match SF account names. Strip corporate suffixes (Inc, LLC, Ltd, GmbH, Pharmaceuticals, Therapeutics, Biosciences, etc.) before matching. If no exact match, try first-word matching for distinctive names (e.g., "Iantrek, Inc." should match "Iantrek" in SF). Owner, tier, and win data must always be pulled live from Salesforce, never assumed from the crosswalk.

### 8. ORA ASSESSMENT
This is where the SME-facing strategic narrative goes. It should cover:

1. **Can we win this?** — Based on Ora's experience, site network, and competitive position
2. **What are our win themes?** — Specific, defensible advantages (not generic)
3. **What are the risks?** — Competitive pressure, enrollment challenges, site availability
4. **What enrollment rate can we support?** — Based on benchmarks, not aspiration

**Rules for the assessment:**
- Never fabricate or assume Ora capabilities, selling points, or asset claims
- Never infer, extrapolate, or round up data to make Ora look better
- When uncertain, flag the uncertainty — don't guess
- Use "Potential Phase X follow-on" for forward-looking BD targets (not "Phase X needed")
- For recently completed studies, frame as "Sponsor may have data and may be planning next study now"
- State only confirmed facts about sites — never speculate or rationalize why a site "could have" participated in a study

---

## FORMATTING STANDARDS

**Sponsor-facing documents:**
- Teal/navy gradient color scheme (#1B2A4A navy, #1A7F8E teal)
- NOT the crimson Ora internal theme
- Segoe UI font
- #F0F4F8 background
- Rounded card-based layout with .wrap max-width 1240px
- KPI grid at top (4-5 metrics)
- Color-coded alert boxes (green for positive, amber for caution, blue for informational)
- Green header for Ora Assessment section
- No Ora study names or NCT numbers
- No CT.gov references — use "industry-available data"
- Source line: "Ora proprietary data + industry-available data"

**Internal documents:**
- Can reference Ora study names and NCT numbers
- Can reference CT.gov
- Can show enrolled counts and PSM data

---

## COMMON PITFALLS TO AVOID

1. **Mixing uveitis subtypes.** Anterior, intermediate, posterior, and pan are distinct. Always confirm before pulling data.
2. **Using zero-enrollment studies in benchmarks.** These are study-level failures, not site performance data. Exclude them.
3. **Presenting Planned PSM as Actual PSM.** Planned is the sponsor's projection. Actual is what happened. Only Actual is a valid benchmark.
4. **Assuming screen-fail capture works for treatment-naive indications.** It doesn't. Screen-fails get treated with SOC immediately and are permanently lost.
5. **Not confirming the sponsor before using a document.** Always verify the sponsor name matches.
6. **Fabricating Ora capabilities.** If you don't know if Ora can do something, say you don't know. Never invent selling points.
7. **Citing a single study as a benchmark.** One data point is an anecdote. Always report the range and sample size.
8. **Including nonconforming sites.** Check every site list against the 7-site exclusion list.
9. **Using the wrong PI.** PI is determined by the most recent FSI in the target indication, not alphabetical or by total Ora study count.
10. **Matching SF accounts by name alone without stripping suffixes.** "Iantrek, Inc." must match "Iantrek" in SF. Strip Inc, LLC, Ltd, Pharmaceuticals, Therapeutics, Biosciences, etc.
11. **Overstating the competitive landscape without thorough verification.** Search multiple keyword combinations, check for masked or renamed studies, and verify subtype and population overlap before making competitive claims.
12. **Not distinguishing between Actual and Estimated enrollment on CT.gov.** CT.gov marks enrollment as ACTUAL (study completed or enrolled) or ESTIMATED (projected). Only ACTUAL enrollment counts as demonstrated data.
13. **Using post-operative inflammation sites for uveitis studies without justification.** Post-op inflammation sites see cataract surgery patients, not uveitis patients. The assessment skills overlap (ACC grading) but the patient populations and referral patterns are different.
14. **Presenting industry site data as Ora data.** Always distinguish between "Ora has run a study at this site" (Veeva data) and "this site has participated in industry studies in this indication" (CT.gov data). They are different claims.

---

## DATA SOURCE PRIORITY

For any claim in the report, use data from these sources in priority order:

1. **Ora Veeva CTM (live Cosmos `ora_veeva_*` / indicationBenchmark)** — Site-level enrollment, PSM, startup speed. This is Ora's proprietary data and the highest-value source.
2. **TrialHub (Context packs or uploaded Trials Search Data)** — Study-level benchmarks (PSM, SFR, enrollment duration, site counts). Industry-wide data scoped to Ora's therapeutic areas.
3. **Salesforce (`salesforceData` / crosswalk)** — Sponsor relationship, win history, outreach activity, account ownership.
4. **ClinicalTrials.gov (live packs / gap-fill)** — Competitive landscape, site identification, study details, eligibility criteria.
5. **Published literature / web search** — KOL identification, mechanism of action context, market landscape. Use sparingly and only for context that can't be found in the structured data sources.

---

## TRIALHUB PSM EXTRACTION — STEP BY STEP

This is the most common failure point. Here is the exact process:

### Step 1: Open the TrialHub file
Open the Trials Search Data xlsx file. Go to the "Trials (Detailed)" tab.

### Step 2: Identify columns
Find these specific columns in the header row:
- `Indications` — the disease/condition text
- `Phase` — values like 1, 1/2, 2, 2/3, 3, 4
- `Status` — Completed, Recruiting, Active Not Recruiting, etc.
- `Actual P/S/M` — the ACTUAL patients per site per month. THIS IS THE KEY FIELD.
- `Planned P/S/M` — the sponsor's projected PSM. Secondary reference ONLY.
- `Actual Number Of Sites` — how many sites actually participated
- `Planned Number Of Sites` — how many sites were planned
- `Patients` — total enrollment count
- `Screen Failure Rate (%)` — percentage who failed screening
- `Recruitment Days` — total enrollment duration in days
- `Sponsor` — company name
- `Countries` — geographic scope

### Step 3: Filter to target indication
Search the `Indications` column for keywords matching the study's indication. Use multiple search terms:
- For wet AMD: "macular degeneration", "AMD", "neovascular", "choroidal neovascularization", "wAMD", "nAMD"
- For dry eye: "dry eye", "DED", "keratoconjunctivitis sicca"
- For glaucoma: "glaucoma", "ocular hypertension", "intraocular pressure"
- For GA: "geographic atrophy"
- Be specific about subtypes

### Step 4: Filter to target phase
Match the phase of the study you're analyzing. Phase 2 benchmarks for a Phase 2 study. Phase 3 for Phase 3. Include Phase 2/3 studies in both Phase 2 and Phase 3 analyses.

### Step 5: Extract PSM values
For every row that matches indication + phase:
- Read the `Actual P/S/M` value
- If it's blank, "-", "None", or non-numeric, SKIP it (do not count it as zero)
- If the value is > 50, it's likely a data artifact — exclude it
- Collect all valid values into a list

### Step 6: Calculate statistics
From the collected PSM values:
- **n** = count of values (this is your sample size — always report it)
- **Median** = middle value when sorted (use this as the primary benchmark)
- **Mean** = average (report alongside median)
- **P25** = value at the 25th percentile (lower quartile)
- **P75** = value at the 75th percentile (upper quartile)
- **Min and Max** = range

### Step 7: Calculate SFR and duration
Repeat the same process for `Screen Failure Rate (%)` and `Recruitment Days` using the same filtered rows.

### Step 8: Report results
Format example:
"TrialHub Phase 2 wet AMD studies (n=5) show a median Actual PSM of 0.22 p/s/m (P25: 0.13, P75: 0.41). Screen failure rate median: 51.9% (n=4 studies with SFR data). Median enrollment duration: 19.7 months (n=5)."

### Step 9: If Actual P/S/M data is unavailable
If most studies have blank Actual P/S/M, you can DERIVE an estimate:
- PSM = Patients / (Actual Number Of Sites × (Recruitment Days / 30.44))
- Label this as "derived estimate" not "actual PSM"
- State your calculation method

### Step 10: Broaden if needed
If fewer than 3 studies match your exact filters:
1. Try same indication, all phases
2. Try adjacent indications, same phase
3. Try same therapeutic area broadly
Always state when and why you broadened the filter.

---

## EXAMPLE FEASIBILITY WORKFLOW

User uploads a synopsis for "Elisigen Inc. — NG101 AAV gene therapy for wet AMD, Phase 2b, 66 patients, 15-20 sites, US + Canada."

**Step 1: Verify sponsor** — Confirm "Elisigen Inc." matches the uploaded document.

**Step 2: Extract protocol details** — Drug: NG101 (AAV8 expressing aflibercept, subretinal via vitrectomy). Previously treated wAMD. Pseudophakic only. Primary: BCVA change at Week 54. Control: Eylea 2mg q8w. N=66 (up to 87). 15-20 sites. US + Canada only.

**Step 3: Check Ora experience** — Search Veeva for: wet AMD, nAMD, neovascular AMD. Also search for: gene therapy, subretinal injection, vitrectomy-delivered therapies. This study requires surgical capability (vitrectomy) so standard IVT-only sites won't qualify. This is a critical differentiator — flag which Ora sites have vitrectomy/surgical capability.

**Step 4: Pull benchmarks** — TrialHub: filter to wet AMD + Phase 2. Pull Actual PSM, SFR, enrollment duration. Also specifically check gene therapy ophthalmology studies (Adverum ADVM-022, 4D-150, RGX-314) as these have similar surgical logistics and enrollment challenges. Gene therapy studies typically enroll slower than standard IVT studies due to surgical requirements and stricter eligibility.

**Step 5: Competitive landscape** — Search CT.gov for recruiting wet AMD gene therapy studies. These are the direct competitors for the same surgical-capable, previously-treated wAMD patient population. Standard anti-VEGF studies are NOT direct competitors since they target a different patient flow (office-based IVT vs surgical suite).

**Step 6: Site selection** — Start with Ora sites that have nAMD experience AND vitrectomy/surgical capability. Cross-reference with CT.gov to find sites that have participated in prior retina gene therapy studies (Adverum, 4D Molecular, REGENXBIO). The overlap between "Ora relationship" and "gene therapy surgical experience" is the sweet spot for this study.

**Step 7: SF intelligence** — Check if Elisigen has an SF account. Check for prior bids, wins, outreach. Check if any BD rep has had contact.

**Step 8: Assessment** — Synthesize everything into a narrative that answers: Can Ora do this study? What's our differentiator? What enrollment rate is realistic? What sites should we propose? What are the risks (surgical complexity, slow enrollment for gene therapy, strict eligibility)?
