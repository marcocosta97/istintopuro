#!/usr/bin/env node
"use strict";

// Read-only comparison of experimental recognition rules. Never writes a schedule.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRuntime, auditSchedule, AUDIT_DAYS } = require("./quiz-schedule.js");
const { PROBES } = require("./refresh-report.js");
const { createModel } = require("./recognition-model.js");
const { createClubContext } = require("./club-recognition.js");
const ROOT = path.resolve(__dirname, "..");
const LEVELS = ["easy", "medium", "hard", "impossible", "unclassified"];
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function loadPlayerQids(index, directory) {
  const qids = Array(index.names.length).fill(null);
  if (!Number.isInteger(index.nshards) || index.nshards <= 0) throw new Error("index has no valid career shard count");
  for (let shard = 0; shard < index.nshards; shard++) {
    const rows = JSON.parse(fs.readFileSync(path.join(directory, "career", `${shard}.json`), "utf8"));
    for (const [key, row] of Object.entries(rows)) {
      const pid = Number(key);
      if (!Number.isInteger(pid) || pid < 0 || pid >= qids.length || qids[pid] !== null
          || !Number.isSafeInteger(row?.[0]) || row[0] <= 0 || pid % index.nshards !== shard)
        throw new Error(`invalid player mapping in career shard ${shard}`);
      qids[pid] = `Q${row[0]}`;
    }
  }
  if (qids.some(qid => qid === null)) throw new Error("career shards are missing player QIDs");
  return qids;
}

function candidateClubs(index) {
  const clubs = Array.from({ length: index.names.length }, () => []);
  index.postings.forEach((deltas, ci) => {
    let pid = 0;
    deltas.forEach((delta, i) => { pid += delta; if (index.apps[ci][i] !== 0) clubs[pid].push(ci); });
  });
  return clubs;
}

function selectIntersections(index, model, clubs, { probes, schedule, maxIntersections }) {
  const selected = new Map(), affected = new Map();
  const add = (rows, into, source) => {
    for (const qids of rows) {
      if (!Array.isArray(qids) || qids.length < 2 || qids.length > 3 || new Set(qids).size !== qids.length)
        throw new Error("intersection probes must contain two or three distinct club QIDs");
      const key = [...qids].sort().join("/");
      if (!into.has(key)) into.set(key, { qids, source });
    }
  };
  add(probes, selected, "fixed probe");
  if (schedule) for (const entry of Object.values(schedule.days || {})) add(entry, selected, "published intersection");
  model.features.forEach((feature, pid) => {
    if (!feature.observed) return;
    const rows = clubs[pid];
    for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++)
      add([[index.clubs[rows[a]][3], index.clubs[rows[b]][3]]], affected, "observed player pair");
  });
  // A stable hash sample avoids systematically favouring low QIDs or early clubs.
  const ordered = [...affected].filter(([key]) => !selected.has(key))
    .sort(([a], [b]) => digest(a).localeCompare(digest(b)));
  const fixedCount = selected.size;
  for (const [key, row] of ordered.slice(0, Math.max(0, maxIntersections - fixedCount))) selected.set(key, row);
  return { rows: [...selected.values()], fixedCount, possibleAffectedPairs: ordered.length,
    truncated: ordered.length > Math.max(0, maxIntersections - fixedCount) };
}

function stageSummary(runtime, qids) {
  const [stage] = runtime.core.stagesFromQids([qids]) || [];
  if (!stage) return null;
  const { core, index } = runtime;
  const strongest = stage.effective.filter(core.qUsableName).sort((a, b) =>
    core.qDifficultyFame(b, stage.clubs) - core.qDifficultyFame(a, stage.clubs))[0];
  return { stage, summary: {
    ease: core.qEase(stage.clubs, stage.effective),
    breadth: core.qRecognisableBreadth(stage.clubs, stage.effective),
    familiar: core.qFamiliarAnswers(stage.clubs, stage.effective).length,
    level: LEVELS[core.classifyStage(stage)] || "unclassified",
    effectiveRecords: stage.effective.length,
    selectableChoices: core.uniqueChoices(stage.effective).length,
    representative: index.names[core.qFace(stage)], representativePid: core.qFace(stage),
    strongestAnswer: index.names[strongest], strongestPid: strongest,
    strongestBridge: core.qDifficultyFame(strongest, stage.clubs),
  } };
}

function impactSummary(intersections) {
  const changed = intersections.filter(row => row.candidate.level !== row.choiceControl.level);
  const validChange = row => LEVELS.indexOf(row.candidate.level) < 4 && LEVELS.indexOf(row.choiceControl.level) < 4;
  return { scoreChanges: intersections.filter(row => row.popularityDelta !== 0).length,
    scoreIncreases: intersections.filter(row => row.popularityDelta > 0).length,
    scoreDecreases: intersections.filter(row => row.popularityDelta < 0).length,
    scoreUnchanged: intersections.filter(row => row.popularityDelta === 0).length,
    identityChanges: intersections.filter(row => row.identityDelta !== 0).length,
    classificationChanges: changed.length,
    harderClassifications: changed.filter(row => validChange(row)
      && LEVELS.indexOf(row.candidate.level) > LEVELS.indexOf(row.choiceControl.level)).length,
    easierClassifications: changed.filter(row => validChange(row)
      && LEVELS.indexOf(row.candidate.level) < LEVELS.indexOf(row.choiceControl.level)).length,
    lostEligibility: changed.filter(row => row.candidate.level === "unclassified").length,
    gainedEligibility: changed.filter(row => row.choiceControl.level === "unclassified").length };
}

function buildReport({ index, snapshot, playerQids, asOf, config, clubSnapshot, clubConfig, probes = PROBES,
  schedule = null, maxIntersections = 2000, auditDays = 0 }) {
  if (typeof index.built !== "string" || !/^\d{4}-\d\d-\d\d$/.test(index.built)
      || !Number.isFinite(Date.parse(index.built))) throw new Error("a fixed dataset build date is required");
  if (!Array.isArray(playerQids) || playerQids.length !== index.names.length
      || playerQids.some(qid => typeof qid !== "string" || !/^Q[1-9]\d*$/.test(qid)))
    throw new Error("a QID mapping is required for every player; names are not join keys");
  asOf ||= [snapshot.generated_at, clubSnapshot?.generated_at].filter(Boolean)
    .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  const model = createModel(snapshot, playerQids, { asOf, config });
  const clubContext = clubSnapshot ? createClubContext(index, clubSnapshot, { asOf, config: clubConfig }) : null;
  const runtime = (recognition = null) => createRuntime(structuredClone(index), { recognition,
    stature: index._fixture?.clubStature ? ci => index._fixture.clubStature[ci] : undefined });
  const runtimes = { baseline: runtime(), choiceControl: runtime({ distinctChoices: true }),
    candidate: runtime(clubContext ? clubContext.wrap(model.adapter) : model.adapter) };
  for (const rt of Object.values(runtimes)) rt.core.qPools();
  const clubs = candidateClubs(index), eligiblePids = clubs.flatMap((cs, pid) => cs.length >= 2 ? [pid] : []);
  const coverage = { candidates: eligiblePids.length, observed: 0, usable: 0, strongAnchors: 0,
    sourceSnapshotRows: Object.keys(snapshot.players).length };
  const players = [];
  for (const pid of eligiblePids) {
    const feature = model.features[pid];
    if (feature.observed) coverage.observed++;
    if (feature.eligible) coverage.usable++;
    if (feature.anchor) coverage.strongAnchors++;
    if (!feature.observed) continue;
    const baselineCareerPrior = runtimes.baseline.core.qFame(pid, []);
    const candidateCareerPrior = model.adjustedBase(pid, baselineCareerPrior);
    players.push({ qid: playerQids[pid], pid, name: index.names[pid], birth: index.births[pid],
      nationality: index.nats[pid], goalkeeper: runtimes.baseline.index.gkSet.has(pid), clubCount: clubs[pid].length,
      baselineCareerPrior, candidateCareerPrior, priorDelta: candidateCareerPrior - baselineCareerPrior, ...feature });
  }
  players.sort((a, b) => Math.abs(b.priorDelta) - Math.abs(a.priorDelta) || a.qid.localeCompare(b.qid));
  const selection = selectIntersections(index, model, clubs, { probes, schedule, maxIntersections });
  const intersections = [], diagnostics = [];
  for (const probe of selection.rows) {
    if (probe.qids.some(qid => !runtimes.baseline.byQid.has(qid))) {
      diagnostics.push(`unavailable clubs: ${probe.qids.join(" / ")}`); continue;
    }
    const sides = Object.fromEntries(Object.entries(runtimes).map(([key, rt]) => [key, stageSummary(rt, probe.qids)]));
    if (!sides.baseline) { diagnostics.push(`no effective answers: ${probe.qids.join(" / ")}`); continue; }
    for (const key of ["choiceControl", "candidate"]) {
      if (JSON.stringify(sides[key].stage.answers) !== JSON.stringify(sides.baseline.stage.answers)
          || sides[key].summary.representativePid !== sides.baseline.summary.representativePid)
        throw new Error("experimental difficulty changed accepted answers or representative ranking");
    }
    const stage = sides.baseline.stage;
    const scoredAnswers = stage.effective.map(pid => {
      const spellPairs = stage.clubs.flatMap((a, i) => stage.clubs.slice(i + 1).map(b => {
        const cs = [a, b], base = runtimes.baseline.core.qFame(pid, cs), bridge = runtimes.baseline.core.qBridgeFame(pid, cs);
        return { clubs: cs.map(ci => index.clubs[ci][0]), appearances: cs.map(ci => runtimes.baseline.core.qApps(ci, pid)),
          careerWithClues: base, spellFactor: base > 0 ? bridge / base : 1, baselineBridge: bridge,
          adjustment: model.adjustment(pid, base), playerAdjustedBridge: model.adapter.adjustBridge({ pid, baseFame: base, bridgeFame: bridge,
            spellApps: cs.map(ci => runtimes.baseline.core.qApps(ci, pid)), birth: index.births[pid], year: Number(index.built.slice(0, 4)) }),
          clubFactor: clubContext?.factor(cs.map(ci => index.clubs[ci][3])) ?? 1,
          candidateBridge: runtimes.candidate.core.qDifficultyFame(pid, cs) };
      }));
      return { pid, qid: playerQids[pid], name: index.names[pid],
      birth: index.births[pid], goalkeeper: runtimes.baseline.index.gkSet.has(pid),
      appearances: stage.clubs.map(ci => runtimes.baseline.core.qApps(ci, pid)),
      baseline: runtimes.baseline.core.qDifficultyFame(pid, stage.clubs),
      candidate: runtimes.candidate.core.qDifficultyFame(pid, stage.clubs),
      playerAdjusted: Math.min(...spellPairs.map(p => p.playerAdjustedBridge)),
      playerAdjustedFamiliar: stage.clubs.every(ci => runtimes.baseline.core.qApps(ci, pid) > 0)
        && Math.min(...spellPairs.map(p => p.playerAdjustedBridge)) >= runtimes.baseline.core.constants.QFAMILIAR_MIN_FAME,
      clubFactor: clubContext?.factor(probe.qids) ?? 1,
      clubEvidence: clubContext?.explain(probe.qids),
      sourceUsable: model.features[pid].eligible, popularityAnchor: model.features[pid].anchor,
      baselineFamiliar: !!runtimes.baseline.core.qFamiliarAnswers(stage.clubs, [pid]).length,
      candidateFamiliar: !!runtimes.candidate.core.qFamiliarAnswers(stage.clubs, [pid]).length,
      evidence: { medianMonthlyViews: model.features[pid].medianMonthlyViews,
        weightedLanguages: model.features[pid].weightedLanguages, languageScore: model.features[pid].languageScore,
        score: model.features[pid].score, bonusSupport: model.features[pid].bonusSupport,
        downwardSupport: model.features[pid].downwardSupport,
        reasons: model.features[pid].reasons,
        through: snapshot.players[playerQids[pid]]?.pageviews?.through,
        viewsFetchedAt: snapshot.players[playerQids[pid]]?.pageviews?.fetched_at,
        languagesFetchedAt: snapshot.players[playerQids[pid]]?.language_coverage?.fetched_at },
      spellPairs };
    }).sort((a, b) => Math.abs(b.candidate - b.baseline) - Math.abs(a.candidate - a.baseline)
      || b.candidate - a.candidate);
    const playerStrongest = [...scoredAnswers].sort((a, b) => b.playerAdjusted - a.playerAdjusted)[0]?.pid;
    const essential = new Set([sides.baseline.summary.strongestPid, sides.candidate.summary.strongestPid, playerStrongest]);
    const answers = [...scoredAnswers.filter(a => essential.has(a.pid)), ...scoredAnswers.filter(a => !essential.has(a.pid))].slice(0, 20);
    intersections.push({ ...probe, clubs: stage.clubs.map(ci => index.clubs[ci][0]),
      baseline: sides.baseline.summary, choiceControl: sides.choiceControl.summary, candidate: sides.candidate.summary,
      identityDelta: sides.choiceControl.summary.ease - sides.baseline.summary.ease,
      popularityDelta: sides.candidate.summary.ease - sides.choiceControl.summary.ease, answers });
  }
  const distribution = {};
  for (const key of Object.keys(runtimes)) distribution[key] = Object.fromEntries(LEVELS.map(level =>
    [level, intersections.filter(row => row[key].level === level).length]));
  const audits = {};
  if (auditDays) for (const [key, rt] of Object.entries(runtimes)) {
    if (key === "choiceControl" && rt.core.constants.QELIGIBILITY_VERSION >= 2) {
      audits[key] = { ...audits.baseline, reusedFrom: "baseline" };
      continue;
    }
    try { audits[key] = { completed: true, ...auditSchedule(rt, { days: auditDays, enforce: false }) }; }
    catch (error) { audits[key] = { completed: false, daysRequested: auditDays, errors: [error.message] }; }
  }
  return { version: 1, experimental: true, deploymentReady: false,
    asOf: model.asOf, datasetBuilt: index.built, snapshotGenerated: snapshot.generated_at,
    model: { id: model.id + (clubContext ? `+${clubContext.id}` : ""), config: model.config,
      clubContext: clubContext?.config }, eligibilityVersion: runtimes.baseline.core.constants.QELIGIBILITY_VERSION, coverage,
    clubContext: clubContext ? { features: clubContext.features, generatedAt: clubSnapshot.generated_at,
      usable: clubContext.features.filter(f => f.sourceUsable).length } : null,
    inputDigests: { index: digest(JSON.stringify(index)), snapshot: digest(JSON.stringify(snapshot)),
      playerQids: digest(JSON.stringify(playerQids)),
      quizCore: digest(fs.readFileSync(path.join(ROOT, "site/quiz-core.js"))),
      recognitionModel: digest(fs.readFileSync(path.join(__dirname, "recognition-model.js"))) },
    clubInputDigests: clubContext ? { snapshot: digest(JSON.stringify(clubSnapshot)),
      model: digest(fs.readFileSync(path.join(__dirname, "club-recognition.js"))) } : null,
    impact: impactSummary(intersections),
    selection: { fixedCount: selection.fixedCount, possibleAffectedPairs: selection.possibleAffectedPairs,
      truncated: selection.truncated, compared: intersections.length },
    notes: ["Trial parameters are not calibrated recognition probabilities.",
      "Only complete, fresh observations from both sources can affect this experiment.",
      model.config.maxDrop > 0
        ? "Bounded positive and negative corrections per answer; missing, stale and partial observations leave the prior unchanged."
        : "Bonus-only control; negative corrections are disabled for this comparison.",
      "The answer-set score is recomputed from corrected distinct choices; adding an obscure valid alternative cannot reduce ease.",
      "The current production policy already counts distinct choices; the choice control is identical to baseline and retained for report compatibility.",
      "Player career priors are measured without a clue set; intersection scores also apply spell recall.",
      "Catalogue distributions describe the selected probes, not the full quiz catalogue.",
      "Popularity changes recognition scores within the shared eligibility policy; every valid intersection keeps a tier.",
      "Calendar simulations use frozen observations for every date; they are not historical predictive backtests.",
      ...(coverage.usable < coverage.candidates ? ["Source coverage is incomplete; results cannot establish calibration quality."] : [])],
    players, intersections, distribution, audits, diagnostics };
}

const cell = value => String(value ?? "—").replace(/[|\r\n]/g, " ");
const number = value => Number(value).toFixed(2);
function formatMarkdown(report) {
  const lines = ["# Experimental quiz recognition comparison", "",
    `Model: ${report.model.id}. Frozen as-of: ${report.asOf}. Read-only comparison; does not publish changes.`, "",
    ...report.notes.map(note => `- ${note}`), "",
    `Coverage: ${report.coverage.usable} usable candidates out of ${report.coverage.candidates}; ${report.coverage.observed} have observations.`, "",
    `Measured popularity changes ${report.impact.scoreChanges} scores and ${report.impact.classificationChanges} classifications; ${report.impact.lostEligibility} intersections lose eligibility and ${report.impact.gainedEligibility} gain it.`, "",
    `Score direction: ${report.impact.scoreIncreases} increases, ${report.impact.scoreDecreases} decreases, ${report.impact.scoreUnchanged} unchanged.`, "",
    "## Intersections", "", "| Clubs | Current score | Choice control | Candidate | Popularity delta | Levels: current → control → candidate |",
    "| --- | ---: | ---: | ---: | ---: | --- |"];
  const ranked = [...report.intersections].sort((a, b) => Math.abs(b.popularityDelta) - Math.abs(a.popularityDelta));
  for (const row of ranked.slice(0, 30)) lines.push(`| ${cell(row.clubs.join(" / "))} | ${number(row.baseline.ease)} | ${number(row.choiceControl.ease)} | ${number(row.candidate.ease)} | ${number(row.popularityDelta)} | ${row.baseline.level} → ${row.choiceControl.level} → ${row.candidate.level} |`);
  lines.push("", "## Player career priors (without club clues)", "",
    "| Player | QID | Prior | Candidate | Weighted editions | Median monthly views | Eligible |", "| --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const row of report.players.slice(0, 30)) lines.push(`| ${cell(row.name)} | ${row.qid} | ${number(row.baselineCareerPrior)} | ${number(row.candidateCareerPrior)} | ${number(row.weightedLanguages)} | ${cell(row.medianMonthlyViews)} | ${row.eligible ? "yes" : cell(row.reasons.join("; "))} |`);
  lines.push("", "## Calendar audits", "");
  for (const [key, audit] of Object.entries(report.audits)) {
    lines.push(`- ${key}: ${audit.completed ? `${audit.days} days completed` : "generation failed"}; ${audit.errors.length ? audit.errors.join("; ") : "all checks passed"}.`);
    if (audit.completed) lines.push(`  Distinct combinations: ${audit.stages.map(s => s.uniqueCombinations).join(" / ")}; representatives: ${audit.stages.map(s => s.representativePlayers).join(" / ")}.`);
  }
  if (!Object.keys(report.audits).length) lines.push("Calendar audits were not requested.");
  lines.push("", "Full parameters, input hashes, per-answer spell scores and all comparisons are in report.json.", "");
  return lines.join("\n");
}

function formatHtml(report) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const labels = { baseline: "Current rules", choiceControl: "Distinct choices", candidate: "With popularity" };
  const maximum = Math.max(1, ...Object.values(report.distribution).flatMap(row => Object.values(row)));
  const charts = LEVELS.map(level => `<div class="group"><b>${level}</b>${Object.entries(labels).map(([key, label], i) =>
    `<div class="barrow"><span>${label}</span><div class="track"><div class="bar c${i}" style="width:${100 * report.distribution[key][level] / maximum}%"></div></div><strong>${report.distribution[key][level]}</strong></div>`).join("")}</div>`).join("");
  const corrections = [...report.intersections].sort((a, b) => Math.abs(b.popularityDelta) - Math.abs(a.popularityDelta));
  const rows = [...corrections.filter(r => r.popularityDelta < 0).slice(0, 6),
    ...corrections.filter(r => r.popularityDelta >= 0).slice(0, 6)];
  const auditIssues = Object.entries(report.audits).flatMap(([key, a]) => a.errors.map(error => `${labels[key]}: ${error}`));
  const england = Object.entries(report.audits).filter(([, a]) => a.completed);
  const countryMax = Math.max(32, ...england.map(([, a]) => a.countries.GB || 0));
  const countryChart = england.length ? `<h2>England impossible puzzles · 730-day minimum: 32</h2>${england.map(([key, a], i) => `<div class="barrow"><span>${labels[key]}</span><div class="track"><div class="bar c${i}" style="width:${100 * (a.countries.GB || 0) / countryMax}%"></div></div><strong>${a.countries.GB || 0}</strong></div>`).join("")}` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:light dark}body{margin:0;font:14px var(--font-sans,system-ui);color:var(--foreground,CanvasText)}h2{font-size:18px;margin:22px 0 12px}p{line-height:1.5}.muted{color:var(--muted-foreground,GrayText)}.issues{padding:16px;border-radius:var(--radius,8px);background:var(--warning-surface,ButtonFace)}.group{margin:18px 0}.barrow{display:flex;align-items:center;gap:8px;margin:5px 0}.barrow span{width:110px;font-size:12px}.barrow strong{width:35px;text-align:right}.track{flex:1;background:var(--secondary,ButtonFace);height:12px;border-radius:3px}.bar{height:12px;border-radius:3px}.c0{background:var(--chart-1,#619aff)}.c1{background:var(--chart-2,#38c6b2)}.c2{background:var(--chart-3,#efa959)}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:8px 4px;border-bottom:1px solid var(--border,GrayText)}.table{overflow-x:auto}input{box-sizing:border-box;width:100%;padding:8px;background:var(--secondary,ButtonFace);color:inherit;border:1px solid var(--border,GrayText);border-radius:4px}</style></head><body>
<p><b>Model comparison · does not publish changes</b></p><p class="muted">${escape(report.model.id)} · frozen at ${escape(report.asOf)}</p>
<p>Usable observations: <b>${report.coverage.usable} / ${report.coverage.candidates}</b> candidates. Complete, fresh readership and language coverage are required. Trial weights need calibration.</p>
<p class="muted">Extended selected-probe diagnostic: supplementary comparisons may include held-out players. Keep these outcomes separate from coefficient selection and independent human validation.</p>
<p>${report.impact.classificationChanges} classification changes; ${report.impact.lostEligibility} intersections lose eligibility. Easy still requires known clues and sufficiently familiar answers.</p>
<p>Scores: ${report.impact.scoreIncreases} increases · ${report.impact.scoreDecreases} decreases · ${report.impact.scoreUnchanged} unchanged. Missing observations retain the existing score.</p>
${auditIssues.length ? `<div class="issues"><b>Audit findings</b>${auditIssues.map(error => `<p>${escape(error)}</p>`).join("")}</div>` : ""}${countryChart}
<h2>Difficulty across ${report.selection.compared} compared intersections</h2><p class="muted">Current rules already count distinct choices, so the control matches baseline. The popularity model adds a bounded familiarity correction. These probes are a sample, not the full catalogue.</p>${charts}
<h2>Score decreases and increases</h2><input aria-label="Filter intersections" placeholder="Filter clubs" oninput="for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.textContent.toLowerCase().includes(this.value.toLowerCase())"><div class="table"><table><thead><tr><th>Clubs</th><th>Current</th><th>Control</th><th>Candidate</th><th>Level: current → candidate</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escape(r.clubs.join(" / "))}</td><td>${number(r.baseline.ease)}</td><td>${number(r.choiceControl.ease)}</td><td>${number(r.candidate.ease)}</td><td>${r.baseline.level} → ${r.candidate.level}</td></tr>`).join("")}</tbody></table></div>
<p class="muted">${Object.entries(report.audits).map(([key, a]) => `${escape(labels[key])}: ${a.completed ? `${a.days}-day audit` : "audit incomplete"}, ${a.errors.length} issue(s).`).join(" ") || "Calendar audits not requested."} Full details and source hashes are in report.json.</p></body></html>`;
}

function writeReport(report, output) {
  fs.mkdirSync(output, { recursive: true });
  for (const [filename, text] of Object.entries({ "report.json": JSON.stringify(report, null, 2) + "\n",
    "report.md": formatMarkdown(report), "report.html": formatHtml(report) })) fs.writeFileSync(path.join(output, filename), text);
  const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [["qid", "name", "birth", "nationality", "goalkeeper", "baseline_prior", "candidate_prior", "delta", "weighted_languages", "median_monthly_views", "eligible", "reasons"],
    ...report.players.map(p => [p.qid, p.name, p.birth, p.nationality, p.goalkeeper, p.baselineCareerPrior, p.candidateCareerPrior,
      p.priorDelta, p.weightedLanguages, p.medianMonthlyViews, p.eligible, p.reasons.join("; ")])];
  fs.writeFileSync(path.join(output, "players.csv"), rows.map(row => row.map(quote).join(",")).join("\n") + "\n");
}

function main(argv = process.argv.slice(2)) {
  const options = { index: path.join(ROOT, "site/data/index.json"), snapshot: path.join(ROOT, "data/popularity/snapshot.json"),
    output: path.join(ROOT, "data/recognition-audit"), auditDays: AUDIT_DAYS, maxIntersections: 2000 };
  const names = { "--index": "index", "--snapshot": "snapshot", "--output": "output", "--config": "config",
    "--as-of": "asOf", "--probes": "probes", "--schedule": "schedule", "--audit-days": "auditDays", "--max-intersections": "maxIntersections" };
  for (let i = 0; i < argv.length; i += 2) {
    if (!names[argv[i]] || !argv[i + 1]) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    options[names[argv[i]]] = argv[i + 1];
  }
  for (const key of ["auditDays", "maxIntersections"]) {
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === "auditDays" ? 0 : 1)) throw new Error(`invalid ${key}`);
  }
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  const index = read(options.index), snapshot = read(options.snapshot);
  const schedulePath = options.schedule || path.join(path.dirname(options.index), "quiz-schedule.json");
  const report = buildReport({ index, snapshot, playerQids: loadPlayerQids(index, path.dirname(options.index)),
    asOf: options.asOf, config: options.config ? read(options.config) : undefined,
    probes: options.probes ? read(options.probes) : PROBES,
    schedule: fs.existsSync(schedulePath) ? read(schedulePath) : null,
    maxIntersections: options.maxIntersections, auditDays: options.auditDays });
  writeReport(report, options.output);
  console.log(JSON.stringify({ model: report.model.id, coverage: report.coverage, compared: report.selection.compared,
    audits: Object.fromEntries(Object.entries(report.audits).map(([key, a]) => [key, { completed: a.completed, errors: a.errors }])),
    output: options.output }, null, 2));
  return report;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildReport, loadPlayerQids, formatMarkdown, formatHtml, writeReport, impactSummary, main };
