#!/usr/bin/env node
"use strict";

// Exhaustive pair eligibility, before random draws, repetition and slate guards.
const fs = require("node:fs");
const path = require("node:path");
const { loadRuntime } = require("./quiz-schedule.js");
const ROOT = path.resolve(__dirname, "..");
const LEVELS = ["easy", "medium", "hard", "impossible", "unclassified"];

function analyse(runtime) {
  const { core, index, postings, intersect } = runtime;
  const pools = Object.fromEntries(Object.entries(core.qPools()).map(([name, ids]) => [name, new Set(ids)]));
  const c = core.constants, ladders = [c.QEASY, c.QMEDIUM, c.QHARD, c.QIMPOSSIBLE];
  const result = { scope: "all core club pairs, normal ladders, before sampling and cooldowns",
    eligibilityVersion: c.QELIGIBILITY_VERSION, valid: 0,
    levels: Object.fromEntries(LEVELS.map(level => [level, { classified: 0, reachable: 0, examples: [] }])) };
  for (let a = 0; a < index.clubs.length; a++) for (let b = a + 1; b < index.clubs.length; b++) {
    const clubs = [a, b], effective = core.qEffective(clubs, intersect(clubs.map(postings)));
    if (!effective.some(core.qUsableName)) continue;
    result.valid++;
    const ease = core.qEase(clubs, effective), level = core.classifyStage({ clubs, effective, ease });
    const row = result.levels[level < 0 ? "unclassified" : LEVELS[level]];
    row.classified++;
    const familiar = level === 0 || level === 1 ? core.qFamiliarAnswers(clubs, effective).length : 0;
    const reachable = level >= 0 && ladders[level].some(tier => {
      const membership = (pools[tier.p[0]].has(a) && pools[tier.p[1]].has(b))
        || (pools[tier.p[0]].has(b) && pools[tier.p[1]].has(a));
      return membership && effective.length >= tier.size[0] && effective.length <= tier.size[1]
        && ease >= tier.ease[0] && ease < tier.ease[1] && (!tier.familiar || familiar >= tier.familiar)
        && (!tier.birth || index.births[core.qFace({ clubs, effective })]);
    });
    if (reachable) row.reachable++;
    else if (row.examples.length < 10) row.examples.push({ clubs: clubs.map(ci => index.clubs[ci][0]), ease, answers: effective.length });
  }
  result.unreachable = Object.values(result.levels).reduce((n, row) => n + row.classified - row.reachable, 0);
  return result;
}

function main(argv = process.argv.slice(2)) {
  const options = { index: path.join(ROOT, "site/data/index.json"), output: path.join(ROOT, "data/eligibility-change/catalogue.json") };
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--index", "--output", "--baseline"].includes(argv[i]) || !argv[i + 1]) throw new Error("usage: quiz-eligibility.js [--index FILE] [--output FILE] [--baseline FILE]");
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const after = analyse(loadRuntime(options.index));
  const report = options.baseline ? { baseline: JSON.parse(fs.readFileSync(options.baseline, "utf8")), after } : after;
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (after.unreachable) throw new Error(`${after.unreachable} valid pairs have no matching search tier`);
  return report;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { analyse, main };
