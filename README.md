# Istinto Puro — solver

Solver for the game "Istinto Puro": pick two or more clubs and instantly
get every player who wore all of those shirts.

## How it works

- **No backend.** The whole dataset (~62k players, ~172k player–club pairs,
  477 clubs from the top-5 leagues + their second divisions, all-time) is
  precomputed into `site/data/index.json` as an inverted index
  (club → delta-encoded sorted player IDs, plus per-pair appearances and
  goals, `-1` = unknown; plus `gks`, a delta-encoded list of goalkeeper
  player IDs — the UI marks them "(GK)" and hides their goal counts, which
  are unreliable on Wikidata). Each club record is `[name, country, leagueMask,
  QID, dissolvedYear, currentLeague]` — `dissolvedYear` (Wikidata P576, `0`
  if active) drives the `†year` marker on defunct clubs; `currentLeague`
  (league index, `-1` if outside the covered leagues) drives the FM-style
  browse panel (country › league › current clubs, everything else under
  "Others"). The browser intersects posting lists client-side in well under
  a millisecond.
- **Careers** are sharded into `site/data/career/*.json` (128 files; the
  count is stamped into the index as `nshards`) and lazy-loaded when a
  player row is expanded. Each entry is
  `[QID number, spells]`; the QID links the player's Wikipedia article
  (it/en per UI language) via Wikidata's `Special:GoToLinkedPage`, so no
  article titles need to be stored.
- **Photos** are the only runtime external dependency: thumbnails lazy-loaded
  from Wikimedia Commons, with initials fallback.

## Data pipeline

Source: Wikidata (P54 team memberships + qualifiers for years/apps/goals;
P576 club dissolution date).

```
python3 pipeline/pipeline.py            # all stages, checkpointed in data/
python3 pipeline/pipeline.py build      # rebuild site/data from checkpoints
```

Stages: `clubs → members → attrs → careers → teams → build → validate`.
Each fetch stage checkpoints to `data/*.json(l)`; delete a checkpoint to
force a re-fetch. Full run issues ~600 SPARQL queries (~40 min,
politeness-throttled). `validate` checks the emitted index's invariants
and — given `VALIDATE_BASELINE=<previous index.json>`, as the weekly
refresh workflow does — fails the run instead of shipping a dataset that
shrank more than 3%.

Quality passes: women (Wikidata P21) are excluded at the `members` stage —
they reach men's club items through women's-section P54 statements. In
`build`, P54 statements with no qualifiers at all (no years/apps/goals)
are discarded as unreliable, re-founded "phoenix" clubs are merged into
one entry, and national sides are filtered out of career panels.
Goalkeepers (P413) are flagged in the index so the UI can suppress their
goal counts. Citizenships pointing at states without an ISO code resolve
through a curated map (`NAT_FIX`: Kingdom of Denmark → DK, Kingdom of
Italy → IT, the German Reich lineage → DE, …); ambiguous ones (USSR,
Yugoslavia, Czechoslovakia) stay unknown. The index is stamped with the extraction date (newest
checkpoint), shown in the site footer.

Current league membership (`CURRENT` in `pipeline.py`) is a curated list
of club QIDs per league — Wikidata's P118 lags promotions/relegations by
months, so it can't be derived reliably. Refresh it each August once the
new season's lineups are settled (reserve teams stay out; `validate`
fails if any league's current lineup drifts outside 17–24 clubs).

## Serve

Any static file server:

```
python3 -m http.server -d site 8000
```

Pushing to `master` auto-deploys `site/` to GitHub Pages
(`.github/workflows/pages.yml`).

## License

MIT. Data derived from [Wikidata](https://www.wikidata.org) (CC0);
photos are served by Wikimedia Commons under their own licenses.
