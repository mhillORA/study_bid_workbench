/**
 * One-shot Veeva smoke probe. Reads env:
 *   VEEVA_DNS, VEEVA_USER, VEEVA_PASS, VEEVA_CLIENT_ID
 * Does not print passwords. Delete or leave uncommitted secrets out of git.
 */
const https = require("https");

const dns = process.env.VEEVA_DNS;
const user = process.env.VEEVA_USER;
const pass = process.env.VEEVA_PASS;
const clientId = process.env.VEEVA_CLIENT_ID || "ora-intelligence";

if (!dns || !user || !pass) {
  console.error("Set VEEVA_DNS, VEEVA_USER, VEEVA_PASS");
  process.exit(1);
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(body);
    const opts = {
      hostname: dns,
      path,
      method,
      headers: {
        Accept: "application/json",
        "X-VaultAPI-ClientID": clientId,
        ...headers,
        ...(data ? { "Content-Length": data.length } : {})
      }
    };
    const r = https.request(opts, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(buf);
        } catch (_) {}
        resolve({ status: res.statusCode, json, raw: buf.slice(0, 4000) });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const auth = await req(
    "POST",
    "/api/v26.1/auth",
    new URLSearchParams({ username: user, password: pass }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  if (auth.json?.responseStatus !== "SUCCESS") {
    console.error("AUTH FAIL", auth.json || auth.raw);
    process.exit(1);
  }
  const sid = auth.json.sessionId;
  console.log("AUTH OK vaultId=", auth.json.vaultId);

  async function vql(q) {
    return req("POST", "/api/v26.1/query", "q=" + encodeURIComponent(q), {
      Authorization: sid,
      "Content-Type": "application/x-www-form-urlencoded"
    });
  }

  for (const obj of [
    "study__v",
    "site__v",
    "organization__v",
    "study_country__v",
    "sponsor__c",
    "milestone_study_site__v"
  ]) {
    const r = await vql(`SELECT id FROM ${obj}`);
    console.log(
      obj,
      r.json?.responseStatus,
      "total=",
      r.json?.responseDetails?.total,
      r.json?.errors?.[0]?.message || ""
    );
  }

  const rich = await vql(
    "SELECT id, name__v, study_name__v, study_name__vs, alternate_study_number__vs, " +
      "sponsor__c, sponsor_organization__v, indication__v, indication__c, study_phase__v, " +
      "study_status__v, status__v, therapeutic_area__c, enrollment__vs, number_of_sites__c, " +
      "modified_date__v FROM study__v MAXROWS 5"
  );
  console.log("\nRICH studies", rich.json?.responseStatus, rich.json?.errors?.[0]?.message || "");
  console.log(JSON.stringify(rich.json?.data || rich.json, null, 2).slice(0, 3000));

  const sites = await vql(
    "SELECT id, name__v, site_name__v, study__v, study_number__v, study_name__v, " +
      "organization__clin, country__v, site_status__v, status__v, indication__c, " +
      "study_phase__c, study_sponsor__c, no_subjects_enrolled__v, site_selected_date__v, " +
      "modified_date__v FROM site__v MAXROWS 5"
  );
  console.log("\nRICH sites", sites.json?.responseStatus, sites.json?.errors?.[0]?.message || "");
  console.log(JSON.stringify(sites.json?.data || sites.json, null, 2).slice(0, 3000));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
