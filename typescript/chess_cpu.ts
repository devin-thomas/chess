#!/usr/bin/env node

type Color = "white" | "black";
type PieceType = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn";
type PromotionType = "queen" | "rook" | "bishop" | "knight";
type Mode = "basic" | "all-rules-enabled";
type MoveKind = "normal" | "en_passant" | "castle_kingside" | "castle_queenside";
type TerminalReason = "checkmate" | "stalemate" | "dead_position" | "fivefold_repetition" | "seventy_five_move";

interface Piece {
  color: Color;
  type: PieceType;
}

type Board = Array<Piece | null>;

interface Position {
  board: Board;
  side: Color;
  rights: number;
  ep: number | null;
  halfmove: number;
  fullmove: number;
}

interface Move {
  from: number;
  to: number;
  promotion?: PromotionType;
  kind?: MoveKind;
}

interface Outcome {
  reason: TerminalReason;
  result: "1-0" | "0-1" | "1/2-1/2";
  winner?: Color;
}

interface Derived {
  status: "active" | "terminal";
  check: Color | null;
  outcome: Outcome | null;
  claimable: string[];
}

interface Session {
  mode: Mode;
  position: Position;
  moves: string[];
  repetition: Map<string, number>;
  derived: Derived;
}

interface RequestObject {
  [key: string]: unknown;
}

export interface Simulator {
  request(request: unknown): Record<string, unknown>;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FILES = "abcdefgh";
const PROMOTIONS: PromotionType[] = ["queen", "rook", "bishop", "knight"];
const PROMOTION_LETTERS: Record<PromotionType, string> = {
  queen: "q",
  rook: "r",
  bishop: "b",
  knight: "n",
};
const LETTER_TO_PROMOTION: Record<string, PromotionType> = {
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
};
const PIECE_FROM_FEN: Record<string, PieceType> = {
  k: "king",
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  p: "pawn",
};
const PIECE_TO_FEN: Record<PieceType, string> = {
  king: "k",
  queen: "q",
  rook: "r",
  bishop: "b",
  knight: "n",
  pawn: "p",
};

const RIGHT_WHITE_KINGSIDE = 1;
const RIGHT_WHITE_QUEENSIDE = 2;
const RIGHT_BLACK_KINGSIDE = 4;
const RIGHT_BLACK_QUEENSIDE = 8;

const UINT64_MASK = (1n << 64n) - 1n;
const SPLITMIX_INCREMENT = 0x9e3779b97f4a7c15n;
const SPLITMIX_MULTIPLIER_1 = 0xbf58476d1ce4e5b9n;
const SPLITMIX_MULTIPLIER_2 = 0x94d049bb133111ebn;

class ProtocolError extends Error {
  code: string;
  details: unknown;

  constructor(code: string, message: string, details: unknown = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class SplitMix64 {
  state: bigint;

  constructor(seed: bigint) {
    this.state = seed & UINT64_MASK;
  }

  next(): bigint {
    this.state = (this.state + SPLITMIX_INCREMENT) & UINT64_MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * SPLITMIX_MULTIPLIER_1) & UINT64_MASK;
    z = ((z ^ (z >> 27n)) * SPLITMIX_MULTIPLIER_2) & UINT64_MASK;
    return (z ^ (z >> 31n)) & UINT64_MASK;
  }

  index(length: number): number {
    return Number(this.next() % BigInt(length));
  }
}

function opposite(color: Color): Color {
  return color === "white" ? "black" : "white";
}

function colorFromFen(value: string): Color {
  return value === "w" ? "white" : "black";
}

function colorToFen(color: Color): string {
  return color === "white" ? "w" : "b";
}

function indexOfSquare(file: number, rank: number): number {
  return file + rank * 8;
}

function fileOf(square: number): number {
  return square % 8;
}

function rankOf(square: number): number {
  return Math.floor(square / 8);
}

function inBounds(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

function parseSquare(value: string): number | null {
  if (!/^[a-h][1-8]$/.test(value)) {
    return null;
  }
  return indexOfSquare(FILES.indexOf(value[0]), Number(value[1]) - 1);
}

function squareName(square: number): string {
  return `${FILES[fileOf(square)]}${rankOf(square) + 1}`;
}

function clonePiece(piece: Piece | null): Piece | null {
  return piece === null ? null : { color: piece.color, type: piece.type };
}

function cloneBoard(board: Board): Board {
  return board.map(clonePiece);
}

function clonePosition(position: Position): Position {
  return {
    board: cloneBoard(position.board),
    side: position.side,
    rights: position.rights,
    ep: position.ep,
    halfmove: position.halfmove,
    fullmove: position.fullmove,
  };
}

function cloneOutcome(outcome: Outcome | null): Outcome | null {
  return outcome === null ? null : { ...outcome };
}

function cloneDerived(derived: Derived): Derived {
  return {
    status: derived.status,
    check: derived.check,
    outcome: cloneOutcome(derived.outcome),
    claimable: [...derived.claimable],
  };
}

function cloneSession(session: Session): Session {
  return {
    mode: session.mode,
    position: clonePosition(session.position),
    moves: [...session.moves],
    repetition: new Map(session.repetition),
    derived: cloneDerived(session.derived),
  };
}

function pieceFromFen(char: string): Piece {
  const lower = char.toLowerCase();
  const type = PIECE_FROM_FEN[lower];
  if (type === undefined) {
    throw new ProtocolError("E_INVALID_FEN", `invalid piece character: ${char}`);
  }
  return { color: char === lower ? "black" : "white", type };
}

function validatePosition(position: Position): void {
  let whiteKing = -1;
  let blackKing = -1;
  for (let square = 0; square < 64; square += 1) {
    const piece = position.board[square];
    if (piece === null) {
      continue;
    }
    if (piece.type === "king") {
      if (piece.color === "white") {
        if (whiteKing !== -1) {
          throw new ProtocolError("E_INVALID_FEN", "position must contain exactly one white king");
        }
        whiteKing = square;
      } else {
        if (blackKing !== -1) {
          throw new ProtocolError("E_INVALID_FEN", "position must contain exactly one black king");
        }
        blackKing = square;
      }
    }
    if (piece.type === "pawn" && (rankOf(square) === 0 || rankOf(square) === 7)) {
      throw new ProtocolError("E_INVALID_FEN", "pawns cannot occupy the first or eighth rank");
    }
  }
  if (whiteKing === -1 || blackKing === -1) {
    throw new ProtocolError("E_INVALID_FEN", "position must contain one king per side");
  }
  if (Math.abs(fileOf(whiteKing) - fileOf(blackKing)) <= 1 && Math.abs(rankOf(whiteKing) - rankOf(blackKing)) <= 1) {
    throw new ProtocolError("E_INVALID_FEN", "kings cannot be adjacent");
  }
}

function parseFen(value: unknown): Position {
  if (typeof value !== "string") {
    throw new ProtocolError("E_INVALID_FEN", "fen must be a string");
  }
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 4 && fields.length !== 6) {
    throw new ProtocolError("E_INVALID_FEN", "fen must contain four or six fields");
  }
  const ranks = fields[0].split("/");
  if (ranks.length !== 8) {
    throw new ProtocolError("E_INVALID_FEN", "fen piece placement must contain eight ranks");
  }
  const board: Board = Array.from({ length: 64 }, () => null);
  for (let fenRank = 0; fenRank < 8; fenRank += 1) {
    const rankText = ranks[fenRank];
    let file = 0;
    for (const char of rankText) {
      if (/^[1-8]$/.test(char)) {
        file += Number(char);
      } else if (/^[a-zA-Z]$/.test(char)) {
        if (file >= 8) {
          throw new ProtocolError("E_INVALID_FEN", "too many files in a rank");
        }
        board[indexOfSquare(file, 7 - fenRank)] = pieceFromFen(char);
        file += 1;
      } else {
        throw new ProtocolError("E_INVALID_FEN", `invalid rank character: ${char}`);
      }
    }
    if (file !== 8) {
      throw new ProtocolError("E_INVALID_FEN", "each rank must describe eight files");
    }
  }

  if (fields[1] !== "w" && fields[1] !== "b") {
    throw new ProtocolError("E_INVALID_FEN", "fen side-to-move must be w or b");
  }
  const side = colorFromFen(fields[1]);

  let rights = 0;
  if (fields[2] !== "-") {
    if (!/^[KQkq]+$/.test(fields[2]) || new Set(fields[2]).size !== fields[2].length) {
      throw new ProtocolError("E_INVALID_FEN", "invalid castling rights");
    }
    if (fields[2].includes("K")) rights |= RIGHT_WHITE_KINGSIDE;
    if (fields[2].includes("Q")) rights |= RIGHT_WHITE_QUEENSIDE;
    if (fields[2].includes("k")) rights |= RIGHT_BLACK_KINGSIDE;
    if (fields[2].includes("q")) rights |= RIGHT_BLACK_QUEENSIDE;
  }

  let halfmove = 0;
  let fullmove = 1;
  if (fields.length === 6) {
    if (!/^\d+$/.test(fields[4]) || !/^\d+$/.test(fields[5])) {
      throw new ProtocolError("E_INVALID_FEN", "fen counters must be non-negative integers");
    }
    halfmove = Number(fields[4]);
    fullmove = Number(fields[5]);
    if (!Number.isSafeInteger(halfmove) || !Number.isSafeInteger(fullmove) || fullmove < 1) {
      throw new ProtocolError("E_INVALID_FEN", "fen counters are out of range");
    }
  }

  let ep: number | null = null;
  if (fields[3] !== "-") {
    ep = parseSquare(fields[3]);
    if (ep === null) {
      throw new ProtocolError("E_INVALID_FEN", "invalid en-passant target");
    }
    const expectedRank = side === "white" ? 5 : 2;
    if (rankOf(ep) !== expectedRank || board[ep] !== null) {
      throw new ProtocolError("E_INVALID_FEN", "en-passant target is incompatible with side to move");
    }
    const pawnSquare = ep + (side === "white" ? -8 : 8);
    const pawn = board[pawnSquare];
    if (pawn === null || pawn.type !== "pawn" || pawn.color !== opposite(side)) {
      throw new ProtocolError("E_INVALID_FEN", "en-passant target has no opposing pawn");
    }
    const pawnOrigin = ep + (side === "white" ? 8 : -8);
    if (board[pawnOrigin] !== null) {
      throw new ProtocolError("E_INVALID_FEN", "en-passant target is incompatible with a two-square pawn move");
    }
  }

  const position: Position = { board, side, rights, ep, halfmove, fullmove };
  validatePosition(position);

  const whiteKing = position.board[indexOfSquare(4, 0)];
  const blackKing = position.board[indexOfSquare(4, 7)];
  if ((rights & (RIGHT_WHITE_KINGSIDE | RIGHT_WHITE_QUEENSIDE)) !== 0 &&
      (whiteKing === null || whiteKing.color !== "white" || whiteKing.type !== "king")) {
    throw new ProtocolError("E_INVALID_FEN", "white castling rights require a king on e1");
  }
  if ((rights & (RIGHT_BLACK_KINGSIDE | RIGHT_BLACK_QUEENSIDE)) !== 0 &&
      (blackKing === null || blackKing.color !== "black" || blackKing.type !== "king")) {
    throw new ProtocolError("E_INVALID_FEN", "black castling rights require a king on e8");
  }
  if ((rights & RIGHT_WHITE_KINGSIDE) !== 0) {
    const rook = position.board[indexOfSquare(7, 0)];
    if (rook === null || rook.color !== "white" || rook.type !== "rook") {
      throw new ProtocolError("E_INVALID_FEN", "white kingside rights require a rook on h1");
    }
  }
  if ((rights & RIGHT_WHITE_QUEENSIDE) !== 0) {
    const rook = position.board[indexOfSquare(0, 0)];
    if (rook === null || rook.color !== "white" || rook.type !== "rook") {
      throw new ProtocolError("E_INVALID_FEN", "white queenside rights require a rook on a1");
    }
  }
  if ((rights & RIGHT_BLACK_KINGSIDE) !== 0) {
    const rook = position.board[indexOfSquare(7, 7)];
    if (rook === null || rook.color !== "black" || rook.type !== "rook") {
      throw new ProtocolError("E_INVALID_FEN", "black kingside rights require a rook on h8");
    }
  }
  if ((rights & RIGHT_BLACK_QUEENSIDE) !== 0) {
    const rook = position.board[indexOfSquare(0, 7)];
    if (rook === null || rook.color !== "black" || rook.type !== "rook") {
      throw new ProtocolError("E_INVALID_FEN", "black queenside rights require a rook on a8");
    }
  }
  return position;
}

function findKing(board: Board, color: Color): number {
  for (let square = 0; square < 64; square += 1) {
    const piece = board[square];
    if (piece !== null && piece.color === color && piece.type === "king") {
      return square;
    }
  }
  return -1;
}

function isSquareAttacked(board: Board, target: number, byColor: Color): boolean {
  const targetFile = fileOf(target);
  const targetRank = rankOf(target);

  const pawnSourceRank = targetRank + (byColor === "white" ? -1 : 1);
  if (pawnSourceRank >= 0 && pawnSourceRank < 8) {
    for (const sourceFile of [targetFile - 1, targetFile + 1]) {
      if (!inBounds(sourceFile, pawnSourceRank)) continue;
      const piece = board[indexOfSquare(sourceFile, pawnSourceRank)];
      if (piece !== null && piece.color === byColor && piece.type === "pawn") return true;
    }
  }

  const knightOffsets = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1],
  ];
  for (const [df, dr] of knightOffsets) {
    const sourceFile = targetFile + df;
    const sourceRank = targetRank + dr;
    if (!inBounds(sourceFile, sourceRank)) continue;
    const piece = board[indexOfSquare(sourceFile, sourceRank)];
    if (piece !== null && piece.color === byColor && piece.type === "knight") return true;
  }

  for (const [df, dr] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
    const sourceFile = targetFile + df;
    const sourceRank = targetRank + dr;
    if (!inBounds(sourceFile, sourceRank)) continue;
    const piece = board[indexOfSquare(sourceFile, sourceRank)];
    if (piece !== null && piece.color === byColor && piece.type === "king") return true;
  }

  const orthogonal = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [df, dr] of orthogonal) {
    let currentFile = targetFile + df;
    let currentRank = targetRank + dr;
    while (inBounds(currentFile, currentRank)) {
      const piece = board[indexOfSquare(currentFile, currentRank)];
      if (piece !== null) {
        if (piece.color === byColor && (piece.type === "rook" || piece.type === "queen")) return true;
        break;
      }
      currentFile += df;
      currentRank += dr;
    }
  }

  const diagonal = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (const [df, dr] of diagonal) {
    let currentFile = targetFile + df;
    let currentRank = targetRank + dr;
    while (inBounds(currentFile, currentRank)) {
      const piece = board[indexOfSquare(currentFile, currentRank)];
      if (piece !== null) {
        if (piece.color === byColor && (piece.type === "bishop" || piece.type === "queen")) return true;
        break;
      }
      currentFile += df;
      currentRank += dr;
    }
  }
  return false;
}

function isInCheck(position: Position, color: Color): boolean {
  const king = findKing(position.board, color);
  return king === -1 || isSquareAttacked(position.board, king, opposite(color));
}

function addMove(moves: Move[], from: number, to: number, promotion?: PromotionType, kind: MoveKind = "normal"): void {
  if (promotion === undefined) moves.push({ from, to, kind });
  else moves.push({ from, to, promotion, kind });
}

function addPawnMove(moves: Move[], from: number, to: number, color: Color, kind: MoveKind = "normal"): void {
  const finalRank = color === "white" ? 7 : 0;
  if (rankOf(to) === finalRank) {
    for (const promotion of PROMOTIONS) addMove(moves, from, to, promotion, kind);
  } else {
    addMove(moves, from, to, undefined, kind);
  }
}

function canCastleStructure(position: Position, color: Color, kingside: boolean): boolean {
  const rank = color === "white" ? 0 : 7;
  const kingFrom = indexOfSquare(4, rank);
  const rookFrom = indexOfSquare(kingside ? 7 : 0, rank);
  const king = position.board[kingFrom];
  const rook = position.board[rookFrom];
  if (king === null || king.color !== color || king.type !== "king") return false;
  if (rook === null || rook.color !== color || rook.type !== "rook") return false;
  const right = color === "white"
    ? (kingside ? RIGHT_WHITE_KINGSIDE : RIGHT_WHITE_QUEENSIDE)
    : (kingside ? RIGHT_BLACK_KINGSIDE : RIGHT_BLACK_QUEENSIDE);
  if ((position.rights & right) === 0) return false;
  const emptyFiles = kingside ? [5, 6] : [1, 2, 3];
  return emptyFiles.every((file) => position.board[indexOfSquare(file, rank)] === null);
}

function castlePathSafe(position: Position, color: Color, kingside: boolean): boolean {
  if (!canCastleStructure(position, color, kingside)) return false;
  const rank = color === "white" ? 0 : 7;
  const origin = indexOfSquare(4, rank);
  const transit = indexOfSquare(kingside ? 5 : 3, rank);
  const destination = indexOfSquare(kingside ? 6 : 2, rank);
  if (isSquareAttacked(position.board, origin, opposite(color))) return false;

  const transitBoard = cloneBoard(position.board);
  transitBoard[origin] = null;
  transitBoard[transit] = { color, type: "king" };
  if (isSquareAttacked(transitBoard, transit, opposite(color))) return false;

  const destinationBoard = cloneBoard(position.board);
  destinationBoard[origin] = null;
  destinationBoard[destination] = { color, type: "king" };
  return !isSquareAttacked(destinationBoard, destination, opposite(color));
}

function generatePseudoMoves(position: Position): Move[] {
  const moves: Move[] = [];
  const { board, side } = position;
  for (let from = 0; from < 64; from += 1) {
    const piece = board[from];
    if (piece === null || piece.color !== side) continue;
    const file = fileOf(from);
    const rank = rankOf(from);

    if (piece.type === "pawn") {
      const direction = side === "white" ? 1 : -1;
      const oneRank = rank + direction;
      if (oneRank >= 0 && oneRank < 8) {
        const one = indexOfSquare(file, oneRank);
        if (board[one] === null) {
          addPawnMove(moves, from, one, side);
          const homeRank = side === "white" ? 1 : 6;
          const twoRank = rank + direction * 2;
          const two = indexOfSquare(file, twoRank);
          if (rank === homeRank && board[two] === null) addMove(moves, from, two);
        }
        for (const captureFile of [file - 1, file + 1]) {
          if (!inBounds(captureFile, oneRank)) continue;
          const destination = indexOfSquare(captureFile, oneRank);
          const target = board[destination];
          if (target !== null && target.color !== side && target.type !== "king") {
            addPawnMove(moves, from, destination, side);
          } else if (position.ep === destination && target === null) {
            const capturedSquare = destination - direction * 8;
            const captured = board[capturedSquare];
            if (captured !== null && captured.color === opposite(side) && captured.type === "pawn") {
              addMove(moves, from, destination, undefined, "en_passant");
            }
          }
        }
      }
      continue;
    }

    if (piece.type === "knight") {
      for (const [df, dr] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
        const destinationFile = file + df;
        const destinationRank = rank + dr;
        if (!inBounds(destinationFile, destinationRank)) continue;
        const to = indexOfSquare(destinationFile, destinationRank);
        const target = board[to];
        if (target === null || (target.color !== side && target.type !== "king")) addMove(moves, from, to);
      }
      continue;
    }

    if (piece.type === "king") {
      for (const [df, dr] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
        const destinationFile = file + df;
        const destinationRank = rank + dr;
        if (!inBounds(destinationFile, destinationRank)) continue;
        const to = indexOfSquare(destinationFile, destinationRank);
        const target = board[to];
        if (target === null || (target.color !== side && target.type !== "king")) addMove(moves, from, to);
      }
      if (from === indexOfSquare(4, side === "white" ? 0 : 7)) {
        if (canCastleStructure(position, side, true)) {
          addMove(moves, from, indexOfSquare(6, side === "white" ? 0 : 7), undefined, "castle_kingside");
        }
        if (canCastleStructure(position, side, false)) {
          addMove(moves, from, indexOfSquare(2, side === "white" ? 0 : 7), undefined, "castle_queenside");
        }
      }
      continue;
    }

    const directions: number[][] = [];
    if (piece.type === "rook" || piece.type === "queen") directions.push([-1, 0], [1, 0], [0, -1], [0, 1]);
    if (piece.type === "bishop" || piece.type === "queen") directions.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
    for (const [df, dr] of directions) {
      let destinationFile = file + df;
      let destinationRank = rank + dr;
      while (inBounds(destinationFile, destinationRank)) {
        const to = indexOfSquare(destinationFile, destinationRank);
        const target = board[to];
        if (target === null) addMove(moves, from, to);
        else {
          if (target.color !== side && target.type !== "king") addMove(moves, from, to);
          break;
        }
        destinationFile += df;
        destinationRank += dr;
      }
    }
  }
  return moves;
}

function updateCastlingRights(position: Position, move: Move, moving: Piece, captured: Piece | null): number {
  let rights = position.rights;
  const from = move.from;
  if (moving.type === "king") {
    rights &= moving.color === "white"
      ? ~(RIGHT_WHITE_KINGSIDE | RIGHT_WHITE_QUEENSIDE)
      : ~(RIGHT_BLACK_KINGSIDE | RIGHT_BLACK_QUEENSIDE);
  }
  if (moving.type === "rook") {
    if (from === indexOfSquare(0, 0)) rights &= ~RIGHT_WHITE_QUEENSIDE;
    if (from === indexOfSquare(7, 0)) rights &= ~RIGHT_WHITE_KINGSIDE;
    if (from === indexOfSquare(0, 7)) rights &= ~RIGHT_BLACK_QUEENSIDE;
    if (from === indexOfSquare(7, 7)) rights &= ~RIGHT_BLACK_KINGSIDE;
  }
  if (captured !== null && captured.type === "rook") {
    if (move.to === indexOfSquare(0, 0)) rights &= ~RIGHT_WHITE_QUEENSIDE;
    if (move.to === indexOfSquare(7, 0)) rights &= ~RIGHT_WHITE_KINGSIDE;
    if (move.to === indexOfSquare(0, 7)) rights &= ~RIGHT_BLACK_QUEENSIDE;
    if (move.to === indexOfSquare(7, 7)) rights &= ~RIGHT_BLACK_KINGSIDE;
  }
  return rights;
}

function applyMove(position: Position, move: Move): Position {
  const board = cloneBoard(position.board);
  const moving = board[move.from];
  if (moving === null) throw new Error("cannot apply a move without a moving piece");
  const captured = board[move.to];
  board[move.from] = null;

  if (move.kind === "en_passant") {
    const direction = moving.color === "white" ? 1 : -1;
    board[move.to - direction * 8] = null;
  }

  if (move.kind === "castle_kingside" || move.kind === "castle_queenside") {
    const rank = moving.color === "white" ? 0 : 7;
    const rookFrom = indexOfSquare(move.kind === "castle_kingside" ? 7 : 0, rank);
    const rookTo = indexOfSquare(move.kind === "castle_kingside" ? 5 : 3, rank);
    const rook = board[rookFrom];
    board[rookFrom] = null;
    board[rookTo] = rook;
  }

  const placed: Piece = move.promotion === undefined
    ? { color: moving.color, type: moving.type }
    : { color: moving.color, type: move.promotion };
  board[move.to] = placed;

  const rights = updateCastlingRights(position, move, moving, captured);
  let ep: number | null = null;
  if (moving.type === "pawn" && Math.abs(move.to - move.from) === 16) {
    ep = (move.to + move.from) / 2;
  }
  const isCapture = captured !== null || move.kind === "en_passant";
  const halfmove = moving.type === "pawn" || isCapture ? 0 : position.halfmove + 1;
  const fullmove = moving.color === "black" ? position.fullmove + 1 : position.fullmove;
  return {
    board,
    side: opposite(position.side),
    rights,
    ep,
    halfmove,
    fullmove,
  };
}

function isMoveLegal(position: Position, move: Move): boolean {
  if (move.kind === "castle_kingside" && !castlePathSafe(position, position.side, true)) return false;
  if (move.kind === "castle_queenside" && !castlePathSafe(position, position.side, false)) return false;
  const next = applyMove(position, move);
  return !isInCheck(next, position.side);
}

function compareMoves(left: Move, right: Move): number {
  if (left.from !== right.from) return left.from - right.from;
  if (left.to !== right.to) return left.to - right.to;
  const leftOrder = left.promotion === undefined ? -1 : PROMOTIONS.indexOf(left.promotion);
  const rightOrder = right.promotion === undefined ? -1 : PROMOTIONS.indexOf(right.promotion);
  return leftOrder - rightOrder;
}

function generateLegalMoves(position: Position): Move[] {
  return generatePseudoMoves(position).filter((move) => isMoveLegal(position, move)).sort(compareMoves);
}

function moveToString(move: Move): string {
  const suffix = move.promotion === undefined ? "" : PROMOTION_LETTERS[move.promotion];
  return `${squareName(move.from)}${squareName(move.to)}${suffix}`;
}

function parseMove(value: unknown): Move {
  if (typeof value !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value)) {
    throw new ProtocolError("E_INVALID_MOVE_SYNTAX", "move must use lowercase coordinate notation");
  }
  const from = parseSquare(value.slice(0, 2));
  const to = parseSquare(value.slice(2, 4));
  if (from === null || to === null) {
    throw new ProtocolError("E_INVALID_MOVE_SYNTAX", "move contains an invalid square");
  }
  return {
    from,
    to,
    ...(value.length === 5 ? { promotion: LETTER_TO_PROMOTION[value[4]] } : {}),
  };
}

function alignedPathBlocked(position: Position, from: number, to: number): boolean {
  const fromFile = fileOf(from);
  const fromRank = rankOf(from);
  const toFile = fileOf(to);
  const toRank = rankOf(to);
  const df = Math.sign(toFile - fromFile);
  const dr = Math.sign(toRank - fromRank);
  if (!((fromFile === toFile) || (fromRank === toRank) || Math.abs(toFile - fromFile) === Math.abs(toRank - fromRank))) {
    return false;
  }
  let currentFile = fromFile + df;
  let currentRank = fromRank + dr;
  while (currentFile !== toFile || currentRank !== toRank) {
    if (position.board[indexOfSquare(currentFile, currentRank)] !== null) return true;
    currentFile += df;
    currentRank += dr;
  }
  return false;
}

function moveErrorFor(position: Position, requested: Move): ProtocolError {
  const moving = position.board[requested.from];
  if (moving === null) return new ProtocolError("E_EMPTY_SOURCE", "source square is empty");
  if (moving.color !== position.side) return new ProtocolError("E_WRONG_TURN", "source piece is not on move");
  const target = position.board[requested.to];
  if (target !== null && target.color === moving.color) return new ProtocolError("E_OWN_PIECE_ON_DESTINATION", "destination contains a friendly piece");

  const finalRank = moving.color === "white" ? 7 : 0;
  if (requested.promotion !== undefined && (moving.type !== "pawn" || rankOf(requested.to) !== finalRank)) {
    return new ProtocolError("E_INVALID_PROMOTION", "promotion is only valid for a pawn reaching the final rank");
  }
  if (moving.type === "pawn" && rankOf(requested.to) === finalRank && requested.promotion === undefined) {
    return new ProtocolError("E_INVALID_PROMOTION", "a pawn reaching the final rank must promote");
  }

  const isCastleAttempt = moving.type === "king" && rankOf(requested.from) === rankOf(requested.to) &&
    Math.abs(fileOf(requested.to) - fileOf(requested.from)) === 2;
  if (isCastleAttempt) {
    const kingside = fileOf(requested.to) > fileOf(requested.from);
    if (!canCastleStructure(position, position.side, kingside)) {
      return new ProtocolError("E_CASTLE_UNAVAILABLE", "castling rights, pieces, or path are unavailable");
    }
    if (!castlePathSafe(position, position.side, kingside)) {
      return new ProtocolError("E_CASTLE_THROUGH_CHECK", "the king is in or crosses an attacked square");
    }
  }

  const pseudo = generatePseudoMoves(position).filter((move) => move.from === requested.from && move.to === requested.to);
  if (requested.promotion !== undefined && pseudo.every((move) => move.promotion !== requested.promotion)) {
    return new ProtocolError("E_INVALID_PROMOTION", "requested promotion is not available for this move");
  }
  if (requested.promotion === undefined && pseudo.some((move) => move.promotion !== undefined)) {
    return new ProtocolError("E_INVALID_PROMOTION", "a promotion selector is required");
  }

  const matching = pseudo.filter((move) => move.promotion === requested.promotion);
  if (matching.length === 0) {
    const direction = moving.color === "white" ? 1 : -1;
    const isEpShape = moving.type === "pawn" && position.ep === requested.to &&
      boardIsEmpty(position, requested.to) && Math.abs(fileOf(requested.to) - fileOf(requested.from)) === 1 &&
      rankOf(requested.to) - rankOf(requested.from) === direction;
    if (isEpShape) return new ProtocolError("E_EN_PASSANT_UNAVAILABLE", "en-passant capture is no longer available");
    if (moving.type === "pawn" && fileOf(requested.from) === fileOf(requested.to) &&
        (rankOf(requested.to) - rankOf(requested.from)) * (moving.color === "white" ? 1 : -1) > 0 &&
        alignedPathBlocked(position, requested.from, requested.to)) {
      return new ProtocolError("E_PATH_BLOCKED", "a piece blocks the pawn's forward path");
    }
    if (isSlider(moving.type) && alignedPathBlocked(position, requested.from, requested.to)) {
      return new ProtocolError("E_PATH_BLOCKED", "a piece blocks the move path");
    }
    return new ProtocolError("E_ILLEGAL_GEOMETRY", "move does not match the piece movement rules");
  }

  if (!matching.some((move) => isMoveLegal(position, move))) {
    return new ProtocolError("E_SELF_CHECK", "move leaves the moving side's king in check");
  }
  return new ProtocolError("E_ILLEGAL_GEOMETRY", "move is not legal");
}

function boardIsEmpty(position: Position, square: number): boolean {
  return position.board[square] === null;
}

function isSlider(type: PieceType): boolean {
  return type === "bishop" || type === "rook" || type === "queen";
}

function findMatchingLegalMove(position: Position, requested: Move): Move {
  const legal = generateLegalMoves(position);
  const matching = legal.find((move) => move.from === requested.from && move.to === requested.to && move.promotion === requested.promotion);
  if (matching !== undefined) return matching;
  throw moveErrorFor(position, requested);
}

function boardFen(board: Board): string {
  const ranks: string[] = [];
  for (let rank = 7; rank >= 0; rank -= 1) {
    let text = "";
    let empty = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = board[indexOfSquare(file, rank)];
      if (piece === null) {
        empty += 1;
      } else {
        if (empty > 0) {
          text += String(empty);
          empty = 0;
        }
        const letter = PIECE_TO_FEN[piece.type];
        text += piece.color === "white" ? letter.toUpperCase() : letter;
      }
    }
    if (empty > 0) text += String(empty);
    ranks.push(text);
  }
  return ranks.join("/");
}

function rightsToString(rights: number): string {
  let result = "";
  if ((rights & RIGHT_WHITE_KINGSIDE) !== 0) result += "K";
  if ((rights & RIGHT_WHITE_QUEENSIDE) !== 0) result += "Q";
  if ((rights & RIGHT_BLACK_KINGSIDE) !== 0) result += "k";
  if ((rights & RIGHT_BLACK_QUEENSIDE) !== 0) result += "q";
  return result || "-";
}

function hasLegalEnPassant(position: Position): boolean {
  if (position.ep === null) return false;
  return generatePseudoMoves(position).some((move) => move.kind === "en_passant" && isMoveLegal(position, move));
}

function positionKey(position: Position): string {
  const effectiveEp = position.ep !== null && hasLegalEnPassant(position) ? squareName(position.ep) : "-";
  return `${boardFen(position.board)} ${colorToFen(position.side)} ${rightsToString(position.rights)} ${effectiveEp}`;
}

function isDeadPosition(position: Position): boolean {
  const nonKings: Array<{ square: number; piece: Piece }> = [];
  for (let square = 0; square < 64; square += 1) {
    const piece = position.board[square];
    if (piece !== null && piece.type !== "king") nonKings.push({ square, piece });
  }
  if (nonKings.length === 0) return true;
  if (nonKings.some(({ piece }) => piece.type === "pawn" || piece.type === "rook" || piece.type === "queen")) return false;
  if (nonKings.length === 1 && (nonKings[0].piece.type === "bishop" || nonKings[0].piece.type === "knight")) return true;
  if (nonKings.every(({ piece }) => piece.type === "bishop")) {
    const squareColors = new Set(nonKings.map(({ square }) => (fileOf(square) + rankOf(square)) % 2));
    return squareColors.size === 1;
  }
  return false;
}

function resultForWinner(winner: Color): "1-0" | "0-1" {
  return winner === "white" ? "1-0" : "0-1";
}

function derive(position: Position, mode: Mode, repetition: Map<string, number>): Derived {
  const check = isInCheck(position, position.side) ? position.side : null;
  const legalMoves = generateLegalMoves(position);
  let outcome: Outcome | null = null;
  if (legalMoves.length === 0) {
    if (check !== null) {
      outcome = { reason: "checkmate", result: resultForWinner(opposite(position.side)), winner: opposite(position.side) };
    } else {
      outcome = { reason: "stalemate", result: "1/2-1/2" };
    }
  } else if (isDeadPosition(position)) {
    outcome = { reason: "dead_position", result: "1/2-1/2" };
  } else if (mode === "all-rules-enabled") {
    const key = positionKey(position);
    const count = repetition.get(key) ?? 0;
    if (count >= 5) {
      outcome = { reason: "fivefold_repetition", result: "1/2-1/2" };
    } else if (position.halfmove >= 150) {
      outcome = { reason: "seventy_five_move", result: "1/2-1/2" };
    }
  }

  if (outcome !== null) {
    return { status: "terminal", check, outcome, claimable: [] };
  }
  const claimable: string[] = [];
  if (mode === "all-rules-enabled") {
    const key = positionKey(position);
    if ((repetition.get(key) ?? 0) >= 3) claimable.push("threefold_repetition");
    if (position.halfmove >= 100) claimable.push("fifty_move");
    for (const move of legalMoves) {
      const next = applyMove(position, move);
      if (!claimable.includes("threefold_repetition") &&
          (repetition.get(positionKey(next)) ?? 0) + 1 >= 3) {
        claimable.push("threefold_repetition");
      }
      if (!claimable.includes("fifty_move") && next.halfmove >= 100) {
        claimable.push("fifty_move");
      }
      if (claimable.length === 2) break;
    }
  }
  return { status: "active", check, outcome: null, claimable };
}

function createSession(mode: Mode, position: Position): Session {
  const repetition = new Map<string, number>();
  if (mode === "all-rules-enabled") repetition.set(positionKey(position), 1);
  return {
    mode,
    position: clonePosition(position),
    moves: [],
    repetition,
    derived: derive(position, mode, repetition),
  };
}

function commitMove(session: Session, move: Move): Session {
  const position = applyMove(session.position, move);
  const repetition = new Map(session.repetition);
  if (session.mode === "all-rules-enabled") {
    const key = positionKey(position);
    repetition.set(key, (repetition.get(key) ?? 0) + 1);
  }
  return {
    mode: session.mode,
    position,
    moves: [...session.moves, moveToString(move)],
    repetition,
    derived: derive(position, session.mode, repetition),
  };
}

function boardForJson(board: Board): Array<{ color: Color; type: PieceType } | null> {
  return board.map((piece) => piece === null ? null : { color: piece.color, type: piece.type });
}

function repetitionForJson(repetition: Map<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, count] of repetition) result[key] = count;
  return result;
}

function stateForJson(session: Session): Record<string, unknown> {
  return {
    mode: session.mode,
    board: boardForJson(session.position.board),
    side_to_move: session.position.side,
    castling_rights: rightsToString(session.position.rights),
    en_passant_target: session.position.ep === null ? null : squareName(session.position.ep),
    halfmove_clock: session.position.halfmove,
    fullmove_number: session.position.fullmove,
    status: session.derived.status,
    check: session.derived.check,
    outcome: cloneOutcome(session.derived.outcome),
    claimable_draws: [...session.derived.claimable],
    repetition_counts: repetitionForJson(session.repetition),
    moves: [...session.moves],
  };
}

function isRecord(value: unknown): value is RequestObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new ProtocolError("E_INVALID_REQUEST", `${field} must be an integer >= ${minimum}`, { field });
  }
  return value;
}

function parseMode(value: unknown, defaultMode: Mode): Mode {
  const mode = value === undefined ? defaultMode : value;
  if (mode !== "basic" && mode !== "all-rules-enabled") {
    throw new ProtocolError("E_INVALID_REQUEST", "mode must be basic or all-rules-enabled", { field: "mode" });
  }
  return mode;
}

function parseSeed(value: unknown, defaultSeed = "1"): { value: bigint; text: string } {
  const raw = value === undefined ? defaultSeed : value;
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (typeof raw === "number" && Number.isSafeInteger(raw)) text = String(raw);
  else throw new ProtocolError("E_INVALID_REQUEST", "seed must be a decimal string or safe integer", { field: "seed" });
  if (!/^-?\d+$/.test(text)) throw new ProtocolError("E_INVALID_REQUEST", "seed must be a decimal integer", { field: "seed" });
  let valueBig: bigint;
  try {
    valueBig = BigInt(text) & UINT64_MASK;
  } catch {
    throw new ProtocolError("E_INVALID_REQUEST", "seed is not a valid integer", { field: "seed" });
  }
  return { value: valueBig, text: valueBig.toString(10) };
}

function positionFromRequest(request: RequestObject, current: Session | null, allowCurrent: boolean): Position {
  if (request.fen !== undefined) return parseFen(request.fen);
  if (allowCurrent && current !== null) return clonePosition(current.position);
  if (allowCurrent) return parseFen(START_FEN);
  throw new ProtocolError("E_NO_SESSION", "no active session; call new first or provide fen");
}

function errorResponse(op: string | null, error: ProtocolError, current: Session | null): Record<string, unknown> {
  const errorObject: Record<string, unknown> = {
    code: error.code,
    message: error.message,
  };
  if (error.details !== undefined) errorObject.details = error.details;
  const response: Record<string, unknown> = { ok: false, op, error: errorObject };
  if (current !== null) response.state = stateForJson(current);
  return response;
}

function requireCurrent(current: Session | null): Session {
  if (current === null) throw new ProtocolError("E_NO_SESSION", "no active session; call new first");
  return current;
}

function playRequest(request: RequestObject, current: Session): Record<string, unknown> {
  if (current.derived.status === "terminal") throw new ProtocolError("E_GAME_OVER", "the game is already over");
  const requested = parseMove(request.move);
  const legal = findMatchingLegalMove(current.position, requested);
  const next = commitMove(current, legal);
  return { ok: true, op: "play", move: moveToString(legal), state: stateForJson(next), __session: next };
}

function perft(position: Position, depth: number): bigint {
  if (depth === 0) return 1n;
  const legalMoves = generateLegalMoves(position);
  let nodes = 0n;
  for (const move of legalMoves) nodes += perft(applyMove(position, move), depth - 1);
  return nodes;
}

function jsonNumberOrString(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString(10);
}

function resultOfSession(session: Session): string {
  return session.derived.outcome === null ? "*" : session.derived.outcome.result;
}

function terminationOfSession(session: Session): string {
  return session.derived.outcome === null ? "max_plies" : session.derived.outcome.reason;
}

function runRequest(request: RequestObject, current: Session | null): Record<string, unknown> {
  const mode = parseMode(request.mode, "all-rules-enabled");
  const position = request.fen === undefined ? parseFen(START_FEN) : parseFen(request.fen);
  const seed = parseSeed(request.seed);
  const maxPlies = request.max_plies === undefined ? 200 : requireInteger(request.max_plies, "max_plies", 0);
  const trace = request.trace === undefined ? true : request.trace;
  if (typeof trace !== "boolean") {
    throw new ProtocolError("E_INVALID_REQUEST", "trace must be boolean", { field: "trace" });
  }
  let game = createSession(mode, position);
  const random = new SplitMix64(seed.value);
  while (game.derived.status === "active" && game.moves.length < maxPlies) {
    const legalMoves = generateLegalMoves(game.position);
    if (legalMoves.length === 0) break;
    const move = legalMoves[random.index(legalMoves.length)];
    game = commitMove(game, move);
  }
  const response: Record<string, unknown> = {
    ok: true,
    op: "run",
    seed: seed.text,
    moves: trace ? [...game.moves] : [],
    plies: game.moves.length,
    termination: terminationOfSession(game),
    result: resultOfSession(game),
    final: stateForJson(game),
  };
  return response;
}

function sampleRequest(request: RequestObject, current: Session | null): Record<string, unknown> {
  const samples = requireInteger(request.samples, "samples", 0);
  const position = positionFromRequest(request, current, true);
  const seed = parseSeed(request.seed);
  const legalMoves = generateLegalMoves(position);
  const moveStrings = legalMoves.map(moveToString);
  const counts: Record<string, number> = {};
  const sequence: string[] = [];
  for (const move of moveStrings) counts[move] = 0;
  const random = new SplitMix64(seed.value);
  for (let index = 0; index < samples && legalMoves.length > 0; index += 1) {
    const selected = moveStrings[random.index(moveStrings.length)];
    sequence.push(selected);
    counts[selected] += 1;
  }
  return { ok: true, op: "sample", moves: moveStrings, counts, sequence, samples, seed: seed.text };
}

function dispatch(request: unknown, current: Session | null): { response: Record<string, unknown>; session: Session | null } {
  if (!isRecord(request) || typeof request.op !== "string") {
    throw new ProtocolError("E_INVALID_REQUEST", "request must be an object with an op field");
  }
  const op = request.op;
  if (op === "new") {
    const mode = parseMode(request.mode, "all-rules-enabled");
    const position = request.fen === undefined ? parseFen(START_FEN) : parseFen(request.fen);
    const next = createSession(mode, position);
    return { response: { ok: true, op, state: stateForJson(next) }, session: next };
  }
  if (op === "state") {
    const session = requireCurrent(current);
    return { response: { ok: true, op, state: stateForJson(session) }, session: current };
  }
  if (op === "legal_moves") {
    const session = requireCurrent(current);
    return { response: { ok: true, op, moves: generateLegalMoves(session.position).map(moveToString) }, session: current };
  }
  if (op === "play") {
    const session = requireCurrent(current);
    const result = playRequest(request, session);
    const next = result.__session as Session;
    delete result.__session;
    return { response: result, session: next };
  }
  if (op === "perft") {
    const depth = requireInteger(request.depth, "depth", 0);
    const position = positionFromRequest(request, current, true);
    return { response: { ok: true, op, depth, nodes: jsonNumberOrString(perft(position, depth)) }, session: current };
  }
  if (op === "run") {
    return { response: runRequest(request, current), session: current };
  }
  if (op === "sample") {
    return { response: sampleRequest(request, current), session: current };
  }
  throw new ProtocolError("E_UNKNOWN_OPERATION", `unknown operation: ${op}`);
}

function requestWithSession(request: unknown, current: Session | null): {
  response: Record<string, unknown>;
  session: Session | null;
} {
  const op = isRecord(request) && typeof request.op === "string" ? request.op : null;
  try {
    return dispatch(request, current);
  } catch (error) {
    const protocolError = error instanceof ProtocolError
      ? error
      : new ProtocolError("E_INVALID_REQUEST", "request could not be processed");
    return { response: errorResponse(op, protocolError, current), session: current };
  }
}

interface SimulatorState {
  simulator: Simulator;
  invalidJsonResponse(): Record<string, unknown>;
}

function createSimulatorState(): SimulatorState {
  let session: Session | null = null;

  const simulator: Simulator = {
    request(request: unknown): Record<string, unknown> {
      const result = requestWithSession(request, session);
      session = result.session;
      return result.response;
    },
  };

  return {
    simulator,
    invalidJsonResponse: () => errorResponse(
      null,
      new ProtocolError("E_INVALID_REQUEST", "line is not valid JSON"),
      session,
    ),
  };
}

export function createSimulator(): Simulator {
  return createSimulatorState().simulator;
}

interface CliInput {
  setEncoding(encoding: string): void;
  on(event: "data", listener: (chunk: string) => void): void;
  on(event: "end", listener: () => void): void;
}

interface CliOutput {
  write(value: string): void;
}

interface CliProcess {
  stdin: CliInput;
  stdout: CliOutput;
}

function isCliInput(value: unknown): value is CliInput {
  if (!isRecord(value)) return false;
  return typeof value.setEncoding === "function" && typeof value.on === "function";
}

function isCliOutput(value: unknown): value is CliOutput {
  if (!isRecord(value)) return false;
  return typeof value.write === "function";
}

function getCliProcess(): CliProcess | null {
  const globalObject = globalThis as typeof globalThis & { process?: unknown };
  const processValue = globalObject.process;
  if (!isRecord(processValue) || !isCliInput(processValue.stdin) || !isCliOutput(processValue.stdout)) {
    return null;
  }
  return { stdin: processValue.stdin, stdout: processValue.stdout };
}

export function runCli(): void {
  const cliProcess = getCliProcess();
  if (cliProcess === null) return;

  const simulatorState = createSimulatorState();
  const simulator = simulatorState.simulator;
  let inputBuffer = "";

  const writeResponse = (response: Record<string, unknown>): void => {
    cliProcess.stdout.write(`${JSON.stringify(response)}\n`);
  };

  const handleLine = (line: string): void => {
    if (line.trim() === "") return;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      writeResponse(simulatorState.invalidJsonResponse());
      return;
    }
    writeResponse(simulator.request(request));
  };

  cliProcess.stdin.setEncoding("utf8");
  cliProcess.stdin.on("data", (chunk: string) => {
    inputBuffer += chunk;
    let newline = inputBuffer.indexOf("\n");
    while (newline !== -1) {
      handleLine(inputBuffer.slice(0, newline).replace(/\r$/, ""));
      inputBuffer = inputBuffer.slice(newline + 1);
      newline = inputBuffer.indexOf("\n");
    }
  });
  cliProcess.stdin.on("end", () => {
    if (inputBuffer.length > 0) handleLine(inputBuffer.replace(/\r$/, ""));
  });
}

if (getCliProcess() !== null) runCli();
