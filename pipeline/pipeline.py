#!/usr/bin/env python3
"""Istinto Puro data pipeline: Wikidata -> compact static dataset.

Stages (each checkpoints to data/, reruns skip completed stages):
  clubs    - club universe of the 10 leagues (top 5 + 2nd divisions, incl. historical items)
  members  - player QIDs per club (P54)
  attrs    - player attributes (label, birth year, nationality, image)
  careers  - full P54 career statements per player (any team, with years/apps/goals)
  wp       - Wikipedia-infobox career overlay (every player; richness-guarded replace)
  teams    - labels for career teams outside the club universe
  build    - emit site/data/index.json + career shards, print stats
  validate - sanity-check the emitted index; fail instead of shipping junk

Usage: python3 pipeline/pipeline.py [stage ...]   (default: all)

Emitted formats — site/data/index.json (one file, whole club-mode dataset):
  clubs     [name, country, leagueMask, QID, dissolvedYear, currentLeague]
            dissolvedYear: P576, 0 = active (drives the †year marker);
            currentLeague: index into leagues, -1 = outside covered ones
            (drives the browse panel)
  postings  per club: sorted player ids, delta-encoded (first id, then gaps)
  apps/goals per club: one value per posting, summed across the player's
            spells there, -1 = unknown
  gks       delta-encoded ids of P413 goalkeepers (UI hides their goals)
  names/births/nats  one entry per player id
  imgs      Commons filename prefixed with 2 hex md5 chars — the hashed
            directory path, so the client builds direct thumb URLs and
            skips Special:FilePath's uncacheable redirects
  leagues/nshards/built  league table, shard count, extraction date
            (footer stamp + shard-fetch cache-buster)

site/data/career/<pid % nshards>.json — lazy-loaded careers, per player:
  [QID number, spells]   QID links Wikipedia via Special:GoToLinkedPage
  spell = [team, start, end, apps, goals(, 1)]  one per P54 statement, so
  a loan and a later return stay separate; trailing 1 = P1642 loan flag
  (app.js also infers loans from a spell inside an earlier one's range)
"""
import hashlib, json, os, re, sys, time, gzip
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

# current league membership (2026–27), curated: Wikidata P118 lags promotions and
# relegations by months. Refresh each August; reserve teams stay out (dataset scope).
CURRENT = {
    "Q15804": [  # Serie A
        "Q1886",     # Atalanta
        "Q1893",     # Bologna
        "Q1900",     # Cagliari
        "Q1120838",  # Como
        "Q2052",     # Fiorentina
        "Q845043",   # Frosinone
        "Q2074",     # Genoa
        "Q631",      # Inter
        "Q1422",     # Juventus
        "Q2609",     # Lazio
        "Q13391",    # Lecce
        "Q1543",     # Milan
        "Q289482",   # Monza
        "Q2641",     # Napoli
        "Q2693",     # Parma
        "Q2739",     # Roma
        "Q8603",     # Sassuolo
        "Q2768",     # Torino
        "Q2798",     # Udinese
        "Q501245",   # Venezia
    ],
    "Q194052": [  # Serie B
        "Q297430",   # Arezzo
        "Q6630",     # Ascoli
        "Q298217",   # Avellino
        "Q652516",   # Benevento
        "Q650365",   # Carrarese
        "Q501372",   # Catanzaro
        "Q6664",     # Cesena
        "Q759482",   # Cremonese
        "Q6703",     # Empoli
        "Q8639",     # Hellas Verona
        "Q6748",     # Juve Stabia
        "Q430993",   # Mantova
        "Q8408",     # Modena
        "Q8428",     # Padova
        "Q2674",     # Palermo
        "Q289613",   # Pisa
        "Q1457",     # Sampdoria
        "Q1387710",  # Südtirol
        "Q8643",     # Vicenza
        "Q2276413",  # Virtus Entella
    ],
    "Q324867": [  # La Liga
        "Q223620",   # Alavés
        "Q8687",     # Athletic Club
        "Q8701",     # Atlético Madrid
        "Q7156",     # Barcelona
        "Q8749",     # Celta Vigo
        "Q8760",     # Deportivo La Coruña
        "Q10512",    # Elche
        "Q8780",     # Espanyol
        "Q8806",     # Getafe
        "Q8823",     # Levante
        "Q8857",     # Málaga
        "Q10286",    # Osasuna
        "Q12236",    # Racing Santander
        "Q10300",    # Rayo Vallecano
        "Q8723",     # Real Betis
        "Q8682",     # Real Madrid
        "Q10315",    # Real Sociedad
        "Q10329",    # Sevilla
        "Q10333",    # Valencia
        "Q12297",    # Villarreal
    ],
    "Q35615": [  # La Liga 2 (20 of 22: Celta Fortuna + Real Sociedad B are reserves)
        "Q576285",   # Albacete
        "Q10407",    # UD Almería (not Q290781, the 1971–82 AD Almería)
        "Q1386854",  # FC Andorra
        "Q852079",   # Burgos
        "Q460448",   # Cádiz
        "Q743557",   # Castellón
        "Q5773365",  # Ceuta
        "Q10499",    # Córdoba
        "Q770740",   # Eibar
        "Q600232",   # Eldense
        "Q11945",    # Girona
        "Q8812",     # Granada
        "Q11979",    # Las Palmas
        "Q856119",   # Leganés
        "Q8835",     # Mallorca
        "Q271574",   # Real Oviedo
        "Q12260",    # Sabadell
        "Q12278",    # Sporting Gijón
        "Q216661",   # Tenerife
        "Q10319",    # Valladolid
    ],
    "Q9448": [  # Premier League
        "Q9617",     # Arsenal
        "Q18711",    # Aston Villa
        "Q19568",    # Bournemouth
        "Q19571",    # Brentford
        "Q19453",    # Brighton
        "Q9616",     # Chelsea
        "Q19580",    # Coventry City
        "Q19467",    # Crystal Palace
        "Q5794",     # Everton
        "Q18708",    # Fulham
        "Q19477",    # Hull City
        "Q9653",     # Ipswich Town
        "Q1128631",  # Leeds United
        "Q1130849",  # Liverpool
        "Q50602",    # Manchester City
        "Q18656",    # Manchester United
        "Q18716",    # Newcastle United
        "Q19490",    # Nottingham Forest
        "Q18739",    # Sunderland
        "Q18741",    # Tottenham Hotspur
    ],
    "Q19510": [  # EFL Championship
        "Q19444",    # Birmingham City
        "Q19446",    # Blackburn Rovers
        "Q19451",    # Bolton Wanderers
        "Q19456",    # Bristol City
        "Q19458",    # Burnley
        "Q18662",    # Cardiff City
        "Q19462",    # Charlton Athletic
        "Q19470",    # Derby County
        "Q18519",    # Lincoln City
        "Q18661",    # Middlesbrough
        "Q19487",    # Millwall
        "Q18721",    # Norwich City
        "Q19604",    # Portsmouth
        "Q19612",    # Preston North End
        "Q18723",    # QPR
        "Q19607",    # Sheffield United
        "Q18732",    # Southampton
        "Q18736",    # Stoke City
        "Q18659",    # Swansea City
        "Q2714",     # Watford
        "Q18744",    # West Bromwich Albion
        "Q18747",    # West Ham United
        "Q19500",    # Wolves
        "Q18529",    # Wrexham
    ],
    "Q13394": [  # Ligue 1
        "Q845137",   # Angers
        "Q182876",   # Auxerre
        "Q218372",   # Brest
        "Q328658",   # Le Havre
        "Q210864",   # Le Mans
        "Q191843",   # Lens
        "Q19516",    # Lille
        "Q48911",    # Lorient
        "Q704",      # Olympique Lyonnais
        "Q132885",   # Olympique de Marseille
        "Q180305",   # Monaco
        "Q185163",   # Nice
        "Q1051013",  # Paris FC
        "Q483020",   # Paris Saint-Germain
        "Q19509",    # Rennes
        "Q126334",   # Strasbourg
        "Q19518",    # Toulouse
        "Q501693",   # Troyes
    ],
    "Q217374": [  # Ligue 2
        "Q1140695",  # Annecy
        "Q309400",   # Boulogne
        "Q870182",   # Clermont
        "Q503317",   # Dijon
        "Q1815297",  # Dunkerque
        "Q209509",   # Grenoble
        "Q459148",   # Guingamp
        "Q760736",   # Laval
        "Q221525",   # Metz
        "Q19513",    # Montpellier
        "Q19523",    # Nancy
        "Q192071",   # Nantes
        "Q288419",   # Pau
        "Q522283",   # Red Star
        "Q208228",   # Reims
        "Q292231",   # Rodez
        "Q19521",    # Saint-Étienne
        "Q19512",    # Sochaux
    ],
    "Q82595": [  # Bundesliga
        "Q15755",    # Augsburg
        "Q141971",   # Union Berlin
        "Q51976",    # Werder Bremen
        "Q41420",    # Borussia Dortmund
        "Q692691",   # Elversberg
        "Q38245",    # Eintracht Frankfurt
        "Q106394",   # Freiburg
        "Q51974",    # Hamburger SV
        "Q22707",    # Hoffenheim
        "Q104770",   # 1. FC Köln
        "Q702455",   # RB Leipzig
        "Q104761",   # Bayer Leverkusen
        "Q105254",   # Mainz 05
        "Q101959",   # Borussia Mönchengladbach
        "Q15789",    # Bayern Munich
        "Q160532",   # Paderborn
        "Q32494",    # Schalke 04
        "Q4512",     # VfB Stuttgart
    ],
    "Q152665": [  # 2. Bundesliga
        "Q102720",   # Hertha BSC
        "Q105844",   # Arminia Bielefeld
        "Q105861",   # VfL Bochum
        "Q154053",   # Eintracht Braunschweig
        "Q107818",   # Energie Cottbus
        "Q479351",   # Darmstadt 98
        "Q141931",   # Dynamo Dresden
        "Q153539",   # Greuther Fürth
        "Q33748",    # Hannover 96
        "Q162251",   # Heidenheim
        "Q8466",     # Kaiserslautern
        "Q105853",   # Karlsruher SC
        "Q157828",   # Holstein Kiel
        "Q155730",   # Magdeburg
        "Q15786",    # Nürnberg
        "Q160530",   # Osnabrück
        "Q6463",     # St. Pauli
        "Q101859",   # Wolfsburg
    ],
}

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
    if not iso: return None
    try: return int(iso[:5].rstrip("-")) if iso[0] != "-" else None
    except (ValueError, IndexError, TypeError): return None

def load(name):
    p = DATA / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else None

def save(name, obj):
    (DATA / f"{name}.json").write_text(json.dumps(obj, ensure_ascii=False))
    (DATA / f"{name}.jsonl").unlink(missing_ok=True)  # batch log superseded by the stage checkpoint

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
      SELECT DISTINCT ?club ?clubLabel ?cc ?lg ?dissolved WHERE {{
        VALUES ?lg {{ {lgs} }}
        {{ ?club p:P118/ps:P118 ?lg . ?club wdt:P31 wd:Q476028 . }}
        UNION {{ ?season wdt:P3450 ?lg . ?season wdt:P1923 ?club . }}
        OPTIONAL {{ ?club wdt:P17/wdt:P297 ?cc }}
        OPTIONAL {{ ?club wdt:P576 ?dissolved }}
        SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul,it,es,de,fr". }}
      }}""")
    clubs = {}
    for r in rows:
        q = qid(v(r, "club"))
        c = clubs.setdefault(q, {"name": v(r, "clubLabel"), "cc": v(r, "cc"), "leagues": set(), "dissolved": None})
        c["leagues"].add(LEAGUE_ALIAS.get(qid(v(r, "lg")), qid(v(r, "lg"))))
        if not c["cc"]: c["cc"] = v(r, "cc")
        d = year(v(r, "dissolved"))
        if d: c["dissolved"] = d
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
        # women (P21 female/trans woman) are out of scope: they reach men's club
        # items via women's-section P54 statements (e.g. Patrizia Panico)
        rows = sparql(f"""SELECT ?club ?p WHERE {{
            VALUES ?club {{ {vals} }} ?p p:P54/ps:P54 ?club . ?p wdt:P31 wd:Q5 .
            MINUS {{ VALUES ?fem {{ wd:Q6581072 wd:Q1052281 }} ?p wdt:P21 ?fem . }} }}""")
        return [[qid(v(r, "club")), qid(v(r, "p"))] for r in rows]
    pairs = resumable("members", sorted(clubs), 10, fetch)
    members = {}
    for club, p in pairs: members.setdefault(club, set()).add(p)
    members = {c: sorted(ps) for c, ps in members.items()}
    save("members", members)
    n_players = len({p for ps in members.values() for p in ps})
    print(f"members: {sum(map(len, members.values()))} postings, {n_players} distinct players")

# citizenship (P27) states without an ISO code (P297) whose modern country is
# unambiguous — historical/umbrella items like Eriksen's "Kingdom of Denmark".
# Genuinely ambiguous ones (USSR, Yugoslavia, Czechoslovakia, Austria-Hungary)
# stay unknown rather than guessing a successor.
NAT_FIX = {
    "Q174193": "GB",  # United Kingdom of Great Britain and Ireland (pre-1922)
    "Q21":     "GB",  # England
    "Q756617": "DK",  # Kingdom of Denmark (the realm; ISO code sits on Q35)
    "Q172579": "IT",  # Kingdom of Italy
    "Q43287":  "DE",  # German Empire
    "Q1206012": "DE", # German Reich
    "Q41304":  "DE",  # Weimar Republic
    "Q7318":   "DE",  # Nazi Germany
    "Q713750": "DE",  # West Germany
    "Q207272": "PL",  # Second Polish Republic
}

# dissolved states that DO carry a P297 code — no emoji flag exists for these, so
# they must never reach the index. DD's successor is unambiguous; the Yugoslav
# lineage is not (same policy as NAT_FIX: don't guess a successor).
ISO_OBSOLETE = {"DD": "DE", "YU": None, "SU": None, "CS": None}

def pick_nat(ccs):  # prefer a current-ISO citizenship, else an unambiguous successor
    cur = sorted(c for c in ccs if c and c not in ISO_OBSOLETE)
    if cur: return cur[0]
    return next((ISO_OBSOLETE[c] for c in ccs if ISO_OBSOLETE.get(c)), None)

# ---------------------------------------------------------------- stage: attrs
def stage_attrs():
    members = load("members")
    players = sorted({p for ps in members.values() for p in ps})
    def fetch(batch):
        vals = " ".join(f"wd:{q}" for q in batch)
        rows = sparql(f"""
          SELECT ?p (SAMPLE(?len) AS ?en) (SAMPLE(?lmul) AS ?mul) (MIN(?b) AS ?birth)
                 (SAMPLE(?img) AS ?image) (GROUP_CONCAT(DISTINCT ?cc; separator=",") AS ?ccs)
                 (SAMPLE(?ctry) AS ?natq) (SAMPLE(?gk1) AS ?gk)
                 (GROUP_CONCAT(DISTINCT ?spcc; separator=",") AS ?spccs) WHERE {{
            VALUES ?p {{ {vals} }}
            OPTIONAL {{ ?p rdfs:label ?len FILTER(LANG(?len)="en") }}
            OPTIONAL {{ ?p rdfs:label ?lmul FILTER(LANG(?lmul) IN ("mul","it","es","de","fr")) }}
            OPTIONAL {{ ?p wdt:P569 ?b }}
            OPTIONAL {{ ?p wdt:P18 ?img }}
            OPTIONAL {{ ?p wdt:P27 ?ctry . OPTIONAL {{ ?ctry wdt:P297 ?cc }} }}
            OPTIONAL {{ ?p wdt:P1532 ?sport . OPTIONAL {{ ?sport wdt:P297 ?spcc }} }}
            OPTIONAL {{ ?p wdt:P413 wd:Q201330 . BIND(1 AS ?gk1) }}
          }} GROUP BY ?p""")
        out = []
        for r in rows:
            img = v(r, "image")
            # P1532 (country represented in sport) beats citizenship when it names
            # one unambiguous country: it's the actual football nationality (e.g.
            # Balotelli GH+IT citizenship but plays for Italy; picking the
            # alphabetically-first citizenship code was giving him a Ghana flag)
            spccs = [c for c in (v(r, "spccs") or "").split(",") if c]
            nat = spccs[0] if len(spccs) == 1 else None
            if not nat:
                nat = pick_nat((v(r, "ccs") or "").split(","))
            if not nat and "natq" in r:  # citizenship without ISO code: curated map
                nat = NAT_FIX.get(qid(v(r, "natq")))
            out.append([qid(v(r, "p")), v(r, "en") or v(r, "mul"),
                        year(v(r, "birth", "")), nat,
                        img.rsplit("/", 1)[1] if img else None, num(r, "gk")])
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
          SELECT ?p ?st ?team ?start ?end ?apps ?goals ?loan WHERE {{
            VALUES ?p {{ {vals} }}
            ?p p:P54 ?st . ?st ps:P54 ?team .
            OPTIONAL {{ ?st pq:P580 ?start }} OPTIONAL {{ ?st pq:P582 ?end }}
            OPTIONAL {{ ?st pq:P1350 ?apps }} OPTIONAL {{ ?st pq:P1351 ?goals }}
            OPTIONAL {{ ?st pq:P1642 ?loan }}
          }}""")
        return [[qid(v(r, "p")), qid(v(r, "st")), qid(v(r, "team")), year(v(r, "start", "")),
                 year(v(r, "end", "")), num(r, "apps"), num(r, "goals"),
                 1 if (v(r, "loan") or "").endswith("Q2914547") else 0] for r in rows]
    rows = resumable("careers", players, 250, fetch)
    # aggregate per statement, not per team: distinct spells at the same club
    # (loan + return, re-signings) must stay separate career entries
    sts = {}
    for p, st, team, s, e, a, g, ln in rows:
        if s is not None and not 1850 <= s <= 2035: s = None  # junk precision-0 dates
        if e is not None and not 1850 <= e <= 2035: e = None
        cur = sts.setdefault(st, [p, team, None, None, None, None, 0])
        # multiple qualifier values fan one statement out over several rows:
        # keep min start, max end, max apps/goals
        if s is not None: cur[2] = min(cur[2], s) if cur[2] else s
        if e is not None: cur[3] = max(cur[3], e) if cur[3] else e
        if a is not None: cur[4] = max(cur[4] or 0, a)
        if g is not None: cur[5] = max(cur[5] or 0, g)
        if ln: cur[6] = 1
    careers = {}
    for p, *sp in sts.values():  # sp = [team, start, end, apps, goals, loan]
        careers.setdefault(p, []).append(sp)
    save("careers", careers)
    print(f"careers: {len(sts)} spells, {len(careers)} players")

# -------------------------------------------------------------------- stage: wp
# Wikipedia-infobox overlay. Wikidata careers are often incomplete in ways no field
# flags — a whole club spell missing, apps/goals absent — and "every spell is dated"
# does not mean "correct" (see Biraghi: 12 dated spells, yet no Torino and half the
# stats blank). Only comparing against Wikipedia reveals it, so stage_wp fetches the
# enwiki {{Infobox football biography}} for EVERY player and lays the parsed result
# over careers. The overlay REPLACES a candidate's whole spell list (re-resolving each
# club to a QID keeps identifier precision) rather than merging row-by-row, avoiding
# duplicate/conflict handling; a richness guard in stage_wp only replaces when the
# infobox is at least as complete as Wikidata (spell count AND populated stats), so a
# correct career is never degraded. Everything downstream reads load_careers().
WP_API = "https://en.wikipedia.org/w/api.php"

def load_careers():
    """Wikidata careers with the Wikipedia-infobox overlay laid on top. The overlay
    holds a parsed career only where it beats Wikidata (the stage_wp richness guard),
    so .update replaces those players wholesale and leaves the rest on raw Wikidata."""
    careers = load("careers")
    careers.update(load("wp") or {})   # same {pid: [[team,s,e,apps,goals,loan],...]} shape
    return careers

def wp_get(**params):
    params.setdefault("format", "json"); params.setdefault("formatversion", 2)
    for i in range(5):
        try:
            r = _session.get(WP_API, params=params, timeout=90)
            if r.status_code == 429:
                time.sleep(int(r.headers.get("Retry-After", 10))); continue
            r.raise_for_status(); time.sleep(0.2)
            return r.json()
        except (requests.RequestException, ValueError):
            if i == 4: raise
            time.sleep(5 * (i + 1))

# senior career only. Not line-anchored: many infoboxes pack several params on
# one line (| years1 = … | clubs1 = … | caps1 = …), so match each "|field=" where
# it sits and read the value up to the next pipe or newline. The (\d+)= shape keeps
# youth*/manager*/national*/total* out (their keyword never follows a pipe directly),
# and stopping at "|" harmlessly clips a wikilink at its display pipe — wp_club wants
# only the target before it.
FIELD = re.compile(r"\|\s*(years|clubs|caps|goals)(\d+)\s*=\s*([^|\n]*)")

def wp_years(s):
    m = re.search(r"(\d{4})(?:\s*[–\-]\s*(\d{4}))?", s)
    if not m: return None, None
    return int(m.group(1)), (int(m.group(2)) if m.group(2) else None)  # open-ended -> None

def wp_club(s):
    loan = 1 if ("→" in s or "(loan)" in s.lower()) else 0   # infobox loan convention
    m = re.search(r"\[\[([^\]|#]+)", s)                      # wikilink target = enwiki page title
    return (m.group(1).strip() if m else None), loan

def wp_int(s):
    s = re.sub(r"\{\{[^}]*\}\}", "", s).split("<")[0]   # drop {{0}} alignment padding & <ref>…
    m = re.search(r"\d+", s)
    return int(m.group()) if m else None

def parse_infobox(wikitext):
    """-> [[clubTitle, start, end, apps, goals, loan], ...]  (club still a page TITLE)."""
    f = {}
    for kind, idx, val in FIELD.findall(wikitext):
        f[(kind, int(idx))] = val
    spells = []
    for _, idx in sorted(k for k in f if k[0] == "clubs"):
        title, loan = wp_club(f[("clubs", idx)])
        if not title: continue
        s, e = wp_years(f.get(("years", idx), ""))
        spells.append([title, s, e, wp_int(f.get(("caps", idx), "")),
                       wp_int(f.get(("goals", idx), "")), loan])
    return spells

def bare(sp): return all(x is None for x in sp[1:5])   # P54 with no date/apps/goals = a gap

def wd_metrics(spells):
    """(qualified spell count, populated apps/goals field count) for a Wikidata career —
    the two axes the replace guard protects."""
    nq = sum(1 for sp in spells if not bare(sp))
    ns = sum((sp[3] is not None) + (sp[4] is not None) for sp in spells)
    return nq, ns

def stage_wp():
    careers, members = load("careers"), load("members")
    players = {p for ps in members.values() for p in ps}
    # trigger = every player. A Wikidata career that "looks complete" (all spells
    # dated) is an unreliable signal: it can still miss a whole club and its stats
    # (e.g. Biraghi's Torino), which no bare-P54 marker flags. The richness guard
    # below keeps a genuinely-complete career untouched, so fetching is the only cost.
    cand = sorted(p for p in players if careers.get(p))
    wd = {p: wd_metrics(careers[p]) for p in cand}   # pid -> (qualified spells, stat fields)
    limit = int(os.environ.get("WP_LIMIT", 0))   # dry-run slice; 0 = all
    if limit: cand = cand[:limit]
    print(f"wp: {len(cand)} candidates (all players)", flush=True)

    # phase 1 — QID -> enwiki page title, straight off WDQS (no new API surface)
    title = {}
    for _, batch in batched(cand, 200):
        vals = " ".join(f"wd:{q}" for q in batch)
        for r in sparql(f"""SELECT ?p ?t WHERE {{ VALUES ?p {{ {vals} }}
            ?a schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?t . }}"""):
            title[qid(v(r, "p"))] = v(r, "t")
    have = [[p, title[p]] for p in cand if p in title]   # no enwiki page -> no infobox to mine
    print(f"wp: {len(have)} have an enwiki page", flush=True)

    # phase 2 — fetch wikitext (50 titles/req) & parse; checkpointed, club still a TITLE
    # rvsection=0 = lead section only, where the infobox always sits: a quarter of the
    # bytes of the full articles (much less on long ones) for byte-identical parses, and
    # it does work with 50 titles per request despite what the API docs imply.
    def fetch(batch):
        by_title = {t: p for p, t in batch}
        data = wp_get(action="query", prop="revisions", rvprop="content",
                      rvslots="main", rvsection=0, titles="|".join(t for _, t in batch))
        out = []
        for pg in (data or {}).get("query", {}).get("pages", []):
            revs = pg.get("revisions")
            if not revs or pg["title"] not in by_title: continue
            spells = parse_infobox(revs[0]["slots"]["main"]["content"])
            if spells: out.append([by_title[pg["title"]], spells])
        return out
    raw = resumable("wp", have, 50, fetch)   # -> [[pid, [[clubTitle,...], ...]], ...]

    # phase 3 — resolve the distinct club TITLES -> QIDs (50/req, redirects folded), cached.
    # Skip interwiki wikilinks (":de:…" etc.): MediaWiki returns them under query.interwiki
    # with no page, and an all-interwiki batch omits query.pages entirely — .get() guards
    # that anyway, but there's nothing to resolve, so they stay unresolved (=None).
    titles = sorted({sp[0] for _, spells in raw for sp in spells if not sp[0].startswith(":")})
    t2q = load("wp_titles") or {}
    todo = [t for t in titles if t not in t2q]
    for _, batch in batched(todo, 50):
        data = wp_get(action="query", prop="pageprops", ppprop="wikibase_item",
                      redirects=1, titles="|".join(batch))
        q = (data or {}).get("query", {})
        # a title is keyed in the response by its NORMALISED form ("Bury__F.C." ->
        # "Bury F.C."), and normalisation happens before redirects are followed, so
        # both hops have to be walked in that order or the lookup silently misses
        norm = {n["from"]: n["to"] for n in q.get("normalized", [])}
        redir = {r["from"]: r["to"] for r in q.get("redirects", [])}
        page_q = {pg["title"]: pg.get("pageprops", {}).get("wikibase_item")
                  for pg in q.get("pages", [])}
        for t in batch:
            t2q[t] = page_q.get(redir.get(norm.get(t, t), norm.get(t, t)))  # None if unresolved
    save("wp_titles", t2q)

    # emit in the exact careers shape, dropping spells whose club title wouldn't
    # resolve. Richness guard: replace only if the infobox is at least as complete as
    # Wikidata on BOTH axes — spell count and populated apps/goals — so a wholesale
    # replace can never drop a club or a stat Wikidata already had. Trivially passes
    # for thin players (Wikidata metrics 0); protects genuinely-complete careers now
    # that the trigger is every player.
    wp, guarded = {}, 0
    for pid_, spells in raw:
        rows = [[t2q[t], s, e, a, g, ln] for t, s, e, a, g, ln in spells if t2q.get(t)]
        if not rows: continue
        nq, ns = wd.get(pid_, (0, 0))
        wp_stat = sum((r[3] is not None) + (r[4] is not None) for r in rows)
        if len(rows) >= nq and wp_stat >= ns: wp[pid_] = rows
        else: guarded += 1
    save("wp", wp)
    n_sp = sum(map(len, wp.values()))
    unresolved = sum(1 for t in titles if not t2q.get(t))
    print(f"wp: enriched {len(wp)} players, {n_sp} spells; guard kept Wikidata for "
          f"{guarded}; {unresolved}/{len(titles)} club titles unresolved")

# ----------------------------------------------------------------- stage: teams
def stage_teams():
    careers, clubs = load_careers(), load("clubs")
    teams = sorted({sp[0] for c in careers.values() for sp in c} - set(clubs))
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
# successors (Wikidata P576→P1366) whose lineage continues as a club we carry
EXTRA_MERGE = {"Q56542463": "Q8643",   # LR Vicenza -> Vicenza Calcio (2018 refounding)
               "Q3626886": "Q6641",    # Liberty Bari -> SSC Bari (merged into Bari in 1928)
               "Q2338486": "Q19516",   # Olympique Lillois -> Lille OSC (1944 merger)
               "Q2277043": "Q210864",  # US du Mans -> Le Mans FC
               "Q97905919": "Q15789",  # "FC Bayern München" dupe item -> FC Bayern Munich
               "Q51243017": "Q704"}    # Lyon Olympique Universitaire -> OL (1950 split)

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

def img_key(tail):
    """P18 URL tail (%-encoded) -> "hh" + underscored filename. The 2-char md5
    prefix is the Commons hashed-directory path, so the client can build the
    direct upload.wikimedia.org thumb URL instead of going through the two
    uncacheable Special:FilePath redirects."""
    f = unquote(tail).replace(" ", "_")
    return hashlib.md5(f.encode()).hexdigest()[:2] + f

def stage_build():
    clubs, members, attrs = load("clubs"), load("members"), load("attrs")
    careers, teams = load_careers(), load("teams")

    merged = merge_map(clubs, members)
    groups = {}  # canonical qid -> all qids folded into it
    for q in members: groups.setdefault(merged.get(q, q), []).append(q)
    for old, canon in sorted(merged.items(), key=lambda x: clubs[x[1]]["name"]):
        print(f"  merge: {clubs[old]['name']} ({old}) -> {clubs[canon]['name']} ({canon})")

    # a membership counts only if the statement carries at least one qualifier
    # (start/end/apps/goals); bare P54 statements are too often wrong
    def spell(p, qs):  # aggregated career entry of player p across a club group
        s = e = a = g = None
        qs = set(qs)
        for team, s2, e2, a2, g2, _ in careers.get(p, ()):
            if team not in qs: continue
            if s2 is not None: s = min(s, s2) if s else s2
            if e2 is not None: e = max(e, e2) if e else e2
            if a2 is not None: a = (a or 0) + a2  # sums across spells and group members
            if g2 is not None: g = (g or 0) + g2
        return s, e, a, g

    # membership must include overlay spells: a player belongs to a club if
    # load_careers() places a spell there, not only if Wikidata P54 (members) listed
    # them — else a Wikipedia-added club (e.g. Asllani's Torino) gets no posting and
    # the player is missing from that club's intersections.
    at_club = {}
    for p, spells in careers.items():
        for sp in spells: at_club.setdefault(sp[0], set()).add(p)

    kept_members, n_dropped = {}, 0
    for canon, qs in groups.items():
        pool = {p for q in qs for p in members.get(q, ())} | {p for q in qs for p in at_club.get(q, ())}
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
    cur_of = {merged.get(q, q): lmask[lq] for lq, qs in CURRENT.items() for q in qs}
    stray = sorted(q for q in cur_of if q not in kept_members)
    if stray: print(f"  WARNING: CURRENT clubs not in universe: {stray}")
    out_clubs, postings, apps_col, goals_col = [], [], [], []
    for cq in club_qids:
        c = clubs[cq]
        leagues = {l for q in groups[cq] for l in clubs[q]["leagues"]}
        mask = sum(1 << lmask[l] for l in leagues if l in lmask)
        ids = sorted(pid[p] for p in kept_members[cq])
        sp = [spell(player_qids[i], groups[cq]) for i in ids]
        deltas = [ids[0]] + [b - a for a, b in zip(ids, ids[1:])] if ids else []
        # a merged group is "dissolved" only if the whole lineage ended (no refounded/active member)
        diss = [clubs[q].get("dissolved") for q in groups[cq]]
        dissolved = max(diss) if diss and all(diss) else 0
        cur = cur_of.get(cq, -1)
        if cur >= 0: dissolved = 0  # playing a covered league now = alive (stale P576 on refounded lineages)
        out_clubs.append([c["name"], c["cc"] or "", mask, cq, dissolved, cur])
        postings.append(deltas)
        apps_col.append([-1 if s[2] is None else s[2] for s in sp])  # -1 = unknown
        goals_col.append([-1 if s[3] is None else s[3] for s in sp])

    names, births, nats, imgs, gk_pids = [], [], [], [], []
    for i, q in enumerate(player_qids):
        a = attrs.get(q) or [None] * 5
        names.append(a[0] or q); births.append(a[1] or 0)
        nats.append(a[2] or ""); imgs.append(img_key(a[3]) if a[3] else "")
        if len(a) > 4 and a[4]: gk_pids.append(i)  # P413 goalkeeper: their goal counts are unreliable

    SITE_DATA.mkdir(parents=True, exist_ok=True)
    # data freshness = newest Wikidata checkpoint, not build time
    built = time.strftime("%Y-%m-%d", time.localtime(max(p.stat().st_mtime for p in DATA.glob("*.json*"))))
    gks = [gk_pids[0]] + [b - a for a, b in zip(gk_pids, gk_pids[1:])] if gk_pids else []
    index = {"built": built, "nshards": NSHARDS,  # app.js reads the shard count from here
             "leagues": [list(LEAGUES[q]) for q in LEAGUE_ORDER],
             "clubs": out_clubs, "postings": postings, "apps": apps_col,
             "goals": goals_col, "gks": gks,
             "names": names, "births": births, "nats": nats, "imgs": imgs}
    blob = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode()
    (SITE_DATA / "index.json").write_bytes(blob)

    club_name = {q: clubs[q]["name"] for q in clubs} | teams
    club_name |= {old: clubs[canon]["name"] for old, canon in merged.items()}
    shards = [{} for _ in range(NSHARDS)]
    for q, career in careers.items():
        if q not in pid: continue  # all memberships dropped as unqualified
        i = pid[q]
        entries = [[club_name.get(t, ""), s, e, a, g] + ([1] if ln else [])
                   for t, s, e, a, g, ln in career
                   if any(x is not None for x in (s, e, a, g))
                   and not NATIONAL.search(club_name.get(t, ""))]
        entries.sort(key=lambda x: (x[1] or 9999, x[2] or 9999))
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
    cur_counts = [sum(1 for c in out_clubs if c[5] == i) for i in range(len(LEAGUE_ORDER))]
    print("  current teams: " + ", ".join(
        f"{LEAGUES[q][0]} {n}" for q, n in zip(LEAGUE_ORDER, cur_counts)))
    print(f"build: {len(out_clubs)} clubs, {len(names)} players, {n_post} postings")
    print(f"  index.json {len(blob)/1e6:.2f} MB raw, {gz/1e6:.2f} MB gzip")
    print(f"  career shards total {shard_bytes/1e6:.2f} MB ({NSHARDS} files)")
    print(f"  goalkeepers: {len(gk_pids)} ({len(gk_pids)/len(names):.0%})")
    print(f"  coverage: birth {sum(1 for b in births if b)/len(names):.0%}, "
          f"img {sum(1 for i in imgs if i)/len(names):.0%}, "
          f"nat {sum(1 for n in nats if n)/len(names):.0%}, "
          f"apps-per-posting {with_apps/max(n_post,1):.0%}, "
          f"goals-per-posting {with_goals/max(n_post,1):.0%}")
    print(f"  longest posting list: {max(map(len, postings))}")
    cov = sorted((sum(1 for a in col if a >= 0) / len(col), len(col), out_clubs[i][0])
                 for i, col in enumerate(apps_col) if len(col) >= 30)
    print("  thinnest apps coverage (roster >= 30):")
    for c, n, name in cov[:12]:
        print(f"    {c:4.0%} of {n:4d}  {name}")

# -------------------------------------------------------------- stage: validate
# Half the careers in the index come from the stage_wp overlay, and nothing about a
# broken overlay changes a club or player count: if enwiki renames an infobox param or
# FIELD stops matching, load_careers() falls back to raw Wikidata everywhere, the shrink
# guards below stay green, and a much worse dataset ships looking healthy. Measured cost
# of that failure is ~12 points of apps coverage, so a 2-point tolerance catches it with
# room to spare. FLOOR is the backstop the baseline check can't be: it stops a slow slide
# from ratcheting into the new normal one accepted refresh at a time.
APPS_FLOOR = 0.85

def apps_coverage(idx):
    tot = sum(len(c) for c in idx["apps"])
    return sum(1 for c in idx["apps"] for a in c if a >= 0) / tot if tot else 0

def stage_validate():
    """Exit non-zero rather than ship a malformed index. VALIDATE_BASELINE=
    <previous index.json> additionally guards against a silently degraded
    extraction (>3% fewer clubs or players, or thinner apps coverage), as the
    weekly refresh does."""
    idx = json.loads((SITE_DATA / "index.json").read_bytes())
    errs = []
    def chk(ok, msg):
        if not ok: errs.append(msg)
    nc, np = len(idx["clubs"]), len(idx["names"])
    chk(nc > 0 and np > 0, "empty index")
    for k in ("postings", "apps", "goals"):
        chk(len(idx[k]) == nc, f"{k}: {len(idx[k])} columns != {nc} clubs")
    for k in ("births", "nats", "imgs"):
        chk(len(idx[k]) == np, f"{k}: {len(idx[k])} rows != {np} players")
    chk(len({c[3] for c in idx["clubs"]}) == nc, "duplicate club QIDs")
    chk(all(not i or re.fullmatch(r"[0-9a-f]{2}\S+", i) for i in idx["imgs"]),
        "imgs: entry without md5 prefix or with spaces")
    nl = len(idx["leagues"])
    chk(all(len(c) == 6 and -1 <= c[5] < nl for c in idx["clubs"]), "bad current-league field")
    for i in range(nl):  # every league must keep a plausible current lineup
        n = sum(1 for c in idx["clubs"] if c[5] == i)
        chk(17 <= n <= 24, f"league {idx['leagues'][i][0]}: {n} current clubs")
    for c, (d, a, g) in enumerate(zip(idx["postings"], idx["apps"], idx["goals"])):
        chk(len(d) == len(a) == len(g), f"club {c}: postings/apps/goals length mismatch")
        chk(not d or (d[0] >= 0 and all(x > 0 for x in d[1:]) and sum(d) < np),
            f"club {c}: bad posting deltas")
        chk(all(x >= -1 for x in a + g), f"club {c}: apps/goals below -1")
    gk = idx.get("gks")
    chk(isinstance(gk, list) and (not gk or (gk[0] >= 0 and all(x > 0 for x in gk[1:])
        and sum(gk) < np)), "bad gks list")
    missing = [i for i in range(NSHARDS) if not (SITE_DATA / "career" / f"{i}.json").exists()]
    chk(not missing, f"missing career shards: {missing[:5]}")
    cov = apps_coverage(idx)
    chk(cov >= APPS_FLOOR, f"apps coverage {cov:.1%} below floor {APPS_FLOOR:.0%}")
    base = os.environ.get("VALIDATE_BASELINE")
    if base:
        old = json.loads(Path(base).read_bytes())
        oc, op, ov = len(old["clubs"]), len(old["names"]), apps_coverage(old)
        chk(nc >= 0.97 * oc, f"clubs shrank {oc} -> {nc}")
        chk(np >= 0.97 * op, f"players shrank {op} -> {np}")
        chk(cov >= ov - 0.02, f"apps coverage shrank {ov:.1%} -> {cov:.1%}")
        print(f"  vs baseline: clubs {oc} -> {nc}, players {op} -> {np}, "
              f"apps {ov:.1%} -> {cov:.1%}")
    if errs:
        sys.exit("validate FAILED:\n  " + "\n  ".join(errs[:20]))
    print(f"validate: OK ({nc} clubs, {np} players)")

STAGES = {"clubs": stage_clubs, "members": stage_members, "attrs": stage_attrs,
          "careers": stage_careers, "wp": stage_wp, "teams": stage_teams,
          "build": stage_build, "validate": stage_validate}

if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    todo = sys.argv[1:] or list(STAGES)
    for s in todo:
        if s != "build" and load(s) is not None and s not in sys.argv[1:]:
            print(f"{s}: checkpoint exists, skipping"); continue
        print(f"== stage {s}", flush=True)
        STAGES[s]()
