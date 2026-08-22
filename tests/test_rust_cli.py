import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUST_SOURCE = ROOT / "rust" / "chess_cpu.rs"
RUSTC = shutil.which("rustc")


def invoke(command, *requests):
    payload = "".join(json.dumps(request) + "\n" for request in requests)
    completed = subprocess.run(
        command,
        input=payload,
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=True,
    )
    if completed.stderr:
        raise AssertionError(f"unexpected stderr from {' '.join(command)}: {completed.stderr}")
    return [json.loads(line) for line in completed.stdout.splitlines()]


@unittest.skipUnless(RUSTC and RUST_SOURCE.is_file(), "rustc and the Rust CLI source are required")
class RustCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._temporary_directory = tempfile.TemporaryDirectory(prefix="chess-rust-test-")
        cls.addClassCleanup(cls._temporary_directory.cleanup)
        cls.binary = pathlib.Path(cls._temporary_directory.name) / "chess_rust"
        subprocess.run(
            [
                RUSTC,
                "--edition=2021",
                "-O",
                str(RUST_SOURCE),
                "-o",
                str(cls.binary),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        cls.command = [str(cls.binary)]

    def test_initial_perft_depth_two(self):
        response = invoke(self.command, {"op": "perft", "depth": 2})[0]
        self.assertTrue(response["ok"])
        self.assertEqual(response["nodes"], 400)

    def test_special_move_is_reflected_in_state(self):
        responses = invoke(
            self.command,
            {
                "op": "new",
                "fen": "2k5/P7/8/8/8/8/8/4K3 w - - 0 1",
            },
            {"op": "play", "move": "a7a8n"},
            {"op": "state"},
        )
        self.assertTrue(responses[1]["ok"])
        self.assertEqual(responses[1]["move"], "a7a8n")
        self.assertIn(
            {"color": "white", "type": "knight"},
            [piece for piece in responses[2]["state"]["board"] if piece],
        )

    def test_seeded_run_is_deterministic(self):
        request = {"op": "run", "seed": "17", "max_plies": 40}
        first = invoke(self.command, request)[0]
        second = invoke(self.command, request)[0]
        self.assertTrue(first["ok"])
        self.assertEqual(first, second)
        self.assertEqual(first["plies"], len(first["moves"]))

    def test_jsonl_error_preserves_state_for_following_request(self):
        responses = invoke(
            self.command,
            {
                "op": "new",
                "fen": "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1",
            },
            {"op": "play", "move": "e2e5"},
            {"op": "state"},
        )
        self.assertTrue(responses[0]["ok"])
        self.assertFalse(responses[1]["ok"])
        self.assertEqual(responses[1]["error"]["code"], "E_ILLEGAL_GEOMETRY")
        self.assertEqual(responses[1]["state"], responses[2]["state"])
        self.assertEqual(responses[2]["state"]["side_to_move"], "white")


if __name__ == "__main__":
    unittest.main()
