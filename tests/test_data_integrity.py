import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pipeline", ROOT / "pipeline/pipeline.py")
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class DataIntegrityTests(unittest.TestCase):
    def test_years_require_bounded_ordered_integer_pairs(self):
        self.assertTrue(PIPELINE.valid_spell_years([[], [150, 152, 160, 162]]))
        for values in [None, [None], [[150]], [[152, 150]], [[0, 251]],
                       [[-1, 1]], [[True, 2]], [[1.5, 2]], [["1", 2]]]:
            with self.subTest(values=values):
                self.assertFalse(PIPELINE.valid_spell_years(values))

    def test_careers_must_route_to_their_actual_shard(self):
        rows = {"2": [123, [["Club", 2000, 2001, 10, 0]]], "4": [456, []]}
        self.assertEqual(PIPELINE.career_shard_errors(rows, 0, 2, range(5)), [])
        self.assertTrue(PIPELINE.career_shard_errors(rows, 1, 2, range(5)))
        self.assertTrue(PIPELINE.career_shard_errors(rows, 0, 2, range(2)))

    def test_pack_career_keys_must_match_the_player_qid(self):
        self.assertEqual(PIPELINE.career_shard_errors({"2": [2, []]}, 0, 2, {2}, True), [])
        self.assertTrue(PIPELINE.career_shard_errors({"2": [3, []]}, 0, 2, {2}, True))

    def test_malformed_careers_fail_with_diagnostics(self):
        for rows in [[], {"no": []}, {"01": [1, []]}, {"0": None},
                     {"0": [True, []]}, {"0": [1, [None]]},
                     {"0": [1, [[None, 2000, 2001, 10, 0]]]},
                     {"0": [1, [["Club", 2000, 2001, -1, 0]]]},
                     {"0": [1, [["Club", 2000, 2001, 1.5, 0]]]},
                     {"0": [1, [["Club", 2000, 1990, 10, 0]]]},
                     {"0": [1, [["Club", 2000, 3000, 10, 0]]]},
                     {"0": [1, [["Club", 1200, 1300, 10, 0]]]}]:
            with self.subTest(rows=rows):
                self.assertTrue(PIPELINE.career_shard_errors(rows, 0, 2, range(5)))

    def test_ordered_career_years_are_accepted(self):
        rows = {"0": [1, [["Club", 2000, 2001, 10, 0], ["Club", 2003, None, 0, 0]]]}
        self.assertEqual(PIPELINE.career_shard_errors(rows, 0, 2, range(5)), [])


if __name__ == "__main__":
    unittest.main()
