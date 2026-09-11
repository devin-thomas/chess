import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_REPLAY, boardSquareOrder, createDefaultViewerState, resolvePublicRoute } from '../web/viewer-shell.ts';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('public route mapping keeps the viewer and simulator separate', () => {
  assert.equal(resolvePublicRoute('/'), 'viewer');
  assert.equal(resolvePublicRoute('/replay/opening'), 'viewer');
  assert.equal(resolvePublicRoute('/simulator'), 'simulator');
  assert.equal(resolvePublicRoute('/simulator/'), 'simulator');
  assert.equal(resolvePublicRoute('/simulator/anything'), 'simulator');
});

test('default viewer state loads the curated replay at ply zero and paused', () => {
  const viewer = createDefaultViewerState();
  const snapshot = viewer.controller.presentationSnapshot();
  assert.equal(viewer.controller.status(), 'ready');
  assert.equal(viewer.controller.currentPly(), 0);
  assert.equal(viewer.paused, true);
  assert.equal(viewer.controller.cacheMode(), 'full');
  assert.equal(viewer.boardFlipped, false);
  assert.equal(snapshot?.after_ply, 0);
  assert.equal(snapshot?.rule_state.revision, 0);
  assert.deepEqual(DEFAULT_REPLAY.moves, ['e2e4', 'e7e5', 'g1f3']);
  assert.equal(DEFAULT_REPLAY.metadata?.white, 'Fixture White');
  assert.equal(DEFAULT_REPLAY.metadata?.black, 'Fixture Black');
  assert.equal(DEFAULT_REPLAY.metadata?.result, '1-0');
});

test('board order exposes canonical squares while leaving orientation as display state', () => {
  const whitePerspective = boardSquareOrder(false);
  const blackPerspective = boardSquareOrder(true);
  assert.equal(whitePerspective.length, 64);
  assert.equal(whitePerspective[0], 'a8');
  assert.equal(whitePerspective.at(-1), 'h1');
  assert.equal(blackPerspective[0], 'h1');
  assert.equal(blackPerspective.at(-1), 'a8');
  assert.deepEqual(new Set(whitePerspective), new Set(blackPerspective));
});

test('production entry documents keep the public shell and simulator direct-loadable', () => {
  const viewerHtml = read('../web/index.html');
  const simulatorHtml = read('../web/simulator/index.html');
  assert.match(viewerHtml, /data-route="viewer"/);
  assert.match(viewerHtml, /id="viewer-board"/);
  assert.match(viewerHtml, /id="viewer-transport"/);
  assert.match(viewerHtml, /id="viewer-move-list"/);
  assert.match(viewerHtml, /id="viewer-replay-select"/);
  assert.doesNotMatch(viewerHtml, /id="viewer-replay-select"[^>]*disabled/);
  assert.match(viewerHtml, /src="\/viewer\.ts"/);
  assert.doesNotMatch(viewerHtml, /id="run-button"/);
  assert.match(simulatorHtml, /id="run-button"/);
  assert.match(simulatorHtml, /id="chess-board"/);
  assert.match(simulatorHtml, /src="\/app\.ts"/);
  assert.doesNotMatch(simulatorHtml, /data-route="viewer"/);
});
