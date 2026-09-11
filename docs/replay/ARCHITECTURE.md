# Replay Architecture

## 1. System boundary

Replay sits between import/storage concerns and the existing authoritative rules/presentation boundaries.

```text
PGN / curated game / user replay
            |
            v
      Import + normalize
            |
            v
    Canonical Replay V1
    root + UCI-style moves
            |
            v
      Replay Controller
            |
            v
  Authoritative Rules Core
            |
     +------+------+
     |             |
     v             v
Rule Position   Move transition
     |             |
     +------+------+
            |
            v
 Presentation Adapter
            |
            v
 PresentationSnapshot
 + PresentationEvents
            |
   +--------+---------+----------------+
   |                  |                |
   v                  v                v
Web/Three.js        PS1/DC          NES/FCEUX
```

## 2. Existing contracts remain authoritative

Replay must reuse rather than replace:

- `SPEC.md` for chess legality and canonical state;
- `docs/PROTOCOL.md` for the current executable JSONL engine boundary;
- `CONTEXT.md` for the distinction between rule state, move records, presentation events, piece identity, and render profiles;
- `spec/3d-presentation-requirements.md` for presentation projection and animation/event requirements.

Replay does not create a new definition of a chess move.

## 3. Recommended source layout

The exact language structure may adapt to the repository, but the intended separation is:

```text
replay/
  schema.ts
  controller.ts
  validate.ts
  pgn-import.ts

web/
  replay/
    app/controller integration
    UI state
    renderer adapter
    Three.js scene

shared/
  replay-cases.json
  replay-fixtures/

tools/
  compile-replay.*
```

Do not force PGN parsing into C/Rust/retro implementations merely for symmetry.

## 4. Replay controller vs rules session

The rules session answers:

> Is this move legal, and what is the resulting chess state?

The replay controller answers:

> Which move index are we viewing, how do we reach it deterministically, and what transition should the presentation show?

This distinction prevents UI actions such as scrub, pause, autoplay speed, or camera movement from contaminating chess state.

## 5. State ownership

### Rules core owns

- board occupancy;
- side to move;
- castling rights;
- en-passant state;
- halfmove/fullmove counters;
- legality;
- terminal chess outcomes;
- repetition/claim state where supported.

### Replay controller owns

- loaded replay artifact;
- current replay cursor/ply;
- optional replay checkpoints/cache;
- play/pause state only if the implementation chooses to colocate playback timing;
- mapping from replay transition to authoritative rule execution.

### Presentation adapter owns

- stable piece identity;
- animation projection;
- visual event sequencing;
- presentation snapshots;
- board orientation as display state.

### Renderer owns

- scene graph / sprites / console primitives;
- camera;
- lighting;
- materials;
- frame timing;
- effects;
- interpolation between deterministic presentation states.

## 6. Playback timing is not chess timing

Autoplay timing must be presentation state.

Examples:

```text
0.5x replay speed
1x replay speed
2x replay speed
instant seek
pause after captures
cinematic camera pause
```

None may modify halfmove clocks, fullmove numbers, move legality, or historical chess clock metadata.

Imported player clock values, if later supported, are replay metadata and should be presented separately from viewer playback speed.

## 7. Determinism

For any validated replay `R` and ply `P`:

```text
position(R, P)
```

must be invariant across:

- repeated loads;
- arbitrary seek order;
- playback speed;
- animation enabled/disabled;
- board orientation;
- camera position;
- supported rules implementations.

Where implementations expose position keys, the key at a given replay ply should match across languages.

## 8. Caching strategy

Correctness must not depend on caching.

Permitted implementations include:

### Web

Cache every resulting position or every N plies for instant scrubbing.

### PS1/Dreamcast

Use fixed-size checkpoints at a chosen interval when useful.

### NES-class target

Replay from root on seek if that is simplest and sufficiently fast.

No renderer should know which strategy was used.

## 9. Friendly import pipeline

```text
Raw PGN
  |
  v
Parse tags + SAN
  |
  v
Resolve each SAN move against authoritative rules state
  |
  v
Canonical coordinate moves
  |
  v
Replay validation
  |
  v
Canonical Replay V1
```

Import errors should identify:

- PGN parse location when known;
- source move number/SAN token;
- canonical ply index reached;
- underlying rules error when available.

## 10. Storage and hosting

V1 should be capable of running with static assets only.

A curated replay may live as a static JSON artifact bundled/deployed with the site. A user-imported PGN may be parsed entirely client-side and need not be uploaded anywhere.

This keeps the first viewer compatible with Cloudflare Pages/static deployment and avoids making accounts or a database prerequisites for replay functionality.

## 11. Security and trust

Imported replay files are data, never executable code.

The canonical loader already bounds input bytes, moves, and metadata. The future PGN importer must additionally bound:

- input file size;
- number of parsed games;
- number of plies;
- metadata lengths;
- annotation/comment lengths if later supported.

Rendering must treat imported strings as text, not HTML.

## 12. Future engine evaluation

If Stockfish or another engine is added later, it is a separate analysis service/adapter:

```text
Replay position -> analysis engine -> evaluation sidecar
```

Evaluation must never become required to reproduce the replay.

## 13. Why not store every board position in the canonical replay?

The replay already contains enough information to reproduce every position.

Storing every board state would:

- duplicate authoritative data;
- make tampering/inconsistency possible;
- increase artifact size;
- make retro transcoding needlessly expensive.

Generated checkpoints are implementation artifacts or compiled derivatives, not canonical replay truth.

## 14. Why not make PGN canonical?

PGN is ideal for interchange between chess tools and humans, but it carries syntax and contextual SAN resolution that constrained runtimes do not need.

Canonical coordinate moves provide a much smaller execution surface:

- fixed square naming;
- explicit origin and destination;
- explicit promotion suffix;
- castling represented as king movement;
- no SAN disambiguation parser needed at playback time.

The project should support importing PGN (export is deferred) without making every renderer understand PGN.

## 15. Current engine integration

The current browser entry point is `createSimulator().request(...)` in [typescript/chess_cpu.ts](../../typescript/chess_cpu.ts). Use isolated instances for validation and active playback. The public operations are `new`, `state`, `legal_moves`, and `play`, not the full `execute`/`save`/`restore` contract in SPEC.md. The replay modules and presentation adapter are now implemented under `replay/`; see the [library API](../../replay/README.md).

RPL-002 supplies a typed bridge that validates responses, converts canonical roots to six-field FEN, and explicitly starts `all-rules-enabled` without clocks. RPL-005 derives move effects from accepted coordinate moves and authoritative before/after states, not renderer geometry. The bridge must not implement a second legality or adjudication algorithm.

The current protocol lacks revisions, enriched move records, terminal events, and a standalone position-key field. For this move-only replay bridge, root revision is 0 and each accepted move increments it once, so replay revision equals the destination ply. This is bridge-owned bookkeeping, not a new claim about JSONL fields. Outcomes supply terminal-event projections at that boundary. Position keys are optional; compare complete normalized observable state when unavailable. Effective en-passant information comes from `legal_moves`.

Piece handles are allocated deterministically at root in canonical occupied-square order, then carried through every accepted move. Arbitrary seek reconstructs this identity history (or restores a matching identity checkpoint); assigning fresh handles from the destination board would lose capture/promotion continuity. Seek replaces upstream state, starts a new presentation epoch, clears transient transitions, and emits only a reset/load snapshot. Hidden reconstruction moves do not emit visible animation events. Event sequence is monotonic for a controller lifetime across epochs. Identical replay paths reproduce event payload order; epoch and delivery sequence identify a particular viewing session and are excluded from cross-seek state equality.

Caches must preserve complete rules history, counters, outcomes, move ledger, and the identity sidecar. A board/FEN-only checkpoint loses repetition history and is insufficient. The current API has no restore operation: retain immutable snapshots for display or reconstruct a fresh session from root; any later internal checkpoint API needs separate equivalence tests. Do not document an unimplemented JSONL restore operation as available.

The existing engines conservatively detect some dead positions and do not implement every competitive action required by SPEC.md. Replay V1 uses their documented common move surface, does not claim full SPEC conformance, and must report discovered rules gaps explicitly rather than weakening fixtures or guessing outcomes. Fix any gap required by a replay fixture in the rules engine before accepting that fixture.

## 16. PGN V1 decisions and limits

RPL-006 supports multiple games, tags, mainline SAN, castling, promotion, move numbers, and result markers. Ignore brace/semicolon comments, NAGs, and balanced recursive variations; do not execute variation moves. Reject malformed/unbalanced syntax and unsupported variants. Accept standard roots and `SetUp "1"` with valid `FEN`; reject inconsistent setup tags. FEN is normalized to the canonical position root. Preserve root side/fullmove number for move-list pairing, including Black-to-move roots. Conflicting tag/movetext results are import errors; a recorded result differing from rules termination is handled by REPLAY_SPEC.md.

Parse the collection and offer a chooser for multiple games. Validate the selected game's complete mainline before replacing the loaded replay. A bad game must have a visible per-game error and cannot be silently selected as valid. SAN resolution must match exactly one authoritative legal move; no guessed repairs.

V1 web/tooling limits are 5 MiB UTF-8 input, 100 games per import, 4096 plies per game, 1024 Unicode code points per metadata string, 64 metadata keys per game, and variation nesting depth 32. Canonical JSON metadata also has a maximum nesting depth of 32 (including the metadata object), 65,536 total values/containers, and 1024 code points per key to bound traversal. The schema/validator tests cover canonical loader limits; PGN collection and variation limits remain RPL-006 work. Enforce limits before or during parsing, including skipped annotations; return `E_REPLAY_LIMIT` with the exceeded limit. These are ingestion limits, not chess rules; retro derivatives declare their own smaller capacities. RPL-006 tests boundary and oversized input; RPL-012 displays the errors and keeps the prior replay intact.
