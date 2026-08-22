import json
import pathlib
import shutil
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
C_SOURCE = ROOT / "c" / "chess_cpu.c"
C_BINARY = BUILD / "test_chess_c"
TS_SOURCE = ROOT / "typescript" / "chess_cpu.ts"


def invoke(command, *requests):
    payload = "".join(json.dumps(item) + "\n" for item in requests)
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


@unittest.skipUnless(shutil.which("cc") and shutil.which("node"), "C compiler and Node are required")
class ExternalCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        BUILD.mkdir(exist_ok=True)
        subprocess.run(
            [
                shutil.which("cc"),
                "-std=c11",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Wpedantic",
                str(C_SOURCE),
                "-o",
                str(C_BINARY),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        cls.commands = {
            "c": [str(C_BINARY)],
            "typescript": [shutil.which("node"), "--experimental-strip-types", str(TS_SOURCE)],
        }

    def test_each_external_cli_reports_initial_perft(self):
        for name, command in self.commands.items():
            with self.subTest(engine=name):
                response = invoke(command, {"op": "perft", "depth": 2})[0]
                self.assertTrue(response["ok"])
                self.assertEqual(response["nodes"], 400)

    def test_each_external_cli_handles_a_special_move(self):
        for name, command in self.commands.items():
            with self.subTest(engine=name):
                responses = invoke(
                    command,
                    {
                        "op": "new",
                        "fen": "2k5/P7/8/8/8/8/8/4K3 w - - 0 1",
                    },
                    {"op": "play", "move": "a7a8n"},
                    {"op": "state"},
                )
                self.assertTrue(responses[1]["ok"])
                pieces = [piece for piece in responses[2]["state"]["board"] if piece]
                self.assertIn({"color": "white", "type": "knight"}, pieces)

    def test_each_external_cli_reproduces_seeded_cpu_trace(self):
        for name, command in self.commands.items():
            with self.subTest(engine=name):
                first = invoke(command, {"op": "run", "seed": "17", "max_plies": 40})[0]
                second = invoke(command, {"op": "run", "seed": "17", "max_plies": 40})[0]
                self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
