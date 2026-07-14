# Istinto Puro — solver

Solver for the game "Istinto Puro": pick two or more clubs and instantly
get every player who wore all of those shirts.

## How it works

- **No backend.** The whole dataset (~62k players, ~172k player–club pairs,
  477 clubs from the top-5 leagues + their second divisions, all-time) is
  precomputed into `site/data/index.json` as an inverted index
  (club → delta-encoded sorted player IDs, plus per-pair appearances and
  goals, `-1` = unknown). Each club record is `[name, country, leagueMask,
  QID, dissolvedYear]` — `dissolvedYear` (Wikidata P576, `0` if active)
  drives the `†year` marker on defunct clubs. The browser intersects posting
  lists client-side in well under a millisecond.
- **Careers** are sharded into `site/data/career/*.json` (128 files) and
  lazy-loaded when a player row is expanded. Each entry is
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

Quality passes in `build`: P54 statements with no qualifiers at all
(no years/apps/goals) are discarded as unreliable, re-founded "phoenix"
clubs are merged into one entry, and national sides are filtered out of
career panels. The index is stamped with the extraction date (newest
checkpoint), shown in the site footer.

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
