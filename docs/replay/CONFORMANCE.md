# Replay Conformance Report

`tools/replay-conformance.py` runs every valid fixture in
`shared/replay-cases.json` through the Python, C, TypeScript, and Rust JSONL
engines. Invalid-input fixtures remain covered by `tests/run_shared.py`; this
report focuses on authoritative replay positions after every recorded ply.

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

The 2026-09-11 host baseline covered 18 valid fixtures and 62 checkpoints with
zero mismatches. The two invalid fixtures remain listed in the report's
`skipped_invalid_fixtures` array. Retro output is deliberately not treated as
host evidence; RPL-016 supplies a separate selected-ply adapter for the final
comparison.
