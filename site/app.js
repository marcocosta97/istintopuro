"use strict";
/* Istinto Puro — solver core (the quiz lives in quiz.js); all client-side: one index file, set intersection. */

const $ = (id) => document.getElementById(id);
const search = $("search"), sugg = $("suggestions"), chips = $("chips"),
      results = $("results"), status = $("status"),
      sortSel = $("sortsel"), dirBtn = $("dirbtn"),
      byFrom = $("byfrom"), byTo = $("byto"), noZero = $("nozero"), langSel = $("langsel"),
      advCount = $("advcount"), filtReset = $("filtreset");

// autofocus is a desktop convenience; on touch, focusing the field the user
// hasn't tapped (mode switch, first load, clear-all) pops the keyboard
const focusSearch = () => { if (!matchMedia("(pointer: coarse)").matches) search.focus(); };

let DB = null;               // raw index.json
let mode = "club";           // "club" (players in common) | "player" (clubs in common)
let clubIds = [];            // selected club indices
let playerIds = [];          // selected player ids (player mode keeps its own selection)
let solveGen = 0;            // stale-async guard: only the newest player solve may render
let detail = localStorage.pdetail === "1";  // shared-club cards: show apps/goals + per-team totals
let sortBy = "apps", sortDir = -1;
const decoded = new Map();   // club index -> Int32Array of player ids
const careerCache = new Map();
const PAGE = 50;             // result rows rendered per batch; "show more" appends the next one

// ---------------------------------------------------------------- i18n
const REPO = "https://github.com/marcocosta97/istintopuro";
const STR = {
  it: {
    tagline: "Scegli una o più squadre — chi ha giocato per tutte?",
    taglineP: "Scegli uno o più giocatori — in quali squadre hanno giocato insieme?",
    placeholder: "Aggiungi una squadra…",
    placeholderP: "Aggiungi un giocatore…",
    modeClub: "Squadre", modePlayer: "Giocatori",
    foundClubs: (n, ms) => `${n} squadr${n === 1 ? "a" : "e"} in comune · ${ms} ms`,
    mates: (span) => `compagni ${span}`,
    noOverlap: "(mai insieme)",
    selPlayers: "giocatori selezionati",
    detail: "dettagli",
    loading: "Caricamento dati…",
    footer: `dati: <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a> · foto: <a href="https://commons.wikimedia.org" target="_blank" rel="noopener">Wikimedia Commons</a> · <a href="${REPO}/blob/master/LICENSE" target="_blank" rel="noopener">MIT</a> · <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>`,
    built: (d) => `aggiornato al ${d}`,
    about: "Due modi di giocare con «Istinto Puro». Solver: scegli una o più squadre e scopri all'istante tutti i giocatori che hanno giocato per tutte, ordinati per presenze combinate. Schedina giornaliera: quattro sfide di difficoltà crescente, le stesse per tutti. Dati estratti da Wikidata.",
    aboutLeagues: "Campionati coperti (tutte le stagioni):",
    disclaimer: `Nessun dato viene raccolto: tutto avviene nel tuo browser, senza server né tracciamento. Codice open source (<a href="${REPO}" target="_blank" rel="noopener">MIT su GitHub</a>). Carattere: <a href="https://github.com/jpt/barlow" target="_blank" rel="noopener">Barlow Semi Condensed</a> (SIL OFL).`,
    remove: "rimuovi", clearAll: "svuota",
    sort: "Ordina per", sortApps: "presenze", sortGoals: "gol", sortBirth: "nascita",
    asc: "crescente", desc: "decrescente",
    adv: "Filtri",
    filtReset: "azzera", filtResetT: "Azzera i filtri",
    born: "Nati", from: "dal", to: "al",
    noZero: "Nascondi 0 presenze",
    noZeroHint: "Nasconde chi ha 0 presenze registrate in una delle squadre scelte. Chi ha giocato più volte nella stessa squadra e ha totalizzato almeno una presenza resta incluso.",
    nat: "Nazionalità", natAll: "tutte", natNone: "nessuna", natUnknown: "sconosciuta",
    stats: (p, c) => `${p.toLocaleString("it")} giocatori · ${c} squadre`,
    loadFail: "Errore nel caricamento dei dati.", retry: "riprova",
    spin: "Non sai da dove partire? Tira il dado 🎲",
    randClubs: "squadre a caso", randPlayers: "giocatori a caso",
    noneCommon: "Nessun giocatore ha vestito tutte queste maglie — togli una squadra.",
    noneFilter: "Nessun giocatore corrisponde ai filtri.",
    combNote: "presenze e gol combinati",
    found: (n, ms) => `${n} giocator${n === 1 ? "e" : "i"} · ${ms} ms`,
    combApps: (n) => `${n.toLocaleString("it")} presenze`,
    combGoals: (n) => `${n.toLocaleString("it")} gol`,
    comb: (apps) => apps ? "combinate" : "combinati",
    apps: () => "pres", goals: () => "gol",  // abbreviazioni invariabili
    noData: "nessun dato", loan: "prestito",
    dissolved: (y) => `squadra sciolta nel ${y}`,
    more: (n) => `… mostra altri ${n}`,
    browse: "Sfoglia per campionato",
    others: "Altre",
    back: "indietro",
    pivot: "compagni ↗", pivotT: "Apri in modalità Giocatori",
    copyLink: "copia link", copyLinkT: "Copia il link a questa selezione", copied: "copiato ✓",
    themeDark: "Passa al tema scuro", themeLight: "Passa al tema chiaro",
  },
  en: {
    tagline: "Pick one or more clubs — who played for them all?",
    taglineP: "Pick one or more players — which clubs did they share?",
    placeholder: "Add a club…",
    placeholderP: "Add a player…",
    modeClub: "Clubs", modePlayer: "Players",
    foundClubs: (n, ms) => `${n} shared club${n === 1 ? "" : "s"} · ${ms} ms`,
    mates: (span) => `teammates ${span}`,
    noOverlap: "(never overlapped)",
    selPlayers: "selected players",
    detail: "details",
    loading: "Loading data…",
    footer: `data: <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a> · photos: <a href="https://commons.wikimedia.org" target="_blank" rel="noopener">Wikimedia Commons</a> · <a href="${REPO}/blob/master/LICENSE" target="_blank" rel="noopener">MIT</a> · <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>`,
    built: (d) => `updated ${d}`,
    about: "Two ways to play “Istinto Puro”. Solver: pick one or more clubs and instantly see every player who played for them all, ranked by combined appearances. Daily quiz: four challenges of rising difficulty, the same for everyone. Data extracted from Wikidata.",
    aboutLeagues: "Leagues covered (all seasons):",
    disclaimer: `No data is collected: everything happens in your browser, with no server or tracking. Open source (<a href="${REPO}" target="_blank" rel="noopener">MIT on GitHub</a>). Typeface: <a href="https://github.com/jpt/barlow" target="_blank" rel="noopener">Barlow Semi Condensed</a> (SIL OFL).`,
    remove: "remove", clearAll: "clear",
    sort: "Sort by", sortApps: "apps", sortGoals: "goals", sortBirth: "birth",
    asc: "ascending", desc: "descending",
    adv: "Filters",
    filtReset: "reset", filtResetT: "Clear all filters",
    born: "Born", from: "from", to: "to",
    noZero: "Hide 0 apps",
    noZeroHint: "Hides players with 0 recorded appearances at one of the selected clubs. Players with multiple stints at the same club who made at least one appearance are kept.",
    nat: "Nationality", natAll: "all", natNone: "none", natUnknown: "unknown",
    stats: (p, c) => `${p.toLocaleString("en")} players · ${c} clubs`,
    loadFail: "Failed to load data.", retry: "retry",
    spin: "Not sure where to start? Roll the dice 🎲",
    randClubs: "random clubs", randPlayers: "random players",
    noneCommon: "No player has played for all these clubs — remove one to widen the search.",
    noneFilter: "No players match the filters.",
    combNote: "combined apps and goals",
    found: (n, ms) => `${n} player${n === 1 ? "" : "s"} · ${ms} ms`,
    combApps: (n) => `${n.toLocaleString("en")} app${n === 1 ? "" : "s"}`,
    combGoals: (n) => `${n.toLocaleString("en")} goal${n === 1 ? "" : "s"}`,
    comb: () => "combined",
    apps: (n) => `app${n === 1 ? "" : "s"}`, goals: (n) => `goal${n === 1 ? "" : "s"}`,
    noData: "no data", loan: "loan",
    dissolved: (y) => `club dissolved in ${y}`,
    more: (n) => `… show ${n} more`,
    browse: "Browse by league",
    others: "Others",
    back: "back",
    pivot: "teammates ↗", pivotT: "Open in player mode",
    copyLink: "copy link", copyLinkT: "Copy a link to this selection", copied: "copied ✓",
    themeDark: "Switch to dark theme", themeLight: "Switch to light theme",
  },
};
let lang = STR[localStorage.lang] ? localStorage.lang
         : (navigator.language || "").startsWith("it") ? "it" : "en";
let t = STR[lang];

function applyLang() {
  t = STR[lang];
  document.documentElement.lang = lang;
  langSel.value = lang;
  paintTheme();  // the toggle's aria-label/title is localized
  $("tagline").textContent = mode === "club" ? t.tagline : t.taglineP;
  $("foot").innerHTML = t.footer + (DB && DB.built ? `<div id="built">${t.built(DB.built)}</div>` : "");
  search.placeholder = mode === "club" ? t.placeholder : t.placeholderP;
  search.setAttribute("aria-label", search.placeholder);  // the placeholder is not a reliable accessible name
  $("mode-club").textContent = t.modeClub;
  $("mode-player").textContent = t.modePlayer;
  browseBtn.title = t.browse;
  browseBtn.setAttribute("aria-label", t.browse);
  const rl = mode === "club" ? t.randClubs : t.randPlayers;
  $("randbtn").title = rl;
  $("randbtn").setAttribute("aria-label", rl);
  if (DB && !browse.hidden) renderBrowse();
  $("l-sort").textContent = t.sort;
  [t.sortApps, t.sortGoals, t.sortBirth].forEach((s, i) => sortSel.options[i].text = s);
  dirBtn.title = sortDir < 0 ? t.desc : t.asc;
  $("l-adv").textContent = t.adv;
  filtReset.textContent = `✕ ${t.filtReset}`;
  filtReset.title = t.filtResetT;
  renderFilterState();
  $("l-born").textContent = t.born;
  byFrom.placeholder = t.from; byTo.placeholder = t.to;
  $("l-nat").textContent = t.nat;
  $("natall").textContent = t.natAll; $("natnone").textContent = t.natNone;
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
  if (DB) {
    renderChips();
    const sel = mode === "club" ? clubIds : playerIds;
    if (sel.length) solve();
    else {
      results.innerHTML = ""; status.textContent = t.stats(DB.names.length, DB.clubs.length);
      renderNats(); renderExamples();
    }
  }
  else status.textContent = t.loading;
}
// theme toggle: default follows the system; a click forces light or dark and
// remembers it (localStorage.theme). The head applies a stored choice before
// paint; here we wire the button and keep its sun/moon icon in sync.
const themeBtn = $("themebtn");
const THEME_ICON = {  // show the mode a click switches TO
  dark: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>`,
  light: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M20 14.5A8 8 0 0 1 9.5 4a.6.6 0 0 0-.82-.7A9 9 0 1 0 20.7 15.3a.6.6 0 0 0-.7-.8z"/></svg>`,
};
const effectiveTheme = () => document.documentElement.getAttribute("data-theme")
  || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
function paintTheme() {
  const dark = effectiveTheme() === "dark";
  themeBtn.innerHTML = dark ? THEME_ICON.dark : THEME_ICON.light;  // dark now → offer sun
  themeBtn.setAttribute("aria-label", dark ? t.themeLight : t.themeDark);
  themeBtn.title = themeBtn.getAttribute("aria-label");
}
themeBtn.onclick = () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", localStorage.theme = next);
  paintTheme();
};
// while on auto (no stored choice), follow later system changes
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (!localStorage.theme) paintTheme(); });
paintTheme();
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

// Club/Player mode switch: each mode keeps its own selection; the club-mode
// controls (sort, filters, browse) don't apply to a list of shared clubs
function setMode(m) {
  if (mode === m || !DB) return;
  mode = m;
  $("mode-club").setAttribute("aria-pressed", m === "club");
  $("mode-player").setAttribute("aria-pressed", m === "player");
  browseOpen(false); suggOpen(false); search.value = "";
  browseBtn.hidden = m === "player";
  $("controls").hidden = m === "player";
  if (m === "player") {
    $("advbody").hidden = true;
    pIndex();  // one-time (~69k names), on the toggle click, not per keystroke
  } else $("advbody").hidden = $("advtoggle").getAttribute("aria-expanded") !== "true";
  applyLang();  // mode-aware: swaps tagline/placeholder, re-renders chips + results
  focusSearch();
}
$("mode-club").onclick = () => setMode("club");
$("mode-player").onclick = () => setMode("player");

// small alias map for names people actually type (keyed by club QID)
const ALIASES = {
  Q483020: ["psg"], Q8682: ["real madrid"], Q8701: ["atletico madrid"],
  Q631: ["inter", "internazionale", "internazionale milano", "fc internazionale milano"],
  Q1543: ["milan"], Q10329: ["siviglia"], Q8723: ["betis"],
  Q18656: ["man united", "manchester united"], Q50602: ["man city", "manchester city"],
  Q15789: ["bayern", "bayern monaco"], Q41420: ["borussia dortmund", "bvb"],
  Q7156: ["barca", "barcellona"], Q8687: ["athletic bilbao", "bilbao"],
  Q18741: ["spurs"], Q19500: ["wolves"], Q101959: ["gladbach"], Q51974: ["hsv"],
  Q104770: ["cologne", "colonia"], Q185163: ["nizza"], Q19521: ["st etienne"],
  Q8760: ["la coruna", "deportivo la coruna"], Q12278: ["sporting gijon"],
};

// Wikidata labels (club/player/team names) are publicly editable — never trust them in innerHTML
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// letters with no canonical NFD decomposition (Đ, Ø, Ł, Æ...) would otherwise
// just get dropped by the a-z filter below instead of matching their ASCII spelling
const TRANSLIT = { đ: "d", Đ: "D", ø: "o", Ø: "O", ł: "l", Ł: "L", æ: "ae", Æ: "AE",
                    œ: "oe", Œ: "OE", þ: "th", Þ: "TH", ð: "d", Ð: "D", ß: "ss" };
const norm = (s) => s.replace(/[đĐøØłŁæÆœŒþÞðÐß]/g, (c) => TRANSLIT[c])
                     .normalize("NFD").replace(/[̀-ͯ]/g, "")
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
// A nat is comma-separated when a player represented more than one country, so flag()
// takes the whole field and returns HTML (never plain text — callers interpolate it).
// Yugoslavia, the GDR, Kosovo and the Netherlands Antilles have no regional-indicator
// emoji; site/flags/<cc>.svg covers them, fetched only when such a row is rendered.
const NO_EMOJI_FLAG = new Set(["YU", "DD", "XK", "AN"]);
// every flag carries its country as title + aria-label: the emoji alone is unreadable
// for anyone who doesn't know the flag (and for screen readers). Hover only, so touch
// gets nothing — the nationality filter panel is where a phone reads the names.
const oneFlag = (cc) => {
  const n = esc(natName(cc));
  return NO_EMOJI_FLAG.has(cc)
    ? `<span class="hflag hf-${cc.toLowerCase()}" role="img" title="${n}" aria-label="${n}"></span>`
    : `<span role="img" title="${n}" aria-label="${n}">`
      + String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1A5 + c.charCodeAt(0))) + "</span>";
};
const flag = (nat) => nat ? nat.split(",").map(oneFlag).join("") : "";
// a player's countries as a list ("" = unknown, kept as a single "" bucket so the
// nationality filter can offer an "unknown" row like any other)
const natsOf = (p) => { const n = DB.nats[p]; return n ? n.split(",") : [""]; };
// Intl.DisplayNames resolves the deprecated codes to whichever state succeeded them
// (YU -> "Serbia", DD -> "Germany", AN -> "Curaçao"), which mislabels the flag and
// collides with the successor's own row in the filter — two rows reading "Germania".
const HIST_NAME = { YU: { it: "Jugoslavia", en: "Yugoslavia" },
                    DD: { it: "Germania Est", en: "East Germany" },
                    XK: { it: "Kosovo", en: "Kosovo" },
                    AN: { it: "Antille Olandesi", en: "Netherlands Antilles" } };
// country name for a single code. Called once per rendered flag, so the Intl instance
// and its answers are cached: constructing DisplayNames per row was the whole cost.
let dnCache = new Map(), dnFor = null, dnLang = null;
const natName = (cc) => {
  if (!cc) return t.natUnknown;
  if (HIST_NAME[cc]) return HIST_NAME[cc][lang] || HIST_NAME[cc].en;
  if (dnLang !== lang) {
    dnLang = lang; dnCache = new Map();
    try { dnFor = new Intl.DisplayNames([lang], { type: "region" }); } catch { dnFor = null; }
  }
  if (!dnCache.has(cc)) {
    let n = cc;
    try { n = (dnFor && dnFor.of(cc)) || cc; } catch { /* not a region code */ }
    dnCache.set(cc, n);
  }
  return dnCache.get(cc);
};
// defunct marker: a dagger + dissolution year for clubs with Wikidata P576 (c[4])
const defunct = (c) => c[4] ? ` <span class="defunct" title="${t.dissolved(c[4])}">†${c[4]}</span>` : "";
// year span of a career spell: single-year ranges collapse, unknown bounds show "?"
const yspan = (s, e) => s && s === e ? String(s) : `${s || "?"}–${e || (s ? "" : "?")}`;

// ---------------------------------------------------------------- club stature
// The continent's marquee clubs — the ones a general fan recognises, so a player
// there is widely visible. Squad-size coverage in Wikidata can't tell a giant
// (Napoli, Man Utd) from a well-documented mid club (Deportivo), so club stature
// leans on this curated set; prestige, unlike league position, rarely changes.
// Shared: search ranking uses it here, quiz difficulty uses it in quiz.js.
const MARQUEE = new Set([
  "Q1422", "Q631", "Q1543", "Q2641", "Q2739", "Q2609", "Q2052",                          // IT
  "Q8682", "Q7156", "Q8701", "Q10329", "Q10333", "Q12297", "Q8687", "Q10315",            // ES
  "Q15789", "Q41420", "Q104761", "Q702455", "Q32494", "Q38245", "Q101959",               // DE
  "Q483020", "Q132885", "Q704", "Q180305", "Q19516",                                     // FR
  "Q18656", "Q50602", "Q1130849", "Q9617", "Q9616", "Q18741", "Q18716", "Q18711", "Q5794", "Q18747", "Q1128631", // GB
]);
// group by the club's LEAGUE country, not its nationality, so Monaco (code "MC",
// plays in Ligue 1) counts as French rather than a country of its own
const leagueCC = (ci) => { const c = DB.clubs[ci]; return c[5] >= 0 ? DB.leagues[c[5]][2] : c[1]; };
// how visible a club is: marquee tops the scale; everyone else is ranked by squad
// size WITHIN their own country (so the coverage bias doesn't matter) and capped
// below marquee — a big-for-its-league club still scores well.
const stature = (ci) => {
  if (!DB.stat) {
    const byC = {};
    DB.clubs.forEach((c, i) => { if (DB.postings[i].length >= 120) (byC[leagueCC(i)] ??= []).push(i); });
    DB.stat = new Map();
    for (const cc in byC) {
      const arr = byC[cc].sort((a, b) => DB.postings[a].length - DB.postings[b].length);
      arr.forEach((ci, idx) => {
        const pct = arr.length > 1 ? idx / (arr.length - 1) : 1;  // 0 smallest … 1 biggest in league
        DB.stat.set(ci, MARQUEE.has(DB.clubs[ci][3]) ? 1.15 : pct >= 0.6 ? 1 : pct >= 0.3 ? 0.82 : 0.66);
      });
    }
  }
  return DB.stat.get(ci) ?? 0.66;
};

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
  // space-padded copies so clubMatches can test word boundaries without building
  // a new string per club per keystroke
  const pad = (s) => " " + s + " ";
  DB.padNames = DB.searchNames.map(pad);
  DB.padSort = DB.sortNames.map(pad);
  DB.padAlias = DB.aliasNorm.map(a => a.map(pad));
  DB.byQid = new Map(DB.clubs.map((c, i) => [c[3], i]));  // hash restore + example queries
  clubIds = location.hash.slice(1).split(",").map(q => DB.byQid.get(q)).filter(i => i !== undefined);
  search.disabled = false;
  browseBtn.disabled = false;
  $("randbtn").disabled = false;
  focusSearch();
  applyLang();  // refresh status + footer now that DB (and its built date) exist
  document.dispatchEvent(new Event("dbready"));  // quiz.js waits on this (e.g. a #quiz deep link)
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

// ---------------------------------------------------------------- search
const SUGG = 12;  // suggestion rows offered; the dropdown scrolls past ~6
const matches = (q) => mode === "club" ? clubMatches(q) : playerMatches(q);

// Where `nq` lands in one candidate string, on the ladder the player search uses
// (T_NAME … T_INFIX). 474 clubs is small enough that plain string tests beat any
// index — the whole search runs in well under a millisecond.
// Unlike the player ladder, a whole word and a name start share ONE tier here:
// "juve" is a whole word of Juve Stabia but only a prefix of Juventus, and
// "sociedad" the reverse — Huesca starts with it, Real Sociedad merely contains
// it as a word. Neither reading deserves to win on shape alone, so both defer to
// the marquee list and squad size, which is what those signals are for.
// `pad` is the space-padded form of `n`, precomputed in boot(); `word` is " nq",
// built once per query. Returns 99 for no match, so callers can Math.min freely.
function clubTier(n, pad, nq, word) {
  if (n === nq) return T_NAME;
  if (pad.includes(word)) return T_WORD;  // any word starts with the query
  return n.includes(nq) ? T_INFIX : 99;
}

function clubMatches(q, rescue = true) {
  const nq = norm(q);
  if (!nq) return [];
  const toks = nq.split(" ");
  const word = " " + nq;
  const out = [];
  // a club answers to its full name, its name minus legal-form tokens, its
  // initials and its aliases — score against all of them and keep the best
  const tier = (n, p) => clubTier(n, p, nq, word);
  for (let i = 0; i < DB.clubs.length; i++) {
    if (clubIds.includes(i)) continue;
    let rank = Math.min(tier(DB.searchNames[i], DB.padNames[i]), tier(DB.sortNames[i], DB.padSort[i]));
    // `al` marks a club reached ONLY through an alias. It breaks ties late rather
    // than costing a tier, so "monaco" answers AS Monaco before Bayern (aliased
    // "bayern monaco") without dropping alias-only clubs off the list entirely.
    let al = 0;
    const av = DB.aliasNorm[i], ap = DB.padAlias[i];
    for (let k = 0; k < av.length; k++) { const t = tier(av[k], ap[k]); if (t < rank) { rank = t; al = 1; } }
    if (DB.searchInitials[i] === nq.replace(/ /g, "") && T_WORD < rank) { rank = T_WORD; al = 0; }
    // every word matched, in any order: "madrid real" and "ham west" found nothing
    if (rank > T_ALL && toks.length > 1
        && toks.every(tk => DB.padNames[i].includes(" " + tk))) rank = T_ALL;
    if (rank > T_INFIX) continue;
    const c = DB.clubs[i];
    // first division, then second, then everything outside the covered leagues —
    // "socie" should not answer four out-of-league Sociedads before Real Sociedad
    const div = c[4] || (c[5] ?? -1) < 0 ? 2 : DB.leagues[c[5]][1] - 1;
    // squad size alone can't rank a shared word: "united" and "city" are Sheffield
    // and Birmingham by roster, Manchester by everything a searcher means
    const mq = MARQUEE.has(c[3]) ? 0 : 1;
    out.push([rank, DB.postings[i].length, i, c[4] ? 1 : 0, div, mq, al]);
  }
  // best rank, then division, marquee ahead, named before aliased, alive before
  // dissolved, then bigger clubs
  const ids = out.sort((a, b) => a[0] - b[0] || a[4] - b[4] || a[5] - b[5]
                              || a[6] - b[6] || a[3] - b[3] || b[1] - a[1])
                 .slice(0, SUGG).map(x => x[2]);
  if (!rescue || (ids.length && out.some(x => x[0] < T_INFIX))) return ids;
  return cRescue(nq, ids);  // "bayren", "dortmond" — same one-edit retry as the names
}

// the distinct words a club answers to, for the typo rescue (~900 of them)
function cWords() {
  if (DB.cWordList) return DB.cWordList;
  const set = new Set();
  const add = (n) => { for (const w of n.split(" ")) if (w.length > 3) set.add(w); };
  DB.searchNames.forEach(add);
  DB.aliasNorm.forEach(arr => arr.forEach(add));
  return DB.cWordList = [...set];
}
function cRescue(nq, had) {
  const toks = nq.split(" ").filter(tk => tk.length > 3);
  if (!toks.length) return had;
  toks.sort((a, b) => b.length - a.length);
  const words = cWords(), seen = new Set(had), out = had.slice();
  for (const tk of toks) {
    const alts = [];
    for (const w of words) if (w !== tk && near1(w, tk)) alts.push(w);
    for (const alt of alts.slice(0, 10)) {
      for (const id of clubMatches(nq.replace(tk, alt), false)) {
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
    }
    if (out.length > had.length) break;
  }
  return out.slice(0, SUGG);
}

// ------------------------------------------------------------ player name index
// Every normalised name, space-separated and concatenated into one blob, plus the
// offset each starts at. A query then scans with String.indexOf over ~1.1 MB —
// which every engine does at memory speed — instead of running 69k JS-level
// String.includes calls per keystroke. Each name is stored with a LEADING space
// and the blob ends with one, so " " + query finds every word start (a name's
// first word included) and the char just past a match tells a whole word from a
// prefix. Costs ~180 ms once; the quiz's idle warm pays it before anyone types.
function pIndex() {
  if (DB.pBlob) return;
  const n = DB.names.length, off = new Int32Array(n + 1), parts = new Array(n);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const s = " " + norm(DB.names[i]);
    parts[i] = s; off[i] = pos; pos += s.length;
  }
  off[n] = pos;
  DB.pOff = off;
  DB.pBlob = parts.join("") + " ";
  DB.pMark = new Int32Array(n);  // per-query dedupe marks, see pGen
  pFame();
}

// Global recognisability: the club-independent sibling of quiz.js's qFame, with
// the same stature-weighted appearances, goals, era and recency terms — summed
// over the whole covered career instead of one puzzle pair. It exists to order
// suggestions: "david" has 897 word-level matches, and without a fame signal the
// top eight are whoever sorts first in the alphabet, which is how Jonathan David
// stayed unreachable behind David Abraham and David Aganzo.
const pEra = (b) => b >= 1970 ? 1 : b >= 1955 ? 0.85 : b >= 1940 ? 0.65 : 0.45;
const pRec = (age) => age <= 28 ? 200 : age <= 32 ? 150 : age <= 36 ? 90 : age <= 41 ? 45 : 10;
function pFame() {
  if (DB.fame) return DB.fame;
  const n = DB.names.length;
  const apps = new Float32Array(n), goals = new Float32Array(n), mApps = new Float32Array(n);
  DB.clubs.forEach((c, ci) => {
    const w = stature(ci), mq = MARQUEE.has(c[3]);
    const arr = postings(ci), ap = DB.apps[ci], gl = DB.goals[ci];
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (ap[i] > 0) { apps[p] += w * ap[i]; if (mq) mApps[p] += w * ap[i]; }
      if (gl[i] > 0 && !DB.gkSet.has(p)) goals[p] += w * gl[i];  // gk goal qualifiers are unreliable
    }
  });
  const year = +(DB.built || "").slice(0, 4) || new Date().getFullYear();
  const fame = DB.fame = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const b = DB.births[p], age = b ? year - b : 99;
    const rec = pRec(age) * Math.min(1, (apps[p] || 12) / 25);  // unknown apps: keep a sliver
    fame[p] = rec + pEra(b) * (0.75 * Math.min(apps[p], 400) + 3 * Math.min(goals[p], 90)
      + 0.35 * Math.min(mApps[p], 300)) + (DB.imgs[p] ? 20 : 0);
  }
  return fame;
}

// player -> the clubs they turn up at, as one flat CSR-style pair of arrays. A
// name on its own often isn't enough to recognise anyone: this dataset holds
// three players called David Silva, all born 1986, and only the clubs tell them
// apart. Built on demand — the postings are already decoded by then (pFame).
function pClubIndex() {
  if (DB.pcAt) return;
  const n = DB.names.length, at = new Int32Array(n + 1);
  DB.clubs.forEach((c, ci) => { for (const p of postings(ci)) at[p + 1]++; });
  for (let i = 0; i < n; i++) at[i + 1] += at[i];
  const club = new Int32Array(at[n]), apps = new Int32Array(at[n]), fill = at.slice(0, n);
  DB.clubs.forEach((c, ci) => {
    const arr = postings(ci), ap = DB.apps[ci];
    for (let i = 0; i < arr.length; i++) { const k = fill[arr[i]]++; club[k] = ci; apps[k] = ap[i]; }
  });
  DB.pcAt = at; DB.pcClub = club; DB.pcApps = apps;
}
// the clubs a suggestion row names: most appearances first, short FM-style names
function pClubs(pid, max) {
  pClubIndex();
  const out = [];
  for (let k = DB.pcAt[pid]; k < DB.pcAt[pid + 1]; k++) out.push([DB.pcApps[k], DB.pcClub[k]]);
  return out.sort((a, b) => b[0] - a[0]).slice(0, max).map(x => coreClub(DB.clubs[x[1]][0]));
}

// norm() is not length-preserving (ß -> ss, punctuation -> space, runs collapse),
// so a hit found in the normalised text can't be sliced out of the original by
// offset. Rebuild the normalisation here character by character, keeping a map
// back to the source index, and highlight against that instead of guessing.
function normMap(s) {
  const map = [];
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = (TRANSLIT[s[i]] || s[i]).normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ");
    for (const ch of c) {
      if (ch !== " ") { out += ch; map.push(i); }
      else if (out && out[out.length - 1] !== " ") { out += ch; map.push(i); }
    }
  }
  if (out.endsWith(" ")) { out = out.slice(0, -1); map.pop(); }
  return { n: out, map };
}
// bold whatever the query matched, so a long name shows at a glance WHY it is here
function hilite(name, nq) {
  if (!nq) return esc(name);
  const { n, map } = normMap(name), spans = [];
  for (const tk of nq.split(" ")) {
    if (!tk) continue;
    const w = n.indexOf(" " + tk);
    const p = w >= 0 ? w + 1 : n.startsWith(tk) ? 0 : n.indexOf(tk);
    if (p >= 0) spans.push([map[p], map[Math.min(p + tk.length, n.length) - 1] + 1]);
  }
  if (!spans.length) return esc(name);
  spans.sort((a, b) => a[0] - b[0]);
  let html = "", at = 0;
  for (const [s, e] of spans) {
    if (s < at) continue;  // overlapping tokens: keep the first, drop the rest
    html += esc(name.slice(at, s)) + "<b>" + esc(name.slice(s, e)) + "</b>";
    at = e;
  }
  return html + esc(name.slice(at));
}

// Match tiers, best first: the whole name, then any word starting with the query,
// then every query word matched out of order, then anywhere inside a word.
// Deliberately coarse. Finer shapes — a WHOLE word beating a word prefix, a name
// start beating a later word — all assume the query is finished, which in a
// type-ahead it usually isn't: they answered "beck" with Christian Beck and no
// Beckham, "maldi" with Maldini Kacurri above Paolo Maldini, "ibrahi" with five
// Ibrahimas and no Zlatan. Fame (players) and division/stature (clubs) rank
// within a tier, and they know which name the searcher meant; the shape doesn't.
const T_NAME = 0, T_WORD = 1, T_ALL = 2, T_INFIX = 3;

// hits come out of indexOf in increasing position, so the id cursor only moves
// forward — no binary search per hit
function pScan(needle, cb) {
  const blob = DB.pBlob, off = DB.pOff, last = DB.names.length - 1;
  let i = 0, p = blob.indexOf(needle);
  while (p >= 0) {
    while (i < last && off[i + 1] <= p) i++;
    cb(p, i);
    p = blob.indexOf(needle, p + 1);
  }
}
// does name `i` have a word starting with `tk`? Bounded manual scan on purpose:
// String.indexOf takes no end limit, so a miss would sweep the rest of the blob
// — once per candidate, that is the whole index re-read.
function pHasWord(i, tk) {
  const blob = DB.pBlob, hi = DB.pOff[i + 1], L = tk.length;
  for (let p = DB.pOff[i]; p + L < hi; p++) {
    if (blob.charCodeAt(p) !== 32) continue;
    let k = 0;
    while (k < L && blob.charCodeAt(p + 1 + k) === tk.charCodeAt(k)) k++;
    if (k === L) return true;
  }
  return false;
}

let pGen = 0;
function playerMatches(q, excl = playerIds, rescue = true) {  // quiz mode passes its own exclusions
  pIndex();
  const nq = norm(q);
  if (!nq) return [];
  const blob = DB.pBlob, off = DB.pOff, mark = DB.pMark, fame = DB.fame;
  const gen = ++pGen;
  for (const i of excl) mark[i] = gen;  // exclusions ride the same marks as dedupe

  // bounded insertion instead of sorting every hit: "a" matches 55k names, and
  // all but the best SUGG of them are dead weight
  const ids = [], ranks = [];
  let worst = T_INFIX + 1;
  const better = (rA, iA, rB, iB) => rA !== rB ? rA < rB
    : fame[iA] !== fame[iB] ? fame[iA] > fame[iB]
    : DB.names[iA].localeCompare(DB.names[iB]) < 0;
  const push = (rank, id) => {
    if (ids.length === SUGG && !better(rank, id, worst, ids[SUGG - 1])) return;
    let k = ids.length < SUGG ? ids.length : SUGG - 1;
    while (k > 0 && better(rank, id, ranks[k - 1], ids[k - 1])) { ids[k] = ids[k - 1]; ranks[k] = ranks[k - 1]; k--; }
    ids[k] = id; ranks[k] = rank;
    worst = ranks[ids.length - 1];
  };

  // pass 1 — any word starting with the query, which covers tiers 0 and 1
  const end = nq.length + 1;
  pScan(" " + nq, (p, i) => {
    if (mark[i] === gen) return;
    mark[i] = gen;
    const whole = p === off[i] && blob.charCodeAt(p + end) === 32 && p + end === off[i + 1];
    push(whole ? T_NAME : T_WORD, i);
  });
  const full = () => ids.length === SUGG && worst <= T_WORD;

  // pass 2 — every query word matches SOME name word, in any order: "silva david"
  // and "david jonathan" found nothing at all before this
  const toks = nq.split(" ");
  if (toks.length > 1 && !full()) {
    // anchor on the longest word: fewest hits to verify the others against
    const ai = toks.reduce((a, b, k) => toks[a].length >= b.length ? a : k, 0);
    const rest = toks.filter((_, k) => k !== ai);
    pScan(" " + toks[ai], (p, i) => {
      if (mark[i] === gen || !rest.every(tk => pHasWord(i, tk))) return;
      mark[i] = gen;
      push(T_ALL, i);
    });
  }
  // pass 3 — anywhere inside a word ("brahim" for Ibrahimović). Skipped once the
  // list is full of better tiers, which is the common case.
  if (!full()) pScan(nq, (p, i) => {
    if (mark[i] === gen) return;
    mark[i] = gen;
    push(T_INFIX, i);
  });
  // A query that only ever landed *inside* words has almost certainly been
  // misspelt — "haland" hits nothing but Achalandabaso. Trigger the rescue on
  // that too, not just on nothing at all, and let fame order the union.
  if (rescue && (!ids.length || ranks[0] >= T_INFIX)) {
    const seen = new Set(ids);
    for (const id of pRescue(nq, excl)) if (!seen.has(id)) ids.push(id);
    ids.sort((a, b) => DB.fame[b] - DB.fame[a]);
    if (ids.length > SUGG) ids.length = SUGG;
  }
  return ids;
}

// ------------------------------------------------------------- typo tolerance
// Every distinct word across all names (~43k), for the rescue below.
function pWords() {
  if (DB.pWordList) return DB.pWordList;
  const set = new Set();
  for (const w of DB.pBlob.split(" ")) if (w.length > 2) set.add(w);
  return DB.pWordList = [...set];
}
// one edit apart, counting a transposition as one — "trezegeut" for "trezeguet"
// is the commonest slip of all and two plain edits away
function near1(a, b) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; }
    else { i++; j++; }
  }
  return e + (la - i) + (lb - j) <= 1;
}
// Last resort, and ONLY when the query matched nothing at all: swap one word for
// a real name that is a single edit away and search again. A full sweep of the
// word list costs ~10ms, which is affordable precisely because it cannot happen
// on a keystroke that found something. Results come back in fame order — with a
// misspelling there is no match quality left to rank by.
function pRescue(nq, excl) {
  const toks = nq.split(" ").filter(tk => tk.length > 3);  // too short to correct meaningfully
  if (!toks.length) return [];
  toks.sort((a, b) => b.length - a.length);  // the longest word carries the most signal
  const words = pWords(), seen = new Set(), out = [];
  for (const tk of toks) {
    const alts = [];
    for (const w of words) if (w.length && w !== tk && near1(w, tk)) alts.push(w);
    for (const alt of alts.slice(0, 10)) {
      for (const id of playerMatches(nq.replace(tk, alt), excl, false)) {
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
    }
    if (out.length) break;
  }
  return out.sort((a, b) => DB.fame[b] - DB.fame[a]).slice(0, SUGG);
}

// a player row over two lines: name and birth year, then the clubs. The clubs are
// what make a half-remembered name recognisable — "Jonathan David" means nothing
// to someone who only recalls Lille and Juventus.
function playerRow(id, nq) {
  const clubs = pClubs(id, 3).map(esc).join(" · ");
  return `<span class="s-row"><span>${flag(DB.nats[id])} ${hilite(DB.names[id], nq)}</span>`
       + `<small>${DB.births[id] || ""}</small></span>`
       + (clubs ? `<small class="s-sub">${clubs}</small>` : "");
}

let cursor = -1;
let suggIds = [];   // what the list currently shows: the cursor indexes THIS, not a re-run of the search
// The list is the popup of a combobox, so every open and close has to carry the
// input's aria state with it — without that the arrow-key cursor below moves
// through rows a screen reader never hears about.
function suggOpen(open) {
  sugg.hidden = !open;
  search.setAttribute("aria-expanded", String(open));
  if (!open) { search.removeAttribute("aria-activedescendant"); cursor = -1; }
}
function moveCursor(items, i) {
  cursor = i;
  items.forEach((li, k) => {
    li.classList.toggle("active", k === i);
    li.setAttribute("aria-selected", String(k === i));
  });
  if (i >= 0) search.setAttribute("aria-activedescendant", items[i].id);
}
function renderSuggestions(ids, q = "") {
  const nq = norm(q);
  sugg.innerHTML = "";
  suggIds = ids;
  suggOpen(ids.length > 0);
  ids.forEach((id, i) => {
    const li = document.createElement("li");
    li.id = "sg" + i;
    li.setAttribute("role", "option");
    if (mode === "club") {
      const c = DB.clubs[id];
      li.innerHTML = `<span>${countryFlag(c[1])} ${hilite(c[0], nq)}${defunct(c)}</span><small>${leagueNames(c[2])}</small>`;
    } else {
      li.innerHTML = playerRow(id, nq);
      li.classList.add("two");
    }
    li.onmousedown = (e) => { e.preventDefault(); addSel(id); };
    sugg.appendChild(li);
  });
  if (ids.length) moveCursor([...sugg.children], 0);
}
const addSel = (id) => mode === "club" ? addClub(id) : addPlayer(id);

function leagueNames(mask) {
  return DB.leagues.filter((_, i) => mask & (1 << i)).map(l => l[0]).join(" · ");
}

search.addEventListener("input", () => { browseOpen(false); renderSuggestions(matches(search.value), search.value); });
search.addEventListener("keydown", (e) => {
  const items = [...sugg.children];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    // with no list open the arrows have nothing to walk here, so ArrowDown steps
    // out of the field and into the results (which take over from there)
    if (sugg.hidden || !items.length) {
      if (e.key === "ArrowDown") navRows()[0]?.focus();
      return;
    }
    moveCursor(items, (cursor + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
  } else if ((e.key === "Enter" || e.key === "Tab") && cursor >= 0 && !sugg.hidden) {
    e.preventDefault();  // Tab confirms like Enter instead of leaving the field
    addSel(suggIds[cursor]);  // the rendered list, not a second run of the search
  } else if (e.key === "Backspace" && !search.value) {
    if (mode === "club" && clubIds.length) removeClub(clubIds[clubIds.length - 1]);
    else if (mode === "player" && playerIds.length) removePlayer(playerIds[playerIds.length - 1]);
  } else if (e.key === "Escape") { suggOpen(false); }
});
// The suggestion list is NOT tied to the input keeping focus. It used to hide on blur,
// which meant putting the phone keyboard away also threw away the list you opened it to
// read. Every path that should close it already says so (selection, Escape, mode switch,
// browse, empty query); the only case blur really stood for is a tap somewhere else.
document.addEventListener("pointerdown", (e) => {
  if (!sugg.hidden && !e.target.closest("#picker")) suggOpen(false);
});

// Phones: the keyboard costs half the viewport and nothing takes it away — page
// scrolling never dismisses it — so the list is read through a slot. Any drag means
// "I'm done typing, let me read", including a drag on the suggestions themselves.
// touchmove and not scroll: focusing an input makes the browser scroll it into view,
// and blurring on that would shut the keyboard on the very tap that opened it.
if (matchMedia("(pointer: coarse)").matches)
  document.addEventListener("touchmove", () => {
    if (document.activeElement === search) search.blur();
  }, { passive: true });

// ------------------------------------------------------- FM-style team browser
const browse = $("browse"), browseBtn = $("browsebtn"), brBack = $("br-back");
let brCC = null, brLG = null;  // drill-down state: country code, league index | "x" (Others)
const canHover = matchMedia("(hover: hover)").matches;

// GB renders as England wherever clubs or leagues appear — the covered pyramid is
// English, even for its Welsh clubs. Player nationality flags keep flag() (real GB).
const ENG = { flag: "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
              it: "Inghilterra", en: "England" };
const countryName = (cc) => cc === "GB" ? (ENG[lang] || ENG.en) : natName(cc);
const countryFlag = (cc) => cc === "GB"
  ? `<span role="img" title="${esc(countryName(cc))}" aria-label="${esc(countryName(cc))}">${ENG.flag}</span>`
  : flag(cc);

function browseOpen(open) {
  if (browse.hidden === !open) return;
  browse.hidden = !open;
  browseBtn.setAttribute("aria-expanded", open);
  if (open) {
    suggOpen(false);
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
  search.value = ""; suggOpen(false);
  renderChips(); solve(); syncHash();
  focusSearch();   // desktop keeps typing; on touch the keyboard stays down to read the result
}
function removeClub(ci) {
  clubIds = clubIds.filter(x => x !== ci);
  renderChips(); solve(); syncHash();
}
// player selections aren't hash-synced: player QIDs aren't in the index,
// so a shared link couldn't be restored without loading every career shard
function addPlayer(pid) {
  if (pid === undefined || playerIds.includes(pid)) return;
  playerIds.push(pid);
  search.value = ""; suggOpen(false);
  renderChips(); solve();
  focusSearch();
}
function removePlayer(pid) {
  playerIds = playerIds.filter(x => x !== pid);
  renderChips(); solve();
}
function renderChips() {
  chips.innerHTML = "";
  const mk = (html, title, onRemove) => {
    const el = document.createElement("span");
    el.className = "chip";
    if (title) el.title = title;
    el.innerHTML = `${html} <button aria-label="${t.remove}">×</button>`;
    el.querySelector("button").onclick = onRemove;
    chips.appendChild(el);
  };
  if (mode === "club") clubIds.forEach(ci => {
    const c = DB.clubs[ci];  // chips show the short FM-style name; full name in search + careers
    mk(`${countryFlag(c[1])} ${esc(coreClub(c[0]))}${defunct(c)}`, c[0], () => removeClub(ci));
  });
  else playerIds.forEach(pid =>  // birth year confirms which homonym was picked
    mk(`${flag(DB.nats[pid])} ${esc(DB.names[pid])}${DB.births[pid] ? ` <small>(${DB.births[pid]})</small>` : ""}`,
       "", () => removePlayer(pid)));
  const sel = mode === "club" ? clubIds : playerIds;
  if (sel.length >= 2) {  // clear-all rides the chip row; one chip has its own × already
    const b = document.createElement("button");
    b.type = "button";
    b.className = "clearchip";
    b.textContent = `✕ ${t.clearAll}`;
    b.onclick = () => {
      if (mode === "club") { clubIds = []; syncHash(); } else playerIds = [];
      renderChips(); solve();
      focusSearch();
    };
    chips.appendChild(b);
  }
}

// ------------------------------------------------------- random demo query
// shown whenever the current mode has no selection: one tap rolls 2–3
// current top-division clubs, or 2–3 players born within a couple of years
// of each other (photo + known birth year as the notability proxy)
function renderExamples() {  // a nudge toward the picker dice, not a control of its own
  const li = document.createElement("li");
  li.className = "examples";
  li.textContent = t.spin;
  results.appendChild(li);
}
const draw = (pool, n) => {  // n distinct random picks
  const p = [...pool], out = [];
  while (out.length < n && p.length) out.push(p.splice(Math.random() * p.length | 0, 1)[0]);
  return out;
};
// a roll must land on something to show: clubs re-draw until they intersect;
// players are drawn same-age from one random roster, so a shared club is
// guaranteed by construction. Both ease 3 picks down to 2 if draws keep failing.
function runRandom(m) {
  let n = 2 + (Math.random() < .35 ? 1 : 0);
  if (m === "club") {
    // first league index of each country group = the top division
    DB.topLeagues ||= new Set(DB.leagues.reduce((a, l, i) =>
      (i === 0 || DB.leagues[i - 1][2] !== l[2]) ? (a.push(i), a) : a, []));
    const pool = DB.clubs.map((c, i) => i)
      .filter(i => !DB.clubs[i][4] && DB.topLeagues.has(DB.clubs[i][5] ?? -1));
    let pick = draw(pool, n);
    for (let tries = 1; tries <= 80 && intersect(pick.map(postings)).length === 0; tries++) {
      if (tries === 30) n = 2;
      pick = draw(pool, n);
    }
    clubIds = pick;
    syncHash();
  } else {
    let pick = null;
    for (let tries = 1; !pick && tries <= 80; tries++) {
      if (tries === 40) n = 2;
      const arr = postings(Math.random() * DB.clubs.length | 0);
      const cand = [];
      for (let k = 0; k < arr.length; k++)
        if (DB.imgs[arr[k]] && DB.births[arr[k]]) cand.push(arr[k]);
      const a = cand[Math.random() * cand.length | 0];
      if (a === undefined) continue;
      const near = cand.filter(p => p !== a && Math.abs(DB.births[p] - DB.births[a]) <= 2);
      if (near.length >= n - 1) pick = [a, ...draw(near, n - 1)];
    }
    if (!pick) return;
    playerIds = pick;
  }
  if (mode !== m) setMode(m);  // setMode re-renders chips + results for the new selection
  else { renderChips(); solve(); }
}
$("randbtn").onclick = () => runRandom(mode);  // the picker dice re-rolls in the current mode

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
  if (mode === "player") return solvePlayers();
  results.innerHTML = "";
  if (clubIds.length === 0) {  // no nagging: the stats line + dice nudge are the empty state
    status.textContent = t.stats(DB.names.length, DB.clubs.length);
    natCounts.clear(); renderNats(); renderExamples();
    return;
  }
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
  // nationality counts are taken before this filter, so unchecked rows keep their numbers.
  // The filter lists COUNTRIES, not the combinations the nat field stores, so a
  // dual-national is counted under each of his and stays visible while either is ticked.
  natCounts.clear();
  for (const p of ids)
    for (const cc of natsOf(p)) natCounts.set(cc, (natCounts.get(cc) || 0) + 1);
  renderNats();
  if (natOff.size) ids = ids.filter(p => !natsOf(p).every(cc => natOff.has(cc)));
  const key = sortBy === "goals" ? (p) => goalsOf.get(p) || 0
            : sortBy === "birth" ? (p) => DB.births[p] || 9999 * sortDir  // unknown last
            : (p) => appsOf.get(p) || 0;
  ids.sort((a, b) => sortDir * (key(a) - key(b)) || DB.names[a].localeCompare(DB.names[b]));
  const ms = performance.now() - t0;
  status.innerHTML = t.found(ids.length, ms.toFixed(1))
    + (ids.length && clubIds.length > 1 ? ` <span class="comb">(${t.combNote})</span>` : "");
  status.appendChild(linkBtn());
  if (ids.length === 0) {  // a dead end still deserves a way forward
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = clubIds.length > 1 && common.length === 0 ? t.noneCommon : t.noneFilter;
    results.appendChild(li);
  }
  renderResults(ids, appsOf, goalsOf, zeroGoals);
}

// ---------------------------------------------------------------- share
// The club selection has always been in the URL hash (syncHash), but nothing on
// the page said so, and on a phone copying the address bar is a chore. Sits at the
// right of the status row, where player mode keeps its "dettagli" switch.
function linkBtn() {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "linkbtn";
  b.textContent = `🔗 ${t.copyLink}`;
  b.title = t.copyLinkT;
  b.onclick = () => shareLink(b);
  return b;
}
async function shareLink(btn) {
  const url = location.href;
  // native sheet only on touch, like the quiz's share: on desktop navigator.share
  // exists but often no-ops, so there we always copy
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ url }); return; } catch (err) { if (err && err.name === "AbortError") return; }
  }
  const done = () => {
    btn.textContent = t.copied; btn.classList.add("copied");
    setTimeout(() => { btn.textContent = `🔗 ${t.copyLink}`; btn.classList.remove("copied"); }, 1500);
  };
  try { await navigator.clipboard.writeText(url); done(); return; } catch {}
  try {  // last-ditch for older Safari without the async clipboard API
    const ta = document.createElement("textarea");
    ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove(); done();
  } catch {}
}

// ------------------------------------------------------ solve: player mode
// one player = plain lookup: the usual result row with the career panel open
let sharedNames = new Set();  // shared clubs of the current selection: highlighted in expanded careers
async function solvePlayers() {
  results.innerHTML = "";
  const g = ++solveGen;
  sharedNames = new Set();
  if (!playerIds.length) {
    status.textContent = t.stats(DB.names.length, DB.clubs.length);
    renderExamples(); return;
  }
  if (playerIds.length === 1) {
    status.textContent = "";
    renderResults(playerIds, new Map(), new Map(), new Set());
    toggleCareer(results.firstChild, playerIds[0]);
    return;
  }
  let careers;
  try { careers = await Promise.all(playerIds.map(careerOf)); }
  catch { if (g === solveGen) status.textContent = t.loadFail; return; }
  if (g !== solveGen || mode !== "player") return;  // selection or mode changed mid-fetch
  const t0 = performance.now();
  const curYear = +(DB.built || "").slice(0, 4) || new Date().getFullYear();
  // per player: team name -> [[start, end, effEnd, apps, goals], ...]; distinct
  // spells stay separate. An open-ended spell effectively runs until the player's
  // next transfer (loans out don't end it) or, with no later move, the dataset year.
  const maps = careers.map(([, career = []]) => {
    const spells = career.filter(e => e[0]);
    const m = new Map();
    spells.forEach(([team, s, e, a, gl], i) => {
      let eff = e;
      if (s && !e) {
        const next = spells.slice(i + 1).find(sp => sp[1] && sp[1] >= s && !sp[5]);
        eff = next ? next[1] : curYear;
      }
      if (!m.has(team)) m.set(team, []);
      m.get(team).push([s, e, eff, a, gl]);
    });
    return m;
  });
  // apps/goals of player k at a club: known values summed across their spells
  const sums = (k, name) => {
    let a = null, gl = null;
    for (const sp of maps[k].get(name) || []) {
      if (sp[3] != null) a = (a || 0) + sp[3];
      if (sp[4] != null) gl = (gl || 0) + sp[4];
    }
    return [a, gl];
  };
  // career team names are canonical within a build, so a plain string match
  // is exact — same trick as the career panel's `hit` highlight
  const smallest = maps.reduce((a, b) => a.size <= b.size ? a : b);
  const startOf = (name) =>  // earliest known arrival of any of them, unknowns last
    Math.min(...maps.map(m => Math.min(...m.get(name).map(([s]) => s || Infinity))));
  const shared = [...smallest.keys()].filter(name => maps.every(m => m.has(name)))
    .sort((a, b) => startOf(a) - startOf(b) || a.localeCompare(b));
  // with a single shared team every figure equals the combined meta on the
  // player rows below — stats and totals only from two teams up, and only
  // when the "dettagli" toggle is on (the compact view stays years-only)
  const multi = shared.length > 1, showStats = multi && detail;

  DB.clubByName ||= new Map(DB.clubs.map((c, i) => [c[0], i]));
  const frag = document.createDocumentFragment();
  for (const name of shared) {
    const ci = DB.clubByName.get(name);
    const c = ci !== undefined ? DB.clubs[ci] : null;
    // teammate window: years every player provably spent there (spells with a
    // known start). If someone's spells there are all startless, claim nothing.
    let badge = "";
    const dated = maps.map(m => m.get(name).filter(([s, , eff]) => s && eff));
    if (dated.every(k => k.length)) {
      const years = dated.map(k => {
        const st = new Set();
        for (const [s, , eff] of k) for (let y = s; y <= eff; y++) st.add(y);
        return st;
      });
      const com = [...years[0]].filter(y => years.every(st => st.has(y))).sort((a, b) => a - b);
      const runs = [];
      for (const y of com) {
        const last = runs[runs.length - 1];
        if (last && last[1] === y - 1) last[1] = y; else runs.push([y, y]);
      }
      badge = runs.length  // a window reaching the dataset year is ongoing: leave it open
        ? ` <span class="mates">${t.mates(runs.map(([s, e]) => e === curYear ? `${s}–` : yspan(s, e)).join(", "))}</span>`
        : ` <span class="nomates">${t.noOverlap}</span>`;
    }
    const li = document.createElement("li");
    li.className = "player sclub";
    const lg = c && c[5] >= 0 ? DB.leagues[c[5]][0] : t.others;  // current league; outside/dissolved/uncovered = Others
    li.innerHTML = `<div class="pinfo"><span class="pname"><span class="cname${c ? " link" : ""}">${c ? countryFlag(c[1]) + " " : ""}${esc(name)}</span>${c ? defunct(c) : ""} <small class="clg">· ${lg}</small>${badge}</span></div>`
      + playerIds.map((pid, k) => {  // name left, spells right: multi-range strings vary too much to column-align
        const [a, gl] = sums(k, name);
        const st = showStats ? [a != null ? a + " " + t.apps(a) : "",
                                gl != null && !DB.gkSet.has(pid) ? gl + " " + t.goals(gl) : ""].filter(Boolean).join(" · ") : "";
        return `<div class="crow"><span class="cteam">${esc(DB.names[pid])}${st ? ` <small class="cst">${st}</small>` : ""}</span><span class="cstats">${maps[k].get(name).map(([s, e]) => yspan(s, e)).join(", ")}</span></div>`;
      }).join("");
    if (showStats) {  // team total: everyone's known figures at this club together
      let a = null, gl = null;
      playerIds.forEach((pid, k) => {
        const [sa, sg] = sums(k, name);
        if (sa != null) a = (a || 0) + sa;
        if (sg != null && !DB.gkSet.has(pid)) gl = (gl || 0) + sg;
      });
      const st = [a != null ? a + " " + t.apps(a) : "", gl != null ? gl + " " + t.goals(gl) : ""].filter(Boolean).join(" · ");
      if (st) li.innerHTML += `<div class="crow tcrow"><span class="cteam"><small class="cst">(${t.comb(a != null)}) ${st}</small></span></div>`;
    }
    if (c)  // covered club: click through to club mode, showing its full roster
      li.querySelector(".cname").onclick = () => { clubIds = [ci]; syncHash(); setMode("club"); };
    frag.appendChild(li);
  }
  results.appendChild(frag);
  sharedNames = new Set(shared);
  // the selected players themselves, expandable to their full careers —
  // all there is to show when they share no club at all. Their meta mirrors
  // club mode: apps/goals combined across the shared clubs, 0 goals only
  // when known at every one of them.
  const appsOf = new Map(), goalsOf = new Map(), zeroGoals = new Set();
  playerIds.forEach((pid, k) => {
    let a = null, gl = null, gClubs = 0;
    for (const name of shared) {
      const [sa, sg] = sums(k, name);
      if (sa != null) a = (a || 0) + sa;
      if (sg != null) { gl = (gl || 0) + sg; gClubs++; }
    }
    if (a != null) appsOf.set(pid, a);
    if (!DB.gkSet.has(pid)) {
      if (gl != null) goalsOf.set(pid, gl);
      if (shared.length && gClubs === shared.length && !gl) zeroGoals.add(pid);
    }
  });
  const sep = document.createElement("li");
  sep.className = "lsep";
  sep.textContent = t.selPlayers;
  if (appsOf.size || goalsOf.size) {  // grand total: everyone, every shared team — always on
    let a = 0, gl = 0;
    for (const x of appsOf.values()) a += x;
    for (const x of goalsOf.values()) gl += x;
    const st = [appsOf.size ? a.toLocaleString(lang) + " " + t.apps(a) : "",
                goalsOf.size ? gl.toLocaleString(lang) + " " + t.goals(gl) : ""].filter(Boolean).join(" · ");
    sep.innerHTML = `<span>${t.selPlayers}</span><span class="tot">${st} <span class="comb">(${t.comb(!!appsOf.size)})</span></span>`;
  }
  results.appendChild(sep);
  renderResults(playerIds, appsOf, goalsOf, zeroGoals);
  status.textContent = t.foundClubs(shared.length, (performance.now() - t0).toFixed(1));
  if (multi) {  // dettagli switch, right-aligned: apps/goals + per-team totals in the cards
    const lab = document.createElement("label");
    lab.className = "dtg";
    lab.innerHTML = `${t.detail}<input type="checkbox"${detail ? " checked" : ""}><span class="knob"></span>`;
    lab.querySelector("input").onchange = (e) => {
      detail = e.target.checked;
      localStorage.pdetail = detail ? "1" : "0";
      solvePlayers();
    };
    status.appendChild(lab);
  }
}

sortSel.onchange = () => { sortBy = sortSel.value; solve(); };
dirBtn.onclick = () => {
  sortDir = -sortDir;
  dirBtn.textContent = sortDir < 0 ? "↓" : "↑";
  dirBtn.title = sortDir < 0 ? t.desc : t.asc;
  solve();
};
// Typing a year is four keystrokes, and each one used to run a full solve plus a
// rebuild of the nationality panel — with the half-typed bound ("19", "1") matching
// almost nobody, so the list emptied and flashed on the way to the real value.
let bornTimer = 0;
const solveSoon = () => { clearTimeout(bornTimer); bornTimer = setTimeout(solve, 250); };
byFrom.oninput = byTo.oninput = solveSoon;
byFrom.onchange = byTo.onchange = () => { clearTimeout(bornTimer); solve(); };  // spinner, blur, Enter: no wait
noZero.onchange = solve;

// ------------------------------------------------------- nationality filter
const natToggle = $("nattoggle"), natPanel = $("natpanel"), natList = $("natlist");
let natOff = new Set();       // unchecked nationality codes ("" = unknown)
let natCounts = new Map();    // current list's per-nationality counts (pre-nationality-filter)

function renderNats() {
  const rows = [...natCounts].map(([cc, n]) => [cc, n, natName(cc)])
    .sort((a, b) => b[1] - a[1] || a[2].localeCompare(b[2]));
  const st = natList.scrollTop;  // rebuilt on every solve: keep the reading position
  natList.innerHTML = "";
  for (const [cc, n, name] of rows) {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !natOff.has(cc);
    cb.onchange = () => { if (cb.checked) natOff.delete(cc); else natOff.add(cc); solve(); };
    const lab = document.createElement("label");
    const txt = document.createElement("span");   // flag() is HTML, so it cannot be appended as text
    txt.innerHTML = ` ${cc ? flag(cc) + " " : ""}${esc(name)}`;
    lab.append(cb, txt);
    const cnt = document.createElement("span");
    cnt.className = "ncount"; cnt.textContent = n.toLocaleString(lang);
    lab.appendChild(cnt);
    li.appendChild(lab); natList.appendChild(li);
  }
  natList.scrollTop = st;
  const on = rows.reduce((k, [cc]) => k + !natOff.has(cc), 0);
  const filtered = on < rows.length;  // the button reads "tutte" until a subset is picked
  $("natcount").textContent = filtered ? `${on}/${rows.length}` : t.natAll;
  $("natcount").classList.toggle("on", filtered);
  natToggle.disabled = rows.length === 0;
  if (!rows.length) natClose();
  renderFilterState();
}

// The filter panel is collapsed by default and its settings survive every change
// of selection, so a forgotten filter silently shrinks the result count with
// nothing on screen to explain it. The toggle carries a badge counting the active
// filters, and the reset sits beside it — undoing them must not require opening
// the panel to find out they were there.
const natFiltered = () => [...natCounts.keys()].some(cc => natOff.has(cc));
function renderFilterState() {
  const n = (noZero.checked ? 1 : 0) + (byFrom.value || byTo.value ? 1 : 0) + (natFiltered() ? 1 : 0);
  advCount.textContent = n ? ` · ${n}` : "";
  $("advtoggle").classList.toggle("on", n > 0);
  filtReset.hidden = n === 0;
}
filtReset.onclick = () => {
  natOff.clear();
  noZero.checked = false;
  byFrom.value = byTo.value = "";
  solve();
};

function natClose() {
  natPanel.hidden = true;
  natToggle.setAttribute("aria-expanded", false);
}
natToggle.onclick = (e) => {
  e.stopPropagation();
  const open = natPanel.hidden;
  if (open) {  // anchor under the Nazionalità row, wherever the layout put it
    const ctl = $("natctl");
    natPanel.style.top = `${ctl.offsetTop + ctl.offsetHeight + 6}px`;
    natPanel.style.left = `${ctl.offsetLeft}px`;
  }
  natPanel.hidden = !open;
  natToggle.setAttribute("aria-expanded", open);
};
natPanel.onclick = (e) => e.stopPropagation();
$("natall").onclick = () => { natOff.clear(); solve(); };
$("natnone").onclick = () => { for (const cc of natCounts.keys()) natOff.add(cc); solve(); };
document.addEventListener("click", natClose);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !natPanel.hidden) natClose();
});

function renderResults(ids, appsOf, goalsOf, zeroGoals, from = 0) {
  const frag = document.createDocumentFragment();
  ids.slice(from, from + PAGE).forEach((pid, i) => {
    const li = document.createElement("li");
    li.className = "player";
    li.style.animationDelay = `${Math.min(i, 14) * 22}ms`;  // solve cascade, capped
    const img = DB.imgs[pid]
      ? `<img loading="lazy" src="${thumbURL(DB.imgs[pid])}" alt="">`
      : `<span class="avatar">${initials(pid)}</span>`;
    const apps = appsOf.get(pid), goals = goalsOf.get(pid);
    // no per-row "(combined)" tag: club mode states it once in the status row,
    // player mode in the selected-players divider
    const parts = [apps ? t.combApps(apps) : "", goals || zeroGoals.has(pid) ? t.combGoals(goals || 0) : ""].filter(Boolean);
    const meta = parts.join(" · ");
    // rank numeral = position in the current sort; meaningless for a hand-picked selection
    const rank = mode === "club" ? `<span class="rank">${from + i + 1}</span>` : "";
    li.innerHTML = `${rank}${img}<div class="pinfo"><span class="pname">${flag(DB.nats[pid])} ${esc(DB.names[pid])}${DB.gkSet.has(pid) ? " <small>(GK)</small>" : ""}${DB.births[pid] ? ` <small>(${DB.births[pid]})</small>` : ""}</span></div>${meta ? `<span class="pstats">${meta}</span>` : ""}<span class="expand">▸</span>`;
    const im = li.querySelector("img");
    if (im) im.onerror = () => {  // e.g. original narrower than 120px: the redirect resolves it
      im.onerror = () => im.replaceWith(avatar(initials(pid)));
      im.src = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(DB.imgs[pid].slice(2))}?width=96`;
    };
    li.onclick = () => toggleCareer(li, pid);
    li.tabIndex = 0;  // keyboard: Enter/Space toggles the career, arrows walk the list
    li.setAttribute("aria-expanded", "false");
    li.dataset.pid = pid;
    li.onkeydown = (e) => {
      // same as an arrow move: what it unfolds has to end up on screen
      if (e.target === li && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        toggleCareer(li, pid).then(() => revealRow(li));
      }
    };
    frag.appendChild(li);
  });
  results.appendChild(frag);
  const shown = Math.min(from + PAGE, ids.length);
  if (ids.length > shown) {
    const li = document.createElement("li");
    li.className = "more";
    li.textContent = t.more(ids.length - shown);
    li.tabIndex = 0;
    li.onclick = () => { li.remove(); renderResults(ids, appsOf, goalsOf, zeroGoals, shown); };
    li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); li.click(); } };
    results.appendChild(li);
  }
}

// ------------------------------------------------------ keyboard: result list
// The rows have always been tabbable and Enter has always opened a career, but the
// arrows did nothing here: the page scrolled and the focus stayed behind, which is
// worst exactly when a career is open and the row is tall. Now the arrows walk the
// list, ArrowUp from the top returns to the search box, and an open career TRAVELS —
// it closes behind you and opens on the row you land on, so holding ArrowDown reads
// the careers one after another instead of leaving every panel open in your wake.
const NAVSEL = "li.player:not(.sclub), li.more";
const navRows = () => [...results.querySelectorAll(NAVSEL)];
// Keep the whole row on screen, career and all. focus() scrolls the row's own box
// into view and stops, but the panel is added AFTER that — so stepping onto the last
// visible row unfolded the career below the fold, out of sight. A row taller than
// the viewport can't fit: pin its top instead, which shows as much as there is room
// for and puts the earliest spells (the ones the scroll would hide) first.
const NAVPAD = 14;
function revealRow(el) {
  const r = el.getBoundingClientRect();
  const dy = r.height > innerHeight - 2 * NAVPAD || r.top < NAVPAD ? r.top - NAVPAD
           : r.bottom > innerHeight - NAVPAD ? r.bottom - innerHeight + NAVPAD : 0;
  if (dy) scrollBy(0, dy);
}
let navGen = 0;
async function navOpen(row) {
  const g = ++navGen;
  await toggleCareer(row, +row.dataset.pid);
  // a shard still in flight can land after the next arrow press: don't leave a trail
  if (g !== navGen) { if (row.querySelector(".career")) toggleCareer(row, +row.dataset.pid); return; }
  revealRow(row);  // only now is the career in the layout
}
// A scroll moves the rows, not the mouse, and the browser keeps :hover on whatever
// passed under a parked cursor — so the green border was left on a row three or four
// back from the one being read, with the pointer nowhere near it. While the view is
// moving, hover isn't what anyone means; the next real mouse move brings it back.
// (Touch never gets here: a finger has no hover to go stale.)
const noHover = (on) => document.body.classList.toggle("nohover", on);
addEventListener("scroll", () => noHover(true), { passive: true });
addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") noHover(false); }, { passive: true });

results.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const from = e.target;
  if (!from.matches || !from.matches(NAVSEL)) return;  // a link inside an open career
  const rows = navRows(), i = rows.indexOf(from), to = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
  if (!to) {
    if (e.key === "ArrowUp" && i === 0) { e.preventDefault(); search.focus(); }
    return;
  }
  e.preventDefault();
  const open = !!from.querySelector(".career");
  if (open) toggleCareer(from, +from.dataset.pid);
  to.focus({ preventScroll: true });  // revealRow does the scrolling, once the row is final
  if (open && to.dataset.pid) navOpen(to);
  else revealRow(to);
});

// ArrowDown reaches the list from anywhere that isn't already listening for it: after
// a dice roll the focus sits on the button, after most other actions on <body>, and
// there the key only scrolled the page. Panels that own their own arrows keep them.
addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (document.body.classList.contains("quiz") || document.querySelector("dialog[open]")) return;
  if (!browse.hidden || !natPanel.hidden) return;
  const a = document.activeElement;
  if (a && (a.matches("input, select, textarea") || a.closest("#results"))) return;
  const first = navRows()[0];
  if (!first) return;
  e.preventDefault();
  first.focus({ preventScroll: true });
  revealRow(first);
});

// imgs entries are "hh" (md5 prefix, the Commons hashed-directory path) + underscored
// filename: enough to hit upload.wikimedia.org directly, skipping the two uncacheable
// Special:FilePath redirects that made every re-render refetch
function thumbURL(entry) {
  const h = entry.slice(0, 2), f = entry.slice(2);
  let t = `120px-${f}`;
  if (/\.svg$/i.test(f)) t += ".png";
  else if (/\.tiff?$/i.test(f)) t = `lossy-page1-${t}.jpg`;
  else if (/\.pdf$/i.test(f)) t = `page1-${t}.jpg`;
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${h[0]}/${h}/${encodeURIComponent(f)}/${encodeURIComponent(t)}`;
}

const initials = (pid) => DB.names[pid].split(" ").map(w => w[0]).slice(0, 2).join("");
const avatar = (txt) => {
  const s = document.createElement("span");
  s.className = "avatar"; s.textContent = txt;
  return s;
};

// ---------------------------------------------------------------- career panel
function fetchShard(shard) {
  if (!careerCache.has(shard))  // versioned by dataset stamp: a stale cached shard would pair wrong careers with a fresh index
    careerCache.set(shard, fetch(`data/career/${shard}.json?v=${DB.built || 0}`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(err => { careerCache.delete(shard); throw err; }));
  return careerCache.get(shard);
}
const careerOf = async (pid) =>  // [qidNumber, spells] — shard count stamped in the index by the pipeline
  (await fetchShard(pid % (DB.nshards || 128)))[pid] || [];

const sitelinksCache = new Map();
async function wikiSitelinks(qid) {
  if (sitelinksCache.has(qid)) return sitelinksCache.get(qid);
  const p = fetch(`https://www.wikidata.org/wiki/Special:EntityData/Q${qid}.json`)
    .then(r => r.json())
    .then(j => j.entities[`Q${qid}`].sitelinks)
    .catch(() => null);
  sitelinksCache.set(qid, p);
  return p;
}

// carry one player over into player mode, replacing that mode's selection —
// the same move quiz.js makes from a revealed answer (qOpenPlayer). Scrolls back
// up: the row clicked can be far down a long list, and the new view is one card.
function openPlayerMode(pid) {
  playerIds = [pid];
  scrollTo(0, 0);
  if (mode !== "player") setMode("player");
  else { renderChips(); solve(); }
}

async function toggleCareer(li, pid) {
  // the arrow and aria-expanded are the same disclosure state, told twice
  const mark = (o) => {
    li.querySelector(".expand").textContent = o ? "▾" : "▸";
    li.setAttribute("aria-expanded", String(o));
  };
  const open = li.querySelector(".career");
  if (open) { open.remove(); mark(false); return; }
  mark(true);
  let qid, career;
  try { [qid = 0, career = []] = await careerOf(pid); }
  catch { mark(false); return; }
  if (li.querySelector(".career")) return;
  // club mode highlights the selected clubs; player mode the shared ones
  const selNames = mode === "club" ? new Set(clubIds.map(ci => DB.clubs[ci][0])) : sharedNames;
  const gk = DB.gkSet.has(pid);  // goalkeeper goal counts are unreliable, show apps only
  const div = document.createElement("div");
  div.className = "career";
  const spells = career.filter(e => e[0]);
  // explicit Wikidata loan flag (P1642), else heuristic: a spell strictly inside
  // an earlier spell's known range reads as a loan from that club
  const loan = spells.map(([, s, e, , , ln], i) => !!ln || !!(s && e && spells.slice(0, i).some(
    ([, s2, e2]) => s2 && e2 && s2 <= s && e <= e2 && e2 - s2 > e - s)));
  div.innerHTML = (spells.map(([team, s, e, apps, goals], i) =>
    `<div class="crow${selNames.has(team) ? " hit" : ""}">
       <span class="cyears">${yspan(s, e)}</span><span class="cteam">${loan[i] ? `<span class="loan" title="${t.loan}">↳</span> ` : ""}${esc(team)}</span>
       <span class="cstats">${apps != null ? apps + " " + t.apps(apps) : ""}${!gk && goals != null ? " · " + goals + " " + t.goals(goals) : ""}</span>
     </div>`).join("") || `<div class='crow'>${t.noData}</div>`)
    // footer: the sources on the left, and pushed to the far right the reverse
    // question, asked from the player you just found — pointless in player mode,
    // where he is already the selection
    + `<div class="cfoot">`
    + (qid ? `<a class="wiki wiki-pedia" href="https://www.wikidata.org/wiki/Special:GoToLinkedPage/${lang}wiki/Q${qid}" target="_blank" rel="noopener">Wikipedia ↗</a>
              <a class="wiki" href="https://www.wikidata.org/wiki/Q${qid}" target="_blank" rel="noopener">Wikidata ↗</a>` : "")
    + (mode === "club" ? `<button type="button" class="wiki pivot" title="${esc(t.pivotT)}">${t.pivot}</button>` : "")
    + `</div>`;
  div.onclick = (e) => e.stopPropagation();
  const pv = div.querySelector(".pivot");
  if (pv) pv.onclick = () => openPlayerMode(pid);
  li.appendChild(div);
  if (qid) {
    const a = div.querySelector(".wiki-pedia");
    wikiSitelinks(qid).then(sitelinks => {
      if (!sitelinks || !div.isConnected || sitelinks[`${lang}wiki`]) return;
      const other = lang === "it" ? "en" : "it";
      const site = `${other}wiki`;
      if (!sitelinks[site]) { a.remove(); return; }
      a.href = `https://${other}.wikipedia.org/wiki/${encodeURIComponent(sitelinks[site].title)}`;
    });
  }
}

applyLang();
boot();
