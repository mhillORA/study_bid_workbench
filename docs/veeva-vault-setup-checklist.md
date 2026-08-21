# Veeva Vault API — setup checklist (before we write code)

**Target API:** [Vault API 26.1](https://developer.veevavault.com/api/26.1/)  
**Goal:** One full pull of Study / Study Site / Org / Milestones → Cosmos, then deltas (`modified_date__v` watermark). Same pattern as Salesforce.  
**App:** Ora Intelligence / Buddy (Azure Function App + Cosmos `bd-budgets`) — **read-only**.

Do these steps in order. When Step 6 samples look good, we wire Node (`veevaClient.js` / sync) like SF.

---

## Recommended auth path

| Phase | Auth | Why |
|---|---|---|
| **Now (prove + map objects)** | Dedicated integration user + **username/password** → Vault `sessionId` | Fastest with your admin creds; matches Vault `POST /api/{version}/auth` |
| **Soon (production)** | Entra ID **client credentials** → OAuth access token → Vault session via OIDC profile | No long-lived Vault password in Azure; Vault’s preferred M2M pattern |

Do **not** use your personal admin login in Azure long-term. Create a dedicated API user once auth works.

---

# Confirmed live (2026-08-21 smoke test)

| Setting | Value |
|---|---|
| Vault DNS | `oraclinical-etmf.veevavault.com` |
| Vault name | Ora Clinical (id 7630) |
| Client ID | `ora-intelligence` |
| API version | `v26.1` |
| Integration user | `maa@oraclinical.com` (display: Matt API Account) |

**Do not store the password in git.** Put it in Azure App Settings / Key Vault only. Rotate the password after it was shared in chat.

### Object counts (VQL `SELECT id FROM …`)

| Object | Total |
|---|---|
| `study__v` | 275 |
| `site__v` (Study Site) | 3,928 |
| `organization__v` | 1,552 |
| `study_country__v` | 459 |
| `sponsor__c` | 119 |
| `milestone_study_site__v` | 0 (empty — need another milestone source) |

### Field map (v1 pull)

**study__v → Cosmos study facts**

- `id`, `name__v`, `alternate_study_number__vs`, `sponsor__c`, `indication__v`, `study_phase__v`, `status__v`, `therapeutic_area__c`, `enrollment__vs`, `number_of_sites__c`, `modified_date__v`

**site__v → Cosmos site facts**

- `id`, `name__v`, `site_name__v`, `study__v`, `study_name__v`, `organization__clin`, `country__v`, `site_status__v`, `status__v`, `indication__c`, `study_phase__c`, `study_sponsor__c`, `no_subjects_enrolled__v`, `site_selected_date__v`, `modified_date__v`

**organization__v / sponsor__c** — join for names

Smoke script (env-based, no secrets in file): `node scripts/veeva_smoke_probe.js`


---

## Step 1 — Dedicated integration user (read-only)

As admin in Vault:

1. **Users & Groups** → create domain user, e.g. `bd-intelligence-api@oraclinical.com` (match your domain pattern)
2. Security profile / permission set: **API access** + **read** on clinical objects (Study, Study Country, Study Site, Organization, Milestone / related)
3. Do **not** grant create/edit/delete on those objects if you can avoid it
4. Confirm the user can log into the UI once (activates the account)
5. Save username + password in a password manager (temporary until OAuth)

Checklist:

- [ ] Integration username  
- [ ] Password set / known  
- [ ] Can log into the correct Vault DNS in UI  

---

## Step 2 — Pick a Client ID string

Vault accepts `X-VaultAPI-ClientID` (or `client_id` query) on every call for usage logs.

Use something like:

```text
ora-bd-intelligence-azure-ora-intel
```

Rules: alphanumeric + `.` `_` `-` only, ≤ 100 chars.

Optional later: Admin → Connections / Client ID Filtering if your org enforces allowlisted client IDs.

- [ ] Client ID chosen: `________________`

---

## Step 3 — Smoke-test authentication (you do this first)

Use **API version `v26.1`** (or latest your Vault supports). Replace placeholders.

### 3a. Authenticate (username / password)

```bash
curl -s -X POST "https://{VAULT_DNS}/api/v26.1/auth" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Accept: application/json" \
  -H "X-VaultAPI-ClientID: ora-bd-intelligence-azure-ora-intel" \
  -d "username={USERNAME}&password={PASSWORD}"
```

Expect:

```json
{
  "responseStatus": "SUCCESS",
  "sessionId": "...",
  "vaultIds": [ { "id": ..., "name": "...", "url": "https://.../api" } ],
  "vaultId": ...
}
```

- [ ] `responseStatus` = `SUCCESS`
- [ ] `sessionId` present
- [ ] Correct Vault appears in `vaultIds` (not a different product Vault)

Copy `sessionId` for the next calls (`Authorization: {sessionId}` or `Bearer {sessionId}`).

### 3b. Confirm session / who am I

```bash
curl -s "https://{VAULT_DNS}/api/v26.1/objects/users/me" \
  -H "Authorization: {SESSION_ID}" \
  -H "Accept: application/json" \
  -H "X-VaultAPI-ClientID: ora-bd-intelligence-azure-ora-intel"
```

- [ ] Returns your integration user (not an error)

Docs: [Authentication](https://developer.veevavault.com/api/26.1/#authentication)

---

## Step 4 — Discover object API names

Clinical object names vary by Vault config. List objects the user can see:

```bash
curl -s "https://{VAULT_DNS}/api/v26.1/metadata/vobjects" \
  -H "Authorization: {SESSION_ID}" \
  -H "Accept: application/json" \
  -H "X-VaultAPI-ClientID: ora-bd-intelligence-azure-ora-intel"
```

Search the JSON / UI for labels like Study, Study Site, Organization, Milestone.

Typical Clinical Ops names (confirm yours — do not assume):

| Business | Often looks like |
|---|---|
| Study | `study__v` or `study__c` |
| Study site | `site__v` / `study_site__v` / `study_country__v` related |
| Organization | `organization__v` |
| Milestone / event | milestone / checklist / custom objects — **verify** |

For each candidate object:

```bash
curl -s "https://{VAULT_DNS}/api/v26.1/metadata/vobjects/{object_name}" \
  -H "Authorization: {SESSION_ID}" \
  -H "Accept: application/json" \
  -H "X-VaultAPI-ClientID: ora-bd-intelligence-azure-ora-intel"
```

Fill this table (paste API names):

| Cosmos target | Vault object API name | Key fields found |
|---|---|---|
| `ora_fact_study` | | id, name/number, sponsor, indication, phase, status, `modified_date__v` |
| `ora_fact_site` | | study ref, org/site name, country, enrollment/PSM if any, `modified_date__v` |
| org / site master | | canonical site name, country |
| `ora_veeva_milestones` | object **or** named report | Selected, Contract, IRB, SIV, FSI dates |

- [ ] Object names filled  
- [ ] Each has a **modified** date field for deltas (`modified_date__v` or equivalent)

---

## Step 5 — Prove VQL read (full + delta shape)

Docs: [Query / VQL](https://developer.veevavault.com/api/26.1/#vault-query-language-vql)

### Full sample (Study)

```bash
curl -s -X POST "https://{VAULT_DNS}/api/v26.1/query" \
  -H "Authorization: {SESSION_ID}" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Accept: application/json" \
  -H "X-VaultAPI-ClientID: ora-bd-intelligence-azure-ora-intel" \
  -H "X-VaultAPI-DescribeQuery: true" \
  --data-urlencode "q=SELECT id, name__v, modified_date__v FROM study__v MAXROWS 5"
```

(Replace `study__v` / fields with your Step 4 names.)

### Delta sample

```text
SELECT id, name__v, modified_date__v
FROM study__v
WHERE modified_date__v > '2026-08-01T00:00:00.000Z'
MAXROWS 100
```

- [ ] Full query returns rows  
- [ ] Delta filter works on modified date  
- [ ] No permission errors on fields we need  
- [ ] Note page size / `next_page` behavior from `responseDetails`

Repeat for Study Site + Milestone (or confirm milestones are **report-only** — then we schedule a Vault report export instead of VQL).

---

## Step 6 — Field map (hand this to engineering)

Map business fields → Vault API names (spreadsheet is fine). Minimum:

**Study → `ora_fact_study`**

- Vault id → upsert key  
- Study number / name  
- Sponsor  
- Indication / TA  
- Phase  
- Lifecycle / status  
- Countries (field or related)  
- Enrollment / PSM rollups if they exist on the object  

**Site × study → `ora_fact_site`**

- Site×study id  
- Study reference  
- Org / site name  
- Country  
- Site PSM / enrolled / months / FSI trust (or closest equivalents)

**Milestones → `ora_veeva_milestones`**

- Org + study keys  
- Selected / Contract / IRB / SIV / FSI (or Mike Watson Site Level report columns)

- [ ] Spreadsheet / notes ready  
- [ ] Sample JSON from 1–2 real studies saved (sanitized) for fixture tests  

---

## Step 7 — Production auth (after MVP works)

When username/password smoke tests are green, harden:

1. Entra app registration (client credentials)  
2. Vault **Admin → Settings → OAuth 2.0 / OpenID Connect Profiles** (Azure AD metadata)  
3. Security policy → SSO / OAuth profile  
4. Integration user’s **Federated ID** = Entra client id (per Vault/Entra M2M guides)  
5. Flow: Entra token → `POST https://login.veevavault.com/auth/oauth/session/{profile_id}` → Vault `sessionId`  

Keep username/password path as Azure fallback during cutover if needed.

- [ ] OIDC profile id  
- [ ] Entra client id / secret in Key Vault (not chat)  
- [ ] Session exchange curl works  

---

## Step 8 — What you send us to start coding

Paste (no passwords in chat if avoidable — use 1Password / secure note for secrets):

```
VAULT_DNS=https://____.veevavault.com
API_VERSION=v26.1
CLIENT_ID=ora-bd-intelligence-azure-ora-intel
AUTH=password | oauth
INTEGRATION_USER=____@____
OBJECTS:
  study=____
  study_site=____
  organization=____
  milestone=____ (or REPORT: ____)
DELTA_FIELD=modified_date__v
SAMPLE_VQL_STUDY=SELECT ... FROM ... MAXROWS 5
SAMPLE_VQL_SITE=...
SAMPLE_VQL_DELTA=... WHERE modified_date__v > '...'
```

Then we implement:

1. `api/src/veevaClient.js` — auth + session refresh + VQL paging  
2. `veevaSync.js` — full + delta → Cosmos (`ora_fact_*` / milestones)  
3. Data Status button — **Ingest Veeva + refresh joins** (mirror SF)  
4. Buddy pack from live Cosmos (already reads those containers)

---

## Out of scope for v1

- Writing back to Vault  
- Document binary download  
- Subject-level PHI beyond aggregate enrollment already used in fact tables  
- Replacing TrialHub / CT.gov (those stay as today)

---

## Quick reference — API shapes

| Action | Method |
|---|---|
| Auth (password) | `POST /api/v26.1/auth` → `sessionId` |
| Auth (OAuth) | Entra token → `POST https://login.veevavault.com/auth/oauth/session/{profileId}` |
| Query | `POST /api/v26.1/query` body `q=SELECT ...` |
| Object metadata | `GET /api/v26.1/metadata/vobjects` / `.../vobjects/{name}` |
| Header | `Authorization: {sessionId}` |
| Tracking | `X-VaultAPI-ClientID: ora-bd-intelligence-azure-ora-intel` |

Full reference: https://developer.veevavault.com/api/26.1/
