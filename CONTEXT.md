# Chess Specification Context

This context defines the vocabulary shared by the chess rules model, presentation adapters, and offline asset pipeline. It treats 3D as a presentation concern; the rules remain ordinary chess unless a future variant is explicitly introduced.

## Rules

**Rule State**:
The complete authoritative state needed to decide the next legal chess action, including piece placement, side to move, castling rights, en passant availability, and move counters. In this repository it is the `GameState`/`Position` contract defined by `SPEC.md`; a presentation adapter consumes it read-only.
_Avoid_: Board snapshot, game screen, render state

**Move Record**:
A normalized description of one accepted chess move, including its source and destination squares plus any capture, promotion, castling, or en passant effects.
_Avoid_: Animation, command, input event

**Presentation Event**:
A time-ordered projection of a committed rules outcome that a user interface may visualize or announce, such as a move, capture, check, promotion, checkmate, or stalemate. A rejected command may be reported as a non-committed UI diagnostic, but it is not a chess move.
_Avoid_: Render command, GPU packet

**Board Square**:
One of the 64 named locations on the chessboard, addressed by file and rank independently of screen coordinates or model coordinates.
_Avoid_: Tile, vertex, pixel

## Presentation and Content

**Piece Identity**:
The stable identity of a physical piece instance across presentation updates, distinct from its piece type and current board square. When the rules source has no piece-ID field, the presentation adapter owns this identity and persists it in its own projection.
_Avoid_: Mesh ID, sprite ID, array index

**Presentation Projection**:
A deterministic, read-only view derived from `SPEC.md` state, committed move results, and adapter-owned piece identities. It supplies renderable effects without becoming a second authority for legality or adjudication.
_Avoid_: Rules fork, renderer-owned game state, GPU state

**Three-Dimensional Presentation**:
The geometry, materials, camera, lighting approximation, animation, and platform rendering used to show chess; it does not imply a different ruleset.
_Avoid_: 3D chess variant, spatial chess

**Canonical Asset**:
The authoring representation from which one or more console-ready assets are derived, with its provenance and source hash recorded.
_Avoid_: Runtime asset, final asset

**Platform Derivative**:
A validated, target-specific conversion of a canonical asset, such as a PS1 mesh packet set or a Dreamcast PVR texture and vertex set.
_Avoid_: Export, copy, universal model

**Render Profile**:
A named set of target capabilities, budgets, and required fallbacks that a renderer can satisfy without changing the rules model.
_Avoid_: Quality setting, console mode

**Asset Provenance Record**:
The immutable record linking an asset to its source URL or repository, author, license, version or commit, modifications, attribution text, and generated derivatives.
_Avoid_: Credits list, download note
