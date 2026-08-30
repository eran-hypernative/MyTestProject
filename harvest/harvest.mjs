#!/usr/bin/env node
/* מצפן — הרבסטר. סעיף 7 באפיון.
 *
 *   node harvest/harvest.mjs probe                 בדיקת סכימה בלבד. לא מושך נתונים.
 *   node harvest/harvest.mjs pull --knesset 25     משיכה מלאה למטמון
 *   node harvest/harvest.mjs pull --knesset 25 --force   התעלמות מהמטמון
 *
 * הסקריפט לא מניח שמות שדות. הוא מגלה אותם מ-$metadata, ואם הסכימה השתנתה
 * הוא נעצר ואומר מה בדיוק לא נמצא, במקום לכתוב שקט נתונים שגויים.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V4, V3, get, loadMetadata, resolveField, pageAll, cached, OdataError, iso } from "./odata.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "cache");

/* הישויות שהאפיון מונה בסעיף 7.1. v3 חי אך חסר את טבלאות ההצבעות — עובדים מול v4. */
const NEEDED = {
  factions:   "KNS_Faction",
  persons:    "KNS_Person",
  positions:  "KNS_PersonToPosition",
  votes:      "KNS_PlenumVote",
  voteResults:"KNS_PlenumVoteResult",
  bills:      "KNS_Bill",
  initiators: "KNS_BillInitiator",
  committees: "KNS_Committee"
};

const args = process.argv.slice(2);
const cmd = args[0] ?? "probe";
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : (args[i+1] ?? true); };
const has = name => args.includes(`--${name}`);
const KNESSET = Number(flag("knesset", 25));
const FORCE = has("force");

function die(err) {
  console.error("\n✖ " + (err?.message ?? err));
  if (err instanceof OdataError) {
    if (err.url) console.error("  url:    " + err.url);
    if (err.body) console.error("  body:   " + err.body);
  }
  console.error("\nלא נכתבו נתונים. אין לקדם קידוד על סכימה שלא אומתה.\n");
  process.exit(1);
}

/* ---------------- probe ---------------- */
async function probe() {
  console.log(`מאמת סכימה מול ${V4}/$metadata`);
  const meta = await loadMetadata(V4);
  const report = { base: V4, checkedAt: new Date().toISOString(), entities: {}, voteValue: null, missing: [] };

  for (const [role, et] of Object.entries(NEEDED)) {
    const present = !!meta.entityTypes[et];
    const inSets = Object.keys(meta.entitySets).includes(et);
    if (!present) report.missing.push(et);
    report.entities[role] = {
      entityType: et, presentInMetadata: present, exposedAsEntitySet: inSets,
      properties: present ? Object.keys(meta.entityTypes[et].properties) : [],
      keys: present ? meta.entityTypes[et].keys : []
    };
    console.log(`${present ? "✓" : "✖"} ${role.padEnd(12)} ${et}${present ? ` (${Object.keys(meta.entityTypes[et].properties).length} fields)` : " — לא נמצא"}`);
  }

  /* קידוד VoteValue — דרישה מפורשת בסעיף 7.1 */
  if (meta.entityTypes[NEEDED.voteResults]) {
    const field = resolveField(meta, NEEDED.voteResults, ["VoteValue", "ResultTypeID", "ResultType", "VoteResult"], { required: false });
    const type = field ? meta.entityTypes[NEEDED.voteResults].properties[field] : null;
    const enumName = type && type.includes(".") ? type.split(".").pop() : null;
    report.voteValue = { field, type, enumMembers: enumName ? (meta.enums[enumName] ?? null) : null };
    console.log(`\nVoteValue: field=${field ?? "לא נמצא"} type=${type ?? "-"}`);
    if (report.voteValue.enumMembers) console.log("  enum: " + JSON.stringify(report.voteValue.enumMembers));
    else console.log("  אין enum ב-$metadata. יש למפות את הערכים מול טבלת קודים לפני קידוד.");
  }

  await mkdir(path.join(ROOT, "data"), { recursive: true });
  const out = path.join(ROOT, "data", "schema-report.json");
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(`\nדוח סכימה נכתב אל ${path.relative(ROOT, out)}`);
  if (report.missing.length) {
    console.log(`\n⚠ חסרות ישויות: ${report.missing.join(", ")}. אין להמשיך למשיכה.`);
    process.exit(2);
  }
  return meta;
}

/* ---------------- pull ---------------- */
async function pull() {
  const meta = await probe();
  console.log(`\nמושך כנסת ${KNESSET}${FORCE ? " (מתעלם מהמטמון)" : ""}`);

  const knessetField = et => resolveField(meta, et, ["KnessetNum", "KnessetNumber", "Knesset"], { required: false });

  async function fetchSet(role, { filter = null, select = null, limit = Infinity } = {}) {
    const et = NEEDED[role];
    const parts = [];
    if (filter) parts.push(`$filter=${encodeURIComponent(filter)}`);
    if (select) parts.push(`$select=${encodeURIComponent(select)}`);
    const url = `${V4}/${et}${parts.length ? "?" + parts.join("&") : ""}`;
    const res = await cached(CACHE, et, async write => {
      const { rows, pages } = await pageAll(url, { onPage: write, limit });
      console.log(`  ${et}: ${rows} רשומות ב-${pages} עמודים`);
    }, { force: FORCE });
    if (res.fromCache) console.log(`  ${et}: ${res.rows.length} רשומות מהמטמון`);
    return res.rows;
  }

  const kf = knessetField(NEEDED.factions);
  const kp = knessetField(NEEDED.positions);
  const kv = knessetField(NEEDED.votes);

  await fetchSet("factions",  { filter: kf ? `${kf} eq ${KNESSET}` : null });
  await fetchSet("persons");
  await fetchSet("positions", { filter: kp ? `${kp} eq ${KNESSET}` : null });
  await fetchSet("votes",     { filter: kv ? `${kv} eq ${KNESSET}` : null });

  /* תוצאות ההצבעה הן הטבלה הגדולה. מושכים רק את ההצבעות של הכנסת הנבחרת. */
  const voteIdField = resolveField(meta, NEEDED.voteResults, ["PlenumVoteID", "VoteID", "PlenumSessionVoteID"], { required: false });
  if (!voteIdField) {
    console.log("\n⚠ לא זוהה שדה המקשר תוצאה להצבעה. יש לבדוק את דוח הסכימה ידנית.");
  } else {
    await fetchSet("voteResults");
    console.log(`  (קישור תוצאה להצבעה דרך ${voteIdField})`);
  }

  console.log(`\nהמטמון: ${path.relative(ROOT, CACHE)}. הרצה חוזרת לא תמשוך מחדש בלי --force.`);
  console.log("השלב הבא:  node harvest/build.mjs --knesset " + KNESSET);
}

try {
  if (cmd === "probe") await probe();
  else if (cmd === "pull") await pull();
  else { console.error(`פקודה לא מוכרת: ${cmd}. השתמש ב-probe או ב-pull.`); process.exit(1); }
} catch (err) { die(err); }
