# NES Replay Profile

RPL-016 adds a constrained replay adapter for the frozen RPL-015 compiled
format. The adapter consumes the embedded `RPLY` bytes directly; it does not
parse JSON, PGN, or SAN at runtime and it does not allocate memory dynamically.

Run the reproducible host proof from the repository root:

```sh
make replay-nes-proof
```

The command compiles the reusable `retro/nes_replay.c` core and its trace
driver with the system C compiler, embeds
`shared/replay-fixtures/castle-kingside.json` through
`tools/emit-nes-embed.ts`, and writes the selected-ply trace to
`build/replay_nes_output.txt`. It also compiles
`retro/nes_replay_invalid.c` and checks malformed headers, metadata, and move
sections in
`build/replay_nes_invalid_output.txt`.

The proof covers the root, both castling moves, previous/next navigation, and
start/end seeking. The expected state is independently read from
`shared/replay-fixtures/castle-kingside.expected.json` by
`tests/test_retro_replay.py`.

An actual cc65 ROM build is available when the toolchain is installed:

```sh
make nes-rom
```

The builder accepts `NES_CC65_HOME=/path/to/cc65` or
`python3 tools/nes-proof.py --cc65-home /path/to/cc65 --build-only`. To run the
automated FCEUX Lua trace, use `make nes-fceux` (or pass `--fceux` explicitly).
The trace script drives the ROM's deterministic demo sequence and writes
`build/nes-replay-trace.json`.

The runtime profile is fixed-buffer: the live board is 64 cells, state and
packed moves are read from the embedded payload, and a seek rebuilds from the
root without a history allocation. The source is a portable adapter with a
cc65 NES renderer and FCEUX trace hook. The current host can build the ROM
when cc65 is supplied, but FCEUX is not yet available locally; the repository
records the emulator limitation instead of claiming a run that did not happen.
