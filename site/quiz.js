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
const QEPOCH = Date.UTC(2026, 6, 19);   // quiz #1
const qNum = (date) => {  // parse by hand: new Date(string) is a timezone trap
  const [y, m, d] = date.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - QEPOCH) / 864e5 + 1;
};

// ---------------------------------------------------------------- generator
// candidate pools in index order (stable within a build). Roster size is the
// fairness guardrail: clubs with under 30 recorded players are too thin to ask about.
function qPools() {
  if (DB.qPools) return DB.qPools;
  DB.topLeagues ||= new Set(DB.leagues.reduce((a, l, i) =>
    (i === 0 || DB.leagues[i - 1][2] !== l[2]) ? (a.push(i), a) : a, []));
  const big = [], mid = [], obs = [], any300 = [], any100 = [];
  DB.clubs.forEach((c, i) => {
    const n = DB.postings[i].length;
    if (n < 30) return;
    if (!c[4] && DB.topLeagues.has(c[5] ?? -1) && n >= 700) big.push(i);
    if (!c[4] && (c[5] ?? -1) >= 0 && n >= 250 && n < 700) mid.push(i);
    if (n < 250) obs.push(i);  // dissolved and out-of-league clubs welcome
    if (n >= 300) any300.push(i);
    if (n >= 100) any100.push(i);
  });
  return DB.qPools = { big, mid, obs, any300, any100 };
}

// per-stage constraint ladders: QT seeded attempts per tier, then relax.
// |I| bands measured on the 2026-07-15 build (same-country big-pair
// intersections: min 10, median 42, max 122) — this table is the whole
// difficulty tuning surface, check quizDebug() after touching it.
// s: pools per club slot; same: 1 = slots share slot 1's country, 0 = must
// differ (absent = free); birth: the lone answer needs a known birth year
// (the identikit hint would otherwise have nothing to say on a 1-player set).
const QT = 200;
const QEASY = [
  { s: ["big", "big"], same: 1, lo: 25, hi: 1e9 },
  { s: ["big", "big"], same: 1, lo: 10, hi: 1e9 },
  { s: ["big", "big"], same: 1, lo: 8, hi: 1e9 },
];
const QMEDIUM = [
  { s: ["big", "mid"], same: 1, lo: 8, hi: 30 },
  { s: ["big", "mid"], same: 1, lo: 5, hi: 40 },
  { s: ["big", "mid"], same: 1, lo: 3, hi: 60 },
];
const QHARD = [  // two flavours, a daily coin picks which leads
  { s: ["big", "big"], same: 0, lo: 2, hi: 6 },
  { s: ["big", "big", "big"], same: 1, lo: 2, hi: 6 },
];
const QIMPOSSIBLE = [
  { s: ["obs", "any300"], lo: 1, hi: 1, birth: 1 },
  { s: ["obs", "any300"], lo: 1, hi: 1 },
  { s: ["obs", "any100"], lo: 1, hi: 2 },
];

function qStage(rng, ladder, used) {
  const P = qPools();
  for (let ti = 0; ti < ladder.length; ti++) {
    const tier = ladder[ti];
    for (let a = 0; a < QT; a++) {
      const picks = [];
      for (const slot of tier.s) {
        // filter before drawing (never draw-and-reject): one rng call per slot
        const cc = picks.length && tier.same !== undefined ? DB.clubs[picks[0]][1] : null;
        const pool = P[slot].filter(i => !used.has(i) && !picks.includes(i)
          && (cc === null || (DB.clubs[i][1] === cc) === !!tier.same));
        if (!pool.length) { picks.length = 0; break; }
        picks.push(pool[rng() * pool.length | 0]);
      }
      if (!picks.length) continue;
      const I = intersect(picks.map(postings));
      if (I.length >= tier.lo && I.length <= tier.hi && (!tier.birth || DB.births[I[0]])) {
        picks.forEach(i => used.add(i));
        return { clubs: picks, answers: I, tier: ti };
      }
    }
  }
  // guaranteed fallback: all unused same-country big pairs in seeded order,
  // first non-empty wins — the pool is finite and every such pair measured >= 10
  const pairs = [];
  for (let x = 0; x < P.big.length; x++) for (let y = x + 1; y < P.big.length; y++) {
    const [a, b] = [P.big[x], P.big[y]];
    if (DB.clubs[a][1] === DB.clubs[b][1] && !used.has(a) && !used.has(b)) pairs.push([a, b]);
  }
  for (let i = pairs.length - 1; i > 0; i--) {  // Fisher–Yates on the rng stream
    const j = rng() * (i + 1) | 0;
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  for (const p of pairs) {
    const I = intersect(p.map(postings));
    if (I.length) { p.forEach(i => used.add(i)); return { clubs: p, answers: I, tier: -1 }; }
  }
}

function qGen(date) {
  const rng = qRng(qHash(date)), used = new Set();
  const flip = rng() < .5, hard = [QHARD[flip ? 0 : 1], QHARD[flip ? 1 : 0]];
  const ladders = [QEASY, QMEDIUM, [hard[0], hard[1], { ...hard[0], hi: 10 }], QIMPOSSIBLE];
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
// identikit hint target: the stage's best-documented answer — highest combined
// apps, ties to the lowest pid. No rng at play time: same hint for everyone.
function qFace(st) {
  let best = -1, bestA = -1;
  for (const p of st.answers) {
    let a = 0;
    for (const ci of st.clubs) { const x = qApps(ci, p); if (x > 0) a += x; }
    if (a > bestA) { best = p; bestA = a; }
  }
  return best;
}

// ---------------------------------------------------------------- game state
// fresh → playing(stage 0-3, lives 5-1) → won | lost; terminal for the day.
// Persisted after every action so a reload lands exactly where the player left.
let qs = null;   // stored state (localStorage.quiz)
let qPz = null;  // resolved puzzle: stages of {clubs:[ci], answers:[pid]}
const qSave = () => localStorage.quiz = JSON.stringify(qs);
const qRolled = () => qs && qs.date !== qToday();  // played past midnight

function qLoad() {
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
    if (stages.every(Boolean)) { qs = s; qPz = { stages }; return; }
  }
  // no state, a stale day, or a club dropped from the build: fresh puzzle
  const p = qGen(today);
  qPz = { stages: p.stages };
  qs = { v: 1, date: today, num: p.num, built: DB.built,
         stages: p.stages.map(st => st.clubs.map(ci => DB.clubs[ci][3])),
         stage: 0, lives: 5, guesses: [], hints: { size: null, nat: null, ini: null },
         startedAt: Date.now(), done: false, won: false };
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
  st.byStage[qs.won ? 4 : qs.stage]++;
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

// ---------------------------------------------------------------- calibration
// console-only helpers. quizGen("2026-07-25") → one resolved puzzle;
// quizDebug(30) → a table of the next N days for difficulty eyeballing.
// Both regenerate from scratch: output is per dataset build, not per player.
const qTierTag = (t) => t > 0 ? `/T${t + 1}` : t < 0 ? "/FB" : "";
function quizGen(date = qToday()) {
  const p = qGen(date);
  return { ...p, stages: p.stages.map(st => ({
    clubs: st.clubs.map(ci => DB.clubs[ci][0]),
    n: st.answers.length, tier: st.tier,
    answers: st.answers.slice(0, 12).map(pid => DB.names[pid]),
    face: DB.names[qFace(st)],
  })) };
}
function quizDebug(days = 14) {
  const rows = [], d = new Date();
  for (let k = 0; k < days; k++) {
    const p = qGen(qFmt(d)), row = { date: p.date };
    p.stages.forEach((st, i) => {
      row[`s${i + 1}`] = st.clubs.map(ci => coreClub(DB.clubs[ci][0])).join(" × ");
      row[`n${i + 1}`] = st.answers.length + qTierTag(st.tier);
    });
    rows.push(row);
    d.setDate(d.getDate() + 1);
  }
  console.table(rows);
}
