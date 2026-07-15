"use strict";
/* Istinto Puro solver — all client-side: one index file, set intersection. */

const $ = (id) => document.getElementById(id);
const search = $("search"), sugg = $("suggestions"), chips = $("chips"),
      results = $("results"), status = $("status"),
      sortSel = $("sortsel"), dirBtn = $("dirbtn"),
      byFrom = $("byfrom"), byTo = $("byto"), noZero = $("nozero"), langSel = $("langsel");

let DB = null;               // raw index.json
let clubIds = [];            // selected club indices
let sortBy = "apps", sortDir = -1;
const decoded = new Map();   // club index -> Int32Array of player ids
const careerCache = new Map();
const PAGE = 50;             // result rows rendered per batch; "show more" appends the next one

// ---------------------------------------------------------------- i18n
const REPO = "https://github.com/marcocosta97/istintopuro";
const STR = {
  it: {
    tagline: "Scegli una o più squadre — chi ha giocato per tutte?",
    placeholder: "Aggiungi una squadra…",
    loading: "Caricamento dati…",
    footer: `dati: <a href="https://www.wikidata.org">Wikidata</a> · foto: <a href="https://commons.wikimedia.org">Wikimedia Commons</a> · <a href="${REPO}/blob/master/LICENSE">MIT</a> · <a href="${REPO}">GitHub</a>`,
    built: (d) => `aggiornato al ${d}`,
    about: "Solver per il gioco «Istinto Puro»: scegli una o più squadre e scopri all'istante tutti i giocatori che hanno giocato per tutte, ordinati per presenze combinate. Dati estratti da Wikidata.",
    aboutLeagues: "Campionati coperti (tutte le stagioni):",
    disclaimer: `Nessun dato viene raccolto: tutto avviene nel tuo browser, senza server né tracciamento. Codice open source (<a href="${REPO}">MIT su GitHub</a>).`,
    remove: "rimuovi",
    sort: "Ordina per", sortApps: "presenze", sortGoals: "gol", sortBirth: "nascita",
    asc: "crescente", desc: "decrescente",
    adv: "Filtri",
    born: "Nati", from: "dal", to: "al",
    noZero: "nascondi 0 presenze",
    noZeroHint: "Nasconde chi ha 0 presenze registrate in una delle squadre scelte. Chi ha giocato più volte nella stessa squadra e ha totalizzato almeno una presenza resta incluso.",
    stats: (p, c) => `${p.toLocaleString("it")} giocatori · ${c} squadre`,
    loadFail: "Errore nel caricamento dei dati.", retry: "riprova",
    needTwo: "Aggiungi almeno una squadra.",
    found: (n, ms) => `${n} giocator${n === 1 ? "e" : "i"} · ${ms} ms`,
    combApps: (n) => `${n.toLocaleString("it")} presenze`,
    combGoals: (n) => `${n.toLocaleString("it")} gol`,
    comb: (apps) => apps ? "combinate" : "combinati",
    apps: "pres", goals: "gol", noData: "nessun dato",
    dissolved: (y) => `squadra sciolta nel ${y}`,
    more: (n) => `… mostra altri ${n}`,
    browse: "Sfoglia per campionato",
    others: "Altre",
    back: "indietro",
  },
  en: {
    tagline: "Pick one or more clubs — who played for them all?",
    placeholder: "Add a club…",
    loading: "Loading data…",
    footer: `data: <a href="https://www.wikidata.org">Wikidata</a> · photos: <a href="https://commons.wikimedia.org">Wikimedia Commons</a> · <a href="${REPO}/blob/master/LICENSE">MIT</a> · <a href="${REPO}">GitHub</a>`,
    built: (d) => `updated ${d}`,
    about: "Solver for the game “Istinto Puro”: pick one or more clubs and instantly see every player who played for them all, ranked by combined appearances. Data extracted from Wikidata.",
    aboutLeagues: "Leagues covered (all seasons):",
    disclaimer: `No data is collected: everything happens in your browser, with no server or tracking. Open source (<a href="${REPO}">MIT on GitHub</a>).`,
    remove: "remove",
    sort: "Sort by", sortApps: "apps", sortGoals: "goals", sortBirth: "birth",
    asc: "ascending", desc: "descending",
    adv: "Filters",
    born: "Born", from: "from", to: "to",
    noZero: "hide 0 apps",
    noZeroHint: "Hides players with 0 recorded appearances at one of the selected clubs. Players with multiple stints at the same club who made at least one appearance are kept.",
    stats: (p, c) => `${p.toLocaleString("en")} players · ${c} clubs`,
    loadFail: "Failed to load data.", retry: "retry",
    needTwo: "Add at least one club.",
    found: (n, ms) => `${n} player${n === 1 ? "" : "s"} · ${ms} ms`,
    combApps: (n) => `${n.toLocaleString("en")} apps`,
    combGoals: (n) => `${n.toLocaleString("en")} goals`,
    comb: () => "combined",
    apps: "apps", goals: "goals", noData: "no data",
    dissolved: (y) => `club dissolved in ${y}`,
    more: (n) => `… show ${n} more`,
    browse: "Browse by league",
    others: "Others",
    back: "back",
  },
};
let lang = STR[localStorage.lang] ? localStorage.lang
         : (navigator.language || "").startsWith("it") ? "it" : "en";
let t = STR[lang];

function applyLang() {
  t = STR[lang];
  document.documentElement.lang = lang;
  langSel.value = lang;
  $("tagline").textContent = t.tagline;
  $("foot").innerHTML = t.footer + (DB && DB.built ? `<div id="built">${t.built(DB.built)}</div>` : "");
  search.placeholder = t.placeholder;
  browseBtn.title = t.browse;
  browseBtn.setAttribute("aria-label", t.browse);
  if (DB && !browse.hidden) renderBrowse();
  $("l-sort").textContent = t.sort;
  [t.sortApps, t.sortGoals, t.sortBirth].forEach((s, i) => sortSel.options[i].text = s);
  dirBtn.title = sortDir < 0 ? t.desc : t.asc;
  $("l-adv").textContent = t.adv;
  $("l-born").textContent = t.born;
  byFrom.placeholder = t.from; byTo.placeholder = t.to;
  $("l-nozero").textContent = t.noZero;
  $("tip-nozero").textContent = t.noZeroHint;
  $("hint-nozero").setAttribute("aria-label", t.noZeroHint);
  $("abouttext").textContent = t.about;
  $("aboutdisclaimer").innerHTML = t.disclaimer;
  if (DB) {  // group leagues by country: one flag + its divisions per line
    const rows = [];
    for (const l of DB.leagues) {
      const last = rows[rows.length - 1];
      if (last && last.cc === l[2]) last.names.push(l[0]);
      else rows.push({ cc: l[2], names: [l[0]] });
    }
    $("aboutleagues").innerHTML = t.aboutLeagues + "<br>" + rows.map(g =>
      `${countryFlag(g.cc)} ` + g.names.map(n => `<span class="lg">${n}</span>`).join(" · ")).join("<br>");
  } else $("aboutleagues").textContent = t.aboutLeagues;
  if (DB) { renderChips(); clubIds.length ? solve() : status.textContent = t.stats(DB.names.length, DB.clubs.length); }
  else status.textContent = t.loading;
}
langSel.onchange = () => { lang = localStorage.lang = langSel.value; applyLang(); };
$("aboutbtn").onclick = () => $("about").showModal();
$("about").onclick = (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); };
$("advtoggle").onclick = () => {
  const open = $("advbody").hidden;
  $("advbody").hidden = !open;
  $("advtoggle").setAttribute("aria-expanded", open);
};
// tap-to-toggle hint bubble (hover handles desktop); close on outside tap
$("hint-nozero").onclick = (e) => {
  e.stopPropagation();
  const h = e.currentTarget, on = h.classList.toggle("show");
  h.setAttribute("aria-expanded", on);
};
document.addEventListener("click", () => $("hint-nozero").classList.remove("show"));

// small alias map for names people actually type (keyed by club QID)
const ALIASES = {
  Q483020: ["psg"], Q8682: ["real madrid"], Q8701: ["atletico madrid"],
  Q631: ["inter"], Q1543: ["milan"], Q10329: ["siviglia"], Q8723: ["betis"],
  Q18656: ["man united", "manchester united"], Q50602: ["man city", "manchester city"],
  Q15789: ["bayern", "bayern monaco"], Q41420: ["borussia dortmund", "bvb"],
  Q7156: ["barca", "barcellona"], Q8687: ["athletic bilbao", "bilbao"],
  Q18741: ["spurs"], Q19500: ["wolves"], Q101959: ["gladbach"], Q51974: ["hsv"],
  Q104770: ["cologne", "colonia"], Q185163: ["nizza"], Q19521: ["st etienne"],
  Q8760: ["la coruna", "deportivo la coruna"], Q12278: ["sporting gijon"],
};

// Wikidata labels (club/player/team names) are publicly editable — never trust them in innerHTML
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "")
                     .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const initialsOf = (s) => norm(s).split(" ").filter(w => w.length > 2).map(w => w[0]).join("");
// leading legal-form tokens (kin to the pipeline's STOP_TOKENS) don't count for
// sorting or prefix ranking: "AC Milan" sorts under M and matches "mil" as a prefix
const LEGAL = new Set(["fc", "afc", "cf", "cfc", "ac", "acf", "as", "ss", "ssc", "sc",
  "us", "usd", "ud", "sd", "cd", "rcd", "ca", "rc", "ad", "aj", "es", "og", "ogc", "usl",
  "sco", "osc", "af", "fco", "calcio", "club", "football", "futbol", "foot", "ball",
  "sport", "balompie", "associazione", "sportiva", "societa", "unione", "de", "di", "en", "avant",
  "centre", "esports", "alsace", "herault",
  "spa", "ssd", "tsv", "vfb", "vfl", "sv", "fsv", "bsc", "bc", "spvgg", "tsg"]);
const sortName = (s) => {
  const w = norm(s).split(" ");  // single letters/digits = abbreviation debris ("U.C.", "1.")
  while (w.length > 1 && (LEGAL.has(w[0]) || w[0].length === 1 || /^\d+$/.test(w[0]))) w.shift();
  return w.join(" ");
};
// FM-style display name for the browse panel: drop legal tokens around the core
// ("AC Milan" -> "Milan", "Bologna F.C. 1909" -> "Bologna"); search/chips keep full names
const isLegal = (word) => {
  const toks = norm(word).split(" ").filter(Boolean);
  return toks.length > 0 && toks.every(x => LEGAL.has(x) || x.length === 1 || /^\d+$/.test(x));
};
const KEEP = new Set(["Athletic Club", "Paris FC", "FC Lyon", "Hamburger SV", "Karlsruher SC"]);
const coreClub = (name) => {
  if (KEEP.has(name)) return name;  // stripping would maim or disambiguate these away
  const w = name.split(" ");
  let a = 0, b = w.length;
  while (a < w.length - 1 && isLegal(w[a])) a++;
  while (b > a + 1 && isLegal(w[b - 1])) b--;
  return w.slice(a, b).join(" ");
};
const flag = (cc) => cc ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1A5 + c.charCodeAt(0))) : "";
// defunct marker: a dagger + dissolution year for clubs with Wikidata P576 (c[4])
const defunct = (c) => c[4] ? ` <span class="defunct" title="${t.dissolved(c[4])}">†${c[4]}</span>` : "";

// ---------------------------------------------------------------- data loading
async function boot() {
  status.textContent = t.loading;
  try {
    const res = await fetch("data/index.json", { cache: "no-cache" });  // revalidate: stale index + fresh app.js hides fields
    if (!res.ok) throw new Error(res.status);
    DB = await res.json();
  } catch {
    status.textContent = t.loadFail + " ";
    const b = document.createElement("button");
    b.textContent = t.retry;
    b.onclick = boot;
    status.appendChild(b);
    return;
  }
  DB.gkSet = new Set();  // goalkeepers ("gks" delta-encoded like postings): goal counts are unreliable, never shown
  { let acc = 0; for (const d of DB.gks || []) DB.gkSet.add(acc += d); }
  DB.searchNames = DB.clubs.map(c => norm(c[0]));
  DB.sortNames = DB.clubs.map(c => sortName(c[0]));
  DB.searchInitials = DB.clubs.map(c => initialsOf(c[0]));
  DB.aliasNorm = DB.clubs.map(c => (ALIASES[c[3]] || []).map(norm));
  const byQid = new Map(DB.clubs.map((c, i) => [c[3], i]));  // restore a shared selection from the hash
  clubIds = location.hash.slice(1).split(",").map(q => byQid.get(q)).filter(i => i !== undefined);
  search.disabled = false;
  browseBtn.disabled = false;
  search.focus();
  applyLang();  // refresh status + footer now that DB (and its built date) exist
}

function postings(ci) {
  let arr = decoded.get(ci);
  if (!arr) {
    const d = DB.postings[ci];
    arr = new Int32Array(d.length);
    let acc = 0;
    for (let i = 0; i < d.length; i++) arr[i] = acc += d[i];
    decoded.set(ci, arr);
  }
  return arr;
}

// ---------------------------------------------------------------- club search
function matches(q) {
  const nq = norm(q);
  if (!nq) return [];
  const out = [];
  for (let i = 0; i < DB.clubs.length; i++) {
    if (clubIds.includes(i)) continue;
    let rank = -1;
    if (DB.searchNames[i].startsWith(nq) || DB.sortNames[i].startsWith(nq)) rank = 0;
    else if (DB.searchNames[i].includes(nq)) rank = 1;
    else if (DB.searchInitials[i] === nq.replace(/ /g, "")) rank = 0;
    else if (DB.aliasNorm[i].some(a => a.startsWith(nq))) rank = 0;
    if (rank >= 0) out.push([rank, DB.postings[i].length, i, DB.clubs[i][4] ? 1 : 0]);
  }
  // best rank first, then active before dissolved, then bigger clubs first
  return out.sort((a, b) => a[0] - b[0] || a[3] - b[3] || b[1] - a[1]).slice(0, 8).map(x => x[2]);
}

let cursor = -1;
function renderSuggestions(ids) {
  sugg.innerHTML = "";
  sugg.hidden = ids.length === 0;
  cursor = ids.length ? 0 : -1;
  ids.forEach((ci, i) => {
    const c = DB.clubs[ci];
    const li = document.createElement("li");
    li.innerHTML = `<span>${countryFlag(c[1])} ${esc(c[0])}${defunct(c)}</span><small>${leagueNames(c[2])}</small>`;
    li.className = i === cursor ? "active" : "";
    li.onmousedown = (e) => { e.preventDefault(); addClub(ci); };
    sugg.appendChild(li);
  });
}

function leagueNames(mask) {
  return DB.leagues.filter((_, i) => mask & (1 << i)).map(l => l[0]).join(" · ");
}

search.addEventListener("input", () => { browseOpen(false); renderSuggestions(matches(search.value)); });
search.addEventListener("keydown", (e) => {
  const items = [...sugg.children];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!items.length) return;
    cursor = (cursor + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items.forEach((li, i) => li.className = i === cursor ? "active" : "");
  } else if ((e.key === "Enter" || e.key === "Tab") && cursor >= 0 && !sugg.hidden) {
    e.preventDefault();  // Tab confirms like Enter instead of leaving the field
    addClub(matches(search.value)[cursor]);
  } else if (e.key === "Backspace" && !search.value && clubIds.length) {
    removeClub(clubIds[clubIds.length - 1]);
  } else if (e.key === "Escape") { sugg.hidden = true; }
});
search.addEventListener("blur", () => setTimeout(() => {
  if (document.activeElement !== search) sugg.hidden = true;
}, 100));

// ------------------------------------------------------- FM-style team browser
const browse = $("browse"), browseBtn = $("browsebtn"), brBack = $("br-back");
let brCC = null, brLG = null;  // drill-down state: country code, league index | "x" (Others)
const canHover = matchMedia("(hover: hover)").matches;

// GB renders as England wherever clubs or leagues appear — the covered pyramid is
// English, even for its Welsh clubs. Player nationality flags keep flag() (real GB).
const ENG = { flag: "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
              it: "Inghilterra", en: "England" };
const countryFlag = (cc) => cc === "GB" ? ENG.flag : flag(cc);
const countryName = (cc) => {
  if (cc === "GB") return ENG[lang] || ENG.en;
  try { return new Intl.DisplayNames([lang], { type: "region" }).of(cc) || cc; }
  catch { return cc; }
};

function browseOpen(open) {
  if (browse.hidden === !open) return;
  browse.hidden = !open;
  browseBtn.setAttribute("aria-expanded", open);
  if (open) {
    sugg.hidden = true;
    // desktop opens with all three columns populated; mobile starts at the country list
    if (brCC === null && matchMedia("(min-width: 561px)").matches) { brCC = DB.leagues[0][2]; brLG = 0; }
    renderBrowse();
  }
}
browseBtn.onclick = (e) => { e.stopPropagation(); browseOpen(browse.hidden); };
document.addEventListener("click", (e) => {
  if (!browse.hidden && !browse.contains(e.target)) browseOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !browse.hidden) { browseOpen(false); search.focus(); }
});
brBack.onclick = () => {
  if (brLG !== null) brLG = null; else brCC = null;
  renderBrowse();
};

function brItem(ul, html, cls, pick, hoverToo) {
  const el = document.createElement("li");
  el.innerHTML = html;
  if (cls) el.className = cls;
  if (pick) {
    el.tabIndex = 0;
    el.onclick = (e) => { e.stopPropagation(); pick(); };
    el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
    if (hoverToo && canHover) el.onmouseenter = pick;
  }
  ul.appendChild(el);
}

function renderBrowse() {
  const [ulC, ulL, ulT] = browse.querySelectorAll("ul");
  ulC.innerHTML = ulL.innerHTML = ulT.innerHTML = "";
  const ccs = [...new Set(DB.leagues.map(l => l[2]))];
  for (const cc of ccs)
    brItem(ulC, `<span>${countryFlag(cc)} ${esc(countryName(cc))}</span><span class="arr">›</span>`,
           cc === brCC ? "active" : "",
           () => { if (brCC !== cc) { brCC = cc; brLG = null; renderBrowse(); } }, true);
  if (brCC !== null) {
    DB.leagues.forEach((l, i) => {
      if (l[2] !== brCC) return;
      brItem(ulL, `<span>${esc(l[0])}</span><span class="arr">›</span>`,
             i === brLG ? "active" : "",
             () => { if (brLG !== i) { brLG = i; renderBrowse(); } }, true);
    });
    brItem(ulL, `<span>${t.others}</span><span class="arr">›</span>`,
           brLG === "x" ? "active" : "",
           () => { if (brLG !== "x") { brLG = "x"; renderBrowse(); } }, true);
  }
  if (brCC !== null && brLG !== null) {
    const ccMask = DB.leagues.reduce((m, l, i) => l[2] === brCC ? m | (1 << i) : m, 0);
    const ids = [];
    DB.clubs.forEach((c, ci) => {
      const cur = c[4] ? -1 : (c[5] ?? -1);  // a dissolved club is never "current": Others only
      if (brLG === "x" ? cur < 0 && (c[2] & ccMask) : cur === brLG) ids.push(ci);
    });
    ids.sort((a, b) => DB.sortNames[a].localeCompare(DB.sortNames[b]));  // "AC Milan" under M
    for (const ci of ids) {
      const c = DB.clubs[ci], sel = clubIds.includes(ci);
      brItem(ulT, `<span>${esc(coreClub(c[0]))}${defunct(c)}</span>${sel ? "<span class=\"arr\">✓</span>" : ""}`,
             sel ? "sel" : "", sel ? null : () => { addClub(ci); browseOpen(false); });
    }
  }
  const level = brCC === null ? 0 : brLG === null ? 1 : 2;
  browse.dataset.level = level;
  brBack.hidden = level === 0;
  brBack.textContent = `‹ ${level === 2 ? `${countryFlag(brCC)} ${countryName(brCC)}` : t.back}`;
}

// ---------------------------------------------------------------- selection
// the selection is shareable: club QIDs in the URL hash (stable across dataset rebuilds)
function syncHash() {
  const h = clubIds.map(ci => DB.clubs[ci][3]).join(",");
  history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
}
function addClub(ci) {
  if (ci === undefined || clubIds.includes(ci)) return;
  clubIds.push(ci);
  search.value = ""; sugg.hidden = true;
  renderChips(); solve(); syncHash();
  search.focus();
}
function removeClub(ci) {
  clubIds = clubIds.filter(x => x !== ci);
  renderChips(); solve(); syncHash();
}
function renderChips() {
  chips.innerHTML = "";
  clubIds.forEach(ci => {
    const c = DB.clubs[ci];
    const el = document.createElement("span");
    el.className = "chip";
    el.innerHTML = `${countryFlag(c[1])} ${esc(c[0])}${defunct(c)} <button aria-label="${t.remove}">×</button>`;
    el.querySelector("button").onclick = () => removeClub(ci);
    chips.appendChild(el);
  });
}

// ---------------------------------------------------------------- solve
function intersect(lists) {
  lists.sort((a, b) => a.length - b.length);
  let acc = [...lists[0]];
  for (let k = 1; k < lists.length && acc.length; k++) {
    const l = lists[k], keep = [];
    let j = 0;
    for (const x of acc) {                 // merge walk, lists are sorted
      while (j < l.length && l[j] < x) j++;
      if (j < l.length && l[j] === x) keep.push(x);
    }
    acc = keep;
  }
  return acc;
}

function solve() {
  results.innerHTML = "";
  if (clubIds.length === 0) { status.textContent = t.needTwo; return; }
  const t0 = performance.now();
  const common = intersect(clubIds.map(postings));
  const commonSet = new Set(common);
  // combined apps/goals across the selected clubs (-1 in DB = unknown; absent from map = all unknown)
  const appsOf = new Map(), goalsOf = new Map(), zero = new Set(), gKnown = new Map();
  for (const ci of clubIds) {
    const arr = postings(ci), apps = DB.apps[ci], goals = DB.goals?.[ci] || [];
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (!commonSet.has(p)) continue;
      if (apps[i] >= 0) appsOf.set(p, (appsOf.get(p) || 0) + apps[i]);
      if (apps[i] === 0) zero.add(p);
      if (goals[i] >= 0 && !DB.gkSet.has(p)) {
        goalsOf.set(p, (goalsOf.get(p) || 0) + goals[i]);
        gKnown.set(p, (gKnown.get(p) || 0) + 1);
      }
    }
  }
  // 0 goals is only shown when known at every selected club
  const zeroGoals = new Set([...gKnown].filter(([p, k]) => k === clubIds.length && !goalsOf.get(p)).map(([p]) => p));
  let ids = common;
  if (noZero.checked) ids = ids.filter(p => !zero.has(p));  // known 0 apps at a selected club
  const yf = +byFrom.value || 0, yt = +byTo.value || 0;
  if (yf || yt)  // a set bound excludes unknown birth years
    ids = ids.filter(p => { const b = DB.births[p]; return b && (!yf || b >= yf) && (!yt || b <= yt); });
  const key = sortBy === "goals" ? (p) => goalsOf.get(p) || 0
            : sortBy === "birth" ? (p) => DB.births[p] || 9999 * sortDir  // unknown last
            : (p) => appsOf.get(p) || 0;
  ids.sort((a, b) => sortDir * (key(a) - key(b)) || DB.names[a].localeCompare(DB.names[b]));
  const ms = performance.now() - t0;
  status.textContent = t.found(ids.length, ms.toFixed(1));
  renderResults(ids, appsOf, goalsOf, zeroGoals);
}

sortSel.onchange = () => { sortBy = sortSel.value; solve(); };
dirBtn.onclick = () => {
  sortDir = -sortDir;
  dirBtn.textContent = sortDir < 0 ? "↓" : "↑";
  dirBtn.title = sortDir < 0 ? t.desc : t.asc;
  solve();
};
byFrom.oninput = byTo.oninput = solve;
noZero.onchange = solve;

function renderResults(ids, appsOf, goalsOf, zeroGoals, from = 0) {
  const frag = document.createDocumentFragment();
  for (const pid of ids.slice(from, from + PAGE)) {
    const li = document.createElement("li");
    li.className = "player";
    const img = DB.imgs[pid]
      ? `<img loading="lazy" src="https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(DB.imgs[pid])}?width=96" alt="">`
      : `<span class="avatar">${initials(pid)}</span>`;
    const apps = appsOf.get(pid), goals = goalsOf.get(pid);
    const parts = [apps ? t.combApps(apps) : "", goals || zeroGoals.has(pid) ? t.combGoals(goals || 0) : ""].filter(Boolean);
    const meta = parts.length ? `${parts.join(" · ")} <span class="comb">(${t.comb(!!apps)})</span>` : "";
    li.innerHTML = `${img}<div class="pinfo"><span class="pname">${flag(DB.nats[pid])} ${esc(DB.names[pid])}${DB.gkSet.has(pid) ? " <small>(GK)</small>" : ""}${DB.births[pid] ? ` <small>(${DB.births[pid]})</small>` : ""}</span>
      <span class="pmeta">${meta}</span></div><span class="expand">▸</span>`;
    const im = li.querySelector("img");
    if (im) im.onerror = () => im.replaceWith(avatar(initials(pid)));
    li.onclick = () => toggleCareer(li, pid);
    frag.appendChild(li);
  }
  results.appendChild(frag);
  const shown = Math.min(from + PAGE, ids.length);
  if (ids.length > shown) {
    const li = document.createElement("li");
    li.className = "more";
    li.textContent = t.more(ids.length - shown);
    li.onclick = () => { li.remove(); renderResults(ids, appsOf, goalsOf, zeroGoals, shown); };
    results.appendChild(li);
  }
}

const initials = (pid) => DB.names[pid].split(" ").map(w => w[0]).slice(0, 2).join("");
const avatar = (txt) => {
  const s = document.createElement("span");
  s.className = "avatar"; s.textContent = txt;
  return s;
};

// ---------------------------------------------------------------- career panel
async function toggleCareer(li, pid) {
  const open = li.querySelector(".career");
  if (open) { open.remove(); li.querySelector(".expand").textContent = "▸"; return; }
  li.querySelector(".expand").textContent = "▾";
  const shard = pid % (DB.nshards || 128);  // shard count stamped in the index by the pipeline
  if (!careerCache.has(shard))  // versioned by dataset stamp: a stale cached shard would pair wrong careers with a fresh index
    careerCache.set(shard, fetch(`data/career/${shard}.json?v=${DB.built || 0}`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }));
  let table;
  try { table = await careerCache.get(shard); }
  catch { careerCache.delete(shard); li.querySelector(".expand").textContent = "▸"; return; }
  const [qid = 0, career = []] = table[pid] || [];
  if (li.querySelector(".career")) return;
  const selNames = new Set(clubIds.map(ci => DB.clubs[ci][0]));
  const gk = DB.gkSet.has(pid);  // goalkeeper goal counts are unreliable, show apps only
  const div = document.createElement("div");
  div.className = "career";
  div.innerHTML = (career.filter(e => e[0]).map(([team, s, e, apps, goals]) =>
    `<div class="crow${selNames.has(team) ? " hit" : ""}">
       <span class="cyears">${s || "?"}–${e || (s ? "" : "?")}</span><span class="cteam">${esc(team)}</span>
       <span class="cstats">${apps != null ? apps + " " + t.apps : ""}${!gk && goals != null ? " · " + goals + " " + t.goals : ""}</span>
     </div>`).join("") || `<div class='crow'>${t.noData}</div>`)
    + (qid ? `<a class="wiki" href="https://www.wikidata.org/wiki/Special:GoToLinkedPage/${lang}wiki/Q${qid}" target="_blank" rel="noopener">Wikipedia ↗</a>
              <a class="wiki" href="https://www.wikidata.org/wiki/Q${qid}" target="_blank" rel="noopener">Wikidata ↗</a>` : "");
  div.onclick = (e) => e.stopPropagation();
  li.appendChild(div);
}

applyLang();
boot();
