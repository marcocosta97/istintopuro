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
    qOk: "Giusto!", qNo: "No…", qDup: "già provato",
    qWon: "Schedina completata!", qLost: "Tentativi finiti.",
    qNewDay: "È mezzanotte: c'è una nuova schedina", qPlay: "gioca",
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
    qOk: "Correct!", qNo: "No…", qDup: "already tried",
    qWon: "Quiz completed!", qLost: "Out of guesses.",
    qNewDay: "It's past midnight: a new quiz is out", qPlay: "play it",
  },
};

// ---------------------------------------------------------------- view
// entered via the modebar Quiz toggle; a body.quiz class flips the page to the
// green schedina theme and hides the solver — its state is never touched
const qEl = $("quiz");
let qBuilt = false;

function qBuild() {  // static skeleton, rendered once on first entry
  qEl.innerHTML = `
    <div id="qhead"><span id="qnum"></span><span id="qtag"></span></div>
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
    </div>
    <div id="qmsg" aria-live="polite"></div>
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
  $("qtag").textContent = q.qTag;
  // stage board: cleared rows show clubs + the winning answer, the failed row
  // its clubs, unreached rows stay covered — no spoilers for a lost run
  const ol = $("qstages");
  ol.innerHTML = "";
  qPz.stages.forEach((st, i) => {
    const done = i < qs.stage || (qs.won && i === 3);
    const cur = i === qs.stage && !qs.done, fail = qs.done && !qs.won && i === qs.stage;
    const li = document.createElement("li");
    li.className = done ? "done" : cur ? "cur" : fail ? "fail" : "todo";
    const hit = done ? qs.guesses.find(g => g.ok && g.stage === i) : null;
    const info = done ? `${esc(qClubNames(st))} <b>✓ ${esc(hit ? hit.name : "")}</b>`
               : fail ? `${esc(qClubNames(st))} <b class="qx">✗</b>`
               : cur ? "▸" : "?";
    li.innerHTML = `<span class="rank">${i + 1}</span><span class="qsname">${q.qStages[i]}</span><span class="qsinfo">${info}</span>`;
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
  return esc(q.qsIni(DB.names[p].split(" ").map(w => w[0] + ".").join(" "),
                     b ? Math.floor(b / 10) * 10 : 0));
}

function qRenderEnd() {
  const el = $("qend"), q = QSTR[lang];
  el.hidden = !qs.done;
  if (el.hidden) return;
  el.innerHTML = `<div class="qres">${qs.won ? q.qWon : q.qLost}</div>`;
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
  $("mode-quiz").setAttribute("aria-pressed", "false");
  $("mode-club").setAttribute("aria-pressed", mode === "club");
  $("mode-player").setAttribute("aria-pressed", mode === "player");
}
$("mode-quiz").addEventListener("click", qEnter);
$("mode-club").addEventListener("click", qExit);
$("mode-player").addEventListener("click", qExit);
// langsel's own handler has already swapped `lang` when this one runs
langSel.addEventListener("change", () => { if (qBuilt && qs) qRender(); });

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
