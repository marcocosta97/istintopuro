"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createClubContext } = require("../scripts/club-recognition.js");
const { createModel } = require("../scripts/recognition-model.js");
const { createRuntime } = require("../scripts/quiz-schedule.js");
const { EASY_QIDS } = require("../site/quiz-core.js");
const { LEGACY_CLUB_CONFIG, FROZEN_CONFIG } = require("../site/quiz-recognition.js");
const { buildReport } = require("../scripts/recognition-audit.js");
const fixture = require("./fixtures/club-recall.json");

function setup(snapshot = fixture.clubSnapshot, index = fixture.index, playerSnapshot = fixture.snapshot) {
  const asOf = [snapshot.generated_at, playerSnapshot.generated_at].sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  const clubs = createClubContext(index, snapshot, { asOf });
  const player = createModel(playerSnapshot, fixture.playerQids, { asOf });
  const runtime = recognition => createRuntime(structuredClone(index), { recognition, stature: ci => index._fixture.clubStature[ci] });
  return { clubs, player, before: runtime(player.adapter), after: runtime(clubs.wrap(player.adapter)) };
}

test("user-labelled AlzanoCene/PSG and Bury/Stoke require at least Hard despite famous answer players", () => {
  const { before, after } = setup();
  for (const qids of [["Q1153687", "Q483020"], ["Q19573", "Q18736"]]) {
    const old = before.core.stagesFromQids([qids])[0], revised = after.core.stagesFromQids([qids])[0];
    assert.equal(before.core.classifyStage(old), 1, "frozen player-only model promotes the connection to Medium");
    assert.ok(after.core.classifyStage(revised) >= 2);
    assert.deepEqual(revised.answers, old.answers);
    assert.deepEqual(after.core.qRanked(revised), before.core.qRanked(old));
    assert.equal(after.core.qFace(revised), before.core.qFace(old));
    assert.equal(after.core.qFamiliarAnswers(revised.clubs, revised.effective).length, 0);
  }
});

test("familiar historic clubs and all-known clue combinations retain the player-model scores exactly", () => {
  const { before, after, clubs } = setup(), known = new Set(EASY_QIDS);
  let checked = 0;
  for (const qids of fixture.probes.filter(cs => cs.every(q => known.has(q)))) {
    const a = before.core.stagesFromQids([qids])[0], b = after.core.stagesFromQids([qids])[0];
    assert.equal(a.ease, b.ease);
    assert.equal(before.core.classifyStage(a), after.core.classifyStage(b));
    checked++;
  }
  assert.ok(checked >= 2);
  assert.equal(clubs.factor(["Q172476"]), 1, "Bordeaux remains familiar after falling outside covered divisions");
  assert.equal(clubs.factor(["Q2693"]), 1, "Parma remains a familiar historic clue");
});

test("a moderately familiar current club can retain a Medium bridge without entering the easy-clue list", () => {
  const { before, after, clubs } = setup();
  const qids = ["Q1128631", "Q19509"]; // Leeds / Rennes, frozen control.
  assert.equal(EASY_QIDS.includes("Q19509"), false);
  assert.ok(clubs.factor(qids) >= 0.95);
  const original = before.core.stagesFromQids([qids])[0], revised = after.core.stagesFromQids([qids])[0];
  assert.equal(before.core.classifyStage(original), 1);
  assert.equal(after.core.classifyStage(revised), 1);
});

test("club recall uses measured recognition, not historical roster size or a compulsory marquee clue", () => {
  const original = setup(), index = structuredClone(fixture.index);
  const ci = index.clubs.findIndex(c => c[3] === "Q19573");
  index.postings[ci] = Array(10000).fill(1);
  const changed = createClubContext(index, fixture.clubSnapshot, { asOf: fixture.clubSnapshot.generated_at });
  assert.equal(changed.factor(["Q19573"]), original.clubs.factor(["Q19573"]));
  assert.ok(changed.factor(["Q19573", "Q18736"]) > 0);
  assert.ok(changed.factor(["Q19573", "Q18736"]) < 1);
  const { after } = original;
  const c = after.core.stagesFromQids([["Q19573", "Q18736"]])[0];
  assert.ok(after.core.classifyStage(c) >= 0, "the obscure connection remains eligible");
});

test("missing or partial club readership is neutral rather than being mistaken for zero interest", () => {
  for (const mode of ["missing", "partial", "stale"]) {
    const source = structuredClone(fixture.clubSnapshot);
    if (mode === "missing") delete source.clubs.Q19573;
    if (mode === "partial") source.clubs.Q19573.pageviews.monthly[0][1] = null;
    if (mode === "stale") source.clubs.Q19573.pageviews.fetched_at = "2020-01-01T00:00:00Z";
    assert.equal(setup(source).clubs.factor(["Q19573"]), 1, mode);
  }
  assert.throws(() => createClubContext(fixture.index, fixture.clubSnapshot, { asOf: "2020-01-01T00:00:00Z" }), /future/);
});

test("stronger recall penalties preserve familiar clues and current-division visibility floors", () => {
  const asOf = fixture.clubSnapshot.generated_at;
  const before = createClubContext(fixture.index, fixture.clubSnapshot, { asOf, config: LEGACY_CLUB_CONFIG });
  const after = createClubContext(fixture.index, fixture.clubSnapshot, { asOf });
  for (const [i, feature] of after.features.entries()) {
    assert.ok(feature.factor <= before.features[i].factor + 1e-12);
    assert.ok(feature.factor >= after.config.minFactor);
    if (feature.known || !feature.sourceUsable) assert.equal(feature.factor, 1);
    if (feature.currentCoveredLeague) assert.ok(feature.factor >= after.config.currentOtherFloor);
  }
  assert.ok(after.factor(["Q19509"]) >= after.config.currentTopFloor, "Rennes keeps its current top-division floor");
});

test("the weakest clue is applied once and a third required club cannot inflate recognition", () => {
  const { clubs, after } = setup();
  const factor = clubs.factor(["Q19573", "Q18736"]);
  assert.equal(factor, Math.min(clubs.factor(["Q19573"]), clubs.factor(["Q18736"])));
  assert.equal(clubs.factor(["Q18736", "Q19573"]), factor);
  const trio = ["Q1153687", "Q483020", "Q1543"], triple = after.core.stagesFromQids([trio])[0];
  assert.ok(triple.effective.length);
  for (let a = 0; a < trio.length; a++) for (let b = a + 1; b < trio.length; b++) {
    const pair = after.core.stagesFromQids([[trio[a], trio[b]]])[0];
    assert.ok(triple.ease <= pair.ease + 1e-9);
    assert.ok(after.core.qRecognisableBreadth(triple.clubs, triple.effective)
      <= after.core.qRecognisableBreadth(pair.clubs, pair.effective) + 1e-9);
  }
});

test("club-context evidence can correct a connection independently of missing player popularity", () => {
  const empty = { ...fixture.snapshot, players: {} }, { before, after } = setup(fixture.clubSnapshot, fixture.index, empty);
  const qids = ["Q1153687", "Q483020"], a = before.core.stagesFromQids([qids])[0], b = after.core.stagesFromQids([qids])[0];
  assert.ok(b.ease < a.ease);
  assert.deepEqual(a.answers, b.answers);
});

test("the report retains the strongest answer and separates its player bonus from club recall", () => {
  const report = buildReport({ index: fixture.index, playerQids: fixture.playerQids,
    snapshot: fixture.snapshot, clubSnapshot: fixture.clubSnapshot, config: FROZEN_CONFIG,
    probes: [["Q1153687", "Q483020"], ["Q19573", "Q18736"]], maxIntersections: 2 });
  const bury = report.intersections.find(row => row.qids.includes("Q19573"));
  const answer = bury.answers.find(a => a.name === "Sammy McIlroy");
  assert.ok(answer);
  assert.ok(bury.answers.some(a => a.name === bury.candidate.strongestAnswer));
  assert.ok(answer.playerAdjusted >= 400 && answer.candidate < 400);
  assert.ok(answer.clubFactor < 1);
  assert.equal(answer.clubEvidence.length, 2);
  assert.equal(bury.candidate.level, "hard");
});
