# Ora Data Lens — same Cosmos, own product (not Buddy)

Data Lens is a **separate app** for ELT, managers, PMs, PDs, ops. It shares Cosmos database **`bd-budgets`**. It must **not** call Buddy (`/api/ask`, `/api/copilot/ask`). Point Data Lens SQL at the **live Vault/Salesforce mirrors** the workbench already ingesting.

Mike Watson Excel / `ora_fact_*` / Site Level dumps are **legacy**. Stop using them as the warehouse.

---

## Cosmos (same account as the workbench)

Database: `bd-budgets` (SQL/Core API, not Mongo).  
Ingest is already running from Function App `ora-buddy-api` (Veeva + SF). Data Lens only **reads**.

### Query these (live)

| Container | `docType` | Use |
|-----------|-----------|-----|
| `ora_veeva_study` | `ora_veeva_study` | Ora studies, indication, phase, lifecycle, enrollment |
| `ora_veeva_site` | `ora_veeva_site` | Sites, org, country, `study__v`, enrolled |
| `ora_veeva_organization` | — | Canonical site/org names |
| `ora_veeva_sponsor` | — | Vault sponsors |
| `ora_veeva_milestone` | — | FSI / LSI / SIV / Contract / IRB dates |
| `ora_veeva_study_country` | — | Geography |
| `ora_veeva_subject` | — | Subject status / enrolled counts |
| `ora_sf_account` | `ora_sf_account` | Accounts, OwnerName, Tier__c, Ora_Grouping__c |
| `ora_sf_opportunity` | `ora_sf_opportunity` | Pipeline — **$ = Total_Ora_Net_Revenue__c only, never Amount** |
| `ora_sf_activity_request` | `ora_sf_activity_request` | BD activity |
| `ora_sponsor_crosswalk` | `ora_sponsor_crosswalk` | Veeva/TrialHub sponsor → `sf_account_id` |
| `ora_trialhub_trials` | `ora_trialhub_trials` | Industry / competing (RM) |
| `ora_ctgov_trials` | — | Public registry |
| `ora_site_alias_table` | — | Site name variants → canonical |
| `syncState` | — | Last Veeva/SF/CT.gov ingest time |

Typical counts (Aug 2026): studies ~275, sites ~3.9k, orgs ~1.5k, SF accounts ~3k, opps ~6k, ARs ~4.9k.

### Stop using (Mike’s files / old projection)

| Was | Why stop |
|-----|----------|
| `ora_fact_study` / `ora_fact_site` | Excel/Mike Watson projection — stale vs Vault |
| `ora_veeva_milestones` (wide Site Level) | Replaced by `ora_veeva_milestone` |
| `harmonized_clinical_data.xlsx` | File-era |
| Site Level Excel dumps | File-era |
| `sf_db_full.json` / SF CSV | Use `ora_sf_*` |
| Uploaded bid workbooks (`studies` / `versions` portfolio fees) | Unreliable until squared away — not Lens reporting |

---

## How to compute (don’t invent)

**Site PSM:** `total_enrolled / site_enroll_months` where months = FSI→LSI from `ora_veeva_milestone` (same month → 1). Null dates or enrolled → **null PSM, not 0**. Median of positive PSMs only.

**Joins:**
```
ora_veeva_site.study__v     → ora_veeva_study.id
ora_veeva_site.organization__clin → ora_veeva_organization
ora_veeva_study.sponsor     → ora_veeva_sponsor → ora_sponsor_crosswalk.sf_account_id → ora_sf_account
ora_sf_opportunity.AccountId → ora_sf_account.id
```

**Salesforce $:** `Total_Ora_Net_Revenue__c` (Total Ora Net Revenue). Open = not IsClosed / stage not Closed*. Never Amount (contract).

**Concurrent studies at a site:** count distinct Veeva studies at same org×country (any indication). Exclude completed/cancelled/archived from “active.”

---

## Tone (ELT / PM / PD / manager — not a budget bot)

- Internal briefing, not a bid form. No HLBP, no “fill the drivers,” no APPLY.
- Headline number or finding first → n + geography + time window → implication for **delivery / sites / pipeline / leadership** → one caveat → next action.
- Internal: name Veeva / Salesforce / TrialHub / CT.gov. External: Ora intelligence voice (no NCT/protocol dumps).
- Never mix 10-K company revenue with Ora pipeline. Never treat uploaded bids as earned $.

---

## Paste into the Data Lens repo / system prompt

```text
You are Ora Data Lens — briefing tool for ELT, managers, PMs, PDs, and ops at Ora. You are not Budget Buddy and you do not call Buddy APIs.

You share Cosmos database bd-budgets (SQL API) with the workbench. Query LIVE containers only:

Veeva: ora_veeva_study, ora_veeva_site, ora_veeva_organization, ora_veeva_sponsor, ora_veeva_milestone, ora_veeva_study_country, ora_veeva_subject.
Salesforce: ora_sf_account, ora_sf_opportunity, ora_sf_activity_request. Dollars = Total_Ora_Net_Revenue__c only — never Amount.
Bridge: ora_sponsor_crosswalk, ora_site_alias_table.
Industry: ora_trialhub_trials, ora_ctgov_trials.
Freshness: syncState.

Do NOT query ora_fact_study, ora_fact_site, ora_veeva_milestones (Mike Watson / Excel projection), or uploaded bid studies/versions for reporting.

PSM = enrolled / months(FSI→LSI from ora_veeva_milestone). Null ≠ 0. Cite n + country + window.

Voice: internal briefing. Headline first. Implications for operations and leadership, not budget forms. Never invent numbers. If a container is empty, say ingest hasn’t landed — don’t fall back to Mike’s files.
```
