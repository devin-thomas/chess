# Replay Portability and Retro Strategy

## 1. Goal

Prove that replay semantics are independent of language, framework, graphics API, and hardware generation.

A retro viewer is not expected to reproduce the web viewer's graphics. It is expected to reproduce the same chess game and replay cursor semantics.

## 2. Cross-platform invariants

At replay ply `P`, every conforming implementation must agree on:

- piece type/color on all 64 squares;
- side to move;
- castling rights;
- en-passant state;
- halfmove and fullmove counters;
- whether the game is active or terminal;
- terminal result/reason under the fixed V1 `all-rules-enabled` mode;
- canonical move at the transition boundary;
- position identity/key where implemented.

Presentation details may differ completely.

## 3. Do not ship friendly interchange parsers everywhere

Desktop/web tooling may understand:

- JSON;
- PGN;
- SAN;
- Unicode;
- URLs;
- large metadata objects.

A retro runtime should not need any of those merely to play a replay.

Use an offline compiler:

```text
Canonical Replay V1 JSON
        |
        v
   replay compiler
        |
        +--> NES derivative
        +--> PS1 derivative
        +--> Dreamcast derivative
        +--> other target derivative
```

## 4. Minimal compact move encoding

The canonical artifact remains readable coordinate notation. A compiled derivative may encode a move numerically.

Because a square fits in 6 bits:

```text
from: 0..63
to:   0..63
```

Promotion requires only a small selector.

A simple target-independent packed conceptual move can fit comfortably in 16 bits:

```text
bits 0..5   from square
bits 6..11  to square
bits 12..14 promotion selector / reserved
bit  15     reserved/version use
```

RPL-015 freezes the packed layout in [COMPILED_FORMAT.md](COMPILED_FORMAT.md).
The earlier bit sketch is superseded by that document; the compiler and runtime
share the versioned definition and golden vectors.

Special move type does not have to be encoded if the authoritative rules engine can derive it from position + move. A presentation-focused derivative MAY precompute effect flags when that reduces runtime complexity.

## 5. Root position strategy

Most curated historical games begin from the orthodox initial position. The compact format should represent that case with a tiny standard-root flag.

Non-standard roots may use a compact board/setup payload or target-specific fixture representation.

Do not require a full FEN parser on the retro target unless there is a separate product reason to support arbitrary FEN input there.

## 6. Metadata tiers

Define practical metadata tiers for compiled replays.

### Tier 0 — execution only

- ruleset/version and fixed execution mode;
- root;
- move count;
- packed moves.

### Tier 1 — basic display

Tier 0 plus:

- White name;
- Black name;
- result;
- short event label.

### Tier 2 — rich modern metadata

Ratings, dates, source URLs, annotations, engine analysis, portraits, etc.

Metadata tiers change display data only. Tier 0 and Tier 1 must preserve all execution state and the fixed V1 mode. A target that only displays precomputed boards is a presentation demonstration, not rules conformance.

## 7. NES/FCEUX proof

A first NES proof can be intentionally modest:

- 2D board;
- recognizable pieces;
- current player/game names if memory budget permits;
- previous/next controls;
- start/end jump;
- autoplay toggle optional;
- current move/ply indicator;
- optional board flip if inexpensive.

It does not need:

- PGN import;
- JSON parsing;
- 3D;
- chess AI;
- network features;
- engine evaluation;
- arbitrary user file browsing inside the ROM.

A curated compiled replay can be embedded in the ROM for the first proof.

## 8. Why FCEUX is a useful showcase

Running a recognizable famous modern chess replay in an NES emulator demonstrates that:

- the game data is small;
- rules semantics are not coupled to the web stack;
- presentation can be radically different while the replay stays identical;
- the language-agnostic project has a visible outcome rather than only cross-language unit tests.

The novelty is useful, but correctness is the actual architectural proof.

## 9. Relationship to PS1 and Dreamcast work

The repository already anticipates PS1 and Dreamcast 3D render profiles.

Replay should become a common input to those renderers rather than a separate fork.

A future PS1/Dreamcast replay viewer may therefore reuse:

- canonical replay source;
- replay controller semantics;
- normalized `MoveRecord`;
- presentation events;
- platform-specific 3D assets already defined by the presentation specification.

## 10. Testing a compiled derivative

The offline compiler should produce a manifest containing enough information to test its output:

```text
replay schema version
compiled format version
ruleset
move count
root identifier/hash
canonical replay content hash
compiled payload hash
optional final position key
```

A host-side test should decode the compiled payload and prove it reproduces the canonical move stream before the artifact is shipped to a console build.

## 11. Runtime failure policy

A compiled replay intended for a ROM/disc should already be validated.

If the runtime nevertheless detects invalid data:

- stop playback safely;
- do not invent a move;
- display a minimal error/debug state appropriate to the target;
- never read past move or asset buffers.

## 12. Portability milestone definition

The portability milestone is achieved when:

1. one canonical replay fixture is compiled from the same source used by the web viewer;
2. the web TypeScript implementation and one retro implementation reach the same final authoritative board state;
3. selected intermediate plies match known expected positions;
4. transport controls on the retro target follow the same ply indexing semantics;
5. no PGN/SAN parser or web-specific dependency is required by the retro runtime.

## 13. Phase 3 implementation gate

RPL-015 freezes the binary format before RPL-016 starts: byte order, square mapping (`a1 = 0`), promotion selectors, reserved-bit handling, lengths, root encoding, metadata encoding, capacity limits, and canonical/hash bytes require decoder tests and golden vectors. The frozen layout is documented in [COMPILED_FORMAT.md](COMPILED_FORMAT.md), with byte vectors in `shared/compiled-replay-vectors.json`. No illustrative bit layout in this document is already a published format.

RPL-016 must identify its toolchain, memory budget, engine/state reconstruction strategy, and reproducible emulator invocation. Unsupported roots or oversized payloads must fail during compilation, never truncate. RPL-017 establishes host reference states before retro integration, then compares retro output including counters, castling, raw en-passant, and termination. A fixture-specific demonstration must state its coverage; it does not establish arbitrary Replay V1 or full orthodox-rules conformance.

## 14. RPL-016 repository proof

The repository includes a constrained NES profile in `retro/nes_replay.c` and
`retro/nes_replay_main.c`. It reads the frozen RPL-015 `RPLY` payload directly
from an embedded byte array, reconstructs seeks from the root, and exposes
next/previous/first/last controls. The runtime contains no JSON, PGN, or SAN
parser and uses no dynamic allocation. The board is drawn with cc65 text tiles;
the current ply and move count are displayed alongside the pieces.

Run the host safety proof with:

```sh
make replay-nes-proof
```

Build the actual iNES ROM with cc65 and run its deterministic FCEUX trace with:

```sh
NES_CC65_HOME=/path/to/cc65 make nes-build
NES_CC65_HOME=/path/to/cc65 NES_FCEUX=/path/to/fceux make nes-proof
make conformance-replay-retro
```

The build uses cc65's mapper-0 layout (32 KiB PRG plus 8 KiB CHR), a fixed
decoder capacity of 4096 packed plies, and cartridge RAM at `$6000`. The trace
record begins at `$7000`; `tools/nes_trace.lua` captures the root, both
castling positions, and the scripted `next`, `next`, `previous`, `first`,
`last` sequence. `tools/replay-conformance.py` compares the trace's selected
positions and navigation sequence with the independent
`castle-kingside.expected.json` oracle.
