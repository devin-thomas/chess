import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COMPILED_REPLAY_FORMAT_VERSION,
  COMPILED_REPLAY_HEADER_BYTES,
  compileReplay,
  decodeCompiledReplay,
  verifyCompiledReplay,
} from '../replay/compiler.ts';
import type { Replay } from '../replay/schema.ts';

const shared = new URL('../shared/', import.meta.url);
const fixture = (id: string): Replay =>
  JSON.parse(readFileSync(new URL(`replay-fixtures/${id}.json`, shared), 'utf8')) as Replay;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

test('frozen compiled replay vectors preserve format bytes and manifest fields', () => {
  const vectors = JSON.parse(readFileSync(new URL('../shared/compiled-replay-vectors.json', import.meta.url), 'utf8')) as {
    vectors: Array<{ id: string; hex: string; root_kind: string; metadata_tier: number; move_count: number; source_hash: string; payload_hash: string }>;
  };
  for (const vector of vectors.vectors) {
    const compiled = compileReplay(fixture(vector.id));
    assert.equal(hex(compiled.bytes), vector.hex, vector.id);
    assert.equal(compiled.manifest.root_kind, vector.root_kind);
    assert.equal(compiled.manifest.metadata_tier, vector.metadata_tier);
    assert.equal(compiled.manifest.move_count, vector.move_count);
    assert.equal(compiled.manifest.canonical_source_sha256, vector.source_hash);
    assert.equal(compiled.manifest.compiled_payload_sha256, vector.payload_hash);
    assert.equal(compiled.bytes[4], COMPILED_REPLAY_FORMAT_VERSION);
    assert.equal(compiled.bytes.length >= COMPILED_REPLAY_HEADER_BYTES, true);
  }
});

test('compiled replay round trips standard and position roots without JSON payloads', () => {
  for (const id of ['opening', 'black-root', 'castle-kingside', 'en-passant', 'promotion-q']) {
    const source = fixture(id);
    const compiled = compileReplay(source);
    const decoded = verifyCompiledReplay(source, compiled.bytes);
    assert.deepEqual(decoded.replay.moves, source.moves, id);
    assert.deepEqual(decoded.replay.root, source.root, id);
    assert.equal(new TextDecoder().decode(compiled.bytes).includes('schema_version'), false, id);
  }
});

test('Tier-1 metadata is compact and ignores non-runtime metadata fields', () => {
  const decoded = decodeCompiledReplay(compileReplay(fixture('opening')).bytes);
  assert.deepEqual(decoded.replay.metadata, {
    white: 'Fixture White', black: 'Fixture Black', result: '1-0',
  });
});

test('corrupted headers, reserved bits, and source hashes fail explicitly', () => {
  const source = fixture('opening');
  const compiled = compileReplay(source);
  const badHeader = new Uint8Array(compiled.bytes);
  badHeader[5] |= 0x80;
  assert.throws(() => decodeCompiledReplay(badHeader), { code: 'E_COMPILED_HEADER' });
  const badMoves = new Uint8Array(compiled.bytes);
  badMoves[badMoves.length - 1] ^= 0x80;
  assert.throws(() => decodeCompiledReplay(badMoves), { code: 'E_COMPILED_MOVE' });
  const badSourceHash = new Uint8Array(compiled.bytes);
  badSourceHash[14] ^= 1;
  assert.throws(() => verifyCompiledReplay(source, badSourceHash), { code: 'E_COMPILED_HASH' });

  const badPiece = new Uint8Array(compileReplay(fixture('promotion-q')).bytes);
  badPiece[COMPILED_REPLAY_HEADER_BYTES] = 7;
  assert.throws(() => decodeCompiledReplay(badPiece), { code: 'E_COMPILED_ROOT' });
});
