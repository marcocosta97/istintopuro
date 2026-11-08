#!/usr/bin/env node
"use strict";

// Compile cached source observations once per release; no network access.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFAULT_CONFIG, DEFAULT_CLUB_CONFIG, validate } = require("../site/quiz-recognition.js");
const { createModel, observation, configuration } = require("./recognition-model.js");
const { createClubContext } = require("./club-recognition.js");
const { loadPlayerQids } = require("./recognition-audit.js");
const ROOT = path.resolve(__dirname, "..");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const expiry = row => Math.min(Date.parse(row.language_coverage.fetched_at), Date.parse(row.pageviews.fetched_at))
  + DEFAULT_CONFIG.maxAgeDays * 864e5;

function compile(index, playerQids, { previous, snapshots = [], clubSnapshot, asOf = new Date().toISOString() } = {}) {
  const time = Date.parse(asOf);
  if (!Number.isFinite(time) || playerQids.length !== index.names.length
      || new Set(playerQids).size !== playerQids.length || playerQids.some(q => !/^Q[1-9]\d*$/.test(q)))
    throw new Error("compilation requires a fixed time and unique career QIDs");
  if (previous) {
    validate(previous, Infinity);
    if (Date.parse(previous.asOf) > time) throw new Error("cannot compile before the previous release time");
  }
  const bundle = { v: 1, kind: "quiz-recognition", asOf: new Date(time).toISOString(),
    config: DEFAULT_CONFIG, clubConfig: DEFAULT_CLUB_CONFIG, players: {}, clubs: {},
    sources: previous?.sources || {} };
  const byQid = new Map(playerQids.map((qid, pid) => [qid, pid]));
  for (const [qid, row] of Object.entries(previous?.players || {}))
    if (byQid.has(qid) && row[4] > time) bundle.players[qid] = [byQid.get(qid), ...row.slice(1)];
  const clubs = new Set(index.clubs.map(c => c[3]));
  for (const [qid, row] of Object.entries(previous?.clubs || {}))
    if (clubs.has(qid) && row[2] > time) bundle.clubs[qid] = row;
  const provenance = snapshot => ({ generatedAt: snapshot.generated_at, digest: digest(JSON.stringify(snapshot)) });
  if (snapshots.length) bundle.sources = { ...bundle.sources, players: snapshots.map(provenance) };
  for (const snapshot of snapshots) {
    const model = createModel(snapshot, playerQids, { asOf });
    model.features.forEach((f, pid) => {
      const qid = playerQids[pid];
      if (!f.eligible) return;
      const until = expiry(snapshot.players[qid]);
      if (!bundle.players[qid] || until >= bundle.players[qid][4])
        bundle.players[qid] = [pid, f.score, f.bonusSupport, f.downwardSupport, until];
    });
  }
  if (clubSnapshot) {
    createClubContext(index, clubSnapshot, { asOf }); // Validate the source envelope.
    const config = configuration({ viewsCap: DEFAULT_CLUB_CONFIG.viewsCap });
    for (const qid of clubs) {
      const row = clubSnapshot.clubs[qid], feature = observation(row, config, time);
      if (!feature.eligible) continue;
      const until = expiry(row);
      if (!bundle.clubs[qid] || until >= bundle.clubs[qid][2])
        bundle.clubs[qid] = [feature.viewsScore, feature.languageScore, until];
    }
    bundle.sources = { ...bundle.sources, clubs: provenance(clubSnapshot) };
  }
  validate(bundle, index.names.length);
  return bundle;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

function main(argv) {
  const options = { index: path.join(ROOT, "site/data/index.json"), players: [],
    clubs: path.join(ROOT, "data/club-recognition/snapshot.json") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--check") options.check = true;
    else if (flag === "--reset-cache") options.resetCache = true;
    else if (["--index", "--players", "--clubs", "--as-of"].includes(flag) && argv[i + 1]) {
      const value = argv[++i];
      if (flag === "--players") options.players.push(value);
      else options[flag === "--as-of" ? "asOf" : flag.slice(2)] = value;
    } else throw new Error(`unknown or incomplete option: ${flag}`);
  }
  const index = read(options.index), directory = path.dirname(options.index);
  const cache = path.join(directory, "quiz-recognition.json");
  if (options.check) {
    if (!index.quizRecognition) throw new Error("recognition is not enabled in the published index");
    validate(index.quizRecognition, index.names.length);
    if (JSON.stringify(read(cache)) !== JSON.stringify(index.quizRecognition)) throw new Error("recognition cache and index disagree");
    const qids = loadPlayerQids(index, directory);
    for (const [qid, [pid]] of Object.entries(index.quizRecognition.players))
      if (qids[pid] !== qid) throw new Error(`recognition points to a different player: ${qid}`);
    console.log(`quiz recognition: OK (${Object.keys(index.quizRecognition.players).length} players, ${Object.keys(index.quizRecognition.clubs).length} clubs; frozen ${index.quizRecognition.asOf})`);
    return;
  }
  const inputs = options.players.length ? options.players
    : [path.join(directory, "recognition.json"), path.join(ROOT, "data/popularity/snapshot.json")];
  const bundle = compile(index, loadPlayerQids(index, directory), {
    previous: options.resetCache ? undefined : fs.existsSync(cache) ? read(cache) : index.quizRecognition,
    snapshots: inputs.filter(fs.existsSync).map(read),
    clubSnapshot: fs.existsSync(options.clubs) ? read(options.clubs) : undefined,
    asOf: options.asOf,
  });
  index.quizRecognition = bundle;
  write(cache, bundle);
  write(options.index, index);
  console.log(`quiz recognition: compiled ${Object.keys(bundle.players).length} players and ${Object.keys(bundle.clubs).length} clubs without source requests`);
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { compile };
