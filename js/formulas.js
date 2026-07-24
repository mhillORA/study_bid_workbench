window.SBW = window.SBW || {};

/**
 * Default billable hourly rates (USD). Overridden by Key sheet rateCards when a study is opened.
 * Formulas page edits these; expressions stay hidden and reference rates.* / factors.* / staffing.*
 */
SBW.defaultRates = function () {
  return {
    recruiter: 155,
    cra: 175,
    seniorCra: 195,
    projectManager: 210,
    clinicalLead: 225,
    dataManager: 165,
    biostatistician: 220,
    medicalMonitor: 280,
    smoCoordinator: 140
  };
};

/** Multipliers / hours-per-unit factors used inside hidden formulas. */
SBW.defaultFactors = function () {
  return {
    aa3HoursPerScreen: 27.771,
    aa4HoursPerEnrolled: 1.914,
    recruiterTrainingHours: 4,
    craHoursPerPatientVisit: 0.5,
    pmHoursPerMonth: 20,
    monitoringVisitHours: 8
  };
};

/** Headcounts selected on study pages (Overview staffing). */
SBW.defaultStaffing = function () {
  return {
    recruiters: 1,
    cra: 2,
    seniorCra: 0,
    projectManager: 1,
    clinicalLead: 1,
    dataManager: 1,
    biostatistician: 0,
    medicalMonitor: 1,
    smoCoordinator: 0
  };
};

/**
 * Formula library.
 * Expressions use: d=drivers, a=dept assumptions, rates, factors, staffing, file=Exec Sum helpers.
 * UI shows rate/factor knobs — not the expression text.
 */
SBW.formulaLibrary = {
  "drivers.totalDuration": {
    id: "drivers.totalDuration",
    label: "Total duration (months)",
    department: "Overview",
    expression:
      "(Number(d.startupMonths)||0)+(Number(d.enrollmentMonths)||0)+(Number(d.treatmentMonths)||0)+(Number(d.dblMonths)||0)+(Number(d.closeoutMonths)||0)",
    ui: { kind: "computed" }
  },
  "drivers.enrollmentRate": {
    id: "drivers.enrollmentRate",
    label: "Enrollment rate (subjects/site/month)",
    department: "Overview",
    expression:
      "(Number(d.coreSites)>0 && Number(d.enrollmentMonths)>0) ? (Number(d.enrolledSubjects)||0)/(Number(d.coreSites))/(Number(d.enrollmentMonths)) : 0",
    ui: { kind: "computed" }
  },
  "recruitment.AA2.units": {
    id: "recruitment.AA2.units",
    label: "Recruiter training attendees",
    department: "Recruitment",
    expression: "Number(a.recruiterTrainingAttendees)||0",
    ui: { kind: "computed" }
  },
  "recruitment.AA3.units": {
    id: "recruitment.AA3.units",
    label: "First phone contact units",
    department: "Recruitment",
    expression: "(Number(d.screenedSubjects)||0) * (Number(factors.aa3HoursPerScreen)||0)",
    ui: { kind: "factor", factorKey: "aa3HoursPerScreen", factorLabel: "Hours per screened subject" }
  },
  "recruitment.AA3.charge": {
    id: "recruitment.AA3.charge",
    label: "First phone contact charge",
    department: "Recruitment",
    expression:
      "(Number(rates.recruiter)||0) * (Number(factors.aa3HoursPerScreen)||0) * (Number(d.screenedSubjects)||0) * (Number(staffing.recruiters)||1)",
    ui: {
      kind: "rate_staff_factor",
      rateKey: "recruiter",
      rateLabel: "Recruiter hourly rate",
      factorKey: "aa3HoursPerScreen",
      factorLabel: "Hours per screened",
      staffKey: "recruiters",
      staffLabel: "Recruiters (staffing)"
    }
  },
  "recruitment.AA4.units": {
    id: "recruitment.AA4.units",
    label: "Pre-screen call units",
    department: "Recruitment",
    expression: "(Number(d.enrolledSubjects)||0) * (Number(factors.aa4HoursPerEnrolled)||0)",
    ui: { kind: "factor", factorKey: "aa4HoursPerEnrolled", factorLabel: "Hours per enrolled subject" }
  },
  "recruitment.AA4.charge": {
    id: "recruitment.AA4.charge",
    label: "Pre-screen call charge",
    department: "Recruitment",
    expression:
      "(Number(rates.recruiter)||0) * (Number(factors.aa4HoursPerEnrolled)||0) * (Number(d.enrolledSubjects)||0) * (Number(staffing.recruiters)||1)",
    ui: {
      kind: "rate_staff_factor",
      rateKey: "recruiter",
      rateLabel: "Recruiter hourly rate",
      factorKey: "aa4HoursPerEnrolled",
      factorLabel: "Hours per enrolled",
      staffKey: "recruiters",
      staffLabel: "Recruiters (staffing)"
    }
  },
  "monitoring.cra.charge": {
    id: "monitoring.cra.charge",
    label: "CRA monitoring effort (ballpark)",
    department: "Monitoring",
    expression:
      "(Number(rates.cra)||0) * (Number(factors.craHoursPerPatientVisit)||0) * (Number(d.enrolledSubjects)||0) * (Number(staffing.cra)||1)",
    ui: {
      kind: "rate_staff_factor",
      rateKey: "cra",
      rateLabel: "CRA hourly rate",
      factorKey: "craHoursPerPatientVisit",
      factorLabel: "Hours per patient (visit effort)",
      staffKey: "cra",
      staffLabel: "CRAs (staffing)"
    }
  },
  "clinops.pm.charge": {
    id: "clinops.pm.charge",
    label: "PM effort (ballpark)",
    department: "ClinOps",
    expression:
      "(Number(rates.projectManager)||0) * (Number(factors.pmHoursPerMonth)||0) * ((Number(d.startupMonths)||0)+(Number(d.enrollmentMonths)||0)+(Number(d.treatmentMonths)||0)+(Number(d.closeoutMonths)||0)) * (Number(staffing.projectManager)||1)",
    ui: {
      kind: "rate_staff_factor",
      rateKey: "projectManager",
      rateLabel: "PM hourly rate",
      factorKey: "pmHoursPerMonth",
      factorLabel: "PM hours per study month",
      staffKey: "projectManager",
      staffLabel: "PMs (staffing)"
    }
  },
  "summary.serviceFeesSubtotal": {
    id: "summary.serviceFeesSubtotal",
    label: "Service fees subtotal",
    department: "Summary",
    expression: "fileServiceFees()",
    ui: { kind: "file_or_computed", fileHint: "Uses Exec Sum “Total Service Fees” / subtotal when present" }
  },
  "summary.passThroughs": {
    id: "summary.passThroughs",
    label: "Pass-throughs",
    department: "Summary",
    expression: "filePassThroughs()",
    ui: { kind: "file_or_computed", fileHint: "Uses Exec Sum pass-through total when present" }
  },
  "summary.inflation": {
    id: "summary.inflation",
    label: "Inflation $",
    department: "Summary",
    expression: "fileServiceFees() * (Number(d.inflationRate)||0)",
    ui: { kind: "computed" }
  },
  "summary.totalServiceFees": {
    id: "summary.totalServiceFees",
    label: "Total service fees",
    department: "Summary",
    expression:
      "fileTotalServiceFees() != null ? fileTotalServiceFees() : (fileServiceFees() + (Number(d.contingency)||0) + (fileServiceFees()*(Number(d.inflationRate)||0)) - (Number(d.discount)||0))",
    ui: { kind: "file_or_computed", fileHint: "Prefers Exec Sum Total Service Fees" }
  },
  "summary.grandTotal": {
    id: "summary.grandTotal",
    label: "Total study budget",
    department: "Summary",
    expression:
      "(fileTotalServiceFees() != null ? fileTotalServiceFees() : (fileServiceFees() + (Number(d.contingency)||0) + (fileServiceFees()*(Number(d.inflationRate)||0)) - (Number(d.discount)||0))) + filePassThroughs()",
    ui: { kind: "file_or_computed", fileHint: "Service fees + pass-throughs (file when present)" }
  },
  "summary.costPerPatient": {
    id: "summary.costPerPatient",
    label: "Total fees / enrolled patient",
    department: "Summary",
    expression:
      "(Number(d.enrolledSubjects)>0) ? (((fileTotalServiceFees() != null ? fileTotalServiceFees() : (fileServiceFees() + (Number(d.contingency)||0) + (fileServiceFees()*(Number(d.inflationRate)||0)) - (Number(d.discount)||0))) + filePassThroughs()) / Number(d.enrolledSubjects)) : 0",
    ui: { kind: "computed" }
  }
};

SBW.calc = {
  moneyFromTotals(totals, keys) {
    if (!totals || typeof totals !== "object") return null;
    for (const want of keys) {
      for (const [k, v] of Object.entries(totals)) {
        if (String(k).toLowerCase().trim() === want) {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        }
      }
    }
    for (const want of keys) {
      for (const [k, v] of Object.entries(totals)) {
        if (String(k).toLowerCase().includes(want)) {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        }
      }
    }
    return null;
  },

  eval(expression, ctx) {
    const d = ctx.drivers || {};
    const a = ctx.assumptions || {};
    const rates = ctx.rates || {};
    const factors = ctx.factors || {};
    const staffing = ctx.staffing || {};
    const totals = ctx.totals || {};

    const filePassThroughs = () => {
      const n =
        this.moneyFromTotals(totals, ["passthroughtotal"]) ??
        this.moneyFromTotals(totals, ["pass through"]);
      return n != null ? n : 0;
    };
    const fileTotalServiceFees = () =>
      this.moneyFromTotals(totals, ["total service fees"]);
    const fileSubtotalServiceFees = () =>
      this.moneyFromTotals(totals, ["subtotal service fees"]);
    const fileServiceFees = () => {
      const total = fileTotalServiceFees();
      if (total != null) return total;
      const sub = fileSubtotalServiceFees();
      if (sub != null) return sub;
      // Ballpark from role charges when no Exec Sum yet
      return (
        (Number(rates.recruiter) || 0) *
          (Number(factors.aa3HoursPerScreen) || 0) *
          (Number(d.screenedSubjects) || 0) *
          (Number(staffing.recruiters) || 1) +
        (Number(rates.recruiter) || 0) *
          (Number(factors.aa4HoursPerEnrolled) || 0) *
          (Number(d.enrolledSubjects) || 0) *
          (Number(staffing.recruiters) || 1) +
        (Number(rates.cra) || 0) *
          (Number(factors.craHoursPerPatientVisit) || 0) *
          (Number(d.enrolledSubjects) || 0) *
          (Number(staffing.cra) || 1) +
        (Number(rates.projectManager) || 0) *
          (Number(factors.pmHoursPerMonth) || 0) *
          ((Number(d.startupMonths) || 0) +
            (Number(d.enrollmentMonths) || 0) +
            (Number(d.treatmentMonths) || 0) +
            (Number(d.closeoutMonths) || 0)) *
          (Number(staffing.projectManager) || 1)
      );
    };

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        "d",
        "a",
        "rates",
        "factors",
        "staffing",
        "fileServiceFees",
        "filePassThroughs",
        "fileTotalServiceFees",
        `return (${expression});`
      );
      return fn(
        d,
        a,
        rates,
        factors,
        staffing,
        fileServiceFees,
        filePassThroughs,
        fileTotalServiceFees
      );
    } catch (err) {
      console.warn("Formula error:", expression, err);
      return null;
    }
  },

  runAll(study) {
    const lib = { ...SBW.formulaLibrary, ...(study && study.formulaOverrides) };
    const out = {};
    const rates = { ...SBW.defaultRates(), ...((study && study.rates) || {}) };
    const factors = { ...SBW.defaultFactors(), ...((study && study.factors) || {}) };
    const staffing = { ...SBW.defaultStaffing(), ...((study && study.staffing) || {}) };
    const assumptions = (study && study.assumptions) || {};

    Object.keys(lib).forEach((key) => {
      const item = lib[key];
      const deptAssumptions =
        item.department === "Recruitment"
          ? assumptions.recruitment || {}
          : item.department === "Monitoring"
            ? assumptions.monitoring || {}
            : item.department === "ClinOps"
              ? assumptions.clinops || {}
              : item.department === "SMO"
                ? assumptions.smo || {}
                : assumptions.recruitment || {};

      out[key] = this.eval(item.expression, {
        drivers: (study && study.drivers) || {},
        assumptions: deptAssumptions,
        rates,
        factors,
        staffing,
        totals: (study && study.totals) || {}
      });
    });

    return out;
  }
};
