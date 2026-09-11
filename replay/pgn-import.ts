import { createReplaySession } from './engine.ts';
import type { ReplaySession, ReplayState } from './engine.ts';
import { createSimulator } from '../typescript/chess_cpu.ts';
import { parseReplay, ReplayError } from './schema.ts';
import type { Color, Piece, Position, Replay, ReplayRoot } from './schema.ts';

export const PGN_LIMITS = {
  input_bytes: 5 * 1024 * 1024,
  games: 100,
  plies: 4096,
  metadata_string_code_points: 1024,
  metadata_keys: 64,
  variation_depth: 32,
} as const;

export interface PgnSourceLocation { offset: number; line: number; column: number }
export class PgnImportError extends ReplayError {
  readonly game_index: number | null;
  readonly token: string | null;
  readonly location: PgnSourceLocation | null;
  constructor(message: string, options: { gameIndex?: number; token?: string; location?: PgnSourceLocation; limit?: string; moveIndex?: number; ply?: number } = {}) {
    super(options.limit === undefined ? 'E_REPLAY_IMPORT' : 'E_REPLAY_LIMIT', message);
    this.game_index = options.gameIndex ?? null;
    this.token = options.token ?? null;
    this.location = options.location ?? null;
    if (options.moveIndex !== undefined) { this.move_index = options.moveIndex; this.ply = options.ply ?? options.moveIndex + 1; this.last_valid_ply = options.moveIndex; }
    if (options.limit !== undefined) this.limit = options.limit;
  }
}

export interface PgnGameChoice {
  index: number;
  tags: Record<string, string>;
  replay: Replay | null;
  error: PgnImportError | null;
}
export interface PgnCollection { games: PgnGameChoice[]; choices: PgnGameChoice[]; }
export interface PgnImportOptions { gameIndex?: number }

interface Tag { name: string; value: string; location: PgnSourceLocation }
interface Token { value: string; location: PgnSourceLocation; kind: 'word' | 'result' | 'move_number' }
interface RawGame { tags: Tag[]; tokens: Token[]; index: number }

function location(source: string, offset: number): PgnSourceLocation {
  const before = source.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { offset, line: 1 + (before.match(/\n/g)?.length ?? 0), column: offset - lineStart + 1 };
}
function fail(message: string, gameIndex: number | undefined, token?: Token, limit?: string): never {
  throw new PgnImportError(message, { gameIndex, token: token?.value, location: token?.location, limit });
}
function limit(name: string, gameIndex?: number, token?: Token): never {
  return fail(`PGN exceeds ${name}`, gameIndex, token, `${name}:${PGN_LIMITS[name as keyof typeof PGN_LIMITS]}`);
}
function codePoints(value: string): number { return Array.from(value).length; }
function unescapeTag(value: string): string { return value.replace(/\\([\\"])/g, '$1'); }

function tokenize(source: string): RawGame[] {
  if (new TextEncoder().encode(source).length > PGN_LIMITS.input_bytes) limit('input_bytes');
  const games: RawGame[] = [];
  let current: RawGame = { tags: [], tokens: [], index: 0 };
  let offset = 0;
  let variationDepth = 0;
  let sawMovetext = false;
  const pushGame = () => {
    if (current.tags.length > 0 || current.tokens.length > 0) {
      games.push(current);
      if (games.length > PGN_LIMITS.games) limit('games');
      current = { tags: [], tokens: [], index: games.length };
      sawMovetext = false;
    }
  };
  while (offset < source.length) {
    const char = source[offset];
    if (/\s/.test(char)) { offset += 1; continue; }
    if (char === '{') {
      const start = offset; offset += 1;
      while (offset < source.length && source[offset] !== '}') offset += 1;
      if (offset >= source.length) fail(`Unterminated comment at ${location(source, start).line}:${location(source, start).column}`, current.index, undefined);
      offset += 1; continue;
    }
    if (char === ';') {
      offset += 1;
      while (offset < source.length && source[offset] !== '\n') offset += 1;
      continue;
    }
    if (char === '[') {
      const start = offset; offset += 1;
      while (offset < source.length && /\s/.test(source[offset])) offset += 1;
      const nameStart = offset;
      while (offset < source.length && /[A-Za-z0-9_+#=-]/.test(source[offset])) offset += 1;
      const name = source.slice(nameStart, offset);
      if (!name) fail(`Malformed tag at ${location(source, start).line}:${location(source, start).column}`, current.index);
      while (offset < source.length && /\s/.test(source[offset])) offset += 1;
      if (source[offset] !== '"') fail(`Malformed tag ${name}`, current.index, { value: name, location: location(source, nameStart), kind: 'word' });
      offset += 1; const valueStart = offset; let raw = ''; let closed = false;
      while (offset < source.length) {
        if (source[offset] === '\\' && offset + 1 < source.length) { raw += source.slice(offset, offset + 2); offset += 2; continue; }
        if (source[offset] === '"') { closed = true; break; }
        if (source[offset] === '\n' || source[offset] === '\r') fail(`Unterminated tag ${name}`, current.index, undefined);
        raw += source[offset]; offset += 1;
      }
      if (!closed) fail(`Unterminated tag ${name}`, current.index);
      if (codePoints(unescapeTag(raw)) > PGN_LIMITS.metadata_string_code_points) limit('metadata_string_code_points', current.index);
      offset += 1;
      while (offset < source.length && /\s/.test(source[offset])) offset += 1;
      if (source[offset] !== ']') fail(`Malformed tag ${name}`, current.index);
      offset += 1;
      if (sawMovetext) pushGame();
      current.tags.push({ name, value: unescapeTag(raw), location: location(source, start) });
      if (current.tags.length > PGN_LIMITS.metadata_keys) limit('metadata_keys', current.index);
      continue;
    }
    if (char === '(') {
      variationDepth += 1;
      if (variationDepth > PGN_LIMITS.variation_depth) limit('variation_depth', current.index);
      offset += 1; continue;
    }
    if (char === ')') {
      if (variationDepth === 0) fail('Unbalanced variation close', current.index);
      variationDepth -= 1; offset += 1; continue;
    }
    const start = offset;
    while (offset < source.length && !/\s|[{}();()[\]]/.test(source[offset])) offset += 1;
    const value = source.slice(start, offset);
    if (value.startsWith('$')) continue;
    const result = ['1-0', '0-1', '1/2-1/2', '*'].includes(value);
    const moveNumber = /^\d+\.(?:\.\.)?$/.test(value);
    if (variationDepth === 0) {
      current.tokens.push({ value, location: location(source, start), kind: result ? 'result' : moveNumber ? 'move_number' : 'word' });
      if (result) pushGame(); else sawMovetext = true;
    }
  }
  if (variationDepth !== 0) fail('Unbalanced variation open', current.index);
  pushGame();
  return games;
}

const pieceLetter: Record<Piece['type'], string> = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: '' };
const promotionLetter: Record<string, string> = { q: 'Q', r: 'R', b: 'B', n: 'N' };
function squareIndex(square: string): number { return (Number(square[1]) - 1) * 8 + square.charCodeAt(0) - 97; }
function squareName(index: number): string { return `${String.fromCharCode(97 + index % 8)}${Math.floor(index / 8) + 1}`; }
function moveParts(move: string): { from: number; to: number; promotion?: string } { return { from: squareIndex(move.slice(0, 2)), to: squareIndex(move.slice(2, 4)), ...(move.length === 5 ? { promotion: move[4] } : {}) }; }
function isCapture(state: ReplayState, from: number, to: number, piece: Piece): boolean { return state.board[to] !== null || (piece.type === 'pawn' && state.en_passant_target === squareName(to) && from % 8 !== to % 8); }
function sanBase(state: ReplayState, move: string, legal: string[]): string {
  const { from, to, promotion } = moveParts(move); const piece = state.board[from];
  if (piece === null) throw new Error('engine returned a move from an empty square');
  const file = String.fromCharCode(97 + from % 8); const rank = String(Math.floor(from / 8) + 1);
  if (piece.type === 'king' && Math.abs(to % 8 - from % 8) === 2) return to % 8 > from % 8 ? 'O-O' : 'O-O-O';
  const capture = isCapture(state, from, to, piece);
  let prefix = pieceLetter[piece.type];
  if (piece.type === 'pawn') { if (capture) prefix += `${file}x`; }
  else {
    const alternatives = legal.filter(candidate => {
      const parts = moveParts(candidate); return candidate !== move && parts.to === to && state.board[parts.from]?.type === piece.type;
    });
    if (alternatives.length > 0) {
      const sameFile = alternatives.some(candidate => moveParts(candidate).from % 8 === from % 8);
      const sameRank = alternatives.some(candidate => Math.floor(moveParts(candidate).from / 8) === Math.floor(from / 8));
      prefix += sameFile ? (sameRank ? file + rank : rank) : file;
    }
    if (capture) prefix += 'x';
  }
  return `${prefix}${squareName(to)}${promotion === undefined ? '' : `=${promotionLetter[promotion]}`}`;
}
function suffix(state: ReplayState): string { return state.outcome?.reason === 'checkmate' ? '#' : state.check === null ? '' : '+'; }
function normalizeSan(value: string): { base: string; check: string | null } {
  let token = value.replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O');
  token = token.replace(/[!?]+$/, '');
  const check = token.endsWith('#') ? '#' : token.endsWith('+') ? '+' : null;
  if (check !== null) token = token.slice(0, -check.length);
  return { base: token, check };
}

function tagMap(tags: Tag[], gameIndex: number): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tags) { if (Object.hasOwn(result, tag.name) && result[tag.name] !== tag.value) fail(`Conflicting tag ${tag.name}`, gameIndex); result[tag.name] = tag.value; }
  return result;
}
function rootFor(tags: Record<string, string>, gameIndex: number): ReplayRoot {
  const setup = tags.SetUp; const fen = tags.FEN;
  if (setup !== undefined && setup !== '0' && setup !== '1') fail('SetUp tag must be "0" or "1"', gameIndex);
  if (setup === '1' && fen === undefined) fail('SetUp "1" requires a FEN tag', gameIndex);
  if (setup !== '1' && fen !== undefined) fail('FEN requires SetUp "1"', gameIndex);
  if (tags.Variant !== undefined && !/^standard$/i.test(tags.Variant)) fail(`Unsupported variant ${tags.Variant}`, gameIndex);
  if (fen === undefined) return { kind: 'standard' };
  const response = createSimulator().request({ op: 'new', mode: 'all-rules-enabled', fen });
  if (response.ok !== true || !isRecord(response.state)) fail(`Invalid FEN: ${typeof response.error === 'object' && response.error !== null && 'message' in response.error ? String(response.error.message) : 'engine rejected the position'}`, gameIndex);
  const state = response.state;
  if (!Array.isArray(state.board) || (state.side_to_move !== 'white' && state.side_to_move !== 'black') || typeof state.castling_rights !== 'string' ||
      (state.en_passant_target !== null && typeof state.en_passant_target !== 'string') || typeof state.halfmove_clock !== 'number' || typeof state.fullmove_number !== 'number') {
    fail('Invalid FEN: authoritative engine returned an invalid position', gameIndex);
  }
  const rights = state.castling_rights;
  if (!/^(?:-|K?Q?k?q?)$/.test(rights)) fail('Invalid FEN: authoritative engine returned invalid castling rights', gameIndex);
  return { kind: 'position', position: {
    board: state.board as Position['board'], side_to_move: state.side_to_move as Color,
    castling_rights: { white_kingside: rights.includes('K'), white_queenside: rights.includes('Q'), black_kingside: rights.includes('k'), black_queenside: rights.includes('q') },
    en_passant_target: state.en_passant_target as string | null, halfmove_clock: state.halfmove_clock as number, fullmove_number: state.fullmove_number as number,
  } };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function makeGame(raw: RawGame): PgnGameChoice {
  const tags = tagMap(raw.tags, raw.index); const metadata: Record<string, string> = {};
  const known = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'WhiteElo', 'BlackElo', 'Source', 'SourceURL'];
  for (const tag of known) if (tags[tag] !== undefined) metadata[tag] = tags[tag];
  let root: ReplayRoot;
  try { root = rootFor(tags, raw.index); }
  catch (error) {
    if (error instanceof PgnImportError) return { index: raw.index, tags, replay: null, error };
    throw error;
  }
  const moveTokens = raw.tokens.filter(token => token.kind === 'word');
  if (moveTokens.length > PGN_LIMITS.plies) limit('plies', raw.index, moveTokens[PGN_LIMITS.plies]);
  const metadataResult: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const name = key === 'WhiteElo' ? (/^\d+$/.test(value) ? 'white_rating' : 'white_elo') : key === 'BlackElo' ? (/^\d+$/.test(value) ? 'black_rating' : 'black_elo') : key === 'White' ? 'white' : key === 'Black' ? 'black' : key === 'Event' ? 'event' : key === 'Site' ? 'site' : key === 'Date' ? 'date' : key === 'Round' ? 'round' : key === 'Result' ? 'result' : key === 'SourceURL' ? 'source_url' : key.toLowerCase();
    metadataResult[name] = ['white_rating', 'black_rating'].includes(name) && /^\d+$/.test(value) ? Number(value) : value;
  }
  for (const [name, value] of Object.entries(tags)) {
    if (['SetUp', 'FEN', 'Variant', 'Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'WhiteElo', 'BlackElo', 'Source', 'SourceURL'].includes(name)) continue;
    const key = name.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
    if (key.length > 0 && !Object.hasOwn(metadataResult, key)) metadataResult[key] = value;
  }
  let session: ReplaySession;
  try { session = createReplaySession(root); } catch (error) { return { index: raw.index, tags, replay: null, error: new PgnImportError(`Invalid root: ${(error as Error).message}`, { gameIndex: raw.index }) }; }
  const moves: string[] = []; let recorded: string | undefined;
  try {
    for (const token of raw.tokens) {
      if (token.kind === 'move_number') continue;
      if (token.kind === 'result') { if (recorded !== undefined && recorded !== token.value) fail(`Conflicting results: ${recorded} and ${token.value}`, raw.index, token); recorded = token.value; continue; }
      if (token.value.startsWith('$')) continue;
      const normalized = normalizeSan(token.value); const state = session.state(); const legal = session.legalMoves();
      const matches = legal.filter(move => sanBase(state, move, legal) === normalized.base);
      if (matches.length !== 1) throw new PgnImportError(`SAN ${token.value} does not identify exactly one legal move`, { gameIndex: raw.index, token: token.value, location: token.location, moveIndex: moves.length });
      const next = session.play(matches[0]); const expected = suffix(next);
      if (normalized.check !== null && normalized.check !== expected) throw new PgnImportError(`SAN ${token.value} has incorrect check marker`, { gameIndex: raw.index, token: token.value, location: token.location, moveIndex: moves.length });
      if (normalized.check === null && expected !== '') throw new PgnImportError(`SAN ${token.value} is missing check marker`, { gameIndex: raw.index, token: token.value, location: token.location, moveIndex: moves.length });
      moves.push(matches[0]);
    }
    if (recorded !== undefined && tags.Result !== undefined && tags.Result !== recorded) fail(`Conflicting results: tag ${tags.Result}, movetext ${recorded}`, raw.index);
    if (recorded === undefined && tags.Result !== undefined) recorded = tags.Result;
    if (recorded !== undefined) metadataResult.result = recorded;
  } catch (error) {
    if (error instanceof PgnImportError) { error.last_valid_state = session.state(); return { index: raw.index, tags, replay: null, error }; }
    throw error;
  }
  try {
    const replay = parseReplay({ schema_version: 1, ruleset: 'orthodox-chess-v1', root, moves, ...(Object.keys(metadataResult).length > 0 ? { metadata: metadataResult } : {}) });
    return { index: raw.index, tags, replay, error: null };
  } catch (error) {
    if (error instanceof ReplayError) return { index: raw.index, tags, replay: null, error: new PgnImportError(error.message, { gameIndex: raw.index, limit: error.limit ?? undefined }) };
    throw error;
  }
}

export function importPgnCollection(source: string): PgnCollection {
  const games = tokenize(source).map(raw => {
    try { return makeGame(raw); }
    catch (error) {
      if (!(error instanceof PgnImportError)) throw error;
      return { index: raw.index, tags: Object.fromEntries(raw.tags.map(tag => [tag.name, tag.value])), replay: null, error };
    }
  });
  return { games, choices: games };
}
export function parsePgn(source: string): PgnCollection { return importPgnCollection(source); }
export function importPgn(source: string, options: PgnImportOptions = {}): Replay | PgnCollection {
  const collection = importPgnCollection(source);
  if (options.gameIndex !== undefined) {
    const selected = collection.games[options.gameIndex];
    if (selected === undefined) throw new PgnImportError(`PGN game index ${options.gameIndex} is out of range`);
    if (selected.error !== null) throw selected.error;
    if (selected.replay === null) throw new PgnImportError('Selected PGN game is invalid');
    return selected.replay;
  }
  if (collection.games.length === 1) {
    const game = collection.games[0]; if (game.error !== null) throw game.error; if (game.replay === null) throw new PgnImportError('PGN game is invalid'); return game.replay;
  }
  return collection;
}
export const importPGN = importPgn;
