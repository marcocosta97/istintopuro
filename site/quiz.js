"use strict";
/* Istinto Puro — daily quiz ("schedina"): four club intersections, easy to
   impossible, one puzzle per calendar date. Classic script loaded after app.js
   and quiz-core.js: the UI uses solver globals and the shared core factory. */

// The generator/scorer is a side-effect-free factory shared with Node schedule
// tooling. It is initialized lazily because app.js loads the dataset async.
let qCoreApi = null;
const qCore = () => qCoreApi ||= QuizCore.createQuizCore({
  DB: CORE_DB, postings: corePostings, intersect,
  leagueCC: coreLeagueCC, coreClub,
  recognition: QuizRecognition.createAdapter(CORE_DB, QuizCore.easyQidsFor(CORE_DB)),
});
const qFmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const qToday = () => qFmt(new Date());
const QEPOCH = Date.UTC(2026, 7, 21);
const QSERIES = "2026-08-21";
const qNum = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - QEPOCH) / 864e5 + 1;
};
const qShift = (date, days) => qCore().qShift(date, days);
const qPools = () => qCore().qPools();
const qApps = (ci, pid) => qCore().qApps(ci, pid);
const qGoals = (ci, pid) => qCore().qGoals(ci, pid);
const qFame = (pid, clubs) => qCore().qFame(pid, clubs);
const qEase = (clubs, answers, audience) => qCore().qEase(clubs, answers, audience);
const qEffective = (clubs, answers) => qCore().qEffective(clubs, answers);
const qRanked = (stage) => qCore().qRanked(stage);
const qFace = (stage) => stage.grandfatheredFace ?? qCore().qFace(stage);
const quizNumberToday = () => Math.max(1, qNum(qToday()));
const quizTodayResult = () => {
  const rec = qHistory().days[qToday()];
  return rec ? { num: rec.num, cleared: rec.res.filter(c => c < 2).length } : null;
};
const qStarted = () => qNum(qToday()) >= 1;
const qLaunchLabel = () => {
  const [year, month, day] = QSERIES.split("-").map(Number);
  try { return new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long" }).format(new Date(year, month - 1, day)); }
  catch { return QSERIES; }
};

// This release starts a new public series. Clear the previous series once per
// browser so its games, archive, replays and aggregate statistics cannot leak
// into Schedina #1. The marker makes the reset a one-off, not a page-load wipe.
try {
  if (localStorage.quizSeries !== QSERIES) {
    ["quiz", "quizStats", "quizHistory", "quizReplays"].forEach(key => localStorage.removeItem(key));
    localStorage.quizSeries = QSERIES;
  }
} catch {}

// Runtime generation shares the full calendar history with the schedule writer.
// Opening a published day still requires no replay of unrelated history.
const qChain = [];
function qScheduled(date, num) {
  const schedule = CORE_DB.quizSchedule;
  const scheduled = schedule?.days?.[date];
  // A published day always wins over a slate generated while the file was missing.
  if (scheduled) {
    const lockedThrough = schedule.lockedThrough || schedule.built;
    const published = typeof lockedThrough === "string" && date <= lockedThrough;
    const checked = qCore().validateEntry(scheduled, { requireOrder: !published, requireLevels: !published });
    if (!checked.ok) return null;
    return qChain[num] = { date, num, attempt: null, stages: checked.stages };
  }
  if (!schedule) return null;
  if (qChain[num]) return qChain[num];
  return null;
}
// Resolve missing dates chronologically, independently of a person's play
// history. Iteration avoids a recursion limit as the public series gets longer.
function qGenerated(date) {
  const num = qNum(date);
  if (num < 1) return qCore().generate(date, { allowFallback: true });
  // No schedule file: a local slate would be saved and then preferred over the
  // published day once the file arrives. Callers show a retry instead.
  if (!CORE_DB.quizSchedule) return null;
  const scheduled = qScheduled(date, num);
  if (scheduled) return scheduled;
  if (qChain[num]) return qChain[num];
  const previousDays = [];
  for (let k = 1; k < num; k++) {
    const previousDate = qShift(date, k - num);
    const previous = qScheduled(previousDate, k) || qChain[k]
      || (qChain[k] = qCore().generate(previousDate, { previousDays: [...previousDays], allowFallback: true }));
    previousDays.push(previous);
  }
  return qChain[num] = qCore().generate(date, { previousDays, allowFallback: true });
}
function qStagesFor(date) {
  const num = qNum(date);
  if (num < 1) return qCore().generate(date, { allowFallback: true }).stages;
  return qGenerated(date)?.stages ?? null;
}
const qGen = (date) => {
  const stages = qStagesFor(date);
  return stages ? { date, num: qNum(date), stages } : null;
};
// small and muted so it reads as a footnote, not as part of the label it trails
const qTag = (s) => `<small class="qplus">${s}</small>`;
// a revealed name stands in for the whole answer set: flag how many OTHERS there
// are (never for a single-solution stage, where the name already says it all)
const qFaceTag = (st) => {
  const count = qCore().uniqueChoices(st.answers).length;
  return count > 1 ? qTag(`+${count - 1}`) : "";
};

// ---------------------------------------------------------------- game state
// fresh → playing(stage 0-3, lives 5-1) → won | lost; terminal for the day.
// Persisted after every action so a reload lands exactly where the player left.
let qs = null;   // stored state (localStorage.quiz)
let qPz = null;  // resolved puzzle: stages of {clubs:[ci], answers:[pid]}
// a replay (a past day opened from the calendar) is practice — its result goes to
// quizHistory but never to quizStats, and it never freezes on the midnight
// rollover. Its in-progress state IS persisted (keyed by date in quizReplays), so
// you can switch between today and a past day, or reopen one, without losing it.
let qReplaying = false;
// which day the quiz view is showing: null = today's live game, a date = that
// replay. Kept across a club/player detour (module state, not localStorage) so
// returning to Quiz restores the same board; a full page reload resets it to today.
let qReplayDate = null;
// "schedule": today's official puzzle cannot be started. "retired": a finished
// day is on record but its clubs will not rebuild. Neither path mints a new slate.
let qHold = null, qHoldRes = null, qHoldNum = null;
const qReplays = () => { try { const s = JSON.parse(localStorage.quizReplays || ""); if (s && s.v === 1) return s; } catch {} return { v: 1, days: {} }; };
const qSave = () => {
  qs.hintTargetKeys = Object.fromEntries(Object.entries(qs.hintTargets)
    .filter(([, pid]) => Number.isInteger(pid) && pid >= 0 && pid < CORE_DB.names.length)
    .map(([kind, pid]) => [kind, qIdentity(pid)]));
  try {
    if (!qReplaying) { localStorage.quiz = JSON.stringify(qs); return true; }
    const r = qReplays(); r.days[qs.date] = qs; localStorage.quizReplays = JSON.stringify(r);
    return true;
  } catch { return false; }
};
const qRolled = () => !qReplaying && qs && qs.date !== qToday();  // played past midnight
// one shot each, spent on whatever stage you're on. "ini2" is adaptive: the
// second-most-famous answer's identikit, or — on a single-answer stage, which
// the impossible tier often is — the lone answer's other clubs ("car")
const QHINTS = ["nat", "ini", "ini2"];
const qHinted = (i) => QHINTS.some(k => qs.hints[k] === i);  // a hint spent on stage i
// stages actually solved: reached minus the ones skipped along the way
const qSolved = () => (qs.won ? 4 : qs.stage) - qs.skipped.length;

// resolve stored stage QIDs against the current build, recomputing answers, so a
// dataset refresh can't swap the clubs under a saved game (or a replayed one).
// Returns null unless all four stages restore from their QIDs (or a grandfathered
// face). Never substitutes a single stage from a freshly generated slate — that
// hybrid board can duplicate clubs and rewrite a corrupt day into storage.
function qStagesFromQids(rows, state = null) {
  if (!Array.isArray(rows) || rows.length !== 4) return null;
  const stages = rows.map((qids, stageIndex) => {
    if (!Array.isArray(qids) || qids.length < 2 || qids.length > 3) return null;
    CORE_DB.byQid ||= new Map(CORE_DB.clubs.map((club, index) => [club[3], index]));
    const clubs = qids.map(qid => CORE_DB.byQid.get(qid));
    if (clubs.some(ci => ci === undefined) || new Set(clubs).size !== clubs.length) return null;
    const raw = intersect(clubs.map(postings));
    const answers = qCore().answerSet(raw);
    const effective = qCore().qEffective(clubs, raw);
    const audience = "european";
    if (effective.length) return { clubs, answers, effective, audience, ease: qEase(clubs, effective, audience) };
    const hit = state?.guesses?.find(guess => guess.stage === stageIndex && guess.ok
      && Number.isInteger(guess.pid) && DB.names[guess.pid] === guess.name);
    if (hit) {
      return { clubs, answers, effective: [], ease: -Infinity, grandfatheredFace: hit.pid };
    }
    return null;
  });
  return stages.every(Boolean) ? stages : null;
}

const qIdentity = (pid) => qCore().playerIdentity(pid);
const qGuessIdentity = (guess) => (guess.key || guess.identity
  || `${guess.name}\u0000${guess.birth || ""}`).split("\u0000").slice(0, 2).join("\u0000");
function qMigrateState(state, stages) {
  const migrated = qCore().migrateState(state, stages, QHINTS);
  // Never introduce a new criterion midway through a saved game.
  if (migrated && !Object.prototype.hasOwnProperty.call(migrated, "bonus")) migrated.bonus = null;
  return migrated;
}

function qRunStarted(state) {
  if (!state || state.done) return false;
  return (state.guesses?.length || 0) > 0 || (state.skipped?.length || 0) > 0
    || Object.values(state.hints || {}).some(h => h !== null);
}
function qQidsOf(stages) {
  return stages.map(st => st.clubs.map(ci => CORE_DB.clubs[ci][3]));
}
function qSameQids(rows, stages) {
  const next = qQidsOf(stages);
  return Array.isArray(rows) && rows.length === next.length && rows.every((row, i) =>
    Array.isArray(row) && row.length === next[i].length && row.every((qid, k) => qid === next[i][k]));
}
function qNoteStorage() {
  const text = QSTR[lang].qStorage;
  const statusEl = $("status");
  if (statusEl) statusEl.textContent = text;
  const msg = $("qmsg");
  if (msg && qBuilt) { msg.textContent = text; msg.className = "no"; }
}
function qHoldSchedule() {
  qHold = "schedule"; qHoldRes = null; qHoldNum = null; qs = null; qPz = null;
}
function qHoldRetired(hist) {
  qHold = "retired";
  qHoldRes = Array.isArray(hist?.res) ? hist.res : null;
  qHoldNum = hist?.num ?? null;
  qs = null; qPz = null;
  try { localStorage.removeItem("quiz"); } catch {}
}
function qFresh(today, puzzle) {
  qHold = null; qHoldRes = null; qHoldNum = null;
  qPz = { stages: puzzle.stages };
  qs = { v: 2, date: today, num: puzzle.num, built: DB.built,
         stages: qQidsOf(puzzle.stages),
         stage: 0, lives: 5, guesses: [], hints: Object.fromEntries(QHINTS.map(k => [k, null])),
         hintTargets: {}, skipped: [], startedAt: Date.now(), done: false, won: false,
         bonus: qBonusFor(today, puzzle.stages) };
  if (!qSave()) qNoteStorage();
}
function qRestoreLive(state) {
  const stages = qStagesFromQids(state.stages, state);
  if (!stages) return false;
  state = qMigrateState(state, stages);  // v1 keeps its reached/cleared stages and gains exact hint targets
  state.stages = stages.map(stage => stage.clubs.map(ci => DB.clubs[ci][3]));
  qHold = null; qHoldRes = null; qHoldNum = null;
  qs = state; qPz = { stages };
  const saved = qSave();
  // A done live game whose stats write never landed still needs the aggregate.
  // qStats no-ops when this date is already on the cursor.
  if (saved && !qReplaying) { qUpdateDaily(); if (qs.done) qStats(); }
  // backfill: a game finished before the calendar shipped has no history row
  if (qs.done && !qHistory().days[qs.date]) qRecordDay();
  if (!saved) qNoteStorage();
  return true;
}
function qAdoptRecorded(hist, today) {
  const rows = hist.stages;
  const stages = qStagesFromQids(rows, hist.state) || qStagesFromQids(rows);
  const rebuilt = stages && qCore().restoreHistoryState(hist, stages, {
    date: today, num: hist.num ?? qNum(today), built: DB.built, stageQids: rows,
  }, QHINTS);
  if (!rebuilt) { qHoldRetired(hist); return; }
  qHold = null; qHoldRes = null; qHoldNum = null;
  qs = rebuilt; qPz = { stages };
  qs.resultDetailsMissing = true;
  if (!qSave()) qNoteStorage();
  if (!qReplaying) qStats();
}
function qTodaySettled(hist, today) {
  if (!hist) return false;
  const state = hist.state;
  const stateDone = !!(state && (state.v === 1 || state.v === 2) && state.date === today && state.done);
  const summary = Array.isArray(hist.res) && hist.res.length === 4;
  if (!stateDone && !summary) return false;
  if (stateDone && qRestoreLive(state)) return true;
  qAdoptRecorded(hist, today);
  return true;
}

function qLoad() {
  qPools();  // prime pools + gkSet even on the restore path (qFame needs them)
  qReplaying = false;  // qLoad always means the live daily game
  qHold = null; qHoldRes = null; qHoldNum = null;
  if (!qStarted()) { qs = null; qPz = null; return; }  // before launch day: no game yet
  const today = qToday();
  // A finished day stays finished. Restoring the board is optional; starting a
  // second official slate would let a later finish overwrite the archive row.
  if (qTodaySettled(qHistory().days[today], today)) return;
  let s = null;
  try { s = JSON.parse(localStorage.quiz || ""); } catch {}
  if (s && (s.v === 1 || s.v === 2) && s.date === today) {
    if (qRunStarted(s) || s.done) {
      if (qRestoreLive(s)) return;
      qHoldRetired({ res: null, num: s.num });
      return;
    }
    if (!CORE_DB.quizSchedule) {
      try { localStorage.removeItem("quiz"); } catch {}
      qHoldSchedule();
      return;
    }
    const official = qGen(today);
    // An unstarted blob from a schedule miss must not outrank the published day.
    if (official && qSameQids(s.stages, official.stages) && qRestoreLive(s)) return;
  }
  // Cold open after midnight: show a started run frozen, and forfeit it only
  // when the player asks for today. An untouched slate is not a played day.
  if (s && (s.v === 1 || s.v === 2) && s.date !== today && qRunStarted(s) && qRestoreLive(s)) return;
  if (!CORE_DB.quizSchedule) { qHoldSchedule(); return; }
  const p = qGen(today);
  if (!p) { qHoldSchedule(); return; }
  qFresh(today, p);
}
function qForfeitRolled() {
  if (!qRolled() || !qs || qs.done) return true;
  const snapshot = JSON.parse(JSON.stringify(qs));
  qs.done = true; qs.won = false;
  if (!qSave()) { qs = snapshot; qNoteStorage(); return false; }
  qFinish();
  return true;
}
async function qRetrySchedule() {
  try {
    const res = await fetch(`data/quiz-schedule.json?v=${V}`);
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    if (!(body && body.v === 1 && body.built === CORE_DB.built && body.days)) throw new Error("schedule");
    CORE_DB.quizSchedule = body;
    if (typeof DB !== "undefined" && DB) DB.quizSchedule = body;
    qChain.length = 0;
  } catch {
    qHoldSchedule();
    if (qBuilt) qRender();
    return;
  }
  qLoad();
  if (qBuilt) qRender();
}

// Open a past day from the calendar. A completed day restores its finished board;
// an unfinished practice run restores its progress; an unplayed day starts fresh
// from the stored QIDs (exact matchup), else deterministically from the date.
function qStartReplay(date) {
  qReplaying = true;
  const rec = qHistory().days[date];
  const saved = rec?.state || qReplays().days[date];
  if (saved && (saved.v === 1 || saved.v === 2)) {
    const stages = qStagesFromQids(saved.stages, saved);
    if (stages) {
      qs = qMigrateState(saved, stages);
      qs.stages = stages.map(stage => stage.clubs.map(ci => DB.clubs[ci][3]));
      qPz = { stages }; qSave(); return;
    }
  }
  const generated = qGen(date);
  const stages = (rec && qStagesFromQids(rec.stages)) || generated?.stages;
  if (!stages) { qReplaying = false; qHoldSchedule(); return; }
  qPz = { stages };
  const stageQids = stages.map(st => st.clubs.map(ci => DB.clubs[ci][3]));
  qs = rec && qCore().restoreHistoryState(rec, stages,
    { date, num: qNum(date), built: DB.built, stageQids }, QHINTS);
  if (qs) qs.resultDetailsMissing = true;
  qs ||= { v: 2, date, num: qNum(date), built: DB.built,
           stages: stageQids, stage: 0, lives: 5, guesses: [],
           hints: Object.fromEntries(QHINTS.map(k => [k, null])), hintTargets: {},
           skipped: [], startedAt: Date.now(), done: false, won: false, bonus: qBonusFor(date, stages) };
  qSave();
}

// one confirmed guess. Returns what happened, for the UI to react to:
// "dup" (free) | "wrong" | "stage" | "won" | "lost" | null (game frozen)
function qGuess(pid) {
  if (!qs || qs.done || qRolled()) return null;
  const st = qPz.stages[qs.stage];
  const choice = qCore().choiceIdentity(pid);
  if (qs.guesses.some(g => g.stage === qs.stage && qGuessIdentity(g) === choice)) return "dup";
  const answer = qCore().resolveAnswer(pid, st.answers), ok = answer !== null;
  // Store the matching record so opening a correct guess shows a valid career.
  if (ok) pid = answer;
  const snapshot = JSON.parse(JSON.stringify(qs));
  qs.guesses.push({ name: DB.names[pid], birth: DB.births[pid] || 0, nat: DB.nats[pid] || "",
    key: qIdentity(pid), pid, stage: qs.stage, ok,
    bonus: ok && qs.bonus?.stage === qs.stage && qs.bonus.targets.includes(qCore().choiceIdentity(pid)) });
  let ev;
  if (ok) {
    if (qs.stage === 3) { qs.done = qs.won = true; ev = "won"; }
    else { qs.stage++; ev = "stage"; }
  } else if (--qs.lives <= 0) { qs.done = true; ev = "lost"; }
  else ev = "wrong";
  // A failed write rolls the guess back. Stats and history run only after the
  // terminal blob is durable, so a full disk cannot close the aggregate early.
  if (!qSave()) { qs = snapshot; qNoteStorage(); return null; }
  if (!qReplaying) qUpdateDaily();
  if (qs.done) qFinish();
  return ev;
}

// a run reached done: record its per-day result for the calendar always; the
// live streak/histogram (quizStats) only for the real daily game, not a replay
function qFinish() {
  if (!qReplaying) qStats();
  qRecordDay();
}

function qHint(kind) {  // a QHINTS key — each usable once per run
  if (!qs || qs.done || qConfirm || qs.hints[kind] !== null || qRolled()) return false;
  qs.hints[kind] = qs.stage;  // remember where it was spent, for the share text
  if (kind === "ini" || kind === "ini2") {
    const used = Object.entries(qs.hintTargets)
      .filter(([key]) => qs.hints[key] === qs.stage).map(([, pid]) => pid);
    qs.hintTargets[kind] = qCore().nextHintTarget(qPz.stages[qs.stage], used);
  }
  qSave();
  return true;
}

// daily streak + histogram, updated exactly once as a run reaches done
function qUpdateDaily() {
  if (!qs || qReplaying || !QuizResult.dailyWon(qs)) return;
  const st = QuizResult.updateStreak(qGetStats(), qs);
  try { localStorage.quizStats = JSON.stringify(st); } catch {}
}

function qStats() {
  const existing = qGetStats();
  const st = QuizResult.updateStreak(existing, qs);
  if (st.lastPlayDate === qs.date) {
    try { localStorage.quizStats = JSON.stringify(st); } catch {}
    return st;
  }
  // Saves from before the cursor already include a finished day once history has
  // it. A cursor sitting on an earlier day means today's aggregate write never
  // landed, even when the calendar row did.
  if (existing && existing.played > 0 && !Object.prototype.hasOwnProperty.call(existing, "lastPlayDate") && qHistory().days[qs.date]) {
    st.lastPlayDate = qs.date;
    try { localStorage.quizStats = JSON.stringify(st); } catch {}
    return st;
  }
  st.played++;
  st.byStage[qSolved()]++;
  st.lastPlayDate = qs.date;
  try { localStorage.quizStats = JSON.stringify(st); } catch {}
  return st;
}
function qGetStats() {
  try { const s = JSON.parse(localStorage.quizStats || ""); if (s && s.v === 1) return QuizResult.streakStats(s); } catch {}
  return null;
}

function qBonusFor(date, stages) {
  const schedule = CORE_DB.quizSchedule, bonus = schedule?.bonuses?.[date];
  if (!bonus || !Number.isInteger(bonus.stage) || bonus.stage < 0 || bonus.stage > 2
      || !["career", "nationality", "birth"].includes(bonus.kind) || !Array.isArray(bonus.targets)
      || !qSameQids(schedule.days[date], stages)) return null;
  const valid = new Set(stages[bonus.stage].answers.map(pid => qCore().choiceIdentity(pid)));
  const targets = bonus.targets.filter(key => valid.has(key));
  return targets.length ? { ...bonus, targets } : null;
}

// Per-day archive for the calendar: summary codes for its tile, club QIDs that pin
// the matchup, and the finished state needed to reopen that exact board. Older
// summary-only rows are reconstructed by restoreHistoryState. Written whenever a
// run finishes (live or replay); replays never touch quizStats, only this.
function qHistory() {
  try { const s = JSON.parse(localStorage.quizHistory || ""); if (s && s.v === 1) return s; } catch {}
  return { v: 1, days: {} };
}
function qRecordDay() {
  const h = qHistory();
  h.days[qs.date] = { num: qs.num, res: qResCodes(), stages: qs.stages, state: qs };
  try { localStorage.quizHistory = JSON.stringify(h); } catch {}
}

// ---------------------------------------------------------------- i18n
const QSTR = {
  it: {
    qTag: "la schedina del giorno — tre sfide e un’impossibile",
    qNum: (n) => `Schedina #${n}`,
    qDailyWon: "Schedina in tasca.", qDailyLost: "Ci riproviamo domani.",
    qDailySub: "Facile, media e difficile risolte.", qDailyUnit: "sfide del giorno",
    qDailyPartial: (n) => `${n} delle tre sfide del giorno risolte.`,
    qSeriesDays: (n) => `${n} giorn${n === 1 ? "o" : "i"} di serie`,
    qSecured: "Giornata conquistata. L’impossibile è un extra.",
    qSeriesRule: "La serie si conquista con le prime tre sfide.",
    qBonusTitle: "Da intenditore", qBonusOptional: "· facoltativa", qBonusWon: "Risposta bonus",
    qBonusNat: (n) => `Nazionalità: ${n}`,
    qBonusBirth: (a, b) => `Nato tra il ${a} e il ${b}`,
    qBonusCareer: (club, years) => `Ha giocato nel ${club}${years ? ` · ${years}` : ""}`,
    qExtra: "extra", qExtraWon: "Impossibile risolta", qExtraMiss: "Non risolta · giornata conquistata",
    qFirstTry: "Al primo colpo", qSolvedLabel: "Risolta", qMissed: "Non risolta",
    qSkipped: "Saltata", qUnreached: "Non giocata", qUnknownDetails: "Dettagli dei tentativi non disponibili",
    qErrors: (n) => `${n} error${n === 1 ? "e" : "i"}`,
    qHintsUsed: (n) => `${n} aiut${n === 1 ? "o" : "i"}`,
    qAttempts: "Tentativi", qCorrect: "Risposta corretta", qWrong: "Tentativo sbagliato", qHintedHit: "Risolta con aiuto",
    qExploreAnswers: "Scopri le risposte", qPersonalStats: "Le tue statistiche",
    qAllGuesses: "I tuoi tentativi", qClose: "concludi schedina",
    qCloseWarn: "Concludere la schedina? La giornata è già conquistata.",
    qShareLegend: "🟥 errore · 🟩 risolta · 🟨 con aiuto · 🟪 bonus · ⬜ non giocata",
    qShareStatus: "Risultato copiato negli appunti.",
    qStages: ["facile", "media", "difficile", "impossibile"],
    qQ: (n) => n === 2 ? "Chi ha giocato in entrambe?" : "Chi ha giocato in tutte e tre?",
    qPh: "Il tuo giocatore…",
    qLives: (n) => `${n} tentativ${n === 1 ? "o" : "i"} rimast${n === 1 ? "o" : "i"}`,
    qh: { nat: "di dove?", ini: "identikit", ini2: "identikit", car: "carriera" },
    qsIni: (ini, dec) => `iniziali ${ini}` + (dec ? `, nato negli anni ${dec >= 2000 ? dec : "'" + String(dec).slice(2)}` : ""),
    qsCar: (l) => `è passato anche da ${l.join(" · ")}`,
    qsProbe: "scrivi almeno tre lettere del nome, non le iniziali",
    qsBorn: (y) => `nato nel ${y}`,
    qsAtClub: (n) => `gioca ancora in una delle ${n === 2 ? "due" : "tre"} squadre`,
    qsActive: "ancora in attività",
    qsApps: (n) => `${n} pres`, qsGoals: (n) => `${n} gol`, qsGk: "portiere",
    qOk: "Giusto!", qDup: "già provato",
    qNoNone: "No… non ha mai giocato per nessuna delle squadre",
    qNoMissing: (l) => `No… non ha mai giocato per ${l.join(" o ")}`,
    qNoZero: (l) => `No… risulta tesserato per ${l.join(" e ")}, ma con 0 presenze`,
    qNoMixed: (m, z) => `No… mai in ${m.join(" o ")}; tesserato ma con 0 presenze in ${z.join(" e ")}`,
    qWon: "Schedina completata!", qLost: "Tentativi finiti.",
    qNewDay: "È iniziata una nuova schedina. La precedente resta in archivio.", qPlay: "gioca",
    qScheduleMiss: "La schedina di oggi non si è caricata.", qRetry: "riprova",
    qStorage: "Memoria piena: la giocata non è stata salvata.",
    qRetired: "Questa schedina resta in archivio, ma il tabellone non si può riaprire.",
    qSq: ["pulita", "con aiuto", "sbagliata", "non raggiunta"],
    qLegend: "✓ pulita · ✦ con aiuto · ◆ bonus · × sbagliata · – non raggiunta",
    qStartsOn: (d) => `La schedina del giorno inizia ${d}. Torna a giocare!`,
    qErrS: (n) => `Errori ${n}/5`, qHintS: (n) => `Aiuti ${n}/3`,
    qStreakS: (n) => `Serie ${n}`,
    qStatPlayed: "giocate", qStatStreak: "serie", qStatBest: "record",
    qHisto: "sfide superate",
    qReveal: (n) => n === 1 ? "la risposta era" : `le ${n} risposte erano`,
    qOthers: (n) => `e altr${n === 1 ? "o" : "i"} ${n}`,
    qShare: "condividi", qCopied: "copiato negli appunti", qCopyFail: "copia non riuscita", qOpen: "apri nel solver",
    qResignBtn: "mi arrendo", qResignWarn: "Abbandonare la schedina di oggi?",
    qSkipBtn: "salta la sfida", qSkipWarn: "Saltare questa sfida? Conterà come non risolta.",
    qConfirmNo: "annulla", qConfirmSkip: "salta", qConfirmResign: "abbandona",
    qLeaveWarn: "Se esci abbandoni la schedina di oggi.",
    qConfirmLeave: (m) => `abbandona e vai a ${m}`,
    qModes: { club: "Squadre", player: "Giocatori" },
    qCal: "archivio", qCalTitle: "Archivio", qCalBack: "torna a oggi",
    qCalHint: "rigioca una schedina passata",
  },
  en: {
    qTag: "the daily quiz — three stages and an impossible",
    qNum: (n) => `Quiz #${n}`,
    qDailyWon: "Daily quiz secured.", qDailyLost: "There’s always tomorrow.",
    qDailySub: "Easy, medium and hard cleared.", qDailyUnit: "daily stages",
    qDailyPartial: (n) => `${n} of the three daily stages cleared.`,
    qSeriesDays: (n) => `${n}-day streak`,
    qSecured: "Daily quiz secured. Impossible is an extra.",
    qSeriesRule: "Clear the first three stages to keep your streak.",
    qBonusTitle: "For the football nerds", qBonusOptional: "· optional", qBonusWon: "Bonus answer",
    qBonusNat: (n) => `Nationality: ${n}`,
    qBonusBirth: (a, b) => `Born between ${a} and ${b}`,
    qBonusCareer: (club, years) => `Played for ${club}${years ? ` · ${years}` : ""}`,
    qExtra: "extra", qExtraWon: "Impossible cleared", qExtraMiss: "Not solved · daily quiz secured",
    qFirstTry: "First try", qSolvedLabel: "Cleared", qMissed: "Not solved",
    qSkipped: "Skipped", qUnreached: "Not played", qUnknownDetails: "Attempt details unavailable",
    qErrors: (n) => `${n} miss${n === 1 ? "" : "es"}`,
    qHintsUsed: (n) => `${n} hint${n === 1 ? "" : "s"}`,
    qAttempts: "Attempts", qCorrect: "Correct answer", qWrong: "Wrong guess", qHintedHit: "Cleared with a hint",
    qExploreAnswers: "Explore the answers", qPersonalStats: "Your statistics",
    qAllGuesses: "Your guesses", qClose: "finish quiz",
    qCloseWarn: "Finish the quiz? Your daily success is already secured.",
    qShareLegend: "🟥 miss · 🟩 cleared · 🟨 hinted · 🟪 bonus · ⬜ not played",
    qShareStatus: "Result copied to clipboard.",
    qStages: ["easy", "medium", "hard", "impossible"],
    qQ: (n) => n === 2 ? "Who played for both?" : "Who played for all three?",
    qPh: "Your guess…",
    qLives: (n) => `${n} guess${n === 1 ? "" : "es"} left`,
    qh: { nat: "from where?", ini: "identikit", ini2: "identikit", car: "career" },
    qsIni: (ini, dec) => `initials ${ini}` + (dec ? `, born in the ${dec}s` : ""),
    qsCar: (l) => `also played for ${l.join(" · ")}`,
    qsProbe: "type at least three letters of the name, not the initials",
    qsBorn: (y) => `born in ${y}`,
    qsAtClub: (n) => `still plays for one of the ${n === 2 ? "two" : "three"} clubs`,
    qsActive: "still an active player",
    qsApps: (n) => `${n} app${n === 1 ? "" : "s"}`,
    qsGoals: (n) => `${n} goal${n === 1 ? "" : "s"}`, qsGk: "goalkeeper",
    qOk: "Correct!", qDup: "already tried",
    qNoNone: "No… played for none of them",
    qNoMissing: (l) => `No… didn't play for ${l.join(" or ")}`,
    qNoZero: (l) => `No… registered with ${l.join(" and ")}, but made 0 appearances`,
    qNoMixed: (m, z) => `No… didn't play for ${m.join(" or ")}; registered but made 0 appearances for ${z.join(" and ")}`,
    qWon: "Quiz completed!", qLost: "Out of guesses.",
    qNewDay: "A new daily quiz has started. The previous one stays in the archive.", qPlay: "play it",
    qScheduleMiss: "Today's quiz did not load.", qRetry: "retry",
    qStorage: "Storage is full: that play was not saved.",
    qRetired: "This quiz stays in the archive, but the board cannot be reopened.",
    qSq: ["clean", "hinted", "missed", "unreached"],
    qLegend: "✓ clean · ✦ hinted · ◆ bonus · × missed · – unreached",
    qStartsOn: (d) => `The daily quiz starts ${d}. Come back to play!`,
    qErrS: (n) => `Misses ${n}/5`, qHintS: (n) => `Hints ${n}/3`,
    qStreakS: (n) => `Streak ${n}`,
    qStatPlayed: "played", qStatStreak: "streak", qStatBest: "best",
    qHisto: "stages cleared",
    qReveal: (n) => n === 1 ? "the answer was" : `the ${n} answers were`,
    qOthers: (n) => `and ${n} more`,
    qShare: "share", qCopied: "copied to clipboard", qCopyFail: "copy failed", qOpen: "open in solver",
    qResignBtn: "give up", qResignWarn: "Give up on today's quiz?",
    qSkipBtn: "skip this stage", qSkipWarn: "Skip this stage? It will count as unsolved.",
    qConfirmNo: "cancel", qConfirmSkip: "skip", qConfirmResign: "give up",
    qLeaveWarn: "Leaving forfeits today's quiz.",
    qConfirmLeave: (m) => `give up and go to ${m}`,
    qModes: { club: "Clubs", player: "Players" },
    qCal: "archive", qCalTitle: "Archive", qCalBack: "back to today",
    qCalHint: "replay a past quiz",
  },
};

// ---------------------------------------------------------------- view
// entered via the modebar Quiz toggle; a body.quiz class flips the page to the
// green schedina theme and hides the solver — its state is never touched
const qEl = $("quiz");
let qBuilt = false, qConfirm = null, qLeaveMode = null;

function qBuild() {  // static skeleton, rendered once on first entry
  qEl.innerHTML = `
    <div id="qhead"><span id="qnum"></span><button id="qcal-open" type="button" aria-label=""></button></div>
    <ol id="qstages"></ol>
    <div id="qcard">
      <div id="qchips"></div>
      <div id="qq"></div>
      <div id="qbonus" hidden></div>
      <p id="qdaily" hidden></p>
      <div id="qwrap">
        <input id="qsearch" type="text" autocomplete="off" autocorrect="off" spellcheck="false"
               role="combobox" aria-expanded="false" aria-controls="qsugg" aria-autocomplete="list" enterkeyhint="go">
        <ul id="qsugg" role="listbox" hidden></ul>
      </div>
      <div id="qbar">
        <span id="qlives"></span>
        <span id="qhbtns">
          <button id="qh-nat" type="button">💡</button>
          <button id="qh-ini" type="button">💡</button>
          <button id="qh-ini2" type="button">💡</button>
        </span>
      </div>
      <div id="qhint" hidden></div>
      <div id="qmsg" aria-live="polite"></div>
      <div id="qconfirm" aria-live="polite" hidden>
        <span id="qconfirmtext"></span>
        <span class="qconfirm-actions"><button id="qconfirm-no" type="button"></button><button id="qconfirm-yes" type="button"></button></span>
      </div>
      <button id="qresign" type="button"></button>
    </div>
    <ul id="qlog"></ul>
    <section id="qend" aria-labelledby="qresult-title" hidden></section>
    <div id="qnewday" hidden></div>
    <div id="qcal"></div>`;
  $("qcal-open").onclick = () => qCalOpen(true);
  const qse = $("qsearch");
  qse.addEventListener("input", () => {
    const ids = qMatches(qse.value);  // the note explains an empty list, never a full one
    qSuggest(ids, qse.value, ids.length === 0 && qInitialsProbe(qse.value));
  });
  qse.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if ($("qsugg").hidden) { qSuggest(qMatches(qse.value), qse.value); return; }
      const items = [...$("qsugg").querySelectorAll('[role="option"]')];
      if (!items.length) return;
      qMoveCursor(items, (qCur + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      items[qCur].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && qCur >= 0 && !$("qsugg").hidden) {
      e.preventDefault();
      const selected = $("qsugg").querySelector('[aria-selected="true"]');
      if (selected) qPick(Number(selected.dataset.pid));
    } else if (e.key === "Escape" || e.key === "Tab") qSuggOpen(false);
  });
  // Not tied to keeping focus: hiding on blur meant dismissing the phone keyboard
  // also threw away the list it was opened to read. Every real close path already
  // says so (pick, Escape, skip/resign, empty query); blur only ever meant a tap
  // elsewhere, so a pointerdown outside #qwrap covers that instead.
  document.addEventListener("pointerdown", (e) => {
    if (!$("qsugg").hidden && !e.target.closest("#qwrap")) qSuggOpen(false);
  });
  // Phones: the keyboard costs half the viewport and nothing takes it away, so the
  // list is read through a slot. Any drag means "done typing, let me read" — including
  // a drag on the suggestions. touchmove, not scroll: focusing an input scrolls it
  // into view, and blurring on that would shut the keyboard on the tap that opened it.
  if (matchMedia("(pointer: coarse)").matches)
    document.addEventListener("touchmove", () => {
      if (document.activeElement === qse) qse.blur();
    }, { passive: true });
  for (const kind of QHINTS)  // render either way: a rolled-over
    $("qh-" + kind).onclick = () => { qHint(kind); qRender(); };  // day shows its bar
  // easy/medium/hard: skip just that stage and move on. impossible (the last
  // stage, nothing to move on to): give up ends the whole run
  $("qresign").onclick = () => {
    if (!qs || qs.done) return;
    qConfirm = qs.stage === 3 ? "resign" : "skip";
    qRender();
  };
  $("qconfirm-no").onclick = () => { qConfirm = null; qLeaveMode = null; qRender(); };
  $("qconfirm-yes").onclick = () => {
    const action = qConfirm, leaveMode = qLeaveMode;
    qConfirm = null; qLeaveMode = null;
    if (action === "resign") qResign();
    else if (action === "skip") qSkipStage();
    else if (action === "leave") { qResign(); qExit(); if (mode !== leaveMode) setMode(leaveMode); }
  };
}

// skip the current (non-final) stage: counts as unsolved, run continues
function qSkipStage() {
  if (!qs || qs.done || qRolled() || qs.stage >= 3) return;
  qConfirm = null; qLeaveMode = null;
  qs.skipped.push(qs.stage);
  qs.stage++;
  qSave();
  qSuggOpen(false);
  qRender();
}

// give up: end the run as a loss (reveal + stats), stay on the quiz page
function qResign() {
  if (!qs || qs.done) return;
  qConfirm = null; qLeaveMode = null;
  const snapshot = JSON.parse(JSON.stringify(qs));
  qs.done = true; qs.won = false;
  if (!qSave()) { qs = snapshot; qNoteStorage(); qSuggOpen(false); qRender(); return; }
  qFinish();
  qSuggOpen(false);
  qRender();
}

let qCur = -1;
function qSuggOpen(open) {
  $("qsugg").hidden = !open;
  $("qsearch").setAttribute("aria-expanded", String(open));
  if (!open) { $("qsearch").removeAttribute("aria-activedescendant"); qCur = -1; }
}
function qMoveCursor(items, index) {
  qCur = index;
  items.forEach((item, position) => {
    item.classList.toggle("active", position === index);
    item.setAttribute("aria-selected", String(position === index));
  });
  if (index >= 0) $("qsearch").setAttribute("aria-activedescendant", items[index].id);
  else $("qsearch").removeAttribute("aria-activedescendant");
}
// The identikit hint spends itself to hand out initials ("Y. P.", Danish), and
// the search box hands the answer straight back: it profiles the stage's most
// recognisable answer, and playerMatches breaks ties by fame — so "y" and "p"
// each put that very player on top. Blocking the "y p" form alone was not
// enough, single letters leak the same way. Suggestions therefore need three
// letters in some token: nobody guesses a name with fewer, and probing the
// initials would take a trigram sweep instead of two keystrokes.
const qInitialsProbe = (q) => {
  const toks = norm(q).split(" ").filter(Boolean);
  return toks.length > 0 && toks.every(w => w.length < 3);
};
// ...with one hole to patch: three players in the index (Jô, Li Ke, Zé Tó) have
// no token that long, and one of them can be a stage answer. A blocked query
// that IS somebody's whole name is a guess, not a probe — "p" still matches no
// name outright, so the initials stay closed.
const qMatches = (q) => {
  const core = qCore();
  if (!qInitialsProbe(q)) return core.uniqueChoices(playerMatches(q, [], true, CORE_DB.names.length));
  const nq = norm(q);
  return core.uniqueChoices(playerMatches(q, [], false, CORE_DB.names.length).filter(id => norm(DB.names[id]) === nq));
};

// Deliberately NOT the solver's two-line row: naming a candidate's clubs here
// would answer the puzzle outright. Birth year only, plus the match highlight.
function qSuggest(ids, q = "", probe = false) {
  const ul = $("qsugg"), nq = norm(q);
  ul.innerHTML = "";
  qSuggOpen(ids.length > 0 || probe);
  if (probe) {
    const li = document.createElement("li");
    li.className = "qnote";
    li.setAttribute("role", "presentation");
    li.textContent = QSTR[lang].qsProbe;
    ul.appendChild(li);
  }
  ids.forEach((pid, i) => {
    const li = document.createElement("li");
    li.id = "qsg" + i;
    li.dataset.pid = pid;
    li.setAttribute("role", "option");
    li.innerHTML = `<span>${flag(DB.nats[pid])} ${hilite(DB.names[pid], nq)}</span><small>${DB.births[pid] || ""}</small>`;
    li.onmousedown = (e) => e.preventDefault();
    li.onclick = () => qPick(pid);
    ul.appendChild(li);
  });
  qMoveCursor([...ul.querySelectorAll('[role="option"]')], ids.length ? 0 : -1);
}

// which of the stage's (already-visible) clubs a wrong guess didn't play for —
// no new info leaked, the chips are on screen already
function qWrongMsg(pid, st) {
  const q = QSTR[lang];
  const gaps = qCore().appearanceGaps(pid, st.clubs);
  const missing = gaps.missing.map(ci => coreClub(DB.clubs[ci][0]));
  const zero = gaps.zero.map(ci => coreClub(DB.clubs[ci][0]));
  if (missing.length === st.clubs.length) return q.qNoNone;
  if (missing.length && zero.length) return q.qNoMixed(missing, zero);
  return missing.length ? q.qNoMissing(missing) : q.qNoZero(zero);
}

function qPick(pid) {
  if (pid === undefined || qConfirm) return;
  $("qsearch").value = "";
  qSuggOpen(false);
  const st = qPz.stages[qs.stage];
  const ev = qGuess(pid);
  if (ev === null) { qRender(); return; }  // frozen (rolled past midnight)
  const q = QSTR[lang], good = ev === "stage" || ev === "won";
  const bonus = good && qs.guesses.at(-1)?.bonus;
  qFlash(ev === "dup" ? q.qDup : good ? (bonus ? q.qBonusWon : q.qOk) : qWrongMsg(pid, st), bonus ? "bonus" : good ? "ok" : "no");
  if (ev === "wrong" || ev === "dup") {
    $("qcard").classList.remove("shake");
    void $("qcard").offsetWidth;  // restart the animation
    $("qcard").classList.add("shake");
  }
  qRender();
  // desktop keeps typing; on touch the keyboard stays down to read the result
  if (!qs.done && !matchMedia("(pointer: coarse)").matches) $("qsearch").focus();
}

let qMsgGen = 0;
function qFlash(text, cls) {
  const el = $("qmsg"), g = ++qMsgGen;
  if (cls === "bonus") el.innerHTML = `${qDiamond()} ${esc(text)}`;
  else el.textContent = text;
  el.className = cls;
  setTimeout(() => { if (g === qMsgGen) { el.textContent = ""; el.className = ""; } }, 3000);
}

const qClubNames = (st) => st.clubs.map(ci => coreClub(DB.clubs[ci][0])).join(" × ");

function qRenderQuiet(message, action) {
  const q = QSTR[lang];
  $("qnum").textContent = qHoldNum ? q.qNum(qHoldNum) : "";
  const cb = $("qcal-open");
  cb.textContent = q.qCal;
  cb.setAttribute("aria-label", q.qCalTitle);
  cb.hidden = qNum(qToday()) <= 1;
  $("qstages").innerHTML = "";
  $("qcard").hidden = true;
  $("qlog").innerHTML = "";
  $("qend").hidden = true;
  const nd = $("qnewday");
  nd.hidden = false;
  if (!action) { nd.textContent = message; return; }
  nd.innerHTML = `${message} <button type="button"></button>`;
  const btn = nd.querySelector("button");
  btn.textContent = action.label;
  btn.onclick = action.run;
}
function qRenderPre() {  // before launch day: a friendly "starts Monday" screen, no puzzle
  qHoldNum = 1;
  qRenderQuiet(QSTR[lang].qStartsOn(qLaunchLabel()));
  $("qcal-open").hidden = true;
}
function qRenderSchedule() {
  qRenderQuiet(QSTR[lang].qScheduleMiss, { label: QSTR[lang].qRetry, run: () => { qRetrySchedule(); } });
}
function qRenderRetired() {
  qRenderQuiet(QSTR[lang].qRetired);
  if (!Array.isArray(qHoldRes)) return;
  const row = document.createElement("div");
  row.className = "qsq";
  row.innerHTML = qSqRow(qHoldRes, true);
  $("qnewday").appendChild(row);
}
function qRender() {
  const q = QSTR[lang];
  $("tagline").textContent = q.qTag;  // reuse the masthead tagline slot: content never shifts
  if (!qStarted()) { qRenderPre(); return; }  // before launch day
  if (!qs) {
    if (qHold === "retired") qRenderRetired();
    else qRenderSchedule();
    return;
  }
  $("qnum").textContent = q.qNum(qs.num);
  const cb = $("qcal-open");  // the archive is only worth offering once there's a past
  cb.textContent = q.qCal; cb.setAttribute("aria-label", q.qCalTitle); cb.hidden = qNum(qToday()) <= 1;
  // stage board: a stage's answer shows the moment it closes — cleared,
  // skipped, or the one that ended the run — not only once the whole game is
  // over; unreached rows stay covered until the run ends, since that's when
  // they close too
  const ol = $("qstages");
  ol.hidden = qs.done;
  ol.innerHTML = "";
  qPz.stages.forEach((st, i) => {
    const skipped = qs.skipped.includes(i);
    const done = !skipped && (i < qs.stage || (qs.won && i === 3));
    const cur = i === qs.stage && !qs.done, fail = qs.done && !qs.won && i === qs.stage;
    const shown = qs.done && !done && !cur && !fail && !skipped;
    const li = document.createElement("li");
    // Hinted clears are amber; an earned bonus overrides the answer treatment.
    li.className = done ? (qHinted(i) ? "done hinted" : "done")
                : skipped ? "shown skip"
                : cur ? "cur" : fail ? "fail" : shown ? "shown" : "todo";
    const hit = done ? qs.guesses.find(g => g.ok && g.stage === i) : null;
    if (hit?.bonus) li.className += " bonus";
    const info = done ? `${esc(qClubNames(st))} <b${hit?.bonus ? ' class="qbonus-hit"' : ""}>${hit?.bonus ? qBonusMark() : "✓"} ${esc(hit ? hit.name : "")}${qFaceTag(st)}</b>`
               : skipped ? `${esc(qClubNames(st))} <b class="qx">✗ ${esc(DB.names[qFace(st)])}${qFaceTag(st)}</b>`
               : fail ? `${esc(qClubNames(st))} <b class="qx">✗ ${esc(DB.names[qFace(st)])}${qFaceTag(st)}</b>`
               : shown ? `${esc(qClubNames(st))} <b>${esc(DB.names[qFace(st)])}${qFaceTag(st)}</b>`
               : cur ? "▸" : "?";
    li.innerHTML = `<span class="rank">${i + 1}</span><span class="qsname">${q.qStages[i]}</span><span class="qsinfo">${info}</span>`;
    if (qs.done && (done || fail || shown || skipped)) {  // post-game: a played/revealed row opens its matchup
      li.className += " qlink";
      li.title = q.qOpen;
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-label", `${q.qOpen}: ${qClubNames(st)}`);
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
    const bonus = qs.bonus?.stage === qs.stage ? qs.bonus : null;
    $("qbonus").hidden = !bonus;
    $("qbonus").innerHTML = bonus ? `<div class="qbonus-heading"><b>${qDiamond()} ${esc(q.qBonusTitle)}</b> <span class="qbonus-optional">${esc(q.qBonusOptional)}</span></div><div>${esc(qBonusText(bonus))}</div>` : "";
    $("qdaily").hidden = !QuizResult.dailyWon(qs);
    $("qdaily").textContent = q.qSecured;
    $("qsearch").placeholder = q.qPh;
    $("qsearch").setAttribute("aria-label", q.qPh);
    $("qsearch").setAttribute("aria-describedby", bonus ? "qq qbonus" : "qq");
    $("qlives").innerHTML = "●".repeat(qs.lives) + `<span class="off">${"●".repeat(5 - qs.lives)}</span>`;
    $("qlives").setAttribute("aria-label", q.qLives(qs.lives));
    for (const kind of QHINTS) {
      const b = $("qh-" + kind);
      // the label announces what THIS stage would give (ini2 is adaptive); once
      // spent the button is disabled, so a label tracking the current stage
      // rather than the one it was spent on reads as greyed-out furniture
      const key = qHintKey(kind, st);
      b.innerHTML = `💡 ${esc(q.qh[key])}${QHNUM[key] ? qTag("#" + QHNUM[key]) : ""}`;
      b.disabled = qs.hints[kind] !== null;
    }
    // hint payloads live on the stage they were spent on and expire with it
    const lines = QHINTS.filter(k => qs.hints[k] === qs.stage)
      .map(k => qHintText(k, st));
    $("qhint").hidden = lines.length === 0;
    $("qhint").innerHTML = lines.map(l => `<div>${l}</div>`).join("");
    const confirming = !!qConfirm;
    $("qconfirm").hidden = !confirming;
    $("qresign").hidden = confirming;
    if (confirming) {
      const resigning = qConfirm === "resign";
      const leaving = qConfirm === "leave";
      $("qconfirmtext").textContent = leaving ? q.qLeaveWarn : resigning
        ? (QuizResult.dailyWon(qs) ? q.qCloseWarn : q.qResignWarn) : q.qSkipWarn;
      $("qconfirm-no").textContent = q.qConfirmNo;
      $("qconfirm-yes").textContent = leaving ? q.qConfirmLeave(q.qModes[qLeaveMode])
        : resigning ? (QuizResult.dailyWon(qs) ? q.qClose : q.qConfirmResign) : q.qConfirmSkip;
    }
    $("qresign").textContent = qs.stage === 3 ? (QuizResult.dailyWon(qs) ? q.qClose : q.qResignBtn) : q.qSkipBtn;
  }
  // guess history, newest first
  const log = $("qlog");
  log.hidden = qs.done;
  log.innerHTML = "";
  [...qs.guesses].reverse().forEach(g => {
    const li = document.createElement("li");
    const bonus = g.ok && g.bonus;
    const why = g.ok ? "" : `<small class="qwhy">${esc(qWrongMsg(g.pid, qPz.stages[g.stage]))}</small>`;
    const mark = bonus ? qBonusMark() : `<span class="${g.ok ? "qv" : "qx"}">${g.ok ? "✓" : "✗"}</span>`;
    li.innerHTML = mark + `<span class="qguess">${esc(g.name)}${why}</span><small>${q.qStages[g.stage]}</small>`;
    log.appendChild(li);
  });
  qRenderEnd();
  const nd = $("qnewday");
  nd.hidden = !qRolled();
  if (!nd.hidden) {
    nd.innerHTML = `${q.qNewDay} <button type="button">${q.qPlay}</button>`;
    nd.querySelector("button").onclick = () => {
      if (!qForfeitRolled()) { qRender(); return; }
      qLoad(); qRender();
    };
  }
  if (document.body.classList.contains("qcal")) qRenderCal();  // keep the open archive in sync (e.g. lang switch)
}

// career facts for a hinted player, loaded lazily from the shard (async is fine
// at hint time): still active / still at one of the puzzle clubs, the OTHER
// clubs of the career, and the years of the spells at the stage's clubs.
const qCareerNote = new Map();  // pid + exact stage clubs -> null (in flight) | note
const qCareerKey = (pid, st) => qCore().careerCacheKey(pid, qs?.date || "", qs?.stage ?? -1, st.clubs);
async function qLoadCareer(pid, st) {
  const key = qCareerKey(pid, st);
  if (qCareerNote.has(key)) return;
  qCareerNote.set(key, null);  // in-flight guard
  const view = qs ? qCore().careerViewKey(qs.date, qs.stage, st.clubs) : "";
  let career;
  // a failed shard caches an empty note rather than clearing the entry: retrying
  // on every render would hammer a shard that is down, and the hint text falls
  // back to index-local facts anyway
  try { [, career = []] = await careerOf(pid); } catch { career = []; }
  const spells = career.filter(e => e[0]);  // [team, start, end, apps, goals, loan]
  const names = new Set(st.clubs.map(ci => DB.clubs[ci][0]));  // canonical names match within a build
  const open = spells.filter(sp => sp[1] && !sp[2] && stillPlaying(pid));  // started, no end, still young enough
  // the two clubs the player is best known for OUTSIDE the stage: a permanent
  // spell beats a loan, then the bigger tally, then the more recent one. Deduped
  // by name, since a return spell shows up twice.
  const seen = new Set();
  const others = spells.filter(sp => !names.has(sp[0]) && !seen.has(sp[0]) && seen.add(sp[0]))
    .sort((a, b) => (a[5] ? 1 : 0) - (b[5] ? 1 : 0)
      || Math.max(b[3], 0) - Math.max(a[3], 0) || (b[1] || 0) - (a[1] || 0))
    .slice(0, 2).map(sp => coreClub(sp[0]));  // raw: qHintText escapes the whole line
  // years at the stage's clubs, one entry per club with both ends recorded. A return
  // spell is listed as a second range rather than merged: "1935–1936, 1944–1945"
  // is the truth, "1935–1945" would invent a decade at the club.
  const yrs = new Map();
  for (const sp of spells) if (names.has(sp[0]) && sp[1] && sp[2])
    (yrs.get(sp[0]) || yrs.set(sp[0], []).get(sp[0]))
      .push(sp[1] === sp[2] ? `${sp[1]}` : `${sp[1]}–${sp[2]}`);
  const spans = [...yrs].map(([n, r]) => `${coreClub(n)} ${r.join(", ")}`);
  qCareerNote.set(key, { at: open.some(sp => names.has(sp[0])), active: open.length > 0, others, spans });
  const currentStage = qs && qPz?.stages[qs.stage];
  const current = currentStage ? qCore().careerViewKey(qs.date, qs.stage, currentStage.clubs) : "";
  if (view === current && document.body.classList.contains("quiz")) qRender();
}

// the two identikits are a numbered pair, tagged like the "+N" on a revealed row
const QHNUM = { ini: 1, ini2: 2 };
// Exact identikit targets are selected when the hint is spent and persisted, so
// button order and reloads can never silently change which answer was profiled.
const qHintKey = (kind, st) =>
  (kind === "ini" || kind === "ini2") && qs.hints[kind] === qs.stage
    && qs.hintTargets[kind] === null ? "car" : kind;

// initials + birth decade, then nationality, the tallies at the stage's clubs, and
// (once the shard lands) whether the player is still around. Goalkeepers say so
// in the goals slot: their goal counts are unreliable and always suppressed, so
// without the tag a keeper reads as an outfielder who never scored.
function qIdentikit(p, st) {
  const q = QSTR[lang], b = DB.births[p], gk = DB.gkSet.has(p);
  let apps = 0, goals = 0;  // combined across the stage's clubs
  for (const ci of st.clubs) { const a = qApps(ci, p); if (a > 0) apps += a; const g = qGoals(ci, p); if (g > 0) goals += g; }
  let s = esc(q.qsIni(DB.names[p].split(" ").map(w => w[0] + ".").join(" "), b ? Math.floor(b / 10) * 10 : 0));
  const extra = [DB.nats[p] ? flag(DB.nats[p]) : "", apps ? q.qsApps(apps) : "",
                 gk ? q.qsGk : goals ? q.qsGoals(goals) : ""].filter(Boolean);
  if (extra.length) s += " · " + extra.join(" · ");
  const note = qCareerNote.get(qCareerKey(p, st));
  if (note === undefined) qLoadCareer(p, st);  // not fetched yet: load, re-render appends the note
  else if (note && note.at) s += " · " + esc(q.qsAtClub(st.clubs.length));
  else if (note && note.active) s += " · " + esc(q.qsActive);
  return s;
}

function qHintText(kind, st) {
  const q = QSTR[lang];
  kind = qHintKey(kind, st);
  if (kind === "nat") {  // count per nationality over every accepted answer, biggest first; unknown = "?"
    const cnt = new Map();
    for (const p of st.answers) { const cc = DB.nats[p]; cnt.set(cc, (cnt.get(cc) || 0) + 1); }
    return [...cnt].sort((a, b) => b[1] - a[1])
      .map(([cc, n]) => `${n} ${cc ? flag(cc) : "?"}`).join(" · ");
  }
  if (kind === "ini" || kind === "ini2") return qIdentikit(qs.hintTargets[kind] ?? qFace(st), st);
  // "car": other clubs, else the years spent at the stage's clubs, else — when the shard
  // is unavailable and only index-local facts remain — the exact birth year
  const p = qFace(st), note = qCareerNote.get(qCareerKey(p, st));
  if (!note) { if (note === undefined) qLoadCareer(p, st); return "…"; }  // the load re-renders
  if (note.others.length) return esc(q.qsCar(note.others));
  if (note.spans.length) return esc(note.spans.join(" · "));
  return DB.births[p] ? esc(q.qsBorn(DB.births[p])) : "…";
}

// per-stage outcome for the four squares: 0 clean clear · 1 cleared with a hint
// · 2 missed (skipped, or the stage that ended the run) · 3 unreached. Shared by
// the share grid, the end screen and the calendar archive.
function qResCodes() { return QuizResult.codes(qs); }
const QRESSQ = ["🟩", "🟨", "🟥", "⬛"];
const qSqCells = (codes, bonusStage = -1) => codes.map((c, i) => `<i class="rsq ${i === bonusStage && c < 2 ? "rb" : `r${c}`}" aria-hidden="true"></i>`).join("");
const qSqLabel = codes => codes.map(c => QSTR[lang].qSq[c] || "").join(", ");
const qSqRow = (codes, named) => `<span class="rsqrow"${named ? ` role="img" aria-label="${esc(qSqLabel(codes))}"` : ` aria-hidden="true"`}>${qSqCells(codes)}</span>`;
const qDiamond = () => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 2 6 6-6 6-6-6Z"/></svg>`;
const qBonusMark = () => `<span class="qbonus-hit" role="img" aria-label="${esc(QSTR[lang].qBonusWon)}">${qDiamond()}</span>`;
function qBonusText(bonus) {
  const q = QSTR[lang];
  if (bonus.kind === "nationality") {
    return q.qBonusNat(bonus.value.split(",").map(natName).join(" / "));
  }
  if (bonus.kind === "birth") return q.qBonusBirth(bonus.from, bonus.to);
  return q.qBonusCareer(coreClub(bonus.value), bonus.from ? `${bonus.from}–${bonus.to}` : "");
}
function qRowText(row, result) {
  const q = QSTR[lang];
  if (row.skipped) return q.qSkipped;
  if (row.code === 3) return q.qUnreached;
  if (row.stage === 3 && row.code === 2 && result.success) return q.qExtraMiss;
  if (!result.known) return row.code < 2 ? q.qSolvedLabel : q.qMissed;
  if (row.firstTry) return q.qFirstTry;
  const parts = row.code < 2 ? [] : [q.qMissed];
  if (row.errors) parts.push(q.qErrors(row.errors));
  if (row.hints) parts.push(q.qHintsUsed(row.hints));
  return parts.join(" · ") || q.qSolvedLabel;
}
function qAttemptCells(row) {
  const q = QSTR[lang];
  const labels = { miss: q.qWrong, hit: q.qCorrect, hint: q.qHintedHit, bonus: q.qBonusWon };
  if (!row.attempts.length && row.errors !== null && row.code >= 2)
    return `<span class="qattempts" role="img" aria-label="${esc(row.skipped ? q.qSkipped : q.qUnreached)}"><i class="rsq r3" aria-hidden="true"></i></span>`;
  if (!row.attempts.length) return `<span class="qattempts">${qSqRow([row.code], true)}</span>`;
  return `<span class="qattempts" role="img" aria-label="${esc(q.qAttempts + ": " + row.attempts.map(x => labels[x]).join(", "))}">`
    + row.attempts.map(x => `<i class="rsq ${x === "bonus" ? "rb" : x === "miss" ? "r2" : x === "hint" ? "r1" : "r0"}" aria-hidden="true"></i>`).join("") + `</span>`;
}
function qSummary(result = QuizResult.describe(qs)) {
  const q = QSTR[lang];
  return { cleared: result.cleared, sq: qResCodes().map(c => QRESSQ[c]).join(""),
    line: result.known ? `${q.qErrors(result.errors)} · ${q.qHintsUsed(result.hints)}` : q.qUnknownDetails };
}
function qShareText() {
  const q = QSTR[lang], result = QuizResult.describe(qs), st = qGetStats();
  const emoji = { miss: "🟥", hit: "🟩", hint: "🟨", bonus: "🟪" };
  const streak = !qReplaying && result.success ? QuizResult.visibleStreak(st, qToday()) : 0;
  const title = `${result.daily}/3` + (streak ? ` · ${q.qSeriesDays(streak)}` : "");
  const rows = result.rows.map(row => {
    const marks = row.attempts.length ? row.attempts.map(x => emoji[x]).join("")
      : row.code === 3 || result.known && row.code === 2 ? "⬜" : QRESSQ[row.code];
    return `${q.qStages[row.stage]}${row.stage === 3 ? ` (${q.qExtra})` : ""}  ${marks}`;
  });
  return `Istinto Puro · ${q.qNum(qs.num)}\n${title}\n\n${rows.join("\n")}\n\n${qSummary(result).line}`
    + (result.bonus ? `\n🟪 ${q.qBonusWon}` : "")
    + `\n${QuizResult.quizUrl("https://istintopuro.mcosta.it/", qs.date)}`;
}
async function qShareOut(e) {
  const btn = e.currentTarget, text = qShareText();
  const touch = navigator.share && matchMedia("(pointer: coarse)").matches;
  if (touch) { try { await navigator.share({ text }); return; } catch (err) { if (err?.name === "AbortError") return; } }
  const msg = $("qshare-status");
  if (await writeClipboard(text)) {
    btn.textContent = QSTR[lang].qCopied; btn.classList.add("qcopied");
    if (msg) msg.textContent = QSTR[lang].qShareStatus;
    setTimeout(() => { btn.textContent = QSTR[lang].qShare; btn.classList.remove("qcopied"); }, 1500);
  } else if (msg) msg.textContent = QSTR[lang].qCopyFail;
}
function qRenderEnd() {
  const el = $("qend"), q = QSTR[lang], newlyFinished = el.hidden && qs.done;
  el.hidden = !qs.done;
  if (el.hidden) return;
  const result = QuizResult.describe(qs), st = qGetStats(), { line } = qSummary(result);
  el.className = result.success ? "qend-win" : "qend-lost";
  const streak = !qReplaying ? QuizResult.visibleStreak(st, qToday()) : null;
  let html = `<div class="qresult-intro"><h2 id="qresult-title" class="qres" tabindex="-1">${result.success ? q.qDailyWon : q.qDailyLost}</h2>
    <p class="qresult-sub">${result.success ? q.qDailySub : q.qDailyPartial(result.daily)}</p>
    <div class="qstanding"><span><b>${result.daily}/3</b> ${q.qDailyUnit}</span>`
    + (streak !== null ? `<span class="qseries">${esc(q.qSeriesDays(streak))}</span>` : "") + `</div></div><ol class="qresult-rows">`;
  for (const row of result.rows) {
    const stage = qPz.stages[row.stage], hit = row.hit;
    const player = hit && Number.isInteger(hit.pid) ? `<button type="button" class="qrp" data-p="${hit.pid}">${esc(hit.name)}</button>`
      : hit ? esc(hit.name) : "";
    html += `<li class="qresult-row${row.stage === 3 ? " qresult-extra" : ""}"><div class="qresult-top"><div>
      <span class="qresult-level">${q.qStages[row.stage]}${row.stage === 3 ? ` <small>${q.qExtra}</small>` : ""}</span>
      <span class="qresult-outcome">${esc(qRowText(row, result))}</span></div>${qAttemptCells(row)}</div>
      <button type="button" class="qmatch" data-s="${row.stage}" title="${esc(q.qOpen)}">${esc(qClubNames(stage))}</button>`
      + (player ? `<div class="qresult-player">${row.bonus ? qBonusMark() + " " : ""}${player}</div>` : "")
      + (row.bonus ? `<span class="qbonus-earned">${q.qBonusWon}</span>` : "") + `</li>`;
  }
  html += `</ol><p class="qresult-meta">${esc(line)}</p><button id="qsharebtn" type="button">${q.qShare}</button>
    <p id="qshare-status" role="status"></p><p class="qseries-rule">${q.qSeriesRule}</p>
    <details class="qanswers"><summary>${q.qExploreAnswers}</summary>`;
  qPz.stages.forEach((stage, i) => {
    const answers = qCore().uniqueChoices([...qRanked(stage), ...stage.answers]);
    const bonusKeys = new Set(qs.bonus?.stage === i ? qs.bonus.targets : []);
    const shown = answers.slice(0, 6);
    // Reveal every bonus option after the run, even if it was not guessed or
    // lies outside the usual first six. Rendering it never awards the bonus.
    for (const pid of answers.slice(6)) if (bonusKeys.has(qCore().choiceIdentity(pid))) shown.push(pid);
    html += `<div class="qreveal"><b>${q.qStages[i]} · ${esc(qClubNames(stage))}</b>`
      + shown.map(pid => {
        const link = `<button type="button" class="qrp" data-p="${pid}">${esc(DB.names[pid])}</button>`;
        return bonusKeys.has(qCore().choiceIdentity(pid)) ? `<span class="qbonus-option">${qBonusMark()} ${link}</span>` : link;
      }).join(", ")
      + (answers.length > shown.length ? ` <button type="button" class="qrmore" data-s="${i}">${q.qOthers(answers.length - shown.length)}</button>` : "") + `</div>`;
  });
  html += `</details>`;
  if (result.known && qs.guesses.length) html += `<details class="qrun-log"><summary>${q.qAllGuesses}</summary><ul>${$("qlog").innerHTML}</ul></details>`;
  if (st && !qReplaying) {
    const tile = (n, k) => `<div class="qtile"><span class="n">${n}</span><span class="k">${k}</span></div>`;
    html += `<details class="qstatistics"><summary>${q.qPersonalStats}</summary><div class="qtiles">${tile(st.played, q.qStatPlayed)}${tile(st.maxStreak, q.qStatBest)}</div>`;
    const max = Math.max(...st.byStage, 1);
    html += `<div id="qhisto"><span class="qhcap">${q.qHisto}</span>` + st.byStage.map((n, i) =>
      `<div class="qh${i === result.cleared ? " me" : ""}"><span class="qhl">${i}</span><span class="qhb"><span style="width:${n / max * 100}%"></span></span><span class="qhn">${n}</span></div>`).join("") + `</div></details>`;
  }
  el.innerHTML = html;
  $("qsharebtn").onclick = qShareOut;
  el.querySelectorAll(".qrp").forEach(b => b.onclick = () => qOpenPlayer(+b.dataset.p));
  el.querySelectorAll(".qrmore, .qmatch").forEach(b => b.onclick = () => qOpenSolver(qPz.stages[+b.dataset.s].clubs));
  if (newlyFinished) $("qresult-title").focus({ preventScroll: true });
}

// ---------------------------------------------------------------- calendar
// the archive: every Schedina from #1 to today, played days shown as a 2×2 block
// of the four stage outcomes, any past day replayable for practice. A full sheet
// inside #quiz (body.qcal), not a separate modal.
function qCalOpen(open) {
  document.body.classList.toggle("qcal", open);
  // focus the back button (a button, so no mobile keyboard) for keyboard/AT nav;
  // never auto-focus the guess input — that pops the on-screen keyboard uninvited
  if (open) { qRenderCal(); $("qcal").querySelector(".qcal-back")?.focus(); }
}
// Escape leaves the archive the same way the back button does — to today's game
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("qcal")) qCalPick(qToday());
});

function qUtcWeekday(n) {
  return new Date(Date.UTC(2024, 0, 1 + n)).toLocaleDateString(lang, { weekday: "narrow", timeZone: "UTC" });
}
function qUtcMonth(y, m) {
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(lang, { month: "long", year: "numeric", timeZone: "UTC" });
}
function qRenderCal() {
  const q = QSTR[lang], today = qToday(), days = qHistory().days;
  const active = qReplayDate || today;  // the board currently open — highlight this, not always today
  const [ty, tm] = today.split("-").map(Number);
  // Intl for the month/weekday labels — respects lang ("it"/"en"), no hardcoding.
  // Monday-first: the toLocaleDateString weekday of a known Monday, rotated.
  const wdRow = `<div class="qcwd">${[0, 1, 2, 3, 4, 5, 6].map(n => `<span>${qUtcWeekday(n)}</span>`).join("")}</div>`;
  const monLabel = qUtcMonth;
  // Walk from the current series' #1 (QEPOCH) to the current month.
  const ep = new Date(QEPOCH), sy = ep.getUTCFullYear(), sm = ep.getUTCMonth() + 1;
  const months = [];
  for (let y = sy, m = sm; y < ty || (y === ty && m <= tm); m === 12 ? (m = 1, y++) : m++) {
    const first = new Date(Date.UTC(y, m - 1, 1));
    const lead = (first.getUTCDay() + 6) % 7;  // Mon-first offset of the 1st
    const nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = [];  // one entry per grid slot, Monday-first: {html, play}
    for (let i = 0; i < lead; i++) cells.push({ html: `<span class="qcell out"></span>`, play: false });
    for (let d = 1; d <= nDays; d++) {
      const ds = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const num = qNum(ds), rec = days[ds];
      const future = ds > today, prelaunch = num < 1;
      // the box is the square (played 2×2 or an empty frame); the date is a caption below it, outside the box
      const cell = (extra, inner) => `<span class="qcell ${extra}"><span class="qcbox">${inner || ""}</span><span class="qcd">${d}</span></span>`;
      if (future || prelaunch) { cells.push({ html: cell("out"), play: false }); continue; }
      const cls = ["play", rec ? "done" : "todo", ds === today ? "today" : "", ds === active ? "current" : ""].filter(Boolean).join(" ");
      const bonusStage = rec?.state?.guesses?.find(g => g.ok && g.bonus && rec.res[g.stage] < 2)?.stage ?? -1;
      const label = `${q.qNum(num)}${rec ? " · " + rec.res.filter(c => c < 2).length + "/4" : ""}`
        + (bonusStage >= 0 ? ` · ${q.qBonusWon}` : "");
      cells.push({ play: true, html:
        `<button type="button" class="qcell ${cls}" data-d="${ds}" title="${esc(label)}" aria-label="${esc(label)}">`
        + `<span class="qcbox">${rec ? qSqCells(rec.res, bonusStage) : ""}</span><span class="qcd">${d}</span></button>` });
    }
    // drop whole weeks holding nothing playable: the pre-launch run-up in the
    // first month, the days still to come in the current one. Three dead rows
    // of July 2026 alone, and it keeps today on the last row of its month.
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    while (weeks.length && !weeks[0].some(c => c.play)) weeks.shift();
    while (weeks.length && !weeks.at(-1).some(c => c.play)) weeks.pop();
    months.push(`<section class="qcmon"><h3>${esc(monLabel(y, m))}</h3>${wdRow}`
      + `<div class="qcgrid">${weeks.flat().map(c => c.html).join("")}</div></section>`);
  }
  $("qcal").innerHTML =
    `<div class="qchead"><h2 id="qcaltitle">${q.qCalTitle}</h2>`
    + `<button type="button" class="qcal-back">${q.qCalBack}</button></div>`
    + `<p class="qchint">${q.qCalHint}</p><p class="qchint qlegend">${q.qLegend}</p>`
    // newest month first, so today is always the top-left cell block — with a
    // year of archive behind it, chronological order buries it below the fold
    + `<div class="qcmons">${months.reverse().join("")}</div>`;
  $("qcal").querySelector(".qcal-back").onclick = () => qCalPick(today);  // straight to today's game
  // a year of archive is ~365 day buttons: each month grid is ONE tab stop (the
  // open day, else its first), the arrows move within it — the date-picker idiom.
  // ±7 lands on the same weekday because the trimming above leaves every grid's
  // playable days contiguous.
  const QSTEP = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  $("qcal").querySelectorAll(".qcgrid").forEach(g => {
    const cells = [...g.querySelectorAll(".qcell.play")];
    if (!cells.length) return;
    const entry = g.querySelector(".qcell.current") || cells[0];
    cells.forEach(b => { b.tabIndex = b === entry ? 0 : -1; b.onclick = () => qCalPick(b.dataset.d); });
    g.onkeydown = (e) => {
      const i = QSTEP[e.key] ? cells.indexOf(e.target) : -1;
      if (i < 0 || !cells[i + QSTEP[e.key]]) return;
      e.preventDefault();
      cells[i + QSTEP[e.key]].focus();
    };
  });
}

// Open a day from the archive. Today is the live persistent game; any past day is
// restored from its completed state or its saved practice run.
function qCalPick(ds) {
  if (ds === qToday()) { qReplayDate = null; qReplaying = false; if (!qs || qs.date !== ds) qLoad(); }
  else { qReplayDate = ds; qStartReplay(ds); }
  if (qs) history.replaceState(null, "", QuizResult.quizUrl(location.href, qs.date));
  qCalOpen(false);
  qRender();
}

// end-screen click-through: load the matchup in club mode, quiz stays finished
function qOpenSolver(clubs) {
  clubIds = clubs.slice();
  leagueIds = [];
  countryIds = [];
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
  if (!DB) return;
  const url = new URL(location.href);
  const day = url.hash === "#quiz" ? QuizResult.validDay(url.searchParams.get("day"), QSERIES, qToday()) : null;
  if (document.body.classList.contains("quiz")) {
    if (day && day !== qs?.date) qCalPick(day);
    return;
  }
  if (day) qReplayDate = day !== qToday() ? day : null;
  qConfirm = null; qLeaveMode = null;
  pIndex();  // guess box searches all players, like player mode
  if (!qBuilt) { qBuild(); qBuilt = true; }
  // restore the same board a club/player detour left behind: a past replay if one
  // was open, else today's live game (a stale replay date that has become today
  // falls through to the live game)
  if (qReplayDate && qReplayDate !== qToday()) { qPools(); qStartReplay(qReplayDate); }
  else { qReplayDate = null; qLoad(); }
  document.body.classList.add("quiz");
  document.body.classList.remove("qcal");  // always (re-)enter on the board, not a stale archive
  history.replaceState(null, "", qs ? QuizResult.quizUrl(location.href, qs.date) : "#quiz");
  $("mode-quiz").setAttribute("aria-pressed", "true");
  $("mode-club").setAttribute("aria-pressed", "false");
  $("mode-player").setAttribute("aria-pressed", "false");
  suggOpen(false);  // app.js: closes the solver's list AND clears its combobox aria state
  browseOpen(false);
  qRender();
}
function qExit() {
  if (!document.body.classList.contains("quiz")) return;
  qConfirm = null; qLeaveMode = null;
  document.body.classList.remove("quiz");
  const url = new URL(location.href);
  url.searchParams.delete("day");
  history.replaceState(null, "", url.href);
  $("tagline").textContent = mode === "club" ? t.tagline : t.taglineP;  // restore solver tagline
  syncHash();  // drop #quiz, restore the solver's selection hash (or a clean URL)
  $("mode-quiz").setAttribute("aria-pressed", "false");
  $("mode-club").setAttribute("aria-pressed", mode === "club");
  $("mode-player").setAttribute("aria-pressed", mode === "player");
  if ((mode === "club" ? clubIds.length + leagueIds.length + countryIds.length : playerIds.length) === 0) solve();
}
// a run in progress (some guess or hint spent) is worth confirming before a
// switch abandons it; a fresh or finished board leaves freely. Capture phase
// on the bar runs before the buttons' own setMode/qExit handlers, so it can hold
// the destination while the in-card confirmation is visible.
const qInProgress = () => !qReplaying && qs && !qs.done && !qRolled()
  && !QuizResult.dailyWon(qs)
  && (qs.guesses.length || qs.skipped.length || Object.values(qs.hints).some(h => h !== null));
$("modebar").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.id === "mode-quiz" || !document.body.classList.contains("quiz")) return;
  if (!qInProgress()) return;
  e.stopImmediatePropagation(); e.preventDefault();
  qConfirm = "leave";
  qLeaveMode = btn.id === "mode-club" ? "club" : "player";
  qRender();
}, true);
$("mode-quiz").addEventListener("click", qEnter);
$("mode-club").addEventListener("click", qExit);
$("mode-player").addEventListener("click", qExit);
// langsel's own handler has already swapped `lang` when this one runs
langSel.addEventListener("change", () => { if (qBuilt && document.body.classList.contains("quiz")) qRender(); });
// a shared https://…/#quiz link opens straight into the game once data is ready
document.addEventListener("dbready", () => { if (location.hash === "#quiz") qEnter(); }, { once: true });
// warm the quiz while the solver idles after boot: the chain replay, the combination
// cache and the guess-box name index are all memoized, so paying them here
// makes the Quiz toggle instant. Start at the epoch so a missing schedule never
// triggers one large replay before the first warm-up slice. Resolve in 15-day
// steps; published dates require no generation. Idempotent:
// a #quiz deep link above has already done this work by the time it fires.
document.addEventListener("dbready", () => {
  const today = qToday(), num = qNum(today);
  const steps = [qPools];
  if (num >= 1) {
    for (let n = 1; n < num; n += 15) { const d = qShift(today, n - num); steps.push(() => qStagesFor(d)); }
    steps.push(() => qStagesFor(today));
  }
  steps.push(pIndex);
  const idle = (fn) => window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 1200);
  const next = () => { const s = steps.shift(); if (s) { s(); idle(next); } };
  idle(next);
}, { once: true });
// dbready fires once at boot; this covers every later hash change — a #quiz link
// opened in an already-loaded tab, the back button, or a hand-edited URL. (Our own
// replaceState calls don't fire hashchange, so entering/leaving can't loop here.)
addEventListener("hashchange", () => {
  if (location.hash === "#quiz") { qEnter(); return; }        // qEnter no-ops before DB is ready
  if (!document.body.classList.contains("quiz")) return;      // a hash change unrelated to the quiz
  // left #quiz for a solver selection hash (or none): adopt that selection, then qExit's
  // syncHash writes it straight back instead of clobbering it with the old clubs
  ({ clubs: clubIds, leagues: leagueIds, countries: countryIds } = parseSelectionHash());
  qExit();
  if (mode === "club") { renderChips(); solve(); }
});
addEventListener("popstate", () => { if (location.hash === "#quiz") qEnter(); });

// Console reset: { archive: true } also removes today's completed result;
// { stats: true } clears aggregate stats. The legacy boolean controls stats.
function quizReset(options = false) {
  const { stats = false, archive = false } = typeof options === "boolean" ? { stats: options } : options || {};
  if (archive) {
    const h = qHistory();
    delete h.days[qToday()];
    localStorage.quizHistory = JSON.stringify(h);
  }
  localStorage.removeItem("quiz");
  if (stats) localStorage.removeItem("quizStats");
  qReplayDate = null; qReplaying = false;
  qConfirm = null; qLeaveMode = null;
  if (document.body.classList.contains("quiz")) {
    document.body.classList.remove("qcal");
    qLoad();
    if (qs) history.replaceState(null, "", QuizResult.quizUrl(location.href, qs.date));
    qRender();
  }
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
  if (!p) return null;
  return { ...p, stages: p.stages.map(st => {
    const eff = qEffective(st.clubs, st.answers);
    return { clubs: st.clubs.map(ci => DB.clubs[ci][0]),
      difficulty: qCore().stageDiagnostics(st).difficulty,
      n: st.answers.length, real: eff.length, tier: st.tier, ease: Math.round(qEase(st.clubs, eff, st.audience)),
      answers: st.answers.slice(0, 12).map(pid => DB.names[pid]), face: DB.names[qFace(st)] };
  }) };
}
function quizDebug(days = 14) {
  const rows = [], d = new Date();
  for (let k = 0; k < days; k++) {
    const p = qGen(qFmt(d));
    if (!p) { d.setDate(d.getDate() + 1); continue; }
    const row = { date: p.date };
    p.stages.forEach((st, i) => {
      const eff = qEffective(st.clubs, st.answers);
      row[`s${i + 1}`] = st.clubs.map(ci => coreClub(DB.clubs[ci][0])).join(" × ");
      row[`n${i + 1}`] = `${eff.length}·e${Math.round(qEase(st.clubs, eff, st.audience))}${qTierTag(st.tier)}`;
    });
    rows.push(row);
    d.setDate(d.getDate() + 1);
  }
  console.table(rows);
}
