# Salesforce ↔ Azure sync (Ora Intelligence Tool)

Live refresh of Cosmos `ora_sponsor_crosswalk` owner / tier / account name from Salesforce Accounts via JWT Bearer.

## What it does

- Reads crosswalk rows that already have `sf_account_id`
- SOQL those Accounts in Salesforce
- Updates `sf_account_name`, `sf_owner`, `tier` (`Tier__c`), `ora_grouping` (`Ora_Grouping__c`)
- Sets `sfAccountActive` / `sf_sync_note` if the Id is missing
- **Does not change** `crosswalk_status` (Cosmos partition key)

### Fields pulled from Salesforce Account

| Salesforce | Cosmos crosswalk field |
|---|---|
| `Id` | (matched on existing `sf_account_id`) |
| `Name` | `sf_account_name` |
| `Owner.Name` | `sf_owner` |
| `Tier__c` | `tier` |
| `Ora_Grouping__c` | `ora_grouping` |
| missing / deleted | `sfAccountActive=false` + note |

### Full table sync (Buddy context)

Separate button / POST mode pulls whole SF objects into Cosmos for Buddy Q&A:

| Salesforce object | Cosmos container |
|---|---|
| Account | `ora_sf_account` |
| Opportunity | `ora_sf_opportunity` |
| `Activity_Request__c` | `ora_sf_activity_request` |

(Only these three — not OpportunityLineItem / Product2.)

Endpoints:

- `GET /api/salesforce/sync` — config + crosswalk status + `tables` counts  
- `POST /api/salesforce/sync` — crosswalk refresh (signed-in or `x-copilot-key`)  
- `POST /api/salesforce/sync` with `{ "dryRun": true }` — crosswalk count only  
- `POST /api/salesforce/sync` with `{ "tables": true }` — full table pull for Buddy
- `POST /api/salesforce/sync` with `{ "tables": true, "thenCrosswalk": true }` — tables + crosswalk (scheduler)

## Schedule

GitHub Actions **`intelligence-daily-sync.yml`** runs tables + crosswalk daily at **11:00 UTC (~6AM EST / ~7AM EDT)** against `ora-buddy-api` (`x-copilot-key` = `COPILOT_ASK_KEY` secret). SF tables are a full upsert of Account / Opportunity / `Activity_Request__c` (not a modified-date delta yet).

## Salesforce (already done checklist)

1. External Client App named **Ora Intelligence Tool** (Local)
2. JWT Bearer enabled + cert uploaded (`ora_intel_sf.crt`)
3. Policies: **Admin approved users are pre-authorized**
4. Integration user pre-authorized; API + Account read
5. Consumer Key saved
6. Private key `ora_intel_sf.key` kept offline

## Azure App Settings (SWA API)

In Azure Portal → your Static Web App → **Configuration** → **Application settings** (API / Function app settings):

| Name | Value |
|---|---|
| `SF_CLIENT_ID` | Consumer Key from the SF app |
| `SF_USERNAME` | Integration user username (login email) |
| `SF_LOGIN_URL` | `https://login.salesforce.com` (prod) |
| `SF_JWT_PRIVATE_KEY_B64` | **Preferred.** Base64 of the entire `ora_intel_sf.key` file (one line — Azure won’t mangle newlines) |
| `SF_JWT_PRIVATE_KEY` | Full PEM (often breaks in App Settings → `DECODER routines::unsupported`) |
| `SF_TIER_FIELD` | `Tier__c` |
| `SF_GROUPING_FIELD` | `Ora_Grouping__c` |
| `SF_API_VERSION` | `59.0` (optional) |

### Pasting the private key (use base64)

Azure App Settings regularly corrupt multi-line PEMs. Use **base64** instead:

**PowerShell (on the machine that has the .key):**
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\ora_intel_sf.key"))
```

**Azure Cloud Shell / bash:**
```bash
base64 -w0 ora_intel_sf.key && echo
```

1. Copy the single-line output  
2. Add App Setting `SF_JWT_PRIVATE_KEY_B64` = that string  
3. You can leave `SF_JWT_PRIVATE_KEY` blank (or delete it)  
4. Save → wait for API restart (~1–2 min)  
5. **Data Status** should show `JWT key: OK`

Still optional: paste PEM into `SF_JWT_PRIVATE_KEY` with `\n` for newlines — base64 is more reliable.

## Run a sync

In the app: **Data Status** tab:

1. **Sync Salesforce now** — refreshes crosswalk owner / tier / grouping  
2. **Sync SF tables** — pulls Accounts, Opps, ARs, line items, Product2 into `ora_sf_*` (needed before Buddy can answer pipeline questions)

Or via API:

```bash
# Crosswalk
curl -X POST https://<your-swa>/api/salesforce/sync \
  -H "Content-Type: application/json" \
  -H "x-copilot-key: <COPILOT_ASK_KEY>"

# Full tables (Buddy)
curl -X POST https://<your-swa>/api/salesforce/sync \
  -H "Content-Type: application/json" \
  -H "x-copilot-key: <COPILOT_ASK_KEY>" \
  -d '{"tables":true}'
```

If the tables sync hits the time budget, click **Sync SF tables** again — it continues remaining objects.

## Common errors

| Error | Fix |
|---|---|
| **`invalid_app_access` / `user is not admin approved to access this app`** | **This is the current live failure (key is OK).** In Salesforce on **Ora Intelligence Tool**: (1) Policies → Permitted Users = **Admin approved users are pre-authorized**; (2) **Manage** → **Profiles** and/or **Permission Sets** → add the profile/perm set of the user in `SF_USERNAME`; (3) that user must be active + **API Enabled**. Then **Sync Salesforce now** again. |
| `invalid_grant` / user hasn’t approved | Same pre-authorize path as above |
| `invalid_client_id` | Wrong `SF_CLIENT_ID` (Consumer Key) |
| `user hasn’t approved this consumer` | Same as pre-authorize |
| Certificate / JWT signature | Key must match the cert uploaded to SF |
| `routines::unsupported` / DECODER | Azure mangled the PEM. Set `SF_JWT_PRIVATE_KEY_B64` to base64 of the whole `.key` file (see above). Do not paste the `.crt`. |
| Tier field invalid | Confirm `SF_TIER_FIELD=Tier__c` |

### Fix `invalid_app_access` on an **External Client App** (most common)

Setup → Quick Find → **External Client App Manager** → **Ora Intelligence Tool** → **Policies** → **Edit**:

1. **OAuth Policies** → Permitted Users = **Admin approved users are pre-authorized** → Save (OK the dialog)
2. Still under Policies → **App Policies** → **Select Permission Sets**  
   Move a Permission Set from **Available** → **Selected** (the one assigned to `SF_USERNAME`)
3. That Permission Set must actually be **assigned to the user** in Azure’s `SF_USERNAME`
4. Save

Optional shortcut while testing: Permitted Users = **All users may self-authorize** (less secure; JWT often still wants a pre-auth’d profile/perm set — prefer Selected Permission Sets).

Also confirm Azure `SF_USERNAME` is the user’s Salesforce **Username** field (Setup → Users), not just Email if they differ.

## Security

- Never commit `.key` / PEM to git  
- Prefer Key Vault references for `SF_JWT_PRIVATE_KEY` when ready  
- Integration user: least privilege (Account + User read)
