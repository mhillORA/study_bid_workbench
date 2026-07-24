# Ora Clinical Intelligence → Cosmos (`bd-budgets`)

Source pack: `Claude AI Model Files for Matt.zip` (July 2026) + ClinicalTrials.gov daily feed.  
App uses **Cosmos SQL/Core API** (`@azure/cosmos` / `azure.cosmos`), not Mongo API.

## What this is for (use cases)

| Ask | Source |
|-----|--------|
| How fast does Ora enroll in Dry Eye? Typical PSM? | `ora_fact_study` / `ora_fact_site` |
| What is industry doing? Competing / recruiting trials? | `ora_trialhub_trials` + `ora_ctgov_trials` |
| Is this sponsor in Salesforce? Who owns them? | `ora_sponsor_crosswalk` |
| Which sites perform for an indication? | `ora_fact_site` (+ aliases) |
| Budget dollars / uploaded bids | `studies` / `versions` (portfolio — not these tables) |

UI tab: **Ora Clinical Intelligence**. Buddy gets summaries via `context.intelligence` (never full table dumps).

## Containers

| Container | Partition key | Docs | Purpose |
|-----------|---------------|------|---------|
| `ora_fact_site` | `/country` | 3,613 | Site-level enrollment / `site_psm` (Veeva) |
| `ora_fact_study` | `/indication` | 249 | Ora study rollups / `psm` |
| `ora_trialhub_trials` | `/indication` | 1,682 | Industry trials / NCT / `psm_common` |
| `ora_sponsor_crosswalk` | `/crosswalk_status` | 642 | TrialHub sponsor → Salesforce |
| `ora_site_alias_table` | `/country` | 46 | Site name variants → canonical |
| `ora_ctgov_trials` | `/oraIndication` | growing | ClinicalTrials.gov ophthalmology (daily delta) |
| `syncState` | `/id` | cursors | Watermarks (e.g. `ctgov_ophthalmology`) |

Every reference document gets:

- `docType` — same as container id  
- `dataset` — `ora_clinical_intelligence` or `clinicaltrials_gov`  
- `schemaVersion` — `1`  
- `importedAt` — ISO timestamp  

Null partition values are written as `"_unknown"`.

## Field renames (crosswalk)

| Source JSON | Cosmos field |
|-------------|--------------|
| `trialhub/veeva_sponsor` | `trialhub_veeva_sponsor` |
| `sf_account_(inactive)` | `sf_account_inactive` |
| `reason_/_notes` | `reason_notes` |
| `create_in_sf?` | `create_in_sf` |

## Joins

```
ora_fact_site.study_name  →  ora_fact_study.study_number
ora_fact_site.org_clean   ←  ora_site_alias_table.canonical_name
ora_trialhub_trials.sponsor  →  ora_sponsor_crosswalk.trialhub_veeva_sponsor  →  sf_account_id
ora_ctgov_trials.nct  ↔  ora_trialhub_trials.nct
indication / oraIndication (aliases) links Ora ↔ TrialHub ↔ CT.gov ↔ budget studies.indication
```

## Load (Veeva + TrialHub pack)

```bash
python ingest/cosmos_setup.py
python ingest/load_ora_intelligence.py --dry-run
python ingest/load_ora_intelligence.py
```

Default data dir: `_inbox/claude-model-files/` (gitignored).

## ClinicalTrials.gov daily delta (~5AM Eastern)

```bash
# First / backfill (StartDate last 10 years) — uses local .env COSMOS_*
python ingest/pull_ctgov_ophthalmology.py --full

# Incremental (LastUpdatePostDate since watermark − 36h)
python ingest/pull_ctgov_ophthalmology.py
```

GitHub Actions: `.github/workflows/ctgov-daily-delta.yml`  
Cron: `0 9 * * *` UTC ≈ **05:00 America/New_York (EDT)**.

**Secrets note:** SWA App Settings already hold Cosmos for the live API. The daily Actions job runs on a separate GitHub runner, so add the *same* values as repo secrets: `COSMOS_ENDPOINT`, `COSMOS_KEY`, optional `COSMOS_DATABASE`. Local/manual pulls use `.env` and do not need GitHub secrets.

API: https://clinicaltrials.gov/data-api/api (`/api/v2/studies`).

## Buddy

`/api/ask` attaches `context.intelligence` for feasibility / PSM / TrialHub / CT.gov / site / NCT asks (or when the open study has an indication). System prompt always includes the intelligence data catalog (even if `BUDDY_SYSTEM_PROMPT` is overridden in SWA).

## Data quality

- High null rates on PSM / enrollment are expected Veeva gaps — never treat null as 0.  
- Prefer `fsi_trust = "high"` for site PSM.  
- TrialHub `psm_common` has extreme outliers — use **median**, not mean.  
- Indication vocab differs across Ora / TrialHub / CT.gov — alias map in `api/src/intelligence.js`.
