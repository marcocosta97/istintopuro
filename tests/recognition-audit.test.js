"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRuntime } = require("../scripts/quiz-schedule.js");
const { recognitionIndex } = require("./helpers/quiz-data.js");
const { createModel, configuration, CONSERVATIVE_CONFIG } = require("../scripts/recognition-model.js");
const { buildReport, formatMarkdown, formatHtml, loadPlayerQids, main } = require("../scripts/recognition-audit.js");
const fixture = require("./fixtures/recognition-signals.json");

function snapshot(cases = { Q1: "broad" }) {
  const players = {};
  for (const [qid, name] of Object.entries(cases)) {
    const row = typeof name === "string" ? fixture.cases[name] : name;
    const fetched_at = row.fetchedAt || fixture.fetchedAt;
    players[qid] = { language_coverage: { status: "available", count: row.languages.length,
      languages: row.languages, fetched_at, current: false },
    pageviews: { status: "complete", title: "Synthetic player", through: fixture.through, fetched_at, current: false,
      monthly: Array.from({ length: 12 }, (_, i) => [new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 7), row.monthlyViews]),
      total_views: row.monthlyViews * 12, median_monthly_views: row.monthlyViews } };
  }
  return { version: 1, kind: "recognition-snapshot", generated_at: fixture.asOf, players,
    pageviews_source: { project: "en.wikipedia.org", access: "all-access", agent: "user" } };
}

function setup(data = snapshot(), configure = {}, changeIndex = () => {}) {
  const index = recognitionIndex();
  changeIndex(index);
  const qids = index.names.map((_, pid) => `Q${pid + 1}`);
  const model = createModel(data, qids, { config: configure });
  const baseline = createRuntime(structuredClone(index));
  const control = createRuntime(structuredClone(index), { recognition: { distinctChoices: true } });
  const candidate = createRuntime(structuredClone(index), { recognition: model.adapter });
  for (const rt of [baseline, control, candidate]) rt.core.qPools();
  return { index, qids, model, baseline, control, candidate };
}

test("primary language editions outweigh supplementary editions and long-tail contribution is capped", () => {
  const primary = createModel(snapshot(), ["Q1"]).features[0];
  const other = createModel(snapshot({ Q1: { languages: ["ro", "hi"], monthlyViews: 100000 } }), ["Q1"]).features[0];
  assert.ok(primary.languageScore > other.languageScore);
  const many = Object.keys(configuration().languageWeights).concat(Array.from({ length: 30 }, (_, i) => `a${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26))}`));
  const capped = createModel(snapshot({ Q1: { languages: many, monthlyViews: 100000 } }), ["Q1"]).features[0];
  assert.equal(capped.languageScore, 1);
  assert.equal(capped.weightedLanguages, 9);
});

test("a strong signal supplies a capped positive correction and a separate familiarity anchor", () => {
  const { model } = setup();
  assert.ok(model.features[0].anchor);
  assert.ok(model.adjustedBase(0, 100) > 100);
  assert.ok(model.adjustedBase(0, 100) <= 100 + model.config.maxBoost);
  assert.equal(model.adjustedBase(0, 900), 900, "existing legends are not demoted");
  assert.equal(model.adjustedBase(1, 100), 100, "an unobserved player keeps the career prior");
  assert.equal(model.adapter.adjustBridge({ pid: 1, baseFame: 276.145, bridgeFame: 225.131 }), 225.131,
    "missing evidence must not introduce floating-point changes");
});

test("zero readership is valid evidence and stale, future or incomplete evidence falls back exactly", () => {
  const zero = createModel(snapshot({ Q1: "zero" }), ["Q1"]);
  assert.equal(zero.features[0].medianMonthlyViews, 0);
  assert.equal(zero.features[0].eligible, true);
  assert.ok(zero.adjustedBase(0, 300) < 300, "a measured zero is evidence, not missing data");
  assert.ok(zero.adjustedBase(0, 300) >= 300 * (1 - zero.config.maxDropFraction));
  for (const mode of ["old", "partial", "future", "tampered", "missing language"]) {
    const source = snapshot({ Q1: mode === "old" ? "old" : "broad" });
    if (mode === "partial") source.players.Q1.pageviews.monthly[0][1] = null;
    if (mode === "future") source.players.Q1.pageviews.fetched_at = "2026-11-05T00:00:00Z";
    if (mode === "tampered") source.players.Q1.pageviews.total_views++;
    if (mode === "missing language") source.players.Q1.language_coverage = null;
    const model = createModel(source, ["Q1"]);
    assert.equal(model.features[0].eligible, false, mode);
    assert.equal(model.adjustedBase(0, 150), 150, mode);
  }
});

test("freshness uses the frozen as-of timestamp, not persisted current flags or the wall clock", () => {
  const source = snapshot();
  const before = createModel(source, ["Q1"]);
  assert.equal(before.features[0].eligible, true);
  const after = createModel(source, ["Q1"], { asOf: "2027-02-03T20:00:00Z" });
  assert.equal(after.features[0].eligible, false);
  assert.deepEqual(createModel(source, ["Q1"]).features, before.features);
  assert.throws(() => createModel(source, ["Q1"], { asOf: "2026-10-01T00:00:00Z" }), /generated after/);
});

test("popularity can lift a non-elite career above the familiarity threshold while retaining spell evidence", () => {
  const { baseline, candidate } = setup(snapshot(), {}, index => {
    index.clubs[0][3] = "Q2609"; // Lazio and Fiorentina are familiar, outside the elite baseline.
    index.apps[1][0] = 0;
    index.apps[0][0] = 220;
    index.apps[2][0] = 220;
  });
  const clubs = [0, 2], answers = [0];
  assert.equal(baseline.index.qGlobalApps[0], 0);
  assert.deepEqual(baseline.core.qFamiliarAnswers(clubs, answers), []);
  assert.deepEqual(candidate.core.qFamiliarAnswers(clubs, answers), [0]);
  candidate.index.apps[0][0] = 1;
  assert.deepEqual(candidate.core.qFamiliarAnswers(clubs, answers), [], "fame cannot make a cameo a familiar bridge");
});

test("zero registrations remain accepted and cannot be promoted into effective difficulty candidates", () => {
  const { candidate } = setup();
  const [stage] = candidate.core.stagesFromQids([["Q1543", "Q9616"]]);
  assert.ok(candidate.core.answerMatches(1, stage.answers));
  assert.equal(stage.effective.includes(1), false);
});

test("production and experimental breadth count each merged name/year choice once", () => {
  const { baseline, control, candidate } = setup(snapshot({}), {}, index => {
    index.names[1] = index.names[0]; index.births[1] = index.births[0]; index.nats[1] = "PT";
    index.apps[0][1] = 80; index.apps[1][1] = 90;
  });
  const clubs = [0, 1], answers = [0, 1];
  assert.equal(baseline.core.qRecognisableBreadth(clubs, answers), control.core.qRecognisableBreadth(clubs, answers));
  assert.equal(control.core.qEase(clubs, answers), candidate.core.qEase(clubs, answers));
  assert.equal(control.core.qRecognisableBreadth(clubs, answers),
    Math.max(...answers.map(pid => control.core.qRecognitionWeight(control.core.qDifficultyFame(pid, clubs)))));
});

test("a merged choice remains familiar when any valid record qualifies, even if a higher-scoring record lacks spell totals", () => {
  const { candidate } = setup(snapshot(), {}, index => {
    index.clubs[2][3] = "Q7156";
    index.apps[0][0] = index.apps[1][0] = -1;
    index.apps[2][0] = 500; index.goals[2][0] = 100;
    index.names[1] = index.names[0]; index.births[1] = index.births[0]; index.nats[1] = "PT";
    index.apps[0][1] = index.apps[1][1] = 100;
    index.goals[0][1] = index.goals[1][1] = 25;
  });
  const clubs = [0, 1];
  assert.ok(candidate.core.qDifficultyFame(0, clubs) > candidate.core.qDifficultyFame(1, clubs));
  assert.deepEqual(candidate.core.qFamiliarAnswers(clubs, [0, 1]), [1]);
  assert.equal(candidate.core.qEasyEligible(clubs, [0, 1]), false, "one moderate route is not a very obvious solo answer");
});

test("a third clue cannot inflate candidate recognition and hints keep the production ranking", () => {
  const { baseline, candidate } = setup();
  const triple = [0, 1, 2];
  for (const pair of [[0, 1], [0, 2], [1, 2]]) {
    assert.ok(candidate.core.qDifficultyFame(0, triple) <= candidate.core.qDifficultyFame(0, pair));
    assert.ok(candidate.core.qEase(triple, [0]) <= candidate.core.qEase(pair, [0]));
  }
  const stage = { clubs: [0, 1], answers: [0, 1], effective: [0, 1] };
  assert.deepEqual(candidate.core.qRanked(stage), baseline.core.qRanked(stage));
  assert.equal(candidate.core.nextHintTarget(stage), baseline.core.nextHintTarget(stage));
});

test("the default core and an evidence-free candidate agree when there are no duplicate choices", () => {
  const { baseline, candidate } = setup(snapshot({}));
  const qids = [["Q1543", "Q9616"], ["Q1543", "Q2052"], ["Q1543", "Q9616", "Q2052"]];
  for (const row of qids) {
    const [before] = baseline.core.stagesFromQids([row]), [after] = candidate.core.stagesFromQids([row]);
    assert.deepEqual(candidate.core.stageDiagnostics(after), baseline.core.stageDiagnostics(before));
  }
});

test("goalkeeper and historical careers use the same bounded evidence without an automatic demographic exemption", () => {
  for (const data of [snapshot({}), snapshot({ Q1: "local" })]) {
    const { baseline, candidate } = setup(data, {}, index => { index.births[0] = 1940; index.gks = [0]; });
    const before = baseline.core.qBridgeFame(0, [0, 1]), after = candidate.core.qDifficultyFame(0, [0, 1]);
    assert.ok(after >= before * 0.75 && after <= before + 250);
    if (!data.players.Q1) assert.equal(after, before);
    assert.equal(candidate.index.gkSet.has(0), true);
  }
});

test("invalid tuning values and unexpected source agents cannot enter an experiment", () => {
  for (const config of [{ blend: 2 }, { viewsCap: 0 }, { maxBoost: -1 }, { maxDrop: -1 }, { maxDropFraction: 1.1 },
    { downwardBlend: 1.1 }, { downwardFade: 0 }, { downwardFade: 1.1 }, { downwardEditionProtection: -1 },
    { typo: 5 }, { languageWeights: { en: -1 } }])
    assert.throws(() => configuration(config));
  const source = snapshot(); source.pageviews_source.agent = "all-agents";
  assert.throws(() => createModel(source, ["Q1"]), /unsupported/);
  assert.throws(() => createModel({ ...snapshot(), players: [] }, ["Q1"]), /unsupported/);
});

test("bounded signed corrections lower overestimated answers and all derived set-recognition inputs", () => {
  const { baseline, candidate } = setup(snapshot({ Q1: "zero" }), {}, index => {
    index.apps.forEach(row => { row[0] = 250; });
    index.goals.forEach(row => { row[0] = 25; });
    index.births[0] = 1998;
  });
  const clubs = [0, 1], answers = [0];
  const before = baseline.core.qDifficultyFame(0, clubs), after = candidate.core.qDifficultyFame(0, clubs);
  assert.ok(after < before);
  assert.ok(after >= before * 0.75 && before - after <= 150);
  assert.ok(candidate.core.qEase(clubs, answers) < baseline.core.qEase(clubs, answers));
  assert.ok(candidate.core.qRecognisableBreadth(clubs, answers) <= baseline.core.qRecognisableBreadth(clubs, answers));
  assert.ok(candidate.core.qFamiliarAnswers(clubs, answers).length <= baseline.core.qFamiliarAnswers(clubs, answers).length);
  assert.equal(baseline.core.classifyStage({ clubs, effective: answers }), 0);
  assert.equal(candidate.core.classifyStage({ clubs, effective: answers }), 1, "a supported malus can move an otherwise valid set from Easy to Medium");
  assert.deepEqual(candidate.core.qAnswerSet(answers), baseline.core.qAnswerSet(answers));
  assert.deepEqual(candidate.core.qRanked({ clubs, effective: answers }), baseline.core.qRanked({ clubs, effective: answers }));
  for (let ci = 0; ci < 2; ci++) candidate.index.apps[ci][2] = 10;
  const withObscureAlternative = candidate.core.qEase(clubs, [0, 2]);
  assert.ok(withObscureAlternative >= candidate.core.qEase(clubs, [0]), "an extra valid route cannot make an any-answer quiz harder");
  const triple = [0, 1, 2];
  for (const pair of [[0, 1], [0, 2], [1, 2]])
    assert.ok(candidate.core.qDifficultyFame(0, triple) <= candidate.core.qDifficultyFame(0, pair));
});

test("stronger readership and edition coverage never worsen the corrected recognition score", () => {
  const languages = [["en"], ["en", "it"], ["en", "it", "es", "fr", "de"], ["en", "it", "es", "fr", "de", "ro", "hi"]];
  const views = [0, 10, 100, 1000, 10000, 50000, 99000, 99999, 100000];
  for (const base of [1, 100, 300, 600, 900]) {
    const matrix = languages.map(ls => views.map(monthlyViews =>
      createModel(snapshot({ Q1: { languages: ls, monthlyViews } }), ["Q1"]).adjustedBase(0, base)));
    matrix.forEach(row => row.forEach((score, i) => {
      assert.ok(score >= base - Math.min(150, 0.25 * base) - 1e-9 && score <= base + 250);
      if (i) assert.ok(score >= row[i - 1] - 1e-9);
    }));
    matrix.forEach((row, i) => { if (i) row.forEach((score, j) => assert.ok(score >= matrix[i - 1][j] - 1e-9)); });
  }
});

test("downside revision preserves every positive correction exactly while strengthening only supported reductions", () => {
  for (const viewCount of [0, 100, 1000, 10000, 50000, 99999, 100000]) {
    const source = snapshot({ Q1: { languages: ["en", "it", "es", "fr", "de"], monthlyViews: viewCount } });
    const previous = createModel(source, ["Q1"], { config: CONSERVATIVE_CONFIG });
    const revised = createModel(source, ["Q1"]);
    for (let base = 0; base <= 1000; base += 20) {
      const old = previous.adjustment(0, base), current = revised.adjustment(0, base);
      if (old.delta >= 0) assert.equal(current.delta, old.delta, "accepted bonuses must not drift");
      else assert.ok(current.delta <= old.delta, "the revised downside removes double attenuation");
      assert.ok(current.delta >= -Math.min(150, 0.25 * base));
    }
  }
  const almostCapped = createModel(snapshot({ Q1: { languages: ["en"], monthlyViews: 99999 } }), ["Q1"]);
  const capped = createModel(snapshot({ Q1: { languages: ["en"], monthlyViews: 100000 } }), ["Q1"]);
  assert.equal(capped.adjustedBase(0, 900), 900);
  assert.ok(capped.adjustedBase(0, 900) - almostCapped.adjustedBase(0, 900) < 0.01, "censoring protection must fade smoothly");
});

test("signed fusion remains ordered by career prior and a smaller observed alternative is never a set penalty", () => {
  const model = createModel(snapshot({ Q1: "local" }), ["Q1"]);
  let previous = -1;
  for (let base = 0; base <= 1000; base += 5) {
    const score = model.adjustedBase(0, base);
    assert.ok(score >= previous); previous = score;
    assert.ok(score >= 0);
  }
  assert.throws(() => model.adjustedBase(0, NaN), /finite/);
});

test("reports are reproducible, preserve source inputs, and distinguish identity from popularity deltas", () => {
  const { index, qids } = setup(), source = snapshot();
  const inputs = JSON.stringify({ index, source });
  const options = { index, snapshot: source, playerQids: qids, probes: [["Q1543", "Q9616"]] };
  const report = buildReport(options);
  assert.deepEqual(buildReport(options), report);
  assert.equal(JSON.stringify({ index, source }), inputs);
  assert.equal(report.deploymentReady, false);
  assert.equal(report.coverage.usable, 1);
  assert.equal(report.intersections[0].identityDelta, 0);
  assert.ok(report.intersections[0].popularityDelta >= 0);
  assert.match(formatMarkdown(report), /not calibrated/);
  assert.match(formatHtml(report), /Distinct choices/);
  assert.throws(() => buildReport({ ...options, index: { ...index, built: null } }), /fixed dataset build date/);
});

test("CLI joins by career QID, exports only audit files, and leaves the published schedule intact", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recognition-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const index = recognitionIndex(); index.nshards = 1;
  fs.mkdirSync(path.join(dir, "career"));
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify(snapshot()));
  fs.writeFileSync(path.join(dir, "career/0.json"), JSON.stringify(Object.fromEntries(index.names.map((_, pid) => [pid, [pid + 1, []]]))));
  const schedule = JSON.stringify({ days: { "2026-11-04": [["Q1543", "Q9616"]] } });
  fs.writeFileSync(path.join(dir, "quiz-schedule.json"), schedule);
  const report = main(["--index", path.join(dir, "index.json"), "--snapshot", path.join(dir, "snapshot.json"),
    "--output", path.join(dir, "report"), "--audit-days", "0"]);
  assert.equal(report.players[0].qid, "Q1");
  assert.equal(fs.readFileSync(path.join(dir, "quiz-schedule.json"), "utf8"), schedule);
  for (const name of ["report.json", "report.md", "report.html", "players.csv"])
    assert.ok(fs.existsSync(path.join(dir, "report", name)));
  assert.throws(() => loadPlayerQids({ ...index, names: [...index.names, "Missing QID"] }, dir), /missing player QIDs/);
});
