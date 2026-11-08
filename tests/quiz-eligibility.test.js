"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createRuntime } = require("../scripts/quiz-schedule.js");
const { recognitionIndex } = require("./helpers/quiz-data.js");

function game(hardCount = 1, impossibleCount = 1) {
  const count = 2 + hardCount + impossibleCount;
  const index = {
    built: "2026-11-05", leagues: [["One", 1, "IT"], ["Two", 1, "GB"]],
    clubs: Array.from({ length: 8 }, (_, ci) => [`Club ${ci}`, ci % 2 ? "GB" : "IT", 1 << (ci % 2),
      ci === 0 ? "Q1543" : ci === 1 ? "Q9616" : `Q${9000 + ci}`, 0, ci % 2]),
    names: Array.from({ length: count }, (_, pid) => `Known Player ${pid}`),
    births: Array(count).fill(1990), nats: Array(count).fill("IT"), imgs: Array(count).fill(""), gks: [],
    postings: [], apps: [], goals: [],
  };
  index.births[0] = 1970; index.imgs[0] = "portrait"; index.births[1] = 1998;
  for (let ci = 0; ci < 8; ci++) {
    const rows = ci < 2 ? [[0, 300, 100], ...(ci === 0 ? [[1, 300, 0]] : [])]
      : ci < 4 ? [[1, 200, 50]] : ci < 6 ? Array.from({ length: hardCount }, (_, k) => [k + 3, 200, 30])
      : Array.from({ length: impossibleCount }, (_, k) => [k ? 2 + hardCount + k : 2, 20, 0]);
    index.postings.push(rows.map((r, i) => i ? r[0] - rows[i - 1][0] : r[0]));
    index.apps.push(rows.map(r => r[1])); index.goals.push(rows.map(r => r[2]));
  }
  return createRuntime(index);
}

test("one very obvious answer between known clubs qualifies as easy", () => {
  const { core } = game();
  const stage = core.stagesFromQids([["Q1543", "Q9616"]])[0];
  assert.equal(stage.effective.length, 1);
  assert.ok(core.qDifficultyFame(stage.effective[0], stage.clubs) >= core.constants.QEASY_SOLO_MIN_FAME);
  assert.equal(core.classifyStage(stage), 0);
});

test("a merged solo answer uses its strongest documented route regardless of record order", () => {
  const index = recognitionIndex();
  index.names[1] = index.names[0];
  index.births[0] = index.births[1] = 1998;
  index.nats[1] = "PT";
  index.apps.forEach(row => { row[0] = 100; row[1] = 300; });
  index.goals.forEach(row => { row[0] = 25; row[1] = 100; });
  const { core } = createRuntime(index, { stature: () => 1 });
  const clubs = [0, 1];
  assert.ok(core.qDifficultyFame(0, clubs) >= core.constants.QFAMILIAR_MIN_FAME);
  assert.ok(core.qDifficultyFame(0, clubs) < core.constants.QEASY_SOLO_MIN_FAME);
  assert.ok(core.qDifficultyFame(1, clubs) >= core.constants.QEASY_SOLO_MIN_FAME);
  for (const answers of [[0, 1], [1, 0]]) {
    assert.deepEqual(core.qFamiliarAnswers(clubs, answers), [1]);
    assert.equal(core.classifyStage({ clubs, effective: answers }), 0);
  }
});

test("normal generation admits a single-answer medium and a non-marquee single-answer hard", () => {
  const { core } = game();
  const slate = core.generate("2026-11-05");
  assert.deepEqual(slate.stages.map(stage => core.classifyStage(stage)), [0, 1, 2, 3]);
  assert.equal(slate.stages.every(stage => stage.effective.length === 1), true);
  assert.equal(slate.stages.some(stage => stage.fallback), false);
});

test("normal generation admits hard puzzles with more than twenty valid answers", () => {
  const { core } = game(31);
  const slate = core.generate("2026-11-05");
  assert.equal(slate.stages[2].effective.length, 31);
  assert.equal(core.classifyStage(slate.stages[2]), 2);
});

test("normal generation admits specialist puzzles with more than three valid answers", () => {
  const { core } = game(1, 4);
  const slate = core.generate("2026-11-05");
  assert.equal(slate.stages[3].effective.length, 4);
  assert.equal(core.classifyStage(slate.stages[3]), 3);
  assert.equal(slate.stages[3].fallback, false);
});

test("valid combinations always receive a tier, including small archives and obscure clubs", () => {
  const { core, postings, intersect, index } = game(31);
  assert.ok(index.postings.every(rows => rows.length < 100));
  let checked = 0;
  for (let a = 0; a < index.clubs.length; a++) for (let b = a + 1; b < index.clubs.length; b++) {
    const clubs = [a, b], answers = core.qEffective(clubs, intersect(clubs.map(postings)));
    if (!answers.length) continue;
    assert.ok(core.classifyStage({ clubs, answers }) >= 0);
    checked++;
  }
  assert.ok(checked >= 4);
  assert.equal(core.classifyStage({ clubs: [0, 0], answers: [0] }), -1);
  assert.equal(core.classifyStage({ clubs: [0, 1], effective: [] }), -1);
});

test("unknown clues constrain easy without creating a classification gap at high scores", () => {
  const { core } = game();
  const stage = core.stagesFromQids([["Q9002", "Q9003"]])[0];
  assert.ok(core.qFamiliarAnswers(stage.clubs, stage.effective).length);
  assert.equal(core.qEasyEligible(stage.clubs, stage.effective), false);
  assert.equal(core.classifyStage({ ...stage, ease: 900 }), 1);
});

test("familiarity does not require appearances at the seventeen elite clubs", () => {
  const index = recognitionIndex();
  index.clubs.forEach((club, ci) => { club[3] = ["Q2052", "Q2609", "Q10333"][ci]; });
  index.births[0] = 1998; index.imgs[0] = "portrait";
  index.apps.forEach(row => { row[0] = 300; });
  index.goals.forEach(row => { row[0] = 70; });
  const { core, index: DB } = createRuntime(index);
  core.qPools();
  assert.equal(DB.qGlobalApps[0], 0);
  assert.deepEqual(core.qFamiliarAnswers([0, 1], [0]), [0]);
});
