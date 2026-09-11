from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "build" / "replay_nes_output.txt"
SOURCES = (
    ROOT / "retro" / "nes_replay.c",
    ROOT / "retro" / "replay_nes.c",
    ROOT / "retro" / "nes_replay_main.c",
)
PIECE_LETTERS = {
    ("white", "pawn"): "P",
    ("white", "knight"): "N",
    ("white", "bishop"): "B",
    ("white", "rook"): "R",
    ("white", "queen"): "Q",
    ("white", "king"): "K",
    ("black", "pawn"): "p",
    ("black", "knight"): "n",
    ("black", "bishop"): "b",
    ("black", "rook"): "r",
    ("black", "queen"): "q",
    ("black", "king"): "k",
}


def board_fen(board: list[object]) -> str:
    ranks: list[str] = []
    for rank in range(7, -1, -1):
        row = ""
        empty = 0
        for file in range(8):
            piece = board[rank * 8 + file]
            if piece is None:
                empty += 1
                continue
            if empty:
                row += str(empty)
                empty = 0
            assert isinstance(piece, dict)
            row += PIECE_LETTERS[(piece["color"], piece["type"])]
        if empty:
            row += str(empty)
        ranks.append(row)
    return "/".join(ranks)


def expected_position(ply: int) -> dict[str, str | int]:
    expected = json.loads((ROOT / "shared" / "replay-fixtures" / "castle-kingside.expected.json").read_text())
    state = next(checkpoint["state"] for checkpoint in expected["checkpoints"] if checkpoint["ply"] == ply)
    rights = state["castling_rights"]
    rights_text = "".join(
        name
        for name, key in (("K", "white_kingside"), ("Q", "white_queenside"), ("k", "black_kingside"), ("q", "black_queenside"))
        if rights[key]
    ) or "-"
    return {
        "board": board_fen(state["board"]),
        "side": state["side_to_move"],
        "rights": rights_text,
        "ep": state["en_passant_target"] or "-",
        "halfmove": state["halfmove_clock"],
        "fullmove": state["fullmove_number"],
    }


class RetroReplayProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not OUTPUT.exists():
            subprocess.run(["make", "replay-nes-proof"], cwd=ROOT, check=True)
        cls.lines = OUTPUT.read_text(encoding="utf-8").splitlines()

    def test_fixed_buffer_source_has_no_runtime_text_parsers_or_allocators(self) -> None:
        for source_path in SOURCES:
            source = source_path.read_text(encoding="utf-8").lower()
            for forbidden in ("json", "pgn", "san", "malloc", "calloc", "realloc", "free"):
                self.assertIsNone(re.search(rf"(?<![a-z]){forbidden}(?![a-z])", source), source_path.name)

    def test_embedded_fixture_exercises_navigation_and_matches_expected_positions(self) -> None:
        self.assertIn("NES_OK format=1 moves=2", self.lines)
        self.assertIn("NES_NAV ok", self.lines)
        positions: dict[int, dict[str, str | int]] = {}
        for line in self.lines:
            if not line.startswith("NES_PLY "):
                continue
            fields = line.split()
            ply = int(fields[1])
            values = {key: value for key, value in (field.split("=", 1) for field in fields[2:])}
            positions[ply] = {
                "board": values["board"],
                "side": values["side"],
                "rights": values["rights"],
                "ep": values["ep"],
                "halfmove": int(values["halfmove"]),
                "fullmove": int(values["fullmove"]),
            }
        self.assertEqual(set(positions), {0, 1, 2})
        for ply in positions:
            self.assertEqual(positions[ply], expected_position(ply))

    def test_malformed_compiled_buffers_fail_without_overrunning(self) -> None:
        self.assertIn("NES_INVALID ok", self.lines)


if __name__ == "__main__":
    unittest.main()
