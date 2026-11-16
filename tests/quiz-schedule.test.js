"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { calibrationRuntime } = require("./helpers/quiz-runtime.js");

const ROOT = path.resolve(__dirname, "..");
const {
  AUDIT_DAYS, auditSchedule, buildSchedule, countryBalanceErrors, createRuntime, EPOCH, HORIZON_DAYS, inspectEntry,
  loadRuntime, shiftDate, scheduleThrough, validateAsset,
} = require("../scripts/quiz-schedule.js");

const runtime = loadRuntime();
const AS_OF = runtime.index.built > EPOCH ? runtime.index.built : EPOCH;
let generated;

test("writer emits a valid deterministic v1 schedule", () => {
  generated = buildSchedule(runtime, null);
  assert.equal(generated.v, 1);
  assert.equal(generated.built, runtime.index.built);
  assert.equal(generated.through, shiftDate(runtime.index.built, HORIZON_DAYS));
  assert.equal(generated.generated, runtime.index.built);
  assert.equal(generated.lockedThrough, generated.generated);
  assert.equal(Object.keys(generated.days)[0], EPOCH);
  assert.deepEqual(validateAsset(runtime, generated, {
    expectedBuilt: runtime.index.built,
    expectedThrough: generated.through,
  }), { ok: true, errors: [] });
  assert.deepEqual(buildSchedule(runtime, generated), generated);
});

test("a refresh preserves today and history and regenerates tomorrow through the horizon", () => {
  generated ||= buildSchedule(runtime, null);
  const index = structuredClone(runtime.index), asOf = shiftDate(index.built, 7);
  index.built = asOf;
  const input = structuredClone(generated), tomorrow = shiftDate(asOf, 1);
  input.days[tomorrow][0][0] = "Q999999999999";
  input.bonuses[tomorrow] = { kind: "nationality", value: "FAKE", stage: 0, targets: ["Fake\u00001900"] };
  const next = createRuntime(index), calls = [], generate = next.core.generateSlate;
  next.core.generateSlate = (date, options) => { calls.push(date); return generate(date, options); };
  const output = buildSchedule(next, input);
  for (const date of Object.keys(generated.days).filter(d => d <= asOf)) {
    assert.deepEqual(output.days[date], generated.days[date]);
    assert.deepEqual(output.bonuses[date], generated.bonuses[date]);
  }
  assert.equal(output.generated, asOf);
  assert.equal(output.lockedThrough, asOf);
  assert.equal(output.through, shiftDate(asOf, HORIZON_DAYS));
  assert.equal(calls[0], tomorrow);
  assert.equal(calls.at(-1), output.through);
  assert.equal(calls.length, HORIZON_DAYS);
  assert.notEqual(output.days[tomorrow][0][0], "Q999999999999");
  assert.notEqual(output.bonuses[tomorrow]?.value, "FAKE");
});

test("a future bonus is selected again even when its club question stays the same", () => {
  generated ||= buildSchedule(runtime, null);
  const input = structuredClone(generated), tomorrow = shiftDate(AS_OF, 1);
  input.bonuses[tomorrow] = { kind: "nationality", value: "FAKE", stage: 0, targets: ["Fake\u00001900"] };
  const output = buildSchedule(runtime, input, { asOf: AS_OF });
  assert.deepEqual(output.days[tomorrow], generated.days[tomorrow]);
  assert.deepEqual(output.bonuses[tomorrow], generated.bonuses[tomorrow]);
  assert.deepEqual(output.bonuses[EPOCH], generated.bonuses[EPOCH]);
});

test("the horizon covers two missed weekly refreshes through the next scheduled attempt", () => {
  generated ||= buildSchedule(runtime, null);
  assert.equal(HORIZON_DAYS, 21);
  const built = runtime.index.built;
  for (const offset of [7, 14, 21]) {
    const date = shiftDate(built, offset);
    assert.ok(generated.days[date], `the scheduled day at +${offset} must already be playable`);
    assert.ok(Object.hasOwn(generated.bonuses, date));
  }
  assert.equal(generated.through, shiftDate(built, 21));
  assert.equal(generated.days[shiftDate(built, 22)], undefined);
});

test("a shorter request retains backup dates while allowing future regeneration", () => {
  generated ||= buildSchedule(runtime, null);
  const tail = shiftDate(generated.through, 1);
  const extended = buildSchedule(runtime, generated, { through: tail });
  const retained = buildSchedule(runtime, extended, { through: generated.through });
  assert.equal(retained.through, tail);
  assert.equal(retained.horizonThrough, tail);
  assert.deepEqual(Object.keys(retained.days), Object.keys(extended.days));
});

test("a dataset rollback cannot move the protected day backwards", () => {
  generated ||= buildSchedule(runtime, null);
  const published = buildSchedule(runtime, generated, { asOf: AS_OF });
  const index = structuredClone(runtime.index);
  index.built = shiftDate(index.built, -7);
  const output = buildSchedule(createRuntime(index), published);
  assert.equal(output.generated, AS_OF);
  assert.equal(output.lockedThrough, AS_OF);
  assert.equal(output.through, published.through);
  assert.deepEqual(output.days[EPOCH], published.days[EPOCH]);
  assert.deepEqual(output.bonuses[EPOCH], published.bonuses[EPOCH]);
});

test("historical questions survive source changes while future questions use the updated clubs", () => {
  generated ||= buildSchedule(runtime, null);
  const index = structuredClone(runtime.index), removedQid = generated.days[EPOCH][0][0];
  index.clubs.find(c => c[3] === removedQid)[3] = "Q999999999999";
  delete index.byQid;
  const next = createRuntime(index);
  const output = buildSchedule(next, generated, { asOf: AS_OF });
  assert.deepEqual(output.days[EPOCH], generated.days[EPOCH]);
  assert.deepEqual(output.bonuses[EPOCH], generated.bonuses[EPOCH]);
  assert.equal(next.byQid.has(removedQid), false);
  for (const [date, stages] of Object.entries(output.days)) if (date > AS_OF)
    assert.equal(stages.flat().includes(removedQid), false);
  assert.equal(validateAsset(next, output).ok, true);
});

test("the generation date controls the horizon even with an older dataset", () => {
  const asOf = shiftDate(runtime.index.built, 10);
  const output = buildSchedule(runtime, null, { asOf });
  assert.equal(output.built, runtime.index.built);
  assert.equal(output.generated, asOf);
  assert.equal(output.through, shiftDate(asOf, HORIZON_DAYS));
});

test("committed schedule matches the current index", () => {
  const asset = JSON.parse(fs.readFileSync(path.join(ROOT, "site/data/quiz-schedule.json"), "utf8"));
  const checked = validateAsset(runtime, asset, {
    expectedBuilt: runtime.index.built,
    expectedThrough: scheduleThrough(asset.generated, asset.horizonThrough),
  });
  assert.equal(checked.ok, true, checked.errors.join("\n"));
});

test("today and historical questions and bonuses cannot be regenerated or backfilled", () => {
  generated ||= buildSchedule(runtime, null);
  assert.throws(() => buildSchedule(runtime, generated, { regenerateFrom: EPOCH }), /regenerateFrom/);
  const missing = structuredClone(generated);
  delete missing.bonuses[EPOCH];
  assert.throws(() => buildSchedule(runtime, missing, { asOf: AS_OF }), /invalid published questions or bonus/);
  delete missing.days[EPOCH];
  assert.throws(() => buildSchedule(runtime, missing, { asOf: AS_OF }), /missing published quiz/);
  const malformed = structuredClone(generated);
  malformed.bonuses[EPOCH].targets = [];
  assert.throws(() => buildSchedule(runtime, malformed, { asOf: AS_OF }), /invalid published questions or bonus/);
});

test("a new series drops previous dates and generates only from day one", () => {
  generated ||= buildSchedule(runtime, null);
  const previous = { ...generated, series: "2026-08-21", days: { "2026-08-21": generated.days[EPOCH] } };
  const next = buildSchedule(runtime, previous);
  assert.equal(next.series, EPOCH);
  assert.equal(Object.keys(next.days)[0], EPOCH);
  assert.equal(next.days["2026-08-21"], undefined);
  assert.deepEqual(next, generated);
});

test("a higher medium score is valid when its recognition requirements differ from easy", () => {
  const runtime = calibrationRuntime();
  const rows = [["Q18741", "Q51974"], ["Q483020", "Q19509"],
    ["Q38245", "Q19604"], ["Q39052565", "Q501372"]];
  const stages = runtime.core.stagesFromQids(rows);
  assert.ok(stages[1].ease > stages[0].ease);
  assert.deepEqual(stages.map(stage => runtime.core.classifyStage(stage)), [0, 1, 2, 3]);
  assert.equal(inspectEntry(runtime, rows, { strict: true }).ok, true);
  const swapped = [rows[1], rows[0], rows[2], rows[3]];
  assert.equal(inspectEntry(runtime, swapped, { strict: true }).ok, false);
});

test("validator rejects malformed dates and repeated clubs in published history", () => {
  generated ||= buildSchedule(runtime, null);
  assert.throws(() => shiftDate("2026-02-30", 1), /invalid ISO date/);
  const repeated = structuredClone(generated);
  const date = Object.keys(repeated.days)[0];
  repeated.days[date][1][0] = repeated.days[date][0][0];
  const checked = validateAsset(runtime, repeated);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("\n"), /invalid published questions or bonus/);
});

test("a lock cannot exempt dates outside the schedule horizon from validation", () => {
  generated ||= buildSchedule(runtime, null);
  const asset = { ...generated, lockedThrough: shiftDate(generated.through, 1) };
  assert.match(validateAsset(runtime, asset).errors.join("\n"), /lockedThrough/);
});

test("country balance accepts 32 England days and reports exact failing counts", () => {
  assert.deepEqual(countryBalanceErrors(new Map([["GB", 32]]), AUDIT_DAYS), []);
  assert.deepEqual(countryBalanceErrors(new Map([["GB", 31]]), AUDIT_DAYS), [
    "impossible England count 31/730 is below minimum 32",
  ]);
});

test("730-day deterministic audit meets repetition and balance bounds", { timeout: 120_000 }, () => {
  const result = auditSchedule(runtime);
  assert.equal(result.days, 730);
  assert.ok(result.triples[0] > 0, "easy triples must survive the rolling repetition guards");
  assert.ok(result.triples[0] < result.days / 5, "easy triples should remain occasional");
  assert.ok(result.triples[1] >= result.days * .2 && result.triples[1] <= result.days * .4);
  assert.ok(result.stages[0].uniqueCombinations >= 150);
  assert.ok(result.stages[1].uniqueCombinations >= 400, "medium must use the wider catalogue");
  assert.ok(result.stages[1].representativePlayers >= 130, "novelty must include different players");
  for (const stage of result.stages.slice(2)) assert.ok(stage.uniqueCombinations >= 650);
});
