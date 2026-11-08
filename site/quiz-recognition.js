"use strict";

// Frozen release inputs: the browser never reads source APIs or its own clock.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuizRecognition = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  const DEFAULT_CONFIG = Object.freeze({
    version: "recognition-experiment-v4",
    languageWeights: Object.freeze({ en: 2, it: 1.5, es: 1.5, fr: 1.5, de: 1.5 }),
    otherLanguageWeight: 0.1, otherLanguageCap: 1,
    viewsCap: 100000, viewsWeight: 0.75,
    targetFame: 700, blend: 0.6, maxBoost: 250, readershipPower: 2,
    maxDrop: 150, maxDropFraction: 0.25,
    downwardBlend: 1, downwardFade: 0.1, downwardEditionProtection: 0,
    anchorScore: 0.75, minAnchorLanguages: 3, maxAgeDays: 90,
  });
  const DEFAULT_CLUB_CONFIG = Object.freeze({ version: "club-recall-v2", viewsCap: 100000,
    minFactor: 0.6, viewsWeight: 0.8, viewsPower: 3, currentTopFloor: 0.95, currentOtherFloor: 0.85 });

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
    return Math.max(floor, config.minFactor + (1 - config.minFactor) * familiarity);
  }

  function topLeagues(index) {
    return new Set(index.leagues.flatMap((l, i) => i === 0 || index.leagues[i - 1][2] !== l[2] ? [i] : []));
  }

  function validate(bundle, playerCount) {
    if (!bundle || bundle.v !== 1 || bundle.kind !== "quiz-recognition"
        || !Number.isFinite(Date.parse(bundle.asOf)) || !bundle.players || !bundle.clubs
        || Array.isArray(bundle.players) || Array.isArray(bundle.clubs)
        || JSON.stringify(bundle.config) !== JSON.stringify(DEFAULT_CONFIG)
        || JSON.stringify(bundle.clubConfig) !== JSON.stringify(DEFAULT_CLUB_CONFIG))
      throw new Error("unsupported published recognition inputs");
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
    const top = topLeagues(index), known = new Set(easyQids);
    const factors = new Map(index.clubs.map(club => {
      const row = bundle.clubs[club[3]];
      return [club[3], clubFactor(club, row ? { viewsScore: row[0], languageScore: row[1] } : null,
        top, known, bundle.clubConfig)];
    }));
    return { adjustBridge: ({ pid, baseFame, bridgeFame, clubQids = [] }) => {
      const { delta } = playerAdjustment(features.get(pid), baseFame, bundle.config);
      const adjusted = baseFame + delta;
      const bridge = adjusted === baseFame || baseFame <= 0 ? bridgeFame
        : bridgeFame + (adjusted - baseFame) * (bridgeFame / baseFame);
      return bridge * Math.min(1, ...clubQids.map(qid => factors.get(qid) ?? 1));
    } };
  }
  return { DEFAULT_CONFIG, DEFAULT_CLUB_CONFIG, playerAdjustment, clubFactor, topLeagues, validate, createAdapter };
});
