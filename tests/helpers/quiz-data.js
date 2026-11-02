"use strict";

// Enough independent registrations to exercise production pool/stature rules.
// Only the first player has played, so filler registrations cannot inflate ease.
function recognitionIndex() {
  const count = 120;
  return {
    built: "2026-10-26",
    leagues: [["Serie A", 1, "IT"], ["Premier League", 1, "GB"]],
    clubs: [["Milan", "IT", 1, "Q1543", 0, 0],
      ["Chelsea", "GB", 2, "Q9616", 0, 1],
      ["Fiorentina", "IT", 1, "Q2052", 0, 0]],
    names: Array.from({ length: count }, (_, i) => `Test Player ${i}`),
    births: Array(count).fill(1990), nats: Array(count).fill("IT"),
    imgs: Array(count).fill(""), gks: [],
    postings: Array.from({ length: 3 }, () => Array.from({ length: count }, (_, i) => i ? 1 : 0)),
    apps: [80, 90, 200].map(apps => [apps, ...Array(count - 1).fill(0)]),
    goals: Array.from({ length: 3 }, () => Array(count).fill(0)),
  };
}

module.exports = { recognitionIndex };
