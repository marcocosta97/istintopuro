/* Shared download inventory and the small offline section in Settings. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OfflineGame = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  function coreFiles(index, version) {
    return ["./", ...["packs.js", "offline.js", "app.js", "quiz-core.js", "quiz.js", "style.css", "manifest.webmanifest"]
      .map(file => `./${file}?v=${version}`),
    "./fonts/barlow-semi-condensed-latin-600-normal.woff2", "./fonts/barlow-semi-condensed-latin-700-italic.woff2",
    "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png",
    ...["yu", "dd", "xk", "an"].map(country => `./flags/${country}.svg`),
    `./data/index.json?v=${version}`, `./data/quiz-schedule.json?v=${version}`,
    ...Array.from({ length: index.nshards }, (_, shard) => `./data/career/${shard}.json?v=${index.built}`),
    ...index.clubs.map((_, club) => `./data/years/${club}.json?v=${index.built}`)];
  }
  function packFiles(pack) {
    const base = `./data/packs/${pack.id}`, stamp = `?v=${pack.built}`;
    return [`${base}/index.json${stamp}`,
      ...Array.from({ length: pack.nshards }, (_, shard) => `${base}/career/${shard}.json${stamp}`),
      ...pack.clubs.map(club => `${base}/years/${club[3]}.json${stamp}`)];
  }

  const copy = {
    en: {
      title: "Play offline", note: "Game and enabled packs · from 8 MB",
      checking: "Checking offline copy…", downloading: (done, total) => `Downloading… ${done} / ${total}`,
      ready: "Ready to play offline", error: "Download interrupted. Reconnect and retry.",
      unsupported: "Offline downloads are unavailable in this browser.", retry: "Retry",
    },
    it: {
      title: "Gioca offline", note: "Gioco e pacchetti abilitati · da 8 MB",
      checking: "Verifica della copia offline…", downloading: (done, total) => `Download… ${done} / ${total}`,
      ready: "Pronto per giocare offline", error: "Download interrotto. Riconnettiti e riprova.",
      unsupported: "Download offline non disponibile in questo browser.", retry: "Riprova",
    },
  };
  const PREF = "offlinePlay";
  const APP_DISPLAY = "(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)";
  const isPwa = () => navigator.standalone === true || !!window.matchMedia?.(APP_DISPLAY).matches;
  let options, registration, core = { state: "checking" }, enabled = false, supported = true;
  const packs = new Map(), attempted = new Set();
  const text = () => copy[options?.getLang() || "en"] || copy.en;
  const wanted = () => options?.getPacks() || [];
  const matches = target => target && new URL(target.scriptURL).searchParams.get("v") === options.version;
  const worker = () => [registration?.installing, registration?.waiting, registration?.active].find(matches);
  function preference() {
    try { const value = localStorage.getItem(PREF); return value === null ? null : value === "1"; }
    catch { return null; }
  }
  function summary() {
    const states = [core, ...wanted().map(meta => packs.get(meta.id) || {
      state: "checking", total: 1 + (meta.nshards || 32) + (meta.clubs?.length || 0),
    })];
    const state = states.some(item => item.state === "error") ? "error"
      : states.every(item => item.state === "ready") ? "ready"
      : states.some(item => item.state === "downloading") || attempted.size ? "downloading" : "checking";
    return { state,
      done: states.reduce((sum, item) => sum + (item.state === "ready" ? item.total || 1 : item.done || 0), 0),
      total: states.reduce((sum, item) => sum + (item.total || 1), 0) };
  }
  function render() {
    if (typeof document === "undefined" || !document.getElementById("aboutoffline")) return;
    const words = text(), status = summary();
    document.getElementById("offlinetitle").textContent = words.title;
    const toggle = document.getElementById("offlineenabled");
    toggle.checked = enabled; toggle.disabled = !supported;
    document.getElementById("offlinestate").textContent = !supported ? words.unsupported : !enabled ? words.note
      : status.state === "downloading" ? words.downloading(status.done, status.total) : words[status.state];
    const progress = document.getElementById("offlineprogress");
    progress.hidden = !enabled || !supported || status.state !== "downloading";
    progress.max = status.total || 1; progress.value = status.done;
    progress.setAttribute("aria-label", words.title);
    const retry = document.getElementById("offlineretry");
    retry.hidden = !supported || !enabled || status.state !== "error";
    retry.textContent = words.retry;
  }
  function refresh() {
    worker()?.postMessage({ type: "offline-status", packs: wanted().map(pack => pack.id) });
    render();
  }
  function sync() {
    if (!enabled || !matches(registration?.active)) return;
    const request = (id, state) => {
      if (!state || !["idle", "error"].includes(state.state) || attempted.has(id)) return;
      attempted.add(id);
      const status = { ...state, state: "downloading", done: 0, total: state.total || 1 };
      if (id === "core") core = status; else packs.set(id, status);
      registration.active.postMessage(id === "core" ? { type: "offline-core" } : { type: "offline-pack", id });
    };
    if (core.state !== "ready") request("core", core);
    else for (const meta of wanted()) request(meta.id, packs.get(meta.id));
    render();
  }
  function protectStorage() {
    try { navigator.storage?.persist?.().catch(() => {}); } catch { /* browser storage stays best-effort */ }
  }
  function watch(target) {
    if (!target) return;
    target.addEventListener("statechange", () => {
      if (target.state === "redundant" && core.state !== "ready") { core = { state: "error" }; render(); }
      else refresh();
    });
  }
  async function connect() {
    attempted.clear(); packs.clear(); core = { state: "checking" }; render();
    try {
      registration = await navigator.serviceWorker.getRegistration();
      if (matches(registration?.active) && navigator.onLine === false) { refresh(); return; }
      registration = await navigator.serviceWorker.register(`sw.js?v=${options.version}`);
      watch(registration.installing);
      registration.addEventListener("updatefound", () => { watch(registration.installing); refresh(); });
      refresh();
    } catch {
      if (matches(registration?.active)) refresh();
      else { core = { state: "error" }; render(); }
    }
  }
  function start(config) {
    options = config;
    enabled = preference() ?? isPwa();
    supported = "serviceWorker" in navigator && window.isSecureContext;
    document.getElementById("offlineenabled").onchange = event => {
      enabled = event.target.checked;
      try { localStorage.setItem(PREF, enabled ? "1" : "0"); } catch {}
      if (enabled) { protectStorage(); connect(); }
      else { attempted.clear(); worker()?.postMessage({ type: "offline-cancel" }); render(); }
    };
    document.getElementById("offlineretry").onclick = () => connect();
    if (supported) {
      navigator.serviceWorker.addEventListener("message", event => {
        const message = event.data;
        if (message?.type !== "offline-status" || message.version !== options.version) return;
        if (message.state === "ready") attempted.delete(message.id);
        if (message.id === "core") {
          const previous = core.state;
          core = message;
          if (message.state === "ready" && previous !== "ready") refresh();
        } else packs.set(message.id, message);
        sync();
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => { attempted.clear(); refresh(); });
      window.matchMedia?.(APP_DISPLAY).addEventListener("change", () => {
        enabled = preference() ?? isPwa();
        if (enabled) connect(); else render();
      });
      window.addEventListener("online", () => { if (enabled && summary().state !== "ready") connect(); else refresh(); });
      window.addEventListener("storage", event => {
        if (event.key === PREF) {
          enabled = preference() ?? isPwa();
          if (enabled) connect(); else render();
        } else if (event.key === "leaguePacks") refresh();
      });
      document.getElementById("aboutbtn").addEventListener("click", refresh);
      if (enabled) protectStorage();
      if (document.readyState === "complete") connect();
      else window.addEventListener("load", connect, { once: true });
    }
    render();
  }
  async function removePack(id) {
    packs.delete(id); attempted.delete(id);
    if (!registration?.active) return;
    await new Promise(resolve => {
      const channel = new MessageChannel(), timer = setTimeout(() => { channel.port1.close(); resolve(); }, 15000);
      channel.port1.onmessage = () => { clearTimeout(timer); channel.port1.close(); resolve(); };
      registration.active.postMessage({ type: "offline-remove-pack", id }, [channel.port2]);
    });
  }
  return { coreFiles, packFiles, start, render, refresh, removePack };
});
