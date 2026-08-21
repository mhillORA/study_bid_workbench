# Ora Clinical Intelligence → Cosmos (`bd-budgets`)

Source pack: `Claude AI Model Files for Matt.zip` (July 2026) + ClinicalTrials.gov feed.  
App uses **Cosmos SQL/Core API** (`@azure/cosmos` / `azure.cosmos`), not Mongo API.

## What this is for (use cases)

| Ask | Source |
|-----|--------|
| How fast does Ora enroll in Dry Eye? Typical PSM? | `ora_fact_study` / `ora_fact_site` |
| What is industry doing? Competing / recruiting trials? | `ora_trialhub_trials` + `ora_ctgov_trials` |
| Sites / feasibility **in a country or region** | same tables + `country` / `region` filter |
| Is this sponsor in Salesforce? Who owns them? | `ora_sponsor_crosswalk` |
| Startup timelines (Selected→Contract→IRB→SIV→FSI) | `ora_veeva_milestones` |
| Budget dollars / uploaded bids | `studies` / `versions` (portfolio — not these tables) |

UI tab: **Ora Clinical Intelligence** — indication + **country/region** inputs, CT.gov **Sync now** button.  
Buddy gets the same pack via `/api/ask` (`intelligenceHint` / on-screen pack).

## Containers

| Container | Partition key | Docs | Purpose |
|-----------|---------------|------|---------|
| `ora_fact_site` | `/country` | 3,613 | Site-level enrollment / `site_psm` (Veeva) |
| `ora_fact_study` | `/indication` | 249 | Ora study rollups / `psm` |
| `ora_trialhub_trials` | `/indication` | 1,682 | Industry trials / NCT / `psm_common` |
| `ora_sponsor_crosswalk` | `/crosswalk_status` | 642 | TrialHub sponsor → Salesforce |
| `ora_site_alias_table` | `/country` | 46 | Site name variants → canonical |
| `ora_veeva_milestones` | `/country` | 1,920 | Wide org×study Veeva milestones + gaps (Mike Watson Site Level 10Jul2026) |
| `ora_ctgov_trials` | `/oraIndication` | growing | ClinicalTrials.gov ophthalmology (app delta) |
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

## ClinicalTrials.gov sync (Mon–Fri ~9AM Eastern)

**Preferred:** app API uses SWA App Settings (Cosmos already there).

```http
POST /api/ctgov/sync
Header: x-copilot-key: <COPILOT_ASK_KEY>
Body: {"full":false}
```

- Signed-in users can click **Sync CT.gov now** on the Intelligence tab (no key in browser).
- GitHub Actions `.github/workflows/ctgov-daily-delta.yml` only **HTTP-pings** that endpoint (cron `0 13 * * 1-5` ≈ 9AM EDT). Needs Actions secret `COPILOT_ASK_KEY` (same as SWA). Optional `CTGOV_SYNC_URL`.

**Full 10y backfill** (too large for the web API):

```bash
python ingest/pull_ctgov_ophthalmology.py --full
```

API: https://clinicaltrials.gov/data-api/api (`/api/v2/studies`).

## Buddy

`/api/ask` attaches `context.intelligence` for feasibility / PSM / TrialHub / CT.gov / site / NCT / region asks (or when the open study has an indication, or the Intelligence tab hint/pack is sent). System prompt always includes the intelligence data catalog (even if `BUDDY_SYSTEM_PROMPT` is overridden in SWA).

Model = SWA `AZURE_OPENAI_DEPLOYMENT` (Foundry **deployment name**). `/api/health` → `llm.deployment` shows what is live.

## Data quality

- High null rates on PSM / enrollment are expected Veeva gaps — never treat null as 0.  
- Prefer `fsi_trust = "high"` for site PSM.  
- TrialHub `psm_common` has extreme outliers — use **median**, not mean.  
- Indication vocab differs across Ora / TrialHub / CT.gov — alias map in `api/src/intelligence.js`.
