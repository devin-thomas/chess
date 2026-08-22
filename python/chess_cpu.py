#!/usr/bin/env python3
"""Dependency-free orthodox chess engine and JSON Lines command line interface.

The public protocol is documented in ``docs/PROTOCOL.md``.  The module keeps
the game model separate from the JSONL adapter so tests can exercise the same
rules without starting a subprocess.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from typing import Any, Optional


MASK_64 = (1 << 64) - 1
SPLITMIX_INCREMENT = 0x9E3779B97F4A7C15
SPLITMIX_MULTIPLIER_1 = 0xBF58476D1CE4E5B9
SPLITMIX_MULTIPLIER_2 = 0x94D049BB133111EB

FILES = "abcdefgh"
FEN_KINDS = "pnbrqk"
PROMOTION_ORDER = {"q": 0, "r": 1, "b": 2, "n": 3}
TYPE_NAMES = {
    "p": "pawn",
    "n": "knight",
    "b": "bishop",
    "r": "rook",
    "q": "queen",
    "k": "king",
}

KNIGHT_STEPS = (
    (1, 2),
    (2, 1),
    (2, -1),
    (1, -2),
    (-1, -2),
    (-2, -1),
    (-2, 1),
    (-1, 2),
)
KING_STEPS = (
    (1, 1),
    (1, 0),
    (1, -1),
    (0, -1),
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, 1),
)
ORTHOGONAL_STEPS = ((1, 0), (-1, 0), (0, 1), (0, -1))
DIAGONAL_STEPS = ((1, 1), (1, -1), (-1, 1), (-1, -1))


class ProtocolError(Exception):
    """An expected request or position error with a stable protocol code."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


@dataclass(frozen=True, slots=True)
class Piece:
    color: str
    kind: str

    @property
    def type(self) -> str:
        """Alias useful to callers that model the protocol's ``type`` field."""

        return self.kind


@dataclass(frozen=True, slots=True)
class Move:
    source: int
    target: int
    promotion: Optional[str] = None

    def uci(self) -> str:
        suffix = self.promotion or ""
        return square_name(self.source) + square_name(self.target) + suffix


@dataclass(slots=True)
class Position:
    board: list[Optional[Piece]]
    side_to_move: str
    castling_rights: set[str]
    en_passant_target: Optional[int]
    halfmove_clock: int
    fullmove_number: int

    def copy(self) -> "Position":
        return Position(
            self.board.copy(),
            self.side_to_move,
            self.castling_rights.copy(),
            self.en_passant_target,
            self.halfmove_clock,
            self.fullmove_number,
        )


def opposite(color: str) -> str:
    return "black" if color == "white" else "white"


def square_index(value: str) -> int:
    if not isinstance(value, str) or len(value) != 2:
        raise ValueError(value)
    file_index = FILES.find(value[0])
    if file_index < 0 or value[1] not in "12345678":
        raise ValueError(value)
    return (ord(value[1]) - ord("1")) * 8 + file_index


def square_name(index: int) -> str:
    return FILES[index % 8] + str(index // 8 + 1)


def coordinates(index: int) -> tuple[int, int]:
    return index % 8, index // 8


def on_board(file_index: int, rank_index: int) -> bool:
    return 0 <= file_index < 8 and 0 <= rank_index < 8


def index_at(file_index: int, rank_index: int) -> int:
    return rank_index * 8 + file_index


def initial_position() -> Position:
    board: list[Optional[Piece]] = [None] * 64
    back_rank = ("r", "n", "b", "q", "k", "b", "n", "r")
    for file_index, kind in enumerate(back_rank):
        board[index_at(file_index, 0)] = Piece("white", kind)
        board[index_at(file_index, 1)] = Piece("white", "p")
        board[index_at(file_index, 6)] = Piece("black", "p")
        board[index_at(file_index, 7)] = Piece("black", kind)
    return Position(board, "white", set("KQkq"), None, 0, 1)


def castling_text(rights: set[str]) -> str:
    value = "".join(letter for letter in "KQkq" if letter in rights)
    return value or "-"


def piece_to_fen(piece: Piece) -> str:
    return piece.kind.upper() if piece.color == "white" else piece.kind


def board_fen(board: list[Optional[Piece]]) -> str:
    ranks: list[str] = []
    for rank_index in range(7, -1, -1):
        empty = 0
        fields: list[str] = []
        for file_index in range(8):
            piece = board[index_at(file_index, rank_index)]
            if piece is None:
                empty += 1
            else:
                if empty:
                    fields.append(str(empty))
                    empty = 0
                fields.append(piece_to_fen(piece))
        if empty:
            fields.append(str(empty))
        ranks.append("".join(fields))
    return "/".join(ranks)


def position_fen(position: Position) -> str:
    ep = square_name(position.en_passant_target) if position.en_passant_target is not None else "-"
    return " ".join(
        (
            board_fen(position.board),
            "w" if position.side_to_move == "white" else "b",
            castling_text(position.castling_rights),
            ep,
            str(position.halfmove_clock),
            str(position.fullmove_number),
        )
    )


def _fen_piece(character: str) -> Piece:
    kind = character.lower()
    if kind not in FEN_KINDS:
        raise ProtocolError("E_INVALID_FEN", f"invalid FEN piece: {character}")
    return Piece("white" if character.isupper() else "black", kind)


def parse_fen(value: str) -> Position:
    """Parse a standard six-field FEN, accepting ``startpos`` as a convenience."""

    if value == "startpos":
        return initial_position()
    if not isinstance(value, str):
        raise ProtocolError("E_INVALID_FEN", "fen must be a string")
    fields = value.split()
    if len(fields) == 4:
        fields.extend(("0", "1"))
    elif len(fields) == 5:
        fields.append("1")
    if len(fields) != 6:
        raise ProtocolError("E_INVALID_FEN", "fen must have four, five, or six fields")

    board_field, side_field, rights_field, ep_field, halfmove_field, fullmove_field = fields
    ranks = board_field.split("/")
    if len(ranks) != 8:
        raise ProtocolError("E_INVALID_FEN", "fen board must have eight ranks")

    board: list[Optional[Piece]] = [None] * 64
    for fen_rank, rank_text in enumerate(ranks):
        rank_index = 7 - fen_rank
        file_index = 0
        for character in rank_text:
            if character in "12345678":
                file_index += int(character)
            elif character in "PNBRQKpnbrqk":
                if file_index >= 8:
                    raise ProtocolError("E_INVALID_FEN", "fen rank contains too many squares")
                board[index_at(file_index, rank_index)] = _fen_piece(character)
                file_index += 1
            else:
                raise ProtocolError("E_INVALID_FEN", f"invalid FEN board character: {character}")
        if file_index != 8:
            raise ProtocolError("E_INVALID_FEN", "fen rank does not contain eight squares")

    if side_field not in ("w", "b"):
        raise ProtocolError("E_INVALID_FEN", "fen side-to-move must be w or b")

    if rights_field == "-":
        rights: set[str] = set()
    elif rights_field and all(letter in "KQkq" for letter in rights_field) and len(set(rights_field)) == len(rights_field):
        rights = set(rights_field)
    else:
        raise ProtocolError("E_INVALID_FEN", "invalid FEN castling rights")

    if ep_field == "-":
        en_passant_target = None
    else:
        try:
            en_passant_target = square_index(ep_field)
        except ValueError:
            raise ProtocolError("E_INVALID_FEN", "invalid FEN en-passant square") from None
        if ep_field[1] not in "36":
            raise ProtocolError("E_INVALID_FEN", "FEN en-passant square must be on rank 3 or 6")

    try:
        halfmove_clock = int(halfmove_field, 10)
        fullmove_number = int(fullmove_field, 10)
    except ValueError:
        raise ProtocolError("E_INVALID_FEN", "FEN move counters must be integers") from None
    if halfmove_clock < 0 or fullmove_number < 1:
        raise ProtocolError("E_INVALID_FEN", "FEN move counters are out of range")

    position = Position(
        board,
        "white" if side_field == "w" else "black",
        rights,
        en_passant_target,
        halfmove_clock,
        fullmove_number,
    )
    white_king = find_king(board, "white")
    black_king = find_king(board, "black")
    if white_king is None or black_king is None:
        raise ProtocolError("E_INVALID_FEN", "FEN must contain exactly one king per side")
    if any(piece is not None and piece.kind == "p" and index // 8 in (0, 7) for index, piece in enumerate(board)):
        raise ProtocolError("E_INVALID_FEN", "FEN cannot place a pawn on the first or eighth rank")
    white_file, white_rank = coordinates(white_king)
    black_file, black_rank = coordinates(black_king)
    if max(abs(white_file - black_file), abs(white_rank - black_rank)) <= 1:
        raise ProtocolError("E_INVALID_FEN", "FEN kings cannot be adjacent")
    white_attacks_black = is_square_attacked(board, black_king, "white")
    black_attacks_white = is_square_attacked(board, white_king, "black")
    if white_attacks_black and black_attacks_white:
        raise ProtocolError("E_INVALID_FEN", "FEN cannot have both kings in check")
    if position.side_to_move == "white" and white_attacks_black:
        raise ProtocolError("E_INVALID_FEN", "the non-moving king cannot be in check")
    if position.side_to_move == "black" and black_attacks_white:
        raise ProtocolError("E_INVALID_FEN", "the non-moving king cannot be in check")
    return position


def find_king(board: list[Optional[Piece]], color: str) -> Optional[int]:
    for index, piece in enumerate(board):
        if piece is not None and piece.color == color and piece.kind == "k":
            return index
    return None


def is_square_attacked(board: list[Optional[Piece]], target: int, by_color: str) -> bool:
    """Return raw attack status; pinned pieces still attack for king-safety rules."""

    target_file, target_rank = coordinates(target)

    pawn_source_rank = target_rank - 1 if by_color == "white" else target_rank + 1
    if 0 <= pawn_source_rank < 8:
        for source_file in (target_file - 1, target_file + 1):
            if 0 <= source_file < 8:
                piece = board[index_at(source_file, pawn_source_rank)]
                if piece is not None and piece.color == by_color and piece.kind == "p":
                    return True

    for file_delta, rank_delta in KNIGHT_STEPS:
        source_file = target_file + file_delta
        source_rank = target_rank + rank_delta
        if on_board(source_file, source_rank):
            piece = board[index_at(source_file, source_rank)]
            if piece is not None and piece.color == by_color and piece.kind == "n":
                return True

    for file_delta, rank_delta in KING_STEPS:
        source_file = target_file + file_delta
        source_rank = target_rank + rank_delta
        if on_board(source_file, source_rank):
            piece = board[index_at(source_file, source_rank)]
            if piece is not None and piece.color == by_color and piece.kind == "k":
                return True

    for file_delta, rank_delta in ORTHOGONAL_STEPS:
        source_file, source_rank = target_file + file_delta, target_rank + rank_delta
        while on_board(source_file, source_rank):
            piece = board[index_at(source_file, source_rank)]
            if piece is not None:
                if piece.color == by_color and piece.kind in ("r", "q"):
                    return True
                break
            source_file += file_delta
            source_rank += rank_delta

    for file_delta, rank_delta in DIAGONAL_STEPS:
        source_file, source_rank = target_file + file_delta, target_rank + rank_delta
        while on_board(source_file, source_rank):
            piece = board[index_at(source_file, source_rank)]
            if piece is not None:
                if piece.color == by_color and piece.kind in ("b", "q"):
                    return True
                break
            source_file += file_delta
            source_rank += rank_delta
    return False


def in_check(position: Position, color: str) -> bool:
    king = find_king(position.board, color)
    return king is None or is_square_attacked(position.board, king, opposite(color))


def move_sort_key(move: Move) -> tuple[int, int, int]:
    return (move.source, move.target, PROMOTION_ORDER.get(move.promotion or "", 99))


def is_en_passant_move(position: Position, move: Move) -> bool:
    piece = position.board[move.source]
    if piece is None or piece.kind != "p" or position.en_passant_target != move.target:
        return False
    if position.board[move.target] is not None:
        return False
    source_file, source_rank = coordinates(move.source)
    target_file, target_rank = coordinates(move.target)
    direction = 1 if piece.color == "white" else -1
    if target_rank - source_rank != direction or abs(target_file - source_file) != 1:
        return False
    captured_square = move.target - 8 if piece.color == "white" else move.target + 8
    captured = position.board[captured_square]
    return captured is not None and captured.color == opposite(piece.color) and captured.kind == "p"


def _remove_right_for_rook_square(rights: set[str], square: int) -> None:
    rights.discard({0: "Q", 7: "K", 56: "q", 63: "k"}.get(square, ""))


def apply_unchecked(position: Position, move: Move) -> Position:
    """Apply a move already known to be pseudo-legal without terminal checks."""

    piece = position.board[move.source]
    if piece is None:
        raise ValueError("cannot apply a move from an empty square")
    board = position.board.copy()
    rights = position.castling_rights.copy()
    captured = board[move.target]
    is_ep = is_en_passant_move(position, move)
    if is_ep:
        captured_square = move.target - 8 if piece.color == "white" else move.target + 8
        captured = board[captured_square]
        board[captured_square] = None

    board[move.source] = None
    board[move.target] = Piece(piece.color, move.promotion) if move.promotion else piece

    source_file, source_rank = coordinates(move.source)
    target_file, target_rank = coordinates(move.target)
    is_castle = piece.kind == "k" and source_rank == target_rank and abs(target_file - source_file) == 2
    if is_castle:
        if target_file == 6:
            rook_source, rook_target = index_at(7, source_rank), index_at(5, source_rank)
        else:
            rook_source, rook_target = index_at(0, source_rank), index_at(3, source_rank)
        board[rook_target] = board[rook_source]
        board[rook_source] = None

    if piece.kind == "k":
        rights.discard("K" if piece.color == "white" else "k")
        rights.discard("Q" if piece.color == "white" else "q")
    elif piece.kind == "r":
        _remove_right_for_rook_square(rights, move.source)
    if captured is not None and captured.kind == "r":
        _remove_right_for_rook_square(rights, move.target)

    en_passant_target = None
    if piece.kind == "p" and abs(target_rank - source_rank) == 2:
        en_passant_target = index_at(source_file, (source_rank + target_rank) // 2)
    is_capture = captured is not None
    halfmove_clock = 0 if piece.kind == "p" or is_capture else position.halfmove_clock + 1
    return Position(
        board,
        opposite(position.side_to_move),
        rights,
        en_passant_target,
        halfmove_clock,
        position.fullmove_number + (1 if piece.color == "black" else 0),
    )


def _append_pawn_moves(position: Position, source: int, moves: list[Move]) -> None:
    piece = position.board[source]
    assert piece is not None and piece.kind == "p"
    source_file, source_rank = coordinates(source)
    direction = 1 if piece.color == "white" else -1
    final_rank = 7 if piece.color == "white" else 0

    one_rank = source_rank + direction
    if on_board(source_file, one_rank):
        one = index_at(source_file, one_rank)
        if position.board[one] is None:
            if one_rank == final_rank:
                moves.extend(Move(source, one, promotion) for promotion in PROMOTION_ORDER)
            else:
                moves.append(Move(source, one))
            start_rank = 1 if piece.color == "white" else 6
            two_rank = source_rank + 2 * direction
            if source_rank == start_rank and position.board[index_at(source_file, two_rank)] is None:
                moves.append(Move(source, index_at(source_file, two_rank)))

    capture_rank = source_rank + direction
    if not 0 <= capture_rank < 8:
        return
    for target_file in (source_file - 1, source_file + 1):
        if not 0 <= target_file < 8:
            continue
        target = index_at(target_file, capture_rank)
        target_piece = position.board[target]
        if target_piece is not None and target_piece.color != piece.color and target_piece.kind != "k":
            if capture_rank == final_rank:
                moves.extend(Move(source, target, promotion) for promotion in PROMOTION_ORDER)
            else:
                moves.append(Move(source, target))
        elif target_piece is None and position.en_passant_target == target:
            candidate = Move(source, target)
            if is_en_passant_move(position, candidate):
                moves.append(candidate)


def _append_sliding_moves(
    position: Position,
    source: int,
    moves: list[Move],
    directions: tuple[tuple[int, int], ...],
) -> None:
    piece = position.board[source]
    assert piece is not None
    source_file, source_rank = coordinates(source)
    for file_delta, rank_delta in directions:
        target_file, target_rank = source_file + file_delta, source_rank + rank_delta
        while on_board(target_file, target_rank):
            target = index_at(target_file, target_rank)
            target_piece = position.board[target]
            if target_piece is None:
                moves.append(Move(source, target))
            else:
                if target_piece.color != piece.color and target_piece.kind != "k":
                    moves.append(Move(source, target))
                break
            target_file += file_delta
            target_rank += rank_delta


def castle_basic_available(position: Position, move: Move) -> bool:
    piece = position.board[move.source]
    if piece is None or piece.kind != "k" or piece.color != position.side_to_move:
        return False
    source_file, source_rank = coordinates(move.source)
    target_file, target_rank = coordinates(move.target)
    if source_file != 4 or target_rank != source_rank or target_file not in (2, 6):
        return False
    if source_rank == 0:
        right = "K" if target_file == 6 else "Q"
        rook_square = index_at(7 if target_file == 6 else 0, 0)
    elif source_rank == 7:
        right = "k" if target_file == 6 else "q"
        rook_square = index_at(7 if target_file == 6 else 0, 7)
    else:
        return False
    if right not in position.castling_rights:
        return False
    rook = position.board[rook_square]
    if rook is None or rook.color != piece.color or rook.kind != "r":
        return False
    path_files = (5, 6) if target_file == 6 else (1, 2, 3)
    return all(position.board[index_at(file_index, source_rank)] is None for file_index in path_files)


def castle_is_safe(position: Position, move: Move) -> bool:
    if not castle_basic_available(position, move):
        return False
    color = position.side_to_move
    enemy = opposite(color)
    if in_check(position, color):
        return False
    source_file, source_rank = coordinates(move.source)
    target_file, _ = coordinates(move.target)
    transit_file = 5 if target_file == 6 else 3
    for file_index in (transit_file, target_file):
        transit_position = position.copy()
        transit_position.board[move.source] = None
        transit_position.board[index_at(file_index, source_rank)] = Piece(color, "k")
        if is_square_attacked(transit_position.board, index_at(file_index, source_rank), enemy):
            return False
    return True


def generate_pseudo_moves(position: Position, include_attacked_castles: bool = False) -> list[Move]:
    moves: list[Move] = []
    color = position.side_to_move
    for source, piece in enumerate(position.board):
        if piece is None or piece.color != color:
            continue
        source_file, source_rank = coordinates(source)
        if piece.kind == "p":
            _append_pawn_moves(position, source, moves)
        elif piece.kind == "n":
            for file_delta, rank_delta in KNIGHT_STEPS:
                target_file, target_rank = source_file + file_delta, source_rank + rank_delta
                if not on_board(target_file, target_rank):
                    continue
                target = index_at(target_file, target_rank)
                target_piece = position.board[target]
                if target_piece is None or (target_piece.color != color and target_piece.kind != "k"):
                    moves.append(Move(source, target))
        elif piece.kind == "b":
            _append_sliding_moves(position, source, moves, DIAGONAL_STEPS)
        elif piece.kind == "r":
            _append_sliding_moves(position, source, moves, ORTHOGONAL_STEPS)
        elif piece.kind == "q":
            _append_sliding_moves(position, source, moves, ORTHOGONAL_STEPS + DIAGONAL_STEPS)
        elif piece.kind == "k":
            for file_delta, rank_delta in KING_STEPS:
                target_file, target_rank = source_file + file_delta, source_rank + rank_delta
                if not on_board(target_file, target_rank):
                    continue
                target = index_at(target_file, target_rank)
                target_piece = position.board[target]
                if target_piece is None or (target_piece.color != color and target_piece.kind != "k"):
                    moves.append(Move(source, target))
            for target_file in (2, 6):
                castle = Move(source, index_at(target_file, source_rank))
                if castle_basic_available(position, castle) and (
                    include_attacked_castles or castle_is_safe(position, castle)
                ):
                    moves.append(castle)
    return moves


def generate_legal_moves(position: Position) -> list[Move]:
    color = position.side_to_move
    legal: list[Move] = []
    for move in generate_pseudo_moves(position):
        candidate = apply_unchecked(position, move)
        if not in_check(candidate, color):
            legal.append(move)
    return sorted(legal, key=move_sort_key)


def effective_en_passant_target(position: Position) -> Optional[int]:
    if position.en_passant_target is None:
        return None
    if any(is_en_passant_move(position, move) for move in generate_legal_moves(position)):
        return position.en_passant_target
    return None


def position_key(position: Position) -> str:
    effective = effective_en_passant_target(position)
    ep = square_name(effective) if effective is not None else "-"
    return " ".join(
        (
            board_fen(position.board),
            "w" if position.side_to_move == "white" else "b",
            castling_text(position.castling_rights),
            ep,
        )
    )


def is_dead_position(position: Position) -> bool:
    """Recognize only material classes that cannot possibly produce mate."""

    non_kings = [piece for piece in position.board if piece is not None and piece.kind != "k"]
    if any(piece.kind in ("p", "r", "q") for piece in non_kings):
        return False
    return len(non_kings) <= 1


def _result_for_winner(color: str) -> str:
    return "1-0" if color == "white" else "0-1"


class SplitMix64:
    """The exact unsigned SplitMix64 generator required by the protocol."""

    def __init__(self, seed: int = 1) -> None:
        self.state = seed & MASK_64

    def next_uint64(self) -> int:
        self.state = (self.state + SPLITMIX_INCREMENT) & MASK_64
        value = self.state
        value = ((value ^ (value >> 30)) * SPLITMIX_MULTIPLIER_1) & MASK_64
        value = ((value ^ (value >> 27)) * SPLITMIX_MULTIPLIER_2) & MASK_64
        return (value ^ (value >> 31)) & MASK_64

    def next(self) -> int:
        return self.next_uint64()


class Game:
    """Mutable session model; all state changes pass through ``commit``."""

    def __init__(self, mode: str = "all-rules-enabled", position: Optional[Position] = None, seed: int = 1) -> None:
        if mode not in ("basic", "all-rules-enabled"):
            raise ProtocolError("E_INVALID_REQUEST", "mode must be basic or all-rules-enabled")
        self.mode = mode
        self.position = (position or initial_position()).copy()
        self.seed = seed & MASK_64
        self.moves: list[str] = []
        self.repetition_counts: dict[str, int] = {}
        if self.mode == "all-rules-enabled":
            self.repetition_counts[position_key(self.position)] = 1
        self.status = "active"
        self.check: Optional[str] = None
        self.outcome: Optional[dict[str, Any]] = None
        self.claimable_draws: list[str] = []
        self.refresh()

    def raw_legal_moves(self) -> list[Move]:
        return generate_legal_moves(self.position)

    def legal_moves(self) -> list[Move]:
        if self.status != "active":
            return []
        return self.raw_legal_moves()

    def refresh(self) -> None:
        side = self.position.side_to_move
        self.check = side if in_check(self.position, side) else None
        legal = self.raw_legal_moves()
        self.outcome = None
        if not legal:
            if self.check is not None:
                winner = opposite(side)
                self.outcome = {
                    "reason": "checkmate",
                    "result": _result_for_winner(winner),
                    "winner": winner,
                }
            else:
                self.outcome = {"reason": "stalemate", "result": "1/2-1/2"}
        elif is_dead_position(self.position):
            self.outcome = {"reason": "dead_position", "result": "1/2-1/2"}
        elif self.mode == "all-rules-enabled":
            current_key = position_key(self.position)
            if self.repetition_counts.get(current_key, 0) >= 5:
                self.outcome = {"reason": "fivefold_repetition", "result": "1/2-1/2"}
            elif self.position.halfmove_clock >= 150:
                self.outcome = {"reason": "seventy_five_move", "result": "1/2-1/2"}
        self.status = "terminal" if self.outcome is not None else "active"
        self.claimable_draws = self._compute_claimable_draws() if self.status == "active" else []

    def _compute_claimable_draws(self) -> list[str]:
        if self.mode != "all-rules-enabled":
            return []
        claimable: list[str] = []
        current_key = position_key(self.position)
        if self.repetition_counts.get(current_key, 0) >= 3:
            claimable.append("threefold_repetition")
        if self.position.halfmove_clock >= 100:
            claimable.append("fifty_move")

        legal = self.raw_legal_moves()
        for move in legal:
            candidate = apply_unchecked(self.position, move)
            if "threefold_repetition" not in claimable:
                if self.repetition_counts.get(position_key(candidate), 0) + 1 >= 3:
                    claimable.append("threefold_repetition")
            if "fifty_move" not in claimable and candidate.halfmove_clock >= 100:
                claimable.append("fifty_move")
            if len(claimable) == 2:
                break
        return claimable

    def commit(self, move: Move) -> None:
        self.position = apply_unchecked(self.position, move)
        self.moves.append(move.uci())
        if self.mode == "all-rules-enabled":
            key = position_key(self.position)
            self.repetition_counts[key] = self.repetition_counts.get(key, 0) + 1
        self.refresh()

    def state_dict(self) -> dict[str, Any]:
        board: list[Optional[dict[str, str]]] = []
        for piece in self.position.board:
            board.append(None if piece is None else {"color": piece.color, "type": TYPE_NAMES[piece.kind]})
        return {
            "mode": self.mode,
            "board": board,
            "side_to_move": self.position.side_to_move,
            "castling_rights": castling_text(self.position.castling_rights),
            "en_passant_target": (
                square_name(self.position.en_passant_target)
                if self.position.en_passant_target is not None
                else None
            ),
            "halfmove_clock": self.position.halfmove_clock,
            "fullmove_number": self.position.fullmove_number,
            "status": self.status,
            "check": self.check,
            "outcome": self.outcome,
            "claimable_draws": self.claimable_draws.copy(),
            "repetition_counts": (
                self.repetition_counts.copy() if self.mode == "all-rules-enabled" else {}
            ),
            "moves": self.moves.copy(),
        }


def parse_mode(value: Any, default: str = "all-rules-enabled") -> str:
    mode = default if value is None else value
    if mode not in ("basic", "all-rules-enabled"):
        raise ProtocolError("E_INVALID_REQUEST", "mode must be basic or all-rules-enabled")
    return mode


def parse_seed(value: Any, default: int = 1) -> int:
    if value is None:
        return default & MASK_64
    if isinstance(value, bool):
        raise ProtocolError("E_INVALID_REQUEST", "seed must be a decimal integer or string")
    if isinstance(value, int):
        return value & MASK_64
    if isinstance(value, str) and re.fullmatch(r"[+-]?\d+", value):
        return int(value, 10) & MASK_64
    raise ProtocolError("E_INVALID_REQUEST", "seed must be a decimal integer or string")


def parse_nonnegative_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ProtocolError("E_INVALID_REQUEST", f"{field} must be a non-negative integer")
    return value


def parse_uci(value: Any) -> Move:
    if not isinstance(value, str) or not re.fullmatch(r"[a-h][1-8][a-h][1-8][qrbn]?", value):
        raise ProtocolError("E_INVALID_MOVE_SYNTAX", "move must use lowercase coordinate notation")
    try:
        source = square_index(value[:2])
        target = square_index(value[2:4])
    except ValueError:
        raise ProtocolError("E_INVALID_MOVE_SYNTAX", "move contains an invalid square") from None
    return Move(source, target, value[4] if len(value) == 5 else None)


def _path_is_blocked(position: Position, source: int, target: int) -> bool:
    source_file, source_rank = coordinates(source)
    target_file, target_rank = coordinates(target)
    file_delta = target_file - source_file
    rank_delta = target_rank - source_rank
    step_file = 0 if file_delta == 0 else (1 if file_delta > 0 else -1)
    step_rank = 0 if rank_delta == 0 else (1 if rank_delta > 0 else -1)
    file_steps = abs(file_delta)
    rank_steps = abs(rank_delta)
    if not (file_delta == 0 or rank_delta == 0 or file_steps == rank_steps):
        return False
    file_index, rank_index = source_file + step_file, source_rank + step_rank
    while (file_index, rank_index) != (target_file, target_rank):
        if position.board[index_at(file_index, rank_index)] is not None:
            return True
        file_index += step_file
        rank_index += step_rank
    return False


def _castle_shape(position: Position, move: Move) -> bool:
    piece = position.board[move.source]
    if piece is None or piece.kind != "k":
        return False
    source_file, source_rank = coordinates(move.source)
    target_file, target_rank = coordinates(move.target)
    return source_file == 4 and target_rank == source_rank and target_file in (2, 6)


def _en_passant_shape(position: Position, move: Move) -> bool:
    piece = position.board[move.source]
    if piece is None or piece.kind != "p":
        return False
    source_file, source_rank = coordinates(move.source)
    target_file, target_rank = coordinates(move.target)
    direction = 1 if piece.color == "white" else -1
    return (
        position.en_passant_target == move.target
        and position.board[move.target] is None
        and target_rank - source_rank == direction
        and abs(target_file - source_file) == 1
    )


def validate_move(game: Game, move: Move) -> None:
    position = game.position
    piece = position.board[move.source]
    if piece is None:
        raise ProtocolError("E_EMPTY_SOURCE", "source square is empty")
    if piece.color != position.side_to_move:
        raise ProtocolError("E_WRONG_TURN", "source piece belongs to the other side")
    target_piece = position.board[move.target]
    if target_piece is not None and target_piece.color == piece.color:
        raise ProtocolError("E_OWN_PIECE_ON_DESTINATION", "destination contains a friendly piece")

    target_rank = move.target // 8
    reaches_promotion_rank = piece.kind == "p" and target_rank in (0, 7)
    if reaches_promotion_rank != (move.promotion is not None):
        raise ProtocolError("E_INVALID_PROMOTION", "promotion is mandatory only on the final rank")
    if move.promotion is not None and piece.kind != "p":
        raise ProtocolError("E_INVALID_PROMOTION", "only a pawn may promote")

    legal = game.raw_legal_moves()
    if move in legal:
        return

    if _castle_shape(position, move):
        if not castle_basic_available(position, move):
            raise ProtocolError("E_CASTLE_UNAVAILABLE", "castling rights, rook, or path are unavailable")
        raise ProtocolError("E_CASTLE_THROUGH_CHECK", "the king is in, through, or into check while castling")
    if _en_passant_shape(position, move):
        if is_en_passant_move(position, move):
            raise ProtocolError("E_SELF_CHECK", "en-passant move would leave the king in check")
        raise ProtocolError("E_EN_PASSANT_UNAVAILABLE", "en-passant capture is unavailable")

    pseudo = generate_pseudo_moves(position, include_attacked_castles=True)
    if move in pseudo:
        raise ProtocolError("E_SELF_CHECK", "move would leave the king in check")

    source_file, source_rank = coordinates(move.source)
    target_file, target_rank = coordinates(move.target)
    file_delta = abs(target_file - source_file)
    rank_delta = abs(target_rank - source_rank)
    if piece.kind in ("b", "r", "q") and (
        (piece.kind == "b" and file_delta == rank_delta and file_delta > 0)
        or (piece.kind == "r" and (file_delta == 0) != (rank_delta == 0))
        or (piece.kind == "q" and ((file_delta == rank_delta and file_delta > 0) or (file_delta == 0) != (rank_delta == 0)))
    ) and _path_is_blocked(position, move.source, move.target):
        raise ProtocolError("E_PATH_BLOCKED", "a piece blocks the move path")
    raise ProtocolError("E_ILLEGAL_GEOMETRY", "piece cannot move that way")


def _copy_position_for_root(session: Optional[Game], fen: Any) -> Position:
    if fen is not None:
        return parse_fen(fen)
    if session is not None:
        return session.position.copy()
    return initial_position()


def perft(position: Position, depth: int) -> int:
    if depth == 0:
        return 1
    moves = generate_legal_moves(position)
    if depth == 1:
        return len(moves)
    return sum(perft(apply_unchecked(position, move), depth - 1) for move in moves)


def run_game(mode: str, position: Position, seed: int, max_plies: int, trace: bool) -> dict[str, Any]:
    game = Game(mode, position, seed)
    rng = SplitMix64(seed)
    committed_moves: list[str] = []
    termination = "max_plies"
    while game.status == "active" and len(committed_moves) < max_plies:
        legal = game.raw_legal_moves()
        if not legal:
            break
        selected = legal[rng.next_uint64() % len(legal)]
        game.commit(selected)
        committed_moves.append(selected.uci())
    if game.status == "terminal" and game.outcome is not None:
        termination = game.outcome["reason"]
        result = game.outcome["result"]
    else:
        result = "*"
    return {
        "ok": True,
        "op": "run",
        "seed": str(seed & MASK_64),
        "moves": committed_moves if trace else [],
        "plies": len(committed_moves),
        "termination": termination,
        "result": result,
        "final": game.state_dict(),
    }


def error_response(op: Any, error: ProtocolError, session: Optional[Game]) -> dict[str, Any]:
    error_body: dict[str, Any] = {"code": error.code, "message": error.message}
    if error.details is not None:
        error_body["details"] = error.details
    response: dict[str, Any] = {"ok": False, "op": op, "error": error_body}
    if session is not None:
        response["state"] = session.state_dict()
    return response


def _require_session(session: Optional[Game]) -> Game:
    if session is None:
        raise ProtocolError("E_NO_SESSION", "create a session with the new operation")
    return session


def handle_request(request: Any, session: Optional[Game] = None) -> tuple[dict[str, Any], Optional[Game]]:
    """Handle one decoded request and return ``(response, resulting_session)``."""

    if not isinstance(request, dict):
        return error_response(None, ProtocolError("E_INVALID_REQUEST", "request must be a JSON object"), session), session
    op = request.get("op")
    if not isinstance(op, str):
        return error_response(op, ProtocolError("E_INVALID_REQUEST", "request op must be a string"), session), session

    try:
        if op == "new":
            mode = parse_mode(request.get("mode"))
            seed = parse_seed(request.get("seed"))
            position = parse_fen(request["fen"]) if "fen" in request else initial_position()
            new_session = Game(mode, position, seed)
            return {"ok": True, "op": op, "state": new_session.state_dict()}, new_session

        if op == "state":
            current = _require_session(session)
            return {"ok": True, "op": op, "state": current.state_dict()}, session

        if op == "legal_moves":
            current = _require_session(session)
            moves = [move.uci() for move in current.legal_moves()]
            return {"ok": True, "op": op, "moves": moves}, session

        if op == "play":
            current = _require_session(session)
            if current.status != "active":
                raise ProtocolError("E_GAME_OVER", "the game is already over")
            move = parse_uci(request.get("move"))
            validate_move(current, move)
            current.commit(move)
            return {"ok": True, "op": op, "move": move.uci(), "state": current.state_dict()}, session

        if op == "perft":
            depth = parse_nonnegative_int(request.get("depth"), "depth")
            position = _copy_position_for_root(session, request.get("fen"))
            return {"ok": True, "op": op, "depth": depth, "nodes": perft(position, depth)}, session

        if op == "run":
            mode = parse_mode(request.get("mode"))
            seed = parse_seed(request.get("seed"))
            max_plies = parse_nonnegative_int(request.get("max_plies", 200), "max_plies")
            trace = request.get("trace", True)
            if not isinstance(trace, bool):
                raise ProtocolError("E_INVALID_REQUEST", "trace must be boolean")
            position = parse_fen(request["fen"]) if "fen" in request else initial_position()
            return run_game(mode, position, seed, max_plies, trace), session

        if op == "sample":
            samples = parse_nonnegative_int(request.get("samples"), "samples")
            seed = parse_seed(request.get("seed"))
            position = _copy_position_for_root(session, request.get("fen"))
            legal = generate_legal_moves(position)
            moves = [move.uci() for move in legal]
            counts = {move: 0 for move in moves}
            sequence: list[str] = []
            rng = SplitMix64(seed)
            if legal:
                for _ in range(samples):
                    selected = legal[rng.next_uint64() % len(legal)].uci()
                    sequence.append(selected)
                    counts[selected] += 1
            return {
                "ok": True,
                "op": op,
                "moves": moves,
                "counts": counts,
                "sequence": sequence,
                "samples": samples,
                "seed": str(seed & MASK_64),
            }, session

        raise ProtocolError("E_UNKNOWN_OPERATION", f"unsupported operation: {op}")
    except ProtocolError as error:
        return error_response(op, error, session), session


def main() -> None:
    session: Optional[Game] = None
    for line_number, line in enumerate(sys.stdin, 1):
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            response = error_response(
                None,
                ProtocolError("E_INVALID_REQUEST", f"invalid JSON on line {line_number}: {error.msg}"),
                session,
            )
        else:
            try:
                response, session = handle_request(request, session)
            except Exception as error:  # CLI boundary: preserve JSONL framing and send diagnostics to stderr.
                print(f"internal error on line {line_number}: {error!r}", file=sys.stderr)
                response = error_response(
                    request.get("op") if isinstance(request, dict) else None,
                    ProtocolError("E_INVALID_REQUEST", "internal request handling error"),
                    session,
                )
        print(json.dumps(response, separators=(",", ":"), ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
