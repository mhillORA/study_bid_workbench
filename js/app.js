(() => {
  const STORAGE_KEY = "sbw.study.v1";
  const USER_KEY = "sbw.user.v1";

  const state = {
    userId: localStorage.getItem(USER_KEY) || "u-analyst",
    sectionId: "hub",
    study: loadStudy(),
    dirty: false,
    results: {}
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
    if (n == null || Number.isNaN(n)) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0
    }).format(n);
  }

  function num(n, digits = 2) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });
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
  }

  function canEdit(department) {
    if (!department) return true;
    const user = currentUser();
    if (user.department === "Analyst" || user.department === "TAH") return true;
    return user.department === department;
  }

  function statusLabel(s) {
    return (s || "not_started").replaceAll("_", " ");
  }

  function renderNav() {
    els.sectionNav.innerHTML = SBW.sections.map((s) => {
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

  function renderUpload() {
    const locked = !canEdit("Analyst");
    const dis = locked ? "disabled" : "";
    return `
      <div class="grid">
        <div class="card wide">
          <h3>Upload budgets into Cosmos</h3>
          <p class="muted">
            Drop one <code>.xlsx</code>, many files, or a <code>.zip</code> of active studies.
            The API parses, normalizes, and loads into <strong>bd-budgets</strong>.
            Aliases + filename opportunity IDs (<code>O-#####</code>) are applied automatically.
          </p>
          <div class="form-grid" style="margin-top:1rem;">
            <div class="full">
              <label class="field-label">Files</label>
              <input id="uploadInput" class="input" type="file" accept=".xlsx,.zip" multiple ${dis} />
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
            <button type="button" class="btn btn-secondary" id="btnCheckApi">Check API</button>
            <span class="muted" id="uploadStatus">Ready — posts to /api/import</span>
          </div>
        </div>
        <div class="card wide">
          <h3>Last import report</h3>
          <pre class="formula-box" id="uploadReport">No upload yet.</pre>
        </div>
        <div class="card wide">
          <h3>How others use this</h3>
          <ol class="list">
            <li>You host the app (Azure Static Web App) + import API.</li>
            <li>Cosmos key stays in Azure App Settings — never in the browser.</li>
            <li>Analysts open Upload, pick the zip/files, click Start.</li>
            <li>Report shows loaded / quarantined / failed per file.</li>
            <li>See <strong>Studies (Cosmos)</strong> for what landed.</li>
          </ol>
        </div>
      </div>`;
  }

  function renderStudies(loadingHtml) {
    return `
      <div class="grid">
        <div class="card wide">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
            <div>
              <h3>Studies in Cosmos</h3>
              <p class="muted">From <code>GET /api/studies</code> · database <strong>bd-budgets</strong></p>
            </div>
            <button type="button" class="btn btn-secondary" id="btnRefreshStudies">Refresh</button>
          </div>
          <div id="studiesPanel" style="margin-top:1rem;">${loadingHtml || "<p class=\"muted\">Loading…</p>"}</div>
        </div>
      </div>`;
  }

  async function checkApiHealth() {
    const status = document.getElementById("uploadStatus");
    const report = document.getElementById("uploadReport");
    if (status) status.textContent = "Checking /api/health…";
    try {
      const res = await fetch(apiUrl("/api/health"));
      const data = await res.json().catch(() => ({}));
      if (status) status.textContent = res.ok ? "API online" : `API error (${res.status})`;
      if (report) report.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      if (status) status.textContent = "API not reachable";
      if (report) report.textContent = String(err);
    }
  }

  async function startUpload() {
    const input = document.getElementById("uploadInput");
    const mode = document.getElementById("uploadMode");
    const status = document.getElementById("uploadStatus");
    const report = document.getElementById("uploadReport");
    if (!input || !input.files || !input.files.length) {
      status.textContent = "Choose at least one .xlsx or .zip file.";
      return;
    }
    const fd = new FormData();
    [...input.files].forEach((f) => fd.append("files", f, f.name));
    fd.append("mode", mode ? mode.value : "load");
    fd.append("requestedBy", state.userId);

    status.textContent = "Uploading…";
    report.textContent = "Working…";
    try {
      const res = await fetch(apiUrl("/api/import"), { method: "POST", body: fd });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
      if (!res.ok) {
        status.textContent = `Failed (${res.status})`;
        report.textContent = JSON.stringify(data, null, 2);
        return;
      }
      const c = data.counts || {};
      status.textContent = `Done — loaded ${c.loaded || 0}, quarantined ${c.quarantined || 0}, failed ${c.failed || 0}`;
      report.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      status.textContent = "API not reachable";
      report.textContent = [
        "Could not reach /api/import.",
        "Confirm the SWA API is deployed and Cosmos App Settings are set.",
        "",
        String(err)
      ].join("\n");
    }
  }

  async function loadStudiesIntoPanel() {
    const panel = document.getElementById("studiesPanel");
    if (!panel) return;
    panel.innerHTML = "<p class=\"muted\">Loading…</p>";
    try {
      const res = await fetch(apiUrl("/api/studies"));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        panel.innerHTML = `<pre class="formula-box">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
        return;
      }
      const studies = data.studies || [];
      if (!studies.length) {
        panel.innerHTML = "<p class=\"muted\">No studies yet. Use Upload budgets to load workbooks.</p>";
        return;
      }
      panel.innerHTML = `
        <table class="table">
          <thead>
            <tr><th>Study</th><th>Client</th><th>Title</th><th>Phase</th><th>Status</th><th>Updated</th></tr>
          </thead>
          <tbody>
            ${studies.map((s) => `<tr>
              <td><code>${escapeHtml(s.studyId || "")}</code></td>
              <td>${escapeHtml(s.clientName || "—")}</td>
              <td>${escapeHtml(s.title || "—")}</td>
              <td>${escapeHtml(s.phase || "—")}</td>
              <td>${escapeHtml(s.status || "—")}</td>
              <td class="muted">${escapeHtml((s.updatedAt || s.importedAt || "").slice(0, 19).replace("T", " "))}</td>
            </tr>`).join("")}
          </tbody>
        </table>`;
    } catch (err) {
      panel.innerHTML = `<p class="muted">Could not reach /api/studies.</p><pre class="formula-box">${escapeHtml(String(err))}</pre>`;
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
        <div class="card">
          <h3>Service fees</h3>
          <div class="stat">${money(state.results["summary.totalServiceFees"])}</div>
          <p class="muted">Includes contingency + inflation (demo formulas)</p>
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
    const d = state.study.drivers;
    const locked = !canEdit("Analyst");
    const dis = locked ? "disabled" : "";
    return `
      <div class="grid">
        <div class="card half">
          <h3>Study identity</h3>
          <div class="form-grid">
            <div><label class="field-label">Client</label><input class="input" data-study="clientName" value="${escapeAttr(state.study.clientName)}" ${dis} /></div>
            <div><label class="field-label">Opportunity</label><input class="input" data-study="studyId" value="${escapeAttr(state.study.studyId)}" ${dis} /></div>
            <div class="full"><label class="field-label">Title</label><input class="input" data-study="title" value="${escapeAttr(state.study.title)}" ${dis} /></div>
            <div><label class="field-label">Protocol</label><input class="input" data-study="protocol" value="${escapeAttr(state.study.protocol)}" ${dis} /></div>
            <div><label class="field-label">Version</label><input class="input" data-study="versionLabel" value="${escapeAttr(state.study.versionLabel)}" ${dis} /></div>
          </div>
        </div>
        <div class="card half">
          <h3>Computed</h3>
          <p><strong>Total duration:</strong> ${num(state.results["drivers.totalDuration"], 2)} months</p>
          <p><strong>Enrollment rate:</strong> ${num(state.results["drivers.enrollmentRate"], 3)} subjects/site/month</p>
          <p class="muted">Driven by formula library — editable on Formulas page.</p>
        </div>
        <div class="card wide">
          <h3>Core drivers</h3>
          <div class="form-grid">
            ${driverField("screenedSubjects", "Screened subjects", d.screenedSubjects, dis)}
            ${driverField("enrolledSubjects", "Enrolled subjects", d.enrolledSubjects, dis)}
            ${driverField("completedSubjects", "Completed subjects", d.completedSubjects, dis)}
            ${driverField("coreSites", "Core sites", d.coreSites, dis)}
            ${driverField("startupMonths", "Startup months", d.startupMonths, dis)}
            ${driverField("enrollmentMonths", "Enrollment months", d.enrollmentMonths, dis)}
            ${driverField("treatmentMonths", "Treatment months", d.treatmentMonths, dis)}
            ${driverField("contingency", "Contingency $", d.contingency, dis)}
          </div>
          <div style="margin-top:1rem;display:flex;gap:0.5rem;">
            <button type="button" class="btn btn-secondary" data-status-section="overview" data-status="ready_for_review" ${dis}>Mark ready for review</button>
          </div>
        </div>
      </div>`;
  }

  function driverField(key, label, value, dis) {
    return `<div>
      <label class="field-label">${label}</label>
      <input class="input" type="number" step="any" data-driver="${key}" value="${value}" ${dis} />
    </div>`;
  }

  function renderRecruitment() {
    const a = state.study.assumptions.recruitment;
    const locked = !canEdit("Recruitment");
    const dis = locked ? "disabled" : "";
    return `
      <div class="grid">
        <div class="card half">
          <h3>Recruitment assumptions</h3>
          <div class="form-grid">
            <div><label class="field-label">Contact center</label>
              <select class="select" data-assumption="recruitment.contactCenterOn" ${dis}>
                <option value="true" ${a.contactCenterOn ? "selected" : ""}>On</option>
                <option value="false" ${!a.contactCenterOn ? "selected" : ""}>Off</option>
              </select>
            </div>
            <div><label class="field-label">Advertising</label>
              <select class="select" data-assumption="recruitment.advertisingOn" ${dis}>
                <option value="true" ${a.advertisingOn ? "selected" : ""}>On</option>
                <option value="false" ${!a.advertisingOn ? "selected" : ""}>Off</option>
              </select>
            </div>
            <div><label class="field-label">Training attendees</label>
              <input class="input" type="number" data-assumption="recruitment.recruiterTrainingAttendees" value="${a.recruiterTrainingAttendees}" ${dis} />
            </div>
            <div class="full"><label class="field-label">Notes</label>
              <textarea class="textarea" rows="4" data-assumption="recruitment.notes" ${dis}>${escapeHtml(a.notes)}</textarea>
            </div>
          </div>
          <div style="margin-top:1rem;">
            <button type="button" class="btn btn-secondary" data-status-section="recruitment" data-status="ready_for_review" ${dis}>Mark ready for review</button>
          </div>
        </div>
        <div class="card half">
          <h3>Calculated line drivers</h3>
          <table class="table">
            <thead><tr><th>Code</th><th>Units</th></tr></thead>
            <tbody>
              <tr><td>AA2 training</td><td>${num(state.results["recruitment.AA2.units"], 0)}</td></tr>
              <tr><td>AA3 first contact</td><td>${num(state.results["recruitment.AA3.units"], 0)}</td></tr>
              <tr><td>AA4 pre-screen</td><td>${num(state.results["recruitment.AA4.units"], 0)}</td></tr>
            </tbody>
          </table>
          <p class="muted">Units come from editable formulas, not a spreadsheet grid.</p>
        </div>
      </div>`;
  }

  function renderDeptSimple(sectionId, assumptionKey, title) {
    const a = state.study.assumptions[assumptionKey];
    const section = SBW.sections.find((s) => s.id === sectionId);
    const locked = !canEdit(section.department);
    const dis = locked ? "disabled" : "";
    const extra = Object.keys(a)
      .filter((k) => k !== "notes")
      .map((k) => {
        const val = a[k];
        if (typeof val === "boolean") {
          return `<div><label class="field-label">${k}</label>
            <select class="select" data-assumption="${assumptionKey}.${k}" ${dis}>
              <option value="true" ${val ? "selected" : ""}>Yes / On</option>
              <option value="false" ${!val ? "selected" : ""}>No / Off</option>
            </select></div>`;
        }
        return `<div><label class="field-label">${k}</label>
          <input class="input" data-assumption="${assumptionKey}.${k}" value="${escapeAttr(String(val))}" ${dis} /></div>`;
      }).join("");

    return `
      <div class="grid">
        <div class="card wide">
          <h3>${title}</h3>
          <div class="form-grid">
            ${extra}
            <div class="full"><label class="field-label">Notes</label>
              <textarea class="textarea" rows="4" data-assumption="${assumptionKey}.notes" ${dis}>${escapeHtml(a.notes || "")}</textarea>
            </div>
          </div>
          <div style="margin-top:1rem;">
            <button type="button" class="btn btn-secondary" data-status-section="${sectionId}" data-status="ready_for_review" ${dis}>Mark ready for review</button>
          </div>
        </div>
      </div>`;
  }

  function renderSummary() {
    return `
      <div class="grid">
        <div class="card"><h3>Service fees subtotal</h3><div class="stat">${money(state.results["summary.serviceFeesSubtotal"])}</div></div>
        <div class="card"><h3>Inflation</h3><div class="stat">${money(state.results["summary.inflation"])}</div></div>
        <div class="card"><h3>Total service fees</h3><div class="stat">${money(state.results["summary.totalServiceFees"])}</div></div>
        <div class="card half"><h3>Pass-throughs</h3><div class="stat">${money(state.results["summary.passThroughs"])}</div></div>
        <div class="card half"><h3>Grand total</h3><div class="stat">${money(state.results["summary.grandTotal"])}</div></div>
        <div class="card wide">
          <h3>Export</h3>
          <p class="muted">This working model exports JSON. Excel/PDF exporters plug in here next.</p>
          <button type="button" class="btn btn-primary" id="btnExportInline">Download study JSON</button>
        </div>
      </div>`;
  }

  function renderReviews() {
    const rows = state.study.requests.map((r) => {
      const user = SBW.users.find((u) => u.id === r.assigneeId);
      const by = SBW.users.find((u) => u.id === r.requestedBy);
      return `<tr>
        <td>${r.department}</td>
        <td>${user ? user.name : r.assigneeId}</td>
        <td>${by ? by.name : r.requestedBy}</td>
        <td>${escapeHtml(r.note)}</td>
        <td><span class="badge ${r.status === "completed" ? "approved" : "in_progress"}">${r.status}</span></td>
      </tr>`;
    }).join("") || `<tr><td colspan="5">No requests yet.</td></tr>`;

    return `
      <div class="grid">
        <div class="card wide">
          <h3>Fill / review requests</h3>
          <table class="table">
            <thead><tr><th>Dept</th><th>Assignee</th><th>Requested by</th><th>Note</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
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
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replaceAll('"', "&quot;");
  }

  function render() {
    recalc();
    const user = currentUser();
    const section = SBW.sections.find((s) => s.id === state.sectionId) || SBW.sections[0];

    els.studyMeta.textContent = `${state.study.studyId} · ${state.study.clientName} · ${state.study.versionLabel}`;
    els.pageTitle.textContent = section.label;
    els.pageSubtitle.textContent = section.department
      ? `Editable by ${section.department}${canEdit(section.department) ? "" : " (view only for you)"}`
      : "Shared study workspace";

    renderNav();

    let html = "";
    switch (section.id) {
      case "hub": html = renderHub(); break;
      case "upload": html = renderUpload(); break;
      case "studies": html = renderStudies(); break;
      case "overview": html = renderOverview(); break;
      case "recruitment": html = renderRecruitment(); break;
      case "clinops": html = renderDeptSimple("clinops", "clinops", "ClinOps / SOE assumptions"); break;
      case "monitoring": html = renderDeptSimple("monitoring", "monitoring", "Monitoring assumptions"); break;
      case "smo": html = renderDeptSimple("smo", "smo", "SMO / block enrollment"); break;
      case "summary": html = renderSummary(); break;
      case "reviews": html = renderReviews(); break;
      case "formulas": html = renderFormulas(); break;
      default: html = renderHub();
    }
    els.viewRoot.innerHTML = html;
    if (section.id === "studies") {
      loadStudiesIntoPanel();
    }
  }

  function bind() {
    els.userSelect.innerHTML = SBW.users.map(
      (u) => `<option value="${u.id}" ${u.id === state.userId ? "selected" : ""}>${u.name}</option>`
    ).join("");

    const depts = [...new Set(SBW.sections.filter((s) => s.department).map((s) => s.department))];
    els.requestDept.innerHTML = depts.map((d) => `<option value="${d}">${d}</option>`).join("");
    els.requestUser.innerHTML = SBW.users.map((u) => `<option value="${u.id}">${u.name}</option>`).join("");

    els.userSelect.addEventListener("change", () => {
      state.userId = els.userSelect.value;
      localStorage.setItem(USER_KEY, state.userId);
      const user = currentUser();
      const home = SBW.sections.find((s) => s.department === user.department);
      if (home) state.sectionId = home.id;
      else state.sectionId = "hub";
      render();
    });

    els.sectionNav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-section]");
      if (!btn) return;
      setSection(btn.dataset.section);
    });

    els.viewRoot.addEventListener("click", (e) => {
      const jump = e.target.closest("[data-jump]");
      if (jump) {
        setSection(jump.dataset.jump);
        return;
      }
      const statusBtn = e.target.closest("[data-status-section]");
      if (statusBtn) {
        state.study.sectionStatus[statusBtn.dataset.statusSection] = statusBtn.dataset.status;
        markDirty();
        render();
        return;
      }
      if (e.target.id === "btnExportInline") {
        exportJson();
      }
      if (e.target.id === "btnStartUpload") {
        startUpload();
      }
      if (e.target.id === "btnCheckApi") {
        checkApiHealth();
      }
      if (e.target.id === "btnRefreshStudies") {
        loadStudiesIntoPanel();
      }
    });

    els.viewRoot.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.driver) {
        state.study.drivers[t.dataset.driver] = Number(t.value);
        markDirty();
        recalc();
        return;
      }
      if (t.dataset.study) {
        state.study[t.dataset.study] = t.value;
        markDirty();
        return;
      }
      if (t.dataset.assumption) {
        const [group, key] = t.dataset.assumption.split(".");
        let val = t.value;
        if (val === "true") val = true;
        else if (val === "false") val = false;
        else if (t.type === "number") val = Number(val);
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

  // Land user on their department page on first load
  const user = currentUser();
  const home = SBW.sections.find((s) => s.department === user.department);
  if (home) state.sectionId = home.id;

  bind();
  render();
  markSaved();
})();
