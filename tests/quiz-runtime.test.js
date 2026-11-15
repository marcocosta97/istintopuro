"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { shiftDate, EPOCH, loadRuntime, createRuntime } = require("../scripts/quiz-schedule.js");
const QuizCore = require("../site/quiz-core.js");
const QuizRecognition = require("../site/quiz-recognition.js");

const source = fs.readFileSync(path.join(__dirname, "../site/quiz.js"), "utf8");

function runtime(asset, index = loadRuntime().index) {
  const browser = createRuntime(structuredClone(index));
  browser.index.quizSchedule = asset;
  const context = vm.createContext({ CORE_DB: browser.index, QuizCore, QuizRecognition,
    corePostings: browser.postings, intersect: browser.intersect,
    coreLeagueCC: browser.leagueCC, coreClub: name => name,
    localStorage: { quizSeries: EPOCH },
  });
  vm.runInContext(source.slice(0, source.indexOf("const qGen =")), context);
  return { stagesFor: date => context.qStagesFor(date), browser, context };
}
const asset = JSON.parse(fs.readFileSync(path.join(__dirname, "../site/data/quiz-schedule.json"), "utf8"));

test("opening a published day restores the same club questions without generation", () => {
  const { stagesFor, browser } = runtime(asset);
  const stages = stagesFor(EPOCH);
  assert.deepEqual(browser.core.serializeStages(stages), asset.days[EPOCH]);
  assert.equal(stagesFor(EPOCH), stages);
});

test("missing, prelaunch and unpublished days never generate local replacements", () => {
  for (const schedule of [null, { days: {} }, asset]) {
    const { stagesFor } = runtime(schedule);
    assert.equal(stagesFor(shiftDate(asset.through, 1)), null);
    assert.equal(stagesFor(shiftDate(EPOCH, -1)), null);
  }
  assert.equal(runtime(null).stagesFor(EPOCH), null);
});

test("published questions resolve the current dataset after club indices change", () => {
  const index = structuredClone(loadRuntime().index);
  for (const field of ["clubs", "postings", "apps", "goals"]) index[field].reverse();
  const { stagesFor, browser } = runtime(asset, index);
  assert.deepEqual(browser.core.serializeStages(stagesFor(EPOCH)), asset.days[EPOCH]);
});

test("unresolvable or malformed published questions never receive replacements", () => {
  const index = structuredClone(loadRuntime().index);
  index.clubs = []; index.postings = []; index.apps = []; index.goals = [];
  assert.equal(runtime(asset, index).stagesFor(EPOCH), null);
  for (const change of [s => { s.days[EPOCH][0] = null; },
    s => { delete s.bonuses[EPOCH]; }, s => { s.bonuses[EPOCH].targets = []; }]) {
    const broken = structuredClone(asset); change(broken);
    assert.equal(runtime(broken).stagesFor(EPOCH), null);
  }
});

test("browser and schedule use the same recognition model independently of solver ranking", () => {
  const node = loadRuntime();
  const browser = createRuntime(structuredClone(node.index));
  const context = vm.createContext({ CORE_DB: browser.index, QuizCore, QuizRecognition,
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
