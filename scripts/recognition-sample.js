#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRuntime } = require("./quiz-schedule.js");
const { loadPlayerQids } = require("./recognition-audit.js");
const ROOT = path.resolve(__dirname, "..");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const band = score => score < 180 ? "under180" : score < 400 ? "180to399" : score < 550 ? "400to549" : "550plus";
const era = birth => birth < 1970 ? "before1970" : birth < 1990 ? "1970to1989" : "1990onward";

function buildSample(index, qids, { perCountryEra = 20, seed = "recognition-calibration-v1" } = {}) {
  // Release features do not change the frozen career evidence or review sample.
  index = { ...index };
  delete index.quizRecognition;
  if (!Number.isSafeInteger(perCountryEra) || perCountryEra < 1) throw new Error("perCountryEra must be a positive integer");
  if (!Array.isArray(qids) || qids.length !== index.names.length || new Set(qids).size !== qids.length
      || qids.some(qid => !/^Q[1-9]\d*$/.test(qid))) throw new Error("a unique QID is required for every player");
  const inputDigest = hash(JSON.stringify(index));
  const { core, index: DB, leagueCC, postings } = createRuntime(structuredClone(index), {
    recognition: null,
    stature: index._fixture?.clubStature ? ci => index._fixture.clubStature[ci] : undefined });
  core.qPools();
  const countries = [...new Set(DB.leagues.map(l => l[2]))].sort();
  const careers = Array.from({ length: DB.names.length }, () => []);
  DB.clubs.forEach((_, ci) => postings(ci).forEach((pid, i) => { if (DB.apps[ci][i] !== 0) careers[pid].push(ci); }));
  const choices = new Map();
  let unknownBirthExcluded = 0;
  careers.forEach((clubs, pid) => {
    if (clubs.length < 2 || !core.qUsableName(pid) || /^Q\d+$/.test(DB.names[pid])) return;
    const birth = DB.births[pid];
    if (!birth) { unknownBirthExcluded++; return; }
    const countryApps = new Map();
    for (const ci of clubs) {
      const cc = leagueCC(ci);
      if (countries.includes(cc)) countryApps.set(cc, (countryApps.get(cc) || 0) + Math.max(1, core.qApps(ci, pid)));
    }
    const country = [...countryApps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (!country) return;
    const pairs = [];
    for (let a = 0; a < clubs.length; a++) for (let b = a + 1; b < clubs.length; b++) {
      const cs = [clubs[a], clubs[b]];
      pairs.push({ clubs: cs.map(ci => DB.clubs[ci][3]), score: core.qBridgeFame(pid, cs),
        weakestApps: Math.min(...cs.map(ci => core.qApps(ci, pid))) });
    }
    pairs.sort((a, b) => b.score - a.score || a.clubs.join("/").localeCompare(b.clubs.join("/")));
    const probes = new Map();
    const add = p => probes.set([...p.clubs].sort().join("/"), p.clubs);
    add(pairs[0]);
    add([...pairs].sort((a, b) => a.weakestApps - b.weakestApps || b.score - a.score)[0]);
    add([...pairs].sort((a, b) => Math.min(...[180, 400, 550].map(t => Math.abs(a.score - t)))
      - Math.min(...[180, 400, 550].map(t => Math.abs(b.score - t))))[0]);
    const score = pairs[0].score;
    const row = { qid: qids[pid], name: DB.names[pid], birth, country, era: era(birth),
      role: DB.gkSet.has(pid) ? "goalkeeper" : "outfield", band: band(score), bestBridgeScore: score,
      probes: [...probes.values()], order: hash(`${seed}/${qids[pid]}`) };
    const identity = core.choiceIdentity(pid), previous = choices.get(identity);
    if (!previous || row.bestBridgeScore > previous.bestBridgeScore
        || (row.bestBridgeScore === previous.bestBridgeScore && row.qid < previous.qid)) choices.set(identity, row);
  });
  const population = [...choices.values()], players = [], shortages = [];
  for (const country of countries) for (const birthEra of ["before1970", "1970to1989", "1990onward"]) {
    const available = population.filter(p => p.country === country && p.era === birthEra).sort((a, b) => a.order.localeCompare(b.order));
    const selected = [];
    for (const scoreBand of ["under180", "180to399", "400to549", "550plus"]) {
      for (const role of ["goalkeeper", "outfield"]) {
        const target = role === "goalkeeper" ? Math.round(perCountryEra / 20) : Math.round(perCountryEra / 5);
        selected.push(...available.filter(p => p.band === scoreBand && p.role === role).slice(0, target));
      }
    }
    const unique = new Map(selected.map(p => [p.qid, p]));
    for (const row of available) { if (unique.size >= perCountryEra) break; unique.set(row.qid, row); }
    const rows = [...unique.values()].slice(0, perCountryEra).sort((a, b) => a.order.localeCompare(b.order));
    if (rows.length < perCountryEra) shortages.push({ country, era: birthEra, requested: perCountryEra, available: rows.length });
    rows.forEach((row, i) => players.push({ ...row, split: i % 10 >= 7 ? "holdout" : "calibration" }));
  }
  const summary = {};
  for (const dimension of ["country", "era", "role", "band", "split"])
    summary[dimension] = Object.fromEntries([...new Set(players.map(p => p[dimension]))].sort()
      .map(value => [value, players.filter(p => p[dimension] === value).length]));
  return { version: 1, kind: "recognition-calibration-sample", seed, datasetBuilt: index.built,
    inputDigest, eligibilityVersion: core.constants.QELIGIBILITY_VERSION,
    policy: { perCountryEra, country: "dominant covered career country by documented appearances, unknown totals count as one",
      era: "birth cohort, not inferred retirement", score: "strongest existing pair bridge score, before popularity",
      role: "target 20% goalkeepers; missing role/score cells filled within country and birth cohort",
      split: "70% calibration / 30% held out within each country and birth cohort",
      purpose: "balanced review sample, not an estimate of the player population", unknownBirthExcluded },
    eligiblePlayers: population.length, requested: countries.length * 3 * perCountryEra,
    summary, shortages, players: players.map(({ order, ...row }) => row) };
}

function main(argv = process.argv.slice(2)) {
  const opts = { index: path.join(ROOT, "site/data/index.json"), output: path.join(ROOT, "data/recognition-calibration/sample.json") };
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--index", "--output", "--seed"].includes(argv[i]) || !argv[i + 1]) throw new Error("usage: recognition-sample.js [--index FILE] [--output FILE] [--seed VALUE]");
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  const index = JSON.parse(fs.readFileSync(opts.index, "utf8"));
  const sample = buildSample(index, loadPlayerQids(index, path.dirname(opts.index)), opts);
  sample.indexFileDigest = hash(fs.readFileSync(opts.index));
  sample.quizCoreDigest = hash(fs.readFileSync(path.join(ROOT, "site/quiz-core.js")));
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, JSON.stringify(sample, null, 2) + "\n");
  const probes = [...new Map(sample.players.flatMap(p => p.probes).map(cs => [[...cs].sort().join("/"), cs])).values()];
  fs.writeFileSync(path.join(path.dirname(opts.output), "probes.json"), JSON.stringify(probes, null, 2) + "\n");
  console.log(JSON.stringify({ players: sample.players.length, probes: probes.length, summary: sample.summary, shortages: sample.shortages, output: opts.output }, null, 2));
  return sample;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { buildSample, main };
