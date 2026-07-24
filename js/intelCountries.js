/**
 * Intelligence country catalog — canonical names + aliases (ISO2/ISO3/common).
 * Keep in sync with alias matching in api/src/intelligence.js (normalizeCountryName).
 */
(function (SBW) {
  const RAW = [
    ["United States", "US", "USA", "U.S.", "U.S.A.", "United States of America", "America"],
    ["United Kingdom", "UK", "GB", "GBR", "Britain", "Great Britain", "England", "U.K."],
    ["Canada", "CA", "CAN"],
    ["Mexico", "MX", "MEX"],
    ["Germany", "DE", "DEU", "Deutschland"],
    ["France", "FR", "FRA"],
    ["Spain", "ES", "ESP"],
    ["Italy", "IT", "ITA"],
    ["Portugal", "PT", "PRT"],
    ["Netherlands", "NL", "NLD", "Holland"],
    ["Belgium", "BE", "BEL"],
    ["Switzerland", "CH", "CHE"],
    ["Austria", "AT", "AUT"],
    ["Poland", "PL", "POL"],
    ["Czechia", "CZ", "CZE", "Czech Republic"],
    ["Slovakia", "SK", "SVK"],
    ["Hungary", "HU", "HUN"],
    ["Romania", "RO", "ROU"],
    ["Bulgaria", "BG", "BGR"],
    ["Greece", "GR", "GRC"],
    ["Sweden", "SE", "SWE"],
    ["Norway", "NO", "NOR"],
    ["Denmark", "DK", "DNK"],
    ["Finland", "FI", "FIN"],
    ["Ireland", "IE", "IRL"],
    ["Turkey", "TR", "TUR", "Türkiye", "Turkiye"],
    ["Russia", "RU", "RUS", "Russian Federation"],
    ["Ukraine", "UA", "UKR"],
    ["Israel", "IL", "ISR"],
    ["Saudi Arabia", "SA", "SAU"],
    ["United Arab Emirates", "AE", "ARE", "UAE"],
    ["Egypt", "EG", "EGY"],
    ["South Africa", "ZA", "ZAF"],
    ["Nigeria", "NG", "NGA"],
    ["Kenya", "KE", "KEN"],
    ["Japan", "JP", "JPN"],
    ["China", "CN", "CHN", "PRC", "People's Republic of China"],
    ["Hong Kong", "HK", "HKG"],
    ["Taiwan", "TW", "TWN"],
    ["Korea, Republic of", "KR", "KOR", "South Korea", "Korea", "Republic of Korea"],
    ["India", "IN", "IND"],
    ["Pakistan", "PK", "PAK"],
    ["Bangladesh", "BD", "BGD"],
    ["Thailand", "TH", "THA"],
    ["Vietnam", "VN", "VNM", "Viet Nam"],
    ["Singapore", "SG", "SGP"],
    ["Malaysia", "MY", "MYS"],
    ["Indonesia", "ID", "IDN"],
    ["Philippines", "PH", "PHL"],
    ["Australia", "AU", "AUS"],
    ["New Zealand", "NZ", "NZL"],
    ["Brazil", "BR", "BRA"],
    ["Argentina", "AR", "ARG"],
    ["Chile", "CL", "CHL"],
    ["Colombia", "CO", "COL"],
    ["Peru", "PE", "PER"],
    ["Puerto Rico", "PR", "PRI"]
  ];

  SBW.INTEL_GLOBAL = "Global";

  SBW.intelCountries = RAW.map(([name, ...aliases]) => ({
    name,
    aliases: aliases.map((a) => String(a))
  }));

  /** Common chips shown like indications (plus Global handled separately). */
  SBW.intelCountryChips = [
    "United States",
    "United Kingdom",
    "Canada",
    "Germany",
    "Japan",
    "China",
    "Australia",
    "France",
    "Italy",
    "Spain",
    "Brazil",
    "India",
    "Korea, Republic of",
    "Turkey"
  ];

  function normKey(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\./g, "")
      .replace(/['’]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const aliasIndex = new Map();
  for (const c of SBW.intelCountries) {
    aliasIndex.set(normKey(c.name), c.name);
    for (const a of c.aliases) aliasIndex.set(normKey(a), c.name);
  }

  /** Resolve typed text / ISO / alias → canonical country name, or null. */
  SBW.resolveIntelCountry = function (raw) {
    const key = normKey(raw);
    if (!key) return null;
    if (key === "global" || key === "worldwide" || key === "world" || key === "all countries") {
      return SBW.INTEL_GLOBAL;
    }
    if (aliasIndex.has(key)) return aliasIndex.get(key);
    // Prefix match on aliases (TUR → Turkey when unique)
    const hits = [];
    for (const [k, name] of aliasIndex.entries()) {
      if (k.startsWith(key) || key.startsWith(k)) hits.push(name);
    }
    const uniq = [...new Set(hits)];
    if (uniq.length === 1) return uniq[0];
    return null;
  };

  /** Autocomplete suggestions for typed query (max n). */
  SBW.suggestIntelCountries = function (query, selected, max = 10) {
    const q = normKey(query);
    const selectedSet = new Set((selected || []).map((s) => s));
    const scored = [];
    for (const c of SBW.intelCountries) {
      if (selectedSet.has(c.name)) continue;
      const nameKey = normKey(c.name);
      const aliasKeys = c.aliases.map(normKey);
      let score = 0;
      if (!q) {
        score = 1;
      } else if (nameKey === q || aliasKeys.includes(q)) {
        score = 100;
      } else if (nameKey.startsWith(q) || aliasKeys.some((a) => a.startsWith(q))) {
        score = 80;
      } else if (nameKey.includes(q) || aliasKeys.some((a) => a.includes(q))) {
        score = 40;
      } else {
        continue;
      }
      scored.push({ name: c.name, aliases: c.aliases, score });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.slice(0, max);
  };
})(window.SBW = window.SBW || {});
