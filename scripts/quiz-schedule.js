#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INDEX = path.join(ROOT, "site/data/index.json");
const DEFAULT_OUTPUT = path.join(ROOT, "site/data/quiz-schedule.json");
const CORE_PATH = path.join(ROOT, "site/quiz-core.js");
const VERSION = 1;
const EPOCH = "2026-08-21";
const HORIZON_DAYS = 14;
const AUDIT_DAYS = 730;
const COMBO_GUARD_DAYS = 30;
const TRIPLE_RATE_MIN = 0.4;
const TRIPLE_RATE_MAX = 0.6;
const IMPOSSIBLE_ITALY_MAX = 0.404;
const IMPOSSIBLE_ENGLAND_MIN = 0.044;
const ALL_SLOT_COUNTRY_MAX_RATIO = 1.5;
const MIN_GOALKEEPER_FACES = 60;
// Pinned from the pre-static generator over the same 730 dates on build 2026-08-17.
const BASELINE_MAX_IMPOSSIBLE_CLUB = 16;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(date) {
  if (!ISO_DATE.test(date || "")) return false;
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === date;
}

function shiftDate(date, days) {
  if (!isIsoDate(date)) throw new Error(`invalid ISO date: ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function dateRange(start, through) {
  if (!isIsoDate(start) || !isIsoDate(through) || through < start) {
    throw new Error(`invalid date range: ${start} through ${through}`);
  }
  const dates = [];
  for (let date = start; date <= through; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

function intersect(lists) {
  const ordered = [...lists].sort((a, b) => a.length - b.length);
  let acc = [...ordered[0]];
  for (let k = 1; k < ordered.length && acc.length; k++) {
    const list = ordered[k], keep = [];
    let j = 0;
    for (const value of acc) {
      while (j < list.length && list[j] < value) j++;
      if (j < list.length && list[j] === value) keep.push(value);
    }
    acc = keep;
  }
  return acc;
}

function createRuntime(index) {
  const coreModule = require(CORE_PATH);
  if (typeof coreModule.createQuizCore !== "function") {
    throw new Error("site/quiz-core.js does not export createQuizCore");
  }
  const marqueeQids = coreModule.MARQUEE_QIDS || coreModule.constants?.MARQUEE_QIDS;
  if (!marqueeQids) throw new Error("quiz core does not export MARQUEE_QIDS");
  const marquee = new Set(marqueeQids);
  const decoded = new Map();
  const postings = (ci) => {
    let result = decoded.get(ci);
    if (result) return result;
    let total = 0;
    result = Int32Array.from(index.postings[ci], delta => total += delta);
    decoded.set(ci, result);
    return result;
  };
  const leagueCC = (ci) => {
    const club = index.clubs[ci];
    return club[5] >= 0 ? index.leagues[club[5]][2] : club[1];
  };
  let statures;
  const stature = (ci) => {
    if (!statures) {
      const byCountry = {};
      index.clubs.forEach((club, i) => {
        if (index.postings[i].length >= 120) (byCountry[leagueCC(i)] ??= []).push(i);
      });
      statures = new Map();
      for (const clubs of Object.values(byCountry)) {
        clubs.sort((a, b) => index.postings[a].length - index.postings[b].length);
        clubs.forEach((club, i) => {
          const percentile = clubs.length > 1 ? i / (clubs.length - 1) : 1;
          statures.set(club, marquee.has(index.clubs[club][3]) ? 1.15
            : percentile >= 0.6 ? 1 : percentile >= 0.3 ? 0.82 : 0.66);
        });
      }
    }
    return statures.get(ci) ?? 0.66;
  };
  const byQid = new Map(index.clubs.map((club, i) => [club[3], i]));
  const core = coreModule.createQuizCore({
    DB: index, postings, intersect, stature, marquee, leagueCC,
    coreClub: name => name,
  });
  return { index, core, postings, intersect, leagueCC, byQid };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadRuntime(indexPath = DEFAULT_INDEX) {
  return createRuntime(readJson(indexPath));
}

function canonicalCombo(stage) {
  return [...stage].sort().join(",");
}

function inspectEntry(runtime, entry, { date, previousDays = [], strict = true } = {}) {
  const errors = [], stages = [];
  if (!Array.isArray(entry) || entry.length !== 4) {
    return { ok: false, errors: ["entry must contain exactly four stages"], stages };
  }
  const used = new Set();
  entry.forEach((qids, stageIndex) => {
    if (!Array.isArray(qids) || qids.length < 2 || qids.length > 3) {
      errors.push(`stage ${stageIndex + 1}: expected two or three club QIDs`);
      return;
    }
    const clubs = [];
    for (const qid of qids) {
      const ci = runtime.byQid.get(qid);
      if (ci === undefined) errors.push(`stage ${stageIndex + 1}: unknown club ${qid}`);
      else clubs.push(ci);
      if (used.has(qid)) errors.push(`stage ${stageIndex + 1}: club ${qid} repeats within the day`);
      used.add(qid);
    }
    if (new Set(qids).size !== qids.length) {
      errors.push(`stage ${stageIndex + 1}: duplicate club within stage`);
    }
    if (clubs.length !== qids.length) return;
    const answers = runtime.intersect(clubs.map(runtime.postings));
    const effective = runtime.core.qEffective(clubs, answers);
    if (!effective.length) errors.push(`stage ${stageIndex + 1}: no effective answer`);
    stages.push({ clubs, answers, effective, ease: runtime.core.qEase(clubs, effective) });
  });
  if (strict && stages.length === 4) {
    for (let i = 1; i < stages.length; i++) {
      if (!(stages[i - 1].ease > stages[i].ease)) {
        errors.push(`ease is not strictly descending at stages ${i}/${i + 1}`);
      }
    }
    const recentCombos = new Set();
    const recentClubs = new Set();
    previousDays.slice(-COMBO_GUARD_DAYS).forEach((day, offset, all) => {
      const dayStages = day.stages || day;
      if (!Array.isArray(dayStages)) return;
      dayStages.forEach(stage => recentCombos.add(canonicalCombo(stage.clubs || stage)));
      if (offset >= all.length - 2) {
        dayStages.forEach(stage => (stage.clubs || stage).forEach(club => recentClubs.add(club)));
      }
    });
    entry.forEach((stage, i) => {
      if (recentCombos.has(canonicalCombo(stage)))
        errors.push(`stage ${i + 1}: combination repeated within ${COMBO_GUARD_DAYS} days`);
      stage.forEach(qid => {
        if (recentClubs.has(qid)) errors.push(`stage ${i + 1}: club ${qid} repeated within 2 days`);
      });
    });
    if (date) {
      const coreCheck = runtime.core.validateEntry(entry, { date, previousDays });
      coreCheck.errors.forEach(error => {
        if (!errors.includes(error)) errors.push(error);
      });
    }
  }
  return { ok: errors.length === 0, errors, stages };
}

function previousContext(days, date) {
  const dates = Object.keys(days).filter(d => d < date).sort().slice(-COMBO_GUARD_DAYS);
  return dates.map(d => ({ date: d, stages: days[d] }));
}

function validateAsset(runtime, asset, { expectedBuilt, expectedThrough } = {}) {
  const errors = [];
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return { ok: false, errors: ["asset must be an object"] };
  if (asset.v !== VERSION) errors.push(`v must be ${VERSION}`);
  if (!isIsoDate(asset.built)) errors.push("built must be an ISO date");
  if (!isIsoDate(asset.through)) errors.push("through must be an ISO date");
  if (isIsoDate(asset.through) && asset.through < EPOCH) errors.push(`through must be on or after ${EPOCH}`);
  if (isIsoDate(asset.built) && isIsoDate(asset.through) && asset.through < asset.built) errors.push("through precedes built");
  if (asset.lockedThrough !== undefined && (!isIsoDate(asset.lockedThrough)
      || (isIsoDate(asset.built) && asset.lockedThrough < asset.built)))
    errors.push("lockedThrough must be an ISO date on or after built");
  if (expectedBuilt && asset.built !== expectedBuilt) errors.push(`built ${asset.built} != index ${expectedBuilt}`);
  if (expectedThrough && asset.through !== expectedThrough) errors.push(`through ${asset.through} != expected ${expectedThrough}`);
  if (!asset.days || typeof asset.days !== "object" || Array.isArray(asset.days)) {
    errors.push("days must be an object");
    return { ok: false, errors };
  }
  if (isIsoDate(asset.through) && asset.through >= EPOCH) {
    const expectedDates = dateRange(EPOCH, asset.through);
    const actualDates = Object.keys(asset.days).sort();
    if (JSON.stringify(actualDates) !== JSON.stringify(expectedDates)) errors.push("days must cover epoch through `through` with no gaps or extras");
    const accepted = {};
    for (const date of expectedDates) {
      if (!Object.hasOwn(asset.days, date)) continue;
      // Published history is immutable across data refreshes as long as its clubs
      // still resolve and every stage remains playable. Difficulty can move when
      // appearances change, so only newly generated/future days enforce ordering
      // and the repetition guard against the preserved tail.
      const validationThrough = asset.lockedThrough || asset.built;
      const result = inspectEntry(runtime, asset.days[date], {
        date, previousDays: previousContext(accepted, date), strict: date > validationThrough,
      });
      if (!result.ok) errors.push(`${date}: ${result.errors.join("; ")}`);
      accepted[date] = asset.days[date];
    }
  }
  return { ok: errors.length === 0, errors };
}

function generatedDiagnostics(core, slate) {
  return slate.stages.map(stage => core.stageDiagnostics(stage));
}

function generateEntry(runtime, date, previousDays) {
  const slate = runtime.core.generateSlate(date, { previousDays });
  if (!slate || !Array.isArray(slate.stages)) throw new Error(`${date}: generator returned no stages`);
  const diagnostics = generatedDiagnostics(runtime.core, slate);
  diagnostics.forEach((diag, i) => {
    if (diag.fallback) throw new Error(`${date}: stage ${i + 1} used fallback`);
  });
  const entry = runtime.core.serializeStages(slate.stages);
  const checked = inspectEntry(runtime, entry, { date, previousDays, strict: true });
  if (!checked.ok) throw new Error(`${date}: generated invalid slate: ${checked.errors.join("; ")}`);
  return { entry, slate, diagnostics };
}

function buildSchedule(runtime, existing, { through = shiftDate(runtime.index.built, HORIZON_DAYS), warn = console.warn } = {}) {
  const built = runtime.index.built;
  if (!isIsoDate(built)) throw new Error(`index has invalid built date: ${built}`);
  if (through < built) throw new Error(`schedule horizon ${through} precedes build ${built}`);
  const oldDays = existing?.v === VERSION && existing.days && typeof existing.days === "object" ? existing.days : {};
  const lockedThrough = isIsoDate(existing?.lockedThrough) && existing.lockedThrough > built
    ? existing.lockedThrough : built;
  const days = {};
  for (const date of dateRange(EPOCH, through)) {
    const previousDays = previousContext(days, date);
    const old = date <= lockedThrough ? oldDays[date] : undefined;
    if (old) {
      const preserved = inspectEntry(runtime, old, { strict: false });
      if (preserved.ok) {
        days[date] = old;
        continue;
      }
      warn(`WARNING: regenerating invalid preserved quiz ${date}: ${preserved.errors.join("; ")}`);
    }
    days[date] = generateEntry(runtime, date, previousDays).entry;
  }
  const asset = { v: VERSION, built, lockedThrough, through, days };
  const checked = validateAsset(runtime, asset, { expectedBuilt: built, expectedThrough: through });
  if (!checked.ok) throw new Error(`generated schedule failed validation:\n  ${checked.errors.join("\n  ")}`);
  return asset;
}

function auditSchedule(runtime, { start = EPOCH, days = AUDIT_DAYS, enforce = true } = {}) {
  const history = {}, countries = new Map(), impossibleClubs = new Map();
  const triples = [0, 0, 0, 0];
  const easeByStage = Array.from({ length: 4 }, () => []);
  const answerCountsByStage = Array.from({ length: 4 }, () => []);
  const breadthByStage = Array.from({ length: 4 }, () => []);
  const countriesByStage = Array.from({ length: 4 }, () => new Map());
  const clubCountriesByStage = Array.from({ length: 4 }, () => new Map());
  const allClubCountries = new Map(), faceLastSeen = new Map(), clubLastSeen = new Map();
  const goalkeeperFaces = [0, 0, 0, 0];
  let softClubRepeats = 0;
  for (let offset = 0; offset < days; offset++) {
    const date = shiftDate(start, offset);
    const previousDays = previousContext(history, date);
    const first = generateEntry(runtime, date, previousDays);
    const second = generateEntry(runtime, date, previousDays);
    if (JSON.stringify(first.entry) !== JSON.stringify(second.entry)) throw new Error(`${date}: generation is not deterministic`);
    history[date] = first.entry;
    first.diagnostics.forEach((diag, stageIndex) => {
      if (first.entry[stageIndex].length === 3) triples[stageIndex]++;
      easeByStage[stageIndex].push(diag.ease);
      answerCountsByStage[stageIndex].push(diag.effectiveCount);
      breadthByStage[stageIndex].push(diag.recognisableBreadth);
      const stageCountry = diag.country || runtime.leagueCC(runtime.byQid.get(first.entry[stageIndex][0]));
      const stageCountries = countriesByStage[stageIndex];
      stageCountries.set(stageCountry, (stageCountries.get(stageCountry) || 0) + 1);
      const clubCountries = clubCountriesByStage[stageIndex];
      (diag.countries || first.entry[stageIndex].map(qid => runtime.leagueCC(runtime.byQid.get(qid))))
        .forEach(country => {
          clubCountries.set(country, (clubCountries.get(country) || 0) + 1);
          allClubCountries.set(country, (allClubCountries.get(country) || 0) + 1);
        });
      first.entry[stageIndex].forEach(qid => {
        const lastSeen = clubLastSeen.get(qid);
        if (lastSeen !== undefined && offset - lastSeen <= runtime.core.constants.QCLUB_SOFT_DAYS)
          softClubRepeats++;
        clubLastSeen.set(qid, offset);
      });
      const effective = diag.effectiveAnswers || diag.effective || [];
      if (diag.face === undefined || diag.face === null || !effective.includes(diag.face)) {
        throw new Error(`${date}: stage ${stageIndex + 1} face is not an effective answer`);
      }
      if (!runtime.core.qUsableName(diag.face))
        throw new Error(`${date}: stage ${stageIndex + 1} face has an unusable player name`);
      const lastSeen = faceLastSeen.get(diag.face);
      if (lastSeen !== undefined && offset - lastSeen <= runtime.core.constants.QFACE_GUARD_DAYS)
        throw new Error(`${date}: stage ${stageIndex + 1} face repeats after ${offset - lastSeen} days`);
      faceLastSeen.set(diag.face, offset);
      if (runtime.index.gkSet.has(diag.face)) goalkeeperFaces[stageIndex]++;
    });
    const impossible = first.entry[3];
    const impossibleDiag = first.diagnostics[3];
    const country = impossibleDiag.country || runtime.leagueCC(runtime.byQid.get(impossible[0]));
    countries.set(country, (countries.get(country) || 0) + 1);
    impossible.forEach(qid => impossibleClubs.set(qid, (impossibleClubs.get(qid) || 0) + 1));
  }
  const errors = [];
  for (const stageIndex of [2, 3]) {
    const rate = triples[stageIndex] / days;
    if (rate < TRIPLE_RATE_MIN || rate > TRIPLE_RATE_MAX) errors.push(`stage ${stageIndex + 1} triple rate ${(rate * 100).toFixed(1)}% is outside 40–60%`);
  }
  const italyRate = (countries.get("IT") || 0) / days;
  const englandRate = (countries.get("GB") || 0) / days;
  if (italyRate >= IMPOSSIBLE_ITALY_MAX) errors.push(`impossible Italy share ${(italyRate * 100).toFixed(1)}% is not below 40.4%`);
  if (englandRate <= IMPOSSIBLE_ENGLAND_MIN) errors.push(`impossible England share ${(englandRate * 100).toFixed(1)}% is not above 4.4%`);
  const slotCountryCounts = [...allClubCountries.values()];
  const slotCountryRatio = Math.max(...slotCountryCounts) / Math.min(...slotCountryCounts);
  if (slotCountryRatio >= ALL_SLOT_COUNTRY_MAX_RATIO)
    errors.push(`all-slot country max/min ratio ${slotCountryRatio.toFixed(2)} is not below ${ALL_SLOT_COUNTRY_MAX_RATIO}`);
  const goalkeeperFaceCount = goalkeeperFaces.reduce((sum, count) => sum + count, 0);
  if (goalkeeperFaceCount < MIN_GOALKEEPER_FACES)
    errors.push(`only ${goalkeeperFaceCount} goalkeeper representatives (minimum ${MIN_GOALKEEPER_FACES})`);
  const [mostUsedQid, mostUsedCount] = [...impossibleClubs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || ["", 0];
  if (mostUsedCount >= 2 * BASELINE_MAX_IMPOSSIBLE_CLUB) {
    errors.push(`most-used impossible club ${mostUsedQid} appears ${mostUsedCount} times (baseline ${BASELINE_MAX_IMPOSSIBLE_CLUB}, must be <2x)`);
  }
  const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
  };
  const result = {
    days, triples,
    countries: Object.fromEntries([...countries].sort()),
    allClubCountries: Object.fromEntries([...allClubCountries].sort()),
    allSlotCountryRatio: slotCountryRatio,
    goalkeeperFaces: goalkeeperFaceCount,
    softClubRepeats,
    mostUsedImpossibleClub: { qid: mostUsedQid, count: mostUsedCount },
    stages: easeByStage.map((ease, i) => ({
      ease: { min: Math.min(...ease), p50: percentile(ease, 0.5), p95: percentile(ease, 0.95), max: Math.max(...ease) },
      answers: { min: Math.min(...answerCountsByStage[i]), p50: percentile(answerCountsByStage[i], 0.5),
        p95: percentile(answerCountsByStage[i], 0.95), max: Math.max(...answerCountsByStage[i]) },
      recognisableBreadth: { min: Math.min(...breadthByStage[i]), p50: percentile(breadthByStage[i], 0.5),
        p95: percentile(breadthByStage[i], 0.95), max: Math.max(...breadthByStage[i]) },
      goalkeeperFaces: goalkeeperFaces[i],
      countries: Object.fromEntries([...countriesByStage[i]].sort()),
      clubCountries: Object.fromEntries([...clubCountriesByStage[i]].sort()),
    })),
  };
  if (errors.length && enforce) throw new Error(`730-day quiz audit failed:\n  ${errors.join("\n  ")}`);
  return { ...result, errors };
}

function writeAsset(file, asset) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(asset)}\n`);
  fs.renameSync(temporary, file);
}

function parseArgs(argv) {
  const options = { index: DEFAULT_INDEX, output: DEFAULT_OUTPUT, check: false, audit: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--index") options.index = path.resolve(argv[++i]);
    else if (arg === "--output") options.output = path.resolve(argv[++i]);
    else if (arg === "--check") options.check = true;
    else if (arg === "--audit") options.audit = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const runtime = loadRuntime(options.index);
  const expectedThrough = shiftDate(runtime.index.built, HORIZON_DAYS);
  if (options.check) {
    const checked = validateAsset(runtime, readJson(options.output), {
      expectedBuilt: runtime.index.built, expectedThrough,
    });
    if (!checked.ok) throw new Error(`quiz schedule validation failed:\n  ${checked.errors.join("\n  ")}`);
    console.log(`quiz schedule: OK (${Object.keys(readJson(options.output).days).length} days)`);
  } else {
    const existing = fs.existsSync(options.output) ? readJson(options.output) : null;
    const asset = buildSchedule(runtime, existing);
    writeAsset(options.output, asset);
    console.log(`quiz schedule: wrote ${Object.keys(asset.days).length} days through ${asset.through}`);
  }
  if (options.audit) {
    const result = auditSchedule(runtime);
    console.log(`quiz audit: OK (${result.days} days; hard triples ${result.triples[2]}, impossible triples ${result.triples[3]}; `
      + `all-slot country ratio ${result.allSlotCountryRatio.toFixed(2)}; GK faces ${result.goalkeeperFaces}; `
      + `soft club repeats ${result.softClubRepeats}; max impossible club ${result.mostUsedImpossibleClub.qid} ${result.mostUsedImpossibleClub.count})`);
    result.stages.forEach((stage, i) => console.log(`  stage ${i + 1}: ease min ${stage.ease.min.toFixed(1)}, p50 ${stage.ease.p50.toFixed(1)}, `
      + `p95 ${stage.ease.p95.toFixed(1)}, max ${stage.ease.max.toFixed(1)}; answers p50 ${stage.answers.p50}, p95 ${stage.answers.p95}; `
      + `breadth p50 ${stage.recognisableBreadth.p50.toFixed(1)}; GK faces ${stage.goalkeeperFaces}; `
      + `club countries ${JSON.stringify(stage.clubCountries)}`));
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = {
  ALL_SLOT_COUNTRY_MAX_RATIO, AUDIT_DAYS, BASELINE_MAX_IMPOSSIBLE_CLUB, COMBO_GUARD_DAYS,
  EPOCH, HORIZON_DAYS, MIN_GOALKEEPER_FACES, VERSION,
  auditSchedule, buildSchedule, createRuntime, inspectEntry, loadRuntime,
  shiftDate, validateAsset,
};
