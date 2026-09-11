# NES Replay Profile

RPL-016 is a constrained playback target for the frozen RPL-015 compiled
format. The NES program embeds the `RPLY` bytes directly; its runtime has no
JSON, PGN, or SAN parser and performs no dynamic allocation.

The portable host proof is:

```sh
make replay-nes-proof
```

It compiles the shared fixed-buffer decoder and runs the
`castle-kingside` compiled fixture through root, both castling moves,
previous/next, first, and last navigation. It also rejects malformed headers,
roots, move counts, and packed moves. The independent oracle is
`shared/replay-fixtures/castle-kingside.expected.json`.

The real cc65 ROM build is:

```sh
NES_CC65_HOME=/path/to/cc65 make nes-build
```

`NES_CC65_HOME` points to a cc65 installation or source build containing
`bin/cl65` and `lib/nes.lib`. The generated ROM is `build/nes_replay.nes`.
It uses cc65's standard iNES mapper-0 layout: 32 KiB PRG, 8 KiB CHR, 3 KiB
runtime stack at `$0500`, cartridge RAM from `$6000`, and the emulator trace at
`$7000`. The target decoder allows up to 4096 packed plies and reconstructs a
seek by replaying from the embedded root.

The ROM presents a tile-based board with piece letters and the current
`ply/move_count` indicator. Controller mappings are A = next, B = previous,
Select = first, and Start = last. On boot it runs a deterministic demo:
load root, next, next, previous, first, last. The Lua observer reads the
fixed trace record at `$7000` and writes `build/nes-replay-trace.json`.

Run the emulator proof with FCEUX available on `PATH`, or provide an explicit
binary:

```sh
NES_CC65_HOME=/path/to/cc65 NES_FCEUX=/path/to/fceux make nes-proof
make conformance-replay-retro
```

The second command compares the FCEUX trace against the same independent
fixture checkpoints used by the four host engines. The retro report records
board, side, castling rights, raw en-passant, halfmove, fullmove, and the
navigation sequence; a missing tool or malformed trace fails loudly instead
of becoming a host-only success.
