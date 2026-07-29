/**
 * Backfill clientName / title / protocol on quarantine + studies from filenames.
 *
 *   node ingest/backfill_identity_from_filename.js --dry-run
 *   node ingest/backfill_identity_from_filename.js
 */
const fs = require("fs");
const path = require("path");

function loadEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnv(path.join(__dirname, "..", ".env"));
loadEnv(path.join(__dirname, "..", "api", ".env"));

const { CosmosClient } = require("../api/node_modules/@azure/cosmos");
const {
  metaFromFilename,
  applyFilenameMetaToHeader,
  isJunkIdentityValue
} = require("../api/src/parseWorkbook");

const dry = process.argv.includes("--dry-run");
const endpoint = process.env.COSMOS_ENDPOINT || process.env.COSMOSDB_ENDPOINT;
const key = process.env.COSMOS_KEY || process.env.COSMOSDB_KEY;
const dbName = process.env.COSMOS_DATABASE || "bd-budgets";

if (!endpoint || !key) {
  console.error("Missing COSMOS_ENDPOINT / COSMOS_KEY");
  process.exit(1);
}

function needsFix(clientName, title) {
  return isJunkIdentityValue(clientName) || isJunkIdentityValue(title) || !clientName || !title;
}

async function main() {
  const client = new CosmosClient({ endpoint, key });
  const db = client.database(dbName);
  const summary = {
    dry,
    quarantineUpdated: 0,
    quarantineSkipped: 0,
    studiesUpdated: 0,
    studiesSkipped: 0,
    samples: []
  };

  // --- quarantine ---
  const { resources: quarantine } = await db
    .container("quarantine")
    .items.query({ query: "SELECT * FROM c" })
    .fetchAll();

  for (const doc of quarantine) {
    const fileName = doc.source?.fileName || doc.fileName || "";
    if (!fileName) {
      summary.quarantineSkipped += 1;
      continue;
    }
    const preview = { ...(doc.preview || {}) };
    if (!needsFix(preview.clientName, preview.title) && preview.clientName && preview.title) {
      summary.quarantineSkipped += 1;
      continue;
    }
    const { header, meta, notes } = applyFilenameMetaToHeader(
      {
        clientName: preview.clientName,
        title: preview.title,
        protocol: preview.protocol,
        therapeuticArea: preview.therapeuticArea
      },
      fileName,
      []
    );
    if (!meta.clientName && !meta.title && !notes.length) {
      summary.quarantineSkipped += 1;
      continue;
    }
    const nextPreview = {
      ...preview,
      clientName: header.clientName || preview.clientName || null,
      title: header.title || preview.title || null,
      protocol: header.protocol || preview.protocol || null,
      therapeuticArea: header.therapeuticArea || preview.therapeuticArea || null
    };
    if (
      nextPreview.clientName === preview.clientName &&
      nextPreview.title === preview.title &&
      nextPreview.protocol === preview.protocol
    ) {
      summary.quarantineSkipped += 1;
      continue;
    }

    if (summary.samples.length < 12) {
      summary.samples.push({
        where: "quarantine",
        fileName: String(fileName).slice(0, 90),
        before: { clientName: preview.clientName, title: preview.title },
        after: { clientName: nextPreview.clientName, title: nextPreview.title }
      });
    }

    if (!dry) {
      doc.preview = nextPreview;
      if (doc.study) {
        doc.study.clientName = nextPreview.clientName;
        doc.study.title = nextPreview.title;
        doc.study.protocol = nextPreview.protocol;
        if (doc.study.header) {
          doc.study.header.clientName = nextPreview.clientName;
          doc.study.header.title = nextPreview.title;
          doc.study.header.protocol = nextPreview.protocol;
        }
      }
      doc.identityBackfillAt = new Date().toISOString();
      doc.identityBackfillNotes = notes;
      await db.container("quarantine").items.upsert(doc);
    }
    summary.quarantineUpdated += 1;
  }

  // --- studies (esp. FILE-* with missing/junk identity) ---
  const { resources: studies } = await db
    .container("studies")
    .items.query({
      query: "SELECT * FROM c WHERE c.docType = @t",
      parameters: [{ name: "@t", value: "study" }]
    })
    .fetchAll();

  for (const doc of studies) {
    const fileName =
      doc.sourceFileName ||
      doc.source?.fileName ||
      doc.header?.sourceFileName ||
      (String(doc.studyId || "").startsWith("FILE-")
        ? String(doc.studyId).replace(/^FILE-/, "") + ".xlsx"
        : "");
    if (!fileName) {
      summary.studiesSkipped += 1;
      continue;
    }
    if (!needsFix(doc.clientName, doc.title)) {
      summary.studiesSkipped += 1;
      continue;
    }
    const { header, notes } = applyFilenameMetaToHeader(
      {
        clientName: doc.clientName,
        title: doc.title,
        protocol: doc.protocol,
        therapeuticArea: doc.therapeuticArea
      },
      fileName,
      []
    );
    if (!header.clientName && !header.title) {
      summary.studiesSkipped += 1;
      continue;
    }
    if (
      header.clientName === doc.clientName &&
      header.title === doc.title &&
      header.protocol === doc.protocol
    ) {
      summary.studiesSkipped += 1;
      continue;
    }

    if (summary.samples.length < 20) {
      summary.samples.push({
        where: "studies",
        studyId: doc.studyId,
        fileName: String(fileName).slice(0, 90),
        before: { clientName: doc.clientName, title: doc.title },
        after: { clientName: header.clientName, title: header.title }
      });
    }

    if (!dry) {
      doc.clientName = header.clientName || doc.clientName || null;
      doc.title = header.title || doc.title || null;
      doc.protocol = header.protocol || doc.protocol || null;
      if (header.therapeuticArea) doc.therapeuticArea = header.therapeuticArea;
      if (!doc.header) doc.header = {};
      doc.header.clientName = doc.clientName;
      doc.header.title = doc.title;
      doc.header.protocol = doc.protocol;
      if (header.therapeuticArea) doc.header.therapeuticArea = header.therapeuticArea;
      doc.identityBackfillAt = new Date().toISOString();
      doc.identityBackfillNotes = notes;
      doc.updatedAt = new Date().toISOString();
      await db.container("studies").items.upsert(doc);
    }
    summary.studiesUpdated += 1;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
