# Veeva Vault → Azure sync (Ora Intelligence)

Live pull of Vault Clinical objects into Cosmos on Function App **`ora-buddy-api`** (same app as Buddy / Salesforce — not a new Function App).

## App Settings (`ora-buddy-api`)

| Name | Example |
|---|---|
| `VEEVA_DNS` | `oraclinical-etmf.veevavault.com` |
| `VEEVA_USERNAME` | integration user |
| `VEEVA_PASSWORD` | *(Key Vault / App Setting — never git)* |
| `VEEVA_CLIENT_ID` | `ora-intelligence` |
| `VEEVA_API_VERSION` | `v26.1` |

## Containers (split)

### Live Vault mirrors (feasibility taxonomy)

Ora categorizes feasibility like the Mike Watson Claude Reports:

| Grain | Join | Typical filters |
|---|---|---|
| **Study level** | Study + Metrics + Milestone | Metric/Milestone study country blank; Ora Project Code set |
| **Site level** | Study Site + Metrics + Milestone | Metric/Milestone site set; Ora Project Code set |

| Cosmos | Vault object | Feasibility role |
|---|---|---|
| `ora_veeva_study` | `study__v` | Study grain |
| `ora_veeva_study_country` | `study_country__v` | Geography |
| `ora_veeva_site` | `site__v` | Site grain |
| `ora_veeva_organization` | `organization__v` | Org / PI org |
| `ora_veeva_sponsor` | `sponsor__c` | Sponsor |
| `ora_veeva_metric` | `metrics__ctms` | Enrollment metrics (enrolled, screened, rates, SF%, dropout) |
| `ora_veeva_subject` | `subject__clin` (fallback `subject__v`) | Subjects |
| `ora_veeva_milestone` | `milestone__v` | Startup / timeline milestones |

Optional `VEEVA_FEASIBILITY_FILTERS=1` narrows metric types to the report list; default is **full** pull.

### Buddy fact packs (projected from live)

| Cosmos | Notes |
|---|---|
| `ora_fact_study` | Upserts with `source=veeva_live` — preferred when live sync exists |
| `ora_fact_site` | Same |
| `ora_veeva_milestones` | Wide site×study gaps projected from live milestones (`source=veeva_live`); Mike Watson Excel rows are legacy fallback |

### Unchanged

| Cosmos | Role |
|---|---|
| `ora_sponsor_crosswalk` | TrialHub/Veeva sponsor name → SF (match Vault sponsor names) |
| `ora_site_alias_table` | Site name variants |

## API

- `GET /api/veeva/sync` — config + counts  
- `POST /api/veeva/sync` `{ "full": true }` — full pull  
- `POST /api/veeva/sync` `{}` — delta since `lastSuccessfulSync`  

UI: **Data Status → Ingest Veeva (full)**

## Schedule

GitHub Actions workflow **`intelligence-daily-sync.yml`** posts delta daily at **11:00 UTC (~6AM EST / ~7AM EDT)** to `ora-buddy-api` with `x-copilot-key` (`COPILOT_ASK_KEY` Actions secret). Manual full backfill stays in the UI / `workflow_dispatch` with `veeva_full`.

**Resume / empty mirrors:** Full ingest sorts empty containers first (metrics, milestones, subjects, …) before redoing sites. Incomplete runs do **not** advance `lastSuccessfulSync`, so history is not skipped. Re-click **Ingest Veeva (full)** until metrics/subjects/milestones show counts.

## Buddy / crosswalk behavior

- Intelligence prefers `source=veeva_live` fact rows when `ora_veeva_study` has data  
- Startup timelines prefer `ora_veeva_milestones` with `source=veeva_live`, else Mike Watson Excel  
- Catalog in `askClaude.js` documents live-first ordering  

## Note on SF App Settings

Salesforce JWT settings (`SF_*`) belong on **`ora-buddy-api`** as well. If you don’t see them there, they may only be on SWA linked config — copy/add `SF_*` onto the Function App the same way as `VEEVA_*`.

## UI routing

Data Status **Ingest Veeva / SF** calls **`ora-buddy-api`** (Buddy session JWT), not the SWA managed API — so App Settings must be on the Function App. SWA alone will show “not configured” even when FA has `VEEVA_*`.
