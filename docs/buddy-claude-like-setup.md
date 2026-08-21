# Buddy: Claude-like reliability

## Can we change the SWA 45s rule?

**No.** Even on **Standard**, Microsoft caps every request through `yoursite.azurestaticapps.net/api/*` at about **45 seconds**. There is no portal setting to raise it.

Standard unlocks a **separate** Buddy API (phase 3). Long runs = short hops (phase 1–2, shipped) and/or a backend the browser hits **directly** / async jobs.

## What “streaming” means

- **Polling (do this first):** status updates until the answer is ready. Good enough for VPs.
- **Streaming (later):** words appear as Buddy types (Claude.app feel). Optional polish.

---

## Phase 3 — what you do in Azure (idiot checklist)

We recommend: **Azure App Service (Node)** for the Buddy brain. Simple, long HTTP OK (~230s sync) + easy async jobs later.

### Before you start

- [ ] Azure Portal access on the **same subscription** as the Study Bid workbench SWA
- [ ] Know the SWA resource name and resource group
- [ ] Know which Cosmos account / Foundry keys the SWA app settings already use (we’ll copy them)

### Step 1 — Create an App Service (Buddy API)

1. Portal → **Create a resource** → **Web App**
2. Fill in:
   - **Name:** e.g. `ora-buddy-api` (must be globally unique)
   - **Runtime:** **Node 20 LTS**
   - **OS:** Linux
   - **Plan:** new or existing; **Basic B1** is fine to start (not Free if you care about always-on)
3. Create → wait until **Deployment succeeded**
4. Open the app → **Overview** → copy **Default domain**  
   Example: `https://ora-buddy-api.azurewebsites.net`  
   **Send that URL to the agent** when done.

### Step 2 — Copy app settings from SWA → App Service

1. Open your **Static Web App** → **Configuration** / **Application settings**
2. Open the new **App Service** → **Settings** → **Environment variables** (or Configuration)
3. Copy these (names may vary slightly in your env — copy whatever Buddy already uses):

   - `AZURE_OPENAI_ENDPOINT` / Foundry project endpoint  
   - `AZURE_OPENAI_API_KEY` / Foundry key  
   - `FOUNDRY_AGENT_NAME_FAST` / `FOUNDRY_AGENT_NAME_DEEP` (BudgetBuddy / BudgetBuddy2)  
   - Cosmos connection: `COSMOS_DB_ENDPOINT`, `COSMOS_DB_KEY`, `COSMOS_DB_DATABASE` (or whatever this repo already uses)  
   - Any other Buddy-related keys already on SWA

4. Add one new setting on App Service:
   - `BUDDY_CORS_ORIGIN` = your SWA URL (e.g. `https://white-river-0de1aed0f.azurestaticapps.net`)  
     (We’ll wire CORS in code when we deploy the API.)

5. **Save** and restart the App Service if prompted.

### Step 3 — Tell the agent these three things

Reply in chat with:

1. App Service URL: `https://….azurewebsites.net`
2. Resource group name
3. SWA resource name

Then say: **“phase 3 go”** — we’ll deploy the Buddy API code, point the UI at the new brain, and add job polling so Deep/visuals can run minutes without SWA 500s.

### Step 4 — (Later, optional) Custom domain

Ignore for now. When you’re ready: App Service → Custom domains → add hostname + TLS. SWA can keep its own domain for the UI.

### Step 5 — (Later, optional) Link API in SWA

Two patterns (we’ll pick one when coding):

- **A (recommended):** UI calls `https://ora-buddy-api.azurewebsites.net` **directly** for Buddy asks (bypass SWA 45s). SWA still hosts the website + Entra.
- **B:** Link BYO Functions/App in SWA → `/api` still proxied → **still 45s** unless every call is a short async hop.

We want **A** for Claude-like length.

---

## What you do NOT need to do

- Don’t try to “increase SWA timeout” in Configuration — it doesn’t exist  
- Don’t recreate Cosmos or Foundry — reuse what SWA already uses  
- Don’t set up streaming yet — polling first
