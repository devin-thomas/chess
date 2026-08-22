# CPU-vs-CPU Chess in C, Python, TypeScript, and Rust

This repository contains four independent implementations of the same orthodox chess CLI:

- `python/chess_cpu.py` - reference implementation with no third-party dependencies.
- `c/chess_cpu.c` - C11 implementation.
- `typescript/chess_cpu.ts` - TypeScript source executed directly by Node 24's type stripping.
- `rust/chess_cpu.rs` - standalone Rust 2021 implementation with no external crates.

All four expose the JSON Lines protocol in [`docs/PROTOCOL.md`](docs/PROTOCOL.md). The engines use the same legal-move semantics and the same SplitMix64 generator so deterministic runs can be compared byte-for-byte at the move-trace level.

## Build and test

The default `Makefile` requires Python 3, a C11 compiler, Node 24 or newer, and `rustc` with Rust 2021 support.

```sh
make build
make test
```

The shared runner exercises each executable with the same independent conformance cases. The language-specific tests exercise the Python module and the three compiled/external CLIs through their public boundaries.

## Run a game

```sh
printf '%s\n' '{"op":"run","mode":"all-rules-enabled","seed":"42","max_plies":100}' | python3 python/chess_cpu.py
printf '%s\n' '{"op":"run","mode":"all-rules-enabled","seed":"42","max_plies":100}' | ./build/chess_c
printf '%s\n' '{"op":"run","mode":"all-rules-enabled","seed":"42","max_plies":100}' | node --experimental-strip-types typescript/chess_cpu.ts
printf '%s\n' '{"op":"run","mode":"all-rules-enabled","seed":"42","max_plies":100}' | ./build/chess_rust
```

For interactive inspection, send requests such as `{"op":"new"}`, `{"op":"state"}`, `{"op":"legal_moves"}`, and `{"op":"play","move":"e2e4"}` one line at a time.

## Comparative analysis

```sh
make benchmark
```

The benchmark records wall-clock processing time, child maximum resident memory, source lines of code, and move-sampling quality. It writes machine-readable JSON and a Markdown summary under `reports/`. The randomness report uses a fixed root position and evaluates chi-square, Shannon entropy, maximum frequency deviation, and lag-1 correlation; it measures the move selector and PRNG, not strategic chess strength.

The benchmark is intentionally reproducible rather than a claim about every machine. Run it on the same host, with the same seed and sample counts, when comparing languages.
