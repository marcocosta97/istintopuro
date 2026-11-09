"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { compile } = require("../scripts/quiz-recognition.js");
const { createRuntime } = require("../scripts/quiz-schedule.js");
const { createClubContext } = require("../scripts/club-recognition.js");
const { strongClue, DEFAULT_CLUB_CONFIG, FROZEN_CLUB_CONFIG } = require("../site/quiz-recognition.js");
const { EASY_QIDS, MARQUEE_QIDS, easyQidsFor } = require("../site/quiz-core.js");
const fixture = require("./helpers/recognition-fixture.js")("clubAdmission");
const upgraded = compile(fixture.index, fixture.playerQids,
  { previous: fixture.withCoverage, asOf: fixture.withCoverage.asOf });
const runtime = bundle => createRuntime({ ...structuredClone(fixture.index), quizRecognition: bundle },
  { stature: ci => fixture.index._fixture.clubStature[ci] });
const before = runtime(fixture.original), after = runtime(upgraded);
const stage = (rt, cs) => rt.core.stagesFromQids([cs])[0];
const level = (rt, s) => rt.core.constants.QLEVELS[rt.core.classifyStage(s)];

test("complete strong club readership and broad language coverage can expand the frozen Easy clue list", () => {
  assert.equal(strongClue({ viewsScore: 1, languageScore: 1 }, DEFAULT_CLUB_CONFIG), true);
  for (const f of [null, { viewsScore: .99, languageScore: 1 }, { viewsScore: 1, languageScore: .89 }])
    assert.equal(strongClue(f, DEFAULT_CLUB_CONFIG), false);
  assert.equal(strongClue({ viewsScore: 1, languageScore: 1 }, FROZEN_CLUB_CONFIG), false);
  assert.equal(fixture.original.easyClubQids.length, 48);
  assert.equal(easyQidsFor({ quizRecognition: fixture.original }).includes("Q19490"), false);
  assert.equal(EASY_QIDS.includes("Q19490"), false);
  assert.equal(MARQUEE_QIDS.includes("Q19490"), false);
  assert.equal(upgraded.easyClubQids.includes("Q19490"), true);
  const qids = ["Q18656", "Q19490"], a = stage(before, qids), b = stage(after, qids);
  assert.equal(level(before, a), "medium");
  assert.equal(level(after, b), "easy");
  for (const pid of a.effective) assert.equal(before.core.qBridgeFame(pid, a.clubs), after.core.qBridgeFame(pid, b.clubs));
});

test("new coverage corrects Ternana and Boga and retains previous population coefficients and calibrations", () => {
  for (const [key, value] of Object.entries(fixture.original.config))
    if (key !== "version") assert.deepEqual(upgraded.config[key], value);
  for (const c of fixture.cases) {
    const a = stage(before, c.qids), b = stage(after, c.qids);
    if (c.current) assert.equal(level(before, a), c.current);
    if (c.minimum) assert.ok(after.core.classifyStage(b) >= after.core.constants.QLEVELS.indexOf(c.minimum));
    else assert.equal(level(after, b), c.expected, c.qids.join("/"));
    assert.deepEqual(a.answers, b.answers);
    assert.deepEqual(before.core.qRanked(a), after.core.qRanked(b));
    assert.equal(before.core.qFace(a), after.core.qFace(b));
  }
});

test("new observations can contradict a provisional tuning judgement instead of triggering an arbitrary penalty", () => {
  const c = fixture.cases.find(c => c.reviewedTarget === "medium"), s = stage(after, c.qids);
  assert.equal(c.reviewedTarget, "medium", "retain the original acknowledged judgement");
  assert.equal(level(after, s), "easy");
  const pid = fixture.playerQids.indexOf("Q19665907");
  assert.deepEqual(s.clubs.map(ci => after.core.qApps(ci, pid)), [98, 117]);
  assert.ok(after.core.qDifficultyFame(pid, s.clubs) >= 400);
  assert.equal(fixture.sourceEvidence.Q19665907.pageviews.median_monthly_views, 69052);
  assert.equal(fixture.sourceEvidence.Q20925240.pageviews.median_monthly_views, 6807);
});

test("raw and compiled club contexts share Easy eligibility, while stale or partial traffic cannot admit a club", () => {
  const asOf = upgraded.asOf;
  const context = createClubContext(fixture.index, fixture.clubSnapshot, { asOf });
  assert.equal(context.easyClubQids.includes("Q19490"), true);
  const old = createClubContext({ ...fixture.index, quizRecognition: upgraded }, fixture.clubSnapshot,
    { asOf, config: FROZEN_CLUB_CONFIG });
  assert.equal(old.easyClubQids.includes("Q19490"), false, "an old-model control cannot inherit a newer automatic list");
  const wrapped = createRuntime(structuredClone(fixture.index), {
    recognition: context.wrap({ adjustBridge: ({ bridgeFame }) => bridgeFame }),
    stature: ci => fixture.index._fixture.clubStature[ci],
  });
  assert.equal(wrapped.core.qPools().easy.includes(wrapped.byQid.get("Q19490")), true);
  for (const mode of ["partial", "stale", "missing"]) {
    const snapshot = structuredClone(fixture.clubSnapshot);
    if (mode === "partial") snapshot.clubs.Q19490.pageviews.monthly[0][1] = null;
    if (mode === "stale") snapshot.clubs.Q19490.pageviews.fetched_at = "2020-01-01T00:00:00Z";
    if (mode === "missing") delete snapshot.clubs.Q19490;
    assert.equal(createClubContext(fixture.index, snapshot, { asOf }).easyClubQids.includes("Q19490"), false, mode);
  }
  const expired = compile(fixture.index, fixture.playerQids,
    { previous: upgraded, asOf: new Date(Date.parse(asOf) + 91 * 864e5).toISOString() });
  assert.equal(expired.easyClubQids.includes("Q19490"), false, "expired measurements do not retain automatic admission");
  assert.ok(EASY_QIDS.every(qid => expired.easyClubQids.includes(qid)), "curated historic clues remain protected");
});
