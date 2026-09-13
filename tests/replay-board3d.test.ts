import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayController } from '../replay/controller.ts';
import {
  BOARD_SQUARE_COUNT,
  boardRendererParameters,
  canonicalBoardSquares,
  canonicalSquareToBoardCoordinate,
  canonicalSquareToIndex,
  fallbackAssetDescriptor,
  indexToCanonicalSquare,
  normalizeBoardOrientation,
  projectIdentityUpdates,
  projectSnapshot,
} from '../web/board3d.ts';
import {
  CLASSIC_CC0_ASSET_BASE_PATH,
  ChessPieceAssetLibrary,
  fallbackAssetRequired,
  pieceAssetFile,
  pieceAssetUrl,
  pieceVisualAssetId,
} from '../web/chess-piece-assets.ts';

const opening = {
  schema_version: 1 as const,
  ruleset: 'orthodox-chess-v1' as const,
  root: { kind: 'standard' as const },
  moves: ['e2e4', 'd7d5', 'e4d5'],
};

function snapshotAt(ply: number) {
  const controller = createReplayController();
  assert.equal(controller.load(opening).ok, true);
  assert.equal(controller.seek(ply).ok, true);
  const snapshot = controller.presentationSnapshot();
  if (snapshot === null) throw new Error('Expected a presentation snapshot');
  return snapshot;
}

test('canonical board mapping covers every square and flips only display coordinates', () => {
  assert.equal(BOARD_SQUARE_COUNT, 64);
  assert.equal(canonicalSquareToIndex('a1'), 0);
  assert.equal(indexToCanonicalSquare(63), 'h8');
  assert.equal(canonicalBoardSquares()[0], 'a8');
  assert.equal(canonicalBoardSquares().at(-1), 'h1');
  assert.equal(canonicalBoardSquares(true)[0], 'h1');
  assert.deepEqual(
    canonicalSquareToBoardCoordinate('a1', 'white'),
    { square: 'a1', file: 0, rank: 0, x: -3.5, z: 3.5 },
  );
  assert.deepEqual(
    canonicalSquareToBoardCoordinate('a1', 'black'),
    { square: 'a1', file: 0, rank: 0, x: 3.5, z: -3.5 },
  );
  assert.equal(normalizeBoardOrientation(true), 'black');
  assert.equal(normalizeBoardOrientation(false), 'white');
  assert.deepEqual(new Set(canonicalBoardSquares()), new Set(canonicalBoardSquares('black')));
});

test('snapshot projection preserves occupancy and stable presentation identities', () => {
  const root = snapshotAt(0);
  const after = snapshotAt(1);
  const rootProjection = projectSnapshot(root);
  const afterProjection = projectSnapshot(after);
  assert.equal(rootProjection.pieces.length, 32);
  assert.equal(rootProjection.occupancy.size, 32);
  assert.equal(new Set(rootProjection.pieces.map(piece => piece.piece_type)).size, 6);
  const pawn = rootProjection.occupancy.get('e2');
  assert.ok(pawn);
  assert.equal(afterProjection.occupancy.get('e4')?.piece_identity, pawn.piece_identity);
  assert.equal(afterProjection.occupancy.has('e2'), false);
  assert.equal(afterProjection.identities.size, rootProjection.identities.size);
  assert.deepEqual(
    projectIdentityUpdates(root, after).find(update => update.piece_identity === pawn.piece_identity),
    {
      piece_identity: pawn.piece_identity,
      before: rootProjection.identities.get(pawn.piece_identity),
      after: afterProjection.identities.get(pawn.piece_identity),
    },
  );
});

test('projection rejects duplicate squares or identities before a renderer can draw them', () => {
  const root = snapshotAt(0);
  const first = root.pieces[0];
  const duplicateSquare = { ...root, pieces: [...root.pieces, { ...first, piece_identity: 'extra' }] };
  assert.throws(() => projectSnapshot(duplicateSquare), /duplicate occupancy/);
  const duplicateIdentity = { ...root, pieces: [...root.pieces, { ...first, board_square: 'a3' }] };
  assert.throws(() => projectSnapshot(duplicateIdentity), /duplicate piece identity/);
});

test('primitive fallback descriptors retain the presentation asset contract', () => {
  const descriptor = fallbackAssetDescriptor({
    piece_identity: 'piece-1',
    piece_type: 'knight',
    color: 'black',
    visual_asset_id: 'black-knight',
  });
  assert.deepEqual(descriptor, {
    kind: 'primitive-fallback',
    piece_identity: 'piece-1',
    piece_type: 'knight',
    color: 'black',
    visual_asset_id: 'black-knight',
    label: 'black knight',
  });
});

test('piece assets map canonical types to six reusable runtime files', () => {
  const pieceTypes = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'] as const;
  assert.deepEqual(
    pieceTypes.map(pieceAssetFile),
    ['king.glb', 'queen.glb', 'rook.glb', 'bishop.glb', 'knight.glb', 'pawn.glb'],
  );
  assert.equal(pieceAssetUrl('knight'), `${CLASSIC_CC0_ASSET_BASE_PATH}/knight.glb`);
  assert.equal(pieceVisualAssetId('queen'), 'classic-cc0-queen');
});

test('an unloaded asset library selects a readable fallback for every piece type', () => {
  const library = new ChessPieceAssetLibrary();
  for (const pieceType of ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'] as const) {
    assert.equal(fallbackAssetRequired(library, pieceType), true);
  }
  library.dispose();
});

test('failed model requests retain the fallback path for every canonical type', async () => {
  const library = new ChessPieceAssetLibrary('/missing', {
    loadAsync: async () => { throw new Error('test model unavailable'); },
  });
  const result = await library.load();
  assert.equal(result.loaded.length, 0);
  assert.equal(result.failed.size, 6);
  for (const pieceType of ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'] as const) {
    assert.equal(fallbackAssetRequired(library, pieceType), true);
  }
  library.dispose();
});

test('webgl renderer preserves settled frames for initial viewer captures', () => {
  assert.equal(boardRendererParameters().preserveDrawingBuffer, true);
  assert.equal(boardRendererParameters({ antialias: false }).antialias, false);
});
