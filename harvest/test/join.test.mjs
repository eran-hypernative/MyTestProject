/* בדיקות לצומת הקריטי: שיוך הצבעה לסיעה לפי תאריך ההצבעה.
   הרשומות כאן הן פיקסצ'רים לבדיקה, לא נתוני אמת. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMemberships, factionAt } from "../build.mjs";

const F = { posPerson:"PersonID", posFaction:"FactionID", posStart:"StartDate", posFinish:"FinishDate" };
const positions = [
  { PersonID: 1, FactionID: 10, StartDate: "2022-11-15T00:00:00", FinishDate: "2024-06-30T00:00:00" },
  { PersonID: 1, FactionID: 20, StartDate: "2024-07-01T00:00:00", FinishDate: null },
  { PersonID: 2, FactionID: 10, StartDate: "2022-11-15T00:00:00", FinishDate: null }
];
const m = buildMemberships(positions, F);

test("חברות נחתכת לתאריכים בלבד", () => {
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { person_id:"1", faction_id:"10", start_date:"2022-11-15", end_date:"2024-06-30" });
  assert.equal(m[1].end_date, null);
});

test("הצבעה לפני הפילוג נספרת לסיעה הישנה", () => {
  assert.equal(factionAt(m, 1, "2024-03-01"), "10");
});

test("הצבעה אחרי הפילוג נספרת לסיעה החדשה", () => {
  assert.equal(factionAt(m, 1, "2024-09-01"), "20");
});

test("גבולות הטווח כלולים משני הצדדים", () => {
  assert.equal(factionAt(m, 1, "2024-06-30"), "10");
  assert.equal(factionAt(m, 1, "2024-07-01"), "20");
});

test("תאריך לפני תחילת הכהונה אינו משויך", () => {
  assert.equal(factionAt(m, 1, "2022-01-01"), null);
});

test("חברות פתוחה תופסת כל תאריך עתידי", () => {
  assert.equal(factionAt(m, 2, "2026-08-30"), "10");
});

test("אדם שאינו במאגר מחזיר null ולא נופל", () => {
  assert.equal(factionAt(m, 999, "2024-01-01"), null);
});

test("השיוך אינו תלוי בסדר הרשומות", () => {
  const shuffled = buildMemberships([positions[1], positions[2], positions[0]], F);
  assert.equal(factionAt(shuffled, 1, "2024-03-01"), "10");
  assert.equal(factionAt(shuffled, 1, "2024-09-01"), "20");
});
