#!/usr/bin/env node
"use strict";

// Fetch likely quiz answers before continuing the ordinary QID backfill.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRuntime } = require("./quiz-schedule.js");
const { loadPlayerQids } = require("./recognition-audit.js");
const { DEFAULT_CONFIG } = require("../site/quiz-recognition.js");
const ROOT = path.resolve(__dirname, "..");

function priorities(index, playerQids, schedule) {
  const { core } = createRuntime(structuredClone(index));
  const selected = new Set();
  const plausible = Math.max(0, core.constants.QFAMILIAR_MIN_FAME
    - (index.quizRecognition?.config.maxBoost ?? DEFAULT_CONFIG.maxBoost));
  for (const [date, entry] of Object.entries(schedule?.days || {})) {
    if (date < index.built) continue;
    for (const qids of entry) {
      const stage = core.stagesFromQids([qids])?.[0];
      if (!stage) continue;
      const strongest = [...stage.effective].sort((a, b) => core.qDifficultyFame(b, stage.clubs) - core.qDifficultyFame(a, stage.clubs) || a - b);
      for (const pid of [...core.uniqueChoices(strongest).slice(0, 3), ...core.qRanked(stage).slice(0, 3)])
        selected.add(playerQids[pid]);
      // Lower-ranked routes can become familiar after their first observation.
      // Include them within the existing source budget rather than repeatedly
      // collecting only answers already favoured by the career prior.
      for (const pid of strongest)
        if (core.qUsableName(pid) && core.qDifficultyFame(pid, stage.clubs) >= plausible)
          selected.add(playerQids[pid]);
    }
  }
  return [...selected];
}

function main(argv) {
  let output = path.join(ROOT, "data/popularity/priority.json");
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== "--output") throw Error("usage: recognition-priority.js [--output FILE]");
    output = path.resolve(argv[1]);
  }
  const directory = path.join(ROOT, "site/data"), input = fs.readFileSync(path.join(directory, "index.json"));
  const index = JSON.parse(input), file = path.join(directory, "quiz-schedule.json");
  const qids = priorities(index, loadPlayerQids(index, directory), fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ version: 1, kind: "quiz-recognition-priority",
    indexFileDigest: crypto.createHash("sha256").update(input).digest("hex"), qids }));
  console.log(`recognition: prioritised ${qids.length} likely answers from the published quiz horizon`);
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { priorities };
