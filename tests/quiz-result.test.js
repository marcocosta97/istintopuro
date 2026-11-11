"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Result = require("../site/quiz-result.js");

function run(overrides = {}) {
  return { date: "2026-11-11", stage: 3, won: false, done: false, skipped: [],
    hints: { nat: null, ini: null, ini2: null },
    guesses: [0, 1, 2].map(stage => ({ stage, name: `Player ${stage}`, ok: true })), ...overrides };
}

test("the first three stages secure the day regardless of Impossible, hints and errors", () => {
  const state = run({ hints: { nat: 2, ini: null, ini2: null } });
  state.guesses.splice(1, 0, { stage: 1, ok: false });
  assert.equal(Result.dailyWon(state), true);
  const st = Result.updateStreak({ v: 1, streak: 6, maxStreak: 6, lastWinDate: "2026-11-10" }, state);
  assert.equal(st.streak, 7);
  for (const ending of [{ done: false }, { done: true }, { done: true, won: true }]) {
    const next = Result.updateStreak(st, { ...state, ...ending });
    assert.equal(next.streak, 7, "finishing Impossible never adds or loses a day");
  }
  const description = Result.describe(state);
  assert.equal(description.rows[1].errors, 1);
  assert.deepEqual(description.rows[2].attempts, ["hint"]);
  assert.equal(description.rows[3].code, 3);
});

test("skipping a daily stage cannot earn a day by solving Impossible instead", () => {
  const state = run({ won: true, done: true, skipped: [1] });
  assert.equal(Result.dailyCleared(state), 2);
  assert.equal(Result.dailyWon(state), false);
  assert.equal(Result.updateStreak({ streak: 6, maxStreak: 6, lastWinDate: "2026-11-10" }, state).streak, 0);
});

test("streaks respect missed dates, DST boundaries, legacy wins and stale display", () => {
  const prior = { v: 1, streak: 4, maxStreak: 9, lastWinDate: "2026-10-24" };
  const next = Result.updateStreak(prior, run({ date: "2026-10-25" }));
  assert.equal(next.streak, 5);
  assert.equal(next.maxStreak, 9);
  assert.equal(prior.streak, 4, "storage inputs are not mutated");
  assert.equal(Result.visibleStreak(next, "2026-10-26"), 5);
  assert.equal(Result.visibleStreak(next, "2026-10-27"), 0);
  assert.equal(Result.updateStreak(next, run({ date: "2026-10-27" })).streak, 1);
  assert.equal(Result.updateStreak(next, run({ date: "2026-10-23", done: true, stage: 1 })).streak, 5);
});

test("unknown historical details never fabricate perfect attempts or a bonus", () => {
  const result = Result.describe(run({ done: true, resultDetailsMissing: true }));
  assert.equal(result.success, true);
  assert.equal(result.errors, null);
  assert.equal(result.bonus, false);
  for (const row of result.rows) {
    assert.deepEqual(row.attempts, []);
    assert.equal(row.hit, null);
    assert.equal(row.firstTry, false);
  }
});

test("a purple answer preserves its separate hint count", () => {
  const state = run({ hints: { nat: 0 }, guesses: [{ stage: 0, ok: true, bonus: true }] });
  const result = Result.describe(state);
  assert.equal(result.bonus, true);
  assert.deepEqual(result.rows[0].attempts, ["bonus"]);
  assert.equal(result.hints, 1);
});

test("dated quiz links preserve base paths and reject invalid, future and prelaunch days", () => {
  const url = new URL(Result.quizUrl("https://game.test/football/?x=1#clubs", "2026-11-11"));
  assert.equal(url.pathname, "/football/");
  assert.equal(url.searchParams.get("day"), "2026-11-11");
  assert.equal(url.hash, "#quiz");
  for (const day of ["2026-02-30", "2026-11-12", "2026-08-20", "hello", null])
    assert.equal(Result.validDay(day, "2026-08-21", "2026-11-11"), null);
  assert.equal(Result.validDay("2026-11-11", "2026-08-21", "2026-11-11"), "2026-11-11");
});
