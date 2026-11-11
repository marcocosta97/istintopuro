#!/usr/bin/env node
"use strict";

// Optional clues annotate an already generated schedule; they never pick clubs.
const fs = require("node:fs");
const path = require("node:path");
const { MARQUEE_QIDS, EASY_QIDS } = require("../site/quiz-core.js");

function buildBonuses(runtime, schedule, previous = {}, directory = path.join(__dirname, "../site/data/career")) {
  const { index: db, core } = runtime, shards = new Map();
  const career = pid => {
    const shard = pid % (db.nshards || 128);
    if (!shards.has(shard)) {
      const file = path.join(directory, `${shard}.json`);
      shards.set(shard, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
    }
    return shards.get(shard)[pid]?.[1] || [];
  };
  core.qPools();
  const normal = name => name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const major = new Set([...MARQUEE_QIDS, ...EASY_QIDS]);
  const familiar = new Set(db.clubs.filter(c => major.has(c[3])).map(c => normal(c[0])));
  function matches(bonus, pid) {
    if (bonus.kind === "nationality") {
      const countries = (db.nats[pid] || "").split(",");
      // New clues name one country; keep old multi-country conditions valid.
      return bonus.value.split(",").every(cc => countries.includes(cc));
    }
    if (bonus.kind === "birth") return db.births[pid] >= bonus.from && db.births[pid] <= bonus.to;
    return bonus.kind === "career" && career(pid).some(sp => normal(sp[0]) === normal(bonus.value)
      && (sp[3] === undefined || sp[3] !== 0)
      && (!bonus.from || sp[1] === bonus.from && sp[2] === bonus.to));
  }
  const targetKeys = (bonus, answers) => [...new Set(answers.filter(pid => matches(bonus, pid)).map(core.choiceIdentity))].sort();
  const bonuses = {};
  for (const [date, entry] of Object.entries(schedule.days).sort(([a], [b]) => a.localeCompare(b))) {
    const checked = core.validateEntry(entry, { requireOrder: false, requireLevels: false });
    if (!checked.ok) throw new Error(`Cannot annotate invalid quiz ${date}`);
    const stages = checked.stages;
    const old = previous.bonuses?.[date];
    // An existing criterion (including an intentionally absent one) stays pinned
    // while its matchup is unchanged. Targets are remapped by name/birth choice.
    if (Object.prototype.hasOwnProperty.call(previous.bonuses || {}, date)
        && JSON.stringify(previous.days?.[date]) === JSON.stringify(entry)) {
      if (old === null) { bonuses[date] = null; continue; }
      if (old && old.stage >= 0 && old.stage < 3 && ["career", "nationality", "birth"].includes(old.kind)) {
        const targets = targetKeys(old, stages[old.stage].answers);
        bonuses[date] = targets.length ? { ...old, targets } : null;
        continue;
      }
    }
    bonuses[date] = null;
    let birthFallback = null;
    for (let stage = 0; stage < 3; stage++) {
      const st = stages[stage];
      const ranked = core.uniqueChoices(core.qRanked(st)).filter(pid => core.qUsableName(pid)
        && st.clubs.every(ci => core.qApps(ci, pid) > 0));
      if (ranked.length < 3) continue;
      const topKey = core.choiceIdentity(ranked[0]), maxTargets = Math.min(2, Math.floor(ranked.length / 2));
      const topFame = Math.max(1, core.qBridgeFame(ranked[0], st.clubs));
      const recentPressure = kind => Object.entries(bonuses).slice(0, -1).reduce((sum, [day, bonus]) => {
        if (bonus?.kind !== kind) return sum;
        const age = (Date.parse(date) - Date.parse(day)) / 864e5;
        return sum + Math.pow(.5, age - 1);
      }, 0);
      const candidates = new Map();
      const add = (criterion, detail = 0) => {
        const targets = targetKeys(criterion, st.answers);
        if (!targets.length || targets.length > maxTargets || targets.includes(topKey)) return;
        const pids = ranked.filter(pid => targets.includes(core.choiceIdentity(pid)));
        if (!pids.length || pids.some(pid => !db.births[pid] || db.births[pid] < 1935)) return;
        // Do not turn low-data registrations or unusable names into rewards.
        const fame = Math.max(...pids.map(pid => core.qBridgeFame(pid, st.clubs)));
        if (fame < 80) return;
        // Judge the actual answer subset: a selective clue pointing away from
        // the obvious answer is more useful than a generic demographic fact.
        const selectivity = 1 - targets.length / ranked.length;
        const contrast = Math.max(0, Math.min(1, 1 - fame / topFame));
        // Same 0–1 scale for every kind: neither the type nor a player's number
        // of career spells can add points to the answer-subset quality.
        const quality = (selectivity + contrast) / 2;
        const key = JSON.stringify(criterion);
        // A condition shared by several players keeps its strongest supporting
        // spell, rather than depending on which player happened to be visited last.
        if (candidates.get(key)?.detail >= detail) return;
        candidates.set(key, { ...criterion, stage, targets, quality, detail,
          tie: core.qHash(`${date}|${key}`) });
      };
      for (const pid of ranked.slice(1)) {
        for (const cc of (db.nats[pid] || "").split(",").filter(Boolean)) add({ kind: "nationality", value: cc });
        const birth = db.births[pid];
        if (birth) add({ kind: "birth", from: Math.floor(birth / 10) * 10, to: Math.floor(birth / 10) * 10 + 9 });
        for (const sp of career(pid)) {
          if (!sp[0] || sp[3] === 0 || sp[3] > 0 && sp[3] < 5
              || familiar.has(normal(sp[0])) || st.clubs.some(ci => normal(db.clubs[ci][0]) === normal(sp[0]))) continue;
          const criterion = { kind: "career", value: sp[0] };
          if (Number.isInteger(sp[1]) && Number.isInteger(sp[2]) && sp[1] > 1900 && sp[2] >= sp[1]
              && sp[1] >= (birth || 0) + 15 && sp[2] <= (birth || 0) + 50) {
            criterion.from = sp[1]; criterion.to = sp[2];
          }
          // Supporting detail chooses between equally good career clues only;
          // it never gives career a head start over nationality.
          const substance = Math.min(Math.max(sp[3] || 0, 0), 50) / 50;
          add(criterion, substance + (criterion.from ? 1 : 0));
        }
      }
      const bestOfKind = kind => [...candidates.values()].filter(c => c.kind === kind)
        .sort((a, b) => b.quality - a.quality || b.detail - a.detail || a.tie - b.tie)[0];
      // Each family gets one finalist, so offering many career clues does not
      // buy more tie-break tickets. Variety applies only within a 0.1 band.
      const finalists = [bestOfKind("nationality"), bestOfKind("career")].filter(Boolean);
      const bestQuality = Math.max(...finalists.map(c => c.quality));
      const band = Math.floor(bestQuality * 10 + 1e-9);
      const comparable = finalists.filter(c => Math.floor(c.quality * 10 + 1e-9) === band);
      // A gentle, decaying penalty affects chances, not a hard weekly count.
      // Repeats remain possible; a full history contributes less than 2 pressure
      // points, so recency alone never reduces a family's weight below 2/3.
      const weights = comparable.map(c => Math.exp(2 * (c.quality - bestQuality)) / (1 + .25 * recentPressure(c.kind)));
      let best = comparable[0];
      if (comparable.length > 1) {
        // Private RNG instance: no generator state or puzzle selection is consumed.
        let draw = core.qRng(core.qHash(`${date}|bonus-variety`))() * weights.reduce((a, b) => a + b, 0);
        best = comparable.at(-1);
        for (let i = 0; i < comparable.length; i++) {
          draw -= weights[i];
          if (draw < 0) { best = comparable[i]; break; }
        }
      }
      if (best) {
        const { quality, detail, tie, ...bonus } = best;
        bonuses[date] = bonus;
        break;
      }
      if (!birthFallback) {
        const birth = bestOfKind("birth");
        if (birth) {
          const { quality, detail, tie, ...bonus } = birth;
          birthFallback = bonus;
        }
      }
    }
    // A birth-only Easy must not hide a useful nationality/career clue on
    // Medium or Hard. Use the first birth fallback only after checking all three.
    bonuses[date] ||= birthFallback;
  }
  return bonuses;
}

module.exports = { buildBonuses };
