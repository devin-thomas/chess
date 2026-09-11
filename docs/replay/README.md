# Chess Replay Viewer Build Pack

Status: RPL-001 through RPL-017 implemented in repository scope; host and fixed-buffer retro comparisons verified; cc65/FCEUX execution is available through the documented external-toolchain command
Project: `devin-thomas/chess`
Primary first target: modern web replay viewer
Portability target: deterministic replay playback across modern and retro platforms

## Product idea

Build a replay-first presentation layer on top of the existing language-agnostic chess rules project.

The standard experience should feel closer to watching a competitive match replay than opening a chess analysis document. A visitor should be able to land directly in a visually striking 3D replay, watch a famous game, scrub through it, step move-by-move, flip the board, and inspect the match without needing to understand the underlying simulator.

The same replay artifact must also be portable enough that a constrained target can reproduce the identical game using a different renderer. The project should be able to demonstrate the same replay on a modern Three.js website and, later, on retro hardware or an emulator such as FCEUX.

## Why this fits the existing repository

The repository already has the correct separation of concerns:

- `SPEC.md` is the authoritative chess rules/state contract.
- `docs/PROTOCOL.md` defines the currently executable cross-language protocol.
- `CONTEXT.md` defines presentation as a read-only consumer of authoritative rules state.
- `spec/3d-presentation-requirements.md` defines stable piece identity, normalized move records, presentation events, and target-specific rendering without moving legality into the renderer.

Replay therefore becomes a thin deterministic layer that answers:

> Given a root position and an ordered sequence of canonical moves, what authoritative chess position and presentation events exist at ply N?

The replay layer must not become a second chess engine.

## Core product principles

1. **Replay is deterministic.** The same replay plus the same ruleset produces the same board state at every ply.
2. **Moves are authoritative; metadata is descriptive.** Player names, event names, ratings, annotations, portraits, links, and commentary may enrich a replay but never change chess state.
3. **PGN is an import format, not the execution format.** Friendly tooling may ingest PGN/SAN and normalize it to canonical replay moves before playback.
4. **Renderers remain replaceable.** The web renderer, PS1 renderer, Dreamcast renderer, NES renderer, terminal renderer, and future clients consume replay/rules projections rather than reimplementing legality.
5. **Retro is a real compatibility target.** The canonical replay format should be simple enough to transcode into compact platform-specific data without requiring JSON, PGN, SAN, networking, or dynamic parsing at runtime.
6. **The web experience leads with spectacle.** The website should make replay viewing feel like watching competitive footage, not merely reading notation.
7. **Analysis is additive.** Engine evaluations, annotations, move names, clocks, or commentary can be layered on later without changing the base replay contract.

## V1 scope

V1 proves the full replay pipeline on the web:

- canonical replay schema;
- deterministic replay controller;
- replay validation through the existing rules engine;
- PGN paste/upload import in web/tooling code;
- curated built-in replay fixtures;
- 3D board presentation using Three.js;
- play, pause, previous, next, first, last, and seek-to-ply controls;
- board flip/orientation control;
- move list synchronized to playback;
- current move, side to move, result, and basic match metadata;
- responsive desktop/mobile presentation;
- graceful no-animation state application for seeking and reduced-motion use;
- replay conformance tests shared across supported language implementations where practical.

V1 is replay-only. It does not need online matchmaking, accounts, live multiplayer, a chess AI opponent, collaborative analysis, or a database-backed social layer.

## V2 direction

After the web replay contract is stable:

- publish or export normalized replay artifacts;
- add richer cinematic presentation and optional broadcast overlays;
- add annotations/evaluation as non-authoritative sidecars;
- build at least one retro replay viewer as proof of portability;
- prefer a deliberately constrained target for the portability demonstration;
- support compact precompiled replay data so retro targets do not need PGN/SAN/JSON parsers;
- later share the same replay with PS1 and Dreamcast 3D presentation work already anticipated by the repository.

## Suggested proof-of-portability target

An NES/FCEUX viewer is an especially compelling early portability proof because it makes the architecture visible:

- the web client may use Three.js, animation, lighting, and responsive UI;
- the NES client may use simple sprites/tiles and minimal controls;
- both reproduce the same ordered chess positions from the same normalized replay source.

This does not replace the existing PS1/Dreamcast presentation roadmap. It is a smaller proof that the replay format and controller are genuinely renderer- and platform-independent.

## Build order

1. Implement the Replay V1 schema frozen by this handoff (RPL-001).
2. Implement replay validation and controller semantics against the TypeScript engine.
3. Add fixtures and conformance tests.
4. Add PGN import as a tooling/web boundary. (RPL-006 complete.)
5. Build a functional browser board with replay controls.
6. Replace the functional board with the intended high-quality 3D presentation while preserving controller tests.
7. Add a compact replay compiler/exporter. (RPL-015 complete.)
8. Build a constrained retro viewer using the compiled artifact.

## Documents in this pack

- [REPLAY_SPEC.md](REPLAY_SPEC.md) — canonical replay artifact and controller contract.
- [ARCHITECTURE.md](ARCHITECTURE.md) — system boundaries, data flow, portability model, and integration with the existing rules/presentation specs.
- [WEB_VIEWER.md](WEB_VIEWER.md) — first web product requirements and UX behavior.
- [PORTABILITY.md](PORTABILITY.md) — retro strategy, compact replay representation, and cross-platform invariants.
- [COMPILED_FORMAT.md](COMPILED_FORMAT.md) — frozen RPL-015 binary layout, limits, and manifest contract.
- [CACHE_BENCHMARK.md](CACHE_BENCHMARK.md) — reproducible full-history seek measurements.
- [TICKETS.md](TICKETS.md) — implementation-ready work breakdown and acceptance checks.
- [CONFORMANCE.md](CONFORMANCE.md) — host conformance report command and schema.
- [../../retro/README.md](../../retro/README.md) — constrained compiled-replay playback proof and toolchain boundary.

## Decisions intentionally deferred

The following do not block V1 and should remain replaceable:

- final product/site name;
- exact 3D art direction and piece set;
- exact camera language beyond baseline usability requirements;
- whether replay artifacts use a dedicated filename extension;
- whether metadata/annotations eventually use JSON sidecars, an embedded section, or both;
- exact retro target order after the first portability proof;
- Stockfish or other evaluation integration;
- accounts, replay hosting, social sharing, comments, collections, or user profiles;
- clocks and timestamp playback beyond optional imported metadata.

No additional product decision is required to start Phase 1. Binary layout/hash and retro toolchain choices are explicit deliverables of Phase 3, not unresolved Web V1 prerequisites.

## Authority and readiness

This directory integrates the supplied `chess-replay-build-pack.zip`. It is the maintained handoff; do not implement the original archive as a competing specification. [REPLAY_SPEC.md](REPLAY_SPEC.md) owns replay data and controller behavior; [ARCHITECTURE.md](ARCHITECTURE.md) owns current-engine integration and PGN policy; [WEB_VIEWER.md](WEB_VIEWER.md) owns browser behavior; [PORTABILITY.md](PORTABILITY.md) owns the later retro proof; [TICKETS.md](TICKETS.md) maps those requirements to dependencies and acceptance checks.

[SPEC.md](../../SPEC.md) remains authoritative for chess rules. [PROTOCOL.md](../PROTOCOL.md) describes what the existing engines actually expose. The [presentation specification](../../spec/3d-presentation-requirements.md) owns rendering seams; console-specific profiles apply to their named targets, not the Web V1 milestone. A rules implementation gap is not permission to change the rules contract.

The repository has four rules CLIs, a Vite simulator, and a [replay core library](../../replay/README.md) with schema validation, deterministic navigation, presentation transitions, PGN import, synchronized move lists, 20 shared technical fixtures, an attributed curated library, complete-history seek caching, and a compact compiled derivative. The public viewer uses a Three.js board with an accessible deterministic fallback, local PGN import, replay selection, and cached seeking. Web V1 is Phases 1 and 2; Phase 3 now has a frozen compiled format, verified host conformance, a fixed-buffer retro-profile comparison, and a cc65/FCEUX ROM trace path. The current host's generated report records whether the external emulator step was available; no emulator result is inferred from the host executable. The completed core is exposed through the public viewer while the simulator remains independently reachable. No deployment is part of the core tickets.

Integration decisions resolved here: fixed `all-rules-enabled` mode; exact canonical setup fields; zero-based error indices and destination-ply lookup; atomic load; paused manual seeks; multiple-game PGN chooser; explicit import limits; deterministic identity reconstruction; complete-history caching; and recorded-result versus rules-outcome separation.
