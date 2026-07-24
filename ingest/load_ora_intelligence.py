"""
Load Ora Clinical Intelligence JSON packs into Cosmos SQL API (bd-budgets).

Not Mongo API. Validates IDs + partition keys, sanitizes awkward field names,
upserts with docType/dataset metadata, then verifies counts.

Usage (repo root, .env with COSMOS_*):
  python ingest/load_ora_intelligence.py --dry-run
  python ingest/load_ora_intelligence.py
  python ingest/load_ora_intelligence.py --data-dir path/to/json --verify-only
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from azure.cosmos import CosmosClient, PartitionKey, exceptions
from dotenv import load_dotenv

SCHEMA_VERSION = 1
DATASET = "ora_clinical_intelligence"
SOURCE_PACK = "claude-model-files-matt-2026-07"
PK_SENTINEL = "_unknown"
WORKERS = 8

# container_id -> (json_filename, partition_field, expected_count)
COLLECTIONS: dict[str, tuple[str, str, int]] = {
    "ora_fact_site": ("ora_fact_site.json", "country", 3613),
    "ora_fact_study": ("ora_fact_study.json", "indication", 249),
    "ora_trialhub_trials": ("ora_trialhub_trials.json", "indication", 1682),
    "ora_sponsor_crosswalk": ("ora_sponsor_crosswalk.json", "crosswalk_status", 642),
    "ora_site_alias_table": ("ora_site_alias_table.json", "country", 46),
}

FIELD_RENAMES = {
    "trialhub/veeva_sponsor": "trialhub_veeva_sponsor",
    "sf_account_(inactive)": "sf_account_inactive",
    "reason_/_notes": "reason_notes",
    "create_in_sf?": "create_in_sf",
}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_data_dir() -> Path:
    root = repo_root()
    candidates = [
        root / "_inbox" / "claude-model-files",
        root / "ingest" / "data" / "ora_intelligence",
    ]
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[0]


def get_client() -> CosmosClient:
    load_dotenv(repo_root() / ".env")
    endpoint = os.getenv("COSMOS_ENDPOINT", "").strip()
    key = os.getenv("COSMOS_KEY", "").strip()
    if not endpoint or not key or "YOUR_" in endpoint or "YOUR_" in key:
        print("Configure .env with COSMOS_ENDPOINT and COSMOS_KEY.", file=sys.stderr)
        sys.exit(1)
    return CosmosClient(endpoint, credential=key)


def get_database(client: CosmosClient):
    load_dotenv(repo_root() / ".env")
    db_name = os.getenv("COSMOS_DATABASE", "bd-budgets").strip()
    return client.create_database_if_not_exists(id=db_name), db_name


def ensure_containers(db) -> None:
    for container_id, (_file, pk_field, _n) in COLLECTIONS.items():
        db.create_container_if_not_exists(
            id=container_id,
            partition_key=PartitionKey(path=f"/{pk_field}"),
        )
        print(f"  container OK: {container_id}  pk=/{pk_field}")


def sanitize_keys(row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in row.items():
        nk = FIELD_RENAMES.get(k, k)
        # Cosmos property names should be simple identifiers when possible
        if any(ch in nk for ch in "/?()"):
            nk = (
                nk.replace("/", "_")
                .replace("?", "")
                .replace("(", "")
                .replace(")", "")
                .replace("__", "_")
            )
        out[nk] = v
    return out


def pk_value(raw: Any) -> str:
    if raw is None:
        return PK_SENTINEL
    s = str(raw).strip()
    return s if s else PK_SENTINEL


def prepare_doc(
    row: dict[str, Any],
    *,
    container_id: str,
    pk_field: str,
    imported_at: str,
) -> dict[str, Any]:
    doc = sanitize_keys(row)
    if not doc.get("id"):
        raise ValueError(f"{container_id}: row missing id")
    doc[pk_field] = pk_value(doc.get(pk_field))
    doc["docType"] = container_id
    doc["dataset"] = DATASET
    doc["schemaVersion"] = SCHEMA_VERSION
    doc["sourcePack"] = SOURCE_PACK
    doc["importedAt"] = imported_at
    return doc


def load_json_array(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path.name}: expected JSON array, got {type(data).__name__}")
    return data


def validate_collection(
    container_id: str,
    rows: list[dict[str, Any]],
    pk_field: str,
    expected: int,
) -> list[str]:
    warnings: list[str] = []
    if len(rows) != expected:
        warnings.append(f"{container_id}: expected {expected} rows, found {len(rows)}")

    ids = [r.get("id") for r in rows]
    if any(not i for i in ids):
        warnings.append(f"{container_id}: {sum(1 for i in ids if not i)} missing id(s)")
    if len(set(ids)) != len(ids):
        warnings.append(f"{container_id}: duplicate ids ({len(ids) - len(set(ids))})")

    missing_pk = 0
    for r in rows:
        raw = r.get(pk_field)
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            missing_pk += 1
    if missing_pk:
        warnings.append(
            f"{container_id}: {missing_pk} row(s) missing '{pk_field}' "
            f"(will use '{PK_SENTINEL}')"
        )

    # Spot-check renamed fields exist only on crosswalk
    if container_id == "ora_sponsor_crosswalk":
        sample = sanitize_keys(rows[0])
        if "trialhub_veeva_sponsor" not in sample and "trialhub/veeva_sponsor" in rows[0]:
            warnings.append("crosswalk rename failed for trialhub_veeva_sponsor")
        if "trialhub/veeva_sponsor" in sample:
            warnings.append("slash field still present after sanitize")

    return warnings


def upsert_one(container, doc: dict[str, Any]) -> None:
    container.upsert_item(doc)


def load_collection(
    db,
    container_id: str,
    docs: list[dict[str, Any]],
    *,
    dry_run: bool,
) -> dict[str, Any]:
    t0 = time.time()
    if dry_run:
        return {
            "container": container_id,
            "upserted": 0,
            "planned": len(docs),
            "dryRun": True,
            "seconds": round(time.time() - t0, 2),
        }

    container = db.get_container_client(container_id)
    errors: list[str] = []
    done = 0

    def work(doc: dict[str, Any]) -> None:
        upsert_one(container, doc)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(work, d): d["id"] for d in docs}
        for fut in as_completed(futures):
            try:
                fut.result()
                done += 1
                if done % 250 == 0 or done == len(docs):
                    print(f"    {container_id}: {done}/{len(docs)}")
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{futures[fut]}: {exc}")
                if len(errors) > 20:
                    break

    return {
        "container": container_id,
        "upserted": done,
        "planned": len(docs),
        "errors": errors[:20],
        "errorCount": len(errors),
        "seconds": round(time.time() - t0, 2),
    }


def count_docs(db, container_id: str) -> int:
    container = db.get_container_client(container_id)
    try:
        items = list(
            container.query_items(
                query="SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
                parameters=[{"name": "@t", "value": container_id}],
                enable_cross_partition_query=True,
            )
        )
        return int(items[0]) if items else 0
    except exceptions.CosmosResourceNotFoundError:
        return -1


def verify_all(db) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for container_id, (_f, _pk, expected) in COLLECTIONS.items():
        n = count_docs(db, container_id)
        out[container_id] = {
            "count": n,
            "expected": expected,
            "ok": n == expected,
        }
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Load Ora intelligence JSON into Cosmos")
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument(
        "--only",
        nargs="*",
        choices=list(COLLECTIONS.keys()),
        help="Load only these containers",
    )
    args = parser.parse_args()

    data_dir = (args.data_dir or default_data_dir()).resolve()
    print(f"Data dir: {data_dir}")
    if not data_dir.is_dir():
        print(f"Missing data directory: {data_dir}", file=sys.stderr)
        return 1

    client = get_client()
    db, db_name = get_database(client)
    print(f"Database: {db_name}")

    if args.verify_only:
        report = verify_all(db)
        print(json.dumps(report, indent=2))
        return 0 if all(v["ok"] for v in report.values()) else 2

    print("Ensuring containers…")
    ensure_containers(db)

    imported_at = datetime.now(timezone.utc).isoformat()
    selected = args.only or list(COLLECTIONS.keys())
    all_warnings: list[str] = []
    results: list[dict[str, Any]] = []

    for container_id in selected:
        filename, pk_field, expected = COLLECTIONS[container_id]
        path = data_dir / filename
        if not path.is_file():
            print(f"MISSING file: {path}", file=sys.stderr)
            return 1
        print(f"\nPreparing {container_id} from {filename}…")
        rows = load_json_array(path)
        warnings = validate_collection(container_id, rows, pk_field, expected)
        for w in warnings:
            print(f"  WARN: {w}")
            all_warnings.append(w)

        docs = [
            prepare_doc(r, container_id=container_id, pk_field=pk_field, imported_at=imported_at)
            for r in rows
        ]
        # Confirm PK always present
        bad_pk = [d["id"] for d in docs if not d.get(pk_field)]
        if bad_pk:
            print(f"FATAL: {len(bad_pk)} docs missing PK after prepare", file=sys.stderr)
            return 1

        mode = "DRY-RUN" if args.dry_run else "UPSERT"
        print(f"  {mode} {len(docs)} docs (pk=/{pk_field})…")
        results.append(load_collection(db, container_id, docs, dry_run=args.dry_run))

    print("\n=== Load summary ===")
    print(json.dumps(results, indent=2))

    if args.dry_run:
        print("\nDry-run only — no writes. Re-run without --dry-run to load.")
        return 1 if any("FATAL" in w for w in all_warnings) else 0

    print("\nVerifying counts…")
    report = verify_all(db)
    print(json.dumps(report, indent=2))

    out_path = repo_root() / "out" / "ora_intelligence_load_report.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "importedAt": imported_at,
                "sourcePack": SOURCE_PACK,
                "dataDir": str(data_dir),
                "warnings": all_warnings,
                "results": results,
                "verify": report,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {out_path}")

    if any(r.get("errorCount", 0) for r in results):
        return 3
    if not all(v["ok"] for v in report.values()):
        print("Count mismatch — check report.", file=sys.stderr)
        return 2
    print("\nAll container counts match expected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
