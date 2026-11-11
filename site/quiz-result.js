"use strict";

// Result semantics are independent of puzzle generation and browser storage.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuizResult = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  function codes(state) {
    const reached = state.won ? 4 : state.stage;
    return [0, 1, 2, 3].map(i => (state.skipped || []).includes(i) ? 2
      : i < reached ? (Object.values(state.hints || {}).includes(i) ? 1 : 0)
      : state.done && !state.won && i === state.stage ? 2 : 3);
  }
  const dailyCleared = state => codes(state).slice(0, 3).filter(c => c < 2).length;
  const dailyWon = state => dailyCleared(state) === 3;
  function describe(state) {
    const known = !state.resultDetailsMissing;
    const rows = codes(state).map((code, stage) => {
      const guesses = (state.guesses || []).filter(g => g.stage === stage);
      const hit = known ? guesses.find(g => g.ok) || null : null;
      const hints = known ? Object.values(state.hints || {}).filter(i => i === stage).length : null;
      const errors = known ? guesses.filter(g => !g.ok).length : null;
      return { stage, code, hit, hints, errors, skipped: (state.skipped || []).includes(stage),
        bonus: !!hit?.bonus, firstTry: !!hit && !hints && !errors,
        attempts: known ? guesses.map(g => !g.ok ? "miss" : g.bonus ? "bonus" : hints ? "hint" : "hit") : [] };
    });
    return { rows, known, daily: dailyCleared(state), success: dailyWon(state),
      cleared: rows.filter(r => r.code < 2).length, impossible: rows[3].code < 2,
      bonus: rows.some(r => r.bonus), errors: known ? rows.reduce((n, r) => n + r.errors, 0) : null,
      hints: known ? rows.reduce((n, r) => n + r.hints, 0) : null };
  }
  function dayNumber(date) {
    const [y, m, d] = date.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 864e5;
  }
  function streakStats(previous) {
    const st = previous ? { ...previous } :
      { v: 1, played: 0, streak: 0, maxStreak: 0, lastWinDate: null, byStage: [0, 0, 0, 0, 0] };
    // A saved four-stage winning streak is also valid under the three-stage rule.
    // Archive replays may have overwritten old calendar rows: do not invent
    // official historical wins from practice results during migration.
    if (st.dailyPolicy !== 2) {
      st.lastSuccessDate = st.streak > 0 ? st.lastWinDate : null;
      st.dailyPolicy = 2;
    }
    return st;
  }
  function updateStreak(previous, state) {
    const st = streakStats(previous);
    if (dailyWon(state)) {
      if (st.lastSuccessDate && st.lastSuccessDate >= state.date) return st;
      const adjacent = st.lastSuccessDate && dayNumber(state.date) - dayNumber(st.lastSuccessDate) === 1;
      st.streak = adjacent ? st.streak + 1 : 1;
      st.maxStreak = Math.max(st.maxStreak, st.streak);
      st.lastSuccessDate = state.date;
      st.lastWinDate = state.date;
    } else if (state.done && (!st.lastSuccessDate || state.date > st.lastSuccessDate)) st.streak = 0;
    return st;
  }
  function visibleStreak(st, today) {
    if (!st?.lastSuccessDate || dayNumber(today) - dayNumber(st.lastSuccessDate) > 1) return 0;
    return st.streak || 0;
  }
  function validDay(day, first, today) {
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < first || day > today) return null;
    const time = dayNumber(day) * 864e5;
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? day : null;
  }
  function quizUrl(base, day) {
    const url = new URL(base);
    url.searchParams.set("day", day);
    url.hash = "quiz";
    return url.href;
  }
  return { codes, dailyCleared, dailyWon, describe, streakStats, updateStreak, visibleStreak, validDay, quizUrl };
});
