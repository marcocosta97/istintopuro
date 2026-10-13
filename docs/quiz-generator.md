# Quiz generator

`site/quiz-core.js` generates and classifies four daily club intersections.
The browser and `scripts/quiz-schedule.js` share the same rules and calendar
history, so every player receives the same quiz. Optional country packs do
not change the daily quiz.

## Difficulty

The classifier assigns the first matching level, in this order:

| Level | Recognition score | Requirements |
| --- | ---: | --- |
| Easy | ≥550 | All clues in `EASY_QIDS`; at least two familiar answers |
| Medium | ≥400 | Recognisable clubs; at least one familiar answer; not easy |
| Hard | ≥180 | At least one marquee clue and historical top-flight links; not easy or medium |
| Impossible | <180 | Specialist candidate pools; an effective answer with a usable name |

Easy targets a general fan who follows their own league and knows major
European clubs. Medium and hard require broader European knowledge;
impossible draws on historical and lower-division careers.

A familiar answer needs at least 100 stature-weighted appearances across
the original 17 `ELITE_QIDS` clubs, 15 documented appearances at every clue
club, and a bridge recognition score of 400. The broader 40-club easy clue
list does not increase the visibility attributed to players. Medium uses
the prominent-club pool plus Bordeaux, Leicester, Parma, Sampdoria,
Deportivo, Blackburn and Saint-Étienne.

Scores combine career exposure, appearances, goals, recency and retirement
legacy, with adjusted appearance weights for goalkeepers. Short spells
reduce bridge recall. Unknown appearance totals are neutral in that
discount, but do not establish a familiar answer. Zero-appearance
registrations remain accepted guesses and are excluded from difficulty.

The levels are exclusive; their raw scores need not descend. An intersection
with one familiar route can be medium even above 550. Unusable intersections
or high scores without an appropriate recognisable anchor can be discarded.
These rules are heuristics, not measured solve probabilities.

## Selection and repetition

Medium searches all eligible groups of the selected format before choosing,
so the first small group cannot hide the rest of its catalogue. The other
levels retain their preference ladders. Within eligible candidates, selection
prefers never-used intersections, then penalises frequent repeats while
balancing recent club and country use.

The full calendar supplies usage counts, independently of local play history.
Hard cooldowns remain 30 days for an unordered intersection, two days for
a club, and 14 days for a representative player. Browser fallback reconstructs
missing dates chronologically using the same context as the schedule writer.

Every level supports triples. Seeded attempt probabilities are 15% for easy,
30% for medium and 50% for hard/impossible, with pairs as fallback. Recognition
uses the weakest constituent pair, so a third clue cannot inflate ease and
must retain the level's familiar-answer requirements.

## Calendar

The versioned asset is `site/data/quiz-schedule.json`. Normal refresh preserves
playable days through `lockedThrough` and regenerates the remaining horizon.
Its default end is 14 days after the dataset build. An explicitly extended
`horizonThrough` is retained until the normal refresh horizon catches up.

To recalculate future dates while preserving earlier games:

```sh
node scripts/quiz-schedule.js --regenerate-from 2026-10-15 --through 2026-10-28
```

This explicitly replaces any existing future lock: October 14 becomes the
preservation cutoff, and October 15–28 are regenerated. The dataset build date
is unchanged. Locked history stays playable under its published levels;
new dates must satisfy the current classifier and cooldowns.

## Verification

```sh
node scripts/quiz-schedule.js --check
node scripts/quiz-schedule.js --audit
sh scripts/check.sh
```

The deterministic 730-day audit checks classification, repetition, triple
rates, country balance and usable representatives. It also requires at least
150/400/650/650 distinct intersections across the four levels and 130 distinct
medium representatives, guarding against the catalogue collapsing into a
small preferred group. Published fixtures and browser fallback are tested
against the same rules.
