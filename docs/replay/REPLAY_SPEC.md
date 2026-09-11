# Replay Specification V1

Status: schema, validation, controller, fixtures, presentation bridge, PGN import, public viewer shell, transport, synchronized move list, Three.js board, deterministic animation effects, and local PGN import UI implemented (RPL-001 through RPL-012)
Rules dependency: `SPEC.md` / `orthodox-chess-v1`

## 1. Purpose

A replay is a portable description of a chess game that can be deterministically reproduced by the repository's rules engine and presented by any compatible renderer.

A replay is not a saved renderer state, video, animation capture, or alternative chess rules implementation.

The minimum information required to reproduce a replay is:

1. the ruleset identifier;
2. the root position; and
3. an ordered sequence of canonical legal moves.

V1 fixes the execution mode to `all-rules-enabled` with clocks disabled. Loaders MUST pass this mode explicitly; the viewer cannot select a different mode. History starts at the root with one occurrence of its position. V1 does not encode claims, resignation, agreement, timeout actions, or pre-root repetition history. It is a move replay, not a complete session snapshot.

Everything else is optional descriptive or presentation data.

## 2. Canonical V1 replay artifact

The interchange representation MUST be UTF-8 JSON for tooling and web use.

Conceptual shape:

```json
{
  "schema_version": 1,
  "ruleset": "orthodox-chess-v1",
  "root": {
    "kind": "standard"
  },
  "moves": [
    "e2e4",
    "e7e5",
    "g1f3"
  ],
  "metadata": {
    "white": "Player One",
    "black": "Player Two",
    "result": "*"
  }
}
```

### Required fields

#### `schema_version`

Integer replay schema version. V1 is `1`.

#### `ruleset`

Rules contract used to validate and reproduce the replay. Initial required value:

```text
orthodox-chess-v1
```

A replay loader MUST reject an unsupported ruleset rather than silently reinterpret it.

#### `root`

The authoritative replay starting position.

V1 supports:

```json
{"kind":"standard"}
```

or `{"kind":"position","position": Position}`. The replay wire representation of `Position` has exactly these required fields:

| Field | V1 wire type |
| --- | --- |
| `board` | Exactly 64 cells in `a1` through `h8` order; each is `null` or `{ "color": "white" or "black", "type": "king", "queen", "rook", "bishop", "knight", or "pawn" }` |
| `side_to_move` | `"white"` or `"black"` |
| `castling_rights` | Object with boolean `white_kingside`, `white_queenside`, `black_kingside`, `black_queenside` |
| `en_passant_target` | Lowercase square `a1` through `h8`, or `null` |
| `halfmove_clock` | Safe integer >= 0 |
| `fullmove_number` | Safe integer >= 1 |

These fields specialize the language-neutral Position in [SPEC.md](../../SPEC.md); the four boolean names are the replay serialization contract. All roots MUST pass authoritative setup validation. Non-authoritative fixtures are not accepted replay inputs. A standard root and a position root with identical initial fields normalize to `{"kind":"standard"}`.

FEN is an import convenience, not a third canonical root kind. The bridge translates a position root losslessly to six-field FEN for the existing `new` operation; it converts protocol castling strings back to the four booleans when comparing canonical positions. See [ARCHITECTURE.md](ARCHITECTURE.md#15-current-engine-integration).

#### `moves`

Ordered canonical coordinate move strings using the repository's existing machine move syntax:

```text
e2e4
e7e5
e1g1
e7e8q
```

Each array entry represents one committed ply. Syntax MUST match `^[a-h][1-8][a-h][1-8][qrbn]?$`; legality is checked separately. An empty array is valid.

Reject unknown top-level, root, position, and piece fields, missing required fields, incorrect types, and unsupported versions with `E_REPLAY_SCHEMA`. Metadata is the only open object in V1. Optional known text fields accept string or null; ratings accept non-negative safe integers or null; result accepts only the four scores shown below. Optional fields may be omitted. Unsupported rulesets use `E_REPLAY_RULESET`.

The replay artifact MUST NOT require SAN parsing during playback.

### Optional `metadata`

Metadata is descriptive and MUST NOT affect replay legality, position identity, or event ordering.

Known V1 metadata fields (illustrative values):

```json
{
  "white": "string or null",
  "black": "string or null",
  "white_rating": 0,
  "black_rating": 0,
  "event": "string or null",
  "site": "string or null",
  "date": "string or null",
  "round": "string or null",
  "result": "1-0 | 0-1 | 1/2-1/2 | *",
  "source": "string or null",
  "source_url": "string or null"
}
```

Unknown metadata fields MAY be preserved by friendly tooling but MUST be ignorable by replay runtimes.

## 3. Authoritative and non-authoritative data

Authoritative for playback:

- schema version;
- ruleset;
- root position;
- ordered canonical moves.

Non-authoritative:

- names;
- ratings;
- event information;
- timestamps;
- annotations;
- engine evaluation;
- camera cues;
- visual themes;
- portraits;
- commentary;
- external links.

If metadata claims a result that disagrees with the rules-derived terminal state, the loader MUST preserve the source claim for diagnostics but MUST treat the rules-derived state as authoritative for chess playback.

## 4. Replay validation

A replay validator MUST:

1. validate the schema version and ruleset;
2. create the declared root position using the authoritative rules engine;
3. apply moves in order;
4. reject the replay at the first illegal or malformed move;
5. report `move_index` as a zero-based array index and `ply` as the attempted one-based destination ply;
6. expose the last valid ply and authoritative state;
7. derive the terminal result from rules state when the game terminates;
8. reject moves occurring after a terminal state.

Validation MUST use the same legal move semantics as ordinary gameplay.

Move failures use `E_REPLAY_MOVE` with `move_index`, `ply`, `last_valid_ply`, `last_valid_state`, and the underlying engine error. For failure at `moves[i]`, these indices are `i`, `i + 1`, and `i`. Root failures use `E_REPLAY_ROOT` with the underlying error and null move/state locations. Schema/ruleset failures have no executed-state location. Validate in a separate session; diagnostics MUST NOT replace the currently loaded valid replay or cursor.

A source result such as resignation may end a recorded game while the final rules position remains active. Preserve and label that value as the recorded result, without synthesizing a terminal rules event. Reaching the final replay ply means playback ended, regardless of rules status. If a terminal rules outcome disagrees with a non-`*` source result, expose a diagnostic and show the rules outcome separately.

The importer MUST NOT "repair" a source game by guessing a different move.

## 5. Replay controller contract

The portable conceptual controller is:

```text
replay_load(replay)
replay_length()
replay_current_ply()
replay_seek(ply)
replay_step_forward()
replay_step_back()
replay_position()
replay_move_at(ply)
replay_status()
```

Optional presentation-facing operations:

```text
replay_last_transition()
replay_events_for_transition()
replay_set_orientation()
```

### Ply indexing

- Ply `0` is the root position before the first replay move.
- Ply `1` is the position after `moves[0]`.
- Ply `N` is the position after the first `N` moves.
- Valid seek range is `0..moves.length` inclusive.

This convention MUST remain identical across implementations.

### `replay_seek(ply)`

Seeking changes replay cursor state but MUST NOT change the replay artifact.

The baseline reference behavior MAY be:

1. reset to root;
2. apply moves `[0, ply)`;
3. expose the resulting authoritative position.

Implementations MAY cache checkpoints or full positions as an optimization, but cached and uncached results MUST be observably identical.

### Forward stepping

`replay_step_forward()` at ply `N < length` applies replay move `moves[N]` and advances to `N + 1`.

At the final ply it MUST be a stable no-op with no transition or events. Back-step at root has the same behavior.

### Back stepping

A V1 implementation MAY implement back-step using `seek(current - 1)`. It is not required to implement inverse chess moves.

### Boundary behavior

Successful load validates the complete artifact atomically, installs an owned immutable copy, resets to ply 0, and pauses playback. Failed load preserves the previous replay, cursor, and presentation. Queries MUST NOT expose mutable internal state. Before load, length/current ply are 0, position and move lookup are null, and status is `unloaded`; seek/step report `E_REPLAY_NO_SESSION`.

Seek accepts only integers in `0..length`; otherwise report `E_REPLAY_RANGE` without mutation. Seeking the current ply is a no-op. `replay_move_at(ply)` returns the move ending at ply `1..length`, or null for ply 0/outside the range. Current move is `move_at(current)`; next is `move_at(current + 1)`. Status reports `unloaded`, `ready`, or `ended` (cursor equals length), separately from authoritative rules status and viewer play/pause state. An empty loaded replay is `ended` at ply 0.

## 6. Replay transition output

For a transition from ply `N` to `N + 1`, the replay adapter MUST expose the enriched `MoveRecord` already described by `spec/3d-presentation-requirements.md`.

The renderer should receive explicit presentation-relevant effects, including:

- moving piece identity;
- origin and destination;
- capture identity/square;
- promotion;
- castling rook movement;
- en-passant capture square;
- resulting check or terminal result.

The renderer MUST NOT need to reverse-engineer these effects from meshes.

## 7. Presentation identity across seeking

The existing presentation specification gives the adapter ownership of stable piece identity.

Replay adds one requirement:

> The same replay at the same ply MUST generate the same deterministic presentation identity assignment when loaded from the same replay root and traversed deterministically.

A viewer MAY discard animation continuity during an arbitrary seek and rebuild the presentation projection at the target ply. Correct board identity and state matter more than preserving an in-flight animation across a seek.

## 8. PGN import boundary

PGN is supported as an ingestion format.

The PGN importer is responsible for:

1. parsing tags and movetext;
2. resolving SAN in the context of the current authoritative position;
3. converting each accepted move to canonical coordinate notation;
4. extracting friendly metadata;
5. validating the complete game;
6. emitting a canonical replay V1 artifact.

Playback runtimes do not need to understand PGN or SAN.

Retro targets SHOULD consume a prevalidated replay or a compiled derivative, never raw PGN.

## 9. Optional extension sidecars

These are explicitly outside required V1 execution data but the schema must leave room for them:

- annotations/comments by ply;
- engine evaluation by ply;
- clocks/time spent;
- opening labels;
- chapters or bookmarked moments;
- camera direction cues;
- audio/commentary synchronization;
- external source attribution;
- thumbnails/poster position.

Extensions MUST reference replay plies or stable replay identifiers and MUST NOT alter rules state.

## 10. Replay identity

V1 MAY compute a content identifier from the normalized authoritative payload:

```text
schema_version
ruleset
normalized root
moves
```

Metadata SHOULD be excluded so that two sources describing the same game can resolve to the same chess replay identity even when their descriptive tags differ.

Content hashing is deferred to RPL-015, which MUST specify canonical byte serialization and hash algorithm with test vectors before any compiled artifact is published. V1 runtime loading does not require a hash.

## 11. Conformance requirements

A replay conformance corpus SHOULD include:

- standard opening moves;
- captures;
- both castling sides;
- en passant;
- all four promotion choices;
- capture-promotion;
- check;
- checkmate;
- stalemate;
- draw adjudication represented by the existing rules core;
- non-standard root positions;
- malformed canonical move syntax;
- illegal move mid-replay;
- move after terminal state;
- seek to `0`, middle, and final ply;
- repeated arbitrary seek order;
- comparison of final position across language implementations.

At minimum, TypeScript must pass V1 for the web viewer. Cross-language fixtures should be added in a way that does not require presentation code in the C/Python/Rust engines.
