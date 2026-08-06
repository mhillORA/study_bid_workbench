# Salesforce ↔ Azure sync (Ora Intelligence Tool)

Live refresh of Cosmos `ora_sponsor_crosswalk` owner / tier / account name from Salesforce Accounts via JWT Bearer.

## What it does

- Reads crosswalk rows that already have `sf_account_id`
- SOQL those Accounts in Salesforce
- Updates `sf_account_name`, `sf_owner`, `tier` (`Tier__c` by default)
- Sets `sfAccountActive` / `sf_sync_note` if the Id is missing
- **Does not change** `crosswalk_status` (Cosmos partition key)

Endpoints:

- `GET /api/salesforce/sync` — config + last sync status  
- `POST /api/salesforce/sync` — run refresh (signed-in user or `x-copilot-key`)  
- `POST /api/salesforce/sync` with `{ "dryRun": true }` — count only  

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
| `SF_JWT_PRIVATE_KEY` | Full PEM of `ora_intel_sf.key` (see below) |
| `SF_TIER_FIELD` | `Tier__c` |
| `SF_API_VERSION` | `59.0` (optional) |

### Pasting the private key

1. Open `ora_intel_sf.key` in Notepad  
2. Copy **everything**, including  
   `-----BEGIN … KEY-----` and `-----END … KEY-----`  
3. Paste into `SF_JWT_PRIVATE_KEY`  
4. If the portal mangles newlines, replace real newlines with `\n` so it is one line, e.g.  
   `-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----`

Save settings and wait for the SWA API to restart (~1–2 min).

## Run a sync

In the app: **Ora Clinical Intelligence** → **Sync Salesforce now**  
Or:

```bash
curl -X POST https://<your-swa>/api/salesforce/sync \
  -H "Content-Type: application/json" \
  -H "x-copilot-key: <COPILOT_ASK_KEY>"
```

## Common errors

| Error | Fix |
|---|---|
| `invalid_grant` / user hasn’t approved | Admin approved + pre-authorize integration user |
| `invalid_client_id` | Wrong `SF_CLIENT_ID` |
| `user hasn’t approved this consumer` | Same as pre-authorize |
| Certificate / JWT signature | Key must match the cert uploaded to SF |
| Tier field invalid | Confirm `SF_TIER_FIELD=Tier__c` |

## Security

- Never commit `.key` / PEM to git  
- Prefer Key Vault references for `SF_JWT_PRIVATE_KEY` when ready  
- Integration user: least privilege (Account + User read)
