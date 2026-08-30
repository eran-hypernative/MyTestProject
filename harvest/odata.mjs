/* מצפן — לקוח OData מול הכנסת.
   עיקרון: לא מניחים שמות שדות. מגלים אותם מ-$metadata ומדווחים על כל אי-התאמה.
   סעיף 7.1 באפיון דורש לאמת את קידוד VoteValue מול $metadata לפני פרודקשן. */

import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";

export const V4 = "https://knesset.gov.il/OdataV4/ParliamentInfo";
export const V3 = "https://knesset.gov.il/Odata/ParliamentInfo.svc";

const UA = { "User-Agent": "compass-harvester/0.1", "Accept": "application/json" };

export class OdataError extends Error {
  constructor(msg, { url, status, body } = {}) {
    super(msg); this.name = "OdataError"; this.url = url; this.status = status; this.body = body;
  }
}

async function backoff(attempt) {
  const ms = Math.min(16000, 2000 * Math.pow(2, attempt));
  await new Promise(r => setTimeout(r, ms));
}

/** GET with retries. Network errors retry; 4xx do not. */
export async function get(url, { json = true, retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: json ? UA : { "User-Agent": UA["User-Agent"] } });
      if (res.status >= 400 && res.status < 500) {
        const body = (await res.text()).slice(0, 500);
        throw new OdataError(`HTTP ${res.status} (not retried)`, { url, status: res.status, body });
      }
      if (!res.ok) throw new OdataError(`HTTP ${res.status}`, { url, status: res.status });
      return json ? await res.json() : await res.text();
    } catch (err) {
      if (err instanceof OdataError && err.status >= 400 && err.status < 500) throw err;
      lastErr = err;
      if (attempt < retries) await backoff(attempt);
    }
  }
  throw new OdataError(`failed after retries: ${lastErr?.message}`, { url });
}

/* ---------------- $metadata ----------------
   מפרסר XML בלי תלות חיצונית. מספיק לשמות ישויות, שדות וטיפוסים. */
export function parseMetadata(xml) {
  const entityTypes = {};
  const enums = {};

  const etRe = /<EntityType\b[^>]*\bName="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g;
  for (let m; (m = etRe.exec(xml)); ) {
    const [, name, body] = m;
    const props = {};
    const pRe = /<Property\b[^>]*\bName="([^"]+)"[^>]*\bType="([^"]+)"[^>]*\/?>/g;
    for (let p; (p = pRe.exec(body)); ) props[p[1]] = p[2];
    const keys = [];
    const kRe = /<Key>([\s\S]*?)<\/Key>/;
    const km = kRe.exec(body);
    if (km) { const rRe = /<PropertyRef\b[^>]*\bName="([^"]+)"/g; for (let r; (r = rRe.exec(km[1])); ) keys.push(r[1]); }
    entityTypes[name] = { properties: props, keys };
  }

  const enRe = /<EnumType\b[^>]*\bName="([^"]+)"[^>]*>([\s\S]*?)<\/EnumType>/g;
  for (let m; (m = enRe.exec(xml)); ) {
    const [, name, body] = m;
    const members = {};
    const mRe = /<Member\b[^>]*\bName="([^"]+)"(?:[^>]*\bValue="([^"]+)")?/g;
    for (let e; (e = mRe.exec(body)); ) members[e[1]] = e[2] ?? null;
    enums[name] = members;
  }

  const sets = {};
  const esRe = /<EntitySet\b[^>]*\bName="([^"]+)"[^>]*\bEntityType="([^"]+)"/g;
  for (let m; (m = esRe.exec(xml)); ) sets[m[1]] = m[2].split(".").pop();

  return { entityTypes, enums, entitySets: sets };
}

export async function loadMetadata(base = V4) {
  const xml = await get(`${base}/$metadata`, { json: false });
  const meta = parseMetadata(xml);
  if (!Object.keys(meta.entitySets).length)
    throw new OdataError("$metadata parsed but no EntitySet found — the service shape changed", { url: `${base}/$metadata` });
  return { xml, ...meta };
}

/** Resolve a field by trying candidate names against the discovered schema. */
export function resolveField(meta, entityType, candidates, { required = true } = {}) {
  const et = meta.entityTypes[entityType];
  if (!et) {
    if (!required) return null;
    throw new OdataError(`entity type ${entityType} is absent from $metadata`);
  }
  const names = Object.keys(et.properties);
  for (const c of candidates) {
    const hit = names.find(n => n.toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  if (!required) return null;
  throw new OdataError(
    `none of [${candidates.join(", ")}] exist on ${entityType}. Available: ${names.join(", ")}`);
}

/* ---------------- paging + cache (סעיף 7.2: הרצה חוזרת לא מושכת מחדש) ---------------- */
export async function pageAll(url, { onPage, limit = Infinity } = {}) {
  let next = url, seen = 0, pages = 0;
  while (next && seen < limit) {
    const body = await get(next);
    const rows = body.value ?? [];
    seen += rows.length; pages++;
    if (onPage) await onPage(rows, { pages, seen });
    next = body["@odata.nextLink"] ?? body["odata.nextLink"] ?? null;
    if (next && !/^https?:/i.test(next)) next = new URL(next, url).toString();
  }
  return { rows: seen, pages };
}

export async function cached(cacheDir, name, producer, { force = false } = {}) {
  await mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${name}.jsonl`);
  if (!force) {
    try {
      const s = await stat(file);
      if (s.size > 0) {
        const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
        return { file, rows: lines.map(l => JSON.parse(l)), fromCache: true };
      }
    } catch { /* לא במטמון */ }
  }
  const out = createWriteStream(file, { flags: "w" });
  const rows = [];
  await producer(async batch => {
    for (const r of batch) { rows.push(r); out.write(JSON.stringify(r) + "\n"); }
  });
  await new Promise(res => out.end(res));
  return { file, rows, fromCache: false };
}

export const iso = d => (d ? String(d).slice(0, 10) : null);
