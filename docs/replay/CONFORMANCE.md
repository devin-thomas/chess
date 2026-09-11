# Replay Conformance Report

`tools/replay-conformance.py` runs every valid fixture in
`shared/replay-cases.json` through the Python, C, TypeScript, and Rust JSONL
engines. Invalid-input fixtures remain covered by `tests/run_shared.py`; this
report focuses on authoritative replay positions after every recorded ply.
When `--retro-output` is supplied, it also compares the castle fixture against
the RPL-016 fixed-buffer trace or a cc65/FCEUX JSON trace.

Run it after building the host engines:

```sh
make conformance-replay
```

The command writes `reports/replay-conformance.json` and exits non-zero when
an engine cannot start, returns malformed protocol output, disagrees with the
fixture checkpoint, or disagrees with another engine. The report is stable and
machine-readable: it records the commands, fixture IDs, ply numbers, complete
normalized state, effective position keys, legal moves, diagnostics, and a
summary. Repetition-key serialization is implementation-specific, so the
report compares the sorted multiset of repetition counts and the canonical
effective position key instead of raw repetition-map keys.

The committed expected checkpoints are generated from the replay fixture
generator and include board state, counters, castling, raw en-passant,
termination, claims, move history, and the zero-based replay revision. CLI
engines do not expose a revision field, so the runner derives that field from
the fixture ply while comparing all other observable fields directly.

The 2026-09-11 baseline covered 18 valid fixtures and 62 host checkpoints with
zero mismatches. The two invalid fixtures remain listed in the report's
`skipped_invalid_fixtures` array. The same report now includes a `retro` object
with the selected castle checkpoints, navigation result, adapter profile, and
emulator availability. The default `make conformance-replay` command uses the
portable fixed-buffer host trace; `make conformance-replay-retro` uses the
cc65/FCEUX JSON trace when that external toolchain is installed.
