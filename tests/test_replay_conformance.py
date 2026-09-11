from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "build" / "replay_nes_output.txt"
MODULE_SPEC = importlib.util.spec_from_file_location("replay_conformance", ROOT / "tools" / "replay-conformance.py")
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
CONFORMANCE = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(CONFORMANCE)


class ReplayConformanceParserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not OUTPUT.exists():
            import subprocess

            subprocess.run(["make", "replay-nes-proof"], cwd=ROOT, check=True)

    def test_fixed_buffer_text_trace_matches_fixture(self) -> None:
        move_count, positions, navigation_ok, profile, emulator_run = CONFORMANCE.load_retro_output(OUTPUT)
        self.assertEqual((move_count, sorted(positions), navigation_ok, profile, emulator_run),
                         (2, [0, 1, 2], True, "nes-fixed-buffer-host", False))
        expected = CONFORMANCE.load_json(ROOT / "shared" / "replay-fixtures" / "castle-kingside.expected.json")
        report = CONFORMANCE.build_retro_report(expected, OUTPUT, "build/replay_nes_output.txt")
        self.assertTrue(report["ok"])
        self.assertEqual(report["mismatch_count"], 0)

    def test_cc65_fceux_json_trace_parser_preserves_navigation(self) -> None:
        records = []
        for event, (ply, command, done) in enumerate(((0, 0, False), (1, 1, False), (2, 1, False),
                                                       (1, 2, False), (0, 3, False), (2, 4, True)), start=1):
            records.append({
                "event": event,
                "command": command,
                "valid": 1,
                "ply": ply,
                "move_count": 2,
                "side": "white" if ply % 2 == 0 else "black",
                "rights": "-",
                "ep": "-",
                "halfmove": ply,
                "fullmove": 1,
                "board": "8/8/8/8/8/8/8/8",
                "error": 0,
                "demo_stage": event - 1,
                "done": done,
            })
        payload = {"schema_version": 1, "profile": "cc65-fceux", "records": records}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            move_count, positions, navigation_ok, profile, emulator_run = CONFORMANCE.load_retro_output(path)
        self.assertEqual(move_count, 2)
        self.assertEqual(sorted(positions), [0, 1, 2])
        self.assertTrue(navigation_ok)
        self.assertEqual(profile, "cc65-fceux")
        self.assertTrue(emulator_run)


if __name__ == "__main__":
    unittest.main()
