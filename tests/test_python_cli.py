import json
import pathlib
import subprocess
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_CLI = ROOT / "python" / "chess_cpu.py"


def request(*requests):
    payload = "".join(json.dumps(item) + "\n" for item in requests)
    completed = subprocess.run(
        [sys.executable, str(PYTHON_CLI)],
        input=payload,
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=True,
    )
    if completed.stderr:
        raise AssertionError(f"unexpected stderr: {completed.stderr}")
    return [json.loads(line) for line in completed.stdout.splitlines()]


class PythonCliTests(unittest.TestCase):
    def test_initial_position_has_twenty_legal_moves(self):
        responses = request({"op": "new"}, {"op": "legal_moves"})
        self.assertTrue(responses[0]["ok"])
        self.assertEqual(len(responses[1]["moves"]), 20)

    def test_initial_perft_depth_three(self):
        response = request({"op": "perft", "depth": 3})[0]
        self.assertTrue(response["ok"])
        self.assertEqual(response["nodes"], 8902)

    def test_special_moves_are_exposed(self):
        castling = request(
            {
                "op": "new",
                "mode": "all-rules-enabled",
                "fen": "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
            },
            {"op": "legal_moves"},
        )[1]
        self.assertIn("e1g1", castling["moves"])
        self.assertIn("e1c1", castling["moves"])

        en_passant = request(
            {
                "op": "new",
                "fen": "k7/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
            },
            {"op": "legal_moves"},
        )[1]
        self.assertIn("e5d6", en_passant["moves"])

        promotion = request(
            {
                "op": "new",
                "fen": "2k5/P7/8/8/8/8/8/4K3 w - - 0 1",
            },
            {"op": "legal_moves"},
        )[1]
        self.assertEqual(
            {move for move in promotion["moves"] if move.startswith("a7a8")},
            {"a7a8q", "a7a8r", "a7a8b", "a7a8n"},
        )

    def test_all_rules_reports_claimability_and_rejects_self_check(self):
        responses = request(
            {
                "op": "new",
                "mode": "all-rules-enabled",
                "fen": "4k3/8/8/8/8/8/R7/K7 w - - 100 1",
            },
            {"op": "state"},
        )
        self.assertIn("fifty_move", responses[1]["state"]["claimable_draws"])

        illegal = request(
            {
                "op": "new",
                "fen": "k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
            },
            {"op": "play", "move": "e5d6"},
        )[1]
        self.assertFalse(illegal["ok"])
        self.assertEqual(illegal["error"]["code"], "E_SELF_CHECK")

    def test_cpu_run_is_reproducible(self):
        first = request(
            {"op": "run", "mode": "all-rules-enabled", "seed": "42", "max_plies": 80}
        )[0]
        second = request(
            {"op": "run", "mode": "all-rules-enabled", "seed": "42", "max_plies": 80}
        )[0]
        self.assertEqual(first, second)
        self.assertEqual(first["plies"], len(first["moves"]))


if __name__ == "__main__":
    unittest.main()
