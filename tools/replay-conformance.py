#!/usr/bin/env python3
"""Compare every valid Replay V1 fixture across the four host engines.

The committed expected states are the independent fixture oracle. The report
also records normalized state and effective position-key output from each host
so a retro harness can be added without changing the report shape.
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
CASES_PATH = ROOT / "shared" / "replay-cases.json"
FIXTURE_DIR = ROOT / "shared" / "replay-fixtures"
STATE_FIELDS = (
    "mode",
    "board",
    "side_to_move",
    "castling_rights",
    "en_passant_target",
    "halfmove_clock",
    "fullmove_number",
    "status",
    "check",
    "outcome",
    "claimable_draws",
    "repetition_counts",
    "moves",
    "revision",
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

sys.path.insert(0, str(ROOT))
from tests.run_shared import EngineSession, RunnerError  # noqa: E402


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RunnerError(f"cannot load {path}: {exc}") from exc


def parse_command(value: str) -> list[str]:
    command = shlex.split(value)
    if not command:
        raise argparse.ArgumentTypeError("engine command cannot be empty")
    return command


def parse_piece(piece: Any) -> str:
    if piece is None:
        return "1"
    if not isinstance(piece, dict):
        raise RunnerError("fixture board contains a non-piece value")
    letter = PIECE_LETTERS.get((piece.get("color"), piece.get("type")))
    if letter is None:
        raise RunnerError(f"fixture board contains an invalid piece {piece!r}")
    return letter


def position_to_fen(root: Mapping[str, Any]) -> str:
    position = root.get("position")
    if not isinstance(position, dict):
        raise RunnerError("position root is missing its position object")
    board = position.get("board")
    if not isinstance(board, list) or len(board) != 64:
        raise RunnerError("position root board must contain 64 cells")
    ranks: list[str] = []
    for rank in range(7, -1, -1):
        row = ""
        empty = 0
        for file in range(8):
            value = parse_piece(board[rank * 8 + file])
            if value == "1":
                empty += 1
            else:
                if empty:
                    row += str(empty)
                    empty = 0
                row += value
        if empty:
            row += str(empty)
        ranks.append(row)
    rights = position.get("castling_rights")
    if not isinstance(rights, dict):
        raise RunnerError("position root castling rights are missing")
    rights_text = "".join(
        name
        for name, key in (
            ("K", "white_kingside"),
            ("Q", "white_queenside"),
            ("k", "black_kingside"),
            ("q", "black_queenside"),
        )
        if rights.get(key) is True
    ) or "-"
    side = position.get("side_to_move")
    if side not in ("white", "black"):
        raise RunnerError("position root side_to_move is invalid")
    ep = position.get("en_passant_target") or "-"
    return " ".join(
        (
            "/".join(ranks),
            "w" if side == "white" else "b",
            rights_text,
            ep,
            str(position.get("halfmove_clock")),
            str(position.get("fullmove_number")),
        )
    )


def fixture_requests(replay: Mapping[str, Any]) -> list[dict[str, Any]]:
    root = replay.get("root")
    if not isinstance(root, dict):
        raise RunnerError("replay root is not an object")
    request: dict[str, Any] = {"op": "new", "mode": "all-rules-enabled"}
    if root.get("kind") == "position":
        request["fen"] = position_to_fen(root)
    elif root.get("kind") != "standard":
        raise RunnerError("replay root kind is unsupported")
    moves = replay.get("moves")
    if not isinstance(moves, list) or not all(isinstance(move, str) for move in moves):
        raise RunnerError("replay moves must be a string array")
    requests: list[dict[str, Any]] = [request, {"op": "legal_moves"}]
    for move in moves:
        requests.extend(({"op": "play", "move": move}, {"op": "legal_moves"}))
    return requests


def castling_rights(value: Any) -> dict[str, bool]:
    if isinstance(value, str):
        return {
            "white_kingside": "K" in value,
            "white_queenside": "Q" in value,
            "black_kingside": "k" in value,
            "black_queenside": "q" in value,
        }
    if isinstance(value, dict):
        return {
            "white_kingside": value.get("white_kingside") is True,
            "white_queenside": value.get("white_queenside") is True,
            "black_kingside": value.get("black_kingside") is True,
            "black_queenside": value.get("black_queenside") is True,
        }
    raise RunnerError(f"engine returned invalid castling rights {value!r}")


def normalized_state(state: Any, revision: int | None = None) -> dict[str, Any]:
    if not isinstance(state, dict):
        raise RunnerError("engine state is not an object")
    result: dict[str, Any] = {}
    for field in STATE_FIELDS:
        if field == "revision" and field not in state and revision is not None:
            result[field] = revision
            continue
        if field not in state:
            raise RunnerError(f"engine state is missing {field}")
        value = state[field]
        if field == "castling_rights":
            result[field] = castling_rights(value)
        elif field == "claimable_draws":
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                raise RunnerError("engine state claimable_draws is invalid")
            result[field] = sorted(value)
        elif field == "repetition_counts":
            if not isinstance(value, dict) or not all(isinstance(count, int) for count in value.values()):
                raise RunnerError("engine state repetition_counts is invalid")
            result[field] = sorted(value.values())
        else:
            result[field] = value
    return result


def board_fen(board: Any) -> str:
    if not isinstance(board, list) or len(board) != 64:
        raise RunnerError("engine board is not a 64-cell array")
    ranks: list[str] = []
    for rank in range(7, -1, -1):
        row = ""
        empty = 0
        for file in range(8):
            piece = board[rank * 8 + file]
            if piece is None:
                empty += 1
                continue
            if not isinstance(piece, dict):
                raise RunnerError("engine board contains an invalid piece")
            letter = PIECE_LETTERS.get((piece.get("color"), piece.get("type")))
            if letter is None:
                raise RunnerError("engine board contains an unknown piece")
            if empty:
                row += str(empty)
                empty = 0
            row += letter
        if empty:
            row += str(empty)
        ranks.append(row)
    return "/".join(ranks)


def effective_position_key(state: Mapping[str, Any], legal_moves: Sequence[str]) -> str:
    rights = castling_rights(state.get("castling_rights"))
    rights_text = "".join(
        name
        for name, key in (
            ("K", "white_kingside"),
            ("Q", "white_queenside"),
            ("k", "black_kingside"),
            ("q", "black_queenside"),
        )
        if rights[key]
    ) or "-"
    side = state.get("side_to_move")
    if side not in ("white", "black"):
        raise RunnerError("engine state side_to_move is invalid")
    raw_ep = state.get("en_passant_target")
    effective_ep = "-"
    if isinstance(raw_ep, str):
        for move in legal_moves:
            if (
                isinstance(move, str)
                and len(move) >= 4
                and move[2:4] == raw_ep
                and move[0] != move[2]
            ):
                source_file = ord(move[0]) - ord("a")
                source_rank = int(move[1]) - 1
                source = state["board"][source_rank * 8 + source_file]
                if isinstance(source, dict) and source.get("type") == "pawn":
                    effective_ep = raw_ep
                    break
    return " ".join(
        (
            board_fen(state["board"]),
            "w" if side == "white" else "b",
            rights_text,
            effective_ep,
        )
    )


def compare_values(expected: Any, actual: Any) -> dict[str, dict[str, Any]]:
    if expected == actual:
        return {}
    if not isinstance(expected, dict) or not isinstance(actual, dict):
        return {"value": {"expected": expected, "actual": actual}}
    fields = set(expected) | set(actual)
    return {
        field: {"expected": expected.get(field), "actual": actual.get(field)}
        for field in sorted(fields)
        if expected.get(field) != actual.get(field)
    }


def checkpoint_result(
    expected_checkpoint: Mapping[str, Any],
    responses: Sequence[Mapping[str, Any]],
    ply: int,
) -> dict[str, Any]:
    expected_state = normalized_state(expected_checkpoint["state"])
    expected_key = expected_checkpoint.get("position_key")
    if not isinstance(expected_key, str):
        raise RunnerError(f"expected checkpoint {ply} is missing position_key")
    state_response_index = 0 if ply == 0 else 2 * ply
    legal_response_index = state_response_index + 1
    state_response = responses[state_response_index]
    legal_response = responses[legal_response_index]
    if state_response.get("ok") is not True or not isinstance(state_response.get("state"), dict):
        raise RunnerError(f"engine did not return state at ply {ply}")
    if legal_response.get("ok") is not True or not isinstance(legal_response.get("moves"), list):
        raise RunnerError(f"engine did not return legal moves at ply {ply}")
    actual_state = normalized_state(state_response["state"], revision=ply)
    legal_moves = sorted(move for move in legal_response["moves"] if isinstance(move, str))
    actual_key = effective_position_key(state_response["state"], legal_moves)
    state_mismatches = compare_values(expected_state, actual_state)
    key_mismatch = {} if actual_key == expected_key else {"position_key": {"expected": expected_key, "actual": actual_key}}
    return {
        "position_key": actual_key,
        "state": actual_state,
        "legal_moves": legal_moves,
        "matches_expected": not state_mismatches and not key_mismatch,
        "mismatches": {**state_mismatches, **key_mismatch},
    }


def build_fixture_report(
    fixture_id: str,
    replay: Mapping[str, Any],
    expected: Mapping[str, Any],
    engine_commands: Sequence[tuple[str, list[str]]],
    timeout: float,
) -> dict[str, Any]:
    requests = fixture_requests(replay)
    checkpoints = expected.get("checkpoints")
    if not isinstance(checkpoints, list):
        raise RunnerError(f"fixture {fixture_id} expected checkpoints are invalid")
    by_ply = {checkpoint.get("ply"): checkpoint for checkpoint in checkpoints if isinstance(checkpoint, dict)}
    moves = replay.get("moves")
    if not isinstance(moves, list):
        raise RunnerError(f"fixture {fixture_id} moves are invalid")
    if set(by_ply) != set(range(len(moves) + 1)):
        raise RunnerError(f"fixture {fixture_id} expected checkpoints are not complete")
    engine_outputs: dict[str, list[Mapping[str, Any]]] = {}
    diagnostics: dict[str, str] = {}
    errors: dict[str, str] = {}
    for name, command in engine_commands:
        session: EngineSession | None = None
        try:
            session = EngineSession(name, command, timeout)
            engine_outputs[name] = session.send_case({"id": fixture_id, "requests": requests})
        except RunnerError as exc:
            errors[name] = str(exc)
            engine_outputs[name] = []
        finally:
            diagnostics[name] = session.close() if session is not None else ""

    checkpoint_reports: list[dict[str, Any]] = []
    mismatch_count = 0
    for ply in range(len(moves) + 1):
        expected_checkpoint = by_ply[ply]
        per_engine: dict[str, Any] = {}
        for name, _ in engine_commands:
            if name in errors:
                per_engine[name] = {"matches_expected": False, "error": errors[name]}
                continue
            try:
                result = checkpoint_result(expected_checkpoint, engine_outputs[name], ply)
            except RunnerError as exc:
                result = {"matches_expected": False, "error": str(exc)}
            per_engine[name] = result
            mismatch_count += 0 if result.get("matches_expected") else 1
        comparable = [
            (name, result)
            for name, result in per_engine.items()
            if "state" in result and "position_key" in result
        ]
        agreement = all(result["state"] == comparable[0][1]["state"] and result["position_key"] == comparable[0][1]["position_key"] for _, result in comparable[1:]) if comparable else False
        if not agreement and len(comparable) > 1:
            mismatch_count += 1
        checkpoint_reports.append({
            "ply": ply,
            "expected_position_key": expected_checkpoint["position_key"],
            "engines": per_engine,
            "engines_agree": agreement,
        })
    return {
        "id": fixture_id,
        "move_count": len(moves),
        "ok": mismatch_count == 0 and not errors,
        "diagnostics": diagnostics,
        "errors": errors,
        "checkpoints": checkpoint_reports,
        "mismatch_count": mismatch_count,
    }


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "reports" / "replay-conformance.json")
    parser.add_argument("--case", action="append", dest="case_ids", default=[])
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--python", dest="python_command")
    parser.add_argument("--c", dest="c_command")
    parser.add_argument("--typescript", dest="typescript_command")
    parser.add_argument("--rust", dest="rust_command")
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    commands = (
        ("python", args.python_command or f"{shlex.quote(sys.executable)} python/chess_cpu.py"),
        ("c", args.c_command or "build/chess_c"),
        ("typescript", args.typescript_command or "node --experimental-strip-types typescript/chess_cpu.ts"),
        ("rust", args.rust_command or "build/chess_rust"),
    )
    try:
        args.engines = [(name, parse_command(command)) for name, command in commands]
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    corpus = load_json(CASES_PATH)
    if not isinstance(corpus, dict) or corpus.get("schema_version") not in (None, 1):
        raise RunnerError("replay case index has an unsupported schema")
    cases = corpus.get("cases")
    if not isinstance(cases, list):
        raise RunnerError("replay case index has no cases")
    selected = set(args.case_ids)
    known = {case.get("id") for case in cases if isinstance(case, dict)}
    unknown = selected - known
    if unknown:
        raise RunnerError(f"unknown replay fixture ids: {', '.join(sorted(unknown))}")
    fixture_reports: list[dict[str, Any]] = []
    skipped_invalid: list[str] = []
    for case in cases:
        if not isinstance(case, dict) or (selected and case.get("id") not in selected):
            continue
        fixture_id = case.get("id")
        if not isinstance(fixture_id, str):
            raise RunnerError("replay case has no id")
        replay_path = FIXTURE_DIR / f"{fixture_id}.json"
        expected_path = FIXTURE_DIR / f"{fixture_id}.expected.json"
        replay = load_json(replay_path)
        expected = load_json(expected_path)
        if not isinstance(expected, dict) or expected.get("valid") is not True:
            skipped_invalid.append(fixture_id)
            continue
        if not isinstance(replay, dict):
            raise RunnerError(f"fixture {fixture_id} is not an object")
        fixture_reports.append(build_fixture_report(fixture_id, replay, expected, args.engines, args.timeout))
    mismatches = sum(report["mismatch_count"] for report in fixture_reports)
    report = {
        "schema_version": 1,
        "kind": "replay-conformance",
        "oracle": "shared/replay-fixtures/*.expected.json (independent Python fixture generation)",
        "ruleset": "orthodox-chess-v1",
        "engines": [{"name": name, "command": command} for name, command in args.engines],
        "fixtures": fixture_reports,
        "skipped_invalid_fixtures": skipped_invalid,
        "summary": {
            "fixture_count": len(fixture_reports),
            "checkpoint_count": sum(len(report["checkpoints"]) for report in fixture_reports),
            "mismatch_count": mismatches,
            "failed_fixture_count": sum(not report["ok"] for report in fixture_reports),
            "ok": mismatches == 0 and all(report["ok"] for report in fixture_reports),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], sort_keys=True))
    return 0 if report["summary"]["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RunnerError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
