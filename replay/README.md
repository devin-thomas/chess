# Replay core library

RPL-001 through RPL-011 implement the [Replay V1 contract](../docs/replay/REPLAY_SPEC.md), public viewer shell, transport controls, synchronized move list, Three.js board boundary, and deterministic animation effects.
The library runs in Node 24 and is compatible with the existing browser build. It
uses the TypeScript rules engine in fixed `all-rules-enabled` mode, with no clocks.
The web transport owns cancellable playback timers; checkpoint caching is a later ticket.

## Use

```ts
import { createReplayController } from './replay/controller.ts';

const replay = createReplayController();
const loaded = replay.load({
  schema_version: 1,
  ruleset: 'orthodox-chess-v1',
  root: { kind: 'standard' },
  moves: ['e2e4', 'e7e5', 'g1f3'],
});
if (!loaded.ok) throw loaded.error;

replay.stepForward();
console.log(replay.currentPly()); // 1
console.log(replay.lastTransition()); // Explicit moving piece and effects
replay.seek(3);
console.log(replay.position()); // Complete authoritative state at ply 3
```

`load` returns `{ok: true, replay, root_state, final_state, diagnostics}` or
`{ok: false, error}`. It validates the entire input in isolation, then installs a
private copy at ply 0. Failed replacement preserves the previous loaded replay.

`seek`, `stepForward`, and `stepBack` return `{ok: true, state}` or `{ok: false, error}`.
Expected input failures are returned; unexpected programming/bridge errors propagate.
`length`, `currentPly`, `position`, `moveAt`, and `status` are read-only queries.
`moveAt(1)` is the first move; `moveAt(0)` and out-of-range lookups return null.
Status is `unloaded`, `ready`, or `ended`, independently of whether chess rules
have adjudicated the position. Navigation beyond a boundary by stepping is a no-op;
an out-of-range explicit seek is an error.

`presentationSnapshot`, `lastTransition`, and `eventsForTransition` expose the
renderer boundary. Piece handles survive moves, captures, and promotion. Seeking
reconstructs the rule and identity history and emits one reset event in a new epoch;
it never emits animations for the hidden reconstruction moves. Boundary no-ops
clear the last transition/events. Rejected operations leave them unchanged.

## Modules

- `schema.ts`: strict JSON shape parsing and canonical types. `parseReplay` throws
  `ReplayError` for bad input and normalizes a standard-equivalent setup root.
- `engine.ts`: typed isolated rules sessions and lossless canonical-position/FEN conversion.
- `validate.ts`: ordered legal execution, first-error location, and recorded-result diagnostics.
- `controller.ts`: deterministic navigation and integrated presentation updates.
- `presentation.ts`: stable identities, explicit effects, event sequencing, and snapshots.
- `pgn-import.ts`: bounded PGN collection parsing, strict SAN resolution, and canonical replay conversion.
- `../web/replay-transport.ts`: browser-independent cursor transport with cancellable playback scheduling.
- `../web/replay-move-list.ts`: SAN display notation derived from authoritative legal moves.
- `../web/board3d.ts`: Three.js scene, canonical-square projection, stable piece objects, and fallback board.
- `../web/replay-animation.ts`: deterministic transition plans, interpolation, effects, and authoritative settling.

`parseReplay` checks move syntax immediately. `validateReplay` defers string syntax
checks to ordered execution so a malformed move reports its last valid state.
Neither API accepts non-string moves. Metadata never affects legality. A recorded
resignation score may coexist with an active final board; contradictory terminal
scores produce `W_REPLAY_RESULT` diagnostics without changing the rules result.

## Verification

```sh
npm install
npm run typecheck
npm run test:replay
make test
npm run build
```

The [shared fixtures](../shared/replay-fixtures/README.md) contain 20 authored
canonical inputs and independent Python expectations at every committed ply.
Tests compare complete states, repetition keys, special-move effects, and identity
reconstruction. Normal tests do not regenerate expectations.

The engine's existing conservative dead-position detection remains a known
limitation; this library does not claim complete conformance to every session
action in SPEC.md. The public simulator remains a separate interface; the replay
viewer is served at `/`.
