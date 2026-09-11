import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createReplayController } from "../replay/controller.ts";
import { validateReplay } from "../replay/validate.ts";
import type { ReplayState } from "../replay/engine.ts";
import { positionToFen } from "../replay/engine.ts";

interface Checkpoint {
  ply: number;
  state: ReplayState;
  position_key: string;
}

interface Expected {
  valid: boolean;
  checkpoints: Checkpoint[];
  error?: {
    code: string;
    move_index: number;
    ply: number;
    last_valid_ply: number;
    underlying_code: string;
  };
}

const shared = new URL("../shared/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, shared), "utf8"));
const manifest: { cases: { id: string; artifact: string; expected: string }[] } = read("replay-cases.json");

for (const fixture of manifest.cases) {
  test(`shared replay: ${fixture.id}`, () => {
    const artifact = read(fixture.artifact);
    const original = structuredClone(artifact);
    const expected: Expected = read(fixture.expected);
    const result = validateReplay(artifact);
    assert.equal(result.ok, expected.valid);
    assert.deepEqual(artifact, original, "validation must preserve canonical input");
    const last = expected.checkpoints.at(-1)!;
    if (!result.ok) {
      assert.ok(expected.error);
      assert.equal(result.error.code, expected.error.code);
      assert.equal(result.error.move_index, expected.error.move_index);
      assert.equal(result.error.ply, expected.error.ply);
      assert.equal(result.error.last_valid_ply, expected.error.last_valid_ply);
      assert.equal(result.error.underlying_error?.code, expected.error.underlying_code);
      assert.deepEqual(result.error.last_valid_state, last.state);
      return;
    }
    assert.deepEqual(result.root_state, expected.checkpoints[0].state);
    assert.deepEqual(result.final_state, last.state);
    if (fixture.id === "checkmate") {
      assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "W_REPLAY_RESULT"));
    }
    if (fixture.id === "opening") {
      assert.equal(result.replay.metadata?.result, "1-0");
      assert.equal(result.final_state.outcome, null, "a recorded result cannot terminate an active position");
    }
    const controller = createReplayController();
    assert.equal(controller.load(artifact).ok, true);
    assert.equal(controller.length(), artifact.moves.length);
    assert.equal(controller.stepBack().ok, true);
    assert.deepEqual(controller.position(), expected.checkpoints[0].state);
    for (const badPly of [-1, artifact.moves.length + 1, 0.5, Number.NaN]) {
      assert.equal(controller.seek(badPly).ok, false);
      assert.deepEqual(controller.position(), expected.checkpoints[0].state);
    }
    // Reverse and alternating seeks expose reconstruction that loses repetition history.
    const order = [...expected.checkpoints].reverse().concat(expected.checkpoints.filter((_, i) => i % 2 === 0));
    for (const checkpoint of order) {
      assert.equal(controller.seek(checkpoint.ply).ok, true);
      assert.equal(controller.currentPly(), checkpoint.ply);
      const state = controller.position();
      assert.deepEqual(state, checkpoint.state, `authoritative state at ply ${checkpoint.ply}`);
      assert.ok(state!.repetition_counts[checkpoint.position_key] >= 1, "oracle position key exists in history");
      const positionKey = positionToFen(state!).split(" ").slice(0, 3).join(" ") + " " +
        (controller.presentationSnapshot()!.effective_en_passant_target ?? "-");
      assert.equal(positionKey, checkpoint.position_key, "effective position identity matches the independent oracle");
      if (checkpoint.ply < controller.length()) {
        assert.equal(controller.stepForward().ok, true);
        assert.deepEqual(controller.position(), expected.checkpoints[checkpoint.ply + 1].state);
        assert.equal(controller.stepBack().ok, true);
        assert.deepEqual(controller.position(), checkpoint.state);
      }
    }
    assert.equal(controller.seek(controller.length()).ok, true);
    assert.equal(controller.stepForward().ok, true);
    assert.deepEqual(controller.position(), last.state);
    assert.equal(controller.load(read("replay-fixtures/invalid-move.json")).ok, false);
    assert.deepEqual(controller.position(), last.state, "failed load preserves the loaded replay");
    assert.deepEqual(artifact, original, "seeking must preserve canonical input");
  });
}

test("fixture semantics independently identify special-move effects", () => {
  const stateAtEnd = (id: string): ReplayState => read(`replay-fixtures/${id}.expected.json`).checkpoints.at(-1).state;
  const piece = (state: ReplayState, square: string) => state.board[(Number(square[1]) - 1) * 8 + square.charCodeAt(0) - 97];
  const ep = stateAtEnd("en-passant");
  assert.equal(piece(ep, "d5"), null);
  assert.deepEqual(piece(ep, "d6"), { color: "white", type: "pawn" });
  const castle = stateAtEnd("castle-kingside");
  for (const [square, color, type] of [["g1", "white", "king"], ["f1", "white", "rook"], ["c8", "black", "king"], ["d8", "black", "rook"]]) {
    assert.deepEqual(piece(castle, square), { color, type });
  }
  for (const [suffix, type] of [["q", "queen"], ["r", "rook"], ["b", "bishop"], ["n", "knight"]]) {
    assert.deepEqual(piece(stateAtEnd(`promotion-${suffix}`), "a8"), { color: "white", type });
  }
  assert.deepEqual(piece(stateAtEnd("capture-promotion"), "h8"), { color: "white", type: "queen" });
  assert.equal(stateAtEnd("repetition").outcome?.reason, "fivefold_repetition");
  assert.equal(stateAtEnd("seventy-five-move").outcome?.reason, "seventy_five_move");
  assert.equal(stateAtEnd("checkmate").outcome?.result, "0-1");
});

test("special-move identities survive captures, promotions and arbitrary reconstruction", () => {
  for (const id of ["capture", "en-passant", "capture-promotion", "promotion-q", "promotion-r", "promotion-b", "promotion-n", "castle-kingside", "castle-queenside"]) {
    const controller = createReplayController();
    assert.equal(controller.load(read(`replay-fixtures/${id}.json`)).ok, true);
    const root = controller.presentationSnapshot()!;
    const piecesAtPly = [root.pieces];
    while (controller.currentPly() < controller.length()) {
      const before = controller.presentationSnapshot()!;
      assert.equal(controller.stepForward().ok, true);
      const move = controller.lastTransition()!;
      const after = controller.presentationSnapshot()!;
      assert.equal(move.piece_identity, before.pieces.find((piece) => piece.board_square === move.from)!.piece_identity);
      assert.equal(move.piece_identity, after.pieces.find((piece) => piece.board_square === move.to)!.piece_identity);
      if (move.captured) assert.ok(!after.pieces.some((piece) => piece.piece_identity === move.captured!.piece_identity));
      if (move.castling_rook) assert.equal(after.pieces.find((piece) => piece.board_square === move.castling_rook!.to)!.piece_identity, move.castling_rook.piece_identity);
      piecesAtPly.push(after.pieces);
    }
    const finalEpoch = controller.presentationSnapshot()!.state_epoch;
    for (let ply = controller.length() - 1; ply >= 0; ply--) {
      assert.equal(controller.seek(ply).ok, true);
      assert.deepEqual(controller.presentationSnapshot()!.pieces, piecesAtPly[ply], `${id} identity at ply ${ply}`);
      assert.ok(controller.presentationSnapshot()!.state_epoch > finalEpoch);
      assert.deepEqual(controller.eventsForTransition().map((event) => event.kind), ["state_reset_or_load"]);
      assert.equal(controller.lastTransition(), null);
    }
    assert.equal(controller.seek(controller.length()).ok, true);
    assert.deepEqual(controller.presentationSnapshot()!.pieces, piecesAtPly.at(-1));
  }
});
