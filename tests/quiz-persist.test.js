"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EPOCH, createRuntime, loadRuntime } = require("../scripts/quiz-schedule.js");
const QuizCore = require("../site/quiz-core.js");

const source = fs.readFileSync(path.join(__dirname, "../site/quiz.js"), "utf8");
const schedule = JSON.parse(fs.readFileSync(path.join(__dirname, "../site/data/quiz-schedule.json"), "utf8"));

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return {
    get quizSeries() { return data.quizSeries; },
    set quizSeries(v) { data.quizSeries = v; },
    get quiz() { return data.quiz; },
    set quiz(v) { data.quiz = v; },
    get quizStats() { return data.quizStats; },
    set quizStats(v) { data.quizStats = v; },
    get quizHistory() { return data.quizHistory; },
    set quizHistory(v) { data.quizHistory = v; },
    get quizReplays() { return data.quizReplays; },
    set quizReplays(v) { data.quizReplays = v; },
    removeItem(key) { delete data[key]; },
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    _data: data,
  };
}

function el(id) {
  return {
    id, hidden: false, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    style: {}, innerHTML: "", textContent: "", value: "",
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, blur() {}, select() {},
    appendChild() {}, remove() {}, onclick: null, offsetWidth: 0,
  };
}

function frozenDate(isoDay) {
  const RealDate = Date;
  const fixed = RealDate.parse(`${isoDay}T12:00:00`);
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  }
  MockDate.UTC = RealDate.UTC;
  MockDate.parse = RealDate.parse;
  return MockDate;
}

function loadQuiz(storage, today) {
  const browser = createRuntime(structuredClone(loadRuntime().index));
  browser.index.quizSchedule = structuredClone(schedule);
  const ids = {};
  const $ = (id) => (ids[id] ||= el(id));
  ["quiz", "modebar", "mode-quiz", "mode-club", "mode-player", "tagline", "langsel"].forEach($);
  const document = {
    body: { classList: { add() {}, remove() {}, contains: () => false, toggle() {} } },
    documentElement: { lang: "it" },
    getElementById: $,
    createElement: (tag) => el(tag),
    addEventListener() {},
    dispatchEvent() { return true; },
    activeElement: null,
  };
  const localStorage = memoryStorage({ quizSeries: EPOCH, ...storage });
  const context = vm.createContext({
    CORE_DB: browser.index, DB: browser.index, QuizCore,
    corePostings: browser.postings, postings: browser.postings,
    intersect: browser.intersect, coreLeagueCC: browser.leagueCC,
    coreClub: name => name, coreStature: () => 1,
    MARQUEE: new Set(),
    localStorage, document, window: { requestIdleCallback: null },
    location: { hash: "" }, history: { replaceState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: {}, addEventListener() {},
    $, lang: "it", langSel: $("langsel"), mode: "club",
    clubIds: [], leagueIds: [], countryIds: [], playerIds: [],
    flag: (cc) => cc || "", esc: (s) => String(s), norm: (s) => String(s).toLowerCase(),
    careerOf: async () => [], suggOpen() {}, browseOpen() {}, syncHash() {},
    parseSelectionHash: () => ({ clubs: [], leagues: [], countries: [] }),
    setMode() {}, renderChips() {}, solve() {},
    Date: frozenDate(today),
  });
  // Same-script trailer keeps const/let in scope (they are not context properties).
  vm.runInContext(`${source}
globalThis.__quizTest = {
  qGen, qStagesFromQids, qStagesFor, qLoad, qGuess, qResign, qFinish, qCore, qToday, qSave,
  qForfeitRolled, qUtcMonth, qUtcWeekday, qRenderCal,
  get qs() { return qs; }, set qs(v) { qs = v; },
  get qPz() { return qPz; }, set qPz(v) { qPz = v; },
  get qHold() { return qHold; },
};
`, context);
  return { api: context.__quizTest, localStorage: context.localStorage, browser, today, context };
}

function pickToday() {
  const days = Object.keys(schedule.days || {}).sort();
  return days.find(d => d <= schedule.lockedThrough) || days.at(-1) || EPOCH;
}
function dayAfter(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

test("qStagesFromQids fails the whole slate when one stage has no effective answers", () => {
  const today = pickToday();
  const { api, browser } = loadQuiz({}, today);
  const generated = api.qGen(today);
  const rows = generated.stages.map(st => st.clubs.map(ci => browser.index.clubs[ci][3]));
  assert.equal(rows.length, 4);

  const core = api.qCore();
  const realEffective = core.qEffective.bind(core);
  let stageIndex = 0;
  core.qEffective = (clubs, raw) => {
    const i = stageIndex++;
    if (i === 2) return [];
    return realEffective(clubs, raw);
  };

  stageIndex = 0;
  assert.equal(api.qStagesFromQids(rows, { date: today, guesses: [] }), null);

  const face = generated.stages[2].answers[0];
  assert.ok(Number.isInteger(face) && face >= 0);
  stageIndex = 0;
  const restored = api.qStagesFromQids(rows, {
    date: today,
    guesses: [{ stage: 2, ok: true, pid: face, name: browser.index.names[face] }],
  });
  assert.ok(restored);
  assert.equal(restored[2].grandfatheredFace, face);
  assert.deepEqual(restored.map(st => st.clubs.map(ci => browser.index.clubs[ci][3])), rows);
});

test("qStats is idempotent per date and qLoad prefers finished history over stale quiz", () => {
  const today = pickToday();
  const { api, localStorage } = loadQuiz({}, today);

  api.qLoad();
  assert.ok(api.qs);
  assert.equal(api.qs.date, today);
  assert.equal(api.qs.done, false);

  const answer = api.qPz.stages[0].answers[0];
  assert.equal(api.qGuess(answer), "stage");
  api.qResign();
  assert.equal(api.qs.done, true);
  assert.equal(api.qs.won, false);

  const statsOnce = JSON.parse(localStorage.quizStats);
  assert.equal(statsOnce.played, 1);
  assert.equal(statsOnce.lastPlayDate, today);
  assert.ok(JSON.parse(localStorage.quizHistory).days[today]);

  // Simulate the race: aggregates say done, live quiz still looks in progress.
  const live = JSON.parse(localStorage.quiz);
  live.done = false;
  live.won = false;
  live.stage = 1;
  localStorage.quiz = JSON.stringify(live);

  api.qFinish();
  api.qFinish();
  const statsAgain = JSON.parse(localStorage.quizStats);
  assert.equal(statsAgain.played, 1);
  assert.deepEqual(statsAgain.byStage, statsOnce.byStage);

  api.qs = null;
  api.qPz = null;
  api.qLoad();
  assert.equal(api.qs.done, true);
  assert.equal(api.qs.date, today);
  assert.equal(JSON.parse(localStorage.quiz).done, true);
});

test("finishing persists quiz before aggregates so a later load cannot double-count", () => {
  const today = pickToday();
  const { api, localStorage, browser } = loadQuiz({}, today);
  api.qLoad();

  const writes = [];
  const raw = localStorage;
  Object.defineProperty(raw, "quiz", {
    configurable: true, enumerable: true,
    get() { return raw._data.quiz; },
    set(v) { writes.push("quiz"); raw._data.quiz = v; },
  });
  Object.defineProperty(raw, "quizStats", {
    configurable: true, enumerable: true,
    get() { return raw._data.quizStats; },
    set(v) { writes.push("quizStats"); raw._data.quizStats = v; },
  });
  Object.defineProperty(raw, "quizHistory", {
    configurable: true, enumerable: true,
    get() { return raw._data.quizHistory; },
    set(v) { writes.push("quizHistory"); raw._data.quizHistory = v; },
  });

  api.qs.lives = 1;
  const answers = new Set(api.qPz.stages[0].answers);
  const wrong = browser.index.names.findIndex((_, pid) => !answers.has(pid));
  assert.ok(wrong >= 0);
  assert.equal(api.qGuess(wrong), "lost");

  const quizAt = writes.indexOf("quiz");
  const statsAt = writes.indexOf("quizStats");
  const histAt = writes.indexOf("quizHistory");
  assert.ok(quizAt >= 0 && statsAt >= 0 && histAt >= 0);
  assert.ok(quizAt < statsAt, "terminal quiz blob must land before quizStats");
  assert.ok(quizAt < histAt, "terminal quiz blob must land before quizHistory");
});

test("a failed terminal save rolls the guess back and skips stats", () => {
  const today = pickToday();
  const { api, localStorage, browser } = loadQuiz({}, today);
  api.qLoad();
  api.qs.lives = 1;
  assert.equal(api.qSave(), true);
  let fail = false;
  const raw = localStorage;
  Object.defineProperty(raw, "quiz", {
    configurable: true, enumerable: true,
    get() { return raw._data.quiz; },
    set(v) { if (fail) throw new Error("QuotaExceededError"); raw._data.quiz = v; },
  });
  const answers = new Set(api.qPz.stages[0].answers);
  const wrong = browser.index.names.findIndex((_, pid) => !answers.has(pid));
  fail = true;
  assert.equal(api.qGuess(wrong), null);
  assert.equal(api.qs.done, false);
  assert.equal(api.qs.lives, 1);
  assert.equal(api.qs.guesses.length, 0);
  assert.equal(JSON.parse(localStorage.quiz).done, false);
  assert.equal(localStorage.quizStats, undefined);
  assert.equal(JSON.parse(localStorage.quizHistory || '{"days":{}}').days[today], undefined);
});

test("restoring a finished day backfills stats that never landed", () => {
  const today = pickToday();
  const { api, localStorage } = loadQuiz({}, today);
  api.qLoad();
  api.qResign();
  localStorage.quizStats = JSON.stringify({
    v: 1, played: 0, streak: 0, maxStreak: 0, lastWinDate: null,
    byStage: [0, 0, 0, 0, 0], lastPlayDate: "2020-01-01",
  });
  api.qs = null;
  api.qLoad();
  const stats = JSON.parse(localStorage.quizStats);
  assert.equal(stats.played, 1);
  assert.equal(stats.lastPlayDate, today);
  assert.equal(api.qs.done, true);
});

test("a pre-cursor stats save is not counted twice when history already has the day", () => {
  const today = pickToday();
  const { api, localStorage } = loadQuiz({}, today);
  api.qLoad();
  api.qResign();
  const stats = JSON.parse(localStorage.quizStats);
  delete stats.lastPlayDate;
  stats.played = 4;
  localStorage.quizStats = JSON.stringify(stats);
  api.qs = null;
  api.qLoad();
  const again = JSON.parse(localStorage.quizStats);
  assert.equal(again.played, 4);
  assert.equal(again.lastPlayDate, today);
});

test("a missing schedule does not pin a local slate", () => {
  const today = pickToday();
  const { api, localStorage, browser } = loadQuiz({}, today);
  const saved = browser.index.quizSchedule;
  browser.index.quizSchedule = null;
  assert.equal(api.qStagesFor(today), null);
  api.qLoad();
  assert.equal(api.qs, null);
  assert.equal(api.qHold, "schedule");
  assert.equal(localStorage.quiz, undefined);

  localStorage.quiz = JSON.stringify({
    v: 2, date: today, num: 1, built: browser.index.built,
    stages: [["QX", "QY"], ["QX", "QY"], ["QX", "QY"], ["QX", "QY"]],
    stage: 0, lives: 5, guesses: [], hints: { nat: null, ini: null, ini2: null },
    hintTargets: {}, skipped: [], done: false, won: false,
  });
  api.qLoad();
  assert.equal(localStorage.quiz, undefined);
  assert.equal(api.qs, null);

  browser.index.quizSchedule = saved;
  api.qLoad();
  assert.deepEqual(api.qs.stages, saved.days[today]);
  assert.equal(api.qs.done, false);
});

test("a started game still restores when the schedule file is missing", () => {
  const today = pickToday();
  const { api, localStorage, browser } = loadQuiz({}, today);
  api.qLoad();
  const stages = JSON.parse(JSON.stringify(api.qs.stages));
  assert.equal(api.qGuess(api.qPz.stages[0].answers[0]), "stage");
  browser.index.quizSchedule = null;
  api.qs = null;
  api.qPz = null;
  api.qLoad();
  assert.equal(api.qs.guesses.length, 1);
  assert.equal(JSON.stringify(api.qs.stages), JSON.stringify(stages));
  assert.equal(localStorage.quizStats, undefined);
});

test("midnight forfeits a started run only from the play action", () => {
  const today = pickToday();
  const next = dayAfter(today);
  const started = loadQuiz({}, today);
  started.api.qLoad();
  assert.equal(started.api.qGuess(started.api.qPz.stages[0].answers[0]), "stage");
  started.context.Date = frozenDate(next);
  started.api.qLoad();
  assert.equal(started.api.qs.date, today);
  assert.equal(started.api.qs.done, false);
  assert.equal(JSON.parse(started.localStorage.quizHistory || '{"days":{}}').days[today], undefined);
  assert.equal(started.api.qForfeitRolled(), true);
  started.api.qLoad();
  assert.equal(started.api.qs.date, next);
  assert.equal(started.api.qs.done, false);
  const stats = JSON.parse(started.localStorage.quizStats);
  assert.equal(stats.played, 1);
  assert.equal(stats.lastPlayDate, today);
  assert.ok(JSON.parse(started.localStorage.quizHistory).days[today]);

  const fresh = loadQuiz({}, today);
  fresh.api.qLoad();
  fresh.context.Date = frozenDate(next);
  fresh.api.qLoad();
  assert.equal(fresh.api.qs.date, next);
  assert.equal(JSON.parse(fresh.localStorage.quizHistory || '{"days":{}}').days[today], undefined);
  assert.equal(fresh.localStorage.quizStats, undefined);
});

test("a finished day that cannot be restored does not start another official game", () => {
  const today = pickToday();
  const { api, localStorage } = loadQuiz({}, today);
  api.qLoad();
  api.qResign();
  const hist = JSON.parse(localStorage.quizHistory);
  const played = JSON.parse(localStorage.quizStats).played;
  delete hist.days[today].state;
  localStorage.quizHistory = JSON.stringify(hist);
  localStorage.quiz = JSON.stringify({
    v: 2, date: today, num: hist.days[today].num, stages: hist.days[today].stages,
    stage: 0, lives: 5, guesses: [], hints: { nat: null, ini: null, ini2: null },
    hintTargets: {}, skipped: [], done: false, won: false,
  });
  api.qs = null;
  api.qLoad();
  assert.equal(api.qs.done, true);
  assert.equal(JSON.stringify(api.qs.stages), JSON.stringify(hist.days[today].stages));
  assert.equal(JSON.parse(localStorage.quizStats).played, played);

  hist.days[today].stages = [["QX"], ["QX"], ["QX"], ["QX"]];
  localStorage.quizHistory = JSON.stringify(hist);
  api.qs = null;
  api.qLoad();
  assert.equal(api.qs, null);
  assert.equal(api.qHold, "retired");
  assert.equal(localStorage.quiz, undefined);
  api.qLoad();
  assert.equal(api.qs, null);
  assert.equal(JSON.parse(localStorage.quizStats).played, played);
});

test("archive month and weekday labels follow the UTC calendar date", () => {
  const today = pickToday();
  const { api, context } = loadQuiz({}, today);
  context.lang = "en";
  assert.equal(api.qUtcMonth(2026, 8), "August 2026");
  const monday = new Date(Date.UTC(2024, 0, 1)).toLocaleDateString("en", { weekday: "narrow", timeZone: "UTC" });
  assert.equal(api.qUtcWeekday(0), monday);
  assert.notEqual(api.qUtcWeekday(0), api.qUtcWeekday(1));
});

test("archive results place four squares directly in each calendar grid box", () => {
  const today = pickToday();
  const { api, context } = loadQuiz({ quizHistory: JSON.stringify({
    v: 1, days: { [today]: { res: [0, 1, 2, 3] } },
  }) }, today);
  const calendar = context.$("qcal");
  calendar.querySelector = () => el("back");
  api.qRenderCal();
  const boxes = [...calendar.innerHTML.matchAll(/<span class="qcbox">([\s\S]*?)<\/span>/g)];
  const results = boxes.map(match => match[1]).find(html => html.includes('class="rsq '));
  assert.ok(results, "played day contains result squares");
  assert.doesNotMatch(results, /<(?:span|div)\b/, "nested wrappers break the two-by-two grid");
  assert.deepEqual([...results.matchAll(/class="rsq r(\d)"/g)].map(match => Number(match[1])), [0, 1, 2, 3]);
});
