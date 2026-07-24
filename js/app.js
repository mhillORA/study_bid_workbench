(() => {
  const STORAGE_KEY = "sbw.study.v1";
  const USER_KEY = "sbw.user.v1";

  const state = {
    userId: localStorage.getItem(USER_KEY) || "u-admin",
    entraUser: null,
    sectionId: "hub",
    study: loadStudy(),
    dirty: false,
    results: {},
    askHistory: [],
    buddyOpen: false,
    buddyBusy: false,
    source: "local", // local | cosmos
    versions: [],
    lineItems: [],
    compare: null,
    compareStatus: "",
    studiesList: [],
    studiesGroupBy: localStorage.getItem("sbw.studiesGroupBy") || "client",
    studiesCollapsed: {},
    budgetCompare: {
      mode: localStorage.getItem("sbw.budgetCompareMode") || "studies", // studies | versions
      leftStudyId: "",
      rightStudyId: "",
      leftVersions: [],
      rightVersions: [],
      leftVersionId: "",
      rightVersionId: ""
    },
    studyCompare: {
      open: false,
      selected: [],
      leftId: null,
      rightId: null,
      left: null,
      right: null,
      status: ""
    },
    intelligence: {
      health: null,
      pack: null,
      indication: "",
      countries: [],
      globalRegion: false,
      countryQuery: "",
      countrySuggestOpen: false,
      status: "",
      loading: false,
      syncStatus: null,
      syncBusy: false,
      syncMessage: ""
    },
    scorecard: {
      indication: "",
      countries: [],
      globalRegion: false,
      countryQuery: "",
      countrySuggestOpen: false,
      source: "veeva",
      result: null,
      status: "",
      loading: false
    }
  };

  const els = {
    userSelect: document.getElementById("userSelect"),
    sectionNav: document.getElementById("sectionNav"),
    viewRoot: document.getElementById("viewRoot"),
    pageTitle: document.getElementById("pageTitle"),
    pageSubtitle: document.getElementById("pageSubtitle"),
    studyMeta: document.getElementById("studyMeta"),
    saveStatus: document.getElementById("saveStatus"),
    btnSave: document.getElementById("btnSave"),
    btnExport: document.getElementById("btnExport"),
    btnRequestFill: document.getElementById("btnRequestFill"),
    btnBuddyOpen: document.getElementById("btnBuddyOpen"),
    btnNewStudy: document.getElementById("btnNewStudy"),
    btnClearStudy: document.getElementById("btnClearStudy"),
    newStudyDialog: document.getElementById("newStudyDialog"),
    newStudyForm: document.getElementById("newStudyForm"),
    newStudyId: document.getElementById("newStudyId"),
    newStudyClient: document.getElementById("newStudyClient"),
    newStudyProtocol: document.getElementById("newStudyProtocol"),
    newStudyTitle: document.getElementById("newStudyTitle"),
    buddyFab: document.getElementById("buddyFab"),
    buddyPanel: document.getElementById("buddyPanel"),
    buddyClose: document.getElementById("buddyClose"),
    askLog: document.getElementById("askLog"),
    askInput: document.getElementById("askInput"),
    btnAsk: document.getElementById("btnAsk"),
    askStatus: document.getElementById("askStatus"),
    compareOverlay: document.getElementById("compareOverlay"),
    requestDialog: document.getElementById("requestDialog"),
    requestForm: document.getElementById("requestForm"),
    requestDept: document.getElementById("requestDept"),
    requestUser: document.getElementById("requestUser"),
    requestNote: document.getElementById("requestNote")
  };

  function loadStudy() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return SBW.defaultStudy();
  }

  function currentUser() {
    return SBW.users.find((u) => u.id === state.userId) || SBW.users[0];
  }

  function money(n) {
    if (n == null || n === "") return "—";
    const x = typeof n === "number" ? n : Number(String(n).replace(/[$,%\s]/g, "").replace(/\((.*)\)/, "-$1"));
    if (!Number.isFinite(x)) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0
    }).format(x);
  }

  function num(n, digits = 2) {
    if (n == null || n === "") return "—";
    const x = typeof n === "number" ? n : Number(n);
    if (!Number.isFinite(x)) return "—";
    return x.toLocaleString("en-US", { maximumFractionDigits: digits });
  }

  function markDirty() {
    state.dirty = true;
    els.saveStatus.textContent = "Unsaved";
    els.saveStatus.classList.remove("saved");
  }

  function markSaved() {
    state.dirty = false;
    els.saveStatus.textContent = "Saved";
    els.saveStatus.classList.add("saved");
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.study));
    markSaved();
  }

  function recalc() {
    state.results = SBW.calc.runAll(state.study);
  }

  function setSection(sectionId) {
    state.sectionId = sectionId;
    render();
    if (sectionId === "versions" || sectionId === "studies") {
      ensureStudiesLoaded().then(() => {
        if (sectionId === "versions") {
          hydrateBudgetCompareDefaults();
          render();
        }
      });
    }
    if (sectionId === "intelligence") {
      ensureIntelligenceLoaded();
    }
    if (sectionId === "scorecard" && state.intelligence.indication && !state.scorecard.indication) {
      state.scorecard.indication = state.intelligence.indication;
      state.scorecard.countries = [...(state.intelligence.countries || [])];
      state.scorecard.globalRegion = !!state.intelligence.globalRegion;
    }
  }

  async function ensureStudiesLoaded() {
    if ((state.studiesList || []).length) return state.studiesList;
    try {
      const res = await fetch(apiUrl("/api/studies?limit=500"));
      const data = await res.json().catch(() => ({}));
      if (res.ok) state.studiesList = data.studies || [];
    } catch (_) {}
    return state.studiesList || [];
  }

  function hydrateBudgetCompareDefaults() {
    const bc = state.budgetCompare;
    const list = state.studiesList || [];
    if (!list.length) return;
    if (!bc.leftStudyId) {
      bc.leftStudyId =
        state.source === "cosmos" && state.study.studyId
          ? state.study.studyId
          : list[0].studyId;
    }
    if (!bc.rightStudyId) {
      const other = list.find((s) => s.studyId !== bc.leftStudyId);
      bc.rightStudyId = other ? other.studyId : bc.leftStudyId;
    }
    loadBudgetCompareVersions("left");
    loadBudgetCompareVersions("right");
  }

  async function loadBudgetCompareVersions(side) {
    const bc = state.budgetCompare;
    const studyId = side === "left" ? bc.leftStudyId : bc.rightStudyId;
    if (!studyId) return;
    try {
      const res = await fetch(apiUrl(`/api/studies/${encodeURIComponent(studyId)}/versions`));
      const data = await res.json().catch(() => ({}));
      const versions = data.versions || [];
      if (side === "left") {
        bc.leftVersions = versions;
        if (!bc.leftVersionId || !versions.some((v) => v.id === bc.leftVersionId)) {
          bc.leftVersionId = versions[0] ? versions[0].id : "";
        }
      } else {
        bc.rightVersions = versions;
        if (!bc.rightVersionId || !versions.some((v) => v.id === bc.rightVersionId)) {
          bc.rightVersionId = versions[0] ? versions[0].id : "";
        }
      }
    } catch (_) {
      if (side === "left") bc.leftVersions = [];
      else bc.rightVersions = [];
    }
  }

  function canEdit(department) {
    if (!department) return true;
    const user = currentUser();
    if (user.department === "Admin") return true;
    if (user.department === "Analyst" || user.department === "TAH") return true;
    return user.department === department;
  }

  function canSeeSection(section) {
    const user = currentUser();
    if (user.department === "Admin") return true;
    if (!section.department) return true;
    if (user.department === "Analyst" || user.department === "TAH") return true;
    return section.department === user.department;
  }

  function statusLabel(s) {
    return (s || "not_started").replaceAll("_", " ");
  }

  function renderNav() {
    els.sectionNav.innerHTML = SBW.sections.filter(canSeeSection).map((s) => {
      const st = state.study.sectionStatus[s.id];
      const active = s.id === state.sectionId ? "active" : "";
      const dot = st ? `<span class="status-dot ${st}"></span>` : "";
      return `<button type="button" data-section="${s.id}" class="${active}">${s.label}${dot}</button>`;
    }).join("");
  }

  function apiUrl(path) {
    const base = (SBW.apiBase || "").replace(/\/$/, "");
    return `${base}${path}`;
  }

  const STUDY_HEADER_FIELDS = [
    { key: "clientName", label: "Client" },
    { key: "studyId", label: "Opportunity" },
    { key: "title", label: "Title" },
    { key: "protocol", label: "Protocol" },
    { key: "versionLabel", label: "Version" },
    { key: "phase", label: "Phase" },
    { key: "therapeuticArea", label: "Therapeutic area" },
    { key: "indication", label: "Indication" },
    { key: "enrollmentType", label: "Enrollment type" },
    { key: "budgetType", label: "Budget type" }
  ];

  const DRIVER_FIELDS = [
    { key: "screenedSubjects", label: "Screened subjects" },
    { key: "enrolledSubjects", label: "Enrolled subjects", aliases: ["enrolled", "patients"] },
    { key: "completedSubjects", label: "Completed subjects", aliases: ["completed"] },
    { key: "coreSites", label: "Core sites", aliases: ["sites"] },
    { key: "startupMonths", label: "Startup months" },
    { key: "enrollmentMonths", label: "Enrollment months" },
    { key: "treatmentMonths", label: "Treatment months" },
    { key: "dblMonths", label: "DBL months" },
    { key: "closeoutMonths", label: "Closeout months" },
    { key: "screenFailRate", label: "Screen fail rate" },
    { key: "dropOutRate", label: "Drop-out rate", aliases: ["dropout rate"] },
    { key: "sdvPercent", label: "SDV percent", aliases: ["sdv %"] },
    { key: "contingency", label: "Contingency" },
    { key: "inflationRate", label: "Inflation rate", aliases: ["inflation"] },
    { key: "discount", label: "Discount" }
  ];

  const ASSUMPTION_FIELDS = {
    recruitment: [
      { key: "contactCenterOn", label: "Contact center", type: "boolean" },
      { key: "advertisingOn", label: "Advertising", type: "boolean" },
      { key: "materialsOn", label: "Materials", type: "boolean" },
      { key: "recruiterTrainingAttendees", label: "Training attendees", type: "number" },
      { key: "notes", label: "Notes", type: "text", aliases: ["recruitment notes", "notes field"] }
    ],
    clinops: [
      { key: "soeSource", label: "SOE source" },
      { key: "patientPopulation", label: "Patient population" },
      { key: "notes", label: "Notes", type: "text", aliases: ["clinops notes", "notes field"] }
    ],
    monitoring: [
      { key: "strategy", label: "Strategy" },
      { key: "rbqmFrequency", label: "RBQM frequency" },
      { key: "maskedTeams", label: "Masked teams", type: "boolean" },
      { key: "notes", label: "Notes", type: "text", aliases: ["monitoring notes", "notes field"] }
    ],
    smo: [
      { key: "blockEnrollmentOn", label: "Block enrollment", type: "boolean" },
      { key: "fixedSitePtComp", label: "Fixed site patient compensation", type: "boolean" },
      { key: "notes", label: "Notes", type: "text", aliases: ["smo notes", "notes field"] }
    ]
  };

  const TAB_META = {
    overview: { label: "Overview / Inputs" },
    recruitment: { label: "Recruitment" },
    clinops: { label: "ClinOps / SOE" },
    monitoring: { label: "Clinical Monitoring" },
    smo: { label: "Block Enrollment / SMO" }
  };

  const SECTION_NAV_ALIASES = {
    hub: ["hub", "home"],
    studies: ["studies", "study list"],
    versions: ["versions", "diff", "versions / diff"],
    intelligence: [
      "intelligence",
      "ora clinical intelligence",
      "clinical intelligence",
      "feasibility",
      "trialhub",
      "psm"
    ],
    scorecard: ["scorecard", "site scorecard", "site scores", "sites"],
    overview: ["overview", "inputs", "overview / inputs"],
    recruitment: ["recruitment", "recruit"],
    clinops: ["clinops", "clin ops", "soe", "clinops / soe"],
    monitoring: ["monitoring", "clinical monitoring"],
    smo: ["smo", "block enrollment", "block enrollment / smo"],
    summary: ["summary", "exec summary", "exec sum"],
    reviews: ["reviews", "review"],
    formulas: ["formulas", "formula"],
    upload: ["upload", "upload budgets"]
  };

  function humanizeKey(key) {
    return String(key || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_./]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, (c) => c.toUpperCase());
  }

  /** Full editable catalog with clean names + tab context for Buddy. */
  function buildEditableFieldCatalog() {
    const study = state.study || {};
    const fields = [];

    for (const f of STUDY_HEADER_FIELDS) {
      fields.push({
        path: f.key,
        label: f.label,
        tab: "overview",
        tabLabel: TAB_META.overview.label,
        group: "Study header",
        value: study[f.key] ?? null,
        aliases: [f.key, humanizeKey(f.key)].filter(Boolean)
      });
    }

    const drivers = study.drivers || {};
    const knownDriverKeys = new Set(DRIVER_FIELDS.map((d) => d.key));
    for (const f of DRIVER_FIELDS) {
      fields.push({
        path: `drivers.${f.key}`,
        label: f.label,
        tab: "overview",
        tabLabel: TAB_META.overview.label,
        group: "Drivers",
        value: drivers[f.key] ?? null,
        aliases: [...(f.aliases || []), f.key, humanizeKey(f.key)]
      });
    }
    for (const key of Object.keys(drivers)) {
      if (knownDriverKeys.has(key)) continue;
      fields.push({
        path: `drivers.${key}`,
        label: humanizeKey(key),
        tab: "overview",
        tabLabel: TAB_META.overview.label,
        group: "Drivers",
        value: drivers[key] ?? null,
        aliases: [key, humanizeKey(key)]
      });
    }

    for (const [group, defs] of Object.entries(ASSUMPTION_FIELDS)) {
      const tabLabel = (TAB_META[group] || {}).label || humanizeKey(group);
      const bucket = (study.assumptions && study.assumptions[group]) || {};
      for (const f of defs) {
        fields.push({
          path: `assumptions.${group}.${f.key}`,
          label: f.label,
          tab: group,
          tabLabel,
          group: `${tabLabel} assumptions`,
          value: bucket[f.key] ?? null,
          type: f.type || "text",
          aliases: [
            ...(f.aliases || []),
            f.key,
            humanizeKey(f.key),
            `${group} ${f.label}`,
            `${tabLabel} ${f.label}`,
            `${f.label} (${tabLabel})`
          ]
        });
      }
      for (const key of Object.keys(bucket)) {
        if (defs.some((d) => d.key === key)) continue;
        fields.push({
          path: `assumptions.${group}.${key}`,
          label: humanizeKey(key),
          tab: group,
          tabLabel,
          group: `${tabLabel} assumptions`,
          value: bucket[key] ?? null,
          aliases: [key, humanizeKey(key), `${group} ${humanizeKey(key)}`]
        });
      }
    }

    (study.inputFields || []).forEach((f, index) => {
      if (!f || f.kind === "section") return;
      const label = f.label || f.key || `Input ${index + 1}`;
      fields.push({
        path: `inputFields.${index}`,
        label,
        tab: "overview",
        tabLabel: TAB_META.overview.label,
        group: f.section || "Workbook inputs",
        value: f.value ?? null,
        inputIdx: index,
        aliases: [f.key, f.label, humanizeKey(f.key)].filter(Boolean)
      });
    });

    return fields;
  }

  function catalogByTab(catalog) {
    const byTab = {};
    for (const f of catalog) {
      const tab = f.tab || "overview";
      if (!byTab[tab]) {
        byTab[tab] = {
          tab,
          tabLabel: f.tabLabel || tab,
          fields: []
        };
      }
      byTab[tab].fields.push({
        path: f.path,
        label: f.label,
        group: f.group,
        value: f.value,
        aliases: f.aliases
      });
    }
    return byTab;
  }

  function openBuddy() {
    state.buddyOpen = true;
    if (els.buddyPanel) {
      els.buddyPanel.hidden = false;
      els.buddyPanel.setAttribute("aria-hidden", "false");
    }
    if (els.buddyFab) els.buddyFab.setAttribute("aria-expanded", "true");
    paintBuddyChat();
    refreshBuddyModelLabel();
    if (els.askInput) els.askInput.focus();
  }

  async function refreshBuddyModelLabel() {
    const el = document.getElementById("buddyModelLabel");
    if (!el) return;
    try {
      const res = await fetch(apiUrl("/api/health"));
      const data = await res.json().catch(() => ({}));
      const dep = data?.llm?.deployment || data?.llm?.resolvedFrom?.deployment || "";
      const active = data?.llm?.active || "";
      if (dep) {
        el.textContent = `Study bid helper · ${dep}${active ? ` (${active})` : ""}`;
      } else if (active) {
        el.textContent = `Study bid helper · provider ${active}`;
      }
    } catch (_) {}
  }

  function closeBuddy() {
    state.buddyOpen = false;
    if (els.buddyPanel) {
      els.buddyPanel.hidden = true;
      els.buddyPanel.setAttribute("aria-hidden", "true");
    }
    if (els.buddyFab) els.buddyFab.setAttribute("aria-expanded", "false");
  }

  function toggleBuddy() {
    if (state.buddyOpen) closeBuddy();
    else openBuddy();
  }

  function paintBuddyChat() {
    if (!els.askLog) return;
    const turns = state.askHistory
      .map((t, idx) => {
        const who = t.role === "user" ? "You" : "Buddy";
        let proposalHtml = "";
        if (t.proposal) {
          const st = t.proposal.status || "pending";
          if (t.proposal.kind === "create_study") {
            const rows = (t.proposal.summary || [])
              .map((line) => `<li>${escapeHtml(line)}</li>`)
              .join("");
            const actions = st === "pending"
              ? `<div class="buddy-proposal-actions">
                  <button type="button" class="btn btn-primary" data-buddy-create="${t.proposal.id}">Create study</button>
                  <button type="button" class="btn btn-ghost" data-buddy-reject="${t.proposal.id}">Reject</button>
                </div>`
              : `<p class="muted">${st === "applied" ? "Study created and opened." : "Rejected."}</p>`;
            proposalHtml = `<div class="buddy-proposal ${escapeAttr(st)}">
              <div class="chat-who">New study</div>
              <ul>${rows}</ul>
              ${actions}
            </div>`;
          } else if (t.proposal.patches && t.proposal.patches.length) {
            const rows = t.proposal.patches
              .map((p) => `<li><strong>${escapeHtml(p.label || p.path)}</strong> → ${escapeHtml(formatPatchValue(p.value))}</li>`)
              .join("");
            const actions = st === "pending"
              ? `<div class="buddy-proposal-actions">
                  <button type="button" class="btn btn-primary" data-buddy-apply="${t.proposal.id}">Apply</button>
                  <button type="button" class="btn btn-ghost" data-buddy-reject="${t.proposal.id}">Reject</button>
                </div>`
              : `<p class="muted">${st === "applied" ? "Applied to the open study (Save when ready)." : "Rejected."}</p>`;
            proposalHtml = `<div class="buddy-proposal ${escapeAttr(st)}">
              <div class="chat-who">Proposed changes</div>
              <ul>${rows}</ul>
              ${actions}
            </div>`;
          }
        }
        return `<div class="chat-turn ${t.role}" data-ask-idx="${idx}">
          <div class="chat-who">${who}</div>
          <div class="chat-body">${formatBuddyHtml(t.content)}</div>
          ${proposalHtml}
        </div>`;
      })
      .join("");
    els.askLog.innerHTML = turns ||
      "<p class=\"muted\">Try “create a new study for Alcon, protocol X, 120 enrolled, 15 sites”, or “set enrolled subjects to 120”.</p>";
    els.askLog.scrollTop = els.askLog.scrollHeight;
    if (els.askStatus) {
      els.askStatus.textContent = state.buddyBusy ? "Thinking…" : "";
    }
    if (els.btnAsk) els.btnAsk.disabled = !!state.buddyBusy;
  }

  function formatPatchValue(v) {
    if (v == null) return "—";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function resolveSectionId(target) {
    const t = String(target || "").toLowerCase().trim();
    if (!t) return null;
    if (["ask", "ask buddy", "buddy", "chat"].includes(t)) return "__buddy__";
    for (const s of SBW.sections) {
      if (s.id === t || s.label.toLowerCase() === t) return s.id;
    }
    for (const [id, aliases] of Object.entries(SECTION_NAV_ALIASES)) {
      if (aliases.some((a) => t === a || t.includes(a))) return id;
    }
    return null;
  }

  /** Pure “open/go to …” intents — navigate without waiting on the model. */
  function matchNavigateOnly(question) {
    const q = String(question || "")
      .toLowerCase()
      .replace(/[?.!]+$/g, "")
      .trim();
    const m = q.match(
      /^(?:please\s+)?(?:open|go to|show|switch to|navigate to|take me to)\s+(.+)$/i
    );
    if (!m) return null;
    return resolveSectionId(m[1]);
  }

  function normalizeFieldToken(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[_./()-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function coercePatchValue(raw) {
    const s = String(raw ?? "").trim();
    if (s === "") return "";
    if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
    if (/^(on|yes)$/i.test(s)) return true;
    if (/^(off|no)$/i.test(s)) return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s.replace(/^["']|["']$/g, "");
  }

  function scoreFieldMatch(token, field, activeTab) {
    const t = normalizeFieldToken(token);
    if (!t) return 0;
    const label = normalizeFieldToken(field.label);
    const path = normalizeFieldToken(field.path);
    const aliases = (field.aliases || []).map(normalizeFieldToken);
    let score = 0;

    if (t === label || t === path || aliases.includes(t)) score = 100;
    else if (aliases.some((a) => a === t || a.endsWith(` ${t}`) || t.endsWith(` ${a}`))) score = 90;
    else if (label && (label.includes(t) || t.includes(label)) && t.length >= 3) score = 70;
    else if (aliases.some((a) => a.includes(t) || t.includes(a)) && t.length >= 4) score = 55;
    else return 0;

    if (field.tab === activeTab) score += 25;
    if (t === "notes" || t === "notes field") {
      if (field.tab === activeTab && String(field.path).endsWith(".notes")) score += 40;
      else if (String(field.path).endsWith(".notes")) score += 5;
    }
    return score;
  }

  function resolveFieldPath(token) {
    const catalog = buildEditableFieldCatalog();
    const activeTab = state.sectionId;
    let best = null;
    let bestScore = 0;
    for (const field of catalog) {
      const score = scoreFieldMatch(token, field, activeTab);
      if (score > bestScore) {
        bestScore = score;
        best = field;
      }
    }
    if (!best || bestScore < 50) return null;
    return {
      path: best.path,
      label: `${best.label} (${best.tabLabel})`,
      tab: best.tab,
      inputIdx: best.inputIdx
    };
  }

  function readFieldValue(path, inputIdx) {
    if (inputIdx != null && state.study.inputFields?.[inputIdx]) {
      return state.study.inputFields[inputIdx].value;
    }
    if (path.startsWith("inputFields.")) {
      const idx = Number(path.split(".")[1]);
      return state.study.inputFields?.[idx]?.value;
    }
    if (path.startsWith("drivers.")) {
      return state.study.drivers?.[path.slice(8)];
    }
    if (path.startsWith("assumptions.")) {
      const parts = path.split(".");
      const group = parts[1];
      const key = parts.slice(2).join(".");
      return state.study.assumptions?.[group]?.[key];
    }
    return state.study[path];
  }

  function writeFieldValue(patch) {
    const path = patch.path;
    const value = patch.value;
    if (patch.inputIdx != null || path.startsWith("inputFields.")) {
      const idx = patch.inputIdx != null
        ? patch.inputIdx
        : Number(String(path).split(".")[1]);
      if (!state.study.inputFields) state.study.inputFields = [];
      if (!state.study.inputFields[idx]) return false;
      state.study.inputFields[idx].value = value;
      const key = state.study.inputFields[idx].key;
      if (key && !String(key).startsWith("input:") && !String(key).startsWith("driver:")) {
        if (!state.study.header) state.study.header = {};
        state.study.header[key] = value;
        if (STUDY_HEADER_FIELDS.some((f) => f.key === key)) state.study[key] = value;
      }
      if (String(key || "").startsWith("driver.")) {
        const dkey = String(key).replace(/^driver\./, "");
        if (state.study.drivers && dkey in state.study.drivers) {
          state.study.drivers[dkey] = value;
        }
      }
      return true;
    }
    if (path.startsWith("drivers.")) {
      const key = path.slice(8);
      if (!state.study.drivers) state.study.drivers = {};
      state.study.drivers[key] = value;
      return true;
    }
    if (path.startsWith("assumptions.")) {
      const parts = path.split(".");
      const group = parts[1];
      const key = parts.slice(2).join(".");
      if (!group || !key) return false;
      if (!state.study.assumptions) state.study.assumptions = {};
      if (!state.study.assumptions[group]) state.study.assumptions[group] = {};
      state.study.assumptions[group][key] = value;
      return true;
    }
    if (STUDY_HEADER_FIELDS.some((f) => f.key === path) || path === "studyId" || path === "versionLabel") {
      state.study[path] = value;
      if (!state.study.header) state.study.header = {};
      state.study.header[path] = value;
      return true;
    }
    return false;
  }

  function normalizePatches(rawPatches) {
    if (!Array.isArray(rawPatches)) return [];
    const out = [];
    for (const raw of rawPatches) {
      if (!raw || typeof raw !== "object") continue;
      let path = String(raw.path || "").trim();
      let label = raw.label || path;
      let inputIdx = raw.inputIdx;
      let tab = raw.tab;
      if (!path && (raw.field || raw.label)) {
        const resolved = resolveFieldPath(raw.field || raw.label);
        if (resolved) {
          path = resolved.path;
          label = resolved.label;
          inputIdx = resolved.inputIdx;
          tab = resolved.tab;
        }
      }
      if (path.startsWith("driver.")) path = `drivers.${path.slice(7)}`;
      if (path.startsWith("assumption.")) path = `assumptions.${path.slice(11)}`;
      if (path && !path.includes(".") && !STUDY_HEADER_FIELDS.some((f) => f.key === path)) {
        const resolved = resolveFieldPath(path);
        if (resolved) {
          path = resolved.path;
          label = label === path || !raw.label ? resolved.label : label;
          inputIdx = resolved.inputIdx;
          tab = resolved.tab;
        }
      }
      if (!path.includes(".") && state.study.drivers && path in state.study.drivers) {
        path = `drivers.${path}`;
      }
      if (path.startsWith("inputFields.") && inputIdx == null) {
        inputIdx = Number(path.split(".")[1]);
      }
      if (!path) continue;
      if (!tab) {
        if (path.startsWith("assumptions.")) tab = path.split(".")[1];
        else if (path.startsWith("drivers.") || STUDY_HEADER_FIELDS.some((f) => f.key === path)) tab = "overview";
      }
      out.push({
        path,
        label,
        value: raw.value,
        inputIdx,
        tab,
        from: readFieldValue(path, inputIdx)
      });
    }
    return out;
  }

  /** Pure “set X to Y” — propose without waiting on the model. */
  function matchFillOnly(question) {
    const q = String(question || "").replace(/[?.!]+$/g, "").trim();
    const m = q.match(
      /^(?:please\s+)?(?:set|fill(?:\s+in)?|change|update|write)\s+(?:the\s+)?(.+?)(?:\s+field)?\s+(?:to|with|=|:)\s+([\s\S]+)$/i
    );
    if (!m) return null;
    const resolved = resolveFieldPath(m[1]);
    if (!resolved) return null;
    return normalizePatches([{
      path: resolved.path,
      label: resolved.label,
      value: coercePatchValue(m[2]),
      inputIdx: resolved.inputIdx,
      tab: resolved.tab
    }]);
  }

  function extractApplyPatches(text) {
    const src = String(text || "");
    const re = /\bAPPLY:\s*(\[[\s\S]*?\])/gi;
    let match;
    let cleaned = src;
    const patches = [];
    while ((match = re.exec(src)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        patches.push(...normalizePatches(parsed));
      } catch (_) {}
      cleaned = cleaned.replace(match[0], "\n");
    }
    return { text: cleaned.trim(), patches };
  }

  function extractCreateStudy(text) {
    const src = String(text || "");
    const re = /\bCREATE_STUDY:\s*(\{[\s\S]*?\})\s*(?=\n(?:NAVIGATE:|APPLY:)|$)/i;
    const m = src.match(re) || src.match(/\bCREATE_STUDY:\s*(\{[\s\S]*\})\s*$/i);
    if (!m) return { text: src.trim(), create: null };
    let create = null;
    try {
      create = JSON.parse(m[1]);
    } catch (_) {
      // try to find balanced JSON object after marker
      const idx = src.toUpperCase().indexOf("CREATE_STUDY:");
      if (idx >= 0) {
        const brace = src.indexOf("{", idx);
        if (brace >= 0) {
          let depth = 0;
          for (let i = brace; i < src.length; i++) {
            if (src[i] === "{") depth += 1;
            else if (src[i] === "}") {
              depth -= 1;
              if (depth === 0) {
                try {
                  create = JSON.parse(src.slice(brace, i + 1));
                } catch (_) {}
                break;
              }
            }
          }
        }
      }
    }
    const cleaned = src.replace(/\bCREATE_STUDY:\s*\{[\s\S]*\}\s*/i, "\n").trim();
    return { text: cleaned, create };
  }

  function summarizeCreatePayload(payload) {
    if (!payload || typeof payload !== "object") return [];
    const lines = [];
    const add = (label, v) => {
      if (v == null || v === "") return;
      lines.push(`${label}: ${v}`);
    };
    add("Opportunity", payload.studyId || payload.opportunityId || "(auto NEW-…)");
    add("Client", payload.clientName);
    add("Title", payload.title);
    add("Protocol", payload.protocol);
    add("Phase", payload.phase);
    add("TA", payload.therapeuticArea);
    add("Indication", payload.indication);
    const d = payload.drivers || {};
    add("Enrolled", d.enrolledSubjects ?? d.patients);
    add("Screened", d.screenedSubjects);
    add("Sites", d.coreSites ?? d.sites);
    add("Enrollment months", d.enrollmentMonths);
    add("Notes", payload.notes);
    return lines.length ? lines : ["Draft study with provided details"];
  }

  function buildWorkspaceFromCreate(payload) {
    const base = SBW.defaultStudy();
    const now = new Date().toISOString();
    let studyId = String(payload.studyId || payload.opportunityId || "").trim();
    if (!studyId) studyId = `NEW-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    else if (/^\d{4,5}$/.test(studyId)) studyId = `O-${studyId.padStart(5, "0")}`;
    else if (/^O\d{4,5}$/i.test(studyId)) studyId = `O-${studyId.slice(1).padStart(5, "0")}`;

    const driversIn = payload.drivers && typeof payload.drivers === "object" ? payload.drivers : {};
    const drivers = { ...base.drivers };
    for (const [k, v] of Object.entries(driversIn)) {
      if (v == null || v === "") continue;
      const key = k === "patients" ? "enrolledSubjects" : k === "sites" ? "coreSites" : k;
      drivers[key] = typeof v === "number" ? v : coercePatchValue(v);
    }

    return {
      ...base,
      studyId,
      clientName: payload.clientName || "",
      title: payload.title || "",
      protocol: payload.protocol || "",
      phase: payload.phase || "",
      therapeuticArea: payload.therapeuticArea || "",
      indication: payload.indication || "",
      enrollmentType: payload.enrollmentType || "",
      budgetType: payload.budgetType || "draft",
      versionLabel: payload.versionLabel || "draft",
      drivers,
      header: {
        ...base.header,
        clientName: payload.clientName || null,
        title: payload.title || null,
        protocol: payload.protocol || null,
        phase: payload.phase || null,
        therapeuticArea: payload.therapeuticArea || null,
        indication: payload.indication || null,
        opportunityId: studyId,
        notes: payload.notes || null
      },
      status: "draft",
      source: "buddy_create"
    };
  }

  function pushCreateProposal(content, createPayload) {
    const turn = {
      role: "assistant",
      content,
      proposal: {
        id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: "create_study",
        status: "pending",
        payload: createPayload,
        summary: summarizeCreatePayload(createPayload)
      }
    };
    state.askHistory.push(turn);
  }

  function pushAssistant(content, patches) {
    const turn = { role: "assistant", content };
    if (patches && patches.length) {
      turn.proposal = {
        id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        status: "pending",
        patches
      };
    }
    state.askHistory.push(turn);
  }

  function applyBuddyAnswer(raw) {
    let text = String(raw || "").trim();
    const navMatch = text.match(/\bNAVIGATE:([a-z0-9_-]+)\b/i);
    let sectionId = null;
    if (navMatch) {
      sectionId = resolveSectionId(navMatch[1]);
      text = text.replace(/\s*NAVIGATE:[a-z0-9_-]+\s*/gi, "\n").trim();
    }
    const created = extractCreateStudy(text);
    text = created.text;
    const extracted = extractApplyPatches(text);
    text = extracted.text;
    if (!text) {
      if (created.create) text = "Proposed a new study — click Create study to open it.";
      else if (extracted.patches.length) {
        text = "Proposed field updates — Apply to write them into the open study.";
      } else if (sectionId === "__buddy__") {
        text = "Buddy is already open.";
      } else if (sectionId) {
        text = `Opened ${(SBW.sections.find((s) => s.id === sectionId) || {}).label || sectionId}.`;
      } else {
        text = "I did not return any text that time — try asking again.";
      }
    }
    if (created.create) {
      pushCreateProposal(text, created.create);
    } else {
      pushAssistant(text, extracted.patches);
    }
    if (sectionId === "__buddy__") openBuddy();
    else if (sectionId) setSection(sectionId);
    paintBuddyChat();
  }

  function hasOpenStudy() {
    return Boolean(state.study && String(state.study.studyId || "").trim());
  }

  /** Deselect open study — Buddy / portfolio questions hit all Cosmos studies with no working copy. */
  function clearOpenStudy({ confirmIfDirty = true } = {}) {
    if (confirmIfDirty && state.dirty && hasOpenStudy()) {
      const ok = window.confirm("Clear the open study? Unsaved changes will be discarded from the workspace.");
      if (!ok) return false;
    }
    state.study = SBW.defaultStudy();
    state.lineItems = [];
    state.versions = [];
    state.compare = null;
    state.source = "none";
    state.dirty = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    if (state.sectionId === "overview" || state.sectionId === "recruitment" || state.sectionId === "clinops" || state.sectionId === "monitoring" || state.sectionId === "smo" || state.sectionId === "summary" || state.sectionId === "formulas" || state.sectionId === "reviews") {
      state.sectionId = "studies";
    }
    markSaved();
    if (els.saveStatus) {
      els.saveStatus.textContent = "No study selected";
      els.saveStatus.classList.remove("saved");
    }
    render();
    return true;
  }

  function openNewStudyDialog() {
    if (state.dirty) {
      const ok = window.confirm("You have unsaved changes on the current study. Start a new draft anyway?");
      if (!ok) return;
    }
    if (els.newStudyId) els.newStudyId.value = "";
    if (els.newStudyClient) els.newStudyClient.value = "";
    if (els.newStudyProtocol) els.newStudyProtocol.value = "";
    if (els.newStudyTitle) els.newStudyTitle.value = "";
    if (els.newStudyDialog) els.newStudyDialog.showModal();
  }

  async function startNewStudyFromForm() {
    const payload = {
      studyId: (els.newStudyId && els.newStudyId.value.trim()) || undefined,
      clientName: (els.newStudyClient && els.newStudyClient.value.trim()) || undefined,
      protocol: (els.newStudyProtocol && els.newStudyProtocol.value.trim()) || undefined,
      title: (els.newStudyTitle && els.newStudyTitle.value.trim()) || undefined,
      versionLabel: "draft",
      budgetType: "draft",
      createdBy: state.entraUser?.email || state.userId || "ui"
    };
    const workspace = buildWorkspaceFromCreate(payload);
    let cosmosOk = false;
    let cosmosError = null;
    try {
      const res = await fetch(apiUrl("/api/studies"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, studyId: workspace.studyId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      cosmosOk = true;
      if (data.studyId) workspace.studyId = data.studyId;
      if (data.versionId) {
        workspace.currentVersionId = data.versionId;
        workspace.viewingVersionId = data.versionId;
      }
    } catch (err) {
      cosmosError = String(err.message || err);
    }

    state.study = workspace;
    state.lineItems = [];
    state.versions = [];
    state.source = cosmosOk ? "cosmos" : "local";
    state.sectionId = "overview";
    state.askHistory = [];
    markDirty();
    save();
    render();
    if (els.saveStatus) {
      els.saveStatus.textContent = cosmosOk
        ? `Created ${workspace.studyId}`
        : `Draft ${workspace.studyId} (local${cosmosError ? " — Cosmos later" : ""})`;
      els.saveStatus.classList.remove("saved");
    }
  }

  async function applyCreateStudy(id) {
    const proposal = findProposal(id);
    if (!proposal || proposal.kind !== "create_study" || proposal.status !== "pending") return;
    proposal.status = "applied";
    paintBuddyChat();

    const workspace = buildWorkspaceFromCreate(proposal.payload || {});
    let cosmosOk = false;
    let cosmosError = null;
    try {
      const res = await fetch(apiUrl("/api/studies"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...proposal.payload,
          studyId: workspace.studyId,
          createdBy: state.entraUser?.email || state.userId || "buddy"
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      cosmosOk = true;
      if (data.studyId) workspace.studyId = data.studyId;
      if (data.versionId) {
        workspace.currentVersionId = data.versionId;
        workspace.viewingVersionId = data.versionId;
      }
    } catch (err) {
      cosmosError = String(err.message || err);
    }

    state.study = workspace;
    state.lineItems = [];
    state.versions = [];
    state.source = cosmosOk ? "cosmos" : "buddy";
    state.sectionId = "overview";
    markDirty();
    save();
    render();
    openBuddy();
    pushAssistant(
      cosmosOk
        ? `Created ${workspace.studyId} in Cosmos and opened Overview. Fill remaining tabs or upload a budget workbook when you have one.`
        : `Opened draft ${workspace.studyId} locally${cosmosError ? ` (Cosmos save failed: ${cosmosError})` : ""}. You can still edit and Save in the browser.`
    );
    paintBuddyChat();
  }

  function findProposal(id) {
    for (const turn of state.askHistory) {
      if (turn.proposal && turn.proposal.id === id) return turn.proposal;
    }
    return null;
  }

  function applyProposal(id) {
    const proposal = findProposal(id);
    if (!proposal || proposal.status !== "pending") return;
    let applied = 0;
    let jumpTab = null;
    for (const patch of proposal.patches) {
      if (writeFieldValue(patch)) {
        applied += 1;
        if (!jumpTab && patch.tab) jumpTab = patch.tab;
      }
    }
    proposal.status = "applied";
    if (applied) {
      markDirty();
      recalc();
      if (jumpTab && jumpTab !== state.sectionId && SBW.sections.some((s) => s.id === jumpTab)) {
        state.sectionId = jumpTab;
      }
      render();
    }
    pushAssistant(
      applied
        ? `Applied ${applied} field update${applied === 1 ? "" : "s"}. Save when you’re ready to keep them.`
        : "Could not apply those fields — check the path labels and try again."
    );
    paintBuddyChat();
  }

  function rejectProposal(id) {
    const proposal = findProposal(id);
    if (!proposal || proposal.status !== "pending") return;
    proposal.status = "rejected";
    pushAssistant(
      proposal.kind === "create_study"
        ? "Okay — did not create that study."
        : "Okay — left those fields unchanged."
    );
    paintBuddyChat();
  }

  async function sendAsk() {
    const input = els.askInput;
    const question = (input && input.value || "").trim();
    if (!question) {
      if (els.askStatus) els.askStatus.textContent = "Type a question first.";
      return;
    }
    if (!state.buddyOpen) openBuddy();
    state.askHistory.push({ role: "user", content: question });
    if (input) input.value = "";

    const navOnly = matchNavigateOnly(question);
    if (navOnly) {
      if (navOnly === "__buddy__") {
        pushAssistant("Buddy is open — ask me anything about this study.");
        paintBuddyChat();
        return;
      }
      const label = (SBW.sections.find((s) => s.id === navOnly) || {}).label || navOnly;
      pushAssistant(`Opened ${label}.`);
      setSection(navOnly);
      paintBuddyChat();
      return;
    }

    const fillOnly = matchFillOnly(question);
    if (fillOnly && fillOnly.length) {
      if (!hasOpenStudy()) {
        pushAssistant("No study is selected. Click New study or open one from Studies before editing fields — or stay in All studies mode to ask portfolio questions.");
        paintBuddyChat();
        return;
      }
      pushAssistant(
        "Proposed field update — click Apply to write it into the open study.",
        fillOnly
      );
      paintBuddyChat();
      return;
    }

    state.buddyBusy = true;
    paintBuddyChat();
    const catalog = buildEditableFieldCatalog();
    const qLower = question.toLowerCase();
    const portfolioMode = !hasOpenStudy();
    const askAcross =
      /\b(all studies|across (all )?studies|every study|portfolio|average|avg|mean)\b/.test(qLower) ||
      /\b(how many studies|which study|largest study|biggest study)\b/.test(qLower) ||
      /\b(across|among)\b.{0,40}\bstudies\b/.test(qLower);
    const wantPortfolio = portfolioMode || askAcross;
    try {
      const res = await fetch(apiUrl("/api/ask"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          studyId: wantPortfolio ? undefined : (state.study.studyId || undefined),
          studySnapshot: wantPortfolio ? undefined : state.study,
          // Always ask API to include Cosmos portfolio; noStudy = zero selection / no open-study bias
          portfolio: true,
          noStudy: portfolioMode || undefined,
          activeTab: state.sectionId,
          activeTabLabel: (SBW.sections.find((s) => s.id === state.sectionId) || {}).label || state.sectionId,
          editableFields: wantPortfolio ? [] : catalog,
          fieldsByTab: wantPortfolio ? undefined : catalogByTab(catalog),
          user: state.entraUser || undefined,
          // Same indication/region as Ora Clinical Intelligence tab (and pack already on screen)
          intelligenceHint: {
            indication: String(state.intelligence.indication || state.scorecard.indication || "").trim() || undefined,
            country: state.intelligence.globalRegion
              ? "Global"
              : (state.intelligence.countries || []).join(", ") || undefined,
            countries: state.intelligence.globalRegion ? undefined : state.intelligence.countries,
            global: state.intelligence.globalRegion || undefined
          },
          intelligencePack:
            state.intelligence.pack &&
            state.intelligence.pack.source === "ora_clinical_intelligence" &&
            !state.intelligence.pack.error
              ? state.intelligence.pack
              : undefined,
          history: state.askHistory.slice(0, -1).map((t) => ({
            role: t.role,
            content: t.content
          }))
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        pushAssistant(data.error || `Request failed (${res.status})`);
      } else {
        applyBuddyAnswer(data.answer);
        if (els.askStatus) {
          const modelLabel = data.deployment || data.model || "";
          const modelNote = modelLabel ? ` · ${modelLabel}` : "";
          const intelBits = [];
          if (data.intelligenceQuery?.indication) intelBits.push(data.intelligenceQuery.indication);
          if (data.intelligenceQuery?.country) intelBits.push(data.intelligenceQuery.country);
          const intelNote = data.intelligenceAttached
            ? ` · Intel${intelBits.length ? ` ${intelBits.join(" / ")}` : ""}`
            : "";
          if (data.answerFocus === "portfolio" && data.databaseStudyCount != null) {
            els.askStatus.textContent = `All studies · Cosmos ${data.portfolioMatched ?? "?"} / ${data.databaseStudyCount}${intelNote}${modelNote}`;
          } else if (portfolioMode) {
            els.askStatus.textContent = `All studies mode (no study selected)${intelNote}${modelNote}`;
          } else {
            els.askStatus.textContent = hasOpenStudy()
              ? `Open study · ${state.study.studyId}${intelNote}${modelNote}`
              : `${intelNote}${modelNote}`.replace(/^ · /, "") || modelLabel;
          }
        }
        state.buddyBusy = false;
        paintBuddyChat();
        return;
      }
    } catch (err) {
      pushAssistant(`Could not reach /api/ask. ${String(err)}`);
    }
    state.buddyBusy = false;
    paintBuddyChat();
  }

  // ---- Ora Clinical Intelligence tab -------------------------------------
  const INTEL_COMMON_INDICATIONS = [
    "Dry Eye",
    "Glaucoma",
    "Cataract",
    "Diabetic Macular Edema (DME)",
    "Wet AMD",
    "Geographic Atrophy",
    "Retinitis Pigmentosa",
    "Presbyopia",
    "Allergic Conjunctivitis",
    "Myopia",
    "Thyroid Eye Disease"
  ];

  async function ensureIntelligenceLoaded() {
    if (!state.intelligence.health && !state.intelligence.loading) {
      await loadIntelligenceHealth();
    }
  }

  async function loadIntelligenceHealth() {
    state.intelligence.loading = true;
    try {
      const res = await fetch(apiUrl("/api/intelligence"));
      const data = await res.json().catch(() => ({}));
      state.intelligence.health = res.ok ? data : { ok: false, error: data.error || `HTTP ${res.status}` };
    } catch (err) {
      state.intelligence.health = { ok: false, error: String(err) };
    }
    try {
      const sres = await fetch(apiUrl("/api/ctgov/sync"));
      const sdata = await sres.json().catch(() => ({}));
      if (sres.ok) state.intelligence.syncStatus = sdata;
    } catch (_) {}
    state.intelligence.loading = false;
    if (state.sectionId === "intelligence") render();
  }

  async function runIntelligenceQuery(indication) {
    const ind = String(indication != null ? indication : state.intelligence.indication || "").trim();
    const global = !!state.intelligence.globalRegion;
    const countries = global ? [] : [...(state.intelligence.countries || [])];
    if (!ind && !global && !countries.length) {
      state.intelligence.status = "Pick an indication and/or country (or Global) first.";
      if (state.sectionId === "intelligence") render();
      return;
    }
    state.intelligence.indication = ind;
    state.intelligence.loading = true;
    state.intelligence.status = `Querying Cosmos${ind ? ` for “${ind}”` : ""}${
      global ? " · Global" : countries.length ? ` · ${countries.join(", ")}` : ""
    }…`;
    if (state.sectionId === "intelligence") render();
    try {
      const params = new URLSearchParams();
      if (ind) params.set("q", ind);
      if (global) params.set("global", "true");
      else if (countries.length) params.set("countries", countries.join(","));
      const res = await fetch(apiUrl(`/api/intelligence/indication?${params.toString()}`));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        state.intelligence.pack = null;
        state.intelligence.status = data.error || `Query failed (${res.status})`;
      } else {
        state.intelligence.pack = data;
        state.intelligence.status = "";
      }
    } catch (err) {
      state.intelligence.pack = null;
      state.intelligence.status = `Could not reach /api/intelligence. ${String(err)}`;
    }
    state.intelligence.loading = false;
    if (state.sectionId === "intelligence") render();
  }

  async function runCtgovSyncManual() {
    if (state.intelligence.syncBusy) return;
    state.intelligence.syncBusy = true;
    state.intelligence.syncMessage = "Running ClinicalTrials.gov delta sync…";
    if (state.sectionId === "intelligence") render();
    try {
      const res = await fetch(apiUrl("/api/ctgov/sync"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full: false })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        state.intelligence.syncMessage = data.error || `Sync failed (${res.status})`;
      } else if (data.skipped) {
        state.intelligence.syncMessage = data.reason || "Sync skipped.";
      } else {
        state.intelligence.syncMessage = `Synced ${data.upserted ?? 0} trials (${data.mode || "delta"}${
          data.incomplete ? ", partial — will catch up next run" : ""
        }).`;
      }
      await loadIntelligenceHealth();
    } catch (err) {
      state.intelligence.syncMessage = `Sync error: ${String(err)}`;
    }
    state.intelligence.syncBusy = false;
    if (state.sectionId === "intelligence") render();
  }

  function askBuddyAboutIndication(indication) {
    const ind = String(indication || state.intelligence.indication || "").trim();
    const global = !!state.intelligence.globalRegion;
    const countries = global ? [] : [...(state.intelligence.countries || [])];
    if (!ind && !global && !countries.length) return;
    openBuddy();
    if (els.askInput) {
      const geo = global ? " globally" : countries.length ? ` in ${countries.join(", ")}` : "";
      els.askInput.value = ind
        ? `Give an executive summary of the competitive and Ora enrollment landscape for ${ind}${geo}. Highlight typical PSM and 2–3 takeaways.`
        : `Which Ora sites perform best${geo}? Include PSM when available.`;
    }
    sendAsk();
  }

  function countryBagState(scope) {
    return scope === "scorecard" ? state.scorecard : state.intelligence;
  }

  function setCountryGlobal(scope, on) {
    const st = countryBagState(scope);
    st.globalRegion = !!on;
    if (st.globalRegion) {
      st.countries = [];
      st.countryQuery = "";
      st.countrySuggestOpen = false;
    }
  }

  function addCountrySelection(scope, name) {
    const st = countryBagState(scope);
    const resolved =
      name === (SBW.INTEL_GLOBAL || "Global")
        ? SBW.INTEL_GLOBAL
        : SBW.resolveIntelCountry
          ? SBW.resolveIntelCountry(name)
          : name;
    if (!resolved) return false;
    if (resolved === (SBW.INTEL_GLOBAL || "Global")) {
      setCountryGlobal(scope, true);
      return true;
    }
    st.globalRegion = false;
    if (!st.countries.includes(resolved)) st.countries.push(resolved);
    st.countryQuery = "";
    st.countrySuggestOpen = false;
    return true;
  }

  function removeCountrySelection(scope, name) {
    const st = countryBagState(scope);
    st.countries = (st.countries || []).filter((c) => c !== name);
  }

  function renderCountryPicker(scope) {
    const st = countryBagState(scope);
    const chipsPopular = (SBW.intelCountryChips || []).slice(0, 8).map((c) => {
      const on = !st.globalRegion && (st.countries || []).includes(c);
      return `<button type="button" class="filter-pill${on ? " active" : ""}" data-country-add="${escapeAttr(
        scope
      )}" data-country-name="${escapeAttr(c)}">${escapeHtml(c)}</button>`;
    }).join("");
    const globalOn = st.globalRegion;
    const selected = st.globalRegion
      ? `<span class="filter-token global">Global <button type="button" class="buddy-country-x" data-country-clear-global="${escapeAttr(
          scope
        )}" aria-label="Clear Global">×</button></span>`
      : (st.countries || [])
          .map(
            (c) =>
              `<span class="filter-token">${escapeHtml(c)} <button type="button" class="buddy-country-x" data-country-remove="${escapeAttr(
                scope
              )}" data-country-name="${escapeAttr(c)}" aria-label="Remove">×</button></span>`
          )
          .join(" ");
    const suggestions =
      st.countrySuggestOpen && SBW.suggestIntelCountries
        ? SBW.suggestIntelCountries(st.countryQuery || "", st.countries || [], 10)
        : [];
    const suggestHtml = suggestions.length
      ? `<ul class="country-suggest" role="listbox">${suggestions
          .map(
            (s) =>
              `<li><button type="button" data-country-add="${escapeAttr(scope)}" data-country-name="${escapeAttr(
                s.name
              )}">${escapeHtml(s.name)} <span class="muted">${escapeHtml(
                (s.aliases || []).slice(0, 3).join(" · ")
              )}</span></button></li>`
          )
          .join("")}</ul>`
      : "";
    return `
      <div class="country-picker" data-country-scope="${escapeAttr(scope)}">
        <div class="country-picker-row">
          <button type="button" class="global-toggle${globalOn ? " active" : ""}" data-country-global="${escapeAttr(
            scope
          )}">Global</button>
          <div class="country-typeahead">
            <input id="${scope}CountryQuery" class="input" autocomplete="off" placeholder="Search country or code (US, USA, TUR)" value="${escapeAttr(
              st.countryQuery || ""
            )}" data-country-query="${escapeAttr(scope)}" ${globalOn ? "disabled" : ""} />
            ${suggestHtml}
          </div>
        </div>
        <div class="filter-selections">${selected || `<span class="muted">Select countries, or choose Global.</span>`}</div>
        <div class="filter-popular"><span class="filter-caption">Popular</span>${chipsPopular}</div>
      </div>`;
  }

  function renderIndicationPicker(scope) {
    const st = scope === "scorecard" ? state.scorecard : state.intelligence;
    const attr = scope === "scorecard" ? "data-score-ind" : "data-intel-ind";
    return `<div class="filter-popular indication-popular">
      <span class="filter-caption">Common</span>
      ${INTEL_COMMON_INDICATIONS.map(
        (i) =>
          `<button type="button" class="filter-pill${st.indication === i ? " active" : ""}" ${attr}="${escapeAttr(
            i
          )}">${escapeHtml(i)}</button>`
      ).join("")}
    </div>`;
  }

  function intelStatNum(v) {
    if (v == null || Number.isNaN(v)) return "—";
    return typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : escapeHtml(String(v));
  }

  function renderIntelligenceHealthCard() {
    const h = state.intelligence.health;
    const sync = state.intelligence.syncStatus || {};
    const syncMsg = state.intelligence.syncMessage
      ? `<p class="muted" style="margin-top:0.5rem;">${escapeHtml(state.intelligence.syncMessage)}</p>`
      : "";
    const lastSync = sync.lastSuccessAt || sync.lastRunAt || sync.watermark || null;
    const syncMeta = lastSync
      ? `<p class="muted" style="margin:0.35rem 0 0;">Last CT.gov sync: ${escapeHtml(
          String(lastSync)
        )}${sync.count != null ? ` · ${Number(sync.count).toLocaleString()} trials` : ""}</p>`
      : `<p class="muted" style="margin:0.35rem 0 0;">CT.gov sync status unavailable yet.</p>`;

    if (!h) {
      return `<div class="card wide"><h3>Data status</h3><p class="muted">Loading intelligence containers…</p></div>`;
    }
    if (h.ok === false && h.error) {
      return `<div class="card wide"><h3>Data status</h3><p class="muted">Could not read intelligence containers: ${escapeHtml(
        h.error
      )}</p><button type="button" class="btn btn-secondary" id="btnIntelRefresh">Retry</button></div>`;
    }
    const counts = h.counts || {};
    const expected = h.expected || {};
    const rows = Object.keys(expected)
      .map((id) => {
        const c = counts[id];
        const exp = expected[id];
        const val = typeof c === "number" ? c : (c && c.error ? "err" : "—");
        const ok = typeof c === "number" && c === exp;
        const badge = ok
          ? `<span class="badge" style="background:#D1FAE5;color:#065F46;">ok</span>`
          : `<span class="badge" style="background:#FEF3C7;color:#92400E;">${escapeHtml(String(val))}/${exp}</span>`;
        return `<tr><td><code>${escapeHtml(id)}</code></td><td>${intelStatNum(
          typeof c === "number" ? c : null
        )}</td><td>${exp.toLocaleString()}</td><td>${badge}</td></tr>`;
      })
      .join("");
    const syncDisabled = state.intelligence.syncBusy ? "disabled" : "";
    return `
      <div class="card wide">
        <h3>Data status ${h.ok ? "· loaded" : "· check counts"}</h3>
        <p class="muted">Ora Veeva + TrialHub reference tables in Cosmos (<code>bd-budgets</code>). Buddy reads summaries from these.</p>
        <table class="table">
          <thead><tr><th>Container</th><th>Loaded</th><th>Expected</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:0.85rem;display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;">
          <button type="button" class="btn btn-secondary" id="btnIntelRefresh">Refresh</button>
          <button type="button" class="btn btn-primary" id="btnCtgovSync" ${syncDisabled}>${
            state.intelligence.syncBusy ? "Syncing…" : "Sync CT.gov now"
          }</button>
        </div>
        ${syncMeta}
        ${syncMsg}
      </div>`;
  }

  function renderIntelBenchmark() {
    const pack = state.intelligence.pack;
    if (!pack) return "";
    if (pack.error) {
      return `<div class="card wide"><h3>Benchmark</h3><p class="muted">${escapeHtml(pack.error)}</p></div>`;
    }
    const b = pack.indicationBenchmark;
    if (!b) {
      return `<div class="card wide"><h3>Benchmark</h3><p class="muted">No benchmark data returned for this indication.</p></div>`;
    }
    const ora = b.ora || {};
    const th = b.trialhub || {};
    const sites = b.sites || {};

    const oraCard = `
      <div class="card">
        <h3>Ora history (Veeva)</h3>
        <div class="stat">${intelStatNum(ora.psmMedian)}</div>
        <p class="muted">Median PSM · ${intelStatNum(ora.studiesWithPsm)} of ${intelStatNum(
      ora.studyCount
    )} studies with PSM</p>
        <p class="muted">P25–P75: ${intelStatNum(ora.psmP25)} – ${intelStatNum(ora.psmP75)}</p>
      </div>`;

    const thCard = `
      <div class="card">
        <h3>Industry (TrialHub)</h3>
        <div class="stat">${intelStatNum(th.psmMedian)}</div>
        <p class="muted">Median PSM · ${intelStatNum(th.trialsWithPsm)} of ${intelStatNum(
      th.trialCount
    )} trials with PSM</p>
        <p class="muted">${intelStatNum(th.recruitingCount)} recruiting · ${intelStatNum(
      th.completedCount
    )} completed</p>
      </div>`;

    const siteCard = `
      <div class="card">
        <h3>Ora sites</h3>
        <div class="stat">${intelStatNum(sites.sitePsmMedian)}</div>
        <p class="muted">Median site PSM · ${intelStatNum(sites.sitesWithPsmSampled)} sites sampled</p>
        <p class="muted">P75: ${intelStatNum(sites.sitePsmP75)}</p>
      </div>`;

    const topSites = (sites.topSitesByPsm || []).length
      ? `<div class="card wide">
          <h3>Top Ora sites by PSM</h3>
          <table class="table">
            <thead><tr><th>Site</th><th>Country</th><th>Site PSM</th><th>Enrolled</th><th>Trust</th></tr></thead>
            <tbody>${sites.topSitesByPsm
              .map(
                (s) =>
                  `<tr><td>${escapeHtml(s.org_clean || "—")}</td><td>${escapeHtml(
                    s.country || "—"
                  )}</td><td>${intelStatNum(s.site_psm)}</td><td>${intelStatNum(
                    s.total_enrolled
                  )}</td><td>${escapeHtml(s.fsi_trust || "—")}</td></tr>`
              )
              .join("")}</tbody>
          </table>
        </div>`
      : "";

    const thTrials = (th.sampleTrials || []).length
      ? `<div class="card wide">
          <h3>Industry trials (TrialHub)</h3>
          <table class="table">
            <thead><tr><th>NCT</th><th>Sponsor</th><th>Phase</th><th>Status</th><th>Patients</th><th>Sites</th><th>PSM</th></tr></thead>
            <tbody>${th.sampleTrials
              .map(
                (t) =>
                  `<tr><td>${escapeHtml(t.nct || "—")}</td><td>${escapeHtml(
                    t.sponsor || "—"
                  )}</td><td>${escapeHtml(String(t.phase || "—"))}</td><td>${escapeHtml(
                    t.status || "—"
                  )}</td><td>${intelStatNum(t.patients)}</td><td>${intelStatNum(
                    t.sites
                  )}</td><td>${intelStatNum(t.psm_common)}</td></tr>`
              )
              .join("")}</tbody>
          </table>
        </div>`
      : "";

    const crosswalk = (pack.sponsorCrosswalk || []).length
      ? `<div class="card wide">
          <h3>Sponsor → Salesforce</h3>
          <table class="table">
            <thead><tr><th>TrialHub sponsor</th><th>SF account</th><th>Owner</th><th>Tier</th><th>Status</th></tr></thead>
            <tbody>${pack.sponsorCrosswalk
              .map(
                (r) =>
                  `<tr><td>${escapeHtml(r.trialhub_veeva_sponsor || "—")}</td><td>${escapeHtml(
                    r.sf_account_name || "—"
                  )}</td><td>${escapeHtml(r.sf_owner || "—")}</td><td>${escapeHtml(
                    String(r.tier || "—")
                  )}</td><td>${escapeHtml(r.crosswalk_status || "—")}</td></tr>`
              )
              .join("")}</tbody>
          </table>
        </div>`
      : "";

    const aliases = (b.aliasesUsed || []).join(", ");
    return `
      <div class="card wide" style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
        <div>
          <h3 style="margin:0;">Benchmark · ${escapeHtml(b.indicationRequested || state.intelligence.indication)}</h3>
          <p class="muted" style="margin:0.35rem 0 0;">Matched labels: ${escapeHtml(aliases || "—")}</p>
        </div>
        <button type="button" class="btn btn-primary" data-intel-ask="${escapeAttr(
          b.indicationRequested || state.intelligence.indication
        )}">Ask Buddy about this</button>
      </div>
      ${oraCard}
      ${thCard}
      ${siteCard}
      ${topSites}
      ${thTrials}
      ${crosswalk}`;
  }

  function renderIntelligence() {
    const status = state.intelligence.status
      ? `<p class="muted" style="margin-top:0.5rem;">${escapeHtml(state.intelligence.status)}</p>`
      : "";
    const geoLabel = state.intelligence.globalRegion
      ? "Global"
      : (state.intelligence.pack?.query?.countries || state.intelligence.pack?.query?.country ||
          state.intelligence.countries || []).length
        ? Array.isArray(state.intelligence.pack?.query?.countries)
          ? state.intelligence.pack.query.countries.join(", ")
          : (state.intelligence.countries || []).join(", ")
        : "";
    const countryNote = geoLabel
      ? `<p class="muted" style="margin-top:0.35rem;">Region filter: <strong>${escapeHtml(geoLabel)}</strong></p>`
      : "";
    return `
      <div class="grid">
        ${renderIntelligenceHealthCard()}
        <div class="card wide">
          <h3>Indication &amp; region benchmark</h3>
          <p class="muted">Compare Ora history, TrialHub, and CT.gov by indication and geography.</p>
          <div class="benchmark-filter-grid">
            <div class="benchmark-filter-field">
              <label class="field-label" for="intelIndication">Indication</label>
              <input id="intelIndication" class="input" placeholder="Search or choose below" value="${escapeAttr(
                state.intelligence.indication || ""
              )}" />
              ${renderIndicationPicker("intelligence")}
            </div>
            <div class="benchmark-filter-field">
              <label class="field-label">Geography</label>
              ${renderCountryPicker("intelligence")}
            </div>
          </div>
          <div class="benchmark-actions">
            <button type="button" class="btn btn-primary" id="btnIntelQuery">Query</button>
            <button type="button" class="btn btn-secondary" id="btnOpenBenchmark" title="Open this view in a new tab">Open benchmark</button>
          </div>
          ${status}
          ${countryNote}
        </div>
        ${renderIntelBenchmark()}
      </div>`;
  }

  async function runSiteScorecard() {
    const ind = String(state.scorecard.indication || "").trim();
    const global = !!state.scorecard.globalRegion;
    const countries = global ? [] : [...(state.scorecard.countries || [])];
    if (!ind && !global && !countries.length) {
      state.scorecard.status = "Pick an indication and/or country (or Global) first.";
      if (state.sectionId === "scorecard") render();
      return;
    }
    state.scorecard.loading = true;
    state.scorecard.status = `Scoring sites (${state.scorecard.source === "all" ? "Veeva + industry" : "Veeva only"})…`;
    if (state.sectionId === "scorecard") render();
    try {
      const params = new URLSearchParams();
      if (ind) params.set("q", ind);
      if (global) params.set("global", "true");
      else if (countries.length) params.set("countries", countries.join(","));
      params.set("source", state.scorecard.source || "veeva");
      const res = await fetch(apiUrl(`/api/intelligence/sitescorecard?${params.toString()}`));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        state.scorecard.result = null;
        state.scorecard.status = data.error || `Scorecard failed (${res.status})`;
      } else {
        state.scorecard.result = data;
        state.scorecard.status = "";
      }
    } catch (err) {
      state.scorecard.result = null;
      state.scorecard.status = String(err);
    }
    state.scorecard.loading = false;
    if (state.sectionId === "scorecard") render();
  }

  function renderScorecard() {
    const src = state.scorecard.source || "veeva";
    const status = state.scorecard.status
      ? `<p class="muted" style="margin-top:0.5rem;">${escapeHtml(state.scorecard.status)}</p>`
      : "";
    const result = state.scorecard.result;
    let table = "";
    if (result && result.sites && result.sites.length) {
      const showAll = src === "all";
      table = `
        <div class="card wide">
          <h3>Ranked sites · ${escapeHtml(result.countryFilterLabel || "Global")} · ${escapeHtml(
            result.indication || "—"
          )}</h3>
          <p class="muted">${escapeHtml(result.note || "")} · n=${intelStatNum(result.siteCount)}</p>
          <table class="table">
            <thead><tr>
              <th>#</th><th>Site</th><th>Country</th><th>Score</th><th>Site PSM</th><th>Enrolled</th><th>Trust</th>
              ${showAll ? "<th>Industry PSM</th><th>vs Ind.</th><th>Recruiting</th>" : ""}
            </tr></thead>
            <tbody>
              ${result.sites
                .slice(0, 50)
                .map(
                  (s, i) => `<tr>
                  <td>${i + 1}</td>
                  <td>${escapeHtml(s.org_clean || "—")}</td>
                  <td>${escapeHtml(s.country || "—")}</td>
                  <td><span class="buddy-i">${intelStatNum(s.score)}</span></td>
                  <td>${intelStatNum(s.sitePsmMedian)}</td>
                  <td>${intelStatNum(s.totalEnrolledSum)}</td>
                  <td>${intelStatNum(s.highTrustShare)}</td>
                  ${
                    showAll
                      ? `<td>${intelStatNum(s.industryMedianPsm)}</td><td>${intelStatNum(
                          s.vsIndustry
                        )}</td><td>${intelStatNum(s.recruitingTrials)}</td>`
                      : ""
                  }
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`;
    } else if (result && !result.sites?.length) {
      table = `<div class="card wide"><p class="muted">No scored sites for this filter.</p></div>`;
    }
    return `
      <div class="grid">
        <div class="card wide">
          <h3>Site Scorecard</h3>
          <p class="muted">Veeva = Ora site history only. All data = same scores plus industry TrialHub overlay by country (what everyone reports at market level — named competitor sites are not in this pack).</p>
          <div class="score-source-toggle" style="margin-top:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
            <button type="button" class="btn ${src === "veeva" ? "btn-primary" : "btn-secondary"}" data-score-source="veeva">Veeva (Ora)</button>
            <button type="button" class="btn ${src === "all" ? "btn-primary" : "btn-secondary"}" data-score-source="all">All data</button>
          </div>
          <div class="benchmark-filter-grid">
            <div class="benchmark-filter-field">
              <label class="field-label" for="scoreIndication">Indication</label>
              <input id="scoreIndication" class="input" placeholder="Search or choose below" value="${escapeAttr(
                state.scorecard.indication || ""
              )}" />
              ${renderIndicationPicker("scorecard")}
            </div>
            <div class="benchmark-filter-field">
              <label class="field-label">Geography</label>
              ${renderCountryPicker("scorecard")}
            </div>
          </div>
          <div class="benchmark-actions">
            <button type="button" class="btn btn-primary" id="btnScoreQuery">Score sites</button>
          </div>
          ${status}
        </div>
        ${table}
      </div>`;
  }

  function renderUpload() {
    const locked = !canEdit("Analyst");
    const dis = locked ? "disabled" : "";
    return `
      <div class="grid">
        <div class="card wide">
          <h3>Upload budgets into Cosmos</h3>
          <p class="muted">
            Drop one <code>.xlsx</code>/<code>.xlsm</code>, many files, or a <code>.zip</code>
            with nested folders. The zip is read into memory once (avoids Chrome
            “permission problems” on long folder uploads), then each workbook is posted
            one at a time.
          </p>
          <div class="form-grid" style="margin-top:1rem;">
            <div class="full">
              <label class="field-label">Files</label>
              <input id="uploadInput" class="input" type="file" accept=".xlsx,.xlsm,.zip" multiple ${dis} />
            </div>
            <div>
              <label class="field-label">Mode</label>
              <select id="uploadMode" class="select" ${dis}>
                <option value="load">Parse + load to Cosmos</option>
                <option value="dry">Parse only (report, no Cosmos write)</option>
              </select>
            </div>
          </div>
          <div style="margin-top:1rem;display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" id="btnStartUpload" ${dis}>Start upload</button>
            <span class="muted" id="uploadStatus">Ready</span>
          </div>
          <div class="upload-progress" id="uploadProgressWrap" hidden>
            <div class="upload-progress-track">
              <div class="upload-progress-bar" id="uploadProgressBar" style="width:0%"></div>
            </div>
            <div class="muted" id="uploadProgressLabel">0%</div>
          </div>
        </div>
        <div class="card wide">
          <h3>Quarantine + parse learning</h3>
          <p class="muted">
            Unsure / near-empty parses land here. Similar old formats still load into Cosmos.
            Quarantine logs propose sheet/field aliases; after ~2 sightings they auto-apply on the next upload.
          </p>
          <div style="margin-top:0.75rem;display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary" id="btnRefreshQuarantine">Refresh quarantine + learnings</button>
            <span class="muted" id="quarantineStatus"></span>
          </div>
          <pre class="formula-box" id="quarantineReport" style="margin-top:0.75rem;">Click Refresh quarantine + learnings.</pre>
        </div>
        <div class="card wide">
          <h3>Last import report</h3>
          <pre class="formula-box" id="uploadReport">No upload yet.</pre>
        </div>
      </div>`;
  }

  async function refreshQuarantine() {
    const status = document.getElementById("quarantineStatus");
    const report = document.getElementById("quarantineReport");
    if (status) status.textContent = "Loading…";
    try {
      const res = await fetch(apiUrl("/api/quarantine?limit=200"));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      const rows = (data.items || []).map((q) => ({
        file: q.fileName,
        studyId: q.studyId,
        confidence: q.confidence,
        missingSheets: q.missingSheets,
        reason: q.reason,
        learnHints: q.learnHints,
        learningPromoted: q.learningPromoted,
        preview: q.preview,
        createdAt: q.createdAt
      }));
      const learn = data.learnings || {};
      if (status) {
        const s = learn.summary || {};
        status.textContent = `${data.count || 0} quarantined · ${s.sheetAliasCount || 0} sheet · ${s.fieldAliasCount || 0} field · ${s.siteHeaderAliasCount || 0} site-header aliases · loads ${s.stats?.loads || 0} / quarantines ${s.stats?.quarantines || 0}`;
      }
      if (report) {
        report.textContent = JSON.stringify(
          {
            count: data.count,
            reasonBuckets: data.reasonBuckets,
            learnings: {
              summary: learn.summary,
              promotedSheetAliases: learn.sheetAliases,
              promotedFieldAliases: learn.fieldAliases,
              promotedSiteHeaderAliases: learn.siteHeaderAliases,
              promotedSiteHeaderSignatures: learn.siteHeaderSignatures,
              countryAliases: learn.countryAliases,
              pendingSheetProposals: learn.topSheetProposals,
              pendingFieldProposals: learn.topFieldProposals,
              pendingSiteHeaderProposals: learn.topSiteHeaderProposals
            },
            tip: "Similar budgets load to Cosmos. Quarantine + successful loads both write parseLearnings. Site table headers now learn too — re-upload older files after aliases promote.",
            sample: rows.slice(0, 40)
          },
          null,
          2
        );
      }
    } catch (err) {
      if (status) status.textContent = "Failed";
      if (report) report.textContent = String(err);
    }
  }

  function setUploadProgress(pct, label) {
    const wrap = document.getElementById("uploadProgressWrap");
    const bar = document.getElementById("uploadProgressBar");
    const lab = document.getElementById("uploadProgressLabel");
    const status = document.getElementById("uploadStatus");
    if (wrap) wrap.hidden = false;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (lab) lab.textContent = label || `${Math.round(pct)}%`;
    if (status) status.textContent = label || "Working…";
  }

  function zipEntryBaseName(entryName) {
    const norm = String(entryName || "").replace(/\\/g, "/");
    const parts = norm.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function isExcelWorkbookName(name) {
    const low = String(name || "").toLowerCase();
    return low.endsWith(".xlsx") || low.endsWith(".xlsm") || low.endsWith(".xls");
  }

  function isSupportedParseName(name) {
    const low = String(name || "").toLowerCase();
    return low.endsWith(".xlsx") || low.endsWith(".xlsm");
  }

  function isFileHandleError(err) {
    const msg = String(err && (err.message || err) || "");
    return /permission problems|could not be read|NotReadableError|NotFoundError/i.test(msg);
  }

  /** Snapshot File → ArrayBuffer immediately (avoids Chrome stale File-handle errors). */
  async function readFileArrayBuffer(file) {
    if (file instanceof ArrayBuffer) return file;
    if (ArrayBuffer.isView(file)) {
      return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    }
    if (typeof file.arrayBuffer === "function") {
      return file.arrayBuffer();
    }
    return new Response(file).arrayBuffer();
  }

  function uint8ToBlob(u8, mime) {
    // Copy into a fresh ArrayBuffer so Blob isn't tied to a detached/transferable view
    const copy = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    return new Blob([copy], { type: mime || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  /**
   * List parseable workbooks inside an in-memory zip (ArrayBuffer).
   * Does not extract payloads yet — extract one-at-a-time during upload.
   */
  async function listZipWorkbooks(arrayBuffer, prefix, diagnostics) {
    const listed = [];
    const zip = await JSZip.loadAsync(arrayBuffer);
    const entries = Object.keys(zip.files || {});
    diagnostics.entryCount += entries.length;

    for (const entryName of entries) {
      const entry = zip.files[entryName];
      if (!entry || entry.dir) continue;
      const norm = String(entryName).replace(/\\/g, "/");
      if (norm.includes("__MACOSX/") || norm.endsWith(".DS_Store")) continue;

      const base = zipEntryBaseName(norm);
      if (!base || base.startsWith("~$")) continue;

      const folderPrefix = norm.slice(0, Math.max(0, norm.length - base.length)).replace(/\/+$/, "");
      const combinedPrefix = [prefix, folderPrefix].filter(Boolean).join("/");
      const low = base.toLowerCase();

      if (low.endsWith(".zip")) {
        diagnostics.nestedZips += 1;
        try {
          const innerAb = await entry.async("arraybuffer");
          const nested = await listZipWorkbooks(innerAb, combinedPrefix || base.replace(/\.zip$/i, ""), diagnostics);
          listed.push(...nested);
        } catch (err) {
          diagnostics.errors.push(`Nested zip ${norm}: ${err.message || err}`);
        }
        continue;
      }

      const ext = low.includes(".") ? low.slice(low.lastIndexOf(".")) : "(none)";
      diagnostics.extensions[ext] = (diagnostics.extensions[ext] || 0) + 1;
      if (diagnostics.samplePaths.length < 40) diagnostics.samplePaths.push(norm);

      if (!isExcelWorkbookName(base)) continue;
      if (!isSupportedParseName(base)) {
        diagnostics.skippedXls.push(norm);
        continue;
      }

      const uploadName = combinedPrefix
        ? `${combinedPrefix.replace(/[\\/]+/g, "_")}_${base}`
        : base;

      listed.push({
        name: uploadName,
        pathInZip: norm,
        entryName, // original key in this zip
        zip // keep reference to extract later from memory
      });
    }
    return listed;
  }

  async function expandUploadFiles(fileList) {
    const workbooks = [];
    const diagnostics = {
      entryCount: 0,
      nestedZips: 0,
      extensions: {},
      samplePaths: [],
      skippedXls: [],
      errors: [],
      sourceFiles: [],
      snapshottedBytes: 0
    };

    for (const file of fileList) {
      const name = file.name || "upload";
      const lower = name.toLowerCase();
      diagnostics.sourceFiles.push(name);

      try {
        if (lower.endsWith(".zip")) {
          if (typeof JSZip === "undefined") {
            throw new Error("JSZip failed to load — refresh the page and try again.");
          }
          // Critical: read the whole zip into RAM once. Re-reading File during a long
          // upload causes Chrome's "permission problems after a reference was acquired".
          const ab = await readFileArrayBuffer(file);
          diagnostics.snapshottedBytes += ab.byteLength || 0;
          const listed = await listZipWorkbooks(ab, "", diagnostics);
          workbooks.push(...listed);
        } else if (isSupportedParseName(name)) {
          const ab = await readFileArrayBuffer(file);
          diagnostics.snapshottedBytes += ab.byteLength || 0;
          workbooks.push({
            name,
            blob: uint8ToBlob(new Uint8Array(ab))
          });
        } else if (isExcelWorkbookName(name)) {
          diagnostics.skippedXls.push(name);
        } else {
          const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "(none)";
          diagnostics.extensions[ext] = (diagnostics.extensions[ext] || 0) + 1;
        }
      } catch (err) {
        if (isFileHandleError(err)) {
          diagnostics.errors.push(
            `${name}: browser lost the file handle while reading (often a large zip). Re-select the file and retry; prefer smaller zips or upload .xlsx files directly.`
          );
        } else {
          diagnostics.errors.push(`${name}: ${err.message || err}`);
        }
      }
    }

    return { workbooks, diagnostics };
  }

  async function materializeWorkbook(wb) {
    if (wb.blob) return wb;
    if (!wb.zip || !wb.entryName) {
      throw new Error(`Cannot extract ${wb.name}: missing in-memory zip entry`);
    }
    const entry = wb.zip.files[wb.entryName];
    if (!entry) throw new Error(`Zip entry missing: ${wb.pathInZip || wb.entryName}`);
    const u8 = await entry.async("uint8array");
    return { name: wb.name, blob: uint8ToBlob(u8), pathInZip: wb.pathInZip };
  }

  async function postOneWorkbook(wb, mode) {
    const ready = await materializeWorkbook(wb);
    const fd = new FormData();
    fd.append("files", ready.blob, ready.name);
    fd.append("mode", mode);
    fd.append("requestedBy", state.userId);
    const res = await fetch(apiUrl("/api/import"), { method: "POST", body: fd });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        file: ready.name,
        error: data.error || data.raw || `HTTP ${res.status}`,
        data
      };
    }
    return { ok: true, status: res.status, file: ready.name, data };
  }

  async function startUpload() {
    const input = document.getElementById("uploadInput");
    const modeEl = document.getElementById("uploadMode");
    const status = document.getElementById("uploadStatus");
    const report = document.getElementById("uploadReport");
    const btn = document.getElementById("btnStartUpload");
    if (!input || !input.files || !input.files.length) {
      status.textContent = "Choose at least one .xlsx or .zip file.";
      return;
    }

    // Snapshot FileList immediately — input.files can become unreadable later
    const selected = [...input.files];
    const mode = modeEl ? modeEl.value : "load";
    if (btn) btn.disabled = true;
    report.textContent = "Reading zip into memory (avoids browser file-handle errors)…";
    setUploadProgress(0, "Snapshotting files…");

    const aggregate = {
      mode,
      loaded: [],
      quarantined: [],
      failed: [],
      perFile: []
    };

    try {
      const { workbooks, diagnostics } = await expandUploadFiles(selected);
      if (!workbooks.length) {
        status.textContent = diagnostics.errors.length
          ? "Could not read zip (see report)."
          : "No .xlsx/.xlsm workbooks found in zip/folders.";
        report.textContent = JSON.stringify(
          {
            problem: diagnostics.errors.length
              ? "Failed while reading the zip into memory."
              : "Zip was read, but no parseable Excel workbooks were found in any folder.",
            hint: "Nested folders are OK. Need .xlsx/.xlsm. If you see 'permission problems', re-select the zip and retry — that message is a Chrome file-handle issue, not folder ACLs.",
            diagnostics
          },
          null,
          2
        );
        setUploadProgress(0, "Nothing to upload");
        return;
      }

      const total = workbooks.length;
      report.textContent = `Found ${total} workbook(s) across folders — uploading one at a time…\n`;

      for (let i = 0; i < total; i++) {
        const wb = workbooks[i];
        const pct = (i / total) * 100;
        setUploadProgress(pct, `${i + 1} / ${total} — ${wb.name}`);
        try {
          const result = await postOneWorkbook(wb, mode);
          aggregate.perFile.push(result);
          if (!result.ok) {
            aggregate.failed.push({ file: wb.name, error: result.error, status: result.status });
          } else {
            const d = result.data || {};
            (d.loaded || []).forEach((x) => aggregate.loaded.push(x));
            (d.quarantined || []).forEach((x) => aggregate.quarantined.push(x));
            (d.failed || []).forEach((x) => aggregate.failed.push(x));
          }
        } catch (err) {
          const msg = isFileHandleError(err)
            ? `Browser file-handle error while extracting ${wb.pathInZip || wb.name}. Re-select the zip and retry.`
            : String(err.message || err);
          aggregate.failed.push({ file: wb.name, error: msg });
        }
        report.textContent = JSON.stringify(
          {
            progress: `${i + 1}/${total}`,
            counts: {
              loaded: aggregate.loaded.length,
              quarantined: aggregate.quarantined.length,
              failed: aggregate.failed.length
            },
            lastFile: wb.name,
            pathInZip: wb.pathInZip || null
          },
          null,
          2
        );
      }

      // Summarize why files quarantined (from this upload batch)
      const quarantineWhy = {};
      for (const q of aggregate.quarantined) {
        const key = (q.studyId === "UNKNOWN" || !q.studyId)
          ? "no_O_number_in_filename"
          : (q.lineItems === 0 ? "zero_line_items" : "other");
        quarantineWhy[key] = (quarantineWhy[key] || 0) + 1;
      }

      setUploadProgress(100, `Done — ${aggregate.loaded.length} loaded, ${aggregate.quarantined.length} quarantined, ${aggregate.failed.length} failed`);
      status.textContent = `Done — loaded ${aggregate.loaded.length}, quarantined ${aggregate.quarantined.length}, failed ${aggregate.failed.length} (of ${total})`;

      const errorBuckets = {};
      for (const f of aggregate.failed) {
        const key = String(f.error || "unknown").split("\n")[0].slice(0, 160);
        errorBuckets[key] = (errorBuckets[key] || 0) + 1;
      }
      const firewallHits = aggregate.failed.filter((f) =>
        /COSMOS_FIREWALL|firewall|public internet/i.test(String(f.error || ""))
      ).length;
      if (firewallHits > 0) {
        status.textContent = `Cosmos firewall blocked ${firewallHits} write(s). Fix Networking, then re-upload.`;
      }

      report.textContent = JSON.stringify(
        {
          files: total,
          diagnostics: {
            entryCount: diagnostics.entryCount,
            snapshottedBytes: diagnostics.snapshottedBytes,
            nestedZips: diagnostics.nestedZips,
            extensions: diagnostics.extensions,
            skippedXls: diagnostics.skippedXls.slice(0, 20),
            errors: diagnostics.errors
          },
          counts: {
            loaded: aggregate.loaded.length,
            quarantined: aggregate.quarantined.length,
            failed: aggregate.failed.length
          },
          quarantineWhy,
          meaning: {
            loaded: "Similar enough → Cosmos studies/versions/lineItems (learns sheet/field aliases from success)",
            quarantined: "Unsure / empty → quarantine only; logs still propose aliases for next parse",
            failed: "Exception (Cosmos firewall, bad/corrupt xlsx, timeout, etc.)"
          },
          tip: "Zip folders are fine. 'Permission problems' = browser file handle — this build snapshots the zip into memory first. Prefer hard-refresh before retry.",
          topErrors: errorBuckets,
          failedSample: aggregate.failed.slice(0, 8),
          loaded: aggregate.loaded,
          quarantined: aggregate.quarantined,
          failed: aggregate.failed
        },
        null,
        2
      );
    } catch (err) {
      status.textContent = isFileHandleError(err)
        ? "Browser lost the file handle — re-select the zip and retry"
        : "Upload failed";
      setUploadProgress(0, "Failed");
      report.textContent = JSON.stringify(
        {
          error: String(err.message || err),
          hint: isFileHandleError(err)
            ? "Chrome cannot re-read a large File after a delay. Re-choose the zip (don't leave the tab idle mid-read) or split into smaller zips / upload .xlsx files."
            : null
        },
        null,
        2
      );
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderStudies(loadingHtml) {
    const sel = state.studyCompare.selected || [];
    const groupBy = state.studiesGroupBy || "client";
    return `
      <div class="grid">
        <div class="card wide">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
            <div>
              <h3>Studies in Cosmos</h3>
              <p class="muted">
                ${hasOpenStudy()
                  ? `Open a study into the workbench, or click <strong>All studies</strong> to clear selection for portfolio questions. Current: <strong>${escapeHtml(state.study.studyId)}</strong>`
                  : "<strong>No study selected</strong> — Buddy will query all Cosmos studies with no open-study bias."}
              </p>
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
              <button type="button" class="btn btn-secondary" id="btnClearStudyInline" ${hasOpenStudy() ? "" : "disabled"}>All studies (clear)</button>
              <label class="field-label" style="margin:0;" for="studiesGroupBy">Group by</label>
              <select id="studiesGroupBy" class="select" style="width:auto;min-width:11rem;">
                <option value="client" ${groupBy === "client" ? "selected" : ""}>Client</option>
                <option value="therapeuticArea" ${groupBy === "therapeuticArea" ? "selected" : ""}>Therapeutic area</option>
                <option value="year" ${groupBy === "year" ? "selected" : ""}>Year</option>
                <option value="none" ${groupBy === "none" ? "selected" : ""}>None (flat list)</option>
              </select>
              <button type="button" class="btn btn-ghost" id="btnExpandAllGroups">Expand all</button>
              <button type="button" class="btn btn-ghost" id="btnCollapseAllGroups">Collapse all</button>
              <button type="button" class="btn btn-primary" id="btnOpenStudyCompare" ${sel.length === 2 ? "" : "disabled"}>Compare selected (${sel.length}/2)</button>
              <button type="button" class="btn btn-primary" id="btnNewStudyInline">New study</button>
              <button type="button" class="btn btn-secondary" id="btnRefreshStudies">Refresh</button>
            </div>
          </div>
          <div id="studiesPanel" style="margin-top:1rem;">${loadingHtml || "<p class=\"muted\">Loading…</p>"}</div>
        </div>
      </div>`;
  }

  function studyYear(s) {
    const raw = s.updatedAt || s.importedAt || "";
    const m = String(raw).match(/^(\d{4})/);
    if (m) return m[1];
    const titleYear = String(s.title || s.protocol || "").match(/\b(20\d{2})\b/);
    return titleYear ? titleYear[1] : "Unknown year";
  }

  function normalizeTa(ta) {
    const t = String(ta || "").trim();
    if (!t) return "(No therapeutic area)";
    return t;
  }

  function groupKeyForStudy(s, groupBy) {
    if (groupBy === "therapeuticArea") return normalizeTa(s.therapeuticArea);
    if (groupBy === "year") return studyYear(s);
    if (groupBy === "client") return String(s.clientName || "").trim() || "(No client)";
    return "All studies";
  }

  function sortGroupKeys(keys, groupBy) {
    return keys.sort((a, b) => {
      if (groupBy === "year") {
        if (a === "Unknown year") return 1;
        if (b === "Unknown year") return -1;
        return String(b).localeCompare(String(a));
      }
      if (a.startsWith("(")) return 1;
      if (b.startsWith("(")) return -1;
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
  }

  function studyRowHtml(s, openId) {
    const id = s.studyId || "";
    const active = id === openId;
    const selected = new Set(state.studyCompare.selected || []);
    const checked = selected.has(id) ? "checked" : "";
    return `<tr class="${active ? "row-active" : ""}">
      <td><input type="checkbox" data-compare-pick="${escapeAttr(id)}" ${checked} /></td>
      <td><button type="button" class="btn btn-primary" data-open-study="${escapeAttr(id)}">${active ? "Opened" : "Open"}</button></td>
      <td><code>${escapeHtml(id)}</code></td>
      <td>${escapeHtml(s.clientName || "—")}</td>
      <td>${escapeHtml(s.therapeuticArea || "—")}</td>
      <td>${escapeHtml(s.title || "—")}</td>
      <td>${escapeHtml(s.phase || "—")}</td>
      <td>${escapeHtml(studyYear(s))}</td>
      <td>${escapeHtml(s.status || "—")}</td>
      <td class="muted">${escapeHtml((s.updatedAt || s.importedAt || "").slice(0, 19).replace("T", " "))}</td>
    </tr>`;
  }

  function renderStudiesTable(studies) {
    const openId = state.study.studyId || "";
    const groupBy = state.studiesGroupBy || "client";
    if (!studies.length) {
      return "<p class=\"muted\">No studies yet. Use Upload budgets to load workbooks.</p>";
    }

    const head = `<thead>
      <tr><th>Compare</th><th></th><th>Study</th><th>Client</th><th>TA</th><th>Title</th><th>Phase</th><th>Year</th><th>Status</th><th>Updated</th></tr>
    </thead>`;

    if (groupBy === "none") {
      const sorted = [...studies].sort((a, b) =>
        String(a.clientName || "").localeCompare(String(b.clientName || ""), undefined, { sensitivity: "base" }) ||
        String(a.studyId || "").localeCompare(String(b.studyId || ""))
      );
      return `<table class="table">${head}<tbody>${sorted.map((s) => studyRowHtml(s, openId)).join("")}</tbody></table>`;
    }

    const buckets = {};
    for (const s of studies) {
      const key = groupKeyForStudy(s, groupBy);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(s);
    }
    for (const key of Object.keys(buckets)) {
      buckets[key].sort((a, b) =>
        String(a.studyId || "").localeCompare(String(b.studyId || ""))
      );
    }

    const keys = sortGroupKeys(Object.keys(buckets), groupBy);
    const collapsed = state.studiesCollapsed || {};

    return keys.map((key) => {
      const rows = buckets[key];
      const isCollapsed = Boolean(collapsed[`${groupBy}::${key}`]);
      return `<div class="study-group ${isCollapsed ? "is-collapsed" : ""}" data-group-key="${escapeAttr(key)}">
        <button type="button" class="study-group-toggle" data-toggle-group="${escapeAttr(`${groupBy}::${key}`)}" aria-expanded="${isCollapsed ? "false" : "true"}">
          <span class="study-group-chevron">${isCollapsed ? "▸" : "▾"}</span>
          <strong>${escapeHtml(key)}</strong>
          <span class="muted">${rows.length} stud${rows.length === 1 ? "y" : "ies"}</span>
        </button>
        <div class="study-group-body" ${isCollapsed ? "hidden" : ""}>
          <table class="table">${head}<tbody>${rows.map((s) => studyRowHtml(s, openId)).join("")}</tbody></table>
        </div>
      </div>`;
    }).join("");
  }

  function paintStudiesPanel() {
    const panel = document.getElementById("studiesPanel");
    if (!panel) return;
    panel.innerHTML = renderStudiesTable(state.studiesList || []);
    syncCompareSelectedFromDom();
  }

  function studySnapshotFromPayload(payload) {
    const s = payload.study || {};
    const v = payload.version || {};
    const snap = v.snapshot || {};
    const drivers = { ...(s.drivers || {}), ...(snap.drivers || {}) };
    const sites = snap.sites || s.sites || [];
    const coreSites =
      Number(drivers.coreSites) ||
      sites.reduce((sum, x) => sum + (Number(x.coreSites) || 0), 0);
    const enrolled =
      Number(drivers.enrolledSubjects) ||
      Number(drivers.patients) ||
      sites.reduce((sum, x) => sum + (Number(x.enrolledPts) || 0), 0);
    const screened =
      Number(drivers.screenedSubjects) ||
      sites.reduce((sum, x) => sum + (Number(x.screenedPts) || 0), 0);
    const totals = v.totals || {};
    const billed =
      totals.grandTotal ??
      totals.totalServiceFees ??
      totals["Total Service Fees"] ??
      totals.serviceFees ??
      null;
    return {
      studyId: s.studyId,
      clientName: s.clientName || snap.clientName || "",
      title: s.title || snap.title || "",
      protocol: s.protocol || snap.protocol || "",
      phase: s.phase || snap.phase || "",
      therapeuticArea: s.therapeuticArea || snap.therapeuticArea || "",
      indication: s.indication || snap.indication || "",
      versionLabel: v.label || "",
      sourceFileName: v.sourceFileName || "",
      lineItemCount: v.lineItemCount || (payload.lineItems || []).length || 0,
      coreSites,
      enrolled,
      screened,
      siteRows: sites.length,
      drivers,
      totals,
      billed,
      inputFieldCount: (snap.inputFields || s.inputFields || []).length
    };
  }

  function compareVal(left, right, key) {
    const a = left == null ? "" : String(left[key] ?? "");
    const b = right == null ? "" : String(right[key] ?? "");
    return a !== b && a !== "" && b !== "";
  }

  function renderComparePane(side, snap, other) {
    if (!snap) {
      return `<p class="muted">Loading…</p>`;
    }
    const row = (label, key, format) => {
      const raw = snap[key];
      const display = format ? format(raw) : (raw == null || raw === "" ? "—" : String(raw));
      const mismatch = other && compareVal(snap, other, key);
      return `<dt>${escapeHtml(label)}</dt><dd class="${mismatch ? "diff-mismatch" : ""}">${escapeHtml(display)}</dd>`;
    };
    const moneyOrDash = (n) => (n == null || n === "" || Number.isNaN(Number(n)) ? "—" : money(Number(n)));
    const totalEntries = Object.entries(snap.totals || {}).slice(0, 12);
    const totalRows = totalEntries
      .map(([k, v]) => {
        const ov = other && other.totals ? other.totals[k] : undefined;
        const mismatch = other && String(v) !== String(ov);
        return `<dt>${escapeHtml(k)}</dt><dd class="${mismatch ? "diff-mismatch" : ""}">${escapeHtml(
          typeof v === "number" ? money(v) : String(v ?? "—")
        )}</dd>`;
      })
      .join("");

    return `
      <p class="compare-section-title">Identity</p>
      <dl class="compare-kv">
        ${row("Study", "studyId")}
        ${row("Client", "clientName")}
        ${row("Title", "title")}
        ${row("Protocol", "protocol")}
        ${row("Phase", "phase")}
        ${row("Therapeutic area", "therapeuticArea")}
        ${row("Indication", "indication")}
        ${row("Version", "versionLabel")}
        ${row("Source file", "sourceFileName")}
      </dl>
      <p class="compare-section-title">Enrollment / sites</p>
      <dl class="compare-kv">
        ${row("Core sites", "coreSites")}
        ${row("Site rows", "siteRows")}
        ${row("Enrolled patients", "enrolled")}
        ${row("Screened", "screened")}
        ${row("Input fields", "inputFieldCount")}
        ${row("Line items", "lineItemCount")}
      </dl>
      <p class="compare-section-title">Billed / Exec Sum</p>
      <dl class="compare-kv">
        <dt>Primary billed</dt>
        <dd class="${other && compareVal(snap, other, "billed") ? "diff-mismatch" : ""}">${escapeHtml(moneyOrDash(snap.billed))}</dd>
        ${totalRows || "<dt colspan></dt><dd class=\"muted\">No Exec Sum totals on this version</dd>"}
      </dl>
      <div style="margin-top:1rem;">
        <button type="button" class="btn btn-secondary" data-compare-open-workbench="${escapeAttr(snap.studyId)}">Open in workbench</button>
      </div>
    `;
  }

  function renderStudyCompareOverlay() {
    const ov = els.compareOverlay;
    if (!ov) return;
    const sc = state.studyCompare;
    if (!sc.open) {
      ov.hidden = true;
      ov.classList.remove("is-open");
      ov.setAttribute("aria-hidden", "true");
      ov.innerHTML = "";
      return;
    }
    ov.hidden = false;
    ov.classList.add("is-open");
    ov.setAttribute("aria-hidden", "false");
    const left = sc.left;
    const right = sc.right;
    ov.innerHTML = `
      <div class="compare-shell" role="dialog" aria-modal="true" aria-label="Compare studies">
        <div class="compare-toolbar">
          <h2>Compare studies</h2>
          <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
            <span class="muted">${escapeHtml(sc.status || "")}</span>
            <button type="button" class="btn btn-ghost" id="btnCloseStudyCompare">Close</button>
          </div>
        </div>
        <div class="compare-windows">
          <section class="compare-window">
            <div class="compare-window-head">
              <h3>A · ${escapeHtml(left?.studyId || sc.leftId || "…")}</h3>
              <span class="muted">${escapeHtml(left?.clientName || "")}</span>
            </div>
            <div class="compare-window-body">${renderComparePane("left", left, right)}</div>
          </section>
          <section class="compare-window">
            <div class="compare-window-head">
              <h3>B · ${escapeHtml(right?.studyId || sc.rightId || "…")}</h3>
              <span class="muted">${escapeHtml(right?.clientName || "")}</span>
            </div>
            <div class="compare-window-body">${renderComparePane("right", right, left)}</div>
          </section>
        </div>
      </div>`;
  }

  function closeStudyCompare() {
    state.studyCompare.open = false;
    state.studyCompare.status = "";
    renderStudyCompareOverlay();
  }

  async function fetchStudyPayload(studyId) {
    const res = await fetch(apiUrl(`/api/studies/${encodeURIComponent(studyId)}`));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to load ${studyId}`);
    return data;
  }

  async function openStudyCompare(leftId, rightId) {
    if (!leftId || !rightId || leftId === rightId) {
      state.studyCompare.status = "Pick two different studies.";
      return;
    }
    state.studyCompare.open = true;
    state.studyCompare.leftId = leftId;
    state.studyCompare.rightId = rightId;
    state.studyCompare.left = null;
    state.studyCompare.right = null;
    state.studyCompare.status = "Loading…";
    renderStudyCompareOverlay();
    try {
      const [a, b] = await Promise.all([fetchStudyPayload(leftId), fetchStudyPayload(rightId)]);
      state.studyCompare.left = studySnapshotFromPayload(a);
      state.studyCompare.right = studySnapshotFromPayload(b);
      state.studyCompare.status = "Mismatched values highlighted";
      renderStudyCompareOverlay();
    } catch (err) {
      state.studyCompare.status = String(err.message || err);
      renderStudyCompareOverlay();
    }
  }

  function syncCompareSelectedFromDom() {
    const boxes = els.viewRoot.querySelectorAll("[data-compare-pick]:checked");
    state.studyCompare.selected = [...boxes].map((el) => el.getAttribute("data-compare-pick")).filter(Boolean).slice(0, 2);
    const btn = document.getElementById("btnOpenStudyCompare");
    if (btn) {
      const n = state.studyCompare.selected.length;
      btn.disabled = n !== 2;
      btn.textContent = `Compare selected (${n}/2)`;
    }
  }

  function cosmosStudyToWorkspace(payload) {
    const s = payload.study || {};
    const v = payload.version || {};
    const snap = v.snapshot || {};
    const base = SBW.defaultStudy();
    const snapFields = Array.isArray(snap.inputFields) ? snap.inputFields : [];
    const studyFields = Array.isArray(s.inputFields) ? s.inputFields : [];
    const drivers = {
      ...base.drivers,
      ...(snap.drivers || {}),
      ...(s.drivers || {})
    };
    return {
      ...base,
      studyId: s.studyId,
      clientName: s.clientName || snap.clientName || "",
      title: s.title || snap.title || "",
      protocol: s.protocol || snap.protocol || "",
      phase: s.phase || snap.phase || "",
      therapeuticArea: s.therapeuticArea || snap.therapeuticArea || "",
      indication: s.indication || snap.indication || "",
      enrollmentType: s.enrollmentType || snap.enrollmentType || "",
      budgetType: s.budgetType || snap.budgetType || "",
      versionLabel: v.label || "imported",
      drivers,
      header: { ...(base.header || {}), ...(snap.header || {}), ...(s.header || {}) },
      inputFields: snapFields.length ? snapFields : studyFields,
      sites: (Array.isArray(snap.sites) && snap.sites.length ? snap.sites : null) || s.sites || [],
      resourceLeads:
        (Array.isArray(snap.resourceLeads) && snap.resourceLeads.length ? snap.resourceLeads : null) ||
        s.resourceLeads ||
        [],
      monitoringInputs: {
        ...(typeof snap.monitoring === "object" && snap.monitoring ? snap.monitoring : {}),
        ...(typeof s.monitoring === "object" && s.monitoring ? s.monitoring : {})
      },
      vendors: (Array.isArray(snap.vendors) && snap.vendors.length ? snap.vendors : null) || s.vendors || [],
      payments: { ...(snap.payments || {}), ...(s.payments || {}) },
      sheetHarvestSummary: s.sheetHarvestSummary || snap.sheetHarvestSummary || v.sheetHarvestSummary || null,
      totals: v.totals || {},
      execSum: v.execSum || {},
      rates: { ...base.rates, ...(s.rates || {}) },
      factors: { ...base.factors },
      staffing: { ...base.staffing },
      currentVersionId: s.currentVersionId || v.id,
      viewingVersionId: v.id,
      sectionStatus: { ...base.sectionStatus, ...(s.sectionStatus || {}) },
      assumptions: {
        recruitment: { ...base.assumptions.recruitment, ...((s.assumptions || {}).recruitment || {}) },
        monitoring: { ...base.assumptions.monitoring, ...((s.assumptions || {}).monitoring || {}) },
        clinops: { ...base.assumptions.clinops, ...((s.assumptions || {}).clinops || {}) },
        smo: { ...base.assumptions.smo, ...((s.assumptions || {}).smo || {}) }
      },
      requests: Array.isArray(s.requests) ? s.requests : base.requests,
      formulaOverrides: {}
    };
  }

  async function openStudy(studyId) {
    const panel = document.getElementById("studiesPanel");
    if (panel) panel.innerHTML = `<p class="muted">Opening ${escapeHtml(studyId)}…</p>`;
    try {
      const res = await fetch(apiUrl(`/api/studies/${encodeURIComponent(studyId)}`));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (panel) panel.innerHTML = `<pre class="formula-box">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
        return;
      }
      state.study = cosmosStudyToWorkspace(data);
      state.versions = data.versions || [];
      state.lineItems = data.lineItems || [];
      state.source = "cosmos";
      state.compare = null;
      state.dirty = false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.study));
      state.sectionId = "overview";
      render();
      markSaved();
    } catch (err) {
      if (panel) panel.innerHTML = `<pre class="formula-box">${escapeHtml(String(err))}</pre>`;
    }
  }

  async function loadStudiesIntoPanel() {
    const panel = document.getElementById("studiesPanel");
    if (!panel) return;
    panel.innerHTML = "<p class=\"muted\">Loading…</p>";
    try {
      const res = await fetch(apiUrl("/api/studies?limit=500"));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        panel.innerHTML = `<pre class="formula-box">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
        return;
      }
      state.studiesList = data.studies || [];
      paintStudiesPanel();
    } catch (err) {
      panel.innerHTML = `<p class="muted">Could not reach /api/studies.</p><pre class="formula-box">${escapeHtml(String(err))}</pre>`;
    }
  }

  function renderVersions() {
    const versions = state.versions || [];
    const opts = versions.map((v) =>
      `<option value="${escapeAttr(v.id)}">${escapeHtml(v.label || v.id)} · ${(v.createdAt || "").slice(0, 10)} · ${v.lineItemCount || 0} lines</option>`
    ).join("");

    const diff = state.compare;
    let diffHtml = "<p class=\"muted\">Pick an older version and compare to the newest. Differences show <span class=\"diff-old\">previous</span> → <span class=\"diff-new\">current</span>.</p>";
    if (state.compareStatus) diffHtml = `<p class="muted">${escapeHtml(state.compareStatus)}</p>`;
    if (diff) {
      const fields = (diff.fieldChanges || []).map((c) =>
        `<tr>
          <td><code>${escapeHtml(c.key)}</code></td>
          <td class="diff-old">${escapeHtml(c.previous == null ? "—" : String(c.previous))}</td>
          <td class="diff-new">${escapeHtml(c.current == null ? "—" : String(c.current))}</td>
        </tr>`
      ).join("") || `<tr><td colspan="3">No field differences (or older upload lacked a snapshot).</td></tr>`;

      const depts = (diff.departmentDiffs || []).filter((d) => d.changed).map((d) =>
        `<tr>
          <td>${escapeHtml(d.department)}</td>
          <td>${d.previous.count} lines / ${money(d.previous.charge)}</td>
          <td>${d.current.count} lines / ${money(d.current.charge)}</td>
        </tr>`
      ).join("") || `<tr><td colspan="3">No department rollup changes.</td></tr>`;

      const lines = (diff.lineItemDiffs || []).slice(0, 80).map((d) =>
        `<tr>
          <td><code>${escapeHtml(d.oraCode)}</code> <span class="badge ${escapeAttr(d.change)}">${escapeHtml(d.change)}</span></td>
          <td class="diff-old">${d.previous ? escapeHtml(`${d.previous.service || ""} · u=${d.previous.units} · ${d.previous.charge}`) : "—"}</td>
          <td class="diff-new">${d.current ? escapeHtml(`${d.current.service || ""} · u=${d.current.units} · ${d.current.charge}`) : "—"}</td>
        </tr>`
      ).join("") || `<tr><td colspan="3">No line-item diffs in sample.</td></tr>`;

      diffHtml = `
        <p class="muted">${escapeHtml(diff.older?.label || diff.older?.id || "")} → <strong>${escapeHtml(diff.newer?.label || diff.newer?.id || "")}</strong>
        · ${diff.fieldChanges?.length || 0} field changes · ${diff.lineItemDiffCount || 0} line-item changes
        ${diff.notes ? ` · ${escapeHtml(diff.notes)}` : ""}</p>
        <h3>Field changes (previous → current)</h3>
        <table class="table">
          <thead><tr><th>Field</th><th>Previous</th><th>Current</th></tr></thead>
          <tbody>${fields}</tbody>
        </table>
        <h3 style="margin-top:1.2rem;">Department rollups</h3>
        <table class="table">
          <thead><tr><th>Dept</th><th>Previous</th><th>Current</th></tr></thead>
          <tbody>${depts}</tbody>
        </table>
        <h3 style="margin-top:1.2rem;">Line items changed (sample)</h3>
        <table class="table">
          <thead><tr><th>Ora code</th><th>Previous</th><th>Current</th></tr></thead>
          <tbody>${lines}</tbody>
        </table>`;
    }

    return `
      <div class="grid">
        <div class="card wide">
          <h3>Versions / Diff</h3>
          <p class="muted">Study <code>${escapeHtml(state.study.studyId || "")}</code>
            · ${state.source === "cosmos" ? "Cosmos" : "Workbench"} · ${versions.length} version(s)</p>
          ${versions.length < 2 ? "<p class=\"muted\">Upload another workbook for the same opportunity ID to create a second version, then compare.</p>" : ""}
          <div class="form-grid" style="margin-top:1rem;">
            <div>
              <label class="field-label">Older version</label>
              <select id="compareOlder" class="select">${opts}</select>
            </div>
            <div>
              <label class="field-label">Current / newer version</label>
              <select id="compareNewer" class="select">${opts}</select>
            </div>
          </div>
          <div style="margin-top:1rem;display:flex;gap:0.6rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" id="btnRunCompare" ${versions.length < 2 ? "disabled" : ""}>Compare → show differences</button>
            <button type="button" class="btn btn-secondary" id="btnOpenNewerVersion" ${versions.length ? "" : "disabled"}>Open newer in workspace</button>
          </div>
        </div>
        <div class="card wide" id="comparePanel">${diffHtml}</div>
      </div>`;
  }

  async function runCompare() {
    const olderEl = document.getElementById("compareOlder");
    const newerEl = document.getElementById("compareNewer");
    if (!olderEl || !newerEl) return;
    const older = olderEl.value;
    const newer = newerEl.value;
    if (!older || !newer) return;
    if (older === newer) {
      state.compareStatus = "Pick two different versions.";
      state.compare = null;
      render();
      return;
    }
    state.compareStatus = "Comparing…";
    state.compare = null;
    render();
    try {
      const res = await fetch(
        apiUrl(`/api/studies/${encodeURIComponent(state.study.studyId)}/compare?older=${encodeURIComponent(older)}&newer=${encodeURIComponent(newer)}`)
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        state.compareStatus = data.error || `Compare failed (${res.status})`;
        state.compare = null;
      } else {
        state.compare = data;
        state.compareStatus = "";
      }
    } catch (err) {
      state.compareStatus = String(err);
      state.compare = null;
    }
    render();
  }

  async function openVersionInWorkspace(versionId) {
    if (!versionId || !state.study.studyId) return;
    try {
      const res = await fetch(
        apiUrl(`/api/studies/${encodeURIComponent(state.study.studyId)}/versions/${encodeURIComponent(versionId)}`)
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        state.compareStatus = data.error || "Could not open version";
        render();
        return;
      }
      const versionPayload = {
        study: {
          studyId: state.study.studyId,
          currentVersionId: state.study.currentVersionId,
          clientName: data.version?.snapshot?.clientName || state.study.clientName,
          title: data.version?.snapshot?.title || state.study.title,
          protocol: data.version?.snapshot?.protocol || state.study.protocol,
          phase: data.version?.snapshot?.phase || state.study.phase,
          drivers: data.version?.snapshot?.drivers || state.study.drivers,
          header: data.version?.snapshot?.header || state.study.header,
          sites: data.version?.snapshot?.sites || state.study.sites,
          inputFields: data.version?.snapshot?.inputFields || state.study.inputFields
        },
        version: data.version,
        versions: state.versions,
        lineItems: data.lineItems || []
      };
      state.study = cosmosStudyToWorkspace(versionPayload);
      state.lineItems = data.lineItems || [];
      state.source = "cosmos";
      state.sectionId = "overview";
      render();
      markSaved();
    } catch (err) {
      state.compareStatus = String(err);
      render();
    }
  }

  function renderHub() {
    const rows = SBW.sections
      .filter((s) => s.department)
      .map((s) => {
        const st = state.study.sectionStatus[s.id] || "not_started";
        const openReq = state.study.requests.find(
          (r) => r.department === s.department && r.status !== "completed"
        );
        return `<tr>
          <td><button type="button" class="btn btn-secondary" data-jump="${s.id}">${s.label}</button></td>
          <td>${s.department}</td>
          <td><span class="badge ${st}">${statusLabel(st)}</span></td>
          <td>${openReq ? openReq.note : "—"}</td>
        </tr>`;
      }).join("");

    return `
      <div class="grid">
        <div class="card wide">
          <h3>Start here</h3>
          <p class="muted">Open a Cosmos study from Studies, upload a budget, or start a blank draft.</p>
          <div style="display:flex;gap:0.6rem;flex-wrap:wrap;margin-top:0.75rem;">
            <button type="button" class="btn btn-primary" id="btnNewStudyHub">New study</button>
            <button type="button" class="btn btn-secondary" data-jump="studies">Browse studies</button>
            <button type="button" class="btn btn-secondary" data-jump="upload">Upload budgets</button>
          </div>
        </div>
        <div class="card">
          <h3>Service fees</h3>
          <div class="stat">${money(state.results["summary.totalServiceFees"])}</div>
          <p class="muted">Includes contingency + inflation</p>
        </div>
        <div class="card">
          <h3>Pass-throughs</h3>
          <div class="stat">${money(state.results["summary.passThroughs"])}</div>
        </div>
        <div class="card">
          <h3>Grand total</h3>
          <div class="stat">${money(state.results["summary.grandTotal"])}</div>
          <p class="muted">${num(state.results["summary.costPerPatient"], 0)} / enrolled patient</p>
        </div>
        <div class="card wide">
          <h3>Department status</h3>
          <table class="table">
            <thead><tr><th>Section</th><th>Dept</th><th>Status</th><th>Open request</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  function renderOverview() {
    const d = state.study.drivers || {};
    const locked = !canEdit("Analyst");
    const dis = locked ? "disabled" : "";
    const fields = state.study.inputFields || [];
    const sites = state.study.sites || [];
    const monitoring = state.study.monitoringInputs || {};
    const vendors = state.study.vendors || [];
    const leads = state.study.resourceLeads || [];
    const payments = state.study.payments || {};

    // Group editable/captured fields by section
    const bySection = {};
    fields.forEach((f, idx) => {
      const sec = f.section || "Inputs";
      if (!bySection[sec]) bySection[sec] = [];
      bySection[sec].push({ ...f, idx });
    });

    const sectionBlocks = Object.keys(bySection).map((sec) => {
      const items = bySection[sec]
        .filter((f) => f.kind !== "section")
        .map((f) => {
          const raw = f.value;
          const isNum = typeof raw === "number";
          const val = raw == null ? "" : String(raw);
          return `<div class="${f.note ? "full" : ""}">
            <label class="field-label">${escapeHtml(f.label || f.key)}${f.sourceCols ? ` <span class="muted">· ${escapeHtml(f.sourceCols)}</span>` : ""}</label>
            <input class="input" data-input-idx="${f.idx}" ${isNum ? 'type="number" step="any"' : ""} value="${escapeAttr(val)}" ${dis || f.editable === false ? "disabled" : ""} />
            ${f.note ? `<div class="muted field-note">${escapeHtml(String(f.note).slice(0, 240))}</div>` : ""}
          </div>`;
        })
        .join("");
      if (!items) return "";
      return `<div class="card wide">
        <h3>${escapeHtml(sec)}</h3>
        <div class="form-grid">${items}</div>
      </div>`;
    }).join("");

    const driverEntries = Object.keys(d).sort();
    const driverBlocks = driverEntries.map((key) => {
      const val = d[key];
      const isNum = typeof val === "number" || val === "" || val == null || !Number.isNaN(Number(val));
      return `<div>
        <label class="field-label">${escapeHtml(key)}</label>
        <input class="input" data-driver="${escapeAttr(key)}" ${isNum ? 'type="number" step="any"' : ""} value="${escapeAttr(val == null ? "" : String(val))}" ${dis} />
      </div>`;
    }).join("");

    const siteRows = sites.map((s, i) => `<tr>
      <td><input class="input" data-site-idx="${i}" data-site-field="country" value="${escapeAttr(s.country || "")}" ${dis} /></td>
      <td><input class="input" data-site-idx="${i}" data-site-field="region" value="${escapeAttr(s.region || "")}" ${dis} /></td>
      <td><input class="input" type="number" step="any" data-site-idx="${i}" data-site-field="coreSites" value="${escapeAttr(s.coreSites ?? "")}" ${dis} /></td>
      <td><input class="input" type="number" step="any" data-site-idx="${i}" data-site-field="backupSites" value="${escapeAttr(s.backupSites ?? "")}" ${dis} /></td>
      <td><input class="input" type="number" step="any" data-site-idx="${i}" data-site-field="enrolledPts" value="${escapeAttr(s.enrolledPts ?? "")}" ${dis} /></td>
      <td><input class="input" type="number" step="any" data-site-idx="${i}" data-site-field="screenedPts" value="${escapeAttr(s.screenedPts ?? "")}" ${dis} /></td>
      <td><input class="input" type="number" step="any" data-site-idx="${i}" data-site-field="enrollmentMonths" value="${escapeAttr(s.enrollmentMonths ?? "")}" ${dis} /></td>
      <td><input class="input" type="number" step="any" data-site-idx="${i}" data-site-field="enrollmentRate" value="${escapeAttr(s.enrollmentRate ?? "")}" ${dis} /></td>
      <td><input class="input" data-site-idx="${i}" data-site-field="notes" value="${escapeAttr(s.notes || "")}" ${dis} /></td>
    </tr>`).join("") || `<tr><td colspan="9" class="muted">No site rows — open a Cosmos study after upload.</td></tr>`;

    const monEntries = Object.entries(monitoring);
    const monBlocks = monEntries.map(([label, val], i) => `<div class="full">
      <label class="field-label">${escapeHtml(label)}</label>
      <input class="input" data-monitoring-key="${escapeAttr(label)}" value="${escapeAttr(val == null ? "" : String(val))}" ${dis} />
    </div>`).join("") || `<p class="muted">No monitoring block loaded.</p>`;

    const leadRows = leads.map((L) => {
      const regions = Object.entries(L.regions || {}).map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v == null ? "" : String(v))}`).join(" · ");
      return `<tr><td>${escapeHtml(L.role || "")}</td><td>${regions}</td><td>${escapeHtml(L.notes || "")}</td></tr>`;
    }).join("") || `<tr><td colspan="3" class="muted">No resource leads loaded.</td></tr>`;

    const vendorRows = vendors.map((v, i) => `<tr>
      <td><input class="input" data-vendor-idx="${i}" data-vendor-field="vendorType" value="${escapeAttr(v.vendorType || "")}" ${dis} /></td>
      <td><input class="input" data-vendor-idx="${i}" data-vendor-field="vendorName" value="${escapeAttr(v.vendorName || "")}" ${dis} /></td>
      <td><input class="input" data-vendor-idx="${i}" data-vendor-field="oraResponsibility" value="${escapeAttr(v.oraResponsibility || "")}" ${dis} /></td>
      <td><input class="input" data-vendor-idx="${i}" data-vendor-field="freqTransfers" value="${escapeAttr(v.freqTransfers || "")}" ${dis} /></td>
    </tr>`).join("") || `<tr><td colspan="4" class="muted">No vendors loaded.</td></tr>`;

    const payBlocks = Object.entries(payments).map(([k, v]) => `<div>
      <label class="field-label">${escapeHtml(k)}</label>
      <input class="input" data-payment-key="${escapeAttr(k)}" value="${escapeAttr(v == null ? "" : String(v))}" ${dis} />
    </div>`).join("");

    return `
      <div class="grid">
        <div class="card half">
          <h3>Study identity</h3>
          <div class="form-grid">
            <div><label class="field-label">Client</label><input class="input" data-study="clientName" value="${escapeAttr(state.study.clientName || "")}" ${dis} /></div>
            <div><label class="field-label">Opportunity</label><input class="input" data-study="studyId" value="${escapeAttr(state.study.studyId || "")}" ${dis} /></div>
            <div class="full"><label class="field-label">Title</label><input class="input" data-study="title" value="${escapeAttr(state.study.title || "")}" ${dis} /></div>
            <div><label class="field-label">Protocol</label><input class="input" data-study="protocol" value="${escapeAttr(state.study.protocol || "")}" ${dis} /></div>
            <div><label class="field-label">Version</label><input class="input" data-study="versionLabel" value="${escapeAttr(state.study.versionLabel || "")}" ${dis} /></div>
            <div><label class="field-label">Phase</label><input class="input" data-study="phase" value="${escapeAttr(state.study.phase || "")}" ${dis} /></div>
            <div><label class="field-label">Therapeutic area</label><input class="input" data-study="therapeuticArea" value="${escapeAttr(state.study.therapeuticArea || "")}" ${dis} /></div>
            <div><label class="field-label">Indication</label><input class="input" data-study="indication" value="${escapeAttr(state.study.indication || "")}" ${dis} /></div>
          </div>
        </div>
        <div class="card half sticky-calc">
          <h3>Calculated (nearby)</h3>
          <p><strong>Total duration:</strong> ${num(state.results["drivers.totalDuration"], 2)} months</p>
          <p><strong>Enrollment rate:</strong> ${num(state.results["drivers.enrollmentRate"], 3)} subjects/site/month</p>
          <p><strong>Service fees:</strong> ${money(state.results["summary.totalServiceFees"])}</p>
          <p><strong>Grand total:</strong> ${money(state.results["summary.grandTotal"])}</p>
          <p class="muted">${fields.length} Input Tab fields · ${sites.length} sites · ${state.lineItems.length} line items in memory</p>
          ${!fields.length ? "<p class=\"muted\">Open a Cosmos study (after upload) to populate every captured Input Tab cell.</p>" : ""}
        </div>

        ${(() => {
          const harvest = state.study.sheetHarvestSummary;
          if (!harvest || !harvest.sheets || !harvest.sheets.length) return "";
          const rows = harvest.sheets.map((s) => `<tr>
            <td>${escapeHtml(s.name || "")}</td>
            <td>${s.structured ? "Structured" : "Harvested"}</td>
            <td>${escapeHtml(String(s.rowCount ?? "—"))}</td>
            <td>${escapeHtml(String(s.labelValueCount ?? 0))}</td>
            <td>${escapeHtml(String(s.cellCount ?? 0))}</td>
          </tr>`).join("");
          return `<div class="card wide">
            <h3>All workbook sheets</h3>
            <p class="muted">${harvest.sheetCount || harvest.sheets.length} sheets · ${harvest.structuredCount || 0} fully mapped · ${harvest.unstructuredCount || 0} harvested for Ask Buddy / later adapters. Re-upload to refresh.</p>
            <div style="overflow:auto;">
              <table class="table">
                <thead><tr><th>Sheet</th><th>Status</th><th>Rows</th><th>Label/values</th><th>Cell dump</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
        })()}

        <div class="card wide">
          <h3>All drivers</h3>
          <div class="form-grid">${driverBlocks || "<p class=\"muted\">No drivers</p>"}</div>
        </div>

        ${sectionBlocks}

        <div class="card wide">
          <h3>Site mix</h3>
          <div style="overflow:auto;">
            <table class="table">
              <thead><tr><th>Country</th><th>Region</th><th>Core sites</th><th>Backup</th><th>Enrolled</th><th>Screened</th><th>Enroll mo</th><th>Rate</th><th>Notes</th></tr></thead>
              <tbody>${siteRows}</tbody>
            </table>
          </div>
        </div>

        <div class="card wide">
          <h3>Monitoring / IMV inputs</h3>
          <div class="form-grid">${monBlocks}</div>
        </div>

        <div class="card wide">
          <h3>Payments</h3>
          <div class="form-grid">${payBlocks || "<p class=\"muted\">No payment fields</p>"}</div>
        </div>

        <div class="card wide">
          <h3>Resource leads</h3>
          <table class="table">
            <thead><tr><th>Role</th><th>Regions</th><th>Notes</th></tr></thead>
            <tbody>${leadRows}</tbody>
          </table>
        </div>

        <div class="card wide">
          <h3>Vendors</h3>
          <table class="table">
            <thead><tr><th>Type</th><th>Name</th><th>Ora responsibility</th><th>Freq / transfers</th></tr></thead>
            <tbody>${vendorRows}</tbody>
          </table>
        </div>

        <div class="card wide">
          <button type="button" class="btn btn-secondary" data-status-section="overview" data-status="ready_for_review" ${dis}>Mark ready for review</button>
        </div>
      </div>`;
  }

  function driverField(key, label, value, dis) {
    return `<div>
      <label class="field-label">${label}</label>
      <input class="input" type="number" step="any" data-driver="${key}" value="${value}" ${dis} />
    </div>`;
  }

  function lineItemsForDept(deptName) {
    const items = (state.lineItems || []).filter((li) => (li.department || "") === deptName);
    if (!items.length) {
      return `<p class="muted">No line items loaded for ${escapeHtml(deptName)}. Open a Cosmos study to pull Internal Budget rows.</p>`;
    }
    const rows = items.slice(0, 200).map((li) => `<tr>
      <td><code>${escapeHtml(li.oraCode || "")}</code></td>
      <td>${escapeHtml(li.service || "")}</td>
      <td>${escapeHtml(li.units == null ? "" : String(li.units))}</td>
      <td>${escapeHtml(li.totalHours == null ? "" : String(li.totalHours))}</td>
      <td>${money(li.charge)}</td>
      <td>${escapeHtml(li.phase || "")}</td>
    </tr>`).join("");
    const chargeSum = items.reduce((s, li) => s + (Number(li.charge) || 0), 0);
    return `
      <p class="muted">${items.length} lines · charge sum ${money(chargeSum)}</p>
      <div style="overflow:auto;max-height:50vh;">
        <table class="table">
          <thead><tr><th>Ora</th><th>Service</th><th>Units</th><th>Hours</th><th>Charge</th><th>Phase</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function displayVal(v) {
    if (v == null || v === "null" || v === "undefined") return "";
    return String(v);
  }

  function ensureSectionStatus() {
    if (!state.study.sectionStatus || typeof state.study.sectionStatus !== "object") {
      state.study.sectionStatus = { ...SBW.defaultStudy().sectionStatus };
    }
    return state.study.sectionStatus;
  }

  function setSectionStatus(sectionId, status) {
    const map = ensureSectionStatus();
    map[sectionId] = status;
    markDirty();
    render();
  }

  /** Drivers + Input Tab labels most relevant to each department tab. */
  const TAB_CONTENT = {
    recruitment: {
      title: "Recruitment",
      assumptionKey: "recruitment",
      drivers: [
        "screenedSubjects",
        "enrolledSubjects",
        "completedSubjects",
        "coreSites",
        "enrollmentMonths",
        "screenFailRate",
        "dropOutRate"
      ],
      inputMatch: /recruit|screen|enroll|advertis|contact.?center|patient.?pop|site|dropout|drop-out|fail/i,
      assumptionFields: [
        { key: "contactCenterOn", label: "Contact center", type: "boolean" },
        { key: "advertisingOn", label: "Advertising", type: "boolean" },
        { key: "materialsOn", label: "Materials", type: "boolean" },
        { key: "recruiterTrainingAttendees", label: "Training attendees", type: "number" },
        { key: "notes", label: "Notes", type: "text" }
      ]
    },
    clinops: {
      title: "ClinOps / SOE",
      assumptionKey: "clinops",
      drivers: ["startupMonths", "enrollmentMonths", "treatmentMonths", "dblMonths", "closeoutMonths"],
      inputMatch: /soe|clinops|procedure|visit|duration|treatment|closeout|database.?lock|dbl|phase|indication|therapeutic/i,
      assumptionFields: [
        { key: "soeSource", label: "SOE source", type: "text" },
        { key: "patientPopulation", label: "Patient population", type: "text" },
        { key: "notes", label: "Notes", type: "text" }
      ]
    },
    monitoring: {
      title: "Clinical Monitoring",
      assumptionKey: "monitoring",
      drivers: ["sdvPercent", "coreSites", "enrolledSubjects"],
      inputMatch: /monitor|sdv|imv|rbqm|masked|unmasked|on.?site|cra/i,
      useMonitoringInputs: true,
      assumptionFields: [
        { key: "strategy", label: "Monitoring strategy", type: "text" },
        { key: "rbqmFrequency", label: "RBQM frequency", type: "text" },
        { key: "maskedTeams", label: "Masked teams", type: "boolean" },
        { key: "notes", label: "Notes", type: "text" }
      ]
    },
    smo: {
      title: "Block Enrollment / SMO",
      assumptionKey: "smo",
      drivers: ["coreSites", "enrolledSubjects", "completedSubjects"],
      inputMatch: /smo|block.?enroll|site.?comp|patient.?comp|payment|vendor/i,
      assumptionFields: [
        { key: "blockEnrollmentOn", label: "Block enrollment", type: "boolean" },
        { key: "fixedSitePtComp", label: "Fixed site patient compensation", type: "boolean" },
        { key: "notes", label: "Notes", type: "text" }
      ]
    }
  };

  function relatedInputFields(sectionId) {
    const cfg = TAB_CONTENT[sectionId];
    if (!cfg) return [];
    const fields = state.study.inputFields || [];
    return fields
      .map((f, idx) => ({ ...f, idx }))
      .filter((f) => {
        if (f.kind === "section") return false;
        const blob = `${f.label || ""} ${f.key || ""} ${f.section || ""} ${f.canonicalKey || ""}`;
        return cfg.inputMatch.test(blob);
      })
      .slice(0, 40);
  }

  function relatedDriverBlocks(sectionId, dis) {
    const cfg = TAB_CONTENT[sectionId];
    if (!cfg) return "";
    const d = state.study.drivers || {};
    const known = Object.fromEntries(DRIVER_FIELDS.map((x) => [x.key, x.label]));
    return cfg.drivers
      .map((key) => {
        const label = known[key] || humanizeKey(key);
        const val = d[key];
        return `<div>
          <label class="field-label">${escapeHtml(label)}</label>
          <input class="input" type="number" step="any" data-driver="${escapeAttr(key)}" value="${escapeAttr(displayVal(val))}" ${dis} />
        </div>`;
      })
      .join("");
  }

  function assumptionFieldHtml(assumptionKey, def, bucket, dis) {
    const val = bucket[def.key];
    if (def.type === "boolean") {
      const on = Boolean(val);
      return `<div>
        <label class="field-label">${escapeHtml(def.label)}</label>
        <select class="select" data-assumption="${assumptionKey}.${def.key}" ${dis}>
          <option value="true" ${on ? "selected" : ""}>On / Yes</option>
          <option value="false" ${!on ? "selected" : ""}>Off / No</option>
        </select>
      </div>`;
    }
    if (def.type === "text" && def.key === "notes") {
      return `<div class="full">
        <label class="field-label">${escapeHtml(def.label)}</label>
        <textarea class="textarea" rows="4" data-assumption="${assumptionKey}.${def.key}" ${dis}>${escapeHtml(displayVal(val))}</textarea>
      </div>`;
    }
    const isNum = def.type === "number";
    return `<div>
      <label class="field-label">${escapeHtml(def.label)}</label>
      <input class="input" ${isNum ? 'type="number" step="any"' : ""} data-assumption="${assumptionKey}.${def.key}" value="${escapeAttr(displayVal(val))}" ${dis} />
    </div>`;
  }

  function relatedInputBlocks(sectionId, dis) {
    const items = relatedInputFields(sectionId);
    if (!items.length) {
      return `<p class="muted">No Input Tab fields matched this department yet. Open a Cosmos study after upload, or check Overview for the full capture.</p>`;
    }
    return `<div class="form-grid">${items
      .map((f) => {
        const raw = f.value;
        const isNum = typeof raw === "number";
        return `<div class="${f.note ? "full" : ""}">
          <label class="field-label">${escapeHtml(f.label || f.key)}${f.section ? ` <span class="muted">· ${escapeHtml(f.section)}</span>` : ""}</label>
          <input class="input" data-input-idx="${f.idx}" ${isNum ? 'type="number" step="any"' : ""} value="${escapeAttr(displayVal(raw))}" ${dis || f.editable === false ? "disabled" : ""} />
        </div>`;
      })
      .join("")}</div>`;
  }

  function renderDepartmentTab(sectionId) {
    const cfg = TAB_CONTENT[sectionId];
    const section = SBW.sections.find((s) => s.id === sectionId);
    if (!cfg || !section) return `<p class="muted">Unknown section.</p>`;

    if (!state.study.assumptions) state.study.assumptions = SBW.defaultStudy().assumptions;
    if (!state.study.assumptions[cfg.assumptionKey]) {
      state.study.assumptions[cfg.assumptionKey] = { ...(SBW.defaultStudy().assumptions[cfg.assumptionKey] || { notes: "" }) };
    }
    const bucket = state.study.assumptions[cfg.assumptionKey];
    const locked = !canEdit(section.department);
    const dis = locked ? "disabled" : "";
    const status = (ensureSectionStatus()[sectionId] || "not_started");

    const assumptionHtml = cfg.assumptionFields
      .map((def) => assumptionFieldHtml(cfg.assumptionKey, def, bucket, dis))
      .join("");

    let monitoringExtra = "";
    if (cfg.useMonitoringInputs) {
      const mon = state.study.monitoringInputs || {};
      const entries = Object.entries(mon);
      monitoringExtra = entries.length
        ? `<div class="card wide">
            <h3>Monitoring inputs (from Input Tab)</h3>
            <div class="form-grid">${entries
              .map(
                ([label, val]) => `<div class="full">
              <label class="field-label">${escapeHtml(label)}</label>
              <input class="input" data-monitoring-key="${escapeAttr(label)}" value="${escapeAttr(displayVal(val))}" ${dis} />
            </div>`
              )
              .join("")}</div>
          </div>`
        : "";
    }

    const calcRows =
      sectionId === "recruitment"
        ? `<table class="table">
            <thead><tr><th>Code</th><th>Units</th></tr></thead>
            <tbody>
              <tr><td>AA2 training</td><td>${num(state.results["recruitment.AA2.units"], 0)}</td></tr>
              <tr><td>AA3 first contact</td><td>${num(state.results["recruitment.AA3.units"], 0)}</td></tr>
              <tr><td>AA4 pre-screen</td><td>${num(state.results["recruitment.AA4.units"], 0)}</td></tr>
            </tbody>
          </table>`
        : `<p class="muted">Enrollment rate ${num(state.results["drivers.enrollmentRate"], 3)} · Total duration ${num(state.results["drivers.totalDuration"], 2)} mo</p>`;

    return `
      <div class="grid">
        <div class="card wide">
          <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:center;">
            <div>
              <h3>${escapeHtml(cfg.title)}</h3>
              <p class="muted">Status: <span class="badge ${escapeAttr(status)}">${escapeHtml(statusLabel(status))}</span></p>
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
              <button type="button" class="btn btn-secondary" data-status-section="${sectionId}" data-status="in_progress" ${dis}>In progress</button>
              <button type="button" class="btn btn-secondary" data-status-section="${sectionId}" data-status="ready_for_review" ${dis}>Mark ready for review</button>
              <button type="button" class="btn btn-primary" data-status-section="${sectionId}" data-status="approved" ${dis}>Approve</button>
            </div>
          </div>
        </div>
        <div class="card half">
          <h3>Department assumptions</h3>
          <div class="form-grid">${assumptionHtml}</div>
        </div>
        <div class="card half">
          <h3>Related drivers</h3>
          <div class="form-grid">${relatedDriverBlocks(sectionId, dis)}</div>
          <div style="margin-top:0.75rem;">${calcRows}</div>
        </div>
        <div class="card wide">
          <h3>Related Input Tab fields</h3>
          ${relatedInputBlocks(sectionId, dis)}
        </div>
        ${monitoringExtra}
        <div class="card wide">
          <h3>${escapeHtml(section.department || "")} line items</h3>
          ${lineItemsForDept(section.department)}
        </div>
      </div>`;
  }

  function renderRecruitment() {
    return renderDepartmentTab("recruitment");
  }

  function renderDeptSimple(sectionId) {
    return renderDepartmentTab(sectionId);
  }

  function renderReviews() {
    ensureSectionStatus();
    const deptSections = SBW.sections.filter((s) => s.department);
    const statusRows = deptSections
      .map((s) => {
        const st = state.study.sectionStatus[s.id] || "not_started";
        return `<tr>
          <td><button type="button" class="btn btn-secondary" data-jump="${s.id}">${escapeHtml(s.label)}</button></td>
          <td>${escapeHtml(s.department)}</td>
          <td><span class="badge ${escapeAttr(st)}">${escapeHtml(statusLabel(st))}</span></td>
          <td style="display:flex;gap:0.35rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-ghost" data-status-section="${s.id}" data-status="in_progress">In progress</button>
            <button type="button" class="btn btn-secondary" data-status-section="${s.id}" data-status="ready_for_review">Ready for review</button>
            <button type="button" class="btn btn-primary" data-status-section="${s.id}" data-status="approved">Approve</button>
            <button type="button" class="btn btn-ghost" data-status-section="${s.id}" data-status="not_started">Reset</button>
          </td>
        </tr>`;
      })
      .join("");

    if (!Array.isArray(state.study.requests)) state.study.requests = [];
    const rows = state.study.requests
      .map((r) => {
        const user = SBW.users.find((u) => u.id === r.assigneeId);
        const by = SBW.users.find((u) => u.id === r.requestedBy);
        return `<tr>
          <td>${escapeHtml(r.department || "")}</td>
          <td>${escapeHtml(user ? user.name : displayVal(r.assigneeId) || "—")}</td>
          <td>${escapeHtml(by ? by.name : displayVal(r.requestedBy) || "—")}</td>
          <td>${escapeHtml(displayVal(r.note) || "—")}</td>
          <td><span class="badge ${r.status === "completed" ? "approved" : "in_progress"}">${escapeHtml(r.status || "open")}</span></td>
          <td>
            ${
              r.status !== "completed"
                ? `<button type="button" class="btn btn-secondary" data-complete-request="${escapeAttr(r.id)}">Mark done</button>`
                : "—"
            }
          </td>
        </tr>`;
      })
      .join("") || `<tr><td colspan="6">No fill requests yet. Use <strong>Request fill</strong> in the top bar.</td></tr>`;

    return `
      <div class="grid">
        <div class="card wide">
          <h3>Section review status</h3>
          <p class="muted">Move each department through review. Status also appears as dots in the left nav.</p>
          <table class="table">
            <thead><tr><th>Section</th><th>Dept</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${statusRows}</tbody>
          </table>
        </div>
        <div class="card wide">
          <h3>Fill / review requests</h3>
          <table class="table">
            <thead><tr><th>Dept</th><th>Assignee</th><th>Requested by</th><th>Note</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  function renderSummary() {
    const totals = state.study.totals || {};
    const execAreas = (state.study.execSum && state.study.execSum.serviceAreas) || [];
    const totalRows = Object.entries(totals).map(([k, v]) =>
      `<tr><td>${escapeHtml(k)}</td><td>${money(v)}</td></tr>`
    ).join("") || `<tr><td colspan="2" class="muted">No Exec Sum totals on this study yet.</td></tr>`;
    const areaRows = execAreas.map((a) =>
      `<tr><td>${escapeHtml(a.name || "")}</td><td>${money(a.serviceFees)}</td></tr>`
    ).join("");

    return `
      <div class="grid">
        <div class="card"><h3>Service fees</h3><div class="stat">${money(state.results["summary.totalServiceFees"])}</div></div>
        <div class="card"><h3>Pass-throughs</h3><div class="stat">${money(state.results["summary.passThroughs"])}</div></div>
        <div class="card"><h3>Grand total</h3><div class="stat">${money(state.results["summary.grandTotal"])}</div></div>
        <div class="card half">
          <h3>Exec Sum totals (from file)</h3>
          <table class="table"><thead><tr><th>Label</th><th>Amount</th></tr></thead><tbody>${totalRows}</tbody></table>
        </div>
        <div class="card half">
          <h3>Service areas (from file)</h3>
          <table class="table"><thead><tr><th>Area</th><th>Fees</th></tr></thead><tbody>${areaRows || "<tr><td colspan=2 class=muted>None</td></tr>"}</tbody></table>
        </div>
        <div class="card wide">
          <h3>Export</h3>
          <button type="button" class="btn btn-primary" id="btnExportInline">Download study JSON</button>
        </div>
      </div>`;
  }

  function renderFormulas() {
    const locked = !canEdit("Analyst");
    const dis = locked ? "disabled" : "";
    const rows = Object.values({ ...SBW.formulaLibrary, ...state.study.formulaOverrides })
      .map((f) => {
        const expr = (state.study.formulaOverrides[f.id] || f).expression || f.expression;
        const result = state.results[f.id];
        return `<tr>
          <td>${f.id}<div class="muted">${f.label}</div></td>
          <td>${f.department}</td>
          <td><input class="input" data-formula="${f.id}" value="${escapeAttr(expr)}" ${dis} /></td>
          <td>${typeof result === "number" ? num(result, 2) : "—"}</td>
        </tr>`;
      }).join("");

    return `
      <div class="grid">
        <div class="card wide">
          <h3>Editable formula library</h3>
          <p class="muted">Change an expression and it recalculates immediately. Later these live in Cosmos.</p>
          <table class="table">
            <thead><tr><th>Formula</th><th>Dept</th><th>Expression</th><th>Result</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="card wide">
          <h3>Example</h3>
          <div class="formula-box">drivers.enrollmentRate = d.enrolledSubjects / d.coreSites / d.enrollmentMonths</div>
        </div>
      </div>`;
  }

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  /** Buddy chat: [[h]] blue headers, [[i]] red important; accept common model variants. */
  function formatBuddyHtml(raw) {
    let s = String(raw == null ? "" : raw);
    s = s.replace(/\r\n/g, "\n");
    // Soften leftover markdown / HTML the model still emits
    s = s.replace(/^#{1,6}\s+/gm, "");
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "[[i]]$1[[/i]]");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "[[i]]$1[[/i]]");
    s = s.replace(/__([^_\n]+)__/g, "[[i]]$1[[/i]]");
    s = s.replace(/<\/?(?:strong|b)>/gi, (m) => (/^<\//.test(m) ? "[[/i]]" : "[[i]]"));
    s = s.replace(/<\/?(?:em|i)>/gi, (m) => (/^<\//.test(m) ? "[[/i]]" : "[[i]]"));
    // Normalize spaced double-bracket tags first: [[ i ]] → [[i]]
    s = s.replace(/\[\[\s*(h|i)\s*\]\]/gi, (_, t) => `[[${t.toLowerCase()}]]`);
    s = s.replace(/\[\[\s*\/\s*(h|i)\s*\]\]/gi, (_, t) => `[[/${t.toLowerCase()}]]`);
    // ((i))…((/i)) → canonical (safe; does not collide with [[i]])
    s = s.replace(/\(\(\s*(h|i)\s*\)\)([\s\S]*?)\(\(\s*\/\s*\1\s*\)\)/gi, (_, t, body) => {
      const tag = String(t).toLowerCase();
      return `[[${tag}]]${body}[[/${tag}]]`;
    });
    // Single [i]…[/i] only when NOT already double-bracketed
    s = s.replace(
      /(?<!\[)\[\s*(h|i)\s*\](?!\[)([\s\S]*?)(?<!\[)\[\s*\/\s*\1\s*\](?!\])/gi,
      (_, t, body) => {
        const tag = String(t).toLowerCase();
        return `[[${tag}]]${body}[[/${tag}]]`;
      }
    );

    const chunks = [];
    const re = /\[\[(h|i)\]\]([\s\S]*?)\[\[\/\1\]\]/gi;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) chunks.push({ type: "text", value: s.slice(last, m.index) });
      chunks.push({ type: m[1].toLowerCase(), value: m[2] });
      last = m.index + m[0].length;
    }
    if (last < s.length) chunks.push({ type: "text", value: s.slice(last) });

    return chunks
      .map((c) => {
        const body = escapeHtml(c.value).replaceAll("\n", "<br>");
        if (c.type === "h") return `<div class="buddy-h">${body}</div>`;
        if (c.type === "i") return `<span class="buddy-i">${body}</span>`;
        return body;
      })
      .join("");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replaceAll('"', "&quot;");
  }

  function render() {
    recalc();
    const user = currentUser();
    const section = SBW.sections.find((s) => s.id === state.sectionId) || SBW.sections[0];

    els.studyMeta.textContent = hasOpenStudy()
      ? `${state.study.studyId} · ${state.study.clientName || "—"} · ${state.study.versionLabel || "—"}${state.source === "cosmos" ? " · Cosmos" : ""}`
      : "No study selected · All studies (portfolio)";
    els.pageTitle.textContent = section.label;
    els.pageSubtitle.textContent = !hasOpenStudy()
      ? "Portfolio mode — Buddy answers from all Cosmos studies"
      : section.department
        ? `Editable by ${section.department}${canEdit(section.department) ? "" : " (view only for you)"}`
        : "Shared study workspace";
    if (els.btnClearStudy) {
      els.btnClearStudy.disabled = !hasOpenStudy();
      els.btnClearStudy.textContent = hasOpenStudy() ? "All studies" : "All studies ✓";
    }

    renderNav();

    let html = "";
    switch (section.id) {
      case "hub": html = renderHub(); break;
      case "upload": html = renderUpload(); break;
      case "studies": html = renderStudies(); break;
      case "versions": html = renderVersions(); break;
      case "intelligence": html = renderIntelligence(); break;
      case "scorecard": html = renderScorecard(); break;
      case "overview": html = renderOverview(); break;
      case "recruitment": html = renderDepartmentTab("recruitment"); break;
      case "clinops": html = renderDepartmentTab("clinops"); break;
      case "monitoring": html = renderDepartmentTab("monitoring"); break;
      case "smo": html = renderDepartmentTab("smo"); break;
      case "summary": html = renderSummary(); break;
      case "reviews": html = renderReviews(); break;
      case "formulas": html = renderFormulas(); break;
      default: html = renderHub();
    }
    els.viewRoot.innerHTML = html;
    if (section.id === "studies") {
      loadStudiesIntoPanel();
    }
    if (section.id === "versions") {
      const older = document.getElementById("compareOlder");
      const newer = document.getElementById("compareNewer");
      if (older && newer && older.options.length >= 2) {
        newer.selectedIndex = 0;
        older.selectedIndex = 1;
      }
    }
  }

  function bind() {
    els.userSelect.innerHTML = SBW.users.map(
      (u) => `<option value="${u.id}" ${u.id === state.userId ? "selected" : ""}>${u.department}</option>`
    ).join("");

    const depts = [...new Set(SBW.sections.filter((s) => s.department).map((s) => s.department))];
    els.requestDept.innerHTML = depts.map((d) => `<option value="${d}">${d}</option>`).join("");
    els.requestUser.innerHTML = SBW.users.map(
      (u) => `<option value="${u.id}">${u.department}</option>`
    ).join("");

    els.userSelect.addEventListener("change", () => {
      state.userId = els.userSelect.value;
      localStorage.setItem(USER_KEY, state.userId);
      const user = currentUser();
      if (user.department === "Admin") {
        state.sectionId = "hub";
      } else {
        const home = SBW.sections.find((s) => s.department === user.department);
        state.sectionId = home ? home.id : "hub";
      }
      render();
    });

    els.sectionNav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-section]");
      if (!btn) return;
      setSection(btn.dataset.section);
    });

    els.viewRoot.addEventListener("input", (e) => {
      if (!e.target) return;
      if (e.target.id === "intelIndication") state.intelligence.indication = e.target.value;
      if (e.target.id === "scoreIndication") state.scorecard.indication = e.target.value;
      const qScope = e.target.getAttribute("data-country-query");
      if (qScope) {
        const st = countryBagState(qScope);
        st.countryQuery = e.target.value;
        st.countrySuggestOpen = true;
        // Re-render only the suggest list via light paint
        const picker = e.target.closest(".country-picker");
        if (picker) {
          const wrap = picker.querySelector(".country-typeahead");
          if (wrap) {
            const suggestions = SBW.suggestIntelCountries
              ? SBW.suggestIntelCountries(st.countryQuery || "", st.countries || [], 10)
              : [];
            let ul = wrap.querySelector(".country-suggest");
            if (!suggestions.length) {
              if (ul) ul.remove();
            } else {
              const html = `<ul class="country-suggest" role="listbox">${suggestions
                .map(
                  (s) =>
                    `<li><button type="button" data-country-add="${escapeAttr(qScope)}" data-country-name="${escapeAttr(
                      s.name
                    )}">${escapeHtml(s.name)} <span class="muted">${escapeHtml(
                      (s.aliases || []).slice(0, 3).join(" · ")
                    )}</span></button></li>`
                )
                .join("")}</ul>`;
              if (ul) ul.outerHTML = html;
              else wrap.insertAdjacentHTML("beforeend", html);
            }
          }
        }
      }
    });

    els.viewRoot.addEventListener("keydown", (e) => {
      if (!e.target) return;
      if (e.target.id === "intelIndication" && e.key === "Enter") {
        e.preventDefault();
        runIntelligenceQuery(e.target.value);
        return;
      }
      if (e.target.id === "scoreIndication" && e.key === "Enter") {
        e.preventDefault();
        runSiteScorecard();
        return;
      }
      const qScope = e.target.getAttribute("data-country-query");
      if (qScope && e.key === "Enter") {
        e.preventDefault();
        const st = countryBagState(qScope);
        const resolved = SBW.resolveIntelCountry
          ? SBW.resolveIntelCountry(st.countryQuery)
          : null;
        if (resolved) {
          addCountrySelection(qScope, resolved);
          render();
        }
      }
      if (qScope && e.key === "Escape") {
        countryBagState(qScope).countrySuggestOpen = false;
        render();
      }
    });

    els.viewRoot.addEventListener("click", (e) => {
      const jump = e.target.closest("[data-jump]");
      if (jump) {
        setSection(jump.dataset.jump);
        return;
      }
      const statusBtn = e.target.closest("[data-status-section]");
      if (statusBtn) {
        setSectionStatus(statusBtn.dataset.statusSection, statusBtn.dataset.status);
        return;
      }

      const countryAdd = e.target.closest("[data-country-add]");
      if (countryAdd) {
        addCountrySelection(
          countryAdd.getAttribute("data-country-add"),
          countryAdd.getAttribute("data-country-name")
        );
        render();
        return;
      }
      const countryRm = e.target.closest("[data-country-remove]");
      if (countryRm) {
        removeCountrySelection(
          countryRm.getAttribute("data-country-remove"),
          countryRm.getAttribute("data-country-name")
        );
        render();
        return;
      }
      const countryGlobal = e.target.closest("[data-country-global]");
      if (countryGlobal) {
        const scope = countryGlobal.getAttribute("data-country-global");
        setCountryGlobal(scope, !countryBagState(scope).globalRegion);
        render();
        return;
      }
      const clearGlobal = e.target.closest("[data-country-clear-global]");
      if (clearGlobal) {
        setCountryGlobal(clearGlobal.getAttribute("data-country-clear-global"), false);
        render();
        return;
      }

      const intelChip = e.target.closest("[data-intel-ind]");
      if (intelChip) {
        runIntelligenceQuery(intelChip.getAttribute("data-intel-ind"));
        return;
      }
      const scoreChip = e.target.closest("[data-score-ind]");
      if (scoreChip) {
        state.scorecard.indication = scoreChip.getAttribute("data-score-ind") || "";
        runSiteScorecard();
        return;
      }
      const scoreSrc = e.target.closest("[data-score-source]");
      if (scoreSrc) {
        state.scorecard.source = scoreSrc.getAttribute("data-score-source") || "veeva";
        if (state.scorecard.result) runSiteScorecard();
        else render();
        return;
      }
      const intelAsk = e.target.closest("[data-intel-ask]");
      if (intelAsk) {
        askBuddyAboutIndication(intelAsk.getAttribute("data-intel-ask"));
        return;
      }
      if (e.target.id === "btnIntelQuery") {
        const input = document.getElementById("intelIndication");
        runIntelligenceQuery(input ? input.value : "");
        return;
      }
      if (e.target.id === "btnScoreQuery") {
        const input = document.getElementById("scoreIndication");
        if (input) state.scorecard.indication = input.value;
        runSiteScorecard();
        return;
      }
      if (e.target.id === "btnOpenBenchmark") {
        const u = new URL(window.location.href);
        u.searchParams.set("section", "intelligence");
        if (state.intelligence.indication) u.searchParams.set("q", state.intelligence.indication);
        if (state.intelligence.globalRegion) u.searchParams.set("global", "true");
        else if ((state.intelligence.countries || []).length) {
          u.searchParams.set("countries", state.intelligence.countries.join(","));
        }
        window.open(u.toString(), "_blank", "noopener");
        return;
      }
      if (e.target.id === "btnIntelRefresh") {
        loadIntelligenceHealth();
        return;
      }
      if (e.target.id === "btnCtgovSync") {
        runCtgovSyncManual();
        return;
      }
      const completeReq = e.target.closest("[data-complete-request]");
      if (completeReq) {
        const id = completeReq.getAttribute("data-complete-request");
        if (!Array.isArray(state.study.requests)) state.study.requests = [];
        const req = state.study.requests.find((r) => r.id === id);
        if (req) {
          req.status = "completed";
          markDirty();
          render();
        }
        return;
      }
      if (e.target.id === "btnExportInline") {
        exportJson();
      }
      if (e.target.id === "btnStartUpload") {
        startUpload();
        return;
      }
      if (e.target.id === "btnRefreshQuarantine") {
        refreshQuarantine();
        return;
      }
      if (e.target.id === "btnRefreshStudies") {
        loadStudiesIntoPanel();
        return;
      }
      if (e.target.id === "btnNewStudyInline" || e.target.id === "btnNewStudyHub") {
        openNewStudyDialog();
        return;
      }
      if (e.target.id === "btnClearStudyInline") {
        clearOpenStudy();
        return;
      }
      if (e.target.id === "btnExpandAllGroups") {
        state.studiesCollapsed = {};
        paintStudiesPanel();
        return;
      }
      if (e.target.id === "btnCollapseAllGroups") {
        const groupBy = state.studiesGroupBy || "client";
        const next = {};
        for (const s of state.studiesList || []) {
          next[`${groupBy}::${groupKeyForStudy(s, groupBy)}`] = true;
        }
        state.studiesCollapsed = next;
        paintStudiesPanel();
        return;
      }
      const toggleGroup = e.target.closest("[data-toggle-group]");
      if (toggleGroup) {
        const key = toggleGroup.getAttribute("data-toggle-group");
        state.studiesCollapsed = { ...(state.studiesCollapsed || {}) };
        state.studiesCollapsed[key] = !state.studiesCollapsed[key];
        paintStudiesPanel();
        return;
      }
      if (e.target.id === "btnOpenStudyCompare") {
        const sel = state.studyCompare.selected || [];
        if (sel.length === 2) openStudyCompare(sel[0], sel[1]);
        return;
      }
      if (e.target.matches && e.target.matches("[data-compare-pick]")) {
        const id = e.target.getAttribute("data-compare-pick");
        let sel = [...(state.studyCompare.selected || [])];
        if (e.target.checked) {
          if (!sel.includes(id)) sel.push(id);
          if (sel.length > 2) {
            const drop = sel.shift();
            const prev = els.viewRoot.querySelector(`[data-compare-pick="${CSS.escape(drop)}"]`);
            if (prev) prev.checked = false;
          }
        } else {
          sel = sel.filter((x) => x !== id);
        }
        state.studyCompare.selected = sel.slice(0, 2);
        syncCompareSelectedFromDom();
        return;
      }
      if (e.target.id === "btnRunCompare") {
        runCompare();
        return;
      }
      if (e.target.id === "btnOpenNewerVersion") {
        const newerEl = document.getElementById("compareNewer");
        if (newerEl && newerEl.value) openVersionInWorkspace(newerEl.value);
        return;
      }
      const openStudyBtn = e.target.closest("[data-open-study]");
      if (openStudyBtn) {
        openStudy(openStudyBtn.getAttribute("data-open-study"));
      }
    });

    if (els.compareOverlay) {
      els.compareOverlay.addEventListener("click", (e) => {
        if (e.target.id === "btnCloseStudyCompare" || e.target === els.compareOverlay) {
          closeStudyCompare();
          return;
        }
        const openWb = e.target.closest("[data-compare-open-workbench]");
        if (openWb) {
          const id = openWb.getAttribute("data-compare-open-workbench");
          closeStudyCompare();
          openStudy(id);
        }
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.studyCompare.open) closeStudyCompare();
      if (e.key === "Escape" && state.buddyOpen) closeBuddy();
    });

    els.viewRoot.addEventListener("change", (e) => {
      if (e.target.id === "studiesGroupBy") {
        state.studiesGroupBy = e.target.value || "client";
        localStorage.setItem("sbw.studiesGroupBy", state.studiesGroupBy);
        state.studiesCollapsed = {};
        paintStudiesPanel();
      }
    });

    els.viewRoot.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.driver) {
        const raw = t.value;
        state.study.drivers[t.dataset.driver] = raw === "" ? null : (t.type === "number" ? Number(raw) : raw);
        markDirty();
        recalc();
        return;
      }
      if (t.dataset.study) {
        state.study[t.dataset.study] = t.value;
        markDirty();
        return;
      }
      if (t.dataset.inputIdx != null) {
        const idx = Number(t.dataset.inputIdx);
        if (!state.study.inputFields) state.study.inputFields = [];
        if (state.study.inputFields[idx]) {
          const prev = state.study.inputFields[idx].value;
          const next = t.type === "number" && t.value !== "" ? Number(t.value) : t.value;
          state.study.inputFields[idx].value = next;
          const key = state.study.inputFields[idx].key;
          if (key && !String(key).startsWith("input:") && !String(key).startsWith("driver:") && !String(key).startsWith("side:") && !String(key).startsWith("section:")) {
            if (!state.study.header) state.study.header = {};
            state.study.header[key] = next;
            if (["clientName", "title", "protocol", "phase", "therapeuticArea", "indication", "enrollmentType", "budgetType"].includes(key)) {
              state.study[key] = next;
            }
          }
          if (String(key || "").startsWith("driver.") || (typeof prev === "number" || t.type === "number")) {
            const dkey = String(key || "").replace(/^driver\./, "");
            if (state.study.drivers && dkey in state.study.drivers) {
              state.study.drivers[dkey] = next;
              recalc();
            }
          }
        }
        markDirty();
        return;
      }
      if (t.dataset.siteIdx != null && t.dataset.siteField) {
        const i = Number(t.dataset.siteIdx);
        if (!state.study.sites) state.study.sites = [];
        if (state.study.sites[i]) {
          const field = t.dataset.siteField;
          state.study.sites[i][field] = t.type === "number" && t.value !== "" ? Number(t.value) : t.value;
        }
        markDirty();
        return;
      }
      if (t.dataset.monitoringKey) {
        if (!state.study.monitoringInputs) state.study.monitoringInputs = {};
        state.study.monitoringInputs[t.dataset.monitoringKey] = t.value;
        markDirty();
        return;
      }
      if (t.dataset.paymentKey) {
        if (!state.study.payments) state.study.payments = {};
        state.study.payments[t.dataset.paymentKey] = t.value;
        markDirty();
        return;
      }
      if (t.dataset.vendorIdx != null && t.dataset.vendorField) {
        const i = Number(t.dataset.vendorIdx);
        if (!state.study.vendors) state.study.vendors = [];
        if (state.study.vendors[i]) {
          state.study.vendors[i][t.dataset.vendorField] = t.value;
        }
        markDirty();
        return;
      }
      if (t.dataset.assumption) {
        const [group, key] = t.dataset.assumption.split(".");
        if (!state.study.assumptions) state.study.assumptions = SBW.defaultStudy().assumptions;
        if (!state.study.assumptions[group]) state.study.assumptions[group] = {};
        let val = t.value;
        if (val === "true") val = true;
        else if (val === "false") val = false;
        else if (t.type === "number") val = val === "" ? null : Number(val);
        state.study.assumptions[group][key] = val;
        markDirty();
        recalc();
        return;
      }
      if (t.dataset.formula) {
        const id = t.dataset.formula;
        const base = SBW.formulaLibrary[id] || state.study.formulaOverrides[id];
        state.study.formulaOverrides[id] = { ...base, expression: t.value };
        markDirty();
        render();
      }
    });

    els.btnSave.addEventListener("click", save);
    els.btnExport.addEventListener("click", exportJson);

    if (els.btnBuddyOpen) els.btnBuddyOpen.addEventListener("click", openBuddy);
    if (els.btnNewStudy) els.btnNewStudy.addEventListener("click", openNewStudyDialog);
    if (els.btnClearStudy) els.btnClearStudy.addEventListener("click", () => clearOpenStudy());
    if (els.newStudyForm) {
      els.newStudyForm.addEventListener("submit", (e) => {
        const submitter = e.submitter;
        if (!submitter || submitter.value !== "confirm") return;
        startNewStudyFromForm();
      });
    }
    if (els.buddyFab) els.buddyFab.addEventListener("click", openBuddy);
    if (els.buddyClose) els.buddyClose.addEventListener("click", closeBuddy);
    if (els.btnAsk) els.btnAsk.addEventListener("click", sendAsk);
    if (els.askInput) {
      els.askInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendAsk();
        }
      });
    }
    if (els.buddyPanel) {
      els.buddyPanel.addEventListener("click", (e) => {
        const applyBtn = e.target.closest("[data-buddy-apply]");
        if (applyBtn) {
          applyProposal(applyBtn.getAttribute("data-buddy-apply"));
          return;
        }
        const createBtn = e.target.closest("[data-buddy-create]");
        if (createBtn) {
          applyCreateStudy(createBtn.getAttribute("data-buddy-create"));
          return;
        }
        const rejectBtn = e.target.closest("[data-buddy-reject]");
        if (rejectBtn) {
          rejectProposal(rejectBtn.getAttribute("data-buddy-reject"));
        }
      });
    }
    els.btnRequestFill.addEventListener("click", () => els.requestDialog.showModal());

    els.requestForm.addEventListener("submit", (e) => {
      const submitter = e.submitter;
      if (!submitter || submitter.value !== "confirm") return;
      state.study.requests.unshift({
        id: "req-" + Date.now(),
        department: els.requestDept.value,
        assigneeId: els.requestUser.value,
        requestedBy: state.userId,
        note: els.requestNote.value || "Please complete your section.",
        status: "open",
        createdAt: new Date().toISOString()
      });
      const section = SBW.sections.find((s) => s.department === els.requestDept.value);
      if (section) state.study.sectionStatus[section.id] = "in_progress";
      els.requestNote.value = "";
      markDirty();
      save();
      render();
    });
  }

  function exportJson() {
    const payload = {
      study: state.study,
      calculated: state.results,
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.study.studyId}_${state.study.versionLabel}_export.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function loadEntraUser() {
    const el = document.getElementById("authUser");
    const btn = document.getElementById("btnSignOut");
    try {
      const res = await fetch("/.auth/me");
      if (!res.ok) return;
      const payload = await res.json();
      const principal = Array.isArray(payload) ? payload[0] : payload?.clientPrincipal;
      if (!principal) return;
      const claims = {};
      for (const c of principal.claims || []) {
        if (!c || c.typ == null) continue;
        claims[c.typ] = c.val;
        const short = String(c.typ).split("/").pop();
        if (short && claims[short] == null) claims[short] = c.val;
      }
      const email = principal.userDetails || claims.preferred_username || claims.email || null;
      const displayName = claims.name || email || principal.userId || "Signed in";
      const given = claims.given_name || claims.givenname || null;
      let firstName = given ? String(given).trim().split(/\s+/)[0] : null;
      if (!firstName && displayName && !String(displayName).includes("@")) {
        firstName = String(displayName).trim().split(/[\s,]+/)[0];
      }
      if (!firstName && email && String(email).includes("@")) {
        const token = String(email).split("@")[0].split(/[._-]/)[0];
        if (token) firstName = token.charAt(0).toUpperCase() + token.slice(1);
      }
      state.entraUser = {
        userId: principal.userId || null,
        identityProvider: principal.identityProvider || "aad",
        email,
        displayName,
        firstName
      };
      if (el) {
        el.textContent = displayName;
        el.hidden = false;
      }
      if (btn) btn.hidden = false;
    } catch {
      /* local / unauthenticated preview */
    }
  }

  // Land user on their department page on first load (Admin stays on Hub)
  const user = currentUser();
  if (state.sectionId === "ask") state.sectionId = "hub";

  // Deep-link: ?section=intelligence&q=Dry+Eye&countries=United%20States or global=true
  try {
    const boot = new URLSearchParams(window.location.search);
    const sec = boot.get("section");
    if (sec && SBW.sections.some((s) => s.id === sec)) state.sectionId = sec;
    const q = boot.get("q");
    if (q) {
      state.intelligence.indication = q;
      state.scorecard.indication = q;
    }
    if (boot.get("global") === "true") {
      state.intelligence.globalRegion = true;
      state.scorecard.globalRegion = true;
    } else if (boot.get("countries")) {
      const list = boot
        .get("countries")
        .split(",")
        .map((c) => (SBW.resolveIntelCountry ? SBW.resolveIntelCountry(c.trim()) : c.trim()))
        .filter(Boolean)
        .filter((c) => c !== (SBW.INTEL_GLOBAL || "Global"));
      state.intelligence.countries = [...new Set(list)];
      state.scorecard.countries = [...state.intelligence.countries];
    }
  } catch (_) {}

  if (user.department !== "Admin" && !new URLSearchParams(window.location.search).get("section")) {
    const home = SBW.sections.find((s) => s.department === user.department);
    if (home) state.sectionId = home.id;
  }

  function bindTheme() {
    const THEME_KEY = "sbw.theme";
    const root = document.documentElement;
    const lightBtn = document.getElementById("themeLight");
    const darkBtn = document.getElementById("themeDark");

    function applyTheme(theme) {
      const next = theme === "dark" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
      if (lightBtn) lightBtn.classList.toggle("active", next === "light");
      if (darkBtn) darkBtn.classList.toggle("active", next === "dark");
    }

    applyTheme(root.getAttribute("data-theme") || localStorage.getItem(THEME_KEY) || "light");
    if (lightBtn) lightBtn.addEventListener("click", () => applyTheme("light"));
    if (darkBtn) darkBtn.addEventListener("click", () => applyTheme("dark"));
  }

  bind();
  bindTheme();
  render();
  paintBuddyChat();
  markSaved();
  loadEntraUser();
})();
