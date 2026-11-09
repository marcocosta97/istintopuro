"use strict";

const crypto = require("node:crypto");
const { EASY_QIDS, LEGACY_EASY_QIDS } = require("../site/quiz-core.js");
const { configuration, observation } = require("./recognition-model.js");
const { DEFAULT_CLUB_CONFIG, PREVIOUS_CLUB_CONFIG, FROZEN_CLUB_CONFIG, LEGACY_CLUB_CONFIG, clubFactor, strongClue, topLeagues } = require("../site/quiz-recognition.js");

function createClubContext(index, snapshot, { asOf, config: overrides = {} } = {}) {
  for (const k of Object.keys(overrides)) if (!(k in DEFAULT_CLUB_CONFIG)) throw Error(`unknown club parameter: ${k}`);
  const config = { ...DEFAULT_CLUB_CONFIG, ...overrides };
  if (overrides.version === LEGACY_CLUB_CONFIG.version && overrides.recallPower === undefined) config.recallPower = 1;
  if ([LEGACY_CLUB_CONFIG.version, PREVIOUS_CLUB_CONFIG.version, FROZEN_CLUB_CONFIG.version].includes(overrides.version)
      && overrides.easyExpansion === undefined) config.easyExpansion = 0;
  if (!Number.isFinite(Date.parse(asOf)) || snapshot?.version !== 1 || snapshot.kind !== "club-recognition-sources"
      || !snapshot.clubs || Array.isArray(snapshot.clubs) || !Number.isFinite(Date.parse(snapshot.generated_at))
      || Date.parse(snapshot.generated_at) > Date.parse(asOf)
      || snapshot.pageviews_source?.project !== "en.wikipedia.org" || snapshot.pageviews_source?.agent !== "user"
      || snapshot.pageviews_source?.access !== "all-access") throw Error("invalid or future-dated club observations");
  if (typeof config.version !== "string" || !config.version) throw Error("club version is required");
  for (const [k, v] of Object.entries(config)) if (k !== "version" && (!Number.isFinite(v) || v < 0)) throw Error(`invalid club parameter: ${k}`);
  if (config.viewsCap <= 0 || config.viewsPower <= 0 || config.recallPower <= 0 || config.viewsWeight > 1 || config.minFactor > 1
      || config.currentTopFloor > 1 || config.currentOtherFloor > 1 || ![0, 1].includes(config.easyExpansion)
      || config.easyViewsScore > 1 || config.easyLanguageScore > 1) throw Error("invalid club bounds");
  const base = [LEGACY_CLUB_CONFIG.version, PREVIOUS_CLUB_CONFIG.version].includes(config.version) ? LEGACY_EASY_QIDS : EASY_QIDS;
  const frozen = index.quizRecognition?.clubConfig?.version === config.version ? index.quizRecognition.easyClubQids : undefined;
  const known = new Set(config.easyExpansion ? base : frozen ?? base);
  const top = topLeagues(index);
  const sourceConfig = configuration({ viewsCap: config.viewsCap });
  const observations = index.clubs.map(club => observation(snapshot.clubs[club[3]], sourceConfig, Date.parse(asOf), club[3]));
  index.clubs.forEach((club, ci) => {
    if (observations[ci].eligible && strongClue(observations[ci], config)) known.add(club[3]);
  });
  const features = index.clubs.map((club, ci) => {
    const qid = club[3], observed = observations[ci];
    const current = Number.isInteger(club[5]) && club[5] >= 0;
    const familiarity = observed.eligible ? config.viewsWeight * Math.pow(observed.viewsScore, config.viewsPower)
      + (1 - config.viewsWeight) * observed.languageScore : null;
    // A known historic clue stays familiar after relegation. Missing traffic is
    // neutral; neither archive size nor dissolution is a recognition score.
    const factor = clubFactor(club, observed.eligible ? observed : null, top, known, config);
    return { qid, name: club[0], factor, familiarity, known: known.has(qid), currentCoveredLeague: current,
      sourceUsable: observed.eligible, medianMonthlyViews: observed.medianMonthlyViews,
      weightedLanguages: observed.weightedLanguages, reasons: observed.reasons,
      rationale: known.has(qid) ? base.includes(qid) ? "curated familiar clue, including recognised historic clubs"
        : "complete strong readership and weighted-language coverage qualify the clue for Easy"
        : !observed.eligible ? "missing or incomplete club sources: neutral"
        : current ? "measured recognition with current league visibility floor" : "measured recognition, independent of historical archive size" };
  });
  const byQid = new Map(features.map(f => [f.qid, f]));
  const factor = qids => Math.min(1, ...qids.map(qid => byQid.get(qid)?.factor ?? 1));
  const easyClubQids = [...known];
  return { config, features, factor, easyClubQids, explain: qids => qids.map(qid => byQid.get(qid)).filter(Boolean),
    id: `${config.version}:${crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12)}`,
    wrap: adapter => ({ easyClubQids, adjustBridge: args => adapter.adjustBridge(args) * factor(args.clubQids || []) }) };
}

module.exports = { DEFAULT_CLUB_CONFIG, createClubContext };
