# Quiz generator

`site/quiz-core.js` shares deterministic generation and classification between
the browser and `scripts/quiz-schedule.js`. Optional country packs do not affect
the daily quiz. Current models are `recognition-v7` and `club-recall-v5`.

## Difficulty

Eligibility policy v2 assigns every usable intersection to the first matching tier:

| Level | Set score | Additional requirements |
| --- | ---: | --- |
| Easy | ≥550 | All clues known; two familiar answers or one very obvious answer |
| Medium | ≥400 | At least one familiar answer; not Easy |
| Hard | ≥180 | Not Easy or Medium |
| Impossible | <180 | At least one effective answer with a usable name |

A familiar answer scores at least 400 and has positive appearances in every
clue club. A single very obvious answer must score at least 550 itself. Unknown
totals cannot establish familiarity. Zero-appearance registrations remain accepted
guesses but do not influence difficulty.

Each name/birth-year choice contributes once, using its strongest valid record.
The set score combines the strongest answers and recognisable breadth; raw answer
counts do not determine difficulty. Adding an obscure accepted answer cannot make
the quiz harder. Triples use their weakest pair and cannot inflate recognition.

All nonempty core clubs remain available to Medium, Hard and Impossible, without
minimum roster sizes, mandatory elite clues or maximum answer counts. Invalid
clues, no effective answers or unusable names prevent classification. Valid
intersections never fall between tiers.

## Recognition

Career exposure, appearances, goals, recency and retirement legacy supply the
prior, with appearance-based visibility for goalkeepers. Popularity and club
recall change difficulty only; guesses, representatives and hints keep their
career-based rules. Scores are heuristics, not solve probabilities.

### Player signals

Both signals must be valid, complete and less than 90 days old:

- English Wikipedia median monthly human readership over 12 complete months:
  `viewsScore = min(1, log1p(median) / log1p(100000))`.
- Weighted editions: English 2; Italian, Spanish, French and German 1.5 each;
  others 0.1 each, capped at 1 combined. Divide by the maximum 9.

The target is `700 * (0.75 * viewsScore ** 1.4 + 0.25 * languageScore)`.
Positive corrections blend 0.6 toward it, cap at 250 and scale by
`viewsScore ** 2`. Negative corrections blend 1, cap at 150 points and 25% of
the prior, and fade to zero over the final 0.1 of readership strength.

Generational recall uses dataset year minus birth year: a linear ramp from 60 to
75 supplies at most a 10% reduction, attenuated by
`min(1, (1 - viewsScore) / 0.2)`. It shares the existing downside budget.
Strongly read legends remain protected; unknown births or missing sources are
neutral. This is a generation proxy, not an asserted retirement date.

Below 25 appearances, difficulty uses `.35 + .65 * (minApps / 25) ** 1.5`
instead of the career prior's square-root confidence. Longer spells are unchanged;
unknown totals are neutral. Positive and negative corrections share this discount.

### Clubs and Easy clues

Club familiarity is `0.8 * viewsScore ** 3 + 0.2 * languageScore`, using the same
sources. Its bridge factor is `(.6 + .4 * familiarity) ** 2`, with floors 0.6
overall, 0.85 for a covered second division and 0.95 for a covered top division.
The weakest clue applies once. Missing, partial or expired observations are neutral;
archive size and absence from covered leagues do not establish obscurity.

The curated Easy list contains 48 familiar current/historic clubs, protected at
factor 1. Complete fresh sources can admit clubs with median readership at least
100,000 and weighted-language score at least 0.9. Compilation freezes the resulting
list; automatic admissions expire with their sources, while curated protections
remain. This does not widen the 17-club elite exposure prior or career weights.

### Compilation

`scripts/quiz-recognition.js` merges cached observations by Wikidata QID into
`index.quizRecognition` and `site/data/quiz-recognition.json`, remapping player
IDs through current career shards. It makes no source requests. Browser and Node
use identical frozen features without browser clock-based expiry.

Missing updates retain usable observations until source expiry. Redirect identity
verification also limits expiry. Incomplete inputs cannot replace complete ones.
Raw snapshots stay in workflow artifacts; the compact cache survives releases.
Frozen v4–v6 bundles retain their original parameters and clue lists. Supported
upgrades reuse features without renewing timestamps; incompatible changes require
`--reset-cache` with raw sources. Invalid inputs fail validation. Collection and
CI budgets are documented in [development.md](development.md).

## Calendar and selection

`site/data/quiz-schedule.json` locks distributed dates through `through`. Normal
refresh appends through 90 days after the dataset build and retains an explicitly
longer horizon. To deliberately replace future dates while preserving earlier games:

```sh
node scripts/quiz-schedule.js --regenerate-from 2026-11-10
```

This replaces the future lock and locks the new schedule again. Offline copies
keep their puzzles until reconnecting. Locked history remains playable under its
published levels; new dates must satisfy the current rules.

Selection prefers unused intersections and balances country/club use. Country
pressure uses the fourth power. Historical clubs use covered league affiliation
as a sampling stratum without changing actual country labels. Cooldowns are 30
days per unordered intersection, two per club and 14 per representative. Browser
fallback reconstructs missing dates chronologically with the same rules.

Every tier supports triples, attempted at 15% for Easy, 30% for Medium and 50%
for Hard/Impossible, with pairs as fallback. Additional clues must retain the
required recognition and effective answers.

## Review tools

Review commands write separate artifacts, not production features or dates.
Tune on calibration cases and reserve independent human labels for accuracy;
technical audits measure generation and variety, not human agreement.

| Tool | Purpose |
| --- | --- |
| `recognition-audit.js` | Source evidence, signed score changes and calendar audits |
| `recognition-sample.js` | Frozen country/cohort sample and calibration/holdout split |
| `recognition-calibration.js` | Model workbook, blind review, labels and evaluation |
| `quiz-recalibration.js` | Frozen before/after comparison and proposed calendar |

```sh
node scripts/recognition-audit.js --audit-days 0 --output data/recognition-probes
node scripts/recognition-sample.js
python3 pipeline/popularity.py --sample data/recognition-calibration/sample.json
node scripts/recognition-calibration.js --club-snapshot data/club-recognition/snapshot.json
node scripts/recognition-calibration.js --evaluate data/recognition-calibration/calibration.json --labels /path/to/labels.json
```

The balanced sample targets 20 players per covered career country/birth cohort,
20% goalkeepers and four recognition bands. Unknown births are excluded from this
sample only. Its manifest freezes QIDs, index/core hashes, policy and a 70/30 split.
Changed inputs require deliberate regeneration or verified identical selection.
Mixed-split intersections do not enter agreement metrics.

Reports separate source coverage, score direction, tier changes and probe
denominators. Fixed probes and published intersections remain even above
`--max-intersections`; additional pairs use a stable hash sample. Inspect
`audits.*.errors`: a report is never deployment approval. Use `--audit-days 0`
for diagnostics only, not release validation.

For a reproducible calendar comparison:

```sh
node scripts/quiz-recalibration.js \
  --baseline-index data/review/baseline-index.json \
  --coverage-bundle data/review/coverage-bundle.json \
  --published data/review/published-schedule.json \
  --previous-proposal data/review/previous-proposal.json \
  --feedback data/review/feedback.json \
  --from 2026-11-10 --output data/review/result
```

This verifies identical career evidence, reproduces the old proposal, separates
coverage/formula effects and checks deterministic generation, history, answer
counts and representatives. `--assessment FILE` attaches qualitative observations.
Outputs include JSON, HTML, CSV and the proposed schedule. Coverage-only mode
requires identical weights and new observations; its formula control retains the
exact old bundle, including source timestamps.

[Frozen regression fixtures](../tests/fixtures/README.md) distinguish acknowledged
tuning judgements, user minimum-difficulty constraints and independent human labels.
Report method notes derive from inputs; case commentary belongs in assessment data.

## Checks

```sh
sh scripts/check.sh
node scripts/quiz-schedule.js --audit
node scripts/quiz-eligibility.js
```

The 730-day audit checks classification, cooldowns, triples, country balance and
diversity, including at least 150/400/650/650 distinct intersections and 130 Medium
representatives. The exhaustive census checks every usable core pair;
`--baseline FILE` compares an earlier census. Missing coverage or review failures
do not justify relaxing these checks.
