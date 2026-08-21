# Ora Clinical Intelligence → Cosmos (`bd-budgets`)

**Live-first (Aug 2026):** Veeva Vault API → `ora_veeva_*` (Buddy queries these directly; site PSM from FSI→LSI milestones). Salesforce JWT → `ora_sf_*`.  
`ora_fact_*` may still exist from older projection but are **not** used for Buddy answers. Bootstrap Excel packs are legacy as data sources — keep analytical rules in Ora context files.  
See [`docs/live-data-pivot.md`](live-data-pivot.md).

App uses **Cosmos SQL/Core API** (`@azure/cosmos` / `azure.cosmos`), not Mongo API.

## What this is for (use cases)

| Ask | Source |
|-----|--------|
| How fast does Ora enroll in Dry Eye? Typical PSM? | `ora_veeva_study` / `ora_veeva_site` + `ora_veeva_milestone` (PSM = enrolled / months FSI→LSI) |
| What is industry doing? Competing / recruiting trials? | `ora_trialhub_trials` + `ora_ctgov_trials` |
| Sites / feasibility **in a country or region** | same + `country` / `region` filter |
| Is this sponsor in Salesforce? Who owns them? | `ora_sponsor_crosswalk` + `ora_sf_account` |
| Startup timelines (Selected→Contract→IRB→SIV→FSI) | `ora_veeva_milestone` (live) |
| Pipeline / opps / ARs | `ora_sf_*` |
| Budget dollars / uploaded bids | `studies` / `versions` (portfolio — not these tables) |

UI: **Data Status** — Ingest Veeva / Ingest SF / TrialHub upload / CT.gov sync.  
Buddy gets packs via `/api/ask`.

## Containers

### Live mirrors

| Container | Partition | Purpose |
|-----------|-----------|---------|
| `ora_veeva_study` | `/id` | Vault `study__v` |
| `ora_veeva_site` | `/id` | Vault `site__v` |
| `ora_veeva_organization` | `/id` | Vault `organization__v` |
| `ora_veeva_sponsor` | `/id` | Vault `sponsor__c` |
| `ora_veeva_milestone` | `/id` | Vault `milestone__v` |
| `ora_sf_account` | `/id` | SF Account |
| `ora_sf_opportunity` | `/id` | SF Opportunity |
| `ora_sf_activity_request` | `/id` | SF Activity_Request__c |

### Buddy / bridge packs

| Container | Partition key | Purpose |
|-----------|---------------|---------|
| `ora_fact_site` | `/country` | Site enrollment / PSM (live projection or legacy Excel) |
| `ora_fact_study` | `/indication` | Study rollups / PSM |
| `ora_trialhub_trials` | `/indication` | Industry trials / NCT |
| `ora_sponsor_crosswalk` | `/crosswalk_status` | TrialHub/Veeva sponsor → Salesforce |
| `ora_site_alias_table` | `/country` | Site name variants → canonical |
| `ora_veeva_milestones` | `/country` | Wide org×study startup gaps |
| `ora_ctgov_trials` | `/oraIndication` | ClinicalTrials.gov ophthalmology |
| `syncState` | `/id` | Sync watermarks |

## Joins

```
ora_fact_site.study_name  →  ora_fact_study.study_number
ora_veeva_site.study__v   →  ora_veeva_study.id
ora_fact_site.org_clean   ←  ora_site_alias_table.canonical_name
ora_veeva_study.sponsor__c → ora_veeva_sponsor → ora_sponsor_crosswalk → sf_account_id / ora_sf_account
ora_ctgov_trials.nct  ↔  ora_trialhub_trials.nct
```

## Load

**Preferred:** Data Status → **Ingest Veeva (full)** / **Ingest SF + crosswalk** (Function App `ora-buddy-api` App Settings).

Legacy Excel bootstrap (only if live empty):

```bash
python ingest/cosmos_setup.py
python ingest/load_ora_intelligence.py --dry-run
python ingest/load_ora_intelligence.py
```

## Buddy

`/api/ask` attaches `context.intelligence` for feasibility / PSM / TrialHub / CT.gov / site / NCT / region / SF / Veeva asks. System prompt includes the intelligence catalog + Ora master context (live-first bridge).

## Data quality

- High null rates on PSM / enrollment are expected Veeva gaps — never treat null as 0.
- Prefer `fsi_trust = "high"` for site PSM when present.
- TrialHub `psm_common` has extreme outliers — use **median**, not mean.
- Indication vocab differs across Ora / TrialHub / CT.gov — alias map in `api/src/intelligence.js`.
- Milestone gaps: prefer 2023+; exclude outliers >730 days; median not mean.
