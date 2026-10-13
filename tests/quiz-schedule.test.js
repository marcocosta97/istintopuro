"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const {
  AUDIT_DAYS, auditSchedule, buildSchedule, countryBalanceErrors, createRuntime, EPOCH, inspectEntry,
  loadRuntime, shiftDate, scheduleThrough, validateAsset,
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
    expectedThrough: scheduleThrough(runtime.index.built, asset.horizonThrough),
  });
  assert.equal(checked.ok, true, checked.errors.join("\n"));
});

test("explicit regeneration replaces future locks while preserving earlier published days", () => {
  const asset = JSON.parse(fs.readFileSync(path.join(ROOT, "site/data/quiz-schedule.json"), "utf8"));
  const from = shiftDate(runtime.index.built, 6), through = shiftDate(from, 13);
  const input = structuredClone(asset);
  input.lockedThrough = shiftDate(from, 5);
  input.days[from][0].reverse();
  const output = buildSchedule(runtime, input, { regenerateFrom: from, through });
  assert.equal(output.lockedThrough, shiftDate(from, -1));
  assert.equal(output.through, through);
  assert.equal(output.horizonThrough, through);
  for (const [date, rows] of Object.entries(input.days))
    if (date < from) assert.deepEqual(output.days[date], rows, date);
  assert.notDeepEqual(output.days[from], input.days[from]);
  assert.deepEqual(buildSchedule(runtime, output), output, "normal refresh must retain the requested horizon");
  assert.equal(validateAsset(runtime, output, { expectedBuilt: runtime.index.built,
    expectedThrough: scheduleThrough(runtime.index.built, output.horizonThrough) }).ok, true);
  assert.throws(() => buildSchedule(runtime, input, { regenerateFrom: runtime.index.built }), /regenerateFrom/);
  assert.throws(() => buildSchedule(runtime, input, { regenerateFrom: "2026-02-30" }), /regenerateFrom/);
  const invalid = { ...output, horizonThrough: shiftDate(through, 1) };
  assert.match(validateAsset(runtime, invalid).errors.join("\n"), /horizonThrough/);
});

test("a higher medium score is valid when its recognition requirements differ from easy", () => {
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
  assert.match(checked.errors.join("\n"), /repeats within the day/);
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
