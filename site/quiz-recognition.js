"use strict";

// Frozen release inputs: the browser never reads source APIs or its own clock.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuizRecognition = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  const LEGACY_CONFIG = Object.freeze({
    version: "recognition-experiment-v4",
    languageWeights: Object.freeze({ en: 2, it: 1.5, es: 1.5, fr: 1.5, de: 1.5 }),
    otherLanguageWeight: 0.1, otherLanguageCap: 1,
    viewsCap: 100000, viewsWeight: 0.75,
    targetFame: 700, blend: 0.6, maxBoost: 250, readershipPower: 2,
    maxDrop: 150, maxDropFraction: 0.25,
    downwardBlend: 1, downwardFade: 0.1, downwardEditionProtection: 0,
    anchorScore: 0.75, minAnchorLanguages: 3, maxAgeDays: 90,
  });
  const PREVIOUS_CONFIG = Object.freeze({ ...LEGACY_CONFIG,
    version: "recognition-v5", viewsTargetPower: 1.4 });
  const FROZEN_CONFIG = Object.freeze({ ...PREVIOUS_CONFIG,
    version: "recognition-v6", spellRecallPower: 1.5, spellFullApps: 25, spellFloor: 0.35 });
  const DEFAULT_CONFIG = Object.freeze({ ...FROZEN_CONFIG, version: "recognition-v7",
    legacyRecallAge: 60, legacyRecallSpan: 15, legacyRecallMaxFraction: 0.1, legacyRecallFade: 0.2 });
  const LEGACY_CLUB_CONFIG = Object.freeze({ version: "club-recall-v2", viewsCap: 100000,
    minFactor: 0.6, viewsWeight: 0.8, viewsPower: 3, currentTopFloor: 0.95, currentOtherFloor: 0.85 });
  const PREVIOUS_CLUB_CONFIG = Object.freeze({ ...LEGACY_CLUB_CONFIG,
    version: "club-recall-v3", recallPower: 2 });
  const FROZEN_CLUB_CONFIG = Object.freeze({ ...PREVIOUS_CLUB_CONFIG, version: "club-recall-v4" });
  const DEFAULT_CLUB_CONFIG = Object.freeze({ ...FROZEN_CLUB_CONFIG, version: "club-recall-v5",
    easyExpansion: 1, easyViewsScore: 1, easyLanguageScore: 0.9 });

  function strongClue(feature, config) {
    return config.easyExpansion === 1 && feature != null
      && feature.viewsScore >= config.easyViewsScore && feature.languageScore >= config.easyLanguageScore;
  }

  function applySpellRecall(bridge, appearances, config) {
    if (!Array.isArray(appearances) || (config.spellRecallPower ?? 0.5) === 0.5) return bridge;
    const known = appearances.filter(n => Number.isFinite(n) && n >= 0);
    if (!known.length) return bridge;
    const fraction = Math.min(1, Math.min(...known) / config.spellFullApps);
    if (fraction === 1) return bridge;
    const prior = config.spellFloor + (1 - config.spellFloor) * Math.sqrt(fraction);
    const revised = config.spellFloor + (1 - config.spellFloor) * Math.pow(fraction, config.spellRecallPower);
    return bridge * revised / prior;
  }

  function legacyRecallFactor(birth, year, feature, config) {
    if (!feature?.eligible || !Number.isFinite(birth) || birth <= 0 || !Number.isFinite(year)
        || !(config.legacyRecallMaxFraction > 0)) return 1;
    const age = Math.max(0, Math.min(1, (year - birth - config.legacyRecallAge) / config.legacyRecallSpan));
    const views = feature.viewsScore ?? Math.pow(feature.bonusSupport, 1 / config.readershipPower);
    if (!Number.isFinite(views)) return 1;
    const support = Math.max(0, Math.min(1, (1 - views) / config.legacyRecallFade));
    return 1 - config.legacyRecallMaxFraction * age * support;
  }

  function legacyRecallFame(adjusted, prior, birth, year, feature, config) {
    const factor = legacyRecallFactor(birth, year, feature, config);
    if (factor === 1) return adjusted;
    return Math.max(prior - Math.min(config.maxDrop, config.maxDropFraction * prior), adjusted * factor);
  }

  function playerAdjustment(feature, baseFame, config) {
    if (!Number.isFinite(baseFame) || baseFame < 0) throw new Error("career score must be finite and nonnegative");
    if (!feature?.eligible) return { prior: baseFame, delta: 0, target: null, support: 0, direction: "unchanged" };
    const target = config.targetFame * feature.score;
    const gap = (target < baseFame ? config.downwardBlend : config.blend) * (target - baseFame);
    const downwardLimit = Math.min(config.maxDrop, config.maxDropFraction * baseFame);
    const bounded = Math.max(-downwardLimit, Math.min(config.maxBoost, gap));
    const support = gap < 0 ? feature.downwardSupport : feature.bonusSupport;
    const delta = bounded * support;
    return { prior: baseFame, delta, target, support, direction: delta > 0 ? "increase" : delta < 0 ? "decrease" : "unchanged" };
  }

  function clubFactor(club, feature, top, known, config) {
    if (known.has(club[3]) || !feature) return 1;
    const current = Number.isInteger(club[5]) && club[5] >= 0;
    const floor = current ? top.has(club[5]) ? config.currentTopFloor : config.currentOtherFloor : config.minFactor;
    const familiarity = config.viewsWeight * Math.pow(feature.viewsScore, config.viewsPower)
      + (1 - config.viewsWeight) * feature.languageScore;
    // Separate recognition of the clue from recognition of a celebrity answer.
    // Preserve known-club protection and current-division floors after the curve.
    return Math.max(floor, Math.pow(config.minFactor + (1 - config.minFactor) * familiarity,
      config.recallPower ?? 1));
  }

  function topLeagues(index) {
    return new Set(index.leagues.flatMap((l, i) => i === 0 || index.leagues[i - 1][2] !== l[2] ? [i] : []));
  }

  function validate(bundle, playerCount) {
    if (!bundle || bundle.v !== 1 || bundle.kind !== "quiz-recognition"
        || !Number.isFinite(Date.parse(bundle.asOf)) || !bundle.players || !bundle.clubs
        || Array.isArray(bundle.players) || Array.isArray(bundle.clubs)
        || ![DEFAULT_CONFIG, FROZEN_CONFIG, PREVIOUS_CONFIG, LEGACY_CONFIG].some(c => JSON.stringify(bundle.config) === JSON.stringify(c))
        || ![DEFAULT_CLUB_CONFIG, FROZEN_CLUB_CONFIG, PREVIOUS_CLUB_CONFIG, LEGACY_CLUB_CONFIG].some(c => JSON.stringify(bundle.clubConfig) === JSON.stringify(c)))
      throw new Error("unsupported published recognition inputs");
    if (bundle.easyClubQids !== undefined && (!Array.isArray(bundle.easyClubQids) || !bundle.easyClubQids.length
        || new Set(bundle.easyClubQids).size !== bundle.easyClubQids.length
        || bundle.easyClubQids.some(q => !/^Q[1-9]\d*$/.test(q)))) throw new Error("invalid frozen Easy club list");
    const seen = new Set(), time = Date.parse(bundle.asOf);
    const unit = n => Number.isFinite(n) && n >= 0 && n <= 1;
    for (const [qid, row] of Object.entries(bundle.players)) {
      if (!/^Q[1-9]\d*$/.test(qid) || !Array.isArray(row) || row.length !== 5
          || !Number.isInteger(row[0]) || row[0] < 0 || row[0] >= playerCount || seen.has(row[0])
          || !row.slice(1, 4).every(unit) || !Number.isFinite(row[4]) || row[4] <= time)
        throw new Error("invalid published player recognition inputs");
      seen.add(row[0]);
    }
    for (const [qid, row] of Object.entries(bundle.clubs)) {
      if (!/^Q[1-9]\d*$/.test(qid) || !Array.isArray(row) || row.length !== 3
          || !row.slice(0, 2).every(unit) || !Number.isFinite(row[2]) || row[2] <= time)
        throw new Error("invalid published club recognition inputs");
    }
    return bundle;
  }

  function createAdapter(index, easyQids) {
    if (!index.quizRecognition) return undefined;
    const bundle = validate(index.quizRecognition, index.names.length);
    const features = new Map(Object.values(bundle.players).map(([pid, score, bonusSupport, downwardSupport]) =>
      [pid, { eligible: true, score, bonusSupport, downwardSupport }]));
    const top = topLeagues(index), known = new Set(bundle.easyClubQids ?? easyQids);
    const factors = new Map(index.clubs.map(club => {
      const row = bundle.clubs[club[3]];
      return [club[3], clubFactor(club, row ? { viewsScore: row[0], languageScore: row[1] } : null,
        top, known, bundle.clubConfig)];
    }));
    return { easyClubQids: [...known], adjustBridge: ({ pid, baseFame, bridgeFame, clubQids = [], spellApps, birth, year }) => {
      const { delta } = playerAdjustment(features.get(pid), baseFame, bundle.config);
      const adjusted = legacyRecallFame(baseFame + delta, baseFame, birth, year, features.get(pid), bundle.config);
      const bridge = adjusted === baseFame || baseFame <= 0 ? bridgeFame
        : bridgeFame + (adjusted - baseFame) * (bridgeFame / baseFame);
      return applySpellRecall(bridge, spellApps, bundle.config) * Math.min(1, ...clubQids.map(qid => factors.get(qid) ?? 1));
    } };
  }
  return { DEFAULT_CONFIG, DEFAULT_CLUB_CONFIG, PREVIOUS_CONFIG, FROZEN_CONFIG, PREVIOUS_CLUB_CONFIG, FROZEN_CLUB_CONFIG, LEGACY_CONFIG, LEGACY_CLUB_CONFIG,
    playerAdjustment, applySpellRecall, legacyRecallFactor, legacyRecallFame, clubFactor, strongClue, topLeagues, validate, createAdapter };
});
