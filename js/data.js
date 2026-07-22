window.SBW = window.SBW || {};

SBW.users = [
  { id: "u-analyst", name: "Louise (BDO / Analyst)", department: "Analyst" },
  { id: "u-recruit", name: "Alex Rivera (Recruitment)", department: "Recruitment" },
  { id: "u-clinops", name: "Caitlin Pearson (ClinOps)", department: "ClinOps" },
  { id: "u-monitor", name: "Laura Lazzari (Monitoring)", department: "Monitoring" },
  { id: "u-smo", name: "Tom Reese (SMO)", department: "SMO" },
  { id: "u-tah", name: "Paul Gomes (TAH)", department: "TAH" }
];

SBW.sections = [
  { id: "hub", label: "Hub", department: null },
  { id: "studies", label: "Studies (Cosmos)", department: null },
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

/** Set after Static Web App / API is deployed. Empty = same origin /api */
SBW.apiBase = "";

SBW.defaultStudy = function () {
  return {
    studyId: "O-06087",
    clientName: "Regeneron",
    title: "CAT Allergy Global Expansion",
    protocol: "Ph3 - Cat - US Only",
    versionLabel: "V3",
    phase: "3",
    therapeuticArea: "Allergy",
    indication: "Cat Allergy",
    enrollmentType: "Block Enrollment",
    budgetType: "Ballpark Budget",
    drivers: {
      screenedSubjects: 1000,
      enrolledSubjects: 570,
      completedSubjects: 542,
      coreSites: 55,
      startupMonths: 1.85,
      enrollmentMonths: 15,
      treatmentMonths: 5,
      dblMonths: 1,
      closeoutMonths: 9,
      screenFailRate: 0.43,
      dropOutRate: 0.05,
      sdvPercent: 1,
      contingency: 150000,
      inflationRate: 0.02915,
      discount: 0
    },
    sectionStatus: {
      overview: "in_progress",
      recruitment: "not_started",
      clinops: "not_started",
      monitoring: "not_started",
      smo: "ready_for_review",
      summary: "not_started",
      formulas: "in_progress"
    },
    assumptions: {
      recruitment: {
        contactCenterOn: true,
        advertisingOn: false,
        materialsOn: true,
        recruiterTrainingAttendees: 15,
        notes: "SMO support focus. Media buying off for this scenario."
      },
      monitoring: {
        strategy: "Traditional",
        rbqmFrequency: "monthly",
        maskedTeams: false,
        notes: ""
      },
      clinops: {
        soeSource: "Sponsor SOE",
        patientPopulation: "Adult and Pediatric",
        notes: "V3: +20 paediatric patients per Regeneron."
      },
      smo: {
        blockEnrollmentOn: true,
        fixedSitePtComp: false,
        notes: "Efficiencies added per SMO team on V3."
      }
    },
    requests: [
      {
        id: "req-1",
        department: "SMO",
        assigneeId: "u-smo",
        requestedBy: "u-analyst",
        note: "Confirm block enrollment efficiencies for US-only 55 sites.",
        status: "completed",
        createdAt: "2026-03-16T14:00:00.000Z"
      }
    ],
    formulaOverrides: {}
  };
};
