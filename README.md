<p align="center">
  <img src="site/icon-192.png" width="112" alt="Istinto Puro icon">
</p>

<h1 align="center">Istinto Puro</h1>

<p align="center"><strong>Every career has a connection.</strong></p>

<p align="center">
  <a href="https://istintopuro.mcosta.it">Play now</a> ·
  <a href="#run-locally">Run locally</a> ·
  <a href="docs/development.md">Development</a>
</p>

A daily football quiz and a career solver. Find the players who connect your
clubs, explore shared careers, or test your football memory with a new puzzle
every day. Everything runs in your browser, with no account or tracking.

- **Daily quiz** — four club intersections, from easy to impossible. The same
  puzzle for everyone, with an archive to replay past days. Clear the first three
  to keep your streak; Impossible is an extra. A purple clue can reward a less
  obvious answer on one of the daily stages.
- **Club solver** — combine clubs, leagues and countries to find matching players.
- **Player connections** — find shared clubs or discover former teammates.
- **Extra leagues** — enable country packs for Portugal, the Netherlands,
  Belgium, Turkey, Brazil and Argentina.
- **Offline play** — install as a PWA and download the game to keep playing
  without a connection. Progress stays in your browser.

## Coverage

Around **72,000 players and 469 clubs** across the top two divisions in England,
Spain, Germany, Italy and France, including historical careers. Optional packs
add the top two divisions in six more countries; the daily quiz uses the core
dataset so everyone gets the same clues.

Data comes from Wikidata and English Wikipedia, refreshed weekly. Coverage
depends on those sources, so some careers and appearance totals are incomplete.

## Play offline

In **Settings**, enable **Play offline** and wait for **Ready to play offline**
before disconnecting. The download includes the game and all enabled country
packs. Installing the PWA turns this on by default; the download still needs
to finish.

Player photos fall back to initials offline. Reconnect occasionally to get fresh
data and extend the shared quiz calendar, which covers 90 days after each build.

## Run locally

From the repository root, serve the included site and dataset with Python 3:

```sh
python3 -m http.server -d site 8000
```

Open [localhost:8000](http://localhost:8000). No build step required.

For checks, data refreshes, deployment and offline internals, see the
[development guide](docs/development.md). The [quiz generator guide](docs/quiz-generator.md)
documents difficulty rules and calendar controls.

## License

Code: [MIT](LICENSE). Data: [Wikidata](https://www.wikidata.org) (CC0),
with career details from [English Wikipedia](https://en.wikipedia.org).
Photos are served by Wikimedia Commons under their individual licenses.

The four flags in `site/flags/` (Yugoslavia, the GDR, Kosovo and the Netherlands
Antilles) are public domain, from Wikimedia Commons.
[Barlow Semi Condensed](https://github.com/jpt/barlow) is © The Barlow Project
Authors, licensed under [SIL OFL 1.1](site/fonts/LICENSE).
