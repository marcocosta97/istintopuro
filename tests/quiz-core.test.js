"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createQuizCore, MARQUEE_QIDS } = require("../site/quiz-core.js");

const ROOT = path.resolve(__dirname, "..");
const SERIES_START = "2026-08-21";
function runtime() {
  const DB = JSON.parse(fs.readFileSync(path.join(ROOT, "site/data/index.json"), "utf8"));
  DB.byQid = new Map(DB.clubs.map((club, i) => [club[3], i]));
  const decoded = new Map();
  const postings = (ci) => {
    if (!decoded.has(ci)) {
      let acc = 0;
      decoded.set(ci, Int32Array.from(DB.postings[ci], delta => acc += delta));
    }
    return decoded.get(ci);
  };
  const intersect = (lists) => {
    lists.sort((a, b) => a.length - b.length);
    let acc = [...lists[0]];
    for (let k = 1; k < lists.length && acc.length; k++) {
      const keep = [], list = lists[k]; let j = 0;
      for (const pid of acc) {
        while (j < list.length && list[j] < pid) j++;
        if (list[j] === pid) keep.push(pid);
      }
      acc = keep;
    }
    return acc;
  };
  const marquee = new Set(MARQUEE_QIDS);
  const leagueCC = (ci) => DB.clubs[ci][5] >= 0 ? DB.leagues[DB.clubs[ci][5]][2] : DB.clubs[ci][1];
  const stature = (ci) => {
    if (!DB.stat) {
      const byCountry = {};
      DB.clubs.forEach((club, i) => {
        if (DB.postings[i].length >= 120) (byCountry[leagueCC(i)] ??= []).push(i);
      });
      DB.stat = new Map();
      for (const country in byCountry) {
        const clubs = byCountry[country].sort((a, b) => DB.postings[a].length - DB.postings[b].length);
        clubs.forEach((club, i) => {
          const pct = clubs.length > 1 ? i / (clubs.length - 1) : 1;
          DB.stat.set(club, marquee.has(DB.clubs[club][3]) ? 1.15 : pct >= .6 ? 1 : pct >= .3 ? .82 : .66);
        });
      }
    }
    return DB.stat.get(ci) ?? .66;
  };
  return { DB, postings, intersect,
    core: createQuizCore({ DB, postings, intersect, stature, marquee, leagueCC }) };
}

test("extracted scorer matches snapshots captured from the pre-extraction implementation", (t) => {
  const { DB, core, intersect, postings } = runtime();
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/quiz-pre-extraction.json"), "utf8"));
  if (DB.built !== fixture.built) return t.skip(`snapshot belongs to dataset ${fixture.built}`);
  for (const day of fixture.dates) for (const row of day.stages) {
    const qidCount = row.length === 5 ? 2 : 3;
    const qids = row.slice(0, qidCount), [count, ease, face] = row.slice(qidCount);
    const [stage] = core.stagesFromQids([qids]);
    const raw = intersect(stage.clubs.map(postings));
    assert.equal(stage.answers.length, count, `${day.date}: ${qids.join(" x ")} count`);
    assert.equal(Math.round(stage.ease), ease, `${day.date}: ${qids.join(" x ")} ease`);
    assert.equal(DB.names[core.face({ clubs: stage.clubs, answers: raw })], face,
      `${day.date}: ${qids.join(" x ")} legacy face`);
  }
});

test("effective answers remove every known zero-appearance registration", () => {
  const { core, intersect, postings } = runtime();
  const [stage] = core.stagesFromQids([["Q41420", "Q106394"]]);
  const raw = intersect(stage.clubs.map(postings));
  const registeredOnly = raw.find(pid => core.appearanceGaps(pid, stage.clubs).zero.length);
  assert.equal(stage.answers.length < raw.length, true);
  assert.equal(stage.answers.every(pid => stage.clubs.every(ci => core.qApps(ci, pid) !== 0)), true);
  assert.equal(core.appearanceGaps(registeredOnly, stage.clubs).missing.length, 0);
  assert.equal(core.appearanceGaps(registeredOnly, stage.clubs).zero.length > 0, true);
});

test("guess identity treats indistinguishable PIDs as the same answer", () => {
  const { DB, core } = runtime();
  const seen = new Map();
  let pair;
  for (let pid = 0; pid < DB.names.length && !pair; pid++) {
    const key = core.playerIdentity(pid);
    if (seen.has(key)) pair = [seen.get(key), pid];
    else seen.set(key, pid);
  }
  assert.ok(pair, "dataset should contain at least one indistinguishable PID pair");
  assert.equal(core.answerMatches(pair[1], [pair[0]]), true);
});

test("generation is deterministic, ordered, effective, and honors QID prior context", () => {
  const { core } = runtime();
  const first = core.generate(SERIES_START);
  assert.equal(first.num, 1);
  assert.deepEqual(core.generate(SERIES_START), first);
  assert.equal(first.stages.every((stage, i) => !i || first.stages[i - 1].ease > stage.ease), true);
  assert.equal(first.stages.every(stage => stage.answers.length > 0 && !stage.fallback), true);
  const previousDays = [{ date: first.date, stages: core.serializeStages(first.stages) }];
  const next = core.generate("2026-08-22", { previousDays });
  const yesterday = new Set(first.stages.flatMap(stage => stage.clubs));
  assert.equal(next.stages.every(stage => stage.clubs.every(ci => !yesterday.has(ci))), true);
});

test("validation rejects unresolved and repeated clubs", () => {
  const { core } = runtime();
  assert.equal(core.validateEntry([["Q-nope"]]).ok, false);
  const puzzle = core.generate(SERIES_START);
  const rows = core.serializeStages(puzzle.stages);
  rows[1][0] = rows[0][0];
  assert.equal(core.validateEntry(rows).ok, false);
});

test("combination guard treats permutations as equal for 30 days", () => {
  const { core } = runtime();
  const first = core.generate(SERIES_START);
  const rows = core.serializeStages(first.stages);
  const reversed = rows.map(stage => [...stage].reverse());
  const previousDays = [{ date: SERIES_START, stages: rows }];
  assert.equal(core.constants.QCOMBO_DAYS, 30);
  assert.equal(core.validateEntry(reversed, { date: "2026-09-20", previousDays }).ok, false);
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

test("an inverted first slate is deterministically resampled", () => {
  const { core } = runtime();
  const previousDays = [];
  let inverted;
  for (let day = 0; day < 365 && !inverted; day++) {
    const date = new Date(Date.UTC(2026, 7, 21 + day)).toISOString().slice(0, 10);
    const result = core.generate(date, { previousDays: previousDays.slice(-core.constants.QCOMBO_DAYS) });
    previousDays.push({ date, stages: core.serializeStages(result.stages) });
    if (result.attempt > 0) inverted = result;
  }
  assert.ok(inverted, "expected at least one first-attempt inversion in a year");
  assert.equal(inverted.stages.every((stage, i) => !i || inverted.stages[i - 1].ease > stage.ease), true);
});
