# Replay Viewer Implementation Tickets

Status: RPL-001 through RPL-011 implemented; RPL-012 through RPL-017 remain open. Phase 1 is complete; Phase 2 is in progress.

Read [REPLAY_SPEC.md](REPLAY_SPEC.md) and [ARCHITECTURE.md](ARCHITECTURE.md) before implementation. Their precise contracts supplement every acceptance list here. Ticket numbers are identifiers, not a strict execution order. Existing modules named in the architecture are integration points; proposed modules must be created by these tickets.

| Ticket | Depends on | Integration / completion evidence |
| --- | --- | --- |
| RPL-001 | None | `replay/schema.ts`; runtime schema and shape cases |
| RPL-002 | RPL-001 | `replay/validate.ts` and typed engine bridge; isolated validation and canonical-root/FEN round trip |
| RPL-003 | RPL-002 | `replay/controller.ts`; boundary, failed-load, immutable-state, random-seek tests |
| RPL-004 | RPL-002, RPL-003 | `shared/replay-cases.json`, `shared/replay-fixtures/`; independent expected states |
| RPL-005 | RPL-003, RPL-004 | Presentation bridge; identity, revision, epoch, effect-order tests |
| RPL-006 | RPL-002, RPL-004 | `replay/pgn-import.ts`; collection/setup/SAN/limit/error cases |
| RPL-007 | RPL-003, RPL-004 | Vite entry points; direct-load `/` and `/simulator/`; temporary shared fixture as default |
| RPL-008 | RPL-007, RPL-005 | Transport state and rapid-seek checks; renderer stub permitted |
| RPL-009 | RPL-008, RPL-006 | Move-list synchronization including Black-to-move roots |
| RPL-010 | RPL-007, RPL-005 | Three.js scene and fixture occupancy checks |
| RPL-011 | RPL-010, RPL-008 | Effect cancellation, settled snapshots, reduced motion |
| RPL-012 | RPL-006, RPL-007 | Import chooser, safe text, failed-import preservation |
| RPL-013 | RPL-004, RPL-007 | At least three attributed curated replays; build validation and selector |
| RPL-014 | RPL-003, RPL-004, RPL-005 | Complete-history cache equivalence and measured seek timings |
| RPL-015 | Phase 2 | Compiler, frozen format document, decoder and golden vectors |
| RPL-016 | RPL-015, RPL-017 host baseline | Reproducible NES build/emulator run and selected-ply output |
| RPL-017 | RPL-004 (host baseline); RPL-016 (retro comparison) | Machine-readable cross-language report; final retro comparison |

RPL-017 deliberately has two checkpoints: host conformance can begin after RPL-004; retro comparison completes Phase 3. This avoids making the retro implementation its own oracle.

Each ticket must wire its checks into a documented repository command, update affected implementation-status docs, and retain the existing simulator and JSONL behavior. Run relevant tests; use `make test` for rules/bridge changes and `npm run build` for browser changes. New replay checks must be part of the phase gate, not merely standalone files. `npm run test:replay` runs the replay tests; `npm run typecheck` checks TypeScript. Both also run through `make test`. See [the library guide](../../replay/README.md) for the implemented API. Phase 2 includes keyboard, reduced-motion, desktop/mobile, direct-route and production-build verification.

## RPL-001 — Add replay schema types

Status: complete. Validated by `npm run test:replay` and `make test`.

**Goal**
Define the V1 canonical replay artifact in TypeScript.

**Requirements**

- `schema_version`;
- `ruleset`;
- standard or canonical-position root;
- canonical move array;
- optional metadata;
- strict validation of required fields;
- unknown descriptive metadata must not affect playback.

**Acceptance**

- a standard three-move replay parses;
- unsupported schema version fails clearly;
- unsupported ruleset fails clearly;
- malformed move syntax is rejected during validation.

---

## RPL-002 — Implement replay validator

Status: complete. Validated by `npm run test:replay` and `make test`.

**Goal**
Validate a replay by executing it through the authoritative TypeScript rules implementation.

**Requirements**

- initialize declared root;
- apply moves in order;
- stop on first invalid move;
- reject moves after terminal state;
- return last valid ply and underlying rules error;
- derive final state/result.

**Acceptance**

- valid fixtures reach expected final states;
- intentionally corrupted move N reports N without mutating canonical input;
- checkmate followed by another move fails.

---

## RPL-003 — Implement replay controller

Status: complete. Validated by `npm run test:replay` and `make test`.

**Goal**
Provide renderer-independent replay cursor behavior.

**Required API behavior**

- load;
- length;
- current ply;
- seek;
- step forward;
- step back;
- current authoritative position/state;
- current/next move lookup.

**Acceptance**

- ply 0 is root;
- final ply equals move count;
- arbitrary seeks produce the same state as sequential playback;
- back-step works without requiring inverse moves;
- seeking does not mutate replay data.

---

## RPL-004 — Add shared replay fixtures

Status: complete. Validated by `npm run test:replay` and `make test`.

**Goal**
Create deterministic fixtures for replay behavior.

**Include**

- short opening;
- capture;
- castling;
- en passant;
- promotion and underpromotion;
- checkmate;
- non-standard root;
- invalid replay fixture.

**Acceptance**

- expected complete normalized state recorded at root, selected plies, and end; position keys compared where available;
- both castling sides, en passant, all promotion choices, capture-promotion, terminal roots, empty replays, repetition and 75-move termination covered;
- boundary/error behavior, metadata-vs-rules result, and history-sensitive seeks covered;
- TypeScript tests pass;
- fixtures are suitable for later C/Python/Rust/retro conformance tests.

---

## RPL-005 — Produce presentation transition from replay step

Status: complete. Validated by `npm run test:replay` and `make test`.

**Goal**
Connect replay stepping to the existing 3D presentation adapter contract.

**Requirements**

- before/after authoritative state available;
- stable presentation piece identity;
- enriched move record;
- explicit capture/castling/en-passant/promotion effects;
- check/terminal presentation events.

**Acceptance**

- renderer does not infer special move effects from mesh positions;
- castling exposes both moving identities;
- en passant exposes capture square;
- promotion preserves presentation identity according to existing presentation spec;
- arbitrary seek reconstructs the same piece handles, starts a new epoch, and emits no hidden intermediate animation events;
- derived bridge revisions and event order follow ARCHITECTURE.md section 15.

---

## RPL-006 — Add PGN importer

Status: complete. Validated by `npm run typecheck`, `npm run test:replay`, and `npm run build`.

**Goal**
Convert friendly PGN input into canonical Replay V1.

**Requirements**

- parse tags;
- parse SAN movetext;
- resolve SAN against authoritative current position;
- emit canonical coordinate moves;
- preserve useful metadata;
- support standard roots and canonicalized SetUp/FEN roots;
- support collection chooser data, comments/NAG/variation skipping, and bounded parsing per ARCHITECTURE.md;
- clear import errors with source context.

**Acceptance**

- a known valid PGN imports and replays to its expected result;
- castling SAN becomes canonical king move;
- promotions convert correctly;
- malformed/illegal source move reports useful location;
- playback after import no longer depends on PGN/SAN.

---

## RPL-007 — Create public replay route/shell

Status: complete. Validated by `npm run typecheck`, `npm run test:replay`, and `npm run build`.

**Goal**
Create a viewer surface separate from the simulator/developer interface.

**Requirements**

- curated replay loaded by default;
- board is primary visual element;
- player names/result/basic metadata;
- transport control area;
- move list area;
- responsive layout foundation.

**Acceptance**

- visitor can understand that a replay is loaded without seeing raw protocol UI;
- route works on desktop and mobile widths;
- simulator functionality remains independently reachable.

---

## RPL-008 — Implement transport UI

Status: complete. Validated by `npm run typecheck`, `npm run test:replay`, and `npm run build`.

**Goal**
Connect web controls to replay controller.

**Controls**

- play/pause;
- previous/next;
- first/last;
- timeline seek;
- speed;
- board flip.

**Acceptance**

- controls reflect current state;
- timeline range exactly matches `0..move_count`;
- seek cancels/reset transient move animation safely;
- autoplay stops at end;
- repeated rapid seeking never corrupts board state.

---

## RPL-009 — Implement human-readable move list

Status: complete. Validated by `npm run typecheck`, `npm run test:replay`, and `npm run build`.

**Goal**
Show a synchronized chess move list without changing canonical replay execution.

**Requirements**

- White/Black pairing by fullmove;
- current ply highlight;
- click/tap to seek;
- SAN may be derived/stored for display;
- canonical coordinate moves remain controller input.

**Acceptance**

- selecting a move seeks correctly;
- current move remains obvious;
- mobile layout has no horizontal overflow caused by list.

---

## RPL-010 — Implement baseline Three.js board

Status: complete. Validated by `npm run typecheck`, `npm run test:replay`, and `npm run build`.

**Goal**
Render correct authoritative chess state in 3D before final art polish.

**Requirements**

- 64-square mapping;
- all piece types/colors;
- stable piece identity;
- camera framing;
- board flip;
- primitive/debug fallback assets.

**Acceptance**

- all replay fixtures render correct occupancy at selected plies;
- no rule calculation exists in renderer;
- orientation does not change square identity.

---

## RPL-011 — Add move animation and effects

Status: complete. Validated by `npm run typecheck`, `npm run test:replay`, and `npm run build`.

**Goal**
Animate normalized replay transitions.

**Requirements**

- ordinary move;
- capture;
- castling;
- en passant;
- promotion;
- immediate/no-animation path;
- deterministic settle to authoritative post-move snapshot.

**Acceptance**

- animations never leave pieces in a state disagreeing with the rules snapshot;
- seeking can bypass animation cleanly;
- reduced-motion mode is functional.

---

## RPL-012 — Add PGN import UI

**Goal**
Allow a user to watch their own or external games locally.

**Requirements**

- paste text;
- choose PGN file;
- multiple-game chooser when applicable;
- client-side import;
- loading/error states;
- no account requirement.

**Acceptance**

- imported replay immediately enters the same viewer path as curated replays;
- imported strings are rendered as text, not HTML;
- invalid PGN cannot corrupt the currently loaded valid replay.

---

## RPL-013 — Curated replay library V1

**Goal**
Ship a small static set of interesting replays.

**Requirements**

- static canonical Replay V1 artifacts;
- useful metadata/source attribution;
- technical coverage of varied replay behavior;
- selector UI kept secondary to the board.

**Acceptance**

- switching replays resets controller/presentation cleanly;
- each artifact validates during test/build;
- page has compelling default content with no user upload required.

---

## RPL-014 — Replay performance/caching

**Goal**
Make arbitrary seeking effectively immediate without changing semantics.

**Requirements**

- baseline uncached path remains testable;
- add full-state or interval checkpoint cache for web;
- cache invalidation on replay load;
- compare cached result against reference seek behavior.

**Acceptance**

- random seek test yields identical authoritative states with cache on/off;
- record device/browser, replay length, and uncached/cached seek timings for a long fixture;
- replaying a move after a cached seek preserves repetition and terminal adjudication.

---

## RPL-015 — Compile replay derivative

**Goal**
Create the first offline compiler from canonical Replay V1 to a compact target-friendly representation.

**Requirements**

- versioned compiled header;
- standard-root shortcut;
- packed moves;
- move count;
- optional Tier 1 metadata;
- source/canonical hash manifest;
- host-side decoder for testing.

**Acceptance**

- encode/decode round trip preserves authoritative move sequence;
- compiled replay validates against canonical source;
- no PGN/SAN requirement remains in compiled payload.

---

## RPL-016 — NES/FCEUX portability proof

**Goal**
Render and navigate one compiled replay on an NES target/emulator.

**Minimum scope**

- board + pieces;
- embedded compiled replay;
- next/previous;
- start/end;
- ply/move indicator;
- deterministic root/seek behavior.

**Acceptance**

- selected intermediate positions match web/reference fixture;
- final position matches reference;
- no web runtime, JSON parser, PGN parser, or SAN parser exists in the NES playback path;
- invalid data fails safely within fixed buffers.

---

## RPL-017 — Cross-platform replay conformance command

**Goal**
Make replay portability measurable rather than visual-only.

**Requirements**

- run a replay fixture through supported host rules implementations;
- compare selected-ply board state and position keys where available;
- emit machine-readable report;
- later ingest outputs produced by retro test harnesses/emulators if practical.

**Acceptance**

- TypeScript/Python/C/Rust agree on selected replay fixture states under their common implemented rules surface;
- any disagreement identifies replay ID and ply.

---

# Phase gates

## Phase 1 — Replay core complete

Tickets RPL-001 through RPL-006, including all linked contract checks.

Result: canonical replay artifacts can be imported, validated, traversed, and converted into presentation transitions without a final renderer.

## Phase 2 — Web viewer complete

Tickets RPL-007 through RPL-014.

Result: a polished replay-first website can load curated or user PGNs and present them through the 3D board.

## Phase 3 — Portability proof

Tickets RPL-015 through RPL-017. RPL-017 host baselines precede RPL-016; retro comparison closes this gate. Phase 3 is a later milestone, not required for Web V1.

Result: the same canonical replay demonstrably runs on a constrained retro target and agrees with host implementations.
