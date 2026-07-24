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
  { id: "studies", label: "Studies", department: null },
  { id: "versions", label: "Versions / Diff", department: null },
  { id: "overview", label: "Overview / Inputs", department: "Analyst" },
  { id: "recruitment", label: "Recruitment", department: "Recruitment" },
  { id: "clinops", label: "ClinOps / SOE", department: "ClinOps" },
  { id: "monitoring", label: "Clinical Monitoring", department: "Monitoring" },
  { id: "smo", label: "Block Enrollment / SMO", department: "SMO" },
  { id: "summary", label: "Exec Summary", department: null },
  { id: "reviews", label: "Reviews", department: null },
  { id: "formulas", label: "Formulas", department: "Analyst" },
  { id: "upload", label: "Upload budgets", department: "Analyst" }
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
