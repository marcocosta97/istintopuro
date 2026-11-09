"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { compile } = require("../scripts/quiz-recognition.js");
const { createRuntime } = require("../scripts/quiz-schedule.js");
const fixture = require("./helpers/recognition-fixture.js")("targetCurve");
const upgraded = compile(fixture.index, fixture.playerQids,
  { previous: fixture.withCoverage, asOf: fixture.withCoverage.asOf });
const runtime = bundle => createRuntime({ ...structuredClone(fixture.index), quizRecognition: bundle },
  { stature: ci => fixture.index._fixture.clubStature[ci] });
const original = runtime(fixture.original), coverageOnly = runtime(fixture.withCoverage), candidate = runtime(upgraded);
const stage = (r, cs) => r.core.stagesFromQids([cs])[0];
const level = (r, s) => r.core.constants.QLEVELS[r.core.classifyStage(s)];

test("frozen tuning cases reach the reviewed bands without names or pairs in the scoring formula", () => {
  for (const example of fixture.cases.filter(c => c.current)) {
    const before = stage(original, example.qids), after = stage(candidate, example.qids);
    assert.equal(level(original, before), example.current, example.qids.join("/"));
    assert.equal(level(candidate, after), example.expected, example.qids.join("/"));
    assert.deepEqual(after.answers, before.answers);
    assert.deepEqual(candidate.core.qRanked(after), original.core.qRanked(before));
    assert.equal(candidate.core.qFace(after), original.core.qFace(before));
  }
});

test("new observations and formula changes have separately observable effects", () => {
  for (const qids of [["Q19481", "Q18721"], ["Q9616", "Q19470"]]) {
    assert.equal(level(original, stage(original, qids)), "hard");
    assert.equal(level(coverageOnly, stage(coverageOnly, qids)), "medium");
    assert.equal(level(candidate, stage(candidate, qids)), "medium");
  }
  for (const qids of [["Q15789", "Q1757655"], ["Q822021", "Q209509"]]) {
    assert.equal(level(coverageOnly, stage(coverageOnly, qids)), "medium");
    assert.equal(level(candidate, stage(candidate, qids)), "hard");
  }
});

test("previous user constraints and familiar historic controls remain valid", () => {
  for (const example of fixture.cases.filter(c => !c.current)) {
    const s = stage(candidate, example.qids), actual = candidate.core.classifyStage(s);
    if (example.minimum) assert.ok(actual >= candidate.core.constants.QLEVELS.indexOf(example.minimum));
    else assert.equal(level(candidate, s), example.expected);
    assert.ok(actual >= 0, "a harder clue keeps its eligibility");
  }
});

test("cached v4 source features upgrade without a new source timestamp or an API response", () => {
  assert.equal(upgraded.config.version, "recognition-v7");
  assert.equal(upgraded.clubConfig.version, "club-recall-v5");
  assert.equal(upgraded.asOf, fixture.withCoverage.asOf);
  let changed = 0;
  for (const [qid, row] of Object.entries(upgraded.players)) {
    assert.equal(row[4], fixture.withCoverage.players[qid][4]);
    assert.equal(row[2], fixture.withCoverage.players[qid][2]);
    assert.equal(row[3], fixture.withCoverage.players[qid][3]);
    if (row[1] !== fixture.withCoverage.players[qid][1]) changed++;
  }
  assert.ok(changed > 0);
  assert.deepEqual(compile(fixture.index, fixture.playerQids,
    { previous: upgraded, asOf: upgraded.asOf }), upgraded, "repeated compilation is stable");
});
