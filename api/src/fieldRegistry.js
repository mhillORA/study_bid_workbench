/**
 * Canonical field registry — normalize labels/keys across workbook variants.
 * Keep raw label/sourceKey; prefer canonicalKey for UI, Ask Buddy, and compare.
 */

const CANONICAL_FIELDS = {
  // Header / study identity
  clientName: { domain: "header", aliases: ["client name", "sponsor", "sponsor name", "client"] },
  title: { domain: "header", aliases: ["study title/description", "study title", "title", "study description"] },
  protocol: { domain: "header", aliases: ["protocol number", "protocol #", "protocol"] },
  opportunityId: {
    domain: "header",
    aliases: ["parent opportunity id#", "opportunity id", "opportunity #", "opp id", "parent opportunity id"]
  },
  phase: { domain: "header", aliases: ["phase", "study phase"] },
  bdDirector: { domain: "header", aliases: ["bd director"] },
  bdoLead: { domain: "header", aliases: ["bdo lead"] },
  therapeuticArea: { domain: "header", aliases: ["therapeutic area", "ta", "ther area"] },
  therapeuticAreaHead: { domain: "header", aliases: ["therapeutic area head", "ta head", "tah"] },
  indication: { domain: "header", aliases: ["indication"] },
  rareDisease: { domain: "header", aliases: ["is indication a rare disease", "rare disease"] },
  geneTherapy: { domain: "header", aliases: ["is ip gene therapy", "gene therapy"] },
  patientPopulation: { domain: "header", aliases: ["what is the patient population", "patient population"] },
  soeSource: { domain: "header", aliases: ["client soe or ora soe assumptions", "soe source"] },
  budgetVersion: { domain: "header", aliases: ["budget version", "version"] },
  budgetDueDate: { domain: "header", aliases: ["date budget due", "budget due date", "due date"] },
  enrollmentType: { domain: "header", aliases: ["enrollment type"] },
  budgetType: { domain: "header", aliases: ["budget type"] },
  reviewLevel: { domain: "header", aliases: ["level of reviews needed", "review level"] },
  deliverableType: { domain: "header", aliases: ["deliverable type"] },
  standaloneOrProgram: { domain: "header", aliases: ["standalone or program"] },
  bidToSpec: { domain: "header", aliases: ["bid to spec / ora assumptions", "bid to spec"] },
  allOraSystems: {
    domain: "header",
    aliases: ["all ora systems? if not, what external systems", "all ora systems"]
  },

  // Drivers
  screenedSubjects: { domain: "driver", aliases: ["# screened subjects", "screened subjects", "screened"] },
  enrolledSubjects: { domain: "driver", aliases: ["# enrolled subjects", "enrolled subjects", "enrolled"] },
  completedSubjects: { domain: "driver", aliases: ["# completed subjects", "completed subjects"] },
  enrollmentRate: {
    domain: "driver",
    aliases: ["overall enrollment rate (subjects/site/month)", "enrollment rate"]
  },
  startupMonths: { domain: "driver", aliases: ["start-up (contract-fpfv) in months", "startup months", "start-up"] },
  enrollmentMonths: {
    domain: "driver",
    aliases: ["enrollment (fpfv-lpfv) in months", "enrollment months"]
  },
  treatmentMonths: {
    domain: "driver",
    aliases: ["treatment incl. screening (lpfv-lplv) in months", "treatment months"]
  },
  ltfuMonths: { domain: "driver", aliases: ["long term follow-up (ltfu) in months", "ltfu"] },
  dblMonths: { domain: "driver", aliases: ["database lock (lp out-db lock) in months", "dbl", "database lock"] },
  closeoutMonths: {
    domain: "driver",
    aliases: ["closeout (db lock-delivery of tmf) in months", "closeout"]
  },
  totalDuration: { domain: "driver", aliases: ["total duration", "total duration months"] },
  screenFailRate: { domain: "driver", aliases: ["screen failure %", "screen fail %", "screen failure"] },
  dropOutRate: { domain: "driver", aliases: ["drop-out rate", "dropout rate", "drop out rate"] },
  coreSites: { domain: "driver", aliases: ["core sites", "number of sites", "# sites"] },
  contingency: { domain: "driver", aliases: ["contingency", "contingency %"] },
  inflationRate: { domain: "driver", aliases: ["inflation", "inflation rate", "inflation %"] },
  discount: { domain: "driver", aliases: ["discount", "discount %"] }
};

function normAlias(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\?+$/, "");
}

const ALIAS_INDEX = (() => {
  const map = new Map();
  for (const [canonical, meta] of Object.entries(CANONICAL_FIELDS)) {
    map.set(normAlias(canonical), canonical);
    for (const a of meta.aliases || []) {
      map.set(normAlias(a), canonical);
    }
  }
  return map;
})();

function resolveCanonicalKey(labelOrKey) {
  if (labelOrKey == null) return null;
  const raw = String(labelOrKey);
  // Strip known prefixes from inputFields keys
  const stripped = raw.replace(/^(input|driver|side|section):/i, "");
  const hit = ALIAS_INDEX.get(normAlias(stripped)) || ALIAS_INDEX.get(normAlias(raw));
  return hit || null;
}

/**
 * @param {Array} fields
 * @param {(label: string) => string|null} [extraResolve] learned-alias resolver
 */
function enrichInputFields(fields, extraResolve) {
  if (!Array.isArray(fields)) return [];
  const resolveExtra = typeof extraResolve === "function" ? extraResolve : null;
  return fields.map((f) => {
    let canonicalKey = resolveCanonicalKey(f.key) || resolveCanonicalKey(f.label);
    if (!canonicalKey && resolveExtra) {
      canonicalKey = resolveExtra(f.key) || resolveExtra(f.label) || null;
    }
    const domain = canonicalKey && CANONICAL_FIELDS[canonicalKey]
      ? CANONICAL_FIELDS[canonicalKey].domain
      : f.kind || "input";
    return {
      ...f,
      sourceKey: f.key,
      canonicalKey,
      domain,
      normalized: Boolean(canonicalKey)
    };
  });
}

function applyCanonicalToBags(header, drivers, fields) {
  const h = { ...(header || {}) };
  const d = { ...(drivers || {}) };
  for (const f of fields || []) {
    if (!f.canonicalKey || f.value == null || f.value === "") continue;
    const meta = CANONICAL_FIELDS[f.canonicalKey];
    if (!meta) continue;
    if (meta.domain === "header" && (h[f.canonicalKey] == null || h[f.canonicalKey] === "")) {
      h[f.canonicalKey] = f.value;
    }
    if (meta.domain === "driver" && (d[f.canonicalKey] == null || d[f.canonicalKey] === "")) {
      d[f.canonicalKey] = f.value;
    }
  }
  return { header: h, drivers: d };
}

module.exports = {
  CANONICAL_FIELDS,
  normAlias,
  resolveCanonicalKey,
  enrichInputFields,
  applyCanonicalToBags
};
