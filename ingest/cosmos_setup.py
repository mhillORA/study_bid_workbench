"""Create Study Bid Workbench Cosmos DB + containers (no Blob)."""

from __future__ import annotations

import os
import sys

from azure.cosmos import CosmosClient, PartitionKey, exceptions
from dotenv import load_dotenv

CONTAINERS = [
    # Partition by studyId so one study's docs stay together.
    {"id": "studies", "partition_key": "/studyId"},
    {"id": "versions", "partition_key": "/studyId"},
    {"id": "lineItems", "partition_key": "/studyId"},
    {"id": "sections", "partition_key": "/studyId"},
    {"id": "reviews", "partition_key": "/studyId"},
    {"id": "rateCards", "partition_key": "/rateCardId"},
    {"id": "importJobs", "partition_key": "/jobId"},
    {"id": "quarantine", "partition_key": "/jobId"},
    # Learned sheet/field aliases promoted from quarantine + successful parses
    {"id": "parseLearnings", "partition_key": "/id"},
    {"id": "users", "partition_key": "/userId"},
    {"id": "profiles", "partition_key": "/profileId"},
    # Ora Clinical Intelligence (Veeva + TrialHub reference tables)
    # See docs/ora-intelligence.md — SQL API, not Mongo.
    {"id": "ora_fact_site", "partition_key": "/country"},
    {"id": "ora_fact_study", "partition_key": "/indication"},
    {"id": "ora_trialhub_trials", "partition_key": "/indication"},
    {"id": "ora_sponsor_crosswalk", "partition_key": "/crosswalk_status"},
    {"id": "ora_site_alias_table", "partition_key": "/country"},
    # ClinicalTrials.gov ophthalmology feed (daily delta pull).
    {"id": "ora_ctgov_trials", "partition_key": "/oraIndication"},
    # Salesforce live mirrors (Ora Intelligence Tool JWT sync)
    {"id": "ora_sf_account", "partition_key": "/id"},
    {"id": "ora_sf_opportunity", "partition_key": "/id"},
    {"id": "ora_sf_activity_request", "partition_key": "/id"},
    {"id": "ora_sf_opportunity_line", "partition_key": "/id"},
    {"id": "ora_sf_services", "partition_key": "/id"},
    # Watermarks / cursors for scheduled sync jobs.
    {"id": "syncState", "partition_key": "/id"},
]


def get_client() -> CosmosClient:
    load_dotenv()
    endpoint = os.getenv("COSMOS_ENDPOINT", "").strip()
    key = os.getenv("COSMOS_KEY", "").strip()
    if not endpoint or not key or "YOUR_" in endpoint or "YOUR_" in key:
        print(
            "Missing Cosmos credentials.\n"
            "1) Copy .env.example to .env\n"
            "2) Paste COSMOS_ENDPOINT and COSMOS_KEY from Azure Portal\n"
            "   (Cosmos DB account → Keys)",
            file=sys.stderr,
        )
        sys.exit(1)
    return CosmosClient(endpoint, credential=key)


def ensure_database_and_containers() -> None:
    load_dotenv()
    db_name = os.getenv("COSMOS_DATABASE", "bd-budgets").strip()
    client = get_client()

    try:
        db = client.create_database_if_not_exists(id=db_name)
    except exceptions.CosmosHttpResponseError as exc:
        print(f"Failed to create/open database '{db_name}': {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Database: {db_name}")
    for spec in CONTAINERS:
        container = db.create_container_if_not_exists(
            id=spec["id"],
            partition_key=PartitionKey(path=spec["partition_key"]),
            offer_throughput=None,  # serverless accounts ignore this; provisioned use autoscale portal setting
        )
        print(f"  container OK: {container.id}  pk={spec['partition_key']}")

    print("Done. Cosmos is ready (Cosmos-only — no Blob).")


if __name__ == "__main__":
    ensure_database_and_containers()
