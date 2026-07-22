"""Bulk-normalize a folder (or zip) of budget workbooks → JSON + optional Cosmos load."""

from __future__ import annotations

import argparse
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from parse_ora_budget import parse_workbook, write_canonical_json


def iter_xlsx(input_path: Path, extract_dir: Path) -> list[Path]:
    input_path = Path(input_path)
    files: list[Path] = []
    if input_path.is_file() and input_path.suffix.lower() == ".zip":
        extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(input_path, "r") as zf:
            zf.extractall(extract_dir)
        files = sorted(extract_dir.rglob("*.xlsx"))
    elif input_path.is_file() and input_path.suffix.lower() == ".xlsx":
        files = [input_path]
    elif input_path.is_dir():
        files = sorted(input_path.rglob("*.xlsx"))
    else:
        raise FileNotFoundError(f"No xlsx/zip found at {input_path}")
    # skip Excel lock files
    return [f for f in files if not f.name.startswith("~$")]


def main() -> None:
    ap = argparse.ArgumentParser(description="Bulk parse budget workbooks")
    ap.add_argument("input", type=Path, help="Folder, .xlsx, or .zip")
    ap.add_argument("--out", type=Path, default=Path("out/bulk"))
    ap.add_argument("--to-cosmos", action="store_true", help="Upsert successful parses into Cosmos")
    ap.add_argument("--limit", type=int, default=0, help="Only process first N files (0 = all)")
    args = ap.parse_args()

    extract_dir = args.out / "_extracted"
    files = iter_xlsx(args.input, extract_dir)
    if args.limit > 0:
        files = files[: args.limit]

    if args.to_cosmos:
        from load_to_cosmos import upsert_canonical

    job_id = f"bulk-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    report = {
        "jobId": job_id,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "input": str(args.input),
        "totalFiles": len(files),
        "loaded": [],
        "quarantined": [],
        "failed": [],
    }

    canonical_dir = args.out / "canonical"
    for path in files:
        try:
            canonical = parse_workbook(path)
            write_canonical_json(canonical, canonical_dir)
            entry = {
                "file": path.name,
                "studyId": canonical["study"]["studyId"],
                "confidence": canonical["confidence"],
                "lineItems": canonical["version"]["lineItemCount"],
                "warnings": canonical["warnings"],
            }
            if args.to_cosmos:
                summary = upsert_canonical(canonical, job_id=job_id)
                entry["cosmosStatus"] = summary["status"]
                if summary["status"] == "quarantined":
                    report["quarantined"].append(entry)
                else:
                    report["loaded"].append(entry)
            else:
                if canonical["quarantine"]:
                    report["quarantined"].append(entry)
                else:
                    report["loaded"].append(entry)
            print(f"OK  {path.name}  study={entry['studyId']}  conf={entry['confidence']}")
        except Exception as exc:  # noqa: BLE001 - collect and continue for bulk
            fail = {"file": str(path), "error": str(exc)}
            report["failed"].append(fail)
            print(f"FAIL {path.name}: {exc}")

    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    report["counts"] = {
        "loaded": len(report["loaded"]),
        "quarantined": len(report["quarantined"]),
        "failed": len(report["failed"]),
    }
    args.out.mkdir(parents=True, exist_ok=True)
    report_path = args.out / f"{job_id}_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report["counts"], indent=2))
    print(f"Report: {report_path}")


if __name__ == "__main__":
    main()
