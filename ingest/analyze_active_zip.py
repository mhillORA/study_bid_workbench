"""Analyze active-studies zip: aliases, parse coverage, upload plan."""

from __future__ import annotations

import json
import warnings
from collections import Counter, defaultdict
from pathlib import Path

warnings.filterwarnings("ignore")

import openpyxl

from parse_ora_budget import parse_workbook

ROOT = Path(__file__).resolve().parents[1]
FP = ROOT / "out" / "active_studies_fingerprint.json"
RAW = ROOT / "out" / "active_studies_raw"

ALIASES = {
    "Input Tab": [
        "Input Tab",
        "Main Specifications Required",
        "Study Specs",
    ],
    "Internal Budget": [
        "Internal Budget",
        "Study Budget",
        "RFP_Budget",
        "Budget",
        "Cost Breakdown",
        "Detailed Breakdown",
        "CNGB-001 Cost Breakdown",
    ],
    "Exec Sum": [
        "Exec Sum",
        "Study Economics (2)",
        "Study Economics",
        "Executive Summary",
    ],
    "Key": ["Key"],
    "Client Budget": [
        "Client Budget",
        "Client Budget - Pricing Request",
    ],
}


def resolve(sheets: list[str]) -> dict[str, str]:
    has = set(sheets)
    mapped: dict[str, str] = {}
    for canon, opts in ALIASES.items():
        for opt in opts:
            if opt in has:
                mapped[canon] = opt
                break
    # fuzzy Cost Breakdown
    if "Internal Budget" not in mapped:
        for s in sheets:
            if "cost breakdown" in s.lower() or s.lower() == "internal budget":
                mapped["Internal Budget"] = s
                break
    return mapped


def main() -> None:
    results = json.loads(FP.read_text(encoding="utf-8"))

    all_sheets: Counter[str] = Counter()
    for r in results:
        for s in r.get("sheets") or []:
            all_sheets[s] += 1

    print("TOP SHEETS:")
    for s, c in all_sheets.most_common(35):
        print(f"{c:3d}  {s}")

    improved: Counter[str] = Counter()
    hard = []
    for r in results:
        if r["status"] != "ok":
            improved[r["status"]] += 1
            continue
        m = resolve(r["sheets"])
        r["aliasMap"] = m
        if {"Input Tab", "Internal Budget", "Exec Sum"} <= m.keys():
            improved["alias_full_core"] += 1
            r["uploadTier"] = "A_auto"
        elif {"Input Tab", "Internal Budget"} <= m.keys():
            improved["alias_input_internal"] += 1
            r["uploadTier"] = "B_auto_no_exec"
        elif "Internal Budget" in m:
            improved["alias_internal_only"] += 1
            r["uploadTier"] = "C_partial"
        elif "Input Tab" in m:
            improved["alias_input_only"] += 1
            r["uploadTier"] = "C_partial"
        else:
            improved["still_hard"] += 1
            r["uploadTier"] = "D_manual_or_new_profile"
            hard.append(r)

    print("\nWITH_ALIASES", dict(improved))
    print("STILL_HARD", len(hard))
    for r in hard[:15]:
        print("-", r["file"][:90])
        print("  sheets:", (r.get("sheets") or [])[:10])

    # Parse with current strict profile on all readable xlsx
    print("\n=== CURRENT PARSER (strict sheet names) ===")
    parse_stats: Counter[str] = Counter()
    parse_rows = []
    files = {p.name: p for p in RAW.rglob("*.xlsx")}
    for r in results:
        name = r["file"]
        path = files.get(name)
        if not path:
            continue
        if r["status"] != "ok":
            continue
        try:
            c = parse_workbook(path)
            bucket = (
                "loaded_ok"
                if not c["quarantine"] and c["version"]["lineItemCount"] >= 50
                else "quarantine"
            )
            parse_stats[bucket] += 1
            parse_rows.append(
                {
                    "file": name,
                    "tier": r.get("uploadTier"),
                    "confidence": c["confidence"],
                    "quarantine": c["quarantine"],
                    "lineItems": c["version"]["lineItemCount"],
                    "studyId": c["study"]["studyId"],
                    "warnings": c["warnings"],
                }
            )
            print(
                f"{bucket:12} conf={c['confidence']:.2f} li={c['version']['lineItemCount']:4d} "
                f"id={str(c['study']['studyId']):10} {name[:55]}"
            )
        except Exception as exc:  # noqa: BLE001
            parse_stats["crash"] += 1
            parse_rows.append({"file": name, "error": str(exc)[:180]})
            print(f"crash        {name[:55]} :: {exc}")

    print("\nPARSE_STATS", dict(parse_stats))

    out = {
        "aliasSummary": dict(improved),
        "parseStats": dict(parse_stats),
        "files": results,
        "parseRows": parse_rows,
        "aliases": ALIASES,
    }
    out_path = ROOT / "out" / "active_studies_upload_plan.json"
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("WROTE", out_path)


if __name__ == "__main__":
    main()
