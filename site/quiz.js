"use strict";
/* Istinto Puro — daily quiz ("schedina"): four club intersections, easy to
   impossible, one puzzle per calendar date. Classic script loaded after app.js:
   both share the global scope, so DB, postings(), intersect(), playerMatches()
   and the other solver helpers are used directly, nothing is exported. */

// ---------------------------------------------------------------- seeded PRNG
// every user on the same dataset build must see the same puzzle: all draws
// flow from one stream seeded by the date, no Math.random anywhere here
const qHash = (s) => {  // FNV-1a
  let h = 0x811c9dc5;
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
};
const qRng = (a) => () => {  // mulberry32
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const qFmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const qToday = () => qFmt(new Date());  // local date: the puzzle flips at the player's midnight
const QEPOCH = Date.UTC(2026, 6, 20);   // quiz #1 = Monday 2026-07-20 (launch day)
const qNum = (date) => {  // parse by hand: new Date(string) is a timezone trap
  const [y, m, d] = date.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - QEPOCH) / 864e5 + 1;
};
const qStarted = () => qNum(qToday()) >= 1;  // false before launch day → "starts soon" screen
const qLaunchLabel = () => {  // e.g. "lunedì 20 luglio" for the pre-launch message
  try { return new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long" }).format(new Date(2026, 6, 20)); }
  catch { return "2026-07-20"; }
};

// ---------------------------------------------------------------- generator
// The continent's marquee clubs — the ones a general fan recognises, so a player
// there is widely visible. Squad-size coverage in Wikidata can't tell a giant
// (Napoli, Man Utd) from a well-documented mid club (Deportivo), so club stature
// leans on this curated set; prestige, unlike league position, rarely changes.
const QMARQUEE = new Set([
  "Q1422", "Q631", "Q1543", "Q2641", "Q2739", "Q2609", "Q2052",                          // IT
  "Q8682", "Q7156", "Q8701", "Q10329", "Q10333", "Q12297", "Q8687", "Q10315",            // ES
  "Q15789", "Q41420", "Q104761", "Q702455", "Q32494", "Q38245", "Q101959",               // DE
  "Q483020", "Q132885", "Q704", "Q180305", "Q19516",                                     // FR
  "Q18656", "Q50602", "Q1130849", "Q9617", "Q9616", "Q18741", "Q18716", "Q18711", "Q5794", "Q18747", "Q1128631", // GB
]);
// Difficulty is driven by the ANSWER SET, not club reputation: a pair is easy
// when its shared players include a household name (a legend with many caps, a
// prolific scorer, or a current star) — which is why Real Madrid × Milan (Seedorf)
// or Napoli × Man United (McTominay) play easy despite small intersections, while
// two mid clubs whose only overlap is journeymen play hard. Each stage buckets by
// a computed `ease` score; drawing from broad pools keeps clubs varied day to day.
// Pools in index order (stable within a build). Roster >= 30 is the fairness floor.
function qPools() {
  if (DB.qPools) return DB.qPools;
  DB.topLeagues ||= new Set(DB.leagues.reduce((a, l, i) =>
    (i === 0 || DB.leagues[i - 1][2] !== l[2]) ? (a.push(i), a) : a, []));
  DB.qYear = +(DB.built || "").slice(0, 4) || new Date().getFullYear();
  if (!DB.gkSet) { DB.gkSet = new Set(); let a = 0; for (const d of DB.gks || []) DB.gkSet.add(a += d); }
  const star = [], sub = [], obs = [], any300 = [], any100 = [];
  DB.clubs.forEach((c, i) => {
    const n = DB.postings[i].length, topDiv = !c[4] && DB.topLeagues.has(c[5] ?? -1);
    if (n < 30) return;
    if (topDiv && n >= 400) star.push(i);                                 // a big top-flight club
    if (!c[4] && (c[5] ?? -1) >= 0 && n >= 120 && n < 400) sub.push(i);   // a lesser covered club
    if (n < 250) obs.push(i);  // dissolved and out-of-league clubs welcome
    if (n >= 300) any300.push(i);
    if (n >= 100) any100.push(i);
  });
  // stature (weights a player's fame): marquee clubs top the scale; everyone else
  // is ranked by squad size WITHIN their own country (so the coverage bias doesn't
  // matter) and capped below marquee — a big-for-its-league club still scores well.
  const byC = {};
  DB.clubs.forEach((c, i) => { if (DB.postings[i].length >= 120) (byC[qLeagueCC(i)] ??= []).push(i); });
  DB.qStat = new Map();
  for (const cc in byC) {
    const arr = byC[cc].sort((a, b) => DB.postings[a].length - DB.postings[b].length);
    arr.forEach((ci, idx) => {
      const pct = arr.length > 1 ? idx / (arr.length - 1) : 1;  // 0 smallest … 1 biggest in league
      DB.qStat.set(ci, QMARQUEE.has(DB.clubs[ci][3]) ? 1.15 : pct >= 0.6 ? 1 : pct >= 0.3 ? 0.82 : 0.66);
    });
  }
  return DB.qPools = { star, sub, field: star.concat(sub), obs, any300, any100 };
}
const qStature = (ci) => DB.qStat.get(ci) ?? 0.66;

// goals of pid at club ci (0 for goalkeepers — their goal qualifiers are unreliable)
function qGoals(ci, pid) {
  if (DB.gkSet.has(pid)) return 0;
  const arr = postings(ci), g = DB.goals[ci];
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] === pid) return g[m]; if (arr[m] < pid) lo = m + 1; else hi = m - 1; }
  return -1;
}
// how recognisable an answer is: apps (a club legend / long-server), goals (a
// prolific scorer), age (a current or recent player is known to casual fans), and
// having a Commons photo (a rough notability signal). Weights tuned in probe5.js.
// Recognisability drives difficulty, and recency is its strongest signal: a
// current/recent player is known to casual fans, whereas a prolific scorer or
// long-server from decades ago is not — so recency leads, with appearances and
// goals as support that can't by themselves make an ancient name "famous".
const qRecBonus = (age) => age <= 28 ? 200 : age <= 32 ? 150 : age <= 36 ? 90 : age <= 41 ? 45 : 10;
// appearances at a big, widely-followed club make a player more recognisable
// than the same tally at a small one — so Lucas Pérez at Deportivo/Cádiz weighs
// less than McTominay at Man Utd/Napoli. Combines club reputation WITH the answer
// set, not either alone. Stature (qStature) is league-normalised, set in qPools.
function qFame(pid, clubs) {
  let apps = 0, goals = 0;
  for (const ci of clubs) {
    const w = qStature(ci);
    const a = qApps(ci, pid); if (a > 0) apps += w * a;
    const g = qGoals(ci, pid); if (g > 0) goals += w * g;
  }
  const age = DB.births[pid] ? DB.qYear - DB.births[pid] : 99;
  return qRecBonus(age) + 0.75 * Math.min(apps, 260) + 3 * Math.min(goals, 70) + (DB.imgs[pid] ? 20 : 0);
}
// puzzle ease: the most famous answer, plus a little for a second star and set
// size. But an easy puzzle should be two legendary clubs OR more than one
// recognisable player — a lone star at a non-giant pair (Marseille × Toulouse for
// Gignac) is knocked down out of the easy band unless a famous SECOND answer backs
// it up. f0 = top fame, f1 = second.
function qEase(clubs, answers) {
  let f0 = 0, f1 = 0;
  for (const p of answers) { const f = qFame(p, clubs); if (f > f0) { f1 = f0; f0 = f; } else if (f > f1) f1 = f; }
  let e = f0 + 0.25 * f1 + Math.min(answers.length, 25) * 2;
  const nMarquee = (QMARQUEE.has(DB.clubs[clubs[0]][3]) ? 1 : 0) + (QMARQUEE.has(DB.clubs[clubs[1]][3]) ? 1 : 0);
  if (nMarquee < 2 && f1 < 430) e -= Math.min((430 - f1) * 1.5, 150);  // lone-star penalty
  // the Bundesliga and Ligue 1 are less globally followed — their players are
  // harder to place, so those pairs read a notch harder (compounds when both are)
  e *= qLeagueEase(clubs[0]) * qLeagueEase(clubs[1]);
  // easy leans on legend TEAMS more than on a lone legend player from a non-legend
  // club: only near the easy line, boost two-marquee pairs and demote pairs missing
  // a giant. Below this zone (all of medium/hard) nothing changes.
  if (e >= 500) e += nMarquee === 2 ? 35 : -(2 - nMarquee) * 45;
  return e;
}
const qLeagueEase = (ci) => { const cc = qLeagueCC(ci); return cc === "DE" || cc === "FR" ? 0.93 : 1; };
// the "real" answers for difficulty: drop players with a KNOWN 0 appearances at
// one of the clubs (they were registered but never played — nobody thinks of
// them). They stay guessable in play, but a puzzle whose only overlap is such
// players counts as no solution. apps === 0 is known-zero; -1 is unknown (kept).
const qEffective = (clubs, answers) => answers.filter(p => !clubs.some(ci => qApps(ci, p) === 0));

// per-stage constraint ladders: QT seeded attempts per tier, then relax. This
// table is the whole difficulty tuning surface — rerun quizDebug() after
// touching it or a dataset refresh. Fields per tier:
//   p      the two clubs' pools ("star" big club, "field" = star ∪ sub, etc.)
//   size   [min, max] answer-set size
//   ease   [min, max) qEase band (absent = any); bands measured in probe5.js —
//          same-country star pairs sit ~470-870, cross-country ones span 80-750
//   birth  the lone answer needs a known birth year (identikit hint fuel)
const QT = 240;
const QEASY = [  // a recognisable name (recent star or icon) at a widely-followed club
  { p: ["star", "field"], size: [2, 1e9], ease: [570, 1e9] },
  { p: ["star", "field"], size: [2, 1e9], ease: [510, 1e9] },
  { p: ["star", "field"], size: [2, 1e9], ease: [450, 1e9] },
];
const QMEDIUM = [
  { p: ["star", "field"], size: [3, 1e9], ease: [400, 570] },
  { p: ["star", "field"], size: [3, 1e9], ease: [340, 570] },
  { p: ["star", "field"], size: [2, 1e9], ease: [290, 620] },
];
const QHARD = [  // small overlap of unremarkable players — no star to grab onto
  { p: ["field", "field"], size: [2, 12], ease: [180, 400] },
  { p: ["field", "field"], size: [2, 15], ease: [120, 450] },
  { p: ["field", "field"], size: [2, 20], ease: [0, 520] },
];
const QIMPOSSIBLE = [
  { p: ["obs", "any300"], size: [1, 1], birth: 1 },
  { p: ["obs", "any300"], size: [1, 1] },
  { p: ["obs", "any100"], size: [1, 2] },
];

// balance across the leagues that produced a candidate, then pick UNIFORMLY within
// the league — with a wide in-band pool this spreads clubs so none recurs daily
// group by the club's LEAGUE country, not its nationality, so Monaco (code "MC",
// plays in Ligue 1) balances with the other French clubs instead of monopolising
// a slot of its own
const qLeagueCC = (ci) => { const c = DB.clubs[ci]; return c[5] >= 0 ? DB.leagues[c[5]][2] : c[1]; };
function qChoose(cands, rng, used) {
  const byCC = {};
  for (const c of cands.values()) (byCC[qLeagueCC(c.clubs[0])] ??= []).push(c);
  const ccs = Object.keys(byCC).sort();
  const arr = byCC[ccs[rng() * ccs.length | 0]].sort((a, b) => a.clubs[0] - b.clubs[0] || a.clubs[1] - b.clubs[1]);
  const best = arr[rng() * arr.length | 0];
  best.clubs.forEach(i => used.add(i));
  return best;
}

function qStage(rng, ladder, used) {
  const P = qPools();
  for (let ti = 0; ti < ladder.length; ti++) {
    const tier = ladder[ti];
    const A = P[tier.p[0]].filter(i => !used.has(i));       // pools don't change within a tier
    const B = P[tier.p[1]].filter(i => !used.has(i));
    if (!A.length || B.length < 2) continue;
    const cands = new Map();  // in-band fits this tier, deduped by pair
    for (let a = 0; a < QT; a++) {
      const c0 = A[rng() * A.length | 0];
      const c1 = B[rng() * B.length | 0];
      if (c0 === c1) continue;
      // I = every shared player (all guessable); eff = those who actually played,
      // which is what sizing and difficulty judge
      const clubs = [c0, c1], I = intersect(clubs.map(postings)), eff = qEffective(clubs, I);
      if (eff.length < tier.size[0] || eff.length > tier.size[1]) continue;
      if (tier.birth && !DB.births[eff[0]]) continue;
      if (tier.ease) { const e = qEase(clubs, eff); if (e < tier.ease[0] || e >= tier.ease[1]) continue; }
      cands.set(c0 < c1 ? c0 + "," + c1 : c1 + "," + c0, { clubs, answers: I, tier: ti });
    }
    if (cands.size) return qChoose(cands, rng, used);
  }
  // guaranteed fallback: first non-empty unused same-country star pair, seeded order
  const pairs = [];
  for (let x = 0; x < P.star.length; x++) for (let y = x + 1; y < P.star.length; y++) {
    const [a, b] = [P.star[x], P.star[y]];
    if (DB.clubs[a][1] === DB.clubs[b][1] && !used.has(a) && !used.has(b)) pairs.push([a, b]);
  }
  for (let i = pairs.length - 1; i > 0; i--) { const j = rng() * (i + 1) | 0; [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
  for (const p of pairs) {
    const I = intersect(p.map(postings));
    if (I.length) { p.forEach(i => used.add(i)); return { clubs: p, answers: I, tier: -1 }; }
  }
}

function qGen(date) {
  const rng = qRng(qHash(date)), used = new Set();
  const ladders = [QEASY, QMEDIUM, QHARD, QIMPOSSIBLE];
  return { date, num: qNum(date), stages: ladders.map(l => qStage(rng, l, used)) };
}

// apps of player pid at club ci (the parallel stat arrays align with postings order)
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
// identikit hint / reveal representative: the stage's most recognisable answer
// (highest fame), ties to the lowest pid. No rng at play time: same for everyone.
function qFace(st) {
  let best = -1, bestF = -1;
  for (const p of st.answers) {
    const f = qFame(p, st.clubs);
    if (f > bestF) { best = p; bestF = f; }
  }
  return best;
}

// ---------------------------------------------------------------- game state
// fresh → playing(stage 0-3, lives 5-1) → won | lost; terminal for the day.
// Persisted after every action so a reload lands exactly where the player left.
let qs = null;   // stored state (localStorage.quiz)
let qPz = null;  // resolved puzzle: stages of {clubs:[ci], answers:[pid]}
let qRevealAll = false;  // end screen: user asked to see the stages they didn't reach (runtime only)
const qSave = () => localStorage.quiz = JSON.stringify(qs);
const qRolled = () => qs && qs.date !== qToday();  // played past midnight
const qHinted = (i) => ["size", "nat", "ini"].some(k => qs.hints[k] === i);  // a hint spent on stage i
// stages actually solved: reached minus the ones skipped along the way
const qSolved = () => (qs.won ? 4 : qs.stage) - qs.skipped.length;

function qLoad() {
  qRevealAll = false;
  qPools();  // prime pools + DB.qStat/gkSet even on the restore path (qFame needs them)
  if (!qStarted()) { qs = null; qPz = null; return; }  // before launch day: no game yet
  const today = qToday();
  let s = null;
  try { s = JSON.parse(localStorage.quiz || ""); } catch {}
  if (s && s.v === 1 && s.date === today) {
    // the stored QIDs pin the puzzle: resolve against the current build and
    // recompute the answers — a mid-day dataset refresh must not swap the
    // clubs under the player, and ok guesses are grandfathered regardless
    const stages = s.stages.map(qids => {
      const clubs = qids.map(q => DB.byQid.get(q));
      return clubs.every(ci => ci !== undefined)
        ? { clubs, answers: intersect(clubs.map(postings)) } : null;
    });
    if (stages.every(Boolean)) {
      s.skipped ||= [];  // grandfather state saved before the skip feature existed
      qs = s; qPz = { stages }; return;
    }
  }
  // no state, a stale day, or a club dropped from the build: fresh puzzle
  const p = qGen(today);
  qPz = { stages: p.stages };
  qs = { v: 1, date: today, num: p.num, built: DB.built,
         stages: p.stages.map(st => st.clubs.map(ci => DB.clubs[ci][3])),
         stage: 0, lives: 5, guesses: [], hints: { size: null, nat: null, ini: null },
         skipped: [], startedAt: Date.now(), done: false, won: false };
  qSave();
}

// one confirmed guess. Returns what happened, for the UI to react to:
// "dup" (free) | "wrong" | "stage" | "won" | "lost" | null (game frozen)
function qGuess(pid) {
  if (!qs || qs.done || qRolled()) return null;
  const st = qPz.stages[qs.stage];
  if (qs.guesses.some(g => g.stage === qs.stage && g.pid === pid)) return "dup";
  const ok = st.answers.includes(pid);
  qs.guesses.push({ name: DB.names[pid], pid, stage: qs.stage, ok });
  let ev;
  if (ok) {
    if (qs.stage === 3) { qs.done = qs.won = true; ev = "won"; }
    else { qs.stage++; ev = "stage"; }
  } else if (--qs.lives <= 0) { qs.done = true; ev = "lost"; }
  else ev = "wrong";
  if (qs.done) qStats();
  qSave();
  return ev;
}

function qHint(kind) {  // "size" | "nat" | "ini" — each usable once per run
  if (!qs || qs.done || qs.hints[kind] !== null || qRolled()) return false;
  qs.hints[kind] = qs.stage;  // remember where it was spent, for the share text
  qSave();
  return true;
}

// daily streak + histogram, updated exactly once as a run reaches done
function qStats() {
  const st = qGetStats() ||
    { v: 1, played: 0, streak: 0, maxStreak: 0, lastWinDate: null, byStage: [0, 0, 0, 0, 0] };
  st.played++;
  st.byStage[qSolved()]++;
  if (qs.won) {  // UTC day numbers: "yesterday" survives DST shifts
    const dayN = (ds) => { const [y, m, d] = ds.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
    st.streak = st.lastWinDate && dayN(qs.date) - dayN(st.lastWinDate) === 1 ? st.streak + 1 : 1;
    st.maxStreak = Math.max(st.maxStreak, st.streak);
    st.lastWinDate = qs.date;
  } else st.streak = 0;
  localStorage.quizStats = JSON.stringify(st);
  return st;
}
function qGetStats() {
  try { const s = JSON.parse(localStorage.quizStats || ""); if (s && s.v === 1) return s; } catch {}
  return null;
}

// ---------------------------------------------------------------- i18n
const QSTR = {
  it: {
    qTag: "la schedina del giorno — quattro sfide, cinque tentativi",
    qNum: (n) => `Schedina n. ${n}`,
    qStages: ["facile", "media", "difficile", "impossibile"],
    qQ: (n) => n === 2 ? "Chi ha giocato in entrambe?" : "Chi ha giocato in tutte e tre?",
    qPh: "Il tuo giocatore…",
    qLives: (n) => `${n} tentativ${n === 1 ? "o" : "i"} rimast${n === 1 ? "o" : "i"}`,
    qhSize: "quanti sono?", qhNat: "di dove?", qhIni: "identikit",
    qsSize: (n) => n === 1 ? "c'è una sola risposta valida" : `le risposte valide sono ${n}`,
    qsIni: (ini, dec) => `iniziali ${ini}` + (dec ? `, nato negli anni ${dec >= 2000 ? dec : "'" + String(dec).slice(2)}` : ""),
    qsAtClub: "gioca ancora in una delle due squadre", qsActive: "ancora in attività",
    qsApps: (n) => `${n} pres`, qsGoals: (n) => `${n} gol`,
    qOk: "Giusto!", qNo: "No…", qDup: "già provato",
    qWon: "Schedina completata!", qLost: "Tentativi finiti.",
    qNewDay: "È mezzanotte: c'è una nuova schedina", qPlay: "gioca",
    qStartsOn: (d) => `La schedina del giorno inizia ${d}. Torna a giocare!`,
    qErrS: (n) => `Errori ${n}/5`, qHintS: (n) => `Aiuti ${n}/3`,
    qStreakS: (n) => `Serie ${n}`,
    qStatPlayed: "giocate", qStatStreak: "serie", qStatBest: "record",
    qHisto: "sfide superate",
    qReveal: (n) => n === 1 ? "la risposta era" : `le ${n} risposte erano`,
    qOthers: (n) => `e altr${n === 1 ? "o" : "i"} ${n}`,
    qShare: "condividi", qCopied: "copiato negli appunti", qOpen: "apri nel solver",
    qRevealRest: "svela le sfide non giocate",
    qResignBtn: "mi arrendo", qResignWarn: "Abbandonare la schedina di oggi?",
    qSkipBtn: "salta la sfida", qSkipWarn: "Saltare questa sfida? Conterà come non risolta.",
    qSkipped: "saltata",
    qLeaveWarn: "Se esci abbandoni la schedina di oggi. Continuare?",
  },
  en: {
    qTag: "the daily quiz — four challenges, five guesses",
    qNum: (n) => `Quiz #${n}`,
    qStages: ["easy", "medium", "hard", "impossible"],
    qQ: (n) => n === 2 ? "Who played for both?" : "Who played for all three?",
    qPh: "Your guess…",
    qLives: (n) => `${n} guess${n === 1 ? "" : "es"} left`,
    qhSize: "how many?", qhNat: "from where?", qhIni: "identikit",
    qsSize: (n) => n === 1 ? "there is a single valid answer" : `there are ${n} valid answers`,
    qsIni: (ini, dec) => `initials ${ini}` + (dec ? `, born in the ${dec}s` : ""),
    qsAtClub: "still plays for one of the two clubs", qsActive: "still an active player",
    qsApps: (n) => `${n} apps`, qsGoals: (n) => `${n} goals`,
    qOk: "Correct!", qNo: "No…", qDup: "already tried",
    qWon: "Quiz completed!", qLost: "Out of guesses.",
    qNewDay: "It's past midnight: a new quiz is out", qPlay: "play it",
    qStartsOn: (d) => `The daily quiz starts ${d}. Come back to play!`,
    qErrS: (n) => `Misses ${n}/5`, qHintS: (n) => `Hints ${n}/3`,
    qStreakS: (n) => `Streak ${n}`,
    qStatPlayed: "played", qStatStreak: "streak", qStatBest: "best",
    qHisto: "stages cleared",
    qReveal: (n) => n === 1 ? "the answer was" : `the ${n} answers were`,
    qOthers: (n) => `and ${n} more`,
    qShare: "share", qCopied: "copied to clipboard", qOpen: "open in solver",
    qRevealRest: "reveal the challenges you didn't play",
    qResignBtn: "give up", qResignWarn: "Give up on today's quiz?",
    qSkipBtn: "skip this stage", qSkipWarn: "Skip this stage? It will count as unsolved.",
    qSkipped: "skipped",
    qLeaveWarn: "Leaving forfeits today's quiz. Continue?",
  },
};

// ---------------------------------------------------------------- view
// entered via the modebar Quiz toggle; a body.quiz class flips the page to the
// green schedina theme and hides the solver — its state is never touched
const qEl = $("quiz");
let qBuilt = false;

function qBuild() {  // static skeleton, rendered once on first entry
  qEl.innerHTML = `
    <div id="qhead"><span id="qnum"></span></div>
    <ol id="qstages"></ol>
    <div id="qcard">
      <div id="qchips"></div>
      <div id="qq"></div>
      <div id="qwrap">
        <input id="qsearch" type="text" autocomplete="off" spellcheck="false">
        <ul id="qsugg" hidden></ul>
      </div>
      <div id="qbar">
        <span id="qlives"></span>
        <span id="qhbtns">
          <button id="qh-size" type="button">💡</button>
          <button id="qh-nat" type="button">💡</button>
          <button id="qh-ini" type="button">💡</button>
        </span>
      </div>
      <div id="qhint" hidden></div>
      <div id="qmsg" aria-live="polite"></div>
      <button id="qresign" type="button"></button>
    </div>
    <ul id="qlog"></ul>
    <div id="qend" hidden></div>
    <div id="qnewday" hidden></div>`;
  const qse = $("qsearch");
  qse.addEventListener("input", () => qSuggest(playerMatches(qse.value, [])));
  qse.addEventListener("keydown", (e) => {
    const items = [...$("qsugg").children];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      qCur = (qCur + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items.forEach((li, i) => li.className = i === qCur ? "active" : "");
    } else if ((e.key === "Enter" || e.key === "Tab") && qCur >= 0 && !$("qsugg").hidden) {
      e.preventDefault();
      qPick(playerMatches(qse.value, [])[qCur]);
    } else if (e.key === "Escape") $("qsugg").hidden = true;
  });
  qse.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement !== qse) $("qsugg").hidden = true;
  }, 100));
  for (const kind of ["size", "nat", "ini"])  // render either way: a rolled-over
    $("qh-" + kind).onclick = () => { qHint(kind); qRender(); };  // day shows its bar
  // easy/medium/hard: skip just that stage and move on. impossible (the last
  // stage, nothing to move on to): give up ends the whole run
  $("qresign").onclick = () => {
    if (!qs || qs.done) return;
    const last = qs.stage === 3, q = QSTR[lang];
    if (!confirm(last ? q.qResignWarn : q.qSkipWarn)) return;
    if (last) qResign(); else qSkipStage();
  };
}

// skip the current (non-final) stage: counts as unsolved, run continues
function qSkipStage() {
  if (!qs || qs.done || qRolled() || qs.stage >= 3) return;
  qs.skipped.push(qs.stage);
  qs.stage++;
  qSave();
  $("qsugg").hidden = true;
  qRender();
  $("qsearch").focus();
}

// give up: end the run as a loss (reveal + stats), stay on the quiz page
function qResign() {
  if (!qs || qs.done) return;
  qs.done = true; qs.won = false;
  qStats();
  qSave();
  $("qsugg").hidden = true;
  qRender();
}

let qCur = -1;
function qSuggest(ids) {  // same look as the solver's player suggestions
  const ul = $("qsugg");
  ul.innerHTML = "";
  ul.hidden = ids.length === 0;
  qCur = ids.length ? 0 : -1;
  ids.forEach((pid, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${flag(DB.nats[pid])} ${esc(DB.names[pid])}</span><small>${DB.births[pid] || ""}</small>`;
    li.className = i === qCur ? "active" : "";
    li.onmousedown = (e) => { e.preventDefault(); qPick(pid); };
    ul.appendChild(li);
  });
}

function qPick(pid) {
  if (pid === undefined) return;
  $("qsearch").value = "";
  $("qsugg").hidden = true;
  const ev = qGuess(pid);
  if (ev === null) { qRender(); return; }  // frozen (rolled past midnight)
  const q = QSTR[lang], good = ev === "stage" || ev === "won";
  qFlash(ev === "dup" ? q.qDup : good ? q.qOk : q.qNo, good ? "ok" : "no");
  if (ev === "wrong" || ev === "dup") {
    $("qcard").classList.remove("shake");
    void $("qcard").offsetWidth;  // restart the animation
    $("qcard").classList.add("shake");
  }
  qRender();
  if (!qs.done) $("qsearch").focus();
}

let qMsgGen = 0;
function qFlash(text, cls) {
  const el = $("qmsg"), g = ++qMsgGen;
  el.textContent = text;
  el.className = cls;
  setTimeout(() => { if (g === qMsgGen) { el.textContent = ""; el.className = ""; } }, 1800);
}

const qClubNames = (st) => st.clubs.map(ci => coreClub(DB.clubs[ci][0])).join(" × ");

function qRenderPre() {  // before launch day: a friendly "starts Monday" screen, no puzzle
  const q = QSTR[lang];
  $("qnum").textContent = q.qNum(1);
  $("qstages").innerHTML = "";
  $("qcard").hidden = true;
  $("qlog").innerHTML = "";
  $("qend").hidden = true;
  const nd = $("qnewday");
  nd.hidden = false;
  nd.textContent = q.qStartsOn(qLaunchLabel());
}
function qRender() {
  const q = QSTR[lang];
  $("tagline").textContent = q.qTag;  // reuse the masthead tagline slot: content never shifts
  if (!qStarted()) { qRenderPre(); return; }  // before launch day
  $("qnum").textContent = q.qNum(qs.num);
  // stage board: cleared rows show clubs + the winning answer, the failed row
  // its clubs, unreached rows stay covered — no spoilers for a lost run
  const ol = $("qstages");
  ol.innerHTML = "";
  qPz.stages.forEach((st, i) => {
    const skipped = qs.skipped.includes(i);
    const done = !skipped && (i < qs.stage || (qs.won && i === 3));
    const cur = i === qs.stage && !qs.done, fail = qs.done && !qs.won && i === qs.stage;
    // a skipped stage reveals its answer alongside the other never-played ones
    const revealSkip = skipped && qs.done && qRevealAll;
    // an unreached stage the user chose to reveal from the end screen
    const shown = qs.done && qRevealAll && !done && !cur && !fail && !skipped;
    const li = document.createElement("li");
    // a stage cleared with a hint reads amber, a clean clear reads green
    li.className = done ? (qHinted(i) ? "done hinted" : "done")
                : skipped ? (revealSkip ? "shown skip" : "skip")
                : cur ? "cur" : fail ? "fail" : shown ? "shown" : "todo";
    const hit = done ? qs.guesses.find(g => g.ok && g.stage === i) : null;
    const info = done ? `${esc(qClubNames(st))} <b>✓ ${esc(hit ? hit.name : "")}</b>`
               : revealSkip ? `${esc(qClubNames(st))} <b>${esc(DB.names[qFace(st)])}</b>`
               : skipped ? `${esc(qClubNames(st))} <b class="qx">${esc(q.qSkipped)}</b>`
               : fail ? `${esc(qClubNames(st))} <b class="qx">✗</b>`
               : shown ? `${esc(qClubNames(st))} <b>${esc(DB.names[qFace(st)])}</b>`
               : cur ? "▸" : "?";
    li.innerHTML = `<span class="rank">${i + 1}</span><span class="qsname">${q.qStages[i]}</span><span class="qsinfo">${info}</span>`;
    if (qs.done && (done || fail || shown || skipped)) {  // post-game: a played/revealed row opens its matchup
      li.className += " qlink";
      li.title = q.qOpen;
      li.tabIndex = 0;
      li.onclick = () => qOpenSolver(st.clubs);
      li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); qOpenSolver(st.clubs); } };
    }
    ol.appendChild(li);
  });
  // active card
  $("qcard").hidden = qs.done || qRolled();
  if (!$("qcard").hidden) {
    const st = qPz.stages[qs.stage];
    $("qchips").innerHTML = st.clubs.map(ci => {
      const c = DB.clubs[ci];
      return `<span class="chip" title="${esc(c[0])}">${countryFlag(c[1])} ${esc(coreClub(c[0]))}${defunct(c)}</span>`;
    }).join("");
    $("qq").textContent = q.qQ(st.clubs.length);
    $("qsearch").placeholder = q.qPh;
    $("qlives").innerHTML = "●".repeat(qs.lives) + `<span class="off">${"●".repeat(5 - qs.lives)}</span>`;
    $("qlives").setAttribute("aria-label", q.qLives(qs.lives));
    for (const kind of ["size", "nat", "ini"]) {
      const b = $("qh-" + kind);
      b.textContent = `💡 ${q["qh" + (kind === "size" ? "Size" : kind === "nat" ? "Nat" : "Ini")]}`;
      b.disabled = qs.hints[kind] !== null;
    }
    // hint payloads live on the stage they were spent on and expire with it
    const lines = ["size", "nat", "ini"].filter(k => qs.hints[k] === qs.stage)
      .map(k => qHintText(k, st));
    $("qhint").hidden = lines.length === 0;
    $("qhint").innerHTML = lines.map(l => `<div>${l}</div>`).join("");
    $("qresign").textContent = qs.stage === 3 ? q.qResignBtn : q.qSkipBtn;
  }
  // guess history, newest first
  const log = $("qlog");
  log.innerHTML = "";
  [...qs.guesses].reverse().forEach(g => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="${g.ok ? "qv" : "qx"}">${g.ok ? "✓" : "✗"}</span>`
      + `<span>${esc(g.name)}</span><small>${q.qStages[g.stage]}</small>`;
    log.appendChild(li);
  });
  qRenderEnd();
  const nd = $("qnewday");
  nd.hidden = !qRolled();
  if (!nd.hidden) {
    nd.innerHTML = `${q.qNewDay} <button type="button">${q.qPlay}</button>`;
    nd.querySelector("button").onclick = () => { qLoad(); qRender(); };
  }
}

// identikit career note, loaded lazily from the shard (async is fine at hint
// time): whether the revealed player is still active / still at one of the clubs
const qCareerNote = new Map();  // pid -> null (in flight) | {at:bool, active:bool}
async function qLoadFace(st) {
  const pid = qFace(st);
  if (qCareerNote.has(pid)) return;
  qCareerNote.set(pid, null);  // in-flight guard
  let career;
  try { [, career = []] = await careerOf(pid); }
  catch { qCareerNote.delete(pid); return; }
  const spells = career.filter(e => e[0]);  // [team, start, end, apps, goals, loan]
  const names = new Set(st.clubs.map(ci => DB.clubs[ci][0]));  // canonical names match within a build
  const open = spells.filter(sp => sp[1] && !sp[2]);  // started, no end recorded = ongoing
  qCareerNote.set(pid, { at: open.some(sp => names.has(sp[0])), active: open.length > 0 });
  if (document.body.classList.contains("quiz")) qRender();
}

function qHintText(kind, st) {
  const q = QSTR[lang];
  if (kind === "size") return esc(q.qsSize(st.answers.length));
  if (kind === "nat") {  // count per nationality, biggest first; unknown = "?"
    const cnt = new Map();
    for (const p of st.answers) { const cc = DB.nats[p]; cnt.set(cc, (cnt.get(cc) || 0) + 1); }
    return [...cnt].sort((a, b) => b[1] - a[1])
      .map(([cc, n]) => `${n} ${cc ? flag(cc) : "?"}`).join(" · ");
  }
  const p = qFace(st), b = DB.births[p];
  let apps = 0, goals = 0;  // combined at the two clubs
  for (const ci of st.clubs) { const a = qApps(ci, p); if (a > 0) apps += a; const g = qGoals(ci, p); if (g > 0) goals += g; }
  // initials + decade, then nationality flag and the combined apps/goals
  let s = esc(q.qsIni(DB.names[p].split(" ").map(w => w[0] + ".").join(" "), b ? Math.floor(b / 10) * 10 : 0));
  const extra = [DB.nats[p] ? flag(DB.nats[p]) : "", apps ? q.qsApps(apps) : "",
                 goals && !DB.gkSet.has(p) ? q.qsGoals(goals) : ""].filter(Boolean);
  if (extra.length) s += " · " + extra.join(" · ");
  const note = qCareerNote.get(p);
  if (note === undefined) qLoadFace(st);  // not fetched yet: load, re-render appends the note
  else if (note && note.at) s += " · " + esc(q.qsAtClub);
  else if (note && note.active) s += " · " + esc(q.qsActive);
  return s;
}

function qSummary() {  // shared by the end screen and the share text
  const q = QSTR[lang], reached = qs.won ? 4 : qs.stage;
  // green = solved, yellow = solved with a hint, red = unsolved (skipped or the stage that ended the run), black = unreached
  const sq = [0, 1, 2, 3].map(i =>
    qs.skipped.includes(i) ? "🟥"
    : i < reached ? (qHinted(i) ? "🟨" : "🟩") : qs.done && !qs.won && i === qs.stage ? "🟥" : "⬛").join("");
  const used = ["size", "nat", "ini"].filter(k => qs.hints[k] !== null);
  const line = `${q.qErrS(qs.guesses.filter(g => !g.ok).length)} · ${q.qHintS(used.length)}`;
  return { cleared: qSolved(), sq, line };
}

function qShareText() {
  const q = QSTR[lang], { cleared, sq, line } = qSummary(), st = qGetStats();
  return `Istinto Puro — ${q.qNum(qs.num)} · ${cleared}/4\n${sq}\n`
    + line + (qs.won && st ? ` · ${q.qStreakS(st.streak)}` : "")
    + `\nhttps://istintopuro.mcosta.it/#quiz`;  // #quiz opens straight into the game
}

async function qShareOut(e) {
  const btn = e.currentTarget, text = qShareText();
  // native share sheet only on touch devices — on Safari/Chrome desktop
  // navigator.share exists but the sheet often no-ops, so desktop always copies
  const touch = navigator.share && matchMedia("(pointer: coarse)").matches;
  if (touch) { try { await navigator.share({ text }); return; } catch (err) { if (err && err.name === "AbortError") return; } }
  // feedback goes on the button itself: #qmsg lives in the card, hidden at game end
  const done = () => { btn.textContent = QSTR[lang].qCopied; setTimeout(() => btn.textContent = QSTR[lang].qShare, 1500); };
  try { await navigator.clipboard.writeText(text); done(); return; } catch {}
  try {  // last-ditch for older Safari without the async clipboard API
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove(); done();
  } catch {}
}

function qRenderEnd() {
  const el = $("qend"), q = QSTR[lang];
  el.hidden = !qs.done;
  if (el.hidden) return;
  el.className = qs.won ? "qend-win" : "qend-lost";
  const { cleared, sq, line } = qSummary(), st = qGetStats();
  let html = `<div class="qres">${qs.won ? q.qWon : q.qLost}</div>
    <div class="qsq">${sq} <b>${cleared}/4</b></div>
    <div class="qmeta">${esc(line)}</div>`;
  if (!qs.won) {  // reveal the stage that ended the run, most recognisable first
    const stg = qPz.stages[qs.stage];
    const byFame = [...stg.answers].sort((a, b) => qFame(b, stg.clubs) - qFame(a, stg.clubs));
    html += `<div class="qreveal"><b>${q.qReveal(stg.answers.length)}</b>`
      + byFame.slice(0, 10).map(p => `<button type="button" class="qrp" data-p="${p}">${esc(DB.names[p])}</button>`).join(", ")
      + (byFame.length > 10 ? ` <button type="button" class="qrmore" data-s="${qs.stage}">${q.qOthers(byFame.length - 10)}</button>` : "")
      + `</div>`;
  }
  // an out for the curious: peek at stages never reached, or skipped along the way
  if ((qs.stage < 3 || qs.skipped.length) && !qRevealAll)
    html += `<button id="qrevealrest" type="button">${q.qRevealRest}</button>`;
  if (st) {  // three stat tiles + stages-cleared histogram
    const tile = (n, k) => `<div class="qtile"><span class="n">${n}</span><span class="k">${k}</span></div>`;
    html += `<div class="qtiles">${tile(st.played, q.qStatPlayed)}${tile(st.streak, q.qStatStreak)}${tile(st.maxStreak, q.qStatBest)}</div>`;
    const max = Math.max(...st.byStage, 1);
    html += `<div id="qhisto"><span class="qhcap">${q.qHisto}</span>` + st.byStage.map((n, i) =>
      `<div class="qh${i === cleared ? " me" : ""}"><span class="qhl">${i}</span>`
      + `<span class="qhb"><span style="width:${n / max * 100}%"></span></span>`
      + `<span class="qhn">${n}</span></div>`).join("") + `</div>`;
  }
  el.innerHTML = html + `<button id="qsharebtn" type="button">${q.qShare}</button>`;
  $("qsharebtn").onclick = qShareOut;
  el.querySelectorAll(".qrp").forEach(b => b.onclick = () => qOpenPlayer(+b.dataset.p));
  const more = el.querySelector(".qrmore");  // "and N more" opens the stage's clubs in the solver
  if (more) more.onclick = () => qOpenSolver(qPz.stages[+more.dataset.s].clubs);
  const rr = el.querySelector("#qrevealrest");
  if (rr) rr.onclick = () => { qRevealAll = true; qRender(); };
}

// end-screen click-through: load the matchup in club mode, quiz stays finished
function qOpenSolver(clubs) {
  clubIds = clubs.slice();
  syncHash();
  qExit();
  if (mode !== "club") setMode("club");  // setMode re-renders for the new selection
  else { renderChips(); solve(); }
}
// reveal click-through: open a revealed player's card in the solver's player mode
function qOpenPlayer(pid) {
  playerIds = [pid];
  qExit();
  if (mode !== "player") setMode("player");
  else { renderChips(); solve(); }
}

// ---------------------------------------------------------------- mode wiring
// app.js assigns onclick properties, these listeners run after them: entering
// club/player mode (even the mode===m no-op click) closes the quiz view
function qEnter() {
  if (!DB || document.body.classList.contains("quiz")) return;
  DB.pNorm ||= DB.names.map(norm);  // guess box searches all players, like player mode
  if (!qBuilt) { qBuild(); qBuilt = true; }
  qLoad();
  document.body.classList.add("quiz");
  history.replaceState(null, "", "#quiz");  // shareable + survives refresh
  $("mode-quiz").setAttribute("aria-pressed", "true");
  $("mode-club").setAttribute("aria-pressed", "false");
  $("mode-player").setAttribute("aria-pressed", "false");
  sugg.hidden = true;
  browseOpen(false);
  qRender();
  if (qs && !qs.done) $("qsearch").focus();  // qs is null before launch day
}
function qExit() {
  if (!document.body.classList.contains("quiz")) return;
  document.body.classList.remove("quiz");
  $("tagline").textContent = mode === "club" ? t.tagline : t.taglineP;  // restore solver tagline
  syncHash();  // drop #quiz, restore the solver's club-QID hash (or a clean URL)
  $("mode-quiz").setAttribute("aria-pressed", "false");
  $("mode-club").setAttribute("aria-pressed", mode === "club");
  $("mode-player").setAttribute("aria-pressed", mode === "player");
}
// a run in progress (some guess or hint spent) is worth confirming before a
// switch abandons it; a fresh or finished board leaves freely. Capture phase
// on the bar runs before the buttons' own setMode/qExit handlers, so cancelling
// can stopImmediatePropagation before the solver mode flips underneath.
const qInProgress = () => qs && !qs.done && !qRolled()
  && (qs.guesses.length || qs.skipped.length || Object.values(qs.hints).some(h => h !== null));
$("modebar").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.id === "mode-quiz" || !document.body.classList.contains("quiz")) return;
  if (!qInProgress()) return;
  if (confirm(QSTR[lang].qLeaveWarn)) qResign();  // ends the run, then the switch proceeds
  else { e.stopImmediatePropagation(); e.preventDefault(); }
}, true);
$("mode-quiz").addEventListener("click", qEnter);
$("mode-club").addEventListener("click", qExit);
$("mode-player").addEventListener("click", qExit);
// langsel's own handler has already swapped `lang` when this one runs
langSel.addEventListener("change", () => { if (qBuilt && document.body.classList.contains("quiz")) qRender(); });
// a shared https://…/#quiz link opens straight into the game once data is ready
document.addEventListener("dbready", () => { if (location.hash === "#quiz") qEnter(); }, { once: true });

// debug escape hatch: quizReset() clears today's game (keep stats),
// quizReset(true) wipes stats too. Re-renders if the quiz is open.
function quizReset(stats) {
  delete localStorage.quiz;
  if (stats) delete localStorage.quizStats;
  if (document.body.classList.contains("quiz")) { qLoad(); qRender(); }
  else { qs = qPz = null; }
  return "quiz reset";
}

// ---------------------------------------------------------------- calibration
// console-only helpers. quizGen("2026-07-25") → one resolved puzzle;
// quizDebug(30) → a table of the next N days for difficulty eyeballing.
// Both regenerate from scratch: output is per dataset build, not per player.
const qTierTag = (t) => t > 0 ? `/T${t + 1}` : t < 0 ? "/FB" : "";
function quizGen(date = qToday()) {
  const p = qGen(date);
  return { ...p, stages: p.stages.map(st => {
    const eff = qEffective(st.clubs, st.answers);
    return { clubs: st.clubs.map(ci => DB.clubs[ci][0]),
      n: st.answers.length, real: eff.length, tier: st.tier, ease: Math.round(qEase(st.clubs, eff)),
      answers: st.answers.slice(0, 12).map(pid => DB.names[pid]), face: DB.names[qFace(st)] };
  }) };
}
function quizDebug(days = 14) {
  const rows = [], d = new Date();
  for (let k = 0; k < days; k++) {
    const p = qGen(qFmt(d)), row = { date: p.date };
    p.stages.forEach((st, i) => {
      const eff = qEffective(st.clubs, st.answers);
      row[`s${i + 1}`] = st.clubs.map(ci => coreClub(DB.clubs[ci][0])).join(" × ");
      row[`n${i + 1}`] = `${eff.length}·e${Math.round(qEase(st.clubs, eff))}${qTierTag(st.tier)}`;
    });
    rows.push(row);
    d.setDate(d.getDate() + 1);
  }
  console.table(rows);
}
