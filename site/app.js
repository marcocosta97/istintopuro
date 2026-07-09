"use strict";
/* Istinto Puro solver — all client-side: one index file, set intersection. */

const $ = (id) => document.getElementById(id);
const search = $("search"), sugg = $("suggestions"), chips = $("chips"),
      results = $("results"), status = $("status");

let DB = null;               // raw index.json
let clubIds = [];            // selected club indices
const decoded = new Map();   // club index -> Int32Array of player ids
const careerCache = new Map();
const NSHARDS = 128;

// small alias map for names people actually type (keyed by club QID)
const ALIASES = {
  Q483020: ["psg"], Q8682: ["real madrid"], Q8701: ["atletico madrid"],
  Q631: ["inter"], Q1543: ["milan"], Q10329: ["siviglia"], Q8687: ["betis"],
  Q18656: ["man united", "manchester united"], Q50602: ["man city", "manchester city"],
  Q15789: ["bayern", "bayern monaco"], Q41420: ["borussia dortmund", "bvb"],
};

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "")
                     .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const initialsOf = (s) => norm(s).split(" ").filter(w => w.length > 2).map(w => w[0]).join("");
const flag = (cc) => cc ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1A5 + c.charCodeAt(0))) : "";

// ---------------------------------------------------------------- data loading
async function boot() {
  const res = await fetch("data/index.json");
  DB = await res.json();
  DB.searchNames = DB.clubs.map(c => norm(c[0]));
  DB.searchInitials = DB.clubs.map(c => initialsOf(c[0]));
  DB.aliasNorm = DB.clubs.map(c => (ALIASES[c[3]] || []).map(norm));
  search.disabled = false;
  search.focus();
  status.textContent = `${DB.names.length.toLocaleString("it")} giocatori · ${DB.clubs.length} squadre`;
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
    if (DB.searchNames[i].startsWith(nq)) rank = 0;
    else if (DB.searchNames[i].includes(nq)) rank = 1;
    else if (DB.searchInitials[i] === nq.replace(/ /g, "")) rank = 0;
    else if (DB.aliasNorm[i].some(a => a.startsWith(nq))) rank = 0;
    if (rank >= 0) out.push([rank, DB.postings[i].length, i]);
  }
  // best rank first, bigger clubs first
  return out.sort((a, b) => a[0] - b[0] || b[1] - a[1]).slice(0, 8).map(x => x[2]);
}

let cursor = -1;
function renderSuggestions(ids) {
  sugg.innerHTML = "";
  sugg.hidden = ids.length === 0;
  cursor = ids.length ? 0 : -1;
  ids.forEach((ci, i) => {
    const c = DB.clubs[ci];
    const li = document.createElement("li");
    li.innerHTML = `<span>${flag(c[1])} ${c[0]}</span><small>${leagueNames(c[2])}</small>`;
    li.className = i === cursor ? "active" : "";
    li.onmousedown = (e) => { e.preventDefault(); addClub(ci); };
    sugg.appendChild(li);
  });
}

function leagueNames(mask) {
  return DB.leagues.filter((_, i) => mask & (1 << i)).map(l => l[0]).join(" · ");
}

search.addEventListener("input", () => renderSuggestions(matches(search.value)));
search.addEventListener("keydown", (e) => {
  const items = [...sugg.children];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!items.length) return;
    cursor = (cursor + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items.forEach((li, i) => li.className = i === cursor ? "active" : "");
  } else if (e.key === "Enter" && cursor >= 0 && !sugg.hidden) {
    addClub(matches(search.value)[cursor]);
  } else if (e.key === "Backspace" && !search.value && clubIds.length) {
    removeClub(clubIds[clubIds.length - 1]);
  } else if (e.key === "Escape") { sugg.hidden = true; }
});
search.addEventListener("blur", () => setTimeout(() => {
  if (document.activeElement !== search) sugg.hidden = true;
}, 100));

// ---------------------------------------------------------------- selection
function addClub(ci) {
  if (ci === undefined || clubIds.includes(ci)) return;
  clubIds.push(ci);
  search.value = ""; sugg.hidden = true;
  renderChips(); solve();
  search.focus();
}
function removeClub(ci) {
  clubIds = clubIds.filter(x => x !== ci);
  renderChips(); solve();
}
function renderChips() {
  chips.innerHTML = "";
  clubIds.forEach(ci => {
    const c = DB.clubs[ci];
    const el = document.createElement("span");
    el.className = "chip";
    el.innerHTML = `${flag(c[1])} ${c[0]} <button aria-label="rimuovi">×</button>`;
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
  if (clubIds.length === 0) { status.textContent = "Aggiungi almeno due squadre."; return; }
  if (clubIds.length === 1) {
    status.textContent = `${postings(clubIds[0]).length.toLocaleString("it")} giocatori in rosa storica — aggiungi un'altra squadra.`;
    return;
  }
  const t0 = performance.now();
  const common = intersect(clubIds.map(postings));
  const commonSet = new Set(common);
  // combined apps across the selected clubs (0 = unknown)
  const appsOf = new Map();
  for (const ci of clubIds) {
    const arr = postings(ci), apps = DB.apps[ci];
    for (let i = 0; i < arr.length; i++)
      if (commonSet.has(arr[i]))
        appsOf.set(arr[i], (appsOf.get(arr[i]) || 0) + apps[i]);
  }
  common.sort((a, b) => (appsOf.get(b) - appsOf.get(a)) || DB.names[a].localeCompare(DB.names[b]));
  const ms = performance.now() - t0;
  status.textContent = `${common.length} giocator${common.length === 1 ? "e" : "i"} · ${ms.toFixed(1)} ms`;
  renderResults(common, appsOf);
}

function renderResults(ids, appsOf) {
  const frag = document.createDocumentFragment();
  for (const pid of ids.slice(0, 200)) {
    const li = document.createElement("li");
    li.className = "player";
    const img = DB.imgs[pid]
      ? `<img loading="lazy" src="https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(DB.imgs[pid])}?width=96" onerror="this.replaceWith(avatar('${initials(pid)}'))" alt="">`
      : `<span class="avatar">${initials(pid)}</span>`;
    const apps = appsOf.get(pid);
    li.innerHTML = `${img}<div class="pinfo"><span class="pname">${flag(DB.nats[pid])} ${DB.names[pid]}${DB.births[pid] ? ` <small>(${DB.births[pid]})</small>` : ""}</span>
      <span class="pmeta">${apps ? apps + " presenze combinate" : ""}</span></div><span class="expand">▸</span>`;
    li.onclick = () => toggleCareer(li, pid);
    frag.appendChild(li);
  }
  results.appendChild(frag);
  if (ids.length > 200) {
    const li = document.createElement("li");
    li.className = "more";
    li.textContent = `… e altri ${ids.length - 200}`;
    results.appendChild(li);
  }
}

const initials = (pid) => DB.names[pid].split(" ").map(w => w[0]).slice(0, 2).join("");
window.avatar = (txt) => {  // used by img onerror
  const s = document.createElement("span");
  s.className = "avatar"; s.textContent = txt;
  return s;
};

// ---------------------------------------------------------------- career panel
async function toggleCareer(li, pid) {
  const open = li.querySelector(".career");
  if (open) { open.remove(); li.querySelector(".expand").textContent = "▸"; return; }
  li.querySelector(".expand").textContent = "▾";
  const shard = pid % NSHARDS;
  if (!careerCache.has(shard))
    careerCache.set(shard, fetch(`data/career/${shard}.json`).then(r => r.json()));
  const career = (await careerCache.get(shard))[pid] || [];
  if (li.querySelector(".career")) return;
  const selNames = new Set(clubIds.map(ci => DB.clubs[ci][0]));
  const div = document.createElement("div");
  div.className = "career";
  div.innerHTML = career.filter(e => e[0]).map(([team, s, e, apps, goals]) =>
    `<div class="crow${selNames.has(team) ? " hit" : ""}">
       <span class="cyears">${s || "?"}–${e || (s ? "" : "?")}</span><span class="cteam">${team}</span>
       <span class="cstats">${apps != null ? apps + " pres" : ""}${goals != null ? " · " + goals + " gol" : ""}</span>
     </div>`).join("") || "<div class='crow'>nessun dato</div>";
  div.onclick = (e) => e.stopPropagation();
  li.appendChild(div);
}

boot();
