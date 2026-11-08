"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { EASY_QIDS } = require("../site/quiz-core.js");
const { runtime } = require("./helpers/quiz-runtime.js");

const ROOT = path.resolve(__dirname, "..");
const SERIES_START = "2026-08-21";

test("published combinations stay playable and scoring stays internally consistent", () => {
  const { core } = runtime();
  const asset = JSON.parse(fs.readFileSync(path.join(ROOT, "site/data/quiz-schedule.json"), "utf8"));
  for (const [date, rows] of Object.entries(asset.days)) for (const qids of rows) {
    const [stage] = core.stagesFromQids([qids]);
    assert.ok(stage, `${date}: ${qids.join(" x ")} must resolve`);
    const ranked = core.rankedAnswers(stage);
    assert.equal(stage.ease, core.qEase(stage.clubs, stage.effective, stage.audience));
    assert.ok(ranked.length && core.qUsableName(ranked[0]) && stage.effective.includes(ranked[0]),
      `${date}: ${qids.join(" x ")} needs a usable representative`);
  }
});

test("combo metadata validates the actual representative", () => {
  const { DB, core } = runtime();
  const [stage] = core.generate(SERIES_START).stages;
  const info = core.qComboInfo(stage.clubs);
  assert.equal(info.face, core.qFace(stage));
  assert.equal(info.b, !!DB.births[info.face]);
  assert.equal(info.named, core.qUsableName(info.face));
});

test("generation is deterministic, classified, effective, and honors QID prior context", () => {
  const { core } = runtime();
  const first = core.generate(SERIES_START);
  assert.equal(first.num, 1);
  assert.deepEqual(core.generate(SERIES_START), first);
  assert.equal(first.stages.every((stage, i) => core.classifyStage(stage) === i), true);
  assert.equal(first.stages.every(stage => stage.effective.length > 0 && !stage.fallback), true);
  const previousDays = [{ date: first.date, stages: core.serializeStages(first.stages) }];
  const next = core.generate("2026-08-22", { previousDays });
  const yesterday = new Set(first.stages.flatMap(stage => stage.clubs));
  assert.equal(next.stages.every(stage => stage.clubs.every(ci => !yesterday.has(ci))), true);
});

test("representative answers do not repeat inside the rolling cooldown", () => {
  const { core } = runtime();
  const previousDays = [], lastSeen = new Map();
  for (let day = 0; day < 30; day++) {
    const date = new Date(Date.UTC(2026, 7, 21 + day)).toISOString().slice(0, 10);
    const result = core.generate(date, { previousDays: previousDays.slice(-core.constants.QCOMBO_DAYS) });
    for (const stage of result.stages) {
      const face = core.qFace(stage), previous = lastSeen.get(face);
      assert.equal(core.qUsableName(face), true);
      if (previous !== undefined) assert.equal(day - previous > core.constants.QFACE_GUARD_DAYS, true);
      lastSeen.set(face, day);
    }
    previousDays.push({ date, stages: core.serializeStages(result.stages) });
  }
});

test("validation rejects unresolved and repeated clubs", () => {
  const { core } = runtime();
  assert.equal(core.validateEntry([["Q-nope"]]).ok, false);
  const puzzle = core.generate(SERIES_START);
  const rows = core.serializeStages(puzzle.stages);
  rows[1][0] = rows[0][0];
  assert.equal(core.validateEntry(rows).ok, false);
});

test("schedule validation rejects missing stages and malformed club counts without throwing", () => {
  const { core } = runtime();
  for (const rows of [null, [], [[]], [["Q1422"]], [[], [], [], []],
    Array(4).fill(["Q1422", "Q631", "Q1543", "Q2641"])]) {
    assert.equal(core.validateEntry(rows).ok, false);
    assert.equal(core.stagesFromQids(rows), null);
  }
  const singleStage = core.serializeStages(core.generate(SERIES_START).stages).slice(0, 1);
  assert.ok(core.stagesFromQids(singleStage));
  assert.equal(core.validateEntry(singleStage).ok, false);
});

test("validation tolerates dropped or malformed prior days instead of throwing", () => {
  const { core } = runtime();
  const rows = core.serializeStages(core.generate(SERIES_START).stages);
  const previousDays = [
    { date: "2026-07-01", stages: [["Q-does-not-exist", "Q631"]] },
    { date: "not-a-date", stages: null },
    { date: "2026-07-02", stages: [{ clubs: ["Q2052", 999999] }] },
    null,
  ];
  const result = core.validateEntry(rows, { date: SERIES_START, previousDays });
  assert.equal(typeof result.ok, "boolean");
});

test("combination guard treats permutations as equal for 30 days", () => {
  const { core } = runtime();
  const first = core.generate(SERIES_START);
  const rows = core.serializeStages(first.stages);
  const reversed = rows.map(stage => [...stage].reverse());
  const previousDays = [{ date: SERIES_START, stages: rows }];
  assert.equal(core.constants.QCOMBO_DAYS, 30);
  assert.equal(core.validateEntry(reversed, { date: "2026-09-20", previousDays }).ok, false);
  const faceGuarded = core.validateEntry(reversed, { date: "2026-08-22", previousDays });
  assert.equal(faceGuarded.errors.some(error => error.includes("representative answer repeats")), true);
  assert.equal(core.validateEntry(reversed, { date: "2026-09-21", previousDays }).ok, true);
});

test("ini2-first targets survive reload and ini then selects a distinct identity", () => {
  const { DB, core } = runtime();
  const puzzle = core.generate(SERIES_START);
  const stage = puzzle.stages[0];
  const first = core.nextHintTarget(stage);
  const saved = JSON.parse(JSON.stringify({
    v: 2, date: puzzle.date, stage: 2, lives: 3, skipped: [1],
    hints: { nat: null, ini: null, ini2: 0 }, hintTargets: { ini2: first },
    guesses: [{ name: DB.names[first], pid: first, stage: 0, ok: true }],
  }));
  const restored = core.migrateState(saved, puzzle.stages);
  assert.equal(restored.stage, 2);
  assert.equal(restored.lives, 3);
  assert.deepEqual(restored.skipped, [1]);
  assert.equal(restored.hintTargets.ini2, first);
  assert.equal(restored.guesses[0].key, core.playerIdentity(first));
  const second = core.nextHintTarget(stage, [restored.hintTargets.ini2]);
  assert.notEqual(core.playerIdentity(second), core.playerIdentity(first));
});

test("v1 migration preserves cleared progress while backfilling state contracts", () => {
  const { DB, core } = runtime();
  const puzzle = core.generate(SERIES_START);
  const pid = core.face(puzzle.stages[0]);
  const legacy = { v: 1, date: puzzle.date, stage: 2, lives: 2, skipped: [1],
    hints: { ini: 0 }, guesses: [{ name: DB.names[pid], pid, stage: 0, ok: true }] };
  const migrated = core.migrateState(legacy, puzzle.stages);
  assert.equal(migrated.v, 2);
  assert.equal(migrated.stage, 2);
  assert.equal(migrated.lives, 2);
  assert.equal(migrated.guesses[0].ok, true);
  assert.equal(migrated.hintTargets.ini, core.face(puzzle.stages[0]));
});

test("saved guesses and hint targets follow identity when a refresh reorders player ids", () => {
  const { DB, core } = runtime();
  const original = 0, replacement = 1;
  const key = core.playerIdentity(original);
  const name = DB.names[original];
  for (const column of ["names", "births", "nats"])
    [DB[column][original], DB[column][replacement]] = [DB[column][replacement], DB[column][original]];
  const state = { v: 2, built: "old", hints: { ini: 0 },
    hintTargets: { ini: original }, hintTargetKeys: { ini: key },
    guesses: [{ pid: original, name, key, stage: 0, ok: true }] };
  const migrated = core.migrateState(state, []);
  assert.equal(migrated.guesses[0].pid, replacement);
  assert.equal(migrated.guesses[0].key, key);
  assert.equal(migrated.hintTargets.ini, replacement);
  assert.equal(migrated.built, DB.built);
});

test("a removed player cannot silently resolve to someone else in a saved game", () => {
  const { core } = runtime();
  const migrated = core.migrateState({ v: 2, guesses: [
    { pid: 0, name: "Removed Player", key: "Removed Player\u00001980\u0000IT", ok: true },
  ] }, []);
  assert.equal(migrated.guesses[0].pid, null);
  assert.equal(migrated.guesses[0].name, "Removed Player");
  assert.equal(migrated.guesses[0].ok, true);
});

test("legacy archive summaries restore as completed boards", () => {
  const { core } = runtime();
  const puzzle = core.generate(SERIES_START);
  const qids = core.serializeStages(puzzle.stages);
  const win = core.restoreHistoryState(
    { num: 1, res: [0, 1, 2, 0], stages: qids }, puzzle.stages,
    { date: SERIES_START, built: "test", stageQids: qids });
  assert.equal(win.done, true);
  assert.equal(win.won, true);
  assert.equal(win.stage, 3);
  assert.deepEqual(win.skipped, [2]);
  assert.equal(win.hints.nat, 1);
  assert.deepEqual(win.guesses.map(guess => guess.stage), [0, 1, 3]);

  const loss = core.restoreHistoryState(
    { num: 1, res: [0, 2, 3, 3], stages: qids }, puzzle.stages,
    { date: SERIES_START, built: "test", stageQids: qids });
  assert.equal(loss.done, true);
  assert.equal(loss.won, false);
  assert.equal(loss.stage, 1);
  assert.deepEqual(loss.skipped, []);
  assert.deepEqual(loss.guesses.map(guess => guess.stage), [0]);
});

test("career cache keys isolate stages, reuse club order, and identify stale views", () => {
  const { core } = runtime();
  assert.equal(core.careerCacheKey(12, "2026-07-20", 1, [8, 3]),
    core.careerCacheKey(12, "2026-07-20", 1, [3, 8]));
  assert.notEqual(core.careerCacheKey(12, "2026-07-20", 1, [3, 8]),
    core.careerCacheKey(12, "2026-07-20", 2, [3, 8]));
  assert.notEqual(core.careerCacheKey(12, "2026-07-20", 1, [3, 8]),
    core.careerCacheKey(12, "2026-07-20", 1, [3, 9]));
  const captured = core.careerViewKey("2026-07-20", 1, [3, 8]);
  assert.equal(captured, core.careerViewKey("2026-07-20", 1, [3, 8]));
  assert.notEqual(captured, core.careerViewKey("2026-07-20", 2, [3, 8]));
});

test("search tiers preserve recognition floors for pairs and triples", () => {
  const { core } = runtime();
  const { QEASY, QEASY3, QMEDIUM, QMEDIUM3, QHARD, QHARD3, QIMPOSSIBLE, QIMP3, QBOUNDARIES: b } = core.constants;
  for (const tier of [...QEASY, ...QEASY3, ...QMEDIUM, ...QMEDIUM3, ...QHARD, ...QHARD3, ...QIMPOSSIBLE, ...QIMP3]) {
    assert.deepEqual(tier.size, [1, Infinity], "search must not reintroduce raw answer-count exclusions");
  }
  for (const tier of [...QEASY, ...QEASY3]) {
    assert.ok(tier.ease[0] >= b.easy);
    assert.ok(tier.p.every(pool => pool === "easy"));
    assert.equal(tier.familiar, core.constants.QEASY_MIN_FAMILIAR);
  }
  for (const tier of [...QMEDIUM, ...QMEDIUM3]) {
    assert.ok(tier.ease[0] >= b.medium);
  }
  for (const tier of [...QHARD, ...QHARD3]) {
    assert.ok(tier.ease[0] >= b.hard);
  }
  for (const tier of [...QIMPOSSIBLE, ...QIMP3]) {
    assert.ok(tier.ease[0] >= 0 && tier.ease[1] <= b.hard);
  }
});

test("every usable core pair has a difficulty and a matching normal search tier", { timeout: 30_000 }, () => {
  const { analyse } = require("../scripts/quiz-eligibility.js");
  const report = analyse(runtime());
  assert.ok(report.valid > 0);
  assert.equal(report.levels.unclassified.classified, 0);
  assert.equal(report.unreachable, 0);
  for (const level of ["easy", "medium", "hard", "impossible"])
    assert.equal(report.levels[level].reachable, report.levels[level].classified, level);
});

test("generated and restored slates agree on audience, face and difficulty", () => {
  const { DB, core } = runtime();
  const generated = core.generate(SERIES_START);
  const rows = core.serializeStages(generated.stages);
  const restored = core.stagesFromQids(rows);
  assert.equal(generated.stages[0].audience, "european");
  assert.ok(restored[0].clubs.every(ci => EASY_QIDS.includes(DB.clubs[ci][3])));
  restored.forEach((stage, i) => {
    assert.equal(stage.ease, generated.stages[i].ease);
    assert.equal(core.qFace(stage), core.qFace(generated.stages[i]));
    assert.equal(stage.audience, generated.stages[i].audience);
  });
  assert.equal(core.validateEntry(rows, { requireBands: true }).ok, true);
  const localEasy = ["Q18739", "Q18662"]; // Sunderland / Cardiff
  const invalid = [localEasy, ...rows.slice(1)];
  assert.ok(core.validateEntry(invalid, { requireBands: true }).errors.some(error => error.includes("known clubs")));
});

test("history older than the cooldown influences novelty but does not ban a combination", () => {
  const { core } = runtime();
  const date = core.qShift(SERIES_START, 40);
  const initial = core.generate(date), rows = core.serializeStages(initial.stages);
  const oldHistory = [{ date: SERIES_START, stages: [rows[0]] }];
  assert.equal(core.validateEntry(rows, { date, previousDays: oldHistory, requireLevels: true }).ok, true);
  const withHistory = core.generate(date, { previousDays: oldHistory });
  assert.notEqual(core.qComboKey(withHistory.stages[0].clubs), core.qComboKey(initial.stages[0].clubs));
  assert.deepEqual(core.generate(date, { previousDays: oldHistory }), withHistory);
});
