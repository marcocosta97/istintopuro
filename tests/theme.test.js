"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../site/index.html"), "utf8");
const startup = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const translations = app.slice(app.indexOf("const REPO ="), app.indexOf("let lang ="));
const toggle = app.slice(app.indexOf("const themeBtn ="), app.indexOf("langSel.onchange ="));

function browser(system, saved, language = "it", storageDenied = false) {
  const attributes = {}, buttonAttributes = {}, listeners = [];
  const savedItems = new Map(saved ? [["theme", saved]] : []);
  const storage = {
    getItem(key) { return savedItems.get(key) ?? null; },
    setItem(key, value) { if (storageDenied) throw Error("denied"); savedItems.set(key, value); },
    removeItem(key) { if (storageDenied) throw Error("denied"); savedItems.delete(key); },
  };
  const metas = [...html.matchAll(/<meta name="theme-color" media="([^"]+)" content="([^"]+)">/g)]
    .map(match => ({ media: match[1], content: match[2], setAttribute(key, value) { this[key] = value; } }));
  const button = {
    setAttribute(key, value) { buttonAttributes[key] = value; },
    getAttribute(key) { return buttonAttributes[key]; },
  };
  const media = { matches: system === "dark", addEventListener(type, fn) { listeners.push(fn); } };
  const context = vm.createContext({
    document: {
      documentElement: {
        getAttribute(key) { return attributes[key] ?? null; },
        setAttribute(key, value) { attributes[key] = value; },
        removeAttribute(key) { delete attributes[key]; },
      },
      querySelectorAll(selector) { assert.equal(selector, 'meta[name="theme-color"]'); return metas; },
    },
    localStorage: storage, matchMedia: () => media, $: () => button,
  });
  vm.runInContext(startup, context);
  const initialColor = metas.find(meta => meta.media.includes(system)).content;
  vm.runInContext(translations + `\nlet t = STR[${JSON.stringify(language)}];\n` + toggle, context);
  return {
    click: () => button.onclick(),
    mode: () => attributes["data-theme"] || "system",
    theme: () => attributes["data-theme"] || (media.matches ? "dark" : "light"),
    saved: () => storage.getItem("theme"),
    label: () => buttonAttributes["aria-label"],
    icon: () => button.innerHTML,
    initialColor,
    colors: () => metas.map(meta => meta.content),
    system(value) { media.matches = value === "dark"; listeners.forEach(fn => fn()); },
  };
}

for (const [system, opposite] of [["light", "dark"], ["dark", "light"]]) {
  test(`system ${system}: first click changes appearance and all three modes are reachable`, () => {
    const page = browser(system);
    assert.equal(page.mode(), "system");
    assert.equal(page.theme(), system);
    for (const mode of [opposite, system, "system"]) {
      page.click();
      assert.equal(page.mode(), mode);
      assert.equal(page.saved(), mode === "system" ? null : mode);
      assert.equal(browser(system, page.saved()).mode(), mode);
    }
    assert.equal(page.theme(), system);
  });

  test(`system ${system}: manual preference survives changes; restored auto follows live`, () => {
    const page = browser(system);
    page.click();
    page.system(opposite);
    page.system(system);
    assert.equal(page.theme(), opposite);
    page.click();
    page.click();
    page.system(opposite);
    assert.equal(page.mode(), "system");
    assert.equal(page.theme(), opposite);
    page.click();
    assert.equal(page.theme(), system);
  });

  test(`system ${system}: browser color matches startup, saved overrides and subsequent changes`, () => {
    for (const saved of [undefined, "light", "dark"]) {
      const page = browser(system, saved);
      const check = () => assert.deepEqual(page.colors(), Array(2).fill(page.theme() === "dark" ? "#0c1210" : "#fafaf8"));
      assert.equal(page.initialColor, page.theme() === "dark" ? "#0c1210" : "#fafaf8");
      check();
      for (let i = 0; i < 3; i++) { page.click(); check(); }
      page.system(opposite);
      check();
    }
  });
}

test("button names identify current mode and next action in both languages", () => {
  for (const [language, labels] of [
    ["it", ["Tema: sistema. Passa al tema scuro", "Tema: scuro. Passa al tema chiaro", "Tema: chiaro. Segui il tema del sistema"]],
    ["en", ["Theme: system. Switch to dark theme", "Theme: dark. Switch to light theme", "Theme: light. Follow the system theme"]],
  ]) {
    const page = browser("light", undefined, language);
    for (const label of labels) {
      assert.equal(page.label(), label);
      assert.match(page.icon(), /<svg/);
      page.click();
    }
    assert.equal(page.label(), labels[0]);
  }
});

test("a system change refreshes the next action without overriding a manual choice", () => {
  const page = browser("light", "light");
  assert.match(page.label(), /Segui il tema del sistema/);
  page.system("dark");
  assert.equal(page.theme(), "light");
  assert.match(page.label(), /Passa al tema scuro/);
});

test("icons show the selected mode throughout the cycle and system changes", () => {
  const icons = {
    system: /<rect /,
    light: /<circle /,
    dark: /<path /,
  };
  for (const system of ["light", "dark"]) {
    for (const saved of [undefined, "light", "dark"]) {
      const page = browser(system, saved);
      const check = () => assert.match(page.icon(), icons[page.mode()]);
      check();
      for (let i = 0; i < 3; i++) { page.click(); check(); }
      const before = page.icon();
      page.system(system === "light" ? "dark" : "light");
      check();
      assert.equal(page.icon(), before);
    }
  }
});

test("switching and restoring automatic mode work when preference writes are denied", () => {
  const page = browser("light", undefined, "it", true);
  page.click();
  assert.equal(page.theme(), "dark");
  page.click();
  page.click();
  page.system("dark");
  assert.equal(page.mode(), "system");
  assert.equal(page.theme(), "dark");
});
