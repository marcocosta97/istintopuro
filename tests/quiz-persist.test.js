"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EPOCH, createRuntime, loadRuntime } = require("../scripts/quiz-schedule.js");
const QuizCore = require("../site/quiz-core.js");
const QuizRecognition = require("../site/quiz-recognition.js");
const QuizResult = require("../site/quiz-result.js");

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
    CORE_DB: browser.index, DB: browser.index, QuizCore, QuizRecognition, QuizResult,
    corePostings: browser.postings, postings: browser.postings,
    intersect: browser.intersect, coreLeagueCC: browser.leagueCC,
    coreClub: name => name, coreStature: () => 1,
    MARQUEE: new Set(),
    localStorage, document, window: { requestIdleCallback: null },
    location: { hash: "", href: "https://game.test/" }, history: { replaceState() {} }, URL,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: {}, addEventListener() {},
    $, lang: "it", langSel: $("langsel"), mode: "club",
    clubIds: [], leagueIds: [], countryIds: [], playerIds: [],
    flag: (cc) => cc || "", countryFlag: (cc) => cc || "", natName: cc => cc, defunct: () => "",
    esc: (s) => String(s), norm: (s) => String(s).toLowerCase(),
    careerOf: async () => [], suggOpen() {}, browseOpen() {}, syncHash() {},
    parseSelectionHash: () => ({ clubs: [], leagues: [], countries: [] }),
    setMode() {}, renderChips() {}, solve() {},
    Date: frozenDate(today),
  });
  // Same-script trailer keeps const/let in scope (they are not context properties).
  vm.runInContext(`${source}
globalThis.__quizTest = {
  qGen, qStagesFromQids, qStagesFor, qLoad, qGuess, qResign, qFinish, qCore, qToday, qSave,
  qForfeitRolled, qUtcMonth, qUtcWeekday, qRenderCal, qRenderEnd, qGetStats, qStartReplay, qShareText, qSkipStage, quizReset, qBonusText,
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

test("archive shows an earned purple bonus without changing persisted outcome codes", () => {
  const today = pickToday(), { api, context, localStorage } = loadQuiz({}, today);
  api.qLoad();
  const pid = api.qPz.stages[0].answers[0];
  api.qs.bonus = { stage: 0, kind: "nationality", value: "DZ", targets: [api.qCore().choiceIdentity(pid)] };
  api.qGuess(pid); api.qResign();
  const saved = localStorage.quizHistory;
  const res = JSON.parse(saved).days[today].res;
  context.$("qcal").querySelector = () => el("back");
  api.qRenderCal();
  assert.match(context.$("qcal").innerHTML, /class="rsq rb"/);
  assert.match(context.$("qcal").innerHTML, /aria-label="Schedina #1 · 1\/4 · Risposta bonus"/);
  assert.deepEqual(res, [0, 2, 3, 3]);
  assert.equal(localStorage.quizHistory, saved);
});

function clearDaily(api) {
  for (let i = 0; i < 3; i++) assert.equal(api.qGuess(api.qPz.stages[i].answers[0]), "stage");
}

test("daily streak is saved before Impossible, survives reload, failure and repeated finishes", () => {
  const today = pickToday();
  const first = loadQuiz({}, today);
  first.api.qLoad();
  first.api.qs.hints.nat = 1;
  clearDaily(first.api);
  assert.equal(first.api.qs.done, false);
  assert.equal(first.api.qGetStats().streak, 1);
  assert.equal(first.api.qGetStats().played, 0);
  const restored = loadQuiz(first.localStorage._data, today);
  restored.api.qLoad();
  assert.equal(restored.api.qs.stage, 3);
  assert.equal(restored.api.qGetStats().streak, 1);
  for (let n = 0; n < 5; n++) {
    const wrong = restored.browser.index.names.findIndex((_name, pid) => !restored.api.qPz.stages[3].answers.includes(pid)
      && !restored.api.qs.guesses.some(g => g.stage === 3 && g.pid === pid));
    restored.api.qGuess(wrong);
  }
  assert.equal(restored.api.qs.done, true);
  assert.equal(restored.api.qs.won, false);
  assert.equal(restored.api.qGetStats().streak, 1);
  assert.equal(restored.api.qGetStats().played, 1);
  restored.api.qFinish();
  assert.equal(restored.api.qGetStats().streak, 1);
  assert.equal(restored.api.qGetStats().played, 1);
});

test("closing an unfinished Impossible after midnight keeps the secured daily streak", () => {
  const today = pickToday(), ctx = loadQuiz({}, today);
  ctx.api.qLoad(); clearDaily(ctx.api);
  ctx.context.Date = frozenDate(dayAfter(today));
  assert.equal(ctx.api.qForfeitRolled(), true);
  assert.equal(ctx.api.qGetStats().streak, 1);
  ctx.api.qLoad(); clearDaily(ctx.api);
  assert.equal(ctx.api.qGetStats().streak, 2);
  ctx.api.qResign();
  assert.equal(ctx.api.qGetStats().streak, 2);
});

test("closing Impossible without guessing shares no invented wrong attempt", () => {
  const { api } = loadQuiz({}, pickToday());
  api.qLoad(); clearDaily(api); api.qResign();
  const share = api.qShareText();
  assert.match(share, /impossibile \(extra\)  ⬜/);
  assert.doesNotMatch(share, /🟥/);
  assert.match(share, /0 errori/);
});

test("a rolled-back third answer cannot secure the day", () => {
  const { api, localStorage } = loadQuiz({}, pickToday());
  api.qLoad();
  api.qGuess(api.qPz.stages[0].answers[0]);
  api.qGuess(api.qPz.stages[1].answers[0]);
  Object.defineProperty(localStorage, "quiz", { configurable: true,
    get() { return localStorage._data.quiz; }, set() { throw new Error("QuotaExceededError"); } });
  assert.equal(api.qGuess(api.qPz.stages[2].answers[0]), null);
  assert.equal(api.qs.stage, 2);
  assert.equal(localStorage.quizStats, undefined);
});

test("purple is earned only by an accepted matching answer and survives restore", () => {
  const ctx = loadQuiz({}, pickToday()), { api } = ctx;
  api.qLoad();
  const pid = api.qPz.stages[0].answers[0];
  api.qs.bonus = { stage: 0, kind: "nationality", value: "DZ", targets: [api.qCore().choiceIdentity(pid)] };
  api.qGuess(pid);
  assert.equal(api.qs.guesses[0].bonus, true);
  assert.equal(api.qs.stage, 1, "bonus gives no extra attempt");
  const restored = loadQuiz(ctx.localStorage._data, ctx.today);
  restored.api.qLoad();
  assert.equal(restored.api.qs.guesses[0].bonus, true);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.api.qs.bonus)), JSON.parse(JSON.stringify(api.qs.bonus)));
  const normal = loadQuiz({}, pickToday()); normal.api.qLoad();
  normal.api.qs.bonus = { stage: 0, kind: "nationality", value: "DZ", targets: ["Another player\u00001990"] };
  assert.equal(normal.api.qGuess(normal.api.qPz.stages[0].answers[0]), "stage");
  assert.equal(normal.api.qs.guesses[0].bonus, false);
});

test("updating published bonus selection does not replace a criterion already shown", () => {
  const today = pickToday(), initial = loadQuiz({}, today);
  initial.api.qLoad();
  const pid = initial.api.qPz.stages[0].answers[0];
  const shown = { stage: 0, kind: "birth", from: 1990, to: 1999,
    targets: [initial.api.qCore().choiceIdentity(pid)] };
  initial.api.qs.bonus = shown;
  initial.api.qSave();
  const restored = loadQuiz(initial.localStorage._data, today);
  restored.browser.index.quizSchedule.bonuses[today] = { stage: 0, kind: "career", value: "Different Club",
    targets: shown.targets };
  restored.api.qLoad();
  assert.deepEqual(JSON.parse(JSON.stringify(restored.api.qs.bonus)), shown);
});

test("practice never increments an official streak and sharing names no answers", () => {
  const today = dayAfter(pickToday()), ctx = loadQuiz({}, today);
  ctx.api.qLoad(); clearDaily(ctx.api); ctx.api.qResign();
  const before = ctx.localStorage.quizStats;
  ctx.api.qStartReplay(pickToday()); clearDaily(ctx.api); ctx.api.qResign();
  assert.equal(ctx.localStorage.quizStats, before);
  const share = ctx.api.qShareText();
  assert.match(share, /\?day=2026-08-21#quiz/);
  assert.doesNotMatch(share, /giorn[oi] di serie/);
  for (const guess of ctx.api.qs.guesses) assert.equal(share.includes(guess.name), false);
});

test("quizReset archive option removes only today's result and preserves stats and other days", () => {
  const earlier = pickToday(), today = dayAfter(earlier), ctx = loadQuiz({}, today);
  ctx.api.qLoad(); clearDaily(ctx.api); ctx.api.qResign();
  const h = JSON.parse(ctx.localStorage.quizHistory);
  h.days[earlier] = { num: 1, res: [0, 1, 2, 3] };
  ctx.localStorage.quizHistory = JSON.stringify(h);
  const stats = ctx.localStorage.quizStats;
  ctx.localStorage.quizReplays = JSON.stringify({ v: 1, days: { [earlier]: { stage: 1 } } });
  const replays = ctx.localStorage.quizReplays;
  assert.equal(ctx.api.quizReset({ archive: true }), "quiz reset");
  const after = JSON.parse(ctx.localStorage.quizHistory);
  assert.equal(after.days[today], undefined);
  assert.deepEqual(after.days[earlier], h.days[earlier]);
  assert.equal(ctx.localStorage.quizStats, stats);
  assert.equal(ctx.localStorage.quizReplays, replays);
  assert.equal(ctx.localStorage.quiz, undefined);
  ctx.api.qLoad();
  assert.equal(ctx.api.qs.date, today);
  assert.equal(ctx.api.qs.done, false);
  assert.equal(ctx.api.qs.guesses.length, 0);
});

test("quizReset retains its boolean stats option and can combine stats and archive removal", () => {
  const ctx = loadQuiz({}, pickToday());
  ctx.api.qLoad(); clearDaily(ctx.api); ctx.api.qResign();
  const stats = ctx.localStorage.quizStats, archive = ctx.localStorage.quizHistory;
  ctx.api.quizReset();
  assert.equal(ctx.localStorage.quizStats, stats);
  assert.equal(ctx.localStorage.quizHistory, archive);
  ctx.api.qLoad();
  assert.equal(ctx.api.qs.done, true, "default reset still respects a completed archived day");
  ctx.api.quizReset(true);
  assert.equal(ctx.localStorage.quizStats, undefined);
  assert.equal(ctx.localStorage.quizHistory, archive);
  ctx.api.qLoad();
  assert.equal(ctx.api.qs.done, true);
  ctx.api.quizReset({ archive: true, stats: true });
  assert.equal(ctx.localStorage.quizStats, undefined);
  ctx.api.qLoad();
  assert.equal(ctx.api.qs.done, false);
  assert.equal(ctx.localStorage.quizStats, undefined);
});

test("quizReset from the open archive returns to today's fresh board and dated URL", () => {
  const earlier = pickToday(), today = dayAfter(earlier), ctx = loadQuiz({}, today);
  ctx.api.qLoad(); clearDaily(ctx.api); ctx.api.qResign();
  ctx.api.qStartReplay(earlier);
  vm.runInContext(`qReplayDate = qShift(qToday(), -1); qConfirm = "leave"; qLeaveMode = "club";`, ctx.context);
  const classes = new Set(["quiz", "qcal"]), cl = ctx.context.document.body.classList;
  cl.contains = name => classes.has(name);
  cl.remove = (...names) => names.forEach(name => classes.delete(name));
  ctx.context.location.href = `https://game.test/?day=${earlier}#quiz`;
  let nextUrl;
  ctx.context.history.replaceState = (_state, _title, url) => { nextUrl = url; };
  ctx.api.quizReset({ archive: true });
  assert.equal(ctx.api.qs.date, today);
  assert.equal(ctx.api.qs.done, false);
  assert.equal(classes.has("qcal"), false);
  assert.equal(new URL(nextUrl).searchParams.get("day"), today);
  assert.equal(vm.runInContext("qReplaying", ctx.context), false);
  assert.equal(vm.runInContext("qReplayDate", ctx.context), null);
  assert.equal(vm.runInContext("qConfirm", ctx.context), null);
});

test("nationality bonus labels preserve historic countries and localize legacy multi-country clues", () => {
  const { api, context } = loadQuiz({}, pickToday());
  const app = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
  vm.runInContext(app.slice(app.indexOf("const HIST_NAME ="), app.indexOf("// defunct marker:")), context);
  assert.equal(api.qBonusText({ kind: "nationality", value: "YU" }), "Nazionalità: Jugoslavia");
  assert.equal(api.qBonusText({ kind: "nationality", value: "FR,SN" }), "Nazionalità: Francia / Senegal");
  context.lang = "en";
  assert.equal(api.qBonusText({ kind: "nationality", value: "YU" }), "Nationality: Yugoslavia");
});

test("answer disclosure includes every unguessed bonus option outside the first six without awarding it", () => {
  const { api, context, localStorage } = loadQuiz({}, "2026-11-11");
  api.qLoad();
  const stage = api.qPz.stages[0], core = api.qCore();
  const choices = core.uniqueChoices([...core.qRanked(stage), ...stage.answers]);
  assert.ok(choices.length > 8);
  const extra = choices.slice(-2);
  api.qs.bonus = { stage: 0, kind: "nationality", value: "DZ", targets: extra.map(core.choiceIdentity) };
  api.qGuess(choices[0]); api.qResign();
  const state = JSON.stringify(api.qs), stats = localStorage.quizStats, history = localStorage.quizHistory;
  api.qRenderEnd();
  const reveal = context.$("qend").innerHTML.match(/<div class="qreveal">([\s\S]*?)<\/div>/)[1];
  assert.equal([...reveal.matchAll(/class="qrp"/g)].length, 8);
  assert.equal([...reveal.matchAll(/class="qbonus-hit"/g)].length, 2);
  for (const pid of extra) assert.equal([...reveal.matchAll(new RegExp(`data-p="${pid}"`, "g"))].length, 1);
  const remaining = choices.length - 8;
  assert.ok(reveal.includes(vm.runInContext(`QSTR[lang].qOthers(${remaining})`, context)));
  assert.equal(JSON.stringify(api.qs), state);
  assert.equal(localStorage.quizStats, stats);
  assert.equal(localStorage.quizHistory, history);
  assert.ok(api.qs.guesses.every(g => !g.bonus));
  assert.equal(api.qShareText().includes("🟪"), false);
});

test("a bonus option already among the first six is marked once without duplication", () => {
  const { api, context } = loadQuiz({}, "2026-11-11");
  api.qLoad();
  const stage = api.qPz.stages[0], core = api.qCore();
  const choices = core.uniqueChoices([...core.qRanked(stage), ...stage.answers]), pid = choices[1];
  api.qs.bonus = { stage: 0, kind: "nationality", value: "DZ", targets: [core.choiceIdentity(pid)] };
  api.qGuess(pid); api.qResign();
  const reveal = context.$("qend").innerHTML.match(/<div class="qreveal">([\s\S]*?)<\/div>/)[1];
  assert.equal([...reveal.matchAll(/class="qrp"/g)].length, 6);
  assert.equal([...reveal.matchAll(/class="qbonus-hit"/g)].length, 1);
  assert.equal([...reveal.matchAll(new RegExp(`data-p="${pid}"`, "g"))].length, 1);
  assert.equal(api.qs.guesses[0].bonus, true);
});
