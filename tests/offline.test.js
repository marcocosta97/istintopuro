"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const OfflineGame = require("../site/offline.js");
const SITE = path.join(__dirname, "../site");
const BASE = "https://game.test/football/";
const absolute = value => new URL(typeof value === "string" ? value : value.url, BASE).href;
const index = { built: "2026-10-12", nshards: 2, clubs: [["A"], ["B"]],
  packs: [{ id: "pt", built: "2026-10-12" }] };
const pack = { id: "pt", built: index.built, nshards: 2, clubs: [["C", "PT", 1, "Q10"]] };

function storage() {
  const all = new Map();
  return {
    failPut: null,
    async has(name) { return all.has(name); },
    async keys() { return [...all.keys()]; },
    async delete(name) { return all.delete(name); },
    async open(name) {
      if (!all.has(name)) all.set(name, new Map());
      const files = all.get(name), owner = this;
      return {
        async match(request) { return files.get(absolute(request))?.clone(); },
        async put(request, response) {
          if (owner.failPut?.(absolute(request))) throw new Error("QuotaExceededError");
          files.set(absolute(request), response.clone());
        },
        async delete(request) { return files.delete(absolute(request)); },
        async keys() { return [...files.keys()].map(url => ({ url })); },
      };
    },
    async match(request) {
      for (const name of all.keys()) {
        const hit = await (await this.open(name)).match(request);
        if (hit) return hit;
      }
    },
  };
}

function worker({ version = "one", caches = storage(), network = {} } = {}) {
  const listeners = {}, messages = [], requests = [];
  const client = { url: BASE, postMessage: message => messages.push(message) };
  const self = { location: new URL(`sw.js?v=${version}`, BASE),
    clients: { matchAll: async () => [client], claim: async () => {} },
    skipWaiting: async () => { self.skipped = true; },
    addEventListener: (type, callback) => { listeners[type] = callback; },
  };
  const fetch = async request => {
    const url = new URL(absolute(request));
    requests.push(url.href);
    if (network.offline || network.fail?.(url)) throw new Error("network unavailable");
    if (network.hold) await network.hold(url);
    if (network.status) return new Response("unavailable", { status: network.status });
    let body = "asset";
    if (url.pathname.endsWith("/data/index.json")) body = index;
    else if (url.pathname.endsWith("/quiz-schedule.json")) body = {
      v: 1, built: network.wrongBuild || index.built, through: "2027-01-10", days: {},
    };
    else if (url.pathname.endsWith("/data/packs/pt/index.json")) body = pack;
    else if (url.pathname.endsWith(".json")) body = network.invalidJson ? "<html>error</html>" : [];
    else if (url.pathname === "/football/") body = `<script src="app.js?v=${network.release || version}"></script>`;
    return new Response(typeof body === "string" ? body : JSON.stringify(body));
  };
  const context = vm.createContext({ self, caches, fetch, URL, Response, AbortController, setTimeout, clearTimeout, console });
  context.importScripts = () => vm.runInContext(fs.readFileSync(path.join(SITE, "offline.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(SITE, "sw.js"), "utf8"), context);
  async function dispatch(type, data = {}) {
    const pending = [];
    let response;
    listeners[type]({ source: client, ports: [], ...data,
      waitUntil: promise => pending.push(promise), respondWith: promise => { response = promise; },
    });
    const result = response ? await response : undefined;
    await Promise.all(pending);
    return result;
  }
  return { self, messages, requests, caches, network, dispatch,
    install: () => dispatch("install"), activate: () => dispatch("activate"),
    message: data => dispatch("message", { data }),
    request: (file, mode = "cors") => dispatch("fetch", { request: { url: absolute(file), method: "GET", mode } }),
  };
}

test("offline inventories cover every published core and pack file, including flags and hints", () => {
  const core = JSON.parse(fs.readFileSync(path.join(SITE, "data/index.json")));
  const files = OfflineGame.coreFiles(core, "release");
  const actual = folder => fs.readdirSync(path.join(SITE, folder)).map(file => `./${folder}/${file}`);
  for (const file of [...actual("data/career"), ...actual("data/years"), ...actual("flags")])
    assert.ok(files.some(url => url.split("?")[0] === file), file);
  for (const file of files) assert.ok(fs.existsSync(path.join(SITE, file.split("?")[0])), file);
  for (const meta of core.packs) {
    const optional = JSON.parse(fs.readFileSync(path.join(SITE, `data/packs/${meta.id}/index.json`)));
    const routes = OfflineGame.packFiles(optional);
    for (const file of [...actual(`data/packs/${meta.id}/career`), ...actual(`data/packs/${meta.id}/years`)])
      assert.ok(routes.some(url => url.split("?")[0] === file), file);
    for (const file of routes) assert.ok(fs.existsSync(path.join(SITE, file.split("?")[0])), file);
  }
});

test("a first install stores everything before activation and survives a cold offline launch", async () => {
  const app = worker();
  await app.install();
  assert.equal(app.self.skipped, true);
  assert.equal(app.messages.at(-1).state, "ready");
  const restarted = worker({ caches: app.caches, network: { offline: true } });
  const html = await restarted.request("./?day=2026-10-20#quiz", "navigate");
  assert.match(await html.text(), /app.js\?v=one/);
  for (const file of OfflineGame.coreFiles(index, "one").slice(1))
    assert.ok((await restarted.request(file)).ok, file);
  await restarted.message({ type: "offline-status" });
  assert.equal(restarted.messages.at(-1).state, "ready");
  assert.equal(restarted.messages.at(-1).through, "2027-01-10");
});

test("interrupted updates leave the previous complete game available and resume later", async () => {
  const old = worker();
  await old.install();
  const next = worker({ version: "two", caches: old.caches,
    network: { fail: url => url.pathname.endsWith("/quiz.js") } });
  await assert.rejects(next.install(), /network unavailable/);
  assert.equal(next.self.skipped, undefined);
  assert.equal(next.messages.at(-1).state, "error");
  old.network.offline = true;
  assert.match(await (await old.request("./", "navigate")).text(), /v=one/);
  next.network.fail = null;
  await next.install();
  await next.activate();
  next.network.offline = true;
  assert.match(await (await next.request("./", "navigate")).text(), /v=two/);
  assert.ok(await next.caches.has("istintopuro-offline-one"));
});

test("storage failures and mismatched releases never become ready", async () => {
  const quota = worker();
  quota.caches.failPut = url => url.includes("/data/career/");
  await assert.rejects(quota.install(), /QuotaExceededError/);
  assert.equal(quota.self.skipped, undefined);
  assert.equal(quota.messages.at(-1).state, "error");
  const wrong = worker({ network: { wrongBuild: "2026-01-01" } });
  await assert.rejects(wrong.install(), /schedule does not match/);
  const raced = worker({ network: { release: "different" } });
  await assert.rejects(raced.install(), /release changed/);
  const malformed = worker({ network: { invalidJson: true } });
  await assert.rejects(malformed.install(), /Unexpected token/);
});

test("readiness is rechecked against storage after a worker restart", async () => {
  const app = worker();
  await app.install();
  const cache = await app.caches.open("istintopuro-offline-one");
  await cache.delete("./data/career/1.json?v=2026-10-12");
  const restarted = worker({ caches: app.caches });
  await restarted.message({ type: "offline-status" });
  assert.equal(restarted.messages.at(-1).state, "idle");
  await restarted.message({ type: "offline-core" });
  assert.equal(restarted.messages.at(-1).state, "ready");
});

test("country packs download completely, persist across restarts, and are removable offline", async () => {
  const app = worker();
  await app.install();
  await app.message({ type: "offline-pack", id: "pt" });
  assert.equal(app.messages.at(-1).id, "pt");
  assert.equal(app.messages.at(-1).state, "ready");
  const offline = worker({ caches: app.caches, network: { offline: true } });
  for (const file of OfflineGame.packFiles(pack)) assert.ok((await offline.request(file)).ok, file);
  await offline.message({ type: "offline-status", packs: ["pt"] });
  assert.equal(offline.messages.at(-1).state, "ready");
  await offline.message({ type: "offline-remove-pack", id: "pt" });
  await offline.message({ type: "offline-status", packs: ["pt"] });
  assert.equal(offline.messages.at(-1).state, "idle");
  assert.ok(!(await offline.caches.keys()).some(name => name.startsWith("istintopuro-pack-pt-")));
});

test("runtime data cache stores versioned JSON and rejects a non-JSON body", async () => {
  const good = worker();
  const url = "./data/career/0.json?v=one";
  assert.equal((await good.request(url)).ok, true);
  assert.deepEqual(await (await good.caches.match(absolute(url))).json(), []);

  const bad = worker({ network: { invalidJson: true } });
  const html = await bad.request(url);
  assert.equal(await html.text(), "<html>error</html>");
  assert.equal(await bad.caches.match(absolute(url)), undefined);
});

test("a failing navigation uses the complete offline copy even for HTTP errors", async () => {
  const app = worker();
  await app.install();
  app.network.status = 503;
  assert.match(await (await app.request("./", "navigate")).text(), /app.js\?v=one/);
});

test("activation keeps one complete predecessor and leaves other applications' caches alone", async () => {
  const first = worker();
  await first.install();
  await first.caches.open("another-app");
  const second = worker({ version: "two", caches: first.caches });
  await second.install();
  const third = worker({ version: "three", caches: first.caches });
  await third.install();
  await third.activate();
  const names = await third.caches.keys();
  assert.ok(names.includes("istintopuro-offline-two"));
  assert.ok(names.includes("istintopuro-offline-three"));
  assert.ok(names.includes("another-app"));
  assert.ok(!names.includes("istintopuro-offline-one"));
});

function offlineClient({ online = false, installingVersion } = {}) {
  const elements = new Map(), callbacks = new Map();
  const document = { readyState: "complete", dispatchEvent() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: "", setAttribute() {}, addEventListener() {} });
      return elements.get(id);
    },
  };
  let registrations = 0;
  const active = { scriptURL: BASE + "sw.js?v=one", postMessage() {
    queueMicrotask(() => callbacks.get("message")({ data: {
      type: "offline-status", version: "one", id: "core", state: "ready", through: "2027-01-10",
    } }));
  } };
  const installing = installingVersion ? { scriptURL: BASE + `sw.js?v=${installingVersion}`, postMessage() {
    throw new Error("queried an unrelated worker");
  } } : null;
  const registration = { active, installing, addEventListener() {} };
  const navigator = { onLine: online, serviceWorker: {
    getRegistration: async () => registration,
    register: async () => { registrations++; throw new Error("network unavailable"); },
    addEventListener: (type, callback) => callbacks.set(type, callback),
  } };
  const context = vm.createContext({ document, navigator, window: { isSecureContext: true, addEventListener() {} },
    URL, Event, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(SITE, "offline.js"), "utf8"), context);
  context.OfflineGame.start({ version: "one", getLang: () => "en", getPacks: () => [] });
  return { elements, registrations: () => registrations };
}

test("a cold offline client checks the installed worker without fetching its script", async () => {
  const client = offlineClient();
  await new Promise(setImmediate);
  assert.equal(client.registrations(), 0);
  assert.equal(client.elements.get("offlinestate").textContent, "Ready to play offline");
});

test("a failed online update check still reports a complete installed copy", async () => {
  const client = offlineClient({ online: true });
  await new Promise(setImmediate);
  assert.equal(client.registrations(), 1);
  assert.equal(client.elements.get("offlinestate").textContent, "Ready to play offline");
});

test("an open client queries its own release while a different worker is installing", async () => {
  const client = offlineClient({ installingVersion: "two" });
  await new Promise(setImmediate);
  assert.equal(client.elements.get("offlinestate").textContent, "Ready to play offline");
});

test("disabling a pack during download cancels writes before removing its offline copy", async () => {
  const app = worker();
  await app.install();
  let release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  app.network.hold = async url => {
    if (url.pathname.includes('/packs/pt/career/')) { entered(); await resumed; }
  };
  const download = app.message({ type: "offline-pack", id: "pt" });
  await blocked;
  const remove = app.message({ type: "offline-remove-pack", id: "pt" });
  release();
  await Promise.all([download, remove]);
  assert.ok(!(await app.caches.keys()).some(name => name.startsWith("istintopuro-pack-pt-")));
  assert.ok(!app.messages.some(message => message.id === "pt" && message.state === "ready"));
});
