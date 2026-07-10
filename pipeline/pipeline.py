#!/usr/bin/env python3
"""Istinto Puro data pipeline: Wikidata -> compact static dataset.

Stages (each checkpoints to data/, reruns skip completed stages):
  clubs    - club universe of the 10 leagues (top 5 + 2nd divisions, incl. historical items)
  members  - player QIDs per club (P54)
  attrs    - player attributes (label, birth year, nationality, image)
  careers  - full P54 career statements per player (any team, with years/apps/goals)
  teams    - labels for career teams outside the club universe
  build    - emit site/data/index.json + career shards, print stats

Usage: python3 pipeline/pipeline.py [stage ...]   (default: all)
"""
import json, re, sys, time, gzip
from pathlib import Path
from urllib.parse import unquote
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE_DATA = ROOT / "site" / "data"
UA = "istintopuro-pipeline/0.1 (mcosta97@proton.me)"
WDQS = "https://query.wikidata.org/sparql"

LEAGUES = {  # qid: (name, tier, cc)
    "Q15804":  ("Serie A", 1, "IT"),          "Q194052": ("Serie B", 2, "IT"),
    "Q324867": ("La Liga", 1, "ES"),          "Q35615":  ("La Liga 2", 2, "ES"),
    "Q9448":   ("Premier League", 1, "GB"),   "Q19510":  ("EFL Championship", 2, "GB"),
    "Q754839": ("First Division", 1, "GB"),   "Q769744": ("Second Division", 2, "GB"),
    "Q13394":  ("Ligue 1", 1, "FR"),          "Q217374": ("Ligue 2", 2, "FR"),
    "Q82595":  ("Bundesliga", 1, "DE"),       "Q152665": ("2. Bundesliga", 2, "DE"),
}
# collapse historical English divisions into their modern successors for display
LEAGUE_ALIAS = {"Q754839": "Q9448", "Q769744": "Q19510"}
LEAGUE_ORDER = ["Q15804", "Q194052", "Q324867", "Q35615", "Q9448", "Q19510",
                "Q13394", "Q217374", "Q82595", "Q152665"]

EXCLUDE_CLUB = re.compile(
    r"(\s(II|III|IV|B|C)|U-?\d{2}|Under-?\d{2}|[Yy]outh|Primavera|Castilla|Atl[eè]tic\b"
    r"|[Rr]eserves?|[Aa]cademy|[Ww]omen|[Ff]emen|[Ff]rauen|[Ff]éminin|[Ff]emminile)$"
    r"|Castilla|\bU-?\d{2}\b", )

# reserve teams the regex misses + junk items wrongly tagged with a big league
BLOCKLIST = {
    "Q950835",    # Sevilla Atlético (reserve, Segunda)
    "Q48780921", "Q2137538", "Q16967366", "Q16848750", "Q130302376",  # TZ/BW/RO junk
}

_session = requests.Session()
_session.headers.update({"User-Agent": UA, "Accept": "application/sparql-results+json"})

def sparql(query, tries=5):
    for i in range(tries):
        try:
            r = _session.get(WDQS, params={"query": query}, timeout=90)
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 10))
                time.sleep(wait); continue
            r.raise_for_status()
            time.sleep(0.3)  # politeness
            return r.json()["results"]["bindings"]
        except (requests.RequestException, ValueError) as e:
            if i == tries - 1: raise
            time.sleep(5 * (i + 1))

def v(row, key, default=None):
    return row[key]["value"] if key in row else default

def qid(uri): return uri.rsplit("/", 1)[1]

def num(row, key):
    try: return int(v(row, key))
    except (TypeError, ValueError): return None  # 'unknown value' comes back as a genid URI

def year(iso):
    try: return int(iso[:5].rstrip("-")) if iso[0] != "-" else None
    except (ValueError, IndexError): return None

def load(name):
    p = DATA / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else None

def save(name, obj):
    (DATA / f"{name}.json").write_text(json.dumps(obj, ensure_ascii=False))

def batched(seq, n):
    for i in range(0, len(seq), n): yield i // n, seq[i:i + n]

def resumable(stage, items, batch_size, fetch_batch):
    """Run fetch_batch over batches of items, appending results to a .jsonl checkpoint."""
    ck = DATA / f"{stage}.jsonl"
    done = sum(1 for _ in ck.open()) if ck.exists() else 0
    batches = list(batched(items, batch_size))
    with ck.open("a") as f:
        for bi, batch in batches:
            if bi < done: continue
            rows = fetch_batch(batch)
            f.write(json.dumps(rows, ensure_ascii=False) + "\n")
            f.flush()
            if bi % 20 == 0 or bi == len(batches) - 1:
                print(f"  {stage}: batch {bi + 1}/{len(batches)}", flush=True)
    return [row for line in ck.open() for row in json.loads(line)]

# ---------------------------------------------------------------- stage: clubs
def stage_clubs():
    lgs = " ".join(f"wd:{q}" for q in LEAGUES)
    rows = sparql(f"""
      SELECT DISTINCT ?club ?clubLabel ?cc ?lg WHERE {{
        VALUES ?lg {{ {lgs} }}
        {{ ?club p:P118/ps:P118 ?lg . ?club wdt:P31 wd:Q476028 . }}
        UNION {{ ?season wdt:P3450 ?lg . ?season wdt:P1923 ?club . }}
        OPTIONAL {{ ?club wdt:P17/wdt:P297 ?cc }}
        SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul,it,es,de,fr". }}
      }}""")
    clubs = {}
    for r in rows:
        q = qid(v(r, "club"))
        c = clubs.setdefault(q, {"name": v(r, "clubLabel"), "cc": v(r, "cc"), "leagues": set()})
        c["leagues"].add(LEAGUE_ALIAS.get(qid(v(r, "lg")), qid(v(r, "lg"))))
        if not c["cc"]: c["cc"] = v(r, "cc")
    dropped = []
    for q in list(clubs):
        name = clubs[q]["name"] or q
        if EXCLUDE_CLUB.search(name) or name == q or q in BLOCKLIST:  # no-label items are junk
            dropped.append(name); del clubs[q]
    for c in clubs.values(): c["leagues"] = sorted(c["leagues"])
    save("clubs", clubs)
    print(f"clubs: kept {len(clubs)}, dropped {len(dropped)}: {sorted(dropped)}")

# --------------------------------------------------------------- stage: members
def stage_members():
    clubs = load("clubs")
    def fetch(batch):
        vals = " ".join(f"wd:{q}" for q in batch)
        rows = sparql(f"""SELECT ?club ?p WHERE {{
            VALUES ?club {{ {vals} }} ?p p:P54/ps:P54 ?club . ?p wdt:P31 wd:Q5 . }}""")
        return [[qid(v(r, "club")), qid(v(r, "p"))] for r in rows]
    pairs = resumable("members", sorted(clubs), 10, fetch)
    members = {}
    for club, p in pairs: members.setdefault(club, set()).add(p)
    members = {c: sorted(ps) for c, ps in members.items()}
    save("members", members)
    n_players = len({p for ps in members.values() for p in ps})
    print(f"members: {sum(map(len, members.values()))} postings, {n_players} distinct players")

# ---------------------------------------------------------------- stage: attrs
def stage_attrs():
    members = load("members")
    players = sorted({p for ps in members.values() for p in ps})
    def fetch(batch):
        vals = " ".join(f"wd:{q}" for q in batch)
        rows = sparql(f"""
          SELECT ?p (SAMPLE(?len) AS ?en) (SAMPLE(?lmul) AS ?mul) (MIN(?b) AS ?birth)
                 (SAMPLE(?img) AS ?image) (SAMPLE(?cc) AS ?nat) WHERE {{
            VALUES ?p {{ {vals} }}
            OPTIONAL {{ ?p rdfs:label ?len FILTER(LANG(?len)="en") }}
            OPTIONAL {{ ?p rdfs:label ?lmul FILTER(LANG(?lmul) IN ("mul","it","es","de","fr")) }}
            OPTIONAL {{ ?p wdt:P569 ?b }}
            OPTIONAL {{ ?p wdt:P18 ?img }}
            OPTIONAL {{ ?p wdt:P27/wdt:P297 ?cc }}
          }} GROUP BY ?p""")
        out = []
        for r in rows:
            img = v(r, "image")
            out.append([qid(v(r, "p")), v(r, "en") or v(r, "mul"),
                        year(v(r, "birth", "")), v(r, "nat"),
                        img.rsplit("/", 1)[1] if img else None])
        return out
    rows = resumable("attrs", players, 350, fetch)
    save("attrs", {r[0]: r[1:] for r in rows})
    print(f"attrs: {len(rows)} players")

# --------------------------------------------------------------- stage: careers
def stage_careers():
    members = load("members")
    players = sorted({p for ps in members.values() for p in ps})
    def fetch(batch):
        vals = " ".join(f"wd:{q}" for q in batch)
        rows = sparql(f"""
          SELECT ?p ?team ?start ?end ?apps ?goals WHERE {{
            VALUES ?p {{ {vals} }}
            ?p p:P54 ?st . ?st ps:P54 ?team .
            OPTIONAL {{ ?st pq:P580 ?start }} OPTIONAL {{ ?st pq:P582 ?end }}
            OPTIONAL {{ ?st pq:P1350 ?apps }} OPTIONAL {{ ?st pq:P1351 ?goals }}
          }}""")
        return [[qid(v(r, "p")), qid(v(r, "team")), year(v(r, "start", "")),
                 year(v(r, "end", "")), num(r, "apps"), num(r, "goals")] for r in rows]
    rows = resumable("careers", players, 250, fetch)
    careers = {}
    for p, team, s, e, a, g in rows:
        if s is not None and not 1850 <= s <= 2035: s = None  # junk precision-0 dates
        if e is not None and not 1850 <= e <= 2035: e = None
        cur = careers.setdefault(p, {}).setdefault(team, [None, None, None, None])
        # multiple qualifier values / duplicate rows: keep min start, max end, max apps/goals
        if s is not None: cur[0] = min(cur[0], s) if cur[0] else s
        if e is not None: cur[1] = max(cur[1], e) if cur[1] else e
        if a is not None: cur[2] = max(cur[2] or 0, a)
        if g is not None: cur[3] = max(cur[3] or 0, g)
    save("careers", careers)
    print(f"careers: {sum(map(len, careers.values()))} statements, {len(careers)} players")

# ----------------------------------------------------------------- stage: teams
def stage_teams():
    careers, clubs = load("careers"), load("clubs")
    teams = sorted({t for c in careers.values() for t in c} - set(clubs))
    def fetch(batch):
        vals = " ".join(f"wd:{q}" for q in batch)
        rows = sparql(f"""
          SELECT ?t (SAMPLE(?len) AS ?en) (SAMPLE(?lmul) AS ?mul) WHERE {{
            VALUES ?t {{ {vals} }}
            OPTIONAL {{ ?t rdfs:label ?len FILTER(LANG(?len)="en") }}
            OPTIONAL {{ ?t rdfs:label ?lmul FILTER(LANG(?lmul) IN ("mul","it","es","de","fr")) }}
          }} GROUP BY ?t""")
        return [[qid(v(r, "t")), v(r, "en") or v(r, "mul")] for r in rows]
    rows = resumable("teams", teams, 400, fetch)
    save("teams", {r[0]: r[1] for r in rows if r[1]})
    print(f"teams: {len(rows)} outside-universe teams labeled")

# ----------------------------------------------------------------- stage: build
NSHARDS = 128

# national sides (senior/under-NN/Olympic/women's, any sport) — not clubs, keep out of careers
NATIONAL = re.compile(r"\bnational\b.*\bteam\b|nationalmannschaft"
                      r"|\bolympic (football|soccer) team|\bunder-\d+.*\bteam\b", re.I)

# --- phoenix-club merging: same club re-founded under a new Wikidata item ---
STOP_TOKENS = {"fc", "afc", "cf", "cfc", "ac", "acf", "as", "ss", "ssc", "sc", "us",
               "usd", "ud", "sd", "cd", "rcd", "ca", "rc", "calcio", "club", "football",
               "futbol", "associazione", "sportiva", "societa", "spa", "ssd", "tsv",
               "vfb", "vfl", "sv", "fsv", "bsc"}
# same-city clubs that are NOT the same club — never merge
DONT_MERGE = {("FR", "bastia"), ("ES", "extremadura"), ("ES", "logrones")}
# true phoenixes whose names normalize differently
EXTRA_MERGE = {"Q56542463": "Q8643",  # LR Vicenza -> Vicenza Calcio (2018 refounding)
               "Q3626886": "Q6641"}   # Liberty Bari -> SSC Bari (merged into Bari in 1928)

def club_core(name):
    import unicodedata
    s = unicodedata.normalize("NFD", name).encode("ascii", "ignore").decode().lower()
    toks = [t for t in re.sub(r"[^a-z0-9 ]", " ", s).split()
            if t not in STOP_TOKENS and not re.fullmatch(r"(18|19|20)\d\d", t)]
    return " ".join(toks)

def merge_map(clubs, members):
    groups = {}
    for q in members:
        key = (clubs[q]["cc"], club_core(clubs[q]["name"]))
        groups.setdefault(key, []).append(q)
    m = dict(EXTRA_MERGE)
    for key, qs in groups.items():
        if len(qs) < 2 or key in DONT_MERGE: continue
        canon = max(qs, key=lambda q: len(members[q]))
        m.update({q: canon for q in qs if q != canon})
    return {old: canon for old, canon in m.items() if old in members and canon in members}

def stage_build():
    clubs, members, attrs = load("clubs"), load("members"), load("attrs")
    careers, teams = load("careers"), load("teams")

    merged = merge_map(clubs, members)
    groups = {}  # canonical qid -> all qids folded into it
    for q in members: groups.setdefault(merged.get(q, q), []).append(q)
    for old, canon in sorted(merged.items(), key=lambda x: clubs[x[1]]["name"]):
        print(f"  merge: {clubs[old]['name']} ({old}) -> {clubs[canon]['name']} ({canon})")

    # a membership counts only if the statement carries at least one qualifier
    # (start/end/apps/goals); bare P54 statements are too often wrong
    def spell(p, qs):  # aggregated career entry of player p across a club group
        s = e = a = g = None
        for q in qs:
            ent = careers.get(p, {}).get(q)
            if not ent: continue
            if ent[0] is not None: s = min(s, ent[0]) if s else ent[0]
            if ent[1] is not None: e = max(e, ent[1]) if e else ent[1]
            if ent[2] is not None: a = (a or 0) + ent[2]
            if ent[3] is not None: g = (g or 0) + ent[3]
        return s, e, a, g

    kept_members, n_dropped = {}, 0
    for canon, qs in groups.items():
        pool = {p for q in qs for p in members[q]}
        kept = {p for p in pool if any(x is not None for x in spell(p, qs))}
        n_dropped += len(pool) - len(kept)
        kept_members[canon] = kept
    print(f"  dropped {n_dropped} unqualified postings, "
          f"merged {len(merged)} duplicate club items")

    player_qids = sorted({p for ps in kept_members.values() for p in ps},
                         key=lambda q: (attrs.get(q, [None])[0] or "￿", q))
    pid = {q: i for i, q in enumerate(player_qids)}

    club_qids = sorted(kept_members, key=lambda q: clubs[q]["name"])
    lmask = {q: i for i, q in enumerate(LEAGUE_ORDER)}
    out_clubs, postings, apps_col, goals_col = [], [], [], []
    for cq in club_qids:
        c = clubs[cq]
        leagues = {l for q in groups[cq] for l in clubs[q]["leagues"]}
        mask = sum(1 << lmask[l] for l in leagues if l in lmask)
        ids = sorted(pid[p] for p in kept_members[cq])
        sp = [spell(player_qids[i], groups[cq]) for i in ids]
        deltas = [ids[0]] + [b - a for a, b in zip(ids, ids[1:])] if ids else []
        out_clubs.append([c["name"], c["cc"] or "", mask, cq])
        postings.append(deltas)
        apps_col.append([-1 if s[2] is None else s[2] for s in sp])  # -1 = unknown
        goals_col.append([-1 if s[3] is None else s[3] for s in sp])

    names, births, nats, imgs = [], [], [], []
    for q in player_qids:
        a = attrs.get(q) or [None, None, None, None]
        names.append(a[0] or q); births.append(a[1] or 0)
        nats.append(a[2] or ""); imgs.append(unquote(a[3]) if a[3] else "")  # P18 URL tail is %-encoded

    SITE_DATA.mkdir(parents=True, exist_ok=True)
    # data freshness = newest Wikidata checkpoint, not build time
    built = time.strftime("%Y-%m-%d", time.localtime(max(p.stat().st_mtime for p in DATA.glob("*.json*"))))
    index = {"built": built,
             "leagues": [list(LEAGUES[q]) for q in LEAGUE_ORDER],
             "clubs": out_clubs, "postings": postings, "apps": apps_col,
             "goals": goals_col,
             "names": names, "births": births, "nats": nats, "imgs": imgs}
    blob = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode()
    (SITE_DATA / "index.json").write_bytes(blob)

    club_name = {q: clubs[q]["name"] for q in clubs} | teams
    club_name |= {old: clubs[canon]["name"] for old, canon in merged.items()}
    shards = [{} for _ in range(NSHARDS)]
    for q, career in careers.items():
        if q not in pid: continue  # all memberships dropped as unqualified
        i = pid[q]
        entries = [[club_name.get(t, ""), c[0], c[1], c[2], c[3]] for t, c in career.items()
                   if any(x is not None for x in c)
                   and not NATIONAL.search(club_name.get(t, ""))]
        entries.sort(key=lambda e: e[1] or 9999)
        shards[i % NSHARDS][str(i)] = [int(q[1:]), entries]  # QID number -> Wikipedia via Special:GoToLinkedPage
    (SITE_DATA / "career").mkdir(exist_ok=True)
    shard_bytes = 0
    for si, sh in enumerate(shards):
        b = json.dumps(sh, ensure_ascii=False, separators=(",", ":")).encode()
        (SITE_DATA / "career" / f"{si}.json").write_bytes(b)
        shard_bytes += len(b)

    n_post = sum(map(len, postings))
    gz = len(gzip.compress(blob, 6))
    with_apps = sum(1 for col in apps_col for a in col if a >= 0)
    with_goals = sum(1 for col in goals_col for g in col if g >= 0)
    print(f"build: {len(out_clubs)} clubs, {len(names)} players, {n_post} postings")
    print(f"  index.json {len(blob)/1e6:.2f} MB raw, {gz/1e6:.2f} MB gzip")
    print(f"  career shards total {shard_bytes/1e6:.2f} MB ({NSHARDS} files)")
    print(f"  coverage: birth {sum(1 for b in births if b)/len(names):.0%}, "
          f"img {sum(1 for i in imgs if i)/len(names):.0%}, "
          f"nat {sum(1 for n in nats if n)/len(names):.0%}, "
          f"apps-per-posting {with_apps/max(n_post,1):.0%}, "
          f"goals-per-posting {with_goals/max(n_post,1):.0%}")
    print(f"  longest posting list: {max(map(len, postings))}")

STAGES = {"clubs": stage_clubs, "members": stage_members, "attrs": stage_attrs,
          "careers": stage_careers, "teams": stage_teams, "build": stage_build}

if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    todo = sys.argv[1:] or list(STAGES)
    for s in todo:
        if s != "build" and load(s) is not None and s not in sys.argv[1:]:
            print(f"{s}: checkpoint exists, skipping"); continue
        print(f"== stage {s}", flush=True)
        STAGES[s]()
