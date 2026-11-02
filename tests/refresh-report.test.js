"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildReport, formatMarkdown, main } = require("../scripts/refresh-report.js");
const { recognitionIndex } = require("./helpers/quiz-data.js");

test("ordinary source updates produce score drift without failing a fixed calibration", () => {
  const baseline = recognitionIndex(), candidate = structuredClone(baseline);
  candidate.apps[0][0]++;
  candidate.built = "2026-11-02";
  candidate.names.push("New Player");
  candidate.births.push(2000);
  candidate.nats.push("IT");
  candidate.imgs.push("");
  const report = buildReport(baseline, candidate);
  const row = report.probes.find(row => row.qids.join() === "Q1543,Q9616");
  assert.ok(row.easeDelta > 0);
  assert.equal(row.baseline.level, row.candidate.level);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.candidate.players - report.baseline.players, 1);
  assert.equal(report.candidate.built, "2026-11-02");
  assert.equal(baseline.qPools, undefined, "report must not mutate its source indexes");
  assert.match(formatMarkdown(report), /Milan \/ Chelsea/);
});

test("lost intersections are reported as advisory classification changes", () => {
  const baseline = recognitionIndex(), candidate = structuredClone(baseline);
  candidate.apps[0][0] = 0;
  const report = buildReport(baseline, candidate);
  const row = report.probes.find(row => row.qids.join() === "Q1543,Q9616");
  assert.equal(row.candidate, null);
  assert.equal(row.easeDelta, null);
  assert.ok(report.warnings.some(warning => warning.includes("Milan / Chelsea") && warning.includes("unavailable")));
});

test("malformed candidate produces diagnostic files for the failed refresh", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-report-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baseline = path.join(directory, "baseline.json"), candidate = path.join(directory, "candidate.json");
  fs.writeFileSync(baseline, JSON.stringify(recognitionIndex()));
  fs.writeFileSync(candidate, "{incomplete");
  main(["--baseline", baseline, "--candidate", candidate, "--output", directory]);
  const report = JSON.parse(fs.readFileSync(path.join(directory, "report.json"), "utf8"));
  assert.equal(report.candidate, null);
  assert.ok(report.diagnostics.some(message => message.startsWith("candidate:")));
  assert.match(fs.readFileSync(path.join(directory, "report.md"), "utf8"), /Diagnostics/);
});
