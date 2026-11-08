# Quiz generator

`site/quiz-core.js` generates and classifies four daily club intersections.
The browser and `scripts/quiz-schedule.js` share the same rules and calendar
history, so every player receives the same quiz. Optional country packs do
not change the daily quiz.

## Difficulty

Eligibility policy v2 assigns every valid intersection to exactly one level,
using the first matching rule:

| Level | Recognition score | Requirements |
| --- | ---: | --- |
| Easy | ≥550 | All clues known; one very obvious answer, or multiple familiar answers |
| Medium | ≥400 | At least one familiar answer; not easy |
| Hard | ≥180 | Not easy or medium |
| Impossible | <180 | At least one effective answer with a usable name |

A familiar answer has a bridge recognition score of at least 400 and documented
positive appearances in every clue club. A single route can qualify for easy
when its own bridge score is at least 550. Two or more familiar routes can also
qualify when the combined ease reaches 550. A moderate single route does not
become easy merely because numerous obscure alternatives inflate the total.

Known easy clues are the curated marquee set plus Bordeaux, Leicester, Parma,
Sampdoria, Deportivo, Blackburn and Saint-Étienne. This list describes clue
recognition and does not widen the original 17-club player-exposure prior.
Medium and hard have no required marquee clue or current/historical division.

Scores combine career exposure, appearances, goals, recency and retirement
legacy, with adjusted appearance weights for goalkeepers. Elite appearances
remain a visibility input, without a mandatory 100-appearance gate. Brief spells
receive a continuous weakest-link discount, without a mandatory 15-appearance
gate. Unknown totals remain neutral in that discount but cannot establish a
familiar route. Zero-appearance registrations remain accepted guesses and are
excluded from difficulty calculations.

Each selectable name/year contributes once to ease and recognised breadth,
using its strongest valid record. A route is familiar if any of its valid records
qualifies. Different birth years remain distinct choices. Guesses and revealed
careers still resolve to the matching accepted record; duplicate selections are
free and subsequent hints skip choices already revealed.

No valid combination falls between tiers. A high score with unfamiliar clues
can be medium or hard instead of being discarded. Only invalid clues, no
effective answer, or unusable answer names prevent classification. Difficulty
scores remain heuristics, not measured solve probabilities.

## Selection and repetition

The normal search uses the same requirements as classification. Every level
admits a single effective answer and has no maximum raw answer count. Easy draws
from the known-club set; the other levels can draw from every nonempty core
club, including small archives and historical/lower-division teams. Archive
size does not define obscurity. All matching hard or impossible intersections
remain available regardless of how many historically valid answers they have.

Country-first draws and selection pressures balance club and country use.
Country pressure uses the fourth power to keep the broader pools from concentrating on the
best-documented countries. Historical clubs now located elsewhere use their
covered league affiliation as a sampling stratum. Their actual country labels
remain unchanged. Representatives and hint ranking use the existing career
heuristic; popularity and club recall adjust difficulty only.

Selection prefers unused intersections, then penalises frequent repeats.
The full calendar supplies usage counts independently of local play history.
Hard cooldowns remain 30 days for an unordered intersection, two days for a
club, and 14 days for a representative player. The fallback searches the same
club universe with the same classifier; it does not require same-country big
clubs. Browser fallback reconstructs missing dates chronologically.

Every level supports triples. Seeded attempt probabilities are 15% for easy,
30% for medium and 50% for hard/impossible, with pairs as fallback. Third clues
must retain effective answers. For easy/medium, the sampler uses the classifier
to find third clues retaining the required recognition, avoiding draws wasted
on combinations already known to be ineligible. Triple recognition uses the
weakest constituent pair and cannot increase recognised answer breadth.

## Calendar

The versioned asset is `site/data/quiz-schedule.json`. Normal refresh preserves
every playable date through the previous `through`, including future dates
already downloaded by offline players, and appends new days. Its default end
is 90 days after the dataset build. The output sets `lockedThrough` to `through`:
every distributed day is published. An explicitly extended
`horizonThrough` is retained until the normal refresh horizon catches up.

To recalculate future dates while preserving earlier games:

```sh
node scripts/quiz-schedule.js --regenerate-from 2026-10-15 --through 2026-10-28
```

This explicitly replaces any existing future lock: October 14 becomes the
preservation cutoff, and October 15 onward is regenerated through at least the
default 90-day horizon. The dataset build date is unchanged. The resulting
schedule is locked again when written. Use this override deliberately: offline
copies keep their previously downloaded puzzles until they reconnect.
Locked history stays playable under its published levels; new dates must satisfy
the current classifier and cooldowns.

## Production recognition inputs

The daily generator uses player model `recognition-experiment-v4` with club
model `club-recall-v2`. Parameters remain heuristics to
calibrate against human ratings.

`scripts/quiz-recognition.js` compiles fresh, complete cached observations into
`index.quizRecognition` and the retained `site/data/quiz-recognition.json` cache.
It makes no source requests. The initial release combines the retained collection
artifact with the previously collected review sample. Future weekly releases
merge new observations by Wikidata QID, keep earlier usable observations until
their source TTL expires, and remap them through the current career shards.
Players without usable popularity keep their career prior; clubs without usable
sources have neutral recall. Incomplete backfills do not exclude any candidate.

The browser and Node share `site/quiz-recognition.js`, the frozen release time,
and the same compact features inside the core index. There is no additional
browser request or runtime clock-based expiry. The offline inventory includes
the shared module. Freshness is checked again when compiling the next release.
Source snapshots remain workflow artifacts rather than published raw data.
When changing the pinned feature configuration, use `--reset-cache` with the
required raw observations to rebuild features; incompatible cached features fail
validation rather than being silently interpreted with new parameters.
Release checks reject malformed inputs, mismatched QID/player mappings, or a
cache that differs from the core index. Existing calendar locks are preserved;
new dates and runtime fallback use the current model.

```sh
python3 pipeline/pipeline.py recognition
node scripts/quiz-recognition.js --check
node scripts/quiz-schedule.js --audit
```

## Verification

### Offline popularity experiment

The comparison tooling is read-only and does not alter published quiz inputs.
It reads the collected snapshot, joins players by the core career shards' QIDs,
and compares the career-only baseline with a bounded popularity adjustment. The existing
choice-control column is retained for report compatibility; it now matches the
baseline because production already counts each selectable name/year once.

```sh
node scripts/recognition-audit.js
# Fast probe-only report; the default also audits 730 days per distinct model:
node scripts/recognition-audit.js --audit-days 0 --output data/recognition-probes
# Repeat a trial with explicit parameters and a frozen observation time:
node scripts/recognition-audit.js --config /tmp/recognition-config.json --as-of 2026-11-04T20:00:00Z
```

Defaults read `site/data/index.json`, its career shards and published schedule,
and `data/popularity/snapshot.json`. Output goes to `data/recognition-audit/`:
`report.json`, `report.md`, an interactive `report.html`, and `players.csv`.
The JSON includes input hashes, every trial coefficient, source coverage,
per-answer appearances and spell scores, and all calendar-audit violations.
Player priors are calculated without club clues; intersection scores add the
existing recall adjustment. This distinction prevents a high global familiarity
estimate being mistaken for knowledge of a particular spell.

The initial hypothesis gives English weight 2 and Italian, Spanish, French and
German weight 1.5 each. Other editions contribute 0.1 each, capped at 1 in total;
weighted coverage is divided by the maximum of 9. Readership uses the logarithm
of the median monthly human pageviews, saturating at 100,000. The combined
signal is 75% readership and 25% weighted editions. The revised default hypothesis
(`recognition-experiment-v4`) moves each answer's existing recognition estimate
toward `700 * signal`. Positive changes keep the previous blend of 0.6 exactly.
Positive corrections are capped at 250 and multiplied by `viewsScore ** 2`.
Negative changes use their own `downwardBlend: 1`, capped at both 150 points
and 25% of the prior. Readership and edition coverage are already incorporated
in the target; the revised downside avoids discounting them a second time
throughout the whole range. Only the last 0.1 of normalised log readership
(`downwardFade`) fades the reduction to zero. Saturated readership is a lower
bound and supplies no evidence for a decrease. All coefficients remain trial
hypotheses, not calibrated confidence or solve probabilities. They are not
selected to force a particular count of difficulty transitions.

`REFERENCE_CONFIG` freezes the original bonus-only control (`readershipPower: 0`,
`maxDrop: 0`); `GRADUAL_CONFIG` retains the attenuated bonus-only control
(`readershipPower: 2`, `maxDrop: 0`). The current default allows both directions.
`CONSERVATIVE_CONFIG` freezes the v3 negative branch: blend 0.6 and support
`(1 - viewsScore) / (1 + languageScore)`. It remains a control to isolate the
effect of revising the downside. Tests require every positive correction to
remain exactly equal between v3 and v4, even when set-level effects differ
because another answer is reduced.
Stronger measured readership or edition coverage can never make the corrected
estimate lower, and the transformation stays ordered by the career prior.

Both sources must be complete, valid and less than 90 days old at the frozen
as-of time (default: snapshot generation). Source timestamps control freshness;
saved `current` flags and the wall clock do not. A complete measured zero can
support a decrease; missing, stale, future-dated or partial observations leave
the prior unchanged. Each player's own measured 12-month window is
retained. Trial configuration is a JSON object overriding fields exported as
`DEFAULT_CONFIG` in `scripts/recognition-model.js`; changing parameters requires
no source requests. The model ID includes its version and configuration digest.
Reports also record the eligibility-policy version and hashes of the quiz core
and model code.

Strong popularity (combined signal at least 0.75 and three primary editions)
is retained as a diagnostic marker, not an additional eligibility gate. The
current classifier uses adjusted bridge scores and positive spell evidence,
without a mandatory elite-club total. Positive and negative corrections receive the same
weakest-spell discount, and triples take their weakest pair. Source coverage
and score scaling remain subjects for further human calibration.

The answer-set score is recomputed from the corrected distinct choices: strongest
answer, top supporting alternatives, weighted recognisable breadth and familiar
answer count can all decline when an answer was overestimated. Obscure extra
answers never create a raw-count penalty; a quiz that accepts any one answer
cannot become harder merely by accepting another route. Adding a required club
can still make it harder through the narrower intersection and weakest spell.

### Club recall and its calibration

Global player recognition does not establish recall of every club spell. The
optional contextual comparison keeps the v4 player correction, then multiplies
each bridge by the weakest clue's club-recognition factor, once. Triples still
use their weakest constituent pair. This changes only difficulty: accepted
answers, representatives, hints, normal search universes and published calendar
locks retain their existing behavior.

```sh
python3 scripts/club-recognition.py --max-requests 600 --max-seconds 600
node scripts/recognition-calibration.js --club-snapshot data/club-recognition/snapshot.json
```

The club collector reuses the player collector's serial source client, 12-month
human readership median, language parser, journal, retries and per-source 90-day
TTL. It collects core club QIDs directly, using separate state and observations
in `data/club-recognition/`, without re-fetching player careers. It cannot replace
player snapshots or write published assets. The separate maintenance workflow
collects both sources; release compilation reuses their cached observations.

The club model uses English median readership normalised logarithmically
at 100,000 and the same weighted-edition coverage. Club familiarity is 80% cubed
readership strength and 20% edition coverage. Its bridge factor ranges from 0.6
to 1. Current covered top-division and second-division presence supply positive
floors of 0.95 and 0.85; missing a covered division does not imply dissolution or
exclude the club. The curated known-club set, including recognised historic clues
such as Parma and Bordeaux, has factor 1 even after relegation. Missing, partial,
stale or future-dated observations are neutral. Historical posting counts never
enter the recall factor. These coefficients remain review hypotheses, not
measured recognition probabilities.

`scripts/recognition-examples.json` records the user's minimum-Hard feedback for
AlzanoCene/PSG and Bury/Stoke as qualitative calibration constraints, separate
from exact human ratings and held-out agreement metrics. The report shows the
career baseline, player-only correction and contextual bridge separately, with
club source values. A familiar route must still reach 400 after this correction;
a set can remain Hard above an aggregate score of 400 if no answer qualifies.
The two supplied examples test the hypothesis; they are not evidence of accuracy
across the entire catalogue.

The first trial squared readership. Release v2 cubes it: the larger collection
also measures Lee Dixon, whose player bonus otherwise promoted Bury/Stoke back
to Medium. The frozen club fixture includes that additional real observation.
Player bonuses, known historic clues and current-division floors are unchanged.

`site/quiz-core.js` accepts a `recognition` dependency shared by production and offline
comparisons. The browser and normal schedule writer load the compiled adapter. Accepted
answers, representatives, hint targets and their ranking continue using the
existing rules, even inside the experiment. No published schedule is written.
The comparison tool never writes the production features or calendar. The release
compiler pins the model version and retains existing published days.

Reports always include the fixed probes and published intersections, then a
stable hash sample of pairs involving observed players. `--max-intersections`
(default 2,000) limits those additional pairs; fixed and published probes are
retained even if they exceed it. `--probes FILE` supplies club-QID arrays, and
`--index`, `--snapshot`, `--schedule` and `--output` select isolated inputs.
Distribution charts describe this selected set rather than the entire catalogue.
The 730-day simulations use a single frozen dataset and signal snapshot: they
test generation, repetition and diversity, not historical predictive accuracy.
Candidate audit failures remain visible in reports and must be reviewed; they
are never waived by reducing the existing quality floors. Coverage and human
review of fixed examples guide subsequent model revisions.
The command reports completed comparisons even when a trial fails quality
checks: inspect `audits.*.errors` rather than interpreting its exit status as
model approval. `deploymentReady` is always false. Invalid inputs and I/O errors
still fail the command.

### Balanced calibration and independent human review

```sh
node scripts/recognition-sample.js
python3 pipeline/popularity.py --sample data/recognition-calibration/sample.json --max-requests 450 --max-seconds 600
node scripts/recognition-calibration.js
```

The sample is deterministic and contains 20 players per covered career country
and birth cohort: before 1970, 1970–1989, and 1990 onward. With five countries
this selects 300 players, targeting 20% goalkeepers and four recognition bands.
Country is the dominant covered career country by documented appearances,
not nationality. Bands use each player's strongest existing pair bridge score,
before observing popularity. Missing role/score cells are filled within the
same country/cohort; shortages and actual distributions are reported. Unknown
birth years are counted as excluded from this review sample, without changing
quiz eligibility. Selectable duplicate records contribute one player.

The manifest freezes QIDs, index and quiz-core hashes, seed, selection policy,
and a 70/30 calibration/holdout split. Regenerate it deliberately when changing
the dataset or quiz rules; regenerating against identical inputs is reproducible.
An interface-only core update can reuse the original manifest only after rebuilding
the selection and verifying identical player records, scores, probes and splits,
and the same eligibility version. This revalidation is recorded in the report;
the manifest and review digest stay unchanged. A changed selection fails validation.
The collector accepts only a matching index and core candidate QIDs, reuses its
normal checkpoint/90-day TTL, and writes separate calibration metrics and a
snapshot. Missing English articles and incomplete series remain unknown. Partial
runs preserve usable observations and can resume with the same command. The
sample snapshot cannot replace the normal release snapshot or published assets.

The workbook compares four player hypotheses: the previous bonus, its attenuated
bonus-only variant, conservative bidirectional v3 and revised v4. When club
observations are available, it adds the contextual recall comparison. Running a
workbook does not change production rules. Each distinct model receives the
same frozen inputs and the existing 730-day calendar checks. Those checks measure
generation quality and variety, not human difficulty agreement. Audit violations
remain visible and no quality floors are relaxed. Use `--audit-days 0` only for
fast diagnostics, not release validation.

Outputs in `data/recognition-calibration/`:

- `report.html` / `report.md`: model comparisons with per-answer source values,
  appearances and reasons for changed levels. The JSON retains weakest-pair
  factors and timestamps, plus the strongest adjusted answer independently of
  the unchanged representative/hint ranking.
- `review.html`: independent human assessment with predictions hidden, accepted
  answers and spell appearances available on demand, and a JSON download.
  “I don't know” stays unlabelled rather than being counted as impossible.
- `labels-template.json`: blank labels; no model supplies its own ground truth.
- `calibration.json`: frozen inputs, comparisons, cases and technical audits;
  `reference/`, `gradual/`, `conservative/`, `bidirectional/` and optionally
  `contextual/` retain detailed model reports.

The standalone pages share the site's typography and support light/dark mode
and mobile screens. The report has player/club search, model selection and
paginated comparisons with expandable evidence. Direction filters distinguish
increases, decreases and unchanged scores independently of difficulty changes.
Signed deltas and per-answer malus explanations show reductions even when the
overall level is unchanged. Sample-level changes and the larger selected probe
diagnostic have distinct denominators: the latter includes supplementary and
held-out cases, and must not be used to tune coefficients on held-out outcomes.
The extended diagnostic explicitly lists decreases as well as increases and
shows before/after levels, rather than only the largest positive corrections.
Review presents one question
at a time, with group progress, optional notes and keyboard shortcuts (1–4 to
rate, arrows to navigate). Existing browser ratings survive presentation
updates. JSON import validates the frozen sample and all rows before merging;
invalid files preserve the work already saved. Export carries ratings and notes
between browsers. If browser storage is unavailable, the page explicitly asks
the reviewer to export the JSON. Fonts and scripts are embedded for offline use
and relative links work through the code-server port proxy.

Choose coefficients using calibration cases and reserve the holdout for a final
check. Intersections containing sampled players from both splits are marked
mixed and excluded from quantitative agreement metrics. The UI defaults to
calibration review. The balanced sample describes a review workload, not the
population or real-world solve probabilities. Readership currently covers only
English Wikipedia, even though edition coverage is weighted across languages.

After downloading human labels, evaluate without fetching or re-running audits:

```sh
node scripts/recognition-calibration.js --evaluate data/recognition-calibration/calibration.json --labels /path/to/human-labels.json
```

`evaluation.json` reports exact agreement and average tier distance separately
for calibration and holdout, with unreviewed counts. Mismatched or duplicate
labels fail validation. No automatic model recommendation or production
activation is inferred from a technical audit or an unlabelled workbook.

### Release checks

```sh
node scripts/quiz-eligibility.js
node scripts/quiz-schedule.js --check
node scripts/quiz-schedule.js --audit
sh scripts/check.sh
```

The exhaustive eligibility census checks every usable core pair before sampling
or cooldowns, requiring a classification and a matching normal search tier.
It writes `data/eligibility-change/catalogue.json`; `--baseline FILE` includes a
previous census for comparison. This separates catalogue availability from
the daily generator's deliberate repetition and variety constraints.

The deterministic 730-day audit checks classification, repetition, triple
rates, country balance and usable representatives. It also requires at least
150/400/650/650 distinct intersections across the four levels and 130 distinct
medium representatives, guarding against the catalogue collapsing into a
small preferred group. Published fixtures and browser fallback are tested
against the same rules.
