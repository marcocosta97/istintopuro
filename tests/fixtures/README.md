# Quiz calibration data

Fixtures are frozen test inputs; collection and weekly refresh never regenerate
them. Changing rules requires reviewing their examples and expectations.
`_fixture.clubStature` pins original population weights so reduced rosters do not
silently change scores. Player/goalkeeper IDs are remapped and relevant careers
retain every club registration. Live-data tests separately check production weights,
published history and the 730-day audit.

| Fixture | Contents and provenance |
| --- | --- |
| `quiz-calibration.json` | 8,834 players from the 2026-10-26 index at `3b0858afa4f7272eed586d3563d042874e440985`; complete tested intersections and population controls |
| `recognition-signals.json` | Synthetic language, readership, zero, stale and missing-source cases; not measured popularity |
| `club-recall.json` | 129 complete careers, measured sources, familiar-club controls and user minimum-Hard constraints for AlzanoCene/PSG and Bury/Stoke |
| `recognition-bridges.json` | Shared 655-career projection from the 2026-11-09 index at `80aa884f38f42643430b1a72c7edfe04eaae4316`, with four preserved comparison frames |

Bridge frames cover target-curve migration, short spells, measured Easy admission
and generational recall. Each retains original/supplemented source bundles,
digests, evidence and expectations. Shared storage preserves original attributes,
complete careers, club metadata and weights without duplicating projections.

Acknowledged assistant judgements and user minimum constraints are not independent
human accuracy labels. Blackburn/Arsenal keeps its initial Medium judgement separate
from the Easy reassessment after observing Raya. Tests preserve this distinction,
old-model replay and accepted-answer/hint identity.
