/**
 * Confirm Monet can resolve pterygium / free-text unfamiliar TAs and live-pull CT.gov.
 */
const {
  extractIndicationFromQuestion,
  indicationAliases,
  resolveIndicationGroup
} = require("../api/src/intelligence");
const { searchCtgovRecruitingLive } = require("../api/src/gapFill");

async function main() {
  const cases = [
    "Ora pterygium prep for Cloudbreak",
    "pterygium feasibility",
    "indication: pinguecula",
    "wet AMD landscape",
    "for xerophthalmia study",
    "meeting prep dry eye"
  ];
  const extract = {};
  for (const q of cases) {
    const ind = extractIndicationFromQuestion(q);
    extract[q] = {
      indication: ind,
      group: resolveIndicationGroup(ind)?.preferred || null,
      aliases: indicationAliases(ind).slice(0, 6)
    };
  }

  const live = await searchCtgovRecruitingLive("Pterygium", { limit: 8, maxPages: 2 });
  const sample = (live.recruitingSample || []).slice(0, 5).map((t) => ({
    nct: t.nct,
    status: t.status,
    title: String(t.title || "").slice(0, 90),
    conditions: (t.conditions || []).slice(0, 3)
  }));

  const ok =
    extract["Ora pterygium prep for Cloudbreak"].indication === "Pterygium" &&
    extract["pterygium feasibility"].indication === "Pterygium" &&
    extract["indication: pinguecula"].indication === "Pinguecula" &&
    extract["wet AMD landscape"].indication === "Wet AMD" &&
    extract["for xerophthalmia study"].indication === "Xerophthalmia" &&
    Number(live.recruitingCount || 0) > 0;

  console.log(
    JSON.stringify(
      {
        ok,
        extract,
        liveCtgov: {
          queryCond: live.queryCond,
          recruitingRegistryTotal: live.recruitingRegistryTotal,
          recruitingCount: live.recruitingCount,
          sample
        }
      },
      null,
      2
    )
  );
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
