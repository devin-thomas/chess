import { createSimulator } from '../typescript/chess_cpu.ts';
import { createReplaySession, ReplayEngineError } from './engine.ts';
import { parsePosition, parseReplay, ReplayError, MOVE_PATTERN } from './schema.ts';
import type { Color, JsonValue, Position, Replay, ReplayRoot } from './schema.ts';
import { validateReplay } from './validate.ts';
import type { ReplayDiagnostic, ReplayValidation } from './validate.ts';
import type { ReplaySession, ReplayState } from './engine.ts';

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_GAMES = 100;
const MAX_PLIES = 4096;
const MAX_METADATA_STRING_CODE_POINTS = 1024;
const MAX_METADATA_KEYS = 64;
const MAX_VARIATION_DEPTH = 32;

export const PGN_LIMITS = {
  input_bytes: MAX_INPUT_BYTES,
  games: MAX_GAMES,
  plies: MAX_PLIES,
  metadata_string_code_points: MAX_METADATA_STRING_CODE_POINTS,
  metadata_keys: MAX_METADATA_KEYS,
  variation_depth: MAX_VARIATION_DEPTH,
} as const;

const RESULT_MARKERS = new Set(['1-0', '0-1', '1/2-1/2', '*']);
const CONTROL_TAGS = new Set(['SetUp', 'FEN', 'Variant']);
const PIECE_LETTERS: Record<string, string> = {
  king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N',
};
const PROMOTION_LETTERS: Record<string, string> = {
  q: 'Q', r: 'R', b: 'B', n: 'N',
};
const FILES = 'abcdefgh';

export interface PgnSourceLocation {
  offset: number;
  line: number;
  column: number;
}

export interface PgnImportOptions {
  gameIndex?: number;
}

export interface PgnErrorSummary {
  code: string;
  message: string;
  source: PgnSourceLocation | null;
  game_index: number | null;
  move_index: number | null;
  ply: number | null;
  limit: string | null;
}

interface PgnErrorOptions {
  source?: PgnSourceLocation | null;
  game_index?: number | null;
  token?: string | null;
  san?: string | null;
  move_number?: number | null;
  location?: PgnSourceLocation | null;
  gameIndex?: number;
  moveIndex?: number;
  ply?: number;
  limit?: string;
}

export class PgnImportError extends ReplayError {
  readonly source: PgnSourceLocation | null;
  readonly location: PgnSourceLocation | null;
  readonly game_index: number | null;
  readonly token: string | null;
  readonly san: string | null;
  readonly san_token: string | null;
  readonly move_number: number | null;
  readonly import_code: string;

  constructor(message: string, options?: PgnErrorOptions);
  constructor(code: string, message: string, options?: PgnErrorOptions);
  constructor(codeOrMessage: string, messageOrOptions?: string | PgnErrorOptions, suppliedOptions: PgnErrorOptions = {}) {
    let code: string;
    let message: string;
    let options: PgnErrorOptions;
    if (typeof messageOrOptions === 'string') {
      code = codeOrMessage;
      message = messageOrOptions;
      options = suppliedOptions;
    } else {
      code = 'E_REPLAY_IMPORT';
      message = codeOrMessage;
      options = messageOrOptions ?? {};
    }
    const publicCode = code === 'E_REPLAY_LIMIT' ? code : 'E_REPLAY_IMPORT';
    const context: string[] = [];
    const source = options.source ?? options.location ?? null;
    const gameIndex = options.game_index ?? options.gameIndex ?? null;
    if (source !== null) {
      context.push(`line ${source.line}, column ${source.column}`);
    }
    if (gameIndex !== null) {
      context.push(`game ${gameIndex + 1}`);
    }
    if (options.token !== undefined && options.token !== null && options.token.length > 0) {
      context.push(`token ${JSON.stringify(options.token)}`);
    }
    super(publicCode, context.length === 0 ? message : `${message} (${context.join(', ')})`);
    this.name = 'PgnImportError';
    this.import_code = code;
    this.source = source;
    this.location = this.source;
    this.game_index = gameIndex;
    this.token = options.token ?? null;
    this.san = options.san ?? null;
    this.san_token = this.san;
    this.move_number = options.move_number ?? null;
    if (options.moveIndex !== undefined) {
      this.move_index = options.moveIndex;
      this.ply = options.ply ?? options.moveIndex + 1;
      this.last_valid_ply = options.moveIndex;
    }
    if (options.limit !== undefined) this.limit = options.limit;
  }
}

export interface PgnGameImport {
  index: number;
  source: PgnSourceLocation;
  tags: Record<string, string>;
  metadata: Record<string, JsonValue>;
  replay: Replay | null;
  root: ReplayRoot | null;
  root_side_to_move: Color;
  root_fullmove_number: number;
  plies: number;
  diagnostics: ReplayDiagnostic[];
  error: PgnImportError | null;
  label: string;
  valid: boolean;
}

export type PgnGameChoice = PgnGameImport;

export interface PgnImportCollection {
  source_bytes: number;
  games: PgnGameImport[];
  choices: PgnGameImport[];
  chooser: PgnGameChoice[];
}

export type PgnCollection = PgnImportCollection;

interface SourceLineIndex {
  starts: number[];
}

interface TokenBase {
  start: number;
  location: PgnSourceLocation;
}

type PgnToken =
  | (TokenBase & { kind: 'tag'; name: string; value: string })
  | (TokenBase & { kind: 'word'; value: string })
  | (TokenBase & { kind: 'move_number'; number: number; dots: 1 | 3; value: string })
  | (TokenBase & { kind: 'nag'; value: string })
  | (TokenBase & { kind: 'open_variation' | 'close_variation'; value: string });

interface GameBuilder {
  index: number;
  source: PgnSourceLocation;
  last_location: PgnSourceLocation;
  tags: Map<string, string>;
  tag_locations: Map<string, PgnSourceLocation>;
  mainline_started: boolean;
  initialized: boolean;
  finished: boolean;
  pending_move_number: Extract<PgnToken, { kind: 'move_number' }> | null;
  movetext_result: string | null;
  root: ReplayRoot | null;
  root_state: ReplayState | null;
  session: ReplaySession | null;
  moves: string[];
  diagnostics: ReplayDiagnostic[];
  error: PgnImportError | null;
}

interface SanCandidate {
  canonical: string;
  core: string;
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}

function isHorizontalWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\f';
}

function makeLineIndex(source: string): SourceLineIndex {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') index += 1;
      starts.push(index + 1);
    } else if (source[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return { starts };
}

function locationAt(index: SourceLineIndex, offset: number): PgnSourceLocation {
  let low = 0;
  let high = index.starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (index.starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { offset, line: low + 1, column: offset - index.starts[low] + 1 };
}

function errorAt(code: string, message: string, lineIndex: SourceLineIndex, offset: number, options: {
  game_index?: number | null;
  token?: string | null;
  san?: string | null;
  move_number?: number | null;
} = {}): PgnImportError {
  return new PgnImportError(code, message, { ...options, source: locationAt(lineIndex, offset) });
}

function limitAt(limit: string, lineIndex: SourceLineIndex, offset: number, options: {
  game_index?: number | null;
  token?: string | null;
} = {}): PgnImportError {
  const error = errorAt('E_REPLAY_LIMIT', `PGN exceeds ${limit}`, lineIndex, offset, options);
  error.limit = limit;
  return error;
}

function globalError(code: string, message: string): PgnImportError {
  return new PgnImportError(code, message);
}

function tagSyntaxError(message: string, lineIndex: SourceLineIndex, offset: number): never {
  throw errorAt('E_REPLAY_PGN', message, lineIndex, offset);
}

function readTag(source: string, start: number, lineIndex: SourceLineIndex): { token: PgnToken; next: number } {
  let cursor = start + 1;
  while (cursor < source.length && isHorizontalWhitespace(source[cursor])) cursor += 1;
  const nameStart = cursor;
  while (cursor < source.length && !isWhitespace(source[cursor]) && source[cursor] !== ']') cursor += 1;
  const name = source.slice(nameStart, cursor);
  if (!/^[A-Za-z][A-Za-z0-9_+#=:-]*$/u.test(name)) {
    tagSyntaxError('Malformed PGN tag name', lineIndex, nameStart);
  }
  if (Array.from(name).length > MAX_METADATA_STRING_CODE_POINTS) {
    throw limitAt('metadata_key_code_points:1024', lineIndex, nameStart, { token: name });
  }
  while (cursor < source.length && isHorizontalWhitespace(source[cursor])) cursor += 1;
  if (source[cursor] !== '"') tagSyntaxError('PGN tag value must be a quoted string', lineIndex, cursor);
  cursor += 1;
  const valueParts: string[] = [];
  let closed = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"') {
      cursor += 1;
      closed = true;
      break;
    }
    if (character === '\r' || character === '\n') {
      tagSyntaxError('PGN tag value cannot contain a line break', lineIndex, cursor);
    }
    if (character === '\\') {
      const escaped = source[cursor + 1];
      if (escaped !== '"' && escaped !== '\\') {
        tagSyntaxError('PGN tag contains an unsupported escape', lineIndex, cursor);
      }
      valueParts.push(escaped);
      cursor += 2;
      continue;
    }
    valueParts.push(character);
    cursor += 1;
  }
  if (!closed) tagSyntaxError('Unterminated PGN tag value', lineIndex, start);
  while (cursor < source.length && isHorizontalWhitespace(source[cursor])) cursor += 1;
  if (source[cursor] !== ']') tagSyntaxError('PGN tag is missing its closing bracket', lineIndex, cursor);
  cursor += 1;
  const value = valueParts.join('');
  if (Array.from(value).length > MAX_METADATA_STRING_CODE_POINTS) {
    throw limitAt('metadata_string_code_points:1024', lineIndex, start, { token: name });
  }
  return {
    token: { kind: 'tag', name, value, start, location: locationAt(lineIndex, start) },
    next: cursor,
  };
}

function scanPgn(source: string, lineIndex: SourceLineIndex): PgnToken[] {
  const tokens: PgnToken[] = [];
  let cursor = 0;
  let variationDepth = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (isWhitespace(character)) {
      cursor += 1;
      continue;
    }
    if (character === '{') {
      const close = source.indexOf('}', cursor + 1);
      if (close === -1) throw errorAt('E_REPLAY_PGN', 'Unterminated PGN brace comment', lineIndex, cursor);
      cursor = close + 1;
      continue;
    }
    if (character === ';') {
      const newline = source.indexOf('\n', cursor + 1);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (character === '[') {
      const tag = readTag(source, cursor, lineIndex);
      tokens.push(tag.token);
      cursor = tag.next;
      continue;
    }
    if (character === '(') {
      variationDepth += 1;
      if (variationDepth > MAX_VARIATION_DEPTH) {
        throw limitAt('variation_depth:32', lineIndex, cursor, { token: '(' });
      }
      tokens.push({ kind: 'open_variation', value: '(', start: cursor, location: locationAt(lineIndex, cursor) });
      cursor += 1;
      continue;
    }
    if (character === ')') {
      if (variationDepth === 0) throw errorAt('E_REPLAY_PGN', 'Unbalanced PGN variation close', lineIndex, cursor);
      variationDepth -= 1;
      tokens.push({ kind: 'close_variation', value: ')', start: cursor, location: locationAt(lineIndex, cursor) });
      cursor += 1;
      continue;
    }
    if (character === '$') {
      const nagStart = cursor;
      cursor += 1;
      const digitsStart = cursor;
      while (cursor < source.length && /[0-9]/u.test(source[cursor])) cursor += 1;
      if (cursor === digitsStart) throw errorAt('E_REPLAY_PGN', 'NAG must contain a numeric code', lineIndex, nagStart);
      if (cursor < source.length && !isWhitespace(source[cursor]) && !'(){};$[]'.includes(source[cursor])) {
        throw errorAt('E_REPLAY_PGN', 'NAG must be separated from the following token', lineIndex, nagStart);
      }
      tokens.push({ kind: 'nag', value: source.slice(nagStart, cursor), start: nagStart, location: locationAt(lineIndex, nagStart) });
      continue;
    }
    if (/[0-9]/u.test(character)) {
      const numberStart = cursor;
      while (cursor < source.length && /[0-9]/u.test(source[cursor])) cursor += 1;
      if (source[cursor] === '.') {
        const dotsStart = cursor;
        while (cursor < source.length && source[cursor] === '.') cursor += 1;
        const dots = cursor - dotsStart;
        if (dots !== 1 && dots !== 3) {
          throw errorAt('E_REPLAY_PGN', 'Move number must use one or three dots', lineIndex, dotsStart);
        }
        const numberText = source.slice(numberStart, dotsStart);
        const number = Number(numberText);
        if (!Number.isSafeInteger(number) || number < 1) {
          throw errorAt('E_REPLAY_PGN', 'Move number is out of range', lineIndex, numberStart, { token: numberText });
        }
        tokens.push({ kind: 'move_number', number, dots: dots as 1 | 3,
          value: source.slice(numberStart, cursor), start: numberStart, location: locationAt(lineIndex, numberStart) });
        continue;
      }
      cursor = numberStart;
    }
    if (character === ']' || character === '}' || character === '"') {
      throw errorAt('E_REPLAY_PGN', `Unexpected PGN character ${JSON.stringify(character)}`, lineIndex, cursor);
    }
    const wordStart = cursor;
    while (cursor < source.length && !isWhitespace(source[cursor]) && !'[]{}();$'.includes(source[cursor])) cursor += 1;
    if (cursor === wordStart) {
      throw errorAt('E_REPLAY_PGN', `Unexpected PGN character ${JSON.stringify(source[cursor])}`, lineIndex, cursor);
    }
    tokens.push({ kind: 'word', value: source.slice(wordStart, cursor), start: wordStart, location: locationAt(lineIndex, wordStart) });
  }
  if (variationDepth !== 0) {
    throw errorAt('E_REPLAY_PGN', 'Unbalanced PGN variation open', lineIndex, source.length);
  }
  return tokens;
}

function isResultMarker(value: string): boolean {
  return RESULT_MARKERS.has(value);
}

function isAnnotationOnly(value: string): boolean {
  return /^[!?]+$/u.test(value);
}

function stripAnnotations(value: string): { core: string; suffix: '' | '+' | '#' | null } {
  let token = value;
  const annotation = /[!?]+$/u.exec(token);
  if (annotation !== null) token = token.slice(0, -annotation[0].length);
  if (token.length === 0) throw new Error('SAN annotation has no move token');
  let suffix: '' | '+' | '#' | null = null;
  const check = /[+#]+$/u.exec(token);
  if (check !== null) {
    if (check[0].length !== 1 || (check[0] !== '+' && check[0] !== '#')) {
      throw new Error('SAN check suffix must be a single + or #');
    }
    suffix = check[0] as '+' | '#';
    token = token.slice(0, -1);
  }
  if (token.length === 0) throw new Error('SAN check suffix has no move token');
  if (token === '0-0') token = 'O-O';
  if (token === '0-0-0') token = 'O-O-O';
  return { core: token, suffix };
}

function squareIndex(square: string): number {
  return (Number(square[1]) - 1) * 8 + FILES.indexOf(square[0]);
}

function squareName(square: number): string {
  return `${FILES[square % 8]}${Math.floor(square / 8) + 1}`;
}

function decodeCanonicalMove(move: string): { from: number; to: number; promotion: string | null } {
  if (!MOVE_PATTERN.test(move)) throw new Error(`Authoritative engine returned malformed move ${move}`);
  return { from: squareIndex(move.slice(0, 2)), to: squareIndex(move.slice(2, 4)), promotion: move.length === 5 ? move[4] : null };
}

function isCapture(state: ReplayState, from: number, to: number): boolean {
  const moving = state.board[from];
  const target = state.board[to];
  if (target !== null && moving !== null && target.color !== moving.color) return true;
  return moving?.type === 'pawn' && target === null && state.en_passant_target === squareName(to) &&
    Math.abs((from % 8) - (to % 8)) === 1;
}

function candidateCore(state: ReplayState, legalMoves: readonly string[], canonical: string): string {
  const move = decodeCanonicalMove(canonical);
  const moving = state.board[move.from];
  if (moving === null) throw new Error(`Authoritative move ${canonical} has an empty source`);
  if (moving.type === 'king' && move.from % 8 === 4 && (move.to % 8 === 2 || move.to % 8 === 6) &&
      Math.floor(move.from / 8) === Math.floor(move.to / 8)) {
    return move.to % 8 === 6 ? 'O-O' : 'O-O-O';
  }
  const capture = isCapture(state, move.from, move.to);
  const destination = squareName(move.to);
  if (moving.type === 'pawn') {
    const prefix = capture ? `${FILES[move.from % 8]}x` : '';
    const promotion = move.promotion === null ? '' : `=${PROMOTION_LETTERS[move.promotion]}`;
    return `${prefix}${destination}${promotion}`;
  }
  const sameDestination = legalMoves
    .filter(candidate => candidate !== canonical)
    .map(decodeCanonicalMove)
    .filter(candidate => candidate.to === move.to && state.board[candidate.from]?.type === moving.type);
  let disambiguation = '';
  if (sameDestination.length > 0) {
    const sameFile = sameDestination.some(candidate => candidate.from % 8 === move.from % 8);
    const sameRank = sameDestination.some(candidate => Math.floor(candidate.from / 8) === Math.floor(move.from / 8));
    if (!sameFile) disambiguation = FILES[move.from % 8];
    else if (!sameRank) disambiguation = String(Math.floor(move.from / 8) + 1);
    else disambiguation = squareName(move.from);
  }
  return `${PIECE_LETTERS[moving.type]}${disambiguation}${capture ? 'x' : ''}${destination}`;
}

function actualCheckSuffix(state: ReplayState): '' | '+' | '#' {
  if (state.outcome?.reason === 'checkmate') return '#';
  return state.check === null ? '' : '+';
}

function newBuilder(index: number, source: PgnSourceLocation): GameBuilder {
  return {
    index, source, last_location: source, tags: new Map(), tag_locations: new Map(),
    mainline_started: false, initialized: false, finished: false, pending_move_number: null,
    movetext_result: null, root: null, root_state: null, session: null, moves: [], diagnostics: [], error: null,
  };
}

function setGameError(builder: GameBuilder, error: PgnImportError): void {
  if (builder.error === null) builder.error = error;
}

function rootError(builder: GameBuilder, message: string, source: PgnSourceLocation, underlying?: { code: string; message: string }): PgnImportError {
  const error = new PgnImportError('E_REPLAY_ROOT', message, { source, game_index: builder.index });
  if (underlying !== undefined) error.underlying_error = underlying;
  return error;
}

function positionFromEngineState(builder: GameBuilder, value: unknown, source: PgnSourceLocation): Position {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw rootError(builder, 'FEN root returned an invalid engine state', source);
  }
  const state = value as Record<string, unknown>;
  const rights = state.castling_rights;
  if (typeof rights !== 'string' || !/^(?:-|K?Q?k?q?)$/u.test(rights)) {
    throw rootError(builder, 'FEN root returned invalid castling rights', source);
  }
  try {
    return parsePosition({
      board: state.board,
      side_to_move: state.side_to_move,
      castling_rights: {
        white_kingside: rights.includes('K'), white_queenside: rights.includes('Q'),
        black_kingside: rights.includes('k'), black_queenside: rights.includes('q'),
      },
      en_passant_target: state.en_passant_target,
      halfmove_clock: state.halfmove_clock,
      fullmove_number: state.fullmove_number,
    });
  } catch (error) {
    if (error instanceof ReplayError) {
      throw rootError(builder, `FEN root returned an invalid position: ${error.message}`, source, {
        code: error.code, message: error.message,
      });
    }
    throw error;
  }
}

function validateHeader(builder: GameBuilder, source: PgnSourceLocation): void {
  const setup = builder.tags.get('SetUp');
  const fen = builder.tags.get('FEN');
  const variant = builder.tags.get('Variant');
  if (setup !== undefined && setup !== '0' && setup !== '1') {
    throw new PgnImportError('E_REPLAY_PGN', 'SetUp must be "0" or "1"', {
      source: builder.tag_locations.get('SetUp') ?? source, game_index: builder.index, token: setup,
    });
  }
  if (fen !== undefined && setup !== '1') {
    throw new PgnImportError('E_REPLAY_PGN', 'FEN requires SetUp "1"', {
      source: builder.tag_locations.get('FEN') ?? source, game_index: builder.index, token: fen,
    });
  }
  if (setup === '1' && fen === undefined) {
    throw new PgnImportError('E_REPLAY_PGN', 'SetUp "1" requires a FEN tag', {
      source: builder.tag_locations.get('SetUp') ?? source, game_index: builder.index, token: setup,
    });
  }
  if (variant !== undefined && variant.toLowerCase() !== 'standard') {
    throw new PgnImportError('E_REPLAY_RULESET', `Unsupported PGN variant ${JSON.stringify(variant)}`, {
      source: builder.tag_locations.get('Variant') ?? source, game_index: builder.index, token: variant,
    });
  }
  const result = builder.tags.get('Result');
  if (result !== undefined && !isResultMarker(result)) {
    throw new PgnImportError('E_REPLAY_PGN', `Invalid PGN Result tag ${JSON.stringify(result)}`, {
      source: builder.tag_locations.get('Result') ?? source, game_index: builder.index, token: result,
    });
  }
}

function initializeBuilder(builder: GameBuilder, source: PgnSourceLocation): void {
  if (builder.initialized) return;
  validateHeader(builder, source);
  const fen = builder.tags.get('FEN');
  let root: ReplayRoot;
  if (fen === undefined) {
    root = { kind: 'standard' };
  } else {
    const fenSource = builder.tag_locations.get('FEN') ?? source;
    const simulator = createSimulator();
    const response = simulator.request({ op: 'new', mode: 'all-rules-enabled', fen });
    if (response.ok !== true) {
      const responseError = response.error;
      if (typeof responseError === 'object' && responseError !== null && !Array.isArray(responseError)) {
        const details = responseError as Record<string, unknown>;
        if (typeof details.code === 'string' && typeof details.message === 'string') {
          throw rootError(builder, `FEN root was rejected: ${details.message}`, fenSource, {
            code: details.code, message: details.message,
          });
        }
      }
      throw rootError(builder, 'FEN root was rejected by the authoritative engine', fenSource);
    }
    const position = positionFromEngineState(builder, response.state, fenSource);
    root = { kind: 'position', position };
  }
  try {
    const session = createReplaySession(root);
    builder.root = root;
    builder.session = session;
    builder.root_state = session.state();
    builder.initialized = true;
  } catch (error) {
    if (error instanceof ReplayEngineError) {
      throw rootError(builder, 'Replay root was rejected by the authoritative engine', source, {
        code: error.code, message: error.message,
      });
    }
    throw error;
  }
}

function engineMoveError(builder: GameBuilder, source: PgnSourceLocation, san: string, error: ReplayEngineError): PgnImportError {
  const result = new PgnImportError('E_REPLAY_MOVE', `SAN ${JSON.stringify(san)} was rejected by the authoritative engine`, {
    source, game_index: builder.index, token: san, san, move_number: builder.session?.state().fullmove_number ?? null,
  });
  result.move_index = builder.moves.length;
  result.ply = builder.moves.length + 1;
  result.last_valid_ply = builder.moves.length;
  result.last_valid_state = builder.session?.state() ?? null;
  result.underlying_error = { code: error.code, message: error.message };
  return result;
}

function resolveSan(builder: GameBuilder, token: Extract<PgnToken, { kind: 'word' }>): void {
  if (builder.session === null || builder.root === null) throw new Error('PGN builder was not initialized');
  let parsed: { core: string; suffix: '' | '+' | '#' | null };
  try {
    parsed = stripAnnotations(token.value);
  } catch (error) {
    if (error instanceof Error) {
      const invalid = new PgnImportError('E_REPLAY_MOVE', error.message, {
        source: token.location, game_index: builder.index, token: token.value, san: token.value,
        move_number: builder.session.state().fullmove_number,
      });
      invalid.move_index = builder.moves.length;
      invalid.ply = builder.moves.length + 1;
      invalid.last_valid_ply = builder.moves.length;
      invalid.last_valid_state = builder.session.state();
      throw invalid;
    }
    throw error;
  }
  let legalMoves: string[];
  try {
    legalMoves = builder.session.legalMoves();
  } catch (error) {
    if (error instanceof ReplayEngineError) throw engineMoveError(builder, token.location, token.value, error);
    throw error;
  }
  const state = builder.session.state();
  const candidates: SanCandidate[] = legalMoves.map(canonical => ({
    canonical, core: candidateCore(state, legalMoves, canonical),
  })).filter(candidate => candidate.core === parsed.core);
  if (candidates.length === 0) {
    const invalid = new PgnImportError('E_REPLAY_MOVE', `Illegal or unrecognized SAN ${JSON.stringify(token.value)}`, {
      source: token.location, game_index: builder.index, token: token.value, san: token.value,
      move_number: state.fullmove_number,
    });
    invalid.move_index = builder.moves.length;
    invalid.ply = builder.moves.length + 1;
    invalid.last_valid_ply = builder.moves.length;
    invalid.last_valid_state = state;
    invalid.underlying_error = { code: 'E_REPLAY_SAN', message: 'SAN does not identify an authoritative legal move' };
    throw invalid;
  }
  if (candidates.length !== 1) {
    const invalid = new PgnImportError(`E_REPLAY_MOVE`, `SAN ${JSON.stringify(token.value)} is ambiguous`, {
      source: token.location, game_index: builder.index, token: token.value, san: token.value,
      move_number: state.fullmove_number,
    });
    invalid.move_index = builder.moves.length;
    invalid.ply = builder.moves.length + 1;
    invalid.last_valid_ply = builder.moves.length;
    invalid.last_valid_state = state;
    invalid.underlying_error = { code: 'E_REPLAY_SAN_AMBIGUOUS', message: 'SAN matched more than one legal move' };
    throw invalid;
  }
  const selected = candidates[0];
  let after: ReplayState;
  try {
    after = builder.session.play(selected.canonical);
  } catch (error) {
    if (error instanceof ReplayEngineError) throw engineMoveError(builder, token.location, token.value, error);
    throw error;
  }
  const actual = actualCheckSuffix(after);
  if ((parsed.suffix !== null && parsed.suffix !== actual) || (parsed.suffix === null && actual !== '')) {
    const markerProblem = parsed.suffix === null ? 'is missing' : 'has an incorrect';
    const invalid = new PgnImportError(
      'E_REPLAY_MOVE',
      `SAN ${JSON.stringify(token.value)} ${markerProblem} check suffix; authoritative result is ${actual || 'no check'}`,
      { source: token.location, game_index: builder.index, token: token.value, san: token.value, move_number: state.fullmove_number },
    );
    invalid.move_index = builder.moves.length;
    invalid.ply = builder.moves.length + 1;
    invalid.last_valid_ply = builder.moves.length;
    invalid.last_valid_state = state;
    invalid.underlying_error = { code: 'E_REPLAY_SAN_SUFFIX', message: 'SAN check marker disagrees with the authoritative result' };
    throw invalid;
  }
  builder.moves.push(selected.canonical);
  builder.pending_move_number = null;
}

function handleMoveNumber(builder: GameBuilder, token: Extract<PgnToken, { kind: 'move_number' }>): void {
  initializeBuilder(builder, token.location);
  if (builder.session === null) throw new Error('PGN builder has no session');
  if (builder.pending_move_number !== null) {
    throw new PgnImportError('E_REPLAY_PGN', 'Move number is not followed by a move', {
      source: token.location, game_index: builder.index, token: token.value,
    });
  }
  const state = builder.session.state();
  const expectedDots = state.side_to_move === 'white' ? 1 : 3;
  if (token.number !== state.fullmove_number || token.dots !== expectedDots) {
    throw new PgnImportError('E_REPLAY_PGN', `Move number ${token.value} does not match the current position`, {
      source: token.location, game_index: builder.index, token: token.value, move_number: state.fullmove_number,
    });
  }
  builder.pending_move_number = token;
}

function handleResult(builder: GameBuilder, token: Extract<PgnToken, { kind: 'word' }>, value: string): void {
  initializeBuilder(builder, token.location);
  if (builder.pending_move_number !== null) {
    throw new PgnImportError('E_REPLAY_PGN', 'Result marker cannot replace a missing move', {
      source: token.location, game_index: builder.index, token: token.value,
    });
  }
  if (builder.movetext_result !== null) {
    throw new PgnImportError('E_REPLAY_RESULT', 'PGN contains more than one movetext result marker', {
      source: token.location, game_index: builder.index, token: token.value,
    });
  }
  const tagResult = builder.tags.get('Result');
  if (tagResult !== undefined && tagResult !== value) {
    throw new PgnImportError('E_REPLAY_RESULT', `Tag result ${JSON.stringify(tagResult)} conflicts with movetext result ${JSON.stringify(value)}`, {
      source: token.location, game_index: builder.index, token: token.value,
    });
  }
  builder.movetext_result = value;
  builder.finished = true;
}

function metadataForBuilder(builder: GameBuilder): Record<string, JsonValue> | undefined {
  const metadata: Record<string, JsonValue> = {};
  const result = builder.movetext_result ?? builder.tags.get('Result');
  for (const [name, value] of builder.tags) {
    if (CONTROL_TAGS.has(name)) continue;
    if (name === 'White') metadata.white = value;
    else if (name === 'Black') metadata.black = value;
    else if (name === 'Event') metadata.event = value;
    else if (name === 'Site') metadata.site = value;
    else if (name === 'Date') metadata.date = value;
    else if (name === 'Round') metadata.round = value;
    else if (name === 'Source') metadata.source = value;
    else if (name === 'SourceURL') metadata.source_url = value;
    else if (name === 'WhiteElo' || name === 'BlackElo') {
      const rating = Number(value);
      if (/^\d+$/u.test(value) && Number.isSafeInteger(rating)) {
        metadata[name === 'WhiteElo' ? 'white_rating' : 'black_rating'] = rating;
      } else {
        metadata[name === 'WhiteElo' ? 'white_elo' : 'black_elo'] = value;
      }
    } else if (name !== 'Result') {
      const key = name.replace(/[^A-Za-z0-9_]/gu, '_').toLowerCase();
      if (key.length > 0 && !Object.hasOwn(metadata, key)) metadata[key] = value;
    }
  }
  if (result !== null && result !== undefined) metadata.result = result;
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function copyTags(tags: Map<string, string>): Record<string, string> {
  return Object.fromEntries(tags.entries());
}

function errorSummary(error: PgnImportError | null): PgnErrorSummary | null {
  if (error === null) return null;
  return {
    code: error.code,
    message: error.message,
    source: error.source,
    game_index: error.game_index,
    move_index: error.move_index,
    ply: error.ply,
    limit: error.limit,
  };
}

function gameLabel(game: Pick<PgnGameImport, 'metadata'>): string {
  const white = typeof game.metadata.white === 'string' && game.metadata.white.length > 0 ? game.metadata.white : 'Unknown';
  const black = typeof game.metadata.black === 'string' && game.metadata.black.length > 0 ? game.metadata.black : 'Unknown';
  const event = typeof game.metadata.event === 'string' && game.metadata.event.length > 0 ? ` - ${game.metadata.event}` : '';
  const result = typeof game.metadata.result === 'string' ? ` (${game.metadata.result})` : '';
  return `${white} - ${black}${event}${result}`;
}

function buildGame(builder: GameBuilder): PgnGameImport {
  const replayMetadata = metadataForBuilder(builder);
  const rootState = builder.root_state;
  let replay: Replay | null = null;
  if (builder.error === null) {
    if (builder.pending_move_number !== null) {
      setGameError(builder, new PgnImportError('E_REPLAY_PGN', 'Move number is not followed by a move', {
        source: builder.pending_move_number.location, game_index: builder.index, token: builder.pending_move_number.value,
      }));
    }
  }
  if (builder.error === null) {
    try {
      initializeBuilder(builder, builder.last_location);
      const raw: { schema_version: 1; ruleset: 'orthodox-chess-v1'; root: ReplayRoot; moves: string[]; metadata?: Record<string, JsonValue> } = {
        schema_version: 1, ruleset: 'orthodox-chess-v1', root: builder.root as ReplayRoot, moves: [...builder.moves],
        ...(replayMetadata === undefined ? {} : { metadata: replayMetadata }),
      };
      const parsed = parseReplay(raw);
      const validation: ReplayValidation = validateReplay(parsed);
      if (!validation.ok) {
        const converted = new PgnImportError(validation.error.code, validation.error.message, {
          source: builder.last_location, game_index: builder.index,
        });
        converted.move_index = validation.error.move_index;
        converted.ply = validation.error.ply;
        converted.last_valid_ply = validation.error.last_valid_ply;
        converted.last_valid_state = validation.error.last_valid_state;
        converted.underlying_error = validation.error.underlying_error;
        converted.limit = validation.error.limit;
        setGameError(builder, converted);
      } else {
        replay = validation.replay;
        builder.root = replay.root;
        builder.diagnostics = validation.diagnostics;
      }
    } catch (error) {
      if (error instanceof PgnImportError) setGameError(builder, error);
      else if (error instanceof ReplayError) {
        const converted = new PgnImportError(error.code, error.message, {
          source: builder.last_location, game_index: builder.index,
        });
        converted.move_index = error.move_index;
        converted.ply = error.ply;
        converted.last_valid_ply = error.last_valid_ply;
        converted.last_valid_state = error.last_valid_state;
        converted.underlying_error = error.underlying_error;
        converted.limit = error.limit;
        setGameError(builder, converted);
      } else throw error;
    }
  }
  const finalRoot = replay?.root ?? builder.root;
  const fallbackSide: Color = finalRoot?.kind === 'position' ? finalRoot.position.side_to_move : 'white';
  const fallbackFullmove = finalRoot?.kind === 'position' ? finalRoot.position.fullmove_number : 1;
  const game: PgnGameImport = {
    index: builder.index,
    source: builder.source,
    tags: copyTags(builder.tags),
    metadata: replayMetadata ?? {},
    replay,
    root: finalRoot,
    root_side_to_move: rootState?.side_to_move ?? fallbackSide,
    root_fullmove_number: rootState?.fullmove_number ?? fallbackFullmove,
    plies: builder.moves.length,
    diagnostics: [...builder.diagnostics],
    error: builder.error,
    label: '',
    valid: replay !== null && builder.error === null,
  };
  game.label = gameLabel(game);
  return game;
}

function startBuilder(gamesCreated: number, source: PgnSourceLocation): GameBuilder {
  if (gamesCreated >= MAX_GAMES) {
    const error = new PgnImportError('E_REPLAY_LIMIT', 'PGN exceeds games:100', { source });
    error.limit = 'games:100';
    throw error;
  }
  return newBuilder(gamesCreated, source);
}

function processToken(builder: GameBuilder, token: PgnToken, lineIndex: SourceLineIndex): void {
  builder.last_location = token.location;
  if (token.kind === 'move_number') {
    if (builder.finished) throw new PgnImportError('E_REPLAY_PGN', 'Move number appears after the result marker', {
      source: token.location, game_index: builder.index, token: token.value,
    });
    builder.mainline_started = true;
    if (builder.moves.length > MAX_PLIES) {
      throw limitAt('plies:4096', lineIndex, token.start, { game_index: builder.index, token: token.value });
    }
    handleMoveNumber(builder, token);
    return;
  }
  if (token.kind === 'nag') return;
  if (token.kind !== 'word') return;
  if (isAnnotationOnly(token.value)) return;
  if (builder.finished) {
    throw new PgnImportError('E_REPLAY_PGN', 'Movetext appears after the result marker', {
      source: token.location, game_index: builder.index, token: token.value,
    });
  }
  builder.mainline_started = true;
  if (isResultMarker(token.value)) {
    handleResult(builder, token, token.value);
    return;
  }
  if (builder.moves.length >= MAX_PLIES) {
    throw limitAt('plies:4096', lineIndex, token.start, { game_index: builder.index, token: token.value });
  }
  initializeBuilder(builder, token.location);
  resolveSan(builder, token);
}

function enforceTokenLimits(tokens: readonly PgnToken[], lineIndex: SourceLineIndex): void {
  let variationDepth = 0;
  let activeGame = false;
  let mainlineStarted = false;
  let finished = false;
  let gameCount = 0;
  let metadataKeys = 0;
  let plies = 0;
  const startGame = (token: PgnToken): void => {
    gameCount += 1;
    if (gameCount > MAX_GAMES) {
      throw limitAt('games:100', lineIndex, token.start, { token: token.kind === 'tag' ? token.name : token.value });
    }
    activeGame = true;
    mainlineStarted = false;
    finished = false;
    metadataKeys = 0;
    plies = 0;
  };
  for (const token of tokens) {
    if (token.kind === 'open_variation') {
      if (variationDepth === 0 && !activeGame) startGame(token);
      variationDepth += 1;
      continue;
    }
    if (token.kind === 'close_variation') {
      variationDepth -= 1;
      continue;
    }
    if (variationDepth > 0) continue;
    if (token.kind === 'tag') {
      if (!activeGame) startGame(token);
      else if (mainlineStarted || finished) startGame(token);
      metadataKeys += 1;
      if (metadataKeys > MAX_METADATA_KEYS) {
        throw limitAt('metadata_keys:64', lineIndex, token.start, { token: token.name });
      }
      continue;
    }
    if (token.kind === 'nag' || (token.kind === 'word' && isAnnotationOnly(token.value))) continue;
    if (!activeGame || finished) startGame(token);
    if (token.kind === 'move_number') {
      mainlineStarted = true;
      continue;
    }
    if (token.kind !== 'word') continue;
    mainlineStarted = true;
    if (isResultMarker(token.value)) {
      finished = true;
      continue;
    }
    plies += 1;
    if (plies > MAX_PLIES) {
      throw limitAt('plies:4096', lineIndex, token.start, { token: token.value });
    }
  }
}

export function parsePgn(input: string): PgnImportCollection {
  if (typeof input !== 'string') throw globalError('E_REPLAY_PGN', 'PGN input must be a string');
  const sourceBytes = new TextEncoder().encode(input).length;
  if (sourceBytes > MAX_INPUT_BYTES) {
    const error = globalError('E_REPLAY_LIMIT', 'PGN exceeds input_bytes:5242880');
    error.limit = 'input_bytes:5242880';
    throw error;
  }
  const lineIndex = makeLineIndex(input);
  const tokens = scanPgn(input, lineIndex);
  enforceTokenLimits(tokens, lineIndex);
  const games: PgnGameImport[] = [];
  let builder: GameBuilder | null = null;
  let gamesCreated = 0;
  let variationDepth = 0;
  const finish = (): void => {
    if (builder === null) return;
    games.push(buildGame(builder));
    builder = null;
  };
  const begin = (source: PgnSourceLocation): GameBuilder => {
    const next = startBuilder(gamesCreated, source);
    gamesCreated += 1;
    return next;
  };
  for (const token of tokens) {
    if (token.kind === 'open_variation') {
      if (variationDepth === 0) {
        if (builder === null) builder = begin(token.location);
        const activeBuilder = builder;
        if (activeBuilder === null) throw new Error('PGN variation parser lost its game builder');
        if (activeBuilder.finished) setGameError(activeBuilder, new PgnImportError('E_REPLAY_PGN', 'Variation appears after the result marker', {
          source: token.location, game_index: activeBuilder.index, token: token.value,
        }));
        else if (!activeBuilder.mainline_started || activeBuilder.pending_move_number !== null) {
          activeBuilder.mainline_started = true;
          setGameError(activeBuilder, new PgnImportError('E_REPLAY_PGN', 'Variation must follow a mainline move', {
            source: token.location, game_index: activeBuilder.index, token: token.value,
          }));
        }
      }
      variationDepth += 1;
      continue;
    }
    if (token.kind === 'close_variation') {
      variationDepth -= 1;
      continue;
    }
    if (variationDepth > 0) continue;
    if (token.kind === 'tag') {
      if (builder === null) builder = begin(token.location);
      else if (builder.mainline_started || builder.finished) {
        finish();
        builder = begin(token.location);
      }
      if (builder === null) throw new Error('PGN tag parser lost its game builder');
      const activeBuilder = builder;
      if (activeBuilder.tags.has(token.name)) {
        setGameError(activeBuilder, new PgnImportError('E_REPLAY_PGN', `Duplicate PGN tag ${token.name}`, {
          source: token.location, game_index: activeBuilder.index, token: token.name,
        }));
      } else if (activeBuilder.tags.size >= MAX_METADATA_KEYS) {
        setGameError(activeBuilder, limitAt('metadata_keys:64', lineIndex, token.start, {
          game_index: activeBuilder.index, token: token.name,
        }));
      } else {
        activeBuilder.tags.set(token.name, token.value);
        activeBuilder.tag_locations.set(token.name, token.location);
      }
      continue;
    }
    if (builder === null) {
      if (token.kind === 'nag' || (token.kind === 'word' && isAnnotationOnly(token.value))) continue;
      builder = begin(token.location);
    }
    if (builder.finished && token.kind !== 'nag' && !(token.kind === 'word' && isAnnotationOnly(token.value))) {
      finish();
      builder = begin(token.location);
    }
    const activeBuilder = builder;
    if (activeBuilder === null) throw new Error('PGN parser lost its game builder');
    if (activeBuilder.error !== null) continue;
    try {
      processToken(activeBuilder, token, lineIndex);
    } catch (error) {
      if (error instanceof PgnImportError) setGameError(activeBuilder, error);
      else throw error;
    }
  }
  finish();
  if (games.length === 0) throw globalError('E_REPLAY_PGN', 'PGN contains no games');
  return { source_bytes: sourceBytes, games, choices: games, chooser: games };
}

export const parsePgnCollection = parsePgn;
export const importPgnCollection = parsePgn;

export function selectPgnGame(collection: PgnImportCollection, gameIndex: number): Replay {
  if (!Number.isInteger(gameIndex) || gameIndex < 0 || gameIndex >= collection.games.length) {
    throw new PgnImportError('E_REPLAY_CHOOSER', `PGN game index ${gameIndex} is out of range`);
  }
  const game = collection.games[gameIndex];
  if (game.replay === null || game.error !== null) {
    if (game.error !== null) throw game.error;
    throw new PgnImportError('E_REPLAY_PGN', `PGN game ${gameIndex + 1} is not valid`);
  }
  const validation = validateReplay(game.replay);
  if (!validation.ok) {
    const converted = new PgnImportError(validation.error.code, validation.error.message, {
      source: game.source, game_index: game.index,
    });
    converted.move_index = validation.error.move_index;
    converted.ply = validation.error.ply;
    converted.last_valid_ply = validation.error.last_valid_ply;
    converted.last_valid_state = validation.error.last_valid_state;
    converted.underlying_error = validation.error.underlying_error;
    converted.limit = validation.error.limit;
    throw converted;
  }
  return validation.replay;
}

export function importPgn(input: string, options: PgnImportOptions | number = {}): Replay | PgnImportCollection {
  const collection = parsePgn(input);
  const requestedIndex = typeof options === 'number' ? options : options.gameIndex;
  if (requestedIndex === undefined) {
    if (collection.games.length === 1) return selectPgnGame(collection, 0);
    return collection;
  }
  return selectPgnGame(collection, requestedIndex);
}

export const importPgnGame = importPgn;
export const importPGN = importPgn;
