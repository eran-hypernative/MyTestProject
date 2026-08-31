#!/usr/bin/env node
/* מצפן — הרבסטר. סעיף 7 באפיון.
 *
 *   node harvest/harvest.mjs probe                 בדיקת סכימה בלבד. לא מושך נתונים.
 *   node harvest/harvest.mjs size  --knesset 25     כמה שורות יש בחלון, בלי למשוך
 *   node harvest/harvest.mjs pull  --knesset 25     משיכה למטמון
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
const today = () => new Date().toISOString().slice(0, 10);

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
    const field = resolveField(meta, NEEDED.voteResults, ["ResultCode", "VoteValue", "ResultTypeID", "ResultType", "VoteResult"], { required: false });
    const type = field ? meta.entityTypes[NEEDED.voteResults].properties[field] : null;
    const enumName = type && type.includes(".") ? type.split(".").pop() : null;
    report.voteValue = { field, type, enumMembers: enumName ? (meta.enums[enumName] ?? null) : null };
    const descField = resolveField(meta, NEEDED.voteResults, ["ResultDesc"], { required: false });
    report.voteValue.descField = descField;
    console.log(`\nערך ההצבעה: field=${field ?? "לא נמצא"} type=${type ?? "-"}`);
    if (report.voteValue.enumMembers) console.log("  enum: " + JSON.stringify(report.voteValue.enumMembers));
    else if (descField) console.log(`  אין enum ב-$metadata, אך קיים ${descField}. המיפוי ייגזר מהנתונים עצמם ויוצג לאישור.`);
    else console.log("  אין enum ואין שדה תיאור. יש למפות ידנית לפני קידוד.");
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

/* ---------------- חלון תאריכים ----------------
   נגזר מטבלת הסיעות של אותה כנסת, ולא מתאריך שהוקלד מהזיכרון. */
async function windowFor(meta) {
  const rows = (await cached(CACHE, NEEDED.factions, async () => {}, { force: false })).rows;
  const sf = resolveField(meta, NEEDED.factions, ["StartDate"]);
  const starts = rows.map(r => iso(r[sf])).filter(Boolean).sort();
  const from = String(flag("from", starts[0] ?? null) ?? "");
  const to = String(flag("to", today()));
  if (!from) throw new OdataError("לא ניתן לגזור תאריך פתיחה מטבלת הסיעות. יש להעביר --from");
  return { from, to };
}

/* ---------------- size ----------------
   שואל את השרת כמה שורות יש בחלון, לפני שמושכים משהו. */
async function size() {
  const meta = await loadMetadata(V4);
  const win = await windowFor(meta);
  const vDate = resolveField(meta, NEEDED.votes, ["VoteDateTime", "VoteDate", "SessionDate"]);
  const rDate = resolveField(meta, NEEDED.voteResults, ["VoteDate", "VoteDateTime"]);
  console.log(`חלון: ${win.from} עד ${win.to}`);
  for (const [label, et, f] of [
    ["הצבעות", NEEDED.votes, `${vDate} ge ${win.from}T00:00:00Z and ${vDate} le ${win.to}T23:59:59Z`],
    ["תוצאות", NEEDED.voteResults, `${rDate} ge ${win.from}T00:00:00Z and ${rDate} le ${win.to}T23:59:59Z`]
  ]) {
    const url = `${V4}/${et}?$filter=${encodeURIComponent(f)}&$count=true&$top=0`;
    const body = await get(url);
    const n = body["@odata.count"] ?? "לא ידוע";
    console.log(`  ${label}: ${n} שורות` + (typeof n === "number" ? `  (בערך ${Math.ceil(n/100)} עמודים, ${Math.ceil(n/100*0.4/60)} דקות)` : ""));
  }
  console.log("\nלצמצום: --from YYYY-MM-DD  או  --to YYYY-MM-DD");
}

/* ---------------- pull ---------------- */
async function pull() {
  const meta = await probe();
  console.log(`\nמושך כנסת ${KNESSET}${FORCE ? " (מתעלם מהמטמון)" : ""}`);

  const knessetField = et => resolveField(meta, et, ["KnessetNum", "KnessetNumber", "Knesset"], { required: false });

  async function fetchSet(role, { filter = null, select = null, cacheName = null, label = null } = {}) {
    const et = NEEDED[role];
    const name = cacheName ?? et;
    const tag = label ?? et;
    const parts = [];
    if (filter) parts.push(`$filter=${encodeURIComponent(filter)}`);
    if (select) parts.push(`$select=${encodeURIComponent(select)}`);
    const url = `${V4}/${et}${parts.length ? "?" + parts.join("&") : ""}`;
    const t0 = Date.now();
    const res = await cached(CACHE, name, async write => {
      await pageAll(url, { onPage: async (rows, info) => {
        await write(rows);
        if (info.pages % 10 === 0) {
          const secs = (Date.now() - t0) / 1000;
          process.stdout.write(`\r  ${tag}: ${info.seen} שורות, ${info.pages} עמודים, ${secs.toFixed(0)} שניות   `);
        }
      }});
    }, { force: FORCE });
    process.stdout.write("\r" + " ".repeat(72) + "\r");
    console.log(`  ${tag}: ${res.rows.length} שורות${res.fromCache ? " (מהמטמון)" : ` ב-${((Date.now()-t0)/1000).toFixed(0)} שניות`}`);
    return res.rows;
  }

  /* חיתוך לחודשים: קובץ מטמון לכל חודש, כדי שנפילה תעלה חודש אחד ולא הכל,
     והרצה חוזרת תמשיך מהמקום שבו נעצרה. */
  function months(from, to) {
    const out = [];
    let [y, m] = from.split("-").map(Number);
    const [ey, em] = to.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      const pad = n => String(n).padStart(2, "0");
      const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
      out.push({ key: `${y}-${pad(m)}`, start: `${y}-${pad(m)}-01`, end: `${ny}-${pad(nm)}-01` });
      [y, m] = [ny, nm];
    }
    return out;
  }

  const kf = knessetField(NEEDED.factions);
  const kp = knessetField(NEEDED.positions);

  await fetchSet("factions",  { filter: kf ? `${kf} eq ${KNESSET}` : null });
  await fetchSet("persons");
  await fetchSet("positions", { filter: kp ? `${kp} eq ${KNESSET}` : null });

  /* KNS_PlenumVote ו-KNS_PlenumVoteResult אינם נושאים KnessetNum. בלי חסם הם
     נמשכים על פני כל הכנסות אי פעם. חוסמים לפי חלון תאריכים שנגזר מהסיעות. */
  const win = await windowFor(meta);
  console.log(`  חלון: ${win.from} עד ${win.to}`);
  const vDate = resolveField(meta, NEEDED.votes, ["VoteDateTime", "VoteDate", "SessionDate"]);
  const rDate = resolveField(meta, NEEDED.voteResults, ["VoteDate", "VoteDateTime"]);
  const vFilter = `${vDate} ge ${win.from}T00:00:00Z and ${vDate} le ${win.to}T23:59:59Z`;
  const rFilter = `${rDate} ge ${win.from}T00:00:00Z and ${rDate} le ${win.to}T23:59:59Z`;

  await fetchSet("votes", { filter: vFilter });

  const chunks = months(win.from, win.to);
  console.log(`  תוצאות ההצבעה, ${chunks.length} חודשים:`);
  let total = 0;
  for (const [i, c] of chunks.entries()) {
    const f = `${rDate} ge ${c.start}T00:00:00Z and ${rDate} lt ${c.end}T00:00:00Z`;
    const rows = await fetchSet("voteResults", {
      filter: f, select: "Id,MkId,VoteID,VoteDate,ResultCode,ResultDesc",
      cacheName: `${NEEDED.voteResults}/${c.key}`, label: `${c.key} (${i + 1}/${chunks.length})`
    });
    total += rows.length;
  }
  console.log(`  סך הכל ${total} תוצאות הצבעה`);

  console.log(`\nהמטמון: ${path.relative(ROOT, CACHE)}. הרצה חוזרת לא תמשוך מחדש בלי --force.`);
  console.log("השלב הבא:  node harvest/build.mjs --knesset " + KNESSET);
}

try {
  if (cmd === "probe") await probe();
  else if (cmd === "size") await size();
  else if (cmd === "pull") await pull();
  else { console.error(`פקודה לא מוכרת: ${cmd}. השתמש ב-probe, size או pull.`); process.exit(1); }
} catch (err) { die(err); }
