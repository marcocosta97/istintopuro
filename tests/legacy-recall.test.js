"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { compile } = require("../scripts/quiz-recognition.js");
const { createRuntime } = require("../scripts/quiz-schedule.js");
const { DEFAULT_CONFIG, FROZEN_CONFIG, legacyRecallFactor, legacyRecallFame } = require("../site/quiz-recognition.js");
const fixture = require("./helpers/recognition-fixture.js")("generationalRecall");
const bundle = compile(fixture.index, fixture.playerQids,
  { previous: fixture.withCoverage, asOf: fixture.withCoverage.asOf });
const runtime = recognition => createRuntime({ ...structuredClone(fixture.index), quizRecognition: recognition },
  { stature: ci => fixture.index._fixture.clubStature[ci] });
const before = runtime(fixture.original), after = runtime(bundle);

test("the three newly acknowledged cases change bands and all previous calibration controls remain valid", () => {
  for (const c of fixture.cases) {
    const a = before.core.stagesFromQids([c.qids])[0], b = after.core.stagesFromQids([c.qids])[0];
    const level = rt => rt.core.constants.QLEVELS[rt.core.classifyStage(rt === before ? a : b)];
    if (c.current) assert.equal(level(before), c.current);
    if (c.minimum) assert.ok(after.core.classifyStage(b) >= after.core.constants.QLEVELS.indexOf(c.minimum));
    else assert.equal(level(after), c.expected, c.qids.join("/"));
    assert.deepEqual(a.answers, b.answers);
    assert.deepEqual(before.core.qRanked(a), after.core.qRanked(b));
    assert.equal(before.core.qFace(a), after.core.qFace(b));
  }
});

test("generational recall is smooth, bounded and protected by strong current readership", () => {
  const low = { eligible: true, viewsScore: .6 }, high = { eligible: true, viewsScore: 1 };
  let previous = 1;
  for (let age = 60; age <= 100; age++) {
    const factor = legacyRecallFactor(2026 - age, 2026, low, DEFAULT_CONFIG);
    assert.ok(factor <= previous && factor >= .9);
    assert.equal(legacyRecallFactor(2026 - age, 2026, high, DEFAULT_CONFIG), 1);
    previous = factor;
  }
  assert.equal(legacyRecallFactor(1966, 2026, low, DEFAULT_CONFIG), 1);
  assert.equal(legacyRecallFactor(1940, 2026, { eligible: true, viewsScore: .9 }, DEFAULT_CONFIG), .95);
  for (const feature of [undefined, { eligible: false }, { eligible: true }])
    assert.equal(legacyRecallFactor(1940, 2026, feature, DEFAULT_CONFIG), 1);
  for (const birth of [0, null, undefined]) assert.equal(legacyRecallFactor(birth, 2026, low, DEFAULT_CONFIG), 1);
  assert.equal(legacyRecallFactor(1940, 2026, low, FROZEN_CONFIG), 1, "v6 replay keeps the original parameters");
});

test("generational recall shares the existing downside budget rather than adding a second uncapped malus", () => {
  const low = { eligible: true, viewsScore: .1 };
  for (const prior of [100, 300, 600, 1000]) {
    const floor = prior - Math.min(150, .25 * prior);
    assert.equal(legacyRecallFame(floor, prior, 1940, 2026, low, DEFAULT_CONFIG), floor);
    assert.ok(legacyRecallFame(prior, prior, 1940, 2026, low, DEFAULT_CONFIG) >= floor);
  }
  assert.deepEqual(bundle.players, fixture.withCoverage.players, "source features and their expiry need no mutation or new API calls");
});

test("nearby recall strengths retain the new classification without targeting a single coefficient", () => {
  const { createAdapter, legacyRecallFame, playerAdjustment } = require("../site/quiz-recognition.js");
  const index = { ...structuredClone(fixture.index), quizRecognition: fixture.withCoverage };
  const old = createAdapter(index, fixture.withCoverage.easyClubQids);
  const features = new Map(Object.values(bundle.players).map(([pid, score, bonusSupport, downwardSupport]) =>
    [pid, { eligible: true, score, bonusSupport, downwardSupport }]));
  for (const fraction of [.08, .1, .12]) {
    const config = { ...DEFAULT_CONFIG, legacyRecallMaxFraction: fraction };
    const rt = createRuntime(structuredClone(index), { stature: ci => fixture.index._fixture.clubStature[ci], recognition: {
      easyClubQids: old.easyClubQids,
      adjustBridge: args => {
        const base = old.adjustBridge(args), adjusted = args.baseFame + playerAdjustment(features.get(args.pid), args.baseFame, config).delta;
        const corrected = legacyRecallFame(adjusted, args.baseFame,
          args.birth, args.year, features.get(args.pid), config);
        return adjusted > 0 ? base * corrected / adjusted : base;
      },
    } });
    for (const c of fixture.cases) {
      const s = rt.core.stagesFromQids([c.qids])[0], level = rt.core.classifyStage(s);
      if (c.minimum) assert.ok(level >= rt.core.constants.QLEVELS.indexOf(c.minimum));
      else assert.equal(rt.core.constants.QLEVELS[level], c.expected, `${fraction}: ${c.qids.join("/")}`);
    }
  }
});
