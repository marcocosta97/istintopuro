"use strict";

/* Deterministic quiz generation shared by the browser and Node schedule tools. */
(function (root, build) {
  const api = build();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QuizCore = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  const MARQUEE_QIDS = [
    "Q1422", "Q631", "Q1543", "Q2641", "Q2739", "Q2609", "Q2052",
    "Q8682", "Q7156", "Q8701", "Q10329", "Q10333", "Q12297", "Q8687", "Q10315",
    "Q15789", "Q41420", "Q104761", "Q702455", "Q32494", "Q38245", "Q101959",
    "Q51976", "Q51974", "Q483020", "Q132885", "Q704", "Q180305", "Q19516",
    "Q18656", "Q50602", "Q1130849", "Q9617", "Q9616", "Q18741", "Q18716",
    "Q18711", "Q5794", "Q18747", "Q1128631",
  ];
  // General fans recognise these clubs across league borders. A current
  // top-division place or a large historical roster is not enough for easy.
  const ELITE_QIDS = [
    "Q1422", "Q1543", "Q631", "Q2739", "Q2641",
    "Q8682", "Q7156", "Q8701", "Q15789", "Q41420", "Q483020",
    "Q18656", "Q50602", "Q1130849", "Q9617", "Q9616", "Q18741",
  ];
  // Clue recognition can widen without widening the player-exposure baseline.
  const EASY_QIDS = MARQUEE_QIDS;
  const KNOWN_LEGACY_QIDS = ["Q19521", "Q19446", "Q8760", "Q172476", "Q19481", "Q2693", "Q1457"];
  const QLEVELS = ["easy", "medium", "hard", "impossible"];

  const QEPOCH = Date.UTC(2026, 7, 21);
  const QT = 240;
  const QCOMBO_DAYS = 30;
  const QMAX_ATTEMPTS = 64;
  const Q3ODDS = 0.5;
  // Easy has few triples with multiple familiar answers; keep them occasional.
  const QEASY3ODDS = 0.15;
  const QMEDIUM3ODDS = 0.3;
  const QBRIDGE_FULL_APPS = 25;
  const QBRIDGE_FLOOR = 0.35;
  const QBREADTH_MIN_FAME = 150;
  const QBREADTH_FULL_FAME = 350;
  const QFACE_GUARD_DAYS = 14;
  const QCLUB_SOFT_DAYS = 7;
  // The impossible tier anchors on its first (obscure) club, and the 730-day audit
  // reads the day's country from that club. A flat posting cutoff starves a bimodal
  // league like England — dozens of clubs at 300+ postings but only three below 200 —
  // so its impossible share becomes a knife-edge that flips between refreshes while
  // denser leagues keep theirs. Every covered country is guaranteed a floor of
  // anchors instead.
  const QOBS_MAX_POSTINGS = 250;
  const QOBS_MIN_ANCHORS = 6;
  // Recognition thresholds are lower bounds. The shared classifier assigns
  // each intersection once, including high scores with only one familiar route.
  const QBOUNDARIES = { easy: 550, medium: 400, hard: 180 };
  const QEASY_MIN_FAMILIAR = 2;
  const QFAMILIAR_MIN_FAME = 400;
  const QFAMILIAR_MIN_GLOBAL_APPS = 100;
  const QFAMILIAR_MIN_BRIDGE_APPS = 15;
  const QEASY = [
    { p: ["easy", "easy"], size: [2, 1e9], ease: [600, 1e9], familiar: QEASY_MIN_FAMILIAR },
    { p: ["easy", "easy"], size: [2, 1e9], ease: [QBOUNDARIES.easy, 1e9], familiar: QEASY_MIN_FAMILIAR },
  ];
  const QEASY3 = QEASY.map(tier => ({ ...tier, p: ["easy", "easy", "easy"] }));
  const QMEDIUM = [
    { p: ["easy", "marquee"], size: [3, 1e9], ease: [450, 1e9], familiar: 1 },
    { p: ["marquee", "marquee"], size: [3, 1e9], ease: [425, 1e9], familiar: 1 },
    { p: ["easy", "field"], size: [2, 1e9], ease: [QBOUNDARIES.medium, 1e9], familiar: 1 },
  ];
  const QMEDIUM3 = QMEDIUM.map(tier => ({ ...tier, p: [...tier.p, "marquee"] }));
  const QHARD = [
    { p: ["marquee", "field"], size: [2, 12], ease: [QBOUNDARIES.hard, 1e9] },
    { p: ["marquee", "field"], size: [2, 15], ease: [QBOUNDARIES.hard, 1e9] },
    { p: ["marquee", "field"], size: [2, 20], ease: [QBOUNDARIES.hard, 1e9] },
  ];
  const QIMPOSSIBLE = [
    { p: ["obs", "any300"], size: [1, 2], ease: [0, QBOUNDARIES.hard], birth: 1 },
    { p: ["obs", "any300"], size: [1, 2], ease: [0, QBOUNDARIES.hard] },
    { p: ["obs", "any100"], size: [1, 3], ease: [0, QBOUNDARIES.hard] },
  ];
  const QHARD3 = [
    { p: ["marquee", "field", "field"], size: [2, 12], ease: [QBOUNDARIES.hard, 1e9] },
    { p: ["marquee", "field", "field"], size: [2, 15], ease: [QBOUNDARIES.hard, 1e9] },
  ];
  const QIMP3 = [
    { p: ["obs", "any300", "any300"], size: [1, 2], ease: [0, QBOUNDARIES.hard], birth: 1 },
    { p: ["obs", "any300", "any100"], size: [1, 3], ease: [0, QBOUNDARIES.hard] },
  ];

  function createClubStature(DB, leagueCC, marquee) {
    const byCountry = {};
    DB.clubs.forEach((club, ci) => {
      if (DB.postings[ci].length >= 120) (byCountry[leagueCC(ci)] ??= []).push(ci);
    });
    const weights = new Map();
    for (const clubs of Object.values(byCountry)) {
      clubs.sort((a, b) => DB.postings[a].length - DB.postings[b].length);
      clubs.forEach((ci, i) => {
        const percentile = clubs.length > 1 ? i / (clubs.length - 1) : 1;
        weights.set(ci, marquee.has(DB.clubs[ci][3]) ? 1.15
          : percentile >= 0.6 ? 1 : percentile >= 0.3 ? 0.82 : 0.66);
      });
    }
    return ci => weights.get(ci) ?? 0.66;
  }

  function createQuizCore(deps) {
    const { DB, postings, intersect, leagueCC } = deps;
    const marquee = deps.marquee || new Set(MARQUEE_QIDS);
    const elite = new Set(ELITE_QIDS);
    const easyClues = new Set(EASY_QIDS), knownLegacy = new Set(KNOWN_LEGACY_QIDS);
    if (!DB || !postings || !intersect || !leagueCC)
      throw new TypeError("createQuizCore requires DB, postings, intersect and leagueCC");
    const stature = deps.stature || createClubStature(DB, leagueCC, marquee);

    const qHash = (s) => {
      let h = 0x811c9dc5;
      for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619);
      return h >>> 0;
    };
    const qRng = (a) => () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const qNum = (date) => {
      const [y, m, d] = date.split("-").map(Number);
      return (Date.UTC(y, m - 1, d) - QEPOCH) / 864e5 + 1;
    };
    const qShift = (date, k) => {
      const [y, m, d] = date.split("-").map(Number);
      const t = new Date(Date.UTC(y, m - 1, d + k));
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
    };

    function postingIndex(ci, pid) {
      const arr = postings(ci);
      let lo = 0, hi = arr.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (arr[m] === pid) return m;
        if (arr[m] < pid) lo = m + 1; else hi = m - 1;
      }
      return -1;
    }
    function qApps(ci, pid) {
      const index = postingIndex(ci, pid);
      return index < 0 ? -1 : DB.apps[ci][index];
    }
    function qGoals(ci, pid) {
      if (DB.gkSet.has(pid)) return 0;
      const index = postingIndex(ci, pid);
      return index < 0 ? -1 : DB.goals[ci][index];
    }
    const appearanceGaps = (pid, clubs) => ({
      missing: clubs.filter(ci => postingIndex(ci, pid) < 0),
      zero: clubs.filter(ci => qApps(ci, pid) === 0),
    });

    function qPools() {
      if (DB.qPools) return DB.qPools;
      DB.topLeagues ||= new Set(DB.leagues.reduce((a, l, i) =>
        (i === 0 || DB.leagues[i - 1][2] !== l[2]) ? (a.push(i), a) : a, []));
      DB.qYear = +(DB.built || "").slice(0, 4) || new Date().getFullYear();
      if (!DB.gkSet) {
        DB.gkSet = new Set();
        let a = 0;
        for (const d of DB.gks || []) DB.gkSet.add(a += d);
      }
      const star = [], sub = [], obs = [], any300 = [], any100 = [], eliteClubs = [], marqueeClubs = [], easyClubs = [];
      const topFlightMask = [...DB.topLeagues].reduce((mask, league) => mask | (1 << league), 0);
      const covered = new Set(DB.leagues.map(league => league[2]));
      const anchorCandidates = {};
      DB.clubs.forEach((c, i) => {
        const n = DB.postings[i].length;
        const topDiv = !c[4] && DB.topLeagues.has(c[5] ?? -1);
        if (n < 30) return;
        if (elite.has(c[3])) eliteClubs.push(i);
        if (easyClues.has(c[3])) easyClubs.push(i);
        if (marquee.has(c[3])) marqueeClubs.push(i);
        const prominent = (topDiv && n >= 400) || (!c[4] && marquee.has(c[3]) && n >= 120);
        if (prominent) star.push(i);
        // Retain historical top-flight careers after relegation, but do not
        // mistake a well-documented minor-league club for familiar football.
        if (!prominent && !c[4] && n >= 120 && (c[2] & topFlightMask)) sub.push(i);
        if (n < QOBS_MAX_POSTINGS) obs.push(i);
        if (n >= 300) any300.push(i);
        if (n >= 100) any100.push(i);
        const cc = leagueCC(i);
        if (covered.has(cc)) (anchorCandidates[cc] ??= []).push(i);
      });
      // Top every covered country up to the anchor floor. This only ever widens the
      // sparse leagues, and the impossible tier's size and ease caps keep the
      // promoted clubs just as hard; a marquee club would never read as obscure.
      const starSet = new Set(star);
      const anchorCount = new Map();
      for (const ci of obs) anchorCount.set(leagueCC(ci), (anchorCount.get(leagueCC(ci)) || 0) + 1);
      const obsSet = new Set(obs);
      for (const [cc, clubs] of Object.entries(anchorCandidates)) {
        let have = anchorCount.get(cc) || 0;
        if (have >= QOBS_MIN_ANCHORS) continue;
        clubs.sort((a, b) => DB.postings[a].length - DB.postings[b].length);
        for (const ci of clubs) {
          if (obsSet.has(ci) || starSet.has(ci)) continue;
          obsSet.add(ci); obs.push(ci);
          if (++have >= QOBS_MIN_ANCHORS) break;
        }
      }
      DB.qMApps = new Float32Array(DB.names.length);
      DB.qMGoals = new Float32Array(DB.names.length);
      DB.qGlobalApps = new Float32Array(DB.names.length);
      DB.clubs.forEach((c, ci) => {
        if (!marquee.has(c[3])) return;
        const weight = stature(ci), arr = postings(ci), apps = DB.apps[ci], goals = DB.goals[ci];
        for (let i = 0; i < arr.length; i++) {
          if (apps[i] > 0) {
            DB.qMApps[arr[i]] += weight * apps[i];
            if (elite.has(c[3])) DB.qGlobalApps[arr[i]] += weight * apps[i];
          }
          if (goals[i] > 0 && !DB.gkSet.has(arr[i])) DB.qMGoals[arr[i]] += weight * goals[i];
        }
      });
      return DB.qPools = { star, sub, field: star.concat(sub), obs, any300, any100,
        elite: eliteClubs, marquee: marqueeClubs, easy: easyClubs,
        known: [...new Set([...star, ...DB.clubs.flatMap((c, i) => knownLegacy.has(c[3]) ? [i] : [])])] };
    }

    // Birth year is only a recency proxy, not evidence of a famous career. Smooth
    // decay avoids large score cliffs at birthdays.
    const qRecBonus = (age) => Math.max(10, 120 - Math.max(age - 28, 0) * 6);
    const qEra = (birth) => birth >= 1970 ? 1 : birth >= 1955 ? 0.85 : birth >= 1940 ? 0.65 : 0.45;
    function qFame(pid, clubs, audience = "european") {
      qPools();
      let apps = 0, goals = 0, mApps = DB.qMApps[pid], mGoals = DB.qMGoals[pid];
      for (const ci of clubs) {
        const weight = stature(ci), mq = marquee.has(DB.clubs[ci][3]);
        const a = qApps(ci, pid);
        if (a > 0) { apps += weight * a; if (mq) mApps -= weight * a; }
        const g = qGoals(ci, pid);
        if (g > 0) { goals += weight * g; if (mq) mGoals -= weight * g; }
      }
      const birth = DB.births[pid], age = birth ? DB.qYear - birth : 99;
      // Keepers gain visibility through appearances rather than goal totals.
      const appWeight = DB.gkSet.has(pid) ? 1.35 : 0.75;
      const rec = qRecBonus(age) * Math.min(1, (apps || 12) / 75);
      const career = appWeight * Math.min(Math.max(mApps, 0), 260) + 3 * Math.min(Math.max(mGoals, 0), 70);
      // Sustained exposure at major clubs survives retirement. This offsets era
      // decay without pretending that every old lower-division regular is known.
      const visibility = Math.min(DB.qGlobalApps[pid] / 400, 1);
      const legacy = 120 * visibility * Math.min(Math.max(age - 36, 0) / 10, 1);
      const fame = rec + qEra(birth) * (appWeight * Math.min(apps, 260) + 3 * Math.min(goals, 70) + 0.4 * career)
        + legacy + (DB.imgs[pid] ? 20 : 0);
      // Sustained exposure at internationally familiar clubs is stronger evidence
      // than scoring or accumulating appearances in a local or minor league.
      return fame * (0.65 + 0.35 * Math.min(DB.qGlobalApps[pid] / 200, 1));
    }
    // General fame does not make a short, forgotten spell easy to recall. Scale it
    // by the weakest documented link in the intersection; unknown historical totals
    // stay neutral because missing statistics are not evidence of a cameo.
    function qBridgeFame(pid, clubs, audience = "european") {
      // A third clue narrows the answer set. It cannot make a player's bridge
      // more familiar by merely adding another club's statistics to the total.
      if (clubs.length > 2) {
        let weakestPair = Infinity;
        for (let a = 0; a < clubs.length; a++) for (let b = a + 1; b < clubs.length; b++)
          weakestPair = Math.min(weakestPair, qBridgeFame(pid, [clubs[a], clubs[b]], audience));
        return weakestPair;
      }
      const knownApps = clubs.map(ci => qApps(ci, pid)).filter(n => n >= 0);
      if (!knownApps.length) return qFame(pid, clubs, audience);
      const weakest = Math.min(...knownApps);
      const confidence = QBRIDGE_FLOOR + (1 - QBRIDGE_FLOOR)
        * Math.sqrt(Math.min(weakest, QBRIDGE_FULL_APPS) / QBRIDGE_FULL_APPS);
      return qFame(pid, clubs, audience) * confidence;
    }
    const qRecognitionWeight = (fame) => Math.max(0,
      Math.min((fame - QBREADTH_MIN_FAME) / (QBREADTH_FULL_FAME - QBREADTH_MIN_FAME), 1));
    const qUsableName = (pid) => {
      const name = DB.names[pid] || "";
      return !!name && !/^[a-z][a-z0-9_.-]{2,}$/.test(name);
    };
    const qRecognisableBreadth = (clubs, answers, audience = "european") => answers.reduce((sum, pid) =>
      sum + (qUsableName(pid) ? qRecognitionWeight(qBridgeFame(pid, clubs, audience)) : 0), 0);
    function qEase(clubs, answers, audience = "european") {
      const top = [0, 0, 0, 0];
      let breadth = 0;
      for (const pid of answers) {
        if (!qUsableName(pid)) continue;
        let fame = qBridgeFame(pid, clubs, audience);
        breadth += qRecognitionWeight(fame);
        for (let k = 0; k < 4 && fame; k++) if (fame > top[k]) {
          const old = top[k]; top[k] = fame; fame = old;
        }
      }
      const support = (fame) => Math.max(fame - 250, 0);
      const f0 = top[0], f1 = top[1];
      const ease = f0 + 0.3 * support(f1) + 0.18 * support(top[2]) + 0.1 * support(top[3])
        + breadth * 2;
      // The remembered bridge determines difficulty. Club prestige and country
      // already inform player visibility; charging them again hid obvious links
      // such as Zidane's Bordeaux–Juventus career.
      return ease;
    }
    const playerIdentity = (pid) => `${DB.names[pid]}\u0000${DB.births[pid] || ""}\u0000${DB.nats[pid] || ""}`;
    // The accepted answer set: everyone the clubs turn up, deduped the way a guess
    // is matched (by identity). It includes players Wikidata registers with 0
    // appearances, since naming one is a correct answer.
    const qAnswerSet = (answers) => {
      const seen = new Set();
      return answers.filter(pid => {
        const key = playerIdentity(pid);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    // The difficulty candidate set: the accepted answers minus the 0-appearance
    // registrations, which must not make a stage look easier or harder than it is.
    const qEffective = (clubs, answers) => qAnswerSet(answers)
      .filter(pid => !clubs.some(ci => qApps(ci, pid) === 0));
    const qComboKey = (clubs) => clubs.slice().sort((a, b) => a - b).join(",");
    function qFamiliarAnswers(clubs, answers) {
      qPools();
      return answers.filter(pid => qUsableName(pid)
        && DB.qGlobalApps[pid] >= QFAMILIAR_MIN_GLOBAL_APPS
        && clubs.every(ci => qApps(ci, pid) >= QFAMILIAR_MIN_BRIDGE_APPS)
        && qBridgeFame(pid, clubs) >= QFAMILIAR_MIN_FAME);
    }
    const qEasyEligible = (clubs, answers) => (clubs.length === 2 || clubs.length === 3)
      && clubs.every(ci => easyClues.has(DB.clubs[ci][3]))
      && qFamiliarAnswers(clubs, answers).length >= QEASY_MIN_FAMILIAR;
    function classifyStage(stage) {
      const clubs = stage.clubs;
      if (!Array.isArray(clubs) || clubs.length < 2 || clubs.length > 3
          || new Set(clubs).size !== clubs.length
          || clubs.some(ci => !Number.isInteger(ci) || !DB.clubs[ci])) return -1;
      const effective = stage.effective || qEffective(clubs, stage.answers || intersect(clubs.map(postings)));
      if (!effective.length || !effective.some(qUsableName)) return -1;
      const ease = stage.ease ?? qEase(clubs, effective);
      if (ease >= QBOUNDARIES.easy && qEasyEligible(clubs, effective)) return 0;
      const pools = qPools();
      const anchored = clubs.some(ci => marquee.has(DB.clubs[ci][3])) && clubs.every(ci => pools.field.includes(ci));
      if (anchored && clubs.every(ci => pools.known.includes(ci))
          && ease >= QBOUNDARIES.medium && qFamiliarAnswers(clubs, effective).length) return 1;
      if (anchored && ease >= QBOUNDARIES.hard) return 2;
      return ease < QBOUNDARIES.hard ? 3 : -1;
    }
    const comboCache = new Map();
    function qComboInfo(clubs, audience = "european") {
      const key = `${audience}:${qComboKey(clubs)}`;
      let info = comboCache.get(key);
      if (!info) {
        const effective = qEffective(clubs, intersect(clubs.map(postings)));
        const face = qRanked({ clubs, answers: effective, effective, audience })[0] ?? -1;
        info = { n: effective.length, ease: qEase(clubs, effective, audience), face,
          familiar: qFamiliarAnswers(clubs, effective).length,
          b: face >= 0 && !!DB.births[face], named: face >= 0 && qUsableName(face) };
        info.level = classifyStage({ clubs, effective, ease: info.ease });
        comboCache.set(key, info);
      }
      return info;
    }
    function qRanked(stage) {
      const answers = stage.effective || stage.answers;
      return answers.slice().sort((a, b) => Number(qUsableName(b)) - Number(qUsableName(a))
        || qBridgeFame(b, stage.clubs, stage.audience) - qBridgeFame(a, stage.clubs, stage.audience) || a - b);
    }
    const qFace = (stage) => qRanked(stage)[0] ?? -1;
    const answerMatches = (pid, answers) => {
      const identity = playerIdentity(pid);
      return answers.some(answer => playerIdentity(answer) === identity);
    };
    const nextHintTarget = (stage, targets = []) => {
      const used = new Set(targets.filter(pid => pid !== null && pid !== undefined).map(playerIdentity));
      return qRanked(stage).find(pid => !used.has(playerIdentity(pid))) ?? null;
    };
    const careerCacheKey = (pid, date, stage, clubs) =>
      `${date}|${stage}|${pid}|${clubs.slice().sort((a, b) => a - b).join(",")}`;
    const careerViewKey = (date, stage, clubs) => `${date}|${stage}|${clubs.join(",")}`;
    function migrateState(state, stages, hintKinds = ["nat", "ini", "ini2"]) {
      if (!state || (state.v !== 1 && state.v !== 2)) return null;
      let identities;
      const resolveIdentity = (key, pid) => {
        if (Number.isInteger(pid) && pid >= 0 && pid < DB.names.length && playerIdentity(pid) === key) return pid;
        identities ||= new Map(DB.names.map((name, index) => [playerIdentity(index), index]));
        return identities.get(key) ?? null;
      };
      state.skipped ||= [];
      state.hints = Object.fromEntries(hintKinds.map(kind => [kind, state.hints?.[kind] ?? null]));
      state.hintTargets ||= {};
      for (const [kind, pid] of Object.entries(state.hintTargets)) {
        const key = state.hintTargetKeys?.[kind];
        if (key) state.hintTargets[kind] = resolveIdentity(key, pid);
        else if (state.built && state.built !== DB.built) delete state.hintTargets[kind];
      }
      for (const kind of ["ini", "ini2"]) {
        if (state.hints[kind] === null || kind in state.hintTargets) continue;
        const stageIndex = state.hints[kind], stage = stages?.[stageIndex];
        const targets = Object.entries(state.hintTargets)
          .filter(([key]) => state.hints[key] === stageIndex).map(([, pid]) => pid);
        state.hintTargets[kind] = stage ? nextHintTarget(stage, targets) : null;
      }
      state.guesses = (state.guesses || []).map(guess => {
        const valid = Number.isInteger(guess.pid) && guess.pid >= 0 && guess.pid < DB.names.length
          && DB.names[guess.pid] === guess.name;
        const birth = guess.birth ?? (valid ? DB.births[guess.pid] : 0);
        const nat = guess.nat ?? (valid ? DB.nats[guess.pid] : "");
        const key = guess.key || guess.identity || `${guess.name}\u0000${birth || ""}\u0000${nat || ""}`;
        return { ...guess, birth: birth || 0, nat: nat || "",
          key, pid: resolveIdentity(key, guess.pid) };
      });
      state.built = DB.built;
      state.v = 2;
      return state;
    }

    // Older archive rows kept only the four result codes and stage QIDs. Turn
    // that summary back into a terminal board so opening a played day does not
    // silently start it over. Exact guesses are available only on newer rows;
    // representative correct answers preserve the recorded stage outcomes.
    function restoreHistoryState(record, stages, meta = {}, hintKinds = ["nat", "ini", "ini2"]) {
      const res = record?.res;
      if (!Array.isArray(res) || res.length !== stages?.length
          || res.some(code => !Number.isInteger(code) || code < 0 || code > 3)) return null;
      let stage = res.length - 1;
      while (stage >= 0 && res[stage] === 3) stage--;
      if (stage < 0) return null;
      const won = res.at(-1) < 2;
      const hinted = res.map((code, i) => code === 1 ? i : -1).filter(i => i >= 0);
      const hints = Object.fromEntries(hintKinds.map((kind, i) => [kind, hinted[i] ?? null]));
      const guesses = [];
      res.forEach((code, i) => {
        if (code > 1) return;
        const pid = qFace(stages[i]);
        if (pid < 0) return;
        guesses.push({ name: DB.names[pid], birth: DB.births[pid] || 0, nat: DB.nats[pid] || "",
          key: playerIdentity(pid), pid, stage: i, ok: true });
      });
      return {
        v: 2, date: meta.date, num: record.num ?? meta.num, built: meta.built,
        stages: meta.stageQids || record.stages, stage: won ? res.length - 1 : stage,
        lives: 5, guesses, hints, hintTargets: {},
        skipped: res.map((code, i) => code === 2 && (won || i < stage) ? i : -1).filter(i => i >= 0),
        startedAt: meta.startedAt || Date.now(), done: true, won,
      };
    }

    function qLadders(rng) {
      const hard3 = rng() < Q3ODDS, impossible3 = rng() < Q3ODDS;
      const easy3 = rng() < QEASY3ODDS;
      const medium3 = rng() < QMEDIUM3ODDS;
      return [easy3 ? [...QEASY3, ...QEASY] : QEASY, medium3 ? [...QMEDIUM3, ...QMEDIUM] : QMEDIUM, hard3 ? [...QHARD3, ...QHARD] : QHARD,
        impossible3 ? [...QIMP3, ...QIMPOSSIBLE] : QIMPOSSIBLE];
    }
    const coveredCountries = new Set(DB.leagues.map(league => league[2]));
    const countryStratum = (ci) => {
      const country = leagueCC(ci);
      return coveredCountries.has(country) ? country : "other";
    };
    function chooseWeightedCountry(countries, clubCount, rng) {
      const total = countries.reduce((sum, country) => sum + Math.sqrt(clubCount(country)), 0);
      let draw = rng() * total;
      for (const country of countries) {
        draw -= Math.sqrt(clubCount(country));
        if (draw < 0) return country;
      }
      return countries.at(-1);
    }
    function chooseBalanced(candidates, rng, used, usedFaces, clubUse, countryUse, comboUse) {
      let choices = [...candidates.values()].sort((a, b) => {
        for (let i = 0; i < Math.max(a.clubs.length, b.clubs.length); i++) {
          const d = (a.clubs[i] ?? -1) - (b.clubs[i] ?? -1);
          if (d) return d;
        }
        return 0;
      });
      const fresh = choices.filter(candidate => !comboUse.has(qComboKey(candidate.clubs)));
      if (fresh.length) choices = fresh;
      const weights = choices.map(candidate => {
        const clubPressure = candidate.clubs.reduce((sum, ci) => sum + (clubUse.get(ci) || 0), 0);
        const countryPressure = candidate.clubs.reduce((sum, ci) =>
          sum + (countryUse.get(countryStratum(ci)) || 0), 0) / candidate.clubs.length;
        const previousUses = comboUse.get(qComboKey(candidate.clubs)) || 0;
        return 1 / ((1 + 2 * clubPressure) * Math.pow(1 + countryPressure, 2) * Math.pow(1 + previousUses, 2));
      });
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let draw = rng() * total, chosen = choices.at(-1);
      for (let i = 0; i < choices.length; i++) {
        draw -= weights[i];
        if (draw < 0) { chosen = choices[i]; break; }
      }
      chosen.clubs.forEach(ci => {
        used.add(ci);
        const country = countryStratum(ci);
        countryUse.set(country, (countryUse.get(country) || 0) + 1);
      });
      usedFaces.add(chosen.face);
      return chosen;
    }
    function countryPool(pool) {
      const byCountry = {};
      for (const ci of pool) {
        const stratum = countryStratum(ci);
        (byCountry[stratum] ??= []).push(ci);
      }
      const allCountries = Object.keys(byCountry).sort();
      const countries = allCountries.some(country => country !== "other")
        ? allCountries.filter(country => country !== "other") : allCountries;
      for (const clubs of Object.values(byCountry)) clubs.sort((left, right) => left - right);
      return { byCountry, countries };
    }
    function drawClubCountryFirst({ byCountry, countries }, rng) {
      const country = chooseWeightedCountry(countries, key => byCountry[key].length, rng);
      const clubs = byCountry[country];
      return clubs[rng() * clubs.length | 0];
    }
    let playerClubs;
    function thirdClubPool(clubs, available, minimumAnswers) {
      const answers = qEffective(clubs, intersect(clubs.map(postings)));
      if (answers.length < minimumAnswers) return [];
      if (!playerClubs) {
        playerClubs = Array.from({ length: DB.names.length }, () => []);
        DB.clubs.forEach((club, ci) => {
          const players = postings(ci);
          players.forEach((pid, i) => {
            if (DB.apps[ci][i] !== 0) playerClubs[pid].push(ci);
          });
        });
      }
      const shared = new Map();
      for (const pid of answers) for (const ci of playerClubs[pid])
        shared.set(ci, (shared.get(ci) || 0) + 1);
      return available.filter(ci => !clubs.includes(ci) && (shared.get(ci) || 0) >= minimumAnswers);
    }
    function buildStage(rng, ladder, level, used, usedFaces, banned, clubUse, countryUse, comboUse, allowFallback) {
      const pools = qPools();
      // The medium search groups contribute to one catalogue, rather than
      // letting a small first group hide every other valid intersection.
      const mergedCandidates = new Map();
      for (let tierIndex = 0; tierIndex < ladder.length; tierIndex++) {
        const tier = ladder[tierIndex];
        const available = tier.p.map(name => pools[name].filter(ci => !used.has(ci)));
        const slots = available.map(countryPool);
        const candidates = level === 1 ? mergedCandidates : new Map();
        for (let draw = 0; draw < QT && available.every(pool => pool.length); draw++) {
          const clubs = slots.slice(0, 2).map(pool => drawClubCountryFirst(pool, rng));
          if (new Set(clubs).size !== clubs.length) continue;
          if (slots.length === 3) {
            // Sample a third clue that can retain enough answers. Independent
            // draws disproportionately lose triples as historical pools widen.
            const third = thirdClubPool(clubs, available[2], tier.size[0]);
            if (!third.length) continue;
            clubs.push(drawClubCountryFirst(countryPool(third), rng));
          }
          const key = qComboKey(clubs);
          if (banned.has(key)) continue;
          const info = qComboInfo(clubs, tier.audience);
          if (!info.named || usedFaces.has(info.face)) continue;
          if (tier.familiar && info.familiar < tier.familiar) continue;
          if (info.n < tier.size[0] || info.n > tier.size[1]) continue;
          if (tier.birth && !info.b) continue;
          if (tier.ease && (info.ease < tier.ease[0] || info.ease >= tier.ease[1])) continue;
          if (info.level !== level) continue;
          candidates.set(key, { clubs, tier: tierIndex, face: info.face, audience: tier.audience || "european" });
        }
        const formatComplete = tierIndex === ladder.length - 1 || tier.p.length !== ladder[tierIndex + 1].p.length;
        if (candidates.size && (level !== 1 || formatComplete)) {
          const stage = chooseBalanced(candidates, rng, used, usedFaces, clubUse, countryUse, comboUse);
          const raw = intersect(stage.clubs.map(postings));
          const effective = qEffective(stage.clubs, raw);
          return { ...stage, answers: qAnswerSet(raw), effective, ease: qEase(stage.clubs, effective, stage.audience), fallback: false };
        }
      }
      if (!allowFallback) return null;
      const pairs = [];
      for (let x = 0; x < pools.star.length; x++) for (let y = x + 1; y < pools.star.length; y++) {
        const clubs = [pools.star[x], pools.star[y]];
        if (DB.clubs[clubs[0]][1] === DB.clubs[clubs[1]][1] && !used.has(clubs[0]) && !used.has(clubs[1])
            && !banned.has(qComboKey(clubs))) pairs.push(clubs);
      }
      for (let i = pairs.length - 1; i > 0; i--) {
        const j = rng() * (i + 1) | 0;
        [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
      }
      const candidates = new Map();
      for (const clubs of pairs) {
        const raw = intersect(clubs.map(postings));
        const effective = qEffective(clubs, raw);
        if (!effective.length) continue;
        const audience = ladder[0].audience || "european";
        const ease = qEase(clubs, effective, audience);
        if (classifyStage({ clubs, effective, ease }) !== level) continue;
        if (!ladder.some(tier => effective.length >= tier.size[0] && effective.length <= tier.size[1]
            && ease >= tier.ease[0] && ease < tier.ease[1]
            && (!tier.familiar || qFamiliarAnswers(clubs, effective).length >= tier.familiar))) continue;
        const face = qFace({ clubs, answers: effective, effective, audience });
        if (!qUsableName(face) || usedFaces.has(face)) continue;
        candidates.set(qComboKey(clubs), { clubs, answers: qAnswerSet(raw), effective, audience, ease, face, tier: -1, fallback: true });
      }
      return candidates.size ? chooseBalanced(candidates, rng, used, usedFaces, clubUse, countryUse, comboUse) : null;
    }

    function normalizePrevious(previousDays) {
      DB.byQid ||= new Map(DB.clubs.map((club, i) => [club[3], i]));
      const out = [];
      // A prior day may name a club this build has since dropped: that is a reason
      // to stop guarding on it, not to throw out of validation. Skip whatever does
      // not resolve to a club row in this dataset.
      for (const day of previousDays || []) {
        if (!day || typeof day.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)
            || !Array.isArray(day.stages)) continue;
        const stages = [];
        for (const stage of day.stages) {
          const raw = Array.isArray(stage) ? stage : stage?.clubs;
          if (!Array.isArray(raw)) continue;
          const clubs = [];
          let resolved = true;
          for (const club of raw) {
            const ci = typeof club === "string" ? DB.byQid.get(club) : club;
            if (!Number.isInteger(ci) || ci < 0 || ci >= DB.clubs.length) { resolved = false; break; }
            clubs.push(ci);
          }
          stages.push(resolved && clubs.length ? clubs : null);
        }
        out.push({ date: day.date, stages });
      }
      return out.sort((a, b) => a.date.localeCompare(b.date));
    }
    function guardsFor(date, previousDays) {
      const banned = new Set(), recentClubs = new Set(), recentFaces = new Set();
      const clubUse = new Map(), countryUse = new Map(), comboUse = new Map();
      for (const day of normalizePrevious(previousDays)) {
        const age = qNum(date) - qNum(day.date);
        if (age < 1) continue;
        for (const clubs of day.stages) {
          if (!clubs) continue;
          const key = qComboKey(clubs);
          comboUse.set(key, (comboUse.get(key) || 0) + 1);
          if (age > QCOMBO_DAYS) continue;
          banned.add(key);
          for (const ci of clubs) {
            if (age <= 2) recentClubs.add(ci);
            if (age <= QCLUB_SOFT_DAYS)
              clubUse.set(ci, (clubUse.get(ci) || 0) + QCLUB_SOFT_DAYS - age + 1);
            const country = countryStratum(ci);
            countryUse.set(country, (countryUse.get(country) || 0) + 1);
          }
          if (age <= QFACE_GUARD_DAYS) {
            const face = qComboInfo(clubs).face;
            if (face >= 0) recentFaces.add(face);
          }
        }
      }
      return { banned, recentClubs, recentFaces, clubUse, countryUse, comboUse };
    }
    const ordered = (stages) => stages.every((stage, i) => classifyStage(stage) === i);
    function attemptSlate(date, attempt, previousDays, allowFallback) {
      const rng = qRng(qHash(`${date}:${attempt}`));
      const { banned, recentClubs, recentFaces, clubUse, countryUse, comboUse } = guardsFor(date, previousDays);
      const used = new Set(recentClubs);
      const usedFaces = new Set(recentFaces);
      const stages = qLadders(rng).map((ladder, level) =>
        buildStage(rng, ladder, level, used, usedFaces, banned, clubUse, countryUse, comboUse, allowFallback));
      return stages.every(Boolean) ? stages : null;
    }
    function generate(date, options = {}) {
      const previousDays = options.previousDays || options.previous || [];
      const requireOrdered = options.requireOrdered !== false;
      const maxAttempts = options.maxAttempts || QMAX_ATTEMPTS;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const stages = attemptSlate(date, attempt, previousDays, false);
        if (stages && (!requireOrdered || ordered(stages)))
          return { date, num: qNum(date), attempt, stages };
      }
      if (options.allowFallback) {
        const attempt = maxAttempts;
        const stages = attemptSlate(date, attempt, previousDays, true);
        if (stages && (!requireOrdered || ordered(stages))) return { date, num: qNum(date), attempt,
          stages: stages.map(stage => ({ ...stage, fallback: true })) };
      }
      throw new Error(`quiz generation exhausted ${maxAttempts} attempts for ${date}`);
    }

    function stagesFromQids(rows) {
      if (!Array.isArray(rows) || !rows.length) return null;
      DB.byQid ||= new Map(DB.clubs.map((club, i) => [club[3], i]));
      const stages = rows.map((row, stageIndex) => {
        if (!Array.isArray(row) || row.length < 2 || row.length > 3) return null;
        const clubs = row.map(qid => DB.byQid.get(qid));
        if (clubs.some(ci => ci === undefined) || new Set(clubs).size !== clubs.length) return null;
        const raw = intersect(clubs.map(postings));
        const effective = qEffective(clubs, raw);
        const audience = "european";
        return effective.length ? { clubs, answers: qAnswerSet(raw), effective, audience,
          ease: qEase(clubs, effective, audience), tier: null, fallback: false } : null;
      });
      return stages.every(Boolean) ? stages : null;
    }
    const serializeStages = (stages) => stages.map(stage => stage.clubs.map(ci => DB.clubs[ci][3]));
    function stageDiagnostics(stage) {
      const effectiveAnswers = stage.effective || qEffective(stage.clubs, stage.answers || intersect(stage.clubs.map(postings)));
      const level = classifyStage({ ...stage, effective: effectiveAnswers });
      return {
        clubs: stage.clubs.slice(),
        qids: stage.clubs.map(ci => DB.clubs[ci][3]),
        country: leagueCC(stage.clubs[0]),
        countries: stage.clubs.map(countryStratum),
        effectiveAnswers: effectiveAnswers.slice(),
        effectiveCount: effectiveAnswers.length,
        audience: stage.audience || "european",
        recognisableBreadth: qRecognisableBreadth(stage.clubs, effectiveAnswers, stage.audience),
        ease: stage.ease ?? qEase(stage.clubs, effectiveAnswers, stage.audience),
        face: qFace({ ...stage, answers: effectiveAnswers, effective: effectiveAnswers }),
        tier: stage.tier ?? null,
        level,
        difficulty: QLEVELS[level] || null,
        familiar: qFamiliarAnswers(stage.clubs, effectiveAnswers).length,
        fallback: !!stage.fallback,
      };
    }
    function validateEntry(qidStages, options = {}) {
      if (!Array.isArray(qidStages) || qidStages.length !== 4)
        return { ok: false, errors: ["entry must contain exactly four stages"], stages: [] };
      const errors = [], stages = stagesFromQids(qidStages);
      if (!stages) errors.push("unresolvable, duplicate, or zero-effective stage");
      if (stages) {
        const all = stages.flatMap(stage => stage.clubs);
        if (new Set(all).size !== all.length) errors.push("club repeated within slate");
        if (options.requireOrder !== false || options.requireLevels || options.requireBands) {
          stages.forEach((stage, i) => {
            if (classifyStage(stage) === i) return;
            errors.push(`stage ${i + 1} does not meet the ${QLEVELS[i]} requirements`);
            if (i === 0)
              errors.push("easy stage needs globally familiar clubs and at least two familiar bridges");
            if (i === 1)
              errors.push("medium stage needs recognisable clubs and at least one familiar bridge, and must not be easy");
          });
        }
        const date = options.date;
        if (date) {
          const { banned, recentClubs, recentFaces } = guardsFor(date, options.previousDays || options.previous || []);
          for (const stage of stages) {
            if (banned.has(qComboKey(stage.clubs)))
              errors.push(`combination repeats within ${QCOMBO_DAYS} days: ${qComboKey(stage.clubs)}`);
            if (stage.clubs.some(ci => recentClubs.has(ci))) errors.push("club repeats within 2 days");
            const face = qFace(stage);
            if (!qUsableName(face)) errors.push("representative answer has an unusable player name");
            if (recentFaces.has(face)) errors.push(`representative answer repeats within ${QFACE_GUARD_DAYS} days`);
          }
        }
      }
      return { ok: errors.length === 0, errors, stages: stages || [] };
    }

    return {
      generate, qGen: generate, generateSlate: generate,
      validateEntry, validateScheduleEntry: validateEntry, stagesFromQids, serializeStages, stageDiagnostics,
      qHash, qRng, qNum, qShift, qPools, qApps, qGoals, appearanceGaps, qFame, qBridgeFame,
      qRecognitionWeight, qRecognisableBreadth, qUsableName, qEase,
      qEffective, effectiveAnswers: qEffective, qAnswerSet, answerSet: qAnswerSet,
      qComboInfo, qComboKey, qFamiliarAnswers, qEasyEligible, classifyStage, qRanked, rankedAnswers: qRanked,
      qFace, face: qFace, playerIdentity, answerMatches, nextHintTarget, migrateState, restoreHistoryState,
      careerCacheKey, careerViewKey, clubCountry: leagueCC,
      resetCaches: () => comboCache.clear(),
      constants: { QEPOCH, QT, QCOMBO_DAYS, QMAX_ATTEMPTS, Q3ODDS, QEASY3ODDS, QMEDIUM3ODDS, QLEVELS,
        QBRIDGE_FULL_APPS, QBRIDGE_FLOOR, QBREADTH_MIN_FAME, QBREADTH_FULL_FAME,
        QFACE_GUARD_DAYS, QCLUB_SOFT_DAYS, QBOUNDARIES, QEASY_MIN_FAMILIAR,
        QFAMILIAR_MIN_FAME, QFAMILIAR_MIN_GLOBAL_APPS, QFAMILIAR_MIN_BRIDGE_APPS,
        QEASY, QEASY3, QMEDIUM, QMEDIUM3, QHARD, QIMPOSSIBLE, QHARD3, QIMP3 },
    };
  }

  return { createQuizCore, MARQUEE_QIDS, ELITE_QIDS, EASY_QIDS, KNOWN_LEGACY_QIDS };
});
