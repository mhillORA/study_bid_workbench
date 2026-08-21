"""
Convert Mike Watson Site Level Veeva milestone Excel → JSON packs for Cosmos/Buddy.

Usage:
  python ingest/convert_mike_watson_milestones.py
  python ingest/convert_mike_watson_milestones.py --xlsx "C:/Users/.../file.xlsx"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

MS_PAT = re.compile(
    r"^(Site Selected|Contract Executed|Contract / Budget|IRB/EC Approval|SIV|"
    r"Site Initiation Visit|FSFV|First Subject In|Last Subject In|LSFV|"
    r"Last Subject Out|LSLV)",
    re.I,
)
MS_MAP = {
    "contract / budget": "Contract Executed",
    "first subject in": "FSFV",
    "last subject in": "LSFV",
    "last subject out": "LSLV",
    "site initiation visit": "SIV",
    "siv": "SIV",
    "site selected": "Site Selected",
    "contract executed": "Contract Executed",
    "irb/ec approval": "IRB/EC Approval",
    "fsfv": "FSFV",
    "lsfv": "LSFV",
    "lslv": "LSLV",
}
CORE = ["Site Selected", "Contract Executed", "IRB/EC Approval", "SIV", "FSFV"]
EXTRA = ["LSFV", "LSLV"]


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def nan_to_none(x):
    if x is None:
        return None
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    try:
        if pd.isna(x):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(x, (pd.Timestamp, datetime)):
        return x.isoformat()
    return x


def to_iso(v):
    if pd.isna(v):
        return None
    ts = pd.to_datetime(v, errors="coerce")
    if pd.isna(ts):
        return None
    if ts.year <= 2000:
        return None
    return ts.date().isoformat()


def clean_ms(val):
    if pd.isna(val):
        return None
    s = str(val).strip()
    m = MS_PAT.match(s)
    if not m:
        return None
    key = m.group(1).lower()
    return MS_MAP.get(key, m.group(1))


def country_from_row(row) -> str:
    for col in ["Study Country", "Study Country.1", "Study Country.2"]:
        v = row.get(col)
        if pd.isna(v):
            continue
        s = str(v)
        m = re.search(r"\(([^)]+)\)\s*$", s)
        if m:
            return m.group(1).strip()
        if s.strip() and "(" not in s:
            return s.strip()
    return "_unknown"


def convert(xlsx: Path, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    df = pd.read_excel(xlsx, sheet_name=0)
    df["milestone_clean"] = df["Milestone"].map(clean_ms)
    df["date_iso"] = df.apply(
        lambda r: to_iso(r["Actual Start Date"]) or to_iso(r["Actual Finish Date"]),
        axis=1,
    )
    df["country"] = df.apply(country_from_row, axis=1)

    long = df[df["milestone_clean"].notna() & df["Study Name"].notna()].copy()

    long_docs = []
    for _, r in long.iterrows():
        org = nan_to_none(r.get("Organization"))
        study = str(r["Study Name"]).strip()
        ms = r["milestone_clean"]
        country = r["country"] or "_unknown"
        base = "|".join(
            [
                study,
                str(org or ""),
                str(ms),
                str(r.get("date_iso") or ""),
                str(nan_to_none(r.get("Study Site Number")) or ""),
            ]
        )
        hid = hashlib.sha1(base.encode("utf-8")).hexdigest()[:20]
        long_docs.append(
            {
                "id": f"ms-long-{hid}",
                "docType": "ora_veeva_milestone_event",
                "dataset": "ora_clinical_intelligence",
                "sourceFile": "Mike_Watson_Claude_Report_Site_Level_10Jul2026.xlsx",
                "study_name": study,
                "organization": org,
                "country": country,
                "location_city": nan_to_none(r.get("Location City")),
                "location_state": nan_to_none(r.get("Location State")),
                "principal_investigator": nan_to_none(r.get("Principal Investigator")),
                "study_sponsor": nan_to_none(r.get("Study Sponsor")),
                "study_site_number": nan_to_none(r.get("Study Site Number")),
                "milestone": ms,
                "milestone_raw": nan_to_none(r.get("Milestone")),
                "date": r.get("date_iso"),
                "planned_start": to_iso(r.get("Planned Start Date")),
                "planned_finish": to_iso(r.get("Planned Finish Date")),
                "actual_start": to_iso(r.get("Actual Start Date")),
                "actual_finish": to_iso(r.get("Actual Finish Date")),
            }
        )

    work = long.copy()
    work["_org"] = work["Organization"].fillna("").astype(str)
    work["_study"] = work["Study Name"].astype(str)

    wide_docs = []
    for (study, org), grp in work.groupby(["_study", "_org"], dropna=False):
        dates = {}
        for ms in CORE + EXTRA:
            sub = grp[grp["milestone_clean"] == ms]["date_iso"].dropna()
            if len(sub):
                dates[ms] = min(sub.tolist())
        if not any(k in dates for k in CORE):
            continue

        def gap(a, b):
            if a in dates and b in dates:
                da = datetime.fromisoformat(dates[a]).date()
                db = datetime.fromisoformat(dates[b]).date()
                g = (db - da).days
                return g if g >= 0 else None
            return None

        gaps = {
            "selected_to_contract": gap("Site Selected", "Contract Executed"),
            "contract_to_irb": gap("Contract Executed", "IRB/EC Approval"),
            "irb_to_siv": gap("IRB/EC Approval", "SIV"),
            "siv_to_fsi": gap("SIV", "FSFV"),
            "contract_to_siv": gap("Contract Executed", "SIV"),
            "contract_to_fsi": gap("Contract Executed", "FSFV"),
        }
        years = [int(d[:4]) for d in dates.values()]
        activity_2023_plus = any(y >= 2023 for y in years) if years else False
        outlier = any(g is not None and g > 730 for g in gaps.values())
        countries = grp["country"].dropna().astype(str)
        country = countries.mode().iloc[0] if len(countries) else "_unknown"
        first = grp.iloc[0]
        base = f"{study}|{org}"
        hid = hashlib.sha1(base.encode("utf-8")).hexdigest()[:20]
        wide_docs.append(
            {
                "id": f"ms-wide-{hid}",
                "docType": "ora_veeva_milestone_site_study",
                "dataset": "ora_clinical_intelligence",
                "sourceFile": "Mike_Watson_Claude_Report_Site_Level_10Jul2026.xlsx",
                "study_name": study,
                "organization": org or None,
                "country": country,
                "location_city": nan_to_none(first.get("Location City")),
                "location_state": nan_to_none(first.get("Location State")),
                "principal_investigator": nan_to_none(first.get("Principal Investigator")),
                "study_sponsor": nan_to_none(first.get("Study Sponsor")),
                "dates": {k: dates[k] for k in CORE + EXTRA if k in dates},
                "gaps_days": gaps,
                "activity_2023_plus": activity_2023_plus,
                "outlier_gap_gt_730": outlier,
            }
        )

    meta = {
        "source": xlsx.name,
        "convertedAt": datetime.now(timezone.utc).isoformat(),
        "rawRows": int(len(df)),
        "longEvents": len(long_docs),
        "wideSiteStudies": len(wide_docs),
        "wide_2023_plus": sum(1 for d in wide_docs if d["activity_2023_plus"]),
        "wide_non_outlier": sum(
            1 for d in wide_docs if d["activity_2023_plus"] and not d["outlier_gap_gt_730"]
        ),
        "milestoneCounts": long["milestone_clean"].value_counts().to_dict(),
    }

    long_path = out_dir / "ora_veeva_milestones_long.json"
    wide_path = out_dir / "ora_veeva_milestones_wide.json"
    meta_path = out_dir / "ora_veeva_milestones_meta.json"
    # Alias used by load_ora_intelligence if registered as primary pack
    primary_path = out_dir / "ora_veeva_milestones.json"
    with long_path.open("w", encoding="utf-8") as f:
        json.dump(long_docs, f, ensure_ascii=False)
    with wide_path.open("w", encoding="utf-8") as f:
        json.dump(wide_docs, f, ensure_ascii=False)
    with primary_path.open("w", encoding="utf-8") as f:
        json.dump(wide_docs, f, ensure_ascii=False)
    with meta_path.open("w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    meta["paths"] = {
        "long": str(long_path),
        "wide": str(wide_path),
        "primary": str(primary_path),
        "meta": str(meta_path),
    }
    return meta


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--xlsx",
        type=Path,
        default=Path.home()
        / "Downloads"
        / "Mike Watson Claude Report [Site Level] 10Jul2026 (1).xlsx",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=repo_root() / "ingest" / "data" / "ora_intelligence",
    )
    args = parser.parse_args()
    if not args.xlsx.exists():
        raise SystemExit(f"Excel not found: {args.xlsx}")
    meta = convert(args.xlsx, args.out_dir)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
