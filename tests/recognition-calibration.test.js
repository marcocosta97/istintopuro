"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { buildSample } = require("../scripts/recognition-sample.js");
const { buildCalibration, labelTemplate, evaluateLabels, formatHtml, formatReviewHtml, main } = require("../scripts/recognition-calibration.js");
const { createModel, REFERENCE_CONFIG, GRADUAL_CONFIG } = require("../scripts/recognition-model.js");
const { recognitionIndex } = require("./helpers/quiz-data.js");
const { mergeLabels } = require("../scripts/recognition-pages.js");

function snapshot(qids = ["Q1"], views = 500) {
  return { version: 1, kind: "recognition-snapshot", generated_at: "2026-11-04T20:00:00Z",
    pageviews_source: { project: "en.wikipedia.org", access: "all-access", agent: "user" },
    players: Object.fromEntries(qids.map(qid => [qid, {
      language_coverage: { status: "available", count: 5, languages: ["en", "it", "es", "fr", "de"], fetched_at: "2026-11-04T19:00:00Z" },
      pageviews: { status: "complete", through: "2026-10", fetched_at: "2026-11-04T19:00:00Z",
        monthly: Array.from({ length: 12 }, (_, i) => [new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 7), views]),
        median_monthly_views: views, total_views: views * 12 } }])) };
}

function setup(mixed = false) {
  const index = recognitionIndex(), playerQids = index.names.map((_, pid) => `Q${pid + 1}`);
  if (mixed) { index.apps.forEach(row => { row[1] = 100; }); index.births[1] = 1970; }
  const sample = buildSample(index, playerQids);
  if (mixed) sample.players.forEach(p => { p.split = p.qid === "Q1" ? "calibration" : "holdout"; });
  return { index, sample, playerQids, snapshot: snapshot(), auditDays: 0 };
}

function population() {
  const countries = ["DE", "ES", "FR", "GB", "IT"], count = 600;
  const index = { built: "2026-11-05", leagues: countries.map(cc => [cc, 1, cc]),
    clubs: countries.flatMap((cc, i) => Array.from({ length: 2 }, (_, j) => [`Club ${i}-${j}`, cc, 1 << i, `Q${1000 + i * 2 + j}`, 0, i])),
    names: Array.from({ length: count }, (_, i) => `Player ${i}`),
    births: Array.from({ length: count }, (_, i) => [1950, 1980, 2000][Math.floor(i / 40) % 3]),
    nats: Array(count).fill("IT"), imgs: Array(count).fill(""), gks: [], postings: [], apps: [], goals: [] };
  let previous = 0;
  for (let i = 0; i < count; i += 5) { index.gks.push(i - previous); previous = i; }
  for (let ci = 0; ci < 10; ci++) {
    const ids = Array.from({ length: 120 }, (_, i) => Math.floor(ci / 2) * 120 + i);
    index.postings.push(ids.map((id, i) => i ? id - ids[i - 1] : id));
    index.apps.push(ids.map(i => [10, 100, 300, 500][i % 4]));
    index.goals.push(ids.map(i => [0, 20, 60, 150][i % 4]));
  }
  return index;
}

test("sample balances countries and birth cohorts without treating posting deltas as player IDs", () => {
  const index = population(), original = JSON.stringify(index), qids = index.names.map((_, i) => `Q${i + 1}`);
  const sample = buildSample(index, qids);
  assert.deepEqual(buildSample(index, qids), sample);
  assert.equal(JSON.stringify(index), original);
  assert.equal(sample.players.length, 300);
  assert.equal(new Set(sample.players.map(p => p.qid)).size, 300);
  assert.deepEqual(Object.values(sample.summary.country), [60, 60, 60, 60, 60]);
  assert.deepEqual(Object.values(sample.summary.era), [100, 100, 100]);
  assert.deepEqual(sample.summary.split, { calibration: 210, holdout: 90 });
  assert.ok(sample.summary.role.goalkeeper > 0);
  assert.deepEqual(sample.shortages, []);
  for (const p of sample.players) {
    const pid = +p.qid.slice(1) - 1;
    assert.equal(p.country, index.leagues[Math.floor(pid / 120)][2]);
    assert.ok(p.probes.every(cs => cs.length === 2 && cs[0] !== cs[1]));
  }
});

test("sample excludes unknown birth cohorts explicitly and merges selectable duplicate records", () => {
  const index = recognitionIndex(), qids = index.names.map((_, i) => `Q${i + 1}`);
  index.apps.forEach(row => { row[1] = 100; row[2] = 100; });
  index.names[1] = index.names[0]; index.births[1] = index.births[0]; index.nats[1] = "PT";
  index.births[2] = null;
  const sample = buildSample(index, qids);
  assert.equal(sample.players.length, 1);
  assert.equal(sample.policy.unknownBirthExcluded, 1);
  assert.ok(sample.shortages.length);
  assert.throws(() => buildSample(index, qids.map(() => "Q1")), /unique QID/);
});

test("an interface-only core change revalidates identical frozen players without changing review identity", () => {
  const options = setup();
  options.sample.quizCoreDigest = "previous-core-interface";
  const expectedLabels = labelTemplate(buildCalibration(options));
  const report = buildCalibration(options);
  assert.equal(report.sampleVerification.sampleRevalidated, true);
  assert.deepEqual(labelTemplate(report), expectedLabels);
  options.sample.players[0].bestBridgeScore++;
  assert.throws(() => buildCalibration(options), /changed the frozen sample/);
});

test("enabling production features preserves the frozen review sample and saved label identities", () => {
  const options = setup(), before = buildCalibration(options);
  const features = require("../scripts/quiz-recognition.js").compile(options.index, options.playerQids,
    { snapshots: [options.snapshot], asOf: options.snapshot.generated_at });
  const index = { ...options.index, quizRecognition: features };
  const after = buildCalibration({ ...options, index });
  assert.equal(after.productionEnabled, true);
  assert.deepEqual(labelTemplate(after), labelTemplate(before));
  assert.deepEqual(buildSample(index, options.playerQids).players, options.sample.players);
  assert.equal(buildSample(index, options.playerQids).inputDigest, options.sample.inputDigest);
});

test("gradual bonus is continuous, bounded, and attenuates weak readership without demoting a player", () => {
  let previous = 0;
  for (const views of [0, 20, 200, 2000, 20000, 100000]) {
    const source = snapshot(["Q1"], views);
    const reference = createModel(source, ["Q1"], { config: REFERENCE_CONFIG });
    const gradual = createModel(source, ["Q1"], { config: GRADUAL_CONFIG });
    const score = gradual.adjustedBase(0, 100);
    assert.ok(score >= 100 && score <= reference.adjustedBase(0, 100));
    assert.ok(score >= previous); previous = score;
    assert.equal(gradual.adjustedBase(0, 900), 900);
    if (views === 0) assert.equal(score, 100);
    if (views === 100000) assert.equal(score, reference.adjustedBase(0, 100));
  }
});

test("calibration preserves inputs and explains actual signals and weakest pair for every correction", () => {
  const options = setup(), original = JSON.stringify(options);
  const report = buildCalibration(options);
  assert.equal(JSON.stringify(options), original);
  assert.equal(report.productionEnabled, false);
  assert.equal(report.recommendedModel, null);
  assert.equal(report.coverage.usable, 1);
  assert.ok(report.cases.length);
  for (const c of report.cases) for (const m of Object.values(c.models)) for (const a of m.answers) {
    assert.equal(a.evidence.medianMonthlyViews, 500);
    assert.equal(a.evidence.through, "2026-10");
    assert.equal(a.candidate, Math.min(...a.spellPairs.map(p => p.candidateBridge)));
    assert.ok(a.spellPairs.every(p => p.spellFactor >= 0 && p.spellFactor <= 1));
  }
  const review = formatReviewHtml(report);
  assert.match(review, /previsioni dei modelli sono nascoste/);
  assert.doesNotMatch(review, /strongestBridge|bonusSupport|candidateBridge|models/);
  for (const html of [review, formatHtml(report)]) for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
    assert.doesNotThrow(() => new vm.Script(match[1]));
  assert.match(formatHtml(report), /speriment|ipotesi/);
  assert.throws(() => buildCalibration({ ...options, index: { ...options.index, built: "2026-10-25" } }), /does not match/);
});

test("unreviewed cases never become labels and reserved labels are scored separately", () => {
  const report = buildCalibration(setup()), labels = labelTemplate(report);
  const empty = evaluateLabels(report, labels);
  assert.equal(empty.calibration.reviewed, 0);
  assert.equal(empty.calibration.models.gradual.agreement, null);
  assert.equal(empty.unreviewed, report.cases.length);
  report.cases[0].split = "holdout";
  labels.rows[0].split = "calibration"; // The frozen report, not editable labels, owns the split.
  labels.rows[0].expectedLevel = report.cases[0].models.gradual.level;
  const evaluated = evaluateLabels(report, labels);
  assert.equal(evaluated.holdout.reviewed, 1);
  assert.equal(evaluated.holdout.models.gradual.agreement, 1);
  assert.equal(evaluated.calibration.reviewed, 0);
  assert.equal(evaluated.recommendedModel, null);
  assert.throws(() => evaluateLabels(report, { ...labels, sampleDigest: "other" }), /do not match/);
  assert.throws(() => evaluateLabels(report, { ...labels, rows: [...labels.rows, labels.rows[0]] }), /duplicate/);
});

test("intersections containing calibration and holdout players are excluded from agreement metrics", () => {
  const report = buildCalibration(setup(true)), labels = labelTemplate(report);
  assert.ok(report.cases.every(c => c.split === "mixed"));
  labels.rows.forEach(row => { row.expectedLevel = "hard"; });
  const evaluation = evaluateLabels(report, labels);
  assert.equal(evaluation.calibration.reviewed, 0);
  assert.equal(evaluation.holdout.reviewed, 0);
  assert.equal(evaluation.mixedReviewed, report.cases.length);
});

test("human labels can be evaluated from frozen reports without source collection or calendar regeneration", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recognition-labels-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = buildCalibration(setup()), labels = labelTemplate(report);
  labels.rows[0].expectedLevel = "hard";
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report));
  fs.writeFileSync(path.join(dir, "labels.json"), JSON.stringify(labels));
  const result = main(["--evaluate", path.join(dir, "report.json"), "--labels", path.join(dir, "labels.json"), "--output", dir]);
  assert.equal(result.calibration.reviewed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "evaluation.json"), "utf8")), result);
  assert.equal(fs.existsSync(path.join(dir, "snapshot.json")), false);
});

test("review imports preserve existing notes and frozen groups, and reject invalid imports atomically", () => {
  const target = labelTemplate(buildCalibration(setup()));
  target.rows[0].expectedLevel = "medium";
  target.rows[0].notes = "Already reviewed";
  const oldPageExport = structuredClone(target);
  oldPageExport.rows[0].expectedLevel = "hard";
  oldPageExport.rows[0].notes = "Imported review";
  oldPageExport.rows[0].split = "holdout";
  mergeLabels(target, oldPageExport);
  assert.equal(target.rows[0].expectedLevel, "hard");
  assert.equal(target.rows[0].notes, "Imported review");
  assert.equal(target.rows[0].split, "calibration");
  for (const mode of ["unknown", "duplicate", "wrong sample", "missing notes", "invalid level"]) {
    const incoming = structuredClone(oldPageExport), before = JSON.stringify(target);
    incoming.rows[0].notes = "Must not replace saved work";
    if (mode === "unknown") incoming.rows.push({ ...incoming.rows[0], id: "unavailable" });
    if (mode === "duplicate") incoming.rows.push(incoming.rows[0]);
    if (mode === "wrong sample") incoming.sampleDigest = "different";
    if (mode === "missing notes") delete incoming.rows[0].notes;
    if (mode === "invalid level") incoming.rows[0].expectedLevel = "unclassified";
    assert.throws(() => mergeLabels(target, incoming), mode);
    assert.equal(JSON.stringify(target), before, mode);
  }
});

test("report renders signed decreases and filters them independently of difficulty changes", () => {
  const options = setup();
  options.snapshot = snapshot(["Q1"], 0);
  const report = buildCalibration(options), html = formatHtml(report);
  assert.ok(report.cases.some(c => c.models.bidirectional.delta < 0));
  const elements = Object.fromEntries(["model", "direction", "search", "cases", "results", "page-count", "previous", "next"]
    .map(id => [id, { value: "", textContent: "", innerHTML: "", disabled: false }]));
  elements.model.value = "bidirectional";
  elements.direction.value = "decrease";
  const filters = ["changed", "all"].map(filter => ({ dataset: { filter }, setAttribute() {} }));
  const document = { getElementById: id => elements[id], querySelectorAll: () => filters };
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
  vm.runInNewContext(script, { document });
  assert.match(elements.cases.innerHTML, /gain negative/);
  assert.match(elements.cases.innerHTML, /−[\d]/);
  assert.doesNotMatch(elements.cases.innerHTML, /\+−|\+-/);
  assert.doesNotMatch(elements.results.textContent, /^0 /);
  elements.direction.value = "increase";
  elements.direction.onchange();
  assert.equal(elements.results.textContent, "0 collegamenti");
  elements.direction.value = "decrease";
  elements.model.value = "reference";
  elements.model.onchange();
  assert.equal(elements.results.textContent, "0 collegamenti", "the bonus-only control has no decreases");
});
