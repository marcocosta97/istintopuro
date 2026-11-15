"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
const quiz = fs.readFileSync(path.join(__dirname, "../site/quiz.js"), "utf8");
const translations = app.slice(app.indexOf("const REPO ="), app.indexOf("let lang ="));
const metadata = app.slice(app.indexOf("function updatePageMetadata("), app.indexOf("function quizWelcomeEligible("));
const exit = quiz.slice(quiz.indexOf("function qExit()"), quiz.indexOf("// a run in progress"));
const ORIGIN = "https://istintopuro.mcosta.it/";

function page({ entry, active = false, url = "https://game.test/" } = {}) {
  const head = new Map(), controls = new Map(), classes = new Set(active ? ["quiz"] : []);
  const element = () => ({ content: "", attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
  const document = {
    title: "", documentElement: { dataset: entry ? { entry } : {} },
    body: { classList: { contains: name => classes.has(name), remove: name => classes.delete(name) } },
    querySelector(selector) { if (!head.has(selector)) head.set(selector, element()); return head.get(selector); },
  };
  const location = new URL(url);
  const context = vm.createContext({ document, location, URL,
    $: id => { if (!controls.has(id)) controls.set(id, element()); return controls.get(id); },
    history: { replaceState(_state, _title, next) { location.href = new URL(next, location).href; } },
    syncHash() { location.hash = ""; }, solve() {},
  });
  vm.runInContext(translations + '\nlet lang="en", t=STR[lang], mode="club", qConfirm=null, qLeaveMode=null, qNavigation=0;\n'
    + "let clubIds=[], leagueIds=[], countryIds=[], playerIds=[];\n" + metadata + exit, context);
  return { document, location, head,
    update: () => vm.runInContext("updatePageMetadata()", context),
    leave: () => vm.runInContext("qExit()", context),
    language: value => vm.runInContext(`lang=${JSON.stringify(value)}; t=STR[lang]; updatePageMetadata();`, context),
  };
}

function assertCanonical(browser, suffix) {
  assert.equal(browser.head.get('link[rel="canonical"]').attributes.href, ORIGIN + suffix);
  assert.equal(browser.head.get('meta[property="og:url"]').content, ORIGIN + suffix);
}

test("a quiz entry keeps quiz metadata before the board or dataset exists", () => {
  const browser = page({ entry: "quiz", url: "https://game.test/quiz/" });
  browser.update();
  assert.equal(browser.document.title, "Daily football quiz — Istinto Puro");
  assert.match(browser.head.get('meta[name="description"]').content, /same quiz for everyone/i);
  assertCanonical(browser, "quiz/");
  browser.update();  // Reapplying the language while loading or after an error is safe.
  assert.equal(browser.document.title, "Daily football quiz — Istinto Puro");
});

test("switching language while the quiz is still loading keeps its page context", () => {
  const browser = page({ entry: "quiz" });
  browser.language("it");
  assert.equal(browser.document.title, "Quiz di calcio giornaliero — Istinto Puro");
  assert.equal(browser.head.get('meta[property="og:locale"]').content, "it_IT");
  assertCanonical(browser, "quiz/");
});

test("leaving either quiz entry clears its marker and restores home metadata across language changes", () => {
  for (const route of ["quiz/", "quiz/index.html", "football/quiz/", "football/quiz/index.html"]) {
    const browser = page({ entry: "quiz", active: true, url: `https://game.test/${route}?day=2026-11-10#quiz` });
    browser.update();
    browser.leave();
    assert.equal(browser.document.documentElement.dataset.entry, undefined);
    assert.equal(browser.location.pathname, route.startsWith("football/") ? "/football/" : "/");
    assert.equal(browser.location.search, "");
    assert.equal(browser.location.hash, "");
    assertCanonical(browser, "");
    browser.language("it");
    assert.equal(browser.document.title, "Istinto Puro — quiz di calcio giornaliero e solver");
    browser.language("en");
    assert.equal(browser.document.title, "Istinto Puro — daily football quiz and solver");
    assertCanonical(browser, "");
  }
});

test("the legacy hash quiz retains the home's canonical URL", () => {
  const browser = page({ active: true, url: "https://game.test/?day=2026-11-10#quiz" });
  browser.update();
  assert.equal(browser.document.title, "Daily football quiz — Istinto Puro");
  assertCanonical(browser, "");
  browser.leave();
  assert.equal(browser.document.title, "Istinto Puro — daily football quiz and solver");
  assertCanonical(browser, "");
});
