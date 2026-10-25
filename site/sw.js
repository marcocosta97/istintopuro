/* A release becomes the offline fallback only after its entire core is stored.
   Keep the previous complete release while downloading the next one. */
const V = new URL(self.location).searchParams.get("v") || "dev";
importScripts(`./offline.js?v=${V}`);
const CORE = `istintopuro-offline-${V}`;
const DATA = "istintopuro-data";
const MARKER = new URL("./__offline__/ready", self.location).href;
const jobs = new Map(), cancelled = new Set();
const packCache = meta => `istintopuro-pack-${meta.id}-${meta.built}-${V}`;

async function announce(status) {
  jobs.set(status.id, status);
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "offline-status", version: V, ...status });
}

async function inventory(name) {
  if (!(await caches.has(name))) return null;
  const cache = await caches.open(name), response = await cache.match(MARKER);
  if (!response) return null;
  const meta = await response.json();
  const keys = new Set((await cache.keys()).map(key => key.url));
  return meta.files.every(file => keys.has(new URL(file, self.location).href)) ? meta : null;
}

async function fetchNetwork(request, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(request, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function get(url) {
  const hit = await caches.match(url);
  if (hit) return hit;
  const response = await fetchNetwork(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}

async function store(name, files, id, extra = {}) {
  const cache = await caches.open(name);
  let done = 0, cursor = 0, failed = false;
  const total = files.length;
  await announce({ id, state: "downloading", done, total });
  const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (cursor < files.length && !failed) {
      const url = files[cursor++];
      try {
        if (cancelled.has(id)) throw new Error("cancelled");
        if (!await cache.match(url)) {
          const response = await get(url);
          if (url.includes(".json?")) await response.clone().json();
          if (cancelled.has(id)) throw new Error("cancelled");
          await cache.put(url, response);
        }
        done++;
        if (done % 10 === 0 || done === total)
          await announce({ id, state: "downloading", done, total });
      } catch (error) { failed = true; throw error; }
    }
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  if (cancelled.has(id)) throw new Error("cancelled");
  const meta = { files, version: V, ...extra };
  // The marker is the commit point; an unfinished download is never a fallback.
  await cache.put(MARKER, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
  if (!await inventory(name)) throw new Error("incomplete offline copy");
  await announce({ id, state: "ready", done, total, ...extra });
}

let coreTask;
function prepareCore() {
  return coreTask ||= (async () => {
    try {
      const indexResponse = await get(`./data/index.json?v=${V}`);
      const index = await indexResponse.clone().json();
      if (!Array.isArray(index.clubs) || !Number.isInteger(index.nshards) || index.nshards < 1)
        throw new Error("invalid index");
      const scheduleResponse = await get(`./data/quiz-schedule.json?v=${V}`);
      const schedule = await scheduleResponse.clone().json();
      if (schedule.v !== 1 || schedule.built !== index.built || !schedule.days || !schedule.through)
        throw new Error("quiz schedule does not match index");
      const documentResponse = await fetchNetwork("./", { cache: "no-cache" });
      if (!documentResponse.ok || !(await documentResponse.clone().text()).includes(`app.js?v=${V}`))
        throw new Error("release changed during download");
      const cache = await caches.open(CORE);
      await cache.put("./", documentResponse);
      await cache.put(`./data/index.json?v=${V}`, indexResponse);
      await cache.put(`./data/quiz-schedule.json?v=${V}`, scheduleResponse);
      await store(CORE, OfflineGame.coreFiles(index, V), "core", { built: index.built, through: schedule.through });
      await pruneCore().catch(() => {});
    } catch (error) {
      await announce({ id: "core", state: "error" });
      throw error;
    } finally { coreTask = null; }
  })();
}

self.addEventListener("install", event => {
  // Worker updates also happen in ordinary browser tabs. Bulk downloads must
  // come from the page: automatically in the PWA, or from its download button.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

async function pruneCore() {
  const names = (await caches.keys()).filter(name => name.startsWith("istintopuro-offline-") && name !== CORE);
  const complete = [];
  for (const name of names) if (await inventory(name)) complete.push(name);
  const previous = complete.at(-1);
  for (const name of names) if (name !== previous) await caches.delete(name);
  for (const name of await caches.keys())
    if (name.startsWith("istintopuro-shell-")) await caches.delete(name);
  // The first page saves its index before a worker controls it. Once those
  // responses are in the complete snapshot, remove the temporary duplicates.
  const meta = await inventory(CORE), runtime = await caches.open(DATA);
  if (meta) for (const file of meta.files) await runtime.delete(file);
}

const packTasks = new Map();
async function preparePack(id) {
  if (packTasks.has(id)) return packTasks.get(id);
  cancelled.delete(id);
  const task = (async () => {
    try {
      const cache = await caches.open(CORE);
      const index = await (await cache.match(`./data/index.json?v=${V}`)).json();
      const meta = index.packs.find(pack => pack.id === id);
      if (!meta) throw new Error("unknown pack");
      const response = await get(`./data/packs/${id}/index.json?v=${meta.built}`);
      const pack = await response.clone().json();
      if (pack.id !== id || pack.built !== meta.built || !Array.isArray(pack.clubs)
          || !Number.isInteger(pack.nshards) || pack.nshards < 1) throw new Error("invalid pack");
      const name = packCache(meta), target = await caches.open(name);
      await target.put(`./data/packs/${id}/index.json?v=${meta.built}`, response);
      await store(name, OfflineGame.packFiles(pack), id, { built: meta.built });
      const old = (await caches.keys()).filter(key => key.startsWith(`istintopuro-pack-${id}-`) && key !== name);
      for (const key of old.slice(0, -1)) await caches.delete(key);
    } catch (error) {
      await announce({ id, state: cancelled.has(id) ? "idle" : "error" });
      throw error;
    } finally { packTasks.delete(id); }
  })();
  packTasks.set(id, task);
  return task;
}

self.addEventListener("message", event => {
  const message = event.data || {};
  if (!event.source || new URL(event.source.url).origin !== self.location.origin) return;
  if (message.type === "offline-status") event.waitUntil((async () => {
    for (const id of ["core", ...(Array.isArray(message.packs) ? message.packs : [])]) {
      const running = jobs.get(id);
      if (running?.state === "downloading" || running?.state === "error") {
        event.source.postMessage({ type: "offline-status", version: V, ...running });
        continue;
      }
      let name = CORE;
      if (id !== "core") {
        const cache = await caches.open(CORE), response = await cache.match(`./data/index.json?v=${V}`);
        const meta = response && (await response.json()).packs?.find(pack => pack.id === id);
        if (!meta) continue;
        name = packCache(meta);
      }
      const meta = await inventory(name);
      event.source.postMessage({ type: "offline-status", version: V, id,
        state: meta ? "ready" : "idle", through: meta?.through });
    }
  })());
  if (message.type === "offline-core") event.waitUntil(prepareCore().catch(() => {}));
  if (message.type === "offline-pack" && typeof message.id === "string")
    event.waitUntil(preparePack(message.id).catch(() => {}));
  if (message.type === "offline-remove-pack" && /^[a-z]{2}$/.test(message.id)) event.waitUntil((async () => {
    cancelled.add(message.id);
    await packTasks.get(message.id)?.catch(() => {});
    for (const name of await caches.keys())
      if (name.startsWith(`istintopuro-pack-${message.id}-`)) await caches.delete(name);
    jobs.delete(message.id);
    event.ports[0]?.postMessage({ ok: true });
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetchNetwork(request, {}, 4000);
        if (response.ok) return response;
      } catch { /* fall back to the last completely downloaded release */ }
      const previous = (await caches.keys()).filter(name => name.startsWith("istintopuro-offline-") && name !== CORE).reverse();
      for (const name of [CORE, ...previous]) {
        if (!await inventory(name)) continue;
        const cache = await caches.open(name);
        const response = await cache.match("./");
        if (response) return response;
      }
      return Response.error();
    })());
    return;
  }
  event.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok && url.pathname.includes("/data/") && url.searchParams.has("v")) {
      const copy = response.clone();
      event.waitUntil(caches.open(DATA).then(async cache => {
        for (const key of await cache.keys()) {
          const old = new URL(key.url);
          if (old.pathname === url.pathname && old.search !== url.search) await cache.delete(key);
        }
        if (url.pathname.endsWith(".json")) await copy.clone().json();
        await cache.put(request, copy);
      }).catch(() => {}));
    }
    return response;
  })());
});
