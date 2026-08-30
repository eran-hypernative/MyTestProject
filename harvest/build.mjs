#!/usr/bin/env node
/* מצפן — עיבוד. סעיפים 7.2 ו-7.3.
 *
 *   node harvest/build.mjs --knesset 25
 *
 * קורא מהמטמון, מצליב הצבעה לסיעה לפי תאריך ההצבעה, מחשב לכידות סיעתית,
 * מתייג ציר ראשוני לפי מילון מונחים, ומוציא תור סקירה שבו direction ו-magnitude ריקים.
 * הקידוד הוא עבודת אדם. הסקריפט לא ממלא אותו.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveField, iso } from "./odata.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "cache");
const DATA = path.join(ROOT, "data");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i+1]; };
const KNESSET = Number(arg("knesset", 25));

async function jsonl(name) {
  try { return (await readFile(path.join(CACHE, `${name}.jsonl`), "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch { throw new Error(`המטמון ${name}.jsonl חסר. הרץ קודם: node harvest/harvest.mjs pull --knesset ${KNESSET}`); }
}
/* בוחר שדה לפי שמות מועמדים, מתוך רשומה אמיתית ולא מתוך הנחה */
function pick(row, candidates, { required = true, label = "" } = {}) {
  const keys = Object.keys(row ?? {});
  for (const c of candidates) { const hit = keys.find(k => k.toLowerCase() === c.toLowerCase()); if (hit) return hit; }
  if (!required) return null;
  throw new Error(`לא נמצא שדה ${label || candidates[0]}. מועמדים: ${candidates.join(", ")}. קיים ברשומה: ${keys.join(", ")}`);
}

/* ---------------- מילון תיוג ראשוני (סעיף 7.2) ----------------
   התיוג הזה הוא הצעה לעורך בלבד. הוא לא קובע כיוון ולא עוצמה. */
const AXIS_LEXICON = {
  economy: ["תקציב","מס ","מסים","מיסוי","קצבה","קצבאות","שכר מינימום","הפרטה","סובסידי","פיקוח מחירים","תמיכות","מענק","היטל","אגרה","הסדרים","גירעון","דיור","פנסיה","ארנונה"],
  security: ["ביטחון","צה\"ל","צבא","מבצע","התיישבות","הסדרה","שטחים","ריבונות","גבול","טרור","מילואים","שב\"כ","הסכם שלום"],
  religion_state: ["דת","רבנות","כשרות","שבת","גיור","נישואים","ישיבות","תורתו אומנותו","מרכולים","חינוך מוכר","מקוואות","עירוב"],
  governance: ["בג\"ץ","בית המשפט","יועץ משפטי","היועמ\"ש","עילת הסבירות","פסקת ההתגברות","חוק יסוד","ועדה לבחירת שופטים","מבקר המדינה","ועדת חקירה","חסינות"]
};
/* נושאים שיושבים על תפר בין צירים — האפיון מונה אותם במפורש */
const CONTESTED = ["גיוס","כולל","כוללים","חינוך מוכר","תקציב ייעודי","תקציבים ייעודיים","תורתו אומנותו","ישיבות","הסדר הגיוס"];

const norm = s => (s ?? "").replace(/\s+/g, " ").trim();
function tagAxes(title) {
  const t = norm(title);
  const hits = [];
  for (const [axis, words] of Object.entries(AXIS_LEXICON)) if (words.some(w => t.includes(w))) hits.push(axis);
  return hits;
}
const isContested = title => CONTESTED.some(w => norm(title).includes(w));

/* ---------------- שיוך לפי תאריך (סעיף 3.1 + 7.2) ----------------
   זו התקלה שהורגת את רוב הניתוחים מהסוג הזה: שיוך לפי החברות הנוכחית
   במקום לפי החברות ביום ההצבעה. */
export function buildMemberships(positions, F) {
  const rows = [];
  for (const p of positions) {
    const pid = p[F.posPerson], fid = p[F.posFaction];
    if (!pid || !fid) continue;
    rows.push({ person_id: String(pid), faction_id: String(fid), start_date: iso(p[F.posStart]), end_date: iso(p[F.posFinish]) });
  }
  return rows;
}
export function factionAt(memberships, person_id, date) {
  const pid = String(person_id);
  const m = memberships.find(m => m.person_id === pid && m.start_date && m.start_date <= date && (!m.end_date || date <= m.end_date));
  return m ? m.faction_id : null;
}

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  const [factions, persons, positions, votes, results] =
    await Promise.all(["KNS_Faction","KNS_Person","KNS_PersonToPosition","KNS_PlenumVote","KNS_PlenumVoteResult"].map(jsonl));

  const F = {
    facId:     pick(factions[0],  ["FactionID","Id"], { label:"FactionID" }),
    facName:   pick(factions[0],  ["Name","FactionName"], { label:"Faction Name" }),
    perId:     pick(persons[0],   ["PersonID","Id"], { label:"PersonID" }),
    perFirst:  pick(persons[0],   ["FirstName"], { required:false }),
    perLast:   pick(persons[0],   ["LastName"], { required:false }),
    perName:   pick(persons[0],   ["Name","PersonName"], { required:false }),
    posPerson: pick(positions[0], ["PersonID"], { label:"PersonID on position" }),
    posFaction:pick(positions[0], ["FactionID"], { label:"FactionID on position" }),
    posStart:  pick(positions[0], ["StartDate"], { label:"StartDate" }),
    posFinish: pick(positions[0], ["FinishDate","EndDate"], { required:false }),
    voteId:    pick(votes[0],     ["VoteID","PlenumVoteID","Id"], { label:"VoteID" }),
    voteDate:  pick(votes[0],     ["VoteDate","SessionDate","Date"], { label:"VoteDate" }),
    voteTitle: pick(votes[0],     ["SessionItemDsc","Description","Name","ItemDsc","Title"], { label:"vote title" }),
    resVote:   pick(results[0],   ["VoteID","PlenumVoteID"], { label:"VoteID on result" }),
    resPerson: pick(results[0],   ["PersonID"], { label:"PersonID on result" }),
    resValue:  pick(results[0],   ["VoteValue","ResultTypeID","ResultType"], { label:"VoteValue" })
  };
  console.log("שדות שזוהו:", JSON.stringify(F, null, 2));

  const memberships = buildMemberships(positions, F);
  const facName = new Map(factions.map(f => [String(f[F.facId]), f[F.facName]]));
  const personName = new Map(persons.map(p => [String(p[F.perId]),
    F.perName ? p[F.perName] : [p[F.perFirst], p[F.perLast]].filter(Boolean).join(" ")]));

  const byVote = new Map();
  for (const r of results) {
    const k = String(r[F.resVote]);
    if (!byVote.has(k)) byVote.set(k, []);
    byVote.get(k).push(r);
  }

  /* מיפוי ערכי ההצבעה. נטען מדוח הסכימה אם קיים שם enum, אחרת נשאר גולמי
     ומסומן כדורש אימות — האפיון אוסר להניח את הקידוד. */
  let voteMap = null;
  try {
    const rep = JSON.parse(await readFile(path.join(DATA, "schema-report.json"), "utf8"));
    if (rep?.voteValue?.enumMembers) voteMap = rep.voteValue.enumMembers;
  } catch { /* אין דוח */ }

  const queue = [];
  let unresolved = 0;
  for (const v of votes) {
    const vid = String(v[F.voteId]);
    const date = iso(v[F.voteDate]);
    const title = norm(v[F.voteTitle]);
    if (!date) continue;
    const rows = byVote.get(vid) ?? [];
    if (!rows.length) continue;

    /* קיבוץ לפי הסיעה שבה ישב הח"כ ביום ההצבעה */
    const perFaction = new Map();
    for (const r of rows) {
      const fid = factionAt(memberships, r[F.resPerson], date);
      if (!fid) { unresolved++; continue; }
      if (!perFaction.has(fid)) perFaction.set(fid, []);
      perFaction.get(fid).push(String(r[F.resValue]));
    }

    const axes = tagAxes(title);
    for (const [fid, vals] of perFaction) {
      const counts = vals.reduce((a, v) => (a[v] = (a[v] ?? 0) + 1, a), {});
      const [topVal, topN] = Object.entries(counts).sort((a,b) => b[1]-a[1])[0];
      const cohesion = topN / vals.length;
      queue.push({
        evidence_id: `v${vid}-${fid}`,
        faction_id: fid,
        faction_name: facName.get(fid) ?? "",
        type: "vote",
        bucket: "actual",
        title,
        date,
        source_url: `https://knesset.gov.il/OdataV4/ParliamentInfo/KNS_PlenumVote(${vid})`,
        source_tier: 1,
        raw_vote_value: topVal,
        vote_value_label: voteMap ? (Object.entries(voteMap).find(([,val]) => String(val) === topVal)?.[0] ?? "") : "",
        members_voting: vals.length,
        cohesion: cohesion.toFixed(3),
        axis_suggested: axes.join("|"),
        contested_topic: isContested(title) ? "TRUE" : "FALSE",
        direction: "",   /* העורך ממלא */
        magnitude: "",   /* העורך ממלא */
        coded_by: "",
        coded_at: ""
      });
    }
  }

  /* סעיף 7.3: המשמעותיים למעלה — קודם שנויים במחלוקת, אחר כך סיעות מלוכדות, אחר כך לפי תאריך */
  queue.sort((a, b) =>
    (b.contested_topic === "TRUE") - (a.contested_topic === "TRUE") ||
    Number(b.cohesion) - Number(a.cohesion) ||
    (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  await mkdir(DATA, { recursive: true });
  const cols = Object.keys(queue[0] ?? { evidence_id:"" });
  const csv = [cols.join(","), ...queue.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\n");
  await writeFile(path.join(DATA, "review-queue.csv"), "﻿" + csv, "utf8");

  const dataset = {
    knesset: KNESSET,
    generated_at: new Date().toISOString(),
    source: "Knesset OData v4 (ParliamentInfo)",
    vote_value_map_verified: !!voteMap,
    persons: [...personName].map(([person_id, name]) => ({ person_id, name })),
    factions: factions.map(f => ({ faction_id: String(f[F.facId]), name: f[F.facName], letters: null, knesset_num: KNESSET })),
    memberships,
    evidence: []   /* מתמלא רק מפריטים שהעורך קידד. אין ראיות, אין נקודה. */
  };
  await writeFile(path.join(DATA, "dataset.json"), JSON.stringify(dataset, null, 2), "utf8");

  console.log(`\nתור סקירה: ${queue.length} שורות -> data/review-queue.csv`);
  console.log(`מתוכן שנויות במחלוקת: ${queue.filter(r => r.contested_topic === "TRUE").length}`);
  console.log(`ללא תיוג ציר אוטומטי: ${queue.filter(r => !r.axis_suggested).length} (העורך יתייג ידנית)`);
  if (unresolved) console.log(`⚠ ${unresolved} תוצאות הצבעה לא שויכו לסיעה בתאריך ההצבעה. יש לבדוק חוסרים ב-KNS_PersonToPosition.`);
  if (!voteMap) console.log("⚠ קידוד VoteValue לא אומת מול $metadata. ערכי ההצבעה נשמרו גולמיים.");
  console.log("\nמצב המפה: אפס פריטים מקודדים, ולכן אפס נקודות. זו התצוגה הנכונה עד שהקידוד ייעשה.");
}

/* רץ רק כשמריצים את הקובץ ישירות, כדי שאפשר יהיה לייבא ממנו לבדיקות */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch(err => { console.error("\n✖ " + err.message + "\n"); process.exit(1); });
