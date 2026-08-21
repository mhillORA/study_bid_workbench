# Live Veeva / Salesforce pivot (files → Cosmos)

Once **Ingest Veeva** and **Ingest SF** are populated, the bootstrap Excel/JSON packs are **not** the warehouse. Keep their **rules** (in `oraMasterContext.txt` / `oraIntelligenceContext.txt`); query **live Cosmos** instead.

## What becomes obsolete as a data source

| Legacy file | Was used for | Live replacement |
|---|---|---|
| `harmonized_clinical_data.xlsx` (fact_study / fact_site) | Ora Veeva study/site PSM packs | `ora_veeva_study` / `ora_veeva_site` + milestone PSM (`ora_veeva_milestone`) — Buddy does **not** query `ora_fact_*` |
| Site Level Excel milestone dumps | Startup gaps Selected→…→FSI | `ora_veeva_milestone` (computed live for Buddy) |
| `sf_db_full.json` | Offline SF account list | `ora_sf_account` (+ opps / ARs) |
| SF MCP / CSV exports for pipeline | Ad-hoc CRM | `intelligence.salesforceData` from Cosmos |

Still useful (not replaced by Vault/SF API yet):

- **TrialHub** xlsx upload → `ora_trialhub_trials`
- **Sponsor crosswalk** / **site alias** Cosmo tables (name bridging rules)
- **All indication / PSM / BD copy / OUS rules** in Ora context files

## Join map (live)

```
site.study__v / study_name__v → study.id / name__v
site.organization__clin      → organization__v (+ site_alias)
study.sponsor__c             → sponsor → crosswalk → sf_account_id
milestones                   → FSI/LSI for site_psm; Selected→…→FSI startup gaps
```

## Buddy behavior

1. If `ora_veeva_study` / `ora_veeva_site` counts > 0 → answer from live mirrors (+ milestone PSM).
2. Never ask the user to re-upload Site Level / harmonized Excel / sf_db_full for those asks.
3. Context files teach **how** to interpret null PSM, indication variants, crosswalk, gap medians — that knowledge stays.

See also: `docs/veeva-azure-sync.md`, `docs/salesforce-azure-sync.md`.
