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

### Live Vault mirrors (canonical)

| Cosmos | Vault object |
|---|---|
| `ora_veeva_study` | `study__v` |
| `ora_veeva_site` | `site__v` |
| `ora_veeva_organization` | `organization__v` |
| `ora_veeva_sponsor` | `sponsor__c` |
| `ora_veeva_milestone` | `milestone__v` (~100k) |

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

## Buddy / crosswalk behavior

- Intelligence prefers `source=veeva_live` fact rows when `ora_veeva_study` has data  
- Startup timelines prefer `ora_veeva_milestones` with `source=veeva_live`, else Mike Watson Excel  
- Catalog in `askClaude.js` documents live-first ordering  

## Note on SF App Settings

Salesforce JWT settings (`SF_*`) belong on **`ora-buddy-api`** as well. If you don’t see them there, they may only be on SWA linked config — copy/add `SF_*` onto the Function App the same way as `VEEVA_*`.
