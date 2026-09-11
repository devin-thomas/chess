import { createHash } from 'node:crypto';
import { isRecord, parsePosition } from './schema.ts';
import type { Color, Piece, PieceType, Position, Replay, ReplayRoot } from './schema.ts';
import { validateReplay } from './validate.ts';

export const COMPILED_REPLAY_MAGIC = 'RPLY';
export const COMPILED_REPLAY_FORMAT_VERSION = 1;
export const COMPILED_REPLAY_RULESET_ID = 1;
export const COMPILED_REPLAY_HEADER_BYTES = 46;
export const COMPILED_REPLAY_MAX_PLIES = 4096;
export const COMPILED_REPLAY_POSITION_ROOT_BYTES = 75;

const FLAG_POSITION_ROOT = 1 << 0;
const FLAG_TIER1_METADATA = 1 << 1;
const KNOWN_FLAGS = FLAG_POSITION_ROOT | FLAG_TIER1_METADATA;
const ROOT_STANDARD_BYTES = 0;
const METADATA_VERSION = 1;
const METADATA_FIELDS = ['white', 'black', 'event', 'result'] as const;
const PIECE_CODES: Record<PieceType, number> = {
  pawn: 1,
  knight: 2,
  bishop: 3,
  rook: 4,
  queen: 5,
  king: 6,
};
const CODE_PIECES: Record<number, { color: Color; type: PieceType }> = {
  1: { color: 'white', type: 'pawn' },
  2: { color: 'white', type: 'knight' },
  3: { color: 'white', type: 'bishop' },
  4: { color: 'white', type: 'rook' },
  5: { color: 'white', type: 'queen' },
  6: { color: 'white', type: 'king' },
  9: { color: 'black', type: 'pawn' },
  10: { color: 'black', type: 'knight' },
  11: { color: 'black', type: 'bishop' },
  12: { color: 'black', type: 'rook' },
  13: { color: 'black', type: 'queen' },
  14: { color: 'black', type: 'king' },
};
const PROMOTION_CODES: Record<string, number> = { q: 1, r: 2, b: 3, n: 4 };
const PROMOTION_SUFFIXES: Record<number, string> = { 1: 'q', 2: 'r', 3: 'b', 4: 'n' };

export type CompiledReplayErrorCode =
  | 'E_COMPILED_SOURCE'
  | 'E_COMPILED_HEADER'
  | 'E_COMPILED_ROOT'
  | 'E_COMPILED_METADATA'
  | 'E_COMPILED_MOVE'
  | 'E_COMPILED_LIMIT'
  | 'E_COMPILED_HASH';

export class CompiledReplayError extends Error {
  readonly code: CompiledReplayErrorCode;

  constructor(code: CompiledReplayErrorCode, message: string) {
    super(message);
    this.name = 'CompiledReplayError';
    this.code = code;
  }
}

export interface CompiledReplayManifest {
  readonly schema_version: 1;
  readonly format_version: 1;
  readonly ruleset: 'orthodox-chess-v1';
  readonly root_kind: 'standard' | 'position';
  readonly metadata_tier: 0 | 1;
  readonly move_count: number;
  readonly canonical_source_sha256: string;
  readonly compiled_payload_sha256: string;
}

export interface CompiledReplayArtifact {
  readonly bytes: Uint8Array;
  readonly manifest: CompiledReplayManifest;
  readonly replay: Replay;
}

export interface DecodedReplayArtifact {
  readonly bytes: Uint8Array;
  readonly replay: Replay;
  readonly manifest: CompiledReplayManifest;
}

function fail(code: CompiledReplayErrorCode, message: string): never {
  throw new CompiledReplayError(code, message);
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalReplayJson(replay: Replay): string {
  const root = replay.root.kind === 'standard'
    ? { kind: 'standard' as const }
    : {
      kind: 'position' as const,
      position: {
        board: replay.root.position.board,
        side_to_move: replay.root.position.side_to_move,
        castling_rights: replay.root.position.castling_rights,
        en_passant_target: replay.root.position.en_passant_target,
        halfmove_clock: replay.root.position.halfmove_clock,
        fullmove_number: replay.root.position.fullmove_number,
      },
    };
  const canonical: Record<string, unknown> = {
    schema_version: replay.schema_version,
    ruleset: replay.ruleset,
    root,
    moves: [...replay.moves],
  };
  // Metadata is descriptive; replay identity is the ruleset, root, and moves.
  return JSON.stringify(canonicalValue(canonical));
}

export function canonicalReplaySha256(replay: Replay): string {
  return sha256Hex(canonicalReplayJson(replay));
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function squareIndex(value: string): number {
  return value.charCodeAt(0) - 97 + (Number(value[1]) - 1) * 8;
}

function squareName(value: number): string {
  return String.fromCharCode(97 + value % 8) + (Math.floor(value / 8) + 1);
}

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function writeUint16(view: DataView, offset: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) fail('E_COMPILED_LIMIT', 'Compiled replay field exceeds uint16');
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail('E_COMPILED_LIMIT', 'Compiled replay counter exceeds uint32');
  view.setUint32(offset, value, true);
}

function encodePiece(piece: Piece): number {
  return PIECE_CODES[piece.type] + (piece.color === 'black' ? 8 : 0);
}

function decodePiece(code: number): Piece | null {
  if (code === 0) return null;
  const piece = CODE_PIECES[code];
  if (piece === undefined) fail('E_COMPILED_ROOT', `Position root contains invalid piece code ${code}`);
  return { ...piece };
}

function encodeRoot(root: ReplayRoot): Uint8Array {
  if (root.kind === 'standard') return new Uint8Array(ROOT_STANDARD_BYTES);
  const result = new Uint8Array(COMPILED_REPLAY_POSITION_ROOT_BYTES);
  result.set(root.position.board.map(piece => piece === null ? 0 : encodePiece(piece)), 0);
  result[64] = root.position.side_to_move === 'white' ? 0 : 1;
  const rights = root.position.castling_rights;
  result[65] = (rights.white_kingside ? 1 : 0) | (rights.white_queenside ? 2 : 0) |
    (rights.black_kingside ? 4 : 0) | (rights.black_queenside ? 8 : 0);
  result[66] = root.position.en_passant_target === null ? 0xff : squareIndex(root.position.en_passant_target);
  const view = new DataView(result.buffer);
  writeUint32(view, 67, root.position.halfmove_clock);
  writeUint32(view, 71, root.position.fullmove_number);
  return result;
}

function decodeRoot(bytes: Uint8Array, positionRoot: boolean): ReplayRoot {
  if (!positionRoot) {
    if (bytes.length !== ROOT_STANDARD_BYTES) fail('E_COMPILED_ROOT', 'Standard root must not include a root payload');
    return { kind: 'standard' };
  }
  if (bytes.length !== COMPILED_REPLAY_POSITION_ROOT_BYTES) fail('E_COMPILED_ROOT', 'Position root has an invalid payload length');
  const boardCodes = [...bytes.slice(0, 64)];
  if (boardCodes.some(code => code !== 0 && decodePiece(code) === null)) {
    fail('E_COMPILED_ROOT', 'Position root contains an unknown piece code');
  }
  const board = boardCodes.map(decodePiece);
  if (bytes[64] > 1 || bytes[65] > 15 || (bytes[66] !== 0xff && bytes[66] > 63)) {
    fail('E_COMPILED_ROOT', 'Position root contains an invalid side, rights, or en-passant value');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positionInput = {
    board,
    side_to_move: bytes[64] === 0 ? 'white' : 'black',
    castling_rights: {
      white_kingside: (bytes[65] & 1) !== 0,
      white_queenside: (bytes[65] & 2) !== 0,
      black_kingside: (bytes[65] & 4) !== 0,
      black_queenside: (bytes[65] & 8) !== 0,
    },
    en_passant_target: bytes[66] === 0xff ? null : squareName(bytes[66]),
    halfmove_clock: readUint32(view, 67),
    fullmove_number: readUint32(view, 71),
  };
  try {
    const position: Position = parsePosition(positionInput);
    return { kind: 'position', position };
  } catch (error) {
    fail('E_COMPILED_ROOT', `Position root was rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function encodeMetadata(replay: Replay): { bytes: Uint8Array; tier: 0 | 1 } {
  const metadata = replay.metadata;
  const present = METADATA_FIELDS.filter(field => typeof metadata?.[field] === 'string');
  if (present.length === 0) return { bytes: new Uint8Array(), tier: 0 };
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [Uint8Array.of(METADATA_VERSION, present.reduce((mask, field) => {
    return mask | (1 << METADATA_FIELDS.indexOf(field));
  }, 0))];
  for (const field of METADATA_FIELDS) {
    const value = metadata?.[field];
    if (typeof value !== 'string') continue;
    const encoded = encoder.encode(value);
    if (encoded.length > 0xffff) fail('E_COMPILED_LIMIT', `metadata.${field} exceeds uint16 bytes`);
    const length = new Uint8Array(2);
    writeUint16(new DataView(length.buffer), 0, encoded.length);
    parts.push(length, encoded);
  }
  return { bytes: concatBytes(parts), tier: 1 };
}

function decodeMetadata(bytes: Uint8Array, tier: 0 | 1): Record<string, string> | undefined {
  if (tier === 0) {
    if (bytes.length !== 0) fail('E_COMPILED_METADATA', 'Tier-0 replay contains metadata bytes');
    return undefined;
  }
  if (bytes.length < 2 || bytes[0] !== METADATA_VERSION || bytes[1] === 0 ||
      (bytes[1] & ~((1 << METADATA_FIELDS.length) - 1)) !== 0) {
    fail('E_COMPILED_METADATA', 'Unsupported or malformed Tier-1 metadata header');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const metadata: Record<string, string> = {};
  let offset = 2;
  for (let index = 0; index < METADATA_FIELDS.length; index += 1) {
    if ((bytes[1] & (1 << index)) === 0) continue;
    if (offset + 2 > bytes.length) fail('E_COMPILED_METADATA', 'Tier-1 metadata length is truncated');
    const length = bytes[offset] | (bytes[offset + 1] << 8);
    offset += 2;
    if (offset + length > bytes.length) fail('E_COMPILED_METADATA', 'Tier-1 metadata value is truncated');
    try {
      const value = decoder.decode(bytes.slice(offset, offset + length));
      if (Array.from(value).length > 1024) fail('E_COMPILED_LIMIT', 'Tier-1 metadata value exceeds 1024 code points');
      metadata[METADATA_FIELDS[index]] = value;
    } catch (error) {
      fail('E_COMPILED_METADATA', `Tier-1 metadata is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
    }
    offset += length;
  }
  if (offset !== bytes.length) fail('E_COMPILED_METADATA', 'Tier-1 metadata has trailing bytes');
  if (metadata.result !== undefined && !['1-0', '0-1', '1/2-1/2', '*'].includes(metadata.result)) {
    fail('E_COMPILED_METADATA', 'Tier-1 result is not a Replay V1 result');
  }
  return metadata;
}

function encodeMove(move: string): number {
  const from = squareIndex(move.slice(0, 2));
  const to = squareIndex(move.slice(2, 4));
  const promotion = move.length === 5 ? PROMOTION_CODES[move[4]] : 0;
  if (!Number.isInteger(from) || from < 0 || from > 63 || !Number.isInteger(to) || to < 0 || to > 63 ||
      (move.length === 5 && promotion === undefined)) {
    fail('E_COMPILED_MOVE', `Cannot pack canonical move ${move}`);
  }
  return from | (to << 6) | (promotion << 12);
}

function decodeMoves(bytes: Uint8Array, moveCount: number): string[] {
  if (bytes.length !== moveCount * 2) fail('E_COMPILED_MOVE', 'Packed move payload has an invalid length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moves: string[] = [];
  for (let index = 0; index < moveCount; index += 1) {
    const packed = readUint16(view, index * 2);
    const promotion = (packed >> 12) & 0x7;
    if ((packed & 0x8000) !== 0 || (promotion !== 0 && PROMOTION_SUFFIXES[promotion] === undefined)) {
      fail('E_COMPILED_MOVE', `Packed move ${index + 1} uses a reserved or invalid promotion code`);
    }
    moves.push(squareName(packed & 0x3f) + squareName((packed >> 6) & 0x3f) +
      (promotion === 0 ? '' : PROMOTION_SUFFIXES[promotion]));
  }
  return moves;
}

function manifestFor(replay: Replay, bytes: Uint8Array, metadataTier: 0 | 1): CompiledReplayManifest {
  return {
    schema_version: 1,
    format_version: 1,
    ruleset: 'orthodox-chess-v1',
    root_kind: replay.root.kind,
    metadata_tier: metadataTier,
    move_count: replay.moves.length,
    canonical_source_sha256: canonicalReplaySha256(replay),
    compiled_payload_sha256: sha256Hex(bytes),
  };
}

export function compileReplay(input: unknown): CompiledReplayArtifact {
  const validation = validateReplay(input);
  if (!validation.ok) fail('E_COMPILED_SOURCE', validation.error.message);
  const replay = structuredClone(validation.replay);
  if (replay.moves.length > COMPILED_REPLAY_MAX_PLIES) fail('E_COMPILED_LIMIT', 'Replay exceeds compiled move capacity');
  const root = encodeRoot(replay.root);
  const metadata = encodeMetadata(replay);
  if (root.length > 0xffff || metadata.bytes.length > 0xffff) fail('E_COMPILED_LIMIT', 'Compiled payload section exceeds uint16 length');
  const header = new Uint8Array(COMPILED_REPLAY_HEADER_BYTES);
  header.set(new TextEncoder().encode(COMPILED_REPLAY_MAGIC), 0);
  header[4] = COMPILED_REPLAY_FORMAT_VERSION;
  header[5] = (replay.root.kind === 'position' ? FLAG_POSITION_ROOT : 0) | (metadata.tier === 1 ? FLAG_TIER1_METADATA : 0);
  header[6] = COMPILED_REPLAY_RULESET_ID;
  header[7] = 0;
  const headerView = new DataView(header.buffer);
  writeUint16(headerView, 8, replay.moves.length);
  writeUint16(headerView, 10, root.length);
  writeUint16(headerView, 12, metadata.bytes.length);
  const sourceHash = Uint8Array.from(Buffer.from(canonicalReplaySha256(replay), 'hex'));
  header.set(sourceHash, 14);
  const packedMoves = new Uint8Array(replay.moves.length * 2);
  const moveView = new DataView(packedMoves.buffer);
  replay.moves.forEach((move, index) => writeUint16(moveView, index * 2, encodeMove(move)));
  const bytes = concatBytes([header, root, metadata.bytes, packedMoves]);
  return { bytes, manifest: manifestFor(replay, bytes, metadata.tier), replay };
}

function sourceHashFromHeader(bytes: Uint8Array): string {
  return Buffer.from(bytes.slice(14, 46)).toString('hex');
}

export function decodeCompiledReplay(input: Uint8Array): DecodedReplayArtifact {
  const bytes = new Uint8Array(input);
  if (bytes.length < COMPILED_REPLAY_HEADER_BYTES) fail('E_COMPILED_HEADER', 'Compiled replay is shorter than its header');
  const magic = new TextDecoder().decode(bytes.slice(0, 4));
  if (magic !== COMPILED_REPLAY_MAGIC || bytes[4] !== COMPILED_REPLAY_FORMAT_VERSION || bytes[6] !== COMPILED_REPLAY_RULESET_ID ||
      bytes[7] !== 0 || (bytes[5] & ~KNOWN_FLAGS) !== 0) {
    fail('E_COMPILED_HEADER', 'Compiled replay header is unsupported');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moveCount = readUint16(view, 8);
  const rootLength = readUint16(view, 10);
  const metadataLength = readUint16(view, 12);
  const positionRoot = (bytes[5] & FLAG_POSITION_ROOT) !== 0;
  const metadataTier: 0 | 1 = (bytes[5] & FLAG_TIER1_METADATA) !== 0 ? 1 : 0;
  const expectedLength = COMPILED_REPLAY_HEADER_BYTES + rootLength + metadataLength + moveCount * 2;
  if (expectedLength !== bytes.length) fail('E_COMPILED_HEADER', 'Compiled replay length does not match its header');
  const rootEnd = COMPILED_REPLAY_HEADER_BYTES + rootLength;
  const metadataEnd = rootEnd + metadataLength;
  const root = decodeRoot(bytes.slice(COMPILED_REPLAY_HEADER_BYTES, rootEnd), positionRoot);
  const decodedMetadata = decodeMetadata(bytes.slice(rootEnd, metadataEnd), metadataTier);
  const moves = decodeMoves(bytes.slice(metadataEnd), moveCount);
  const replay: Replay = { schema_version: 1, ruleset: 'orthodox-chess-v1', root, moves };
  if (decodedMetadata !== undefined) replay.metadata = decodedMetadata;
  const validation = validateReplay(replay);
  if (!validation.ok) fail('E_COMPILED_MOVE', `Decoded replay is not legal: ${validation.error.message}`);
  const manifest = manifestFor(replay, bytes, metadataTier);
  if (manifest.canonical_source_sha256 !== sourceHashFromHeader(bytes)) {
    fail('E_COMPILED_HASH', 'Compiled replay canonical source hash does not match its payload');
  }
  return {
    bytes,
    replay,
    manifest,
  };
}

export function verifyCompiledReplay(source: unknown, compiled: Uint8Array): DecodedReplayArtifact {
  const expected = compileReplay(source);
  const actual = decodeCompiledReplay(compiled);
  if (actual.manifest.canonical_source_sha256 !== expected.manifest.canonical_source_sha256) {
    fail('E_COMPILED_HASH', 'Compiled replay source hash does not match the canonical source');
  }
  if (actual.manifest.compiled_payload_sha256 !== expected.manifest.compiled_payload_sha256) {
    fail('E_COMPILED_HASH', 'Compiled replay payload hash does not match the canonical source');
  }
  if (actual.manifest.move_count !== expected.manifest.move_count ||
      actual.manifest.root_kind !== expected.manifest.root_kind ||
      actual.manifest.metadata_tier !== expected.manifest.metadata_tier ||
      JSON.stringify(actual.replay.moves) !== JSON.stringify(expected.replay.moves)) {
    fail('E_COMPILED_HASH', 'Compiled replay manifest does not match the canonical source');
  }
  return actual;
}
