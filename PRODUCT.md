# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Football supporters exploring player careers, club intersections, and a shared
daily football quiz. They may arrive for a quick answer, browse historical
connections, or play repeatedly on desktop or mobile.

## Product Purpose

Istinto Puro turns an all-time football dataset into a fast, private solver and
daily game. Success means useful answers feel immediate, the same daily puzzle
is dependable for everyone, and richer data remains optional rather than making
the default experience heavier.

## Positioning

Precomputed, all-time football career data powers a private, in-browser solver
and a shared daily quiz. The same core dataset supports quick intersections,
career exploration, and dependable daily play, with extra leagues kept optional.

## Operating Context

People use the web app on desktop and mobile for quick lookups, deeper career
exploration, shared selections, a daily quiz, and archive replays. It can be
installed as a PWA. Offline play requires an initial online download; Settings
shows when the complete game is ready and which country packs are saved.

## Capabilities and Constraints

- The solver finds players connecting selected clubs, leagues, or countries.
  Player mode finds shared clubs and historical teammates.
- The daily quiz has four stages of rising difficulty and uses the core dataset.
  Optional country packs never change its puzzles.
- The published schedule extends 90 days after the dataset build. Normal
  refreshes preserve playable published dates, including future ones. Beyond
  the saved schedule, locally generated puzzles can differ from a newer online
  release.
- The complete core game downloads automatically, including career hints and
  teammate data. Enabled country packs have separate offline downloads.
  Incomplete updates preserve the previous complete offline copy.
- Optional packs add the top two divisions in Portugal, the Netherlands,
  Belgium, Turkey, Brazil, and Argentina to the solver.
- Progress and preferences stay in the browser, with no account, application
  backend, or tracking. Offline storage depends on browser retention; users
  can request persistent storage.
- Wikimedia portraits fall back to initials when offline or when a fetch fails.
  External Wikipedia and Wikidata pages require a connection.

## Brand Personality

Knowledgeable, playful, and restrained. The almanac-inspired presentation
should feel rooted in football culture without becoming nostalgic decoration.

## Anti-references

Avoid sportsbook styling, generic statistics dashboards, collectible-card
grids, excessive gamification, and controls that compete with the football
results. Optional features must not make the primary solver feel configurable
or administrative.

## Evidence on Hand

- Static football indexes, career records, teammate data, and the quiz schedule
  live in `site/data/`; `pipeline/pipeline.py` builds them from Wikidata and
  Wikipedia sources.
- `README.md` describes the product, data coverage, local setup, and offline
  behavior. `docs/quiz-generator.md` records the daily quiz rules and schedule.
- The existing interface and Italian/English copy live in `site/`. Tests in
  `tests/` cover data integrity, quiz behavior, and offline downloads and recovery.
- `LICENSE`, `site/fonts/LICENSE`, and the README's license section record the
  code, typeface, and data/image attribution requirements.

## Product Principles

- Put the football question and answer ahead of configuration.
- Preserve a fast, complete default experience; disclose heavier data choices.
- Make historical depth browsable without overwhelming first-time use.
- Prefer stable, shareable states and deterministic daily play.
- Keep data processing private, local, and resilient offline.

## Accessibility & Inclusion

Target WCAG AA contrast and keyboard operation, provide explicit accessible
names and status announcements, support coarse pointers and responsive mobile
layouts, and respect reduced-motion preferences. Never rely on a flag, color,
hover, or motion alone to communicate state.
