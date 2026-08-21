# Veeva Vault admin request — Ora Intelligence (Azure / Buddy)

**Purpose:** Enable a **one-time full extract** of Ora’s Veeva clinical data into Azure Cosmos, then **ongoing deltas** (changed + net-new records only). Same pattern we use for Salesforce (full pull → watermark → incremental).

**Consuming system:** Ora Intelligence / Buddy (Azure Static Web App + Function App + Cosmos `bd-budgets`). Read-only. No writes back to Veeva.

**Owner (requestor):** Matt / BD Intelligence  
**Status:** Draft for Veeva admin review

---

## Email you can send

**Subject:** API access for Ora Intelligence — full extract + daily deltas (read-only)

Hi —

We’re wiring **Ora Intelligence / Buddy** to Azure the same way we did Salesforce: one big read-only pull of core clinical objects, then incremental syncs for updates and net-new rows.

Today we load Veeva-derived tables from periodic Excel/JSON exports (`ora_fact_study`, `ora_fact_site`, site milestones). We want a supported Vault API (or scheduled extract) instead so data stays current without manual dumps.

Please help us with the items below. Happy to start in **sandbox**, then promote the same integration user / app to production.

Thanks

---

## 1. Confirm product / Vault

Please confirm which Vault(s) hold the source of truth for:

| Business data we use today | Likely Vault area (confirm) |
|---|---|
| Studies (study #, sponsor, indication, phase, lifecycle, enrollment / PSM rollups) | Clinical Operations / CTMS |
| Site × study performance (org, country, enrollment, site PSM, FSI trust) | Study sites / organizations |
| Startup milestones (Selected, Contract, IRB, SIV, FSI dates) | Site / study milestones (today from Mike Watson “Site Level” report) |

We need:

- [ ] Vault DNS / name (prod + sandbox), e.g. `https://xxxx.veevavault.com`
- [ ] Confirmation this is **Vault Clinical Operations** (or which product if different)
- [ ] Preferred integration path: **Vault API** (preferred) vs scheduled **report / Data Loader / Vault Loader** extract to Azure Blob

---

## 2. Integration identity (read-only)

Please create (or designate):

| Item | Notes |
|---|---|
| Integration user | Dedicated service account (not a personal login), e.g. `bd-intelligence-veeva@…` |
| License / permission profile | API-enabled, **read-only** on objects below |
| Auth method | OAuth 2.0 client credentials **or** Vault-supported connected-app / JWT pattern suitable for Azure App Settings (server-to-server, no interactive login) |
| Client ID / secret (or cert) | Shared via secure channel; we store in Azure App Settings / Key Vault |
| IP allowlisting | If required — we will provide Azure Function App outbound IPs |
| Sandbox first | Same config in sandbox for dry-run full pull |

**We will not** create/update/delete records in Veeva.

---

## 3. Objects & fields (what we need to ingest)

Exact **object and field API names** (`*_v` / custom) may differ by Vault config — please map our business fields to Vault API names (or point us at describe/docs for the integration user).

### A. Study (maps → Cosmos `ora_fact_study`)

| Business field | Why |
|---|---|
| Stable study Id (Vault id) | Upsert key / delta watermark join |
| Study number / study name | Join to sites (`study_name` ↔ `study_number`) |
| Sponsor / client name | Crosswalk → Salesforce |
| Indication / therapeutic area | Feasibility filters |
| Phase | Feasibility / BD |
| Lifecycle / status | Active vs closed |
| Countries (list or related) | Geo filters |
| Enrollment rollups if available: total enrolled, enroll months, study PSM / rate pt-mo, screen-fail rate, # contributing sites | Buddy / Intelligence medians |

### B. Study site / organization (maps → Cosmos `ora_fact_site`)

| Business field | Why |
|---|---|
| Stable site×study Id | Upsert key |
| Study reference (id + study number) | Join to study |
| Organization / site name (raw) | Alias → `org_clean` |
| Country | Partition / geo |
| Indication (if stored at site row) | Filters |
| Site enrollment metrics: enrolled, enroll months, site PSM, screen-fail | Site slate / PSM |
| FSI / first-subject trust or equivalent quality flag | Prefer “high” trust rows |
| Last modified timestamp | **Delta sync** |

### C. Startup milestones (maps → Cosmos `ora_veeva_milestones`)

Prefer API objects over Excel if they exist. If not, a **repeatable Vault report** with the same columns as the Mike Watson Site Level export is acceptable.

| Milestone / date | Why |
|---|---|
| Organization + study | Join key |
| Country | Partition |
| Selected / awarded (or equivalent) | Gap start |
| Contract executed | Gaps |
| IRB / EC approval | Gaps |
| SIV | Gaps |
| FSI / FPI | Gaps |
| Last modified | Deltas |

We compute gap days in Azure (`selected→contract`, `contract→IRB`, `IRB→SIV`, `SIV→FSI`, etc.).

### D. Optional later (not required for v1)

- Subjects / enrollment events (if study/site rollups are incomplete)
- Document metadata only if needed for audit — **not** document binaries

---

## 4. Sync pattern we will implement

| Phase | Behavior |
|---|---|
| **Initial full pull** | Query all readable Study / StudySite / Milestone records (paged). Load into Cosmos. |
| **Ongoing deltas** | Poll `modified_date__v` (or Vault equivalent) **> lastSuccessfulSync** watermark stored in Azure `syncState`. Upsert changed + net-new only. |
| **Deletes / inactivate** | Prefer soft status if Vault soft-deletes; otherwise document how inactivated sites/studies appear so we can mark inactive in Cosmos. |
| **Cadence** | Daily (or every few hours) via Azure Function — similar to our CT.gov / SF jobs. |
| **Crosswalk** | After ingest, join sponsor names → existing `ora_sponsor_crosswalk` / Salesforce (already live). |

Please confirm:

- [ ] Which field is the authoritative **last modified** for each object
- [ ] Max page size / rate limits for bulk query
- [ ] Whether **VQL** (or REST query) can filter `WHERE modified_date__v > '{watermark}'`
- [ ] Any object that **cannot** be queried via API and must stay on report extract

---

## 5. Deliverables from admin (checklist)

- [ ] Prod + sandbox Vault URLs  
- [ ] Integration user username (and confirmation it can log in / API)  
- [ ] OAuth / connected app credentials (client id + secret or cert instructions)  
- [ ] Permission set / profile name used  
- [ ] Object API names for Study, Study Site, Organization, Milestone (as applicable)  
- [ ] Field map (spreadsheet OK) for the business fields in §3  
- [ ] Sample VQL (or REST) for: (1) full Study page, (2) delta since a timestamp  
- [ ] Note on milestone source: **native objects** vs **named report** to schedule  
- [ ] Rate-limit / concurrency guidance  
- [ ] Security / DPA notes if any (data stays in Ora Azure tenant)

---

## 6. What we already have (context)

Cosmos already holds curated Veeva-derived packs from offline loads:

| Cosmos container | ~rows | Role |
|---|---|---|
| `ora_fact_study` | ~249 | Study rollups / PSM |
| `ora_fact_site` | ~3,613 | Site × study performance |
| `ora_veeva_milestones` | ~1,920 | Startup dates / gaps (Mike Watson Site Level) |
| `ora_sponsor_crosswalk` | ~642 | Veeva/TrialHub sponsor → Salesforce |

Goal is to **replace manual refresh** of those packs with Vault-backed full + delta sync, then keep joining to Salesforce as we do today.

---

## 7. Out of scope (for this request)

- Writing data back to Veeva  
- Vault UI customization  
- Full subject-level PHI beyond what’s already used in aggregate enrollment metrics — if subject-level is required for rollups, please flag and we will scope minimization  

---

## Reply template (for admin)

```
Vault product: _______________
Prod URL: _______________
Sandbox URL: _______________
Auth: [ ] OAuth client credentials  [ ] Other: _______________
Integration user: _______________
Objects for v1: Study=___  StudySite=___  Org=___  Milestone=___ / Report=___
Delta field: _______________
Sample VQL attached: [ ] Yes
Milestones via API: [ ] Yes  [ ] Report only (name: _______)
```
