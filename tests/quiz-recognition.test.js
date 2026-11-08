"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { compile } = require("../scripts/quiz-recognition.js");
const { createAdapter, validate } = require("../site/quiz-recognition.js");
const { createRuntime, loadRuntime } = require("../scripts/quiz-schedule.js");
const { createModel } = require("../scripts/recognition-model.js");
const { createClubContext } = require("../scripts/club-recognition.js");
const { EASY_QIDS } = require("../site/quiz-core.js");
const fixture = require("./fixtures/club-recall.json");
const asOf = [fixture.clubSnapshot.generated_at, fixture.snapshot.generated_at]
  .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
const bundle = () => compile(fixture.index, fixture.playerQids,
  { snapshots: [fixture.snapshot], clubSnapshot: fixture.clubSnapshot, asOf });

test("the shipped adapter reproduces the approved player and club model, including hints and answers", () => {
  const compiled = bundle();
  const player = createModel(fixture.snapshot, fixture.playerQids, { asOf });
  const club = createClubContext(fixture.index, fixture.clubSnapshot, { asOf });
  const options = { stature: ci => fixture.index._fixture.clubStature[ci] };
  const expected = createRuntime(structuredClone(fixture.index), { ...options, recognition: club.wrap(player.adapter) });
  const published = createRuntime({ ...structuredClone(fixture.index), quizRecognition: compiled }, options);
  for (const qids of fixture.probes) {
    const a = expected.core.stagesFromQids([qids])[0], b = published.core.stagesFromQids([qids])[0];
    assert.equal(b.ease, a.ease);
    assert.equal(published.core.classifyStage(b), expected.core.classifyStage(a));
    assert.deepEqual(b.answers, a.answers);
    assert.deepEqual(published.core.qRanked(b), expected.core.qRanked(a));
    assert.equal(published.core.qFace(b), expected.core.qFace(a));
    for (const pid of a.effective)
      assert.equal(published.core.qDifficultyFame(pid, b.clubs), expected.core.qDifficultyFame(pid, a.clubs));
  }
});

test("the browser and Node use the same frozen inputs, independently of the wall clock", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../site/quiz-recognition.js"), "utf8"), context);
  const index = { ...fixture.index, quizRecognition: JSON.parse(JSON.stringify(bundle())) };
  const node = createAdapter(index, EASY_QIDS), browser = context.QuizRecognition.createAdapter(index, EASY_QIDS);
  for (const pid of [0, 1, 10, fixture.index.names.length - 1]) for (const baseFame of [0, 180, 400, 550, 900]) {
    const args = { pid, baseFame, bridgeFame: baseFame * 0.6, clubQids: ["Q1153687", "Q483020"] };
    assert.equal(browser.adjustBridge(args), node.adjustBridge(args));
  }
  const html = fs.readFileSync(path.join(__dirname, "../site/index.html"), "utf8");
  assert.ok(html.indexOf('src="quiz-recognition.js') < html.indexOf('src="quiz.js'));
  const files = require("../site/offline.js").coreFiles({ nshards: 0, clubs: [] }, "test");
  assert.ok(files.includes("./quiz-recognition.js?v=test"));
});

test("cached observations survive an unavailable source and remap by QID after player IDs change", () => {
  const previous = bundle(), qids = [...fixture.playerQids].reverse();
  const index = { ...fixture.index, names: [...fixture.index.names].reverse() };
  const next = compile(index, qids, { previous, asOf });
  for (const [qid, row] of Object.entries(previous.players)) {
    assert.equal(next.players[qid][0], qids.indexOf(qid));
    assert.deepEqual(next.players[qid].slice(1), row.slice(1));
  }
  assert.deepEqual(next.clubs, previous.clubs);
  assert.deepEqual(compile(index, qids, { previous: next, asOf }), next);
});

test("stale and incomplete data are neutral and are removed at release compilation", () => {
  const previous = bundle(), future = new Date(Date.parse(asOf) + 91 * 864e5).toISOString();
  const expired = compile(fixture.index, fixture.playerQids, { previous,
    snapshots: [fixture.snapshot], clubSnapshot: fixture.clubSnapshot, asOf: future });
  assert.equal(Object.keys(expired.players).length, 0);
  assert.equal(Object.keys(expired.clubs).length, 0);
  const adapter = createAdapter({ ...fixture.index, quizRecognition: expired }, EASY_QIDS);
  assert.equal(adapter.adjustBridge({ pid: 0, baseFame: 600, bridgeFame: 300, clubQids: ["Q1153687"] }), 300);
  assert.throws(() => compile(fixture.index, fixture.playerQids, { previous, asOf: "2020-01-01T00:00:00Z" }), /before/);
});

test("invalid or mismatched published measurements fail release validation", () => {
  const invalid = bundle(), qid = Object.keys(invalid.players)[0];
  invalid.players[qid][1] = -1;
  assert.throws(() => validate(invalid, fixture.index.names.length), /invalid published player/);
  const config = bundle();
  config.clubConfig = { ...config.clubConfig, minFactor: 0.1 };
  assert.throws(() => validate(config, fixture.index.names.length), /unsupported/);
});

test("the full published coverage keeps explicit user feedback at its minimum difficulty", () => {
  const { core } = loadRuntime();
  for (const example of require("../scripts/recognition-examples.json").items) {
    const stage = core.stagesFromQids([example.qids])[0];
    assert.ok(stage, example.qids.join("/"));
    assert.ok(core.classifyStage(stage) >= core.constants.QLEVELS.indexOf(example.minimumDifficulty),
      `${example.qids.join("/")}: expanded observations must not erase the obscure clue`);
  }
});
