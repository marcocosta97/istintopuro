#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRuntime } = require("./quiz-schedule.js");

// Representative calibration probes, not release gates. Source corrections can
// legitimately change their scores, answer counts, or even difficulty levels.
const PROBES = [
  ["Q1543", "Q9616"], // Milan / Chelsea
  ["Q1886", "Q1422"], // Atalanta / Juventus
  ["Q41420", "Q10315"], // Dortmund / Real Sociedad
  ["Q172476", "Q1422"], // Bordeaux / Juventus
  ["Q2693", "Q1422"], // Parma / Juventus
  ["Q8823", "Q10300"], // Levante / Rayo
  ["Q2052", "Q631", "Q2739"], // Fiorentina / Inter / Roma
  ["Q1543", "Q1130849"], // Milan / Liverpool
];

function datasetSummary(index) {
  let known = 0, total = 0;
  for (const apps of index.apps) for (const value of apps) {
    total++;
    if (value >= 0) known++;
  }
  return { built: index.built, clubs: index.clubs.length, players: index.names.length,
    postings: total, appsCoverage: total ? known / total : 0 };
}

function probe(runtime, qids) {
  const stages = runtime.core.stagesFromQids([qids]);
  if (!stages) return null;
  const [stage] = stages;
  const face = runtime.core.qFace(stage), level = runtime.core.classifyStage(stage);
  return { ease: stage.ease, level: level < 0 ? "unclassified" : runtime.core.constants.QLEVELS[level],
    answers: stage.answers.length, effective: stage.effective.length,
    representative: face >= 0 ? runtime.index.names[face] : null };
}

function buildReport(baseline, candidate, { diagnostics = [], provenance = {} } = {}) {
  const report = { provenance, diagnostics: [...diagnostics], baseline: null, candidate: null, probes: [], warnings: [] };
  const runtimes = {};
  for (const [name, index] of Object.entries({ baseline, candidate })) {
    if (!index) continue;
    try {
      report[name] = datasetSummary(index);
      runtimes[name] = createRuntime(structuredClone(index));
    } catch (error) { report.diagnostics.push(`${name}: ${error.message}`); }
  }
  for (const qids of PROBES) {
    const row = { qids, clubs: qids.map(qid => {
      const runtime = runtimes.candidate || runtimes.baseline;
      return runtime?.index.clubs[runtime.byQid.get(qid)]?.[0] || qid;
    }) };
    for (const side of ["baseline", "candidate"]) {
      try { row[side] = runtimes[side] ? probe(runtimes[side], qids) : null; }
      catch (error) {
        row[side] = null;
        report.diagnostics.push(`${side} ${qids.join(" / ")}: ${error.message}`);
      }
    }
    row.easeDelta = row.baseline && row.candidate ? row.candidate.ease - row.baseline.ease : null;
    if (runtimes.baseline && runtimes.candidate && row.baseline?.level !== row.candidate?.level)
      report.warnings.push(`${row.clubs.join(" / ")}: ${row.baseline?.level || "unavailable"} → ${row.candidate?.level || "unavailable"}`);
    report.probes.push(row);
  }
  return report;
}

function formatMarkdown(report) {
  const cell = value => String(value ?? "unavailable").replace(/[|\r\n]/g, " ");
  const percent = value => `${(value * 100).toFixed(2)}%`;
  const lines = ["### Weekly refresh data comparison", "",
    "Score and classification changes below are advisory. Data integrity, coverage and calendar checks remain release gates.", "",
    "| Metric | Baseline | Candidate |", "| --- | ---: | ---: |"];
  for (const key of ["built", "clubs", "players", "postings", "appsCoverage"]) {
    const value = side => report[side] ? key === "appsCoverage" ? percent(report[side][key]) : report[side][key] : "unavailable";
    lines.push(`| ${key} | ${cell(value("baseline"))} | ${cell(value("candidate"))} |`);
  }
  lines.push("", "| Clubs | Score before → after | Delta | Level before → after | Answers before → after |",
    "| --- | ---: | ---: | --- | ---: |");
  for (const row of report.probes) {
    const score = side => row[side] ? row[side].ease.toFixed(2) : "unavailable";
    lines.push(`| ${cell(row.clubs.join(" / "))} | ${score("baseline")} → ${score("candidate")} | ${row.easeDelta?.toFixed(2) ?? "—"} | ${cell(row.baseline?.level)} → ${cell(row.candidate?.level)} | ${cell(row.baseline?.answers)} → ${cell(row.candidate?.answers)} |`);
  }
  for (const [title, messages] of [["Classification changes", report.warnings], ["Diagnostics", report.diagnostics]]) {
    if (messages.length) lines.push("", `**${title}**`, "", ...messages.map(message => `- ${cell(message)}`));
  }
  return `${lines.join("\n")}\n`;
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--baseline", "--candidate", "--output"].includes(argv[i]) || !argv[i + 1])
      throw new Error("usage: refresh-report.js --baseline INDEX --candidate INDEX --output DIRECTORY");
    options[argv[i].slice(2)] = argv[i + 1];
  }
  if (!options.baseline || !options.candidate || !options.output)
    throw new Error("--baseline, --candidate and --output are required");
  const diagnostics = [];
  const read = side => {
    try { return JSON.parse(fs.readFileSync(options[side], "utf8")); }
    catch (error) { diagnostics.push(`${side}: ${error.message}`); return null; }
  };
  const baseline = read("baseline"), candidate = read("candidate");
  const report = buildReport(baseline, candidate, { diagnostics, provenance: {
    sha: process.env.GITHUB_SHA || null, runId: process.env.GITHUB_RUN_ID || null,
    attempt: process.env.GITHUB_RUN_ATTEMPT || null,
  } });
  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(path.join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(options.output, "report.md"), formatMarkdown(report));
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildReport, formatMarkdown, main, PROBES };
