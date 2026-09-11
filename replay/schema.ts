import type { ReplayState } from './engine.ts';

export type Color = 'white' | 'black';
export type PieceType = 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn';
export interface Piece { color: Color; type: PieceType }
export interface Position {
  board: (Piece | null)[];
  side_to_move: Color;
  castling_rights: { white_kingside: boolean; white_queenside: boolean; black_kingside: boolean; black_queenside: boolean };
  en_passant_target: string | null;
  halfmove_clock: number;
  fullmove_number: number;
}
export type ReplayRoot = { kind: 'standard' } | { kind: 'position'; position: Position };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Replay {
  schema_version: 1;
  ruleset: 'orthodox-chess-v1';
  root: ReplayRoot;
  moves: string[];
  metadata?: Record<string, JsonValue>;
}
export interface EngineErrorData { code: string; message: string }
export class ReplayError extends Error {
  code: string;
  move_index: number | null = null;
  ply: number | null = null;
  last_valid_ply: number | null = null;
  last_valid_state: ReplayState | null = null;
  underlying_error: EngineErrorData | null = null;
  limit: string | null = null;
  constructor(code: string, message: string) { super(message); this.name = 'ReplayError'; this.code = code; }
}
export const MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const pieceTypes: PieceType[] = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
const rightNames = ['white_kingside', 'white_queenside', 'black_kingside', 'black_queenside'] as const;
function invalid(message: string): never { throw new ReplayError('E_REPLAY_SCHEMA', message); }
function limitExceeded(limit: string): never {
  const error = new ReplayError('E_REPLAY_LIMIT', `Replay exceeds ${limit}`); error.limit = limit; throw error;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function object(value: unknown, fields: string[], required = fields): Record<string, unknown> {
  if (!isRecord(value)) invalid('Expected an object');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid('Expected a JSON object');
  if (Object.keys(value).some(key => !fields.includes(key))) invalid('Unknown object field');
  if (required.some(key => !Object.hasOwn(value, key))) invalid('Missing required field');
  return value;
}
function color(value: unknown): Color { if (value !== 'white' && value !== 'black') invalid('Invalid color'); return value; }
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid('Invalid position counter');
  return value;
}
export function parsePosition(input: unknown): Position {
  const p = object(input, ['board', 'side_to_move', 'castling_rights', 'en_passant_target', 'halfmove_clock', 'fullmove_number']);
  if (!Array.isArray(p.board) || p.board.length !== 64) invalid('Board must have exactly 64 cells');
  const board = Array.from(p.board, cell => {
    if (cell === null) return null;
    const piece = object(cell, ['color', 'type']);
    const type = pieceTypes.find(type => type === piece.type);
    if (!type) invalid('Invalid piece type');
    return { color: color(piece.color), type };
  });
  const rights = object(p.castling_rights, [...rightNames]);
  for (const name of rightNames) if (typeof rights[name] !== 'boolean') invalid('Invalid castling flag');
  if (p.en_passant_target !== null && (typeof p.en_passant_target !== 'string' || !/^[a-h][1-8]$/.test(p.en_passant_target))) invalid('Invalid en passant square');
  return { board, side_to_move: color(p.side_to_move), castling_rights: {
    white_kingside: rights.white_kingside === true, white_queenside: rights.white_queenside === true,
    black_kingside: rights.black_kingside === true, black_queenside: rights.black_queenside === true,
  }, en_passant_target: p.en_passant_target, halfmove_clock: integer(p.halfmove_clock, 0), fullmove_number: integer(p.fullmove_number, 1) };
}
function jsonCopy(value: unknown, ancestors = new Set<object>(), budget = { nodes: 0 }): JsonValue {
  if (++budget.nodes > 65536) limitExceeded('metadata_nodes:65536');
  if (typeof value === 'string' && Array.from(value).length > 1024) limitExceeded('metadata_string_code_points:1024');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) invalid('Metadata must contain JSON values');
  if (ancestors.size >= 32) limitExceeded('metadata_depth:32');
  ancestors.add(value);
  let result: JsonValue;
  if (Array.isArray(value)) result = Array.from(value, child => jsonCopy(child, ancestors, budget));
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid('Metadata must contain JSON objects');
    result = Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (Array.from(key).length > 1024) limitExceeded('metadata_string_code_points:1024');
      return [key, jsonCopy(child, ancestors, budget)];
    }));
  }
  ancestors.delete(value);
  return result;
}
function standardPosition(p: Position): boolean {
  const back: PieceType[] = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
  return p.side_to_move === 'white' && p.en_passant_target === null && p.halfmove_clock === 0 && p.fullmove_number === 1 &&
    rightNames.every(name => p.castling_rights[name]) && p.board.every((piece, square) => {
      const rank = Math.floor(square / 8);
      if (rank > 1 && rank < 6) return piece === null;
      return piece?.color === (rank < 2 ? 'white' : 'black') && piece.type === (rank === 1 || rank === 6 ? 'pawn' : back[square % 8]);
    });
}
// The validator defers move syntax to ordered engine execution for precise failure locations.
export function parseReplay(input: unknown, options: { deferMoveSyntax?: boolean } = {}): Replay {
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > 5 * 1024 * 1024) limitExceeded('input_bytes:5242880');
    try { input = JSON.parse(input); } catch (error) { if (error instanceof SyntaxError) invalid('Replay is not valid JSON'); throw error; }
  }
  const r = object(input, ['schema_version', 'ruleset', 'root', 'moves', 'metadata'], ['schema_version', 'ruleset', 'root', 'moves']);
  if (r.schema_version !== 1) invalid('Unsupported schema_version');
  if (typeof r.ruleset !== 'string') invalid('ruleset must be a string');
  if (r.ruleset !== 'orthodox-chess-v1') throw new ReplayError('E_REPLAY_RULESET', 'Unsupported replay ruleset');
  if (!isRecord(r.root)) invalid('Invalid root');
  let root: ReplayRoot;
  if (r.root.kind === 'standard') { object(r.root, ['kind']); root = { kind: 'standard' }; }
  else if (r.root.kind === 'position') {
    object(r.root, ['kind', 'position']);
    const position = parsePosition(r.root.position);
    root = standardPosition(position) ? { kind: 'standard' } : { kind: 'position', position };
  } else invalid('Unsupported root kind');
  if (!Array.isArray(r.moves)) invalid('moves must be an array');
  if (r.moves.length > 4096) limitExceeded('plies:4096');
  const moves = Array.from(r.moves, move => {
    if (typeof move !== 'string' || (!options.deferMoveSyntax && !MOVE_PATTERN.test(move))) invalid('Invalid canonical move syntax');
    return move;
  });
  const replay: Replay = { schema_version: 1, ruleset: 'orthodox-chess-v1', root, moves };
  if (Object.hasOwn(r, 'metadata')) {
    if (!isRecord(r.metadata)) invalid('metadata must be an object');
    const metadata = r.metadata;
    if (Object.keys(metadata).length > 64) limitExceeded('metadata_keys:64');
    for (const name of ['white', 'black', 'event', 'site', 'date', 'round', 'source', 'source_url']) {
      if (Object.hasOwn(metadata, name) && metadata[name] !== null && typeof metadata[name] !== 'string') invalid(`Invalid metadata.${name}`);
    }
    for (const name of ['white_rating', 'black_rating']) if (Object.hasOwn(metadata, name) && metadata[name] !== null) integer(metadata[name], 0);
    if (Object.hasOwn(metadata, 'result') && (typeof metadata.result !== 'string' || !['1-0', '0-1', '1/2-1/2', '*'].includes(metadata.result))) invalid('Invalid metadata.result');
    const copied = jsonCopy(metadata);
    if (copied === null || typeof copied !== 'object' || Array.isArray(copied)) invalid('metadata must be a JSON object');
    replay.metadata = copied;
  }
  return replay;
}
