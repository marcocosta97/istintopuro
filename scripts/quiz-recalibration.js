#!/usr/bin/env node
"use strict";

// Compare frozen compiled models, then produce a future calendar for review.
// This command writes artifacts only; it never replaces published site data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { createRuntime, buildSchedule, inspectEntry, auditSchedule } = require("./quiz-schedule.js");
const { compile } = require("./quiz-recognition.js");
const { loadPlayerQids } = require("./recognition-audit.js");
const { clubFactor, topLeagues } = require("../site/quiz-recognition.js");
const { easyQidsFor } = require("../site/quiz-core.js");
const ROOT = path.resolve(__dirname, "..");
const LEVELS = ["easy", "medium", "hard", "impossible"];
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function careerEvidence(index) {
  const { quizRecognition, ...rest } = index;
  // Record label corrections separately; they do not change appearance evidence.
  return { ...rest, clubs: rest.clubs.map(club => club.slice(1)) };
}

function describe(runtime, qids, playerQids) {
  const { core, index } = runtime;
  const stage = core.stagesFromQids([qids])?.[0];
  if (!stage) throw Error(`unresolvable proposed stage: ${qids.join("/")}`);
  const best = [...stage.effective].sort((a, b) => core.qDifficultyFame(b, stage.clubs) - core.qDifficultyFame(a, stage.clubs));
  const records = core.uniqueChoices(best).slice(0, 6).map(pid => ({
    qid: playerQids[pid], name: index.names[pid], birth: index.births[pid],
    appearances: stage.clubs.map(ci => core.qApps(ci, pid)),
    bridge: core.qDifficultyFame(pid, stage.clubs), baseline: core.qBridgeFame(pid, stage.clubs),
    measured: !!index.quizRecognition.players[playerQids[pid]],
  }));
  const top = topLeagues(index), known = new Set(easyQidsFor(index)), b = index.quizRecognition;
  const factors = stage.clubs.map(ci => {
    const c = index.clubs[ci], row = b.clubs[c[3]];
    return clubFactor(c, row ? { viewsScore: row[0], languageScore: row[1] } : null, top, known, b.clubConfig);
  });
  return { qids, clubs: stage.clubs.map(ci => index.clubs[ci][0]), level: LEVELS[core.classifyStage(stage)],
    score: stage.ease, familiar: core.qFamiliarAnswers(stage.clubs, stage.effective).length,
    accepted: core.uniqueChoices(stage.answers).length, effective: core.uniqueChoices(stage.effective).length,
    representative: index.names[core.qFace(stage)], weakestClub: Math.min(...factors), answers: records };
}

function buildComparison({ index, baselineIndex, coverageBundle, published, previous, feedback, playerQids,
  from, through = previous.through, auditDays = 730 }) {
  assert.equal(digest(careerEvidence(index)), digest(careerEvidence(baselineIndex)),
    "compare models on identical career evidence; freeze a new baseline after source changes");
  const make = bundle => createRuntime({ ...structuredClone(index), quizRecognition: bundle });
  const weightsFrozen = digest(baselineIndex.quizRecognition.config) === digest(index.quizRecognition.config)
    && digest(baselineIndex.quizRecognition.clubConfig) === digest(index.quizRecognition.clubConfig);
  if (weightsFrozen) assert.equal(digest(coverageBundle), digest(index.quizRecognition),
    "a coverage-only comparison must use the same new observations for coverage and final output");
  // Expiry is a data update, not a formula change. A frozen-formula control must
  // therefore retain the exact old observations when coefficients are unchanged.
  const formulaBundle = weightsFrozen ? baselineIndex.quizRecognition
    : compile(index, playerQids, { previous: baselineIndex.quizRecognition, asOf: index.quizRecognition.asOf });
  const runtimes = { before: make(baselineIndex.quizRecognition), coverage: make(coverageBundle),
    formula: make(formulaBundle), after: make(index.quizRecognition) };
  assert.deepEqual(buildSchedule(runtimes.before, published, { regenerateFrom: from, through }), previous,
    "the baseline must reproduce the reviewed proposal");
  const current = buildSchedule(runtimes.after, published, { regenerateFrom: from, through });
  assert.deepEqual(buildSchedule(runtimes.after, published, { regenerateFrom: from, through }), current,
    "the candidate must be deterministic");
  const probes = [], days = [], context = [];
  let preserved = 0;
  for (const [date, entry] of Object.entries(current.days)) {
    if (date < from) {
      assert.deepEqual(entry, published.days[date]);
      preserved++;
    } else {
      const check = inspectEntry(runtimes.after, entry, { date, previousDays: context, strict: true });
      assert.ok(check.ok, `${date}: ${check.errors.join("; ")}`);
      days.push({ date, stages: entry.map(cs => describe(runtimes.after, cs, playerQids)) });
      previous.days[date].forEach((qids, slot) => {
        const models = Object.fromEntries(Object.entries(runtimes).map(([name, rt]) => [name, describe(rt, qids, playerQids)]));
        assert.equal(models.before.accepted, models.after.accepted, "difficulty changes must not alter accepted choices");
        assert.equal(models.before.representative, models.after.representative, "difficulty changes must not alter hint representatives");
        probes.push({ date, slot, ...models });
      });
    }
    context.push({ date, stages: entry });
  }
  const tuning = feedback.cases.map(c => {
    const qids = previous.days[c.date][LEVELS.indexOf(c.current.toLowerCase())];
    const models = Object.fromEntries(Object.entries(runtimes).map(([name, rt]) => [name, describe(rt, qids, playerQids)]));
    return { ...c, rater: "assistant", role: weightsFrozen
      ? "previous review judgement acknowledged by user; weights frozen; not a held-out human label"
      : "tuning judgement acknowledged by user; not a held-out human label",
      expected: c.suggested.toLowerCase(), ...models, matches: models.after.level === c.suggested.toLowerCase() };
  });
  const impact = name => {
    const changed = probes.filter(p => p[name].level !== p.before.level);
    return { changed: changed.length, harder: changed.filter(p => LEVELS.indexOf(p[name].level) > LEVELS.indexOf(p.before.level)).length,
      easier: changed.filter(p => LEVELS.indexOf(p[name].level) < LEVELS.indexOf(p.before.level)).length };
  };
  const reviewQueue = [];
  for (const d of days) for (const s of d.stages) {
    const reasons = [];
    if (s.level === "easy" && s.familiar === 1 && s.answers[0].bridge < 580) reasons.push("single Easy route close to the solo threshold");
    if (s.level === "medium" && s.weakestClub < .8) reasons.push("Medium with a weakly recognised clue");
    if (s.level === "medium" && s.familiar === 1 && !s.answers[0].measured) reasons.push("single familiar route without measured player popularity");
    if (s.level === "medium" && s.qids.length === 3 && s.effective === 1) reasons.push("triple with one effective route");
    if (s.level === "hard" && s.answers[0].bridge >= 375) reasons.push("Hard close to the individual familiarity threshold");
    if (s.level === "impossible" && s.answers[0].appearances.every(n => n < 0)) reasons.push("historical route without quantified appearances");
    if (reasons.length) reviewQueue.push({ date: d.date, ...s, reasons });
  }
  const audit = auditDays ? auditSchedule(runtimes.after, { days: auditDays }) : null;
  const labelCorrections = index.clubs.flatMap((c, ci) => c[0] !== baselineIndex.clubs[ci][0]
    ? [{ qid: c[3], before: baselineIndex.clubs[ci][0], after: c[0] }] : []);
  return { version: 1, kind: "quiz-recalibration-comparison", mode: weightsFrozen ? "coverage-only" : "recalibration", published: false, from, through,
    datasetBuilt: index.built, asOf: index.quizRecognition.asOf,
    models: Object.fromEntries(Object.entries(runtimes).map(([name, rt]) => [name,
      { player: rt.index.quizRecognition.config, club: rt.index.quizRecognition.clubConfig,
        observations: Object.keys(rt.index.quizRecognition.players).length,
        clubObservations: Object.keys(rt.index.quizRecognition.clubs).length,
        knownClues: easyQidsFor(rt.index) }])),
    inputDigests: { careerEvidence: digest(careerEvidence(index)), previousProposal: digest(previous), published: digest(published) },
    preserved, impact: { coverage: impact("coverage"), formula: impact("formula"), combined: impact("after") },
    tuning, probes, days, reviewQueue, labelCorrections, audit, schedule: current };
}

function writeReport(directory, report) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "comparison.json"), JSON.stringify(report));
  fs.writeFileSync(path.join(directory, "quiz-schedule.json"), JSON.stringify(report.schedule) + "\n");
  const cell = value => '"' + String(value).replaceAll('"', '""') + '"';
  const csv = [["Data", ...LEVELS], ...report.days.map(d => [d.date, ...d.stages.map(s => s.clubs.join(" / "))])];
  fs.writeFileSync(path.join(directory, "schedule.csv"), "\uFEFF" + csv.map(row => row.map(cell).join(",")).join("\r\n") + "\r\n");
  const md = ["# Quiz recalibration comparison", "", "Review artifacts only; no published schedule was changed.", "",
    `Models: ${report.models.after.player.version} / ${report.models.after.club.version}.`,
    `New calendar: ${report.from} through ${report.through}; ${report.preserved} earlier days preserved.`, "",
    report.mode === "coverage-only" ? "Weights are unchanged; only source coverage is updated. Previous review goals are not held-out accuracy measurements."
      : "The reviewed examples are tuning judgements, not held-out accuracy measurements.", "",
    "| Date | Clubs | Before | Coverage only | Formula only | Combined | Reviewed target |", "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.tuning.map(c => `| ${c.date} | ${c.before.clubs.join(" / ")} | ${c.before.level} | ${c.coverage.level} | ${c.formula.level} | ${c.after.level} | ${c.expected} |`), "",
    ...report.tuning.filter(c => c.revisedSuggestion).map(c =>
      `New evidence: ${c.before.clubs.join(" / ")}. Original target retained: ${c.expected}; revised qualitative suggestion: ${c.revisedSuggestion}. ${c.revisedReason}`), "",
    `Combined classification changes on the original ${report.probes.length} stages: ${report.impact.combined.changed} `
      + `(${report.impact.combined.harder} harder, ${report.impact.combined.easier} easier).`, "",
    `Audit: ${report.audit ? report.audit.days + " days; " + report.audit.errors.length + " errors" : "not run"}.`, ""];
  fs.writeFileSync(path.join(directory, "report.md"), md.join("\n"));
  const { renderComparison, renderCalendar } = require("./quiz-recalibration-pages.js");
  fs.writeFileSync(path.join(directory, "report.html"), renderComparison(report));
  fs.writeFileSync(path.join(directory, "calendar.html"), renderCalendar(report));
}

function main(argv) {
  const options = { index: path.join(ROOT, "site/data/index.json"), output: path.join(ROOT, "data/quiz-recalibration"), auditDays: 730 };
  const flags = { "--index": "index", "--baseline-index": "baseline", "--coverage-bundle": "coverage", "--published": "published",
    "--previous-proposal": "previous", "--feedback": "feedback", "--assessment": "assessment", "--from": "from", "--through": "through", "--output": "output", "--audit-days": "auditDays" };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (!key || !argv[i + 1]) throw Error(`unknown or incomplete option: ${argv[i]}`);
    options[key] = argv[++i];
  }
  for (const key of ["baseline", "coverage", "published", "previous", "feedback", "from"])
    if (!options[key]) throw Error(`missing input: ${key}`);
  const output = path.resolve(options.output), site = path.join(ROOT, "site");
  if (output === site || output.startsWith(site + path.sep)) throw Error("review output must be outside published site assets");
  const auditDays = Number(options.auditDays);
  if (!Number.isInteger(auditDays) || auditDays < 0) throw Error("audit days must be a nonnegative integer");
  const index = read(options.index);
  const report = buildComparison({ index, baselineIndex: read(options.baseline), coverageBundle: read(options.coverage),
    published: read(options.published), previous: read(options.previous), feedback: read(options.feedback), from: options.from,
    through: options.through, auditDays, playerQids: loadPlayerQids(index, path.dirname(options.index)) });
  if (options.assessment) report.reassessment = read(options.assessment);
  writeReport(output, report);
  console.log(JSON.stringify({ output, days: report.days.length, preserved: report.preserved,
    tuningMatches: report.tuning.filter(c => c.matches).length, tuningCases: report.tuning.length,
    impact: report.impact, auditErrors: report.audit?.errors }));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildComparison, describe, writeReport };
