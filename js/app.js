(() => {
  const STORAGE_KEY = "sbw.study.v1";
  const USER_KEY = "sbw.user.v1";

  const state = {
    userId: localStorage.getItem(USER_KEY) || "u-admin",
    sectionId: "hub",
    study: loadStudy(),
    dirty: false,
    results: {},
    askHistory: [],
    source: "local", // local | cosmos
    versions: [],
    lineItems: [],
    compare: null,
    compareStatus: ""
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

  function renderAsk() {
    const turns = state.askHistory
      .map((t) => {
        const who = t.role === "user" ? "You" : "Copilot";
        return `<div class="chat-turn ${t.role}"><div class="chat-who">${who}</div><div class="chat-body">${escapeHtml(t.content)}</div></div>`;
      })
      .join("");
    return `
      <div class="grid">
        <div class="card wide">
          <h3>Ask about this study</h3>
          <p class="muted">POC — Azure OpenAI (Copilot-style). Uses the working study here, plus Cosmos when loaded.</p>
          <div class="chat-log" id="askLog">${turns || "<p class=\"muted\">Try: “What are the enrollment drivers?” or “Summarize ClinOps assumptions.”</p>"}</div>
          <div class="ask-compose">
            <textarea id="askInput" class="textarea" rows="3" placeholder="Ask a question…"></textarea>
            <button type="button" class="btn btn-primary" id="btnAsk">Ask</button>
            <span class="muted" id="askStatus"></span>
          </div>
        </div>
      </div>`;
  }

  async function sendAsk() {
    const input = document.getElementById("askInput");
    const status = document.getElementById("askStatus");
    const question = (input && input.value || "").trim();
    if (!question) {
      if (status) status.textContent = "Type a question first.";
      return;
    }
    state.askHistory.push({ role: "user", content: question });
    if (input) input.value = "";
    if (status) status.textContent = "Thinking…";
    render();
    const statusAfter = document.getElementById("askStatus");
    try {
      const res = await fetch(apiUrl("/api/ask"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          studyId: state.study.studyId,
          studySnapshot: state.study,
          history: state.askHistory.slice(0, -1).map((t) => ({
            role: t.role,
            content: t.content
          }))
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        state.askHistory.push({
          role: "assistant",
          content: data.error || `Request failed (${res.status})`
        });
      } else {
        state.askHistory.push({ role: "assistant", content: data.answer || "(no answer)" });
      }
    } catch (err) {
      state.askHistory.push({
        role: "assistant",
        content: `Could not reach /api/ask. ${String(err)}`
      });
    }
    render();
    if (statusAfter) statusAfter.textContent = "";
  }

  function renderUpload() {
    const locked = !canEdit("Analyst");
    const dis = locked ? "disabled" : "";
    return `
      <div class="grid">
        <div class="card wide">
          <h3>Upload budgets into Cosmos</h3>
          <p class="muted">
            Drop one <code>.xlsx</code>, many files, or a <code>.zip</code>.
            Large zips are unzipped in the browser and uploaded <strong>one workbook at a time</strong>
            (avoids HTTP 413 payload limits).
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
          <h3>Quarantine queue</h3>
          <p class="muted">Files that parsed too weakly to promote into studies. Refresh to see Cosmos quarantine docs + reason buckets.</p>
          <div style="margin-top:0.75rem;display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary" id="btnRefreshQuarantine">Refresh quarantine</button>
            <span class="muted" id="quarantineStatus"></span>
          </div>
          <pre class="formula-box" id="quarantineReport" style="margin-top:0.75rem;">Click Refresh quarantine.</pre>
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
        preview: q.preview,
        createdAt: q.createdAt
      }));
      if (status) status.textContent = `${data.count || 0} in quarantine`;
      if (report) {
        report.textContent = JSON.stringify(
          {
            count: data.count,
            reasonBuckets: data.reasonBuckets,
            tip: "Re-upload after deploy — loosened quarantine auto-loads most files with a filename-based study id. Remaining quarantine = nearly empty parse.",
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

  async function expandUploadFiles(fileList) {
    const workbooks = [];
    for (const file of fileList) {
      const name = file.name || "upload";
      const lower = name.toLowerCase();
      if (lower.endsWith(".zip")) {
        if (typeof JSZip === "undefined") {
          throw new Error("JSZip failed to load — refresh the page and try again.");
        }
        const zip = await JSZip.loadAsync(file);
        const entries = Object.keys(zip.files);
        for (const entryName of entries) {
          const entry = zip.files[entryName];
          if (!entry || entry.dir) continue;
          const base = entryName.split("/").pop();
          if (!base || base.startsWith("~$")) continue;
          if (!base.toLowerCase().endsWith(".xlsx")) continue;
          const buf = await entry.async("blob");
          workbooks.push({ name: base, blob: buf });
        }
      } else if (lower.endsWith(".xlsx")) {
        workbooks.push({ name, blob: file });
      }
    }
    return workbooks;
  }

  async function postOneWorkbook(wb, mode) {
    const fd = new FormData();
    fd.append("files", wb.blob, wb.name);
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
        file: wb.name,
        error: data.error || data.raw || `HTTP ${res.status}`,
        data
      };
    }
    return { ok: true, status: res.status, file: wb.name, data };
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

    const mode = modeEl ? modeEl.value : "load";
    if (btn) btn.disabled = true;
    report.textContent = "Preparing…";
    setUploadProgress(0, "Reading files…");

    const aggregate = {
      mode,
      loaded: [],
      quarantined: [],
      failed: [],
      perFile: []
    };

    try {
      const workbooks = await expandUploadFiles([...input.files]);
      if (!workbooks.length) {
        status.textContent = "No .xlsx workbooks found.";
        report.textContent = "Zip/files contained no .xlsx budgets.";
        setUploadProgress(0, "Nothing to upload");
        return;
      }

      const total = workbooks.length;
      report.textContent = `Uploading ${total} workbook(s) one at a time…\n`;

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
            if (!d.loaded && !d.quarantined && !d.failed) {
              // unexpected shape — still count as ok payload
            }
          }
        } catch (err) {
          aggregate.failed.push({ file: wb.name, error: String(err) });
        }
        report.textContent = JSON.stringify(
          {
            progress: `${i + 1}/${total}`,
            counts: {
              loaded: aggregate.loaded.length,
              quarantined: aggregate.quarantined.length,
              failed: aggregate.failed.length
            },
            lastFile: wb.name
          },
          null,
          2
        );
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
          counts: {
            loaded: aggregate.loaded.length,
            quarantined: aggregate.quarantined.length,
            failed: aggregate.failed.length
          },
          meaning: {
            loaded: "Parsed OK and written to Cosmos studies/versions/lineItems",
            quarantined: "Parsed but needs review (or low confidence) — in quarantine container if Cosmos allowed the write",
            failed: "Exception (Cosmos firewall, bad/corrupt xlsx, unsupported layout, etc.)"
          },
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
      status.textContent = "Upload failed";
      setUploadProgress(0, "Failed");
      report.textContent = String(err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderStudies(loadingHtml) {
    const openId = state.source === "cosmos" ? state.study.studyId : "";
    return `
      <div class="grid">
        <div class="card wide">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
            <div>
              <h3>Studies in Cosmos</h3>
              <p class="muted">Open a study to swap into the workbench and edit it. Current: <strong>${escapeHtml(openId || "(local demo)")}</strong></p>
            </div>
            <button type="button" class="btn btn-secondary" id="btnRefreshStudies">Refresh</button>
          </div>
          <div id="studiesPanel" style="margin-top:1rem;">${loadingHtml || "<p class=\"muted\">Loading…</p>"}</div>
        </div>
      </div>`;
  }

  function cosmosStudyToWorkspace(payload) {
    const s = payload.study || {};
    const v = payload.version || {};
    const snap = v.snapshot || {};
    const base = SBW.defaultStudy();
    const drivers = { ...base.drivers, ...(s.drivers || {}), ...(snap.drivers || {}) };
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
      header: snap.header || s.header || {},
      inputFields: snap.inputFields || s.inputFields || [],
      sites: snap.sites || s.sites || [],
      resourceLeads: snap.resourceLeads || s.resourceLeads || [],
      monitoringInputs: snap.monitoring || s.monitoring || {},
      vendors: snap.vendors || s.vendors || [],
      payments: snap.payments || s.payments || {},
      totals: v.totals || {},
      execSum: v.execSum || {},
      currentVersionId: s.currentVersionId || v.id,
      viewingVersionId: v.id,
      sectionStatus: base.sectionStatus,
      assumptions: base.assumptions,
      requests: base.requests,
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
      const openId = state.source === "cosmos" ? state.study.studyId : "";
      panel.innerHTML = `
        <table class="table">
          <thead>
            <tr><th></th><th>Study</th><th>Client</th><th>Title</th><th>Phase</th><th>Status</th><th>Updated</th></tr>
          </thead>
          <tbody>
            ${studies.map((s) => {
              const active = s.studyId === openId;
              return `<tr class="${active ? "row-active" : ""}">
              <td><button type="button" class="btn btn-primary" data-open-study="${escapeAttr(s.studyId || "")}">${active ? "Opened" : "Open"}</button></td>
              <td><code>${escapeHtml(s.studyId || "")}</code></td>
              <td>${escapeHtml(s.clientName || "—")}</td>
              <td>${escapeHtml(s.title || "—")}</td>
              <td>${escapeHtml(s.phase || "—")}</td>
              <td>${escapeHtml(s.status || "—")}</td>
              <td class="muted">${escapeHtml((s.updatedAt || s.importedAt || "").slice(0, 19).replace("T", " "))}</td>
            </tr>`;
            }).join("")}
          </tbody>
        </table>`;
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
            · ${state.source === "cosmos" ? "Cosmos" : "Local demo"} · ${versions.length} version(s)</p>
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
      const fakePayload = {
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
      state.study = cosmosStudyToWorkspace(fakePayload);
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
          <p><strong>Service fees (demo):</strong> ${money(state.results["summary.totalServiceFees"])}</p>
          <p><strong>Grand total (demo):</strong> ${money(state.results["summary.grandTotal"])}</p>
          <p class="muted">${fields.length} Input Tab fields · ${sites.length} sites · ${state.lineItems.length} line items in memory</p>
          ${!fields.length ? "<p class=\"muted\">Open a Cosmos study (after upload) to populate every captured Input Tab cell.</p>" : ""}
        </div>

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
        <div class="card wide">
          <h3>Recruitment line items (from Cosmos version)</h3>
          ${lineItemsForDept("Recruitment")}
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
        <div class="card wide">
          <h3>${escapeHtml(section.department || "")} line items</h3>
          ${lineItemsForDept(section.department)}
        </div>
      </div>`;
  }

  function renderSummary() {
    const totals = state.study.totals || {};
    const execAreas = (state.study.execSum && state.study.execSum.serviceAreas) || [];
    const totalRows = Object.entries(totals).map(([k, v]) =>
      `<tr><td>${escapeHtml(k)}</td><td>${typeof v === "number" ? money(v) : escapeHtml(String(v))}</td></tr>`
    ).join("") || `<tr><td colspan="2" class="muted">No Exec Sum totals on this study yet.</td></tr>`;
    const areaRows = execAreas.map((a) =>
      `<tr><td>${escapeHtml(a.name || "")}</td><td>${money(a.serviceFees)}</td></tr>`
    ).join("");

    return `
      <div class="grid">
        <div class="card"><h3>Service fees (formula demo)</h3><div class="stat">${money(state.results["summary.totalServiceFees"])}</div></div>
        <div class="card"><h3>Pass-throughs (formula demo)</h3><div class="stat">${money(state.results["summary.passThroughs"])}</div></div>
        <div class="card"><h3>Grand total (formula demo)</h3><div class="stat">${money(state.results["summary.grandTotal"])}</div></div>
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

    els.studyMeta.textContent = `${state.study.studyId} · ${state.study.clientName || "—"} · ${state.study.versionLabel}${state.source === "cosmos" ? " · Cosmos" : " · Local"}`;
    els.pageTitle.textContent = section.label;
    els.pageSubtitle.textContent = section.department
      ? `Editable by ${section.department}${canEdit(section.department) ? "" : " (view only for you)"}`
      : "Shared study workspace";

    renderNav();

    let html = "";
    switch (section.id) {
      case "hub": html = renderHub(); break;
      case "ask": html = renderAsk(); break;
      case "upload": html = renderUpload(); break;
      case "studies": html = renderStudies(); break;
      case "versions": html = renderVersions(); break;
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
        return;
      }
      if (e.target.id === "btnRefreshQuarantine") {
        refreshQuarantine();
        return;
      }
      if (e.target.id === "btnAsk") {
        sendAsk();
      }
      if (e.target.id === "btnRefreshStudies") {
        loadStudiesIntoPanel();
      }
      if (e.target.id === "btnRunCompare") {
        runCompare();
      }
      if (e.target.id === "btnOpenNewerVersion") {
        const newerEl = document.getElementById("compareNewer");
        if (newerEl && newerEl.value) openVersionInWorkspace(newerEl.value);
      }
      const openStudyBtn = e.target.closest("[data-open-study]");
      if (openStudyBtn) {
        openStudy(openStudyBtn.getAttribute("data-open-study"));
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

  // Land user on their department page on first load (Admin stays on Hub)
  const user = currentUser();
  if (user.department !== "Admin") {
    const home = SBW.sections.find((s) => s.department === user.department);
    if (home) state.sectionId = home.id;
  }

  bind();
  render();
  markSaved();
})();
