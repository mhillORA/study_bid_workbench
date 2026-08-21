# Deploy Buddy API to Function App + keep it warm

I (the agent) do **not** log into your Azure. You do Portal steps. Code is in the repo.

Function App URL you created:

`https://ora-buddy-api-hrdbgqh9cvaub5ft.eastus2-01.azurewebsites.net`

---

## Part 1 — Extra app settings (both places)

### A) On the **Function App** (brain)

Add/update:

| Name | Value |
|---|---|
| `BUDDY_REQUIRE_SESSION` | `1` |
| `BUDDY_SESSION_SECRET` | Make a long random string (see below) — **same** as SWA |
| `BUDDY_ASK_DEADLINE_MS` | `120000` |
| `BUDDY_FOUNDRY_TIMEOUT_MS` | `45000` |
| `BUDDY_FOUNDRY_DEEP_TIMEOUT_MS` | `90000` |
| `BUDDY_CORS_ORIGIN` | `https://white-river-0de1aed0f.7.azurestaticapps.net` (already set) |

Plus Cosmos + Foundry settings you already copied.

### B) On the **Static Web App** (website)

Add:

| Name | Value |
|---|---|
| `BUDDY_API_BASE` | `https://ora-buddy-api-hrdbgqh9cvaub5ft.eastus2-01.azurewebsites.net` |
| `BUDDY_SESSION_SECRET` | **Exact same** string as on the Function App |

### Make a secret (bash / Git Bash / WSL / macOS)

```bash
openssl rand -base64 48
```

Copy the output → paste as `BUDDY_SESSION_SECRET` on **both** SWA and Function App → Save / restart both if prompted.

---

## Part 2 — Deploy API code (browser only — any computer)

You do **not** need `func` or this PC. Use Azure’s Deployment Center (it talks to GitHub for you).

### Recommended: Deployment Center → GitHub

1. Azure Portal → Function App `ora-buddy-api-…`  
2. Left menu → **Deployment Center**  
3. **Settings** tab → Source: **GitHub**  
4. **Authorize** / sign in as the GitHub user that owns `mhillORA/study_bid_workbench`  
5. Pick:
   - Organization: `mhillORA`  
   - Repository: `study_bid_workbench`  
   - Branch: `main`  
6. If it asks for app location / package path, use: `api`  
7. **Save**  
8. Open the **Logs** tab — wait until a deploy finishes green  

Azure may add a GitHub Actions workflow itself (that’s fine).

### Prove it

`https://ora-buddy-api-hrdbgqh9cvaub5ft.eastus2-01.azurewebsites.net/api/health`  
→ `"ok": true`

### Optional later: secret-based Actions workflow

There is a local commit with `.github/workflows/buddy-function-app.yml` if you prefer a publish-profile secret. Push needs a GitHub token with the `workflow` scope (`gh auth refresh -s workflow` then `git push`). Deployment Center above is simpler and doesn’t need that.

---

## Part 3 — Prove health

Browser:

`https://ora-buddy-api-hrdbgqh9cvaub5ft.eastus2-01.azurewebsites.net/api/health`

Expect JSON with `"ok": true`.

---

## Part 4 — Keep it warm (business-hours-ish ping)

Do this **after** health works.

1. Function App → **Application Insights** → turn **On** if needed → open the Insights resource  
2. **Availability** → **Add Standard test**  
3. Settings:

| Field | Value |
|---|---|
| Name | `buddy-warmup` |
| URL | `https://ora-buddy-api-hrdbgqh9cvaub5ft.eastus2-01.azurewebsites.net/api/health` |
| Frequency | **5 minutes** |
| Locations | **1** (e.g. East US) |
| Success | HTTP 200 |
| Alerts | Off for now |

4. Save. Wait ~10 minutes → green checks.

That ping stops most morning cold starts. Cost is tiny.

---

## Part 5 — How Buddy uses this

1. You open the **SWA** workbench (login as usual)  
2. UI calls SWA `/api/buddy/session` (fast, under 45s) → gets a short-lived token + Function App URL  
3. Prepare / answer / visual go to the **Function App** with that token (can run ~2 minutes per hop)  
4. If `BUDDY_API_BASE` is missing, UI falls back to SWA `/api` (old 45s behavior)

---

## Checklist

- [ ] `BUDDY_SESSION_SECRET` on SWA **and** Function App (identical)  
- [ ] `BUDDY_API_BASE` on SWA  
- [ ] `BUDDY_REQUIRE_SESSION=1` on Function App  
- [ ] Longer timeout settings on Function App  
- [ ] API code deployed to Function App  
- [ ] `/api/health` returns OK  
- [ ] Availability test every 5 minutes  
- [ ] Hard refresh workbench, ask Buddy something simple  

If something fails, tell the agent: health URL result + whether session settings are on both apps (don’t paste the secret).
