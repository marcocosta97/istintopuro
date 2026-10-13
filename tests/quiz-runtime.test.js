"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { shiftDate, EPOCH, loadRuntime, createRuntime } = require("../scripts/quiz-schedule.js");
const QuizCore = require("../site/quiz-core.js");

const source = fs.readFileSync(path.join(__dirname, "../site/quiz.js"), "utf8");

function runtime(days) {
  const calls = [];
  const core = {
    constants: { QCOMBO_DAYS: 30 },
    qShift: shiftDate,
    validateEntry: rows => ({ ok: rows.length === 4, stages: rows }),
    generate: (date, options) => {
      calls.push({ date, previousDays: options.previousDays });
      return { date, stages: [1, 2, 3, 4] };
    },
  };
  const context = vm.createContext({ CORE_DB: { quizSchedule: { days } },
    QuizCore: { createQuizCore: () => core }, corePostings() {}, intersect() {},
    coreStature() {}, coreLeagueCC() {}, coreClub() {}, MARQUEE: new Set(),
    localStorage: { quizSeries: EPOCH },
  });
  vm.runInContext(source.slice(0, source.indexOf("const qGen =")), context);
  return { calls, stagesFor: date => context.qStagesFor(date) };
}

test("opening a scheduled day does not generate or replay unrelated history", () => {
  const date = shiftDate(EPOCH, 89), stages = [1, 2, 3, 4];
  const { calls, stagesFor } = runtime({ [date]: stages });
  assert.equal(stagesFor(date), stages);
  assert.equal(stagesFor(date), stages);
  assert.equal(calls.length, 0);
});

test("fallback reconstructs missing history before the published tail", () => {
  const days = {};
  for (let day = 60; day < 90; day++) days[shiftDate(EPOCH, day)] = [1, 2, 3, 4];
  const { calls, stagesFor } = runtime(days);
  const date = shiftDate(EPOCH, 90);
  stagesFor(date);
  assert.equal(calls.length, 61);
  assert.equal(calls.at(-1).date, date);
  assert.equal(calls.at(-1).previousDays.length, 90);
  assert.equal(calls.at(-1).previousDays[0].date, EPOCH);
  assert.equal(calls.at(-1).previousDays.at(-1).date, shiftDate(EPOCH, 89));
});

test("without a published schedule the runtime replays the whole prior chain", () => {
  const date = shiftDate(EPOCH, 95);
  const { calls, stagesFor } = runtime({});
  stagesFor(date);
  assert.equal(calls.length, 96);
  assert.equal(calls[0].date, EPOCH);
  assert.equal(calls[0].previousDays.length, 0);
  assert.equal(calls.at(-1).date, date);
  assert.equal(calls.at(-1).previousDays.length, 95);
  assert.equal(calls.at(-1).previousDays[0].date, EPOCH);
});

test("browser fallback agrees with the writer after locked published history", () => {
  const node = loadRuntime();
  const asset = JSON.parse(fs.readFileSync(path.join(__dirname, "../site/data/quiz-schedule.json"), "utf8"));
  const date = shiftDate(asset.through, 1);
  const previousDays = Object.keys(asset.days).sort().map(date => ({ date, stages: asset.days[date] }));
  const expected = node.core.serializeStages(node.core.generate(date, { previousDays }).stages);
  const browser = createRuntime(structuredClone(node.index));
  browser.index.quizSchedule = asset;
  const context = vm.createContext({ CORE_DB: browser.index, QuizCore,
    corePostings: browser.postings, intersect: browser.intersect,
    coreLeagueCC: browser.leagueCC, coreClub: name => name,
    localStorage: { quizSeries: EPOCH, quizHistory: '{"days":{}}' },
  });
  vm.runInContext(source.slice(0, source.indexOf("const qGen =")), context);
  const stages = context.qStagesFor(date);
  assert.deepEqual(browser.core.serializeStages(stages), expected);
  assert.equal(browser.core.validateEntry(expected, { date, previousDays, requireLevels: true }).ok, true);
});

test("runtime preserves locked levels but repairs invalid future classifications", () => {
  const node = loadRuntime();
  const asset = JSON.parse(fs.readFileSync(path.join(__dirname, "../site/data/quiz-schedule.json"), "utf8"));
  const date = shiftDate(asset.lockedThrough, 1);
  const expected = asset.days[date];
  const corrupted = structuredClone(asset);
  [corrupted.days[date][0], corrupted.days[date][1]] = [corrupted.days[date][1], corrupted.days[date][0]];
  const browser = createRuntime(structuredClone(node.index));
  browser.index.quizSchedule = corrupted;
  const context = vm.createContext({ CORE_DB: browser.index, QuizCore,
    corePostings: browser.postings, intersect: browser.intersect,
    coreLeagueCC: browser.leagueCC, coreClub: name => name,
    localStorage: { quizSeries: EPOCH },
  });
  vm.runInContext(source.slice(0, source.indexOf("const qGen =")), context);
  assert.deepEqual(browser.core.serializeStages(context.qStagesFor(asset.lockedThrough)), asset.days[asset.lockedThrough]);
  assert.deepEqual(browser.core.serializeStages(context.qStagesFor(date)), expected);
});

test("browser and schedule use the same recognition model independently of solver ranking", () => {
  const node = loadRuntime();
  const browser = createRuntime(structuredClone(node.index));
  const context = vm.createContext({ CORE_DB: browser.index, QuizCore,
    corePostings: browser.postings, intersect: browser.intersect,
    coreLeagueCC: browser.leagueCC, coreClub: name => name,
    MARQUEE: new Set(), coreStature() { throw new Error("solver ranking leaked into quiz"); },
  });
  vm.runInContext(source.slice(0, source.indexOf("const qFmt =")), context);
  const browserCore = vm.runInContext("qCore()", context);
  const scheduled = node.core.generate(EPOCH);
  const generated = browserCore.generate(EPOCH);
  assert.deepEqual(browserCore.serializeStages(generated.stages), node.core.serializeStages(scheduled.stages));
  assert.deepEqual(generated.stages.map(stage => browserCore.stageDiagnostics(stage)),
    scheduled.stages.map(stage => node.core.stageDiagnostics(stage)));
});
