#!/usr/bin/env node
"use strict";

// Local calibration workbook. Human labels are independent of model predictions.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRuntime } = require("./quiz-schedule.js");
const { buildReport, loadPlayerQids, writeReport } = require("./recognition-audit.js");
const { DEFAULT_CONFIG, REFERENCE_CONFIG, GRADUAL_CONFIG, CONSERVATIVE_CONFIG } = require("./recognition-model.js");
const ROOT = path.resolve(__dirname, "..");
const LEVELS = ["easy", "medium", "hard", "impossible"];
const QUALITATIVE_FEEDBACK = require("./recognition-examples.json");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const key = clubs => [...clubs].sort().join("/");
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = n => Number(n).toFixed(1);
const title = level => level[0].toUpperCase() + level.slice(1);

function buildCalibration({ index, sample, snapshot, playerQids, clubSnapshot, auditDays = 730 }) {
  const productionEnabled = !!index.quizRecognition;
  index = { ...index };
  delete index.quizRecognition;
  if (sample?.version !== 1 || sample.kind !== "recognition-calibration-sample"
      || sample.inputDigest !== hash(JSON.stringify(index)) || !sample.players?.length)
    throw new Error("sample does not match this core index");
  const currentCoreDigest = hash(fs.readFileSync(path.join(ROOT, "site/quiz-core.js")));
  let sampleRevalidated = false;
  if (sample.quizCoreDigest && sample.quizCoreDigest !== currentCoreDigest) {
    const { buildSample } = require("./recognition-sample.js");
    const rebuilt = buildSample(index, playerQids, { seed: sample.seed, perCountryEra: sample.policy.perCountryEra });
    if (rebuilt.eligibilityVersion !== sample.eligibilityVersion
        || JSON.stringify(rebuilt.players) !== JSON.stringify(sample.players))
      throw new Error("quiz rules changed the frozen sample; freeze a new sample explicitly");
    sampleRevalidated = true;
  }
  const sampled = new Map(sample.players.map(p => [p.qid, p]));
  if (sampled.size !== sample.players.length || [...sampled.keys()].some(qid => !playerQids.includes(qid)))
    throw new Error("sample contains duplicate or unavailable QIDs");
  const probes = [...new Map(sample.players.flatMap(p => p.probes).map(cs => [key(cs), cs])).values()];
  const available = new Set(index.clubs.map(c => c[3]));
  const feedback = QUALITATIVE_FEEDBACK.items.filter(row => row.qids.every(qid => available.has(qid)));
  const diagnosticProbes = [...new Map([...probes, ...feedback.map(f => f.qids)].map(cs => [key(cs), cs])).values()];
  const asOf = [snapshot.generated_at, clubSnapshot?.generated_at].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  const options = { index, snapshot, playerQids, asOf, probes: diagnosticProbes, maxIntersections: 2000, auditDays };
  const reports = {
    reference: buildReport({ ...options, config: REFERENCE_CONFIG }),
    gradual: buildReport({ ...options, config: GRADUAL_CONFIG }),
    conservative: buildReport({ ...options, config: CONSERVATIVE_CONFIG }),
    bidirectional: buildReport({ ...options, config: DEFAULT_CONFIG }),
    ...(clubSnapshot ? { contextual: buildReport({ ...options, config: DEFAULT_CONFIG, clubSnapshot }) } : {}),
  };
  const runtime = createRuntime(structuredClone(index), {
    recognition: null,
    stature: index._fixture?.clubStature ? ci => index._fixture.clubStature[ci] : undefined });
  const byModel = Object.fromEntries(Object.entries(reports).map(([name, report]) =>
    [name, new Map(report.intersections.map(row => [key(row.qids), row]))]));
  const feedbackResults = feedback.map(row => ({ ...row, source: "explicit user feedback; minimum difficulty, not an exact label",
    clubs: byModel.reference.get(key(row.qids)).clubs,
    baseline: byModel.reference.get(key(row.qids)).baseline,
    models: Object.fromEntries(Object.entries(byModel).map(([name, rows]) => {
      const result = rows.get(key(row.qids));
      return [name, { ...result.candidate, answers: result.answers,
        meetsMinimum: LEVELS.indexOf(result.candidate.level) >= LEVELS.indexOf(row.minimumDifficulty) }];
    })) }));
  const cases = probes.map(qids => {
    const [stage] = runtime.core.stagesFromQids([qids]) || [];
    if (!stage) return null;
    const owners = stage.effective.map(pid => sampled.get(playerQids[pid])).filter(Boolean);
    const splits = new Set(owners.map(p => p.split));
    const split = splits.size > 1 ? "mixed" : [...splits][0];
    const models = Object.fromEntries(Object.entries(byModel).map(([name, rows]) => {
      const row = rows.get(key(qids));
      return [name, { ...row.candidate, delta: row.popularityDelta,
        answers: row.answers.filter(a => a.candidate !== a.baseline) }];
    }));
    return { id: key(qids), qids, clubs: stage.clubs.map(ci => index.clubs[ci][0]), split,
      sampledPlayers: owners.map(p => ({ qid: p.qid, name: p.name, country: p.country, era: p.era, role: p.role })),
      baseline: byModel.reference.get(key(qids)).baseline, models,
      answers: stage.effective.filter(runtime.core.qUsableName).map(pid => ({ qid: playerQids[pid],
        name: index.names[pid], birth: index.births[pid],
        appearances: stage.clubs.map(ci => runtime.core.qApps(ci, pid)) })).sort((a, b) => a.name.localeCompare(b.name)) };
  }).filter(Boolean);
  const observed = new Map(reports.reference.players.map(p => [p.qid, p]));
  const unavailable = sample.players.filter(p => !observed.get(p.qid)?.eligible).map(p => ({ qid: p.qid, name: p.name,
    reasons: observed.get(p.qid)?.reasons || ["no observations"] }));
  return { version: 1, kind: "recognition-calibration", productionEnabled, recommendedModel: null,
    sampleDigest: hash(JSON.stringify(sample)), indexDigest: sample.inputDigest,
    sampleVerification: { originalCoreDigest: sample.quizCoreDigest, currentCoreDigest, sampleRevalidated },
    feedback: feedbackResults,
    asOf: reports.reference.asOf, sampleSummary: sample.summary,
    coverage: { requested: sample.players.length, usable: sample.players.length - unavailable.length, unavailable },
    policy: { target: "general European football fan; the daily quiz is the same for all languages",
      review: "human expected levels must be entered independently; model predictions are not labels",
      holdout: "mixed intersections contain calibration and held-out players and are excluded from agreement metrics",
      trials: "reference/gradual are bonus-only controls; conservative freezes v3; bidirectional revises v4 downside; contextual keeps player corrections and adds measured clue recall",
      limits: "English-edition readership only; balanced review sample, not a population survey" },
    cases, reports };
}

function labelTemplate(report) {
  return { version: 1, kind: "recognition-human-labels", sampleDigest: report.sampleDigest, indexDigest: report.indexDigest,
    rows: report.cases.map(c => ({ id: c.id, clubs: c.clubs, split: c.split, expectedLevel: null, notes: "" })) };
}

function evaluateLabels(report, labels) {
  if (labels?.version !== 1 || labels.kind !== "recognition-human-labels" || labels.sampleDigest !== report.sampleDigest
      || labels.indexDigest !== report.indexDigest || !Array.isArray(labels.rows)) throw new Error("human labels do not match this calibration");
  const cases = new Map(report.cases.map(c => [c.id, c])), seen = new Set(), rows = [];
  for (const row of labels.rows) {
    if (!cases.has(row.id) || seen.has(row.id) || (row.expectedLevel !== null && !LEVELS.includes(row.expectedLevel)))
      throw new Error("human labels contain an unknown case, duplicate, or invalid level");
    seen.add(row.id);
    if (row.expectedLevel !== null) rows.push({ case: cases.get(row.id), level: row.expectedLevel });
  }
  const result = {};
  for (const split of ["calibration", "holdout"]) {
    const selected = rows.filter(row => row.case.split === split);
    result[split] = { reviewed: selected.length, models: {} };
    for (const model of ["baseline", ...Object.keys(report.reports)]) {
      const prediction = row => model === "baseline" ? row.case.baseline.level : row.case.models[model].level;
      const matches = selected.filter(row => prediction(row) === row.level).length;
      result[split].models[model] = { matches, agreement: selected.length ? matches / selected.length : null,
        meanTierDistance: selected.length ? selected.reduce((sum, row) =>
          sum + Math.abs(LEVELS.indexOf(prediction(row)) - LEVELS.indexOf(row.level)), 0) / selected.length : null };
    }
  }
  return { ...result, mixedReviewed: rows.filter(row => row.case.split === "mixed").length,
    unreviewed: report.cases.length - rows.length, recommendedModel: null };
}

function reason(summary) {
  const score = num(summary.ease), n = summary.familiar;
  if (summary.level === "easy") return `Score ${score} ≥550, club noti e ${n > 1 ? `${n} risposte riconoscibili` : "una risposta con collegamento molto ovvio (≥550)"}.`;
  if (summary.level === "medium") return `Score ${score} ≥400 e ${n} rispost${n === 1 ? "a riconoscibile" : "e riconoscibili"}; requisiti Easy non soddisfatti.`;
  if (summary.level === "hard") return `Score ${score} ≥180; requisiti Easy e Medium non soddisfatti.`;
  return `Score ${score} inferiore a 180.`;
}

function formatMarkdown(report) {
  const lines = ["# Calibrazione della popolarità", "", "Modelli sperimentali: attivazione in produzione disabilitata.", "",
    `Campione: ${report.coverage.requested} giocatori; ${report.coverage.usable} con segnali utilizzabili.`, "",
    "Il modello bidirezionale applica bonus e malus alle singole risposte e ricalcola massimo, alternative riconoscibili e fascia della combinazione. Riferimento e graduale restano controlli con soli bonus.", "",
    "La variante rivista conserva esattamente i bonus e rimuove la doppia attenuazione del ramo negativo: visite e lingue sono già nella stima obiettivo. Il malus avvicina la risposta a tale stima, con limiti di 150 punti e 25%. Il peso cala solo vicino alla saturazione delle visite. Dati assenti o incompleti mantengono la stima originale.", "",
    "Le visite sono solo dell'edizione inglese. Le fasce rappresentano ipotesi sulla riconoscibilità, non probabilità di soluzione misurate.", "",
    "Aprire review.html per valutare le combinazioni senza vedere le previsioni ed esportare human-labels.json. La ripartizione calibrazione/verifica è congelata nel campione; le intersezioni miste sono escluse dalle metriche di accordo.", ""];
  for (const [name, r] of Object.entries(report.reports)) {
    const changed = report.cases.filter(c => c.models[name].level !== c.baseline.level).length;
    const increases = report.cases.filter(c => c.models[name].delta > 0).length;
    const decreases = report.cases.filter(c => c.models[name].delta < 0).length;
    lines.push(`## ${name}`, "", `${changed} cambi di fascia sulle ${report.cases.length} combinazioni del campione: ${increases} score aumentati, ${decreases} diminuiti, ${report.cases.length - increases - decreases} invariati.`, "");
    lines.push(`Diagnostica estesa (${r.selection.compared} confronti selezionati, inclusi casi di verifica): ${r.impact.harderClassifications} passaggi a una fascia più difficile e ${r.impact.easierClassifications} a una più facile. Non è una misura di accuratezza e non sostituisce il campione congelato.`, "");
    const candidates = report.cases.filter(c => c.split === "calibration"
      && (c.models[name].level !== c.baseline.level || c.models[name].delta < 0));
    const examples = [...candidates.filter(c => c.models[name].delta < 0).slice(0, 10), ...candidates.filter(c => c.models[name].delta >= 0).slice(0, 10)];
    for (const c of examples) {
      const m = c.models[name];
      lines.push(`### ${c.clubs.join(" / ")}: ${title(c.baseline.level)} → ${title(m.level)}`, "",
        `Prima: ${reason(c.baseline)} Dopo: ${reason(m)}`, "");
      for (const a of m.answers.slice(0, 3)) lines.push(`- ${a.name}: collegamento ${num(a.baseline)} → ${num(a.candidate)}; mediana ${a.evidence.medianMonthlyViews} visite/mese; lingue pesate ${num(a.evidence.weightedLanguages)}; presenze ${a.appearances.map(n => n < 0 ? "sconosciute" : n).join(" / ")}; fattore delle permanenze ${a.spellPairs.map(p => num(p.spellFactor)).join(" / ")}.`);
      lines.push("");
    }
    for (const [mode, audit] of Object.entries(r.audits).filter(([mode]) => mode !== "choiceControl"))
      lines.push(`Audit ${mode}: ${audit.completed ? `${audit.days} giorni` : "non completato"}; ${audit.errors.join("; ") || "controlli superati"}.`, "");
  }
  lines.push("## Valutazioni umane", "", report.evaluation ? JSON.stringify(report.evaluation, null, 2) : "Nessuna valutazione umana disponibile: coefficienti non calibrati e nessun modello approvato.", "");
  return lines.join("\n");
}

// Presentation stays separate from the frozen model calculations.
const { renderReport, renderReview } = require("./recognition-pages.js");
const formatHtml = report => renderReport(report);
const formatReviewHtml = report => renderReview(report, labelTemplate(report));

function writeCalibration(report, output) {
  fs.mkdirSync(output, { recursive: true });
  const files = { "calibration.json": JSON.stringify(report, null, 2) + "\n", "report.md": formatMarkdown(report),
    "report.html": formatHtml(report), "review.html": formatReviewHtml(report),
    "labels-template.json": JSON.stringify(labelTemplate(report), null, 2) + "\n" };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(output, name), content);
  for (const [name, r] of Object.entries(report.reports)) writeReport(r, path.join(output, name));
}

function main(argv = process.argv.slice(2)) {
  const opts = { index: path.join(ROOT, "site/data/index.json"), sample: path.join(ROOT, "data/recognition-calibration/sample.json"),
    snapshot: path.join(ROOT, "data/recognition-calibration/snapshot.json"), output: path.join(ROOT, "data/recognition-calibration"), auditDays: 730 };
  const names = { "--index": "index", "--sample": "sample", "--snapshot": "snapshot", "--output": "output", "--audit-days": "auditDays", "--labels": "labels", "--evaluate": "evaluate", "--club-snapshot": "clubSnapshot" };
  for (let i = 0; i < argv.length; i += 2) {
    if (!names[argv[i]] || !argv[i + 1]) throw new Error(`unknown or incomplete option: ${argv[i]}`);
    opts[names[argv[i]]] = argv[i + 1];
  }
  opts.auditDays = Number(opts.auditDays);
  if (!Number.isSafeInteger(opts.auditDays) || opts.auditDays < 0) throw new Error("invalid audit duration");
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  if (opts.evaluate) {
    if (!opts.labels) throw new Error("--evaluate requires --labels");
    const evaluation = evaluateLabels(read(opts.evaluate), read(opts.labels));
    fs.mkdirSync(opts.output, { recursive: true });
    fs.writeFileSync(path.join(opts.output, "evaluation.json"), JSON.stringify(evaluation, null, 2) + "\n");
    console.log(JSON.stringify(evaluation, null, 2));
    return evaluation;
  }
  const index = read(opts.index);
  const clubPath = opts.clubSnapshot || path.join(ROOT, "data/club-recognition/snapshot.json");
  const report = buildCalibration({ index, sample: read(opts.sample), snapshot: read(opts.snapshot),
    playerQids: loadPlayerQids(index, path.dirname(opts.index)), auditDays: opts.auditDays,
    clubSnapshot: opts.clubSnapshot || fs.existsSync(clubPath) ? read(clubPath) : undefined });
  if (opts.labels) report.evaluation = evaluateLabels(report, read(opts.labels));
  writeCalibration(report, opts.output);
  console.log(JSON.stringify({ coverage: { requested: report.coverage.requested, usable: report.coverage.usable },
    cases: report.cases.length, splits: Object.fromEntries(["calibration", "holdout", "mixed"].map(s => [s, report.cases.filter(c => c.split === s).length])),
    models: Object.fromEntries(Object.entries(report.reports).map(([name, r]) => [name, { changed: report.cases.filter(c => c.models[name].level !== c.baseline.level).length,
      audits: Object.fromEntries(Object.entries(r.audits).map(([k, a]) => [k, a.errors])) }])), output: opts.output }, null, 2));
  return report;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; } }
module.exports = { buildCalibration, labelTemplate, evaluateLabels, formatMarkdown, formatHtml, formatReviewHtml, writeCalibration, main };
