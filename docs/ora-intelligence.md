# Ora Clinical Intelligence → Cosmos (`bd-budgets`)

Source pack: `Claude AI Model Files for Matt.zip` (July 2026).  
App uses **Cosmos SQL/Core API** (`@azure/cosmos` / `azure.cosmos`), not Mongo API.

## Containers

| Container | Partition key | Docs | Purpose |
|-----------|---------------|------|---------|
| `ora_fact_site` | `/country` | 3,613 | Site-level enrollment / `site_psm` (Veeva) |
| `ora_fact_study` | `/indication` | 249 | Ora study rollups / `psm` |
| `ora_trialhub_trials` | `/indication` | 1,682 | Industry trials / NCT / `psm_common` |
| `ora_sponsor_crosswalk` | `/crosswalk_status` | 642 | TrialHub sponsor → Salesforce |
| `ora_site_alias_table` | `/country` | 46 | Site name variants → canonical |

Every document gets:

- `docType` — same as container id  
- `dataset` — `ora_clinical_intelligence`  
- `schemaVersion` — `1`  
- `sourcePack` — pack id  
- `importedAt` — ISO timestamp  

Null partition values are written as `"_unknown"` (4 studies missing `indication`).

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
indication (fuzzy aliases) links Ora facts ↔ TrialHub ↔ budget studies.indication
```

## Load

```bash
# from repo root, with .env COSMOS_* set
python ingest/cosmos_setup.py
python ingest/load_ora_intelligence.py --dry-run
python ingest/load_ora_intelligence.py
```

Default data dir: `_inbox/claude-model-files/` (gitignored). Override with `--data-dir`.

## Buddy

`/api/ask` attaches `context.intelligence` only when the question looks like feasibility / PSM / TrialHub / site performance / competitors, or when the open study has an indication (compact benchmark). Payloads are **summaries** (medians, counts, top rows) — not full table dumps.

## Data quality

- High null rates on PSM / enrollment are expected Veeva gaps — never treat null as 0.  
- Prefer `fsi_trust = "high"` for site PSM.  
- TrialHub `psm_common` has extreme outliers — use **median**, not mean.  
- Indication vocab differs slightly between Ora Veeva and TrialHub — alias map in `api/src/intelligence.js`.
