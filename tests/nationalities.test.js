"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function runtime() {
  const source = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
  const context = vm.createContext({ lang: "it", t: { natUnknown: "sconosciuta" },
    esc: value => String(value).replace(/[&<>"']/g, char =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]),
  });
  vm.runInContext(source.slice(source.indexOf("const NO_EMOJI_FLAG ="), source.indexOf("// defunct marker:")), context);
  return { context, ...vm.runInContext("({ flag, natName })", context) };
}

test("current emoji flags and existing historical SVG flags are preserved", () => {
  const { flag } = runtime();
  assert.match(flag("IT"), /🇮🇹/u);
  assert.match(flag("YU"), /class="hflag hf-yu"/);
  assert.match(flag("YU"), /aria-label="Jugoslavia"/);
  assert.equal(flag(""), "");
});

test("missing flag artwork uses an accessible country-code label", () => {
  const { flag } = runtime();
  assert.match(flag("ZZ"), /aria-label="[^"]+">ZZ<\/span>/);
  assert.doesNotMatch(flag("ZZ"), /[\u{1F1E6}-\u{1F1FF}]/u);
  assert.doesNotMatch(flag("ZZ"), /hflag/);
});

test("Soviet nationality remains distinct from Russia in both languages", () => {
  const { flag, natName, context } = runtime();
  assert.equal(natName("SU"), "Unione Sovietica");
  assert.match(flag("SU,RU"), /aria-label="Unione Sovietica">SU<\/span>/);
  assert.match(flag("SU,RU"), /🇷🇺/u);
  context.lang = "en";
  assert.equal(natName("SU"), "Soviet Union");
  assert.match(flag("SU"), /aria-label="Soviet Union">SU<\/span>/);
});

test("fallback labels escape unexpected source text", () => {
  const { flag } = runtime();
  const html = flag('<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&quot;alert/);
});
