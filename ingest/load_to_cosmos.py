"""Upsert a canonical parse result into Cosmos DB (no Blob)."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from azure.cosmos import CosmosClient
from dotenv import load_dotenv

from parse_ora_budget import parse_workbook, write_canonical_json


def _db():
    load_dotenv()
    endpoint = os.getenv("COSMOS_ENDPOINT", "").strip()
    key = os.getenv("COSMOS_KEY", "").strip()
    db_name = os.getenv("COSMOS_DATABASE", "bd-budgets").strip()
    if not endpoint or not key or "YOUR_" in endpoint:
        print("Configure .env with COSMOS_ENDPOINT and COSMOS_KEY first.", file=sys.stderr)
        sys.exit(1)
    client = CosmosClient(endpoint, credential=key)
    return client.get_database_client(db_name)


def upsert_canonical(canonical: dict[str, Any], job_id: str | None = None) -> dict[str, Any]:
    db = _db()
    now = datetime.now(timezone.utc).isoformat()
    study = canonical["study"]
    version = canonical["version"]
    study_id = study["studyId"]
    job_id = job_id or f"job-{study_id}-{version['sourceSha256'][:8]}"

    summary = {
        "jobId": job_id,
        "studyId": study_id,
        "confidence": canonical["confidence"],
        "quarantine": canonical["quarantine"],
        "lineItemCount": version["lineItemCount"],
        "warnings": canonical.get("warnings", []),
    }

    if canonical["quarantine"]:
        db.get_container_client("quarantine").upsert_item(
            {
                "id": f"q-{version['sourceSha256'][:16]}",
                "jobId": job_id,
                "studyId": study_id,
                "reason": canonical.get("warnings") or ["low confidence"],
                "source": canonical["source"],
                "fingerprint": canonical["fingerprint"],
                "preview": {
                    "clientName": study.get("clientName"),
                    "title": study.get("title"),
                    "protocol": study.get("protocol"),
                    "lineItemCount": version["lineItemCount"],
                },
                "createdAt": now,
            }
        )
        summary["status"] = "quarantined"
        return summary

    # Study header
    db.get_container_client("studies").upsert_item(
        {
            **study,
            "currentVersionId": version["id"],
            "updatedAt": now,
            "docType": "study",
        }
    )

    # Version (totals + exec summary; not every line)
    db.get_container_client("versions").upsert_item(
        {
            **version,
            "docType": "version",
            "confidence": canonical["confidence"],
            "profileId": canonical["profileId"],
            "source": canonical["source"],
        }
    )

    # Line items — batched upsert
    line_container = db.get_container_client("lineItems")
    for idx, item in enumerate(canonical["lineItems"]):
        line_container.upsert_item(
            {
                "id": f"{version['id']}-li-{idx}",
                "studyId": study_id,
                "versionId": version["id"],
                "docType": "lineItem",
                **item,
            }
        )

    # Seed empty section docs for dept workflow
    sections = db.get_container_client("sections")
    depts = sorted({li["department"] for li in canonical["lineItems"] if li.get("department")})
    for dept in depts:
        sections.upsert_item(
            {
                "id": f"{version['id']}-sec-{dept}",
                "studyId": study_id,
                "versionId": version["id"],
                "department": dept,
                "status": "not_started",
                "assumptions": {},
                "notes": "",
                "docType": "section",
                "updatedAt": now,
            }
        )

    # Rates as one rate card doc (fits under 2MB for ~70 resources)
    if canonical.get("rates"):
        db.get_container_client("rateCards").upsert_item(
            {
                "id": f"rates-{version['sourceSha256'][:12]}",
                "rateCardId": f"rates-{study_id}",
                "studyId": study_id,
                "versionId": version["id"],
                "docType": "rateCard",
                "rates": canonical["rates"],
                "createdAt": now,
            }
        )

    db.get_container_client("importJobs").upsert_item(
        {
            "id": job_id,
            "jobId": job_id,
            "status": "loaded",
            "studyId": study_id,
            "versionId": version["id"],
            "confidence": canonical["confidence"],
            "lineItemCount": version["lineItemCount"],
            "source": canonical["source"],
            "createdAt": now,
        }
    )

    summary["status"] = "loaded"
    summary["versionId"] = version["id"]
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description="Parse workbook and upsert into Cosmos")
    ap.add_argument("xlsx", type=Path)
    ap.add_argument("--json-out", type=Path, default=Path("out/canonical"))
    ap.add_argument("--dry-run", action="store_true", help="Parse only; do not write Cosmos")
    args = ap.parse_args()

    canonical = parse_workbook(args.xlsx)
    out = write_canonical_json(canonical, args.json_out)
    print(f"Wrote {out}")

    if args.dry_run:
        print(json.dumps({
            "dryRun": True,
            "studyId": canonical["study"]["studyId"],
            "confidence": canonical["confidence"],
            "quarantine": canonical["quarantine"],
            "lineItems": canonical["version"]["lineItemCount"],
        }, indent=2))
        return

    result = upsert_canonical(canonical)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
