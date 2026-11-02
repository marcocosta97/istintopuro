# Quiz calibration data

`quiz-calibration.json` freezes football examples from the 2026-10-26 core
index at commit `3b0858afa4f7272eed586d3563d042874e440985`. It contains 8,834
players (about 0.7 MB), including complete intersections for the pairs and
triples in `quiz-calibration.test.js` and the schedule classification test.
All club statistics for those players are retained, along with at least 120
source players per relevant club where available, or 400 for non-marquee
current top-flight clubs, to exercise the original candidate pool memberships.
Player IDs and goalkeeper deltas are remapped to the reduced index.

The `_fixture.clubStature` array pins weights from the original club
populations: reducing rosters must not silently alter the recognition inputs.
The calibration helper injects these weights through the core's existing
`stature` dependency. Production population weighting is exercised by the
tests on the live dataset and the synthetic population tests.

This fixture is test input, not published data. Weekly refreshes must never
regenerate it. When changing recognition rules, review the fixed examples and
their expected results explicitly. Add a focused synthetic case or extend the
frozen examples when testing a new behavior; an unchanged build date alone
does not identify unchanged input data.

Tests in `quiz-core.test.js` use `site/data` to check current published games,
determinism, repetition, state restoration, and scoring consistency. The
schedule tests retain the live 730-day audit and its quality thresholds.
