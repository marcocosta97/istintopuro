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
// the continent's genuinely legendary clubs (curated QIDs, all five leagues):
// roster size alone couldn't tell Real/Bayern/PSG from a mid-table side, so
// easy anchors on this set — every easy puzzle carries one household name.
const QICONIC = new Set([
  "Q1422", "Q631", "Q1543", "Q2641", "Q2739",                       // Juventus Inter Milan Napoli Roma
  "Q8682", "Q7156", "Q8701",                                        // Real Barça Atlético
  "Q15789", "Q41420",                                               // Bayern Dortmund
  "Q483020",                                                        // PSG
  "Q18656", "Q1130849", "Q9617", "Q9616", "Q50602", "Q18741",       // ManU Liverpool Arsenal Chelsea City Spurs
]);
function qPools() {
  if (DB.qPools) return DB.qPools;
  DB.topLeagues ||= new Set(DB.leagues.reduce((a, l, i) =>
    (i === 0 || DB.leagues[i - 1][2] !== l[2]) ? (a.push(i), a) : a, []));
  const yr = +(DB.built || "").slice(0, 4) || new Date().getFullYear();
  DB.qRecentCut = yr - 34;  // "recent" floor = <=34; the activity score weights younger higher
  DB.qActCuts = [yr - 25, yr - 30, yr - 34];  // ~current squad / active / recent → 3/2/1 pts
  const big = [], star = [], iconic = [], sub = [], mid = [], obs = [], any300 = [], any100 = [];
  DB.clubs.forEach((c, i) => {
    const n = DB.postings[i].length, topDiv = !c[4] && DB.topLeagues.has(c[5] ?? -1);
    if (n < 30) return;
    if (topDiv && n >= 700) big.push(i);
    // STAR (roster >= 400) drops all five leagues' current giants into the
    // easy pool — the 700 cut kept only IT/GB, so easy skewed English/Italian
    if (topDiv && n >= 400) star.push(i);
    if (topDiv && QICONIC.has(c[3])) iconic.push(i);  // the legendary-anchor pool
    if (!c[4] && (c[5] ?? -1) >= 0 && n >= 120 && n < 400) sub.push(i);  // a lesser covered club
    if (!c[4] && (c[5] ?? -1) >= 0 && n >= 250 && n < 700) mid.push(i);
    if (n < 250) obs.push(i);  // dissolved and out-of-league clubs welcome
    if (n >= 300) any300.push(i);
    if (n >= 100) any100.push(i);
  });
  return DB.qPools = { big, star, iconic, sub, mid, obs, any300, any100 };
}
const qRecentN = (ids) => {  // answers young enough to be recognisable to a casual fan
  let n = 0; for (const p of ids) if (DB.births[p] >= DB.qRecentCut) n++; return n;
};
// activity score of an answer set: rewards likely-active players and weights the
// probably-current (youngest) highest, so easy/medium favour guessable squads
const qActScore = (ids) => {
  const [c0, c1, c2] = DB.qActCuts;
  let s = 0;
  for (const p of ids) { const b = DB.births[p]; if (b >= c0) s += 3; else if (b >= c1) s += 2; else if (b >= c2) s += 1; }
  return s;
};

// per-stage constraint ladders: QT seeded attempts per tier, then relax. This
// table is the whole difficulty tuning surface — rerun quizDebug() after
// touching it or after a dataset refresh. Fields per tier:
//   s        pool per club slot
//   same     1 = later slots share slot-1's country, 0 = must differ (absent = free)
//   balance  1 = draw the anchor country-first (uniform over countries), so
//            easy/medium rotate fairly across leagues instead of following the
//            English/Italian-heavy pool sizes
//   recent   minimum answers born >= qRecentCut (recognisable, current-ish)
//   score    1 = keep the highest activity-score candidate in the tier (prefer
//            active/current-heavy sets) instead of the first that fits
//   birth    the lone answer needs a known birth year (identikit hint fuel)
// Bands measured on the 2026-07-15 build (same-country STAR pairs: |I| med
// 22-60 by country, >=2 recent in ~60% of pairs).
const QT = 200;
const QEASY = [  // anchor is always a legendary club; partner a same-country star
  { s: ["iconic", "star"], same: 1, balance: 1, score: 1, lo: 18, hi: 1e9, recent: 2 },
  { s: ["iconic", "star"], same: 1, balance: 1, score: 1, lo: 12, hi: 1e9, recent: 1 },
  { s: ["iconic", "star"], same: 1, balance: 1, score: 1, lo: 8, hi: 1e9 },
];
const QMEDIUM = [
  { s: ["star", "sub"], same: 1, balance: 1, score: 1, lo: 8, hi: 30, recent: 1 },
  { s: ["star", "sub"], same: 1, balance: 1, score: 1, lo: 5, hi: 40 },
  { s: ["star", "sub"], same: 1, balance: 1, lo: 3, hi: 60 },
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
    const cands = new Map();  // balanced tiers gather the tier's fits (deduped by pair)
    for (let a = 0; a < QT; a++) {
      const picks = [];
      for (let si = 0; si < tier.s.length; si++) {
        let pool;
        if (si === 0 && tier.balance) {  // country-balanced anchor: country first, uniform
          const base = P[tier.s[0]].filter(i => !used.has(i));
          const ccs = [...new Set(base.map(i => DB.clubs[i][1]))];
          if (!ccs.length) break;
          const cc = ccs[rng() * ccs.length | 0];
          pool = base.filter(i => DB.clubs[i][1] === cc);
        } else {  // filter before drawing (never draw-and-reject): one rng call per slot
          const cc = picks.length && tier.same !== undefined ? DB.clubs[picks[0]][1] : null;
          pool = P[tier.s[si]].filter(i => !used.has(i) && !picks.includes(i)
            && (cc === null || (DB.clubs[i][1] === cc) === !!tier.same));
        }
        if (!pool.length) break;
        picks.push(pool[rng() * pool.length | 0]);
      }
      if (picks.length !== tier.s.length) continue;
      const I = intersect(picks.map(postings));
      if (I.length < tier.lo || I.length > tier.hi
          || (tier.birth && !DB.births[I[0]])
          || (tier.recent && qRecentN(I) < tier.recent)) continue;
      if (!tier.balance) { picks.forEach(i => used.add(i)); return { clubs: picks, answers: I, tier: ti }; }
      cands.set(picks.slice().sort((x, y) => x - y).join(","),
                { clubs: picks, answers: I, tier: ti, score: qActScore(I) });
    }
    // balance over only the countries that actually produced a valid puzzle (no
    // trap if a league can't fit this tier), then prefer active-heavy sets while
    // keeping the top few random so the same country isn't the same pair daily
    if (cands.size) {
      const byCC = {};
      for (const c of cands.values()) (byCC[DB.clubs[c.clubs[0]][1]] ??= []).push(c);
      const ccs = Object.keys(byCC).sort();
      const pool = byCC[ccs[rng() * ccs.length | 0]].sort((a, b) =>
        b.score - a.score || a.clubs[0] - b.clubs[0] || a.clubs[1] - b.clubs[1]);
      const best = pool[rng() * Math.min(6, pool.length) | 0];
      best.clubs.forEach(i => used.add(i));
      return best;
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
// combined known apps of an answer across the stage's clubs
const qDoc = (st, p) => st.clubs.reduce((a, ci) => {
  const x = qApps(ci, p);
  return x > 0 ? a + x : a;
}, 0);
// identikit hint target: the stage's best-documented answer — highest combined
// apps, ties to the lowest pid. No rng at play time: same hint for everyone.
function qFace(st) {
  let best = -1, bestA = -1;
  for (const p of st.answers) {
    const a = qDoc(st, p);
    if (a > bestA) { best = p; bestA = a; }
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

function qLoad() {
  qRevealAll = false;
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
    qOk: "Giusto!", qNo: "No…", qDup: "già provato",
    qWon: "Schedina completata!", qLost: "Tentativi finiti.",
    qNewDay: "È mezzanotte: c'è una nuova schedina", qPlay: "gioca",
    qErrS: (n) => `Errori ${n}/5`, qHintS: (n) => `Aiuti ${n}/3`,
    qStreakS: (n) => `Serie ${n}`,
    qStatPlayed: "giocate", qStatStreak: "serie", qStatBest: "record",
    qHisto: "sfide superate",
    qReveal: (n) => n === 1 ? "la risposta era" : `le ${n} risposte erano`,
    qOthers: (n) => `e altr${n === 1 ? "o" : "i"} ${n}`,
    qShare: "condividi", qCopied: "copiato negli appunti", qOpen: "apri nel solver",
    qRevealRest: "svela le sfide non giocate",
    qResignBtn: "mi arrendo", qResignWarn: "Abbandonare la schedina di oggi?",
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
    qOk: "Correct!", qNo: "No…", qDup: "already tried",
    qWon: "Quiz completed!", qLost: "Out of guesses.",
    qNewDay: "It's past midnight: a new quiz is out", qPlay: "play it",
    qErrS: (n) => `Misses ${n}/5`, qHintS: (n) => `Hints ${n}/3`,
    qStreakS: (n) => `Streak ${n}`,
    qStatPlayed: "played", qStatStreak: "streak", qStatBest: "best",
    qHisto: "stages cleared",
    qReveal: (n) => n === 1 ? "the answer was" : `the ${n} answers were`,
    qOthers: (n) => `and ${n} more`,
    qShare: "share", qCopied: "copied to clipboard", qOpen: "open in solver",
    qRevealRest: "reveal the challenges you didn't play",
    qResignBtn: "give up", qResignWarn: "Give up on today's quiz?",
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
  $("qresign").onclick = () => { if (confirm(QSTR[lang].qResignWarn)) qResign(); };
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

function qRender() {
  const q = QSTR[lang];
  $("qnum").textContent = q.qNum(qs.num);
  $("tagline").textContent = q.qTag;  // reuse the masthead tagline slot: content never shifts
  // stage board: cleared rows show clubs + the winning answer, the failed row
  // its clubs, unreached rows stay covered — no spoilers for a lost run
  const ol = $("qstages");
  ol.innerHTML = "";
  qPz.stages.forEach((st, i) => {
    const done = i < qs.stage || (qs.won && i === 3);
    const cur = i === qs.stage && !qs.done, fail = qs.done && !qs.won && i === qs.stage;
    // an unreached stage the user chose to reveal from the end screen
    const shown = qs.done && qRevealAll && !done && !cur && !fail;
    const li = document.createElement("li");
    // a stage cleared with a hint reads amber, a clean clear reads green
    li.className = done ? (qHinted(i) ? "done hinted" : "done")
                : cur ? "cur" : fail ? "fail" : shown ? "shown" : "todo";
    const hit = done ? qs.guesses.find(g => g.ok && g.stage === i) : null;
    const info = done ? `${esc(qClubNames(st))} <b>✓ ${esc(hit ? hit.name : "")}</b>`
               : fail ? `${esc(qClubNames(st))} <b class="qx">✗</b>`
               : shown ? `${esc(qClubNames(st))} <b>${esc(DB.names[qFace(st)])}</b>`
               : cur ? "▸" : "?";
    li.innerHTML = `<span class="rank">${i + 1}</span><span class="qsname">${q.qStages[i]}</span><span class="qsinfo">${info}</span>`;
    if (qs.done && (done || fail || shown)) {  // post-game: a played/revealed row opens its matchup
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
    $("qresign").textContent = q.qResignBtn;
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
  let s = q.qsIni(DB.names[p].split(" ").map(w => w[0] + ".").join(" "), b ? Math.floor(b / 10) * 10 : 0);
  const note = qCareerNote.get(p);
  if (note === undefined) qLoadFace(st);  // not fetched yet: load, re-render appends the note
  else if (note && note.at) s += " · " + q.qsAtClub;
  else if (note && note.active) s += " · " + q.qsActive;
  return esc(s);
}

function qSummary() {  // shared by the end screen and the share text
  const q = QSTR[lang], cleared = qs.won ? 4 : qs.stage;
  const sq = [0, 1, 2, 3].map(i =>  // green = clean clear, yellow = cleared with a hint
    i < cleared ? (qHinted(i) ? "🟨" : "🟩") : qs.done && !qs.won && i === qs.stage ? "🟥" : "⬛").join("");
  const used = ["size", "nat", "ini"].filter(k => qs.hints[k] !== null);
  const line = `${q.qErrS(qs.guesses.filter(g => !g.ok).length)} · ${q.qHintS(used.length)}`;
  return { cleared, sq, line };
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
  if (!qs.won) {  // reveal the stage that ended the run, best-documented first
    const stg = qPz.stages[qs.stage];
    const byDoc = [...stg.answers].sort((a, b) => qDoc(stg, b) - qDoc(stg, a));
    html += `<div class="qreveal"><b>${q.qReveal(stg.answers.length)}</b>`
      + byDoc.slice(0, 10).map(p => `<button type="button" class="qrp" data-p="${p}">${esc(DB.names[p])}</button>`).join(", ")
      + (byDoc.length > 10 ? ` <button type="button" class="qrmore" data-s="${qs.stage}">${q.qOthers(byDoc.length - 10)}</button>` : "")
      + `</div>`;
    if (qs.stage < 3 && !qRevealAll)  // an out for the curious: peek at the stages never reached
      html += `<button id="qrevealrest" type="button">${q.qRevealRest}</button>`;
  }
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
  if (!qs.done) $("qsearch").focus();
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
  && (qs.guesses.length || Object.values(qs.hints).some(h => h !== null));
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
langSel.addEventListener("change", () => { if (qBuilt && qs) qRender(); });
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
