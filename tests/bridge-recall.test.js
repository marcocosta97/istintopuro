"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { compile } = require("../scripts/quiz-recognition.js");
const { createRuntime } = require("../scripts/quiz-schedule.js");
const { DEFAULT_CONFIG, applySpellRecall, validate } = require("../site/quiz-recognition.js");
const { observation, configuration } = require("../scripts/recognition-model.js");
const { EASY_QIDS, LEGACY_EASY_QIDS, MARQUEE_QIDS, easyQidsFor } = require("../site/quiz-core.js");
const fixture = require("./helpers/recognition-fixture.js")("spellRecall");
const upgraded = compile(fixture.index, fixture.playerQids,
  { previous: fixture.withCoverage, asOf: fixture.withCoverage.asOf });
const runtime = bundle => createRuntime({ ...structuredClone(fixture.index), quizRecognition: bundle },
  { stature: ci => fixture.index._fixture.clubStature[ci] });
const original = runtime(fixture.original), candidate = runtime(upgraded);
const stage = (rt, qids) => rt.core.stagesFromQids([qids])[0];
const level = (rt, s) => rt.core.constants.QLEVELS[rt.core.classifyStage(s)];

test("short spells and completed observations correct the five reviewed cases and retain previous constraints", () => {
  for (const c of fixture.cases) {
    const before = stage(original, c.qids), after = stage(candidate, c.qids);
    if (c.current) assert.equal(level(original, before), c.current, c.qids.join("/"));
    if (c.minimum) assert.ok(candidate.core.classifyStage(after) >= candidate.core.constants.QLEVELS.indexOf(c.minimum));
    else assert.equal(level(candidate, after), c.expected, c.qids.join("/"));
    assert.deepEqual(after.answers, before.answers);
    assert.deepEqual(candidate.core.qRanked(after), original.core.qRanked(before));
    assert.equal(candidate.core.qFace(after), original.core.qFace(before));
  }
});

test("difficulty discounts shorter spells monotonically while 25+ appearances and unknown spells are unchanged", () => {
  let previous = 0;
  for (let apps = 1; apps <= 25; apps++) {
    const oldBridge = 600 * (.35 + .65 * Math.sqrt(apps / 25));
    const value = applySpellRecall(oldBridge, [300, apps], DEFAULT_CONFIG);
    assert.ok(value > previous);
    assert.ok(value <= oldBridge);
    assert.ok(Math.abs(value - 600 * (.35 + .65 * Math.pow(apps / 25, 1.5))) < 1e-10);
    previous = value;
  }
  for (const apps of [[25, 300], [100, 300], [-1, -1], undefined])
    assert.equal(applySpellRecall(600, apps, DEFAULT_CONFIG), 600);
  assert.equal(applySpellRecall(600, [1, 300], fixture.original.config), 600, "frozen v5 reproduces the old formula");
});

test("the Easy clue list is frozen per release without changing the player exposure prior", () => {
  assert.deepEqual(easyQidsFor({ quizRecognition: fixture.original }), LEGACY_EASY_QIDS);
  assert.deepEqual(easyQidsFor({ quizRecognition: upgraded }), upgraded.easyClubQids);
  assert.ok(EASY_QIDS.every(qid => upgraded.easyClubQids.includes(qid)));
  assert.equal(upgraded.easyClubQids.includes("Q19490"), true, "strong measured clues expand Easy at compilation");
  assert.equal(EASY_QIDS.includes("Q19490"), false, "measured expansion does not edit the curated list");
  assert.equal(LEGACY_EASY_QIDS.includes("Q4512"), false);
  assert.equal(EASY_QIDS.includes("Q4512"), true);
  assert.equal(MARQUEE_QIDS.includes("Q4512"), false);
  for (const qids of [["Q4512", "Q15789"]]) {
    const a = stage(original, qids), b = stage(candidate, qids);
    for (const pid of a.effective) assert.equal(candidate.core.qBridgeFame(pid, b.clubs), original.core.qBridgeFame(pid, a.clubs));
  }
  for (const bad of [[], ["Q4512", "Q4512"], ["Stuttgart"]])
    assert.throws(() => validate({ ...upgraded, easyClubQids: bad }, fixture.playerQids.length), /Easy club list/);
  assert.deepEqual(upgraded.players, fixture.withCoverage.players, "v5 source features need no re-fetch or altered expiry");
});

test("a historical title is eligible only with matching club identity and a fresh verified move", () => {
  const row = fixture.clubSnapshot.clubs.Q289713, time = Date.parse(upgraded.asOf), config = configuration();
  assert.equal(observation(row, config, time, "Q289713").eligible, true);
  for (const change of [
    { verified_alias_qid: "Q1" }, { sitelink_title: "Unrelated club" },
    { alias_checked_at: "2020-01-01T00:00:00Z" }, { alias_move_at: "2099-01-01T00:00:00Z" },
  ]) {
    const bad = { ...row, pageviews: { ...row.pageviews, ...change } };
    assert.equal(observation(bad, config, time, "Q289713").eligible, false);
  }
});
