"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRuntime, loadRuntime } = require("../../scripts/quiz-schedule.js");
const { createQuizCore } = require("../../site/quiz-core.js");

function runtime(index) {
  const result = index ? createRuntime(index) : loadRuntime();
  result.DB = result.index;
  result.DB.byQid = result.byQid;
  return result;
}

function calibrationRuntime() {
  // Always read a fresh copy: the core caches pools and scores on its input DB.
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/quiz-calibration.json"), "utf8"));
  const result = runtime(index);
  // Reduced rosters must not change the population weights of these fixed cases.
  result.core = createQuizCore({ DB: index, ...result,
    stature: ci => index._fixture.clubStature[ci] });
  return result;
}

module.exports = { runtime, calibrationRuntime };
