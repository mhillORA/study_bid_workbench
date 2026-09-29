# NetSuite + Veeva in Ora Data Lens / Budget Buddy

**Updated:** 2026-09-29  
**Repos:** study_bid_workbench (+ netsuite-pull-job for SuiteQL) · Data Lens on `mhillORA.github.io` branch `ora-data-lens`

---

## What PMs + investigator-fee work both need

| Consumer | Needs |
|----------|--------|
| **PMs** | Same Excel workbooks as today — same tabs, formulas, layouts. Export must not regress. |
| **Investigator fees / Finance / Buddy** | Study + site context in Cosmos, joined to Veeva, askable (“tell me about 25-150-0005”), dashboardable. |

**Rule:** Excel is an **export**. Cosmos is the **system of record for AI + Data Lens**. Blob CSVs optional for Fabric.

---

## Project number = YY-DEPT-SEQ

`25-150-0005` → year **2025**, dept **150**, study sequence **0005**.  
Join: `ora_ns_study.project_number` ↔ `ora_veeva_study.study_number` (exact / prefix / token — no mapping table).

---

## Veeva (wired)

- Vault → Cosmos `ora_veeva_*` via `ora-buddy-api`
- Daily delta (GH Actions) + manual full/delta
- Prefer Actions for full pulls (browser CORS/timeouts)

---

## NetSuite — SuiteQL → Cosmos *and* Excel

```
SuiteQL (runs.py)
  ├─→ curated/study_reports/*.xlsx
  └─→ POST Buddy /api/netsuite/study-sync → ora_ns_study (+ optional ora_ns_task)
```

### Container Apps env (Cosmos upsert)

| Name | Value |
|------|--------|
| `BUDDY_API_BASE` or `BUDDY_STUDY_SYNC_URL` | `https://ora-buddy-api-….azurewebsites.net` |
| `BUDDY_COPILOT_KEY` or `COPILOT_ASK_KEY` | same as Buddy Copilot key |

Soft-skips if unset (`DEBUG_COSMOS_STUDY_SKIP`).

### Data Lens

Sources → Data sync status → `GET /api/sync-status`.  
Project page joins GM (`lens_ns_projects`) + study intel (`ora_ns_study`) + Veeva.

### Buddy Data Status

Refresh NetSuite study status → `GET /api/netsuite/study-sync`.

---

## CORS (why browser “lost FA connection”)

**Platform CORS** on Function App `ora-buddy-api` must allow:

- `https://white-river-0de1aed0f.7.azurestaticapps.net` (Buddy)
- `https://black-stone-03061770f.7.azurestaticapps.net` (Data Lens)

Also set app setting (comma-separated):

`BUDDY_CORS_ORIGIN=<buddy-swa>,<lens-swa>`

See `docs/buddy-claude-like-setup.md` and Data Lens `docs/CORS.md`.

---

## One-liner

**Veeva schedule + manual. SuiteQL → Excel + Cosmos. YY-DEPT-SEQ join in Lens/Buddy. Fix platform CORS on ora-buddy-api for both SWA hosts.**
