#!/usr/bin/env python3
"""Istinto Puro data pipeline: Wikidata -> compact static dataset.

Stages (each checkpoints to data/, reruns skip completed stages):
  clubs    - core + optional-pack club universe (incl. historical items)
  members  - player QIDs per club (P54)
  roster   - current-squad seeds from enwiki squad tables (players Wikidata has no P54 for)
  attrs    - player attributes (label, birth year, nationality, image, enwiki title)
  careers  - full P54 career statements per player (any team, with years/apps/goals)
  wp       - Wikipedia-infobox career overlay (every player; authoritative when complete)
  teams    - labels for career teams outside the club universe
  build    - emit site/data/index.json + career shards, print stats
  validate - sanity-check the emitted index; fail instead of shipping junk
  quiz     - preserve published quizzes and generate/validate the next 14 days

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
  names/births/nats  one entry per player id; a nat is comma-separated when a
            player represented more than one country ("CH,HR"), "" when unknown;
            a name is the common one (enwiki title) when the label is a legal
            name the game would never use — see common_name()
  imgs      Commons filename prefixed with 2 hex md5 chars — the hashed
            directory path, so the client builds direct thumb URLs and
            skips Special:FilePath's uncacheable redirects
  leagues/nshards/built  league table, shard count, extraction date
            (footer stamp + shard-fetch cache-buster)

site/data/years/<club index>.json — lazy-loaded spell years, one entry per
  posting IN THE SAME ORDER (so it carries no ids of its own):
  [start, end, start, end, ...] offset from YEAR0, one pair per dated spell at
  that club, [] when none is dated. Spells stay separate here (unlike the
  aggregated apps/goals above) because a player who left and came back was not
  at the club in between. Answers "who was there at the same time", which the
  career shards can only answer by fetching all of them — they are keyed by
  player, and the question is asked about a club.

site/data/career/<pid % nshards>.json — lazy-loaded core careers, per player:
  [QID number, spells]   QID links Wikipedia via Special:GoToLinkedPage
  spell = [team, start, end, apps, goals(, 1)]  one per STAY, not per P54
  statement: fold_spells() joins the statements that split one continuous
  spell (a loan then bought, a re-signing), while a later return after a
  move elsewhere stays separate; trailing 1 = P1642 loan flag
  (app.js also infers loans from a spell inside an earlier one's range)

site/data/packs/<id>/index.json — optional country pack. It has the same club,
  postings and stats columns, plus player rows keyed by Wikidata QID. A row carries
  its immutable core player id when one exists, so the browser can append the pack
  without duplicating people. Pack career shards are keyed by QID and pack years
  files by club QID, keeping both routes stable when the core dataset changes.
"""
import hashlib, json, os, re, subprocess, sys, time, gzip
from pathlib import Path
from urllib.parse import unquote
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATE = DATA / "state"
SITE_DATA = ROOT / "site" / "data"
UA = "istintopuro-pipeline/0.1 (mcosta97@proton.me)"
WDQS = "https://query.wikidata.org/sparql"
CACHE_VERSION = 1

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
CORE_LEAGUE_ORDER = ["Q15804", "Q194052", "Q324867", "Q35615", "Q9448", "Q19510",
                     "Q13394", "Q217374", "Q82595", "Q152665"]
LEAGUE_ORDER = CORE_LEAGUE_ORDER.copy()

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

# Optional country packs. Extraction runs over the union so shared players are
# fetched once; stage_build keeps the original ten leagues in index.json and emits
# each pack separately. Reserve teams are deliberately absent from CURRENT and are
# already removed from the historical universe by EXCLUDE_CLUB below.
PACKS = {
    "pt": {
        "cc": "PT",
        "leagues": {
            "Q182994": ("Liga Portugal", 1, "PT"),
            "Q754488": ("Liga Portugal 2", 2, "PT"),
        },
        "current": {
            "Q182994": [
                "Q2410944",  # Académico de Viseu
                "Q1386850",  # Alverca
                "Q1386869",  # Arouca
                "Q131499",   # Benfica
                "Q75684",    # Braga
                "Q1046440",  # Casa Pia
                "Q634829",   # Estoril Praia
                "Q838134",   # Estrela da Amadora
                "Q1387105",  # Famalicão
                "Q926438",   # Gil Vicente
                "Q216503",   # Marítimo
                "Q1346314",  # Moreirense
                "Q216459",   # Nacional
                "Q128446",   # Porto
                "Q622432",   # Rio Ave
                "Q740637",   # Santa Clara
                "Q75729",    # Sporting CP
                "Q223450",   # Vitória de Guimarães
            ],
            "Q754488": [
                "Q120775987", # AVS
                "Q243235",    # Académica
                "Q2841205",   # Amarante
                "Q671042",    # Feirense
                "Q17505449",  # Felgueiras 1932
                "Q1387471",   # Penafiel
                "Q1387855",   # Vizela
                "Q543467",    # Chaves
                "Q623730",    # Leixões
                "Q6705180",   # Lusitânia de Lourosa
                "Q621120",    # Portimonense
                "Q1853273",   # Torreense
                "Q744353",    # Farense
                "Q1023227",   # Tondela
                "Q211401",    # União de Leiria
            ],
        },
        "expected_current": [18, 15],
    },
}

for _pack in PACKS.values():
    LEAGUES.update(_pack["leagues"])
    LEAGUE_ORDER.extend(_pack["leagues"])
    CURRENT.update(_pack["current"])

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

def load_state(name):
    """Return (source revisions, parsed records) from a compatible validated run."""
    if os.environ.get("FULL_REFRESH") == "1": return {}, {}
    p = STATE / f"{name}.json"
    if not p.exists(): return {}, {}
    try: obj = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError): return {}, {}
    if not isinstance(obj, dict) or obj.get("version") != CACHE_VERSION: return {}, {}
    return obj.get("source", {}), obj.get("records", {})

def save_state(name, source, records):
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / f"{name}.json").write_text(json.dumps({
        "version": CACHE_VERSION, "source": source, "records": records,
    }, ensure_ascii=False))

def stale_records(current, old_source, old_records):
    """Keys whose source is new/changed/unknown or whose parsed record is absent."""
    return [k for k, token in current.items()
            if not token or old_source.get(k) != token or k not in old_records]

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
    with ck.open() as f:
        return [row for line in f for row in json.loads(line)]

def current_wd_versions(players):
    """Wikidata entity modification timestamps, shared by attrs and careers."""
    cached = load("wd_versions")
    if cached is not None and set(cached) == set(players): return cached
    def fetch(batch):
        vals = " ".join(f"wd:{q}" for q in batch)
        rows = sparql(f"""SELECT ?p ?modified WHERE {{ VALUES ?p {{ {vals} }}
            ?p schema:dateModified ?modified . }}""")
        return [[qid(v(r, "p")), v(r, "modified")] for r in rows]
    # QIDs are steadily getting longer; 500 VALUES now pushes WDQS's GET URL past
    # its proxy header limit (HTTP 431) on the full core + pack union. At 250 the
    # request stays comfortably below that ceiling while retaining useful batching.
    rows = resumable("wd_versions", players, 250, fetch)
    versions = {p: None for p in players}
    versions.update(rows)
    save("wd_versions", versions)
    print(f"  wikidata revisions: {sum(bool(x) for x in versions.values())}/{len(players)}", flush=True)
    return versions

# ---------------------------------------------------------------- stage: clubs
def stage_clubs():
    lgs = " ".join(f"wd:{q}" for q in LEAGUES)
    rows = sparql(f"""
      SELECT DISTINCT ?club ?clubLabel ?cc ?lg ?dissolved ?teamDissolved WHERE {{
        VALUES ?lg {{ {lgs} }}
        {{ ?club p:P118/ps:P118 ?lg . ?club wdt:P31 wd:Q476028 . }}
        UNION {{ ?season wdt:P3450 ?lg . ?season wdt:P1923 ?club . }}
        OPTIONAL {{ ?club wdt:P17/wdt:P297 ?cc }}
        OPTIONAL {{ ?club wdt:P576 ?dissolved }}
        OPTIONAL {{ VALUES ?teamClass {{ wd:Q103229495 wd:Q15944511 }}
                    ?club wdt:P31 ?teamClass ; wdt:P361/wdt:P576 ?teamDissolved }}
        SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul,it,es,de,fr". }}
      }}""")
    clubs = {}
    for r in rows:
        q = qid(v(r, "club"))
        c = clubs.setdefault(q, {"name": v(r, "clubLabel"), "cc": v(r, "cc"), "leagues": set(),
                                 "dissolved": None, "pdissolved": None})
        c["leagues"].add(LEAGUE_ALIAS.get(qid(v(r, "lg")), qid(v(r, "lg"))))
        if not c["cc"]: c["cc"] = v(r, "cc")
        d = year(v(r, "dissolved"))
        if d: c["dissolved"] = d
        # "…men's team" items (P31 Q103229495/Q15944511) hold the P54 statements but
        # none of the club's own metadata: take the parent club's P576 (Blau-Weiß 90)
        p = year(v(r, "teamDissolved"))
        if p: c["pdissolved"] = p
    current_league = {club: league for league, current in CURRENT.items() for club in current}
    missing_current = sorted(set(current_league) - set(clubs))
    for _, batch in batched(missing_current, 100):
        vals = " ".join(f"wd:{q}" for q in batch)
        for r in sparql(f"""SELECT ?club ?clubLabel ?cc ?dissolved ?teamDissolved WHERE {{
          VALUES ?club {{ {vals} }}
          OPTIONAL {{ ?club wdt:P17/wdt:P297 ?cc }}
          OPTIONAL {{ ?club wdt:P576 ?dissolved }}
          OPTIONAL {{ VALUES ?teamClass {{ wd:Q103229495 wd:Q15944511 }}
                      ?club wdt:P31 ?teamClass ; wdt:P361/wdt:P576 ?teamDissolved }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul,it,es,de,fr". }}
        }}"""):
            q = qid(v(r, "club"))
            clubs[q] = {"name": v(r, "clubLabel"), "cc": v(r, "cc"),
                        "leagues": {current_league[q]}, "dissolved": year(v(r, "dissolved")),
                        "pdissolved": year(v(r, "teamDissolved"))}
    for c in clubs.values():
        p = c.pop("pdissolved")
        c["dissolved"] = c["dissolved"] or p
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

# ---------------------------------------------------------------- stage: roster
# Player DISCOVERY is P54-only, and recent Wikidata items increasingly carry no P54
# at all: Ange-Yoan Bonny (Q101067809) has 26 claims and not one club statement, so
# no stage ever sees him even though enwiki holds his full career. The infobox
# overlay would fix him outright — it just never gets asked, because its candidate
# set comes from members. So seed members from the one source that lists a club's
# players without going through P54: the squad table on the club's own enwiki
# article. Scope is the CURRENT clubs only, which is where the gap actually bites
# (recent signings) and keeps the seed set to squads people search for.
# A seed earns its posting the ordinary way — stage_build keeps it only if
# load_careers() ends up placing a qualified spell at that club — so a wrong or
# non-human wikilink costs one wasted fetch and then drops out on its own.
SQUAD = re.compile(r"\{\{\s*(?:fs|football squad) player\b[^}]*?\|\s*name\s*=\s*\[\[([^\]|#]+)", re.I)

def stage_roster():
    clubs = load("clubs")
    cur = [q for qs in CURRENT.values() for q in qs if q in clubs]

    # club QID -> enwiki article title (same WDQS route stage_wp uses for players)
    title = {}
    for _, batch in batched(cur, 100):
        vals = " ".join(f"wd:{q}" for q in batch)
        for r in sparql(f"""SELECT ?c ?t WHERE {{ VALUES ?c {{ {vals} }}
            ?a schema:about ?c ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?t . }}"""):
            title[qid(v(r, "c"))] = v(r, "t")
    have = [[c, title[c]] for c in cur if c in title]
    print(f"roster: {len(have)}/{len(cur)} current clubs have an enwiki article", flush=True)

    # squad tables sit mid-article, so this needs the full wikitext (no rvsection=0).
    # Unlinked squad names are players with no enwiki article, hence no infobox and
    # nothing to recover — dropping them costs nothing.
    def fetch(batch):
        by = {t: c for c, t in batch}
        data = wp_get(action="query", prop="revisions", rvprop="content",
                      rvslots="main", redirects=1, titles="|".join(t for _, t in batch))
        q = (data or {}).get("query", {})
        norm = {n["from"]: n["to"] for n in q.get("normalized", [])}
        redir = {r["from"]: r["to"] for r in q.get("redirects", [])}
        fwd = {redir.get(norm.get(t, t), norm.get(t, t)): c for t, c in by.items()}
        out = []
        for pg in q.get("pages", []):
            revs = pg.get("revisions")
            if not revs or pg["title"] not in fwd: continue
            names = sorted({m.strip() for m in SQUAD.findall(revs[0]["slots"]["main"]["content"])})
            if names: out.append([fwd[pg["title"]], names])
        return out
    raw = resumable("roster", have, 50, fetch)   # -> [[clubQID, [playerTitle, ...]], ...]

    linked = {t for _, names in raw for t in names}
    t2q = titles_to_qids(linked, "roster_titles")   # cache outlives a squad, so count over `linked`
    roster, seeded = {}, set()
    for cq, names in raw:
        ps = {t2q[t] for t in names if t2q.get(t)}
        if ps:
            roster[cq] = sorted(ps)
            seeded |= ps
    save("roster", roster)
    unresolved = sum(1 for t in linked if not t2q.get(t))   # redlinks: no article, nothing to mine
    print(f"roster: {sum(map(len, roster.values()))} squad postings over {len(roster)} clubs, "
          f"{len(seeded)} distinct players; {unresolved} of {len(linked)} titles unresolved")

def load_members():
    """P54 memberships with the enwiki squad-table seeds laid on top. Kept separate
    from members.json on disk so that checkpoint stays pure Wikidata."""
    members = load("members")
    for cq, ps in (load("roster") or {}).items():
        members[cq] = sorted(set(members.get(cq, ())) | set(ps))
    return members

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

# P297 codes outside current ISO 3166-1, so Unicode has no regional-indicator flag
# for them. These used to be dropped (or mapped to a successor) because they rendered
# as letter boxes; site/flags/<cc>.svg now covers them, so they stay as themselves —
# a GDR international is shown under the GDR, not backdated into modern Germany.
# Exhaustive: a survey of every P297-carrying item found only 10 non-ISO codes, and
# the other 6 (Ascension, Clipperton, Sark, Diego Garcia, Trust Territory of the
# Pacific Islands, Tristan da Cunha) have no football nationals. stage_validate
# fails the build if a code ever appears that neither this set nor an emoji covers.
NO_EMOJI_FLAG = {"YU", "DD", "XK", "AN"}

# officially assigned ISO 3166-1 alpha-2 codes — exactly the set Unicode gives a
# regional-indicator flag, so it is what stage_validate checks nat codes against
ISO_ALPHA2 = set("""AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG
BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU
CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF
GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS
IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC
MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO
NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD
SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR
TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW""".split())

def pick_nat(ccs):  # a single citizenship, used only when no sport country is known
    cur = sorted(c for c in ccs if c and c in ISO_ALPHA2)
    if cur: return cur[0]                       # a state that still exists wins: someone
    old = sorted(c for c in ccs if c)           # holding DD+DE citizenship is German today
    return old[0] if old else None              # ...but DD alone is now renderable, not dropped

# ---------------------------------------------------------------- stage: attrs
def stage_attrs():
    members = load_members()
    players = sorted({p for ps in members.values() for p in ps})
    versions = current_wd_versions(players)
    old_source, old_records = load_state("attrs")
    changed = stale_records(versions, old_source, old_records)
    def fetch(batch):
        vals = " ".join(f"wd:{q}" for q in batch)
        rows = sparql(f"""
          SELECT ?p (SAMPLE(?len) AS ?en) (SAMPLE(?lmul) AS ?mul) (MIN(?b) AS ?birth)
                 (SAMPLE(?img) AS ?image) (GROUP_CONCAT(DISTINCT ?cc; separator=",") AS ?ccs)
                 (SAMPLE(?ctry) AS ?natq) (SAMPLE(?gk1) AS ?gk) (SAMPLE(?page) AS ?enwiki)
                 (GROUP_CONCAT(DISTINCT ?spcc; separator=",") AS ?spccs) WHERE {{
            VALUES ?p {{ {vals} }}
            OPTIONAL {{ ?p rdfs:label ?len FILTER(LANG(?len)="en") }}
            OPTIONAL {{ ?p rdfs:label ?lmul FILTER(LANG(?lmul) IN ("mul","it","es","de","fr")) }}
            OPTIONAL {{ ?a schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> ;
                           schema:name ?page }}
            OPTIONAL {{ ?p wdt:P569 ?b }}
            OPTIONAL {{ ?p wdt:P18 ?img }}
            OPTIONAL {{ ?p wdt:P27 ?ctry . OPTIONAL {{ ?ctry wdt:P297 ?cc }} }}
            OPTIONAL {{ ?p wdt:P1532 ?sport . OPTIONAL {{ ?sport wdt:P297 ?spcc }} }}
            OPTIONAL {{ ?p wdt:P413 wd:Q201330 . BIND(1 AS ?gk1) }}
          }} GROUP BY ?p""")
        out = []
        for r in rows:
            img = v(r, "image")
            # P1532 (country represented in sport) beats citizenship: it's the actual
            # football nationality (Balotelli holds GH+IT but plays for Italy; the
            # alphabetically-first citizenship code was giving him a Ghana flag).
            # ALL of them count, comma-joined — a player who turned out for two
            # countries earns both flags (Rakitić: Swiss youth, then Croatia at
            # senior level, and taking one of them left him under the wrong flag).
            # Citizenship stays single, though: it says nothing about who a player
            # represented, so a second passport is not a second flag.
            spccs = sorted({c for c in (v(r, "spccs") or "").split(",") if c})
            nat = ",".join(spccs)
            if not nat:
                nat = pick_nat((v(r, "ccs") or "").split(","))
            if not nat and "natq" in r:  # citizenship without ISO code: curated map
                nat = NAT_FIX.get(qid(v(r, "natq")))
            out.append([qid(v(r, "p")), v(r, "en") or v(r, "mul"),
                        year(v(r, "birth", "")), nat,
                        img.rsplit("/", 1)[1] if img else None, num(r, "gk"),
                        v(r, "enwiki")])  # article title = common name, see common_name()
        return out
    rows = resumable("attrs", changed, 350, fetch)
    fresh = {r[0]: r[1:] for r in rows}
    changed = set(changed)
    records = {p: (fresh.get(p) if p in changed else old_records[p]) for p in players}
    attrs = {p: row for p, row in records.items() if row is not None}
    save("attrs", attrs)
    save_state("attrs", versions, records)
    print(f"attrs: {len(attrs)} players; reused {len(players) - len(changed)}, "
          f"fetched {len(changed)}")

# --------------------------------------------------------------- stage: careers
def stage_careers():
    members = load_members()
    players = sorted({p for ps in members.values() for p in ps})
    versions = current_wd_versions(players)
    old_source, old_records = load_state("careers")
    changed = stale_records(versions, old_source, old_records)
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
    rows = resumable("careers", changed, 250, fetch)
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
    fresh = {}
    for p, *sp in sts.values():  # sp = [team, start, end, apps, goals, loan]
        fresh.setdefault(p, []).append(sp)
    changed = set(changed)
    records = {p: (fresh.get(p, []) if p in changed else old_records[p]) for p in players}
    careers = {p: spells for p, spells in records.items() if spells}
    save("careers", careers)
    save_state("careers", versions, records)
    print(f"careers: {sum(map(len, careers.values()))} spells, {len(careers)} players; "
          f"reused {len(players) - len(changed)}, fetched {len(changed)}")

# -------------------------------------------------------------------- stage: wp
# Wikipedia-infobox overlay. Wikidata careers are often incomplete in ways no field
# flags — a whole club spell missing, apps/goals absent — and "every spell is dated"
# does not mean "correct" (see Biraghi: 12 dated spells, yet no Torino and half the
# stats blank). Only comparing against Wikipedia reveals it, so stage_wp fetches the
# enwiki {{Infobox football biography}} for EVERY player and lays the parsed result
# over careers. The overlay REPLACES a candidate's whole spell list (re-resolving each
# club to a QID keeps identifier precision) rather than merging row-by-row, avoiding
# duplicate/conflict handling. A fully resolved infobox is authoritative even when it
# is shorter: Wikidata commonly mixes youth, national or incorrect team statements
# into P54 careers. Everything downstream reads load_careers().
WP_API = "https://en.wikipedia.org/w/api.php"

def load_careers():
    """Wikidata careers with the Wikipedia-infobox overlay laid on top. The overlay
    holds each completely resolved parsed career, so .update replaces those players
    wholesale and leaves players without a usable infobox on raw Wikidata."""
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

def titles_to_qids(titles, cache):
    """enwiki page titles -> QIDs (None where unresolved), 50/req, cached in
    data/<cache>.json. Skips interwiki wikilinks (":de:…"): MediaWiki returns them
    under query.interwiki with no page, and an all-interwiki batch omits
    query.pages entirely — .get() guards that anyway, but there is nothing to
    resolve, so they stay unresolved."""
    t2q = load(cache) or {}
    todo = [t for t in sorted(titles) if t not in t2q and not t.startswith(":")]
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
    save(cache, t2q)
    return t2q

# senior career only. Not line-anchored: many infoboxes pack several params on
# one line (| years1 = … | clubs1 = … | caps1 = …), so match each "|field=" where
# it sits and read the value up to the next pipe or newline. The (\d+)= shape keeps
# youth*/manager*/national*/total* out (their keyword never follows a pipe directly),
# and stopping at "|" harmlessly clips a wikilink at its display pipe — wp_club wants
# only the target before it.
FIELD = re.compile(r"\|\s*(years|clubs|caps|goals)(\d+)\s*=\s*([^|\n]*)")

# "2022–2023" -> closed, "2025–" -> open (still there), and a bare "2023" -> a spell
# that both started and ended that year. The trailing dash is the whole distinction:
# reading a lone year as open-ended made a one-season stay sort as if it were current
# (Diouf's 2023 at Basel outlived his 2023–2025 at Lens and the career read backwards).
def wp_years(s):
    m = re.search(r"(\d{4})\s*([–\-])?\s*(\d{4})?", s)
    if not m: return None, None
    start = int(m.group(1))
    if m.group(3): return start, int(m.group(3))
    return (start, None) if m.group(2) else (start, start)

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

def resolve_wp_spells(spells, t2q):
    """Resolve a complete Wikipedia career, or reject it if any club is unresolved."""
    if any(not t2q.get(sp[0]) for sp in spells): return None
    return [[t2q[t], s, e, a, g, ln] for t, s, e, a, g, ln in spells]

def wp_batch_pages(batch, data):
    """Pair requested [player, title] rows with normalized/redirected API pages."""
    by_title = {t: p for p, t in batch}
    q = (data or {}).get("query", {})
    norm = {n["from"]: n["to"] for n in q.get("normalized", [])}
    redir = {r["from"]: r["to"] for r in q.get("redirects", [])}
    by_result = {redir.get(norm.get(t, t), norm.get(t, t)): p
                 for t, p in by_title.items()}
    return [(by_result[pg["title"]], pg) for pg in q.get("pages", [])
            if pg["title"] in by_result]

def wp_source_token(title, revid):
    return f"{title}\0{revid}" if revid else None

def stage_wp():
    careers, members, attrs = load("careers"), load_members(), load("attrs")
    players = {p for ps in members.values() for p in ps}
    # Trigger every player: Wikipedia is the preferred senior-career source even when
    # it has fewer rows than Wikidata (which often mixes in youth or incorrect teams).
    # Squad-table seeds have no Wikidata career at all, so include those explicitly.
    seeded = {p for ps in (load("roster") or {}).values() for p in ps}
    cand = sorted(p for p in players if careers.get(p) or p in seeded)
    limit = int(os.environ.get("WP_LIMIT", 0))   # dry-run slice; 0 = all
    if limit: cand = cand[:limit]
    print(f"wp: {len(cand)} candidates (all players)", flush=True)

    # stage_attrs already reads the enwiki sitelink from the same Wikidata entity.
    title = {p: attrs[p][5] for p in cand if p in attrs and len(attrs[p]) > 5 and attrs[p][5]}
    legacy = [p for p in cand if p in attrs and len(attrs[p]) <= 5]
    for _, batch in batched(legacy, 200):
        vals = " ".join(f"wd:{q}" for q in batch)
        for r in sparql(f"""SELECT ?p ?t WHERE {{ VALUES ?p {{ {vals} }}
            ?a schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?t . }}"""):
            title[qid(v(r, "p"))] = v(r, "t")
    have = [[p, title[p]] for p in cand if p in title]   # no enwiki page -> no infobox to mine
    print(f"wp: {len(have)} have an enwiki page", flush=True)

    # A cold cache goes straight to content and learns its revision in that response.
    # A warm cache first asks only for revision ids, then downloads the changed pages.
    old_source, old_records = load_state("wp")
    current, current_title = {}, {}
    if old_source:
        def fetch_versions(batch):
            data = wp_get(action="query", prop="revisions", rvprop="ids", redirects=1,
                          titles="|".join(t for _, t in batch))
            out = []
            for p, pg in wp_batch_pages(batch, data):
                revs = pg.get("revisions")
                if revs: out.append([p, pg["title"], revs[0].get("revid")])
            return out
        version_rows = resumable("wp_versions", have, 50, fetch_versions)
        current = {p: wp_source_token(t, rev) for p, t, rev in version_rows}
        current_title = {p: t for p, t, _ in version_rows}
        save("wp_versions", {p: [current_title[p], token] for p, token in current.items()})
        changed = stale_records(current, old_source, old_records)
    else:
        changed = [p for p, _ in have]
        current_title = title

    # Fetch and parse changed wikitext; the cached club value remains a page TITLE.
    # rvsection=0 = lead section only, where the infobox always sits: a quarter of the
    # bytes of the full articles (much less on long ones) for byte-identical parses, and
    # it does work with 50 titles per request despite what the API docs imply.
    def fetch(batch):
        data = wp_get(action="query", prop="revisions", rvprop="ids|content",
                      rvslots="main", rvsection=0, redirects=1,
                      titles="|".join(t for _, t in batch))
        out = []
        for p, pg in wp_batch_pages(batch, data):
            revs = pg.get("revisions")
            if not revs: continue
            spells = parse_infobox(revs[0]["slots"]["main"]["content"])
            out.append([p, pg["title"], revs[0].get("revid"), spells])
        return out
    changed_set = set(changed)
    todo = [[p, current_title[p]] for p in changed if p in current_title]
    rows = resumable("wp", todo, 50, fetch)
    fresh_records = {p: [t, spells] for p, t, _rev, spells in rows}
    fresh_source = {p: wp_source_token(t, rev) for p, t, rev, _spells in rows}
    if old_source:
        records, source = {}, {}
        for p in current:
            if p in changed_set:
                if p not in fresh_records: continue
                records[p], source[p] = fresh_records[p], fresh_source[p]
            else:
                records[p], source[p] = old_records[p], old_source[p]
    else:
        records, source = fresh_records, fresh_source
    save_state("wp", source, records)
    raw = [[p, rec[1]] for p, rec in records.items() if rec[1]]
    print(f"wp: reused {len(records) - len(fresh_records)} pages, "
          f"fetched {len(changed)}", flush=True)

    # phase 3 — resolve the distinct club TITLES -> QIDs
    titles = sorted({sp[0] for _, spells in raw for sp in spells})
    t2q = titles_to_qids(titles, "wp_titles")

    # Wikipedia's senior infobox is authoritative when every parsed club title resolves.
    # A shorter career is accepted: omissions commonly mean Wikidata mixed in youth,
    # national or simply incorrect team statements. Never publish a partially-resolved
    # infobox, though; in that case retain the complete Wikidata career as a fallback.
    wp, unresolved_players = {}, 0
    for pid_, spells in raw:
        rows = resolve_wp_spells(spells, t2q)
        if rows is None:
            unresolved_players += 1
            continue
        wp[pid_] = rows
    save("wp", wp)
    n_sp = sum(map(len, wp.values()))
    unresolved = sum(1 for t in titles if not t2q.get(t))
    print(f"wp: enriched {len(wp)} players, {n_sp} spells; kept Wikidata for "
          f"{unresolved_players} players with unresolved clubs; "
          f"{unresolved}/{len(titles)} club titles unresolved")

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
PACK_NSHARDS = 32
# spell years ship as offsets from here: two digits instead of four, over 200k of them.
# YEAR_MAX is the plausibility ceiling that keeps typo years out of the overlap test.
YEAR0 = 1850
YEAR_MAX = 2100
END_AGE = 42  # past this nobody is still under contract, whatever an unclosed spell says

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
               "Q51243017": "Q704",    # Lyon Olympique Universitaire -> OL (1950 split)
               # bot-made "…men's team" items the name heuristic misses (trailing token)
               "Q97905939": "Q102720",     # Hertha BSC Berlin -> Hertha BSC
               "Q97905936": "Q142005",     # FC Hansa Rostock -> F.C. Hansa Rostock
               "Q97905981": "Q14551982",   # SSV Ulm 1846 -> SSV Ulm 1846 Fußball
               "Q97905972": "Q3163786"}    # Blau-Weiß 90 Berlin -> SpVgg Blau-Weiß 1890 Berlin

# Clubs Wikidata never got a P576 for, though they demonstrably ceased to exist.
# Only lineages that end here: a club whose tradition continues under a new item
# (phoenix, rename, merger into a club we carry) belongs in EXTRA_MERGE instead.
EXTRA_DISSOLVED = {"Q3626037": 1931,   # AC La Dominante (FBC Liguria from 1930)
                   "Q2311455": 1946,   # AC Sampierdarenese (merged -> Sampdoria)
                   "Q3747545": 1926,   # FBC Internazionale-Naples (-> AC Napoli)
                   "Q3629464": 1946,   # Audace FC Taranto (merged -> Taranto)
                   "Q3820995": 1926,   # SS Pro Roma (-> Fortitudo-Pro Roma)
                   "Q4005164": 1928,   # US Ideale Bari (merged -> US Bari)
                   "Q959103":  1935,   # Club Français
                   "Q1514915": 1944,   # SC Fives (merged -> Lille, P1366 but no P576)
                   "Q3590859": 1944}   # ÉF Reims-Champagne (wartime federal team)

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

def fold_spells(career, canon=lambda t: t, hidden=lambda t: False, prefer=lambda t: 0):
    """Fold the statements that split ONE continuous stay — a loan made permanent, a
    re-signing, a contract renewal filed as its own statement — into a single spell,
    the way an infobox career reads. Barella's Inter loan and the transfer that
    followed it were two rows whose apps did not even add up to the one number club
    mode shows for him.

    Two spells at the same club fold when the second starts no later than the first
    ends and everything between them was a loan OUT taken during the stay — a spell
    whose whole range sits inside the combined one (Morata: Atlético 2019-20 on loan,
    then 2020-24 bought, with the Juventus loan in between). A return after a real
    move elsewhere keeps its own entry, because either the years leave a gap (Pogba's
    two United spells) or the club in between outlives the stay (Lukaku back at Inter
    on loan from a Chelsea deal that ran past it). Apps and goals add up; the loan
    flag survives only if every part carried it.

    canon() is the club identity to compare on, so two Wikidata items for one club
    fold like one; prefer() then picks which of them the folded spell keeps, because
    the team it names is what places the player at that club. hidden() marks the teams
    that never reach a career panel (national sides, unlabelled items): they are
    transparent to the "what sits in between" test, since a national career runs
    alongside a club one and would otherwise keep every stay it spans from folding."""
    out = []
    for team, s, e, a, g, ln in sorted(career, key=lambda x: (x[1] or 9999, x[2] or 9999)):
        k = None if hidden(team) else next(
            (i for i in range(len(out) - 1, -1, -1)
             if not hidden(out[i][0]) and canon(out[i][0]) == canon(team)), None)
        p = out[k] if k is not None else None
        # a spell with no start cannot be placed against another; sorted last, it also
        # never sits between two that could fold
        fold = False
        if p and s is not None and p[1] is not None and (s <= p[2] if p[2] is not None else s >= p[1]):
            hi = None if p[2] is None or e is None else max(p[2], e)
            # an open end leaves "inside the stay" unfalsifiable, so fold across
            # nothing at all
            fold = all(hidden(q[0]) or (hi is not None and q[1] is not None
                       and q[2] is not None and p[1] <= q[1] and q[2] <= hi)
                       for q in out[k + 1:])
        if fold:
            if prefer(team) > prefer(p[0]): p[0] = team
            p[1] = min(p[1], s)
            p[2] = hi
            p[3] = None if p[3] is None and a is None else (p[3] or 0) + (a or 0)
            p[4] = None if p[4] is None and g is None else (p[4] or 0) + (g or 0)
            p[5] = 1 if p[5] and ln else 0
        else:
            out.append([team, s, e, a, g, ln])
    return out

def img_key(tail):
    """P18 URL tail (%-encoded) -> "hh" + underscored filename. The 2-char md5
    prefix is the Commons hashed-directory path, so the client can build the
    direct upload.wikimedia.org thumb URL instead of going through the two
    uncacheable Special:FilePath redirects."""
    f = unquote(tail).replace(" ", "_")
    return hashlib.md5(f.encode()).hexdigest()[:2] + f

DISAMB = re.compile(r"\s*\([^()]*\)\s*$")   # "Dodô (footballer, born 1998)"

def common_name(label, page):
    """Display name: a Wikidata label is often the LEGAL name where football uses
    something else entirely — Fiorentina's Dodô is labelled "Domilson Cordeiro dos
    Santos", Javi Martínez "Javier Martínez González". The enwiki article title is
    the common name by policy (WP:COMMONNAME), so prefer it, but only when it is
    SHORTER in words: equal or longer means the label is already the everyday name
    and the title would only add a disambiguator or a stray transliteration.
    ~4% of players are renamed by this; every sampled rename was an improvement."""
    if not page: return label
    short = DISAMB.sub("", page).strip()
    if not short: return label
    if not label: return short
    return short if len(short.split()) < len(label.split()) else label

def stage_build():
    clubs, members, attrs = load("clubs"), load_members(), load("attrs")
    careers, teams = load_careers(), load("teams")

    # data freshness = newest Wikidata checkpoint, not build time. Read up here because
    # spells_at closes over its year, as the end of an open-ended spell.
    built = time.strftime("%Y-%m-%d", time.localtime(max(p.stat().st_mtime for p in DATA.glob("*.json*"))))
    built_year = int(built[:4])

    merged = merge_map(clubs, members)
    groups = {}  # canonical qid -> all qids folded into it
    for q in members: groups.setdefault(merged.get(q, q), []).append(q)
    for old, canon in sorted(merged.items(), key=lambda x: clubs[x[1]]["name"]):
        print(f"  merge: {clubs[old]['name']} ({old}) -> {clubs[canon]['name']} ({canon})")

    club_name = {q: clubs[q]["name"] for q in clubs} | teams
    club_name |= {old: clubs[canon]["name"] for old, canon in merged.items()}

    # one continuous stay, one spell — everything below reads the folded careers, so the
    # shards, the club apps/goals totals and the years files describe the same stays.
    # Identity is the emitted NAME, which is what the client matches careers on and what
    # a reader sees repeated: it folds the phoenix-merged items (club_name maps them to
    # the canonical name) and the pairs of items that merely share a label — Le Havre AC
    # and Legia Warsaw each have two, and neither is in the universe merge.
    # An unlabelled team is hidden like a national side: the emit drops both, and app.js
    # drops what reaches it nameless, so neither may block a fold.
    hidden = lambda t: not club_name.get(t) or bool(NATIONAL.search(club_name[t]))
    n_before = sum(map(len, careers.values()))
    careers = {p: fold_spells(c, lambda t: club_name.get(t) or t, hidden,
                              prefer=lambda t: t in members)  # a universe item outranks
               for p, c in careers.items()}                   # the twin it folded with
    print(f"  folded {n_before - sum(map(len, careers.values()))} split spells "
          f"(loan then bought, re-signings) into the stay they belong to")

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

    def spells_at(p, qs):  # the same spells, kept apart and flattened: [s, e, s, e, ...]
        qs = set(qs)
        career = careers.get(p, ())
        # An open spell runs until the player's next move — a loan out doesn't end it.
        # With no later move it means "still there", but only for someone who could
        # still be playing: for anyone long retired an unclosed spell is a missing end
        # date, and reading it as ongoing makes him a team-mate of everyone who came
        # after. Haki Korça (b. 1919) joined Roma in 1941 and Wikidata records no end —
        # which is not an 85-year stay, and had him turning up beside Totti. There,
        # claim only the season we can prove.
        moves = sorted(s for _, s, _, _, _, ln in career if s and not ln)
        birth = (attrs.get(p) or [None, None])[1]
        playing = bool(birth) and birth + END_AGE >= built_year
        out = []
        for team, s, e, _a, _g, _ln in career:
            if team not in qs or not s or not YEAR0 <= s <= YEAR_MAX: continue
            if e is None:
                e = next((m for m in moves if m > s), None) or (built_year if playing else s)
            elif not s <= e <= YEAR_MAX:
                # Wikidata noise — an end before the start, a 4-digit typo (14 spells in
                # 225k). An impossible range is worse than a missing one here: 1299-9999
                # would make that player a teammate of everyone the club ever had. Keep
                # the start, which is the qualifier the pipeline already sorts on, and
                # claim nothing beyond that season.
                e = s
            out.append((s, e))
        return [x - YEAR0 for s, e in sorted(out) for x in (s, e)]

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

    # display name per player, chosen once. Core keeps its historical name ordering;
    # packs use QID order so a rename cannot churn every pack-local id.
    disp = {q: common_name(a[0], a[5] if len(a) > 5 else None) for q, a in attrs.items()}
    renamed = sum(1 for q, a in attrs.items() if disp[q] != a[0])
    def scope_members(league_order, current):
        wanted = set(league_order)
        # Curated CURRENT is authoritative for promotions: Wikidata's historical
        # league statements can lag or be absent for newly promoted clubs.
        current_clubs = {merged.get(q, q) for qs in current.values() for q in qs}
        return {cq: ps for cq, ps in kept_members.items()
                if cq in current_clubs
                or any(wanted.intersection(clubs[q]["leagues"]) for q in groups[cq])}

    def scope_index(league_order, current, player_sort):
        scoped = scope_members(league_order, current)
        player_qids = sorted({p for ps in scoped.values() for p in ps}, key=player_sort)
        pid = {q: i for i, q in enumerate(player_qids)}
        club_qids = sorted(scoped, key=lambda q: clubs[q]["name"])
        lmask = {q: i for i, q in enumerate(league_order)}
        cur_of = {merged.get(q, q): lmask[lq] for lq, qs in current.items() for q in qs}
        stray = sorted(q for q in cur_of if q not in scoped)
        if stray: print(f"  WARNING: CURRENT clubs not in scope: {stray}")
        out_clubs, postings, apps_col, goals_col, years = [], [], [], [], []
        for cq in club_qids:
            c = clubs[cq]
            leagues = {l for q in groups[cq] for l in clubs[q]["leagues"]}
            mask = sum(1 << lmask[l] for l in leagues if l in lmask)
            ids = sorted(pid[p] for p in scoped[cq])
            sp = [spell(player_qids[i], groups[cq]) for i in ids]
            deltas = [ids[0]] + [b - a for a, b in zip(ids, ids[1:])] if ids else []
            # a merged group is dissolved only if its whole lineage ended
            diss = [clubs[q].get("dissolved") or EXTRA_DISSOLVED.get(q) for q in groups[cq]]
            dissolved = max(diss) if diss and all(diss) else 0
            cur = cur_of.get(cq, -1)
            if cur >= 0: dissolved = 0
            out_clubs.append([c["name"], c["cc"] or "", mask, cq, dissolved, cur])
            postings.append(deltas)
            apps_col.append([-1 if s[2] is None else s[2] for s in sp])
            goals_col.append([-1 if s[3] is None else s[3] for s in sp])
            years.append([spells_at(player_qids[i], groups[cq]) for i in ids])

        names, births, nats, imgs, gk_pids = [], [], [], [], []
        for i, q in enumerate(player_qids):
            a = attrs.get(q) or [None] * 5
            names.append(disp.get(q) or q); births.append(a[1] or 0)
            nats.append(a[2] or ""); imgs.append(img_key(a[3]) if a[3] else "")
            if len(a) > 4 and a[4]: gk_pids.append(i)
        gks = [gk_pids[0]] + [b - a for a, b in zip(gk_pids, gk_pids[1:])] if gk_pids else []
        index = {"built": built, "leagues": [list(LEAGUES[q]) for q in league_order],
                 "clubs": out_clubs, "postings": postings, "apps": apps_col,
                 "goals": goals_col, "gks": gks,
                 "names": names, "births": births, "nats": nats, "imgs": imgs}
        return index, player_qids, pid, club_qids, years

    def career_entries(q):
        career = careers.get(q, ())
        entries = [[club_name.get(t, ""), s, e, a, g] + ([1] if ln else [])
                   for t, s, e, a, g, ln in career
                   if any(x is not None for x in (s, e, a, g))
                   and not NATIONAL.search(club_name.get(t, ""))]
        entries.sort(key=lambda x: (x[1] or 9999, x[2] or 9999))
        return entries

    core_current = {q: CURRENT[q] for q in CORE_LEAGUE_ORDER}
    index, player_qids, pid, club_qids, years = scope_index(
        CORE_LEAGUE_ORDER, core_current, lambda q: (disp.get(q) or "￿", q))
    core_pid = pid

    SITE_DATA.mkdir(parents=True, exist_ok=True)
    packs_root = SITE_DATA / "packs"
    packs_root.mkdir(exist_ok=True)
    manifests = []
    for pack_id, pack in PACKS.items():
        order = list(pack["leagues"])
        pidx, p_qids, p_pid, p_clubs, p_years = scope_index(
            order, pack["current"], lambda q: int(q[1:]))
        gk_set, acc = set(), 0
        for delta in pidx.pop("gks"):
            acc += delta; gk_set.add(acc)
        players = []
        for i, q in enumerate(p_qids):
            players.append([int(q[1:]), core_pid.get(q, -1), pidx["names"][i],
                            pidx["births"][i], pidx["nats"][i], pidx["imgs"][i],
                            1 if i in gk_set else 0])
        for key in ("names", "births", "nats", "imgs"):
            del pidx[key]
        pidx.update({"v": 1, "id": pack_id, "nshards": PACK_NSHARDS, "players": players})

        root = packs_root / pack_id
        career_dir, years_dir = root / "career", root / "years"
        career_dir.mkdir(parents=True, exist_ok=True)
        years_dir.mkdir(parents=True, exist_ok=True)
        for f in years_dir.glob("*.json"): f.unlink()
        shards = [{} for _ in range(PACK_NSHARDS)]
        for q in p_qids:
            qnum = int(q[1:])
            shards[qnum % PACK_NSHARDS][str(qnum)] = [qnum, career_entries(q)]
        for si, shard in enumerate(shards):
            (career_dir / f"{si}.json").write_bytes(
                json.dumps(shard, ensure_ascii=False, separators=(",", ":")).encode())
        for cq, y in zip(p_clubs, p_years):
            (years_dir / f"{cq}.json").write_bytes(json.dumps(y, separators=(",", ":")).encode())
        pblob = json.dumps(pidx, ensure_ascii=False, separators=(",", ":")).encode()
        (root / "index.json").write_bytes(pblob)
        manifests.append({"id": pack_id, "cc": pack["cc"], "built": built,
                          "nshards": PACK_NSHARDS,
                          "bytes": len(gzip.compress(pblob, 6)),
                          "leagues": [LEAGUES[q][0] for q in order],
                          "clubs": [c[3] for c in pidx["clubs"]]})
        print(f"pack {pack_id}: {len(pidx['clubs'])} clubs, {len(players)} players, "
              f"{sum(map(len, pidx['postings']))} postings, {manifests[-1]['bytes']/1e3:.0f} kB gzip")

    index["nshards"] = NSHARDS
    index["packs"] = manifests
    blob = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode()
    (SITE_DATA / "index.json").write_bytes(blob)

    shards = [{} for _ in range(NSHARDS)]
    for q in player_qids:
        i = pid[q]
        shards[i % NSHARDS][str(i)] = [int(q[1:]), career_entries(q)]
    (SITE_DATA / "career").mkdir(exist_ok=True)
    shard_bytes = 0
    for si, sh in enumerate(shards):
        b = json.dumps(sh, ensure_ascii=False, separators=(",", ":")).encode()
        (SITE_DATA / "career" / f"{si}.json").write_bytes(b)
        shard_bytes += len(b)

    # Spell years per club, parallel to postings. Rewritten from empty: a club index
    # freed by a shrinking universe would otherwise leave a stale file behind, and
    # nothing in the format could tell that it now describes a different club.
    (SITE_DATA / "years").mkdir(exist_ok=True)
    for f in (SITE_DATA / "years").glob("*.json"): f.unlink()
    years_bytes = 0
    for ci, y in enumerate(years):
        b = json.dumps(y, separators=(",", ":")).encode()
        (SITE_DATA / "years" / f"{ci}.json").write_bytes(b)
        years_bytes += len(b)

    out_clubs, postings = index["clubs"], index["postings"]
    apps_col, goals_col = index["apps"], index["goals"]
    names, births, nats, imgs = (index[k] for k in ("names", "births", "nats", "imgs"))
    gk_pids, acc = [], 0
    for delta in index["gks"]:
        acc += delta; gk_pids.append(acc)
    n_post = sum(map(len, postings))
    gz = len(gzip.compress(blob, 6))
    with_apps = sum(1 for col in apps_col for a in col if a >= 0)
    with_goals = sum(1 for col in goals_col for g in col if g >= 0)
    cur_counts = [sum(1 for c in out_clubs if c[5] == i) for i in range(len(CORE_LEAGUE_ORDER))]
    print("  current teams: " + ", ".join(
        f"{LEAGUES[q][0]} {n}" for q, n in zip(CORE_LEAGUE_ORDER, cur_counts)))
    print(f"build: {len(out_clubs)} clubs, {len(names)} players, {n_post} postings")
    print(f"  index.json {len(blob)/1e6:.2f} MB raw, {gz/1e6:.2f} MB gzip")
    print(f"  career shards total {shard_bytes/1e6:.2f} MB ({NSHARDS} files)")
    n_dated = sum(1 for y in years for sp in y if sp)
    print(f"  years total {years_bytes/1e6:.2f} MB ({len(years)} files), "
          f"{n_dated/max(n_post,1):.1%} of postings dated")
    print(f"  goalkeepers: {len(gk_pids)} ({len(gk_pids)/len(names):.0%})")
    # ~4% on a healthy run; 0 means a pre-2026-08-08 attrs checkpoint with no titles
    print(f"  common names from enwiki titles: {renamed} of {len(attrs)}")
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

# Squad-table seeds are the one slice of the dataset with no Wikidata anchor at all:
# for a player with no P54 the infobox IS the record, so a broken parse makes him
# VANISH rather than degrade, and neither the apps-coverage guard (he contributes no
# postings to thin out) nor the 3%-shrink player count can see 2.6k of them go. Hence
# a direct check. Measured: ~50% of resolved seeds are players Wikidata already knew
# via P54 and survive any parse failure, while 99.8% of the rest land a qualified
# spell at a universe club — so a healthy run sits near 100% and a dead parser at
# ~50%. The floor goes between, nearer the failure so normal churn never trips it.
ROSTER_FLOOR = 0.85

# The years files are a bare parallel array to postings — no ids of their own — so a
# length that stops matching is a silent mis-pairing of every player at that club with
# someone else's spells, not a visible failure. Checked per club, not sampled. The
# floor is a second, softer guard: a posting exists because some spell was qualified,
# and a start year is the commonest qualifier, so healthy runs sit at 99.7%.
YEARS_FLOOR = 0.95

def apps_coverage(idx):
    tot = sum(len(c) for c in idx["apps"])
    return sum(1 for c in idx["apps"] for a in c if a >= 0) / tot if tot else 0

def decode_deltas(deltas):
    out, total = [], 0
    for delta in deltas:
        total += delta
        out.append(total)
    return out

def pack_index_errors(idx, pack_id, core_players, expected_current):
    """Validate the self-contained part of a pack index (also used by tests)."""
    errs = []
    def chk(ok, msg):
        if not ok: errs.append(msg)
    chk(idx.get("v") == 1, "unsupported format version")
    chk(idx.get("id") == pack_id, f"id {idx.get('id')!r} != {pack_id!r}")
    leagues = idx.get("leagues", [])
    clubs = idx.get("clubs", [])
    players = idx.get("players", [])
    postings = idx.get("postings", [])
    apps = idx.get("apps", [])
    goals = idx.get("goals", [])
    chk(len(leagues) == 2, f"{len(leagues)} leagues != 2")
    chk(len(postings) == len(clubs), "postings/club count mismatch")
    chk(len(apps) == len(clubs), "apps/club count mismatch")
    chk(len(goals) == len(clubs), "goals/club count mismatch")
    chk(len({c[3] for c in clubs if len(c) > 3}) == len(clubs), "duplicate club QIDs")
    chk(all(len(c) == 6 and -1 <= c[5] < len(leagues) for c in clubs),
        "bad club row or current-league field")
    current = [sum(1 for c in clubs if len(c) == 6 and c[5] == i)
               for i in range(len(leagues))]
    chk(current == expected_current,
        f"current clubs {current} != expected {expected_current}")
    valid_players = [p for p in players if isinstance(p, list) and len(p) == 7]
    qids = [p[0] for p in valid_players]
    chk(len(valid_players) == len(players), "malformed player row")
    chk(len(set(qids)) == len(players) and all(isinstance(q, int) and q > 0 for q in qids),
        "duplicate or invalid player QID")
    chk(all(isinstance(p[1], int) and -1 <= p[1] < core_players for p in valid_players),
        "invalid core player id")
    chk(all(p[6] in (0, 1) for p in valid_players), "invalid goalkeeper flag")
    chk(all(not p[5] or re.fullmatch(r"[0-9a-f]{2}\S+", p[5]) for p in valid_players),
        "image without md5 prefix or with spaces")
    for ci, (deltas, acol, gcol) in enumerate(zip(postings, apps, goals)):
        ids = decode_deltas(deltas)
        chk(len(ids) == len(acol) == len(gcol), f"club {ci}: posting stats mismatch")
        chk(all(isinstance(i, int) and 0 <= i < len(players)
                and (pos == 0 or i > ids[pos - 1]) for pos, i in enumerate(ids)),
            f"club {ci}: invalid postings")
        chk(all(x >= -1 for x in acol + gcol), f"club {ci}: apps/goals below -1")
    codes = {c for p in valid_players if p[4] for c in p[4].split(",")}
    unrenderable = sorted(c for c in codes if c not in ISO_ALPHA2 and c not in NO_EMOJI_FLAG)
    chk(not unrenderable, f"nat codes with no flag: {unrenderable}")
    cov = apps_coverage(idx) if postings else 0
    chk(cov >= APPS_FLOOR, f"apps coverage {cov:.1%} below floor {APPS_FLOOR:.0%}")
    return errs

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
    ydir = SITE_DATA / "years"
    stray = sorted(int(f.stem) for f in ydir.glob("*.json") if int(f.stem) >= nc) if ydir.is_dir() else []
    chk(not stray, f"years files for clubs that no longer exist: {stray[:5]}")
    y_dated = y_tot = 0
    for c in range(nc):
        f = ydir / f"{c}.json"
        if not f.exists(): chk(False, f"club {c}: years file missing"); continue
        y = json.loads(f.read_bytes())
        chk(len(y) == len(idx["postings"][c]),
            f"club {c}: years {len(y)} != postings {len(idx['postings'][c])}")
        chk(all(len(sp) % 2 == 0 and all(x >= 0 for x in sp)
                and all(sp[k] <= sp[k + 1] for k in range(0, len(sp), 2)) for sp in y),
            f"club {c}: malformed spell years")
        y_tot += len(y); y_dated += sum(1 for sp in y if sp)
    ycov = y_dated / y_tot if y_tot else 0
    chk(ycov >= YEARS_FLOOR, f"dated postings {ycov:.1%} below floor {YEARS_FLOOR:.0%}")
    cov = apps_coverage(idx)
    chk(cov >= APPS_FLOOR, f"apps coverage {cov:.1%} below floor {APPS_FLOOR:.0%}")
    # every nat code must be renderable: a real ISO 3166-1 alpha-2 (emoji flag) or one
    # of the four we ship an SVG for. Codes that are neither used to reach the client
    # and render as two letter boxes — 216 players shipped that way before anyone
    # noticed, so this is a build failure, not a cosmetic issue.
    codes = {c for n in idx["nats"] if n for c in n.split(",")}
    unrenderable = sorted(c for c in codes if c not in ISO_ALPHA2 and c not in NO_EMOJI_FLAG)
    chk(not unrenderable, f"nat codes with no flag: {unrenderable}")
    roster = load("roster") or {}
    core_current_clubs = {q for lq in CORE_LEAGUE_ORDER for q in CURRENT[lq]}
    seeds = {int(p[1:]) for club, ps in roster.items() if club in core_current_clubs for p in ps}
    shipped, core_qid_pid = set(), {}
    if not missing:
        for i in range(NSHARDS):
            rows = json.loads((SITE_DATA / "career" / f"{i}.json").read_bytes())
            for pid_s, entry in rows.items():
                shipped.add(entry[0]); core_qid_pid[entry[0]] = int(pid_s)
    if seeds and not missing:
        kept = len(seeds & shipped) / len(seeds)
        chk(kept >= ROSTER_FLOOR,
            f"roster seeds in index {kept:.1%} below floor {ROSTER_FLOOR:.0%}")
        print(f"  roster seeds: {len(seeds & shipped)}/{len(seeds)} in index ({kept:.1%})")
    base = os.environ.get("VALIDATE_BASELINE")
    if base:
        old = json.loads(Path(base).read_bytes())
        oc, op, ov = len(old["clubs"]), len(old["names"]), apps_coverage(old)
        chk(nc >= 0.97 * oc, f"clubs shrank {oc} -> {nc}")
        chk(np >= 0.97 * op, f"players shrank {op} -> {np}")
        chk(cov >= ov - 0.02, f"apps coverage shrank {ov:.1%} -> {cov:.1%}")
        print(f"  vs baseline: clubs {oc} -> {nc}, players {op} -> {np}, "
              f"apps {ov:.1%} -> {cov:.1%}")

    # Optional packs are release units of their own: validate both their compact
    # index and every lazy route before exposing them through the core manifest.
    manifests = idx.get("packs", [])
    by_id = {m.get("id"): m for m in manifests}
    chk(len(by_id) == len(manifests), "duplicate pack manifest ids")
    chk(set(by_id) == set(PACKS),
        f"pack manifest ids {sorted(by_id)} != configured {sorted(PACKS)}")
    pack_baseline_dir = os.environ.get("VALIDATE_PACK_BASELINE_DIR")
    for pack_id, config in PACKS.items():
        root = SITE_DATA / "packs" / pack_id
        pf = root / "index.json"
        if not pf.exists():
            chk(False, f"pack {pack_id}: index missing")
            continue
        pidx = json.loads(pf.read_bytes())
        for err in pack_index_errors(pidx, pack_id, np, config["expected_current"]):
            chk(False, f"pack {pack_id}: {err}")
        chk(all(row[1] == core_qid_pid.get(row[0], -1)
                for row in pidx.get("players", []) if isinstance(row, list) and len(row) == 7),
            f"pack {pack_id}: core player id/QID mismatch")
        manifest = by_id.get(pack_id, {})
        chk(manifest.get("cc") == config["cc"], f"pack {pack_id}: bad manifest country")
        chk(manifest.get("built") == pidx.get("built"), f"pack {pack_id}: manifest build mismatch")
        chk(manifest.get("nshards") == pidx.get("nshards"),
            f"pack {pack_id}: manifest shard count mismatch")
        chk(manifest.get("bytes") == len(gzip.compress(pf.read_bytes(), 6)),
            f"pack {pack_id}: manifest byte size mismatch")
        chk(manifest.get("leagues") == [x[0] for x in pidx.get("leagues", [])],
            f"pack {pack_id}: manifest leagues mismatch")
        pack_club_qids = [c[3] for c in pidx.get("clubs", [])]
        chk(manifest.get("clubs") == pack_club_qids,
            f"pack {pack_id}: manifest clubs mismatch")

        pshards = pidx.get("nshards", 0)
        pmissing = [i for i in range(pshards)
                    if not (root / "career" / f"{i}.json").exists()]
        chk(not pmissing, f"pack {pack_id}: missing career shards {pmissing[:5]}")
        pshipped = set()
        if not pmissing:
            for i in range(pshards):
                rows = json.loads((root / "career" / f"{i}.json").read_bytes())
                pshipped |= {row[0] for row in rows.values()}
            expected_qids = {p[0] for p in pidx.get("players", [])}
            chk(pshipped == expected_qids,
                f"pack {pack_id}: career QIDs differ from player rows")

        pydir = root / "years"
        stray_years = sorted(f.stem for f in pydir.glob("*.json")
                             if f.stem not in set(pack_club_qids)) if pydir.is_dir() else []
        chk(not stray_years, f"pack {pack_id}: stale years files {stray_years[:5]}")
        py_dated = py_total = 0
        for club, deltas in zip(pidx.get("clubs", []), pidx.get("postings", [])):
            yf = pydir / f"{club[3]}.json"
            if not yf.exists():
                chk(False, f"pack {pack_id}: {club[3]} years missing")
                continue
            values = json.loads(yf.read_bytes())
            chk(len(values) == len(deltas),
                f"pack {pack_id}: {club[3]} years/postings mismatch")
            chk(all(len(sp) % 2 == 0 and all(x >= 0 for x in sp)
                    and all(sp[k] <= sp[k + 1] for k in range(0, len(sp), 2))
                    for sp in values), f"pack {pack_id}: {club[3]} malformed years")
            py_total += len(values); py_dated += sum(bool(sp) for sp in values)
        pycov = py_dated / py_total if py_total else 0
        chk(pycov >= YEARS_FLOOR,
            f"pack {pack_id}: dated postings {pycov:.1%} below floor {YEARS_FLOOR:.0%}")

        pack_current_clubs = {q for qs in config["current"].values() for q in qs}
        pseeds = {int(p[1:]) for club, ps in roster.items()
                  if club in pack_current_clubs for p in ps}
        if pseeds and not pmissing:
            pkept = len(pseeds & pshipped) / len(pseeds)
            chk(pkept >= ROSTER_FLOOR,
                f"pack {pack_id}: roster seeds {pkept:.1%} below floor {ROSTER_FLOOR:.0%}")
        pcov = apps_coverage(pidx)
        if pack_baseline_dir:
            old_path = Path(pack_baseline_dir) / f"{pack_id}.json"
            if old_path.exists():
                old = json.loads(old_path.read_bytes())
                chk(len(pidx["clubs"]) >= .97 * len(old["clubs"]),
                    f"pack {pack_id}: clubs shrank {len(old['clubs'])} -> {len(pidx['clubs'])}")
                chk(len(pidx["players"]) >= .97 * len(old["players"]),
                    f"pack {pack_id}: players shrank {len(old['players'])} -> {len(pidx['players'])}")
                chk(pcov >= apps_coverage(old) - .02,
                    f"pack {pack_id}: apps coverage shrank too far")
        print(f"  pack {pack_id}: {len(pidx.get('clubs', []))} clubs, "
              f"{len(pidx.get('players', []))} players, apps {pcov:.1%}, years {pycov:.1%}")
    if errs:
        sys.exit("validate FAILED:\n  " + "\n  ".join(errs[:20]))
    print(f"validate: OK ({nc} clubs, {np} players, {ycov:.1%} of postings dated)")

    # Body for the refresh commit. The diff is one line of minified JSON, so none of
    # this is readable from it — which is the only reason it earns the three lines the
    # commit rule allows. Deltas need VALIDATE_BASELINE, as the weekly job sets.
    def delta(new, old, pct=False):
        d = new - old
        return "" if not d else (f" ({d:+.1f}pt)" if pct else f" ({d:+,})")
    gcov = sum(1 for c in idx["goals"] for g in c if g >= 0) / max(sum(map(len, idx["goals"])), 1)
    wp_n = len(set(load("wp") or {}) & shipped) if shipped else 0
    lines = [f"{nc:,} clubs, {np:,} players{delta(np, op) if base else ''}, "
             f"{sum(map(len, idx['postings'])):,} postings",
             f"apps {cov:.1%}{delta(cov * 100, ov * 100, True) if base else ''}, goals {gcov:.1%}"
             + (f"; {len(seeds & shipped):,} of {len(seeds):,} squad seeds kept"
                if seeds and not missing else "")]
    if wp_n:
        lines.append(f"{wp_n:,} careers from Wikipedia infoboxes, "
                     f"{np - wp_n:,} straight from Wikidata")
    (DATA / "commit-body.txt").write_text("\n".join(lines) + "\n")

def stage_quiz():
    """Preserve published quizzes and generate the next 14 days."""
    subprocess.run(["node", str(ROOT / "scripts" / "quiz-schedule.js")], cwd=ROOT, check=True)

STAGES = {"clubs": stage_clubs, "members": stage_members, "roster": stage_roster,
          "attrs": stage_attrs, "careers": stage_careers, "wp": stage_wp,
          "teams": stage_teams, "build": stage_build, "validate": stage_validate,
          "quiz": stage_quiz}

if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    todo = sys.argv[1:] or list(STAGES)
    for s in todo:
        if s not in ("build", "quiz") and load(s) is not None and s not in sys.argv[1:]:
            print(f"{s}: checkpoint exists, skipping"); continue
        print(f"== stage {s}", flush=True)
        STAGES[s]()
