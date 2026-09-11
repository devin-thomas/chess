import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createReplayController } from "../replay/controller.ts";
import { validateReplay } from "../replay/validate.ts";

const opening = () => ({
  schema_version: 1, ruleset: "orthodox-chess-v1", root: { kind: "standard" },
  moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"],
});

test("importing the rules engine leaves command-line stdin untouched", () => {
  const script = `import { createSimulator } from './typescript/chess_cpu.ts';
    console.log(JSON.stringify({ listeners: process.stdin.listenerCount('data'),
      ok: createSimulator().request({op:'new'}).ok }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { listeners: 0, ok: true });
});

test("unloaded, empty and boundary behavior is explicit", () => {
  const controller = createReplayController();
  assert.equal(controller.status(), "unloaded");
  assert.equal(controller.length(), 0);
  assert.equal(controller.currentPly(), 0);
  assert.equal(controller.position(), null);
  assert.equal(controller.moveAt(1), null);
  assert.equal(controller.presentationSnapshot(), null);
  for (const result of [controller.seek(0), controller.stepForward(), controller.stepBack()]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "E_REPLAY_NO_SESSION");
  }
  assert.equal(controller.load({ ...opening(), moves: [] }).ok, true);
  assert.equal(controller.status(), "ended");
  const state = controller.position();
  controller.stepForward();
  controller.stepBack();
  assert.deepEqual(controller.position(), state);
  assert.deepEqual(controller.eventsForTransition(), []);
  assert.equal(controller.lastTransition(), null);
});

test("seek and move lookup use destination plies without losing history", () => {
  const controller = createReplayController();
  const replay = opening();
  assert.equal(controller.load(replay).ok, true);
  assert.equal(controller.currentPly(), 0);
  assert.equal(controller.length(), replay.moves.length);
  for (const ply of [0, 3, 8, 2, 6, 1, 7, 4, 0, 8]) {
    const expected = validateReplay({ ...replay, moves: replay.moves.slice(0, ply) });
    assert.ok(expected.ok);
    assert.ok(controller.seek(ply).ok);
    assert.deepEqual(controller.position(), expected.final_state);
    assert.equal(controller.moveAt(ply), ply ? replay.moves[ply - 1] : null);
  }
  assert.equal(controller.moveAt(-1), null);
  assert.equal(controller.moveAt(1.5), null);
  assert.equal(controller.moveAt(9), null);
  assert.equal(controller.status(), "ended");
  controller.stepForward();
  assert.equal(controller.lastTransition(), null);
  assert.deepEqual(controller.eventsForTransition(), []);
  controller.stepBack();
  assert.equal(controller.currentPly(), 7);
  controller.stepForward();
  assert.equal(controller.currentPly(), 8);
});

test("invalid navigation and failed replacement preserve state and presentation", () => {
  const controller = createReplayController();
  controller.load(opening());
  controller.stepForward();
  const state = controller.position();
  const snapshot = controller.presentationSnapshot();
  const events = controller.eventsForTransition();
  for (const ply of [-1, 9, 0.2, NaN, Infinity]) {
    const result = controller.seek(ply);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "E_REPLAY_RANGE");
  }
  assert.equal(controller.load({ ...opening(), moves: ["e2e5"] }).ok, false);
  assert.deepEqual(controller.position(), state);
  assert.deepEqual(controller.presentationSnapshot(), snapshot);
  assert.deepEqual(controller.eventsForTransition(), events);
  assert.equal(controller.currentPly(), 1);
});

test("caller mutations cannot change loaded data or rule state", () => {
  const replay = opening();
  const controller = createReplayController();
  const result = controller.load(replay);
  assert.ok(result.ok);
  replay.moves[0] = "e2e5";
  const position = controller.position();
  assert.ok(position);
  position.board.fill(null);
  assert.ok(controller.stepForward().ok);
  assert.equal(controller.moveAt(1), "e2e4");
  assert.ok(controller.position()?.board[28]);
  assert.equal(result.root_state.board[4]?.type, "king");
});

test("history-sensitive seeks preserve automatic repetition termination", () => {
  const moves = Array.from({ length: 4 }, () => ["g1f3", "g8f6", "f3g1", "f6g8"]).flat();
  const controller = createReplayController();
  assert.ok(controller.load({ ...opening(), moves }).ok);
  controller.seek(15);
  controller.stepForward();
  assert.equal(controller.position()?.outcome?.reason, "fivefold_repetition");
  const final = controller.position();
  controller.seek(4);
  controller.seek(16);
  assert.deepEqual(controller.position(), final);
});
