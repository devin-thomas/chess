# Compiled Replay Format V1

RPL-015 freezes the offline `RPLY` derivative used by host and constrained
playback targets. The canonical JSON Replay V1 artifact remains the source of
truth; this binary is an execution derivative and never needs JSON, PGN, or SAN
at runtime.

## Header

All integers are unsigned little-endian. The fixed header is 46 bytes.

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII magic `RPLY` |
| 4 | 1 | compiled format version `1` |
| 5 | 1 | flags: bit 0 position root, bit 1 Tier-1 metadata; other bits reserved and zero |
| 6 | 1 | ruleset id `1` (`orthodox-chess-v1`) |
| 7 | 1 | reserved; zero |
| 8 | 2 | move count, maximum 4096 |
| 10 | 2 | root payload byte length |
| 12 | 2 | metadata payload byte length |
| 14 | 32 | SHA-256 of the canonical execution payload (`schema_version`, `ruleset`, normalized root, and moves; metadata excluded) |

The sections follow immediately in this order: root payload, metadata payload,
then `move_count` packed moves. The host manifest also records the SHA-256 of
the complete compiled payload.

## Root payload

The standard root is represented by zero bytes and a clear position-root flag.
A position root is 75 bytes:

- bytes 0-63: board cells in canonical `a1` through `h8` order;
- byte 64: side to move (`0` white, `1` black);
- byte 65: castling bits (`K=1`, `Q=2`, `k=4`, `q=8`);
- byte 66: en-passant square index, or `0xff` for none;
- bytes 67-70: halfmove clock as uint32;
- bytes 71-74: fullmove number as uint32.

Piece cell codes are zero for empty, `1..6` for white pawn/knight/bishop/rook/
queen/king, and the same values plus eight for black. Values outside this set
are rejected by the decoder. Counter values above uint32 are rejected by the
compiler instead of being truncated.

## Tier-1 metadata

When the metadata flag is set, the payload starts with version `1` and a
four-bit presence mask for `white`, `black`, `event`, and `result`, in that
order. Each present value is a uint16 byte length followed by UTF-8 text. The
result is limited to the four Replay V1 result strings. Rich metadata such as
URLs, ratings, annotations, and descriptions stays in the canonical source and
is intentionally not required by a target runtime.

## Packed moves

Each move is one uint16:

```text
bits 0..5   source square (a1 = 0)
bits 6..11  destination square
bits 12..14 promotion (0 none, 1 queen, 2 rook, 3 bishop, 4 knight)
bit 15      reserved; zero
```

The decoder reconstructs canonical coordinate moves and validates the complete
sequence with the authoritative rules engine. A malformed, truncated, or
illegal payload fails explicitly; it is never repaired or read past its fixed
sections.

## Compiler and manifest

The host entry points are `compileReplay`, `decodeCompiledReplay`, and
`verifyCompiledReplay` in `replay/compiler.ts`. The CLI form is:

```sh
npm run compile:replay -- shared/replay-fixtures/opening.json build/opening.rply
```

The CLI writes a JSON sidecar manifest containing schema version, format
version, ruleset, root kind, metadata tier, move count, canonical source hash,
and compiled payload hash. Frozen byte vectors live in
`shared/compiled-replay-vectors.json` and are checked by
`tests/replay-compiler.test.ts`.
