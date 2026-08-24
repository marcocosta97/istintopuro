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

  const QEPOCH = Date.UTC(2026, 7, 21);
  const QT = 240;
  const QWIN = 90;
  const QCOMBO_DAYS = 30;
  const QMAX_ATTEMPTS = 64;
  const Q3ODDS = 0.5;
  const QEASY = [
    { p: ["star", "field"], size: [2, 1e9], ease: [545, 1e9] },
    { p: ["star", "field"], size: [2, 1e9], ease: [505, 1e9] },
    { p: ["star", "field"], size: [2, 1e9], ease: [470, 1e9] },
  ];
  const QMEDIUM = [
    { p: ["star", "field"], size: [3, 1e9], ease: [425, 545] },
    { p: ["star", "field"], size: [3, 1e9], ease: [390, 545] },
    { p: ["star", "field"], size: [2, 1e9], ease: [350, 570] },
  ];
  const QHARD = [
    { p: ["field", "field"], size: [2, 12], ease: [140, 370] },
    { p: ["field", "field"], size: [2, 15], ease: [90, 400] },
    { p: ["field", "field"], size: [2, 20], ease: [0, 425] },
  ];
  const QIMPOSSIBLE = [
    { p: ["obs", "any300"], size: [1, 2], ease: [-1e9, 360], birth: 1 },
    { p: ["obs", "any300"], size: [1, 2], ease: [-1e9, 400] },
    { p: ["obs", "any100"], size: [1, 3], ease: [-1e9, 440] },
  ];
  const QHARD3 = [
    { p: ["field", "field", "field"], size: [2, 12], ease: [140, 370] },
    { p: ["field", "field", "field"], size: [2, 15], ease: [90, 400] },
  ];
  const QIMP3 = [
    { p: ["obs", "any300", "any300"], size: [1, 2], ease: [-1e9, 360], birth: 1 },
    { p: ["obs", "any300", "any100"], size: [1, 3], ease: [-1e9, 440] },
  ];

  function createQuizCore(deps) {
    const { DB, postings, intersect, stature, leagueCC } = deps;
    const marquee = deps.marquee || new Set(MARQUEE_QIDS);
    if (!DB || !postings || !intersect || !stature || !leagueCC)
      throw new TypeError("createQuizCore requires DB, postings, intersect, stature and leagueCC");

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

    function qApps(ci, pid) {
      const arr = postings(ci);
      let lo = 0, hi = arr.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (arr[m] === pid) return DB.apps[ci][m];
        if (arr[m] < pid) lo = m + 1; else hi = m - 1;
      }
      return -1;
    }
    function qGoals(ci, pid) {
      if (DB.gkSet.has(pid)) return 0;
      const arr = postings(ci), goals = DB.goals[ci];
      let lo = 0, hi = arr.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (arr[m] === pid) return goals[m];
        if (arr[m] < pid) lo = m + 1; else hi = m - 1;
      }
      return -1;
    }
    const appearanceGaps = (pid, clubs) => ({
      missing: clubs.filter(ci => qApps(ci, pid) < 0),
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
      const star = [], sub = [], obs = [], any300 = [], any100 = [];
      DB.clubs.forEach((c, i) => {
        const n = DB.postings[i].length;
        const topDiv = !c[4] && DB.topLeagues.has(c[5] ?? -1);
        if (n < 30) return;
        if (topDiv && n >= 400) star.push(i);
        if (!c[4] && (c[5] ?? -1) >= 0 && n >= 120 && n < 400) sub.push(i);
        if (n < 250) obs.push(i);
        if (n >= 300) any300.push(i);
        if (n >= 100) any100.push(i);
      });
      DB.qMApps = new Float32Array(DB.names.length);
      DB.qMGoals = new Float32Array(DB.names.length);
      DB.clubs.forEach((c, ci) => {
        if (!marquee.has(c[3])) return;
        const weight = stature(ci), arr = postings(ci), apps = DB.apps[ci], goals = DB.goals[ci];
        for (let i = 0; i < arr.length; i++) {
          if (apps[i] > 0) DB.qMApps[arr[i]] += weight * apps[i];
          if (goals[i] > 0 && !DB.gkSet.has(arr[i])) DB.qMGoals[arr[i]] += weight * goals[i];
        }
      });
      return DB.qPools = { star, sub, field: star.concat(sub), obs, any300, any100 };
    }

    const qRecBonus = (age) => age <= 28 ? 200 : age <= 32 ? 150 : age <= 36 ? 90 : age <= 41 ? 45 : 10;
    const qEra = (birth) => birth >= 1970 ? 1 : birth >= 1955 ? 0.85 : birth >= 1940 ? 0.65 : 0.45;
    function qFame(pid, clubs) {
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
      const rec = qRecBonus(age) * Math.min(1, (apps || 12) / 25);
      const career = 0.75 * Math.min(Math.max(mApps, 0), 260) + 3 * Math.min(Math.max(mGoals, 0), 70);
      return rec + qEra(birth) * (0.75 * Math.min(apps, 260) + 3 * Math.min(goals, 70) + 0.4 * career)
        + (DB.imgs[pid] ? 20 : 0);
    }
    const qLeagueEase = (ci) => {
      const cc = leagueCC(ci);
      return cc === "DE" || cc === "FR" ? 0.93 : 1;
    };
    function qEase(clubs, answers) {
      const top = [0, 0, 0, 0];
      for (const pid of answers) {
        let fame = qFame(pid, clubs);
        for (let k = 0; k < 4 && fame; k++) if (fame > top[k]) {
          const old = top[k]; top[k] = fame; fame = old;
        }
      }
      const support = (fame) => Math.max(fame - 250, 0);
      const f0 = top[0], f1 = top[1];
      let ease = f0 + 0.3 * support(f1) + 0.18 * support(top[2]) + 0.1 * support(top[3])
        + Math.min(answers.length, 25) * 2;
      const ratio = clubs.filter(ci => marquee.has(DB.clubs[ci][3])).length / clubs.length;
      if (ratio < 1 && f1 < 430)
        ease -= Math.min((430 - f1) * 1.5, 150) * Math.min((1 - ratio) * 2, 1);
      ease *= Math.pow(clubs.reduce((n, ci) => n * qLeagueEase(ci), 1), 2 / clubs.length);
      if (ease >= 500) ease += ratio === 1 ? 35 : -(1 - ratio) * 90;
      return ease;
    }
    const playerIdentity = (pid) => `${DB.names[pid]}\u0000${DB.births[pid] || ""}\u0000${DB.nats[pid] || ""}`;
    const qEffective = (clubs, answers) => {
      const seen = new Set();
      return answers.filter(pid => {
        if (clubs.some(ci => qApps(ci, pid) === 0)) return false;
        const key = playerIdentity(pid);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const qComboKey = (clubs) => clubs.slice().sort((a, b) => a - b).join(",");
    const comboCache = new Map();
    function qComboInfo(clubs) {
      const key = qComboKey(clubs);
      let info = comboCache.get(key);
      if (!info) {
        const effective = qEffective(clubs, intersect(clubs.map(postings)));
        info = { n: effective.length, ease: qEase(clubs, effective), b: !!(effective.length && DB.births[effective[0]]) };
        comboCache.set(key, info);
      }
      return info;
    }
    function qRanked(stage) {
      const answers = stage.effective || stage.answers;
      return answers.slice().sort((a, b) => qFame(b, stage.clubs) - qFame(a, stage.clubs) || a - b);
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
      state.skipped ||= [];
      state.hints = Object.fromEntries(hintKinds.map(kind => [kind, state.hints?.[kind] ?? null]));
      state.hintTargets ||= {};
      for (const kind of ["ini", "ini2"]) {
        if (state.hints[kind] === null || kind in state.hintTargets) continue;
        const stageIndex = state.hints[kind], stage = stages?.[stageIndex];
        const targets = Object.entries(state.hintTargets)
          .filter(([key]) => state.hints[key] === stageIndex).map(([, pid]) => pid);
        state.hintTargets[kind] = stage ? nextHintTarget(stage, targets) : null;
      }
      state.guesses = (state.guesses || []).map(guess => {
        if (guess.key) return guess;
        if (guess.identity) return { ...guess, key: guess.identity };
        const valid = Number.isInteger(guess.pid) && guess.pid >= 0 && guess.pid < DB.names.length;
        const birth = valid ? DB.births[guess.pid] : guess.birth;
        const nat = valid ? DB.nats[guess.pid] : guess.nat;
        return { ...guess, birth: birth || 0, nat: nat || "",
          key: `${guess.name}\u0000${birth || ""}\u0000${nat || ""}` };
      });
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
      return [QEASY, QMEDIUM, hard3 ? [...QHARD3, ...QHARD] : QHARD,
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
    function chooseCountryFirst(candidates, rng, used) {
      const byCountry = {};
      for (const candidate of candidates.values()) {
        const country = countryStratum(candidate.clubs[0]);
        const club = candidate.clubs[0];
        ((byCountry[country] ??= {})[club] ??= []).push(candidate);
      }
      const allCountries = Object.keys(byCountry).sort();
      const countries = allCountries.some(country => country !== "other")
        ? allCountries.filter(country => country !== "other") : allCountries;
      if (!countries.length) return null;
      const country = chooseWeightedCountry(countries, key => Object.keys(byCountry[key]).length, rng);
      const clubs = Object.keys(byCountry[country]).map(Number).sort((a, b) => a - b);
      const club = clubs[rng() * clubs.length | 0];
      const choices = byCountry[country][club].sort((a, b) => {
        for (let i = 0; i < Math.max(a.clubs.length, b.clubs.length); i++) {
          const d = (a.clubs[i] ?? -1) - (b.clubs[i] ?? -1);
          if (d) return d;
        }
        return 0;
      });
      const chosen = choices[rng() * choices.length | 0];
      chosen.clubs.forEach(ci => used.add(ci));
      return chosen;
    }
    function drawClubCountryFirst(pool, rng) {
      const byCountry = {};
      for (const ci of pool) {
        const stratum = countryStratum(ci);
        (byCountry[stratum] ??= []).push(ci);
      }
      const allCountries = Object.keys(byCountry).sort();
      const countries = allCountries.some(country => country !== "other")
        ? allCountries.filter(country => country !== "other") : allCountries;
      const country = chooseWeightedCountry(countries, key => byCountry[key].length, rng);
      const clubs = byCountry[country].sort((a, b) => a - b);
      return clubs[rng() * clubs.length | 0];
    }
    function buildStage(rng, ladder, used, banned, allowFallback) {
      const pools = qPools();
      for (let tierIndex = 0; tierIndex < ladder.length; tierIndex++) {
        const tier = ladder[tierIndex];
        const slots = tier.p.map(name => pools[name].filter(ci => !used.has(ci)));
        if (slots.some((pool, i) => pool.length < i + 1)) continue;
        const candidates = new Map();
        for (let draw = 0; draw < QT; draw++) {
          const clubs = slots.map(pool => drawClubCountryFirst(pool, rng));
          if (new Set(clubs).size !== clubs.length) continue;
          const key = qComboKey(clubs);
          if (banned.has(key)) continue;
          const info = qComboInfo(clubs);
          if (info.n < tier.size[0] || info.n > tier.size[1]) continue;
          if (tier.birth && !info.b) continue;
          if (tier.ease && (info.ease < tier.ease[0] || info.ease >= tier.ease[1])) continue;
          candidates.set(key, { clubs, tier: tierIndex });
        }
        if (candidates.size) {
          const stage = chooseCountryFirst(candidates, rng, used);
          const effective = qEffective(stage.clubs, intersect(stage.clubs.map(postings)));
          return { ...stage, answers: effective, effective, ease: qEase(stage.clubs, effective), fallback: false };
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
      for (const clubs of pairs) {
        const effective = qEffective(clubs, intersect(clubs.map(postings)));
        if (!effective.length) continue;
        clubs.forEach(ci => used.add(ci));
        return { clubs, answers: effective, effective, ease: qEase(clubs, effective), tier: -1, fallback: true };
      }
      return null;
    }

    function normalizePrevious(previousDays) {
      DB.byQid ||= new Map(DB.clubs.map((club, i) => [club[3], i]));
      return (previousDays || []).map(day => ({
        date: day.date,
        stages: (day.stages || []).map(stage => (Array.isArray(stage) ? stage : stage.clubs)
          .map(club => {
            const ci = typeof club === "string" ? DB.byQid.get(club) : club;
            if (ci === undefined) throw new Error(`unknown club in previous schedule: ${club}`);
            return ci;
          })),
      })).sort((a, b) => a.date.localeCompare(b.date));
    }
    function guardsFor(date, previousDays) {
      const banned = new Set(), recentClubs = new Set();
      for (const day of normalizePrevious(previousDays)) {
        const age = qNum(date) - qNum(day.date);
        if (age < 1 || age > QCOMBO_DAYS) continue;
        for (const clubs of day.stages) {
          banned.add(qComboKey(clubs));
          if (age <= 2) clubs.forEach(ci => recentClubs.add(ci));
        }
      }
      return { banned, recentClubs };
    }
    const ordered = (stages) => stages.every((stage, i) => !i || stages[i - 1].ease > stage.ease);
    function attemptSlate(date, attempt, previousDays, allowFallback) {
      const rng = qRng(qHash(`${date}:${attempt}`));
      const { banned, recentClubs } = guardsFor(date, previousDays);
      const used = new Set(recentClubs);
      const stages = qLadders(rng).map(ladder => buildStage(rng, ladder, used, banned, allowFallback));
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
        if (stages) return { date, num: qNum(date), attempt,
          stages: stages.map(stage => ({ ...stage, fallback: true })) };
      }
      throw new Error(`quiz generation exhausted ${maxAttempts} attempts for ${date}`);
    }

    function stagesFromQids(rows) {
      if (!Array.isArray(rows)) return null;
      DB.byQid ||= new Map(DB.clubs.map((club, i) => [club[3], i]));
      const stages = rows.map(row => {
        if (!Array.isArray(row)) return null;
        const clubs = row.map(qid => DB.byQid.get(qid));
        if (clubs.some(ci => ci === undefined) || new Set(clubs).size !== clubs.length) return null;
        const effective = qEffective(clubs, intersect(clubs.map(postings)));
        return effective.length ? { clubs, answers: effective, effective, ease: qEase(clubs, effective), tier: null, fallback: false } : null;
      });
      return stages.every(Boolean) ? stages : null;
    }
    const serializeStages = (stages) => stages.map(stage => stage.clubs.map(ci => DB.clubs[ci][3]));
    function stageDiagnostics(stage) {
      const effectiveAnswers = stage.effective || qEffective(stage.clubs, stage.answers || intersect(stage.clubs.map(postings)));
      return {
        clubs: stage.clubs.slice(),
        qids: stage.clubs.map(ci => DB.clubs[ci][3]),
        country: leagueCC(stage.clubs[0]),
        effectiveAnswers: effectiveAnswers.slice(),
        effectiveCount: effectiveAnswers.length,
        ease: stage.ease ?? qEase(stage.clubs, effectiveAnswers),
        face: qFace({ clubs: stage.clubs, answers: effectiveAnswers, effective: effectiveAnswers }),
        tier: stage.tier ?? null,
        fallback: !!stage.fallback,
      };
    }
    function validateEntry(qidStages, options = {}) {
      const errors = [], stages = stagesFromQids(qidStages);
      if (!stages) errors.push("unresolvable, duplicate, or zero-effective stage");
      if (stages) {
        const all = stages.flatMap(stage => stage.clubs);
        if (new Set(all).size !== all.length) errors.push("club repeated within slate");
        if (options.requireOrder !== false && !ordered(stages)) errors.push("stage ease is not strictly descending");
        const date = options.date;
        if (date) {
          const { banned, recentClubs } = guardsFor(date, options.previousDays || options.previous || []);
          for (const stage of stages) {
            if (banned.has(qComboKey(stage.clubs)))
              errors.push(`combination repeats within ${QCOMBO_DAYS} days: ${qComboKey(stage.clubs)}`);
            if (stage.clubs.some(ci => recentClubs.has(ci))) errors.push("club repeats within 2 days");
          }
        }
      }
      return { ok: errors.length === 0, errors, stages: stages || [] };
    }

    return {
      generate, qGen: generate, generateSlate: generate,
      validateEntry, validateScheduleEntry: validateEntry, stagesFromQids, serializeStages, stageDiagnostics,
      qHash, qRng, qNum, qShift, qPools, qApps, qGoals, appearanceGaps, qFame, qEase,
      qEffective, effectiveAnswers: qEffective, qComboInfo, qComboKey, qRanked, rankedAnswers: qRanked,
      qFace, face: qFace, playerIdentity, answerMatches, nextHintTarget, migrateState, restoreHistoryState,
      careerCacheKey, careerViewKey, clubCountry: leagueCC,
      resetCaches: () => comboCache.clear(),
      constants: { QEPOCH, QT, QWIN, QCOMBO_DAYS, QMAX_ATTEMPTS, Q3ODDS,
        QEASY, QMEDIUM, QHARD, QIMPOSSIBLE, QHARD3, QIMP3 },
    };
  }

  return { createQuizCore, MARQUEE_QIDS };
});
