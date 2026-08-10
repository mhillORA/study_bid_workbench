/**
 * Exclusive indication matching: one request → one INDICATION_GROUPS row.
 * Run: node api/scripts/test-indication-exclusivity.js
 */
const {
  INDICATION_GROUPS,
  resolveIndicationGroup,
  indicationAliases,
  indicationCompatible,
  extractIndicationFromQuestion,
  indicationContainsNeedles
} = require("../src/intelligence");

const fails = [];
function assert(cond, msg) {
  if (!cond) fails.push(msg);
}

for (let i = 0; i < INDICATION_GROUPS.length; i++) {
  for (const label of INDICATION_GROUPS[i]) {
    const r = resolveIndicationGroup(label);
    assert(r && r.index === i, `resolve(${label}) expected group ${i} got ${r && r.index}`);
    for (const a of indicationAliases(label)) {
      const ar = resolveIndicationGroup(a);
      if (ar) assert(ar.index === i, `alias ${a} of ${label} left group ${i} -> ${ar.index}`);
    }
    for (const n of indicationContainsNeedles(label)) {
      const nr = resolveIndicationGroup(n);
      if (nr) {
        assert(nr.index === i, `needle "${n}" for ${label} -> group ${nr.index} not ${i}`);
      }
    }
  }
}

for (let i = 0; i < INDICATION_GROUPS.length; i++) {
  for (let j = 0; j < INDICATION_GROUPS.length; j++) {
    if (i === j) continue;
    const a = INDICATION_GROUPS[i][0];
    const b = INDICATION_GROUPS[j][0];
    assert(!indicationCompatible(b, a), `compatible(${b} | req ${a}) should be false`);
  }
}

assert(!indicationCompatible("Dry AMD", "Dry Eye"), "Dry Eye vs Dry AMD");
assert(!indicationCompatible("Geographic Atrophy / Dry AMD", "Dry Eye"), "DED vs GA");
assert(!indicationCompatible("Glaucoma Neuroprotection", "Glaucoma"), "Glaucoma vs Neuroprotection");
assert(!indicationCompatible("Glaucoma", "Neuroprotection"), "Neuroprotection vs Glaucoma");
assert(
  !indicationCompatible("Central Retinal Vein Occlusion", "Retinal Vein Occlusion"),
  "RVO vs CRVO"
);
assert(
  !indicationCompatible("Branch Retinal Vein Occlusion", "Retinal Vein Occlusion"),
  "RVO vs BRVO"
);
assert(!indicationCompatible("Devices-Dry Eye", "Dry Eye"), "Dry Eye vs Devices-Dry Eye");
assert(
  !indicationCompatible("Leber Hereditary Optic Neuropathy", "Optic Neuropathy"),
  "ON vs LHON"
);
assert(indicationCompatible("Dry Eye Disease", "Dry Eye"), "DED synonyms ok");
assert(indicationCompatible("Glaucoma Neuroprotection", "Neuroprotection"), "Neuroprotection ok");
assert(indicationCompatible("CRVO", "Central Retinal Vein Occlusion"), "CRVO synonyms ok");

const dryEyeQ = extractIndicationFromQuestion("dry eye enrollment");
assert(
  dryEyeQ === "Dry Eye" || dryEyeQ === "Dry Eye Disease",
  `extract dry eye got ${dryEyeQ}`
);
assert(
  !["Geographic Atrophy / Dry AMD", "Dry AMD", "GA"].includes(dryEyeQ),
  "extract dry eye not amd"
);
const neuroQ = extractIndicationFromQuestion("glaucoma neuroprotection sites");
assert(/neuroprotect/i.test(neuroQ || ""), `extract neuroprotection got ${neuroQ}`);
const glaucQ = extractIndicationFromQuestion("glaucoma enrollment");
assert(/glaucoma/i.test(glaucQ || ""), `extract glaucoma got ${glaucQ}`);
assert(!/neuroprotect/i.test(glaucQ || ""), `glaucoma must not be neuroprotection: ${glaucQ}`);
assert(resolveIndicationGroup("dry") === null, "bare dry ambiguous");
assert(resolveIndicationGroup("amd") === null, "bare amd ambiguous");

if (fails.length) {
  console.error(`FAILS (${fails.length}):`);
  fails.slice(0, 50).forEach((f) => console.error(" -", f));
  process.exit(1);
}
console.log(`OK exclusivity checks passed for ${INDICATION_GROUPS.length} groups`);
