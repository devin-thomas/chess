# Chess Rules and Presentation Specification

This repository is the language-agnostic source of truth for a deterministic chess rules core and the machine-facing presentation seams needed by later ports. The first presentation targets are a PlayStation 1 renderer and a Sega Dreamcast renderer built with KallistiOS.

The rules model must remain independent of meshes, textures, camera behavior, SDK headers, and console memory layouts. Console renderers consume stable state and events, then select platform-specific asset derivatives.

## Documents

- [`SPEC.md`](./SPEC.md) — preserved authoritative orthodox-chess rules and command/state contract.
- [`CONTEXT.md`](./CONTEXT.md) — project vocabulary and boundaries.
- [`spec/3d-presentation-requirements.md`](./spec/3d-presentation-requirements.md) — normative machine-facing requirements for rendering chess in 3D.
- [`docs/research/3d-modeling-and-platform-integration.md`](./docs/research/3d-modeling-and-platform-integration.md) — sourced research on PS1/Dreamcast constraints, asset sources, and the production pipeline.

`SPEC.md` remains the rules source. The presentation specification consumes a read-only projection of it and does not add spatial chess rules or modify legality. The research document is deliberately separate from both: hardware facts and recommendations can change without silently changing chess rules.

## Executable conformance suite

The same rules contract is implemented as four independent CPU-vs-CPU command-line engines:

- `python/chess_cpu.py` - dependency-free Python reference implementation.
- `c/chess_cpu.c` - C11 implementation.
- `typescript/chess_cpu.ts` - TypeScript executed directly by Node 24's type stripping.
- `rust/chess_cpu.rs` - dependency-free Rust 2021 implementation.

All four expose the JSON Lines protocol documented in [`docs/PROTOCOL.md`](./docs/PROTOCOL.md). The shared corpus covers both `basic` and `all-rules-enabled` modes, legal movement, king safety, castling, en passant, promotion, terminal states, repetition, 50/75-move rules, FEN validation, deterministic runs, and sampling.

The default build requires Python 3, a C11 compiler, Node 24 or newer, and `rustc` with Rust 2021 support:

```sh
make build
make test
make benchmark
```

## Web simulator

The browser interface runs the TypeScript engine locally in the page. It supports single games, deterministic batches, optional FEN and move tracing, terminal-style JSON output, and first-move sampling statistics.

    npm install
    npm run dev

Open the local URL printed by Vite. The deployed interface is intended for https://chess-sim.uppercut-labs.workers.dev/.

The production asset bundle is built with npm run build. With an authenticated Wrangler session, npm run deploy publishes it through wrangler.jsonc.

## Run a game

```sh
printf '%s\n' '{"op":"run","mode":"all-rules-enabled","seed":"42","max_plies":100}' | python3 python/chess_cpu.py
printf '%s\n' '{"op":"run","mode":"all-rules-enabled","seed":"42","max_plies":100}' | ./build/chess_c
printf '%s\n' '{"op":"run","mode":"all-rules-enabled","seed":"42","max_plies":100}' | node --experimental-strip-types typescript/chess_cpu.ts
printf '%s\n' '{"op":"run","mode":"all-rules-enabled","seed":"42","max_plies":100}' | ./build/chess_rust
```

For interactive inspection, send `new`, `state`, `legal_moves`, and `play` requests one JSON line at a time.

## Comparative analysis

Benchmark results are written to `reports/benchmark.json` and `reports/benchmark.md`. The benchmark compares wall-clock processing time, child peak resident memory, implementation LOC, and root move-selector randomness quality.
