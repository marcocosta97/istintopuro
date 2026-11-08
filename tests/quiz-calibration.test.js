"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ELITE_QIDS } = require("../site/quiz-core.js");
const { calibrationRuntime: runtime } = require("./helpers/quiz-runtime.js");
const { createRuntime } = require("../scripts/quiz-schedule.js");
const { recognitionIndex } = require("./helpers/quiz-data.js");

test("broader easy clues do not widen the elite player visibility baseline", () => {
  const index = recognitionIndex();
  const before = createRuntime(structuredClone(index));
  before.core.qPools();
  const milan = before.byQid.get("Q1543"), chelsea = before.byQid.get("Q9616");
  // Only Milan and Chelsea contribute to elite visibility, each weighted 1.15.
  assert.ok(Math.abs(before.index.qGlobalApps[0] - (80 + 90) * 1.15) < 1e-4);
  const fame = before.core.qFame(0, [milan, chelsea]);
  index.apps[2][0] = 2000; // More exposure at Fiorentina, an extra easy clue.
  const after = createRuntime(index);
  const pools = after.core.qPools();
  assert.ok(pools.easy.includes(2));
  assert.ok(!pools.elite.includes(2));
  assert.equal(after.index.qGlobalApps[0], before.index.qGlobalApps[0]);
  assert.ok(after.index.qMApps[0] > before.index.qMApps[0]);
  assert.ok(after.core.qFame(0, [milan, chelsea]) > fame);
});

test("zero-appearance registrations are accepted answers but not difficulty candidates", () => {
  const { core, intersect, postings } = runtime();
  const [stage] = core.stagesFromQids([["Q41420", "Q106394"]]);
  const raw = intersect(stage.clubs.map(postings));
  const registeredOnly = raw.find(pid => core.appearanceGaps(pid, stage.clubs).zero.length);
  assert.ok(registeredOnly !== undefined);
  assert.equal(core.answerMatches(registeredOnly, stage.answers), true);
  assert.equal(core.answerMatches(registeredOnly, stage.effective), false);
  assert.equal(stage.answers.length > stage.effective.length, true);
  assert.equal(stage.effective.every(pid => stage.clubs.every(ci => core.qApps(ci, pid) !== 0)), true);
  assert.equal(core.appearanceGaps(registeredOnly, stage.clubs).missing.length, 0);
  assert.equal(core.appearanceGaps(registeredOnly, stage.clubs).zero.length > 0, true);
});

test("bridge recognisability penalizes cameos without penalizing unknown historical totals", () => {
  const { DB, core } = runtime();
  const [dortmundSociedad] = core.stagesFromQids([["Q41420", "Q10315"]]);
  const weakestLinks = dortmundSociedad.effective.map(pid =>
    Math.min(...dortmundSociedad.clubs.map(ci => core.qApps(ci, pid))));
  assert.equal(Math.max(...weakestLinks), 8);
  assert.equal(dortmundSociedad.ease >= 140 && dortmundSociedad.ease < 425, true);
  assert.equal(dortmundSociedad.ease < core.constants.QEASY[0].ease[0], true);
  const isak = dortmundSociedad.effective.find(pid => DB.names[pid] === "Alexander Isak");
  assert.equal(core.qBridgeFame(isak, dortmundSociedad.clubs) < core.qFame(isak, dortmundSociedad.clubs), true);

  const [celtaSevilla] = core.stagesFromQids([["Q8749", "Q10329"]]);
  const balbino = celtaSevilla.effective.find(pid => DB.names[pid] === "Balbino Clemente");
  assert.equal(celtaSevilla.clubs.every(ci => core.qApps(ci, balbino) < 0), true);
  assert.equal(core.qBridgeFame(balbino, celtaSevilla.clubs), core.qFame(balbino, celtaSevilla.clubs));
  assert.deepEqual(core.appearanceGaps(balbino, celtaSevilla.clubs), { missing: [], zero: [] });
});

test("large intersections earn ease from recognisable breadth rather than raw answer count", () => {
  const { core } = runtime();
  const [atalantaJuventus] = core.stagesFromQids([["Q1886", "Q1422"]]);
  const breadth = core.qRecognisableBreadth(atalantaJuventus.clubs, atalantaJuventus.effective);
  assert.equal(atalantaJuventus.effective.length, 90);
  assert.equal(breadth < 15, true);
  assert.equal(atalantaJuventus.ease >= core.constants.QEASY[0].ease[0], true);
});

test("handle-like labels cannot become representative answers", () => {
  const { DB, core } = runtime();
  const handle = 0, original = DB.names[handle];
  const named = DB.names.findIndex((name, pid) => pid !== handle && core.qUsableName(pid));
  try {
    DB.names[handle] = "elpisha";
    assert.equal(core.qUsableName(handle), false);
    assert.equal(core.qRanked({ clubs: [], answers: [handle, named] })[0], named);
  } finally {
    DB.names[handle] = original;
  }
});

test("guess identity treats indistinguishable PIDs as the same answer", () => {
  const { DB, core } = runtime();
  // Construct the duplicate: a refresh is allowed to remove every real duplicate.
  const pair = [0, DB.names.length];
  for (const field of ["names", "births", "nats"]) DB[field].push(DB[field][0]);
  assert.equal(core.answerMatches(pair[1], [pair[0]]), true);
});

test("easy triples retain multiple familiar routes and reject an extra obscure spell", () => {
  const { core } = runtime();
  const obvious = core.stagesFromQids([["Q1543", "Q7156", "Q483020"]])[0];
  assert.ok(core.qEasyEligible(obvious.clubs, obvious.effective));
  assert.ok(obvious.ease >= core.constants.QBOUNDARIES.easy);
  const rejected = core.stagesFromQids([["Q631", "Q2739", "Q18716"]])[0];
  assert.ok(rejected);
  assert.equal(core.qEasyEligible(rejected.clubs, rejected.effective), false);
  assert.equal(core.qEasyEligible(obvious.clubs.slice(0, 1), obvious.effective), false);
});

test("football calibration preserves legends without promoting local statistics to easy", () => {
  const { DB, core } = runtime();
  const combo = qids => core.stagesFromQids([qids])[0];
  const zidane = combo(["Q172476", "Q1422"]); // Bordeaux / Juventus
  const parmaJuve = combo(["Q2693", "Q1422"]);
  const levanteRayo = combo(["Q8823", "Q10300"]);
  const isak = combo(["Q41420", "Q10315"]);
  assert.ok(zidane.ease >= core.constants.QBOUNDARIES.easy);
  assert.equal(DB.names[core.qFace(zidane)], "Zinedine Zidane");
  const buffon = parmaJuve.effective.find(pid => DB.names[pid] === "Gianluigi Buffon");
  assert.ok(core.qFamiliarAnswers(parmaJuve.clubs, parmaJuve.effective).includes(buffon));
  assert.equal(core.qEasyEligible(levanteRayo.clubs, levanteRayo.effective), false);
  assert.ok(levanteRayo.ease < core.constants.QBOUNDARIES.easy);
  assert.ok(zidane.ease > levanteRayo.ease);
  assert.ok(isak.ease >= core.constants.QBOUNDARIES.hard && isak.ease < core.constants.QBOUNDARIES.medium);
});

test("historical career links remain candidates after a club leaves the top divisions", () => {
  const { DB, core } = runtime();
  const pools = core.qPools();
  for (const qid of ["Q172476", "Q19446"]) {
    const ci = DB.byQid.get(qid); // Bordeaux / Blackburn
    assert.ok(pools.field.includes(ci));
  }
});

test("recency does not create a difficulty cliff on the 33rd birthday", () => {
  const { DB, core } = runtime();
  const [stage] = core.stagesFromQids([["Q8823", "Q10300"]]);
  const pid = DB.names.indexOf("Jorge de Frutos"), birth = DB.births[pid];
  try {
    DB.births[pid] = DB.qYear - 32;
    const before = core.qBridgeFame(pid, stage.clubs);
    DB.births[pid]--;
    const after = core.qBridgeFame(pid, stage.clubs);
    assert.ok(before > after && before - after <= 6);
  } finally {
    DB.births[pid] = birth;
  }
});

test("adding a third required club cannot inflate ease or recognised breadth", () => {
  const { core, intersect, postings } = runtime();
  const [stage] = core.stagesFromQids([["Q2052", "Q631", "Q2739"]]);
  assert.ok(stage, "fixed calibration includes a triple");
  for (let dropped = 0; dropped < 3; dropped++) {
    const clubs = stage.clubs.filter((_, i) => i !== dropped);
    const answers = core.qEffective(clubs, intersect(clubs.map(postings)));
    assert.ok(stage.ease <= core.qEase(clubs, answers));
    assert.ok(core.qRecognisableBreadth(stage.clubs, stage.effective) <= core.qRecognisableBreadth(clubs, answers));
  }
});

test("classification admits an obvious single route and assigns unfamiliar clues to a valid harder tier", () => {
  const { core } = runtime();
  const resolve = qids => core.stagesFromQids([qids])[0];
  const easy = resolve(["Q1543", "Q2052"]); // Milan / Fiorentina
  const medium = resolve(["Q172476", "Q1422"]); // Bordeaux / Juventus
  const triple = resolve(["Q2052", "Q631", "Q2739"]); // Fiorentina / Inter / Roma
  const mediumTriple = resolve(["Q2693", "Q1422", "Q1543"]); // Parma / Juventus / Milan
  const cameo = resolve(["Q1543", "Q1130849"]); // Milan / Liverpool
  const unknownClue = resolve(["Q8701", "Q12260"]); // Atlético / Sabadell
  assert.equal(core.classifyStage(easy), 0);
  assert.ok(medium.ease >= core.constants.QBOUNDARIES.easy);
  assert.equal(core.qFamiliarAnswers(medium.clubs, medium.effective).length, 1);
  assert.equal(core.classifyStage(medium), 0);
  assert.equal(core.qFamiliarAnswers(triple.clubs, triple.effective).length, 0);
  assert.equal(core.classifyStage(triple), 2);
  assert.equal(core.qFamiliarAnswers(mediumTriple.clubs, mediumTriple.effective).length, 1);
  assert.equal(core.classifyStage(mediumTriple), 1);
  assert.ok(cameo.ease >= core.constants.QBOUNDARIES.medium);
  assert.equal(core.classifyStage(cameo), 1);
  assert.ok(unknownClue);
  assert.ok(core.qFamiliarAnswers(unknownClue.clubs, unknownClue.effective).length > 0);
  assert.equal(core.classifyStage(unknownClue), 1);
  for (const stage of [easy, medium, triple, mediumTriple, cameo, unknownClue]) {
    assert.equal(core.stageDiagnostics(stage).level, core.classifyStage(stage));
    assert.equal(core.qComboInfo(stage.clubs).level, core.classifyStage(stage));
  }
  assert.equal(core.classifyStage({ clubs: [], effective: [] }), -1);
  assert.equal(core.classifyStage({ clubs: easy.clubs, effective: [] }), -1);
});

test("fixed Milan–Chelsea calibration retains its recognition score", () => {
  const { DB, core } = runtime();
  const pools = core.qPools();
  assert.ok(pools.easy.length > pools.elite.length);
  assert.deepEqual(pools.elite.map(ci => DB.clubs[ci][3]).sort(), [...ELITE_QIDS].sort());
  const [stage] = core.stagesFromQids([["Q1543", "Q9616"]]);
  assert.ok(Math.abs(stage.ease - 814.3038391080344) < 1e-6, "fixed inputs must retain the calibrated score");
});

test("a general fan's easy excludes the rejected domestic week and admits obvious European bridges", () => {
  const { DB, core } = runtime();
  for (const qids of [
    ["Q18739", "Q18662"], // Sunderland / Cardiff
    ["Q51974", "Q106394"], // Hamburg / Freiburg
    ["Q9616", "Q18736"], // Chelsea / Stoke
    ["Q501693", "Q704"], // Troyes / Lyon
    ["Q1051013", "Q19512"], // Paris FC / Sochaux
    ["Q2052", "Q13391"], // Fiorentina / Lecce: plausible local recall, not universal easy
  ]) {
    const [stage] = core.stagesFromQids([qids]);
    assert.equal(core.qEasyEligible(stage.clubs, stage.effective), false, qids.join(" / "));
  }
  for (const qids of [["Q1543", "Q9616"], ["Q1422", "Q7156"], ["Q50602", "Q41420"]]) {
    const [stage] = core.stagesFromQids([qids]);
    assert.ok(stage.ease >= core.constants.QBOUNDARIES.easy);
    assert.equal(core.qEasyEligible(stage.clubs, stage.effective), true);
    assert.ok(core.qFamiliarAnswers(stage.clubs, stage.effective).length >= 2);
  }
  const seregno = DB.byQid.get("Q1637277");
  assert.equal(core.qPools().any.includes(seregno), true, "lower-division history is not an eligibility veto");
});

test("a merely familiar single bridge cannot bypass the stronger solo easy requirement", () => {
  const { core } = runtime();
  const [stage] = core.stagesFromQids([["Q1543", "Q9616"]]);
  const pid = core.qFamiliarAnswers(stage.clubs, stage.effective)[0];
  assert.equal(core.qEasyEligible(stage.clubs, [pid]), false);
  assert.equal(core.qEasyEligible(stage.clubs, []), false);
});

test("unknown appearances cannot supply positive evidence for a familiar bridge", () => {
  const { DB, core, postings } = runtime();
  const [stage] = core.stagesFromQids([["Q1543", "Q9616"]]);
  const pid = core.qFamiliarAnswers(stage.clubs, stage.effective)[0];
  const ci = stage.clubs[0], index = postings(ci).indexOf(pid), apps = DB.apps[ci][index];
  try {
    DB.apps[ci][index] = -1;
    assert.equal(core.qFamiliarAnswers(stage.clubs, [pid]).length, 0);
  } finally {
    DB.apps[ci][index] = apps;
  }
});
