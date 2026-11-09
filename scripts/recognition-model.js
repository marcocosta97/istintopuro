"use strict";

// Source validation and controls for the shared production recognition model.
const crypto = require("node:crypto");
const { DEFAULT_CONFIG, PREVIOUS_CONFIG, FROZEN_CONFIG, LEGACY_CONFIG, playerAdjustment, applySpellRecall, legacyRecallFame } = require("../site/quiz-recognition.js");
const BIDIRECTIONAL_CONFIG = Object.freeze({ ...LEGACY_CONFIG, viewsTargetPower: 1, spellRecallPower: 0.5, legacyRecallMaxFraction: 0 });
// Frozen bonus-only controls; they are comparisons, not the current hypothesis.
const REFERENCE_CONFIG = Object.freeze({ ...BIDIRECTIONAL_CONFIG,
  version: "recognition-experiment-v1", readershipPower: 0, maxDrop: 0 });
const GRADUAL_CONFIG = Object.freeze({ ...BIDIRECTIONAL_CONFIG,
  version: "recognition-trial-gradual-v2", readershipPower: 2, maxDrop: 0 });
const CONSERVATIVE_CONFIG = Object.freeze({ ...BIDIRECTIONAL_CONFIG,
  version: "recognition-experiment-v3", downwardBlend: 0.6, downwardFade: 1, downwardEditionProtection: 1 });

function configuration(overrides = {}) {
  for (const key of Object.keys(overrides)) if (!(key in DEFAULT_CONFIG)) throw new Error(`unknown model parameter: ${key}`);
  const config = { ...DEFAULT_CONFIG, ...overrides,
    languageWeights: { ...DEFAULT_CONFIG.languageWeights, ...overrides.languageWeights } };
  if ([LEGACY_CONFIG.version, PREVIOUS_CONFIG.version].includes(overrides.version)
      && overrides.spellRecallPower === undefined) config.spellRecallPower = 0.5;
  if (overrides.version === LEGACY_CONFIG.version && overrides.viewsTargetPower === undefined) config.viewsTargetPower = 1;
  if ([LEGACY_CONFIG.version, PREVIOUS_CONFIG.version, FROZEN_CONFIG.version].includes(overrides.version)
      && overrides.legacyRecallMaxFraction === undefined) config.legacyRecallMaxFraction = 0;
  if (typeof config.version !== "string" || !config.version) throw new Error("model version must be a nonempty string");
  for (const [key, value] of Object.entries(config)) {
    if (key === "version" || key === "languageWeights") continue;
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid model parameter: ${key}`);
  }
  for (const [language, weight] of Object.entries(config.languageWeights))
    if (!/^[a-z][a-z-]*$/.test(language) || !Number.isFinite(weight) || weight < 0)
      throw new Error(`invalid language weight: ${language}`);
  if (config.viewsCap <= 0 || config.maxAgeDays <= 0 || config.targetFame <= 0 || config.viewsTargetPower <= 0
      || config.spellRecallPower <= 0 || config.spellFullApps <= 0 || config.spellFloor > 1
      || config.legacyRecallSpan <= 0 || config.legacyRecallFade <= 0 || config.legacyRecallFade > 1 || config.legacyRecallMaxFraction > 1
      || config.viewsWeight > 1 || config.blend > 1 || config.anchorScore > 1 || config.maxDropFraction > 1
      || config.downwardBlend > 1 || config.downwardFade <= 0 || config.downwardFade > 1
      || !Number.isInteger(config.minAnchorLanguages)
      || config.minAnchorLanguages > Object.values(config.languageWeights).filter(w => w > 0).length
      || !Object.values(config.languageWeights).some(w => w > 0)) throw new Error("invalid model bounds");
  return config;
}

function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error(`expected an ISO timestamp: ${value}`);
  return Date.parse(value);
}

function current(signal, asOf, maxAgeDays) {
  try {
    const age = (asOf - instant(signal?.fetched_at)) / 864e5;
    return age >= 0 && age < maxAgeDays;
  } catch { return false; }
}

function completeMedian(views, asOf) {
  if (views?.status !== "complete" || !Array.isArray(views.monthly) || views.monthly.length !== 12) return null;
  const [year, month] = String(views.through).split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const end = Date.UTC(year, month, 1);
  if (end > asOf) return null;
  const values = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(year, month - 12 + i, 1));
    const label = d.toISOString().slice(0, 7), bucket = views.monthly[i];
    if (!Array.isArray(bucket) || bucket[0] !== label || !Number.isSafeInteger(bucket[1]) || bucket[1] < 0) return null;
    values.push(bucket[1]);
  }
  const sorted = [...values].sort((a, b) => a - b), median = (sorted[5] + sorted[6]) / 2;
  if (views.total_views !== values.reduce((a, b) => a + b, 0) || views.median_monthly_views !== median) return null;
  return median;
}

function observation(row, config, asOf, expectedQid) {
  const reasons = [], coverage = row?.language_coverage, views = row?.pageviews;
  const languages = Array.isArray(coverage?.languages) ? [...new Set(coverage.languages)] : [];
  const validLanguages = coverage?.status === "available" && Number.isInteger(coverage.count)
    && coverage.count === languages.length && languages.every(l => typeof l === "string" && /^[a-z][a-z-]*$/.test(l));
  if (!validLanguages) reasons.push("language coverage missing or invalid");
  else if (!current(coverage, asOf, config.maxAgeDays)) reasons.push("language coverage stale or future-dated");
  const median = completeMedian(views, asOf);
  if (median === null) reasons.push("complete readership missing or invalid");
  else if (!current(views, asOf, config.maxAgeDays)) reasons.push("readership stale or future-dated");
  if (views?.title_mode === "verified_redirect" && (
      (expectedQid && views.verified_alias_qid !== expectedQid) || views.sitelink_title !== coverage?.enwiki
      || !current({ fetched_at: views.alias_checked_at }, asOf, config.maxAgeDays)
      || !Number.isFinite(Date.parse(views.alias_move_at)) || Date.parse(views.alias_move_at) > asOf))
    reasons.push("redirect identity or verification invalid");
  let primary = 0, other = 0, primaryLanguages = 0;
  for (const language of validLanguages ? languages : []) {
    const weight = config.languageWeights[language];
    if (weight !== undefined) { primary += weight; if (weight > 0) primaryLanguages++; }
    else other += config.otherLanguageWeight;
  }
  const weightedLanguages = primary + Math.min(other, config.otherLanguageCap);
  const languageScale = Object.values(config.languageWeights).reduce((a, b) => a + b, 0) + config.otherLanguageCap;
  const languageScore = Math.min(1, weightedLanguages / languageScale);
  const viewsScore = median === null ? null : Math.min(1, Math.log1p(median) / Math.log1p(config.viewsCap));
  const eligible = reasons.length === 0;
  const score = eligible ? config.viewsWeight * Math.pow(viewsScore, config.viewsTargetPower)
    + (1 - config.viewsWeight) * languageScore : null;
  // Readership and editions already determine the target. The revised downside
  // does not discount them a second time throughout the entire range. It fades
  // only near capped readership, where a censored value is a lower bound. The
  // old conservative curve remains reproducible via CONSERVATIVE_CONFIG.
  const downwardSupport = eligible ? Math.min(1, (1 - viewsScore) / config.downwardFade)
    / (1 + config.downwardEditionProtection * languageScore) : 0;
  return { observed: row != null && (coverage != null || views?.fetched_at != null), eligible, reasons,
    primaryLanguages, weightedLanguages, languageScore, medianMonthlyViews: median, viewsScore, score,
    bonusSupport: eligible ? Math.pow(viewsScore, config.readershipPower) : 0,
    downwardSupport,
    anchor: eligible && score >= config.anchorScore && primaryLanguages >= config.minAnchorLanguages };
}

function createModel(snapshot, playerQids, { asOf = snapshot?.generated_at, config: overrides } = {}) {
  const config = configuration(overrides), time = instant(asOf);
  if (snapshot?.version !== 1 || snapshot?.kind !== "recognition-snapshot" || !snapshot.players
      || typeof snapshot.players !== "object" || Array.isArray(snapshot.players)
      || snapshot.pageviews_source?.project !== "en.wikipedia.org" || snapshot.pageviews_source?.agent !== "user"
      || snapshot.pageviews_source?.access !== "all-access") throw new Error("unsupported recognition snapshot");
  if (instant(snapshot.generated_at) > time) throw new Error("snapshot was generated after the audit's as-of time");
  const features = playerQids.map(qid => observation(snapshot.players[qid], config, time, qid));
  function adjustment(pid, baseFame) {
    return playerAdjustment(features[pid], baseFame, config);
  }
  const adjustedBase = (pid, baseFame) => baseFame + adjustment(pid, baseFame).delta;
  return { config, features, asOf: new Date(time).toISOString(),
    id: `${config.version}:${crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12)}`,
    adjustedBase, adjustment,
    adapter: {
      adjustBridge: ({ pid, baseFame, bridgeFame, spellApps, birth, year }) => {
        const adjusted = legacyRecallFame(adjustedBase(pid, baseFame), baseFame, birth, year, features[pid], config);
        const bridge = adjusted === baseFame || baseFame <= 0 ? bridgeFame
          : bridgeFame + (adjusted - baseFame) * (bridgeFame / baseFame);
        return applySpellRecall(bridge, spellApps, config);
      } },
  };
}

module.exports = { DEFAULT_CONFIG, BIDIRECTIONAL_CONFIG, REFERENCE_CONFIG, GRADUAL_CONFIG,
  CONSERVATIVE_CONFIG, configuration, createModel, observation, completeMedian };
