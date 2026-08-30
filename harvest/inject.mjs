#!/usr/bin/env node
/* מצפן — הזרקת הפנקס המקודד אל האפליקציה.
 *
 *   node harvest/inject.mjs
 *
 * קורא את data/dataset.json ואת השורות המקודדות ב-data/review-queue.csv,
 * ומחליף את הבלוק שבין הסימנים DATASET:BEGIN ו-DATASET:END ב-app/index.html.
 * שורה בלי direction או בלי magnitude אינה נכנסת כפריט מקודד: היא נספרת בכיסוי בלבד.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "app", "index.html");
const BEGIN = "/* ==== DATASET:BEGIN";
const END = "/* ==== DATASET:END ==== */";

/* פרסר CSV מינימלי שמכבד מרכאות כפולות */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.length > 1);
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const num = v => (v === "" || v === undefined || v === null ? null : Number(v));

async function main() {
  const dataset = JSON.parse(await readFile(path.join(ROOT, "data", "dataset.json"), "utf8"));
  let queue = [];
  try { queue = parseCsv(await readFile(path.join(ROOT, "data", "review-queue.csv"), "utf8")); }
  catch { console.log("אין תור סקירה. מוזרק פנקס בלי פריטים."); }

  let coded = 0, skipped = 0, bad = 0;
  const evidence = [];
  for (const r of queue) {
    const dir = num(r.direction), mag = num(r.magnitude);
    const hasCoding = dir !== null && mag !== null;
    if (hasCoding && ![1, -1].includes(dir)) { bad++; continue; }
    if (hasCoding && !(mag >= 0 && mag <= 100)) { bad++; continue; }
    if (!r.axis_final && !r.axis_suggested) { skipped++; continue; }
    if (hasCoding) coded++; else skipped++;
    evidence.push({
      id: r.evidence_id,
      faction_id: r.faction_id,
      person_id: null,
      axis: r.axis_final || r.axis_suggested.split("|")[0],
      type: r.type || "vote",
      bucket: r.bucket || "actual",
      title: r.title,
      summary: r.summary || "",
      date: r.date,
      source_url: r.source_url || null,
      source_tier: Number(r.source_tier || 1),
      amount_nis: num(r.amount_nis),
      stance: r.stance || null,
      cohesion: num(r.cohesion),
      contested_topic: String(r.contested_topic).toUpperCase() === "TRUE",
      direction: hasCoding ? dir : null,
      magnitude: hasCoding ? mag : 0,
      coded_by: r.coded_by || null,
      coded_at: r.coded_at || null
    });
  }

  const payload = {
    source: dataset.source, knesset: dataset.knesset,
    generated_at: dataset.generated_at,
    vote_value_map_verified: !!dataset.vote_value_map_verified,
    persons: dataset.persons ?? [], factions: dataset.factions ?? [],
    memberships: dataset.memberships ?? [], baselines: dataset.baselines ?? [],
    evidence
  };

  const html = await readFile(APP, "utf8");
  const a = html.indexOf(BEGIN), b = html.indexOf(END);
  if (a === -1 || b === -1) throw new Error(`הסימנים DATASET:BEGIN/END לא נמצאו ב-${path.relative(ROOT, APP)}`);
  const blockStart = html.lastIndexOf("\n", a) + 1;
  const blockEnd = b + END.length;
  const block = `${BEGIN} — הוזרק אוטומטית, אין לערוך ידנית ==== */\nconst REAL_DATASET = ${JSON.stringify(payload)};\n${END}`;
  await writeFile(APP, html.slice(0, blockStart) + block + html.slice(blockEnd), "utf8");

  console.log(`הוזרקו ${evidence.length} פריטים: ${coded} מקודדים, ${skipped} ללא קידוד (נספרים בכיסוי בלבד).`);
  if (bad) console.log(`⚠ ${bad} שורות נדחו: direction חייב להיות 1 או מינוס 1, ו-magnitude בין 0 ל-100.`);
  if (!coded) console.log("אין פריטים מקודדים, ולכן לא תוצג אף נקודה. זו התצוגה הנכונה.");
  if (!payload.vote_value_map_verified) console.log("⚠ קידוד VoteValue לא אומת מול $metadata.");
}

main().catch(err => { console.error("\n✖ " + err.message + "\n"); process.exit(1); });
