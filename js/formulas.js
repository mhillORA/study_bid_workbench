window.SBW = window.SBW || {};

/**
 * Editable formula library.
 * Expressions use `d` = study.drivers and simple helpers.
 * Edit these later in the Formulas page or replace with Cosmos-stored rules.
 */
SBW.formulaLibrary = {
  "drivers.totalDuration": {
    id: "drivers.totalDuration",
    label: "Total duration (months)",
    department: "Overview",
    expression: "d.startupMonths + d.enrollmentMonths + d.treatmentMonths + d.dblMonths + d.closeoutMonths"
  },
  "drivers.enrollmentRate": {
    id: "drivers.enrollmentRate",
    label: "Enrollment rate (subjects/site/month)",
    department: "Overview",
    expression: "d.coreSites > 0 ? d.enrolledSubjects / d.coreSites / d.enrollmentMonths : 0"
  },
  "recruitment.AA2.units": {
    id: "recruitment.AA2.units",
    label: "Recruiter training attendees",
    department: "Recruitment",
    expression: "a.recruiterTrainingAttendees"
  },
  "recruitment.AA3.units": {
    id: "recruitment.AA3.units",
    label: "First phone contact units",
    department: "Recruitment",
    expression: "d.screenedSubjects * 27.771"
  },
  "recruitment.AA4.units": {
    id: "recruitment.AA4.units",
    label: "Pre-screen call units",
    department: "Recruitment",
    expression: "d.enrolledSubjects * 1.914"
  },
  "summary.serviceFeesSubtotal": {
    id: "summary.serviceFeesSubtotal",
    label: "Service fees subtotal",
    department: "Summary",
    expression: "8387878.360625"
  },
  "summary.passThroughs": {
    id: "summary.passThroughs",
    label: "Pass-throughs",
    department: "Summary",
    expression: "1138075"
  },
  "summary.inflation": {
    id: "summary.inflation",
    label: "Inflation $",
    department: "Summary",
    expression: "summaryServiceFees() * d.inflationRate"
  },
  "summary.totalServiceFees": {
    id: "summary.totalServiceFees",
    label: "Total service fees",
    department: "Summary",
    expression: "summaryServiceFees() + d.contingency + (summaryServiceFees() * d.inflationRate) - d.discount"
  },
  "summary.grandTotal": {
    id: "summary.grandTotal",
    label: "Total study budget",
    department: "Summary",
    expression: "(summaryServiceFees() + d.contingency + (summaryServiceFees() * d.inflationRate) - d.discount) + 1138075"
  },
  "summary.costPerPatient": {
    id: "summary.costPerPatient",
    label: "Total fees / enrolled patient",
    department: "Summary",
    expression: "d.enrolledSubjects > 0 ? ((summaryServiceFees() + d.contingency + (summaryServiceFees() * d.inflationRate) - d.discount) + 1138075) / d.enrolledSubjects : 0"
  }
};

SBW.calc = {
  eval(expression, ctx) {
    const d = ctx.drivers;
    const a = ctx.assumptions || {};
    const summaryServiceFees = () => 8387878.360625;
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("d", "a", "summaryServiceFees", `return (${expression});`);
      return fn(d, a, summaryServiceFees);
    } catch (err) {
      console.warn("Formula error:", expression, err);
      return null;
    }
  },

  runAll(study) {
    const lib = { ...SBW.formulaLibrary, ...study.formulaOverrides };
    const out = {};
    const ctxBase = {
      drivers: study.drivers,
      assumptions: study.assumptions.recruitment
    };

    Object.keys(lib).forEach((key) => {
      const item = lib[key];
      const deptAssumptions =
        item.department === "Recruitment" ? study.assumptions.recruitment :
        item.department === "Monitoring" ? study.assumptions.monitoring :
        item.department === "ClinOps" ? study.assumptions.clinops :
        item.department === "SMO" ? study.assumptions.smo :
        study.assumptions.recruitment;

      out[key] = this.eval(item.expression, {
        drivers: study.drivers,
        assumptions: deptAssumptions
      });
    });

    // unused but keeps ctxBase referenced for future expansion
    void ctxBase;
    return out;
  }
};
