window.SBW = window.SBW || {};

SBW.users = [
  { id: "u-admin", name: "Admin", department: "Admin" },
  { id: "u-analyst", name: "Analyst", department: "Analyst" },
  { id: "u-recruit", name: "Recruitment", department: "Recruitment" },
  { id: "u-clinops", name: "ClinOps", department: "ClinOps" },
  { id: "u-monitor", name: "Monitoring", department: "Monitoring" },
  { id: "u-smo", name: "SMO", department: "SMO" },
  { id: "u-tah", name: "TAH", department: "TAH" }
];

SBW.sections = [
  { id: "hub", label: "Hub", department: null },
  { id: "dashboard", label: "Dashboard", department: null },
  { id: "intelligence", label: "Ora Clinical Intelligence", department: null },
  { id: "scorecard", label: "Site Scorecard", department: null },
  { id: "buddy", label: "Buddy", department: null },
  { id: "data-status", label: "Data Status", department: null },
  { id: "ops", label: "Ops Dashboard", department: null },
  { id: "buddy-context", label: "Buddy Context", department: null },
  { id: "studies", label: "Studies", department: null },
  { id: "versions", label: "Versions / Diff", department: null },
  { id: "hlbp", label: "HLBP", department: null, navGroup: "budget" },
  { id: "overview", label: "Overview / Inputs", department: "Analyst", navGroup: "budget" },
  { id: "recruitment", label: "Recruitment", department: "Recruitment", navGroup: "budget" },
  { id: "clinops", label: "ClinOps / SOE", department: "ClinOps", navGroup: "budget" },
  { id: "monitoring", label: "Clinical Monitoring", department: "Monitoring", navGroup: "budget" },
  { id: "smo", label: "Block Enrollment / SMO", department: "SMO", navGroup: "budget" },
  { id: "summary", label: "Exec Summary", department: null, navGroup: "budget" },
  { id: "reviews", label: "Reviews", department: null, navGroup: "budget" },
  { id: "formulas", label: "Formulas", department: "Analyst", navGroup: "budget" },
  { id: "upload", label: "Upload budgets", department: "Analyst", navGroup: "budget" }
];

/** Sidebar groups — budget work stays available, collapsed at the bottom. */
SBW.navGroups = {
  budget: {
    id: "budget",
    label: "Budget (legacy)",
    defaultSection: "overview"
  }
};

/** Tabs that require explicit Edit lock before changing fields. */
SBW.lockableSections = ["hlbp", "overview", "recruitment", "clinops", "monitoring", "smo", "formulas"];

/** Map APPLY path → section id for lock checks. */
SBW.sectionForFieldPath = function (path) {
  const p = String(path || "");
  if (p.startsWith("assumptions.recruitment") || p === "recruitment") return "recruitment";
  if (p.startsWith("assumptions.clinops")) return "clinops";
  if (p.startsWith("assumptions.monitoring") || p.startsWith("monitoring")) return "monitoring";
  if (p.startsWith("assumptions.smo") || p.startsWith("vendors") || p.startsWith("payments")) return "smo";
  if (p.startsWith("totals.") || p.startsWith("sites.")) return "hlbp";
  if (p.startsWith("formula")) return "formulas";
  return "overview";
};

/** Simple High Level Ballpark (HLBP) v1 field checklist. */
SBW.hlbpFields = {
  header: [
    { key: "clientName", label: "Client / sponsor", required: true },
    { key: "studyId", label: "Opportunity id", required: false },
    { key: "title", label: "Study title", required: false },
    { key: "protocol", label: "Protocol", required: false },
    { key: "phase", label: "Phase", required: true },
    { key: "therapeuticArea", label: "Therapeutic area", required: false },
    { key: "indication", label: "Indication", required: true }
  ],
  drivers: [
    { key: "screenedSubjects", label: "Screened subjects", required: false },
    { key: "enrolledSubjects", label: "Enrolled subjects", required: true },
    { key: "completedSubjects", label: "Completed subjects", required: false },
    { key: "coreSites", label: "Total core sites", required: true },
    { key: "startupMonths", label: "Start-up months", required: false },
    { key: "enrollmentMonths", label: "Enrollment months", required: true },
    { key: "treatmentMonths", label: "Treatment months", required: false },
    { key: "screenFailRate", label: "Screen-fail %", required: false },
    { key: "dropOutRate", label: "Drop-out %", required: false }
  ],
    siteMix: [
      { key: "country", label: "Country", required: true },
      { key: "coreSites", label: "Core sites", required: true },
      { key: "backupSites", label: "Backup sites", required: false },
      { key: "enrolledPts", label: "Enrolled pts (country)", required: false },
      { key: "notes", label: "Notes", required: false }
    ],
    fees: [
      { key: "serviceFees", label: "Service fees (ballpark $)", required: false },
      { key: "passThroughs", label: "Pass-throughs $", required: false },
      { key: "grandTotal", label: "Grand total $", required: false }
    ]
  };

/** Hub shortcuts — feasibility first; budget stays in the sidebar group. */
SBW.bdShortcuts = [
  {
    id: "dashboard",
    title: "Dashboard",
    blurb: "Weekly commercial brief — chase, watch, SF pipeline"
  },
  {
    id: "intelligence",
    title: "Indication benchmark",
    blurb: "Ora vs industry PSM — for proposals and RFIs"
  },
  {
    id: "scorecard",
    title: "Site Scorecard",
    blurb: "Rank sites, concurrent Ora load, recommended slate"
  },
  {
    id: "data-status",
    title: "Data Status",
    blurb: "Veeva / Salesforce / CT.gov ingest"
  },
  {
    id: "ops",
    title: "Ops Dashboard",
    blurb: "Workflow status and data health"
  },
  {
    id: "hlbp",
    title: "HLBP (budget)",
    blurb: "High Level Ballpark form — still available under Budget"
  }
];

/** Prefill Ask Buddy from Hub. */
SBW.buddyQuickAsks = [
  {
    id: "pitch",
    label: "Draft pitch points",
    prompt:
      "For Dry Eye in the US, give me 3 short talking points comparing Ora median enrollment speed vs industry, plus geography and competitive recruiting. Proposal-ready."
  },
  {
    id: "sites",
    label: "Site slate",
    prompt:
      "Rank Ora sites for Dry Eye in the US. Include concurrent Ora studies at each org, startup speed if we have it, and a recommended slate with expected enrollment."
  },
  {
    id: "weekly-brief",
    label: "Weekly commercial brief",
    prompt:
      "Produce an HTML leave-behind leadership visual for Ora's weekly commercial brief. Use live Salesforce Total Ora Net Revenue for open pipeline (never Amount/contract), chase list, watch/reassess flags, and owner coverage. Do not use uploaded bid workbook fees. Headline numbers first, then tables. Internal company briefing — clear and actionable."
  },
  {
    id: "ops",
    label: "Feasibility pulse",
    prompt:
      "Feasibility pulse: Veeva study/site counts, Salesforce pipeline (Total Ora Net Revenue), CT.gov last sync. Then what I should check next on Intelligence or Site Scorecard."
  }
];

/** Empty = same origin /api (Static Web App) */
SBW.apiBase = "";

/** Empty workspace until a Cosmos study is opened or a file is uploaded. */
SBW.defaultStudy = function () {
  return {
    studyId: "",
    clientName: "",
    title: "",
    protocol: "",
    versionLabel: "",
    phase: "",
    therapeuticArea: "",
    indication: "",
    enrollmentType: "",
    budgetType: "",
    category: "",
    totals: {
      serviceFees: null,
      passThroughs: null,
      grandTotal: null
    },
    drivers: {
      screenedSubjects: null,
      enrolledSubjects: null,
      completedSubjects: null,
      coreSites: null,
      startupMonths: null,
      enrollmentMonths: null,
      treatmentMonths: null,
      dblMonths: null,
      closeoutMonths: null,
      screenFailRate: null,
      dropOutRate: null,
      sdvPercent: null,
      contingency: null,
      inflationRate: null,
      discount: null
    },
    sites: [],
    sectionStatus: {
      overview: "not_started",
      recruitment: "not_started",
      clinops: "not_started",
      monitoring: "not_started",
      smo: "not_started",
      summary: "not_started",
      formulas: "not_started",
      hlbp: "not_started"
    },
    assumptions: {
      recruitment: {
        contactCenterOn: false,
        advertisingOn: false,
        materialsOn: false,
        recruiterTrainingAttendees: null,
        notes: ""
      },
      monitoring: {
        strategy: "",
        rbqmFrequency: "",
        maskedTeams: false,
        notes: ""
      },
      clinops: {
        soeSource: "",
        patientPopulation: "",
        notes: ""
      },
      smo: {
        blockEnrollmentOn: false,
        fixedSitePtComp: false,
        notes: ""
      }
    },
    rates: SBW.defaultRates(),
    factors: SBW.defaultFactors(),
    staffing: SBW.defaultStaffing(),
    rateCards: [],
    requests: [],
    formulaOverrides: {},
    bidHelper: {
      step: 0,
      answers: {},
      ballpark: null
    }
  };
};
