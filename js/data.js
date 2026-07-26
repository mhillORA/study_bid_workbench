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
  { id: "ops", label: "Ops Dashboard", department: null },
  { id: "studies", label: "Studies", department: null },
  { id: "versions", label: "Versions / Diff", department: null },
  { id: "intelligence", label: "Ora Clinical Intelligence", department: null },
  { id: "overview", label: "Overview / Inputs", department: "Analyst" },
  { id: "recruitment", label: "Recruitment", department: "Recruitment" },
  { id: "clinops", label: "ClinOps / SOE", department: "ClinOps" },
  { id: "monitoring", label: "Clinical Monitoring", department: "Monitoring" },
  { id: "smo", label: "Block Enrollment / SMO", department: "SMO" },
  { id: "summary", label: "Exec Summary", department: null },
  { id: "reviews", label: "Reviews", department: null },
  { id: "formulas", label: "Formulas", department: "Analyst" },
  { id: "upload", label: "Upload budgets", department: "Analyst" },
  { id: "scorecard", label: "Site Scorecard", department: null }
];

/** Hub shortcuts — BD/sales, leadership, and ops. */
SBW.bdShortcuts = [
  {
    id: "intelligence",
    title: "Indication benchmark",
    blurb: "Ora vs industry PSM — for proposals and RFIs"
  },
  {
    id: "scorecard",
    title: "Site Scorecard",
    blurb: "Rank sites and build a recommended slate"
  },
  {
    id: "ops",
    title: "Ops Dashboard",
    blurb: "Workflow status, portfolio pulse, data health"
  },
  {
    id: "studies",
    title: "Past bids",
    blurb: "Open prior studies / fee history"
  }
];

/** Prefill Ask Buddy from Hub (BD pitch, leadership, ops). */
SBW.buddyQuickAsks = [
  {
    id: "pitch",
    label: "Draft pitch points",
    prompt:
      "For Dry Eye in the US, give me 3 short talking points comparing Ora median enrollment speed vs industry, plus geography and competitive recruiting. Proposal-ready."
  },
  {
    id: "leadership",
    label: "Leadership snapshot",
    prompt:
      "Give me a leadership snapshot of our uploaded bid portfolio: study count, average enrolled subjects, top clients by count, and which studies have the highest budgets. Headline numbers first."
  },
  {
    id: "ops",
    label: "Ops briefing",
    prompt:
      "Ops briefing for the open study if one is selected: which departments are not started, in progress, ready for review, or approved; any open fill requests; key drivers (enrolled, sites, months). If no study is open, summarize portfolio study count and what I should check next on Reviews or Upload."
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
    sectionStatus: {
      overview: "not_started",
      recruitment: "not_started",
      clinops: "not_started",
      monitoring: "not_started",
      smo: "not_started",
      summary: "not_started",
      formulas: "not_started"
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
