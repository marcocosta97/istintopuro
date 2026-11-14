"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
const source = app.slice(app.indexOf("function quizWelcomeEligible("), app.indexOf("function setupQuizWelcome("));
const eligible = vm.runInNewContext(source + "\nquizWelcomeEligible");
const storage = records => ({ getItem: key => key in records ? JSON.stringify(records[key]) : null });

test("new visitors and untouched boards can see the welcome", () => {
  assert.equal(eligible(storage({})), true);
  assert.equal(eligible(storage({ quiz: { stage: 0, guesses: [], skipped: [], hints: { nat: null }, done: false } })), true);
  assert.equal(eligible(storage({ quizStats: { played: 0 }, quizHistory: { days: {} } })), true);
});

test("dismissing the welcome suppresses it on later visits", () => {
  assert.equal(eligible({ getItem: key => key === "quizWelcomeSeen" ? "1" : null }), false);
});

test("a guess, hint, skip or completed game each establishes prior play", () => {
  for (const quiz of [{ guesses: [{ ok: false }] }, { hints: { nat: 0 } }, { skipped: [0] },
    { stage: 1 }, { done: true }, { won: true }]) {
    assert.equal(eligible(storage({ quiz })), false, JSON.stringify(quiz));
  }
});

test("statistics and old summary-only archive records suppress the welcome", () => {
  assert.equal(eligible(storage({ quizStats: { played: 1 } })), false);
  assert.equal(eligible(storage({ quizStats: { maxStreak: 1 } })), false);
  assert.equal(eligible(storage({ quizHistory: { days: { "2026-11-10": { res: [0, 0, 2, 3] } } } })), false);
});

test("archive practice counts even without live progress or aggregate stats", () => {
  assert.equal(eligible(storage({ quizReplays: { days: { "2026-11-10": { guesses: [{ ok: true }] } } } })), false);
  assert.equal(eligible(storage({ quizHistory: { days: { "2026-11-10": { state: { hints: { car: 0 } } } } } })), false);
  assert.equal(eligible(storage({ quizReplays: { days: { "2026-11-10": { guesses: [], stage: 0 } } } })), true);
});

test("malformed records do not crash detection; inaccessible storage does not interrupt visitors", () => {
  assert.equal(eligible({ getItem: () => "invalid-json" }), true);
  assert.equal(eligible({ getItem() { throw new Error("denied"); } }), false);
});

function launchWelcome({ ready = false, hash = "", entry, restoringSettings = false } = {}) {
  const saved = new Map(), listeners = {};
  const localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  let quizClicks = 0;
  const dialog = { open: false, addEventListener: (name, listener) => { listeners[name] = listener; },
    showModal() { this.open = true; }, close() { this.open = false; listeners.close?.(); } };
  const nodes = { intro: dialog, "intro-play": {}, "intro-dismiss": {}, "mode-quiz": { click() { quizClicks++; } } };
  const location = { href: "https://game.test/", hash };
  const context = { $: id => nodes[id], localStorage, DB: ready ? {} : null, location, URL,
    quizWelcomeEligible: () => eligible(localStorage),
    sessionStorage: { getItem: () => restoringSettings ? "1" : null },
    document: { documentElement: { dataset: { entry } }, querySelector: () => null } };
  const setup = app.slice(app.indexOf("function setupQuizWelcome("), app.indexOf("function applyLang("));
  vm.runInNewContext(setup + "\nsetupQuizWelcome();", context);
  return { dialog, nodes, saved, location, quizClicks: () => quizClicks };
}

test("the welcome opens immediately without a dataset or a dbready event", () => {
  const welcome = launchWelcome();
  assert.equal(welcome.dialog.open, true);
});

test("starting the quiz while loading preserves the page and requests the quiz", () => {
  const welcome = launchWelcome();
  let prevented = false;
  welcome.nodes["intro-play"].onclick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(welcome.dialog.open, false);
  assert.equal(welcome.saved.get("quizWelcomeSeen"), "1");
  assert.equal(welcome.location.href, "https://game.test/");
  assert.equal(welcome.location.hash, "quiz");
  assert.equal(welcome.quizClicks(), 0);
});

test("starting the quiz after loading uses the existing game", () => {
  const welcome = launchWelcome({ ready: true });
  welcome.nodes["intro-play"].onclick({ preventDefault() {} });
  assert.equal(welcome.quizClicks(), 1);
  assert.equal(welcome.dialog.open, false);
});

test("an immediate welcome still skips shared links, quiz entry and settings restoration", () => {
  for (const options of [{ hash: "#quiz" }, { hash: "#Q123,Q456" }, { entry: "quiz" }, { restoringSettings: true }])
    assert.equal(launchWelcome(options).dialog.open, false);
});
