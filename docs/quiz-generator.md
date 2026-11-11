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

### Result rules and optional purple clues

Easy, Medium and Hard all solved secures the daily streak as soon as Hard is
cleared. Hints are allowed. Skipping any of those stages does not count as a
daily success, even if Impossible is solved. Impossible is an extra: failing it,
ending the run or leaving it unfinished past midnight preserves an earned day.
Archive practice never changes official statistics. Existing four-stage streaks
remain valid; summary-only archive rows cannot reconstruct exact attempts.

`site/quiz-result.js` supplies shared result and streak semantics. The end screen
and text sharing show attempts by stage, with separate hint counts and a purple
mark for an earned criterion. Shared URLs include `?day=YYYY-MM-DD#quiz` and open
that day's puzzle, without carrying any answers.

After the schedule is generated, `scripts/quiz-bonuses.js` annotates it with
optional `bonuses`, keyed by date. It never changes club selections, accepted
answers, difficulty or generation randomness. The schedule writer and its
`--check` command also compile and validate this metadata using local career
shards; no source requests or additional browser downloads are needed.

Each date has at most one criterion. Nationality and career criteria are sought
on Easy, then Medium, then Hard. Birth decades are a last resort: only if none of
those three stages has a suitable nationality or career condition is the first
usable birth criterion selected, again preferring Easy.
Stages need at least three distinct usable answers with positive appearances.
Candidates restrict the answers by nationality, birth decade or another senior
career spell, excluding the strongest ordinary answer. Zero-appearance
registrations cannot supply the candidate player. Career clues prefer documented spells
outside familiar clubs; exact years appear only when both ends are usable.
All accepted answers matching the selected condition receive the reward, with
name/birth-year grouping preserved. Nationality clues name one country and also
accept qualifying players with multiple nationalities. Historical country names
use the same localized labels as the player lists. Selection evaluates the actual answer
subset on the same 0–1 scale for every family: the mean of selectivity
(`1 - targetCount / effectiveChoiceCount`) and recognition contrast with the
strongest ordinary answer (`max(0, 1 - strongestTargetFame / ordinaryFame)`).
There are no fixed points for a criterion family. These are local heuristics,
not measured human difficulty.

Each family contributes one finalist, chosen by exact subset quality. Supporting
detail, such as usable dates and substantial appearances, then chooses between
equally good clues within that family; it cannot boost the family itself.
The two finalists are compared in 0.1-wide quality bands; a weaker band cannot
win. Within the best band, a seeded weighted draw favors the higher exact quality
and gently discounts recent use. Each past use contributes `0.5 ** (ageDays - 1)`
pressure to its family, and its weight is
`exp(2 * (quality - bestQuality)) / (1 + 0.25 * pressure)`. Recency therefore fades
continuously with calendar distance, with no weekly cutoff or balancing target.
Repeats remain possible; there is no required alternation or fixed run length.

The RNG is local to the tie-break, seeded from the quiz date, so repeated builds
agree without consuming puzzle-generator state. Each family has one finalist,
avoiding extra tie-break chances for careers with more spells. There are no
date-based type quotas. Repeated evidence for the same condition
retains its strongest supporting spell. Dates without a suitable condition
store `null`.

Published conditions, including an absent condition, remain pinned while the
matchup is unchanged. Targets remap by name/birth-year choice at release time.
A new game copies its criterion into the saved state; started older games gain
no new condition midway through play. Purple is earned only by the normal
answer to that question, with no extra attempt or requirement for the streak.

### Published horizon

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
