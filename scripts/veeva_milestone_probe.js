/** Env: VEEVA_DNS, VEEVA_USER, VEEVA_PASS, VEEVA_CLIENT_ID */
const https = require("https");
const dns = process.env.VEEVA_DNS;
const user = process.env.VEEVA_USER;
const pass = process.env.VEEVA_PASS;
const clientId = process.env.VEEVA_CLIENT_ID || "ora-intelligence";

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
        resolve({ json });
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
  const sid = auth.json.sessionId;
  const meta = await req("GET", "/api/v26.1/metadata/vobjects/milestone__v", null, {
    Authorization: sid
  });
  const fields = meta.json?.object?.fields || [];
  const names = new Set(fields.map((f) => f.name));
  console.log("milestone__v fields", fields.length);
  console.log(
    fields
      .map((f) => f.name)
      .filter((n) =>
        /name|date|study|site|org|country|type|status|complete|planned|actual|milestone|modified|level|object_type/i.test(
          n
        )
      )
      .join("\n")
  );

  async function vql(q) {
    return req("POST", "/api/v26.1/query", "q=" + encodeURIComponent(q), {
      Authorization: sid,
      "Content-Type": "application/x-www-form-urlencoded"
    });
  }

  const want = [
    "id",
    "name__v",
    "status__v",
    "modified_date__v",
    "study__v",
    "site__v",
    "study_country__v",
    "organization__v",
    "milestone_type__v",
    "planned_completion_date__v",
    "actual_completion_date__v",
    "baseline_completion_date__v",
    "completed_date__v",
    "object_type__v",
    "lifecycle__v",
    "milestone_level__v"
  ].filter((n) => names.has(n));
  console.log("\nSELECT", want.join(", "));
  let r = await vql(`SELECT ${want.join(", ")} FROM milestone__v MAXROWS 10`);
  console.log(r.json?.responseStatus, r.json?.errors?.[0]?.message || "");
  console.log(JSON.stringify(r.json?.data || r.json, null, 2).slice(0, 4000));

  r = await vql("SELECT name__v FROM milestone__v MAXROWS 500");
  const counts = {};
  for (const row of r.json?.data || []) {
    const n = String(row.name__v || "?");
    counts[n] = (counts[n] || 0) + 1;
  }
  console.log("\nTop name__v in first page (~500):");
  console.log(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([k, v]) => `${v}\t${k}`)
      .join("\n")
  );

  // item sample
  const itemMeta = await req("GET", "/api/v26.1/metadata/vobjects/milestone_item__v", null, {
    Authorization: sid
  });
  console.log(
    "\nmilestone_item__v fields",
    (itemMeta.json?.object?.fields || []).map((f) => f.name).join(", ")
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
