"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
const boot = app.slice(app.indexOf("async function boot()"), app.indexOf("\nfunction postingsFor("));

function launch(readyState) {
  const document = new EventTarget();
  document.readyState = readyState;
  let quizReady = readyState !== "loading", starts = 0, refreshes = 0;
  const index = { built: "2026-11-10", clubs: [], packs: [] };
  const schedule = { v: 1, built: index.built };
  const nodes = { randbtn: {}, about: { open: false } };
  const context = {
    document, Event, Set, Map, V: "test", CORE_DB: null, DB: null,
    status: {}, t: { loading: "loading", loadFail: "failed", retry: "retry" },
    packFailures: new Map(), search: {}, browseBtn: {}, requiredPackIds: [],
    clubIds: [], leagueIds: [], countryIds: [],
    fetch: async url => ({ ok: true, clone() { return this; },
      json: async () => url.includes("quiz-schedule") ? schedule : index }),
    keepIndex() {}, keepQuizSchedule() {}, enabledPackIds: () => new Set(), loadPack() {},
    LeaguePacks: { compose: core => ({ ...core }) },
    missingPacksForHash: () => [],
    parseSelectionHash: () => ({ clubs: [], leagues: [], countries: [] }),
    restoreShareOptions() {}, focusSearch() {},
    applyLang() { assert.equal(quizReady, true, "quiz helpers must exist before rendering"); },
    $: id => nodes[id], sessionStorage: { getItem: () => null, removeItem() {} },
    OfflineGame: { refresh() { refreshes++; } }
  };
  const attachQuiz = () => {
    quizReady = true;
    document.addEventListener("dbready", () => { starts++; });
  };
  if (quizReady) attachQuiz();
  const running = vm.runInNewContext(boot + "\nboot();", context);
  return { context, document, attachQuiz, running, starts: () => starts, refreshes: () => refreshes };
}

test("fast data waits for later quiz scripts before exposing DB or dispatching dbready", async () => {
  const app = launch("loading");
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(app.context.CORE_DB, "the dataset downloads while the scripts are still loading");
  assert.equal(app.context.DB, null, "the welcome keeps queuing entry until the quiz is ready");
  assert.equal(app.starts(), 0);
  app.attachQuiz();
  app.document.readyState = "interactive";
  app.document.dispatchEvent(new Event("DOMContentLoaded"));
  await app.running;
  assert.ok(app.context.DB);
  assert.equal(app.context.DB.quizSchedule.built, "2026-11-10");
  assert.equal(app.starts(), 1);
  assert.equal(app.refreshes(), 1);
});

test("boot after document readiness completes without waiting for another DOM event", async () => {
  const app = launch("complete");
  await app.running;
  assert.ok(app.context.DB);
  assert.equal(app.starts(), 1);
  assert.equal(app.refreshes(), 1);
});
