"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

async function renderCareer(spells) {
  const source = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
  let rendered;
  const context = vm.createContext({
    DB: { gkSet: new Set(), births: [2000], built: "2026-11-03" },
    careerOf: async () => [0, spells],
    mode: "player", sharedNames: new Set(), esc: String,
    t: { loan: "prestito", apps: n => `presenze (${n})`, goals: n => `gol (${n})` },
    document: { createElement: () => ({ querySelector: () => null }) },
  });
  vm.runInContext(source.slice(source.indexOf("const yspan ="),
    source.indexOf("// ---------------------------------------------------------------- club stature")), context);
  vm.runInContext(source.slice(source.indexOf("async function toggleCareer("),
    source.lastIndexOf("\napplyLang();")), context);
  await context.toggleCareer({
    querySelector: selector => selector === ".expand" ? {} : null,
    setAttribute() {}, appendChild: div => { rendered = div.innerHTML; },
  }, 0);
  return rendered.match(/<div class="crow[^"]*">[\s\S]*?<\/div>/g) || [];
}

test("Toldo's Milan stay precedes Verona and his other loans in existing shards", async () => {
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, "../site/data/index.json")));
  const pid = index.names.indexOf("Francesco Toldo");
  assert.ok(pid >= 0);
  const shard = JSON.parse(fs.readFileSync(path.join(__dirname,
    `../site/data/career/${pid % index.nshards}.json`)));
  const spells = shard[pid][1], before = structuredClone(spells);
  const rows = await renderCareer(spells);
  const expected = ["AC Milan", "Hellas Verona FC", "Trento Calcio 1921",
    "S.C. Ravenna Sport", "ACF Fiorentina", "Inter Milan"];
  assert.equal(rows.length, expected.length);
  expected.forEach((name, i) => assert.ok(rows[i].includes(name), name));
  assert.doesNotMatch(rows[0], /class="loan"/);
  for (const i of [1, 2, 3]) assert.match(rows[i], /class="loan"/);
  assert.deepEqual(spells, before);
});

test("same-start loans without a flag are inferred after the parent stay", async () => {
  const rows = await renderCareer([
    ["Loan club", 1990, 1991, 10, 0], ["Parent club", 1990, 1993, 0, 0],
  ]);
  assert.match(rows[0], /Parent club/);
  assert.doesNotMatch(rows[0], /class="loan"/);
  assert.match(rows[1], /class="loan"/);
});

test("open parent stays, equal ranges and undated spells keep a useful order", async () => {
  const rows = await renderCareer([
    ["Undated", null, null], ["Later", 2025, 2026],
    ["Short loan", 2024, 2025, 1, 0, 1], ["Open parent", 2024, null],
    ["Equal loan", 2020, 2021, 1, 0, 1], ["Equal parent", 2020, 2021],
  ]);
  ["Equal parent", "Equal loan", "Open parent", "Short loan", "Later", "Undated"]
    .forEach((name, i) => assert.ok(rows[i].includes(name), name));
});
