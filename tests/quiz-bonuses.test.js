"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildBonuses } = require("../scripts/quiz-bonuses.js");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-bonus-"));
  fs.writeFileSync(path.join(dir, "0.json"), JSON.stringify({
    0: [10, [["Big Club", 2010, 2014, 100]]],
    1: [11, [["Remote Club", 2004, 2006, 44]]],
    2: [12, [["Remote Club", 2004, 2006, 38]]],
    3: [13, [["Remote Club", 1990, 1992, 20]]],
    4: [14, [["Other Club", 1990, 1992, 0]]],
  }));
  const db = { nshards: 1, names: ["Obvious", "Niche One", "Niche Two", "Older", "Registered"],
    births: [1990, 1985, 1986, 1970, 1960], nats: ["IT", "DZ", "DZ", "IT", "FR"],
    clubs: [["Clue A", "IT", 1, "Q1"], ["Clue B", "IT", 1, "Q2"]] };
  const core = { qPools() {}, validateEntry: stages => ({ ok: true, stages }),
    qRanked: st => st.answers, uniqueChoices: arr => [...new Set(arr)], qUsableName: () => true,
    choiceIdentity: pid => `${db.names[pid]}\u0000${db.births[pid]}`,
    qApps: (_ci, pid) => pid === 4 ? 0 : 50,
    qBridgeFame: pid => pid === 1 || pid === 2 ? 100 : 300, qHash: () => 0, qRng: () => () => 0 };
  const st = answers => ({ clubs: [0, 1], answers });
  const schedule = { days: { "2026-11-11": [st([0, 1, 2, 3, 4]), st([0]), st([0]), st([0, 1, 2, 3])] } };
  return { dir, runtime: { index: db, core }, schedule };
}

test("career criteria award every qualifying answer and never alter generated questions", () => {
  const f = fixture();
  try {
    f.runtime.index.nats.fill("IT");
    const before = JSON.stringify(f.schedule.days);
    const bonus = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
    assert.equal(bonus.stage, 0);
    assert.equal(bonus.kind, "career");
    assert.equal(bonus.value, "Remote Club");
    assert.deepEqual(bonus.targets, ["Niche One\u00001985", "Niche Two\u00001986"]);
    assert.equal(JSON.stringify(f.schedule.days), before);
    const again = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
    assert.deepEqual(again, bonus);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("published criteria stay fixed when selection preferences change", () => {
  const f = fixture();
  try {
    const bonuses = buildBonuses(f.runtime, f.schedule, {}, f.dir);
    const old = { days: structuredClone(f.schedule.days), bonuses };
    f.runtime.core.qHash = () => 4;
    assert.deepEqual(buildBonuses(f.runtime, f.schedule, old, f.dir), bonuses);
    old.bonuses["2026-11-11"] = null;
    assert.equal(buildBonuses(f.runtime, f.schedule, old, f.dir)["2026-11-11"], null);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("nationality and birth criteria are available, and Impossible is never selected", () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.dir, "0.json"));
    assert.equal(buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"].kind, "nationality");
    f.runtime.index.nats.fill("IT");
    assert.equal(buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"].kind, "birth");
    f.schedule.days["2026-11-11"].slice(0, 3).forEach(st => { st.answers = [0]; });
    assert.equal(buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"], null);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("the tie-break cannot displace a more distinctive answer subset", () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, "0.json"), careers = JSON.parse(fs.readFileSync(file));
    careers[2][1] = [];
    fs.writeFileSync(file, JSON.stringify(careers));
    for (let hash = 0; hash < 5; hash++) {
      f.runtime.core.qHash = () => hash;
      const bonus = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
      assert.equal(bonus.kind, "career");
      assert.equal(bonus.from, 2004);
      assert.deepEqual(bonus.targets, ["Niche One\u00001985"]);
    }
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

function contrastingClues(f, apps, dated = true) {
  fs.writeFileSync(path.join(f.dir, "0.json"), JSON.stringify({
    1: [11, [["Remote Club", dated ? 2004 : null, dated ? 2006 : null, apps]]],
    2: [12, [["Remote Club", dated ? 2004 : null, dated ? 2006 : null, apps]]],
  }));
  f.runtime.index.nats = ["IT", "FR", "FR", "DZ", "IT"];
  f.runtime.core.qBridgeFame = pid => pid === 3 ? 120 : 300;
}

test("a more distinctive nationality beats a less distinctive career clue", () => {
  const f = fixture();
  try {
    contrastingClues(f, 5, false);
    const bonus = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
    assert.equal(bonus.kind, "nationality");
    assert.equal(bonus.value, "DZ");
    assert.deepEqual(bonus.targets, ["Older\u00001970"]);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("recent variety breaks comparable ties, but cannot displace a better nationality", () => {
  const f = fixture();
  try {
    f.runtime.core.qRng = () => () => .46;
    const entry = f.schedule.days["2026-11-11"];
    const initial = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
    assert.equal(initial.kind, "nationality");
    // Deliberately reverse the input dates: diversity follows calendar order.
    f.schedule.days = { "2026-11-11": entry, "2026-11-10": entry };
    const previous = { days: { "2026-11-10": structuredClone(entry) }, bonuses: { "2026-11-10": initial } };
    const diverse = buildBonuses(f.runtime, f.schedule, previous, f.dir);
    assert.equal(diverse["2026-11-11"].kind, "career", "recency can tip a draw between equal answer subsets");
    contrastingClues(f, 100);
    const strong = buildBonuses(f.runtime, f.schedule, previous, f.dir);
    assert.equal(strong["2026-11-11"].kind, "nationality", "better subset wins even when nationality was used yesterday");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("recent use changes chances without forbidding repeats and decays with calendar distance", () => {
  const f = fixture();
  try {
    const entry = f.schedule.days["2026-11-11"];
    const nationality = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
    f.schedule.days["2026-11-10"] = entry;
    const previous = { days: { "2026-11-10": structuredClone(entry) }, bonuses: { "2026-11-10": nationality } };
    f.runtime.core.qRng = () => () => .1;
    assert.equal(buildBonuses(f.runtime, f.schedule, previous, f.dir)["2026-11-11"].kind, "nationality",
      "a recent nationality remains selectable rather than losing a hard tie-break");
    f.runtime.core.qRng = () => () => .46;
    assert.equal(buildBonuses(f.runtime, f.schedule, previous, f.dir)["2026-11-11"].kind, "career");
    f.schedule.days = { "2026-11-11": entry, "2026-10-12": entry };
    previous.days = { "2026-10-12": structuredClone(entry) };
    previous.bonuses = { "2026-10-12": nationality };
    assert.equal(buildBonuses(f.runtime, f.schedule, previous, f.dir)["2026-11-11"].kind, "nationality",
      "the same old result should not have yesterday's influence");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("equal-quality schedules are reproducible and allow varied run lengths rather than a fixed cycle", () => {
  const f = fixture();
  try {
    const actualCore = require("../scripts/quiz-schedule.js").loadRuntime().core;
    f.runtime.core.qHash = actualCore.qHash;
    f.runtime.core.qRng = actualCore.qRng;
    const entry = f.schedule.days["2026-11-11"];
    f.schedule.days = {};
    for (let n = 0; n < 40; n++) {
      const day = new Date(Date.UTC(2026, 10, 11 + n)).toISOString().slice(0, 10);
      f.schedule.days[day] = entry;
    }
    const first = buildBonuses(f.runtime, f.schedule, {}, f.dir);
    f.schedule.days = Object.fromEntries(Object.entries(f.schedule.days).reverse());
    assert.deepEqual(buildBonuses(f.runtime, f.schedule, {}, f.dir), first);
    const kinds = Object.values(first).map(b => b.kind), runs = [];
    kinds.forEach((kind, i) => {
      if (i && kinds[i - 1] === kind) runs[runs.length - 1]++;
      else runs.push(1);
    });
    assert.equal(new Set(kinds).size, 2);
    assert.ok(runs.includes(1), "single-day runs remain possible");
    assert.ok(runs.some(n => n >= 2), "consecutive repeats remain possible");
    assert.ok(new Set(runs).size > 1, "run lengths are not a forced four-day cycle");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("career dates, appearances and additional spells do not buy a head start over the same nationality subset", () => {
  const f = fixture();
  try {
    for (const apps of [5, 100]) {
      const spells = Array.from({ length: 15 }, (_, i) => [`Remote Club ${i}`, 2004, 2006, apps]);
      fs.writeFileSync(path.join(f.dir, "0.json"), JSON.stringify({ 1: [11, spells], 2: [12, spells] }));
      const bonus = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
      assert.equal(bonus.kind, "nationality");
      assert.deepEqual(bonus.targets, ["Niche One\u00001985", "Niche Two\u00001986"]);
    }
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("a birth-only Easy waits for nationality or career on later stages before falling back", () => {
  const f = fixture();
  try {
    const db = f.runtime.index;
    db.names.push("Medium Niche", "Medium Other");
    db.births.push(1985, 1986);
    db.nats.push("IT", "IT"); db.nats.fill("IT");
    const entry = f.schedule.days["2026-11-11"];
    entry[0].answers = [0, 1, 3];
    entry[1].answers = [0, 5, 6];
    fs.writeFileSync(path.join(f.dir, "0.json"), JSON.stringify({ 5: [15, [["Medium Remote Club", 2004, 2006, 50]]] }));
    const medium = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
    assert.equal(medium.kind, "career");
    assert.equal(medium.stage, 1, "a usable medium career takes precedence over an easy birth decade");
    fs.unlinkSync(path.join(f.dir, "0.json"));
    const fallback = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
    assert.equal(fallback.kind, "birth");
    assert.equal(fallback.stage, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("an index supplied without career shards can still use its nationality and birth evidence", () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.dir, "0.json"));
    const bonus = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
    assert.equal(bonus.kind, "nationality");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("nationality clues name a single country and include players with multiple nationalities", () => {
  const f = fixture();
  try {
    f.runtime.index.nats = ["IT", "DZ,FR", "FR", "IT", "IT"];
    const bonus = buildBonuses(f.runtime, f.schedule, {}, f.dir)["2026-11-11"];
    assert.equal(bonus.kind, "nationality");
    assert.equal(bonus.value, "DZ");
    assert.deepEqual(bonus.targets, ["Niche One\u00001985"]);
    const previous = { days: structuredClone(f.schedule.days), bonuses: {
      "2026-11-11": { kind: "nationality", value: "FR", stage: 0, targets: [] },
    } };
    const french = buildBonuses(f.runtime, f.schedule, previous, f.dir)["2026-11-11"];
    assert.deepEqual(french.targets, ["Niche One\u00001985", "Niche Two\u00001986"]);
    previous.bonuses["2026-11-11"].value = "DZ,FR";
    const legacy = buildBonuses(f.runtime, f.schedule, previous, f.dir)["2026-11-11"];
    assert.deepEqual(legacy.targets, ["Niche One\u00001985"]);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
