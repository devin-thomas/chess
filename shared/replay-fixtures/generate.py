"""Regenerate replay goldens using the independent Python rules implementation.

Run from any directory: python3 shared/replay-fixtures/generate.py
The TypeScript tests consume committed goldens; they never regenerate them.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
import chess_cpu as chess

OUTPUT = Path(__file__).resolve().parent


def canonical_position(state):
    rights = state["castling_rights"]
    return {
        **{key: state[key] for key in (
            "board", "side_to_move", "en_passant_target", "halfmove_clock", "fullmove_number"
        )},
        "castling_rights": {
            name: symbol in rights for name, symbol in (
                ("white_kingside", "K"), ("white_queenside", "Q"),
                ("black_kingside", "k"), ("black_queenside", "q")
            )
        },
    }


def checkpoint(game):
    state = game.state_dict()
    state.update(canonical_position(state))
    state["revision"] = len(game.moves)
    return {"ply": len(game.moves), "state": state, "position_key": chess.position_key(game.position)}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def make_case(identifier, moves, coverage, fen=None, metadata=None):
    position = chess.parse_fen(fen) if fen else chess.initial_position()
    game = chess.Game("all-rules-enabled", position)
    root = {"kind": "position", "position": canonical_position(game.state_dict())} if fen else {"kind": "standard"}
    artifact = {"schema_version": 1, "ruleset": "orthodox-chess-v1", "root": root, "moves": moves}
    if metadata:
        artifact["metadata"] = metadata
    expected = {"valid": True, "checkpoints": [checkpoint(game)]}
    for index, move in enumerate(moves):
        response, game = chess.handle_request({"op": "play", "move": move}, game)
        if not response["ok"]:
            expected["valid"] = False
            expected["error"] = {
                "code": "E_REPLAY_MOVE", "move_index": index, "ply": index + 1,
                "last_valid_ply": index, "underlying_code": response["error"]["code"],
            }
            break
        expected["checkpoints"].append(checkpoint(game))
    write_json(OUTPUT / f"{identifier}.json", artifact)
    write_json(OUTPUT / f"{identifier}.expected.json", expected)
    return {
        "id": identifier, "artifact": f"replay-fixtures/{identifier}.json",
        "expected": f"replay-fixtures/{identifier}.expected.json", "coverage": coverage,
    }


def main():
    cases = [
        make_case("opening", ["e2e4", "e7e5", "g1f3"], ["short-opening", "metadata-does-not-adjudicate"],
                  metadata={"white": "Fixture White", "black": "Fixture Black", "result": "1-0", "annotation": {"ignored": True}}),
        make_case("capture", ["e2e4", "d7d5", "e4d5"], ["capture"]),
        make_case("castle-kingside", ["e1g1", "e8c8"], ["white-kingside-castling", "black-queenside-castling"],
                  "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"),
        make_case("castle-queenside", ["e1c1", "e8g8"], ["white-queenside-castling", "black-kingside-castling"],
                  "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"),
        make_case("en-passant", ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"], ["en-passant"]),
        make_case("checkmate", ["f2f3", "e7e5", "g2g4", "d8h4"], ["checkmate", "metadata-result-disagreement"], metadata={"result": "1-0"}),
        make_case("black-root", ["h8h7", "a1a2"], ["non-standard-root", "black-to-move", "fullmove-offset"],
                  "7k/8/8/8/8/8/8/KR6 b - - 17 23"),
        make_case("empty", [], ["empty-replay"]),
        make_case("terminal-checkmate", [], ["terminal-root", "checkmate"], "7k/6Q1/5K2/8/8/8/8/8 b - - 0 1"),
        make_case("terminal-stalemate", [], ["terminal-root", "stalemate"], "7k/5K2/6Q1/8/8/8/8/8 b - - 0 1"),
        make_case("terminal-dead", [], ["terminal-root", "dead-position"], "7k/8/8/8/8/8/8/K7 w - - 0 1"),
        make_case("repetition", ["g1f3", "g8f6", "f3g1", "f6g8"] * 4,
                  ["threefold-claim", "fivefold-termination", "history-sensitive-seek"]),
        make_case("seventy-five-move", ["b1b2", "h8h7"], ["fifty-move-claim", "75-move-termination"],
                  "7k/8/8/8/8/8/8/KR6 w - - 148 76"),
        make_case("invalid-move", ["e2e4", "e7e4"], ["invalid-replay", "last-valid-state"]),
        make_case("after-checkmate", ["f2f3", "e7e5", "g2g4", "d8h4", "a2a3"], ["invalid-replay", "move-after-terminal"]),
        make_case("capture-promotion", ["g7h8q"], ["capture-promotion"], "k6r/6P1/8/8/8/8/8/K7 w - - 0 1"),
    ]
    for choice in "qrbn":
        cases.append(make_case(f"promotion-{choice}", [f"a7a8{choice}"], [f"promotion-{choice}", "underpromotion" if choice != "q" else "promotion"],
                               "7k/P7/8/8/8/8/8/7K w - - 0 1"))
    assert all(json.loads((ROOT / "shared" / case["expected"]).read_text())["valid"]
               == ("invalid-replay" not in case["coverage"]) for case in cases)
    write_json(ROOT / "shared/replay-cases.json", {
        "fixture_version": 1,
        "oracle": "python/chess_cpu.py; all-rules-enabled, clocks disabled, fresh root history",
        "state_normalization": "Protocol state with canonical boolean castling rights and revision equal to ply. Checkpoints include every committed ply.",
        "cases": cases,
    })


if __name__ == "__main__":
    main()
