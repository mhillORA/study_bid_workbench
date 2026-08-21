# Live Veeva / Salesforce pivot (files → Cosmos)

Once **Ingest Veeva** and **Ingest SF** are populated, the bootstrap Excel/JSON packs are **not** the warehouse. Keep their **rules** (in `oraMasterContext.txt` / `oraIntelligenceContext.txt`); query **live Cosmos** instead.

## What becomes obsolete as a data source

| Legacy file | Was used for | Live replacement |
|---|---|---|
| `harmonized_clinical_data.xlsx` (fact_study / fact_site) | Ora Veeva study/site PSM packs | `ora_veeva_study` / `ora_veeva_site` → projected `ora_fact_*` (`source=veeva_live`) |
| `Mike_Watson_Claude_Report__Site_Level__10Jul2026.xlsx` | Startup gaps Selected→…→FSI | `ora_veeva_milestone` → `ora_veeva_milestones` (`source=veeva_live`) |
| `sf_db_full.json` | Offline SF account list | `ora_sf_account` (+ opps / ARs) |
| SF MCP / CSV exports for pipeline | Ad-hoc CRM | `intelligence.salesforceData` from Cosmos |

Still useful (not replaced by Vault/SF API yet):

- **TrialHub** xlsx upload → `ora_trialhub_trials`
- **Sponsor crosswalk** / **site alias** Cosmo tables (name bridging rules)
- **All indication / PSM / BD copy / OUS rules** in Ora context files

## Join map preserved from the file era

```
site.study_name     → study.study_number          (live: site__v.study__v / study_name__v → study__v)
site.org_clean      ← site_alias.canonical_name   (live: organization__clin → organization__v)
study.sponsor       → crosswalk.trialhub_veeva_sponsor → sf_account_id
                      (live: sponsor__c → ora_veeva_sponsor.Name → crosswalk / ora_sf_account)
milestones          → gaps_days on org×study       (live: site-level milestone__v → wide projection)
```

## Buddy behavior

1. If `ora_veeva_study` (or SF `ora_sf_*`) counts > 0 → answer from live / `source=veeva_live`.
2. Never ask the user to re-upload Mike Watson / harmonized Excel / sf_db_full for those asks.
3. Context files still teach **how** to interpret null PSM, indication variants, crosswalk sheets, gap medians — that knowledge stays.

See also: `docs/veeva-azure-sync.md`, `docs/salesforce-azure-sync.md`.
