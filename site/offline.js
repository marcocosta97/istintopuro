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
      title: "Play offline", note: "Includes careers and hints. Photos use initials when unavailable.",
      appNote: "Downloads automatically in the app. Keep it open until ready.",
      manual: "Download the game to play offline.",
      checking: "Checking offline copy…", downloading: (done, total) => `Downloading game… ${done} / ${total}`,
      ready: "Ready to play offline", horizon: date => `Shared daily puzzles saved through ${date}.`,
      practice: "Later puzzles are generated on this device and may differ from the online game.",
      details: "Details", error: "Download interrupted.",
      errorHelp: "Reconnect and retry. Your previous offline copy is kept.",
      idle: "Connect to finish downloading the game.", unsupported: "Offline downloads are unavailable in this browser.",
      retry: "Download again", download: "Download · 8 MB", downloadLabel: "Download game for offline play, about 8 MB",
      protect: "Keep on device", protected: "Saved with persistent storage.",
      unprotected: "Storage protection was not granted. This browser may remove the offline copy to free space.",
      packDownload: "Save offline", packReady: "Available offline", packProgress: (done, total) => `Saving… ${done} / ${total}`,
      packError: "Retry offline download", packLabel: country => `Save ${country} for offline play`,
    },
    it: {
      title: "Gioca offline", note: "Include carriere e indizi. Le foto non disponibili mostrano le iniziali.",
      appNote: "Download automatico nell’app. Tienila aperta finché il gioco non è pronto.",
      manual: "Scarica il gioco per giocare offline.",
      checking: "Verifica della copia offline…", downloading: (done, total) => `Download del gioco… ${done} / ${total}`,
      ready: "Pronto per giocare offline", horizon: date => `Schedine condivise salvate fino al ${date}.`,
      practice: "Le schedine successive sono generate sul dispositivo e possono differire dal gioco online.",
      details: "Dettagli", error: "Download interrotto.",
      errorHelp: "Riconnettiti e riprova. La copia offline precedente resta disponibile.",
      idle: "Connettiti per completare il download del gioco.", unsupported: "Download offline non disponibile in questo browser.",
      retry: "Scarica di nuovo", download: "Scarica · 8 MB", downloadLabel: "Scarica il gioco per giocare offline, circa 8 MB",
      protect: "Conserva sul dispositivo", protected: "Salvato con archiviazione persistente.",
      unprotected: "Protezione non concessa. Il browser può rimuovere la copia offline per liberare spazio.",
      packDownload: "Salva offline", packReady: "Disponibile offline", packProgress: (done, total) => `Salvataggio… ${done} / ${total}`,
      packError: "Riprova download offline", packLabel: country => `Salva ${country} per giocare offline`,
    },
  };
  let options, registration, core = { state: "checking" }, protection = "", supported = true;
  let downloadRequested = false;
  const APP_DISPLAY = "(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)";
  const isPwa = () => navigator.standalone === true || !!window.matchMedia?.(APP_DISPLAY).matches;
  const packs = new Map();
  const text = () => copy[options?.getLang() || "en"] || copy.en;
  const matches = target => target && new URL(target.scriptURL).searchParams.get("v") === options.version;
  const worker = () => [registration?.installing, registration?.waiting, registration?.active].find(matches);
  function changed() {
    render();
    document.dispatchEvent(new Event("offlinestatus"));
  }
  function render() {
    if (typeof document === "undefined") return;
    const section = document.getElementById("aboutoffline");
    if (!section) return;
    const words = text(), state = core.state;
    document.getElementById("offlinetitle").textContent = words.title;
    document.getElementById("offlinedetails").hidden = !supported;
    document.getElementById("offlinedetailstitle").textContent = words.details;
    document.getElementById("offlinenote").textContent = state === "error" ? words.errorHelp : isPwa() ? words.appNote : words.note;
    const status = document.getElementById("offlinestate");
    status.hidden = supported && state === "idle";
    status.textContent = !supported ? words.unsupported
      : state === "downloading" ? words.downloading(core.done, core.total)
      : state === "idle" && !isPwa() ? words.manual : words[state] || words.checking;
    const progress = document.getElementById("offlineprogress");
    progress.hidden = state !== "downloading";
    progress.max = core.total || 1; progress.value = core.done || 0;
    progress.setAttribute("aria-label", words.title);
    const horizon = document.getElementById("offlinehorizon");
    horizon.hidden = state !== "ready" || !core.through;
    if (!horizon.hidden) {
      const date = new Date(core.through + "T12:00:00Z").toLocaleDateString(options?.getLang() || "en");
      horizon.textContent = words.horizon(date) + " " + words.practice;
    }
    const retry = document.getElementById("offlineretry");
    retry.hidden = !supported || !["error", "idle"].includes(state);
    retry.textContent = state === "error" ? words.retry : words.download;
    retry.setAttribute("aria-label", state === "error" ? words.retry : words.downloadLabel);
    const protect = document.getElementById("offlineprotect");
    protect.hidden = state !== "ready" || !navigator.storage?.persist || protection === "protected";
    protect.textContent = words.protect;
    const storage = document.getElementById("offlinestorage");
    storage.hidden = !protection; storage.textContent = words[protection] || "";
  }
  function refresh() {
    if (options) worker()?.postMessage({ type: "offline-status", packs: options.getPacks().map(pack => pack.id) });
  }
  function beginDownload() {
    if (!downloadRequested || !matches(registration?.active)) return;
    downloadRequested = false;
    core = { state: "downloading", done: 0, total: 1 }; changed();
    registration.active.postMessage({ type: "offline-core" });
  }
  function watch(target) {
    if (!target) return;
    target.addEventListener("statechange", () => {
      if (target.state === "redundant" && core.state !== "ready") { core = { state: "error" }; changed(); }
      else refresh();
    });
  }
  async function connect() {
    downloadRequested ||= isPwa();
    core = { state: "checking" }; changed();
    try {
      registration = await navigator.serviceWorker.getRegistration();
      if (matches(registration?.active) && navigator.onLine === false) { refresh(); return; }
      registration = await navigator.serviceWorker.register(`sw.js?v=${options.version}`);
      watch(registration.installing);
      registration.addEventListener("updatefound", () => { watch(registration.installing); refresh(); });
      refresh();
    } catch {
      if (matches(registration?.active)) refresh();
      else { core = { state: "error" }; changed(); }
    }
  }
  function start(config) {
    options = config;
    supported = "serviceWorker" in navigator && window.isSecureContext;
    document.getElementById("offlineretry").onclick = async () => {
      downloadRequested = true;
      if (matches(registration?.active)) beginDownload();
      else await connect();
    };
    document.getElementById("offlineprotect").onclick = async () => {
      try { protection = await navigator.storage.persist() ? "protected" : "unprotected"; }
      catch { protection = "unprotected"; }
      render();
    };
    if (supported) {
      navigator.serviceWorker.addEventListener("message", event => {
        const message = event.data;
        if (message?.type !== "offline-status" || message.version !== options.version) return;
        if (message.id === "core") {
          core = message;
          if (message.state === "ready") downloadRequested = false;
          else if (message.state === "idle" || message.state === "error") beginDownload();
        }
        else packs.set(message.id, message);
        changed();
      });
      navigator.serviceWorker.addEventListener("controllerchange", refresh);
      window.matchMedia?.(APP_DISPLAY).addEventListener("change", () => {
        render();
        if (isPwa()) connect();
      });
      window.addEventListener("online", () => { if (core.state !== "ready") connect(); else refresh(); });
      document.getElementById("aboutbtn").addEventListener("click", refresh);
      navigator.storage?.persisted?.().then(value => { if (value) protection = "protected"; render(); }).catch(() => {});
      if (document.readyState === "complete") connect();
      else window.addEventListener("load", connect, { once: true });
    }
    render();
  }
  function packControl(meta, country) {
    if (!supported || !options || !matches(registration?.active)) return null;
    const words = text(), state = packs.get(meta.id) || { state: "idle" };
    const button = document.createElement("button");
    button.type = "button"; button.className = "packoffline";
    button.disabled = state.state === "ready" || state.state === "downloading" || core.state !== "ready";
    button.textContent = state.state === "ready" ? words.packReady
      : state.state === "downloading" ? words.packProgress(state.done, state.total)
      : state.state === "error" ? words.packError : words.packDownload;
    button.setAttribute("aria-label", `${words.packLabel(country)} — ${button.textContent}`);
    button.onclick = () => {
      packs.set(meta.id, { state: "downloading", done: 0, total: 1 }); changed();
      registration.active.postMessage({ type: "offline-pack", id: meta.id });
    };
    return button;
  }
  async function removePack(id) {
    packs.delete(id);
    if (!registration?.active) return;
    await new Promise(resolve => {
      const channel = new MessageChannel(), timer = setTimeout(() => { channel.port1.close(); resolve(); }, 15000);
      channel.port1.onmessage = () => { clearTimeout(timer); channel.port1.close(); resolve(); };
      registration.active.postMessage({ type: "offline-remove-pack", id }, [channel.port2]);
    });
  }
  return { coreFiles, packFiles, start, render, refresh, packControl, removePack };
});
