# Deploy Buddy API to Function App + keep it warm

I (the agent) do **not** log into your Azure. You do Portal steps. Code is in the repo.

Function App URL you created:

`https://ora-buddy-api-hrdbgqh9cvaub5ft.easus2-01.azurewebsites.net`

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
| `BUDDY_API_BASE` | `https://ora-buddy-api-hrdbgqh9cvaub5ft.easus2-01.azurewebsites.net` |
| `BUDDY_SESSION_SECRET` | **Exact same** string as on the Function App |

### Make a secret (Windows PowerShell)

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
```

Copy the output → paste as `BUDDY_SESSION_SECRET` on **both** SWA and Function App → Save / restart both if prompted.

---

## Part 2 — Deploy API code to the Function App

SWA still deploys `api/` for the **website’s** `/api` (session mint + fallback).  
The **Function App** needs the same `api/` folder published separately.

### Option A — VS Code (easiest for many people)

1. Install [Azure Functions extension](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.vscode-azurefunctions)  
2. Open this repo in VS Code  
3. Open the `api` folder as the Functions project  
4. Azure sidebar → Function App `ora-buddy-api-…` → **Deploy to Function App…**  
5. Confirm  

### Option B — Azure Portal zip (no VS Code)

1. On your PC, zip the contents of the `api` folder **including** `package.json`, `host.json`, `src/`, `node_modules` after `npm install`  
   Or from repo root in PowerShell:

```powershell
cd api
npm ci
cd ..
Compress-Archive -Path api\* -DestinationPath buddy-api-deploy.zip -Force
```

2. Function App → **Deployment Center** or **Advanced Tools (Kudu)** → zip deploy  
   (Portal UI varies; “Zip push deploy” / Deployment Center → zip is fine.)

### Option C — Azure CLI (if you use `az` locally)

```powershell
cd api
npm ci
func azure functionapp publish ora-buddy-api-hrdbgqh9cvaub5ft --javascript
```

(Function App **name** may be `ora-buddy-api-hrdbgqh9cvaub5ft` — check Overview → Name.)

---

## Part 3 — Prove health

Browser:

`https://ora-buddy-api-hrdbgqh9cvaub5ft.easus2-01.azurewebsites.net/api/health`

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
| URL | `https://ora-buddy-api-hrdbgqh9cvaub5ft.easus2-01.azurewebsites.net/api/health` |
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
