/* Istinto Puro — offline shell.

   Every URL this site fetches carries a version: the code and the index the deploy's
   commit sha (?v=<sha>, stamped into index.html and read back by app.js), the career
   shards and the years files the dataset's build date. A cached response therefore
   can never be stale FOR ITS URL, which is what makes cache-first safe here. The one
   thing that must never be served from cache without asking is the document itself,
   since it is the file that names all those versions.

   Two caches, because they expire on different clocks: the shell is replaced wholesale
   by a deploy, while the data files outlive it and are keyed by the dataset build —
   putting them in the shell cache would re-download the index (1.5 MB) after every
   code change. Old versions of a data file are dropped as its new one arrives, so the
   cache holds at most one copy of each.

   Escape hatch, should this ever misbehave in the wild: deploy an sw.js whose install
   handler calls self.registration.unregister() and caches.keys().then(delete). Clients
   pick it up on their next load, because the browser revalidates the worker script. */
const V = new URL(self.location).searchParams.get("v") || "dev";
const SHELL = `istintopuro-shell-${V}`;
const DATA = "istintopuro-data";
const CORE = ["./", `./app.js?v=${V}`, `./quiz.js?v=${V}`, `./style.css?v=${V}`,
  "./fonts/barlow-semi-condensed-latin-600-normal.woff2",
  "./fonts/barlow-semi-condensed-latin-700-italic.woff2",
  "./icon-192.png", "./icon-512.png", `./manifest.webmanifest?v=${V}`];

self.addEventListener("install", (e) => {
  // the flags are fetched by CSS only for the four countries that need them: leave
  // them to the runtime rule below rather than paying for them on every install
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.map(k => (k === SHELL || k === DATA) ? null : caches.delete(k))))
    .then(() => self.clients.claim()));
});

// keep one version of each data file: drop the entries for the same path whose ?v differs
async function putData(req, res) {
  const c = await caches.open(DATA), here = new URL(req.url);
  for (const k of await c.keys()) {
    const u = new URL(k.url);
    if (u.pathname === here.pathname && u.search !== here.search) await c.delete(k);
  }
  await c.put(req, res);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // Commons photos: the browser's business

  // The document names the versioned assets, so it is fetched fresh whenever the
  // network allows and only falls back to the cached copy offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./", { ignoreSearch: true })));
    return;
  }

  const isData = url.pathname.includes("/data/");
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok && (url.searchParams.has("v") || /\.(woff2|png|svg|webmanifest)$/.test(url.pathname))) {
      // waitUntil, not fire-and-forget: the response is already on its way to the page,
      // and a browser may stop the worker the moment it has been delivered. Safari does
      // so promptly, which loses the write and leaves the cache holding whatever it had
      // — the page then works online and fails offline, with nothing to show for it.
      // A full storage quota rejects the put; that is a reason to cache less, not to
      // fail the request the page is waiting on.
      const copy = res.clone();
      e.waitUntil((isData ? putData(req, copy)
                          : caches.open(SHELL).then(c => c.put(req, copy))).catch(() => {}));
    }
    return res;
  })));
});
