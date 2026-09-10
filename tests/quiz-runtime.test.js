"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { shiftDate, EPOCH } = require("../scripts/quiz-schedule.js");

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

test("fallback at a 90-day boundary retains the published repetition context", () => {
  const days = {};
  for (let day = 60; day < 90; day++) days[shiftDate(EPOCH, day)] = [1, 2, 3, 4];
  const { calls, stagesFor } = runtime(days);
  const date = shiftDate(EPOCH, 90);
  stagesFor(date);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].date, date);
  assert.equal(calls[0].previousDays.length, 30);
  assert.equal(calls[0].previousDays[0].date, shiftDate(EPOCH, 60));
  assert.equal(calls[0].previousDays.at(-1).date, shiftDate(EPOCH, 89));
});
