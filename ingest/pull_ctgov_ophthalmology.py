"""
ClinicalTrials.gov ophthalmology delta pull → Cosmos `ora_ctgov_trials`.

API: https://clinicaltrials.gov/api/v2/studies (public, no auth)
Docs: https://clinicaltrials.gov/data-api/api

Behavior:
  - First run (no watermark): studies with StartDate >= LOOKBACK_START (10 years).
  - Later runs: studies with LastUpdatePostDate >= lastSuccessfulSync − OVERLAP_HOURS
    (catch-up / delta; upsert by NCT).
  - Writes sync cursor to container `syncState` id=`ctgov_ophthalmology`.

Usage:
  python ingest/pull_ctgov_ophthalmology.py --dry-run
  python ingest/pull_ctgov_ophthalmology.py
  python ingest/pull_ctgov_ophthalmology.py --full   # ignore watermark; 10y backfill
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from azure.cosmos import CosmosClient, PartitionKey, exceptions
from dotenv import load_dotenv

API_BASE = "https://clinicaltrials.gov/api/v2/studies"
SYNC_ID = "ctgov_ophthalmology"
DATASET = "clinicaltrials_gov"
DOC_TYPE = "ora_ctgov_trials"
SCHEMA_VERSION = 1
PAGE_SIZE = 100
WORKERS = 6
OVERLAP_HOURS = 36
REQUEST_PAUSE_S = 0.15
USER_AGENT = "OraStudyBidWorkbench/1.0 (ctgov-delta; contact=bd-budgets)"

# Ophthalmic / Ora-relevant condition expression (Essie).
COND_QUERY = (
    "(eye diseases OR ophthalmology OR dry eye OR macular degeneration OR glaucoma OR "
    "cataract OR diabetic macular OR diabetic retinopathy OR geographic atrophy OR "
    "retinitis pigmentosa OR uveitis OR myopia OR allergic conjunctivitis OR "
    "thyroid eye OR keratoconus OR presbyopia OR blepharitis OR ocular hypertension OR "
    "retinal vein OR corneal OR conjunctivitis OR AMD OR nAMD OR neuroprotection OR "
    "optic neuropathy OR optic neuritis OR LHON OR NAION OR neurotrophic keratitis OR "
    "meibomian OR Stargardt OR macular hole OR epiretinal OR central serous OR "
    "amblyopia OR strabismus OR uveal melanoma OR ocular melanoma OR Fuchs)"
)

# Map CT.gov condition strings → Ora-ish indication labels for partition + joins.
# Order matters: more specific patterns first.
INDICATION_RULES: list[tuple[str, str]] = [
    ("neurotrophic kerat", "Neurotrophic Keratitis"),
    ("neuroprotection", "Neuroprotection"),
    ("retinal neuroprotect", "Neuroprotection"),
    ("optic nerve neuroprotect", "Neuroprotection"),
    ("leber.?s?\\s*hereditary\\s*optic", "Optic Neuropathy"),
    ("\\blhon\\b", "Optic Neuropathy"),
    ("\\bnaion\\b", "Optic Neuropathy"),
    ("non.?arteritic.*optic", "Optic Neuropathy"),
    ("optic neuritis", "Optic Neuropathy"),
    ("optic neuropath", "Optic Neuropathy"),
    ("dry eye", "Dry Eye"),
    ("keratoconjunctivitis sicca", "Dry Eye"),
    ("meibomian gland", "Meibomian Gland Dysfunction"),
    ("\\bmgd\\b", "Meibomian Gland Dysfunction"),
    ("ocular hypertension", "Glaucoma / Ocular Hypertension"),
    ("glaucoma", "Glaucoma / Ocular Hypertension"),
    ("cataract", "Cataract"),
    ("diabetic macular", "Diabetic Macular Edema (DME)"),
    ("\\bdme\\b", "Diabetic Macular Edema (DME)"),
    ("diabetic retinopathy", "Diabetic Retinopathy"),
    ("geographic atrophy", "Geographic Atrophy / Dry AMD"),
    ("dry amd", "Geographic Atrophy / Dry AMD"),
    ("wet amd", "Wet AMD"),
    ("neovascular.*macular", "Wet AMD"),
    ("age.?related macular", "Wet AMD"),
    ("macular degeneration", "Wet AMD"),
    ("central serous", "Central Serous Chorioretinopathy"),
    ("\\bcscr\\b", "Central Serous Chorioretinopathy"),
    ("epiretinal membrane", "Macular Hole / ERM"),
    ("macular hole", "Macular Hole / ERM"),
    ("\\berm\\b", "Macular Hole / ERM"),
    ("stargardt", "Inherited Retinal Disease"),
    ("leber congenital amaurosis", "Inherited Retinal Disease"),
    ("inherited retinal", "Inherited Retinal Disease"),
    ("retinitis pigmentosa", "Retinitis Pigmentosa"),
    ("presbyopia", "Presbyopia"),
    ("allergic conjunctivitis", "Allergic Conjunctivitis"),
    ("thyroid eye", "Thyroid Eye Disease"),
    ("graves.*orbit", "Thyroid Eye Disease"),
    ("pathologic myopia|myopic cnv", "Myopia"),
    ("myopia", "Myopia"),
    ("uveitis|panuveitis", "Uveitis"),
    ("blepharitis", "Blepharitis"),
    ("keratoconus", "Keratoconus"),
    ("fuchs", "Ocular Surface / Cornea"),
    ("corneal dystroph", "Ocular Surface / Cornea"),
    ("infectious keratit|bacterial keratit|fungal keratit", "Ocular Surface / Cornea"),
    ("central retinal vein|branch retinal vein|\\bcrvo\\b|\\bbrvo\\b|retinal vein occlusion", "Retinal Vein Occlusion"),
    ("uveal melanoma|ocular melanoma|choroidal melanoma", "Uveal Melanoma"),
    ("amblyopia", "Amblyopia"),
    ("strabismus", "Strabismus"),
    ("ocular redness|eye redness", "Eye Redness"),
]

FIELDS = [
    "NCTId",
    "BriefTitle",
    "OfficialTitle",
    "OverallStatus",
    "Phase",
    "StudyType",
    "StartDate",
    "PrimaryCompletionDate",
    "CompletionDate",
    "LastUpdatePostDate",
    "StudyFirstPostDate",
    "Condition",
    "InterventionName",
    "LeadSponsorName",
    "LeadSponsorClass",
    "EnrollmentCount",
    "EnrollmentType",
    "LocationCountry",
    "LocationFacility",
    "WhyStopped",
    "HasResults",
]


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def lookback_start() -> str:
    """ISO date ~10 years ago (UTC)."""
    d = datetime.now(timezone.utc) - timedelta(days=365 * 10)
    return d.strftime("%Y-%m-%d")


def get_client() -> CosmosClient:
    load_dotenv(repo_root() / ".env")
    endpoint = os.getenv("COSMOS_ENDPOINT", "").strip()
    key = os.getenv("COSMOS_KEY", "").strip()
    if not endpoint or not key or "YOUR_" in endpoint:
        print("Configure COSMOS_ENDPOINT / COSMOS_KEY in .env or env.", file=sys.stderr)
        sys.exit(1)
    return CosmosClient(endpoint, credential=key)


def get_database(client: CosmosClient):
    load_dotenv(repo_root() / ".env")
    db_name = os.getenv("COSMOS_DATABASE", "bd-budgets").strip()
    return client.create_database_if_not_exists(id=db_name), db_name


def ensure_containers(db) -> None:
    db.create_container_if_not_exists(
        id="ora_ctgov_trials",
        partition_key=PartitionKey(path="/oraIndication"),
    )
    db.create_container_if_not_exists(
        id="syncState",
        partition_key=PartitionKey(path="/id"),
    )


def http_get_json(url: str, retries: int = 4) -> dict[str, Any]:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_err = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"CT.gov request failed after {retries} tries: {last_err}")


def dig(obj: Any, *path: str, default=None):
    cur = obj
    for p in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(p)
        if cur is None:
            return default
    return cur


def as_list(v) -> list:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def map_ora_indication(conditions: list[str]) -> str:
    import re

    blob = " | ".join(conditions).lower()
    for pattern, label in INDICATION_RULES:
        if re.search(pattern, blob, flags=re.I):
            return label
    if conditions:
        # Keep a cleaned first condition (bounded)
        return str(conditions[0]).strip()[:120] or "_unknown"
    return "_unknown"


def flatten_study(raw: dict[str, Any], imported_at: str) -> dict[str, Any]:
    ps = raw.get("protocolSection") or {}
    nct = dig(ps, "identificationModule", "nctId") or ""
    conditions = as_list(dig(ps, "conditionsModule", "conditions"))
    phases = as_list(dig(ps, "designModule", "phases"))
    locations = as_list(dig(ps, "contactsLocationsModule", "locations"))
    countries = sorted(
        {str(loc.get("country")).strip() for loc in locations if isinstance(loc, dict) and loc.get("country")}
    )
    interventions = as_list(dig(ps, "armsInterventionsModule", "interventions"))
    intervention_names = [
        str(i.get("name")).strip()
        for i in interventions
        if isinstance(i, dict) and i.get("name")
    ]
    enroll = dig(ps, "designModule", "enrollmentInfo") or {}
    ora_ind = map_ora_indication([str(c) for c in conditions])

    return {
        "id": nct.upper() if nct else None,
        "nct": nct.upper() if nct else None,
        "oraIndication": ora_ind,
        "title": dig(ps, "identificationModule", "briefTitle"),
        "officialTitle": dig(ps, "identificationModule", "officialTitle"),
        "status": dig(ps, "statusModule", "overallStatus"),
        "phases": phases,
        "phase": phases[0] if phases else None,
        "studyType": dig(ps, "designModule", "studyType"),
        "startDate": dig(ps, "statusModule", "startDateStruct", "date"),
        "primaryCompletionDate": dig(ps, "statusModule", "primaryCompletionDateStruct", "date"),
        "completionDate": dig(ps, "statusModule", "completionDateStruct", "date"),
        "lastUpdatePostDate": dig(ps, "statusModule", "lastUpdatePostDateStruct", "date")
        or dig(ps, "statusModule", "statusVerifiedDate"),
        "studyFirstPostDate": dig(ps, "statusModule", "studyFirstPostDateStruct", "date"),
        "conditions": [str(c) for c in conditions],
        "interventions": intervention_names[:20],
        "sponsor": dig(ps, "sponsorCollaboratorsModule", "leadSponsor", "name"),
        "sponsorClass": dig(ps, "sponsorCollaboratorsModule", "leadSponsor", "class"),
        "enrollment": enroll.get("count"),
        "enrollmentType": enroll.get("type"),
        "countries": countries,
        "nCountries": len(countries),
        "nLocations": len(locations),
        "whyStopped": dig(ps, "statusModule", "whyStopped"),
        "hasResults": bool(raw.get("hasResults")),
        "docType": DOC_TYPE,
        "dataset": DATASET,
        "schemaVersion": SCHEMA_VERSION,
        "source": "clinicaltrials.gov/api/v2",
        "importedAt": imported_at,
    }


def build_search_url(*, advanced: str, page_token: str | None) -> str:
    params: dict[str, str] = {
        "format": "json",
        "countTotal": "true",
        "pageSize": str(PAGE_SIZE),
        "query.cond": COND_QUERY,
        "filter.advanced": advanced,
        "fields": ",".join(FIELDS),
    }
    if page_token:
        params["pageToken"] = page_token
    return f"{API_BASE}?{urllib.parse.urlencode(params)}"


def fetch_all_studies(advanced: str, *, max_pages: int | None = None) -> tuple[list[dict], int]:
    studies: list[dict] = []
    token: str | None = None
    total = 0
    page = 0
    while True:
        page += 1
        if max_pages and page > max_pages:
            break
        url = build_search_url(advanced=advanced, page_token=token)
        data = http_get_json(url)
        if page == 1:
            total = int(data.get("totalCount") or 0)
            print(f"  CT.gov totalCount={total}  filter={advanced}")
        batch = data.get("studies") or []
        studies.extend(batch)
        print(f"  page {page}: +{len(batch)} (collected {len(studies)})")
        token = data.get("nextPageToken")
        if not token or not batch:
            break
        time.sleep(REQUEST_PAUSE_S)
    return studies, total


def read_sync_state(db) -> dict[str, Any] | None:
    try:
        return db.get_container_client("syncState").read_item(item=SYNC_ID, partition_key=SYNC_ID)
    except exceptions.CosmosResourceNotFoundError:
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"  WARN: could not read syncState: {exc}")
        return None


def write_sync_state(db, doc: dict[str, Any]) -> None:
    db.get_container_client("syncState").upsert_item(doc)


def upsert_docs(db, docs: list[dict[str, Any]], *, dry_run: bool) -> dict[str, Any]:
    if dry_run:
        return {"upserted": 0, "planned": len(docs), "dryRun": True, "errors": []}
    container = db.get_container_client("ora_ctgov_trials")
    errors: list[str] = []
    done = 0

    def work(doc: dict[str, Any]) -> None:
        container.upsert_item(doc)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {pool.submit(work, d): d["id"] for d in docs}
        for fut in as_completed(futs):
            try:
                fut.result()
                done += 1
                if done % 200 == 0 or done == len(docs):
                    print(f"    upserted {done}/{len(docs)}")
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{futs[fut]}: {exc}")
                if len(errors) >= 25:
                    break
    return {"upserted": done, "planned": len(docs), "dryRun": False, "errors": errors[:25], "errorCount": len(errors)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Pull CT.gov ophthalmology studies into Cosmos")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--full", action="store_true", help="Ignore watermark; pull StartDate last 10 years")
    parser.add_argument("--max-pages", type=int, default=None, help="Safety cap on API pages")
    args = parser.parse_args()

    imported_at = datetime.now(timezone.utc).isoformat()
    client = get_client()
    db, db_name = get_database(client)
    print(f"Database: {db_name}")
    ensure_containers(db)

    state = None if args.full else read_sync_state(db)
    lookback = lookback_start()

    if state and state.get("lastSuccessfulSync") and not args.full:
        # Delta: LastUpdatePostDate since watermark − overlap
        try:
            last = datetime.fromisoformat(str(state["lastSuccessfulSync"]).replace("Z", "+00:00"))
        except ValueError:
            last = datetime.now(timezone.utc) - timedelta(days=2)
        since = (last - timedelta(hours=OVERLAP_HOURS)).strftime("%Y-%m-%d")
        advanced = f"AREA[LastUpdatePostDate]RANGE[{since},MAX]"
        mode = "delta"
        print(f"Mode: delta since {since} (watermark {state['lastSuccessfulSync']}, overlap {OVERLAP_HOURS}h)")
    else:
        advanced = f"AREA[StartDate]RANGE[{lookback},MAX]"
        mode = "full"
        print(f"Mode: full backfill StartDate>={lookback}")

    t0 = time.time()
    raw_studies, total = fetch_all_studies(advanced, max_pages=args.max_pages)
    docs: list[dict[str, Any]] = []
    skipped = 0
    for raw in raw_studies:
        doc = flatten_study(raw, imported_at)
        if not doc.get("id"):
            skipped += 1
            continue
        docs.append(doc)

    # De-dupe by NCT (keep last)
    by_id = {d["id"]: d for d in docs}
    docs = list(by_id.values())

    print(f"Prepared {len(docs)} docs (skipped {skipped}, api totalCount={total})")
    result = upsert_docs(db, docs, dry_run=args.dry_run)
    print(json.dumps(result, indent=2))

    if not args.dry_run and result.get("errorCount", 0) == 0:
        sync_doc = {
            "id": SYNC_ID,
            "docType": "syncState",
            "job": SYNC_ID,
            "source": "clinicaltrials.gov",
            "mode": mode,
            "filterAdvanced": advanced,
            "condQuery": COND_QUERY,
            "lastSuccessfulSync": imported_at,
            "lastRunAt": imported_at,
            "lastTotalCount": total,
            "lastUpserted": result.get("upserted", 0),
            "lookbackStart": lookback,
            "dataset": DATASET,
            "schemaVersion": SCHEMA_VERSION,
            "seconds": round(time.time() - t0, 2),
        }
        write_sync_state(db, sync_doc)
        print(f"Wrote syncState/{SYNC_ID}")

    out = repo_root() / "out" / "ctgov_pull_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "importedAt": imported_at,
                "mode": mode,
                "filterAdvanced": advanced,
                "apiTotalCount": total,
                "prepared": len(docs),
                "result": result,
                "seconds": round(time.time() - t0, 2),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {out}")
    return 1 if result.get("errorCount") else 0


if __name__ == "__main__":
    raise SystemExit(main())
