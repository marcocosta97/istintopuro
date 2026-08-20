"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const {
  auditSchedule, buildSchedule, createRuntime, EPOCH, inspectEntry, loadRuntime, shiftDate, validateAsset,
} = require("../scripts/quiz-schedule.js");

const runtime = loadRuntime();
let generated;

test("writer emits a valid deterministic v1 schedule", () => {
  generated = buildSchedule(runtime, null);
  assert.equal(generated.v, 1);
  assert.equal(generated.built, runtime.index.built);
  assert.equal(generated.through, shiftDate(runtime.index.built, 14));
  assert.equal(Object.keys(generated.days)[0], EPOCH);
  assert.deepEqual(validateAsset(runtime, generated, {
    expectedBuilt: runtime.index.built,
    expectedThrough: generated.through,
  }), { ok: true, errors: [] });
  assert.deepEqual(buildSchedule(runtime, generated), generated);
});

test("later refresh preserves history, repairs invalid days, and regenerates its horizon", () => {
  generated ||= buildSchedule(runtime, null);
  const input = structuredClone(generated);
  const nextIndex = structuredClone(runtime.index);
  nextIndex.built = shiftDate(runtime.index.built, 7);
  const nextRuntime = createRuntime(nextIndex);
  const preservedDate = EPOCH;
  const invalidDate = shiftDate(EPOCH, 1);
  const regeneratedDate = shiftDate(nextIndex.built, 1);
  const nextThrough = shiftDate(nextIndex.built, 14);
  const excessDate = shiftDate(nextThrough, 1);
  const preservedHistory = Object.fromEntries(Object.entries(input.days)
    .filter(([date]) => date <= nextIndex.built).map(([date, stages]) => [date, structuredClone(stages)]));
  const preserved = preservedHistory[preservedDate];
  input.days[invalidDate][0][0] = "Q999999999999";
  delete preservedHistory[invalidDate];
  input.days[regeneratedDate][0].reverse();
  const deliberatelyReorderedFuture = structuredClone(input.days[regeneratedDate]);
  input.days[excessDate] = preserved;
  input.through = excessDate;
  const warnings = [];

  const repaired = buildSchedule(nextRuntime, input, { warn: message => warnings.push(message) });

  for (const [date, stages] of Object.entries(preservedHistory)) assert.deepEqual(repaired.days[date], stages);
  assert.notDeepEqual(repaired.days[regeneratedDate], deliberatelyReorderedFuture);
  assert.equal(repaired.built, nextIndex.built);
  assert.equal(repaired.through, nextThrough);
  assert.equal(Object.hasOwn(repaired.days, excessDate), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(invalidDate));
  assert.equal(inspectEntry(nextRuntime, repaired.days[invalidDate], { strict: false }).ok, true);
});

test("committed schedule matches the current index", () => {
  const asset = JSON.parse(fs.readFileSync(path.join(ROOT, "site/data/quiz-schedule.json"), "utf8"));
  const checked = validateAsset(runtime, asset, {
    expectedBuilt: runtime.index.built,
    expectedThrough: shiftDate(runtime.index.built, 14),
  });
  assert.equal(checked.ok, true, checked.errors.join("\n"));
});

test("validator rejects malformed dates and repeated clubs in published history", () => {
  generated ||= buildSchedule(runtime, null);
  assert.throws(() => shiftDate("2026-02-30", 1), /invalid ISO date/);
  const repeated = structuredClone(generated);
  const date = Object.keys(repeated.days)[0];
  repeated.days[date][1][0] = repeated.days[date][0][0];
  const checked = validateAsset(runtime, repeated);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("\n"), /repeats within the day/);
});

test("730-day deterministic audit meets repetition and balance bounds", { timeout: 120_000 }, () => {
  const result = auditSchedule(runtime);
  assert.equal(result.days, 730);
});
