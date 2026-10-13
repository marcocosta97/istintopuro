"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createQuizCore, MARQUEE_QIDS, ELITE_QIDS, EASY_QIDS } = require("../site/quiz-core.js");

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
  return { DB, postings, intersect,
    core: createQuizCore({ DB, postings, intersect, marquee, leagueCC }) };
}

test("archived combinations stay playable and scoring stays internally consistent", (t) => {
  const { DB, core } = runtime();
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/quiz-pre-extraction.json"), "utf8"));
  const pinned = DB.built === fixture.built;
  if (!pinned) t.diagnostic(`snapshot pinned to dataset ${fixture.built}; checking invariants only`);
  for (const day of fixture.dates) for (const row of day.stages) {
    const qidCount = row.length === 5 ? 2 : 3;
    const qids = row.slice(0, qidCount), [count] = row.slice(qidCount);
    const [stage] = core.stagesFromQids([qids]);
    assert.ok(stage, `${day.date}: ${qids.join(" x ")} must resolve`);
    const ranked = core.rankedAnswers(stage);
    assert.equal(stage.ease, core.qEase(stage.clubs, stage.effective, stage.audience));
    assert.ok(ranked.length && core.qUsableName(ranked[0]) && stage.effective.includes(ranked[0]),
      `${day.date}: ${qids.join(" x ")} needs a usable representative`);
    if (!pinned) continue;
    assert.equal(stage.effective.length, count, `${day.date}: ${qids.join(" x ")} count`);
  }
});

test("zero-appearance registrations are accepted answers but not difficulty candidates", () => {
  const { core, intersect, postings } = runtime();
  const [stage] = core.stagesFromQids([["Q41420", "Q106394"]]);
  const raw = intersect(stage.clubs.map(postings));
  const registeredOnly = raw.find(pid => core.appearanceGaps(pid, stage.clubs).zero.length);
  assert.ok(registeredOnly !== undefined);
  assert.equal(core.answerMatches(registeredOnly, stage.answers), true);
  assert.equal(core.answerMatches(registeredOnly, stage.effective), false);
  assert.equal(stage.answers.length > stage.effective.length, true);
  assert.equal(stage.effective.every(pid => stage.clubs.every(ci => core.qApps(ci, pid) !== 0)), true);
  assert.equal(core.appearanceGaps(registeredOnly, stage.clubs).missing.length, 0);
  assert.equal(core.appearanceGaps(registeredOnly, stage.clubs).zero.length > 0, true);
});

test("bridge recognisability penalizes cameos without penalizing unknown historical totals", () => {
  const { DB, core } = runtime();
  const [dortmundSociedad] = core.stagesFromQids([["Q41420", "Q10315"]]);
  const weakestLinks = dortmundSociedad.effective.map(pid =>
    Math.min(...dortmundSociedad.clubs.map(ci => core.qApps(ci, pid))));
  assert.equal(Math.max(...weakestLinks), 8);
  assert.equal(dortmundSociedad.ease >= 140 && dortmundSociedad.ease < 425, true);
  assert.equal(dortmundSociedad.ease < core.constants.QEASY[0].ease[0], true);
  const isak = dortmundSociedad.effective.find(pid => DB.names[pid] === "Alexander Isak");
  assert.equal(core.qBridgeFame(isak, dortmundSociedad.clubs) < core.qFame(isak, dortmundSociedad.clubs), true);

  const [celtaSevilla] = core.stagesFromQids([["Q8749", "Q10329"]]);
  const balbino = celtaSevilla.effective.find(pid => DB.names[pid] === "Balbino Clemente");
  assert.equal(celtaSevilla.clubs.every(ci => core.qApps(ci, balbino) < 0), true);
  assert.equal(core.qBridgeFame(balbino, celtaSevilla.clubs), core.qFame(balbino, celtaSevilla.clubs));
  assert.deepEqual(core.appearanceGaps(balbino, celtaSevilla.clubs), { missing: [], zero: [] });
});

test("large intersections earn ease from recognisable breadth rather than raw answer count", () => {
  const { core } = runtime();
  const [atalantaJuventus] = core.stagesFromQids([["Q1886", "Q1422"]]);
  const breadth = core.qRecognisableBreadth(atalantaJuventus.clubs, atalantaJuventus.effective);
  assert.equal(atalantaJuventus.effective.length, 90);
  assert.equal(breadth < 15, true);
  assert.equal(atalantaJuventus.ease >= core.constants.QEASY[0].ease[0], true);
});

test("handle-like labels cannot become representative answers", () => {
  const { DB, core } = runtime();
  const handle = 0, original = DB.names[handle];
  const named = DB.names.findIndex((name, pid) => pid !== handle && core.qUsableName(pid));
  try {
    DB.names[handle] = "elpisha";
    assert.equal(core.qUsableName(handle), false);
    assert.equal(core.qRanked({ clubs: [], answers: [handle, named] })[0], named);
  } finally {
    DB.names[handle] = original;
  }
});

test("combo metadata validates the actual representative", () => {
  const { DB, core } = runtime();
  const [stage] = core.stagesFromQids([["Q2052", "Q10333"]]);
  const info = core.qComboInfo(stage.clubs);
  assert.equal(info.face, core.qFace(stage));
  assert.equal(info.b, !!DB.births[info.face]);
  assert.equal(info.named, core.qUsableName(info.face));
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
  const pair = [["Q2052", "Q10333"]];
  assert.ok(core.stagesFromQids(pair));
  assert.equal(core.validateEntry(pair).ok, false);
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

test("easy triples retain multiple familiar routes and reject an extra obscure spell", () => {
  const { core } = runtime();
  const obvious = core.stagesFromQids([["Q1543", "Q7156", "Q483020"]])[0];
  assert.ok(core.qEasyEligible(obvious.clubs, obvious.effective));
  assert.ok(obvious.ease >= core.constants.QBOUNDARIES.easy);
  const rejected = core.stagesFromQids([["Q631", "Q2739", "Q18716"]])[0];
  assert.ok(rejected);
  assert.equal(core.qEasyEligible(rejected.clubs, rejected.effective), false);
  assert.equal(core.qEasyEligible(obvious.clubs.slice(0, 1), obvious.effective), false);
});

test("football calibration preserves legends without promoting local statistics to easy", () => {
  const { DB, core } = runtime();
  const combo = qids => core.stagesFromQids([qids])[0];
  const zidane = combo(["Q172476", "Q1422"]); // Bordeaux / Juventus
  const parmaJuve = combo(["Q2693", "Q1422"]);
  const levanteRayo = combo(["Q8823", "Q10300"]);
  const isak = combo(["Q41420", "Q10315"]);
  assert.ok(zidane.ease >= core.constants.QBOUNDARIES.easy);
  assert.equal(DB.names[core.qFace(zidane)], "Zinedine Zidane");
  const buffon = parmaJuve.effective.find(pid => DB.names[pid] === "Gianluigi Buffon");
  assert.ok(core.qFamiliarAnswers(parmaJuve.clubs, parmaJuve.effective).includes(buffon));
  assert.equal(core.qEasyEligible(levanteRayo.clubs, levanteRayo.effective), false);
  assert.ok(levanteRayo.ease < core.constants.QBOUNDARIES.easy);
  assert.ok(zidane.ease > levanteRayo.ease);
  assert.ok(isak.ease >= core.constants.QBOUNDARIES.hard && isak.ease < core.constants.QBOUNDARIES.medium);
});

test("historical career links remain candidates after a club leaves the top divisions", () => {
  const { DB, core } = runtime();
  const pools = core.qPools();
  for (const qid of ["Q172476", "Q19446"]) {
    const ci = DB.byQid.get(qid); // Bordeaux / Blackburn
    assert.ok(pools.field.includes(ci));
  }
});

test("recency does not create a difficulty cliff on the 33rd birthday", () => {
  const { DB, core } = runtime();
  const [stage] = core.stagesFromQids([["Q8823", "Q10300"]]);
  const pid = DB.names.indexOf("Jorge de Frutos"), birth = DB.births[pid];
  try {
    DB.births[pid] = DB.qYear - 32;
    const before = core.qBridgeFame(pid, stage.clubs);
    DB.births[pid]--;
    const after = core.qBridgeFame(pid, stage.clubs);
    assert.ok(before > after && before - after <= 6);
  } finally {
    DB.births[pid] = birth;
  }
});

test("adding a third required club cannot inflate ease or recognised breadth", () => {
  const { core, intersect, postings } = runtime();
  const stage = core.generate(SERIES_START).stages.find(stage => stage.clubs.length === 3);
  assert.ok(stage, "calibration day includes a triple");
  for (let dropped = 0; dropped < 3; dropped++) {
    const clubs = stage.clubs.filter((_, i) => i !== dropped);
    const answers = core.qEffective(clubs, intersect(clubs.map(postings)));
    assert.ok(stage.ease <= core.qEase(clubs, answers));
    assert.ok(core.qRecognisableBreadth(stage.clubs, stage.effective) <= core.qRecognisableBreadth(clubs, answers));
  }
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
  assert.ok(core.validateEntry(invalid, { requireBands: true }).errors.some(error => error.includes("globally familiar")));
});

test("classification recovers high scores without promoting single routes or unknown clues", () => {
  const { core } = runtime();
  const resolve = qids => core.stagesFromQids([qids])[0];
  const easy = resolve(["Q1543", "Q2052"]); // Milan / Fiorentina
  const medium = resolve(["Q172476", "Q1422"]); // Bordeaux / Juventus
  const triple = resolve(["Q2052", "Q631", "Q2739"]); // Fiorentina / Inter / Roma
  const mediumTriple = resolve(["Q2693", "Q1422", "Q1543"]); // Parma / Juventus / Milan
  const cameo = resolve(["Q1543", "Q1130849"]); // Milan / Liverpool
  const unknownClue = resolve(["Q8701", "Q12260"]); // Atlético / Sabadell
  assert.equal(core.classifyStage(easy), 0);
  assert.ok(medium.ease >= core.constants.QBOUNDARIES.easy);
  assert.equal(core.qFamiliarAnswers(medium.clubs, medium.effective).length, 1);
  assert.equal(core.classifyStage(medium), 1);
  assert.equal(core.qFamiliarAnswers(triple.clubs, triple.effective).length, 0);
  assert.equal(core.classifyStage(triple), 2);
  assert.equal(core.qFamiliarAnswers(mediumTriple.clubs, mediumTriple.effective).length, 1);
  assert.equal(core.classifyStage(mediumTriple), 1);
  assert.ok(cameo.ease >= core.constants.QBOUNDARIES.medium);
  assert.equal(core.classifyStage(cameo), 2);
  assert.ok(unknownClue);
  assert.ok(core.qFamiliarAnswers(unknownClue.clubs, unknownClue.effective).length > 0);
  assert.equal(core.classifyStage(unknownClue), 2);
  for (const stage of [easy, medium, triple, mediumTriple, cameo, unknownClue]) {
    assert.equal(core.stageDiagnostics(stage).level, core.classifyStage(stage));
    assert.equal(core.qComboInfo(stage.clubs).level, core.classifyStage(stage));
  }
  assert.equal(core.classifyStage({ clubs: [], effective: [] }), -1);
  assert.equal(core.classifyStage({ clubs: easy.clubs, effective: [] }), -1);
});

test("expanding easy clues retains the original player visibility baseline", () => {
  const { DB, core } = runtime();
  const pools = core.qPools();
  assert.ok(pools.easy.length > pools.elite.length);
  assert.deepEqual(pools.elite.map(ci => DB.clubs[ci][3]).sort(), [...ELITE_QIDS].sort());
  const [stage] = core.stagesFromQids([["Q1543", "Q9616"]]);
  assert.ok(Math.abs(stage.ease - 813) < 2, "expanding clues must not inflate established bridge scores");
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

test("a general fan's easy excludes the rejected domestic week and admits obvious European bridges", () => {
  const { DB, core } = runtime();
  for (const qids of [
    ["Q18739", "Q18662"], // Sunderland / Cardiff
    ["Q51974", "Q106394"], // Hamburg / Freiburg
    ["Q9616", "Q18736"], // Chelsea / Stoke
    ["Q501693", "Q704"], // Troyes / Lyon
    ["Q1051013", "Q19512"], // Paris FC / Sochaux
    ["Q2052", "Q13391"], // Fiorentina / Lecce: plausible local recall, not universal easy
  ]) {
    const [stage] = core.stagesFromQids([qids]);
    assert.equal(core.qEasyEligible(stage.clubs, stage.effective), false, qids.join(" / "));
  }
  for (const qids of [["Q1543", "Q9616"], ["Q1422", "Q7156"], ["Q50602", "Q41420"]]) {
    const [stage] = core.stagesFromQids([qids]);
    assert.ok(stage.ease >= core.constants.QBOUNDARIES.easy);
    assert.equal(core.qEasyEligible(stage.clubs, stage.effective), true);
    assert.ok(core.qFamiliarAnswers(stage.clubs, stage.effective).length >= 2);
  }
  const seregno = DB.byQid.get("Q1637277");
  assert.equal(core.qPools().field.includes(seregno), false);
});

test("a single familiar bridge cannot bypass the easy familiarity requirement", () => {
  const { core } = runtime();
  const [stage] = core.stagesFromQids([["Q1543", "Q9616"]]);
  const pid = core.qFamiliarAnswers(stage.clubs, stage.effective)[0];
  assert.equal(core.qEasyEligible(stage.clubs, [pid]), false);
  assert.equal(core.qEasyEligible(stage.clubs, []), false);
});

test("unknown appearances cannot supply positive evidence for a familiar bridge", () => {
  const { DB, core, postings } = runtime();
  const [stage] = core.stagesFromQids([["Q1543", "Q9616"]]);
  const pid = core.qFamiliarAnswers(stage.clubs, stage.effective)[0];
  const ci = stage.clubs[0], index = postings(ci).indexOf(pid), apps = DB.apps[ci][index];
  try {
    DB.apps[ci][index] = -1;
    assert.equal(core.qFamiliarAnswers(stage.clubs, [pid]).length, 0);
  } finally {
    DB.apps[ci][index] = apps;
  }
});
