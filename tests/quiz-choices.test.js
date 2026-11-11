"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRuntime } = require("../scripts/quiz-schedule.js");
const { recognitionIndex } = require("./helpers/quiz-data.js");

const source = fs.readFileSync(path.join(__dirname, "../site/quiz.js"), "utf8");

function runtime() {
  const index = recognitionIndex();
  index.names.splice(0, 5, "Alex Costa", "Alex Costa", "Alex Costa", "Vitinha", "Vitinha");
  index.births.splice(0, 5, 2000, 2000, 1999, 2000, 2000);
  index.nats.splice(0, 5, "IT", "PT", "IT", "PT", "PT");
  const { core } = createRuntime(index);
  function element() {
    const el = { children: [], dataset: {}, attrs: {}, hidden: true,
      classList: { toggle() {} },
      setAttribute(key, value) { this.attrs[key] = value; },
      removeAttribute(key) { delete this.attrs[key]; },
      appendChild(child) { this.children.push(child); },
      querySelectorAll() { return this.children.filter(child => child.attrs.role === "option"); },
    };
    Object.defineProperty(el, "innerHTML", {
      get() { return this.html || ""; },
      set(value) { this.html = value; this.children = []; },
    });
    return el;
  }
  const elements = { qsugg: element(), qsearch: element() }, picks = [];
  const context = vm.createContext({
    DB: index, CORE_DB: index, qCore: () => core,
    norm: value => value.toLowerCase(),
    playerMatches: query => index.names.flatMap((name, pid) => name.toLowerCase().includes(query.toLowerCase()) ? [pid] : []),
    $: id => elements[id], document: { createElement: element },
    flag: value => value, hilite: value => value, lang: "it", QSTR: { it: { qsProbe: "Type a name" } },
    qPick: pid => picks.push(pid), qRolled: () => false,
    qSave: () => true, qFinish() {}, qUpdateDaily() {}, qReplaying: false,
    qs: { stage: 0, lives: 5, guesses: [], done: false }, qPz: { stages: [{ answers: [0] }] },
  });
  const identities = source.slice(source.indexOf("const qIdentity ="), source.indexOf("function qMigrateState"));
  const guessing = source.slice(source.indexOf("function qGuess(pid)"), source.indexOf("// a run reached done:"));
  const choices = source.slice(source.indexOf("let qCur = -1;"), source.indexOf("// which of the stage's"));
  vm.runInContext(`${identities}\n${guessing}\n${choices}\nglobalThis.api = { qMatches, qSuggest, qGuess };`, context);
  return { core, index, elements, picks, context, ...context.api };
}

test("quiz choices merge any matching name and birth year, including different nationalities", () => {
  const { qMatches, core } = runtime();
  assert.deepEqual([...qMatches("Alex Costa")], [0, 2]);
  assert.deepEqual([...qMatches("Vitinha")], [3]);
  assert.deepEqual(core.uniqueChoices([1, 0, 2, 4, 3]), [1, 2, 4], "keep the search's representative and order");
});

test("suggestions render one selectable row per name/year and retain keyboard option ids", () => {
  const { qMatches, qSuggest, elements, picks } = runtime();
  qSuggest(qMatches("Alex Costa"), "Alex Costa");
  const rows = elements.qsugg.querySelectorAll();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => Number(row.dataset.pid)), [0, 2]);
  assert.equal(elements.qsearch.attrs["aria-activedescendant"], "qsg0");
  rows[0].onclick();
  assert.deepEqual(picks, [0]);
});

test("short exact names are grouped while initials probes remain blocked", () => {
  const { qMatches, index } = runtime();
  index.names[0] = index.names[1] = "Li";
  assert.deepEqual([...qMatches("Li")], [0]);
  assert.deepEqual([...qMatches("L")], []);
});

test("a grouped choice is accepted when a hidden record is correct", () => {
  const { qGuess, context, core } = runtime();
  assert.equal(qGuess(1), "stage", "different nationality must not hide a valid answer");
  assert.equal(context.qs.lives, 5);
  assert.equal(context.qs.guesses[0].ok, true);
  assert.equal(context.qs.guesses[0].pid, 0, "the revealed career must belong to a matching record");
  assert.equal(context.qs.guesses[0].key, core.playerIdentity(0), "preserve the matching record's saved key");
});

test("same-name players born in different years remain different answers", () => {
  const { qGuess, context } = runtime();
  assert.equal(qGuess(2), "wrong");
  assert.equal(context.qs.lives, 4);
});

test("repeating another record of the same choice never costs another life", () => {
  const { qGuess, context } = runtime();
  context.qPz.stages[0].answers = [2];
  assert.equal(qGuess(0), "wrong");
  assert.equal(qGuess(1), "dup");
  assert.equal(context.qs.lives, 4);
  assert.equal(context.qs.guesses.length, 1);
});

test("saved guesses with nationality-based keys still count as the same choice", () => {
  for (const keyField of ["key", "identity", null]) {
    const { qGuess, context, core } = runtime();
    const guess = { name: "Alex Costa", birth: 2000, nat: "IT", stage: 0 };
    if (keyField) guess[keyField] = core.playerIdentity(0);
    context.qs.guesses = [guess];
    assert.equal(qGuess(1), "dup");
    assert.equal(context.qs.lives, 5);
  }
});

test("a second hint skips every record of the already hinted name/year", () => {
  const { core } = runtime();
  const stage = { clubs: [0, 1], effective: [0, 1, 2], answers: [0, 1, 2] };
  assert.equal(core.nextHintTarget(stage, [0]), 2);
});
