"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { compose } = require("../site/packs.js");

const source = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, "../site/data", file), "utf8"));

function runtime() {
  const core = read("index.json");
  const DB = compose(core, core.packs.map(pack => read(`packs/${pack.id}/index.json`)));
  const context = vm.createContext({ DB, clubIds: [], MARQUEE: new Set(),
    T_NAME: 0, T_WORD: 1, T_ALL: 2, T_INFIX: 3 });
  vm.runInContext(source.slice(source.indexOf("const ALIASES ="), source.indexOf("// A nat is")), context);
  vm.runInContext(source.slice(source.indexOf("  DB.searchNames ="), source.indexOf("  ({ clubs: clubIds,")), context);
  vm.runInContext(source.slice(source.indexOf("const SUGG ="), source.indexOf("// League names share")), context);
  const api = vm.runInContext("({ coreClub, sortName, norm, clubNorm })", context);
  return { DB, context, ...api,
    matches: query => [...context.clubMatches(query, false)].map(ci => DB.clubs[ci][3]) };
}

test("SPAL uses its conventional name and accepts dotted, compact and full queries", () => {
  const { DB, matches, coreClub, sortName } = runtime();
  const club = DB.clubs.find(c => c[3] === "Q13385");
  assert.equal(coreClub(club[0]), "S.P.A.L.");
  assert.equal(sortName(club[0]), "spal");
  for (const query of ["spal", "S.P.A.L.", "s.p.a.l", "Ars et Labor", club[0],
    "Società Polisportiva Ars et Labor", "SPAL 2013"])
    assert.equal(matches(query)[0], "Q13385", query);
  assert.equal(coreClub("Società Polisportiva Ars et Labor"), "S.P.A.L.");
  assert.equal(club[0], "Ars et Labor Ferrara Calcio", "retain the source label");
});

test("other conventional names display and match in core and optional leagues", () => {
  const { DB, matches, coreClub } = runtime();
  for (const [qid, name] of [["Q483020", "PSG"], ["Q18723", "QPR"],
    ["Q501693", "ESTAC Troyes"], ["Q191264", "AZ"], ["Q11938", "PSV"],
    ["Q2306468", "ASA"], ["Q1024264", "CRB"], ["Q2946171", "CEUB"], ["Q1028545", "Icasa"]]) {
    const club = DB.clubs.find(c => c[3] === qid);
    assert.ok(club, qid);
    assert.equal(coreClub(club[0]), name);
    assert.equal(matches(name)[0], qid, name);
    assert.equal(matches(club[0])[0], qid, club[0]);
  }
});

test("French acronyms and dotted spellings reach the intended club", () => {
  const { matches } = runtime();
  for (const [query, qid] of [["OM", "Q132885"], ["OL", "Q704"], ["LOSC", "Q19516"],
    ["ASSE", "Q19521"], ["ESTAC", "Q501693"], ["P.S.G.", "Q483020"],
    ["Q.P.R.", "Q18723"], ["NEC", "Q318348"], ["N.E.C.", "Q318348"]])
    assert.equal(matches(query)[0], qid, query);
});

test("legal-name shortening, disambiguation and existing search aliases survive", () => {
  const { coreClub, sortName, matches, norm, clubNorm, context } = runtime();
  for (const [name, short] of [["AC Milan", "Milan"], ["Bologna F.C. 1909", "Bologna"],
    ["Athletic Club", "Athletic Club"], ["Paris FC", "Paris FC"],
    ["Hamburger SV", "Hamburger SV"], ["Unknown United", "Unknown United"]])
    assert.equal(coreClub(name), short);
  assert.equal(matches("inter")[0], "Q631");
  assert.equal(matches("bayern monaco")[0], "Q15789");
  assert.equal(matches("monaco")[0], "Q180305");
  assert.equal(matches("st etienne")[0], "Q19521");
  assert.equal(sortName("A.S.D. Barletta 1922"), "barletta 1922");
  assert.equal(sortName("U.C. Sampdoria"), "sampdoria");
  assert.equal(norm("J.P. Smith"), "j p smith", "player normalization stays independent");
  assert.equal(clubNorm("N.E.C."), "nec");
  vm.runInContext('clubIds = [DB.byQid.get("Q13385")]', context);
  assert.ok(!matches("spal").includes("Q13385"), "selected clubs remain excluded");
});

test("club suggestions present the shortened name with the full source label in a title", () => {
  const { DB, context } = runtime();
  const rows = [];
  Object.assign(context, { mode: "club", sugg: { children: rows, appendChild: li => rows.push(li) },
    document: { createElement: () => ({ setAttribute() {} }) },
    countryFlag: () => "", hilite: name => name, defunct: () => "",
    leagueNames: () => "", isCountryToken: () => false, isLeagueToken: () => false,
    suggOpen() {}, moveCursor() {},
  });
  vm.runInContext(source.slice(source.indexOf("function renderSuggestions("), source.indexOf("const addSel =")), context);
  context.renderSuggestions([DB.byQid.get("Q13385")], "spal");
  assert.match(rows[0].innerHTML, />\s*S\.P\.A\.L\.</);
  assert.match(rows[0].innerHTML, /title="Ars et Labor Ferrara Calcio"/);
});
